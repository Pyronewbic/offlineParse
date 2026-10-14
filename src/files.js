import { randomBytes } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { COLUMNS } from './leads.js';

const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];
const LOG_FIELDS = ['id', 'name', 'phone', 'source', 'eventCode', 'socialsSentAt'];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function leadsCsv(leads) {
  const lines = [COLUMNS.join(',')];
  for (const lead of leads) {
    lines.push(COLUMNS.map((c) => {
      const v = lead[c];
      const guarded = c !== 'phone' && typeof v === 'string' && CSV_FORMULA_PREFIXES.some((p) => v.startsWith(p));
      return csvCell(guarded ? `'${v}` : v);
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
  constructor({ csvPath, logPath, onError = (msg) => console.error(msg) }) {
    this.csvPath = resolve(csvPath);
    this.logPath = resolve(logPath);
    this.onError = onError;
    this.problems = new Map();
    mkdirSync(dirname(this.logPath), { recursive: true });
    // O_NOFOLLOW: a symlink planted at the log path must not redirect our writes (absent on Windows,
    // where creating a symlink needs admin rights anyway).
    this.logFd = openSync(this.logPath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  }

  record(event, lead) {
    const entry = { ts: new Date().toISOString(), event };
    for (const field of LOG_FIELDS) entry[field] = lead[field] ?? null;
    const buf = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
    try {
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
      this.problems.delete(this.csvPath);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {}
      this.fail(this.csvPath, e);
    }
  }

  fail(path, e) {
    this.problems.set(path, e.message);
    this.onError(`not updated: ${path}: ${e.message}`);
  }

  warnings() {
    return [...this.problems].map(([path, message]) => `${path} is not being updated: ${message}`);
  }

  close() {
    closeSync(this.logFd);
  }
}
