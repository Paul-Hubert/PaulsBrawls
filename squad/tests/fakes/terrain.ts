// Real 1.21.1 terrain for the block-search tests and benchmark (docs/37 P6): prismarine-chunk columns built like a
// forest (deepslate, stone with ores, dirt and grass, a pond, oak and birch trees with leaves), and a bot that runs
// MINEFLAYER'S OWN blocks plugin over a packet stream, so `bot.findBlocks` is the real one. A map_chunk packet reaches
// both the plugin (the bot's own world) and anything else listening to `_client`, such as SharedWorld.attach.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { Vec3 } from 'vec3';

const require = createRequire(import.meta.url);

export const VERSION = '1.21.1';
export const OVERWORLD = 'minecraft:overworld';
export const registry = require('prismarine-registry')(VERSION) as any;
const Chunk = require('prismarine-chunk')(registry) as any;
const injectBlocks = require('mineflayer/lib/plugins/blocks') as (bot: unknown, opts: Record<string, unknown>) => void;

export const stateOf = (name: string): number => registry.blocksByName[name].defaultState;
export const blockIdOf = (name: string): number => registry.blocksByName[name].id;

/** A small deterministic PRNG (mulberry32), so a column is the same every run. */
export function prng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ground level of the forest columns (grass at this y; trees stand on it). */
export const GROUND_Y = 63;

/**
 * A forest column at chunk (cx, cz): deepslate from -64 to -1 (four one-state sections), stone to 58 with coal and
 * iron ores, dirt, grass at 63, a pond in some columns, 0–3 trees (an oak or birch trunk of 4–6 logs, leaves around
 * the top). Sections above are all air. `extra` places more blocks (absolute coordinates).
 */
export function forestColumn(cx: number, cz: number, extra: Array<[number, number, number, number]> = []): any {
  const c = new Chunk({ minY: -64, worldHeight: 384 });
  const rnd = prng(cx * 7919 + cz * 104729 + 13);
  const deepslate = stateOf('deepslate');
  const stone = stateOf('stone');
  const ores = [stateOf('coal_ore'), stateOf('iron_ore'), stateOf('copper_ore')];
  const dirt = stateOf('dirt');
  const grass = stateOf('grass_block');
  const water = stateOf('water');
  const pond = rnd() < 0.25;
  const p = new Vec3(0, 0, 0);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      p.x = x;
      p.z = z;
      for (let y = -64; y < 0; y++) {
        p.y = y;
        c.setBlockStateId(p, deepslate);
      }
      for (let y = 0; y <= 58; y++) {
        p.y = y;
        c.setBlockStateId(p, rnd() < 0.02 ? (ores[Math.floor(rnd() * ores.length)] as number) : stone);
      }
      const inPond = pond && x > 4 && x < 11 && z > 4 && z < 11;
      for (let y = 59; y <= GROUND_Y; y++) {
        p.y = y;
        c.setBlockStateId(p, inPond && y >= 61 ? water : y === GROUND_Y ? grass : dirt);
      }
    }
  }
  const trees = Math.floor(rnd() * 4);
  for (let t = 0; t < trees; t++) {
    const tx = 2 + Math.floor(rnd() * 12);
    const tz = 2 + Math.floor(rnd() * 12);
    const log = stateOf(rnd() < 0.7 ? 'oak_log' : 'birch_log');
    const leaves = stateOf(log === stateOf('oak_log') ? 'oak_leaves' : 'birch_leaves');
    const h = 4 + Math.floor(rnd() * 3);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = h - 2; dy <= h + 1; dy++) {
          const x = tx + dx;
          const z = tz + dz;
          if (x < 0 || x > 15 || z < 0 || z > 15 || Math.abs(dx) + Math.abs(dz) > 3) continue;
          p.x = x;
          p.y = GROUND_Y + dy;
          p.z = z;
          c.setBlockStateId(p, leaves);
        }
      }
    }
    for (let dy = 1; dy <= h; dy++) {
      p.x = tx;
      p.y = GROUND_Y + dy;
      p.z = tz;
      c.setBlockStateId(p, log);
    }
  }
  for (const [x, y, z, s] of extra) {
    if (x >> 4 === cx && z >> 4 === cz) c.setBlockStateId(new Vec3(x & 15, y, z & 15), s);
  }
  return c;
}

/**
 * A bot with mineflayer's real blocks plugin (its findBlocks, blockAt and world) over a fake packet stream. Logged
 * into the overworld; `position` is where findBlocks searches from by default.
 */
export function mineflayerBot(position = new Vec3(0, GROUND_Y + 1, 0), username = 'Bot'): any {
  const bot: any = new EventEmitter();
  bot.setMaxListeners(100);
  bot.username = username;
  bot._client = new EventEmitter();
  bot._client.setMaxListeners(100);
  bot._client.write = () => undefined;
  bot.registry = registry;
  bot.version = VERSION;
  bot.supportFeature = registry.supportFeature;
  bot.game = { minY: -64, height: 384, dimension: 'overworld' };
  bot.entity = { position };
  injectBlocks(bot, { version: VERSION, hideErrors: true });
  return bot;
}

export function loginBot(bot: any, name = OVERWORLD): void {
  bot._client.emit('login', { worldState: { dimension: 0, name } });
}

/** The server sends a column: mineflayer parses it into the bot's world; other listeners get the same bytes. */
export function sendColumn(bot: any, cx: number, cz: number, column: any): void {
  bot._client.emit('map_chunk', { x: cx, z: cz, chunkData: column.dump() });
}

export function unloadColumn(bot: any, cx: number, cz: number): void {
  bot._client.emit('unload_chunk', { chunkX: cx, chunkZ: cz });
}

/** A block change the bot hears (mineflayer applies it to its world; the shared world follows the same packet). */
export function changeBlock(bot: any, x: number, y: number, z: number, stateId: number): void {
  bot._client.emit('block_change', { location: { x, y, z }, type: stateId });
}

/** A forest of (2r + 1)² columns around chunk (0, 0), sent to the bot. `skip(cx, cz)` leaves a column out. */
export function sendForest(bot: any, r: number, skip: (cx: number, cz: number) => boolean = () => false, extra: Array<[number, number, number, number]> = []): number {
  let n = 0;
  for (let cx = -r; cx <= r; cx++) {
    for (let cz = -r; cz <= r; cz++) {
      if (skip(cx, cz)) continue;
      sendColumn(bot, cx, cz, forestColumn(cx, cz, extra));
      n++;
    }
  }
  return n;
}
