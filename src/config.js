import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';

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
  lcqWinsToQualify: 'count',
  lcqLossesOut: 'count',
  lcqWaitAlertMin: 'minutes',
  lcqMatchAlertMin: 'minutes',
};
// Keys older config files lack: qualify at 4 wins, out at 2 losses; flag a 10-minute wait or a 15-minute match.
const DEFAULTS = { lcqWinsToQualify: 4, lcqLossesOut: 2, lcqWaitAlertMin: 10, lcqMatchAlertMin: 15 };
// Keys from the WhatsApp follow-up days. Named in the error so an old config.json is easy to fix.
const RETIRED = ['whatsappNumber', 'socials', 'socialsMessage', 'prefillMessage'];

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
      : type === 'count' ? Number.isInteger(value) && value >= 1 && value <= 20
      : type === 'minutes' ? Number.isInteger(value) && value >= 1 && value <= 240
      : typeof value === type;
    if (!ok) {
      const want = { port: 'an integer 1-65535', count: 'a whole number 1-20', minutes: 'a whole number of minutes, 1-240' }[type] ?? `a ${type}`;
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

  return Object.freeze({ ...raw });
}
