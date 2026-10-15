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
const STRIP_CHARS = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\u202A-\u202E\u2066-\u2069]/gu;

// Contacts autofill and copy-paste wrap numbers in invisible format characters (\p{Cf}) and Unicode dashes.
const PHONE_SEPARATORS = /[\s().\-\u2010-\u2015\u2212\p{Cf}]/gu;

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

export class ValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.field = field;
  }
}

function indianMobile(digits) {
  if (digits.length !== 10) {
    throw new ValidationError(`We counted ${digits.length} digits. Enter a 10-digit Indian mobile number, or include your country code with +.`, 'phone');
  }
  if (!'6789'.includes(digits[0])) throw new ValidationError('Indian mobile numbers start with 6, 7, 8 or 9.', 'phone');
  return digits;
}

export function normalizePhone(raw) {
  let s = String(raw ?? '').replace(PHONE_SEPARATORS, '');
  if (!s) throw new ValidationError('Please enter your WhatsApp number.', 'phone');
  if (s.length > 20) throw new ValidationError('That number is too long.', 'phone');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) {
    const digits = s.slice(1);
    if (!/^[0-9]+$/.test(digits)) throw new ValidationError('Use digits only after the +.', 'phone');
    if (digits.startsWith('91')) return `+91${indianMobile(digits.slice(2))}`;
    if (digits.length < 8 || digits.length > 15) {
      throw new ValidationError('International numbers need 8-15 digits after the +.', 'phone');
    }
    return `+${digits}`;
  }
  if (!/^[0-9]+$/.test(s)) throw new ValidationError('Use digits only.', 'phone');
  if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return `+91${indianMobile(s)}`;
}

export function cleanName(raw) {
  const name = String(raw ?? '').replace(STRIP_CHARS, '').split(/\s+/).filter(Boolean).join(' ');
  if (!name) throw new ValidationError('Please enter your name.', 'name');
  if ([...name].length > NAME_MAX) throw new ValidationError(`Name is too long (${NAME_MAX} characters max).`, 'name');
  return name;
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export class LeadStore {
  constructor(path, { files = null } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.files = files;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Overwrite deleted rows with zeros instead of leaving them in free pages: deletion must erase.
    this.db.exec('PRAGMA secure_delete = ON;');
    this.db.exec(SCHEMA);
    const cols = COLUMNS.join(', ');
    this.stmts = {
      byPhone: this.db.prepare(`SELECT ${cols} FROM leads WHERE phone = ?`),
      insert: this.db.prepare(
        'INSERT INTO leads (phone, name, source, eventCode, consentAt, noticeVersion, createdAt, updatedAt)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(phone) DO NOTHING'),
      list: this.db.prepare(`SELECT ${cols} FROM leads ORDER BY id`),
      get: this.db.prepare(`SELECT ${cols} FROM leads WHERE id = ?`),
      remove: this.db.prepare('DELETE FROM leads WHERE id = ?'),
    };
    this.files?.sync(this.list());
  }

  /**
   * Register a phone number once. A number that is already registered is left untouched and
   * reported as { created: false, existing }; the UNIQUE constraint decides, so there is no race.
   */
  register({ name, phone, source, eventCode, noticeVersion }) {
    if (!SOURCES.includes(source)) throw new Error(`unknown source ${source}`);
    const ts = now();
    const { changes, lastInsertRowid } = this.stmts.insert.run(phone, name, source, eventCode, ts, noticeVersion, ts, ts);
    if (changes === 0) return { created: false, existing: { ...this.stmts.byPhone.get(phone) } };
    this.changed('lead.created', Number(lastInsertRowid));
    return { created: true };
  }

  list() {
    return this.stmts.list.all().map((row) => ({ ...row }));
  }

  get(id) {
    const row = this.stmts.get.get(id);
    return row ? { ...row } : null;
  }

  /** Delete one registration everywhere it is stored. Returns the deleted row, or null. */
  remove(id) {
    const lead = this.get(id);
    if (!lead) return null;
    this.stmts.remove.run(id);
    // Fold the WAL back in and truncate it, so the pre-delete page images do not linger there.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    if (this.files) {
      this.files.forget(lead);
      this.files.sync(this.list());
    }
    return lead;
  }

  changed(event, id) {
    if (!this.files) return;
    this.files.record(event, this.get(id));
    this.files.sync(this.list());
  }

  close() {
    this.db.close();
  }
}
