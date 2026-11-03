import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Lcq } from '../src/lcq.js';
import { LeadStore } from '../src/leads.js';
import { createPortalServer, overdue, runnerPage, runnerVersion } from '../src/web.js';
import { makeConfig, request } from './helpers.js';

describe('LCQ runner over HTTP', () => {
  let store;
  let lcq;
  let server;
  let port;
  let now = 1_000_000;

  before(async () => {
    store = new LeadStore(':memory:');
    lcq = new Lcq(store, { winsToQualify: 2, lossesOut: 2, random: () => 0 });
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
    store.db.exec('DELETE FROM leads; DELETE FROM lcq_members; DELETE FROM lcq_groups; DELETE FROM lcq_matches;');
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
  const signUp = (count) => {
    for (let i = 0; i < count; i++) {
      store.register({ name: `P${i + 1}`, phone: `+9198765${String(i).padStart(5, '0')}`, source: 'form', eventCode: 'E', noticeVersion: 'v', bracket: 'lcq' });
    }
  };

  test('without the PIN a guest sees only the PIN page and changes nothing', async () => {
    signUp(4);
    lcq.syncGroups();
    const page = await request({ port, path: '/lcq' });
    assert.match(page.body, /Enter the PIN/);
    assert.ok(!page.body.includes('P1'), 'no names before signing in');
    assert.equal((await request({ port, path: '/lcq/version' })).status, 401);
    const pair = await post('/lcq/pair', { group: '1', split: '0' });
    assert.equal(pair.headers.location, '/lcq');
    assert.deepEqual(lcq.state().open, [], 'nothing paired');
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

  test('a new group pops up, gets paired, results move players into win buckets, and the runner pairs equal wins', async () => {
    const cookie = await signIn();
    const page = async () => (await request({ port, path: '/lcq', headers: cookie })).body;
    signUp(3);
    assert.match(await page(), /<h3>Waiting for a group, 3\/4 \(3\)<\/h3>/);
    signUp(4);
    const v1 = JSON.parse((await request({ port, path: '/lcq/version', headers: cookie })).body).v;
    assert.match(await page(), /New group: #1 \(P1, P2, P3, P4\)/, 'the 4th LCQ registration makes a group');

    await post('/lcq/seen', {}, cookie);
    assert.ok(!(await page()).includes('New group'));
    await post('/lcq/randomize', { group: '1' }, cookie);
    const v2 = JSON.parse((await request({ port, path: '/lcq/version', headers: cookie })).body).v;
    assert.notEqual(v1, v2, 'the tablet sees the change');
    const [m1, m2] = lcq.state().open;
    await post('/lcq/result', { match: String(m1.id), winner: String(m1.a) }, cookie);
    await post('/lcq/result', { match: String(m2.id), winner: String(m2.a) }, cookie);
    const body = await page();
    assert.match(body, /P1 vs P3 <span class="chip">1W<\/span>/, 'both 1W players are offered a match');
    assert.match(body, /P2 vs P4 <span class="chip">0W<\/span>/);
    await post('/lcq/start', { a: String(m1.a), b: String(m2.a) }, cookie);
    assert.match(await page(), /<strong>P1<\/strong> <span class="hint">1W 0L<\/span> vs <strong>P3<\/strong> <span class="hint">1W 0L<\/span>/,
      'Playing shows each player\'s record');
    const final = lcq.state().open[0];
    await post('/lcq/result', { match: String(final.id), winner: String(final.a) }, cookie);
    const done = await page();
    assert.match(done, /<details id="lcq-b-qualified"><summary>/, 'Qualified starts folded');
    assert.match(done, /<details id="lcq-b-w1" open><summary><h3>1W \(1\)/, 'a win bucket still in play starts open');
    assert.equal(done.match(/data-version="([^"]+)"/)[1], JSON.parse((await request({ port, path: '/lcq/version', headers: cookie })).body).v,
      'the page and the poll agree, or the tablet would reload forever');
    assert.match(await page(), /<h3>Qualified, 2W \(1\)<\/h3><\/summary><ul class="names"><li><details><summary>P1 <span class="hint">2W 0L<\/span>/);
  });

  test('layout: the most-tapped sections first and open, history and standings folded, pickers start blank', async () => {
    const cookie = await signIn();
    signUp(8);
    lcq.syncGroups();
    lcq.pairGroup(1, 0);
    lcq.pairGroup(2, 0);
    const st = () => lcq.state();
    for (const m of st().open) lcq.result(m.id, m.a);
    for (let i = 0; i < 2; i++) {
      const [p] = st().proposals;
      lcq.start(p.a.id, p.b.id);
      lcq.result(st().open[0].id, p.a.id);
    }
    const [next] = st().proposals;
    lcq.start(next.a.id, next.b.id);
    const body = (await request({ port, path: '/lcq', headers: cookie })).body;
    const at = (id) => body.indexOf(`id="${id}"`);
    assert.ok(at('lcq-playing') < at('lcq-ready') && at('lcq-ready') < at('lcq-results') && at('lcq-results') < at('lcq-standings')
      && at('lcq-standings') < at('lcq-drop'), 'Playing, Ready, Results, Standings, Drop');
    for (const [id, open] of [['lcq-playing', true], ['lcq-ready', true], ['lcq-results', true], ['lcq-standings', false], ['lcq-drop', false]]) {
      assert.equal(new RegExp(`<details class="panel" id="${id}" open>`).test(body), open, id);
    }
    assert.match(body, /<summary><h2>Results \(6\)<\/h2><\/summary>/);
    assert.match(body, /<summary>Older results \(1\)<\/summary>/, 'the newest 5 stay out, the rest fold away');
    assert.match(body, /<div class="won"><form class="inline" method="post" action="\/lcq\/result">/);
    assert.ok(!/action="\/lcq\/start">.*?<button type="submit">/.test(body), 'Start is never the pink primary button');
    for (const name of ['a', 'b', 'player']) {
      assert.match(body, new RegExp(`name="${name}" required><option value="">Choose player</option>`), `${name} starts blank`);
    }
    assert.ok(!body.includes('id="lcq-pair"'), 'Groups to pair is hidden when there is nothing to pair');
  });

  test('standings count matches, waiting and eliminated players, show how long each has waited, and reveal a number on tap', () => {
    signUp(13);
    lcq.syncGroups();
    lcq.pairGroup(1, 0);
    lcq.pairGroup(2, 0);
    const [m1, m2] = lcq.state().open;
    lcq.result(m1.id, m1.a);
    lcq.result(m2.id, m2.a);
    lcq.start(m1.b, m2.b);
    lcq.result(lcq.state().open.at(-1).id, m1.b);
    const st = lcq.state();
    const loser = st.players.find((p) => p.id === m2.b);
    assert.equal(loser.status, 'out', 'precondition: 2 losses is eliminated');
    const p1 = st.players.find((p) => p.id === m1.a);
    const body = runnerPage(makeConfig(), st, { now: Date.parse(p1.freeSince) + 75 * 60_000 });
    const stat = (k) => body.match(new RegExp(`<dt>${k}</dt><dd>(\\d+)</dd>`))?.[1];
    assert.deepEqual([stat('Matches on'), stat('Waiting for a match'), stat('Waiting for a group'), stat('Eliminated'), stat('Dropped')],
      ['2', '7', '1', '1', '0'], 'group 2 plays 2 matches; P1, P3, P2 free and group 3 unpaired; P13 has no group; P4 is out');
    assert.match(body, new RegExp(`<summary>P1 <span class="hint">1W 0L, waiting <span data-wait="4500000">1 h 15 min</span></span></summary><span class="nowrap">\\+91 98765 00000</span></details>`));
    assert.match(body, /<h3>Eliminated, 2L \(1\)<\/h3><\/summary><ul class="names"><li><details><summary>P4 <span class="hint">0W 2L<\/span><\/summary>/,
      'no waiting time once eliminated');
    assert.match(body, /<summary>P9 <span class="hint">0W 0L<\/span><\/summary>/, 'no waiting time before a first match');
  });

  test('needs attention: groups to pair, long waits and long matches, capped at 5 each; the version moves only when someone crosses a limit', () => {
    const cfg = makeConfig();
    signUp(16);
    lcq.syncGroups();
    for (const g of [1, 2, 3]) lcq.pairGroup(g, 0);
    for (const m of lcq.state().open.slice(0, 4)) lcq.result(m.id, m.a);
    const st = lcq.state();
    const t0 = Date.now();
    const min = (n) => t0 + n * 60_000;
    assert.deepEqual(runnerPage(cfg, st, { now: t0 }).match(/<section class="attention".*?<\/section>/)[0].match(/<li>.*?<\/li>/g),
      ['<li><a href="#lcq-pair">1 group to pair</a></li>'], 'at the start only the unpaired group needs attention');
    lcq.pairGroup(4, 0);
    assert.ok(!runnerPage(cfg, lcq.state(), { now: t0 }).includes('Needs attention'), 'nothing to flag, no strip');
    assert.deepEqual([overdue(cfg, st, min(9)).waiting.length, overdue(cfg, st, min(11)).waiting.length], [0, 8], 'free players flag at 10 minutes');
    assert.deepEqual([overdue(cfg, st, min(14)).long.length, overdue(cfg, st, min(16)).long.length], [0, 2], 'open matches flag at 15 minutes');
    const body = runnerPage(cfg, st, { now: min(16) });
    const strip = body.match(/<section class="attention".*?<\/section>/)[0];
    assert.match(strip, /<a href="#lcq-pair">1 group to pair<\/a>/);
    assert.equal(strip.match(/href="#lcq-ready"/g).length, 5, 'five waiting names, then a count');
    assert.match(strip, /<li>and 3 more<\/li>/);
    assert.match(strip, /<a href="#lcq-playing">P9 vs P10 running <span data-wait="\d+">\d+ min<\/span><\/a>/);
    assert.equal(runnerVersion(cfg, lcq, st, min(11)), runnerVersion(cfg, lcq, st, min(13)), 'no reload while nothing new is overdue');
    assert.notEqual(runnerVersion(cfg, lcq, st, min(9)), runnerVersion(cfg, lcq, st, min(11)));
    assert.notEqual(runnerVersion(cfg, lcq, st, min(14)), runnerVersion(cfg, lcq, st, min(16)));
    const later = makeConfig({ lcqWaitAlertMin: 30 });
    assert.equal(overdue(later, st, min(16)).waiting.length, 0, 'the limit comes from config');
  });

  test('a sticky bar jumps to each section, with counts', () => {
    signUp(4);
    lcq.syncGroups();
    const body = runnerPage(makeConfig(), lcq.state());
    assert.match(body, /<nav class="jump" aria-label="Sections"><a href="#lcq-pair">Pair \(1\)<\/a><a href="#lcq-playing">Playing \(0\)<\/a>/ );
    assert.match(body, /<a href="#lcq-results">Results<\/a><a href="#lcq-standings">Players \(4\)<\/a><\/nav>/);
    for (const id of ['lcq-pair', 'lcq-playing', 'lcq-ready', 'lcq-results', 'lcq-standings']) assert.ok(body.includes(`id="${id}"`), `${id} exists`);
  });

  test('a refused action is explained once on the next page load', async () => {
    const cookie = await signIn();
    signUp(4);
    lcq.syncGroups();
    await post('/lcq/pair', { group: '1', split: '0' }, cookie);
    const [m] = lcq.state().open;
    await post('/lcq/result', { match: String(m.id), winner: '999' }, cookie);
    assert.match((await request({ port, path: '/lcq', headers: cookie })).body, /The winner must be one of the two players\./);
    assert.ok(!(await request({ port, path: '/lcq', headers: cookie })).body.includes('The winner must be'), 'shown once');
  });

  test('undo says what else it called off; a mistaken ladder match can be called off', async () => {
    const cookie = await signIn();
    signUp(4);
    lcq.syncGroups();
    lcq.pairGroup(1, 0);
    const [m1, m2] = lcq.state().open;
    lcq.result(m1.id, m1.a);
    lcq.result(m2.id, m2.a);
    lcq.start(m1.a, m2.a);
    const body = (await request({ port, path: '/lcq', headers: cookie })).body;
    assert.match(body, /action="\/lcq\/cancel">.*Call off/, 'the ladder match has Call off');
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
    signUp(4);
    lcq.syncGroups();
    assert.equal((await post('/lcq/pair', { group: '1', split: '0' }, { ...cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await request({ port, path: '/lcq', headers: { ...cookie, Host: 'evil.example' } })).status, 404);
    assert.deepEqual(lcq.state().open, []);
  });

  test('the admin page shows the runner address and PIN', async () => {
    const admin = await request({ port, path: '/admin' });
    assert.match(admin.body, new RegExp(`LCQ runner for a tablet on the booth Wi-Fi: <strong>http://127\\.0\\.0\\.1:${port}/lcq</strong>, PIN <strong>${lcq.pin()}</strong>`));
  });
});
