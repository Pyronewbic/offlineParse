import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { rawConfig } from './helpers.js';

const SCRIPT = fileURLToPath(new URL('../scripts/make-qr.js', import.meta.url));
let hasQrcode = true;
try {
  await import('qrcode');
} catch {
  hasQrcode = false;
}

function runTerminal(overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'qr-'));
  try {
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify(rawConfig({ wifiSsid: 'Versus Booth', wifiPassword: 'secret-pass-1', ...overrides })));
    return spawnSync(process.execPath, [SCRIPT, '--config', config, '--terminal'], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('qr:show prints the Wi-Fi and WhatsApp codes in order, without the Wi-Fi password', { skip: !hasQrcode && 'run npm install' }, () => {
  const r = runTerminal({ laptopIp: '100.64.0.2' });
  assert.equal(r.status, 0, r.stderr);
  const labels = r.stdout.split('\n').filter((l) => /^(Wi-Fi|Register|WhatsApp):/.test(l));
  assert.deepEqual(labels, ['Wi-Fi: join "Versus Booth"', `WhatsApp: message ${rawConfig().orgName}`]);
  assert.ok(!r.stdout.includes('secret-pass-1'));
  assert.ok(r.stdout.includes('\u2580') || r.stdout.includes('\u2584'), 'QR blocks were drawn');
});

test('qr writes only the Wi-Fi and WhatsApp images', { skip: !hasQrcode && 'run npm install' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'qr-'));
  try {
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify(rawConfig({ laptopIp: '100.64.0.2' })));
    const out = join(dir, 'out');
    const r = spawnSync(process.execPath, [SCRIPT, '--config', config, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(out).sort(), ['whatsapp.png', 'whatsapp.svg', 'wifi.png', 'wifi.svg']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
