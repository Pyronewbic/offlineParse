import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SOURCES = ['form', 'whatsapp'];
// Gaming brackets. Staff pick which one new sign-ups join; a number can register once in each.
export const BRACKETS = { normal: 'Normal', lcq: 'LCQ' };
export const NAME_MAX = 80;
const V1_COLUMNS = [
  'id', 'name', 'phone', 'source', 'eventCode', 'consentAt',
  'noticeVersion', 'createdAt', 'updatedAt', 'socialsSentAt',
];
export const COLUMNS = [...V1_COLUMNS, 'bracket'];

// Bidi overrides can make a stored name render as different text in the admin view.
const STRIP_CHARS = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\u202A-\u202E\u2066-\u2069]/gu;

// Contacts autofill and copy-paste wrap numbers in invisible format characters (\p{Cf}) and Unicode dashes.
const PHONE_SEPARATORS = /[\s().\-\u2010-\u2015\u2212\p{Cf}]/gu;

const LEADS_TABLE = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('form', 'whatsapp')),
  eventCode TEXT NOT NULL,
  consentAt TEXT NOT NULL,
  noticeVersion TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  socialsSentAt TEXT,
  bracket TEXT NOT NULL DEFAULT 'normal' CHECK (bracket IN ('normal', 'lcq')),
  UNIQUE (phone, bracket)
);`;
const SCHEMA = `${LEADS_TABLE}
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

/**
 * Databases from before brackets had one row per number. Rebuild the table with the per-bracket rule,
 * every existing row as Normal, all in one transaction that keeps the old table unless every row copied.
 */
function addBrackets(db) {
  const cols = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
  if (cols.length === 0 || cols.includes('bracket')) return;
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const before = count('leads');
  const v1 = V1_COLUMNS.join(', ');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE leads RENAME TO leads_v1; ${LEADS_TABLE}
      INSERT INTO leads (${v1}, bracket) SELECT ${v1}, 'normal' FROM leads_v1;`);
    const after = count('leads');
    if (after !== before) throw new Error(`bracket upgrade copied ${after} of ${before} registrations`);
    db.exec('DROP TABLE leads_v1; COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

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
    addBrackets(this.db);
    this.db.exec(SCHEMA);
    const cols = COLUMNS.join(', ');
    this.stmts = {
      byPhone: this.db.prepare(`SELECT ${cols} FROM leads WHERE phone = ? AND bracket = ?`),
      insert: this.db.prepare(
        'INSERT INTO leads (phone, name, source, eventCode, consentAt, noticeVersion, createdAt, updatedAt, bracket)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(phone, bracket) DO NOTHING'),
      getSetting: this.db.prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      list: this.db.prepare(`SELECT ${cols} FROM leads ORDER BY id`),
      get: this.db.prepare(`SELECT ${cols} FROM leads WHERE id = ?`),
      remove: this.db.prepare('DELETE FROM leads WHERE id = ?'),
    };
    this.files?.sync(this.list());
  }

  /** The bracket new sign-ups join; survives restarts. */
  bracket() {
    const value = this.stmts.getSetting.get('bracket')?.value;
    return Object.hasOwn(BRACKETS, value) ? value : 'normal';
  }

  setBracket(bracket) {
    if (!Object.hasOwn(BRACKETS, bracket)) throw new Error(`unknown bracket ${bracket}`);
    this.stmts.setSetting.run('bracket', bracket);
  }

  /**
   * Register a phone number once per bracket. A number already in that bracket is left untouched and
   * reported as { created: false, existing }; the UNIQUE constraint decides, so there is no race.
   */
  register({ name, phone, source, eventCode, noticeVersion, bracket = this.bracket() }) {
    if (!SOURCES.includes(source)) throw new Error(`unknown source ${source}`);
    if (!Object.hasOwn(BRACKETS, bracket)) throw new Error(`unknown bracket ${bracket}`);
    const ts = now();
    const { changes, lastInsertRowid } = this.stmts.insert.run(phone, name, source, eventCode, ts, noticeVersion, ts, ts, bracket);
    if (changes === 0) return { created: false, existing: { ...this.stmts.byPhone.get(phone, bracket) } };
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
