import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { LeadFiles, leadsCsv } from '../src/files.js';
import { LeadStore } from '../src/leads.js';
import { createPortalServer } from '../src/web.js';
import { makeConfig, postForm, request } from './helpers.js';

const csvRows = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trimEnd().split('\r\n').slice(1);
const logEntries = (path) => readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('leadsCsv leaves empty sent dates blank', () => {
  const csv = leadsCsv([{ id: 1, name: 'A', phone: '+919876543210', source: 'form', eventCode: 'E',
    consentAt: 't', noticeVersion: 'v', createdAt: 't', updatedAt: 't', socialsSentAt: null }]);
  assert.ok(csv.startsWith('\uFEFFid,name,phone'));
  assert.ok(csv.split('\r\n')[1].endsWith(',t,'));
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
  const add = (overrides = {}) => store.upsert({
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

  test('CSV mirrors the table: one row per phone, sent state included', () => {
    open();
    assert.deepEqual(csvRows(csvPath), [], 'header-only sheet exists from startup');
    add();
    add({ name: 'Asha Rao' });
    add({ name: 'Ravi', phone: '+919123456789', source: 'whatsapp' });
    store.markSent(1);
    assert.equal(readFileSync(csvPath, 'utf8'), leadsCsv(store.list()));
    const rows = csvRows(csvPath);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /^1,Asha Rao,\+919876543210,form,.*,\d{4}-\d\d-\d\dT[\d:]+Z$/);
    assert.match(rows[1], /^2,Ravi,\+919123456789,whatsapp,.*,$/);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
  });

  test('log appends one entry per real change and never rewrites', () => {
    open();
    add();
    add({ name: 'Asha Rao' });
    assert.equal(store.markSent(1), true);
    assert.equal(store.markSent(1), false, 'second markSent is a no-op');
    assert.equal(store.markSent(999), false);
    const entries = logEntries(logPath);
    assert.deepEqual(entries.map((e) => [e.event, e.id, e.name]),
      [['lead.created', 1, 'Asha'], ['lead.updated', 1, 'Asha Rao'], ['socials.sent', 1, 'Asha Rao']]);
    assert.ok(entries[2].socialsSentAt);

    store.close();
    files.close();
    open();
    add({ name: 'Ravi', phone: '+919123456789' });
    assert.equal(logEntries(logPath).length, 4, 'reopening appends rather than truncating');
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
    assert.equal(add(), true);
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
      assert.ok(results.every((r) => r.status === 200), 'positive control: every request was accepted');

      assert.equal(store.list().length, 41);
      assert.equal(csvRows(csvPath).length, 41);
      assert.equal(readFileSync(csvPath, 'utf8'), leadsCsv(store.list()));
      const entries = logEntries(logPath);
      assert.equal(entries.length, 50);
      assert.equal(entries.filter((e) => e.phone === '+919000000000' && e.event === 'lead.created').length, 1);
      assert.equal(entries.filter((e) => e.phone === '+919000000000' && e.event === 'lead.updated').length, 9);

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
