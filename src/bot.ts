import {
  CARGO_LIMIT, LOCATIONS, ROLES, legalActions,
  type Action, type GameState, type Location,
} from './rules.ts';

function route(from: Location, to: Location): { next: Location; distance: number } {
  const queue = [{ at: from, next: from, distance: 0 }];
  const seen = new Set<Location>([from]);
  for (const step of queue) {
    if (step.at === to) return step;
    for (const exit of LOCATIONS[step.at].exits) {
      if (seen.has(exit)) continue;
      seen.add(exit);
      queue.push({ at: exit, next: step.distance ? step.next : exit, distance: step.distance + 1 });
    }
  }
  throw new Error('Disconnected voyage map');
}

export function chooseBotAction(game: GameState, seat: number): Action {
  const actions = legalActions(game, seat);
  const player = game.players[seat];
  let best: Action = { type: 'pass' };
  let bestScore = 0;
  if (!actions.length) return best;
  const from = player.location;
  const forecast = game.forecast[game.round - 1].filter((site) => game.stations[site].guard === null);
  const space = CARGO_LIMIT - player.cargo.wood - player.cargo.iron;
  const free = player.usedRole ? null : ROLES[seat].action;

  function consider(action: Action, score: number) {
    if (score <= bestScore) return;
    const allowed = actions.find((candidate) => {
      if (candidate.type !== action.type) return false;
      if (candidate.type === 'sail') return action.type === 'sail' && candidate.to === action.to;
      if (candidate.type === 'load' || candidate.type === 'deliver') {
        return (action.type === 'load' || action.type === 'deliver') && candidate.wood === action.wood && candidate.iron === action.iron;
      }
      return true;
    });
    if (allowed) {
      best = allowed;
      bestScore = score;
    }
  }

  function headTo(site: Location, action: Action, score: number) {
    const { next, distance } = route(from, site);
    consider(distance ? { type: 'sail', to: next } : action, score - distance * 9);
  }

  for (const site of forecast) {
    const { distance } = route(from, site);
    const bonus = Number(free === 'guard' || (free === 'sail' && distance > 0));
    // With a free guard, the bot needs a point left when it reaches the site.
    const canGuard = distance + 1 - bonus <= player.points && (free !== 'guard' || distance < player.points);
    if (canGuard) headTo(site, { type: 'guard' }, game.integrity <= forecast.length ? 100 : 48);
  }

  for (const site of game.targets) {
    const beacon = game.stations[site];
    if (beacon.lit) continue;
    const needsWood = 1 - beacon.cargo.wood;
    const needsIron = 1 - beacon.cargo.iron;
    if (needsWood + needsIron === 0) {
      headTo(site, { type: 'light' }, 67);
      continue;
    }
    const wood = Math.min(needsWood, player.cargo.wood);
    const iron = Math.min(needsIron, player.cargo.iron);
    if (wood + iron) headTo(site, { type: 'deliver', wood, iron }, 45 + 7 * (wood + iron));

    const addWood = Math.min(needsWood - wood, space);
    const addIron = Math.min(needsIron - iron, space - addWood);
    if (addWood + addIron) {
      headTo('port', { type: 'load', wood: addWood, iron: addIron }, 35 + 8 * (addWood + addIron) - 3 * route('port', site).distance);
    }
  }
  return best;
}
