/**
 * The deterministic eval fixture: bot roster constants + world geometry.
 *
 * `eval/village.test.json` (the roster the village process loads) and
 * `eval/world-setup.ts` (the RCON command list that builds the world) must both
 * agree with this file — a unit test (tests/eval-helpers.test.ts) pins the
 * roster JSON against EVAL_BOTS so they cannot drift silently.
 *
 * Geometry: everything happens on two flat platforms built by world-setup at
 * y=63 (ground) regardless of the underlying world:
 *  - the VILLAGE platform around (0, 64, 0) — homes, farm, market, parking row;
 *  - the ARENA platform around (160, 64, 160) — isolation scenarios (S1/S4/S7/S8),
 *    far enough (>100 blocks) that village bots are outside entity-tracking
 *    range ('tiny' view distance ≈ 2 chunks), so guards can't interfere.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FixtureBot {
  name: string;
  role: string;
  home: Vec3;
  workstation?: Vec3;
  chest?: Vec3;
}

/** Mirrors village.example.json's layout, with eval-prefixed usernames that
 *  must never collide with the God avatar (`LLMBot`) or a real player. */
export const EVAL_BOTS: FixtureBot[] = [
  { name: 'EvalMargaux',     role: 'farmer',     home: { x: 10,  y: 64, z: 10 },  workstation: { x: 18,  y: 64, z: 14 },  chest: { x: 11,  y: 64, z: 9 } },
  { name: 'EvalFirmin',      role: 'farmer',     home: { x: 26,  y: 64, z: 8 },   workstation: { x: 30,  y: 64, z: 16 },  chest: { x: 27,  y: 64, z: 7 } },
  { name: 'EvalBrindille',   role: 'lumberjack', home: { x: -8,  y: 64, z: 20 },  workstation: { x: -20, y: 64, z: 30 },  chest: { x: -7,  y: 64, z: 19 } },
  { name: 'EvalCaillou',     role: 'miner',      home: { x: -14, y: 64, z: 2 },   workstation: { x: -22, y: 64, z: -6 },  chest: { x: -13, y: 64, z: 1 } },
  { name: 'EvalEnclume',     role: 'crafter',    home: { x: 4,   y: 64, z: -12 }, workstation: { x: 8,   y: 64, z: -16 }, chest: { x: 5,   y: 64, z: -13 } },
  { name: 'EvalEcu',         role: 'shopkeeper', home: { x: 0,   y: 64, z: 0 },   workstation: { x: 2,   y: 64, z: 4 },   chest: { x: 1,   y: 64, z: -1 } },
  { name: 'EvalRempart',     role: 'guard',      home: { x: 14,  y: 64, z: -4 },  workstation: { x: 16,  y: 64, z: 0 } },
  { name: 'EvalVigie',       role: 'guard',      home: { x: -4,  y: 64, z: -8 },  workstation: { x: -6,  y: 64, z: -4 } },
  { name: 'EvalGoujon',      role: 'fisher',     home: { x: 22,  y: 64, z: 24 },  workstation: { x: 28,  y: 64, z: 30 },  chest: { x: 23,  y: 64, z: 23 } },
  { name: 'EvalBourgmestre', role: 'mayor',      home: { x: 6,   y: 64, z: 6 },   workstation: { x: 6,   y: 64, z: 6 } },
];

export function fixtureBot(name: string): FixtureBot {
  const bot = EVAL_BOTS.find((b) => b.name === name);
  if (!bot) throw new Error(`no fixture bot named '${name}'`);
  return bot;
}

/** Bots seeded with the stock 'night-shelter' reflex (see stock-skills.ts roles
 *  — guards stand watch and the miner is happiest underground, so neither
 *  heads home at dusk; S3 asserts only on these seven). */
export const NIGHT_SHELTER_ROLES: ReadonlySet<string> = new Set([
  'farmer', 'lumberjack', 'fisher', 'shopkeeper', 'crafter', 'mayor',
]);

export const GROUND_Y = 63;
export const STAND_Y = 64;

export const VILLAGE = { minX: -64, minZ: -64, maxX: 63, maxZ: 63 };
export const ARENA = { minX: 128, minZ: 128, maxX: 191, maxZ: 191, center: { x: 160, y: STAND_Y, z: 160 } };

/** Far corner of the village platform — uninvolved bots get parked here,
 *  ~90+ blocks from both the village center and the action spots, i.e. outside
 *  entity-tracking range at 'tiny' view distance. */
export const PARKING = { x: -56, y: STAND_Y, z: -56, spacing: 3 };

/** Where trading pairs are placed (must be within 16 blocks of each other for
 *  start_conversation). */
export const MARKET = {
  a: { x: 0, y: STAND_Y, z: 0 },
  b: { x: 3, y: STAND_Y, z: 0 },
};

/** Farm plot (farmland at GROUND_Y, crops at STAND_Y) around EvalMargaux's
 *  workstation, with a hydrating water block at the center. */
export const FARM = { minX: 14, minZ: 10, maxX: 22, maxZ: 18, water: { x: 18, z: 14 } };

export const WORLD_SPAWN = { x: 0, y: STAND_Y, z: 0 };

/** Every entity the eval summons carries this tag so teardown can sweep it. */
export const TAG_ALL = 'eval';

export const SETTLEMENT_URL = 'http://127.0.0.1:8767';
export const DEFAULT_ADMIN_PORT = 8766;
export const DEFAULT_MOCK_PORT = 8799;
