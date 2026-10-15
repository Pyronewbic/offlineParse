import { isIPv4 } from 'node:net';

export class BoothIpError extends Error {}

const toInt = (ip) => ip.split('.').reduce((n, octet) => ((n << 8) + Number(octet)) >>> 0, 0);
const toIp = (n) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
const maskBits = (prefix) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
const networkOf = (ip, prefix) => (toInt(ip) & maskBits(prefix)) >>> 0;
export const sameSubnet = (a, b, prefix) => networkOf(a, prefix) === networkOf(b, prefix);
export const prefixToMask = (prefix) => toIp(maskBits(prefix));

/** Map device -> network service name from `networksetup -listnetworkserviceorder` output. */
export function parseServiceOrder(text) {
  const services = new Map();
  for (const m of String(text).matchAll(/^\((?:\d+|\*)\)\s+(.+?)\s*\r?\n\(Hardware Port: [^,]*, Device: ([^)]*)\)/gm)) {
    if (m[2]) services.set(m[2], m[1]);
  }
  return services;
}

function macService(iface, services) {
  const service = services?.get(iface);
  if (!service) throw new BoothIpError(`could not find the macOS network service for ${iface} (networksetup -listnetworkserviceorder)`);
  return service;
}

function upSteps(platform, iface, ip, prefix, gateway, services) {
  // macOS only lets a normal user open port 53 on all addresses, so the booth address must be the
  // adapter's only one (an extra alias would make DNS replies leave from the other address).
  if (platform === 'darwin') {
    return [['sudo', ['networksetup', '-setmanual', macService(iface, services), ip, prefixToMask(prefix), gateway]]];
  }
  if (platform === 'linux') return [['sudo', ['ip', 'addr', 'add', `${ip}/${prefix}`, 'dev', iface]]];
  if (platform === 'win32') {
    return [['netsh', ['interface', 'ipv4', 'set', 'address', iface, 'static', ip, prefixToMask(prefix), gateway]]];
  }
  throw new BoothIpError(`booth-ip does not support ${platform}; add ${ip} to the Wi-Fi adapter by hand`);
}

function undoSteps(platform, iface, ip, prefix, services) {
  if (platform === 'darwin') return [['sudo', ['networksetup', '-setdhcp', macService(iface, services)]]];
  if (platform === 'linux') return [['sudo', ['ip', 'addr', 'del', `${ip}/${prefix}`, 'dev', iface]]];
  if (platform === 'win32') return [['netsh', ['interface', 'ipv4', 'set', 'address', iface, 'dhcp']]];
  throw new BoothIpError(`booth-ip does not support ${platform}`);
}

/**
 * Work out the commands that give this machine the booth address (or take it away with undo).
 * Pure: `addresses` comes from netaddr.localAddresses(), so tests can describe any machine.
 */
export function planBoothIp({ platform, addresses, boothIp, undo = false, prefix = 24, gateway, services }) {
  if (!isIPv4(boothIp)) {
    throw new BoothIpError(`laptopIp in config.json must be the fixed booth address, e.g. "100.64.0.2" (it is "${boothIp}")`);
  }
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) throw new BoothIpError('--prefix must be a whole number from 8 to 30');
  const gw = gateway ?? toIp(networkOf(boothIp, prefix) + 1);
  if (!isIPv4(gw) || !sameSubnet(gw, boothIp, prefix) || gw === boothIp) {
    throw new BoothIpError(`gateway ${gw} must be another address on the same network as ${boothIp}`);
  }
  const subnet = `${toIp(networkOf(boothIp, prefix))}/${prefix}`;
  const holder = addresses.find((a) => a.address === boothIp);

  if (undo) {
    if (!holder) return { steps: [], note: `${boothIp} is not on this machine, so there is nothing to undo.` };
    return { iface: holder.name, steps: undoSteps(platform, holder.name, boothIp, prefix, services) };
  }
  if (holder) return { iface: holder.name, steps: [], note: `${boothIp} is already on ${holder.name}. Run npm start.` };

  const names = [...new Set(addresses.filter((a) => a.connected && sameSubnet(a.address, boothIp, prefix)).map((a) => a.name))];
  if (names.length === 0) throw new BoothIpError(`no network adapter is on ${subnet}; join the booth Wi-Fi first`);
  if (names.length > 1) {
    throw new BoothIpError(`several adapters are on ${subnet} (${names.join(', ')}); disconnect all but the booth Wi-Fi`);
  }
  return { iface: names[0], steps: upSteps(platform, names[0], boothIp, prefix, gw, services) };
}

/**
 * Run a plan, then confirm the address really appeared (or went away) instead of trusting exit codes.
 * `run(cmd, args)` returns an exit status; `hasAddress()` re-reads the machine's addresses.
 */
export async function applyBoothIp({ plan, boothIp, undo, run, hasAddress, log, sleep, attempts = 10 }) {
  for (const [cmd, args] of plan.steps) {
    log(`> ${cmd} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    const status = run(cmd, args);
    if (status !== 0) throw new BoothIpError(`${cmd} failed (exit ${status}); nothing else was changed`);
  }
  for (let i = 0; i < attempts; i++) {
    if (hasAddress() !== undo) return;
    await sleep(500);
  }
  throw new BoothIpError(undo
    ? `the command ran but ${boothIp} is still on this machine`
    : `the command ran but ${boothIp} did not appear on ${plan.iface}`);
}
