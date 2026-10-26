import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, createServer } from 'node:net';
import { explainPortError, rivalAddresses, startDnsOn, startRefusers } from '../src/dnsbind.js';

const failing = (code) => Object.assign(new Error(code), { code });

test('binds the booth address itself when allowed', async () => {
  const calls = [];
  const result = await startDnsOn('192.168.0.2', 53, async (opts) => (calls.push(opts.host), 'sock'));
  assert.deepEqual(result, { sock: 'sock', host: '192.168.0.2' });
  assert.deepEqual(calls, ['192.168.0.2']);
});

test('falls back to all addresses only when the OS refuses the specific bind (macOS EACCES)', async () => {
  const calls = [];
  const start = async ({ host }) => {
    calls.push(host);
    if (host !== '0.0.0.0') throw failing('EACCES');
    return 'wild';
  };
  assert.deepEqual(await startDnsOn('192.168.0.2', 53, start, null, 'darwin'), { sock: 'wild', host: '0.0.0.0' });
  assert.deepEqual(calls, ['192.168.0.2', '0.0.0.0']);
});

test('other bind errors are not papered over', async () => {
  for (const code of ['EADDRINUSE', 'EADDRNOTAVAIL']) {
    const calls = [];
    await assert.rejects(startDnsOn('192.168.0.2', 53, async ({ host }) => {
      calls.push(host);
      throw failing(code);
    }), (e) => e.code === code);
    assert.deepEqual(calls, ['192.168.0.2'], `${code}: no wildcard retry`);
  }
  await assert.rejects(startDnsOn('192.168.0.2', 53, async () => {
    throw failing('EACCES');
  }), (e) => e.code === 'EACCES', 'a refused wildcard bind is reported, not swallowed');
});

test('outside macOS, EACCES is explained instead of retried on all addresses', async () => {
  for (const [platform, hint] of [['win32', /UDP port 53 is already used by another program.*netstat -ano -p UDP \| findstr :53.*Mobile Hotspot/],
    ['linux', /UDP port 53 needs root or the setcap command/]]) {
    const calls = [];
    await assert.rejects(startDnsOn('100.64.0.2', 53, async ({ host }) => {
      calls.push(host);
      throw failing('EACCES');
    }, null, platform), (e) => e.code === 'EACCES' && hint.test(e.message), platform);
    assert.deepEqual(calls, ['100.64.0.2'], `${platform}: no wildcard retry`);
  }
});

test('explainPortError names the next step per platform and leaves other errors alone', () => {
  const inUse = failing('EADDRINUSE');
  assert.match(explainPortError(inUse, 80, 'TCP', 'win32').message, /TCP port 80 .*findstr :80.*PID 4 is IIS/);
  assert.match(explainPortError(inUse, 53, 'UDP', 'darwin').message, /already used .*sudo lsof -nP -i UDP:53/);
  assert.equal(explainPortError(inUse, 53, 'UDP', 'darwin').cause, inUse);
  assert.equal(explainPortError(failing('EACCES'), 53, 'UDP', 'darwin').message, 'EACCES');
  assert.equal(explainPortError(failing('EADDRNOTAVAIL'), 53, 'UDP', 'win32').message, 'EADDRNOTAVAIL');
});

test('real port 53 on this machine: specific refused or allowed, either way DNS ends up listening', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS-specific port rule');
    return;
  }
  const { localAddresses } = await import('../src/netaddr.js');
  const ip = localAddresses().find((a) => a.connected)?.address;
  if (!ip) {
    t.skip('no connected address');
    return;
  }
  let result;
  try {
    result = await startDnsOn(ip, 53);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      t.skip('port 53 already in use (a booth server may be running)');
      return;
    }
    throw e;
  }
  try {
    assert.ok(['0.0.0.0', ip].includes(result.host));
    assert.equal(result.sock.address().port, 53);
  } finally {
    result.sock.close();
  }
});

test('rivalAddresses finds other connected addresses on the booth /24 only', () => {
  const addrs = [
    { address: '192.168.0.2', connected: true }, { address: '192.168.0.101', connected: true },
    { address: '192.168.1.5', connected: true }, { address: '192.168.0.77', connected: false },
  ];
  assert.deepEqual(rivalAddresses('192.168.0.2', addrs).map((a) => a.address), ['192.168.0.101']);
  assert.deepEqual(rivalAddresses('192.168.0.2', [addrs[0]]), []);
});

test('refusers reset every connection at once, and a port that cannot be opened is reported, not fatal', async () => {
  const taken = createServer();
  await new Promise((r) => taken.listen(0, '127.0.0.1', r));
  const busy = taken.address().port;
  const { servers, failed } = await startRefusers([0, busy], '127.0.0.1', 'darwin');
  try {
    assert.equal(servers.length, 1);
    assert.deepEqual(failed.map((f) => f.port), [busy]);
    assert.match(failed[0].message, new RegExp(`TCP port ${busy} is already used by another program`));
    const started = Date.now();
    const outcome = await new Promise((resolvePromise) => {
      // Send nothing: a plain close would then end cleanly, so only a real reset gives ECONNRESET.
      const socket = connect(servers[0].address().port, '127.0.0.1');
      socket.on('data', () => resolvePromise('data'));
      socket.on('error', (e) => resolvePromise(e.code));
      socket.on('close', () => resolvePromise('closed'));
    });
    assert.equal(outcome, 'ECONNRESET', 'reset, not a silent wait');
    assert.ok(Date.now() - started < 1000, 'at once');
  } finally {
    for (const s of servers) s.close();
    taken.close();
  }
});
