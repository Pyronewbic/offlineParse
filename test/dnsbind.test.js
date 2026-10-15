import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rivalAddresses, startDnsOn } from '../src/dnsbind.js';

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
  assert.deepEqual(await startDnsOn('192.168.0.2', 53, start), { sock: 'wild', host: '0.0.0.0' });
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
