import test from 'node:test';
import assert from 'node:assert/strict';
import { games, defaultConfig, validateConfig } from '../dist/arcade-catalog.js';
import { playMove, projectGame } from '../server/arcade-engine.js';
const players = ['Ada', 'Bea', 'Cy'].map((username, i) => ({
  id: 'p' + i,
  username,
  seat: i,
  stats: { calls: 12, savedCalls: 6, mobileOrders: 2, internet: 4 },
}));
const snapshot = (kind) => ({
  game: { id: 'game', status: 'live', kind },
  kind,
  rules: defaultConfig(kind),
  world: {},
  secret: 'private-seed',
  revision: 0,
  players: structuredClone(players),
  host: 'host',
  members: [],
  leaders: [],
  me: null,
});
for (const g of games)
  test(g.name + ' projects scoped views and accepts only legal player moves', () => {
    const s = snapshot(g.id);
    assert.deepEqual(validateConfig(g.id, defaultConfig(g.id)), defaultConfig(g.id));
    const host = projectGame(s, 'host'),
      agent = projectGame(s, 'p0');
    assert.equal(host.game.kind, g.id);
    assert.ok(!JSON.stringify(agent).includes('private-seed'));
    assert.deepEqual(agent.members, []);
    assert.equal(playMove(s, 'p0', 'made-up'), null);
    if (g.id !== 'bingo') {
      assert.equal(host.members.length, 3);
      assert.deepEqual(host.scene.actions, []);
      assert.equal(agent.me.username, 'Ada');
      assert.equal(playMove(s, 'host', agent.scene.actions[0]?.key), null);
      for (const action of agent.scene.actions) assert.ok(playMove(structuredClone(s), 'p0', action.key));
    }
  });
test('contracts start at draft time and cannot pay twice', () => {
  const s = snapshot('mission');
  playMove(s, 'p0', 'take0');
  assert.equal(playMove(s, 'p0', 'stamp0'), null);
  s.players[0].stats.savedCalls += 2;
  playMove(s, 'p0', 'stamp0');
  assert.equal(projectGame(s, 'p0').me.points, 1);
  assert.equal(playMove(s, 'p0', 'stamp0'), null);
});
test('secret dial stays private until the other players finish guessing', () => {
  const s = snapshot('wavelength');
  playMove(s, 'p0', 'dial5');
  playMove(s, 'p0', 'hint1');
  assert.ok(!projectGame(s, 'p1').scene.cells.some((c) => c.label === 'Secret dial'));
  playMove(s, 'p1', 'tune5');
  assert.equal(projectGame(s, 'p1').me.points, 0);
  playMove(s, 'p2', 'tune4');
  assert.deepEqual(projectGame(s, 'host').winners, ['Bea']);
});
test('every Bingo winner is visible to all participants even when more than three tie', () => {
  const s = snapshot('bingo');
  s.bingoWinners = ['A', 'B', 'C', 'D'];
  assert.deepEqual(projectGame(s, 'p0').winners, ['A', 'B', 'C', 'D']);
});
