import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
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
  const add = (overrides = {}) => store.upsert({
    name: 'Asha', phone: '+919876543210', source: 'form', eventCode: 'EVT26', noticeVersion: 'v1', ...overrides,
  });

  beforeEach(() => { store = new LeadStore(':memory:'); });
  afterEach(() => store.close());

  test('dedupes on phone, refreshes the name and keeps source and sent state', () => {
    assert.equal(add(), true);
    const { id } = store.list()[0];
    assert.equal(store.markSent(id), true);
    assert.equal(add({ name: 'Asha Rao', source: 'whatsapp' }), false);
    const leads = store.list();
    assert.equal(leads.length, 1);
    assert.equal(leads[0].name, 'Asha Rao');
    assert.equal(leads[0].source, 'form');
    assert.ok(leads[0].socialsSentAt);
  });

  test('markSent is idempotent and ignores unknown ids', () => {
    add();
    const { id } = store.list()[0];
    assert.equal(store.markSent(id), true);
    const first = store.get(id).socialsSentAt;
    assert.equal(store.markSent(id), false);
    assert.equal(store.get(id).socialsSentAt, first);
    assert.equal(store.markSent(9999), false);
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
      disk.upsert({ name: 'Asha', phone: '+919876543210', source: 'form', eventCode: 'E', noticeVersion: 'v1' });
      disk.close();
      const reopened = new LeadStore(path);
      assert.equal(reopened.list().length, 1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
