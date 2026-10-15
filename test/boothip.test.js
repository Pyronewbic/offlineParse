import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BoothIpError, applyBoothIp, parseServiceOrder, planBoothIp, prefixToMask, sameSubnet } from '../src/boothip.js';

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
    assert.deepEqual(plan({ platform: 'win32', addresses: [wifi('Wi-Fi 2')] }).steps,
      [['netsh', ['interface', 'ipv4', 'set', 'address', 'Wi-Fi 2', 'static', BOOTH, '255.255.255.0', '192.168.88.1']]]);
    assert.equal(plan({ platform: 'win32', addresses: [wifi('Wi-Fi')], gateway: '192.168.88.254' }).steps[0][1].at(-1), '192.168.88.254');
  });

  test('undo removes it from whichever adapter holds it', () => {
    const holding = [wifi('en0', BOOTH), wifi('en0')];
    assert.deepEqual(plan({ undo: true, addresses: holding }).steps, [['sudo', ['networksetup', '-setdhcp', 'Wi-Fi']]]);
    assert.deepEqual(plan({ platform: 'win32', undo: true, addresses: [wifi('Wi-Fi', BOOTH)] }).steps,
      [['netsh', ['interface', 'ipv4', 'set', 'address', 'Wi-Fi', 'dhcp']]]);
    assert.deepEqual(plan({ platform: 'linux', undo: true, addresses: [wifi('wlan0', BOOTH)] }).steps,
      [['sudo', ['ip', 'addr', 'del', `${BOOTH}/24`, 'dev', 'wlan0']]]);
  });

  test('already set, or nothing to undo, means no commands at all', () => {
    const done = plan({ addresses: [wifi('en0', BOOTH)] });
    assert.deepEqual(done.steps, []);
    assert.match(done.note, /already on en0/);
    const nothing = plan({ undo: true });
    assert.deepEqual(nothing.steps, []);
    assert.match(nothing.note, /nothing to undo/);
  });

  test('refuses when the laptop is not on the booth network, or on it twice', () => {
    assert.throws(() => plan({ addresses: [loopback, wifi('en0', '10.0.0.5')] }),
      (e) => e instanceof BoothIpError && /no network adapter is on 192\.168\.88\.0\/24; join the booth Wi-Fi/.test(e.message));
    assert.throws(() => plan({ addresses: [wifi('en0'), wifi('en7', '192.168.88.40')] }), /several adapters .*en0, en7/);
    const linkLocal = { name: 'en0', address: '192.168.88.9', connected: false, usable: false };
    assert.throws(() => plan({ addresses: [linkLocal] }), /no network adapter/, 'a disconnected entry does not count');
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
    await assert.rejects(promise, /sudo failed \(exit 1\)/);
    assert.equal(ran.length, 1);
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
