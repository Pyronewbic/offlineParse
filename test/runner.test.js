import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Lcq, bracketGap } from '../src/lcq.js';
import { LeadStore } from '../src/leads.js';
import { againstFor, bracketLayout, createPortalServer, holdsUpdates, overdue, runnerPage, runnerVersion } from '../src/web.js';
import { makeConfig, postForm, request } from './helpers.js';

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
    store.db.exec('DELETE FROM leads; DELETE FROM lcq_matches; DELETE FROM lcq_drops; DELETE FROM lcq_games;');
    store.setBracket('normal');
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
    assert.match(body0, /<strong>P1<\/strong> vs <strong>P2<\/strong> <span class="chip">0W<\/span> <span class="hint">waiting <span data-wait=/);
    assert.match(body0, /<strong>P3<\/strong> vs <strong>P4<\/strong> <span class="chip">0W<\/span>/);
    for (const p of lcq.state().proposals) await post('/lcq/start', { a: String(p.a.id), b: String(p.b.id) }, cookie);
    const [m1, m2] = lcq.state().open;
    await post('/lcq/result', { match: String(m1.id), winner: String(m1.a) }, cookie);
    await post('/lcq/result', { match: String(m2.id), winner: String(m2.a) }, cookie);
    const body = await page();
    assert.match(body, /<strong>P1<\/strong> vs <strong>P3<\/strong> <span class="chip">1W<\/span>/, 'both winners are offered a match');
    assert.match(body, /<h3>Eliminated \(2\)<\/h3>/, 'one loss is out');
    await post('/lcq/start', { a: String(m1.a), b: String(m2.a) }, cookie);
    assert.match(await page(), /A<\/span><strong>P1<\/strong> <span class="hint">1W 0L<\/span> vs <span class="side" aria-hidden="true">B<\/span><strong>P3<\/strong> <span class="hint">1W 0L<\/span>/,
      'Playing shows each player\'s record');
    const final = lcq.state().open[0];
    await post('/lcq/result', { match: String(final.id), winner: String(final.a) }, cookie);
    const done = await page();
    assert.match(done, /<details id="lcq-b-w2" open><summary><h3>2W \(1\)/, 'a win bucket still in play starts open');
    assert.match(done, /<details id="lcq-b-out"><summary><h3>Eliminated \(3\)/, 'Eliminated starts folded');
    assert.ok(!done.includes('One loss and you are out'), 'no rule line in the header');
    assert.match(done, /<h1>LCQ runner<\/h1><\/header>/);
    assert.equal(done.match(/data-version="([^"]+)"/)[1], await version(), 'the page and the poll agree, or the tablet would reload forever');
  });

  test('layout: the matches first and open, history and standings folded, pickers start blank', async () => {
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
    assert.ok(at('lcq-playing') > 0 && at('lcq-playing') < at('lcq-ready') && at('lcq-ready') < at('lcq-results')
      && at('lcq-results') < at('lcq-standings') && at('lcq-standings') < at('lcq-find'), 'Playing, Ready, Results, Standings, then Find');
    for (const [id, open] of [['lcq-playing', true], ['lcq-ready', true], ['lcq-results', true], ['lcq-standings', false]]) {
      assert.equal(new RegExp(`<details class="panel" id="${id}" open>`).test(body), open, id);
    }
    assert.match(body, /<summary><h2>Results \(6\)<\/h2><\/summary>/);
    assert.match(body, /<summary>Older results \(1\)<\/summary>/, 'the newest 5 stay out, the rest fold away');
    assert.match(body, /<div class="won"><form class="inline" method="post" action="\/lcq\/result">.*?<button type="submit"><span class="side" aria-hidden="true">A<\/span>/,
      'the winner buttons say A and B, not just the colour');
    assert.match(body, /<div class="calloff"><form class="inline" method="post" action="\/lcq\/cancel">/, 'Call off sits apart, below a rule');
    assert.match(body, /<details id="lcq-pick"><summary>Pick a match<\/summary>/, 'the hand-picked match folds away');
    assert.ok(!/action="\/lcq\/start">.*?<button type="submit">/.test(body), 'Start is never the pink primary button');
    assert.ok(!body.includes('name="player" required>'), 'no list of every player to drop from');
    for (const name of ['a', 'b']) {
      assert.match(body, new RegExp(`name="${name}" required><option value="">Choose player</option>`), `${name} starts blank`);
    }
    for (const gone of ['id="lcq-pair"', 'New group', 'Waiting for a group', 'Make a group']) assert.ok(!body.includes(gone), `no ${gone}: groups are gone`);
  });

  test('standings count matches, waiting and eliminated players, show how long each has waited, and each number on the row', () => {
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
    assert.match(body, new RegExp('<li><span class="who"><strong>P1</strong> <span class="hint">1W, waiting <span data-wait="4500000">1 h 15 min</span></span></span>' +
      '<span class="nowrap">\\+91 98765 00000</span><details class="drop"><summary>Drop</summary><form method="post" action="/lcq/drop"'), 'the number is on the row; Drop folds away');
    assert.match(body, /<h3>Eliminated \(2\)<\/h3><\/summary><ul class="names"><li><span class="who"><strong>P(2|4)<\/strong> <span class="hint">out in round 1 to P(1|3)<\/span><\/span><span class="nowrap">[^<]*<\/span><\/li>/,
      'no waiting time, record or Drop once eliminated');
    assert.match(body, /<strong>P9<\/strong> <span class="hint">0W, waiting <span data-wait=/, 'a new sign-up waits from when they signed up');
    assert.ok(!body.includes('Tap a name'), 'nothing to tap for a number');
  });

  test('eliminated: furthest along first, with the round and who beat them; dropped last, with the time and no record', () => {
    signUp(6);
    const st = () => lcq.state();
    const id = (n) => st().players.find((p) => p.name === n).id;
    const play = (a, b) => {
      lcq.start(id(a), id(b));
      const m = st().open[0];
      lcq.result(m.id, id(a));
      return m;
    };
    const first = play('P1', 'P2');
    store.db.prepare('UPDATE lcq_matches SET decidedAt = ? WHERE id = ?').run('2026-01-01T00:00:00Z', first.id);
    play('P3', 'P4');
    play('P1', 'P3');
    play('P1', 'P5');
    lcq.drop(id('P6'));
    const body = runnerPage(makeConfig(), st());
    const out = body.match(/<details id="lcq-b-out">.*?<\/details>/)[0];
    assert.deepEqual([...out.matchAll(/<strong>(P\d)<\/strong> <span class="hint">([^<]*)</g)].map((m) => `${m[1]} ${m[2]}`),
      ['P5 out in round 3 to P1', 'P3 out in round 2 to P1', 'P4 out in round 1 to P3', 'P2 out in round 1 to P1'],
      'P5 (0W) lost in P1\'s round 3, not round 1; on the same round the later loss comes first');
    const dropped = body.match(/<details id="lcq-b-dropped">.*?<\/details>/)[0];
    assert.match(dropped, /<li class="gone"><span class="who"><strong>P6<\/strong> <span class="hint">dropped \d+ [A-Z][a-z]{2}, \d+:\d\d [ap]m<\/span><\/span><span class="nowrap">[^<]*<\/span><\/li>/);
    assert.ok(body.indexOf('id="lcq-b-out"') < body.indexOf('id="lcq-b-dropped"'), 'Dropped comes last');
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

  test('a sticky bar jumps to Playing and Ready, with counts', () => {
    signUp(4);
    const body = runnerPage(makeConfig(), lcq.state());
    assert.match(body, /<nav class="jump" aria-label="Sections"><a href="#lcq-playing">Playing \(0\)<\/a><a href="#lcq-ready">Ready \(2\)<\/a><\/nav>/,
      'only the two sections the operator keeps going back to');
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
    assert.match(byName, /<strong>P1<\/strong> <span class="hint">0W, playing<\/span><\/span><span class="nowrap">\+91 98765 00000<\/span><details class="drop"><summary>Drop<\/summary><form method="post" action="\/lcq\/drop"/);
    assert.match(byName, /<strong>P13<\/strong> <span class="hint">0W, waiting <span data-wait=/);
    assert.match(panel(await find('98765 00024')), /1 found\.<\/p><ul class="names"><li><span class="who"><strong>P25<\/strong> <span class="hint">0W, waiting/, 'by number');
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
    assert.match(body, /<li class="gone"><span class="who"><strong>P1<\/strong> <span class="hint">dropped [^<]*<\/span><\/span><span class="nowrap">[^<]*<\/span><\/li>/, 'no Drop for someone already dropped');
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

  test('the tab says how many more sign-ups make a full bracket; dropped players keep their place', () => {
    assert.deepEqual([1, 2, 3, 16, 17, 24, 32].map((n) => bracketGap(n)),
      [{ size: 1, more: 0 }, { size: 2, more: 0 }, { size: 4, more: 1 }, { size: 16, more: 0 }, { size: 32, more: 15 }, { size: 32, more: 8 }, { size: 32, more: 0 }]);
    const line = () => runnerPage(makeConfig(), lcq.state()).match(/<p class="hint">\d+ in the bracket: [^<]*<\/p>/)?.[0];
    assert.equal(line(), undefined, 'nobody signed up, no line');
    signUp(24);
    assert.equal(line(), '<p class="hint">24 in the bracket: need 8 more for a full bracket of 32.</p>');
    lcq.drop(lcq.state().players[0].id);
    assert.equal(line(), '<p class="hint">24 in the bracket: need 8 more for a full bracket of 32.</p>', 'a dropped player still counts');
    store.db.exec('DELETE FROM leads WHERE id IN (SELECT id FROM leads ORDER BY id DESC LIMIT 8)');
    assert.equal(line(), '<p class="hint">16 in the bracket: a full bracket.</p>');
  });

  test('Finalize from the tablet: a short bracket needs the tick; later sign-ups are counted and told the bracket is full', async () => {
    const cookie = await signIn();
    const page = async () => (await request({ port, path: '/lcq', headers: cookie })).body;
    signUp(3);
    const open = await page();
    assert.match(open, /<p class="hint">3 in the bracket: need 1 more for a full bracket of 4\.<\/p><form method="post" action="\/lcq\/finalize"/);
    assert.match(open, /<input type="checkbox" name="confirm" value="yes" required><span>3 in: 1 short of 4; some players will need a Bye<\/span>/);
    await post('/lcq/finalize', {}, cookie);
    assert.match(await page(), /Tick that some players will need a Bye, then tap Finalize\./, 'without the tick it is refused, and says why');
    assert.equal(lcq.phase().finalizedAt, null);
    await post('/lcq/finalize', { confirm: 'yes' }, cookie);
    assert.ok(lcq.phase().finalizedAt, 'positive control: finalized with the tick');
    store.db.exec(`UPDATE leads SET createdAt = '2026-01-01T00:00:00Z'; UPDATE lcq_games SET finalizedAt = '2026-01-01T00:00:00.500Z'`);

    store.setBracket('lcq');
    const thanks = await postForm(port, '/submit', { name: 'Late Comer', phone: '9876599999', email: 'guest@example.com', consent: 'yes' });
    assert.equal(thanks.status, 200);
    assert.match(thanks.body, /<p>The LCQ bracket is full; staff may still add you\.<\/p>/);
    const body = await page();
    assert.match(body, /Finalized 1 Jan, 5:30 am, 3 in the bracket\. 1 signed up since; Unfinalize to add them \(4 in, a full bracket\)\. <form class="inline" method="post" action="\/lcq\/unfinalize">.*?<\/form><\/div>/);
    assert.ok(!body.includes('Late Comer'), 'not on the runner while finalized');
    assert.ok(!body.includes('action="/lcq/finalize"'), 'no Finalize once finalized');
    await post('/lcq/unfinalize', {}, cookie);
    const back = await page();
    assert.match(back, /<p class="hint">4 in the bracket: a full bracket\.<\/p><form method="post" action="\/lcq\/finalize" class="fields"><input type="hidden" name="game" value=""><button/,
      'a full bracket needs no tick');
    assert.ok(back.includes('Late Comer'), 'Unfinalize lets them in');
    store.setBracket('normal');
    const normal = await postForm(port, '/submit', { name: 'Normal One', phone: '9876599998', email: 'guest@example.com', consent: 'yes' });
    assert.ok(!normal.body.includes('bracket is full'), 'not finalized now, and Normal sign-ups never hear it');
  });

  test('the tablet offers the Bye in Needs attention, and Results shows it', async () => {
    const cookie = await signIn();
    const page = async () => (await request({ port, path: '/lcq', headers: cookie })).body;
    signUp(3);
    startAll();
    assert.ok(!(await page()).includes('action="/lcq/bye"'), 'no Bye before Finalize');
    lcq.finalize('', true);
    const p3 = lcq.state().players.find((p) => p.name === 'P3');
    const body = await page();
    assert.match(body, new RegExp(`<li>P3 is the only one on 0W, and nobody can catch up\\.<form class="inline" method="post" action="/lcq/bye"><input type="hidden" name="player" value="${p3.id}"><input type="hidden" name="game" value=""><button type="submit">Give P3 a Bye</button>`),
      'a full-width button that says who gets it');
    await post('/lcq/bye', { player: String(p3.id) }, cookie);
    assert.match(await page(), /<li><span><strong>P3<\/strong> had a bye <span class="hint">Round 1, <span data-wait="\d+">[^<]+<\/span> ago<\/span><\/span><form class="inline" method="post" action="\/lcq\/undo">/);
    await post('/lcq/bye', { player: String(p3.id) }, cookie);
    assert.match(await page(), /A Bye is only for the one player left on their wins/, 'a second tap is refused, and says why');
    assert.equal(lcq.state().players.find((p) => p.id === p3.id).wins, 1);
  });

  test('LCQ End from the tablet shows the Winner and leaves a read-only tab; Reopen brings the controls back', async () => {
    const cookie = await signIn();
    const page = async () => (await request({ port, path: '/lcq', headers: cookie })).body;
    signUp(4);
    assert.ok(!(await page()).includes('action="/lcq/end"'), 'no End before Finalize');
    lcq.finalize();
    startAll();
    assert.match(await page(), /<h2 id="lcq-end-title">End this LCQ<\/h2><p class="hint">A match is still on: record its winner or call it off first\.<\/p><\/section>/);
    for (const m of lcq.state().open) lcq.result(m.id, m.a);
    const ready = await page();
    assert.match(ready, /Winners: <strong>P1 and P3<\/strong> \(1W\)\. Ending shows/, 'two still in on 1W share it so far');
    assert.match(ready, /<span>2 players still in; they will not play again<\/span><\/label><button class="danger" type="submit">LCQ End<\/button>/);
    assert.ok(ready.indexOf('action="/lcq/unfinalize"') < ready.indexOf('id="lcq-results"') && ready.indexOf('action="/lcq/end"') > ready.indexOf('id="lcq-standings"'),
      'End sits at the bottom, away from Unfinalize');
    await post('/lcq/end', {}, cookie);
    assert.match(await page(), /Tick that the players still in will not play again, then tap End\./);
    lcq.start(lcq.state().proposals[0].a.id, lcq.state().proposals[0].b.id);
    lcq.result(lcq.state().open[0].id, lcq.state().open[0].a);
    await post('/lcq/end', {}, cookie);
    const done = await page();
    assert.match(done, /<p class="flash" role="status">Ended [^<]+\. Winner: <strong>P1<\/strong> \(2W\)\.<\/p>/, 'one left: no tick needed');
    for (const gone of ['id="lcq-playing"', 'id="lcq-ready"', 'action="/lcq/undo"', 'action="/lcq/drop"', 'action="/lcq/start"', 'action="/lcq/end"', 'action="/lcq/unfinalize"', 'Needs attention']) {
      assert.ok(!done.includes(gone), `ended: no ${gone}`);
    }
    assert.match(done, /<details class="panel" id="lcq-standings" open>/, 'final standings start open');
    assert.match(done, /<li><span><strong>P1<\/strong> beat P3 <span class="hint">Round 2, <span data-wait="\d+">[^<]+<\/span> ago<\/span><\/span><\/li>/, 'results stay, without Undo');
    await post('/lcq/reopen', {}, cookie);
    assert.ok(lcq.phase().endedAt, 'Reopen needs the tick');
    await post('/lcq/reopen', { confirm: 'yes' }, cookie);
    assert.ok((await page()).includes('action="/lcq/undo"'), 'Undo is back');
  });

  test('with no games set up, an ended LCQ closes the form to LCQ sign-ups and says so', async () => {
    signUp(2);
    lcq.finalize();
    lcq.end('', true);
    assert.ok(!(await request({ port, path: '/' })).body.includes('LCQ has ended'), 'not while sign-ups go to Normal');
    store.setBracket('lcq');
    assert.match((await request({ port, path: '/' })).body, /<p>The LCQ has ended, so it is closed to new sign-ups\. Ask at the desk\.<\/p>/);
    const res = await postForm(port, '/submit', { name: 'Late Comer', phone: '9876599999', email: 'guest@example.com', consent: 'yes' });
    assert.equal(res.status, 409);
    assert.match(res.body, /<p class="error" role="alert">The LCQ has ended, so it is closed to new sign-ups\.<\/p>/);
    assert.equal(store.list().length, 2, 'nothing saved');
  });

  test('emails never reach the tablet, not even through Find a player', async () => {
    const cookie = await signIn();
    store.register({ name: 'Asha', phone: '+919876500001', email: 'asha.secret@example.com', source: 'form', noticeVersion: 'v', bracket: 'lcq' });
    const page = (await request({ port, path: '/lcq', headers: cookie })).body;
    assert.ok(page.includes('Asha'), 'positive control: the player is on the tablet');
    assert.ok(!page.includes('asha.secret'), 'no email on the page');
    const found = (await request({ port, path: '/lcq?q=asha.secret', headers: cookie })).body;
    assert.match(found, /Nobody matches "asha\.secret"/, 'and no search by email');
  });

  test('an earlier event can be picked and viewed, but nothing in it can be changed', async () => {
    const cookie = await signIn();
    const get = async (path) => (await request({ port, path, headers: cookie })).body;
    const october = store.currentEvent();
    signUp(4);
    startAll();
    const [m1, m2] = lcq.state().open;
    lcq.result(m1.id, m1.a);
    lcq.finalize();
    assert.equal((await get('/lcq')).includes('aria-label="Events"'), false, 'one event: no picker');
    const november = store.startEvent(`November ${now}`);
    try {
      const fresh = await get('/lcq');
      assert.match(fresh, new RegExp(`<nav class="tabs events" aria-label="Events"><span>Event</span><a href="/lcq" aria-current="page">${november.name} \\(now\\)</a><a href="/lcq\\?event=${october.code}">`));
      assert.ok(!fresh.includes('P1'), 'the current event starts empty');

      const old = await get(`/lcq?event=${october.code}`);
      assert.match(old, new RegExp(`You are looking at ${october.name}\\. Only ${november.name} can be run\\.`));
      assert.match(old, /<li><span><strong>P1<\/strong> beat P2 <span class="hint">Round 1, [^]*?<\/span><\/span><\/li>/, 'its results, without Undo');
      assert.ok(!old.includes(' ready</a>') && !old.includes('Ready ('), 'nothing is offered as ready to start');
      assert.match(old, /Finalized [^<]+, 4 in the bracket\.<\/div><\/div>/, 'its state, without Unfinalize');
      for (const action of ['result', 'start', 'undo', 'cancel', 'drop', 'bye', 'finalize', 'unfinalize', 'end', 'reopen']) {
        assert.ok(!old.includes(`action="/lcq/${action}"`), `no ${action} on an earlier event`);
      }
      assert.match(old, new RegExp(`<form method="get" action="/lcq" class="fields" role="search"><input type="hidden" name="event" value="${october.code}">`), 'search stays on that event');
      assert.equal(old.match(/data-version="([^"]+)"/)[1], JSON.parse(await get(`/lcq/version?event=${october.code}`)).v, 'the page and the poll agree');
      assert.ok((await get('/lcq?event=nope')).includes(`${november.name} (now)</a>`) && !(await get('/lcq?event=nope')).includes('You are looking at'), 'an unknown event is the current one');

      await post('/lcq/result', { match: String(m2.id), winner: String(m2.a) }, cookie);
      assert.match(await get('/lcq'), /That match is from an earlier event, which can only be viewed\./, 'a forged post is refused, and says why');
      assert.equal(lcq.at(october.code).state().open.length, 1, 'the earlier match is untouched');
      await post('/lcq/undo', { match: String(m1.id) }, cookie);
      assert.equal(lcq.at(october.code).state().decided.length, 1);
      const p1 = lcq.at(october.code).state().players.find((p) => p.name === 'P1');
      assert.equal(p1.status, 'free', 'precondition: P1 could be dropped if this were the current event');
      await post('/lcq/drop', { player: String(p1.id), confirm: 'yes' }, cookie);
      assert.equal(lcq.at(october.code).state().players.find((p) => p.id === p1.id).status, 'free', 'not dropped');

      const octoberView = lcq.at(october.code);
      octoberView.cancel(m2.id);
      octoberView.end('', true);
      const ended = await get(`/lcq?event=${october.code}`);
      assert.match(ended, /Ended [^<]+\. Winner: <strong>P1<\/strong> \(1W\)\.<\/p><\/div>/, 'an ended earlier event shows its Winner');
      assert.ok(!ended.includes('action="/lcq/reopen"'), 'without Reopen');
      assert.match(await get('/lcq'), /<h1>LCQ runner<\/h1>/, 'positive control: the current event still renders');
    } finally {
      store.db.prepare("UPDATE settings SET value = ? WHERE key = 'currentEvent'").run(october.code);
      store.db.prepare('DELETE FROM events WHERE code = ?').run(november.code);
    }
  });

  test('after a result, an Undo for it sits at the top until the next change', async () => {
    const cookie = await signIn();
    const page = async () => (await request({ port, path: '/lcq', headers: cookie })).body;
    signUp(4);
    startAll();
    const [m1, m2] = lcq.state().open;
    await post('/lcq/result', { match: String(m1.id), winner: String(m1.b) }, cookie);
    const after = await page();
    assert.match(after, new RegExp(`<div class="flash" role="status">P2 beat P1\\. <form class="inline" method="post" action="/lcq/undo"><input type="hidden" name="match" value="${m1.id}">`));
    assert.ok(after.indexOf('P2 beat P1. <form') < after.indexOf('id="lcq-playing"'), 'above the matches');
    assert.ok(!(await page()).includes('P2 beat P1. <form'), 'gone once the page has moved on');
    assert.ok(!/<p[^>]*>[^<]*(<[^/][^>]*>[^<]*)*<form/.test(after.replace(/<style>[\s\S]*?<\/style>/, '')), 'no form sits inside a paragraph anywhere on the page');
    await post('/lcq/result', { match: String(m2.id), winner: String(m2.a) }, cookie);
    await post('/lcq/undo', { match: String(m2.id) }, cookie);
    assert.match(await page(), /Result undone\./, 'the Undo works from there');
    assert.equal(lcq.state().open.length, 1);
  });

  test('Ready shows the longest-waiting pairs; past four, the rest fold under N more pairs', () => {
    signUp(20);
    // P19 and P20 have waited longest.
    const pf = lcq.state().players.filter((p) => ['P19', 'P20'].includes(p.name)).map((p) => p.id);
    store.db.prepare(`UPDATE leads SET createdAt = '2026-01-01T00:00:00Z' WHERE id IN (${pf.join(',')})`).run();
    const body = runnerPage(makeConfig(), lcq.state());
    const top = body.match(/<ul class="plain ready">(.*?)<\/ul><details id="lcq-ready-more">/)[1];
    assert.equal((top.match(/action="\/lcq\/start"/g) ?? []).length, 3);
    assert.match(top, /^<li><span class="pair"><strong>P19<\/strong> vs <strong>P20<\/strong>/, 'the longest wait first');
    assert.match(body, /<details id="lcq-ready-more"><summary>7 more pairs<\/summary><ul class="plain ready">(<li>.*?<\/li>){7}<\/ul><\/details>/,
      'the toggle says how many it holds, not the total');
    const four = runnerPage(makeConfig(), { ...lcq.state(), proposals: lcq.state().proposals.slice(0, 4) });
    assert.ok(!four.includes('id="lcq-ready-more"'), 'four pairs: all listed, no toggle for a single one');
    assert.equal((four.match(/<ul class="plain ready">(.*?)<\/ul>/)[1].match(/action="\/lcq\/start"/g) ?? []).length, 4);
    const five = runnerPage(makeConfig(), { ...lcq.state(), proposals: lcq.state().proposals.slice(0, 5) });
    assert.match(five, /<summary>2 more pairs<\/summary>/, 'five: three, then two more');
  });

  test('a pair on more wins that has waited longer comes before newer 0W pairs', () => {
    signUp(10);
    startAll();
    const [m1, m2] = lcq.state().open;
    lcq.result(m1.id, m1.a);
    lcq.result(m2.id, m2.a);
    store.db.prepare('UPDATE lcq_matches SET decidedAt = ? WHERE id IN (?, ?)').run('2026-01-01T00:00:00Z', m1.id, m2.id);
    for (let i = 11; i <= 14; i++) {
      store.register({ name: `P${i}`, phone: `+9198766${String(i).padStart(5, '0')}`, source: 'form', noticeVersion: 'v', bracket: 'lcq' });
    }
    const { proposals } = lcq.state();
    assert.equal(proposals[0].wins, 0, 'precondition: the engine lists 0W pairs first');
    const body = runnerPage(makeConfig(), lcq.state());
    assert.match(body, /<ul class="plain ready"><li><span class="pair"><strong>P1<\/strong> vs <strong>P3<\/strong> <span class="chip">1W<\/span>/);
  });

  test('the bracket line leads before Finalize, and the Winner leads once ended; Drop and End are danger buttons that name what they do', () => {
    signUp(2);
    const open = runnerPage(makeConfig(), lcq.state());
    assert.ok(open.indexOf('action="/lcq/finalize"') < open.indexOf('id="lcq-playing"'), 'Finalize above the matches');
    assert.match(open, /<button class="danger" type="submit">Drop P1<\/button>/);
    lcq.finalize();
    startAll();
    lcq.result(lcq.state().open[0].id, lcq.state().open[0].a);
    const live = runnerPage(makeConfig(), lcq.state());
    assert.match(live, /<section class="panel danger-zone" id="lcq-end"[^>]*>.*?<button class="danger" type="submit">LCQ End<\/button>/);
    assert.ok(live.indexOf('id="lcq-end"') > live.indexOf('id="lcq-find"'), 'End is the last thing on the page');
    lcq.end();
    const ended = runnerPage(makeConfig(), lcq.state());
    assert.ok(ended.indexOf('Winner: <strong>P1</strong>') < ended.indexOf('id="lcq-results"'), 'the Winner first');
    assert.ok(!ended.includes('<nav class="jump"'), 'nothing to jump to on a finished tab');
  });

  test('the bracket centres each match on the two that fed it, puts the furthest along on top, and stacks the rest', () => {
    const { slot, rows } = bracketLayout([
      { key: 'r1a', col: 0, next: 'r2a' }, { key: 'r1b', col: 0, next: 'r2a' },
      { key: 'r1c', col: 0, next: 'r2b' }, { key: 'r1d', col: 0, next: 'r2b' },
      { key: 'r2a', col: 1, next: 'fin' }, { key: 'r2b', col: 1, next: 'fin' },
      { key: 'fin', col: 2, next: null },
      { key: 'late', col: 0, next: 'wait' }, { key: 'wait', col: 1, next: null },
    ]);
    assert.deepEqual(['r1a', 'r1b', 'r1c', 'r1d', 'r2a', 'r2b', 'fin', 'late', 'wait'].map((k) => slot.get(k)), [0, 1, 2, 3, 0.5, 2.5, 1.5, 4, 4]);
    assert.equal(rows, 5);
  });

  test('Rounds draws a bracket: a line from each winner to their next match, the open match, who waits, and how many are still to play', () => {
    const bracket = (st) => runnerPage(makeConfig(), st).match(/<details class="panel" id="lcq-rounds"( open)?>.*?<\/details>/s);
    assert.match(bracket(lcq.state())[0], /No matches yet\./);
    signUp(6);
    lcq.finalize('', true);
    startAll();
    const [m1, m2] = lcq.state().open;
    lcq.result(m1.id, m1.a);
    lcq.result(m2.id, m2.b);
    const live = bracket(lcq.state());
    assert.equal(live[1], undefined, 'folded while the LCQ runs');
    const html = live[0];
    assert.match(html, /<h3 style="left:0px">Round 1<\/h3>/, 'all 6 in round 1 already: nothing more to come');
    assert.match(html, /<h3 style="left:196px">Round 2 <span class="hint">2 more to play<\/span><\/h3>/, '3 winners: a match and a bye');
    assert.match(html, /<h3 style="left:392px">Final <span class="hint">1 more to play<\/span><\/h3>/);
    assert.match(html, /<div class="bkc" style="left:0px;top:42px"><div class="r win"><span>P1<\/span><span class="tag">W<\/span><\/div><div class="r lose"><span>P2<\/span><\/div><\/div>/);
    assert.match(html, /<div class="r lose"><span>P3<\/span><\/div><div class="r win"><span>P4<\/span><span class="tag">W<\/span><\/div>/);
    assert.match(html, /<div class="bkc live" style="left:0px;top:162px"><div class="r"><span>P5<\/span><\/div><div class="r"><span>P6<\/span><\/div><\/div>/);
    assert.match(html, /<div class="bkc waiting" style="left:196px;top:42px"><div class="r"><span>P1<\/span><\/div><div class="r hint"><span>waiting <span data-wait=/,
      'P1 waits beside the match they won');
    assert.equal((html.match(/<path /g) ?? []).length, 2, 'one line per winner to where they are now');
    assert.match(html, /<path d="M160 67H178V67H196"\/>/, 'P1: straight across to their waiting card');
    assert.match(html, /role="region" aria-label="Bracket, scroll sideways for later rounds" tabindex="0"/);
    assert.match(html, /<svg class="bk-lines"[^>]* aria-hidden="true">/);
  });

  test('the last one in is shown as the winner after the final, not as waiting in an extra round; once ended it says Winner', () => {
    signUp(4);
    lcq.finalize();
    const play = () => {
      const [p] = lcq.state().proposals;
      lcq.start(p.a.id, p.b.id);
      lcq.result(lcq.state().open[0].id, p.a.id);
    };
    play();
    play();
    play();
    const st = lcq.state();
    assert.deepEqual(st.players.filter((p) => p.status === 'free').map((p) => [p.name, p.wins]), [['P1', 2]], 'precondition: P1 won the final');
    const html = runnerPage(makeConfig(), st);
    assert.match(html, /<h3 style="left:196px">Final<\/h3>/);
    assert.match(html, /<h3 style="left:392px">Winner<\/h3><div class="bkc champ" style="left:392px;top:[\d.]+px"><div class="r win"><span>P1<\/span><\/div><div class="r hint"><span>Last one in, 2W<\/span>/);
    assert.ok(!/Round 3|bkc waiting/.test(html), 'no extra round, nobody waiting');
    lcq.end();
    const ended = runnerPage(makeConfig(), lcq.state()).match(/<details class="panel" id="lcq-rounds"( open)?>.*?<\/details>/s);
    assert.equal(ended[1], ' open', 'open once ended, to look back');
    assert.match(ended[0], /<span>Winner, 2W<\/span>/);
  });

  test('the tablet sees a desk delete then add, even when the new registration reuses the old id', async () => {
    const cookie = await signIn();
    const v = async () => JSON.parse((await request({ port, path: '/lcq/version', headers: cookie })).body).v;
    signUp(2);
    const before = await v();
    const last = store.list().at(-1);
    store.remove(last.id);
    store.register({ name: 'Chen', phone: '+919876599901', source: 'desk', noticeVersion: 'v', bracket: 'lcq' });
    assert.equal(store.list().at(-1).id, last.id, 'precondition: the id was reused and the count is the same');
    assert.notEqual(await v(), before);
  });

  test('the tablet also sees a write made through another connection to the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcq-version-'));
    const path = join(dir, 'leads.db');
    const mine = new LeadStore(path);
    try {
      const runner = new Lcq(mine);
      const before = runner.version();
      const other = new DatabaseSync(path);
      other.exec("INSERT INTO settings (key, value) VALUES ('from-elsewhere', '1')");
      other.close();
      assert.notEqual(runner.version(), before);
    } finally {
      mine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('just looking changes nothing: opening the pages again and again keeps the version, so the tablet does not reload', async () => {
    const cookie = await signIn();
    signUp(4);
    startAll();
    const v = async () => JSON.parse((await request({ port, path: '/lcq/version', headers: cookie })).body).v;
    const first = await v();
    for (let i = 0; i < 2; i++) {
      for (const path of ['/lcq', '/lcq?q=P1', '/lcq/version', '/admin', '/admin/export.csv', '/']) await request({ port, path, headers: cookie });
    }
    assert.equal(await v(), first);
    lcq.result(lcq.state().open[0].id, lcq.state().open[0].a);
    assert.notEqual(await v(), first, 'positive control: a result moves it');
  });

  test('a focused field or half-made pick holds off updates, but never for more than a minute idle', () => {
    assert.equal(holdsUpdates(100, false), true, 'right after a tap');
    assert.equal(holdsUpdates(1000, false), false, 'idle and nothing in hand: update');
    assert.equal(holdsUpdates(30_000, true), true, 'a focused field or a pick in progress');
    assert.equal(holdsUpdates(60_001, true), false, 'a forgotten tap on a box no longer freezes the page');
  });

  test('Results offer Undo only where it would work: the latest result for both players', () => {
    signUp(4);
    startAll();
    const [m1, m2] = lcq.state().open;
    lcq.result(m1.id, m1.a);
    lcq.result(m2.id, m2.a);
    lcq.start(m1.a, m2.a);
    const st = () => lcq.state();
    lcq.result(st().open[0].id, m1.a);
    const html = runnerPage(makeConfig(), st()).match(/<ul class="plain results">.*?<\/ul>/s)[0];
    const rows = html.match(/<li>.*?<\/li>/gs);
    assert.equal(rows.length, 3);
    assert.match(rows[0], /<strong>P1<\/strong> beat P3 <span class="hint">Round 2, .*action="\/lcq\/undo".*class="subtle">Undo<\/button>/s, 'the final can be undone');
    assert.ok(!rows[1].includes('/lcq/undo') && !rows[2].includes('/lcq/undo'), 'the earlier results cannot until the final is undone, so no button');
    for (const m of [m1, m2]) assert.throws(() => lcq.undo(m.id), /first/, 'and the server agrees');
    assert.ok(!html.includes('class="quiet"'), 'Undo is not styled as danger');
  });

  test('the admin page shows the runner address and PIN', async () => {
    const admin = await request({ port, path: '/admin' });
    assert.match(admin.body, new RegExp(`LCQ runner for a tablet on the booth Wi-Fi: <strong>http://127\\.0\\.0\\.1:${port}/lcq</strong>, PIN <strong>${lcq.pin()}</strong>`));
  });
});
