import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { LeadFiles, csvProblem, leadsCsv, toIST, toISTShort } from '../src/files.js';
import { LeadStore } from '../src/leads.js';
import { createPortalServer } from '../src/web.js';
import { makeConfig, postForm, request } from './helpers.js';

const csvRows = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trimEnd().split('\r\n').slice(1);
const logEntries = (path) => readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('toISTShort is a readable India-time stamp with 12-hour clock edges right', () => {
  assert.equal(toISTShort('2026-10-15T13:48:30Z'), '15 Oct, 7:18 pm');
  assert.equal(toISTShort('2026-10-15T18:30:00Z'), '16 Oct, 12:00 am');
  assert.equal(toISTShort('2026-10-15T06:30:00Z'), '15 Oct, 12:00 pm');
  assert.equal(toISTShort('2026-12-31T19:05:00Z'), '1 Jan, 12:35 am');
  assert.equal(toISTShort('nope'), 'nope');
});

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

  test('a blocked CSV catches up on retry, without waiting for the next sign-up, and warns once', () => {
    const infos = [];
    files = new LeadFiles({ csvPath, logPath, onError: (m) => errors.push(m), onInfo: (m) => infos.push(m) });
    store = new LeadStore(join(dir, 'leads.db'), { files });
    assert.equal(files.retryCsv(), false, 'nothing pending after a good startup sync');
    // A non-empty directory at the path makes the rename fail, standing in for a file Excel holds open.
    unlinkSync(csvPath);
    mkdirSync(csvPath);
    writeFileSync(join(csvPath, 'blocker'), '');
    add();
    add({ phone: '+919123456789', name: 'Ravi' });
    assert.equal(store.list().length, 2, 'sign-ups still saved');
    assert.equal(errors.length, 1, 'one warning, not one per failed write');
    assert.equal(files.warnings().length, 1);
    assert.equal(files.retryCsv(), true, 'still blocked: retried');
    assert.equal(errors.length, 1, 'a retry that fails the same way stays quiet');

    rmSync(csvPath, { recursive: true });
    assert.equal(files.retryCsv(), true);
    assert.equal(csvRows(csvPath).length, 2, 'both sign-ups reached the sheet');
    assert.deepEqual(files.warnings(), []);
    assert.equal(infos.length, 1);
    assert.match(infos[0], /updated again: .*leads\.csv/);
    assert.equal(files.retryCsv(), false, 'nothing left to retry');
  });

  test('on Windows a locked CSV is explained as open in another app', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const e = Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
      assert.match(csvProblem(e, 'win32'), /open in another app \(probably Excel\)\. It catches up within 15 seconds/, code);
      assert.equal(csvProblem(e, 'darwin'), e.message, `${code} elsewhere keeps the real error`);
    }
    const missing = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    assert.equal(csvProblem(missing, 'win32'), missing.message);
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

describe('deleting a registration', () => {
  let dir;
  let files;
  let store;
  const paths = () => ({ db: join(dir, 'leads.db'), csv: join(dir, 'leads.csv'), log: join(dir, 'leads.log') });
  const open = () => {
    files = new LeadFiles({ csvPath: paths().csv, logPath: paths().log, onError: () => {} });
    store = new LeadStore(paths().db, { files });
  };
  const reg = (name, phone) => store.register({ name, phone, source: 'form', eventCode: 'EVT26', noticeVersion: 'v1' });
  const rawEverywhere = () => readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'delete-'));
    open();
  });
  afterEach(() => {
    store.close();
    files.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('erases the person from the database bytes, WAL, spreadsheet and log, and keeps everyone else', () => {
    reg('Zanzibar Quokka', '+919111122222');
    reg('Asha Rao', '+919876543210');
    assert.ok(rawEverywhere().includes('Zanzibar Quokka'), 'positive control: the name is on disk before deletion');
    assert.ok(rawEverywhere().includes('+919111122222'));

    const removed = store.remove(1);
    assert.equal(removed.name, 'Zanzibar Quokka');
    assert.equal(store.get(1), null);

    const raw = rawEverywhere();
    assert.ok(!raw.includes('Zanzibar Quokka'), 'name gone from every file in the data folder');
    assert.ok(!raw.includes('+919111122222') && !raw.includes('9111122222'), 'number gone from every file');
    assert.ok(raw.includes('Asha Rao') && raw.includes('+919876543210'), 'the other registration is intact');

    const entries = logEntries(paths().log);
    assert.deepEqual(entries.map((e) => e.event), ['lead.created', 'lead.deleted']);
    assert.deepEqual(Object.keys(entries[1]).sort(), ['event', 'id', 'ts'], 'the deletion entry carries no personal data');
    assert.equal(entries[1].id, 1);
    assert.equal(csvRows(paths().csv).length, 1);
  });

  test('the log keeps working after it is rewritten, and the number can register again', () => {
    reg('Zanzibar Quokka', '+919111122222');
    store.remove(1);
    assert.deepEqual(reg('Zanzibar Quokka', '+919111122222'), { created: true });
    reg('Ravi', '+919123456789');
    assert.deepEqual(logEntries(paths().log).map((e) => [e.event, e.name ?? null]),
      [['lead.deleted', null], ['lead.created', 'Zanzibar Quokka'], ['lead.created', 'Ravi']]);
    assert.equal(files.warnings().length, 0);
  });

  test('an unknown id deletes nothing', () => {
    reg('Asha Rao', '+919876543210');
    assert.equal(store.remove(99), null);
    assert.equal(store.list().length, 1);
    assert.equal(logEntries(paths().log).length, 1);
  });
});
