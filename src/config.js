import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { cleanMac } from './routerban.js';

const FIELD_TYPES = {
  orgName: 'string',
  eventName: 'string',
  eventCode: 'string',
  wifiSsid: 'string',
  wifiPassword: 'string',
  laptopIp: 'string',
  httpPort: 'port',
  dnsPort: 'port',
  dbPath: 'string',
  logoLight: 'string',
  logoDark: 'string',
  noticeVersion: 'string',
  lcqWaitAlertMin: 'minutes',
  lcqMatchAlertMin: 'minutes',
  games: 'games',
  routerBan: 'routerBan',
};
// Keys older config files lack: flag a 10-minute wait or a 15-minute match.
// No games means guests pick none and registrations carry no game.
// Dropping registered phones from the Wi-Fi needs an OpenWrt router (see README), so it is off unless set.
const ROUTER_BAN_OFF = { enabled: false, host: '100.64.0.1', certSha256: '', afterMin: 3, hours: 24, never: [] };
const DEFAULTS = { lcqWaitAlertMin: 10, lcqMatchAlertMin: 15, games: [], routerBan: ROUTER_BAN_OFF };
export const MAX_GAMES = 12;
export const GAME_MAX = 40; // characters, counted as code points
// Keys from the WhatsApp follow-up days and the LCQ rules before single elimination.
// Named in the error so an old config.json is easy to fix.
const RETIRED = ['whatsappNumber', 'socials', 'socialsMessage', 'prefillMessage', 'lcqWinsToQualify', 'lcqLossesOut'];

export class ConfigError extends Error {}

export function loadConfig(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`cannot read ${path}: ${e.message}`);
  }
  return configFromObject(raw);
}

export function configFromObject(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('config must be a JSON object');
  }
  raw = { ...DEFAULTS, ...raw };
  const names = Object.keys(FIELD_TYPES);
  const retired = Object.keys(raw).filter((k) => RETIRED.includes(k));
  if (retired.length) throw new ConfigError(`no longer used, delete from config.json: ${retired.join(', ')}`);
  const unknown = Object.keys(raw).filter((k) => !names.includes(k));
  const missing = names.filter((k) => !(k in raw));
  if (unknown.length) throw new ConfigError(`unknown config keys: ${unknown.join(', ')}`);
  if (missing.length) throw new ConfigError(`missing config keys: ${missing.join(', ')}`);

  for (const [key, type] of Object.entries(FIELD_TYPES)) {
    const value = raw[key];
    const ok =
      type === 'port' ? Number.isInteger(value) && value >= 1 && value <= 65535
      : type === 'minutes' ? Number.isInteger(value) && value >= 1 && value <= 240
      : type === 'games' ? Array.isArray(value)
      : type === 'routerBan' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : typeof value === type;
    if (!ok) {
      const want = { port: 'an integer 1-65535', minutes: 'a whole number of minutes, 1-240',
        games: 'a list of game names', routerBan: 'an object (see README)' }[type] ?? `a ${type}`;
      throw new ConfigError(`${key} must be ${want}`);
    }
  }

  for (const key of ['orgName', 'eventName', 'dbPath', 'noticeVersion']) {
    if (!raw[key].trim()) throw new ConfigError(`${key} must not be empty`);
  }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(raw.eventCode)) {
    throw new ConfigError('eventCode must be 1-32 chars of A-Z a-z 0-9 _ -');
  }
  const ssidBytes = Buffer.byteLength(raw.wifiSsid, 'utf8');
  if (ssidBytes < 1 || ssidBytes > 32) throw new ConfigError('wifiSsid must be 1-32 bytes');
  if (raw.wifiPassword && (raw.wifiPassword.length < 8 || raw.wifiPassword.length > 63)) {
    throw new ConfigError('wifiPassword must be empty (open network) or 8-63 characters');
  }
  if (!/^[^\p{C}]{1,64}$/u.test(raw.laptopIp) || raw.laptopIp.trim() !== raw.laptopIp) {
    throw new ConfigError('laptopIp must be "auto", an IPv4 address, or a network adapter name such as "en0" or "Wi-Fi"');
  }
  if (/^[0-9.]+$/.test(raw.laptopIp) && !isIPv4(raw.laptopIp)) {
    throw new ConfigError(`laptopIp "${raw.laptopIp}" looks like an address but is not a valid IPv4 address`);
  }

  for (const key of ['logoLight', 'logoDark']) {
    if (raw[key].length > 512 || /\p{C}/u.test(raw[key])) throw new ConfigError(`${key} must be a file path or empty`);
  }

  if (raw.games.length > MAX_GAMES) throw new ConfigError(`games: at most ${MAX_GAMES}`);
  for (const game of raw.games) {
    if (typeof game !== 'string' || !game || game.trim() !== game || [...game].length > GAME_MAX || /\p{C}/u.test(game)) {
      throw new ConfigError(`games: each must be a name of 1-${GAME_MAX} characters with no spaces at the ends or hidden characters`);
    }
  }
  const lower = raw.games.map((g) => g.toLocaleLowerCase());
  if (new Set(lower).size !== lower.length) throw new ConfigError('games: each name must be different');

  return Object.freeze({ ...raw, games: Object.freeze([...raw.games]), routerBan: routerBanFrom(raw.routerBan) });
}

const PRIVATE = [[10, 0, 8], [172, 16, 12], [192, 168, 16], [100, 64, 10]];
const inRange = (ip, [a, b, bits]) => {
  const n = ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
  return n >>> (32 - bits) === ((a * 256 + b) * 65536) >>> (32 - bits);
};

function routerBanFrom(raw) {
  const keys = Object.keys(ROUTER_BAN_OFF);
  const unknown = Object.keys(raw).filter((k) => !keys.includes(k));
  if (unknown.length) throw new ConfigError(`routerBan: unknown keys: ${unknown.join(', ')}`);
  const v = { ...ROUTER_BAN_OFF, ...raw };
  if (typeof v.enabled !== 'boolean') throw new ConfigError('routerBan.enabled must be true or false');
  // The router is on the booth network itself: a private address, never a public or cloud-metadata one.
  if (typeof v.host !== 'string' || !isIPv4(v.host) || !PRIVATE.some((r) => inRange(v.host, r))) {
    throw new ConfigError('routerBan.host must be the router\'s IPv4 address on the booth network (10.x, 172.16-31.x, 192.168.x or 100.64-127.x)');
  }
  const pin = typeof v.certSha256 === 'string' ? v.certSha256.replaceAll(':', '').toLowerCase() : null;
  if (pin === null || (pin && !/^[0-9a-f]{64}$/.test(pin))) throw new ConfigError('routerBan.certSha256 must be the router certificate\'s SHA-256 fingerprint (64 hex digits)');
  if (v.enabled && !pin) throw new ConfigError('routerBan.certSha256 is needed when routerBan.enabled is true');
  if (!Number.isInteger(v.afterMin) || v.afterMin < 1 || v.afterMin > 60) throw new ConfigError('routerBan.afterMin must be a whole number of minutes, 1-60');
  // hostapd takes the ban as a 32-bit count of milliseconds: 500 h fits, 600 h would not.
  if (!Number.isInteger(v.hours) || v.hours < 1 || v.hours > 500) throw new ConfigError('routerBan.hours must be a whole number of hours, 1-500');
  if (!Array.isArray(v.never) || v.never.length > 32 || v.never.some((m) => !cleanMac(m))) {
    throw new ConfigError('routerBan.never must be a list of up to 32 device Wi-Fi addresses like "a4:83:e7:01:02:03"');
  }
  return Object.freeze({ ...v, certSha256: pin, never: Object.freeze(v.never.map(cleanMac)) });
}
