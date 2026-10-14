import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { detectAddress } from '../src/netaddr.js';
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

describe('entry point', () => {
  let dir;
  let child;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'main-'));
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
    child = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(configOverrides, args = []) {
    const port = await freePort();
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(rawConfig({ httpPort: port, dbPath: join(dir, 'data', 'leads.db'), ...configOverrides })));
    child = spawn(process.execPath, [MAIN, '--config', configPath, '--no-dns', '--quiet', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const outcome = await new Promise((resolvePromise) => {
      const poll = setInterval(() => {
        if (out.includes('Append-only log:')) finish('ready');
      }, 20);
      const finish = (state) => {
        clearInterval(poll);
        resolvePromise(state);
      };
      child.once('exit', (code) => finish(`exit ${code}`));
    });
    return { port, outcome, out: () => out, err: () => err };
  }

  test('serves sign-ups and keeps data files owner-only', async () => {
    const { port, outcome, err } = await start({ laptopIp: '127.0.0.1' });
    assert.equal(outcome, 'ready', err());
    const res = await postForm(port, '/submit', { name: 'Asha', phone: '9876543210', consent: 'yes' });
    assert.equal(res.status, 200, 'positive control: the sign-up went through the real server');
    if (process.platform !== 'win32') {
      for (const file of ['leads.db', 'leads.csv', 'leads.log']) {
        assert.equal(statSync(join(dir, 'data', file)).mode & 0o077, 0, `${file} is owner-only`);
      }
    }
  });

  test('--ip overrides config and a non-local address is refused before anything opens', async () => {
    const { outcome, err } = await start({ laptopIp: '127.0.0.1' }, ['--ip', '203.0.113.7']);
    assert.equal(outcome, 'exit 2');
    assert.match(err(), /203\.0\.113\.7 is not an address of this machine/);
  });

  test('auto picks the same address as detectAddress and prints it', async (t) => {
    let expected;
    try {
      expected = await detectAddress('auto');
    } catch (e) {
      t.skip(`no unambiguous network address on this machine: ${e.message}`);
      return;
    }
    const { outcome, out, err } = await start({ laptopIp: 'auto' });
    assert.equal(outcome, 'ready', err());
    assert.match(out(), new RegExp(`Laptop address: +${expected.ip.replaceAll('.', '\\.')} \\(auto: `));
  });
});
