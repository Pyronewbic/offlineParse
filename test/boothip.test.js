import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BoothIpError, applyBoothIp, parseServiceOrder, planBoothIp, planWhenReady, prefixToMask, sameSubnet } from '../src/boothip.js';

const BOOTH = '192.168.88.2';
const wifi = (name = 'en0', address = '192.168.88.8') => ({ name, address, connected: true, usable: true });
const loopback = { name: 'lo0', address: '127.0.0.1', connected: false, usable: false };
const SERVICES = new Map([['en0', 'Wi-Fi']]);
const plan = (overrides) =>
  planBoothIp({ platform: 'darwin', addresses: [loopback, wifi()], boothIp: BOOTH, services: SERVICES, ...overrides });

describe('parseServiceOrder', () => {
  test('maps devices to macOS service names, including disabled ones, skipping device-less services', () => {
    const text = 'An asterisk (*) denotes that a network service is disabled.\n' +
      '(1) USB 10/100/1000 LAN\n(Hardware Port: USB 10/100/1000 LAN, Device: en9)\n\n' +
      '(*) Thunderbolt Bridge\n(Hardware Port: Thunderbolt Bridge, Device: bridge0)\n\n' +
      '(6) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n\n' +
      '(7) Tailscale\n(Hardware Port: io.tailscale.ipn.macsys, Device: )\n';
    assert.deepEqual([...parseServiceOrder(text)], [['en9', 'USB 10/100/1000 LAN'], ['bridge0', 'Thunderbolt Bridge'], ['en0', 'Wi-Fi']]);
    assert.equal(parseServiceOrder('').size, 0);
  });
});

describe('subnet helpers', () => {
  test('masks and subnet membership', () => {
    assert.equal(prefixToMask(24), '255.255.255.0');
    assert.equal(prefixToMask(16), '255.255.0.0');
    assert.ok(sameSubnet('192.168.88.2', '192.168.88.254', 24));
    assert.ok(!sameSubnet('192.168.88.2', '192.168.89.2', 24));
    assert.ok(sameSubnet('10.1.2.3', '10.1.200.4', 16));
  });
});

describe('planBoothIp', () => {
  test('macOS makes the booth address the Wi-Fi service\'s only address (networksetup, by service name)', () => {
    assert.deepEqual(plan(), {
      iface: 'en0', steps: [['sudo', ['networksetup', '-setmanual', 'Wi-Fi', BOOTH, '255.255.255.0', '192.168.88.1']]],
    });
  });

  test('macOS uses whatever the service is called, for both setting and undoing', () => {
    const services = new Map([['en1', 'AirPort Extreme']]);
    assert.equal(plan({ services, addresses: [wifi('en1')] }).steps[0][1][2], 'AirPort Extreme');
    assert.deepEqual(plan({ services, undo: true, addresses: [wifi('en1', BOOTH)] }).steps,
      [['sudo', ['networksetup', '-setdhcp', 'AirPort Extreme']]]);
  });

  test('macOS refuses when the adapter has no known network service', () => {
    assert.throws(() => plan({ services: new Map() }), /could not find the macOS network service for en0/);
    assert.throws(() => plan({ services: undefined }), /network service/);
  });

  test('Linux adds a secondary address', () => {
    assert.deepEqual(plan({ platform: 'linux', addresses: [wifi('wlp2s0')] }).steps,
      [['sudo', ['ip', 'addr', 'add', `${BOOTH}/24`, 'dev', 'wlp2s0']]]);
  });

  test('Windows sets the adapter static with the .1 gateway, keeping spaces in the name as one argument', () => {
    assert.deepEqual(plan({ platform: 'win32', addresses: [wifi('Wi-Fi 2')] }).steps[0],
      ['netsh', ['interface', 'ipv4', 'set', 'address', 'Wi-Fi 2', 'static', BOOTH, '255.255.255.0', '192.168.88.1']]);
    assert.equal(plan({ platform: 'win32', addresses: [wifi('Wi-Fi')], gateway: '192.168.88.254' }).steps[0][1].at(-1), '192.168.88.254');
  });

  test('Windows then replaces its firewall rules: the booth ports, booth network only, every profile', () => {
    const rest = plan({ platform: 'win32', addresses: [wifi('Wi-Fi')], ports: { http: 8080, dns: 5353 } }).steps.slice(1);
    assert.deepEqual(rest, [
      ['netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=offlineParse-booth-http'], { mayFail: true }],
      ['netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=offlineParse-booth-dns'], { mayFail: true }],
      ['netsh', ['advfirewall', 'firewall', 'add', 'rule', 'name=offlineParse-booth-http', 'dir=in', 'action=allow',
        'protocol=TCP', 'localport=8080', 'remoteip=192.168.88.0/24', 'profile=any']],
      ['netsh', ['advfirewall', 'firewall', 'add', 'rule', 'name=offlineParse-booth-dns', 'dir=in', 'action=allow',
        'protocol=UDP', 'localport=5353', 'remoteip=192.168.88.0/24', 'profile=any']],
    ]);
    assert.match(plan({ platform: 'win32', addresses: [wifi('Wi-Fi')] }).steps.at(-1)[1].join(' '), /localport=53 /);
    for (const platform of ['darwin', 'linux']) {
      assert.ok(!JSON.stringify(plan({ platform, addresses: [wifi()] }).steps).includes('advfirewall'), platform);
    }
  });

  test('undo removes it from whichever adapter holds it', () => {
    const holding = [wifi('en0', BOOTH), wifi('en0')];
    assert.deepEqual(plan({ undo: true, addresses: holding }).steps, [['sudo', ['networksetup', '-setdhcp', 'Wi-Fi']]]);
    assert.deepEqual(plan({ platform: 'win32', undo: true, addresses: [wifi('Wi-Fi', BOOTH)] }).steps, [
      ['netsh', ['interface', 'ipv4', 'set', 'address', 'Wi-Fi', 'dhcp']],
      ['netsh', ['interface', 'ipv4', 'set', 'dnsservers', 'Wi-Fi', 'dhcp']],
      ['netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=offlineParse-booth-http'], { mayFail: true }],
      ['netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=offlineParse-booth-dns'], { mayFail: true }],
    ]);
    assert.deepEqual(plan({ platform: 'linux', undo: true, addresses: [wifi('wlan0', BOOTH)] }).steps,
      [['sudo', ['ip', 'addr', 'del', `${BOOTH}/24`, 'dev', 'wlan0']]]);
  });

  test('already set, or nothing to undo, means no commands at all', () => {
    const done = plan({ addresses: [wifi('en0', BOOTH)] });
    assert.deepEqual(done.steps, []);
    assert.match(done.note, /already on en0/);
    const nothing = plan({ undo: true });
    assert.deepEqual(nothing.steps, []);
    assert.match(nothing.note, /not on this machine right now\. If the Wi-Fi is off or disconnected, connect it/);
  });

  test('Windows undo with the adapter disconnected still removes the firewall rules', () => {
    const r = plan({ platform: 'win32', undo: true, addresses: [] });
    assert.equal(r.firewallOnly, true);
    assert.deepEqual(r.steps.map(([, args]) => args.join(' ')), [
      'advfirewall firewall delete rule name=offlineParse-booth-http', 'advfirewall firewall delete rule name=offlineParse-booth-dns']);
    assert.ok(r.steps.every(([, , opts]) => opts?.mayFail), 'absent rules do not fail the undo');
    assert.match(r.note, /connect it/);
  });

  test('refuses when the laptop is not on the booth network, or on it twice', () => {
    assert.throws(() => plan({ addresses: [loopback, wifi('en0', '10.0.0.5')] }),
      (e) => e instanceof BoothIpError && e.code === 'NO_BOOTH_NETWORK' && /no network adapter is on 192\.168\.88\.0\/24\./.test(e.message));
    assert.throws(() => plan({ addresses: [wifi('en0'), wifi('en7', '192.168.88.40')] }), /several adapters .*en0, en7/);
    const linkLocal = { name: 'en0', address: '192.168.88.9', connected: false, usable: false };
    assert.throws(() => plan({ addresses: [linkLocal] }), /no network adapter/, 'a disconnected entry does not count');
  });

  test('says what each adapter has instead, and what to do', () => {
    const msg = (addresses) => {
      try {
        plan({ addresses });
      } catch (e) {
        return e.message;
      }
      return assert.fail('expected a refusal');
    };
    assert.match(msg([loopback, wifi('en0', '10.0.0.5')]),
      /en0 is on 10\.0\.0\.5, a different network: join the booth Wi-Fi \(if the laptop keeps switching back, turn off Auto-Join/);
    assert.match(msg([loopback, { name: 'en0', address: '169.254.12.7', connected: false, usable: false }]),
      /en0 has only a temporary 169\.254\.12\.7 address, so the router has not given it one yet: turn Wi-Fi off and on/);
    assert.match(msg([loopback]), /No adapter has an address: join the booth Wi-Fi\./);
    const vpn = { name: 'utun3', address: '100.100.1.1', connected: true, usable: false };
    assert.ok(!msg([loopback, vpn, wifi('en0', '10.0.0.5')]).includes('utun3'), 'VPN and virtual adapters are not mentioned');
  });

  test('refuses configs and flags it cannot honour', () => {
    for (const boothIp of ['auto', 'en0', '192.168.88']) {
      assert.throws(() => plan({ boothIp }), /must be the fixed booth address/, boothIp);
    }
    for (const prefix of [0, 7, 31, 24.5, Number.NaN]) assert.throws(() => plan({ prefix }), /--prefix/, String(prefix));
    for (const gateway of ['10.0.0.1', BOOTH, 'router']) assert.throws(() => plan({ gateway }), /gateway/, gateway);
  });

  test('unsupported platforms are refused rather than guessed', () => {
    assert.throws(() => plan({ platform: 'freebsd' }), /does not support freebsd/);
  });
});

describe('applyBoothIp', () => {
  const steps = [['sudo', ['ifconfig', 'en0', 'alias', BOOTH, '255.255.255.255']], ['echo', ['second step']]];
  const harness = ({ statuses = [0, 0], appearsAfter = 0, undo = false } = {}) => {
    const ran = [];
    let checks = 0;
    const promise = applyBoothIp({
      plan: { iface: 'en0', steps }, boothIp: BOOTH, undo,
      run: (cmd, args) => {
        ran.push([cmd, ...args].join(' '));
        return statuses[ran.length - 1];
      },
      hasAddress: () => (checks++ >= appearsAfter ? !undo : undo),
      log: () => {},
      sleep: async () => {},
      attempts: 5,
    });
    return { promise, ran };
  };

  test('runs every step and waits for the address to show up', async () => {
    const { promise, ran } = harness({ appearsAfter: 3 });
    await promise;
    assert.equal(ran.length, 2);
  });

  test('a failing command stops the run before later steps', async () => {
    const { promise, ran } = harness({ statuses: [1, 0] });
    await assert.rejects(promise, /sudo failed \(exit 1\); nothing was changed/);
    assert.equal(ran.length, 1);
    await assert.rejects(harness({ statuses: [0, 1] }).promise, /echo failed \(exit 1\); the steps after it were not run/);
  });

  test('a step marked mayFail (deleting a rule that is not there) does not stop the run', async () => {
    const ran = [];
    await applyBoothIp({
      plan: { iface: 'en0', steps: [['netsh', ['delete'], { mayFail: true }], ['netsh', ['add']]] }, boothIp: BOOTH, undo: false,
      run: (cmd, args) => (ran.push(args[0]), ran.length === 1 ? 1 : 0),
      hasAddress: () => true, log: () => {}, sleep: async () => {},
    });
    assert.deepEqual(ran, ['delete', 'add']);
  });

  test('exit 0 without the address appearing is still a failure', async () => {
    const { promise } = harness({ appearsAfter: 99 });
    await assert.rejects(promise, /did not appear on en0/);
  });

  test('undo is verified the same way', async () => {
    await harness({ undo: true, appearsAfter: 1 }).promise;
    await assert.rejects(harness({ undo: true, appearsAfter: 99 }).promise, /is still on this machine/);
  });
});

describe('planWhenReady', () => {
  const noNetwork = () => Object.assign(new BoothIpError('no network adapter is on x'), { code: 'NO_BOOTH_NETWORK' });

  test('waits for a just-joined Wi-Fi to get its address, telling the operator once', async () => {
    let calls = 0;
    const waits = [];
    const slept = [];
    const result = await planWhenReady({
      plan: () => (++calls < 4 ? (() => { throw noNetwork(); })() : 'planned'),
      sleep: async (ms) => slept.push(ms), onWait: () => waits.push('waiting'),
    });
    assert.equal(result, 'planned');
    assert.equal(calls, 4);
    assert.deepEqual(waits, ['waiting']);
    assert.deepEqual(slept, [1000, 1000, 1000]);
  });

  test('gives up after the attempts with the last message, and never waits on other errors', async () => {
    let calls = 0;
    await assert.rejects(planWhenReady({ plan: () => { calls++; throw noNetwork(); }, sleep: async () => {}, attempts: 5 }),
      /no network adapter is on x/);
    assert.equal(calls, 5);
    calls = 0;
    await assert.rejects(planWhenReady({ plan: () => { calls++; throw new BoothIpError('--prefix must be'); }, sleep: async () => {} }),
      /--prefix/);
    assert.equal(calls, 1, 'a config error is reported at once');
  });
});
