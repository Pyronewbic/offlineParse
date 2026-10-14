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
    .map((a) => ({
      name,
      address: a.address,
      usable: !a.internal && !a.address.startsWith('169.254.') && !VIRTUAL.test(name),
    })));
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

const describe = (addresses) => addresses.map((a) => `${a.address} (${a.name})`).join(', ') || 'none';

/** Decide which address phones are sent to. `configured` is "auto" or an IPv4 address. */
export function chooseAddress({ configured, addresses, routed }) {
  if (configured !== 'auto') {
    if (!isIPv4(configured)) throw new AddressError(`"${configured}" is not an IPv4 address`);
    if (!addresses.some((a) => a.address === configured)) {
      throw new AddressError(`${configured} is not an address of this machine (it has: ${describe(addresses)})`);
    }
    return { ip: configured, how: 'set in config or --ip' };
  }
  const usable = addresses.filter((a) => a.usable);
  const viaRoute = usable.find((a) => a.address === routed);
  if (viaRoute) return { ip: viaRoute.address, how: `auto: ${viaRoute.name}, the default route` };
  if (usable.length === 1) return { ip: usable[0].address, how: `auto: ${usable[0].name}, the only network address` };
  if (usable.length === 0) {
    throw new AddressError('no network address found; join the event Wi-Fi first');
  }
  throw new AddressError(`several network addresses (${describe(usable)}) and none is the default route; ` +
    'set laptopIp in config.json or pass --ip to pick the event Wi-Fi one');
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
