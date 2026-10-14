import dgram from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

// Adapters that are never the event Wi-Fi: containers, VMs, VPNs, Apple peer-to-peer links.
const VIRTUAL = /^(docker|br-|veth|virbr|vboxnet|vmnet|vnic|utun|tun|tap|wg|tailscale|zt|awdl|llw|anpi|bridge)|vEthernet|VirtualBox|VMware|Hyper-V|Bluetooth|Loopback/i;
// TEST-NET-1. Connecting a UDP socket only asks the OS which source address its routing table
// would use; no packet is sent.
const ROUTE_PROBE = '192.0.2.1';

export class AddressError extends Error {}

export function localAddresses(ifaces = networkInterfaces()) {
  return Object.entries(ifaces).flatMap(([name, addrs]) => (addrs ?? [])
    .filter((a) => a.family === 'IPv4' || a.family === 4)
    .map((a) => {
      const linkLocal = a.address.startsWith('169.254.');
      return { name, address: a.address, connected: !a.internal && !linkLocal, usable: !a.internal && !linkLocal && !VIRTUAL.test(name) };
    }));
}

export function defaultRouteAddress() {
  return new Promise((resolvePromise) => {
    const sock = dgram.createSocket('udp4');
    const done = (ip) => {
      try {
        sock.close();
      } catch {}
      resolvePromise(ip);
    };
    sock.once('error', () => done(null));
    try {
      sock.connect(9, ROUTE_PROBE, () => {
        try {
          done(sock.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

const describe = (addresses, routed) =>
  addresses.map((a) => `${a.address} (${a.name}${a.address === routed ? ', default route, probably internet' : ''})`).join(', ') || 'none';

/** Decide which address phones are sent to. `configured` is "auto", an IPv4 address, or an adapter name. */
export function chooseAddress({ configured, addresses, routed }) {
  if (isIPv4(configured)) {
    if (!addresses.some((a) => a.address === configured)) {
      throw new AddressError(`${configured} is not an address of this machine (it has: ${describe(addresses)})`);
    }
    return { ip: configured, how: 'fixed address' };
  }
  if (configured !== 'auto') {
    const named = addresses.filter((a) => a.name === configured);
    const matches = named.length ? named : addresses.filter((a) => a.name.toLowerCase() === configured.toLowerCase());
    const live = matches.find((a) => a.connected);
    if (live) return { ip: live.address, how: `adapter ${live.name}` };
    const names = [...new Set(addresses.filter((a) => a.connected).map((a) => a.name))].join(', ') || 'none';
    throw new AddressError(matches.length
      ? `adapter "${configured}" has no usable IPv4 address; is it connected to the event Wi-Fi?`
      : `no adapter named "${configured}" (connected adapters: ${names})`);
  }
  const usable = addresses.filter((a) => a.usable);
  if (usable.length === 1) return { ip: usable[0].address, how: `auto: ${usable[0].name}, the only network` };
  if (usable.length === 0) {
    throw new AddressError('no network address found; join the event Wi-Fi first');
  }
  // With two real networks the default route is usually the internet one, never the booth Wi-Fi.
  throw new AddressError(`connected to several networks: ${describe(usable, routed)}. ` +
    'Set laptopIp in config.json (or pass --ip) to the event Wi-Fi adapter name or address, for example "en0" or "Wi-Fi"');
}

export async function detectAddress(configured) {
  return chooseAddress({ configured, addresses: localAddresses(), routed: await defaultRouteAddress() });
}

/**
 * Re-checks the address and reports changes and problems once each, so a DHCP renewal or a
 * dropped Wi-Fi mid-event is either followed (auto) or shouted about (fixed address).
 */
export function addressFollower({ initial, detect, onChange, onProblem, onRecovered }) {
  let current = initial;
  let problem = null;
  return {
    get current() {
      return current;
    },
    async check() {
      let next;
      try {
        next = await detect();
      } catch (e) {
        if (e.message !== problem) onProblem(e.message);
        problem = e.message;
        return;
      }
      if (problem !== null) onRecovered(next.ip);
      problem = null;
      if (next.ip !== current.ip) {
        const previous = current;
        current = next;
        await onChange(next, previous);
      }
    },
  };
}
