import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { LeadFiles } from '../src/files.js';
import { Lcq } from '../src/lcq.js';
import { LeadStore, ValidationError } from '../src/leads.js';
import { createPortalServer } from '../src/web.js';
import { makeConfig, postForm, request } from './helpers.js';

const FIRST = { code: 'EVT26', name: 'October Expo' };
const reg = (store, phone, extra = {}) => store.register({ name: 'Asha', phone, source: 'form', noticeVersion: 'v1', ...extra });

describe('events in the store', () => {
  let store;
  beforeEach(() => { store = new LeadStore(':memory:', { firstEvent: FIRST }); });
  afterEach(() => store.close());

  test('a new database starts with the configured event, and new sign-ups join it', () => {
    assert.deepEqual(store.events().map((e) => [e.code, e.name]), [['EVT26', 'October Expo']]);
    assert.equal(store.currentEvent().code, 'EVT26');
    reg(store, '+919876543210');
    assert.equal(store.list()[0].eventCode, 'EVT26');
  });

  test('starting an event switches new sign-ups to it, and a number can register again there, once', () => {
    const next = store.startEvent('  Mumbai   Expo 2026 ');
    assert.deepEqual([next.code, next.name], ['Mumbai-Expo-2026', 'Mumbai Expo 2026']);
    assert.equal(store.currentEvent().code, 'Mumbai-Expo-2026');
    assert.deepEqual(reg(store, '+919876543210', { eventCode: 'EVT26' }), { created: true }, 'positive control: registered at the first event');
    assert.deepEqual(reg(store, '+919876543210'), { created: true }, 'same number, same bracket, new event');
    const again = reg(store, '+919876543210');
    assert.equal(again.created, false);
    assert.equal(again.existing.eventCode, 'Mumbai-Expo-2026', 'the refusal names the row in this event');
    assert.deepEqual(store.events().map((e) => e.code), ['Mumbai-Expo-2026', 'EVT26'], 'newest first');
    assert.throws(() => reg(store, '+919123456789', { eventCode: 'nope' }), /unknown event nope/);
  });

  test('event names are cleaned, must be new, and codes stay unique and safe', () => {
    assert.throws(() => store.startEvent('october expo'), (e) => e instanceof ValidationError && /already an event called/.test(e.message));
    assert.throws(() => store.startEvent(' ‮ '), /Give the new event a name/);
    assert.throws(() => store.startEvent('x'.repeat(61)), /too long/);
    assert.equal(store.startEvent('Expo!').code, 'Expo');
    assert.equal(store.startEvent('Expo?').code, 'Expo-2', 'a code already taken gets a number');
    assert.equal(store.startEvent('कार्यक्रम').code, 'event', 'no Latin letters at all');
    assert.equal(store.startEvent('Café Night').code, 'Cafe-Night');
    for (const e of store.events()) assert.match(e.code, /^[A-Za-z0-9_-]{1,32}$/);
    assert.equal(store.currentEvent().code, 'Cafe-Night');
  });

  test('the current event survives a restart, and the configured one does not take it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'events-'));
    try {
      const path = join(dir, 'leads.db');
      const first = new LeadStore(path, { firstEvent: FIRST });
      first.startEvent('Second');
      first.close();
      const second = new LeadStore(path, { firstEvent: { code: 'OTHER', name: 'Edited config' } });
      assert.equal(second.currentEvent().code, 'Second');
      assert.deepEqual(second.events().map((e) => e.code), ['Second', 'EVT26'], 'a later config edit adds nothing');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a database from before events', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pre-events-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('keeps every row, gives each code seen an event (the configured one by name), and gains the per-event rule', () => {
    const path = join(dir, 'leads.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE leads (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, name TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('form', 'desk')), eventCode TEXT NOT NULL, consentAt TEXT NOT NULL,
      noticeVersion TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, socialsSentAt TEXT,
      bracket TEXT NOT NULL DEFAULT 'normal' CHECK (bracket IN ('normal', 'lcq')), UNIQUE (phone, bracket));
      INSERT INTO leads VALUES (1, '+919876543210', 'Asha', 'form', 'EVT26', 't', 'v1', '2026-10-20T10:00:00Z', 't', NULL, 'normal');
      INSERT INTO leads VALUES (2, '+919876543210', 'Asha', 'desk', 'EVT26', 't', 'v1', '2026-10-20T11:00:00Z', 't', NULL, 'lcq');
      INSERT INTO leads VALUES (5, '+919123456789', 'Ravi', 'form', 'SUMMER', 't', 'v1', '2026-06-01T09:00:00Z', 't', NULL, 'normal');`);
    old.close();

    const store = new LeadStore(path, { firstEvent: FIRST });
    assert.deepEqual(store.list().map((l) => [l.id, l.eventCode, l.bracket]), [[1, 'EVT26', 'normal'], [2, 'EVT26', 'lcq'], [5, 'SUMMER', 'normal']]);
    assert.deepEqual(store.events().map((e) => [e.code, e.name, e.createdAt]),
      [['EVT26', 'October Expo', '2026-10-20T10:00:00Z'], ['SUMMER', 'SUMMER', '2026-06-01T09:00:00Z']]);
    assert.equal(store.currentEvent().code, 'EVT26');
    assert.equal(reg(store, '+919876543210').created, false, 'still once per bracket in the October event');
    store.startEvent('November');
    assert.equal(reg(store, '+919876543210').created, true, 'allowed again at a new event');
    store.close();
    const reopened = new LeadStore(path, { firstEvent: FIRST });
    assert.equal(reopened.list().length, 4, 'opening again changes nothing');
    assert.equal(reopened.events().length, 3);
    reopened.close();
  });
});

describe('deleting with events', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'events-delete-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("deleting one event's registration keeps the same number's registration at another event in every file", () => {
    const log = join(dir, 'leads.log');
    const files = new LeadFiles({ csvPath: join(dir, 'leads.csv'), logPath: log, onError: () => {} });
    const store = new LeadStore(join(dir, 'leads.db'), { files, firstEvent: FIRST });
    reg(store, '+919876543210', { name: 'Old Asha' });
    store.startEvent('November');
    reg(store, '+919876543210', { name: 'New Asha' });
    store.remove(1);
    for (const file of [log, join(dir, 'leads.csv')]) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!text.includes('Old Asha'), `the deleted registration is gone from ${file}`);
      assert.ok(text.includes('New Asha'), `the other event keeps theirs in ${file}`);
    }
    store.close();
    files.close();
  });

  test('a pending deletion saved before events still erases the number, and a bad event code there is refused', () => {
    const log = join(dir, 'leads.log');
    writeFileSync(log, `${JSON.stringify({ ts: '2026-10-20T10:00:00.000Z', event: 'lead.created', id: 1, name: 'Old Asha', phone: '+919876543210', eventCode: 'EVT26', bracket: 'normal' })}\n`);
    writeFileSync(join(dir, 'pending-erasures.json'), JSON.stringify([{ id: 1, phone: '+919876543210', bracket: 'normal', until: '2026-10-21T00:00:00Z' }]));
    const files = new LeadFiles({ csvPath: join(dir, 'leads.csv'), logPath: log, onError: () => {} });
    assert.ok(!readFileSync(log, 'utf8').includes('Old Asha'), 'an old entry without an event matches any event');
    files.close();

    writeFileSync(log, `${JSON.stringify({ ts: '2026-10-20T10:00:00.000Z', event: 'lead.created', name: 'Kept', phone: '+919876543210' })}\n`);
    writeFileSync(join(dir, 'pending-erasures.json'), JSON.stringify([{ id: 1, phone: '+919876543210', eventCode: '../x', until: '2026-10-21T00:00:00Z' }]));
    const errors = [];
    const strict = new LeadFiles({ csvPath: join(dir, 'leads.csv'), logPath: log, onError: (m) => errors.push(m) });
    assert.ok(readFileSync(log, 'utf8').includes('Kept'), 'nothing erased from a malformed file');
    assert.match(errors.join('\n'), /not a list of pending erasures/);
    strict.close();
  });
});

describe('LCQ runner with events', () => {
  test('a new event starts a fresh runner; the earlier event keeps its matches but they are not shown', () => {
    const store = new LeadStore(':memory:', { firstEvent: FIRST });
    const lcq = new Lcq(store);
    const signUp = (n, from = 0) => {
      for (let i = from; i < from + n; i++) reg(store, `+9198765${String(i).padStart(5, '0')}`, { name: `P${i}`, bracket: 'lcq' });
    };
    signUp(4);
    const [p0, p1] = lcq.state().players;
    lcq.start(p0.id, p1.id);
    lcq.result(lcq.state().open[0].id, p0.id);
    assert.equal(lcq.state().decided.length, 1, 'positive control: the October runner has a result');
    const before = lcq.version();

    store.startEvent('November');
    assert.notEqual(lcq.version(), before, 'the tablet reloads');
    const fresh = lcq.state();
    assert.deepEqual([fresh.players.length, fresh.open.length, fresh.decided.length], [0, 0, 0]);
    signUp(4, 0);
    const now = lcq.state();
    assert.ok(now.players.every((p) => p.status === 'free' && p.wins === 0 && p.losses === 0), 'nobody carries an October record');
    assert.deepEqual(now.proposals.map((x) => [x.a.name, x.b.name]), [['P0', 'P1'], ['P2', 'P3']]);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM lcq_matches').get().n, 1, 'October matches are kept');
    store.close();
  });
});

describe('events on the admin page', () => {
  let store;
  let server;
  let port;
  const cfg = makeConfig();

  before(async () => {
    store = new LeadStore(':memory:', { firstEvent: { code: cfg.eventCode, name: cfg.eventName } });
    server = createPortalServer(cfg, store, { laptopIp: '127.0.0.1', quiet: true, submitLimit: { max: 1e6, windowMs: 60_000 } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => {
    server.close();
    server.closeAllConnections();
    store.close();
  });

  const admin = async (path = '/admin') => (await request({ port, path })).body;
  const token = async () => (await admin()).match(/name="token" value="([^"]+)"/)[1];
  const guest = (name, phone) => postForm(port, '/submit', { name, phone, consent: 'yes' });

  test('Start new event switches sign-ups, keeps the earlier event viewable, and each event downloads its own CSV', async () => {
    assert.equal((await guest('Old Asha', '9876543210')).status, 200);
    const t = await token();
    const started = await postForm(port, '/admin/event', { token: t, name: 'November <Night>' });
    assert.equal(started.status, 303);
    assert.equal(started.headers.location, '/admin?msg=event');
    const page = await admin('/admin?msg=event');
    assert.match(page, /New sign-ups now go to November &lt;Night&gt;\./);
    assert.match(page, /<a href="\/admin" aria-current="page">November &lt;Night&gt; \(now\)<\/a><a href="\/admin\?event=EVT26">Event XYZ<\/a>/);
    assert.match(page, /Showing all 0,/, 'the new event starts empty');

    assert.equal((await guest('New Asha', '9876543210')).status, 200, 'the same number registers again at the new event');
    assert.equal((await guest('New Asha', '9876543210')).status, 409, 'but only once');
    assert.equal((await guest('Ravi', '9123456789')).status, 200);

    const old = await admin('/admin?event=EVT26');
    assert.match(old, /You are looking at Event XYZ\. New sign-ups go to November &lt;Night&gt;\./);
    assert.match(old, /Old Asha/);
    assert.ok(!old.includes('New Asha') && !old.includes('Ravi'), 'only that event');
    assert.match(old, /href="\/admin\/export\.csv\?event=EVT26"/);
    assert.match(old, /<a href="\/admin\?tab=lcq&amp;event=EVT26">LCQ \(0\)<\/a>/, 'tabs keep the event');

    const csv = (q) => request({ port, path: `/admin/export.csv${q}` });
    const oldCsv = await csv('?event=EVT26');
    assert.match(oldCsv.headers['content-disposition'], /filename="leads-EVT26\.csv"/);
    assert.deepEqual(oldCsv.body.trim().split('\r\n').slice(1).map((r) => r.split(',')[1]), ['Old Asha']);
    const nowCsv = await csv('');
    assert.match(nowCsv.headers['content-disposition'], /filename="leads-November-Night\.csv"/);
    assert.deepEqual(nowCsv.body.trim().split('\r\n').slice(1).map((r) => r.split(',')[1]), ['New Asha', 'Ravi']);
    const bogus = await csv('?event=..%2Fetc');
    assert.match(bogus.headers['content-disposition'], /filename="leads-November-Night\.csv"/, 'an unknown event means the current one');
  });

  test('a desk entry made while viewing an earlier event joins the current one, and the page shows it there', async () => {
    const t = await token();
    const res = await postForm(port, '/admin/add', { token: t, event: 'EVT26', name: 'Desk Dev', phone: '9000012345', consent: 'yes', bracket: 'normal' });
    assert.equal(res.headers.location, '/admin?msg=added');
    assert.equal(store.list().find((l) => l.name === 'Desk Dev').eventCode, store.currentEvent().code);
  });

  test('a bad event name is explained with the form open; a duplicate changes nothing', async () => {
    const t = await token();
    const current = store.currentEvent().code;
    const dup = await postForm(port, '/admin/event', { token: t, name: 'event xyz', event: 'EVT26' });
    assert.equal(dup.status, 400);
    assert.match(dup.body, /<details class="new-event" open>/);
    assert.match(dup.body, /There is already an event called &quot;event xyz&quot;\./);
    assert.match(dup.body, /value="event xyz"/, 'what was typed is kept');
    assert.equal(store.currentEvent().code, current);
    assert.equal((await postForm(port, '/admin/event', { name: 'Sneaky' })).status, 403, 'the page token is required');
    assert.equal((await postForm(port, '/admin/event', { token: t, name: 'Sneaky' }, { headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(`token=${t}&name=Sneaky`), 'Sec-Fetch-Site': 'cross-site',
    } })).status, 403, 'and a cross-site post is refused');
    assert.equal(store.currentEvent().code, current);
  });
});
