import assert from 'node:assert/strict';
import { isIPv4 } from 'node:net';
import { describe, test } from 'node:test';
import { AddressError, addressFollower, chooseAddress, defaultRouteAddress, localAddresses } from '../src/netaddr.js';

const iface = (address, extra = {}) => ({ address, netmask: '255.255.255.0', family: 'IPv4', internal: false, ...extra });

describe('localAddresses', () => {
  test('marks loopback, link-local and virtual adapters unusable on every OS naming scheme', () => {
    const found = localAddresses({
      lo0: [iface('127.0.0.1', { internal: true })],
      en0: [iface('192.168.88.8'), { address: 'fe80::1', family: 'IPv6', internal: false }],
      'Wi-Fi': [iface('10.0.0.7')],
      wlan0: [iface('172.20.1.4', { family: 4 })], // Node 18.0-18.3 reported family as a number
      docker0: [iface('172.17.0.1')],
      'br-9f2c': [iface('172.18.0.1')],
      'vEthernet (WSL)': [iface('172.25.48.1')],
      'VirtualBox Host-Only Network': [iface('192.168.56.1')],
      utun3: [iface('100.64.0.2')],
      tailscale0: [iface('100.100.1.1')],
      bridge100: [iface('192.168.64.1')],
      'Ethernet 2': [iface('169.254.10.20')],
      eth0: undefined,
    });
    assert.deepEqual(found.filter((a) => a.usable).map((a) => a.name), ['en0', 'Wi-Fi', 'wlan0']);
    assert.equal(found.length, 12, 'IPv6 entries are skipped, everything IPv4 is listed');
  });
});

describe('chooseAddress', () => {
  const wifi = { name: 'Wi-Fi', address: '192.168.88.8', usable: true };
  const ethernet = { name: 'Ethernet', address: '10.1.1.5', usable: true };
  const docker = { name: 'docker0', address: '172.17.0.1', usable: false };
  const loopback = { name: 'lo', address: '127.0.0.1', usable: false };

  test('auto prefers the default-route address', () => {
    const r = chooseAddress({ configured: 'auto', addresses: [loopback, docker, ethernet, wifi], routed: '192.168.88.8' });
    assert.equal(r.ip, '192.168.88.8');
    assert.match(r.how, /default route/);
  });

  test('auto ignores a default route through a virtual adapter and uses the only real address', () => {
    const r = chooseAddress({ configured: 'auto', addresses: [loopback, docker, wifi], routed: '172.17.0.1' });
    assert.equal(r.ip, '192.168.88.8');
    assert.match(r.how, /only network address/);
  });

  test('auto with no route (offline router without a gateway) uses the only real address', () => {
    assert.equal(chooseAddress({ configured: 'auto', addresses: [loopback, wifi], routed: null }).ip, '192.168.88.8');
  });

  test('auto refuses to guess between several real addresses without a route', () => {
    assert.throws(() => chooseAddress({ configured: 'auto', addresses: [ethernet, wifi], routed: null }),
      (e) => e instanceof AddressError && /10\.1\.1\.5 \(Ethernet\)/.test(e.message) && /--ip/.test(e.message));
  });

  test('auto with no real address says to join the Wi-Fi', () => {
    assert.throws(() => chooseAddress({ configured: 'auto', addresses: [loopback, docker], routed: null }), /join the event Wi-Fi/);
  });

  test('a fixed address must belong to this machine; loopback is allowed for local testing', () => {
    assert.equal(chooseAddress({ configured: '192.168.88.8', addresses: [wifi], routed: null }).ip, '192.168.88.8');
    assert.equal(chooseAddress({ configured: '127.0.0.1', addresses: [loopback], routed: null }).ip, '127.0.0.1');
    assert.throws(() => chooseAddress({ configured: '192.168.88.5', addresses: [loopback, wifi], routed: null }),
      /192\.168\.88\.5 is not an address of this machine/);
    assert.throws(() => chooseAddress({ configured: 'laptop.local', addresses: [wifi], routed: null }), /not an IPv4/);
  });
});

test('defaultRouteAddress returns null or one of this machine\'s IPv4 addresses', async () => {
  const ip = await defaultRouteAddress();
  if (ip !== null) {
    assert.ok(isIPv4(ip));
    assert.ok(localAddresses().some((a) => a.address === ip), `${ip} is local`);
  }
});

describe('addressFollower', () => {
  const run = (results) => {
    const events = [];
    let i = 0;
    const follower = addressFollower({
      initial: { ip: '192.168.88.5' },
      detect: async () => {
        const r = results[i++];
        if (r instanceof Error) throw r;
        return { ip: r, how: 'test' };
      },
      onChange: (next, prev) => events.push(`change ${prev.ip} ${next.ip}`),
      onProblem: (msg) => events.push(`problem ${msg}`),
      onRecovered: (ip) => events.push(`recovered ${ip}`),
    });
    return { follower, events };
  };

  test('follows a DHCP change once and stays quiet while stable', async () => {
    const { follower, events } = run(['192.168.88.5', '192.168.88.8', '192.168.88.8']);
    for (let n = 0; n < 3; n++) await follower.check();
    assert.deepEqual(events, ['change 192.168.88.5 192.168.88.8']);
    assert.equal(follower.current.ip, '192.168.88.8');
  });

  test('reports a lost address once, then the recovery', async () => {
    const lost = new AddressError('no network address found');
    const { follower, events } = run([lost, lost, lost, '192.168.88.5']);
    for (let n = 0; n < 4; n++) await follower.check();
    assert.deepEqual(events, ['problem no network address found', 'recovered 192.168.88.5']);
  });
});
