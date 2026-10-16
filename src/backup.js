import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const runCommand = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

/**
 * Keep the data folder out of Time Machine on macOS, so a guest deleted at the desk does not live on
 * in hourly snapshots. Returns a warning for the operator, or null when done or not applicable.
 */
export function excludeFromBackups(dir, { platform = process.platform, run = runCommand } = {}) {
  if (platform !== 'darwin') return null;
  const path = resolve(dir);
  const r = run('tmutil', ['addexclusion', path]);
  if (!r.error && r.status === 0) return null;
  const why = r.error ? r.error.message : (r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`;
  return `could not keep ${path} out of Time Machine (${why}); deleted registrations may stay in its backups`;
}
