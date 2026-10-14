import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { fill } from './payloads.js';

export const SOCIAL_KEYS = ['instagram', 'youtube', 'discord'];

const FIELD_TYPES = {
  orgName: 'string',
  eventName: 'string',
  eventCode: 'string',
  whatsappNumber: 'string',
  wifiSsid: 'string',
  wifiPassword: 'string',
  laptopIp: 'string',
  httpPort: 'port',
  dnsPort: 'port',
  dbPath: 'string',
  noticeVersion: 'string',
  socials: 'object',
  socialsMessage: 'string',
  prefillMessage: 'string',
};

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
  const names = Object.keys(FIELD_TYPES);
  const unknown = Object.keys(raw).filter((k) => !names.includes(k));
  const missing = names.filter((k) => !(k in raw));
  if (unknown.length) throw new ConfigError(`unknown config keys: ${unknown.join(', ')}`);
  if (missing.length) throw new ConfigError(`missing config keys: ${missing.join(', ')}`);

  for (const [key, type] of Object.entries(FIELD_TYPES)) {
    const value = raw[key];
    const ok =
      type === 'port' ? Number.isInteger(value) && value >= 1 && value <= 65535
      : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : typeof value === type;
    if (!ok) throw new ConfigError(`${key} must be ${type === 'port' ? 'an integer 1-65535' : `a ${type}`}`);
  }

  for (const key of ['orgName', 'eventName', 'dbPath', 'noticeVersion']) {
    if (!raw[key].trim()) throw new ConfigError(`${key} must not be empty`);
  }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(raw.eventCode)) {
    throw new ConfigError('eventCode must be 1-32 chars of A-Z a-z 0-9 _ -');
  }
  if (!/^[0-9]{8,15}$/.test(raw.whatsappNumber)) {
    throw new ConfigError('whatsappNumber must be 8-15 digits with country code, no +, e.g. 919876543210');
  }
  const ssidBytes = Buffer.byteLength(raw.wifiSsid, 'utf8');
  if (ssidBytes < 1 || ssidBytes > 32) throw new ConfigError('wifiSsid must be 1-32 bytes');
  if (raw.wifiPassword && (raw.wifiPassword.length < 8 || raw.wifiPassword.length > 63)) {
    throw new ConfigError('wifiPassword must be empty (open network) or 8-63 characters');
  }
  if (raw.laptopIp !== 'auto' && !isIPv4(raw.laptopIp)) {
    throw new ConfigError('laptopIp must be "auto" or an IPv4 address');
  }

  const socialKeys = Object.keys(raw.socials).sort();
  if (socialKeys.join() !== [...SOCIAL_KEYS].sort().join()) {
    throw new ConfigError(`socials must have exactly the keys ${SOCIAL_KEYS.join(', ')}`);
  }
  for (const [key, url] of Object.entries(raw.socials)) {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new ConfigError(`socials.${key} must be an https:// URL`);
    }
  }

  const sample = { name: 'x', orgName: 'x', eventName: 'x', eventCode: 'x', ...raw.socials };
  for (const key of ['socialsMessage', 'prefillMessage']) {
    try {
      fill(raw[key], sample);
    } catch (e) {
      throw new ConfigError(`${key}: ${e.message}`);
    }
  }
  return Object.freeze({ ...raw, socials: Object.freeze({ ...raw.socials }) });
}
