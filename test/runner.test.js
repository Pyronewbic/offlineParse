import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Lcq } from '../src/lcq.js';
import { LeadStore } from '../src/leads.js';
import { createPortalServer } from '../src/web.js';
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
    assert.match(await page(), /Waiting for a group \(3\/4\)/);
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
    const final = lcq.state().open[0];
    await post('/lcq/result', { match: String(final.id), winner: String(final.a) }, cookie);
    assert.match(await page(), /<strong>Qualified \(2W\):<\/strong> P1/);
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
