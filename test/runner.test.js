import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Lcq } from '../src/lcq.js';
import { LeadStore } from '../src/leads.js';
import { againstFor, createPortalServer, overdue, runnerPage, runnerVersion } from '../src/web.js';
import { makeConfig, request } from './helpers.js';

describe('LCQ runner over HTTP', () => {
  let store;
  let lcq;
  let server;
  let port;
  let now = 1_000_000;

  before(async () => {
    store = new LeadStore(':memory:');
    lcq = new Lcq(store);
    server = createPortalServer(makeConfig(), store, { laptopIp: '127.0.0.1', quiet: true, lcq, clock: () => now });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => {
    server.close();
    server.closeAllConnections();
    store.close();
  });
  beforeEach(() => {
    now += 120_000;
    store.db.exec('DELETE FROM leads; DELETE FROM lcq_matches; DELETE FROM lcq_drops;');
  });

  const post = (path, fields, headers = {}) => {
    const body = new URLSearchParams(fields).toString();
    return request({ port, method: 'POST', path, body, headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers } });
  };
  const signIn = async () => {
    const res = await post('/lcq/login', { pin: lcq.pin() });
    assert.equal(res.status, 303);
    return { Cookie: res.headers['set-cookie'][0].split(';')[0] };
  };
  const startAll = () => {
    for (const p of lcq.state().proposals) lcq.start(p.a.id, p.b.id);
  };
  const signUp = (count) => {
    for (let i = 0; i < count; i++) {
      store.register({ name: `P${i + 1}`, phone: `+9198765${String(i).padStart(5, '0')}`, source: 'form', noticeVersion: 'v', bracket: 'lcq' });
    }
  };

  test('without the PIN a guest sees only the PIN page and changes nothing', async () => {
    signUp(2);
    const page = await request({ port, path: '/lcq' });
    assert.match(page.body, /Enter the PIN/);
    assert.ok(!page.body.includes('P1'), 'no names before signing in');
    assert.equal((await request({ port, path: '/lcq/version' })).status, 401);
    const [p] = lcq.state().proposals;
    const start = await post('/lcq/start', { a: String(p.a.id), b: String(p.b.id) });
    assert.equal(start.headers.location, '/lcq');
    assert.deepEqual(lcq.state().open, [], 'nothing started');
    const forged = await request({ port, path: '/lcq', headers: { Cookie: `lcq=${'A'.repeat(43)}` } });
    assert.match(forged.body, /Enter the PIN/, 'a made-up session is not accepted');
  });

  test('a wrong PIN is refused, and after 5 tries even the right one waits a minute', async () => {
    const wrong = lcq.pin() === '000000' ? '111111' : '000000';
    assert.equal((await post('/lcq/login', { pin: wrong })).status, 401);
    for (let i = 0; i < 4; i++) await post('/lcq/login', { pin: wrong });
    const blocked = await post('/lcq/login', { pin: lcq.pin() });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['set-cookie'], undefined);
    now += 61_000;
    assert.equal((await post('/lcq/login', { pin: lcq.pin() })).status, 303, 'positive control: allowed again after the window');
  });

  test('the session cookie is HttpOnly, SameSite=Strict and limited to /lcq; only the runner page may run its script', async () => {
    const res = await post('/lcq/login', { pin: lcq.pin() });
    assert.match(res.headers['set-cookie'][0], /^lcq=[A-Za-z0-9_-]{43}; Path=\/lcq; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    const cookie = { Cookie: res.headers['set-cookie'][0].split(';')[0] };
    const page = await request({ port, path: '/lcq', headers: cookie });
    assert.match(page.headers['content-security-policy'], /script-src 'self'; connect-src 'self'/);
    assert.match(page.body, /<script src="\/lcq\/app\.js"><\/script>/);
    assert.ok(!/script-src/.test((await request({ port, path: '/' })).headers['content-security-policy']), 'the guest form still runs no script');
    const js = await request({ port, path: '/lcq/app.js' });
    assert.match(js.headers['content-type'], /text\/javascript/);
    assert.match(js.body, /fetch\('\/lcq\/version'/);
  });

  test('sign-ups are offered at once, results move winners into win buckets, and losers are out', async () => {
    const cookie = await signIn();
    const page = async () => (await request({ port, path: '/lcq', headers: cookie })).body;
    const version = async () => JSON.parse((await request({ port, path: '/lcq/version', headers: cookie })).body).v;
    signUp(1);
    assert.match(await page(), /<h3>0W \(1\)<\/h3>/);
    assert.match(await page(), /Nobody to pair yet\./);
    const v1 = await version();
    signUp(4);
    assert.notEqual(await version(), v1, 'the tablet sees new sign-ups');
    const body0 = await page();
    assert.match(body0, /P1 vs P2 <span class="chip">0W<\/span>/);
    assert.match(body0, /P3 vs P4 <span class="chip">0W<\/span>/);
    for (const p of lcq.state().proposals) await post('/lcq/start', { a: String(p.a.id), b: String(p.b.id) }, cookie);
    const [m1, m2] = lcq.state().open;
    await post('/lcq/result', { match: String(m1.id), winner: String(m1.a) }, cookie);
    await post('/lcq/result', { match: String(m2.id), winner: String(m2.a) }, cookie);
    const body = await page();
    assert.match(body, /P1 vs P3 <span class="chip">1W<\/span>/, 'both winners are offered a match');
    assert.match(body, /<h3>Eliminated \(2\)<\/h3>/, 'one loss is out');
    await post('/lcq/start', { a: String(m1.a), b: String(m2.a) }, cookie);
    assert.match(await page(), /<strong>P1<\/strong> <span class="hint">1W 0L<\/span> vs <strong>P3<\/strong> <span class="hint">1W 0L<\/span>/,
      'Playing shows each player\'s record');
    const final = lcq.state().open[0];
    await post('/lcq/result', { match: String(final.id), winner: String(final.a) }, cookie);
    const done = await page();
    assert.match(done, /<details id="lcq-b-w2" open><summary><h3>2W \(1\)/, 'a win bucket still in play starts open');
    assert.match(done, /<details id="lcq-b-out"><summary><h3>Eliminated \(3\)/, 'Eliminated starts folded');
    assert.match(done, /<span>One loss and you are out<\/span>/);
    assert.equal(done.match(/data-version="([^"]+)"/)[1], await version(), 'the page and the poll agree, or the tablet would reload forever');
  });

  test('layout: the most-tapped sections first and open, history and standings folded, pickers start blank', async () => {
    const cookie = await signIn();
    signUp(16);
    const st = () => lcq.state();
    for (let i = 0; i < 6; i++) {
      const [p] = st().proposals;
      lcq.start(p.a.id, p.b.id);
      lcq.result(st().open[0].id, p.a.id);
    }
    const [next] = st().proposals;
    lcq.start(next.a.id, next.b.id);
    const body = (await request({ port, path: '/lcq', headers: cookie })).body;
    const at = (id) => body.indexOf(`id="${id}"`);
    assert.ok(at('lcq-find') < at('lcq-playing') && at('lcq-playing') < at('lcq-ready') && at('lcq-ready') < at('lcq-results')
      && at('lcq-results') < at('lcq-standings') && at('lcq-find') > 0, 'Find, Playing, Ready, Results, Standings');
    for (const [id, open] of [['lcq-playing', true], ['lcq-ready', true], ['lcq-results', true], ['lcq-standings', false]]) {
      assert.equal(new RegExp(`<details class="panel" id="${id}" open>`).test(body), open, id);
    }
    assert.match(body, /<summary><h2>Results \(6\)<\/h2><\/summary>/);
    assert.match(body, /<summary>Older results \(1\)<\/summary>/, 'the newest 5 stay out, the rest fold away');
    assert.match(body, /<div class="won"><form class="inline" method="post" action="\/lcq\/result">/);
    assert.ok(!/action="\/lcq\/start">.*?<button type="submit">/.test(body), 'Start is never the pink primary button');
    assert.ok(!body.includes('name="player" required>'), 'no list of every player to drop from');
    for (const name of ['a', 'b']) {
      assert.match(body, new RegExp(`name="${name}" required><option value="">Choose player</option>`), `${name} starts blank`);
    }
    for (const gone of ['id="lcq-pair"', 'New group', 'Waiting for a group', 'Make a group']) assert.ok(!body.includes(gone), `no ${gone}: groups are gone`);
  });

  test('standings count matches, waiting and eliminated players, show how long each has waited, and reveal a number on tap', () => {
    signUp(9);
    startAll();
    const [m1, m2] = lcq.state().open;
    lcq.result(m1.id, m1.a);
    lcq.result(m2.id, m2.a);
    const st = lcq.state();
    const loser = st.players.find((p) => p.id === m1.b);
    assert.equal(loser.status, 'out', 'precondition: one loss is eliminated');
    const p1 = st.players.find((p) => p.id === m1.a);
    const body = runnerPage(makeConfig(), st, { now: Date.parse(p1.freeSince) + 75 * 60_000 });
    const stat = (k) => body.match(new RegExp(`<dt>${k}</dt><dd>(\\d+)</dd>`))?.[1];
    assert.deepEqual([stat('Matches on'), stat('Waiting for a match'), stat('Eliminated'), stat('Dropped')],
      ['2', '3', '2', '0'], 'P5-P8 play; P1, P3 won and P9 waits; P2, P4 lost');
    assert.equal(stat('Waiting for a group'), undefined);
    assert.match(body, new RegExp(`<summary>P1 <span class="hint">1W 0L, waiting <span data-wait="4500000">1 h 15 min</span></span></summary><span class="nowrap">\\+91 98765 00000</span><form method="post" action="/lcq/drop"`));
    assert.match(body, /<h3>Eliminated \(2\)<\/h3><\/summary><ul class="names"><li><details><summary>P2 <span class="hint">0W 1L<\/span><\/summary>/,
      'no waiting time once eliminated');
    assert.match(body, /<summary>P9 <span class="hint">0W 0L, waiting <span data-wait=/, 'a new sign-up waits from when they signed up');
  });

  test('needs attention: long waits and long matches, capped at 5 each; the version moves only when someone crosses a limit', () => {
    const cfg = makeConfig();
    signUp(20);
    startAll();
    for (const m of lcq.state().open.slice(0, 8)) lcq.result(m.id, m.a);
    const st = lcq.state();
    const t0 = Date.now();
    const min = (n) => t0 + n * 60_000;
    assert.ok(!runnerPage(cfg, st, { now: t0 }).includes('Needs attention'), 'nothing to flag, no strip');
    assert.deepEqual([overdue(cfg, st, min(9)).waiting.length, overdue(cfg, st, min(11)).waiting.length], [0, 8], 'free players flag at 10 minutes');
    assert.deepEqual([overdue(cfg, st, min(14)).long.length, overdue(cfg, st, min(16)).long.length], [0, 2], 'open matches flag at 15 minutes');
    const body = runnerPage(cfg, st, { now: min(16) });
    const strip = body.match(/<section class="attention".*?<\/section>/)[0];
    assert.equal(strip.match(/href="#lcq-ready"/g).length, 5, 'five waiting names, then a count');
    assert.match(strip, /<li>and 3 more<\/li>/);
    assert.match(strip, /<a href="#lcq-playing">P17 vs P18 running <span data-wait="\d+">\d+ min<\/span><\/a>/);
    assert.equal(runnerVersion(cfg, lcq, st, min(11)), runnerVersion(cfg, lcq, st, min(13)), 'no reload while nothing new is overdue');
    assert.notEqual(runnerVersion(cfg, lcq, st, min(9)), runnerVersion(cfg, lcq, st, min(11)));
    assert.notEqual(runnerVersion(cfg, lcq, st, min(14)), runnerVersion(cfg, lcq, st, min(16)));
    const later = makeConfig({ lcqWaitAlertMin: 30 });
    assert.equal(overdue(later, st, min(16)).waiting.length, 0, 'the limit comes from config');
  });

  test('a sticky bar jumps to each section, with counts', () => {
    signUp(4);
    const body = runnerPage(makeConfig(), lcq.state());
    assert.match(body, /<nav class="jump" aria-label="Sections"><a href="#lcq-playing">Playing \(0\)<\/a><a href="#lcq-ready">Ready \(2\)<\/a>/);
    assert.match(body, /<a href="#lcq-results">Results<\/a><a href="#lcq-standings">Players \(4\)<\/a><\/nav>/);
    for (const id of ['lcq-playing', 'lcq-ready', 'lcq-results', 'lcq-standings']) assert.ok(body.includes(`id="${id}"`), `${id} exists`);
  });

  test('find a player by name or number: matches open with status and number; the tablet keeps the search while it updates', async () => {
    const cookie = await signIn();
    signUp(25);
    lcq.start(lcq.state().proposals[0].a.id, lcq.state().proposals[0].b.id);
    const find = async (q) => (await request({ port, path: `/lcq?q=${encodeURIComponent(q)}`, headers: cookie })).body;
    const panel = (body) => body.match(/<section class="panel" id="lcq-find".*?<\/section>/)[0];
    const byName = panel(await find('p1'));
    assert.match(byName, /11 found\./, 'P1 and P10-P19, any case');
    assert.match(byName, /<details open><summary>P1 <span class="hint">0W 0L, playing<\/span><\/summary><span class="nowrap">\+91 98765 00000<\/span><form method="post" action="\/lcq\/drop"/);
    assert.match(byName, /<summary>P13 <span class="hint">0W 0L, waiting <span data-wait=/);
    assert.match(panel(await find('98765 00024')), /1 found\.<\/p><ul class="names"><li><details open><summary>P25 <span class="hint">0W 0L, waiting/, 'by number');
    assert.match(panel(await find('P')), /First 20 of 25; type more of the name\./);
    assert.match(panel(await find('zz')), /Nobody matches "zz"\./);
    const hostile = panel(await find('"><b>'));
    assert.match(hostile, /value="&quot;&gt;&lt;b&gt;"/, 'the query is escaped in the box');
    assert.match(hostile, /Nobody matches "&quot;&gt;&lt;b&gt;"\./, 'and in the message');
    assert.ok(!panel(await request({ port, path: '/lcq', headers: cookie }).then((r) => r.body)).includes('found'), 'no search, no results');
    assert.match((await request({ port, path: '/lcq/app.js' })).body, /fetch\(location\.pathname \+ location\.search,/, 'updates fetch the searched page');
  });

  test('drop needs the tick: without it nothing happens and the tablet says why', async () => {
    const cookie = await signIn();
    signUp(2);
    startAll();
    const p1 = lcq.state().players.find((p) => p.name === 'P1');
    await post('/lcq/drop', { player: String(p1.id) }, cookie);
    assert.equal(lcq.state().players.find((p) => p.id === p1.id).status, 'playing', 'not dropped');
    assert.match((await request({ port, path: '/lcq', headers: cookie })).body, /Tick that they are not here, then tap Drop\./);
    await post('/lcq/drop', { player: String(p1.id), confirm: 'yes' }, cookie);
    assert.equal(lcq.state().players.find((p) => p.id === p1.id).status, 'dropped', 'positive control: dropped with the tick');
    const body = (await request({ port, path: '/lcq?q=P1', headers: cookie })).body;
    assert.match(body, /<summary>P1 <span class="hint">0W 1L, dropped<\/span><\/summary><span class="nowrap">[^<]*<\/span><\/details>/, 'no Drop for someone already dropped');
  });

  test('a refused action is explained once on the next page load', async () => {
    const cookie = await signIn();
    signUp(2);
    const [p] = lcq.state().proposals;
    await post('/lcq/start', { a: String(p.a.id), b: String(p.b.id) }, cookie);
    const [m] = lcq.state().open;
    await post('/lcq/result', { match: String(m.id), winner: '999' }, cookie);
    assert.match((await request({ port, path: '/lcq', headers: cookie })).body, /The winner must be one of the two players\./);
    assert.ok(!(await request({ port, path: '/lcq', headers: cookie })).body.includes('The winner must be'), 'shown once');
  });

  test('undo says what else it called off; a mistaken ladder match can be called off', async () => {
    const cookie = await signIn();
    signUp(4);
    startAll();
    const [m1, m2] = lcq.state().open;
    lcq.result(m1.id, m1.a);
    lcq.result(m2.id, m2.a);
    lcq.start(m1.a, m2.a);
    const body = (await request({ port, path: '/lcq', headers: cookie })).body;
    assert.match(body, /action="\/lcq\/cancel">.*Call off/, 'an open match has Call off');
    await post('/lcq/undo', { match: String(m1.id) }, cookie);
    assert.match((await request({ port, path: '/lcq', headers: cookie })).body,
      /<p class="flash" role="status">Result undone\. Also called off P1 vs P3, which depended on it\.<\/p>/);
    lcq.result(m1.id, m1.a);
    lcq.start(m1.a, m2.a);
    await post('/lcq/cancel', { match: String(lcq.state().open[0].id) }, cookie);
    assert.deepEqual(lcq.state().open, []);
  });

  test('cross-site posts and other hostnames are refused even with a session', async () => {
    const cookie = await signIn();
    signUp(2);
    const [p] = lcq.state().proposals;
    assert.equal((await post('/lcq/start', { a: String(p.a.id), b: String(p.b.id) }, { ...cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await request({ port, path: '/lcq', headers: { ...cookie, Host: 'evil.example' } })).status, 404);
    assert.deepEqual(lcq.state().open, []);
  });

  test('Against lists only the Player\'s wins; Any wins lists everyone but the Player', async () => {
    signUp(7);
    startAll();
    const [m1, m2] = lcq.state().open;
    lcq.result(m1.id, m1.a);
    lcq.result(m2.id, m2.a);
    const body = runnerPage(makeConfig(), lcq.state());
    assert.match(body, /<option value="\d+" data-w="1">P1 \(1W 0L\)<\/option>/, 'each choice carries its wins');
    assert.match(body, /<option value="\d+" data-w="0">P7 \(0W 0L\)<\/option>/);
    assert.match(body, /<label class="check"><input type="checkbox" id="lcq-any"><span>Any wins/);
    assert.match((await request({ port, path: '/lcq/app.js' })).body, /const againstFor = \(options, player, any\) =>/, 'the tablet runs the same filter');
    const opt = (value, w) => ({ value, dataset: { w } });
    const options = [opt('1', '1'), opt('3', '1'), opt('5', '0'), opt('6', '0')];
    const ids = (list) => list.map((o) => o.value);
    assert.deepEqual(ids(againstFor(options, opt('1', '1'), false)), ['3'], 'same wins, not the Player');
    assert.deepEqual(ids(againstFor(options, opt('5', '0'), false)), ['6']);
    assert.deepEqual(ids(againstFor(options, opt('1', '1'), true)), ['3', '5', '6'], 'Any wins');
    assert.deepEqual(ids(againstFor(options, opt('', undefined), false)), ['1', '3', '5', '6'], 'no Player yet: everyone');
    const [a, b] = [lcq.state().players.find((p) => p.name === 'P1'), lcq.state().players.find((p) => p.name === 'P7')];
    lcq.start(a.id, b.id);
    assert.equal(lcq.state().open.at(-1).aName, 'P1', 'the server still allows any two free players, so the override works');
  });

  test('the admin page shows the runner address and PIN', async () => {
    const admin = await request({ port, path: '/admin' });
    assert.match(admin.body, new RegExp(`LCQ runner for a tablet on the booth Wi-Fi: <strong>http://127\\.0\\.0\\.1:${port}/lcq</strong>, PIN <strong>${lcq.pin()}</strong>`));
  });
});
