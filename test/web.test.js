import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { after, before, beforeEach, describe, test } from 'node:test';
import { LeadStore } from '../src/leads.js';
import { MAX_BODY, createPortalServer, leadsCsv } from '../src/web.js';
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
  const cfg = makeConfig({ laptopIp: '127.0.0.1' });

  before(async () => {
    store = new LeadStore(':memory:');
    server = createPortalServer(cfg, store, { quiet: true });
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

  test('the portal host serves the form', async () => {
    const res = await request({ port, headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(res.status, 200);
    assert.match(res.body, /<form method="post" action="\/submit">/);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
  });

  test('a valid submission is stored normalized', async () => {
    const res = await postForm(port, '/submit', VALID);
    assert.equal(res.status, 200);
    assert.match(res.body, /You're on the list, Asha!/);
    const leads = store.list();
    assert.equal(leads.length, 1);
    assert.deepEqual([leads[0].name, leads[0].phone, leads[0].source, leads[0].eventCode],
      ['Asha Rao', '+919876543210', 'form', 'EVT26']);
  });

  test('invalid submissions are rejected and nothing is stored', async () => {
    for (const fields of [{ ...VALID, consent: '' }, { name: 'Asha', phone: '98765 43210' },
      { ...VALID, phone: '12345' }, { ...VALID, name: '   ' }, {}]) {
      const res = await postForm(port, '/submit', fields);
      assert.equal(res.status, 400, JSON.stringify(fields));
      assert.match(res.body, /class="error"/);
    }
    assert.equal(store.list().length, 0);
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

  test('admin lists leads with a prefilled WhatsApp link for each', async () => {
    await postForm(port, '/submit', VALID);
    const res = await request({ port, path: '/admin' });
    assert.equal(res.status, 200);
    const href = res.body.match(/href="(https:\/\/wa\.me\/[^"]+)"/)[1].replaceAll('&amp;', '&');
    const url = new URL(href);
    assert.equal(url.pathname, '/919876543210');
    assert.match(url.searchParams.get('text'), /^Hi Asha! Thanks for stopping by Daijobu/);
  });

  test('admin POSTs need the page token', async () => {
    await postForm(port, '/submit', VALID);
    const { id } = store.list()[0];
    for (const token of ['', 'wrong', '\u00FC'.repeat(43)]) {
      const res = await postForm(port, '/admin/mark-sent', { id, token });
      assert.equal(res.status, 403);
    }
    assert.equal(store.get(id).socialsSentAt, null);
    const ok = await postForm(port, '/admin/mark-sent', { id, token: await adminToken() });
    assert.equal(ok.status, 303);
    assert.ok(store.get(id).socialsSentAt);
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
    assert.equal(store.list().length, 0);
  });
});

test('leadsCsv leaves empty sent dates blank', () => {
  const csv = leadsCsv([{ id: 1, name: 'A', phone: '+919876543210', source: 'form', eventCode: 'E',
    consentAt: 't', noticeVersion: 'v', createdAt: 't', updatedAt: 't', socialsSentAt: null }]);
  assert.ok(csv.startsWith('\uFEFFid,name,phone'));
  assert.ok(csv.split('\r\n')[1].endsWith(',t,'));
});
