import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];
const LOG_FIELDS = ['id', 'name', 'phone', 'source', 'eventCode'];
const MAX_LOG_REWRITE_BYTES = 64 * 1024 * 1024;
export const CSV_RETRY_MS = 15000;
// Windows refuses to replace a file another app holds open, which is what Excel does with a CSV.
const LOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** The reason a CSV rewrite failed, in words the operator can act on. */
export function csvProblem(e, platform = process.platform) {
  if (platform === 'win32' && LOCKED_CODES.has(e.code)) {
    return `it is open in another app (probably Excel). It catches up within ${CSV_RETRY_MS / 1000} seconds of closing it; ` +
      'use Download CSV on the admin page for a copy to open';
  }
  return e.message;
}

const openLog = (path) =>
  openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);

/** Whether a log line belongs to a registration deleted at `until` (a later re-registration is kept). */
function erases(line, { phone, until }) {
  try {
    const entry = JSON.parse(line);
    return entry.phone === phone && !(Date.parse(entry.ts) > Date.parse(until));
  } catch {
    return line.includes(phone);
  }
}

const MAX_PENDING_BYTES = 1024 * 1024;
const validPending = (e) => e && Number.isSafeInteger(e.id) && typeof e.phone === 'string' && /^\+\d{8,15}$/.test(e.phone) &&
  typeof e.until === 'string' && !Number.isNaN(Date.parse(e.until));
const IST_OFFSET_MS = 330 * 60 * 1000; // India has no daylight saving, so a fixed +05:30 is exact

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-15T13:48:30Z" -> "15 Oct, 7:18 pm" in India time, for people reading a table. */
export function toISTShort(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso ?? '';
  const d = new Date(t + IST_OFFSET_MS);
  const h = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${h % 12 || 12}:${mm} ${h < 12 ? 'am' : 'pm'}`;
}

/** "2026-10-15T13:48:30Z" -> "2026-10-15 19:18 IST"; anything unparseable is returned as-is. */
export function toIST(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso ?? '';
  return `${new Date(t + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} IST`;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // ';' too: spreadsheets in semicolon locales would otherwise start a new, possibly formula, cell.
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const SOURCE_LABELS = { form: 'Wi-Fi form', whatsapp: 'WhatsApp message' };
// Spreadsheet columns for people, not code: [header, value, guard against formula injection].
const SHEET = [
  ['ID', (l) => l.id, false],
  ['Name', (l) => l.name, true],
  ['WhatsApp number', (l) => l.phone, false],
  ['Came in via', (l) => SOURCE_LABELS[l.source] ?? l.source, true],
  ['Event', (l) => l.eventCode, true],
  ['Signed up (IST)', (l) => toIST(l.createdAt), false],
  ['Notice version', (l) => l.noticeVersion, true],
];

export function leadsCsv(leads) {
  const lines = [SHEET.map(([header]) => header).join(',')];
  for (const lead of leads) {
    lines.push(SHEET.map(([, value, guard]) => {
      const v = value(lead);
      const risky = guard && typeof v === 'string' && CSV_FORMULA_PREFIXES.some((p) => v.startsWith(p));
      return csvCell(risky ? `'${v}` : v);
    }).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * Human-facing copies of the lead table: a CSV rewritten whole after every change, and an
 * append-only JSON Lines log. The database stays the source of truth, so a failed file write
 * is reported but never fails the sign-up.
 */
export class LeadFiles {
  constructor({ csvPath, logPath, onError = (msg) => console.error(msg), onInfo = (msg) => console.log(msg), platform = process.platform }) {
    this.csvPath = resolve(csvPath);
    this.logPath = resolve(logPath);
    this.onError = onError;
    this.onInfo = onInfo;
    this.platform = platform;
    this.problems = new Map();
    this.pendingCsv = null;
    // Deletions not yet scrubbed from the log, kept on disk so a restart still finishes them.
    this.pendingPath = join(dirname(this.logPath), 'pending-erasures.json');
    this.pendingErasures = new Map();
    mkdirSync(dirname(this.logPath), { recursive: true });
    // O_NOFOLLOW: a symlink planted at the log path must not redirect our writes (absent on Windows,
    // where creating a symlink needs admin rights anyway).
    this.logFd = openLog(this.logPath);
    this.loadPending();
    if (this.pendingErasures.size) this.flushErasures();
  }

  loadPending() {
    let entries;
    try {
      if (statSync(this.pendingPath).size > MAX_PENDING_BYTES) throw new Error('too large');
      entries = JSON.parse(readFileSync(this.pendingPath, 'utf8'));
      if (!Array.isArray(entries) || !entries.every(validPending)) throw new Error('not a list of pending erasures');
    } catch (e) {
      if (e.code !== 'ENOENT') this.fail(this.pendingPath, new Error(`ignored, so these deletions may still be in the log: ${e.message}`));
      return;
    }
    for (const e of entries) this.pendingErasures.set(e.phone, { id: e.id, phone: e.phone, until: e.until });
  }

  savePending() {
    try {
      if (this.pendingErasures.size === 0) {
        unlinkSync(this.pendingPath);
      } else {
        const tmp = `${this.pendingPath}.${randomBytes(6).toString('hex')}.tmp`;
        writeFileSync(tmp, JSON.stringify([...this.pendingErasures.values()]), { flag: 'wx', mode: 0o600 });
        renameSync(tmp, this.pendingPath);
      }
      this.problems.delete(this.pendingPath);
    } catch (e) {
      if (e.code !== 'ENOENT') this.fail(this.pendingPath, e);
    }
  }

  record(event, lead, fields = LOG_FIELDS) {
    const entry = { ts: new Date().toISOString(), event };
    for (const field of fields) entry[field] = lead[field] ?? null;
    const buf = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
    try {
      if (this.logFd === null) throw new Error('log is closed after a failed rewrite');
      let offset = 0;
      while (offset < buf.length) offset += writeSync(this.logFd, buf, offset);
      this.problems.delete(this.logPath);
    } catch (e) {
      this.fail(this.logPath, e);
    }
  }

  sync(leads) {
    // Exclusive-create a fresh temp file, then rename over the target: readers never see a
    // half-written sheet, and a symlink at the target is replaced rather than followed.
    const tmp = `${this.csvPath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, leadsCsv(leads), { flag: 'wx', mode: 0o600 });
      renameSync(tmp, this.csvPath);
      this.pendingCsv = null;
      if (this.problems.delete(this.csvPath)) this.onInfo(`updated again: ${this.csvPath}`);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {}
      this.pendingCsv = leads;
      this.fail(this.csvPath, Object.assign(new Error(csvProblem(e, this.platform)), { code: e.code }));
    }
  }

  /** Retry deletions and a CSV rewrite that failed, without waiting for the next change. True if any was pending. */
  retry() {
    const pending = this.pendingErasures.size > 0 || this.pendingCsv !== null;
    if (this.pendingErasures.size) this.flushErasures();
    if (this.pendingCsv) this.sync(this.pendingCsv);
    return pending;
  }

  /** Whether a deleted person may still be in the log or the spreadsheet. */
  stillHolds(lead) {
    return this.pendingErasures.has(lead.phone) || this.pendingCsv !== null;
  }

  /**
   * Erase a deleted person from the log: append a deletion entry that carries only the id (now, as
   * ids can be reused), then rewrite the log without their lines. A failed rewrite stays pending
   * and is retried. True if erased.
   */
  forget(lead) {
    const until = new Date().toISOString();
    this.record('lead.deleted', lead, ['id']);
    this.pendingErasures.set(lead.phone, { id: lead.id, phone: lead.phone, until });
    this.flushErasures();
    return !this.pendingErasures.has(lead.phone);
  }

  flushErasures() {
    for (const entry of [...this.pendingErasures.values()]) {
      if (!this.scrub(entry)) break;
      this.pendingErasures.delete(entry.phone);
    }
    this.savePending();
    const n = this.pendingErasures.size;
    if (n) {
      this.problems.set('erasures', {
        key: n,
        text: `${this.logPath} still holds ${n} deleted registration${n === 1 ? '' : 's'}; retrying every ${CSV_RETRY_MS / 1000} seconds`,
      });
    } else {
      this.problems.delete('erasures');
    }
  }

  scrub(entry) {
    const tmp = `${this.logPath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      if (statSync(this.logPath).size > MAX_LOG_REWRITE_BYTES) throw new Error('log too large to rewrite');
      const kept = readFileSync(this.logPath, 'utf8').split('\n').filter((line) => line && !erases(line, entry));
      writeFileSync(tmp, kept.map((line) => `${line}\n`).join(''), { flag: 'wx', mode: 0o600 });
      // The append handle points at the old file; swap files, then reopen on the new one.
      closeSync(this.logFd);
      this.logFd = null;
      renameSync(tmp, this.logPath);
      this.logFd = openLog(this.logPath);
      this.problems.delete(this.logPath);
      return true;
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {}
      if (this.logFd === null) {
        try {
          this.logFd = openLog(this.logPath);
        } catch {}
      }
      this.fail(this.logPath, e);
      return false;
    }
  }

  fail(path, e) {
    // Messages carry random temp-file names, so a repeat is the same error code.
    const key = e.code ?? e.message;
    const repeat = this.problems.get(path)?.key === key;
    this.problems.set(path, { key, text: `${path} is not being updated: ${e.message}` });
    if (!repeat) this.onError(`not updated: ${path}: ${e.message}`);
  }

  warnings() {
    return [...this.problems.values()].map(({ text }) => text);
  }

  close() {
    if (this.logFd !== null) closeSync(this.logFd);
  }
}
