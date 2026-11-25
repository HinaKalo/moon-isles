import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseBotAction } from '../src/bot.ts';
import { applyAction, createState, legalActions, STATIONS, type GameState } from '../src/rules.ts';

function setup(count = 2): GameState {
  return createState(['玩家', '雾帆', '星砂', '归潮'].slice(0, count), STATIONS.slice(0, count));
}

test('the supply bot loads a pair and completes the delivery on its first turn', () => {
  const game = setup();
  assert.deepEqual(chooseBotAction(game, 1), { type: 'load', wood: 1, iron: 1 });
  assert.equal(applyAction(game, 1, chooseBotAction(game, 1)), 0);
  assert.deepEqual(chooseBotAction(game, 1), { type: 'sail', to: 'north' });
  assert.equal(applyAction(game, 1, chooseBotAction(game, 1)), 1);
  assert.deepEqual(chooseBotAction(game, 1), { type: 'deliver', wood: 1, iron: 1 });
  assert.equal(applyAction(game, 1, chooseBotAction(game, 1)), 1);
  assert.deepEqual(game.stations.north.cargo, { wood: 1, iron: 1 });
});

test('a bot prevents certain hull loss before lighting a ready beacon', () => {
  const game = setup();
  game.round = 2;
  game.integrity = 1;
  game.stations.north.cargo = { wood: 1, iron: 1 };
  game.players[1].location = 'north';
  assert.deepEqual(chooseBotAction(game, 1), { type: 'guard' });
  applyAction(game, 1, { type: 'guard' });
  assert.deepEqual(chooseBotAction(game, 1), { type: 'light' });
});

test('a bot skips unreachable emergency work and always chooses from legal actions', () => {
  const game = setup(4);
  game.round = 2;
  game.integrity = 1;
  game.forecast[1] = ['outer'];
  game.stations.east.cargo = { wood: 1, iron: 1 };
  game.players[2].location = 'east';
  game.players[2].points = 1;
  const move = chooseBotAction(game, 2);
  assert.deepEqual(move, { type: 'light' });
  assert.ok(legalActions(game, 2).some((action) => JSON.stringify(action) === JSON.stringify(move)));
});
