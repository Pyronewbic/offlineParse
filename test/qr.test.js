import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('qr:show prints Wi-Fi, Register and WhatsApp codes in order, without the Wi-Fi password', { skip: !hasQrcode && 'run npm install' }, () => {
  const r = runTerminal({ laptopIp: '100.64.0.2' });
  assert.equal(r.status, 0, r.stderr);
  const labels = r.stdout.split('\n').filter((l) => /^(Wi-Fi|Register|WhatsApp):/.test(l));
  assert.deepEqual(labels, ['Wi-Fi: join "Versus Booth"', 'Register: open http://100.64.0.2/ after joining the Wi-Fi',
    `WhatsApp: message ${rawConfig().orgName}`]);
  assert.ok(!r.stdout.includes('secret-pass-1'));
  assert.ok(r.stdout.includes('\u2580') || r.stdout.includes('\u2584'), 'QR blocks were drawn');
});

test('without a fixed booth address there is no Register code to print', { skip: !hasQrcode && 'run npm install' }, () => {
  const r = runTerminal({ laptopIp: 'en0' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('Register:'));
  assert.match(r.stdout, /Wi-Fi: join/);
});
