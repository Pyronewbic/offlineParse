import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BrandError, MAX_LOGO_BYTES, loadLogo } from '../src/brand.js';
import { LeadStore } from '../src/leads.js';
import { createPortalServer, formPage, thanksPage } from '../src/web.js';
import { makeConfig, request } from './helpers.js';

const ASSET = fileURLToPath(new URL('../assets/VERSUS EXPERIENCE _ LOGO _2025-05.png', import.meta.url));
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452000000100000000808060000', 'hex');

describe('loadLogo', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'brand-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('an empty path means no logo', () => {
    assert.equal(loadLogo(''), null);
  });

  test('reads a PNG and its dimensions', () => {
    const path = join(dir, 'tiny.png');
    writeFileSync(path, PNG_HEAD);
    const logo = loadLogo(path);
    assert.deepEqual([logo.width, logo.height, logo.bytes.length], [16, 8, PNG_HEAD.length]);
  });

  test('the shipped brand logo loads', { skip: !safeExists(ASSET) && 'brand asset not present' }, () => {
    const logo = loadLogo(ASSET);
    assert.deepEqual([logo.width, logo.height], [2424, 1268]);
  });

  test('refuses missing, non-PNG, truncated and oversized files', () => {
    const notPng = join(dir, 'logo.jpg');
    writeFileSync(notPng, Buffer.from('ffd8ffe000104a464946', 'hex'));
    const truncated = join(dir, 'short.png');
    writeFileSync(truncated, PNG_HEAD.subarray(0, 10));
    const noHeader = join(dir, 'noheader.png');
    writeFileSync(noHeader, Buffer.concat([PNG_HEAD.subarray(0, 8), Buffer.alloc(24, 0x41)]));
    const big = join(dir, 'big.png');
    const fd = openSync(big, 'w');
    writeSync(fd, PNG_HEAD);
    writeSync(fd, Buffer.from([0]), 0, 1, MAX_LOGO_BYTES + 1);
    closeSync(fd);
    for (const [label, path, pattern] of [['missing', join(dir, 'nope.png'), /cannot read/],
      ['not a PNG', notPng, /not a PNG/], ['truncated', truncated, /not a PNG/],
      ['signature but no IHDR', noHeader, /not a PNG/], ['oversized', big, /over 2 MB/]]) {
      assert.throws(() => loadLogo(path), (e) => e instanceof BrandError && pattern.test(e.message), label);
    }
  });
});

function safeExists(path) {
  try {
    loadLogo(path);
    return true;
  } catch {
    return false;
  }
}

describe('logo on the pages', () => {
  const light = { bytes: Buffer.from('light-bytes'), width: 2424, height: 1268 };
  const dark = { bytes: Buffer.from('dark-bytes'), width: 2424, height: 1268 };
  const cfg = makeConfig({ orgName: 'Versus "Experience" <x>' });

  test('both logos: a picture that swaps for dark mode, with escaped alt text', () => {
    const html = formPage(cfg, {}, { light, dark });
    assert.match(html, /<picture><source srcset="\/brand\/logo-dark.png" media="\(prefers-color-scheme: dark\)">/);
    assert.match(html, /<img src="\/brand\/logo-light.png" alt="Versus &quot;Experience&quot; &lt;x&gt;" width="2424" height="1268">/);
  });

  test('one logo: a plain image; no logo: the name as a wordmark', () => {
    assert.match(formPage(cfg, {}, { light: null, dark }), /<img src="\/brand\/logo-dark.png"/);
    const none = thanksPage(cfg, 'Asha', '+919876543210');
    assert.ok(!none.includes('<img'));
    assert.match(none, /<p class="wordmark">Versus &quot;Experience&quot; &lt;x&gt;<\/p>/);
  });

  test('the old org heading is gone from the form', () => {
    assert.ok(!/Hi from/.test(formPage(makeConfig(), {}, { light, dark })));
  });
});

describe('logo routes', () => {
  let store;
  let server;
  let port;
  before(async () => {
    store = new LeadStore(':memory:');
    const brand = { light: { bytes: Buffer.from('LIGHT'), width: 1, height: 1 }, dark: null };
    server = createPortalServer(makeConfig(), store, { laptopIp: '127.0.0.1', quiet: true, brand });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => {
    server.close();
    server.closeAllConnections();
    store.close();
  });

  test('serves the configured logo bytes from any host, cacheable, with the image allowed by CSP', async () => {
    const res = await request({ port, path: '/brand/logo-light.png', headers: { Host: 'captive.apple.com' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.body, 'LIGHT');
    assert.match(res.headers['cache-control'], /max-age=86400/);
    const page = await request({ port, path: '/', headers: { Host: '127.0.0.1' } });
    assert.match(page.headers['content-security-policy'], /img-src 'self'/);
  });

  test('a logo that is not configured, or any other path, is just a portal redirect', async () => {
    for (const path of ['/brand/logo-dark.png', '/brand/../config.json', '/brand/logo-light.png/x', '/assets/x.png']) {
      const res = await request({ port, path });
      assert.equal(res.status, 302, path);
    }
  });
});
