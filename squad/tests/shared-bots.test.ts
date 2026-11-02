// docs/37 P5: the bots read the shared world (world.shared). Each test feeds ONE packet stream (real 1.21.1 chunk data:
// prismarine-chunk columns dumped as the server's chunkData, block changes, unloads, respawns) to a bot running
// mineflayer's own blocks plugin and to a bot running the shared world's (blocks-plugin.ts over bot-world.ts), and
// checks that the second sees what the first sees: blockAt, getBlockStateId, the events, findBlocks, raycasts, block
// entities, physics and A*. Then what only the shared world has: two bots sharing columns (decoded once, a change
// applied once), a bot leaving, a change of dimension, the spawn's wait for chunks, digging's prediction, the resync
// sources (a new primary's overlay; a writer restart rebuilt from the store itself; the third death in a minute moving
// the writer to the main thread), and world.shared off changing nothing.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { Vec3 } from 'vec3';

import { SharedWorld, type SharedWorldOptions } from '../src/world/shared-world';
import { injectSharedBlocks } from '../src/world/blocks-plugin';
import { OVERLAY_MS, type SharedBotWorld } from '../src/world/bot-world';
import { encodeColumn } from '../src/world/encode.mjs';
import { decodeColumn, FULL } from '../src/world/decode.mjs';
import { buildStateTables, decoderOptions } from '../src/world/tables.mjs';
import { botWorld } from '../src/aim/inline';
import { BotPool, type SpawnRequest } from '../src/bots/pool';
import { SHARED_WORLD_PACKETS } from '../src/bots/protocol';
import { ConfigError, parseConfig } from '../src/config';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { until } from './fakes/harness';
import { blockIdOf, forestColumn, GROUND_Y, mineflayerBot, OVERWORLD, registry, stateOf, VERSION } from './fakes/terrain';

holdEventLoopPerTest(120_000);

const require = createRequire(import.meta.url);
const Chunk = require('prismarine-chunk')(registry) as any;
const Block = require('prismarine-block')(registry) as any;
const nbt = require('prismarine-nbt') as any;
const { Physics, PlayerState } = require('prismarine-physics') as any;
const AStar = require('mineflayer-pathfinder/lib/astar') as any;
const Movements = require('mineflayer-pathfinder/lib/movements') as any;
const Move = require('mineflayer-pathfinder/lib/move') as any;
const goals = require('mineflayer-pathfinder/lib/goals') as any;

const NETHER = 'minecraft:the_nether';
const STONE = stateOf('stone');
const GOLD = stateOf('gold_block');
const GLASS = stateOf('glass');
const LOGS = [blockIdOf('oak_log'), blockIdOf('birch_log')];

const worlds: SharedWorld[] = [];
function newWorld(opts: Partial<SharedWorldOptions> = {}): SharedWorld {
  const w = new SharedWorld({ version: VERSION, cacheSeconds: 60, cacheColumns: 2_000, maxReaders: 8, shared: true, ...opts });
  worlds.push(w);
  return w;
}
after(async () => {
  for (const w of worlds) await w.stop();
});

/** A bot as the shared world's blocks plugin makes it: the same fields as terrain.ts's mineflayer bot. */
function sharedBot(world: SharedWorld, position = new Vec3(0, GROUND_Y + 1, 0), username = 'Shared'): any {
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
  world.attach(bot); // the pool attaches right after createBot; mineflayer loads the plugin later
  injectSharedBlocks(bot, { version: VERSION, hideErrors: true }, world);
  return bot;
}

/** The same packet to every bot (each a real stream: the server sends every bot its own copy). */
function emit(bots: any[], name: string, packet: unknown): void {
  for (const b of bots) b._client.emit(name, packet);
}
const login = (bots: any[], name = OVERWORLD, dimension = 0): void => emit(bots, 'login', { worldState: { dimension, name } });
const sendCol = (bots: any[], cx: number, cz: number, col: any, extra: Record<string, unknown> = {}): void =>
  emit(bots, 'map_chunk', { x: cx, z: cz, chunkData: col.dump(), ...extra });
const sendForest = (bots: any[], r: number, from = { x: 0, z: 0 }): void => {
  for (let cx = from.x - r; cx <= from.x + r; cx++) for (let cz = from.z - r; cz <= from.z + r; cz++) sendCol(bots, cx, cz, forestColumn(cx, cz));
};
const change = (bots: any[], x: number, y: number, z: number, s: number): void => emit(bots, 'block_change', { location: { x, y, z }, type: s });
const multi = (bots: any[], cx: number, cy: number, cz: number, changes: Array<[number, number, number, number]>): void =>
  emit(bots, 'multi_block_change', {
    chunkCoordinates: { x: cx, y: cy, z: cz },
    records: changes.map(([x, y, z, s]) => (s << 12) | ((x & 15) << 8) | ((z & 15) << 4) | (y & 15)),
  });
const unload = (bots: any[], cx: number, cz: number): void => emit(bots, 'unload_chunk', { chunkX: cx, chunkZ: cz });

/** What a block is, as the tests compare it (null: no block, an unloaded column). */
function describe(b: any): string {
  if (!b) return 'null';
  return `${b.name}#${b.stateId} t${b.type} m${b.metadata} ${b.position} ${b.boundingBox} ${JSON.stringify(b.shapes)} ${b.hardness} ${b.diggable}`;
}

/** Every block of a column (stateIds) and a sample of whole blocks, compared between the two bots; returns mismatches. */
function compareColumn(ref: any, sh: any, cx: number, cz: number, step = 7): string[] {
  const bad: string[] = [];
  const p = new Vec3(0, 0, 0);
  for (let y = -64; y < 320; y++) {
    for (let z = cz * 16; z < cz * 16 + 16; z++) {
      for (let x = cx * 16; x < cx * 16 + 16; x++) {
        p.x = x;
        p.y = y;
        p.z = z;
        const a = ref.world.getBlockStateId(p);
        const b = sh.world.getBlockStateId(p);
        if (a !== b && bad.length < 5) bad.push(`${p}: ${a} vs ${b}`);
        if ((x + y * 3 + z * 5) % step === 0) {
          const da = describe(ref.blockAt(p));
          const db = describe(sh.blockAt(p));
          if (da !== db && bad.length < 5) bad.push(`${p}: ${da} vs ${db}`);
        }
      }
    }
  }
  return bad;
}

/** The events a bot emits, as text. */
function record(bot: any): { blocks: string[]; loads: string[]; unloads: string[] } {
  const ev = { blocks: [] as string[], loads: [] as string[], unloads: [] as string[] };
  bot.on('blockUpdate', (o: any, n: any) => ev.blocks.push(`${o?.stateId}>${n?.stateId} ${n?.position} same=${o?.position === n?.position}`));
  bot.on('chunkColumnLoad', (c: Vec3) => ev.loads.push(String(c)));
  bot.on('chunkColumnUnload', (c: Vec3) => ev.unloads.push(String(c)));
  return ev;
}

/** A log (or another block) of a forest column, from the column itself. */
function findIn(col: any, cx: number, cz: number, names: string[]): Vec3 {
  for (let y = GROUND_Y + 1; y < GROUND_Y + 12; y++) {
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        const s = col.getBlockStateId(new Vec3(x, y, z));
        if (names.includes(Block.fromStateId(s, 0).name)) return new Vec3(cx * 16 + x, y, cz * 16 + z);
      }
    }
  }
  throw new Error(`no ${names.join('/')} in column ${cx},${cz}`);
}

// -- one bot against mineflayer's own world -------------------------------------------------------------------------

test("blockAt, getBlockStateId and the events equal mineflayer's own world on the same packet stream", async () => {
  const world = newWorld();
  const ref = mineflayerBot(new Vec3(0, GROUND_Y + 1, 0), 'Ref');
  const sh = sharedBot(world);
  const bots = [ref, sh];
  const evRef = record(ref);
  const evSh = record(sh);
  login(bots);
  sendForest(bots, 2);
  // A new column is readable once the writer has published it, a few ms after its packet: not yet.
  assert.equal(sh.blockAt(new Vec3(3, GROUND_Y, 3)), null, 'not published yet');
  assert.equal(sh.world.getColumn(0, 0), undefined);
  assert.equal(evSh.loads.length, 0);
  await world.settle();
  assert.equal(evSh.loads.length, 25);
  assert.deepEqual(evSh.loads, evRef.loads, 'chunkColumnLoad: the same columns, in the same order');
  for (const [cx, cz] of [[0, 0], [-2, 1], [2, -2]] as const) assert.deepEqual(compareColumn(ref, sh, cx, cz), [], `column ${cx},${cz}`);
  // Outside: no column, as mineflayer.
  for (const p of [new Vec3(100, 64, 0), new Vec3(0, 64, -60)]) {
    assert.equal(sh.blockAt(p), ref.blockAt(p));
    assert.equal(sh.world.getBlockStateId(p), ref.world.getBlockStateId(p));
  }
  // Above and below the world inside a loaded column: air, as prismarine.
  assert.equal(describe(sh.blockAt(new Vec3(1, 400, 1))), describe(ref.blockAt(new Vec3(1, 400, 1))));
  assert.equal(describe(sh.blockAt(new Vec3(1, -100, 1))), describe(ref.blockAt(new Vec3(1, -100, 1))));

  // Block changes: each bot sees its change at once (the shared bot through its overlay, before the writer applies it).
  const log = findIn(forestColumn(0, 0), 0, 0, ['oak_log', 'birch_log']);
  const was = ref.blockAt(log).name;
  const named: string[] = [];
  for (const b of bots) b.on(`blockUpdate:${log}`, (o: any, n: any) => named.push(`${b === ref ? 'ref' : 'sh'} ${o.name}>${n.name}`));
  change(bots, log.x, log.y, log.z, 0);
  assert.equal(describe(sh.blockAt(log)), describe(ref.blockAt(log)), 'the change at once');
  assert.equal(sh.blockAt(log).name, 'air');
  assert.deepEqual(named, [`ref ${was}>air`, `sh ${was}>air`], "blockUpdate:(x, y, z), in the packet's handler");
  multi(bots, 1, 4, 1, [[17, 70, 18, GOLD], [20, 71, 30, GLASS], [17, 70, 18, STONE]]);
  emit(bots, 'explosion', { x: -10.5, y: GROUND_Y + 0.3, z: -9.7, affectedBlockOffsets: [{ x: 0, y: 0, z: 0 }, { x: 1, y: -1, z: 0 }, { x: 0, y: -2, z: 1 }] });
  for (const p of [new Vec3(17, 70, 18), new Vec3(20, 71, 30), new Vec3(-11, GROUND_Y, -10), new Vec3(-10, GROUND_Y - 1, -10)]) {
    assert.equal(describe(sh.blockAt(p)), describe(ref.blockAt(p)), `at once ${p}`);
  }
  unload(bots, 2, 2);
  assert.equal(sh.blockAt(new Vec3(40, 60, 40)), null);
  assert.equal(ref.blockAt(new Vec3(40, 60, 40)), null);
  await world.settle();
  // And once the writer has applied them: the same from the store, the overlay empty.
  for (const [cx, cz] of [[0, 0], [1, 1], [-1, -1]] as const) assert.deepEqual(compareColumn(ref, sh, cx, cz), [], `after the writer, ${cx},${cz}`);
  assert.equal(world.stats().shared?.overlay, 0);
  assert.deepEqual(evSh.blocks, evRef.blocks, 'blockUpdate: the same changes, old and new blocks, one position object');
  assert.deepEqual(evSh.unloads, evRef.unloads);
  assert.equal(world.stats().decoded, 25, 'each column decoded once, on the writer');
});

test('findBlocks and findBlock answer as mineflayer: by ids (the store, over the bot\'s own columns) and with a matcher', async () => {
  const world = newWorld();
  const ref = mineflayerBot(new Vec3(5, GROUND_Y + 1, -3), 'Ref');
  const sh = sharedBot(world, new Vec3(5, GROUND_Y + 1, -3));
  const bots = [ref, sh];
  login(bots);
  sendForest(bots, 3);
  // Another bot holds columns this one does not: they are in the store, not in this bot's world.
  const other = sharedBot(world, new Vec3(160, GROUND_Y + 1, 0), 'Other');
  login([other]);
  for (let cx = 4; cx <= 6; cx++) for (let cz = -1; cz <= 1; cz++) sendCol([other], cx, cz, forestColumn(cx, cz));
  await world.settle();
  const flat = (ps: Vec3[]): string => ps.map(String).join(' ');
  const queries: Array<Record<string, unknown>> = [
    { matching: LOGS, maxDistance: 48, count: 64 },
    { matching: blockIdOf('oak_log'), maxDistance: 32 },
    { matching: [blockIdOf('iron_ore'), blockIdOf('coal_ore')], maxDistance: 16, count: 8, point: new Vec3(-7, 40, 9) },
    { matching: LOGS, maxDistance: 80, count: 500 },
    { matching: (b: any) => b && b.name.endsWith('_leaves'), maxDistance: 20, count: 30 },
    { matching: (b: any) => b.name === 'water', maxDistance: 24, count: 10, useExtraInfo: true },
    { matching: LOGS, maxDistance: 24, count: 10, useExtraInfo: (b: any) => b.position.y > GROUND_Y + 2 },
  ];
  for (const q of queries) {
    const want = ref.findBlocks(q);
    assert.ok(want.length > 0, `${JSON.stringify(q)} finds something`);
    assert.equal(flat(sh.findBlocks(q)), flat(want), JSON.stringify(q));
  }
  assert.equal(describe(sh.findBlock({ matching: LOGS, maxDistance: 32 })), describe(ref.findBlock({ matching: LOGS, maxDistance: 32 })));
  assert.equal(sh.findBlock({ matching: blockIdOf('diamond_block'), maxDistance: 32 }), null);
  // The other bot's columns (x 64..111) are not this bot's: nothing found there, as mineflayer.
  const far = { matching: LOGS, maxDistance: 16, count: 5, point: new Vec3(88, GROUND_Y + 2, 8) };
  assert.equal(flat(sh.findBlocks(far)), '');
  assert.ok(other.findBlocks(far).length > 0);
  // A change heard is searched once the writer has it.
  const log = sh.findBlocks({ matching: LOGS, maxDistance: 32 })[0] as Vec3;
  change(bots, log.x, log.y, log.z, 0);
  await world.settle();
  assert.equal(flat(sh.findBlocks({ matching: LOGS, maxDistance: 48, count: 64 })), flat(ref.findBlocks({ matching: LOGS, maxDistance: 48, count: 64 })));
});

test('raycasts and canSeeBlock answer as prismarine-world over the bot\'s own world', async () => {
  const world = newWorld();
  const ref = mineflayerBot(new Vec3(8.5, GROUND_Y + 1, 8.5), 'Ref');
  const sh = sharedBot(world, new Vec3(8.5, GROUND_Y + 1, 8.5));
  for (const b of [ref, sh]) b.entity.eyeHeight = 1.62;
  login([ref, sh]);
  sendForest([ref, sh], 2);
  await world.settle();
  const from = new Vec3(8.5, GROUND_Y + 2.62, 8.5);
  let n = 0;
  for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.21) {
    for (const pitch of [-0.6, -0.2, 0, 0.15, 0.4]) {
      const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      const a = ref.world.raycast(from, dir, 40);
      const b = sh.world.raycast(from, dir, 40);
      assert.equal(b ? `${b.position} ${b.face} ${b.intersect} ${b.name}` : 'null', a ? `${a.position} ${a.face} ${a.intersect} ${a.name}` : 'null');
      if (a) n++;
    }
  }
  assert.ok(n > 50, `${n} hits`);
  for (const p of [new Vec3(8, GROUND_Y, 12), new Vec3(20, GROUND_Y, 4), new Vec3(3, GROUND_Y + 5, 9), new Vec3(30, GROUND_Y - 3, 30)]) {
    assert.equal(sh.canSeeBlock(sh.blockAt(p)), ref.canSeeBlock(ref.blockAt(p)), `canSeeBlock ${p}`);
  }
});

test('block entities: from map_chunk and tile_entity_data, kept per column for every bot that holds it', async () => {
  const world = newWorld();
  const ref = mineflayerBot(undefined, 'Ref');
  const a = sharedBot(world, undefined, 'A');
  const b = sharedBot(world, undefined, 'B');
  const bots = [ref, a, b];
  login(bots);
  const col = forestColumn(0, 0, [[3, GROUND_Y + 1, 4, stateOf('chest')], [5, GROUND_Y + 1, 5, stateOf('oak_sign')]]);
  const chestNbt = nbt.comp({ Items: nbt.list(nbt.comp([])), id: nbt.string('minecraft:chest') });
  const signNbt = nbt.comp({ front_text: nbt.comp({ messages: nbt.list(nbt.string(['"a"', '"b"', '""', '""'])) }) });
  sendCol(bots, 0, 0, col, {
    blockEntities: [
      { x: 3, y: GROUND_Y + 1, z: 4, type: 1, nbtData: chestNbt },
      { x: 5, y: GROUND_Y + 1, z: 5, type: 7, nbtData: signNbt },
    ],
  });
  await world.settle();
  const chest = new Vec3(3, GROUND_Y + 1, 4);
  const sign = new Vec3(5, GROUND_Y + 1, 5);
  for (const bot of [a, b]) {
    assert.deepEqual(bot.blockAt(chest).entity, ref.blockAt(chest).entity);
    assert.deepEqual(bot.blockAt(chest).blockEntity, ref.blockAt(chest).blockEntity);
    assert.deepEqual(bot.blockAt(sign).blockEntity, ref.blockAt(sign).blockEntity);
    assert.equal(bot.blockAt(new Vec3(4, GROUND_Y + 1, 4)).entity, undefined);
  }
  const heard: unknown[] = [];
  for (const bot of bots) bot.on('blockEntityData', (blk: any) => heard.push(JSON.stringify(blk.blockEntity)));
  const newer = nbt.comp({ Items: nbt.list(nbt.comp([])), id: nbt.string('minecraft:chest'), CustomName: nbt.string('"Coffre"') });
  emit(bots, 'tile_entity_data', { location: { x: 3, y: GROUND_Y + 1, z: 4 }, action: 1, nbtData: newer });
  assert.equal(heard.length, 3);
  assert.equal(new Set(heard).size, 1, 'every bot heard the same block entity');
  assert.deepEqual(a.blockAt(chest).blockEntity, ref.blockAt(chest).blockEntity);
  // One copy per column: b sees what a's packet set.
  emit([a], 'tile_entity_data', { location: { x: 5, y: GROUND_Y + 1, z: 5 }, action: 9, nbtData: newer });
  assert.deepEqual(b.blockAt(sign).entity, newer);
});

test('physics and A* over a shared bot\'s world: the same moves and the same paths as over mineflayer\'s own', async () => {
  const world = newWorld();
  const start = new Vec3(8.5, GROUND_Y + 1, 8.5);
  const ref = mineflayerBot(start.clone(), 'Ref');
  const sh = sharedBot(world, start.clone());
  login([ref, sh]);
  sendForest([ref, sh], 2);
  await world.settle();
  // Physics: forty ticks walking and jumping through the forest (trees, a pond), one tick at a time in both worlds.
  const physicsBot = (bot: any): any => {
    bot.entity = { ...bot.entity, position: start.clone(), velocity: new Vec3(0, 0, 0), onGround: false, yaw: 0.7, pitch: 0, effects: {}, attributes: {} };
    bot.inventory = { slots: [] };
    bot.jumpTicks = 0;
    bot.jumpQueued = false;
    bot.fireworkRocketDuration = 0;
    return bot;
  };
  const tracks: string[][] = [];
  for (const bot of [physicsBot(ref), physicsBot(sh)]) {
    const physics = Physics(registry, { getBlock: (p: Vec3) => bot.blockAt(p, false) });
    const track: string[] = [];
    for (let t = 0; t < 120; t++) {
      bot.entity.yaw = 0.7 + t * 0.03;
      const control = { forward: true, back: false, left: false, right: false, jump: t % 9 < 2, sprint: t > 30, sneak: false };
      const st = new PlayerState(bot, control);
      physics.simulatePlayer(st, { getBlock: (p: Vec3) => bot.blockAt(p, false) }).apply(bot);
      track.push(`${bot.entity.position.x.toFixed(6)},${bot.entity.position.y.toFixed(6)},${bot.entity.position.z.toFixed(6)} ${bot.entity.onGround} ${bot.entity.isInWater}`);
    }
    tracks.push(track);
  }
  assert.deepEqual(tracks[1], tracks[0]);
  assert.notEqual(tracks[0]![0], tracks[0]![119], 'it moved');
  // A*: mineflayer-pathfinder's Movements and AStar on the main thread, over each bot's blockAt.
  const pathBot = (bot: any): any => {
    bot.entity = { position: new Vec3(8, GROUND_Y + 1, 8), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, effects: {} };
    bot.entities = {};
    bot.inventory = { slots: [], items: () => [] };
    bot.pathfinder = { bestHarvestTool: () => null };
    return bot;
  };
  for (const [gx, gz] of [[30, -20], [-25, 28], [5, 33]] as const) {
    const paths: string[] = [];
    for (const bot of [pathBot(ref), pathBot(sh)]) {
      const m = new Movements(bot);
      m.allowParkour = false;
      const a = new AStar(new Move(8, GROUND_Y + 1, 8, 0, 0), m, new goals.GoalNearXZ(gx, gz, 1), 5_000, 40, -1);
      let r = a.compute();
      while (r.status === 'partial') r = a.compute();
      paths.push(`${r.status} ${r.path.map((n: any) => `${n.x},${n.y},${n.z}`).join(' ')}`);
    }
    assert.equal(paths[1], paths[0], `goal ${gx},${gz}`);
    assert.match(paths[0] as string, /^success/);
  }
});

test("the archers' inline aim reads a shared bot's world as it reads mineflayer's (unknown -1)", async () => {
  const world = newWorld();
  const ref = mineflayerBot(undefined, 'Ref');
  const sh = sharedBot(world);
  login([ref, sh]);
  sendForest([ref, sh], 1);
  await world.settle();
  const wa = botWorld(ref) as any;
  const wb = botWorld(sh) as any;
  for (const [x, y, z] of [[3, GROUND_Y, 3], [20, GROUND_Y + 4, -5], [-15, 10, 14], [100, 64, 0], [5, 400, 5], [-1, GROUND_Y + 1, -1]]) {
    assert.equal(wb.stateIdIn(0, x, y, z), wa.stateIdIn(0, x, y, z), `${x},${y},${z}`);
  }
  assert.equal(wb.stateIdIn(0, 100, 64, 0), -1);
});

// -- what only the shared world has ---------------------------------------------------------------------------------

test('two bots sharing columns: each column decoded once; a change both hear is applied once, and each sees it when it hears it', async () => {
  const world = newWorld();
  const a = sharedBot(world, undefined, 'A');
  const b = sharedBot(world, undefined, 'B');
  login([a, b]);
  sendForest([a, b], 1);
  await world.settle();
  assert.equal(world.stats().decoded, 9, 'one decode per column, not one per bot');
  assert.equal(world.stats().held, 9);
  assert.equal(world.stats().shared?.bots, 2);
  // b's socket is ahead: it hears the change first. It sees it at once; a does not (it has not heard it).
  const p = new Vec3(4, GROUND_Y + 3, 4);
  const before = a.blockAt(p).stateId;
  change([b], p.x, p.y, p.z, GOLD);
  assert.equal(b.blockAt(p).stateId, GOLD);
  assert.equal(a.blockAt(p).stateId, before);
  await world.settle();
  assert.equal(world.stats().dropped, 1, "b is not the column's primary: its copy is not sent");
  assert.equal(a.blockAt(p).stateId, before, 'the store has not got it: a, its primary, has not heard it');
  assert.equal(b.blockAt(p).stateId, GOLD, "b's overlay still shows it");
  change([a], p.x, p.y, p.z, GOLD);
  assert.equal(a.blockAt(p).stateId, GOLD);
  await world.settle();
  assert.equal(world.stats().dropped, 1);
  assert.equal(world.stats().shared?.overlay, 0, 'the store shows it now: both overlays are empty');
  for (const bot of [a, b]) assert.equal(bot.blockAt(p).stateId, GOLD);
  // A column only b receives later: a does not see it, b does.
  sendCol([b], 5, 5, forestColumn(5, 5));
  await world.settle();
  assert.equal(a.blockAt(new Vec3(85, GROUND_Y, 85)), null);
  assert.ok(b.blockAt(new Vec3(85, GROUND_Y, 85)));
  // A column a already holds, sent to b: readable for b at once (the store has it), its chunkColumnLoad at once.
  const loads: string[] = [];
  const c = sharedBot(world, undefined, 'C');
  c.on('chunkColumnLoad', (v: Vec3) => loads.push(String(v)));
  login([c]);
  sendCol([c], 0, 0, forestColumn(0, 0));
  assert.deepEqual(loads, ['(0, 0, 0)']);
  assert.ok(c.blockAt(new Vec3(1, GROUND_Y, 1)));
});

test("a bot leaving: the others keep reading; what only it held goes cached; a new primary replays the changes only it had heard", async () => {
  const world = newWorld();
  const a = sharedBot(world, undefined, 'A');
  const b = sharedBot(world, undefined, 'B');
  login([a, b]);
  for (let cx = -1; cx <= 1; cx++) sendCol([a], cx, 0, forestColumn(cx, 0)); // a: x -1..1
  for (let cx = 0; cx <= 2; cx++) sendCol([b], cx, 0, forestColumn(cx, 0)); // b: x 0..2 (a is the primary of 0 and 1)
  await world.settle();
  // b hears a change in column 1 before a does (dropped: a is the primary); then a leaves without hearing it.
  const p = new Vec3(20, GROUND_Y + 2, 5);
  change([b], p.x, p.y, p.z, GLASS);
  await world.settle();
  assert.equal(world.stats().dropped, 1);
  a.emit('end');
  assert.equal(a.blockAt(new Vec3(1, GROUND_Y, 1)), null, "a's world is empty");
  assert.equal(a.world.size, 0);
  await world.settle();
  assert.equal(world.stats().resyncs, 1, "b, column 1's new primary, sent the change its overlay showed");
  assert.equal(world.stats().shared?.overlay, 0);
  const r = world.reader;
  r.enter();
  try {
    assert.equal(r.stateId(OVERWORLD, p.x, p.y, p.z), GLASS, 'in the store');
    assert.equal(r.stateId(OVERWORLD, -10, GROUND_Y, 3), -1, 'column -1 (a only): cached, unknown');
  } finally {
    r.leave();
  }
  assert.deepEqual([world.stats().held, world.stats().columnsLive, world.stats().columnsCached], [3, 3, 1]);
  for (let cx = 0; cx <= 2; cx++) assert.ok(b.blockAt(new Vec3(cx * 16 + 3, GROUND_Y, 3)), `b reads column ${cx}`);
  assert.equal(b.blockAt(p).stateId, GLASS);
  assert.equal(world.stats().shared?.bots, 1);
});

test('a change of dimension: every column unloads with its event, blockUpdate waiters hear (null, null), the new world loads', async () => {
  const world = newWorld();
  const ref = mineflayerBot(undefined, 'Ref');
  const sh = sharedBot(world);
  const bots = [ref, sh];
  const ev = [record(ref), record(sh)];
  login(bots);
  sendForest(bots, 1);
  await world.settle();
  const waiting: string[] = [];
  for (const b of bots) b.once('blockUpdate:(1, 64, 1)', (o: unknown, n: unknown) => waiting.push(`${b === ref ? 'ref' : 'sh'} ${o} ${n}`));
  emit(bots, 'respawn', { worldState: { dimension: 1, name: NETHER }, copyMetadata: false });
  for (const b of bots) b.game = { minY: 0, height: 256, dimension: 'the_nether' };
  assert.deepEqual(waiting.sort(), ['ref null null', 'sh null null']);
  assert.deepEqual(ev[1]!.unloads.sort(), ev[0]!.unloads.sort());
  assert.equal(ev[1]!.unloads.length, 9);
  assert.equal(sh.blockAt(new Vec3(3, GROUND_Y, 3)), null);
  const n = new Chunk({ minY: 0, worldHeight: 256 });
  n.setBlockStateId(new Vec3(1, 30, 1), stateOf('netherrack'));
  sendCol(bots, 0, 0, n);
  await world.settle();
  assert.equal(sh.world.dim, NETHER);
  assert.equal(describe(sh.blockAt(new Vec3(1, 30, 1))), describe(ref.blockAt(new Vec3(1, 30, 1))));
  assert.equal(describe(sh.blockAt(new Vec3(1, 200, 1))), describe(ref.blockAt(new Vec3(1, 200, 1))));
  assert.equal(sh.blockAt(new Vec3(17, 30, 1)), null);
  assert.deepEqual(ev[1]!.loads, ev[0]!.loads);
  // The overworld's columns went cached (no bot holds them); a respawn into the same world keeps the columns.
  assert.deepEqual([world.stats().columnsLive, world.stats().columnsCached], [1, 9]);
  emit(bots, 'respawn', { worldState: { dimension: 1, name: NETHER }, copyMetadata: true });
  assert.ok(sh.blockAt(new Vec3(1, 30, 1)));
});

test('the spawn waits for the chunks: waitForChunksToLoad resolves once the writer has published the 5×5 around the bot', async () => {
  const world = newWorld();
  const sh = sharedBot(world, new Vec3(24.5, GROUND_Y + 1, 24.5));
  sh.entity.height = 1.8;
  login([sh]);
  for (let cx = -1; cx <= 3; cx++) for (let cz = -1; cz <= 0; cz++) sendCol([sh], cx, cz, forestColumn(cx, cz)); // 10 of the 5×5 around chunk (1, 1)
  let done = false;
  const wait = sh.waitForChunksToLoad().then(() => (done = true));
  await world.settle();
  assert.equal(done, false, '15 of the 25 columns are missing');
  for (let cx = -1; cx <= 3; cx++) for (let cz = 1; cz <= 3; cz++) sendCol([sh], cx, cz, forestColumn(cx, cz));
  assert.equal(done, false, 'sent, not published yet');
  await wait;
  assert.ok(sh.world.getColumnAt(sh.entity.position));
  // Already there: at once.
  await sh.waitForChunksToLoad();
});

test("digging's prediction: the digging bot sees air at once, the others the store; the server's word or OVERLAY_MS settles it", async () => {
  const world = newWorld();
  const a = sharedBot(world, undefined, 'A');
  const b = sharedBot(world, undefined, 'B');
  login([a, b]);
  sendForest([a, b], 1);
  await world.settle();
  const log = findIn(forestColumn(0, 0), 0, 0, ['oak_log', 'birch_log']);
  const name = a.blockAt(log).name;
  let completed: string | null = null;
  a.once(`blockUpdate:${log}`, (_o: any, n: any) => (completed = n.name));
  a._updateBlockState(log, 0); // digging.js finishDigging
  assert.equal(completed, 'air', "digging's waiter heard its own prediction");
  assert.equal(a.blockAt(log).name, 'air');
  assert.equal(b.blockAt(log).name, name, 'the others: the store, the server has not spoken');
  await world.settle();
  assert.equal(b.blockAt(log).name, name, 'a prediction is never sent to the store');
  // The server confirms: both hear it, the store applies it, the overlays empty.
  change([a, b], log.x, log.y, log.z, 0);
  await world.settle();
  for (const bot of [a, b]) assert.equal(bot.blockAt(log).name, 'air');
  assert.equal(world.stats().shared?.overlay, 0);
  // A prediction the server never confirms: after OVERLAY_MS the store wins.
  const other = log.offset(0, 1, 0);
  const stays = a.blockAt(other).name;
  a._updateBlockState(other, 0);
  assert.equal(a.blockAt(other).name, 'air');
  assert.equal((a.world as SharedBotWorld)._prune(Number.MAX_SAFE_INTEGER, Date.now() + OVERLAY_MS + 1), false);
  assert.equal(a.blockAt(other).name, stays);
  assert.equal(world.stats().shared?.expired, 1);
});

test('encode.mjs: a store column back into a payload that decode.mjs and prismarine-chunk read block for block', () => {
  const tables = buildStateTables(registry);
  const opts = decoderOptions(registry, tables);
  const col = forestColumn(2, -3);
  // The store's form of it: one value per uniform section, else the 4 096 ids in (y, z, x) order.
  const sections: Array<number | Uint16Array> = [];
  const scratch = new Uint16Array(4096);
  decodeColumn(new Uint8Array(col.dump()), 24, opts, scratch, (i, kind, value) => {
    sections[i] = kind === FULL ? scratch.slice() : value;
  });
  assert.ok(sections.some((s) => typeof s === 'number') && sections.some((s) => typeof s !== 'number'));
  const bytes = encodeColumn(sections, opts);
  const back: Array<number | Uint16Array> = [];
  decodeColumn(bytes, 24, opts, scratch, (i, kind, value) => {
    back[i] = kind === FULL ? scratch.slice() : value;
  });
  assert.deepEqual(back, sections);
  const parsed = new Chunk({ minY: -64, worldHeight: 384 });
  parsed.load(Buffer.from(bytes));
  let bad = 0;
  const p = new Vec3(0, 0, 0);
  for (p.y = -64; p.y < 320; p.y++) for (p.z = 0; p.z < 16; p.z++) for (p.x = 0; p.x < 16; p.x++) if (parsed.getBlockStateId(p) !== col.getBlockStateId(p)) bad++;
  assert.equal(bad, 0);
});

test('a writer that dies: the bots\' columns are rebuilt from the store and the unacknowledged batches; the third death in a minute makes this thread the writer', async () => {
  const world = newWorld({ writerUrl: new URL('./fixtures/deaf-writer.mjs', import.meta.url) });
  const ref = mineflayerBot(undefined, 'Ref');
  const sh = sharedBot(world);
  const bots = [ref, sh];
  login(bots);
  sendForest(bots, 1);
  await world.settle();
  change(bots, 3, GROUND_Y + 5, 3, GOLD);
  await world.settle();
  const loads: string[] = [];
  sh.on('chunkColumnLoad', (c: Vec3) => loads.push(String(c)));
  // Unacknowledged when the writer dies (it stops answering first): a block change, a new column and a re-sent one
  // (the dead writer may have half-decoded it: its payload, kept until the acknowledgement, is sent again).
  (world as any).writer.postMessage({ t: 'deaf' });
  change(bots, 4, GROUND_Y + 5, 4, GLASS);
  sendCol(bots, 2, 0, forestColumn(2, 0));
  const resent = forestColumn(-1, 0, [[-8, GROUND_Y + 6, 8, GOLD]]);
  sendCol(bots, -1, 0, resent);
  (world as any).flush();
  assert.ok((world.stats().shared?.unacked ?? 0) > 0, 'payloads kept until acknowledged');
  await world.killWriter();
  await until(() => world.stats().restarts === 1, 5_000, 'the restart');
  await world.settle();
  for (const [cx, cz] of [[0, 0], [1, -1], [2, 0]] as const) assert.deepEqual(compareColumn(ref, sh, cx, cz, 50), [], `after the restart, ${cx},${cz}`);
  assert.equal(sh.blockAt(new Vec3(3, GROUND_Y + 5, 3)).stateId, GOLD, 'applied before the death: read back from the store');
  assert.equal(sh.blockAt(new Vec3(4, GROUND_Y + 5, 4)).stateId, GLASS, 'unacknowledged: re-sent');
  assert.equal(sh.blockAt(new Vec3(-8, GROUND_Y + 6, 8)).stateId, GOLD, 'the unacknowledged re-send of a column');
  assert.deepEqual(compareColumn(ref, sh, -1, 0, 50), []);
  assert.equal(world.stats().resyncs, 10);
  assert.equal(world.stats().writer, 'up');
  assert.ok(loads.length >= 10, `every column announced again (${loads.length})`);
  // Two more deaths within the minute: this thread writes the store from now on, and the bots still read.
  await world.killWriter();
  await until(() => world.stats().restarts === 2, 5_000, 'the second restart');
  await world.settle();
  await world.killWriter();
  await until(() => world.stats().writer === 'inline', 5_000, 'inline');
  await world.settle();
  for (const [cx, cz] of [[0, 0], [-1, 1], [2, 0]] as const) assert.deepEqual(compareColumn(ref, sh, cx, cz, 50), [], `inline, ${cx},${cz}`);
  change(bots, 5, GROUND_Y + 5, 5, STONE);
  sendCol(bots, 3, 0, forestColumn(3, 0));
  await world.settle();
  assert.deepEqual(compareColumn(ref, sh, 3, 0, 50), []);
  assert.equal(sh.blockAt(new Vec3(5, GROUND_Y + 5, 5)).stateId, STONE);
  assert.equal(world.stats().shared?.overlay, 0);
});

// -- world.shared off, config, the pool's seam ------------------------------------------------------------------------

test('world.shared off changes nothing: no blocks plugin, the bots keep mineflayer\'s own world', async () => {
  const off = newWorld({ shared: false });
  assert.equal(off.blocksPlugin(), null);
  assert.equal(off.shared, false);
  const ref = mineflayerBot(undefined, 'Ref');
  off.attach(ref);
  assert.equal(off.bindView(ref), null);
  login([ref]);
  sendForest([ref], 1);
  await off.settle();
  assert.equal(ref.world.constructor.name, 'WorldSync', "prismarine-world's own");
  assert.equal(off.stats().columnsLive, 9, 'the store is fed as in P1');
  assert.equal(off.stats().shared, undefined);
  // The pool passes no blocks plugin to createBot.
  const reqs: SpawnRequest[] = [];
  const pool = new BotPool({
    host: 'x',
    port: 1,
    staggerMs: 1,
    setup: () => undefined,
    world: off,
    createBot: (req) => {
      reqs.push(req);
      const b = new FakeBot(req.username);
      setTimeout(() => b.emit('spawn'), 1);
      return b as never;
    },
  });
  pool.add('Off1');
  await until(() => pool.status('Off1') === 'online', 1_000, 'online');
  assert.equal(reqs[0]?.blocks, undefined);
  pool.stop();
});

test("with world.shared the pool hands createBot the shared world's blocks plugin", async () => {
  const world = newWorld();
  const reqs: SpawnRequest[] = [];
  const pool = new BotPool({
    host: 'x',
    port: 1,
    staggerMs: 1,
    setup: () => undefined,
    world,
    createBot: (req) => {
      reqs.push(req);
      const b = new FakeBot(req.username);
      setTimeout(() => b.emit('spawn'), 1);
      return b as never;
    },
  });
  pool.add('Shared1');
  await until(() => pool.status('Shared1') === 'online', 1_000, 'online');
  assert.equal(typeof reqs[0]?.blocks, 'function');
  pool.stop();
  // A bot the shared world cannot take any more (it stopped) gets mineflayer's own blocks plugin: its own world.
  await world.stop();
  const lone: any = new EventEmitter();
  Object.assign(lone, { registry, version: VERSION, supportFeature: registry.supportFeature, game: { minY: -64, height: 384 }, _client: new EventEmitter() });
  (reqs[0]?.blocks as (b: unknown, o: unknown) => void)(lone, { hideErrors: true });
  login([lone]);
  assert.equal(lone.world.constructor.name, 'WorldSync');
});

test('config: world.shared defaults to on (off with an explicit world.enabled false); on, it turns the shared world on; with world.enabled false it is an error', () => {
  const env = { PAULSBRAWLS_SQUAD_TOKEN: 't' };
  assert.equal(parseConfig({}, env).world.shared, true);
  assert.equal(parseConfig({ world: { enabled: false } }, env).world.shared, false);
  assert.deepEqual(parseConfig({ world: { shared: true } }, env).world, { enabled: true, cacheSeconds: 60, cacheColumns: 2_000, verify: false, shared: true });
  assert.throws(() => parseConfig({ world: { shared: true, enabled: false } }, env), ConfigError);
  assert.throws(() => parseConfig({ world: { shared: 'yes' } }, env), ConfigError);
});

test("world.shared's protocol: map_chunk and update_light read their light as bytes; every other field as minecraft-data's", () => {
  // Compiled on copies of minecraft-data's protocol, as minecraft-protocol compiles it (its own cache would keep the
  // first one this process made, and its merge writes into minecraft-data's object).
  const merge = require('lodash.merge') as (a: unknown, b: unknown) => any;
  const { ProtoDefCompiler } = (require('protodef') as any).Compiler;
  const mcData = require('minecraft-data')(VERSION) as any;
  const compile = (protocol: unknown): any => {
    const c = new ProtoDefCompiler();
    c.addTypes(require('minecraft-protocol/src/datatypes/compiler-minecraft'));
    c.addProtocol(protocol, ['play', 'toClient']);
    nbt.addTypesToCompiler('big', c);
    return c.compileProtoDefSync();
  };
  const custom = merge(structuredClone(mcData.protocol), SHARED_WORLD_PACKETS['1.21']);
  const full = structuredClone(mcData.protocol);
  for (const name of ['packet_map_chunk', 'packet_update_light']) {
    const ours = custom.play.toClient.types[name][1] as Array<{ name: string; type: unknown }>;
    const theirs = full.play.toClient.types[name][1] as Array<{ name: string; type: unknown }>;
    const light = ours.findIndex((f) => f.name === 'light');
    assert.deepEqual(ours.slice(0, light), theirs.slice(0, light), `${name}: the fields before the light`);
    assert.equal(theirs[light]?.name, 'skyLightMask', `${name}: the light starts where minecraft-data's does`);
    assert.equal(ours.length, theirs.length);
  }
  const fullProto = compile(full);
  const ourProto = compile(custom);
  const light = Array.from({ length: 26 }, (_, i) => Array.from({ length: 2048 }, (_, j) => (i + j) & 255));
  const params = {
    x: 3,
    z: -7,
    heightmaps: { type: 'compound', name: '', value: {} },
    chunkData: forestColumn(3, -7).dump(),
    blockEntities: [{ x: 3, y: 64, z: 9, type: 1, nbtData: nbt.comp({ id: nbt.string('minecraft:chest') }) }],
    skyLightMask: [[0, 0x3ffffff]],
    blockLightMask: [[0, 0x3ffffff]],
    emptySkyLightMask: [[0, 0]],
    emptyBlockLightMask: [[0, 0]],
    skyLight: light,
    blockLight: light,
  };
  const buf = fullProto.createPacketBuffer('packet', { name: 'map_chunk', params });
  const got = ourProto.parsePacketBuffer('packet', buf).data.params;
  assert.deepEqual([got.x, got.z], [3, -7]);
  assert.ok(Buffer.compare(got.chunkData, params.chunkData) === 0, 'chunkData, byte for byte');
  assert.deepEqual(got.blockEntities, fullProto.parsePacketBuffer('packet', buf).data.params.blockEntities);
  assert.ok(Buffer.isBuffer(got.light) && got.light.length > 100_000, 'the light, unread');
  const lightBuf = fullProto.createPacketBuffer('packet', { name: 'update_light', params: { chunkX: -2, chunkZ: 5, ...params, x: undefined, z: undefined } });
  const lit = ourProto.parsePacketBuffer('packet', lightBuf).data.params;
  assert.deepEqual([lit.chunkX, lit.chunkZ], [-2, 5]);
});
