import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { after, before, beforeEach, describe, test } from 'node:test';
import { LeadStore } from '../src/leads.js';
import { MAX_BODY, createPortalServer } from '../src/web.js';
import { makeConfig, postForm, request } from './helpers.js';

const VALID = { name: 'Asha Rao', phone: '98765 43210', consent: 'yes' };

function lanAddress() {
  return Object.values(networkInterfaces()).flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
}

describe('portal server', () => {
  let store;
  let server;
  let port;
  const cfg = makeConfig();

  before(async () => {
    store = new LeadStore(':memory:');
    server = createPortalServer(cfg, store, { laptopIp: '127.0.0.1', quiet: true });
    await new Promise((r) => server.listen(0, '0.0.0.0', r));
    port = server.address().port;
  });
  after(() => {
    server.close();
    server.closeAllConnections();
    store.close();
  });
  beforeEach(() => store.db.exec('DELETE FROM leads'));

  const adminToken = async () => {
    const res = await request({ port, path: '/admin' });
    return res.body.match(/name="token" value="([^"]+)"/)[1];
  };

  test('captive probes on foreign hosts redirect to the portal', async () => {
    for (const [host, path] of [['captive.apple.com', '/hotspot-detect.html'],
      ['connectivitycheck.gstatic.com', '/generate_204'], ['www.msftconnecttest.com', '/connecttest.txt'],
      ['example.com', '/']]) {
      const res = await request({ port, path, headers: { Host: host } });
      assert.equal(res.status, 302, host);
      assert.equal(res.headers.location, `http://127.0.0.1:${port}/`);
    }
  });

  test('retargeting the laptop address moves both the redirect and the accepted host', async () => {
    try {
      server.setLaptopIp('10.9.9.9');
      const probe = await request({ port, path: '/hotspot-detect.html', headers: { Host: 'captive.apple.com' } });
      assert.equal(probe.headers.location, `http://10.9.9.9:${port}/`);
      assert.equal((await request({ port, headers: { Host: `10.9.9.9:${port}` } })).status, 200);
    } finally {
      server.setLaptopIp('127.0.0.1');
    }
    assert.equal((await request({ port, headers: { Host: '10.9.9.9' } })).status, 302, 'old address no longer served');
  });

  test('the form and thank-you pages are registration-only: no socials or link promises', async () => {
    const form = (await request({ port, headers: { Host: '127.0.0.1' } })).body;
    const thanks = (await postForm(port, '/submit', VALID)).body;
    for (const [label, html] of [['form', form], ['thanks', thanks]]) {
      const text = html.replace(/<style>[\s\S]*?<\/style>/, '');
      assert.ok(!/Get the links|Instagram|YouTube|Discord|social|on their way|Reply STOP/i.test(text), `${label} page mentions socials`);
    }
    assert.match(form, /<button class="primary" type="submit">Register<\/button>/);
    assert.match(form, /<h1 class="sr-only">Register for /);
    assert.match(form, /<label for="phone">Mobile number<\/label>/);
  });

  test('the portal host serves the form', async () => {
    const res = await request({ port, headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(res.status, 200);
    assert.match(res.body, /<form method="post" action="\/submit">/);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
  });

  test('a valid submission is stored normalized', async () => {
    const res = await postForm(port, '/submit', VALID);
    assert.equal(res.status, 200);
    assert.match(res.body, /You're registered, Asha!/);
    const leads = store.list();
    assert.equal(leads.length, 1);
    assert.deepEqual([leads[0].name, leads[0].phone, leads[0].source, leads[0].eventCode],
      ['Asha Rao', '+919876543210', 'form', 'EVT26']);
  });

  test('invalid submissions are rejected and nothing is stored', async () => {
    const cases = [[{ ...VALID, consent: '' }, 'consent'], [{ name: 'Asha', phone: '98765 43210' }, 'consent'],
      [{ ...VALID, phone: '12345' }, 'phone'], [{ ...VALID, name: '   ' }, 'name'], [{}, 'name']];
    for (const [fields, field] of cases) {
      const res = await postForm(port, '/submit', fields);
      assert.equal(res.status, 400, JSON.stringify(fields));
      assert.match(res.body, new RegExp(`<p class="field-error" id="${field}-error" role="alert">`), JSON.stringify(fields));
      const input = res.body.match(new RegExp(`<input id="${field}"[^>]*>|<input type="checkbox" name="${field}"[^>]*>`))[0];
      assert.match(input, new RegExp(`aria-invalid="true" autofocus`), `${field} input is flagged and focused`);
      assert.match(input, new RegExp(`aria-describedby="[^"]*${field}-error`), `${field} input points at its error`);
      assert.equal((res.body.match(/aria-invalid="true"/g) || []).length, 1, 'only one field is flagged');
    }
    assert.equal(store.list().length, 0);
  });

  test('a number that is already registered is refused under the phone field', async () => {
    assert.equal((await postForm(port, '/submit', VALID)).status, 200);
    for (const phone of ['98765 43210', '+91 98765 43210', '098765-43210']) {
      const res = await postForm(port, '/submit', { name: 'Someone Else', phone, consent: 'yes' });
      assert.equal(res.status, 409, phone);
      assert.match(res.body, /<p class="field-error" id="phone-error" role="alert">This number is already registered\./);
      assert.match(res.body, /value="Someone Else"/, 'what they typed is kept');
      assert.ok(!res.body.includes('Asha'), 'the existing registration is not revealed');
    }
    assert.deepEqual(store.list().map((l) => [l.name, l.phone]), [['Asha Rao', '+919876543210']]);
  });

  test('admin add refuses an already-registered number and names who has it', async () => {
    await postForm(port, '/submit', VALID);
    const res = await postForm(port, '/admin/add', { name: 'Ravi', phone: '9876543210', token: await adminToken() });
    assert.equal(res.status, 409);
    assert.match(res.body, /\+91 98765 43210 is already registered, as Asha Rao\./);
    assert.equal(store.list().length, 1);
  });

  test('a re-rendered form keeps the consent tick only if it was given', async () => {
    const ticked = await postForm(port, '/submit', { ...VALID, phone: '12345' });
    assert.match(ticked.body, /name="consent" value="yes" required checked/);
    const unticked = await postForm(port, '/submit', { ...VALID, phone: '12345', consent: '' });
    assert.ok(!/name="consent"[^>]* checked/.test(unticked.body));
  });

  test('the thank-you page shows the number in readable groups', async () => {
    const res = await postForm(port, '/submit', VALID);
    assert.match(res.body, /<strong class="nowrap">\+91 98765 43210<\/strong>/);
  });

  test('re-rendered form escapes what the user typed', async () => {
    const res = await postForm(port, '/submit', { name: '"><script>alert(1)</script>', phone: 'x' });
    assert.equal(res.status, 400);
    assert.ok(!res.body.includes('<script>alert(1)'));
    assert.ok(res.body.includes('&quot;&gt;&lt;script&gt;'));
  });

  test('oversized, unlabelled and malformed bodies are refused', async () => {
    const big = `name=${'a'.repeat(MAX_BODY)}`;
    const cases = [
      [413, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': big.length }, body: big }],
      [415, { headers: { 'Content-Type': 'application/json', 'Content-Length': 2 }, body: '{}' }],
      [400, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': 2 }, body: Buffer.from([0xff, 0xfe]) }],
      [400, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': 63 }, body: Array(21).fill('a=1').join('&') }],
    ];
    for (const [status, opts] of cases) {
      const res = await request({ port, method: 'POST', path: '/submit', ...opts });
      assert.equal(res.status, status);
    }
    assert.equal(store.list().length, 0);
  });

  test('admin lists registrations newest first, numbered down, with stats and no socials tools', async () => {
    await postForm(port, '/submit', VALID);
    await postForm(port, '/admin/add', { name: 'Ravi Kumar', phone: '91234 56789', token: await adminToken() });
    await postForm(port, '/submit', { ...VALID, name: 'Meera', phone: '9000011111' });
    const res = await request({ port, path: '/admin' });
    assert.equal(res.status, 200);
    const order = [...res.body.matchAll(/<td class="num idx">(\d+)<\/td><th scope="row">([^<]+)<\/th>/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(order, ['3 Meera', '2 Ravi Kumar', '1 Asha Rao']);
    assert.match(res.body, /<dt>Total<\/dt><dd>3<\/dd>/);
    assert.match(res.body, /<dt>Wi-Fi form<\/dt><dd>2<\/dd>/);
    assert.match(res.body, /<dt>WhatsApp<\/dt><dd>1<\/dd>/);
    assert.match(res.body, /<dt>Last sign-up<\/dt><dd>\d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d\d [ap]m<\/dd>/);
    assert.match(res.body, /<span class="chip whatsapp">WhatsApp message<\/span>/);
    assert.match(res.body, /<td class="num">\+91 98765 43210<\/td>/);
    assert.match(res.body, /<button class="quiet" aria-label="Delete Asha Rao">Delete<\/button>/);
    assert.match(res.body, /<caption class="sr-only">Registrations, newest first<\/caption>/);
    assert.ok(!/wa\.me|Mark sent|Open WhatsApp|socials|Socials/.test(res.body));
    const gone = await postForm(port, '/admin/mark-sent', { id: 1, token: await adminToken() });
    assert.equal(gone.status, 404, 'the mark-sent endpoint no longer exists');
  });

  test('admin search finds by name or any form of the number, and echoes the query safely', async () => {
    await postForm(port, '/submit', VALID);
    await postForm(port, '/submit', { ...VALID, name: 'Ravi Kumar', phone: '91234 56789' });
    const names = async (q) => {
      const res = await request({ port, path: `/admin?q=${encodeURIComponent(q)}` });
      return [...res.body.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((m) => m[1]);
    };
    assert.deepEqual(await names('asha'), ['Asha Rao']);
    assert.deepEqual(await names('KUMAR'), ['Ravi Kumar']);
    for (const q of ['98765 43210', '+91 98765 43210', '098765-43210', '919876543210', '43210', '765']) {
      assert.deepEqual(await names(q), ['Asha Rao'], q);
    }
    assert.deepEqual(await names('98'), [], 'fewer than 3 digits never matches a number');
    assert.deepEqual(await names(''), ['Ravi Kumar', 'Asha Rao']);
    const none = await request({ port, path: `/admin?q=${encodeURIComponent('<script>x</script>')}` });
    assert.ok(!none.body.includes('<script>x</script>'), 'query is escaped');
    assert.match(none.body, /No matches for "&lt;script&gt;x&lt;\/script&gt;"\./);
    assert.match(none.body, /0 matches for .* out of 2\. <a href="\/admin">Clear search<\/a>/);
    const csv = await request({ port, path: '/admin/export.csv?q=asha' });
    assert.equal(csv.body.trim().split('\r\n').length, 3, 'the export ignores the search');
  });

  test('admin flash messages come from a fixed list; anything else in the URL is ignored', async () => {
    const added = await postForm(port, '/admin/add', { name: 'Ravi', phone: '9123456789', token: await adminToken() });
    assert.equal(added.headers.location, '/admin?msg=added');
    assert.match((await request({ port, path: '/admin?msg=added' })).body, /<p class="flash" role="status">Registration added\.<\/p>/);
    for (const msg of ['<b>hi</b>', 'constructor', 'toString', '__proto__']) {
      const res = await request({ port, path: `/admin?msg=${encodeURIComponent(msg)}` });
      assert.equal(res.status, 200, msg);
      assert.ok(!res.body.includes('class="flash"'), msg);
    }
  });

  test('a failed admin add keeps what was typed', async () => {
    const res = await postForm(port, '/admin/add', { name: 'Ravi "R"', phone: '12345', token: await adminToken() });
    assert.equal(res.status, 400);
    assert.match(res.body, /value="Ravi &quot;R&quot;"/);
    assert.match(res.body, /value="12345"/);
  });

  test('admin POSTs need the page token', async () => {
    for (const token of ['', 'wrong', '\u00FC'.repeat(43)]) {
      const res = await postForm(port, '/admin/add', { name: 'Ravi', phone: '9123456789', token });
      assert.equal(res.status, 403);
    }
    assert.equal(store.list().length, 0);
    const ok = await postForm(port, '/admin/add', { name: 'Ravi', phone: '9123456789', token: await adminToken() });
    assert.equal(ok.status, 303, 'positive control: the real token works');
    assert.equal(store.list().length, 1);
  });

  test('admin answers only to localhost names, so a rebound hostname cannot read or change it', async () => {
    await postForm(port, '/submit', VALID);
    const token = await adminToken();
    for (const host of ['rebind.attacker.example', `rebind.attacker.example:${port}`, '100.64.0.2', 'localhost.attacker.example']) {
      for (const path of ['/admin', '/admin/export.csv']) {
        const res = await request({ port, path, headers: { Host: host } });
        assert.equal(res.status, 404, `${host} ${path}`);
        assert.ok(!res.body.includes('9876543210') && !res.body.includes(token), `${host} ${path} leaks nothing`);
      }
      const body = new URLSearchParams({ id: '1', confirm: 'yes', token }).toString();
      const post = await request({ port, method: 'POST', path: '/admin/delete', body, headers: {
        Host: host, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } });
      assert.equal(post.status, 404, `${host} delete`);
    }
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `LOCALHOST:${port}`]) {
      assert.equal((await request({ port, path: '/admin', headers: { Host: host } })).status, 200, `positive control: ${host}`);
    }
    assert.equal(store.list().length, 1, 'nothing was deleted');
  });

  test('admin POSTs from another origin are refused even with the token', async () => {
    const token = await adminToken();
    const add = (headers) => {
      const body = new URLSearchParams({ name: 'Ravi', phone: '9123456789', token }).toString();
      return request({ port, method: 'POST', path: '/admin/add', body, headers: {
        'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers } });
    };
    for (const headers of [{ Origin: 'http://rebind.attacker.example' }, { Origin: 'null' }, { Origin: `http://localhost:${port + 1}` },
      { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      assert.equal((await add(headers)).status, 403, JSON.stringify(headers));
    }
    assert.equal(store.list().length, 0);
    const ok = await add({ Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(ok.status, 303, 'positive control: the page itself can post');
    assert.equal(store.list().length, 1);
  });

  test('admin delete asks for confirmation, then removes the registration', async () => {
    await postForm(port, '/submit', { ...VALID, name: 'Asha <b>Rao</b>' });
    const { id } = store.list()[0];
    const token = await adminToken();
    const confirm = await postForm(port, '/admin/delete', { id, token });
    assert.equal(confirm.status, 200);
    assert.match(confirm.body, /Delete this registration\?/);
    assert.match(confirm.body, /<a class="btn secondary" href="\/admin" autofocus>Cancel<\/a>/);
    assert.match(confirm.body, /<strong>Asha &lt;b&gt;Rao&lt;\/b&gt;<\/strong>/);
    assert.match(confirm.body, /name="confirm" value="yes"/);
    assert.equal(store.list().length, 1, 'nothing deleted before confirming');

    for (const bad of ['', 'wrong']) {
      assert.equal((await postForm(port, '/admin/delete', { id, token: bad, confirm: 'yes' })).status, 403);
    }
    assert.equal(store.list().length, 1);

    const done = await postForm(port, '/admin/delete', { id, token, confirm: 'yes' });
    assert.equal(done.status, 303);
    assert.equal(done.headers.location, '/admin?msg=deleted');
    assert.equal(store.list().length, 0);
    assert.equal((await postForm(port, '/admin/delete', { id, token, confirm: 'yes' })).status, 404, 'second delete finds nothing');
    assert.equal((await postForm(port, '/admin/delete', { id: 'abc', token })).status, 404);
    assert.equal((await postForm(port, '/submit', VALID)).status, 200, 'the number can register again');
  });

  test('admin can add a WhatsApp lead and rejects a bad number', async () => {
    const token = await adminToken();
    const bad = await postForm(port, '/admin/add', { name: 'Ravi', phone: '123', token });
    assert.equal(bad.status, 400);
    const ok = await postForm(port, '/admin/add', { name: 'Ravi', phone: '+91 91234 56789', token });
    assert.equal(ok.status, 303);
    assert.deepEqual(store.list().map((l) => [l.phone, l.source]), [['+919123456789', 'whatsapp']]);
  });

  test('CSV export guards formula-looking names and keeps phones intact', async () => {
    await postForm(port, '/submit', { ...VALID, name: '=HYPERLINK("http://evil","x")' });
    const res = await request({ port, path: '/admin/export.csv' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-disposition'], /attachment/);
    const row = res.body.split('\r\n')[1];
    assert.ok(row.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), row);
    assert.ok(row.includes(',+919876543210,'), row);
  });

  test('admin is invisible from the Wi-Fi side', { skip: !lanAddress() && 'no LAN address on this machine' }, async () => {
    const host = lanAddress();
    const local = await request({ port, path: '/admin' });
    assert.equal(local.status, 200, 'positive control: loopback reaches admin');
    for (const path of ['/admin', '/admin/export.csv']) {
      const res = await request({ host, port, path });
      assert.equal(res.status, 404, path);
    }
    const post = await postForm(port, '/admin/add', { name: 'X', phone: '9876543210', token: await adminToken() }, { host });
    assert.equal(post.status, 404);
    await postForm(port, '/submit', VALID);
    const del = await postForm(port, '/admin/delete', { id: store.list()[0].id, token: await adminToken(), confirm: 'yes' }, { host });
    assert.equal(del.status, 404, 'delete is not reachable from the Wi-Fi side');
    assert.equal(store.list().length, 1);
    store.db.exec('DELETE FROM leads');
    assert.equal(store.list().length, 0);
  });
});

describe('connection limits', () => {
  let store;
  let server;
  let port;
  before(async () => {
    store = new LeadStore(':memory:');
    server = createPortalServer(makeConfig(), store, { laptopIp: '127.0.0.1', quiet: true, idleTimeoutMs: 300, maxConnectionsPerAddress: 2 });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => {
    server.close();
    store.close();
  });

  const silentSocket = () => new Promise((resolvePromise, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolvePromise(socket));
    socket.on('error', reject);
    socket.gone = new Promise((r) => socket.once('close', () => r(Date.now())));
  });

  test('a socket that never sends a request is closed after the idle timeout', async () => {
    const started = Date.now();
    const socket = await silentSocket();
    try {
      const closedAt = await Promise.race([socket.gone, new Promise((r) => setTimeout(() => r(null), 3000))]);
      assert.ok(closedAt, 'server closed the idle socket');
      assert.ok(closedAt - started >= 250, 'not before the timeout');
    } finally {
      socket.destroy();
    }
  });

  test('one address gets a bounded number of connections; others are refused until one closes', async (t) => {
    const a = await silentSocket();
    const b = await silentSocket();
    const c = await silentSocket();
    t.after(() => [a, b, c].forEach((s) => s.destroy()));
    const cClosed = await Promise.race([c.gone, new Promise((r) => setTimeout(() => r(null), 200))]);
    assert.ok(cClosed, 'third connection from the same address is dropped at once');
    const aStillOpen = await Promise.race([a.gone.then(() => false), new Promise((r) => setTimeout(() => r(true), 100))]);
    assert.ok(aStillOpen, 'the first two stay open');
    a.destroy();
    b.destroy();
    await Promise.all([a.gone, b.gone]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await request({ port })).status, 200, 'positive control: a new request is served once slots free up');
  });
});
