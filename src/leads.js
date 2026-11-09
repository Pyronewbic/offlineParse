import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Where a registration came from: the guest's own phone, or staff entering it at the desk.
export const SOURCES = ['form', 'desk'];
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

// A number registers once per bracket in each event.
const UNIQUE_RULE = 'UNIQUE (phone, bracket, eventCode)';
const LEADS_TABLE = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('form', 'desk')),
  eventCode TEXT NOT NULL,
  consentAt TEXT NOT NULL,
  noticeVersion TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  socialsSentAt TEXT,
  bracket TEXT NOT NULL DEFAULT 'normal' CHECK (bracket IN ('normal', 'lcq')),
  ${UNIQUE_RULE}
);`;
const SCHEMA = `${LEADS_TABLE}
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (code TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL);`;

/**
 * Older databases had one row per number (before brackets), called desk entries 'whatsapp', or allowed a
 * number once per bracket across all events. Rebuild the table to today's schema in one transaction that
 * keeps the old table unless every row copied; columns it lacked take their defaults.
 */
function upgrade(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leads'").get();
  if (!table || (table.sql.includes(UNIQUE_RULE) && !table.sql.includes("'whatsapp'"))) return;
  const old = new Set(db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name));
  const cols = COLUMNS.filter((c) => old.has(c));
  const count = (name) => db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
  const before = count('leads');
  const select = cols.map((c) => (c === 'source' ? "CASE source WHEN 'whatsapp' THEN 'desk' ELSE source END" : c)).join(', ');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE leads RENAME TO leads_old; ${LEADS_TABLE}
      INSERT INTO leads (${cols.join(', ')}) SELECT ${select} FROM leads_old;`);
    const after = count('leads');
    if (after !== before) throw new Error(`database upgrade copied ${after} of ${before} registrations`);
    db.exec('DROP TABLE leads_old; COMMIT;');
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
  if (!s) throw new ValidationError('Please enter your mobile number.', 'phone');
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
export const EVENT_CODE = /^[A-Za-z0-9_-]{1,32}$/;
const EVENT_NAME_MAX = 60;

export class LeadStore {
  constructor(path, { files = null, firstEvent = { code: 'event-1', name: 'Event 1' } } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.files = files;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Overwrite deleted rows with zeros instead of leaving them in free pages: deletion must erase.
    this.db.exec('PRAGMA secure_delete = ON;');
    upgrade(this.db);
    this.db.exec(SCHEMA);
    const cols = COLUMNS.join(', ');
    this.stmts = {
      byPhone: this.db.prepare(`SELECT ${cols} FROM leads WHERE phone = ? AND bracket = ? AND eventCode = ?`),
      insert: this.db.prepare(
        'INSERT INTO leads (phone, name, source, eventCode, consentAt, noticeVersion, createdAt, updatedAt, bracket)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(phone, bracket, eventCode) DO NOTHING'),
      getSetting: this.db.prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      list: this.db.prepare(`SELECT ${cols} FROM leads ORDER BY id`),
      get: this.db.prepare(`SELECT ${cols} FROM leads WHERE id = ?`),
      remove: this.db.prepare('DELETE FROM leads WHERE id = ?'),
      event: this.db.prepare('SELECT code, name, createdAt FROM events WHERE code = ?'),
      events: this.db.prepare('SELECT code, name, createdAt FROM events ORDER BY createdAt DESC, rowid DESC'),
      addEvent: this.db.prepare('INSERT OR IGNORE INTO events (code, name, createdAt) VALUES (?, ?, ?)'),
    };
    this.seedEvents(firstEvent);
    this.files?.sync(this.list());
  }

  /**
   * A new database starts with the configured event. One from before events gets an event for each
   * code its registrations carry, named after the configured event where the codes match.
   */
  seedEvents({ code, name }) {
    if (this.stmts.events.all().length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { eventCode, at } of this.db.prepare('SELECT eventCode, MIN(createdAt) AS at FROM leads GROUP BY eventCode').all()) {
        this.stmts.addEvent.run(eventCode, eventCode === code ? name : eventCode, at);
      }
      this.stmts.addEvent.run(code, name, now());
      this.stmts.setSetting.run('currentEvent', code);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Every event, newest first. */
  events() {
    return this.stmts.events.all().map((row) => ({ ...row }));
  }

  event(code) {
    const row = this.stmts.event.get(code);
    return row ? { ...row } : null;
  }

  /** The event new sign-ups join; survives restarts. */
  currentEvent() {
    return this.event(this.stmts.getSetting.get('currentEvent')?.value) ?? this.events()[0];
  }

  /** Start a new event and send new sign-ups to it. Earlier events keep their registrations. */
  startEvent(raw) {
    const name = String(raw ?? '').replace(STRIP_CHARS, '').split(/\s+/).filter(Boolean).join(' ');
    if (!name) throw new ValidationError('Give the new event a name.', 'event');
    if ([...name].length > EVENT_NAME_MAX) throw new ValidationError(`Event name is too long (${EVENT_NAME_MAX} characters max).`, 'event');
    const lower = name.toLocaleLowerCase();
    if (this.events().some((e) => e.name.toLocaleLowerCase() === lower)) throw new ValidationError(`There is already an event called "${name}".`, 'event');
    const base = name.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 24).replace(/^-+|-+$/g, '') || 'event';
    let code = base;
    for (let i = 2; this.stmts.event.get(code); i++) code = `${base}-${i}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.stmts.addEvent.run(code, name, now());
      this.stmts.setSetting.run('currentEvent', code);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.event(code);
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
   * Register a phone number once per bracket in an event. A number already there is left untouched and
   * reported as { created: false, existing }; the UNIQUE constraint decides, so there is no race.
   */
  register({ name, phone, source, noticeVersion, bracket = this.bracket(), eventCode = this.currentEvent().code }) {
    if (!SOURCES.includes(source)) throw new Error(`unknown source ${source}`);
    if (!Object.hasOwn(BRACKETS, bracket)) throw new Error(`unknown bracket ${bracket}`);
    if (!this.stmts.event.get(eventCode)) throw new Error(`unknown event ${eventCode}`);
    const ts = now();
    const { changes, lastInsertRowid } = this.stmts.insert.run(phone, name, source, eventCode, ts, noticeVersion, ts, ts, bracket);
    if (changes === 0) return { created: false, existing: { ...this.stmts.byPhone.get(phone, bracket, eventCode) } };
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
