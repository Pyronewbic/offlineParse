import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { LeadFiles } from '../src/files.js';
import { Lcq } from '../src/lcq.js';
import { LeadStore } from '../src/leads.js';
import { createPortalServer } from '../src/web.js';
import { makeConfig, request } from './helpers.js';

const GAMES = ['SSBU', 'SF6', 'Avatar Legends'];
const FIRST = { code: 'EVT26', name: 'October Expo' };

// Repeated "games" fields, as a browser sends ticked checkboxes.
function post(port, path, fields, headers = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) params.append(k, x);
  const body = params.toString();
  return request({ port, method: 'POST', path, body, headers: {
    'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers } });
}

async function serve(cfg) {
  const store = new LeadStore(':memory:', { firstEvent: FIRST });
  const server = createPortalServer(cfg, store, { laptopIp: '127.0.0.1', quiet: true, submitLimit: { max: 1e6, windowMs: 60_000 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { store, server, port: server.address().port };
}

describe('games on the sign-up form', () => {
  let s;
  before(async () => { s = await serve(makeConfig({ games: [...GAMES, 'R&D <Cup>'] })); });
  after(() => {
    s.server.close();
    s.server.closeAllConnections();
    s.store.close();
  });
  beforeEach(() => s.store.db.exec('DELETE FROM leads'));
  const guest = (games, extra = {}) => post(s.port, '/submit', { name: 'Asha Rao', phone: '98765 43210', consent: 'yes', games, ...extra });
  const rows = () => s.store.list().map((l) => [l.game, l.bracket]);

  test('the form has a checkbox per game, none ticked, with names escaped', async () => {
    const form = (await request({ port: s.port, path: '/' })).body;
    assert.match(form, /<fieldset class="games"><legend>Games<\/legend>/);
    assert.equal((form.match(/type="checkbox" name="games"/g) ?? []).length, 4);
    assert.match(form, /value="R&amp;D &lt;Cup&gt;"><span>R&amp;D &lt;Cup&gt;<\/span>/);
    assert.ok(!/name="games" value="[^"]*" checked/.test(form), 'nothing ticked for the guest');
  });

  test('one sign-up enters every game ticked; the thank-you page names them', async () => {
    const res = await guest(['Avatar Legends', 'SSBU']);
    assert.equal(res.status, 200);
    assert.match(res.body, /down for <strong>Normal<\/strong> in <strong>SSBU<\/strong> and <strong>Avatar Legends<\/strong> as/);
    assert.deepEqual(rows(), [['SSBU', 'normal'], ['Avatar Legends', 'normal']], 'one row per game, in the order games are listed');
  });

  test('games already entered are skipped and named; all of them already entered is refused under the number', async () => {
    await guest(['SSBU']);
    const some = await guest(['SF6', 'SSBU']);
    assert.equal(some.status, 200);
    assert.match(some.body, /in <strong>SF6<\/strong> as/);
    assert.match(some.body, /You were already registered for <strong>SSBU<\/strong>\./);
    const none = await guest(['SSBU', 'SF6']);
    assert.equal(none.status, 409);
    assert.match(none.body, /id="phone-error" role="alert">This number is already registered for Normal in SSBU and SF6\./);
    assert.match(none.body, /value="SSBU" checked>/, 'the ticks are kept');
    assert.deepEqual(rows(), [['SSBU', 'normal'], ['SF6', 'normal']]);
  });

  test('no game ticked is explained, and keeps what was typed; a ticked box twice is one entry', async () => {
    const res = await guest([]);
    assert.equal(res.status, 400);
    assert.match(res.body, /id="game-error" role="alert">Pick at least one game\.</);
    assert.match(res.body, /value="Asha Rao"/);
    assert.deepEqual(rows(), []);
    const twice = await guest(['SF6', 'SF6']);
    assert.equal(twice.status, 200);
    assert.ok(!twice.body.includes('already registered'), 'the second tick is not a repeat sign-up');
    assert.deepEqual(rows(), [['SF6', 'normal']]);
  });

  test('a game the booth never offered is refused and nothing is stored, even next to a real one', async () => {
    for (const games of [['Tekken'], ['SSBU', 'Tekken'], ['ssbu']]) {
      const res = await guest(games);
      assert.equal(res.status, 400, games.join());
      assert.match(res.body, /unknown game/);
    }
    assert.deepEqual(rows(), []);
    assert.equal((await guest(['SSBU'])).status, 200, 'positive control: a real game is accepted');
  });
});

describe('a booth with one game, or none', () => {
  test('one game is ticked already; no games means no game question and rows carry no game', async () => {
    const one = await serve(makeConfig({ games: ['SF6'] }));
    const none = await serve(makeConfig());
    try {
      assert.match((await request({ port: one.port, path: '/' })).body, /name="games" value="SF6" checked>/);
      const plainForm = (await request({ port: none.port, path: '/' })).body;
      assert.match(plainForm, /name="consent"/, 'positive control: the form rendered');
      assert.ok(!plainForm.includes('name="games"'));
      assert.equal((await post(none.port, '/submit', { name: 'Asha', phone: '9876543210', consent: 'yes' })).status, 200);
      assert.equal(none.store.list()[0].game, '');
      assert.equal((await post(none.port, '/submit', { name: 'Asha', phone: '9876543210', consent: 'yes', games: 'SF6' })).status, 400,
        'a game posted to a booth with none is refused');
    } finally {
      for (const x of [one, none]) {
        x.server.close();
        x.server.closeAllConnections();
        x.store.close();
      }
    }
  });
});

describe('games on the admin page', () => {
  let s;
  before(async () => { s = await serve(makeConfig({ games: GAMES })); });
  after(() => {
    s.server.close();
    s.server.closeAllConnections();
    s.store.close();
  });
  beforeEach(() => s.store.db.exec('DELETE FROM leads'));
  const page = async (path = '/admin') => (await request({ port: s.port, path })).body;
  const token = async () => (await page()).match(/name="token" value="([^"]+)"/)[1];
  const add = async (fields) => post(s.port, '/admin/add', { token: await token(), name: 'Desk Dev', phone: '9000012345', consent: 'yes', bracket: 'lcq', ...fields });

  test('the desk ticks games like a guest; repeats are named, partial repeats add the rest', async () => {
    const first = await add({ games: ['SSBU', 'SF6'] });
    assert.equal(first.headers.location, '/admin?msg=added');
    const some = await add({ games: ['SF6', 'Avatar Legends'] });
    assert.equal(some.headers.location, '/admin?msg=added-some');
    assert.match(await page('/admin?msg=added-some'), /Added for the games they were not in yet/);
    const none = await add({ games: ['SSBU'] });
    assert.equal(none.status, 409);
    assert.match(none.body, /\+91 90000 12345 is already registered for LCQ in SSBU, as Desk Dev\./);
    assert.match((await add({ games: [] })).body, /Pick at least one game\./);
    assert.equal((await add({ games: ['Tekken'] })).status, 400);
    assert.deepEqual(s.store.list().map((l) => [l.game, l.source]), [['SSBU', 'desk'], ['SF6', 'desk'], ['Avatar Legends', 'desk']]);
  });

  test('a Game column, a game filter that keeps the tab and event, and a CSV of what is shown', async () => {
    await add({ games: ['SSBU', 'Avatar Legends'] });
    await add({ name: 'Ravi', phone: '9123456789', games: ['Avatar Legends'], bracket: 'normal' });
    const all = await page();
    assert.match(all, /<th scope="col">Game<\/th>/);
    assert.match(all, /<a href="\/admin" aria-current="page">All games \(3\)<\/a><a href="\/admin\?game=SSBU">SSBU \(1\)<\/a><a href="\/admin\?game=SF6">SF6 \(0\)<\/a><a href="\/admin\?game=Avatar\+Legends">Avatar Legends \(2\)<\/a>/);
    const avatar = await page('/admin?tab=lcq&game=Avatar+Legends');
    assert.equal((avatar.match(/<tr><td class="num idx">/g) ?? []).length, 1, 'LCQ and Avatar Legends only');
    assert.match(avatar, /<a href="\/admin\?game=Avatar\+Legends">All \(2\)<\/a>/, 'bracket tabs keep the game');
    assert.match(avatar, /href="\/admin\/export\.csv\?tab=lcq&amp;game=Avatar\+Legends"/);
    assert.match(avatar, /name="games" value="Avatar Legends" checked>/, 'the add form starts on the game in view');
    const csv = await request({ port: s.port, path: '/admin/export.csv?game=Avatar+Legends' });
    assert.match(csv.headers['content-disposition'], /filename="leads-EVT26-Avatar-Legends\.csv"/);
    assert.deepEqual(csv.body.trim().split('\r\n').slice(1).map((r) => r.split(',').slice(1, 4)), [['Desk Dev', 'LCQ', 'Avatar Legends'], ['Ravi', 'Normal', 'Avatar Legends']]);
    const bogus = await page('/admin?game=%22%3E%3Cb%3E');
    assert.match(bogus, /aria-current="page">All games \(3\)/, 'an unknown game filter shows every game');
    assert.ok(!bogus.includes('"><b>'));
  });

  test('a desk entry while a game filter is on keeps the filter, and posts its games, not the filter', async () => {
    const res = await post(s.port, '/admin/add', {
      token: await token(), game: 'SF6', name: 'Desk Dev', phone: '9000012345', consent: 'yes', bracket: 'normal', games: ['SSBU'],
    });
    assert.equal(res.headers.location, '/admin?game=SF6&msg=added');
    assert.deepEqual(s.store.list().map((l) => l.game), ['SSBU']);
  });

  test('twelve games all ticked at the desk still fit in one form', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `G${i}`);
    const big = await serve(makeConfig({ games: many }));
    try {
      const t = (await request({ port: big.port, path: '/admin' })).body.match(/name="token" value="([^"]+)"/)[1];
      const res = await post(big.port, '/admin/add', {
        token: t, tab: 'all', event: '', game: '', name: 'Asha', phone: '9876543210', consent: 'yes', bracket: 'normal', games: many,
      });
      assert.equal(res.status, 303);
      assert.equal(big.store.list().length, 12);
    } finally {
      big.server.close();
      big.server.closeAllConnections();
      big.store.close();
    }
  });
});

describe('games in the store and files', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'games-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const reg = (store, extra) => store.register({ name: 'Asha', phone: '+919876543210', source: 'form', noticeVersion: 'v1', ...extra });

  test("deleting one game's registration keeps the same person's other game in the log and the sheet", () => {
    const log = join(dir, 'leads.log');
    const csv = join(dir, 'leads.csv');
    const files = new LeadFiles({ csvPath: csv, logPath: log, onError: () => {} });
    const store = new LeadStore(join(dir, 'leads.db'), { files, firstEvent: FIRST });
    reg(store, { game: 'SSBU', name: 'Asha One' });
    reg(store, { game: 'SF6', name: 'Asha Two' });
    store.remove(1);
    for (const file of [log, csv]) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!text.includes('Asha One'), `gone from ${file}`);
      assert.ok(text.includes('Asha Two'), `the other game is kept in ${file}`);
    }
    store.close();
    files.close();
  });

  test('a pending deletion for a game with emoji in its name survives a restart and is finished', () => {
    const game = 'Street Fighter 6 Grand Finals \u{1F525}\u{1F525}\u{1F525}\u{1F525}\u{1F525}\u{1F525}';
    assert.ok([...game].length <= 40 && game.length > 40, 'precondition: allowed by config, longer than 40 in UTF-16');
    assert.deepEqual(makeConfig({ games: [game] }).games, [game]);
    const log = join(dir, 'leads.log');
    writeFileSync(log, `${JSON.stringify({ ts: '2026-11-09T10:00:00.000Z', event: 'lead.created', name: 'Gone Guy', phone: '+919876543210', eventCode: 'EVT26', bracket: 'lcq', game })}\n`);
    writeFileSync(join(dir, 'pending-erasures.json'), JSON.stringify([{ id: 1, phone: '+919876543210', bracket: 'lcq', eventCode: 'EVT26', game, until: '2026-11-10T00:00:00Z' }]));
    const errors = [];
    const files = new LeadFiles({ csvPath: join(dir, 'leads.csv'), logPath: log, onError: (m) => errors.push(m) });
    assert.deepEqual(errors, []);
    assert.ok(!readFileSync(log, 'utf8').includes('Gone Guy'), 'erased on startup');
    files.close();
  });

  test('a database from before games keeps every row with no game, and then allows one row per game', () => {
    const path = join(dir, 'leads.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE leads (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, name TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('form', 'desk')), eventCode TEXT NOT NULL, consentAt TEXT NOT NULL,
      noticeVersion TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, socialsSentAt TEXT,
      bracket TEXT NOT NULL DEFAULT 'normal' CHECK (bracket IN ('normal', 'lcq')), UNIQUE (phone, bracket, eventCode));
      CREATE TABLE events (code TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL);
      INSERT INTO events VALUES ('EVT26', 'October Expo', '2026-10-20T10:00:00Z');
      INSERT INTO leads VALUES (1, '+919876543210', 'Asha', 'form', 'EVT26', 't', 'v1', '2026-10-20T10:00:00Z', 't', NULL, 'lcq');`);
    old.close();
    const store = new LeadStore(path, { firstEvent: FIRST });
    assert.deepEqual(store.list().map((l) => [l.id, l.game, l.bracket]), [[1, '', 'lcq']]);
    assert.equal(reg(store, { bracket: 'lcq' }).created, false, 'still once with no game');
    assert.equal(reg(store, { bracket: 'lcq', game: 'SSBU' }).created, true, 'a game is a new entry');
    assert.equal(reg(store, { bracket: 'lcq', game: 'SSBU' }).created, false, 'once per game');
    store.close();
  });
});

describe('LCQ per game', () => {
  let store;
  let lcq;
  let n;
  beforeEach(() => {
    store = new LeadStore(':memory:', { firstEvent: FIRST });
    lcq = new Lcq(store);
    n = 0;
  });
  afterEach(() => store.close());
  const signUp = (game, count, name = null) => {
    for (let i = 0; i < count; i++) {
      n++;
      store.register({ name: name ?? `${game}${n}`, phone: `+9198765${String(n).padStart(5, '0')}`, source: 'form', noticeVersion: 'v', bracket: 'lcq', game });
    }
  };
  const pairs = (game) => lcq.state(game).proposals.map((p) => [p.a.name, p.b.name]);

  test('each game pairs its own players; one person in two games is a player in each', () => {
    signUp('SSBU', 1);
    signUp('SF6', 1);
    assert.deepEqual([pairs('SSBU'), pairs('SF6')], [[], []], 'two players, but not in one game');
    store.register({ name: 'Both', phone: '+919000000001', source: 'form', noticeVersion: 'v', bracket: 'lcq', game: 'SSBU' });
    store.register({ name: 'Both', phone: '+919000000001', source: 'form', noticeVersion: 'v', bracket: 'lcq', game: 'SF6' });
    assert.deepEqual(pairs('SSBU'), [['SSBU1', 'Both']]);
    assert.deepEqual(pairs('SF6'), [['SF62', 'Both']]);
    assert.deepEqual(lcq.state('Avatar Legends').players, []);
    assert.deepEqual(lcq.games().sort(), ['SF6', 'SSBU']);
  });

  test('results and proposals stay inside a game; a match across games is refused; Drop acts on one game', () => {
    signUp('SSBU', 4);
    signUp('SF6', 2);
    for (const g of ['SSBU', 'SF6']) for (const p of lcq.state(g).proposals) lcq.start(p.a.id, p.b.id);
    for (const g of ['SSBU', 'SF6']) for (const m of lcq.state(g).open) lcq.result(m.id, m.a);
    assert.deepEqual(pairs('SSBU'), [['SSBU1', 'SSBU3']]);
    const ssbuWinner = lcq.state('SSBU').players.find((p) => p.name === 'SSBU1');
    const sf6Winner = lcq.state('SF6').players.find((p) => p.name === 'SF65');
    assert.deepEqual([ssbuWinner.status, sf6Winner.status], ['free', 'free'], 'precondition: both are free');
    assert.throws(() => lcq.start(ssbuWinner.id, sf6Winner.id), /different games/);
    lcq.start(ssbuWinner.id, lcq.state('SSBU').players.find((p) => p.name === 'SSBU3').id);
    assert.equal(lcq.state('SSBU').open.length, 1);
    assert.equal(lcq.state('SF6').open.length, 0, 'the other game is untouched');
    lcq.drop(sf6Winner.id);
    assert.equal(lcq.state('SF6').players.find((p) => p.id === sf6Winner.id).status, 'dropped');
    assert.equal(lcq.state('SSBU').open.length, 1, 'still on in SSBU');
  });
});

describe('LCQ runner tabs', () => {
  let s;
  let cookie;
  before(async () => {
    const store = new LeadStore(':memory:', { firstEvent: FIRST });
    const lcq = new Lcq(store);
    const server = createPortalServer(makeConfig({ games: GAMES }), store, { laptopIp: '127.0.0.1', quiet: true, lcq });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    s = { store, lcq, server, port: server.address().port };
    const login = await post(s.port, '/lcq/login', { pin: lcq.pin() });
    cookie = { Cookie: login.headers['set-cookie'][0].split(';')[0] };
  });
  after(() => {
    s.server.close();
    s.server.closeAllConnections();
    s.store.close();
  });
  beforeEach(() => s.store.db.exec('DELETE FROM leads; DELETE FROM lcq_matches; DELETE FROM lcq_drops; DELETE FROM lcq_games;'));
  const signUp = (game, count, from = 0) => {
    for (let i = from; i < from + count; i++) {
      s.store.register({ name: `${game}-${i}`, phone: `+9198765${String(i).padStart(5, '0')}`, source: 'form', noticeVersion: 'v', bracket: 'lcq', game });
    }
  };
  const page = async (q = '') => (await request({ port: s.port, path: `/lcq${q}`, headers: cookie })).body;

  test('a tab per game with its players and matches ready to start; each tab shows only its game', async () => {
    signUp('SSBU', 4);
    signUp('SF6', 1, 10);
    const first = await page();
    assert.match(first, /<nav class="tabs" aria-label="Games"><a href="\/lcq\?game=SSBU" aria-current="page">SSBU \(4\), 2 ready<\/a><a href="\/lcq\?game=SF6">SF6 \(1\)<\/a><a href="\/lcq\?game=Avatar\+Legends">Avatar Legends \(0\)<\/a><\/nav>/);
    assert.match(first, /SSBU-0 vs SSBU-1 <span class="chip">0W<\/span>/);
    const sf6 = await page('?game=SF6');
    assert.match(sf6, /aria-current="page">SF6 \(1\)</);
    assert.ok(!sf6.includes('SSBU-0'), 'no other game on this tab');
    assert.match(sf6, /<h3>0W \(1\)<\/h3>/);
    assert.match(await page('?game=Tekken'), /aria-current="page">SSBU/, 'an unknown game opens the first tab');
  });

  test('every action comes back to its tab and acts on that game', async () => {
    signUp('SSBU', 2);
    signUp('SF6', 2, 10);
    const sf6 = await page('?game=SF6');
    assert.match(sf6, /<input type="hidden" name="game" value="SF6"><button type="submit" class="secondary">Start<\/button>/);
    const [p] = s.lcq.state('SF6').proposals;
    const start = await post(s.port, '/lcq/start', { a: String(p.a.id), b: String(p.b.id), game: 'SF6' }, cookie);
    assert.equal(start.headers.location, '/lcq?game=SF6');
    assert.equal(s.lcq.state('SF6').open.length, 1);
    assert.equal(s.lcq.state('SSBU').open.length, 0, 'SSBU untouched');
    const v = JSON.parse((await request({ port: s.port, path: '/lcq/version?game=SF6', headers: cookie })).body).v;
    assert.match(await page('?game=SF6'), new RegExp(`data-version="${v}"`), 'the poll and the page agree on a tab');
  });

  test('registrations from before games get a No game tab next to the games', async () => {
    signUp('', 2);
    signUp('SSBU', 1, 5);
    assert.match(await page(), /<a href="\/lcq\?game=SSBU" aria-current="page">SSBU \(1\)<\/a>.*<a href="\/lcq\?game=">No game \(2\), 1 ready<\/a>/s,
      'the configured games come first');
    const none = await page('?game=');
    assert.match(none, /<a href="\/lcq\?game=" aria-current="page">No game \(2\), 1 ready<\/a>/);
    assert.ok(!none.includes('SSBU-5'));
    const [p] = s.lcq.state('').proposals;
    const back = await post(s.port, '/lcq/start', { a: String(p.a.id), b: String(p.b.id), game: '' }, cookie);
    assert.equal(back.headers.location, '/lcq?game=', 'actions on the No game tab come back to it');
    assert.equal(s.lcq.state('').open.length, 1);
  });

  test('a guest signing up for a finalized game hears that its bracket is full; the other game is not mentioned', async () => {
    signUp('SF6', 2, 10);
    s.lcq.finalize('SF6');
    s.store.setBracket('lcq');
    try {
      const res = await post(s.port, '/submit', { name: 'Late', phone: '9876599999', consent: 'yes', games: ['SSBU', 'SF6'] });
      assert.equal(res.status, 200);
      assert.match(res.body, /<p>The <strong>SF6<\/strong> LCQ bracket is full; staff may still add you\.<\/p>/);
      assert.ok(!/SSBU<\/strong> LCQ bracket/.test(res.body));
    } finally {
      s.store.setBracket('normal');
    }
  });

  test('a game whose LCQ has ended cannot be ticked, and a form loaded before End is refused for that game only', async () => {
    signUp('SF6', 2, 10);
    s.lcq.finalize('SF6');
    s.lcq.end('SF6', true);
    const form = async () => (await request({ port: s.port, path: '/' })).body;
    assert.match(await form(), /value="SF6"><span>SF6<\/span>/, 'Normal sign-ups are not affected');
    s.store.setBracket('lcq');
    try {
      const lcqForm = await form();
      assert.match(lcqForm, /<input type="checkbox" name="games" value="SF6" disabled><span>SF6 \(LCQ ended\)<\/span>/);
      assert.match(lcqForm, /<input type="checkbox" name="games" value="SSBU"><span>SSBU<\/span>/);
      const stale = await post(s.port, '/submit', { name: 'Late', phone: '9876599999', consent: 'yes', games: ['SSBU', 'SF6'] });
      assert.equal(stale.status, 409);
      assert.match(stale.body, /The SF6 LCQ has ended; untick it to register for the rest\./);
      assert.match(stale.body, /value="SSBU" checked>/, 'the other game stays ticked');
      assert.equal(s.store.list().filter((l) => l.name === 'Late').length, 0, 'nothing saved');
      const ok = await post(s.port, '/submit', { name: 'Late', phone: '9876599999', consent: 'yes', games: ['SSBU'] });
      assert.equal(ok.status, 200, 'positive control: the open game still takes sign-ups');
    } finally {
      s.store.setBracket('normal');
    }
  });
});
