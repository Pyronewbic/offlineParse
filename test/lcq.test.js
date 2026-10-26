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
    store.register({ name: `P${n}`, phone: `+9198765${String(n).padStart(5, '0')}`, source: 'form', eventCode: 'E', noticeVersion: 'v', bracket });
  };
  const player = (name) => lcq.state().players.find((p) => p.name === name);
  const id = (name) => player(name).id;
  const openMatch = (name) => lcq.state().open.find((m) => m.aName === name || m.bName === name);
  const win = (name) => lcq.result(openMatch(name).id, id(name));

  beforeEach(() => {
    store = new LeadStore(':memory:');
    lcq = new Lcq(store, { winsToQualify: 3, lossesOut: 2, random: () => 0.99 });
    n = 0;
  });

  test('every 4 LCQ registrations, in sign-up order, make one group; Normal ones never join', () => {
    for (let i = 0; i < 3; i++) signUp();
    signUp('normal');
    assert.equal(lcq.syncGroups(), 0, 'three LCQ players are not a group yet');
    assert.deepEqual(lcq.state().players.map((p) => p.status), ['queued', 'queued', 'queued']);
    for (let i = 0; i < 5; i++) signUp();
    assert.equal(lcq.syncGroups(), 2);
    assert.equal(lcq.syncGroups(), 0, 'no group twice');
    const { groups, players } = lcq.state();
    assert.deepEqual(groups.map((g) => g.seats.map((s) => s.name)), [['P1', 'P2', 'P3', 'P5'], ['P6', 'P7', 'P8', 'P9']]);
    assert.ok(groups.every((g) => !g.seen), 'new groups are unseen until paired or acknowledged');
    assert.equal(players.filter((p) => p.status === 'grouped').length, 8);
  });

  test('a group is split three ways, randomize picks one, and the split is fixed once a result is in', () => {
    for (let i = 0; i < 4; i++) signUp();
    lcq.syncGroups();
    lcq.pairGroup(1, 1);
    assert.deepEqual(lcq.state().open.map((m) => [m.aName, m.bName]), [['P1', 'P3'], ['P2', 'P4']]);
    lcq.randomize(1);
    assert.deepEqual(lcq.state().open.map((m) => [m.aName, m.bName]), [['P1', 'P4'], ['P2', 'P3']], 'replaced, random 0.99 is split 2');
    assert.ok(lcq.state().groups[0].seen);
    win('P1');
    assert.throws(() => lcq.pairGroup(1, 0), LcqError);
    assert.throws(() => lcq.pairGroup(1, 7), LcqError);
  });

  test('free players with the same wins are offered a match, longest waiting first; others wait', () => {
    for (let i = 0; i < 8; i++) signUp();
    lcq.syncGroups();
    lcq.pairGroup(1, 0);
    lcq.pairGroup(2, 0);
    win('P1');
    assert.deepEqual(lcq.state().proposals, [], 'a lone 1W player waits');
    win('P3');
    win('P6');
    win('P8');
    const { proposals } = lcq.state();
    assert.deepEqual(proposals.map((p) => [p.a.name, p.b.name, p.wins]), [['P2', 'P4', 0], ['P5', 'P7', 0], ['P1', 'P3', 1], ['P6', 'P8', 1]]);
    lcq.start(id('P1'), id('P3'));
    assert.equal(player('P1').status, 'playing');
    assert.throws(() => lcq.start(id('P1'), id('P6')), LcqError, 'a playing player cannot start another match');
    assert.throws(() => lcq.start(id('P6'), id('P6')), LcqError);
  });

  test('players qualify at the win target and are out at the loss limit', () => {
    for (let i = 0; i < 4; i++) signUp();
    lcq.syncGroups();
    lcq.pairGroup(1, 0);
    win('P1');
    win('P3');
    lcq.start(id('P1'), id('P3'));
    win('P1');
    lcq.start(id('P2'), id('P4'));
    win('P4');
    assert.equal(player('P2').status, 'out', '2 losses');
    lcq.start(id('P1'), id('P4'));
    assert.throws(() => lcq.start(id('P2'), id('P3')), LcqError, 'an out player is never paired');
    win('P1');
    assert.equal(player('P1').status, 'qualified', '3 wins');
    assert.deepEqual([player('P1').wins, player('P1').losses], [3, 0]);
  });

  test('a result can be undone until either player is in a later match; bad results are refused', () => {
    for (let i = 0; i < 4; i++) signUp();
    lcq.syncGroups();
    lcq.pairGroup(1, 0);
    const first = openMatch('P1');
    assert.throws(() => lcq.result(first.id, id('P3')), LcqError, 'the winner must be in the match');
    win('P1');
    assert.throws(() => lcq.result(first.id, id('P2')), LcqError, 'no second result');
    lcq.undo(first.id);
    assert.equal(player('P1').status, 'playing');
    win('P2');
    win('P3');
    lcq.start(id('P2'), id('P3'));
    assert.throws(() => lcq.undo(first.id), LcqError);
  });

  test('a deleted registration leaves the runner working and keeps no name', () => {
    for (let i = 0; i < 4; i++) signUp();
    lcq.syncGroups();
    store.remove(id('P2'));
    const { groups } = lcq.state();
    assert.deepEqual(groups[0].seats.map((s) => s.name), ['P1', '(deleted)', 'P3', 'P4']);
    lcq.pairGroup(1, 0);
    assert.equal(lcq.state().open[0].bName, '(deleted)');
  });

  test('version changes with each change the tablet must see', () => {
    const seen = new Set([lcq.version()]);
    for (let i = 0; i < 4; i++) signUp();
    seen.add(lcq.version());
    lcq.syncGroups();
    seen.add(lcq.version());
    lcq.pairGroup(1, 0);
    seen.add(lcq.version());
    lcq.pairGroup(1, 1);
    seen.add(lcq.version());
    win('P1');
    seen.add(lcq.version());
    assert.equal(seen.size, 6);
  });

  test('proposals never repeat a pairing and prefer the same losses', () => {
    for (let i = 0; i < 4; i++) signUp();
    lcq.syncGroups();
    lcq.pairGroup(1, 0);
    win('P1');
    win('P3');
    lcq.start(id('P2'), id('P4'));
    win('P2');
    // 1W: P1 (1-0), P3 (1-0), P2 (1-1). P1 and P3 match on losses.
    assert.deepEqual(lcq.state().proposals.map((p) => [p.a.name, p.b.name]), [['P1', 'P3']]);
    lcq.start(id('P1'), id('P3'));
    win('P3');
    // 1W now: P1 (1-1), P2 (1-1). They have played each other, so nothing is proposed.
    assert.deepEqual(lcq.state().proposals, [], 'no rematch');
  });

  test('the last 2 or 3 waiting players can be made a group; in a group of 3 one sits out into the ladder', () => {
    signUp();
    assert.throws(() => lcq.closeGroup(), /at least 2 waiting/, 'one player alone is not a group');
    signUp();
    signUp();
    lcq.closeGroup();
    const [group] = lcq.state().groups;
    assert.equal(group.seats.length, 3);
    lcq.pairGroup(group.id, 2);
    assert.deepEqual(lcq.state().open.map((m) => [m.aName, m.bName]), [['P2', 'P3']]);
    assert.equal(player('P1').status, 'free', 'the one sitting out joins the ladder at 0 wins');
    win('P3');
    assert.deepEqual(lcq.state().proposals.map((p) => [p.a.name, p.b.name, p.wins]), [['P1', 'P2', 0]]);
    assert.throws(() => lcq.closeGroup(), /at least 2 waiting/);
  });

  test('dropping a no-show gives their match to the opponent and takes them out for good', () => {
    for (let i = 0; i < 4; i++) signUp();
    lcq.syncGroups();
    assert.throws(() => lcq.drop(id('P1')), /pair their group first/);
    lcq.pairGroup(1, 0);
    lcq.drop(id('P1'));
    assert.equal(player('P1').status, 'dropped');
    assert.deepEqual([player('P2').wins, player('P2').status], [1, 'free']);
    assert.throws(() => lcq.drop(id('P1')), LcqError);
    win('P3');
    assert.ok(lcq.state().proposals.every((p) => p.a.name !== 'P1' && p.b.name !== 'P1'));
  });
});
