import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SOURCES = ['form', 'whatsapp'];
export const NAME_MAX = 80;
export const COLUMNS = [
  'id', 'name', 'phone', 'source', 'eventCode', 'consentAt',
  'noticeVersion', 'createdAt', 'updatedAt', 'socialsSentAt',
];

// Bidi overrides can make a stored name render as different text in the admin view.
const STRIP_CHARS = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}‪-‮⁦-⁩]/gu;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('form', 'whatsapp')),
  eventCode TEXT NOT NULL,
  consentAt TEXT NOT NULL,
  noticeVersion TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  socialsSentAt TEXT
);`;

export class ValidationError extends Error {}

function indianMobile(digits) {
  if (digits.length === 10 && '6789'.includes(digits[0])) return digits;
  throw new ValidationError('Enter a 10-digit Indian mobile number, or include your country code with +.');
}

export function normalizePhone(raw) {
  let s = String(raw ?? '').replace(/[\s\-().]/g, '');
  if (!s) throw new ValidationError('Please enter your WhatsApp number.');
  if (s.length > 20) throw new ValidationError('That number is too long.');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) {
    const digits = s.slice(1);
    if (!/^[0-9]+$/.test(digits)) throw new ValidationError('Use digits only after the +.');
    if (digits.startsWith('91')) return `+91${indianMobile(digits.slice(2))}`;
    if (digits.length < 8 || digits.length > 15) {
      throw new ValidationError('International numbers need 8-15 digits after the +.');
    }
    return `+${digits}`;
  }
  if (!/^[0-9]+$/.test(s)) throw new ValidationError('Use digits only.');
  if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return `+91${indianMobile(s)}`;
}

export function cleanName(raw) {
  const name = String(raw ?? '').replace(STRIP_CHARS, '').split(/\s+/).filter(Boolean).join(' ');
  if (!name) throw new ValidationError('Please enter your name.');
  if ([...name].length > NAME_MAX) throw new ValidationError(`Name is too long (${NAME_MAX} characters max).`);
  return name;
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export class LeadStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    const cols = COLUMNS.join(', ');
    this.stmts = {
      byPhone: this.db.prepare('SELECT id FROM leads WHERE phone = ?'),
      insert: this.db.prepare(
        'INSERT INTO leads (phone, name, source, eventCode, consentAt, noticeVersion, createdAt, updatedAt)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      refresh: this.db.prepare(
        'UPDATE leads SET name = ?, consentAt = ?, noticeVersion = ?, updatedAt = ? WHERE id = ?'),
      list: this.db.prepare(`SELECT ${cols} FROM leads ORDER BY id`),
      get: this.db.prepare(`SELECT ${cols} FROM leads WHERE id = ?`),
      markSent: this.db.prepare('UPDATE leads SET socialsSentAt = ? WHERE id = ? AND socialsSentAt IS NULL'),
    };
  }

  /** Insert or refresh a lead keyed on phone. Returns true if it was new. */
  upsert({ name, phone, source, eventCode, noticeVersion }) {
    if (!SOURCES.includes(source)) throw new Error(`unknown source ${source}`);
    const ts = now();
    const existing = this.stmts.byPhone.get(phone);
    if (existing) {
      this.stmts.refresh.run(name, ts, noticeVersion, ts, existing.id);
      return false;
    }
    this.stmts.insert.run(phone, name, source, eventCode, ts, noticeVersion, ts, ts);
    return true;
  }

  list() {
    return this.stmts.list.all().map((row) => ({ ...row }));
  }

  get(id) {
    const row = this.stmts.get.get(id);
    return row ? { ...row } : null;
  }

  markSent(id) {
    return this.stmts.markSent.run(now(), id).changes === 1;
  }

  close() {
    this.db.close();
  }
}
