import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { excludeFromBackups } from '../src/backup.js';

test('on macOS the data folder is excluded from Time Machine by absolute path, without a shell', () => {
  const calls = [];
  const warning = excludeFromBackups('data', { platform: 'darwin', run: (cmd, args) => (calls.push([cmd, args]), { status: 0 }) });
  assert.equal(warning, null);
  assert.deepEqual(calls, [['tmutil', ['addexclusion', resolve('data')]]]);
});

test('other platforms run nothing', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(excludeFromBackups('data', { platform, run: () => assert.fail('ran a command') }), null);
  }
});

test('a failure is reported, never silently treated as done', () => {
  assert.match(excludeFromBackups('data', { platform: 'darwin', run: () => ({ status: 22, stderr: 'Error (100002) while attempting\nmore' }) }),
    /could not keep .*data out of Time Machine \(Error \(100002\) while attempting\); deleted registrations may stay/);
  assert.match(excludeFromBackups('data', { platform: 'darwin', run: () => ({ error: new Error('spawn tmutil ENOENT') }) }),
    /\(spawn tmutil ENOENT\)/);
  assert.match(excludeFromBackups('data', { platform: 'darwin', run: () => ({ status: 1, stderr: '' }) }), /\(exit 1\)/);
});
