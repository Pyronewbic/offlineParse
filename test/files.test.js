import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { LeadFiles, leadsCsv, toIST } from '../src/files.js';
import { LeadStore } from '../src/leads.js';
import { createPortalServer } from '../src/web.js';
import { makeConfig, postForm, request } from './helpers.js';

const csvRows = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trimEnd().split('\r\n').slice(1);
const logEntries = (path) => readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('toIST converts UTC to India time, including across midnight', () => {
  assert.equal(toIST('2026-10-15T13:48:30Z'), '2026-10-15 19:18 IST');
  assert.equal(toIST('2026-10-15T20:00:00Z'), '2026-10-16 01:30 IST');
  assert.equal(toIST('2026-12-31T18:30:00Z'), '2027-01-01 00:00 IST');
  assert.equal(toIST('not a date'), 'not a date');
  assert.equal(toIST(null), '');
});

test('leadsCsv has readable headers, no socials columns, and India-time sign-up', () => {
  const lead = { id: 1, name: 'A', phone: '+919876543210', source: 'form', eventCode: 'E', consentAt: 'x',
    noticeVersion: 'v', createdAt: '2026-10-15T13:48:30Z', updatedAt: 'x', socialsSentAt: '2026-10-15T14:00:00Z' };
  const csv = leadsCsv([lead, { ...lead, id: 2, source: 'whatsapp' }]);
  const [header, first, second] = csv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(header, 'ID,Name,WhatsApp number,Came in via,Event,Signed up (IST),Notice version');
  assert.equal(first, '1,A,+919876543210,Wi-Fi form,E,2026-10-15 19:18 IST,v');
  assert.equal(second, '2,A,+919876543210,WhatsApp message,E,2026-10-15 19:18 IST,v');
  assert.ok(!/socials|Socials|2026-10-15T14:00/.test(csv), 'a stored socials date never reaches the sheet');
});

describe('lead files', () => {
  let dir;
  let csvPath;
  let logPath;
  let errors;
  let files;
  let store;
  const open = () => {
    files = new LeadFiles({ csvPath, logPath, onError: (m) => errors.push(m) });
    store = new LeadStore(join(dir, 'leads.db'), { files });
  };
  const add = (overrides = {}) => store.register({
    name: 'Asha', phone: '+919876543210', source: 'form', eventCode: 'EVT26', noticeVersion: 'v1', ...overrides,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'files-'));
    csvPath = join(dir, 'leads.csv');
    logPath = join(dir, 'leads.log');
    errors = [];
  });
  afterEach(() => {
    store?.close();
    files?.close();
    store = files = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test('CSV mirrors the table: one row per phone', () => {
    open();
    assert.deepEqual(csvRows(csvPath), [], 'header-only sheet exists from startup');
    add();
    add({ name: 'Asha Again' });
    add({ name: 'Ravi', phone: '+919123456789', source: 'whatsapp' });
    assert.equal(readFileSync(csvPath, 'utf8'), leadsCsv(store.list()));
    const rows = csvRows(csvPath);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /^1,Asha,\+919876543210,Wi-Fi form,EVT26,\d{4}-\d\d-\d\d \d\d:\d\d IST,v1$/);
    assert.match(rows[1], /^2,Ravi,\+919123456789,WhatsApp message,EVT26,/);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
  });

  test('log appends one entry per real change and never rewrites', () => {
    open();
    add();
    add({ name: 'Asha Again' });
    const entries = logEntries(logPath);
    assert.deepEqual(entries.map((e) => [e.event, e.id, e.name]), [['lead.created', 1, 'Asha']],
      'the refused repeat logs nothing');
    assert.ok(!('socialsSentAt' in entries[0]));

    store.close();
    files.close();
    open();
    add({ name: 'Ravi', phone: '+919123456789' });
    assert.equal(logEntries(logPath).length, 2, 'reopening appends rather than truncating');
  });

  test('a deleted CSV is rebuilt from the database on startup', () => {
    open();
    add();
    store.close();
    files.close();
    unlinkSync(csvPath);
    open();
    assert.equal(csvRows(csvPath).length, 1);
  });

  test('a symlink at the CSV path is replaced, not written through', () => {
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, csvPath);
    open();
    add();
    assert.equal(readFileSync(victim, 'utf8'), 'untouched');
    assert.ok(lstatSync(csvPath).isFile());
    assert.equal(csvRows(csvPath).length, 1);
  });

  test('a symlink at the log path is refused at startup', () => {
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, logPath);
    assert.throws(() => new LeadFiles({ csvPath, logPath }), /ELOOP|symbolic link/);
    assert.equal(readFileSync(victim, 'utf8'), 'untouched');
  });

  test('a CSV that cannot be written is reported but does not lose the lead', () => {
    csvPath = join(dir, 'missing-dir', 'leads.csv');
    open();
    assert.equal(errors.length, 1, 'startup sync failure reported');
    assert.deepEqual(add(), { created: true });
    assert.equal(store.list().length, 1, 'lead still saved in the database');
    assert.equal(logEntries(logPath).length, 1, 'log still written');
    assert.match(files.warnings()[0], /missing-dir\/leads\.csv is not being updated/);
    assert.ok(!existsSync(csvPath));
  });

  test('simultaneous sign-ups are all recorded exactly once', async () => {
    open();
    const server = createPortalServer(makeConfig(), store, { laptopIp: '127.0.0.1', quiet: true });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const distinct = Array.from({ length: 40 }, (_, i) =>
        postForm(port, '/submit', { name: `Guest ${i}`, phone: `98765${String(i).padStart(5, '0')}`, consent: 'yes' }));
      const same = Array.from({ length: 10 }, (_, i) =>
        postForm(port, '/submit', { name: `Twin ${i}`, phone: '9000000000', consent: 'yes' }));
      const results = await Promise.all([...distinct, ...same]);
      assert.ok(results.slice(0, 40).every((r) => r.status === 200), 'positive control: every distinct number registered');
      const twins = results.slice(40).map((r) => r.status).sort();
      assert.deepEqual(twins, [200, ...Array(9).fill(409)], 'exactly one of the same-number submissions wins');

      assert.equal(store.list().length, 41);
      assert.equal(csvRows(csvPath).length, 41);
      assert.equal(readFileSync(csvPath, 'utf8'), leadsCsv(store.list()));
      const entries = logEntries(logPath);
      assert.equal(entries.length, 41);
      assert.equal(entries.filter((e) => e.phone === '+919000000000').length, 1);

      const admin = await request({ port, path: '/admin' });
      assert.ok(!admin.body.includes('is not being updated'), 'no warning when files are healthy');
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test('admin page shows a file warning', async () => {
    csvPath = join(dir, 'missing-dir', 'leads.csv');
    open();
    const server = createPortalServer(makeConfig(), store, { laptopIp: '127.0.0.1', quiet: true });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const admin = await request({ port: server.address().port, path: '/admin' });
      assert.match(admin.body, /class="error" role="alert">[^<]*leads\.csv is not being updated/);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});
