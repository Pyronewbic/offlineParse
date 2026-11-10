// The LCQ runner: single elimination. A sign-up is free to play at once; free players on the same wins are
// paired, one loss puts you out, until the organiser ends it. Only registration ids are stored here, so deleting
// a registration still erases the person everywhere. The runner shows one game of the current event at a time.
// Groups of 4 (before 2026-11) are gone; their old matches still count.

import { randomInt } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lcq_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, groupId INTEGER, a INTEGER NOT NULL, b INTEGER NOT NULL,
  winner INTEGER, createdAt TEXT NOT NULL, decidedAt TEXT
);
CREATE TABLE IF NOT EXISTS lcq_drops (leadId INTEGER PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lcq_games (
  eventCode TEXT NOT NULL, game TEXT NOT NULL, finalizedAt TEXT, endedAt TEXT, PRIMARY KEY (eventCode, game)
);`;

export class LcqError extends Error {}

/** How many more sign-ups make a full single-elimination bracket (the next power of 2), and its size. */
export function bracketGap(count) {
  let size = 1;
  while (size < count) size *= 2;
  return { size, more: size - count };
}

const now = () => new Date().toISOString();

export class Lcq {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(SCHEMA);
  }

  event() {
    return this.store.currentEvent().code;
  }

  /** This event's LCQ registrations, oldest first; in one game, or every game. */
  leads(game = null) {
    const event = this.event();
    return this.store.list().filter((l) => l.bracket === 'lcq' && l.eventCode === event && (game === null || l.game === game));
  }

  /** Where one game's LCQ is in this event: finalizedAt and endedAt, each null until set. */
  phase(game = '') {
    const row = this.db.prepare('SELECT finalizedAt, endedAt FROM lcq_games WHERE eventCode = ? AND game = ?').get(this.event(), game);
    return { finalizedAt: row?.finalizedAt ?? null, endedAt: row?.endedAt ?? null };
  }

  /** Fix who is in a game's bracket; later sign-ups wait. A bracket short of a power of 2 needs `short` (staff ticked it). */
  finalize(game = '', short = false) {
    if (this.phase(game).finalizedAt) throw new LcqError('This LCQ is already finalized.');
    const count = this.leads(game).length;
    if (!count) throw new LcqError('Nobody has signed up for this LCQ yet.');
    if (bracketGap(count).more && !short) throw new LcqError('Tick that some players will need a Bye, then tap Finalize.');
    this.db.prepare(`INSERT INTO lcq_games (eventCode, game, finalizedAt) VALUES (?, ?, ?)
      ON CONFLICT(eventCode, game) DO UPDATE SET finalizedAt = excluded.finalizedAt`).run(this.event(), game, now());
  }

  /** Let the sign-ups since Finalize into the bracket. */
  unfinalize(game = '') {
    if (!this.phase(game).finalizedAt) throw new LcqError('This LCQ is not finalized.');
    this.db.prepare('UPDATE lcq_games SET finalizedAt = NULL WHERE eventCode = ? AND game = ?').run(this.event(), game);
  }

  /** The games this event's LCQ registrations are in. */
  games() {
    return [...new Set(this.leads().map((l) => l.game))];
  }

  /** Take a player out (a no-show): a match they are in goes to their opponent. */
  drop(leadId) {
    const player = this.state(this.store.get(leadId)?.game ?? '').players.find((p) => p.id === leadId);
    if (!player || !['free', 'playing'].includes(player.status)) {
      throw new LcqError('Only a player who is playing or waiting for a match can be dropped.');
    }
    const open = this.db.prepare('SELECT * FROM lcq_matches WHERE winner IS NULL AND (a = ? OR b = ?)').get(leadId, leadId);
    if (open) this.db.prepare('UPDATE lcq_matches SET winner = ?, decidedAt = ? WHERE id = ?').run(open.a === leadId ? open.b : open.a, now(), open.id);
    this.db.prepare('INSERT INTO lcq_drops (leadId, at) VALUES (?, ?)').run(leadId, now());
  }

  /** Changes whenever anything the runner shows changes, so the tablet knows when to reload. */
  version() {
    const n = (sql) => Object.values(this.db.prepare(sql).get())[0] ?? 0;
    return [
      this.event(), n("SELECT COUNT(*) FROM leads WHERE bracket = 'lcq'"),
      n('SELECT MAX(id) FROM lcq_matches'), n('SELECT COUNT(*) FROM lcq_matches'),
      n('SELECT COUNT(*) FROM lcq_matches WHERE winner IS NOT NULL'), n('SELECT COUNT(*) FROM lcq_drops'),
      n("SELECT group_concat(coalesce(finalizedAt, '') || '/' || coalesce(endedAt, '')) FROM lcq_games"),
    ].join('-');
  }

  /** Everything the runner page shows for one game, derived from registrations and matches. */
  state(game = '') {
    const phase = this.phase(game);
    const all = this.leads(game);
    // Once finalized, the bracket is who signed up before; the rest are counted, not played. Sign-up times are
    // to the second, so one in the same second as Finalize is in.
    const cutoff = phase.finalizedAt && Date.parse(phase.finalizedAt);
    const inBracket = (l) => !cutoff || Date.parse(l.createdAt) <= cutoff;
    const leads = new Map(all.filter(inBracket).map((l) => [l.id, l]));
    // Leads are per event and game, so a match of theirs is one of this game in this event.
    const matches = this.db.prepare('SELECT * FROM lcq_matches ORDER BY id').all().map((m) => ({ ...m }))
      .filter((m) => leads.has(m.a) || leads.has(m.b));
    const dropped = new Set(this.db.prepare('SELECT leadId FROM lcq_drops').all().map((r) => r.leadId));
    const players = [...leads.values()].map((l) => {
      const mine = matches.filter((m) => m.a === l.id || m.b === l.id);
      const decided = mine.filter((m) => m.winner !== null);
      const wins = decided.filter((m) => m.winner === l.id).length;
      const losses = decided.length - wins;
      const status = dropped.has(l.id) ? 'dropped'
        : losses ? 'out'
        : mine.some((m) => m.winner === null) ? 'playing'
        : 'free';
      const freeSince = decided.map((m) => m.decidedAt).sort().at(-1) ?? l.createdAt;
      return { id: l.id, name: l.name, phone: l.phone, wins, losses, status, freeSince };
    });
    const byId = new Map(players.map((p) => [p.id, p]));
    const name = (id) => byId.get(id)?.name ?? '(deleted)';
    // Same wins only, longest-waiting first. Two free players have never met: one of them would have lost.
    const free = players.filter((p) => p.status === 'free').sort((x, y) => x.freeSince.localeCompare(y.freeSince) || x.id - y.id);
    const proposals = [];
    for (const wins of [...new Set(free.map((p) => p.wins))].sort((x, y) => x - y)) {
      const pool = free.filter((p) => p.wins === wins);
      for (let i = 0; i + 1 < pool.length; i += 2) proposals.push({ a: pool[i], b: pool[i + 1], wins });
    }
    // A Bye is for the one player left on their wins once nobody can still reach them: the bracket is
    // finalized, nobody else in play is on fewer wins or free on the same, and they are not the last one in.
    const inPlay = players.filter((p) => p.status === 'free' || p.status === 'playing');
    const bye = (phase.finalizedAt && inPlay.length > 1 && free.find((p) =>
      !inPlay.some((q) => q !== p && (q.wins < p.wins || (q.status === 'free' && q.wins === p.wins))))) || null;
    const label = (m) => ({ ...m, aName: name(m.a), bName: name(m.b) });
    return {
      ...phase, late: all.length - leads.size, players, proposals, bye,
      open: matches.filter((m) => m.winner === null).map(label),
      decided: matches.filter((m) => m.winner !== null).reverse().map(label),
    };
  }

  match(id) {
    const m = this.db.prepare('SELECT * FROM lcq_matches WHERE id = ?').get(id);
    if (!m) throw new LcqError('That match is gone; reload the page.');
    return m;
  }

  /** Start a match between two free players (a proposal, or the operator's own pick). */
  start(a, b) {
    const [la, lb] = [this.store.get(a), this.store.get(b)];
    if (la && lb && la.game !== lb.game) throw new LcqError('Those two are in different games.');
    const players = new Map(this.state(la?.game ?? '').players.map((p) => [p.id, p]));
    if (a === b || players.get(a)?.status !== 'free' || players.get(b)?.status !== 'free') {
      throw new LcqError('Both players must be free (finished their last match and not out).');
    }
    this.db.prepare('INSERT INTO lcq_matches (a, b, createdAt) VALUES (?, ?, ?)').run(a, b, now());
  }

  /** One win without a match, for the player state() offers a Bye to. Stored as a match against themselves. */
  bye(leadId) {
    if (this.state(this.store.get(leadId)?.game ?? '').bye?.id !== leadId) {
      throw new LcqError('A Bye is only for the one player left on their wins, once the LCQ is finalized and nobody can catch up.');
    }
    const at = now();
    this.db.prepare('INSERT INTO lcq_matches (a, b, winner, createdAt, decidedAt) VALUES (?, ?, ?, ?, ?)').run(leadId, leadId, leadId, at, at);
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
      const what = w === l ? `${this.nameOf(w)} had a bye` : `${this.nameOf(w)} beat ${this.nameOf(l)}`;
      throw new LcqError(`Undo "${what}" first; it came after this result.`);
    }
    this.db.exec('BEGIN');
    try {
      for (const x of later) this.db.prepare('DELETE FROM lcq_matches WHERE id = ?').run(x.id);
      // A bye has no match to go back to.
      if (m.a === m.b) this.db.prepare('DELETE FROM lcq_matches WHERE id = ?').run(matchId);
      else this.db.prepare('UPDATE lcq_matches SET winner = NULL, decidedAt = NULL WHERE id = ?').run(matchId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return later.map((x) => `${this.nameOf(x.a)} vs ${this.nameOf(x.b)}`);
  }

  /** Call off a match that has no result yet (started by mistake); both players are free again. */
  cancel(matchId) {
    const m = this.match(matchId);
    if (m.winner !== null) throw new LcqError('That match already has a result; use Undo.');
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

}
