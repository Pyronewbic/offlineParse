import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConfigError } from '../src/config.js';
import { LeadStore } from '../src/leads.js';
import { Router, RouterError, WifiBan, cleanMac, macFromArp, macOf, onBoothNet, ubusPost } from '../src/routerban.js';
import { createPortalServer } from '../src/web.js';
import { makeConfig, postForm, request } from './helpers.js';

// A throwaway self-signed certificate, only for the fake router below.
const KEY = readFileSync(new URL('./fixtures/router-key.pem', import.meta.url));
const CERT = readFileSync(new URL('./fixtures/router-cert.pem', import.meta.url));
const PIN = '59aef169bf3ee062ee3cfd999be0abf31e1bc449cc4d6652840e44530df6342c';
const PHONE_MAC = 'a4:83:e7:01:02:03';
const ROUTER_ON = { enabled: true, host: '100.64.0.1', certSha256: PIN };

describe('Wi-Fi addresses', () => {
  test('cleanMac keeps one device address, in one spelling', () => {
    assert.equal(cleanMac('A4-83-E7-1-2-3'), PHONE_MAC);
    assert.equal(cleanMac('a6:83:e7:01:02:03'), 'a6:83:e7:01:02:03', 'a private (locally administered) address is a phone too');
    for (const bad of ['ff:ff:ff:ff:ff:ff', '01:00:5e:00:00:fb', '00:00:00:00:00:00', 'a4:83:e7:01:02', 'a4:83:e7:01:02:03:04', 'zz:83:e7:01:02:03', '', null, 7]) {
      assert.equal(cleanMac(bad), null, String(bad));
    }
  });

  test('the ARP table of macOS, Windows and Linux gives the address of exactly that IP', () => {
    const ip = '100.64.0.23';
    assert.equal(macFromArp('? (100.64.0.23) at a4:83:e7:1:2:3 on en0 ifscope [ethernet]\n', ip), PHONE_MAC, 'macOS drops leading zeros');
    assert.equal(macFromArp('\r\nInterface: 100.64.0.2 --- 0xb\r\n  Internet Address      Physical Address      Type\r\n  100.64.0.23           a4-83-e7-01-02-03     dynamic\r\n', ip), PHONE_MAC);
    assert.equal(macFromArp('100.64.0.23 dev wlan0 lladdr a4:83:e7:01:02:03 REACHABLE\n', ip), PHONE_MAC);
    assert.equal(macFromArp('? (100.64.0.23) at (incomplete) on en0 ifscope [ethernet]\n', ip), null, 'not resolved');
    assert.equal(macFromArp('? (100.64.0.230) at a4:83:e7:9:9:9 on en0 ifscope [ethernet]\n', ip), null, 'a longer address with the same start is not it');
    assert.equal(macFromArp('100.64.0.23 dev wlan0 lladdr ff:ff:ff:ff:ff:ff STALE\n', ip), null);
    assert.equal(macFromArp('garbage', ip), null);
  });

  test('only an address on the booth network ever reaches the ARP command, as an argument, never through a shell', async () => {
    const calls = [];
    const run = async (cmd, args) => {
      calls.push([cmd, args]);
      return '? (100.64.0.23) at a4:83:e7:1:2:3 on en0 ifscope [ethernet]';
    };
    for (const ip of ['8.8.8.8', '100.64.1.23', '100.64.0.23; rm -rf /', '$(reboot)', '::ffff:100.64.0.23', '', undefined]) {
      assert.equal(await macOf(ip, { router: '100.64.0.1', platform: 'darwin', run }), null, String(ip));
    }
    assert.deepEqual(calls, [], 'none of them ran anything');
    assert.equal(await macOf('100.64.0.23', { router: '100.64.0.1', platform: 'darwin', run }), PHONE_MAC);
    assert.deepEqual(calls, [['arp', ['-n', '100.64.0.23']]], 'control: a booth address does');
    await macOf('100.64.0.23', { router: '100.64.0.1', platform: 'win32', run });
    assert.deepEqual(calls[1], ['arp', ['-a', '100.64.0.23']]);
    assert.ok(onBoothNet('100.64.0.200', '100.64.0.1') && !onBoothNet('100.64.2.200', '100.64.0.1'));
  });
});

describe('routerBan config', () => {
  const on = (rb) => makeConfig({ routerBan: rb }).routerBan;
  test('off unless set, and checked when set', () => {
    assert.equal(makeConfig().routerBan.enabled, false);
    assert.equal(on({ ...ROUTER_ON, certSha256: PIN.toUpperCase().match(/../g).join(':') }).certSha256, PIN, 'the colon form openssl prints is fine');
    for (const [rb, why] of [
      [{ enabled: true }, /certSha256 is needed/],
      [{ host: '8.8.8.8' }, /routerBan.host/], [{ host: '169.254.169.254' }, /routerBan.host/], [{ host: '100.128.0.1' }, /routerBan.host/],
      [{ hours: 501 }, /hours/], [{ hours: 0 }, /hours/], [{ afterMin: 0 }, /afterMin/], [{ afterMin: 2.5 }, /afterMin/],
      [{ never: ['ff:ff:ff:ff:ff:ff'] }, /never/], [{ certSha256: 'abc' }, /certSha256/], [{ enabled: 'yes' }, /enabled/], [{ password: 'x' }, /unknown keys: password/],
    ]) assert.throws(() => on(rb), (e) => e instanceof ConfigError && why.test(e.message), JSON.stringify(rb));
  });
});

/** A stand-in for an OpenWrt router's /ubus: one Wi-Fi network, a login, and the hostapd calls this uses. */
function fakeRouter() {
  const state = { sessions: new Set(), clients: new Set([PHONE_MAC]), calls: [], requests: 0, reply: null };
  const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
    state.requests++;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (state.reply) return state.reply(req, res);
      const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const answer = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      const [sid, object, call, args] = params;
      if (method === 'list') {
        if (!state.sessions.has(sid)) return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32002, message: 'Access denied' } }));
        return answer({ 'hostapd.wlan0': {} });
      }
      if (object === 'session' && call === 'login') {
        if (args.username !== 'booth' || args.password !== 'pw') return answer([6]);
        const session = 'ab'.repeat(16);
        state.sessions.add(session);
        return answer([0, { ubus_rpc_session: session }]);
      }
      if (!state.sessions.has(sid)) return answer([6]);
      state.calls.push([object, call, args]);
      if (call === 'get_clients') return answer([0, { freq: 2437, clients: Object.fromEntries([...state.clients].map((m) => [m, {}])) }]);
      if (call === 'del_client') {
        state.clients.delete(args.addr);
        return answer([0]);
      }
      return answer([2]);
    });
  });
  return { server, state };
}

describe('router client over HTTPS', () => {
  let fake;
  let port;
  before(async () => {
    fake = fakeRouter();
    await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
    port = fake.server.address().port;
  });
  after(() => fake.server.close());
  beforeEach(() => {
    Object.assign(fake.state, { sessions: new Set(), clients: new Set([PHONE_MAC]), calls: [], requests: 0, reply: null });
  });
  const router = (extra = {}) => new Router({ host: '127.0.0.1', port, certSha256: PIN, password: 'pw', timeoutMs: 500, ...extra });

  test('logs in, finds the phone, and drops it with a ban in milliseconds', async () => {
    const r = router();
    assert.deepEqual(await r.holding(PHONE_MAC), ['hostapd.wlan0']);
    assert.deepEqual(await r.holding('a4:83:e7:09:09:09'), [], 'a phone that is not here is not found');
    await r.ban(PHONE_MAC, 86_400_000, ['hostapd.wlan0']);
    assert.deepEqual(fake.state.calls.at(-1), ['hostapd.wlan0', 'del_client', { addr: PHONE_MAC, reason: 5, deauth: true, ban_time: 86_400_000 }]);
    assert.ok(!fake.state.clients.has(PHONE_MAC));
  });

  test('a router whose certificate is not the pinned one never gets the password', async () => {
    await assert.rejects(router({ certSha256: 'ab'.repeat(32) }).holding(PHONE_MAC), /certificate does not match/);
    assert.equal(fake.state.requests, 0, 'nothing reached it');
    await router().holding(PHONE_MAC);
    assert.ok(fake.state.requests > 0, 'control: the right pin does');
  });

  test('a wrong password, and a session the router forgot, are handled', async () => {
    await assert.rejects(router({ password: 'nope' }).holding(PHONE_MAC), /refused the routerBan login/);
    const r = router();
    await r.holding(PHONE_MAC);
    fake.state.sessions.clear();
    assert.deepEqual(await r.holding(PHONE_MAC), ['hostapd.wlan0'], 'logs in again once');
  });

  test('redirects, errors, oversized, malformed and slow replies are refused', async () => {
    const cases = [
      [(req, res) => { res.writeHead(302, { Location: 'https://example.com/ubus' }); res.end(); }, /HTTP 302/],
      [(req, res) => { res.writeHead(500); res.end(); }, /HTTP 500/],
      [(req, res) => res.end('x'.repeat(70 * 1024)), /too large/],
      [(req, res) => res.end('<html>'), /not JSON/],
      [(req, res) => res.end(JSON.stringify({ result: 'odd' })), /refused the routerBan login|unexpected shape/],
      [() => {}, /did not answer in time/],
    ];
    for (const [reply, why] of cases) {
      fake.state.reply = reply;
      await assert.rejects(router().holding(PHONE_MAC), (e) => e instanceof RouterError && why.test(e.message), String(why));
    }
  });

  test('ubusPost sends the body only after the certificate check', async () => {
    let seen = '';
    fake.state.reply = (req, res) => res.end(JSON.stringify({ ok: true }));
    fake.server.once('request', (req) => req.on('data', (c) => { seen += c; }));
    assert.deepEqual(await ubusPost({ host: '127.0.0.1', port, certSha256: PIN, timeoutMs: 500 }, { secret: 's' }), { ok: true });
    assert.match(seen, /"secret":"s"/);
  });
});

/** A router stub that records what it is asked, for the policy tests. */
function stubRouter(connected = new Set([PHONE_MAC])) {
  const calls = [];
  return {
    calls, connected, broken: false,
    async holding(mac) {
      if (this.broken) throw new RouterError('the router did not answer in time');
      return connected.has(mac) ? ['hostapd.wlan0'] : [];
    },
    async ban(mac, ms, radios) {
      if (this.broken) throw new RouterError('the router did not answer in time');
      calls.push([mac, ms, radios ?? 'all']);
    },
  };
}

describe('who is dropped, when, and for how long', () => {
  let store;
  let now;
  let router;
  let macs;
  const settings = makeConfig({ routerBan: { ...ROUTER_ON, never: ['00:11:22:33:44:55'] } }).routerBan;
  const make = (extra = {}) => new WifiBan(settings, store, {
    router, clock: () => now, lookup: async (ip) => macs[ip] ?? null, ownMacs: () => ['10:20:30:40:50:60'], ...extra,
  });
  const settle = () => new Promise((r) => setImmediate(r));
  const rows = () => store.db.prepare('SELECT mac, phone, eventCode FROM wifi_bans ORDER BY mac').all().map((r) => ({ ...r }));
  beforeEach(() => {
    store = new LeadStore(':memory:', { firstEvent: { code: 'EVT', name: 'Event' } });
    now = Date.parse('2026-11-14T10:00:00Z');
    router = stubRouter();
    macs = { '100.64.0.23': PHONE_MAC };
  });

  test('a sign-up is dropped afterMin later, for hours, and kept for later', async () => {
    const ban = make();
    ban.queue({ ip: '100.64.0.23', phone: '+919876543210', eventCode: 'EVT' });
    await settle();
    now += 2 * 60_000;
    await ban.tick();
    assert.deepEqual(router.calls.filter(([, ms]) => ms === 24 * 3_600_000), [], 'not before 3 minutes');
    now += 60_000;
    await ban.tick();
    assert.deepEqual(router.calls, [[PHONE_MAC, 24 * 3_600_000, ['hostapd.wlan0']]]);
    assert.deepEqual(rows(), [{ mac: PHONE_MAC, phone: '+919876543210', eventCode: 'EVT' }]);
    assert.deepEqual([...ban.status('EVT').banned], ['+919876543210']);
  });

  test('a second sign-up from the same phone waits again; a phone not on the Wi-Fi then is left alone', async () => {
    const ban = make();
    ban.queue({ ip: '100.64.0.23', phone: '+919876543210', eventCode: 'EVT' });
    await settle();
    now += 2 * 60_000;
    ban.queue({ ip: '100.64.0.23', phone: '+919876543211', eventCode: 'EVT' });
    await settle();
    now += 2 * 60_000;
    await ban.tick();
    assert.equal(router.calls.length, 0, 'the friend still has time');
    router.connected.clear();
    now += 2 * 60_000;
    await ban.tick();
    assert.deepEqual([router.calls, rows()], [[], []], 'gone before it was due: no ban, nothing kept');
  });

  test('the laptop, the tablet and the never list are never dropped', async () => {
    const TABLET = 'a4:83:e7:0a:0a:0a';
    macs = { '100.64.0.40': TABLET, '100.64.0.41': '10:20:30:40:50:60', '100.64.0.42': '00:11:22:33:44:55', '100.64.0.23': PHONE_MAC };
    for (const m of Object.values(macs)) router.connected.add(m);
    const ban = make();
    ban.protect('100.64.0.40');
    await settle();
    for (const ip of Object.keys(macs)) ban.queue({ ip, phone: `+9198765432${ip.slice(-2)}`, eventCode: 'EVT' });
    await settle();
    now += 3 * 60_000;
    await ban.tick();
    assert.deepEqual(router.calls.map(([m]) => m), [PHONE_MAC], 'only the guest\'s phone');
  });

  test('a forged ARP answer cannot get the tablet dropped: its address is the one taken when it entered the PIN', async () => {
    const TABLET = 'a4:83:e7:0a:0a:0a';
    const ATTACKER = 'a4:83:e7:0e:0e:0e';
    router.connected.add(TABLET);
    macs = { '100.64.0.40': TABLET };
    const ban = make();
    ban.protect('100.64.0.40');
    await settle();
    macs = { '100.64.0.66': TABLET, '100.64.0.40': ATTACKER };
    ban.queue({ ip: '100.64.0.66', phone: '+919876543266', eventCode: 'EVT' });
    await settle();
    now += 3 * 60_000;
    await ban.tick();
    assert.deepEqual(router.calls, [], 'the guest at .66 claimed the tablet\'s address, then the tablet\'s IP; the tablet stays on');
    macs = { '100.64.0.41': null };
    const unknown = make();
    unknown.protect('100.64.0.41');
    await settle();
    assert.match(unknown.status('EVT').lastError, /LCQ tablet.*routerBan\.never/, 'a tablet it cannot find is reported');
  });

  test('a failed lookup or an unreachable router is counted and shown, never thrown', async () => {
    const ban = make();
    ban.queue({ ip: '100.64.0.99', phone: '+919876543210', eventCode: 'EVT' });
    await settle();
    assert.equal(ban.status('EVT').failures, 1);
    ban.queue({ ip: '100.64.0.23', phone: '+919876543210', eventCode: 'EVT' });
    await settle();
    router.broken = true;
    now += 3 * 60_000;
    await ban.tick();
    assert.deepEqual([ban.status('EVT').failures, ban.status('EVT').lastError], [2, 'the router did not answer in time']);
    const throwing = make({ lookup: async () => { throw new Error('arp missing'); } });
    throwing.queue({ ip: '100.64.0.23', phone: '+919876543210', eventCode: 'EVT' });
    await settle();
    assert.match(throwing.status('EVT').lastError, /arp missing/);
  });

  test('kept bans are applied again with the time left, for the current event only, and forgotten once over', async () => {
    store.db.exec('CREATE TABLE IF NOT EXISTS wifi_bans (mac TEXT NOT NULL, phone TEXT NOT NULL, eventCode TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (mac, eventCode));');
    const insert = store.db.prepare('INSERT INTO wifi_bans (mac, phone, eventCode, at) VALUES (?, ?, ?, ?)');
    insert.run(PHONE_MAC, '+919876543210', 'EVT', new Date(now - 3_600_000).toISOString());
    insert.run('a4:83:e7:0b:0b:0b', '+919876543211', 'OLD', new Date(now - 3_600_000).toISOString());
    insert.run('a4:83:e7:0c:0c:0c', '+919876543212', 'EVT', new Date(now - 25 * 3_600_000).toISOString());
    const ban = make();
    await ban.tick();
    assert.deepEqual(router.calls, [[PHONE_MAC, 23 * 3_600_000, 'all']], 'once at start: 23 h left of 24');
    assert.deepEqual(rows().map((r) => r.mac), [PHONE_MAC, 'a4:83:e7:0b:0b:0b'], 'the one past its time is gone');
    now += 60_000;
    await ban.tick();
    assert.equal(router.calls.length, 1, 'not again within 5 minutes');
    now += 5 * 60_000;
    await ban.tick();
    assert.equal(router.calls.length, 2);
  });

  test('lift forgets the ban, tells the router, and cancels a pending drop', async () => {
    const ban = make();
    ban.queue({ ip: '100.64.0.23', phone: '+919876543210', eventCode: 'EVT' });
    await settle();
    now += 3 * 60_000;
    await ban.tick();
    assert.equal(await ban.lift({ phone: '+919876543210', eventCode: 'EVT' }), true);
    assert.deepEqual([rows(), router.calls.at(-1)], [[], [PHONE_MAC, 0, 'all']]);
    ban.queue({ ip: '100.64.0.23', phone: '+919876543210', eventCode: 'EVT' });
    await settle();
    await ban.lift({ phone: '+919876543210', eventCode: 'EVT' });
    now += 3 * 60_000;
    await ban.tick();
    assert.equal(router.calls.length, 2, 'the cancelled drop never happened');
    router.broken = true;
    assert.equal(await ban.lift({ phone: '+919876543210', eventCode: 'EVT' }), true, 'nothing to lift');
  });
});

describe('the booth with the Wi-Fi drop on', () => {
  let store;
  let server;
  let port;
  let queued;
  let lifted;
  let banned;
  let protectedIps;
  const cfg = makeConfig({ routerBan: ROUTER_ON });
  const wifiBan = {
    queue: (q) => queued.push(q),
    protect: (ip) => protectedIps.push(ip),
    lift: async (l) => {
      lifted.push([l.phone, l.eventCode]);
      return true;
    },
    status: () => ({ banned: new Set(banned), pending: 1, failures: 2, lastError: 'the <router> did not answer in time', afterMin: 3, hours: 24 }),
  };
  const VALID = { name: 'Asha Rao', phone: '98765 43210', email: 'guest@example.com', consent: 'yes' };
  const start = async (config, ban = wifiBan) => {
    store = new LeadStore(':memory:', { firstEvent: { code: config.eventCode, name: config.eventName } });
    const lcq = { pin: () => '123456', games: () => [], phase: () => ({}) };
    server = createPortalServer(config, store, { laptopIp: '127.0.0.1', quiet: true, lcq, wifiBan: ban, submitLimit: { max: 1e6, windowMs: 60_000 } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  };
  const stop = () => {
    server.close();
    server.closeAllConnections();
    store.close();
  };
  const adminToken = async () => (await request({ port, path: '/admin' })).body.match(/name="token" value="([^"]+)"/)[1];
  beforeEach(() => {
    queued = [];
    protectedIps = [];
    lifted = [];
    banned = [];
  });

  test('a form sign-up queues the phone and says so; the notice and consent name the Wi-Fi address', async () => {
    await start(cfg);
    try {
      const form = (await request({ port, path: '/' })).body;
      assert.match(form, /keeping my name, number and email for this event's registration, and to my phone being taken off this Wi-Fi after I register\./);
      assert.match(form, /Your phone's Wi-Fi address is kept for 24 hours only to keep it off this Wi-Fi\./);
      const res = await postForm(port, '/submit', VALID);
      assert.equal(res.status, 200);
      assert.match(res.body, /This phone leaves the booth Wi-Fi in 3 minutes\./);
      assert.deepEqual(queued, [{ ip: '127.0.0.1', phone: '+919876543210', eventCode: cfg.eventCode }]);
      assert.equal(store.list()[0].noticeVersion, `${cfg.noticeVersion}+wifi`, 'the consent records which notice was shown');
      assert.equal((await postForm(port, '/submit', VALID)).status, 409);
      assert.equal(queued.length, 1, 'a refused repeat queues nothing');
      await postForm(port, '/admin/add', { ...VALID, phone: '91234 56789', token: await adminToken() });
      assert.equal(queued.length, 1, 'a desk entry is not a phone on the Wi-Fi');
      assert.equal(store.list().length, 2);
      assert.equal(store.list()[1].noticeVersion, cfg.noticeVersion);
      const login = await postForm(port, '/lcq/login', { pin: '123456' });
      assert.equal(login.status, 303, 'precondition: the tablet signed in from this address');
      assert.deepEqual(protectedIps, ['127.0.0.1'], 'its Wi-Fi address is taken now, to protect');
      await postForm(port, '/submit', { ...VALID, phone: '91234 56780' });
      assert.equal(queued.length, 1, 'never the tablet');
    } finally {
      stop();
    }
  });

  test('with it off, nothing is queued and the pages read as before', async () => {
    await start(makeConfig());
    try {
      const form = (await request({ port, path: '/' })).body;
      assert.ok(!form.includes('Wi-Fi address') && !form.includes('taken off'));
      const res = await postForm(port, '/submit', VALID);
      assert.match(res.body, /You can leave this Wi-Fi now\./);
      assert.deepEqual(queued, [], 'not even with a WifiBan handed in');
      assert.equal(store.list()[0].noticeVersion, makeConfig().noticeVersion);
      assert.ok(!(await request({ port, path: '/admin' })).body.includes('Wi-Fi drop'));
    } finally {
      stop();
    }
  });

  test('the admin page shows the drops, lets a phone back on, and a delete lifts the ban once the last registration goes', async () => {
    await start(cfg);
    try {
      await postForm(port, '/submit', VALID);
      banned = ['+919876543210'];
      const page = (await request({ port, path: '/admin' })).body;
      assert.match(page, /Wi-Fi drop on: 1 phone kept off the booth Wi-Fi in this event, 1 to drop\. <strong>2 did not work<\/strong>; last: the &lt;router&gt; did not answer in time/);
      assert.match(page, /action="\/admin\/wifi-back">.*?Back on Wi-Fi<\/button>/);
      const [lead] = store.list();
      const token = await adminToken();
      const back = await postForm(port, '/admin/wifi-back', { id: lead.id, token });
      assert.deepEqual([back.status, back.headers.location.includes('msg=wifi-back'), lifted], [303, true, [[lead.phone, lead.eventCode]]]);
      assert.equal((await postForm(port, '/admin/wifi-back', { id: lead.id, token: 'wrong' })).status, 403, 'needs the admin token');
      lifted = [];
      store.register({ name: 'Asha Rao', phone: lead.phone, email: 'guest@example.com', source: 'desk', noticeVersion: 'v', bracket: 'lcq' });
      await postForm(port, '/admin/delete', { id: lead.id, token, confirm: 'yes' });
      assert.deepEqual(lifted, [], 'another registration of that number is left, so the ban stays');
      await postForm(port, '/admin/delete', { id: store.list()[0].id, token, confirm: 'yes' });
      assert.deepEqual(lifted, [[lead.phone, lead.eventCode]], 'the last one goes: lifted');
    } finally {
      stop();
    }
  });
});
