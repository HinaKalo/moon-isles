import type { Game } from 'boardgame.io';
import { applyAction, createState, endRound, STATIONS, type GameState } from './rules.ts';

type Setup = { names: string[] };

export const moonIsles: Game<GameState, Record<string, unknown>, Setup> = {
  name: 'moon-isles',
  minPlayers: 2,
  maxPlayers: 4,
  disableUndo: true,
  events: {
    endTurn: false, pass: false, endPhase: false, setPhase: false, endGame: false,
    endStage: false, setStage: false, setActivePlayers: false,
  },
  validateSetupData(data, count) {
    if (!Array.isArray(data?.names) || data.names.length !== count || !data.names.every((name) => typeof name === 'string')) {
      return 'The room must have a complete roster.';
    }
  },
  setup({ ctx, random }, data) {
    const names = data?.names ?? ctx.playOrder.map((seat) => `旅人 ${Number(seat) + 1}`);
    return createState(names, random!.Shuffle(STATIONS.slice(0, ctx.numPlayers)));
  },
  moves: {
    act: {
      client: false,
      move({ G, ctx, playerID }, action: unknown) {
        if (playerID !== ctx.currentPlayer || applyAction(G, Number(playerID), action) === null) return 'INVALID_MOVE';
      },
    },
  },
  turn: {
    endIf: ({ G, ctx }) => G.players[Number(ctx.currentPlayer)].points === 0,
    onEnd({ G, ctx }) {
      if (ctx.playOrderPos === ctx.playOrder.length - 1) endRound(G);
    },
  },
  endIf: ({ G }) => G.result ? { reason: G.result.reason } : undefined,
};
