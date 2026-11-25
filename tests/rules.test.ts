import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, createState, endRound, STATIONS, type GameState } from '../src/rules.ts';

function setup(count = 2) {
  return createState(['Ada', 'Bao', 'Cai', 'Dan'].slice(0, count), STATIONS.slice(0, count));
}

test('role actions are free once per round and illegal delivery leaves state intact', () => {
  const game = setup();
  assert.equal(applyAction(game, 0, { type: 'load', wood: 2, iron: 1 }), null);
  assert.equal(applyAction(game, 0, { type: 'load', wood: 2, iron: 0 }), 1);
  assert.equal(applyAction(game, 0, { type: 'sail', to: 'north' }), 0);
  const before = structuredClone(game);
  assert.equal(applyAction(game, 0, { type: 'deliver', wood: 2, iron: 0 }), null);
  assert.deepEqual(game, before);
  assert.equal(applyAction(game, 0, { type: 'deliver', wood: 1, iron: 0 }), 1);
  assert.equal(applyAction(game, 0, { type: 'deliver', wood: 1, iron: 0 }), null);
  assert.equal(applyAction(game, 0, { type: 'sail', to: 'north' }), null);
  const other = game.players[1];
  other.location = 'north';
  other.cargo.wood = 1;
  assert.equal(applyAction(game, 1, { type: 'deliver', wood: 1, iron: 0 }), null);
});

function readyFinal(game: GameState) {
  game.round = 5;
  for (const site of game.targets) game.stations[site].lit = true;
}

test('final-round completion wins after surviving both strikes with exact score and contributions', () => {
  const game = setup(4);
  readyFinal(game);
  const [first] = game.forecast[4];
  game.players[3].location = first;
  assert.equal(applyAction(game, 3, { type: 'guard' }), 0);
  assert.equal(applyAction(game, 3, { type: 'guard' }), null);
  endRound(game);
  assert.equal(game.result?.reason, 'all-lit');
  assert.deepEqual(game.result?.score, { beacons: 80, integrity: 10, defenses: 2, speed: 0, total: 92 });
  assert.equal(game.result?.players[3].blocked, 1);
  const result = structuredClone(game.result);
  endRound(game);
  assert.deepEqual(game.result, result);
});

test('destruction takes priority over lighting all beacons and the deadline', () => {
  const game = setup();
  readyFinal(game);
  game.integrity = 1;
  endRound(game);
  assert.equal(game.result?.reason, 'ship-lost');
  assert.equal(game.result?.integrity, 0);
  assert.equal(game.result?.score.total, 40);
});

test('deadline fails while surviving and early victory earns the speed bonus', () => {
  const late = setup();
  late.round = 5;
  endRound(late);
  assert.equal(late.result?.reason, 'deadline');
  const early = setup();
  for (const site of early.targets) early.stations[site].lit = true;
  endRound(early);
  assert.equal(early.result?.score.speed, 20);
});
