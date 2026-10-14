import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { postForm, rawConfig } from './helpers.js';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));

function freePort() {
  return new Promise((resolvePromise) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePromise(port));
    });
  });
}

test('the real entry point serves sign-ups and keeps data files owner-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-'));
  const port = await freePort();
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(rawConfig({ laptopIp: '127.0.0.1', httpPort: port, dbPath: join(dir, 'data', 'leads.db') })));
  const child = spawn(process.execPath, [MAIN, '--config', configPath, '--no-dns', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolvePromise, reject) => {
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
        if (out.includes('Append-only log:')) resolvePromise();
      });
      child.stderr.on('data', (d) => reject(new Error(`server stderr: ${d}`)));
      child.once('exit', (code) => reject(new Error(`server exited early with ${code}`)));
    });
    const res = await postForm(port, '/submit', { name: 'Asha', phone: '9876543210', consent: 'yes' });
    assert.equal(res.status, 200, 'positive control: the sign-up went through the real server');
    for (const file of ['leads.db', 'leads.csv', 'leads.log']) {
      assert.equal(statSync(join(dir, 'data', file)).mode & 0o077, 0, `${file} is owner-only`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    rmSync(dir, { recursive: true, force: true });
  }
});
