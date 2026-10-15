import { startCatchAllDns } from './dns.js';

/**
 * Listen for DNS on the booth address itself so replies leave from the address phones asked.
 * macOS refuses a normal user port 53 on one address (EACCES) but allows it on all addresses; that is
 * only correct when the booth address is the adapter's sole address, which booth-ip arranges there.
 */
export async function startDnsOn(ip, port, start = startCatchAllDns) {
  try {
    return { sock: await start({ answerIp: ip, host: ip, port }), host: ip };
  } catch (e) {
    if (e.code !== 'EACCES') throw e;
  }
  return { sock: await start({ answerIp: ip, host: '0.0.0.0', port }), host: '0.0.0.0' };
}

/** Other addresses on the booth address's /24: with a wildcard DNS socket, replies may leave from one. */
export function rivalAddresses(ip, addresses) {
  const net = ip.split('.').slice(0, 3).join('.');
  return addresses.filter((a) => a.connected && a.address !== ip && a.address.split('.').slice(0, 3).join('.') === net);
}
