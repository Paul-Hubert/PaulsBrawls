// The aim solver on the main thread, over one bot's own world and entities (docs/37 P3). With the defaults
// (workers.count 0, world.enabled false) there is no job pool and no shared world: aim/draw.ts then solves each update
// here, synchronously, with the same code the `aim` job runs (aim/solve.mjs).
//   • The world: a reader over mineflayer's `bot.world` (prismarine-world's sync API, `getColumn` + the column's
//     `getBlockStateId`, no prismarine Block), with the shared world's per-state tables (world/tables.mjs), built
//     once per Minecraft version. A column the bot does not have reads -1 (unknown), as in the shared world.
//   • The entities: the bot's `entities` in the entity snapshot's row layout (jobs/entities.mjs), team 0: the
//     shooter's friends come in the input's `friends` (the order's isFriend players).

import { createRequire } from 'node:module';

import { COL, HEADER, HEADER_LENGTH, STRIDE, kindCode } from '../jobs/entities.mjs';
import { StateTables } from '../world/reader.mjs';
import { buildStateTables } from '../world/tables.mjs';
import type { AimEntities, AimWorld } from './solve.mjs';

const require = createRequire(import.meta.url);

/** The per-state tables by Minecraft version (null: this version's registry could not be read). */
const tablesByVersion = new Map<string, StateTables | null>();

function statesFor(version: unknown): StateTables | null {
  if (typeof version !== 'string' || !version) return null;
  let t = tablesByVersion.get(version);
  if (t === undefined) {
    try {
      const registry = require('prismarine-registry')(version) as unknown;
      t = new StateTables(buildStateTables(registry));
    } catch {
      t = null;
    }
    tablesByVersion.set(version, t);
  }
  return t;
}

interface ColumnLike {
  getBlockStateId(p: { x: number; y: number; z: number }): number;
}

/** What is read of a mineflayer bot. */
export interface InlineBot {
  version?: string;
  world?: unknown;
  entities?: Record<string, unknown> | null;
}

/** A reader over the bot's own world, or null when it has none the solver can read (a fake, no registry). */
export function botWorld(bot: InlineBot): AimWorld | null {
  const w = bot.world as
    | { getColumn?: (cx: number, cz: number) => ColumnLike | null | undefined; stateIdAt?: (x: number, y: number, z: number) => number }
    | undefined;
  if (typeof w?.getColumn !== 'function') return null;
  const states = statesFor(bot.version);
  if (!states) return null;
  // world.shared (docs/37 P5): the bot's world reads the store; its own stateIdAt is -1 where the bot has no column.
  if (typeof w.stateIdAt === 'function') {
    const stateIdAt = w.stateIdAt.bind(w);
    return { dimIndex: () => 0, stateIdIn: (_d: number, x: number, y: number, z: number) => stateIdAt(x, y, z), states: states as unknown as AimWorld['states'] };
  }
  const getColumn = w.getColumn.bind(w);
  let lastX = Number.NaN;
  let lastZ = Number.NaN;
  let last: ColumnLike | null = null;
  const at = { x: 0, y: 0, z: 0 };
  return {
    dimIndex: () => 0,
    stateIdIn(_d: number, x: number, y: number, z: number): number {
      const cx = x >> 4;
      const cz = z >> 4;
      if (cx !== lastX || cz !== lastZ) {
        last = getColumn(cx, cz) ?? null;
        lastX = cx;
        lastZ = cz;
      }
      if (!last) return -1;
      at.x = x & 15;
      at.y = y;
      at.z = z & 15;
      return last.getBlockStateId(at);
    },
    states: states as unknown as AimWorld['states'],
  };
}

interface EntityLike {
  id?: number;
  type?: string;
  position?: { x: number; y: number; z: number } | null;
  width?: number;
  height?: number;
  isValid?: boolean;
}

/** The bot's entities as snapshot rows (velocity 0, team 0). */
export function botEntities(bot: InlineBot): AimEntities {
  const ents = bot.entities ?? {};
  const keys = Object.keys(ents);
  const data = new Float64Array(HEADER_LENGTH + keys.length * STRIDE);
  let n = 0;
  for (const k of keys) {
    const e = ents[k] as EntityLike | undefined;
    const p = e?.position;
    if (!e || !p || typeof e.id !== 'number' || e.isValid === false) continue;
    const kind = kindCode(e.type);
    // Only creatures and armor stands can stop an arrow (items, orbs, arrows cannot).
    if (kind < 1 || kind > 8) continue;
    const o = HEADER_LENGTH + n * STRIDE;
    data[o + COL.ID] = e.id;
    data[o + COL.TYPE] = -1;
    data[o + COL.KIND] = kind;
    data[o + COL.X] = p.x;
    data[o + COL.Y] = p.y;
    data[o + COL.Z] = p.z;
    data[o + COL.WIDTH] = typeof e.width === 'number' ? e.width : 0.6;
    data[o + COL.HEIGHT] = typeof e.height === 'number' ? e.height : 1.8;
    data[o + COL.TEAM] = 0;
    n++;
  }
  data[HEADER.COUNT] = n;
  return { data, count: n };
}
