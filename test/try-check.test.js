import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { rawConfig } from './helpers.js';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));
const CHECK = fileURLToPath(new URL('../scripts/try-check.js', import.meta.url));

const freeTcp = () => new Promise((r) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => r(port));
  });
});
const freeUdp = () => new Promise((r) => {
  const probe = createSocket('udp4').bind(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => r(port));
  });
});
const run = (args) => new Promise((r) => {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.once('exit', (code) => r({ code, out }));
});

describe('npm run try:check', () => {
  let dir;
  let server;
  let config;
  let dnsPort;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'try-check-'));
    config = join(dir, 'config.json');
    dnsPort = await freeUdp();
    writeFileSync(config, JSON.stringify(rawConfig({ httpPort: await freeTcp(), laptopIp: '127.0.0.1', games: ['SSBU', 'SF6', 'Avatar Legends'] })));
  });
  afterEach(async () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async (extra) => {
    server = spawn(process.execPath, [MAIN, '--config', config, '--db', join(dir, 'leads.db'), '--quiet', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    server.stdout.on('data', (d) => { out += d; });
    server.stderr.on('data', (d) => { out += d; });
    await new Promise((r, reject) => {
      const poll = setInterval(() => {
        if (out.includes('Append-only log:')) {
          clearInterval(poll);
          r();
        }
      }, 20);
      server.once('exit', () => {
        clearInterval(poll);
        reject(new Error(out));
      });
    });
  };
  const db = () => {
    const d = new DatabaseSync(join(dir, 'leads.db'));
    const rows = d.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
    const bracket = d.prepare("SELECT value FROM settings WHERE key = 'bracket'").get()?.value ?? 'normal';
    d.close();
    return { rows, bracket };
  };

  test('against a practice run every step passes, and it leaves no sign-up and the switch as it was', async () => {
    await start(['--dns-port', String(dnsPort)]);
    const { code, out } = await run([CHECK, '--config', config, '--dns-port', String(dnsPort)]);
    assert.equal(code, 0, out);
    assert.equal((out.match(/^PASS /gm) ?? []).length, 14, out);
    assert.match(out, /PASS a phone signs up for SSBU and SF6/);
    assert.match(out, /PASS the test sign-up is deleted: 2 removed/);
    assert.deepEqual(db(), { rows: 0, bracket: 'normal' });
  });

  test('with no DNS answering it fails and writes nothing, so it never touches a real booth', async () => {
    await start(['--no-dns']);
    const { code, out } = await run([CHECK, '--config', config, '--dns-port', String(dnsPort)]);
    assert.equal(code, 1, out);
    assert.match(out, /FAIL DNS answers captive\.apple\.com/);
    assert.match(out, /PASS iPhone sign-in check is sent to the form/, 'positive control: it reached the server');
    assert.match(out, /SKIP sign-up, desk and tablet/);
    assert.deepEqual(db(), { rows: 0, bracket: 'normal' });
  });

  test('a port that stays open instead of refusing is a failure', async () => {
    await start(['--dns-port', String(dnsPort)]);
    const holder = createServer(() => {}).listen(0, '127.0.0.1');
    await new Promise((r) => holder.once('listening', r));
    try {
      const open = holder.address().port;
      const { code, out } = await run([CHECK, '--config', config, '--dns-port', String(dnsPort), '--refused-ports', String(open)]);
      assert.equal(code, 1, out);
      assert.match(out, new RegExp(`FAIL port ${open} is refused at once, so phones do not wait: the connection stayed open`));
    } finally {
      holder.close();
    }
  });

  test('with nothing running it says how to start it and exits 2, not 1', async () => {
    const { code, out } = await run([CHECK, '--config', config, '--dns-port', String(dnsPort)]);
    assert.equal(code, 2);
    assert.match(out, /Start it with "npm run try" first/);
  });

  test('a bad --dns-port stops the server before it opens anything', async () => {
    const { code, out } = await run([MAIN, '--config', config, '--db', join(dir, 'leads.db'), '--dns-port', '99999']);
    assert.equal(code, 2);
    assert.match(out, /--dns-port must be a whole number 1-65535/);
  });
});
