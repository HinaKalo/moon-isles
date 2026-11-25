import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { moonIsles } from '../src/game.ts';
import type { Action } from '../src/rules.ts';

const require = createRequire(import.meta.url);
const { CreateGameReducer, InitializeGame } = require('boardgame.io/internal') as typeof import('boardgame.io/dist/types/packages/internal.js');

for (const count of [2, 3, 4]) {
  test(`${count} players win via ordinary framework moves and the round-end hook`, () => {
    const names = ['Ada', 'Bao', 'Cai', 'Dan'].slice(0, count);
    const game = { ...moonIsles, seed: 'route-test' };
    const reducer = CreateGameReducer({ game });
    let state = InitializeGame({ game, numPlayers: count, setupData: { names } });
    function act(seat: number, action: Action) {
      assert.equal(state.ctx.currentPlayer, String(seat));
      const version = state._stateID;
      state = reducer(state, { type: 'MAKE_MOVE', payload: { type: 'act', playerID: String(seat), args: [action] } });
      assert.equal(state._stateID, version + 1, JSON.stringify(action));
    }
    const load: Action = { type: 'load', wood: 1, iron: 1 };
    const deliver: Action = { type: 'deliver', wood: 1, iron: 1 };
    act(0, load);
    act(0, { type: 'sail', to: 'north' });
    act(0, deliver);
    act(1, load);
    act(1, { type: 'sail', to: 'north' });
    act(1, { type: 'light' });
    for (let seat = 2; seat < count; seat++) {
      act(seat, load);
      act(seat, { type: 'sail', to: 'east' });
    }
    assert.equal(state.G.round, 2);
    act(0, { type: 'sail', to: 'outer' });
    act(0, { type: 'pass' });
    act(1, { type: 'sail', to: 'outer' });
    act(1, deliver);
    if (count >= 3) {
      act(2, deliver);
      act(2, { type: 'light' });
      act(2, { type: 'pass' });
    }
    if (count === 4) {
      act(3, { type: 'sail', to: 'south' });
      act(3, deliver);
    }
    assert.equal(state.G.round, 3);
    act(0, { type: 'light' });
    act(0, { type: 'pass' });
    act(1, { type: 'pass' });
    if (count >= 3) act(2, { type: 'pass' });
    if (count === 4) {
      act(3, { type: 'light' });
      act(3, { type: 'pass' });
    }
    assert.equal(state.ctx.gameover.reason, 'all-lit');
    assert.equal(state.G.result.lit.length, count);
    assert.equal(state.G.result.round, 3);
    assert.equal(state.G.result.score.beacons, count * 20);
  });
}
