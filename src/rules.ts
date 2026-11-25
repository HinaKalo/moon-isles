export const RULES_VERSION = 1;
export const MAX_ROUNDS = 5;
export const CARGO_LIMIT = 2;
export const STATIONS = ['north', 'outer', 'east', 'south'] as const;
export type Station = typeof STATIONS[number];
export type Location = 'port' | Station;

export const LOCATIONS = {
  port: { name: '月灯港', exits: ['north', 'east'] },
  north: { name: '北礁', exits: ['port', 'east', 'outer'] },
  east: { name: '东岬', exits: ['port', 'north', 'south'] },
  outer: { name: '外海台', exits: ['north', 'south'] },
  south: { name: '南湾', exits: ['east', 'outer'] },
} satisfies Record<Location, { name: string; exits: Location[] }>;

export const ROLES = [
  { name: '领航员', action: 'sail', description: '每轮首次移动免费' },
  { name: '补给员', action: 'load', description: '每轮首次装货免费' },
  { name: '工匠', action: 'light', description: '每轮首次点灯免费' },
  { name: '守塔员', action: 'guard', description: '每轮首次布防免费' },
] as const;

type Cargo = { wood: number; iron: number };
type Contribution = { delivered: Cargo; lit: Station[]; blocked: number };
type Sailor = { name: string; location: Location; cargo: Cargo; points: number; usedRole: boolean; contribution: Contribution };
type Beacon = { cargo: Cargo; lit: boolean; guard: number | null };

export type Action =
  | { type: 'sail'; to: Location }
  | ({ type: 'load' | 'deliver' } & Cargo)
  | { type: 'light' | 'guard' | 'pass' };

export type Outcome = 'all-lit' | 'ship-lost' | 'deadline';
export type Result = {
  rulesVersion: number;
  reason: Outcome;
  round: number;
  integrity: number;
  targets: Station[];
  lit: Station[];
  score: { beacons: number; integrity: number; defenses: number; speed: number; total: number };
  players: (Contribution & { name: string })[];
};

export type GameState = {
  round: number;
  integrity: number;
  blocked: number;
  targets: Station[];
  stations: Record<Station, Beacon>;
  forecast: Station[][];
  players: Sailor[];
  log: { round: number; text: string }[];
  result: Result | null;
};

function emptyCargo(): Cargo {
  return { wood: 0, iron: 0 };
}

function beacon(): Beacon {
  return { cargo: emptyCargo(), lit: false, guard: null };
}

export function createState(names: string[], stormOrder: Station[]): GameState {
  const targets = STATIONS.slice(0, names.length);
  const wind = (index: number) => stormOrder[index % stormOrder.length];
  return {
    round: 1, integrity: 3, blocked: 0, targets,
    stations: { north: beacon(), east: beacon(), outer: beacon(), south: beacon() },
    forecast: [[], [wind(0)], [wind(1)], [wind(2)], [wind(3), wind(4)]],
    players: names.map((name) => ({
      name, location: 'port', cargo: emptyCargo(), points: 2, usedRole: false,
      contribution: { delivered: emptyCargo(), lit: [], blocked: 0 },
    })),
    log: [], result: null,
  };
}

export function actionCost(game: GameState, seat: number, action: Action): number {
  return action.type === 'pass' || (!game.players[seat].usedRole && ROLES[seat].action === action.type) ? 0 : 1;
}

export function legalActions(game: GameState, seat: number): Action[] {
  const player = game.players[seat];
  if (!player || player.points === 0 || game.result) return [];
  const actions: Action[] = LOCATIONS[player.location].exits.map((to) => ({ type: 'sail', to }));
  const { wood, iron } = player.cargo;
  if (player.location === 'port') {
    const capacity = CARGO_LIMIT - wood - iron;
    for (let addWood = 0; addWood <= capacity; addWood++) {
      for (let addIron = 0; addIron <= capacity - addWood; addIron++) {
        if (addWood + addIron) actions.push({ type: 'load', wood: addWood, iron: addIron });
      }
    }
  } else if (game.targets.includes(player.location)) {
    const site = game.stations[player.location];
    const canWood = wood > 0 && site.cargo.wood === 0;
    const canIron = iron > 0 && site.cargo.iron === 0;
    if (canWood) actions.push({ type: 'deliver', wood: 1, iron: 0 });
    if (canIron) actions.push({ type: 'deliver', wood: 0, iron: 1 });
    if (canWood && canIron) actions.push({ type: 'deliver', wood: 1, iron: 1 });
    if (!site.lit && site.cargo.wood === 1 && site.cargo.iron === 1) actions.push({ type: 'light' });
    if (site.guard === null && game.forecast[game.round - 1].includes(player.location)) actions.push({ type: 'guard' });
  }
  actions.push({ type: 'pass' });
  return actions;
}

export function cargoLabel(cargo: Cargo): string {
  return [cargo.wood ? `木材 ×${cargo.wood}` : '', cargo.iron ? `铁件 ×${cargo.iron}` : ''].filter(Boolean).join('、') || '空舱';
}

export function actionLabel(action: Action): string {
  switch (action.type) {
    case 'sail': return `航行至${LOCATIONS[action.to].name}`;
    case 'load': return `装载${cargoLabel(action)}`;
    case 'deliver': return `交付${cargoLabel(action)}`;
    case 'light': return '点亮信标';
    case 'guard': return '设置风暴防护';
    case 'pass': return '结束回合';
  }
}

export function applyAction(game: GameState, seat: number, input: unknown): number | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as { type?: string; to?: unknown; wood?: unknown; iron?: unknown };
  const action = legalActions(game, seat).find((option) => {
    if (option.type !== candidate.type) return false;
    if (option.type === 'sail') return option.to === candidate.to;
    if (option.type === 'load' || option.type === 'deliver') return option.wood === candidate.wood && option.iron === candidate.iron;
    return true;
  });
  if (!action) return null;

  const player = game.players[seat];
  const cost = actionCost(game, seat, action);
  const location = player.location;
  const station = location === 'port' ? null : game.stations[location];
  player.points -= cost;
  if (action.type === 'pass') player.points = 0;
  else if (cost === 0) player.usedRole = true;

  if (action.type === 'sail') player.location = action.to;
  if (action.type === 'load') {
    player.cargo.wood += action.wood;
    player.cargo.iron += action.iron;
  }
  if (action.type === 'deliver' && station) {
    player.cargo.wood -= action.wood;
    player.cargo.iron -= action.iron;
    station.cargo.wood += action.wood;
    station.cargo.iron += action.iron;
    player.contribution.delivered.wood += action.wood;
    player.contribution.delivered.iron += action.iron;
  }
  if (action.type === 'light' && station && location !== 'port') {
    station.lit = true;
    player.contribution.lit.push(location);
  }
  if (action.type === 'guard' && station) station.guard = seat;
  const place = action.type === 'sail' || action.type === 'pass' ? '' : `在${LOCATIONS[location].name}`;
  game.log.push({ round: game.round, text: `${player.name}${place}${actionLabel(action)}` });
  return cost;
}

export function endRound(game: GameState): void {
  if (game.result) return;
  for (const site of game.forecast[game.round - 1]) {
    const { guard } = game.stations[site];
    if (guard === null) {
      game.integrity = Math.max(0, game.integrity - 1);
      game.log.push({ round: game.round, text: `${LOCATIONS[site].name}遭遇风暴，船体完整度 −1` });
    } else {
      game.blocked++;
      game.players[guard].contribution.blocked++;
      game.log.push({ round: game.round, text: `${game.players[guard].name}在${LOCATIONS[site].name}抵挡了风暴` });
    }
  }
  for (const site of STATIONS) game.stations[site].guard = null;

  const lit = game.targets.filter((site) => game.stations[site].lit);
  let reason: Outcome | undefined;
  if (!game.integrity) reason = 'ship-lost';
  else if (lit.length === game.targets.length) reason = 'all-lit';
  else if (game.round === MAX_ROUNDS) reason = 'deadline';

  if (!reason) {
    game.round++;
    for (const player of game.players) {
      player.points = 2;
      player.usedRole = false;
    }
    return;
  }
  const beacons = lit.length * 20;
  const integrity = game.integrity * 5;
  const defenses = game.blocked * 2;
  const speed = reason === 'all-lit' ? (MAX_ROUNDS - game.round) * 5 : 0;
  game.result = {
    rulesVersion: RULES_VERSION, reason, round: game.round, integrity: game.integrity,
    targets: [...game.targets], lit,
    score: { beacons, integrity, defenses, speed, total: beacons + integrity + defenses + speed },
    players: game.players.map(({ name, contribution }) => ({
      name, delivered: { ...contribution.delivered }, lit: [...contribution.lit], blocked: contribution.blocked,
    })),
  };
}
