import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError, configFromObject, loadConfig } from '../src/config.js';
import { fill, prefillText, socialsText, whatsappLink, wifiPayload } from '../src/payloads.js';
import { BASE_CONFIG, makeConfig, rawConfig } from './helpers.js';

describe('config', () => {
  test('shipped config.json loads', () => {
    const cfg = loadConfig(fileURLToPath(new URL('../config.json', import.meta.url)));
    assert.equal(cfg.eventCode, 'EVT26');
    assert.ok(Object.isFrozen(cfg));
  });

  test('rejects bad values', () => {
    const socials = BASE_CONFIG.socials;
    const cases = {
      'whatsapp number with +': { whatsappNumber: '+919999999999' },
      'laptopIp hostname': { laptopIp: 'laptop.local' },
      'port as string': { httpPort: '80' },
      'port as bool': { httpPort: true },
      'port zero': { httpPort: 0 },
      'port fractional': { dnsPort: 53.5 },
      'port out of range': { dnsPort: 70000 },
      'short WPA password': { wifiPassword: 'short' },
      'long SSID': { wifiSsid: 'x'.repeat(33) },
      'event code with space': { eventCode: 'EVT 26' },
      'http social link': { socials: { ...socials, discord: 'http://discord.gg/x' } },
      'missing social': { socials: { instagram: socials.instagram, youtube: socials.youtube } },
      'socials as array': { socials: [] },
      'unknown placeholder': { socialsMessage: 'Hi {nmae}' },
      'prototype placeholder': { prefillMessage: 'Hi {constructor}' },
      'empty org': { orgName: '  ' },
    };
    for (const [label, override] of Object.entries(cases)) {
      assert.throws(() => configFromObject(rawConfig(override)), ConfigError, label);
    }
  });

  test('rejects unknown and missing keys', () => {
    assert.throws(() => configFromObject(rawConfig({ extra: 1 })), ConfigError);
    const raw = rawConfig();
    delete raw.dbPath;
    assert.throws(() => configFromObject(raw), ConfigError);
  });

  test('unreadable file is a ConfigError', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    try {
      const bad = join(dir, 'c.json');
      writeFileSync(bad, '{not json');
      assert.throws(() => loadConfig(bad), ConfigError);
      assert.throws(() => loadConfig(join(dir, 'missing.json')), ConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('payloads', () => {
  test('fill is single-pass and supports literal braces', () => {
    assert.equal(fill('{a} {{b}}', { a: '{b}', b: 'no' }), '{b} {b}');
  });

  test('wa.me link round-trips the prefilled text', () => {
    const cfg = makeConfig();
    const url = new URL(whatsappLink(cfg.whatsappNumber, prefillText(cfg)));
    assert.equal(url.origin + url.pathname, 'https://wa.me/919999999999');
    assert.equal(url.searchParams.get('text'), prefillText(cfg));
    assert.match(prefillText(cfg), /EVT26/);
  });

  test('wa.me link encodes reserved characters', () => {
    const url = new URL(whatsappLink('919999999999', 'a&b=c #d\n+e'));
    assert.equal(url.searchParams.get('text'), 'a&b=c #d\n+e');
  });

  test('Wi-Fi payload escapes special characters', () => {
    assert.equal(wifiPayload('a;b,c:d"e\\f', ''), 'WIFI:T:nopass;S:a\\;b\\,c\\:d\\"e\\\\f;;');
    assert.equal(wifiPayload('Booth', 'pass;word'), 'WIFI:T:WPA;S:Booth;P:pass\\;word;;');
  });

  test('a name containing placeholders is not expanded', () => {
    const cfg = makeConfig();
    const text = socialsText(cfg, '{instagram}');
    assert.match(text, /^Hi \{instagram\}!/);
    assert.ok(text.includes(cfg.socials.discord));
  });
});
