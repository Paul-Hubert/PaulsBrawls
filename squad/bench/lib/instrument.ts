// Bench-only instrumentation of the shared library modules (one instance serves every bot of the process). It
// wraps, never replaces: the time spent in protocol decoding (protodef), decompression (zlib.unzipSync, which
// minecraft-protocol calls synchronously on the main thread), player physics (prismarine-physics) and A* search
// (mineflayer-pathfinder) is added to process-wide counters.
//
// IMPORT THIS MODULE BEFORE ANYTHING THAT LOADS MINEFLAYER: mineflayer's physics plugin destructures
// `Physics` from prismarine-physics when it loads, so the wrapper has to be in place first.
//
// The pathfinder's look-ahead (lib/physics.js: canStraightLine, canSprintJump, canWalkJump, each simulating ticks
// ahead with the bot's physics, every tick of a moving bot) is timed apart from the bots' own physics.
//
// Since docs/32 B, the library fixes these prototypes measured are patches of node_modules (squad/patches/, applied by
// patch-package at install). What that means for each flag:
//   • --astar-budget is no longer a prototype: bench/load.ts passes it to the runtime's config
//     (pathfinding.astarBudgetMs → the patched AStar.setBudget). The wrapper below only times and counts the slices.
//   • --physics-hoist and --stuck-ticks refuse to start: the code they edit is already changed by the patches.
//   • --mcdata-memo, --cheap-varint, --lookahead-*, --astar-blockcache(-world) still load, but each now stacks on the
//     patched code that does the same thing (a second memo or cache in front of the first), so they measure nothing new.
//
// Bench-only experiments live here, all off unless set:
//   • setThinkOnCompute(true): thinkTimeout counts compute time instead of wall time, so a search is not failed
//     ("Took to long to decide path") because the event loop or the budget kept it waiting.
//   • setLookahead({ cap, memoTicks, blockCache }): the look-ahead simulates at most `cap` ticks (upstream: up to
//     200); a decision for the same next path node is reused for `memoTicks` ticks; the blocks a look-ahead reads are
//     cached for the rest of the bot's physics tick (upstream: a new Block object per lookup).
//   • `--stuck-ticks` on the command line (read here: it must act before the pathfinder loads): a patched copy of
//     mineflayer-pathfinder's index.js is put in the module cache, in which "stuck" (no progress to the next node)
//     means 70 physics ticks instead of 3 500 ms of wall time, so a slow event loop does not throw paths away.
//   • Library hot spots the profiles found (docs/31 §4), each behind its own flag, read here at load:
//       --mcdata-memo     prismarine-physics' PlayerState calls require('minecraft-data')(version) on every physics
//                         tick and every look-ahead tick; minecraft-data re-parses the version string each time
//                         (`new Version`). Memoized by its arguments.
//       --cheap-varint    minecraft-protocol's Splitter reads each packet length with protodef's readVarInt, which
//                         throws a new PartialReadError (with a stack trace) whenever a TCP chunk ends mid-packet:
//                         once per chunk received. The patched read throws one shared error instead.
//       --physics-hoist   the same PlayerState also calls require() twice per construction; under tsx every require
//                         runs tsx's resolve hook (pathToFileURL…), cached or not. Hoisted to the module's top.
//     and setAstarBlockCache(true): mineflayer-pathfinder's Movements.getBlock (every neighbour check of A*) builds a
//     new Block, Biome and block-entity lookup per call (bot.blockAt); the patched one caches it for the bot's tick.

import { createRequire, Module } from 'node:module';
import { performance } from 'node:perf_hooks';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);

// -- source patches (before anything loads these modules): `--stuck-ticks`, `--physics-hoist` --------------------
// Each module is loaded through require (so it is a normal cached CJS module), with its source edited on the way in.

type Edit = [from: string | RegExp, to: string];
const sourcePatches = new Map<string, { flag: string; edits: Edit[]; check: string }>();
export const STUCK_TICKS = process.argv.includes('--stuck-ticks');
if (STUCK_TICKS) {
  sourcePatches.set(require.resolve('mineflayer-pathfinder'), {
    flag: '--stuck-ticks',
    edits: [
      ['let lastNodeTime = performance.now()', 'let __stuckTicks = 0; let lastNodeTime = performance.now()'],
      [/lastNodeTime = performance\.now\(\)/g, 'lastNodeTime = performance.now(); __stuckTicks = 0'],
      ['if (performance.now() - lastNodeTime > 3500) {', 'if (++__stuckTicks > 70) {'],
    ],
    check: '++__stuckTicks > 70',
  });
}
// prismarine-physics' PlayerState does require('minecraft-data')(version) and require('prismarine-nbt') in its
// constructor (every physics tick, every look-ahead): under tsx even a cached require runs its resolve hook.
export const PHYSICS_HOIST = process.argv.includes('--physics-hoist');
if (PHYSICS_HOIST) {
  sourcePatches.set(require.resolve('prismarine-physics'), {
    flag: '--physics-hoist',
    edits: [
      [
        "const Vec3 = require('vec3').Vec3",
        "const Vec3 = require('vec3').Vec3; const __mdLoad = require('minecraft-data'); const __nbt = require('prismarine-nbt'); let __mdV, __mdR; " +
          'function __mcDataFor (v) { if (v !== __mdV || !__mdR) { __mdV = v; __mdR = __mdLoad(v) } return __mdR }',
      ],
      ["const mcData = require('minecraft-data')(bot.version)", 'const mcData = __mcDataFor(bot.version)'],
      ["const nbt = require('prismarine-nbt')", 'const nbt = __nbt'],
    ],
    check: 'const mcData = __mcDataFor(bot.version)',
  });
}
if (sourcePatches.size > 0) {
  const proto = (Module as unknown as { prototype: { _compile(content: string, filename: string): unknown } }).prototype;
  const compileCjs = proto._compile;
  proto._compile = function (content: string, filename: string) {
    const patch = sourcePatches.get(filename);
    if (!patch) return compileCjs.call(this, content, filename);
    let patched = content;
    for (const [from, to] of patch.edits) patched = patched.replace(from as string, to);
    if (!patched.includes(patch.check)) throw new Error(`${patch.flag}: ${filename} changed, the patch no longer applies`);
    return compileCjs.call(this, patched, filename);
  };
  try {
    for (const file of sourcePatches.keys()) require(file);
  } finally {
    proto._compile = compileCjs;
  }
}

export interface Counters {
  decodeMs: number;
  decodePackets: number;
  inflateMs: number;
  inflateCalls: number;
  /** The bots' own physics (one simulation per bot per tick). */
  physicsMs: number;
  physicsCalls: number;
  /** The pathfinder's look-ahead: simulateUntil calls, the ticks they simulated, decisions reused (memo). */
  lookaheadMs: number;
  lookaheadCalls: number;
  lookaheadTicks: number;
  lookaheadMemoHits: number;
  astarMs: number;
  astarCalls: number;
  /** The longest single A* slice (ms) since the last reset. */
  astarMaxSlice: number;
  /** The most A* time spent by all bots inside one 50 ms window (ms) since the last reset. */
  astarMaxWindow: number;
  /** Slices refused by the A* budget (pathfinding.astarBudgetMs, the patched AStar.setBudget). */
  astarStarved: number;
  /** --astar-blockcache: neighbour lookups served from the cache, and built. */
  astarCacheHits: number;
  astarCacheMisses: number;
}

export const counters: Counters = zero();

function zero(): Counters {
  return { decodeMs: 0, decodePackets: 0, inflateMs: 0, inflateCalls: 0, physicsMs: 0, physicsCalls: 0, lookaheadMs: 0, lookaheadCalls: 0, lookaheadTicks: 0, lookaheadMemoHits: 0, astarMs: 0, astarCalls: 0, astarMaxSlice: 0, astarMaxWindow: 0, astarStarved: 0, astarCacheHits: 0, astarCacheMisses: 0 };
}

/** Read and reset the counters. */
export function takeCounters(): Counters {
  const out = { ...counters };
  Object.assign(counters, zero());
  return out;
}

// -- `--mcdata-memo` and `--cheap-varint` (before minecraft-protocol and prismarine-physics load) ------------------

export const MCDATA_MEMO = process.argv.includes('--mcdata-memo');
if (MCDATA_MEMO) {
  const file = require.resolve('minecraft-data');
  const load = require(file) as ((v: unknown, preNetty?: unknown) => unknown) & Record<string, unknown>;
  const memo = new Map<string, unknown>();
  let lastV: unknown;
  let lastP: unknown;
  let lastR: unknown;
  const memoized = Object.assign(function (v: unknown, preNetty?: unknown) {
    if (v === lastV && preNetty === lastP && lastR !== undefined) return lastR;
    const r = memoLoad(v, preNetty);
    lastV = v;
    lastP = preNetty;
    lastR = r;
    return r;
  }, load);
  function memoLoad(v: unknown, preNetty?: unknown): unknown {
    const k = `${String(v)}|${preNetty ? 1 : 0}`;
    if (memo.has(k)) return memo.get(k);
    const r = load(v, preNetty);
    memo.set(k, r);
    return r;
  }
  (require.cache[file] as { exports: unknown }).exports = memoized;
}

export const CHEAP_VARINT = process.argv.includes('--cheap-varint');
if (CHEAP_VARINT) {
  const pd = require('protodef') as { types: { varint: Array<(buffer: Buffer, offset: number) => unknown> }; utils: { PartialReadError: new (m: string) => Error } };
  const readVarInt = pd.types.varint[0] as (buffer: Buffer, offset: number) => unknown;
  const partial = new pd.utils.PartialReadError('Unexpected buffer end while reading VarInt');
  pd.types.varint[0] = function (buffer: Buffer, offset: number) {
    // The whole varint must be in the buffer; if it is not, the shared error (no new stack trace).
    for (let c = offset, k = 0; k < 10; c++, k++) {
      if (c >= buffer.length) throw partial;
      if (!((buffer[c] as number) & 0x80)) break;
    }
    return readVarInt(buffer, offset);
  };
}

// -- protodef: the packet decoder ------------------------------------------------------------------------------

const protodef = require('protodef') as { FullPacketParser: { prototype: { parsePacketBuffer: (b: Buffer) => unknown } } };
const parse = protodef.FullPacketParser.prototype.parsePacketBuffer;
protodef.FullPacketParser.prototype.parsePacketBuffer = function (this: unknown, buffer: Buffer) {
  const t = performance.now();
  try {
    return parse.call(this, buffer);
  } finally {
    counters.decodeMs += performance.now() - t;
    counters.decodePackets++;
  }
};

// -- zlib: minecraft-protocol inflates every compressed packet with unzipSync ------------------------------------

const z = zlib as unknown as { unzipSync: (...a: unknown[]) => unknown };
const unzipSync = z.unzipSync;
z.unzipSync = function (...args: unknown[]) {
  const t = performance.now();
  try {
    return unzipSync.apply(zlib, args);
  } finally {
    counters.inflateMs += performance.now() - t;
    counters.inflateCalls++;
  }
};

// -- prismarine-physics: one simulatePlayer per bot per physics tick ---------------------------------------------

const physicsPkg = require('prismarine-physics') as { Physics: (...a: unknown[]) => { simulatePlayer: (...a: unknown[]) => unknown } };
const PhysicsFactory = physicsPkg.Physics;
physicsPkg.Physics = function (...args: unknown[]) {
  const physics = PhysicsFactory(...args);
  const simulate = physics.simulatePlayer;
  physics.simulatePlayer = (...a: unknown[]) => {
    if (inLookahead) {
      counters.lookaheadTicks++;
      return simulate(...a);
    }
    const t = performance.now();
    try {
      return simulate(...a);
    } finally {
      counters.physicsMs += performance.now() - t;
      counters.physicsCalls++;
    }
  };
  return physics;
};

// -- mineflayer-pathfinder: the look-ahead (lib/physics.js) ------------------------------------------------------

interface LookaheadPhysics {
  bot: { blockAt(p: unknown, extra?: boolean): unknown; on(e: string, f: () => void): unknown };
  world: { getBlock(p: { x: number; y: number; z: number }): unknown };
}
type Method = (this: LookaheadPhysics, ...a: unknown[]) => unknown;
const PFPhysics = require('mineflayer-pathfinder/lib/physics') as { prototype: Record<string, Method> };
const look = { cap: 0, memoTicks: 0, blockCache: false };
let inLookahead = false;

export function setLookahead(o: Partial<typeof look>): void {
  Object.assign(look, o);
}

/** Physics ticks of a bot, counted after the pathfinder's own physicsTick listener (registered first). */
const tickCounts = new WeakMap<object, { n: number }>();
function tickOf(bot: LookaheadPhysics['bot']): number {
  let c = tickCounts.get(bot);
  if (!c) {
    const counter = { n: 0 };
    c = counter;
    tickCounts.set(bot, c);
    bot.on('physicsTick', () => {
      counter.n++;
    });
  }
  return c.n;
}

const blockCaches = new WeakMap<object, { tick: number; map: Map<string, unknown> }>();
function cachedWorld(p: LookaheadPhysics): LookaheadPhysics['world'] {
  const tick = tickOf(p.bot);
  let c = blockCaches.get(p);
  if (!c || c.tick !== tick) {
    c = { tick, map: new Map() };
    blockCaches.set(p, c);
  }
  const cache = c.map;
  return {
    getBlock(pos) {
      const k = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      if (cache.has(k)) return cache.get(k);
      const b = p.bot.blockAt(pos, false);
      cache.set(k, b);
      return b;
    },
  };
}

const simulateUntil = PFPhysics.prototype.simulateUntil as Method;
PFPhysics.prototype.simulateUntil = function (this: LookaheadPhysics, goal: unknown, controller?: unknown, ticks: unknown = 1, state: unknown = null) {
  const n = look.cap > 0 ? Math.min(Number(ticks), look.cap) : ticks;
  const world = this.world;
  if (look.blockCache) this.world = cachedWorld(this);
  const outer = !inLookahead;
  const t = performance.now();
  inLookahead = true;
  try {
    return simulateUntil.call(this, goal, controller, n, state);
  } finally {
    this.world = world;
    if (outer) {
      inLookahead = false;
      counters.lookaheadMs += performance.now() - t;
      counters.lookaheadCalls++;
    }
  }
};

// The per-tick decisions: the same answer for the same next node within `memoTicks` ticks.
const memos = new WeakMap<object, Map<string, { node: unknown; tick: number; result: unknown }>>();
for (const name of ['canStraightLine', 'canSprintJump', 'canWalkJump']) {
  const decide = PFPhysics.prototype[name] as Method;
  PFPhysics.prototype[name] = function (this: LookaheadPhysics, path: unknown, arg?: unknown) {
    const node = (path as unknown[] | undefined)?.[0];
    if (!look.memoTicks || !node) return decide.call(this, path, arg);
    const tick = tickOf(this.bot);
    let m = memos.get(this);
    if (!m) {
      m = new Map();
      memos.set(this, m);
    }
    const key = `${name}|${String(arg)}`;
    const e = m.get(key);
    if (e && e.node === node && tick - e.tick < look.memoTicks) {
      counters.lookaheadMemoHits++;
      return e.result;
    }
    const result = decide.call(this, path, arg);
    m.set(key, { node, tick, result });
    return result;
  };
}

// -- mineflayer-pathfinder: a block cache for A*'s neighbour checks (Movements.getBlock) ---------------------------

interface MovementsLike {
  bot: LookaheadPhysics['bot'];
}
const MovementsProto = (require('mineflayer-pathfinder/lib/movements') as { prototype: Record<string, (this: MovementsLike, ...a: unknown[]) => unknown> }).prototype;
const getBlockOrig = MovementsProto.getBlock as (this: MovementsLike, pos: { x: number; y: number; z: number } | null, dx: number, dy: number, dz: number) => unknown;
/** 'tick': the cache lives for one physics tick. 'world': it lives until the block changes (blockUpdate, chunks). */
let astarBlockCache: false | 'tick' | 'world' = false;
const movementCaches = new WeakMap<object, { tick: number; map: Map<string, unknown> }>();
const MAX_CACHED_BLOCKS = 200_000;

export function setAstarBlockCache(mode: false | 'tick' | 'world'): void {
  astarBlockCache = mode;
}

type BlockEvents = LookaheadPhysics['bot'] & { on(e: string, f: (...a: Array<{ position?: { x: number; y: number; z: number } } | null>) => void): unknown };

function worldCache(m: MovementsLike): Map<string, unknown> {
  let c = movementCaches.get(m);
  if (!c) {
    const map = new Map<string, unknown>();
    c = { tick: -1, map };
    movementCaches.set(m, c);
    const bot = m.bot as BlockEvents;
    type Located = { position?: { x: number; y: number; z: number } } | null;
    bot.on('blockUpdate', (oldBlock: Located, newBlock: Located) => {
      const p = newBlock?.position ?? oldBlock?.position;
      if (p) map.delete(`${p.x},${p.y},${p.z}`);
    });
    bot.on('chunkColumnUnload', () => map.clear());
    bot.on('chunkColumnLoad', () => map.clear());
  }
  if (c.map.size > MAX_CACHED_BLOCKS) c.map.clear();
  return c.map;
}

MovementsProto.getBlock = function (this: MovementsLike, pos: unknown, dx: unknown, dy: unknown, dz: unknown) {
  const p = pos as { x: number; y: number; z: number } | null;
  if (!astarBlockCache || !p) return getBlockOrig.call(this, p, dx as number, dy as number, dz as number);
  let map: Map<string, unknown>;
  if (astarBlockCache === 'world') map = worldCache(this);
  else {
    const tick = tickOf(this.bot);
    let c = movementCaches.get(this);
    if (!c || c.tick !== tick) {
      c = { tick, map: new Map() };
      movementCaches.set(this, c);
    }
    map = c.map;
  }
  const k = `${p.x + (dx as number)},${p.y + (dy as number)},${p.z + (dz as number)}`;
  const hit = map.get(k);
  if (hit !== undefined) {
    counters.astarCacheHits++;
    return hit;
  }
  counters.astarCacheMisses++;
  const b = getBlockOrig.call(this, p, dx as number, dy as number, dz as number) as { position?: unknown };
  // An unloaded block comes back as a fresh object whose `height` is relative (dy): only real blocks are cached.
  if (b && b.position) map.set(k, b);
  return b;
};

// -- mineflayer-pathfinder: A* slices ----------------------------------------------------------------------------

interface AStarLike {
  startTime: number;
  __lastEnd?: number;
  /** Set by the patched compute when the budget refused this search a slice (lib/astar.js, squad/patches/). */
  waitingSince?: number | null;
}
const AStar = require('mineflayer-pathfinder/lib/astar') as { prototype: { compute: (this: AStarLike) => unknown } };
const compute = AStar.prototype.compute;

let thinkOnCompute = false;
let windowStart = 0;
let windowSpent = 0;

export function setThinkOnCompute(on: boolean): void {
  thinkOnCompute = on;
}

AStar.prototype.compute = function (this: AStarLike) {
  const now = performance.now();
  if (now - windowStart >= 50) {
    if (windowSpent > counters.astarMaxWindow) counters.astarMaxWindow = windowSpent;
    windowStart = now;
    windowSpent = 0;
  }
  // thinkTimeout on compute time: the wall time between two slices of this search does not count. After a slice the
  // budget refused, the patched compute already forgives that wait itself: not twice.
  if (thinkOnCompute && this.__lastEnd !== undefined && this.waitingSince == null) this.startTime += now - this.__lastEnd;
  try {
    return compute.call(this);
  } finally {
    if (this.waitingSince != null) counters.astarStarved++;
    const end = performance.now();
    const dt = end - now;
    this.__lastEnd = end;
    windowSpent += dt;
    counters.astarMs += dt;
    counters.astarCalls++;
    if (dt > counters.astarMaxSlice) counters.astarMaxSlice = dt;
  }
};
