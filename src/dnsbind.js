import { startCatchAllDns } from './dns.js';

/**
 * Listen for DNS on the booth address itself so replies leave from the address phones asked.
 * macOS refuses a normal user port 53 on one address (EACCES) but allows it on all addresses; that is
 * only correct when the booth address is the adapter's sole address, which booth-ip arranges there.
 */
export async function startDnsOn(ip, port, start = startCatchAllDns, onQuery = null, platform = process.platform) {
  try {
    return { sock: await start({ answerIp: ip, host: ip, port, onQuery }), host: ip };
  } catch (e) {
    if (e.code !== 'EACCES' || platform !== 'darwin') throw explainPortError(e, port, 'UDP', platform);
  }
  try {
    return { sock: await start({ answerIp: ip, host: '0.0.0.0', port, onQuery }), host: '0.0.0.0' };
  } catch (e) {
    throw explainPortError(e, port, 'UDP', platform);
  }
}

/**
 * The bind error with a message saying what to do. On Windows EACCES means another program holds
 * the port (a wildcard socket blocks a specific-address bind), not a missing privilege.
 */
export function explainPortError(e, port, proto, platform = process.platform) {
  let message = e.message;
  if (e.code === 'EADDRINUSE' || (e.code === 'EACCES' && platform === 'win32')) {
    message = platform === 'win32'
      ? `${proto} port ${port} is already used by another program. Find it with "netstat -ano -p ${proto} | findstr :${port}" ` +
        'and look the last number (PID) up in Task Manager, Details tab. Port 53 is often Mobile Hotspot, Internet Connection ' +
        'Sharing, WSL or Hyper-V; port 80 under PID 4 is IIS or another Windows web service. Stop it and run npm start again.'
      : `${proto} port ${port} is already used by another program (is npm start already running?). ` +
        `Find it with "sudo lsof -nP -i ${proto}:${port}".`;
  } else if (e.code === 'EACCES' && platform === 'linux') {
    message = `${proto} port ${port} needs root or the setcap command in the README (Linux).`;
  }
  return Object.assign(new Error(message, { cause: e }), { code: e.code });
}

/** Other addresses on the booth address's /24: with a wildcard DNS socket, replies may leave from one. */
export function rivalAddresses(ip, addresses) {
  const net = ip.split('.').slice(0, 3).join('.');
  return addresses.filter((a) => a.connected && a.address !== ip && a.address.split('.').slice(0, 3).join('.') === net);
}
