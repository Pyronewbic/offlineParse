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
    assert.deepEqual(found.filter((a) => a.connected && !a.usable).map((a) => a.name),
      ['docker0', 'br-9f2c', 'vEthernet (WSL)', 'VirtualBox Host-Only Network', 'utun3', 'tailscale0', 'bridge100']);
    assert.equal(found.length, 12, 'IPv6 entries are skipped, everything IPv4 is listed');
  });
});

describe('chooseAddress', () => {
  const wifi = { name: 'Wi-Fi', address: '192.168.88.8', connected: true, usable: true };
  const tether = { name: 'en7', address: '172.20.10.2', connected: true, usable: true };
  const docker = { name: 'docker0', address: '172.17.0.1', connected: true, usable: false };
  const loopback = { name: 'lo', address: '127.0.0.1', connected: false, usable: false };
  const unplugged = { name: 'Ethernet', address: '169.254.3.4', connected: false, usable: false };

  test('auto uses the only real network, even when the default route is a virtual adapter', () => {
    const r = chooseAddress({ configured: 'auto', addresses: [loopback, docker, wifi], routed: '172.17.0.1' });
    assert.deepEqual(r, { ip: '192.168.88.8', how: 'auto: Wi-Fi, the only network' });
    assert.equal(chooseAddress({ configured: 'auto', addresses: [loopback, wifi], routed: null }).ip, '192.168.88.8');
  });

  test('auto refuses with booth Wi-Fi plus a tether, and flags the default route as the likely internet', () => {
    assert.throws(() => chooseAddress({ configured: 'auto', addresses: [loopback, wifi, tether], routed: '172.20.10.2' }),
      (e) => e instanceof AddressError &&
        e.message.includes('192.168.88.8 (Wi-Fi), 172.20.10.2 (en7, default route, probably internet)') &&
        /adapter name or address/.test(e.message));
  });

  test('auto with no real address says to join the Wi-Fi', () => {
    assert.throws(() => chooseAddress({ configured: 'auto', addresses: [loopback, docker, unplugged], routed: null }), /join the event Wi-Fi/);
  });

  test('an adapter name picks that adapter, ignoring the default route', () => {
    const r = chooseAddress({ configured: 'Wi-Fi', addresses: [wifi, tether], routed: '172.20.10.2' });
    assert.deepEqual(r, { ip: '192.168.88.8', how: 'adapter Wi-Fi' });
    assert.equal(chooseAddress({ configured: 'wi-fi', addresses: [wifi, tether], routed: null }).ip, '192.168.88.8',
      'case-insensitive fallback for Windows adapter names');
    assert.equal(chooseAddress({ configured: 'docker0', addresses: [docker, wifi], routed: null }).ip, '172.17.0.1',
      'an explicitly named virtual adapter is honoured');
  });

  test('an adapter that is down or missing is an error that lists what is connected', () => {
    assert.throws(() => chooseAddress({ configured: 'Ethernet', addresses: [unplugged, wifi], routed: null }),
      /adapter "Ethernet" has no usable IPv4 address/);
    assert.throws(() => chooseAddress({ configured: 'wlan0', addresses: [loopback, wifi, tether], routed: null }),
      /no adapter named "wlan0" \(connected adapters: Wi-Fi, en7\)/);
  });

  test('a fixed address must belong to this machine; loopback is allowed for local testing', () => {
    assert.equal(chooseAddress({ configured: '192.168.88.8', addresses: [wifi], routed: null }).ip, '192.168.88.8');
    assert.equal(chooseAddress({ configured: '127.0.0.1', addresses: [loopback], routed: null }).ip, '127.0.0.1');
    assert.throws(() => chooseAddress({ configured: '192.168.88.5', addresses: [loopback, wifi], routed: null }),
      /192\.168\.88\.5 is not an address of this machine/);
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
