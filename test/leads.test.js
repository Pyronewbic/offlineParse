import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { LeadStore, ValidationError, cleanName, normalizePhone } from '../src/leads.js';

describe('normalizePhone', () => {
  test('Indian formats normalize to E.164', () => {
    for (const raw of ['9876543210', '98765 43210', '098765-43210', '919876543210',
      '+91 98765 43210', '+91-(98765)-43210', '0091 9876543210']) {
      assert.equal(normalizePhone(raw), '+919876543210', raw);
    }
  });

  test('accepts numbers wrapped in invisible characters by autofill or copy-paste', () => {
    for (const raw of ['\u200E9876501234', '\u202A+91 98765 01234\u202C', '\u2068+91 98765 01234\u2069',
      '98765\u201101234', '98765\u2013012\u221234', '98765\u200B01234', '\uFEFF9876501234', '98765\u00A001234']) {
      assert.equal(normalizePhone(raw), '+919876501234', JSON.stringify(raw));
    }
  });

  test('errors tell the guest what was wrong', () => {
    assert.throws(() => normalizePhone('987650644'), /We counted 9 digits/);
    assert.throws(() => normalizePhone('+91 919876501234'), /We counted 12 digits/);
    assert.throws(() => normalizePhone('5600001234'), /start with 6, 7, 8 or 9/);
  });

  test('international numbers with +', () => {
    assert.equal(normalizePhone('+44 7700 900123'), '+447700900123');
  });

  test('rejects malformed and hostile input', () => {
    for (const raw of ['', '   ', '12345', '5876543210', '98765432101', '+91 5876543210',
      '+1234567', '+1234567890123456', '98765abcde', '+', '00', null, undefined,
      '\u0669\u0668\u0667\u0666\u0665\u0664\u0663\u0662\u0661\u0660', // Arabic-Indic digits
      '\uFF19\uFF18\uFF17\uFF16\uFF15\uFF14\uFF13\uFF12\uFF11\uFF10', // fullwidth digits
      '9'.repeat(200), '98765\u000043210']) {
      assert.throws(() => normalizePhone(raw), ValidationError, String(raw));
    }
  });
});

describe('cleanName', () => {
  test('collapses whitespace', () => {
    assert.equal(cleanName('  Asha \n\t Rao '), 'Asha Rao');
  });

  test('strips control and bidi override characters', () => {
    assert.equal(cleanName('Asha\u0000\u001b[31m\u202EoaR'), 'Asha[31moaR');
  });

  test('keeps the zero-width joiner Indic scripts rely on', () => {
    const malayalam = '\u0D05\u0D28\u0D4D\u200D';
    assert.equal(cleanName(malayalam), malayalam);
  });

  test('length limit counts code points, not UTF-16 units', () => {
    assert.equal(cleanName('\u{1F600}'.repeat(80)), '\u{1F600}'.repeat(80));
    assert.throws(() => cleanName('a'.repeat(81)), ValidationError);
  });

  test('rejects empty input', () => {
    for (const raw of ['', '   ', '\u0000\u0001', null]) assert.throws(() => cleanName(raw), ValidationError);
  });
});

describe('LeadStore', () => {
  let store;
  const add = (overrides = {}) => store.register({
    name: 'Asha', phone: '+919876543210', source: 'form', eventCode: 'EVT26', noticeVersion: 'v1', ...overrides,
  });

  beforeEach(() => { store = new LeadStore(':memory:'); });
  afterEach(() => store.close());

  test('a number registers once; a repeat is refused and changes nothing', () => {
    assert.deepEqual(add(), { created: true });
    const { id } = store.list()[0];
    const before = store.list();
    const repeat = add({ name: 'Someone Else', source: 'desk', noticeVersion: 'v2' });
    assert.equal(repeat.created, false);
    assert.equal(repeat.existing.name, 'Asha');
    assert.equal(repeat.existing.id, id);
    assert.deepEqual(store.list(), before, 'existing row untouched');
  });

  test('rejects an unknown source', () => {
    assert.throws(() => add({ source: 'sms' }));
    assert.equal(store.list().length, 0);
  });

  test('persists to disk, creating the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leads-'));
    try {
      const path = join(dir, 'nested', 'leads.db');
      const disk = new LeadStore(path);
      disk.register({ name: 'Asha', phone: '+919876543210', source: 'form', eventCode: 'E', noticeVersion: 'v1' });
      disk.close();
      const reopened = new LeadStore(path);
      assert.equal(reopened.list().length, 1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('brackets', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'brackets-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const reg = (store, phone, extra = {}) =>
    store.register({ name: 'Asha', phone, source: 'form', eventCode: 'E', noticeVersion: 'v1', ...extra });

  test('a number registers once per bracket, and new sign-ups join the bracket that is switched on', () => {
    const store = new LeadStore(':memory:');
    assert.equal(store.bracket(), 'normal');
    assert.deepEqual(reg(store, '+919876543210'), { created: true });
    store.setBracket('lcq');
    assert.deepEqual(reg(store, '+919876543210'), { created: true }, 'same number, other bracket');
    const again = reg(store, '+919876543210');
    assert.equal(again.created, false);
    assert.equal(again.existing.bracket, 'lcq');
    assert.deepEqual(store.list().map((l) => l.bracket), ['normal', 'lcq']);
    assert.throws(() => store.setBracket('finals'), /unknown bracket/);
    assert.throws(() => reg(store, '+919123456789', { bracket: 'finals' }), /unknown bracket/);
    store.close();
  });

  test('the switch survives a restart', () => {
    const path = join(dir, 'leads.db');
    const first = new LeadStore(path);
    first.setBracket('lcq');
    first.close();
    const second = new LeadStore(path);
    assert.equal(second.bracket(), 'lcq');
    second.close();
  });

  test('a database with brackets but WhatsApp desk entries keeps each bracket and relabels the source', () => {
    const path = join(dir, 'leads.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE leads (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, name TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('form', 'whatsapp')), eventCode TEXT NOT NULL, consentAt TEXT NOT NULL,
      noticeVersion TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, socialsSentAt TEXT,
      bracket TEXT NOT NULL DEFAULT 'normal' CHECK (bracket IN ('normal', 'lcq')), UNIQUE (phone, bracket));
      INSERT INTO leads VALUES (1, '+919876543210', 'Asha', 'form', 'E', 't', 'v1', '2026-10-20T10:00:00Z', 't', NULL, 'normal');
      INSERT INTO leads VALUES (2, '+919876543210', 'Asha', 'whatsapp', 'E', 't', 'none', '2026-10-20T11:00:00Z', 't', NULL, 'lcq');`);
    old.close();
    const store = new LeadStore(path);
    assert.deepEqual(store.list().map((l) => [l.id, l.bracket, l.source]), [[1, 'normal', 'form'], [2, 'lcq', 'desk']]);
    assert.equal(reg(store, '+919123456789', { source: 'desk' }).created, true, 'new desk entries are accepted');
    assert.throws(() => reg(store, '+919000011111', { source: 'whatsapp' }), /unknown source/);
    store.close();
  });

  test('a database from before brackets keeps every row as Normal and gains the per-bracket rule', () => {
    const path = join(dir, 'leads.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE leads (id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('form', 'whatsapp')), eventCode TEXT NOT NULL, consentAt TEXT NOT NULL,
      noticeVersion TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, socialsSentAt TEXT);
      INSERT INTO leads VALUES (3, '+919876543210', 'Asha', 'form', 'E', 't', 'v1', '2026-10-20T10:00:00Z', 't', NULL);
      INSERT INTO leads VALUES (7, '+919123456789', 'Ravi', 'whatsapp', 'E', 't', 'none', '2026-10-20T11:00:00Z', 't', NULL);`);
    old.close();

    const store = new LeadStore(path);
    assert.deepEqual(store.list().map((l) => [l.id, l.name, l.bracket, l.source]), [[3, 'Asha', 'normal', 'form'], [7, 'Ravi', 'normal', 'desk']],
      'old WhatsApp desk entries become desk entries');
    assert.equal(reg(store, '+919876543210').created, false, 'still once per bracket');
    assert.equal(reg(store, '+919876543210', { bracket: 'lcq' }).created, true, 'now allowed in LCQ');
    store.close();
    const reopened = new LeadStore(path);
    assert.equal(reopened.list().length, 3, 'opening again changes nothing');
    reopened.close();
  });
});
