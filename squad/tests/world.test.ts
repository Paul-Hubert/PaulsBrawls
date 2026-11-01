// docs/37 P1: the shared world. Real 1.21.1 chunk data (prismarine-chunk columns, dumped as the server's chunkData)
// goes through the same packet listeners the store attaches to a real bot, and every block the store answers is
// compared with the bot's own prismarine world. Then the parts one by one: the per-state tables, the decoder, the
// writer's index (tombstones), its epochs (no reuse under a reader), the cache, the dedup and the primary holder,
// dimensions and disconnects, a writer crash, a reader on another thread, verify, the config and the pool's seam.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

import { SharedWorld, type SharedWorldOptions } from '../src/world/shared-world';
import { allocateWorld, slotOf, INDEX_CAPACITY, PAGE_SECTIONS, SECTION_BLOCKS } from '../src/world/layout.mjs';
import { openWorld, type WorldDescriptor, type WorldReader } from '../src/world/reader.mjs';
import { WorldStore } from '../src/world/store.mjs';
import { buildStateTables, decoderOptions, F_BB_BLOCK, F_LAVA, F_WATERLOGGED } from '../src/world/tables.mjs';
import { decodeColumn, FULL, UNIFORM } from '../src/world/decode.mjs';
import { BotPool } from '../src/bots/pool';
import { ConfigError, parseConfig } from '../src/config';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { until } from './fakes/harness';

holdEventLoopPerTest();

const require = createRequire(import.meta.url);
const VERSION = '1.21.1';
const registry = require('prismarine-registry')(VERSION) as any;
const Chunk = require('prismarine-chunk')(registry) as any;
const World = require('prismarine-world')(registry) as any;
const Block = require('prismarine-block')(registry) as any;
const { Vec3 } = require('vec3') as { Vec3: any };

const OW = 'minecraft:overworld';
const NETHER = 'minecraft:the_nether';
const S = (name: string): number => registry.blocksByName[name].defaultState;
const STONE = S('stone');
const GOLD = S('gold_block');
const GLASS = S('glass');
const LOG = S('oak_log');
const READER_FIXTURE = new URL('./fixtures/world-reader.mjs', import.meta.url);

const TABLES = buildStateTables(registry);
const DECODER = decoderOptions(registry, TABLES);

// -- columns, bots ---------------------------------------------------------------------------------------------------

/** Every block state id of the registry, for palettes of any size. */
const ALL_STATES = Array.from({ length: TABLES.count - 1 }, (_, i) => i + 1);

/**
 * A column with everything the decoder must read: one-state sections (deepslate, then all air above), small and
 * large palettes (9 and 120 states), the global palette (2 000 states in one section), stone, a few logs, biomes.
 */
function richColumn(seed: number, minY = -64, height = 384): any {
  const c = new Chunk({ minY, worldHeight: height });
  const top = Math.min(minY + height, minY + 160);
  for (let y = minY; y < top; y++) {
    const sec = (y - minY) >> 4;
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        let s = 0;
        if (sec < 2) s = S('deepslate');
        else if (sec === 2) s = ALL_STATES[(x * 7 + z * 3 + y + seed) % 9] as number;
        else if (sec === 3) s = ALL_STATES[(x * 7 + z * 13 + y * 5 + seed) % 120] as number;
        else if (sec === 4) s = ALL_STATES[(x * 256 + z * 16 + (y & 15) + seed) % 2000] as number;
        else if (sec < 9) s = STONE;
        else if (sec === 9 && ((x + z + seed) & 3) === 0 && (y & 15) === 0) s = LOG;
        if (s) c.setBlockStateId(new Vec3(x, y, z), s);
        if ((x & 3) === 0 && (z & 3) === 0 && (y & 3) === 0) c.setBiome(new Vec3(x, y, z), (x + z + y + seed) & 7);
      }
    }
  }
  return c;
}

/** A cheap column: stone from y 60 to 63, one log whose place depends on `seed` (so payloads differ). */
function flatColumn(seed: number): any {
  const c = new Chunk({ minY: -64, worldHeight: 384 });
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 60; y <= 63; y++) c.setBlockStateId(new Vec3(x, y, z), STONE);
  c.setBlockStateId(new Vec3(seed & 15, 64, (seed >> 4) & 15), LOG);
  return c;
}

function cloneColumn(c: any): any {
  const copy = new Chunk({ minY: c.minY, worldHeight: c.worldHeight });
  copy.load(c.dump());
  return copy;
}

/** A bot as the store sees it: a packet stream (`_client`), its own world, a game (minY, height). */
function mcBot(): any {
  const bot: any = new EventEmitter();
  bot.setMaxListeners(50);
  bot._client = new EventEmitter();
  bot.world = new World(null, null, 0).sync;
  bot.game = { minY: -64, height: 384 };
  return bot;
}

function login(bot: any, name = OW, id = 0): void {
  bot._client.emit('login', { worldState: { dimension: id, name } });
}

/** The server sends a column: the bot's world gets its own copy (as mineflayer parses it), the store the bytes. */
function send(bot: any, x: number, z: number, col: any): void {
  bot.world.setColumn(x, z, cloneColumn(col));
  bot._client.emit('map_chunk', { x, z, chunkData: col.dump() });
}

function unload(bot: any, x: number, z: number): void {
  bot.world.unloadColumn(x, z);
  bot._client.emit('unload_chunk', { chunkX: x, chunkZ: z });
}

/** A block change the bot hears (and applies to its own world, as mineflayer does). */
function change(bot: any, x: number, y: number, z: number, s: number): void {
  bot.world.setBlockStateId(new Vec3(x, y, z), s);
  bot._client.emit('block_change', { location: { x, y, z }, type: s });
}

function read<T>(r: WorldReader, fn: () => T): T {
  r.enter();
  try {
    return fn();
  } finally {
    r.leave();
  }
}

/** Blocks of the column at (cx, cz) where the store and the bot's own world disagree. */
function mismatches(r: WorldReader, bot: any, cx: number, cz: number, dim = OW, minY = -64, height = 384): number {
  let bad = 0;
  read(r, () => {
    for (let y = minY; y < minY + height; y++) {
      for (let z = cz * 16; z < cz * 16 + 16; z++) {
        for (let x = cx * 16; x < cx * 16 + 16; x++) {
          if (r.stateId(dim, x, y, z) !== bot.world.getBlockStateId(new Vec3(x, y, z))) bad++;
        }
      }
    }
  });
  return bad;
}

const worlds: SharedWorld[] = [];
const workers: Worker[] = [];
function newWorld(opts: Partial<SharedWorldOptions> = {}): SharedWorld {
  const w = new SharedWorld({ version: VERSION, cacheSeconds: 60, cacheColumns: 2_000, maxReaders: 8, ...opts });
  worlds.push(w);
  return w;
}
after(async () => {
  for (const w of workers) await w.terminate();
  for (const w of worlds) await w.stop();
});

/** A store driven on this thread (the writer's logic without its thread), with a reader in slot 1. */
function newStore(opts: { cacheSeconds?: number; cacheColumns?: number; now?: () => number } = {}) {
  const d = allocateWorld({ version: VERSION, maxReaders: 4, tables: TABLES, decoder: DECODER });
  const store = new WorldStore(d, { cacheSeconds: opts.cacheSeconds ?? 60, cacheColumns: opts.cacheColumns ?? 2_000, now: opts.now });
  return { d, store, reader: openWorld({ ...d, reader: 1 }), reader2: openWorld({ ...d, reader: 2 }) };
}

const bytesOf = (c: any): Uint8Array => new Uint8Array(c.dump());

// -- the per-state tables --------------------------------------------------------------------------------------------

test('per-state tables: collision boxes, flags, names and ids from the registry', () => {
  const t = openWorld({ ...allocateWorld({ version: VERSION, maxReaders: 1, tables: TABLES, decoder: DECODER }), reader: -1 }).states;
  assert.equal(t.count, 26_684);
  assert.deepEqual([...t.boxes(STONE)], [0, 0, 0, 1, 1, 1]);
  assert.ok(t.isSolid(STONE) && !t.isEmpty(STONE) && (t.flags(STONE) & F_BB_BLOCK) !== 0);
  assert.equal(t.boxes(STONE), t.boxes(S('dirt')), 'one view per shape, shared by its states');
  assert.ok(t.isEmpty(0) && t.boxes(0).length === 0 && t.name(0) === 'air');
  const water = S('water');
  assert.ok(t.isLiquid(water) && t.isWater(water) && t.isEmpty(water) && !t.isSolid(water));
  assert.ok(t.isLiquid(S('lava')) && (t.flags(S('lava')) & F_LAVA) !== 0 && !t.isWater(S('lava')));
  assert.ok(t.isClimbable(S('ladder')) && t.boxes(S('ladder')).length === 6 && !t.isSolid(S('ladder')));
  assert.ok(t.isClimbable(S('twisting_vines')) && !t.isClimbable(STONE));
  assert.deepEqual([...t.boxes(S('oak_slab'))], [0, 0, 0, 1, 0.5, 1], 'a bottom slab');
  const stateWith = (name: string, props: Record<string, unknown>): number => {
    const b = registry.blocksByName[name];
    for (let s = b.minStateId; s <= b.maxStateId; s++) {
      const p = Block.fromStateId(s).getProperties();
      if (Object.entries(props).every(([k, v]) => p[k] === v)) return s;
    }
    throw new Error(`no ${name} state with ${JSON.stringify(props)}`);
  };
  const wetStairs = stateWith('oak_stairs', { waterlogged: true });
  assert.ok(t.isWater(wetStairs) && (t.flags(wetStairs) & F_WATERLOGGED) !== 0 && !t.isLiquid(wetStairs));
  assert.ok(!t.isWater(stateWith('oak_stairs', { waterlogged: false })));
  // Per state, not per block: an open gate has no collision; minecraft-data's per-block box says 'block'.
  const openGate = stateWith('oak_fence_gate', { open: true });
  assert.ok(t.isEmpty(openGate) && (t.flags(openGate) & F_BB_BLOCK) !== 0);
  assert.ok(!t.isEmpty(stateWith('oak_fence_gate', { open: false })));
  assert.ok(t.isEmpty(stateWith('snow', { layers: '1' })) && !t.isEmpty(stateWith('snow', { layers: '3' })));
  assert.equal(t.name(STONE), 'stone');
  assert.equal(t.blockId(STONE), registry.blocksByName.stone.id);
  assert.equal(t.name(LOG), 'oak_log');
  assert.equal(t.boxes(-1).length, 0);
  assert.equal(t.name(99_999), '');
  assert.equal(t.blockId(-1), -1);
  assert.equal(t.boxCount(S('oak_slab')), 1);
  assert.deepEqual([...t.boxData.subarray(t.boxStart(S('oak_slab')), t.boxStart(S('oak_slab')) + 6)], [0, 0, 0, 1, 0.5, 1]);
});

// -- the decoder -----------------------------------------------------------------------------------------------------

test('the decoder reads every block of a payload as prismarine-chunk does (uniform, palettes, global palette)', () => {
  for (const [minY, height] of [[-64, 384], [0, 256]] as const) {
    const col = richColumn(3, minY, height);
    const scratch = new Uint16Array(SECTION_BLOCKS);
    const kinds = { uniform: 0, full: 0 };
    let bad = 0;
    decodeColumn(bytesOf(col), height >> 4, DECODER, scratch, (i, kind, value) => {
      if (kind === UNIFORM) kinds.uniform++;
      else if (kind === FULL) kinds.full++;
      for (let j = 0; j < SECTION_BLOCKS; j++) {
        const pos = new Vec3(j & 15, minY + i * 16 + (j >> 8), (j >> 4) & 15);
        const ours = kind === UNIFORM ? value : (scratch[j] as number);
        if (ours !== col.getBlockStateId(pos)) bad++;
      }
    });
    assert.equal(bad, 0, `minY ${minY}`);
    assert.ok(kinds.uniform > 0 && kinds.full >= 4, JSON.stringify(kinds));
  }
  const truncated = bytesOf(flatColumn(1)).subarray(0, 300);
  assert.throws(() => decodeColumn(truncated, 24, DECODER, new Uint16Array(SECTION_BLOCKS), () => undefined), /truncated/);
});

// -- the main thread's handle: publish, read, route ------------------------------------------------------------------

test("a bot's columns are published and read block for block as its own world has them; unknown is -1", async () => {
  const world = newWorld();
  const published: string[] = [];
  world.on('published', (d: string, x: number, z: number) => published.push(`${d} ${x},${z}`));
  const bot = mcBot();
  world.attach(bot);
  login(bot);
  send(bot, 0, 0, richColumn(1));
  for (const [x, z] of [[1, 0], [0, 1], [-1, -1]] as const) send(bot, x, z, flatColumn(x * 7 + z));
  await world.settle();
  assert.deepEqual(published.sort(), [`${OW} -1,-1`, `${OW} 0,0`, `${OW} 0,1`, `${OW} 1,0`]);
  const r = world.reader;
  for (const [x, z] of [[0, 0], [1, 0], [0, 1], [-1, -1]] as const) assert.equal(mismatches(r, bot, x, z), 0, `column ${x},${z}`);
  read(r, () => {
    assert.equal(r.stateId(OW, 40, 63, 0), -1, 'a column nobody sent');
    assert.equal(r.stateId(NETHER, 0, 63, 0), -1, 'a dimension the store never saw');
    assert.equal(r.stateId(OW, 3, 400, 3), 0, 'above the world, in a live column: air');
    assert.equal(r.stateId(OW, 3, -100, 3), 0, 'below the world: air');
    assert.equal(r.stateId(OW, 16.9, 63.2, 0.5), STONE, 'fractional positions are floored');
    assert.equal(r.stateId(OW, -0.5, 63, -0.5), bot.world.getBlockStateId(new Vec3(-1, 63, -1)), 'negative coordinates floor too');
    assert.ok(r.hasColumn(OW, 0, 0) && r.hasColumn(OW, -1, -1) && !r.hasColumn(OW, 5, 5) && !r.hasColumn(NETHER, 0, 0));
    assert.ok(r.columnVersion(OW, 0, 0) > 0);
    assert.equal(r.columnVersion(OW, 5, 5), -1);
    const d = r.dimIndex(OW);
    assert.equal(r.stateIdIn(d, 16, 63, 0), STONE);
  });
  assert.deepEqual(r.bounds(OW), { minY: -64, height: 384 });
  assert.equal(r.bounds(NETHER), null);
  assert.throws(() => r.stateId(OW, 0, 0, 0), /outside enter/);
  assert.throws(() => r.leave(), /not inside/);
  r.enter();
  assert.throws(() => r.enter(), /re-entrant/);
  r.leave();
  const s = world.stats();
  assert.equal(s.columnsLive, 4);
  assert.equal(s.decoded, 4);
  assert.ok(s.sections >= 4 && s.bytes > 8 * 1024 * 1024, JSON.stringify(s));
  assert.ok(s.decodeMs.max > 0 && s.decodeMs.p50 > 0);
  assert.equal(s.writer, 'up');
});

test('a column held by several bots is decoded once, and a change N bots hear is sent once', async () => {
  const world = newWorld();
  const bots = [mcBot(), mcBot(), mcBot()];
  for (const b of bots) {
    world.attach(b);
    login(b);
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) send(b, x, z, flatColumn(x * 3 + z + 4));
  }
  await world.settle();
  assert.equal(world.stats().decoded, 9, 'each column decoded once');
  assert.equal(world.stats().held, 9);
  for (const b of bots) change(b, 5, 70, 5, GOLD);
  // multi_block_change: one long per record, stateId << 12 | x << 8 | z << 4 | y, in section (0, 4, 0) (y 64..79).
  const records = [(GLASS << 12) | (2 << 8) | (3 << 4) | 7, (STONE << 12) | (4 << 8) | (6 << 4) | 8];
  for (const b of bots) {
    b.world.setBlockStateId(new Vec3(2, 71, 3), GLASS);
    b.world.setBlockStateId(new Vec3(4, 72, 6), STONE);
    b._client.emit('multi_block_change', { chunkCoordinates: { x: 0, y: 4, z: 0 }, records });
  }
  // An explosion: its affected blocks become air.
  for (const b of bots) {
    b.world.setBlockStateId(new Vec3(8, 63, 8), 0);
    b.world.setBlockStateId(new Vec3(9, 62, 8), 0);
    b._client.emit('explosion', { x: 8.5, y: 63.5, z: 8.5, affectedBlockOffsets: [{ x: 0, y: 0, z: 0 }, { x: 1, y: -1, z: 0 }] });
  }
  await world.settle();
  const r = world.reader;
  read(r, () => {
    assert.equal(r.stateId(OW, 5, 70, 5), GOLD);
    assert.equal(r.stateId(OW, 2, 71, 3), GLASS);
    assert.equal(r.stateId(OW, 4, 72, 6), STONE);
    assert.equal(r.stateId(OW, 8, 63, 8), 0);
    assert.equal(r.stateId(OW, 9, 62, 8), 0);
  });
  assert.equal(world.stats().dropped, 2 * 5, 'two bots of three dropped each of the 5 changes: only the primary sends');
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) assert.equal(mismatches(r, bots[2], x, z), 0);
  // A change for a column the bot does not hold is ignored, as mineflayer does.
  bots[0]._client.emit('block_change', { location: { x: 100, y: 64, z: 100 }, type: GOLD });
  await world.settle();
  assert.equal(world.stats().held, 9);
});

test('the last holder going: cached (unknown), back without a decode when the payload is the same, decoded when not', async () => {
  const world = newWorld();
  const unloaded: string[] = [];
  world.on('unloaded', (d: string, x: number, z: number) => unloaded.push(`${x},${z}`));
  const a = mcBot();
  world.attach(a);
  login(a);
  const c0 = flatColumn(1);
  const c1 = flatColumn(2);
  send(a, 0, 0, c0);
  send(a, 1, 0, c1);
  await world.settle();
  unload(a, 0, 0);
  await world.settle();
  assert.deepEqual(unloaded, ['0,0']);
  assert.equal(read(world.reader, () => world.reader.stateId(OW, 3, 63, 3)), -1, 'cached reads as unknown');
  assert.deepEqual([world.stats().columnsLive, world.stats().columnsCached], [1, 1]);
  // The same payload again (walking back): published without a decode.
  send(a, 0, 0, c0);
  await world.settle();
  assert.equal(read(world.reader, () => world.reader.stateId(OW, 3, 63, 3)), STONE);
  assert.deepEqual([world.stats().decoded, world.stats().skipped, world.stats().columnsCached], [2, 1, 0]);
  // A changed payload: decoded.
  unload(a, 1, 0);
  const c1b = flatColumn(2);
  c1b.setBlockStateId(new Vec3(0, 70, 0), GOLD);
  send(a, 1, 0, c1b);
  await world.settle();
  assert.equal(read(world.reader, () => world.reader.stateId(OW, 16, 70, 0)), GOLD);
  assert.equal(world.stats().decoded, 3);
  // A block change made the column dirty: the old payload again must be decoded, not trusted (the server's block
  // may have been put back while no bot held the column).
  change(a, 5, 70, 5, GOLD);
  await world.settle();
  unload(a, 0, 0);
  send(a, 0, 0, c0);
  await world.settle();
  assert.equal(read(world.reader, () => world.reader.stateId(OW, 5, 70, 5)), 0, 'the payload, not the old change');
  assert.equal(world.stats().decoded, 4);
  assert.equal(mismatches(world.reader, a, 0, 0), 0);
});

// -- the writer's store, on this thread ------------------------------------------------------------------------------

test('cached columns expire after cacheSeconds; beyond cacheColumns the oldest go first', () => {
  let clock = 0;
  const { store, reader } = newStore({ cacheSeconds: 10, cacheColumns: 2, now: () => clock });
  const cols = [0, 1, 2, 3].map((i) => bytesOf(flatColumn(i)));
  cols.forEach((b, i) => assert.equal(store.load(OW, i, 0, -64, 384, b).decoded, true));
  store.endBatch();
  cols.forEach((_, i) => {
    clock = i * 1_000;
    assert.equal(store.release(OW, i, 0), true);
  });
  store.endBatch();
  assert.deepEqual([store.stats().columnsCached, store.stats().evicted], [2, 2], 'the two oldest dropped');
  clock = 12_500;
  assert.equal(store.expire(), 1, 'cached at 2 s: past 10 s');
  store.endBatch();
  assert.deepEqual([store.stats().columnsCached, store.stats().evicted], [1, 3]);
  const back = store.load(OW, 3, 0, -64, 384, cols[3]!);
  assert.deepEqual([back.live, back.decoded], [true, false], 'still cached: no decode');
  assert.equal(store.load(OW, 0, 0, -64, 384, cols[0]!).decoded, true, 'dropped: decoded again');
  store.endBatch();
  read(reader, () => assert.equal(reader.stateId(OW, 48, 63, 0), STONE));
  assert.equal(store.stats().columnsLive, 2);
});

test('an evicted column leaves a tombstone: probes pass over it, and it is reused once every reader is past', () => {
  const { d, store, reader } = newStore({ cacheColumns: 0 });
  const mask = INDEX_CAPACITY - 1;
  const tag = 1; // the first dimension
  // Keys whose probes all start at the same index entry.
  const s0 = slotOf(tag, 0, 0, mask);
  const same: number[] = [];
  for (let cz = 1; same.length < 3; cz++) if (slotOf(tag, 0, cz, mask) === s0) same.push(cz);
  const idx = new Int32Array(d.index);
  const entryOf = (cz: number): number => {
    for (let n = 0; n < 8; n++) {
      const e = (s0 + n) & mask;
      if (idx[e * 4] === tag && idx[e * 4 + 2] === cz) return e;
    }
    return -1;
  };
  store.load(OW, 0, 0, -64, 384, bytesOf(flatColumn(1)));
  store.load(OW, 0, same[0]!, -64, 384, bytesOf(flatColumn(2)));
  store.endBatch();
  assert.deepEqual([entryOf(0), entryOf(same[0]!)], [s0, (s0 + 1) & mask], 'the second key probed past the first');
  // Evict the first: its entry becomes a tombstone while a reader is inside.
  reader.enter();
  store.release(OW, 0, 0);
  store.endBatch();
  assert.equal(idx[s0 * 4], -1, 'tombstone');
  assert.equal(reader.stateId(OW, 3, 63, same[0]! * 16 + 3), STONE, 'the probe passes over the tombstone');
  assert.equal(reader.stateId(OW, 3, 63, 3), -1);
  // While the reader is inside, the tombstone is not reused: a new key with the same start goes further.
  store.load(OW, 0, same[1]!, -64, 384, bytesOf(flatColumn(3)));
  store.endBatch();
  assert.equal(entryOf(same[1]!), (s0 + 2) & mask);
  assert.equal(store.stats().tombstones, 1);
  reader.leave();
  store.endBatch();
  store.load(OW, 0, same[2]!, -64, 384, bytesOf(flatColumn(4)));
  store.endBatch();
  assert.equal(entryOf(same[2]!), s0, 'reused once the reader left');
  assert.equal(store.stats().tombstones, 0);
  // Reinsert the evicted key: a new entry, found and read.
  store.load(OW, 0, 0, -64, 384, bytesOf(flatColumn(5)));
  store.endBatch();
  read(reader, () => {
    assert.equal(reader.stateId(OW, 3, 63, 3), STONE);
    for (const cz of [same[0]!, same[1]!, same[2]!]) assert.equal(reader.stateId(OW, 3, 63, cz * 16 + 3), STONE);
  });
});

test('epochs: memory freed while a reader is inside is not reused until it leaves; then it is', () => {
  const { d, store, reader, reader2 } = newStore({ cacheColumns: 0 });
  store.load(OW, 0, 0, -64, 384, bytesOf(richColumn(1)));
  store.endBatch();
  const used = store.stats().sectionCapacity;
  assert.ok(used >= 4);
  const sections = new Uint16Array(d.sections, 0, used * SECTION_BLOCKS);
  reader.enter();
  const before = sections.slice();
  const want = Block.fromStateId(reader.stateId(OW, 5, -64 + 3 * 16 + 2, 5)).name;
  // Drop the column while the reader is inside.
  store.release(OW, 0, 0);
  store.endBatch();
  assert.equal(reader.stateId(OW, 5, -64 + 3 * 16 + 2, 5), -1, 'a dropped column reads as unknown, never as garbage');
  assert.equal(store.freeSections.length, 0, 'retired, not free: the reader may still hold it');
  // A reader entering now is past the retirement and does not hold it back.
  reader2.enter();
  // New columns get new memory.
  store.load(OW, 1, 0, -64, 384, bytesOf(richColumn(2)));
  store.load(OW, 2, 0, -64, 384, bytesOf(richColumn(3)));
  store.endBatch();
  assert.ok(store.stats().sectionCapacity >= used * 3, 'fresh sections');
  assert.deepEqual(sections.slice(), before, "the dropped column's sections are untouched while the reader is inside");
  reader.leave();
  store.endBatch();
  assert.equal(store.freeSections.length, used, 'freed once the reader left (reader2 entered after: no hold)');
  store.load(OW, 3, 0, -64, 384, bytesOf(richColumn(4)));
  store.endBatch();
  assert.equal(store.freeSections.length, 0, 'and reused');
  assert.equal(store.stats().sectionCapacity, used * 3);
  read(reader, () => assert.equal(Block.fromStateId(reader.stateId(OW, 3 * 16 + 5, -64 + 3 * 16 + 2, 5)).name, Block.fromStateId(richColumn(4).getBlockStateId(new Vec3(5, -64 + 3 * 16 + 2, 5))).name));
  reader2.leave();
  assert.ok(want.length > 0);
});

test('block changes: into a stored section in place, into an all-air or one-state section by materialising it', () => {
  const { store, reader } = newStore();
  const c = new Chunk({ minY: -64, worldHeight: 384 });
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = -64; y < -48; y++) c.setBlockStateId(new Vec3(x, y, z), STONE);
  store.load(OW, 0, 0, -64, 384, bytesOf(c));
  store.endBatch();
  assert.equal(store.stats().sections, 0, 'all stone and all air: no section stored');
  store.set(OW, 1, -60, 1, GOLD); // the stone section
  store.set(OW, 2, 100, 2, GLASS); // an air section
  store.set(OW, 3, 100, 3, GLASS);
  store.set(OW, 4, 400, 4, GLASS); // above the world: ignored
  store.set(OW, 40, 64, 4, GLASS); // a column the store does not have: ignored
  store.endBatch();
  assert.equal(store.stats().sections, 2);
  read(reader, () => {
    assert.equal(reader.stateId(OW, 1, -60, 1), GOLD);
    assert.equal(reader.stateId(OW, 0, -60, 0), STONE, 'the rest of the section is still stone');
    assert.equal(reader.stateId(OW, 2, 100, 2), GLASS);
    assert.equal(reader.stateId(OW, 3, 100, 3), GLASS);
    assert.equal(reader.stateId(OW, 5, 100, 5), 0);
    assert.equal(reader.stateId(OW, 40, 64, 4), -1);
  });
});

// -- dimensions, disconnects, the primary holder ------------------------------------------------------------------

test('a new dimension or a disconnect releases every column the bot held', async () => {
  const world = newWorld();
  const a = mcBot();
  world.attach(a);
  login(a);
  send(a, 0, 0, flatColumn(1));
  send(a, 1, 0, flatColumn(2));
  await world.settle();
  assert.equal(world.stats().columnsLive, 2);
  // Into the nether: the overworld columns go.
  a._client.emit('respawn', { worldState: { dimension: 1, name: NETHER }, copyMetadata: false });
  a.game = { minY: 0, height: 256 };
  a.world = new World(null, null, 0).sync;
  const n = new Chunk({ minY: 0, worldHeight: 256 });
  n.setBlockStateId(new Vec3(1, 30, 1), S('netherrack'));
  send(a, 0, 0, n);
  await world.settle();
  assert.deepEqual([world.stats().columnsLive, world.stats().columnsCached, world.stats().held], [1, 2, 1]);
  const r = world.reader;
  read(r, () => {
    assert.equal(r.stateId(OW, 3, 63, 3), -1);
    assert.equal(r.stateId(NETHER, 1, 30, 1), S('netherrack'));
  });
  assert.deepEqual(r.bounds(NETHER), { minY: 0, height: 256 });
  assert.equal(mismatches(r, a, 0, 0, NETHER, 0, 256), 0);
  // A respawn into the same dimension keeps the columns.
  a._client.emit('respawn', { worldState: { dimension: 1, name: NETHER }, copyMetadata: true });
  await world.settle();
  assert.equal(world.stats().columnsLive, 1);
  // A disconnect releases the rest.
  a.emit('end');
  await world.settle();
  assert.deepEqual([world.stats().columnsLive, world.stats().columnsCached, world.stats().held], [0, 3, 0]);
  read(r, () => assert.equal(r.stateId(NETHER, 1, 30, 1), -1));
});

test("only the primary's changes are applied; when it leaves, the next holder re-sends a column changed recently", async () => {
  const world = newWorld();
  const a = mcBot();
  const b = mcBot();
  for (const bot of [a, b]) {
    world.attach(bot);
    login(bot);
    send(bot, 0, 0, flatColumn(1));
    send(bot, 1, 0, flatColumn(2));
  }
  await world.settle();
  // b hears a change a has not heard yet (its socket is ahead): dropped, a is the primary.
  change(b, 3, 70, 3, GOLD);
  await world.settle();
  assert.equal(read(world.reader, () => world.reader.stateId(OW, 3, 70, 3)), 0);
  assert.equal(world.stats().dropped, 1);
  // a leaves the column before hearing it: b's own column is re-sent, and b is the primary now.
  unload(a, 0, 0);
  await world.settle();
  assert.equal(world.stats().resyncs, 1);
  assert.equal(read(world.reader, () => world.reader.stateId(OW, 3, 70, 3)), GOLD);
  assert.equal(mismatches(world.reader, b, 0, 0), 0);
  change(b, 4, 70, 4, GLASS);
  await world.settle();
  assert.equal(read(world.reader, () => world.reader.stateId(OW, 4, 70, 4)), GLASS);
  // A quiet column (no change heard there) switches primary without a re-send.
  unload(a, 1, 0);
  await world.settle();
  assert.equal(world.stats().resyncs, 1);
  assert.equal(mismatches(world.reader, b, 1, 0), 0);
});

test('a re-send to a holder replaces the column and makes that holder the primary', async () => {
  const world = newWorld();
  const a = mcBot();
  const b = mcBot();
  for (const bot of [a, b]) {
    world.attach(bot);
    login(bot);
    send(bot, 0, 0, flatColumn(1));
  }
  await world.settle();
  const changed = flatColumn(1);
  changed.setBlockStateId(new Vec3(7, 80, 7), GOLD);
  send(b, 0, 0, changed);
  await world.settle();
  assert.equal(read(world.reader, () => world.reader.stateId(OW, 7, 80, 7)), GOLD);
  assert.equal(world.stats().decoded, 2);
  change(b, 1, 80, 1, GLASS);
  change(a, 2, 80, 2, GLASS); // a is no longer the primary: dropped
  await world.settle();
  read(world.reader, () => {
    assert.equal(world.reader.stateId(OW, 1, 80, 1), GLASS);
    assert.equal(world.reader.stateId(OW, 2, 80, 2), 0);
  });
});

// -- threads ---------------------------------------------------------------------------------------------------------

interface ReaderThread {
  worker: Worker;
  descriptor: WorldDescriptor;
  ask: (dim: string, points: number[][]) => Promise<{ out: number[]; name: string }>;
  /** The reader enters a bracket and never leaves it (resolves once it is inside). */
  hold: () => Promise<unknown>;
}

function startReader(world: SharedWorld): ReaderThread {
  const descriptor = world.descriptor();
  const w = new Worker(READER_FIXTURE, { workerData: { descriptor } });
  workers.push(w);
  let seq = 0;
  const waiting = new Map<number, (m: { out: number[]; name: string }) => void>();
  w.on('message', (m: { id?: number; out: number[]; name: string }) => {
    if (m.id !== undefined) waiting.get(m.id)?.(m);
  });
  const send = (msg: Record<string, unknown>): Promise<{ out: number[]; name: string }> =>
    new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      w.postMessage({ id, ...msg });
    });
  return { worker: w, descriptor, ask: (dim, points) => send({ dim, points }), hold: () => send({ hold: true }) };
}

test('a reader on another thread sees what the writer publishes, across new section pages', async () => {
  const world = newWorld();
  const reader = startReader(world);
  const a = mcBot();
  world.attach(a);
  login(a);
  // A column of 20 noisy sections, sent at 60 places: 1 200 sections, past the first 1 024-section page.
  const noisy = new Chunk({ minY: -64, worldHeight: 384 });
  for (let y = -64; y < -64 + 20 * 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) noisy.setBlockStateId(new Vec3(x, y, z), ALL_STATES[(x * 31 + z * 17 + y * 7) % 12] as number);
  for (let i = 0; i < 60; i++) send(a, i, 0, noisy);
  await world.settle();
  assert.ok(world.stats().sections > PAGE_SECTIONS, `${world.stats().sections} sections`);
  const points = [];
  for (let i = 0; i < 60; i += 7) points.push([i * 16 + 5, 100, 9], [i * 16 + 15, -64, 0], [i * 16, 255, 15]);
  points.push([5000, 64, 5000]);
  const { out } = await reader.ask(OW, points);
  const want = points.map(([x, y, z]) => (x === 5000 ? -1 : a.world.getBlockStateId(new Vec3(x, y, z))));
  assert.deepEqual(out, want);
});

test('a writer that dies is restarted over the same buffers and the bots re-send; three deaths in a minute disable it', async () => {
  const world = newWorld();
  const reader = startReader(world);
  const a = mcBot();
  world.attach(a);
  login(a);
  send(a, 0, 0, richColumn(1));
  send(a, 1, 0, flatColumn(1));
  await world.settle();
  change(a, 20, 70, 4, GOLD);
  await world.settle();
  const points = [[3, -20, 3], [20, 70, 4], [17, 63, 1], [5, 10, 5]];
  const want = points.map(([x, y, z]) => a.world.getBlockStateId(new Vec3(x, y, z)));
  assert.deepEqual((await reader.ask(OW, points)).out, want);
  const unloaded: string[] = [];
  world.on('unloaded', (_d: string, x: number, z: number) => unloaded.push(`${x},${z}`));
  await world.killWriter();
  await until(() => world.stats().restarts === 1, 5_000, 'the restart');
  assert.deepEqual(unloaded.sort(), ['0,0', '1,0'], 'every column stopped being live');
  await world.settle();
  assert.deepEqual((await reader.ask(OW, points)).out, want, 'the reader opened before the crash reads the re-sent columns');
  assert.equal(mismatches(world.reader, a, 0, 0), 0);
  assert.equal(world.stats().resyncs, 2);
  assert.equal(world.stats().writer, 'up');
  // Changes keep coming to the new writer.
  change(a, 21, 70, 4, GLASS);
  await world.settle();
  assert.equal(read(world.reader, () => world.reader.stateId(OW, 21, 70, 4)), GLASS);
  // Two more deaths within the minute: disabled, and the store is cleared (every read unknown).
  await world.killWriter();
  await until(() => world.stats().restarts === 2, 5_000, 'the second restart');
  await world.killWriter();
  await until(() => world.stats().writer === 'disabled', 5_000, 'disabled');
  await world.settle();
  assert.deepEqual((await reader.ask(OW, points)).out, [-1, -1, -1, -1]);
  read(world.reader, () => assert.equal(world.reader.hasColumn(OW, 0, 0), false));
});

test("world.verify compares a sample of the store with the bots' own worlds", async () => {
  const world = newWorld({ verify: true, verifyIntervalMs: 60_000 });
  const a = mcBot();
  world.attach(a);
  login(a);
  send(a, 0, 0, richColumn(1));
  await world.settle();
  const clean = world.verifyRound(3_000);
  assert.ok(clean.checked > 2_000, `checked ${clean.checked}`);
  assert.equal(clean.mismatches, 0);
  // The bot's world changes without a packet the store could follow: a whole section of gold.
  for (let y = 80; y < 96; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) a.world.setBlockStateId(new Vec3(x, y, z), GOLD);
  const dirty = world.verifyRound(3_000);
  assert.ok(dirty.mismatches > 0, JSON.stringify(dirty));
  assert.equal(world.stats().verify.mismatches, dirty.mismatches);
  assert.equal(world.stats().verify.rounds, 2);
});

test('descriptors: one epoch slot each, up to maxReaders (the main thread has slot 0); released slots come back', () => {
  const world = newWorld({ maxReaders: 3 });
  const d1 = world.descriptor();
  const d2 = world.descriptor();
  assert.deepEqual([d1.reader, d2.reader], [1, 2]);
  assert.throws(() => world.descriptor(), /reader slots are taken/);
  world.release(d1);
  const d3 = world.descriptor();
  assert.equal(d3.reader, 1, 'the slot came back');
  // Idempotent: releasing d1 again must not free d3, which holds that slot now.
  world.release(d1);
  assert.throws(() => world.descriptor(), /reader slots are taken/);
  world.release({ ...d2, reader: 0 }); // never the main thread's own slot
  assert.ok(structuredClone(d2).sections instanceof SharedArrayBuffer, 'structured-cloneable, buffers by reference');
});

test('a reader thread killed inside enter() holds freed memory until release(); then the memory is reused', async () => {
  const world = newWorld({ cacheColumns: 0 }); // a column no bot holds is dropped at once
  const a = mcBot();
  world.attach(a);
  login(a);
  send(a, 0, 0, richColumn(1));
  await world.settle();
  const perColumn = world.stats().sectionCapacity;
  assert.ok(perColumn >= 4);
  const reader = startReader(world);
  await reader.hold();
  // The column is dropped while the reader is inside: its memory is retired, not free.
  unload(a, 0, 0);
  await world.settle();
  assert.equal(world.stats().retiredBatches, 1);
  // The reader dies without leave(). New columns cannot reuse the retired memory.
  await reader.worker.terminate();
  send(a, 1, 0, richColumn(2));
  await world.settle();
  assert.equal(world.stats().sectionCapacity, perColumn * 2, 'fresh sections: the dead reader still holds the old ones');
  assert.equal(world.stats().retiredBatches, 1);
  world.release(reader.descriptor);
  world.release(reader.descriptor); // idempotent
  send(a, 2, 0, richColumn(3));
  await world.settle();
  assert.equal(world.stats().sectionCapacity, perColumn * 2, "the next column reused the dead reader's memory");
  assert.equal(world.stats().retiredBatches, 0);
  assert.equal(mismatches(world.reader, a, 2, 0), 0);
  assert.equal(mismatches(world.reader, a, 1, 0), 0);
});

// -- config, pool ----------------------------------------------------------------------------------------------------

test('config: world.* defaults to off, 60 s, 2 000 columns, no verify; values are checked', () => {
  const env = { PAULSBRAWLS_SQUAD_TOKEN: 't' };
  assert.deepEqual(parseConfig({}, env).world, { enabled: false, cacheSeconds: 60, cacheColumns: 2_000, verify: false });
  assert.deepEqual(parseConfig({ world: { enabled: true, cacheSeconds: 5, cacheColumns: 10, verify: true } }, env).world, {
    enabled: true,
    cacheSeconds: 5,
    cacheColumns: 10,
    verify: true,
  });
  for (const bad of [{ enabled: 'yes' }, { cacheSeconds: -1 }, { cacheColumns: 1.5 }, { verify: 1 }]) {
    assert.throws(() => parseConfig({ world: bad }, env), ConfigError, JSON.stringify(bad));
  }
});

test('the bot pool attaches the shared world before the first packet', async () => {
  const calls: string[] = [];
  const pool = new BotPool({
    host: 'x',
    port: 1,
    staggerMs: 1,
    setup: () => calls.push('setup'),
    world: { attach: () => calls.push('world') },
    createBot: (req) => {
      const b = new FakeBot(req.username);
      setTimeout(() => b.emit('spawn'), 1);
      return b as never;
    },
  });
  pool.add('World1');
  await until(() => pool.status('World1') === 'online', 1_000, 'online');
  assert.deepEqual(calls, ['world', 'setup']);
  pool.stop();
});
