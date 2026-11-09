import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError, configFromObject, loadConfig } from '../src/config.js';
import { wifiPayload } from '../src/payloads.js';
import { BASE_CONFIG, makeConfig, rawConfig } from './helpers.js';

describe('config', () => {
  test('the LCQ rules default to 4 wins and 2 losses, and can be set', () => {
    const cfg = makeConfig();
    assert.deepEqual([cfg.lcqWinsToQualify, cfg.lcqLossesOut], [4, 2]);
    const set = makeConfig({ lcqWinsToQualify: 3, lcqLossesOut: 1 });
    assert.deepEqual([set.lcqWinsToQualify, set.lcqLossesOut], [3, 1]);
  });

  test('the LCQ attention limits default to 10 and 15 minutes, and can be set', () => {
    assert.deepEqual([makeConfig().lcqWaitAlertMin, makeConfig().lcqMatchAlertMin], [10, 15]);
    const set = makeConfig({ lcqWaitAlertMin: 5, lcqMatchAlertMin: 240 });
    assert.deepEqual([set.lcqWaitAlertMin, set.lcqMatchAlertMin], [5, 240]);
  });

  test('games default to none and keep their order; the list cannot be changed after loading', () => {
    assert.deepEqual(makeConfig().games, []);
    const cfg = makeConfig({ games: ['SSBU', 'SF6', 'Avatar Legends'] });
    assert.deepEqual(cfg.games, ['SSBU', 'SF6', 'Avatar Legends']);
    assert.ok(Object.isFrozen(cfg.games));
    assert.equal(makeConfig({ games: Array.from({ length: 12 }, (_, i) => `G${i}`) }).games.length, 12, 'twelve is allowed');
  });

  test('shipped config.json loads', () => {
    const cfg = loadConfig(fileURLToPath(new URL('../config.json', import.meta.url)));
    assert.ok(Object.isFrozen(cfg));
    assert.equal(cfg.laptopIp, '100.64.0.2');
  });

  test('rejects bad values', () => {
    const cases = {
      'laptopIp bad address': { laptopIp: '192.168.88.256' },
      'laptopIp empty': { laptopIp: '' },
      'laptopIp padded': { laptopIp: ' en0' },
      'laptopIp control char': { laptopIp: 'en0\u001b[2J' },
      'laptopIp too long': { laptopIp: 'x'.repeat(65) },
      'logo path with control char': { logoLight: 'assets/logo\u0007.png' },
      'logo path as number': { logoDark: 5 },
      'port as string': { httpPort: '80' },
      'port as bool': { httpPort: true },
      'port zero': { httpPort: 0 },
      'LCQ wins zero': { lcqWinsToQualify: 0 },
      'LCQ losses too many': { lcqLossesOut: 21 },
      'LCQ wins as text': { lcqWinsToQualify: '4' },
      'LCQ wait limit zero': { lcqWaitAlertMin: 0 },
      'LCQ match limit too long': { lcqMatchAlertMin: 241 },
      'LCQ wait limit fractional': { lcqWaitAlertMin: 7.5 },
      'LCQ match limit as text': { lcqMatchAlertMin: '15' },
      'port fractional': { dnsPort: 53.5 },
      'port out of range': { dnsPort: 70000 },
      'short WPA password': { wifiPassword: 'short' },
      'long SSID': { wifiSsid: 'x'.repeat(33) },
      'event code with space': { eventCode: 'EVT 26' },
      'games not a list': { games: 'SSBU' },
      'game not text': { games: [5] },
      'game empty': { games: [''] },
      'game with spaces at the ends': { games: [' SF6'] },
      'game with a hidden character': { games: ['SF6\u202E'] },
      'game too long': { games: ['x'.repeat(41)] },
      'same game twice, any case': { games: ['SSBU', 'ssbu'] },
      'too many games': { games: Array.from({ length: 13 }, (_, i) => `G${i}`) },
      'empty org': { orgName: '  ' },
    };
    for (const [label, override] of Object.entries(cases)) {
      assert.throws(() => configFromObject(rawConfig(override)), ConfigError, label);
    }
  });

  test('an old config with the WhatsApp keys is refused by name, so it is easy to fix', () => {
    for (const key of ['whatsappNumber', 'socials', 'socialsMessage', 'prefillMessage']) {
      assert.throws(() => configFromObject(rawConfig({ [key]: 'x' })), new RegExp(`no longer used, delete from config\\.json: ${key}`), key);
    }
  });

  test('laptopIp accepts "auto", an IPv4 address, or an adapter name', () => {
    for (const value of ['auto', '192.168.88.8', 'en0', 'wlan0', 'Wi-Fi', 'Ethernet 2', 'vEthernet (WSL)']) {
      assert.equal(configFromObject(rawConfig({ laptopIp: value })).laptopIp, value);
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
  test('Wi-Fi payload escapes special characters', () => {
    assert.equal(wifiPayload('a;b,c:d"e\\f', ''), 'WIFI:T:nopass;S:a\\;b\\,c\\:d\\"e\\\\f;;');
    assert.equal(wifiPayload('Booth', 'pass;word'), 'WIFI:T:WPA;S:Booth;P:pass\\;word;;');
  });
});
