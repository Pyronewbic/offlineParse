import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { Lcq, LcqError } from '../src/lcq.js';
import { LeadStore } from '../src/leads.js';

describe('LCQ runner', () => {
  let store;
  let lcq;
  let n;
  const signUp = (bracket = 'lcq') => {
    n++;
    store.register({ name: `P${n}`, phone: `+9198765${String(n).padStart(5, '0')}`, source: 'form', noticeVersion: 'v', bracket });
  };
  const player = (name) => lcq.state().players.find((p) => p.name === name);
  const id = (name) => player(name).id;
  const openMatch = (name) => lcq.state().open.find((m) => m.aName === name || m.bName === name);
  const win = (name) => lcq.result(openMatch(name).id, id(name));
  const play = (a, b) => lcq.start(id(a), id(b));
  const pairs = () => lcq.state().proposals.map((p) => [p.a.name, p.b.name, p.wins]);
  // Sign-up times are to the second: move everyone so far, and Finalize, into the past.
  const backdate = () => store.db.exec(`UPDATE leads SET createdAt = '2026-01-01T00:00:00Z';
    UPDATE lcq_games SET finalizedAt = '2026-01-01T00:00:00.500Z' WHERE finalizedAt IS NOT NULL`);

  beforeEach(() => {
    store = new LeadStore(':memory:');
    lcq = new Lcq(store);
    n = 0;
  });

  test('a sign-up can play at once: 0W players are offered in sign-up order; Normal ones never join', () => {
    signUp();
    assert.deepEqual(pairs(), [], 'one player alone waits');
    signUp('normal');
    signUp();
    signUp();
    assert.deepEqual(lcq.state().players.map((p) => [p.name, p.status]), [['P1', 'free'], ['P3', 'free'], ['P4', 'free']]);
    assert.deepEqual(pairs(), [['P1', 'P3', 0]], 'the odd one out waits for the next sign-up');
    signUp();
    assert.deepEqual(pairs(), [['P1', 'P3', 0], ['P4', 'P5', 0]]);
  });

  test('one loss and you are out; only winners on the same wins are offered, longest waiting first', () => {
    for (let i = 0; i < 4; i++) signUp();
    play('P1', 'P2');
    play('P3', 'P4');
    assert.equal(player('P1').status, 'playing');
    assert.throws(() => play('P1', 'P3'), LcqError, 'a playing player cannot start another match');
    win('P1');
    assert.deepEqual([player('P2').status, player('P2').losses], ['out', 1], 'one loss is out');
    assert.deepEqual(pairs(), [], 'a lone 1W player waits');
    assert.throws(() => play('P2', 'P1'), LcqError, 'an out player is never paired');
    win('P4');
    assert.deepEqual(pairs(), [['P1', 'P4', 1]]);
    play('P1', 'P4');
    win('P4');
    assert.deepEqual([player('P4').wins, player('P4').status], [2, 'free']);
    assert.throws(() => play('P4', 'P4'), LcqError);
  });

  test('a late sign-up plays their own way up', () => {
    for (let i = 0; i < 2; i++) signUp();
    play('P1', 'P2');
    win('P1');
    signUp();
    signUp();
    assert.deepEqual(pairs(), [['P3', 'P4', 0]], 'the 1W player is not offered against 0W');
  });

  test('undo calls off later matches that have no result yet, and names a later result that must go first', () => {
    for (let i = 0; i < 4; i++) signUp();
    play('P1', 'P2');
    play('P3', 'P4');
    const first = openMatch('P1');
    assert.throws(() => lcq.result(first.id, id('P3')), LcqError, 'the winner must be in the match');
    win('P1');
    assert.throws(() => lcq.result(first.id, id('P2')), LcqError, 'no second result');
    win('P3');
    play('P1', 'P3');
    assert.deepEqual(lcq.undo(first.id).cancelled, ['P1 vs P3'], 'the match paired on the wrong record is called off');
    assert.equal(player('P1').status, 'playing', 'P1 is back in the undone match');
    assert.equal(player('P2').status, 'playing', 'and so is the player who had lost it');
    assert.equal(player('P3').status, 'free');

    win('P1');
    play('P1', 'P3');
    win('P3');
    assert.throws(() => lcq.undo(first.id), /Undo "P3 beat P1" first/);
    assert.equal(lcq.undo(lcq.state().decided[0].id).back, null, 'nobody was dropped, nobody comes back');
  });

  test('a match started by mistake can be called off; a decided one cannot', () => {
    for (let i = 0; i < 2; i++) signUp();
    play('P1', 'P2');
    assert.throws(() => lcq.undo(openMatch('P1').id), /no result yet/);
    lcq.cancel(openMatch('P1').id);
    assert.deepEqual([player('P1').status, player('P2').status], ['free', 'free']);
    play('P1', 'P2');
    win('P1');
    assert.throws(() => lcq.cancel(lcq.state().decided[0].id), /already has a result/);
  });

  test('a deleted registration leaves the runner working and keeps no name', () => {
    for (let i = 0; i < 2; i++) signUp();
    play('P1', 'P2');
    store.remove(id('P2'));
    assert.equal(lcq.state().open[0].bName, '(deleted)');
    win('P1');
    assert.equal(player('P1').wins, 1);
  });

  test('version changes with each change the tablet must see', () => {
    const seen = new Set([lcq.version()]);
    for (let i = 0; i < 2; i++) signUp();
    seen.add(lcq.version());
    play('P1', 'P2');
    seen.add(lcq.version());
    win('P1');
    seen.add(lcq.version());
    signUp();
    seen.add(lcq.version());
    lcq.drop(id('P3'));
    seen.add(lcq.version());
    assert.equal(seen.size, 6);
  });

  test('dropping a no-show gives their match to the opponent and takes them out for good', () => {
    for (let i = 0; i < 4; i++) signUp();
    play('P1', 'P2');
    lcq.drop(id('P1'));
    assert.equal(player('P1').status, 'dropped');
    assert.deepEqual([player('P2').wins, player('P2').status], [1, 'free']);
    assert.throws(() => lcq.drop(id('P1')), LcqError);
    lcq.drop(id('P3'));
    assert.equal(player('P3').status, 'dropped', 'a free player can be dropped too');
    assert.ok(lcq.state().proposals.every((p) => ![p.a.name, p.b.name].some((x) => x === 'P1' || x === 'P3')));
  });

  test('undoing a drop\'s forfeit takes the drop back, so a dropped player is never in a match again', () => {
    for (let i = 0; i < 4; i++) signUp();
    play('P1', 'P2');
    const forfeit = openMatch('P1');
    lcq.drop(id('P1'));
    lcq.drop(id('P3'));
    const p4 = id('P4');
    store.db.prepare('INSERT INTO lcq_matches (a, b, winner, createdAt, decidedAt) VALUES (?, ?, ?, ?, ?)').run(p4, p4, p4, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    lcq.drop(p4);
    assert.deepEqual(lcq.undo(forfeit.id), { cancelled: [], back: 'P1' });
    assert.deepEqual([player('P1').status, player('P2').status], ['playing', 'playing'], 'P1 is back in the match their drop gave away');
    assert.equal(player('P3').status, 'dropped', 'a drop with no forfeit is not touched');
    assert.deepEqual(lcq.undo(lcq.state().decided.find((m) => m.a === p4).id), { cancelled: [], back: null });
    assert.equal(player('P4').status, 'dropped', 'undoing a bye never brings its player back');
    win('P1');
    assert.deepEqual([player('P1').status, player('P1').wins], ['free', 1]);
  });

  test('a player dropped while waiting can be brought back to wait on their wins again', () => {
    for (let i = 0; i < 4; i++) signUp();
    play('P1', 'P2');
    win('P1');
    lcq.drop(id('P3'));
    assert.throws(() => lcq.undrop(id('P4')), /Only a dropped player/);
    assert.deepEqual(lcq.undrop(id('P3')), { cancelled: [], back: 'P3', bye: null });
    assert.deepEqual([player('P3').status, player('P3').wins], ['free', 0]);
    assert.deepEqual(pairs(), [['P3', 'P4', 0]]);
    play('P3', 'P4');
    lcq.drop(id('P3'));
    assert.deepEqual(lcq.undrop(id('P3')), { cancelled: [], back: 'P3', bye: null }, 'a forfeit is undone like its result');
    assert.deepEqual([player('P3').status, player('P4').status], ['playing', 'playing']);
  });

  test('bringing back a dropped player takes back a Bye given on their wins since, unless its player has a result since', () => {
    const setup = () => {
      store = new LeadStore(':memory:');
      lcq = new Lcq(store);
      n = 0;
      for (let i = 0; i < 4; i++) signUp();
      lcq.finalize();
      play('P1', 'P2');
      win('P1');
      lcq.drop(id('P3'));
      assert.equal(lcq.state().bye?.name, 'P4', 'precondition: alone on 0W, P4 is offered a Bye');
      lcq.bye(id('P4'));
    };
    setup();
    assert.deepEqual(lcq.undrop(id('P3')), { cancelled: [], back: 'P3', bye: 'P4' });
    assert.deepEqual(pairs(), [['P3', 'P4', 0]], 'the two play after all');

    setup();
    play('P4', 'P1');
    assert.deepEqual(lcq.undrop(id('P3')), { cancelled: ['P4 vs P1'], back: 'P3', bye: 'P4' }, 'the match the Bye led to is called off');
    assert.deepEqual([player('P1').status, player('P1').wins], ['free', 1]);

    setup();
    play('P4', 'P1');
    win('P4');
    assert.deepEqual(lcq.undrop(id('P3')), { cancelled: [], back: 'P3', bye: null }, 'a Bye already played on stands');
    assert.deepEqual([player('P4').wins, player('P3').status], [2, 'free']);

    setup();
    store.db.exec("UPDATE lcq_matches SET createdAt = '2000-01-01T00:00:00.000Z' WHERE a = b");
    assert.equal(lcq.undrop(id('P3')).bye, null, 'a Bye from before the drop was not because of it');

    setup();
    lcq.end('', true);
    assert.throws(() => lcq.undrop(id('P3')), LcqError, 'not once ended');
  });

  test('matches from before single elimination, made in groups of 4, still count', () => {
    for (let i = 0; i < 4; i++) signUp();
    const [p1, p2, p3, p4] = ['P1', 'P2', 'P3', 'P4'].map(id);
    store.db.prepare('INSERT INTO lcq_matches (groupId, a, b, winner, createdAt, decidedAt) VALUES (1, ?, ?, ?, ?, ?), (1, ?, ?, NULL, ?, NULL)')
      .run(p1, p2, p1, '2026-10-20T10:00:00Z', '2026-10-20T10:10:00Z', p3, p4, '2026-10-20T10:00:00Z');
    assert.deepEqual(['P1', 'P2', 'P3'].map((x) => [player(x).wins, player(x).status]), [[1, 'free'], [0, 'out'], [0, 'playing']]);
    lcq.cancel(openMatch('P3').id);
    assert.equal(player('P3').status, 'free', 'an old open group match can be called off now');
  });

  test('Finalize fixes the bracket: later sign-ups are counted but not played until Unfinalize', () => {
    assert.throws(() => lcq.finalize(), /Nobody has signed up/);
    for (let i = 0; i < 4; i++) signUp();
    const v = lcq.version();
    lcq.finalize();
    assert.notEqual(lcq.version(), v, 'the tablet sees it');
    assert.throws(() => lcq.finalize(), /already finalized/);
    assert.equal(lcq.state().players.length, 4, 'a sign-up in the same second as Finalize is in');
    backdate();
    signUp();
    signUp();
    const st = lcq.state();
    assert.equal(st.players.length, 4);
    assert.equal(st.late, 2);
    assert.ok(st.finalizedAt);
    assert.deepEqual(pairs(), [['P1', 'P2', 0], ['P3', 'P4', 0]], 'the late two are not offered');
    const late = store.list().find((l) => l.name === 'P6');
    assert.throws(() => lcq.start(id('P1'), late.id), LcqError, 'nor can they be started by hand');
    const v2 = lcq.version();
    lcq.unfinalize();
    assert.notEqual(lcq.version(), v2);
    assert.deepEqual([lcq.state().players.length, lcq.state().late, lcq.state().finalizedAt], [6, 0, null]);
    assert.deepEqual(pairs().at(-1), ['P5', 'P6', 0], 'they join at 0W');
    assert.throws(() => lcq.unfinalize(), /not finalized/);
  });

  test('a bracket short of a power of 2 is finalized only with the tick; each game and event has its own', () => {
    for (let i = 0; i < 3; i++) signUp();
    assert.throws(() => lcq.finalize(''), /Tick that some players will need a Bye/);
    assert.equal(lcq.phase('').finalizedAt, null, 'refused means not finalized');
    lcq.finalize('', true);
    assert.ok(lcq.phase('').finalizedAt);
    assert.equal(lcq.phase('SSBU').finalizedAt, null, 'another game is open');
    store.startEvent('November');
    assert.equal(lcq.phase('').finalizedAt, null, 'a new event starts open');
  });

  test('a Bye goes to the one player left on their wins once nobody can catch up, and Undo takes it back', () => {
    for (let i = 0; i < 3; i++) signUp();
    play('P1', 'P2');
    assert.equal(lcq.state().bye, null, 'not before Finalize: someone may still sign up');
    assert.throws(() => lcq.bye(id('P3')), /only for the one player left/);
    lcq.finalize('', true);
    assert.equal(lcq.state().bye.name, 'P3', 'P1 and P2 play on 0W, so only one of them reaches 1W; P3 can never meet them on 0W');
    win('P1');
    assert.equal(lcq.state().bye.name, 'P3', 'still alone on 0W, with nobody below');
    assert.throws(() => lcq.bye(id('P1')), LcqError, 'P3 is below P1 and could still catch up');
    lcq.bye(id('P3'));
    assert.deepEqual([player('P3').wins, player('P3').losses, player('P3').status], [1, 0, 'free']);
    assert.equal(lcq.state().decided[0].aName, 'P3');
    assert.deepEqual(pairs(), [['P1', 'P3', 1]], 'the bye brings P3 level with P1');
    assert.equal(lcq.state().bye, null, 'two on 1W play each other');
    play('P1', 'P3');
    win('P1');
    assert.equal(lcq.state().bye, null, 'the last one in gets no Bye');
    assert.throws(() => lcq.bye(id('P1')), LcqError);

    const byeMatch = lcq.state().decided.find((m) => m.a === m.b);
    assert.throws(() => lcq.undo(byeMatch.id), /Undo "P1 beat P3" first/);
    lcq.undo(lcq.state().decided[0].id);
    assert.deepEqual(lcq.undo(byeMatch.id).cancelled, ['P1 vs P3'], 'the match the bye led to is called off');
    assert.deepEqual([player('P3').wins, player('P3').status], [0, 'free']);
    assert.ok(!lcq.state().decided.some((m) => m.a === m.b) && !lcq.state().open.some((m) => m.a === m.b), 'an undone bye is gone, not left open');
  });

  test('a later bye must be undone first, and says so', () => {
    for (let i = 0; i < 5; i++) signUp();
    lcq.finalize('', true);
    play('P1', 'P2');
    play('P3', 'P4');
    win('P1');
    win('P3');
    lcq.bye(id('P5'));
    const first = lcq.state().decided[0];
    play('P1', 'P3');
    win('P1');
    lcq.bye(id('P5'));
    assert.deepEqual([player('P5').wins, pairs()], [2, [['P1', 'P5', 2]]], 'two byes take P5 to the final');
    assert.throws(() => lcq.undo(first.id), /Undo "P5 had a bye" first/);
  });

  test('no Bye while someone else is free on the same wins', () => {
    for (let i = 0; i < 2; i++) signUp();
    lcq.finalize();
    assert.equal(lcq.state().bye, null, 'two free on 0W should play');
    assert.throws(() => lcq.bye(id('P1')), LcqError);
  });

  test('End: only once finalized and no match is on, with a tick if players are still in; then nothing changes until Reopen', () => {
    for (let i = 0; i < 4; i++) signUp();
    assert.throws(() => lcq.end(), /Finalize this LCQ before ending it/);
    lcq.finalize();
    play('P1', 'P2');
    assert.throws(() => lcq.end('', true), /A match is still on/);
    win('P1');
    assert.throws(() => lcq.end(), /Tick that the players still in will not play again/, 'P1, P3 and P4 are still in');
    assert.equal(lcq.phase().endedAt, null);
    const v = lcq.version();
    lcq.end('', true);
    assert.ok(lcq.phase().endedAt, 'positive control: ended with the tick');
    assert.notEqual(lcq.version(), v);
    assert.throws(() => lcq.end('', true), /already ended/);
    const ended = /This LCQ has ended; Reopen it/;
    assert.throws(() => play('P3', 'P4'), ended);
    assert.throws(() => lcq.undo(lcq.state().decided[0].id), ended);
    assert.throws(() => lcq.result(lcq.state().decided[0].id, id('P1')), ended);
    assert.throws(() => lcq.drop(id('P3')), ended);
    assert.throws(() => lcq.unfinalize(), ended);
    assert.deepEqual(lcq.state().winners.map((p) => p.name), ['P1'], 'the most wins');

    assert.throws(() => lcq.reopen(), /Tick that this LCQ ended by mistake/);
    lcq.reopen('', true);
    assert.equal(lcq.phase().endedAt, null);
    assert.ok(lcq.phase().finalizedAt, 'back to finalized');
    play('P3', 'P4');
    assert.equal(lcq.state().open.length, 1, 'changes work again');
    assert.throws(() => lcq.reopen('', true), /has not ended/);
  });

  test('End needs no tick with one player left; a tie on the most wins is shared; other games play on', () => {
    for (let i = 0; i < 2; i++) signUp();
    store.register({ name: 'S1', phone: '+919000000001', source: 'form', noticeVersion: 'v', bracket: 'lcq', game: 'SSBU' });
    store.register({ name: 'S2', phone: '+919000000002', source: 'form', noticeVersion: 'v', bracket: 'lcq', game: 'SSBU' });
    lcq.finalize();
    assert.deepEqual(lcq.state().winners.map((p) => p.name), ['P1', 'P2'], 'nobody has played: a tie on 0W');
    play('P1', 'P2');
    win('P2');
    lcq.end();
    assert.deepEqual(lcq.state().winners.map((p) => p.name), ['P2']);
    const [a, b] = lcq.state('SSBU').players;
    lcq.start(a.id, b.id);
    assert.equal(lcq.state('SSBU').open.length, 1, 'SSBU is not ended');
  });

  test('rounds group matches by the wins they were entered on, in order, with late sign-ups and byes where they belong', () => {
    for (let i = 0; i < 5; i++) signUp();
    lcq.finalize('', true);
    play('P1', 'P2');
    play('P3', 'P4');
    win('P1');
    win('P3');
    lcq.bye(id('P5'));
    play('P1', 'P3');
    const names = () => lcq.state().rounds.map((r) => r.map((m) => (m.a === m.b ? `${m.aName} bye` : `${m.aName}-${m.bName}`)));
    assert.deepEqual(names(), [['P1-P2', 'P3-P4', 'P5 bye'], ['P1-P3']], 'the bye is P5\'s first round; the open match is in round 2');
    win('P3');
    lcq.bye(id('P5'));
    assert.deepEqual(names(), [['P1-P2', 'P3-P4', 'P5 bye'], ['P1-P3', 'P5 bye']]);
    play('P3', 'P5');
    assert.deepEqual(names().at(-1), ['P3-P5'], 'the final is round 3');
    lcq.unfinalize();
    signUp();
    signUp();
    play('P6', 'P7');
    assert.deepEqual(names()[0], ['P1-P2', 'P3-P4', 'P5 bye', 'P6-P7'], 'late sign-ups play in round 1, after the others');
    win('P7');
    lcq.cancel(openMatch('P3').id);
    assert.deepEqual([player('P7').wins, player('P3').wins], [1, 2], 'precondition');
    play('P7', 'P3');
    assert.deepEqual(names()[2], ['P7-P3'], 'P7 (1W) picked first against P3 (2W) by hand: the round of the one further along');
  });
});
