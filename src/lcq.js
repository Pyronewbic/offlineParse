// The LCQ runner: LCQ registrations form groups of 4 in sign-up order, each group plays two 1v1 matches,
// then free players with the same number of wins are paired, until they qualify, are out, or are dropped.
// Only registration ids are stored here, so deleting a registration still erases the person everywhere.

import { randomInt } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lcq_groups (id INTEGER PRIMARY KEY, createdAt TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lcq_members (leadId INTEGER PRIMARY KEY, groupId INTEGER NOT NULL, seat INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lcq_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, groupId INTEGER, a INTEGER NOT NULL, b INTEGER NOT NULL,
  winner INTEGER, createdAt TEXT NOT NULL, decidedAt TEXT
);
CREATE TABLE IF NOT EXISTS lcq_drops (leadId INTEGER PRIMARY KEY, at TEXT NOT NULL);`;

// The ways to pair a group's seats: a group of 4 plays two matches; in a closed group of 3 one sits out
// (and joins the ladder at 0 wins); a group of 2 plays one match.
export const splitsFor = (size) => ({
  4: [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]],
  3: [[[0, 1]], [[0, 2]], [[1, 2]]],
  2: [[[0, 1]]],
})[size] ?? [];
const pairKey = (x, y) => (x < y ? `${x}-${y}` : `${y}-${x}`);

export class LcqError extends Error {}

const now = () => new Date().toISOString();

export class Lcq {
  constructor(store, { winsToQualify = 4, lossesOut = 2, random = Math.random } = {}) {
    this.store = store;
    this.db = store.db;
    this.rules = { winsToQualify, lossesOut };
    this.random = random;
    this.db.exec(SCHEMA);
  }

  /** Put every 4 ungrouped LCQ registrations, oldest first, into a new group. Returns how many groups were made. */
  syncGroups() {
    const grouped = new Set(this.db.prepare('SELECT leadId FROM lcq_members').all().map((r) => r.leadId));
    const waiting = this.store.list().filter((l) => l.bracket === 'lcq' && !grouped.has(l.id));
    const made = Math.floor(waiting.length / 4);
    if (!made) return 0;
    this.db.exec('BEGIN');
    try {
      const add = this.db.prepare('INSERT INTO lcq_members (leadId, groupId, seat) VALUES (?, ?, ?)');
      for (let i = 0; i < made * 4; i += 4) {
        const groupId = Number(this.db.prepare('INSERT INTO lcq_groups (createdAt) VALUES (?)').run(now()).lastInsertRowid);
        waiting.slice(i, i + 4).forEach((lead, seat) => add.run(lead.id, groupId, seat));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return made;
  }

  /** Make a group of the last 2 or 3 LCQ registrations still waiting, so stragglers are not stuck. */
  closeGroup() {
    this.syncGroups();
    const queued = this.state().players.filter((p) => p.status === 'queued');
    if (queued.length < 2) throw new LcqError('A group needs at least 2 waiting players.');
    const groupId = Number(this.db.prepare('INSERT INTO lcq_groups (createdAt, seen) VALUES (?, 1)').run(now()).lastInsertRowid);
    const add = this.db.prepare('INSERT INTO lcq_members (leadId, groupId, seat) VALUES (?, ?, ?)');
    queued.forEach((p, seat) => add.run(p.id, groupId, seat));
  }

  /** Take a player out (a no-show): a match they are in goes to their opponent. */
  drop(leadId) {
    const player = this.state().players.find((p) => p.id === leadId);
    if (!player || !['free', 'playing'].includes(player.status)) {
      throw new LcqError('Only a player who is playing or waiting for a match can be dropped (pair their group first).');
    }
    const open = this.db.prepare('SELECT * FROM lcq_matches WHERE winner IS NULL AND (a = ? OR b = ?)').get(leadId, leadId);
    if (open) this.db.prepare('UPDATE lcq_matches SET winner = ?, decidedAt = ? WHERE id = ?').run(open.a === leadId ? open.b : open.a, now(), open.id);
    this.db.prepare('INSERT INTO lcq_drops (leadId, at) VALUES (?, ?)').run(leadId, now());
  }

  /** Changes whenever anything the runner shows changes, so the tablet knows when to reload. */
  version() {
    const n = (sql) => Object.values(this.db.prepare(sql).get())[0] ?? 0;
    return [
      n("SELECT COUNT(*) FROM leads WHERE bracket = 'lcq'"), n('SELECT COUNT(*) FROM lcq_groups'),
      n('SELECT MAX(id) FROM lcq_matches'), n('SELECT COUNT(*) FROM lcq_matches'),
      n('SELECT COUNT(*) FROM lcq_matches WHERE winner IS NOT NULL'), n('SELECT COUNT(*) FROM lcq_groups WHERE seen = 0'),
      n('SELECT COUNT(*) FROM lcq_drops'),
    ].join('-');
  }

  /** Everything the runner page shows, derived from registrations, groups and matches. */
  state() {
    const leads = new Map(this.store.list().filter((l) => l.bracket === 'lcq').map((l) => [l.id, l]));
    const members = this.db.prepare('SELECT leadId, groupId, seat FROM lcq_members ORDER BY groupId, seat').all();
    const matches = this.db.prepare('SELECT * FROM lcq_matches ORDER BY id').all().map((m) => ({ ...m }));
    const groupOf = new Map(members.map((m) => [m.leadId, m.groupId]));
    const dropped = new Set(this.db.prepare('SELECT leadId FROM lcq_drops').all().map((r) => r.leadId));
    // When each group was paired: a member left out of the pairing (a group of 3) is free from then.
    const pairedAt = new Map();
    for (const m of matches) if (m.groupId !== null && !pairedAt.has(m.groupId)) pairedAt.set(m.groupId, m.createdAt);
    const players = [...leads.values()].map((l) => {
      const mine = matches.filter((m) => m.a === l.id || m.b === l.id);
      const decided = mine.filter((m) => m.winner !== null);
      const wins = decided.filter((m) => m.winner === l.id).length;
      const losses = decided.length - wins;
      const open = mine.some((m) => m.winner === null);
      const groupPaired = pairedAt.get(groupOf.get(l.id));
      const status = dropped.has(l.id) ? 'dropped'
        : wins >= this.rules.winsToQualify ? 'qualified'
        : losses >= this.rules.lossesOut ? 'out'
        : open ? 'playing'
        : !groupOf.has(l.id) ? 'queued'
        : decided.length === 0 && !groupPaired ? 'grouped'
        : 'free';
      const freeSince = decided.map((m) => m.decidedAt).sort().at(-1) ?? groupPaired ?? null;
      return { id: l.id, name: l.name, wins, losses, status, groupId: groupOf.get(l.id) ?? null, freeSince };
    });
    const byId = new Map(players.map((p) => [p.id, p]));
    const name = (id) => byId.get(id)?.name ?? '(deleted)';
    const groups = this.db.prepare('SELECT * FROM lcq_groups ORDER BY id').all().map((g) => ({
      id: g.id, seen: g.seen === 1, createdAt: g.createdAt,
      seats: members.filter((m) => m.groupId === g.id).map((m) => ({ id: m.leadId, name: name(m.leadId) })),
      paired: matches.some((m) => m.groupId === g.id),
      started: matches.some((m) => m.groupId === g.id && m.winner !== null),
    }));
    // Same win count only, longest-waiting first; never a rematch, and the same losses where possible.
    const played = new Set(matches.map((m) => pairKey(m.a, m.b)));
    const free = players.filter((p) => p.status === 'free').sort((x, y) => x.freeSince.localeCompare(y.freeSince) || x.id - y.id);
    const proposals = [];
    for (const wins of [...new Set(free.map((p) => p.wins))].sort((x, y) => x - y)) {
      const pool = free.filter((p) => p.wins === wins);
      while (pool.length > 1) {
        const a = pool.shift();
        const fresh = pool.filter((q) => !played.has(pairKey(a.id, q.id)));
        const b = fresh.find((q) => q.losses === a.losses) ?? fresh[0];
        if (b) proposals.push({ a, b: pool.splice(pool.indexOf(b), 1)[0], wins });
      }
    }
    const label = (m) => ({ ...m, aName: name(m.a), bName: name(m.b) });
    return {
      rules: this.rules, players, groups, proposals,
      open: matches.filter((m) => m.winner === null).map(label),
      decided: matches.filter((m) => m.winner !== null).reverse().map(label),
    };
  }

  match(id) {
    const m = this.db.prepare('SELECT * FROM lcq_matches WHERE id = ?').get(id);
    if (!m) throw new LcqError('That match is gone; reload the page.');
    return m;
  }

  /** Pair a group (one of splitsFor its size), replacing an earlier pairing if no result is in yet. */
  pairGroup(groupId, split) {
    const group = this.state().groups.find((g) => g.id === groupId);
    if (!group) throw new LcqError('That group is gone; reload the page.');
    if (group.started) throw new LcqError('A result is already in for this group, so its pairing is fixed.');
    const choice = splitsFor(group.seats.length)[split];
    if (!choice) throw new LcqError('Pick one of the pairings.');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM lcq_matches WHERE groupId = ?').run(groupId);
      const add = this.db.prepare('INSERT INTO lcq_matches (groupId, a, b, createdAt) VALUES (?, ?, ?, ?)');
      for (const [x, y] of choice) add.run(groupId, group.seats[x].id, group.seats[y].id, now());
      this.db.prepare('UPDATE lcq_groups SET seen = 1 WHERE id = ?').run(groupId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  randomize(groupId) {
    const group = this.state().groups.find((g) => g.id === groupId);
    this.pairGroup(groupId, Math.floor(this.random() * splitsFor(group?.seats.length).length));
  }

  /** Start a match between two free players (a proposal, or the operator's own pick). */
  start(a, b) {
    const players = new Map(this.state().players.map((p) => [p.id, p]));
    if (a === b || players.get(a)?.status !== 'free' || players.get(b)?.status !== 'free') {
      throw new LcqError('Both players must be free (finished their last match, not qualified or out).');
    }
    this.db.prepare('INSERT INTO lcq_matches (a, b, createdAt) VALUES (?, ?, ?)').run(a, b, now());
  }

  result(matchId, winner) {
    const m = this.match(matchId);
    if (m.winner !== null) throw new LcqError('That match already has a result; use Undo to change it.');
    if (winner !== m.a && winner !== m.b) throw new LcqError('The winner must be one of the two players.');
    this.db.prepare('UPDATE lcq_matches SET winner = ?, decidedAt = ? WHERE id = ?').run(winner, now(), matchId);
  }

  /**
   * Take back a result. Later matches of either player that have no result yet were paired on the
   * wrong record, so they are cancelled too; a later match with a result must be undone first.
   * Returns what else was cancelled, for the operator.
   */
  undo(matchId) {
    const m = this.match(matchId);
    if (m.winner === null) throw new LcqError('That match has no result yet.');
    const later = this.db.prepare('SELECT * FROM lcq_matches WHERE id > ? AND (a IN (?, ?) OR b IN (?, ?)) ORDER BY id')
      .all(matchId, m.a, m.b, m.a, m.b);
    const decided = later.find((x) => x.winner !== null);
    if (decided) {
      const [w, l] = decided.winner === decided.a ? [decided.a, decided.b] : [decided.b, decided.a];
      throw new LcqError(`Undo "${this.nameOf(w)} beat ${this.nameOf(l)}" first; it came after this result.`);
    }
    if (later.some((x) => x.groupId !== null)) throw new LcqError('A group match came after this result; change that pairing first.');
    this.db.exec('BEGIN');
    try {
      for (const x of later) this.db.prepare('DELETE FROM lcq_matches WHERE id = ?').run(x.id);
      this.db.prepare('UPDATE lcq_matches SET winner = NULL, decidedAt = NULL WHERE id = ?').run(matchId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return later.map((x) => `${this.nameOf(x.a)} vs ${this.nameOf(x.b)}`);
  }

  /** Call off a ladder match that has no result yet (started by mistake); both players are free again. */
  cancel(matchId) {
    const m = this.match(matchId);
    if (m.winner !== null) throw new LcqError('That match already has a result; use Undo.');
    if (m.groupId !== null) throw new LcqError('A group match is changed with its group pairing.');
    this.db.prepare('DELETE FROM lcq_matches WHERE id = ?').run(matchId);
  }

  nameOf(leadId) {
    return this.store.get(leadId)?.name ?? '(deleted)';
  }

  /** The tablet's 6-digit PIN, made once and kept across restarts. */
  pin() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'lcqPin'").get();
    if (row && /^\d{6}$/.test(row.value)) return row.value;
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('lcqPin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(pin);
    return pin;
  }

  markSeen() {
    this.db.prepare('UPDATE lcq_groups SET seen = 1 WHERE seen = 0').run();
  }
}
