// docs/32 D: the pathfinding worker pool. A small synthetic 1.21.1 world (prismarine-chunk columns) is fed through the
// same packet listeners the pool attaches to a real bot ('login', 'map_chunk', 'block_change', 'unload_chunk'), and the
// worker's answer is compared with mineflayer-pathfinder's own A* run on this thread over the same world. Then every
// fallback to the main thread, the dedup and refcount of the mirror, the plugin's hook (patches/), and a clean stop.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { PathWorkerPool, type MirroredBot, type SearchParams } from '../src/bots/pathworkers/client';
import { movementSettings, serializeGoal } from '../src/bots/pathworkers/serialize';
import { BotPool } from '../src/bots/pool';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { until } from './fakes/harness';

holdEventLoopPerTest();

const require = createRequire(import.meta.url);
const VERSION = '1.21.1';
const registry = require('prismarine-registry')(VERSION) as any;
const Chunk = require('prismarine-chunk')(registry) as any;
const World = require('prismarine-world')(registry) as any;
const { Vec3 } = require('vec3') as { Vec3: any };
const AStar = require('mineflayer-pathfinder/lib/astar') as any;
const Movements = require('mineflayer-pathfinder/lib/movements') as any;
const Move = require('mineflayer-pathfinder/lib/move') as any;
const goals = require('mineflayer-pathfinder/lib/goals') as any;
const { pathfinder: injectPathfinder } = require('mineflayer-pathfinder') as { pathfinder: (bot: any) => void };

const STONE = registry.blocksByName.stone.defaultState as number;
const GROUND = 63;
const SILENT_WORKER = new URL('./fixtures/silent-path-worker.mjs', import.meta.url);

/** Where the wall at x = 10 lets a bot through. */
const GAP_Z = 30;

/**
 * 3×3 columns (x and z from -16 to 31): stone up to y = 63, a 2-high wall at x = 10 with a gap at z = 30 (far enough
 * that digging through is cheaper when allowed), and a small hill. Returned as the columns themselves: tests build the main-thread world and the packets from them.
 */
function buildColumns(): Map<string, any> {
  const cols = new Map<string, any>();
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      const c = new Chunk({ minY: -64, worldHeight: 384 });
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          const wx = cx * 16 + x;
          const wz = cz * 16 + z;
          for (let y = GROUND - 3; y <= GROUND; y++) c.setBlockStateId(new Vec3(x, y, z), STONE);
          if (wx === 10 && wz !== GAP_Z) for (const y of [64, 65]) c.setBlockStateId(new Vec3(x, y, z), STONE);
          if (wx >= 3 && wx <= 5 && wz >= 3 && wz <= 4) c.setBlockStateId(new Vec3(x, 64, z), STONE);
        }
      }
      cols.set(`${cx},${cz}`, c);
    }
  }
  return cols;
}

/** A bot as the pool and Movements see it: a packet stream (`_client`), a world, a game, an inventory. */
function fakeMcBot(cols: Map<string, any>): any {
  const world = new World(null, null, 0).sync;
  for (const [k, c] of cols) {
    const [x, z] = k.split(',').map(Number);
    world.setColumn(x, z, c);
  }
  const bot: any = new EventEmitter();
  bot.setMaxListeners(50);
  Object.assign(bot, {
    _client: new EventEmitter(),
    version: VERSION,
    registry,
    world,
    game: { minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, GROUND + 1, 0.5), effects: {} },
    entities: {},
    inventory: { items: () => [] },
    blockAt: (p: any) => world.getBlock(p),
    pathfinder: { bestHarvestTool: () => null },
  });
  return bot;
}

/** The packets a server sends a bot that logs in near the columns. */
function login(bot: any, cols: Map<string, any>): void {
  bot._client.emit('login', { worldState: { dimension: 0, name: 'minecraft:overworld' } });
  for (const [k, c] of cols) {
    const [x, z] = k.split(',').map(Number);
    bot._client.emit('map_chunk', { x, z, chunkData: c.dump() });
  }
}

function movementsFor(bot: any, canDig: boolean): any {
  const m = new Movements(bot);
  m.canDig = canDig;
  m.allowParkour = false;
  return m;
}

function params(bot: any, goal: unknown, movements: any, timeout = 5_000): SearchParams {
  return { start: new Move(0, GROUND + 1, 0, 0, 0), movements, goal, timeout, tickTimeout: 40, searchRadius: -1 };
}

/** The main thread's own search, to the end. */
function mainThread(p: SearchParams): any {
  const a = new AStar(p.start, p.movements, p.goal, p.timeout, p.tickTimeout, p.searchRadius);
  let r = a.compute();
  while (r.status === 'partial') r = a.compute();
  return r;
}

/** Call compute() as the plugin does (once per tick) until the search is no longer partial. */
async function settle(ctx: any, ms = 10_000): Promise<any> {
  let r = ctx.compute();
  const end = Date.now() + ms;
  while (r.status === 'partial') {
    if (Date.now() > end) throw new Error('the offloaded search never settled');
    await new Promise((res) => setTimeout(res, 5));
    r = ctx.compute();
  }
  return r;
}

const coords = (path: any[]): number[][] => path.map((n) => [n.x, n.y, n.z]);

const pools: PathWorkerPool[] = [];
function newPool(opts: Partial<ConstructorParameters<typeof PathWorkerPool>[0]> = {}): PathWorkerPool {
  const p = new PathWorkerPool({ workers: 1, version: VERSION, ...opts });
  pools.push(p);
  return p;
}
after(async () => {
  for (const p of pools) await p.stop();
});

function attached(pool: PathWorkerPool, cols = buildColumns()): { bot: any; cols: Map<string, any> } {
  const bot = fakeMcBot(cols);
  pool.attach(bot as MirroredBot);
  pool.install(bot as MirroredBot);
  login(bot, cols);
  return { bot, cols };
}

test('the worker finds the same path as the main thread, Moves rebuilt for the executor', async () => {
  const pool = newPool();
  const { bot } = attached(pool);
  for (const canDig of [false, true]) {
    const goal = new goals.GoalBlock(12, GROUND + 1, -10);
    const local = mainThread(params(bot, goal, movementsFor(bot, canDig)));
    assert.equal(local.status, 'success');
    const ctx = bot.pathfinder.searchOffload(params(bot, goal, movementsFor(bot, canDig)));
    assert.ok(ctx, 'offloaded');
    const first = ctx.compute();
    assert.equal(first.status, 'partial', 'the first tick only posts the search');
    // Never an empty partial path: goto() would take it for "already there".
    assert.deepEqual(coords(first.path), [[0, GROUND + 1, 0]], 'the start node while waiting');
    const r = await settle(ctx);
    assert.equal(r.status, 'success');
    assert.deepEqual(coords(r.path), coords(local.path), `canDig=${canDig}`);
    assert.equal(r.cost, local.cost);
    assert.ok(r.path[0] instanceof Move && typeof r.path[0].distanceSquared === 'function', 'Move objects with Vec3 methods');
    assert.deepEqual(r.path.map((n: any) => n.toBreak.length), local.path.map((n: any) => n.toBreak.length));
    if (canDig) {
      const dug = r.path.flatMap((n: any) => n.toBreak);
      assert.ok(dug.length > 0 && dug.every((b: any) => b instanceof Vec3), 'canDig goes through the wall; toBreak are Vec3');
    }
    assert.ok(ctx.visitedChunks.size > 0, 'visitedChunks come back for the chunk_loaded re-plan');
  }
  // GoalFollow becomes a snapshot of where the entity is; composite and look-at goals cross too.
  const entity = { position: new Vec3(20.5, GROUND + 1, 5.5) };
  const more = [
    new goals.GoalFollow(entity, 2),
    new goals.GoalCompositeAny([new goals.GoalBlock(-5, GROUND + 1, 20), new goals.GoalNear(25, GROUND + 1, -5, 2)]),
    new goals.GoalLookAtBlock(new Vec3(20, GROUND, 5), bot.world),
    new goals.GoalGetToBlock(20, GROUND + 1, 12),
  ];
  for (const goal of more) {
    const local = mainThread(params(bot, goal, movementsFor(bot, false)));
    const r = await settle(bot.pathfinder.searchOffload(params(bot, goal, movementsFor(bot, false))));
    assert.equal(r.status, local.status, goal.constructor.name);
    assert.deepEqual(coords(r.path), coords(local.path), goal.constructor.name);
  }
  assert.equal(pool.stats().fallbacks.goal, undefined);
});

test('a bot carrying scaffolding: the same path as an uncached search on the main thread (blocks to place)', async () => {
  const pool = newPool();
  const { bot } = attached(pool);
  // The reference reads every block afresh, as upstream: a bot without events has no block cache.
  const plain = { registry, game: bot.game, entity: bot.entity, entities: {}, inventory: bot.inventory, blockAt: bot.blockAt, pathfinder: bot.pathfinder };
  for (const goal of [new goals.GoalBlock(4, GROUND + 6, -6), new goals.GoalNear(-6, GROUND + 5, -6, 1)]) {
    const p = (b: any): SearchParams => ({ ...params(b, goal, movementsFor(b, true)), start: new Move(0, GROUND + 1, 0, 64, 0) });
    const local = mainThread(p(plain));
    assert.equal(local.status, 'success', `${goal.constructor.name}: reachable by placing blocks`);
    const r = await settle(bot.pathfinder.searchOffload(p(bot)));
    assert.equal(r.status, 'success', goal.constructor.name);
    assert.deepEqual(coords(r.path), coords(local.path), goal.constructor.name);
    assert.ok(r.path.some((n: any) => n.toPlace.length > 0), 'the path places blocks');
  }
});

test('block changes reach the mirror; a chunk is mirrored once and kept until its last bot unloads it', async () => {
  const pool = newPool();
  const cols = buildColumns();
  const a = attached(pool, cols).bot;
  const b = fakeMcBot(cols);
  pool.attach(b);
  pool.install(b);
  login(b, cols);
  assert.equal(pool.stats().chunks, 9, 'nine chunks, whichever bots hold them');

  // Close the gap in the wall: both bots hear the change; the main-thread world gets it too.
  const gap = new Vec3(10, GROUND + 1, GAP_Z);
  for (const bot of [a, b]) bot._client.emit('block_change', { location: gap, type: STONE });
  a.world.setBlockStateId(gap, STONE);
  a.world.setBlockStateId(gap.offset(0, 1, 0), STONE);
  b._client.emit('multi_block_change', { chunkCoordinates: { x: 0, y: 4, z: GAP_Z >> 4 }, records: [(STONE << 12) | (10 << 8) | ((GAP_Z & 15) << 4) | 1] });
  const goal = new goals.GoalBlock(20, GROUND + 1, 5);
  const local = mainThread(params(a, goal, movementsFor(a, false)));
  assert.equal(local.status, 'noPath', 'the wall is closed');
  const r = await settle(a.pathfinder.searchOffload(params(a, goal, movementsFor(a, false))));
  assert.equal(r.status, 'noPath');

  // Bot a leaves the chunk the goal is in: b still holds it. Then b leaves it too: it is gone from the mirror.
  const near = new goals.GoalBlock(2, GROUND + 1, 2);
  a._client.emit('unload_chunk', { chunkX: 0, chunkZ: 0 });
  assert.equal(pool.stats().chunks, 9);
  assert.equal((await settle(a.pathfinder.searchOffload(params(a, near, movementsFor(a, false))))).status, 'success');
  b._client.emit('unload_chunk', { chunkX: 0, chunkZ: 0 });
  assert.equal(pool.stats().chunks, 8);
  assert.equal((await settle(a.pathfinder.searchOffload(params(a, near, movementsFor(a, false))))).status, 'noPath');
  // A disconnect releases everything the bot held; a new dimension too.
  b.emit('end');
  assert.equal(pool.stats().chunks, 8, 'a still holds the other eight');
  a._client.emit('respawn', { worldState: { dimension: 1, name: 'minecraft:the_nether' }, copyMetadata: 0 });
  assert.equal(pool.stats().chunks, 0);
});

test('fallbacks: unknown goals, exclusion areas, subclassed Movements stay on the main thread', async () => {
  const pool = newPool();
  const { bot } = attached(pool);
  const MyGoal: any = class extends goals.GoalBlock {};
  assert.equal(bot.pathfinder.searchOffload(params(bot, new MyGoal(1, GROUND + 1, 1), movementsFor(bot, false))), null);
  assert.equal(bot.pathfinder.searchOffload(params(bot, new goals.GoalBreakBlock(1, GROUND, 1, bot), movementsFor(bot, false))), null);
  // A look-at goal over another world cannot be mirrored.
  assert.equal(bot.pathfinder.searchOffload(params(bot, new goals.GoalLookAtBlock(new Vec3(1, GROUND, 1), new World(null, null, 0).sync), movementsFor(bot, false))), null);
  const excl = movementsFor(bot, false);
  excl.exclusionAreasStep.push(() => 0);
  assert.equal(bot.pathfinder.searchOffload(params(bot, new goals.GoalBlock(1, GROUND + 1, 1), excl)), null);
  const MyMovements: any = class extends Movements {};
  assert.equal(bot.pathfinder.searchOffload(params(bot, new goals.GoalBlock(1, GROUND + 1, 1), new MyMovements(bot))), null);
  assert.deepEqual(pool.stats().fallbacks, { goal: 3, movements: 2 });

  // The serializers themselves, for the record.
  assert.equal(serializeGoal(new goals.GoalInvert(new MyGoal(0, 0, 0)), null), null);
  assert.deepEqual(serializeGoal(new goals.GoalY(70), null), { t: 'GoalY', f: { y: 70 } });
  const s = movementSettings(movementsFor(bot, true))!;
  assert.equal(s.canDig, true);
  assert.ok(s.blocksCantBreak instanceof Set && !('bot' in s) && !('blocks' in s));
});

test('a dead worker: its searches finish on the main thread, and a restarted worker gets the mirror back', async () => {
  const silent = newPool({ workerUrl: SILENT_WORKER });
  const { bot } = attached(silent);
  const goal = new goals.GoalBlock(20, GROUND + 1, 5);
  const local = mainThread(params(bot, goal, movementsFor(bot, false)));
  const ctx = bot.pathfinder.searchOffload(params(bot, goal, movementsFor(bot, false)));
  assert.equal(ctx.compute().status, 'partial');
  await silent.killWorker(0);
  await until(() => silent.stats().restarts === 1, 3_000, 'the restart');
  const r = await settle(ctx);
  assert.equal(r.status, 'success');
  assert.deepEqual(coords(r.path), coords(local.path));
  assert.equal(silent.stats().fallbacks.workerDied, 1);

  // A real worker restarted after a crash is resynced from the bots' own worlds (column.dump()).
  const pool = newPool();
  const b2 = attached(pool).bot;
  await settle(b2.pathfinder.searchOffload(params(b2, goal, movementsFor(b2, false))));
  await pool.killWorker(0);
  await until(() => pool.stats().restarts === 1, 3_000, 'the restart');
  const again = await settle(b2.pathfinder.searchOffload(params(b2, goal, movementsFor(b2, false))));
  assert.equal(again.status, 'success');
  assert.deepEqual(coords(again.path), coords(local.path));
  assert.equal(pool.stats().fallbacks.workerDied, undefined, 'nothing was in flight');
});

test('a worker that does not answer by thinkTimeout + grace: the search runs on the main thread', async () => {
  const pool = newPool({ workerUrl: SILENT_WORKER, graceMs: 0 });
  const { bot } = attached(pool);
  const goal = new goals.GoalBlock(20, GROUND + 1, 5);
  const ctx = bot.pathfinder.searchOffload(params(bot, goal, movementsFor(bot, false), 50));
  assert.equal(ctx.compute().status, 'partial');
  await new Promise((r) => setTimeout(r, 80));
  const r = ctx.compute();
  // The main-thread search starts with its own full timeout (50 ms here) and may need a few slices.
  const final = r.status === 'partial' ? await settle(ctx) : r;
  assert.ok(['success', 'timeout'].includes(final.status), final.status);
  assert.equal(pool.stats().fallbacks.deadline, 1);
});

test('a worker search that exceeds thinkTimeout answers timeout, like the main thread', async () => {
  const pool = newPool();
  const { bot } = attached(pool);
  // Unreachable and unbounded: the search would explore the whole mirror. 1 ms is never enough.
  const r = await settle(bot.pathfinder.searchOffload(params(bot, new goals.GoalBlock(500, GROUND + 1, 500), movementsFor(bot, true), 1)));
  assert.equal(r.status, 'timeout');
});

test("the plugin's hook: its own planning is offloaded, a synchronous getPathTo is not", async () => {
  const pool = newPool();
  const cols = buildColumns();
  const bot = fakeMcBot(cols);
  delete bot.pathfinder;
  Object.assign(bot, {
    entity: {
      ...bot.entity,
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      height: 1.8,
      effects: {},
      attributes: {},
      yaw: 0,
      pitch: 0,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: true,
      elytraFlying: false,
    },
    inventory: { slots: [], items: () => [] },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    controlState: {},
    setControlState: (k: string, v: boolean) => (bot.controlState[k] = v),
    clearControlStates: () => (bot.controlState = {}),
    look: () => Promise.resolve(),
    lookAt: () => Promise.resolve(),
    physics: { simulatePlayer: (s: unknown) => s },
    stopDigging: () => undefined,
  });
  injectPathfinder(bot);
  bot.pathfinder.setMovements(movementsFor(bot, false));
  pool.attach(bot);
  pool.install(bot);
  login(bot, cols);
  const offload = bot.pathfinder.searchOffload;
  let asked = 0;
  bot.pathfinder.searchOffload = (p: SearchParams) => {
    asked++;
    return offload(p);
  };

  const goal = new goals.GoalBlock(20, GROUND + 1, 5);
  const sync = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal);
  assert.equal(asked, 0, 'getPathTo searched here');
  assert.ok(['success', 'partial'].includes(sync.status));

  const updates: any[] = [];
  // The length as goto() sees it, at emit time (the executor then shifts the same array as the bot walks).
  bot.on('path_update', (r: any) => updates.push({ ...r, length: r.path.length }));
  bot.pathfinder.setGoal(goal);
  for (let i = 0; i < 400 && !updates.some((u) => u.status !== 'partial'); i++) {
    bot.emit('physicsTick');
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(asked, 1, 'the plugin planned through the hook');
  assert.equal(updates[0].status, 'partial', 'partial until the worker answers');
  assert.ok(updates.every((u) => u.length > 0), 'no empty path_update while waiting (goto would resolve on it)');
  const done = updates.find((u) => u.status !== 'partial');
  assert.equal(done?.status, 'success');
  assert.ok(done.length > 0, 'the bot got a path to walk');
  assert.equal(pool.stats().done, 1);
});

test('the bot pool attaches the mirror before the first packet and installs the hook at spawn', async () => {
  const calls: string[] = [];
  const made: FakeBot[] = [];
  const pool = new BotPool({
    host: 'x',
    port: 1,
    staggerMs: 1,
    setup: () => calls.push('setup'),
    pathWorkers: { attach: () => calls.push('attach'), install: () => calls.push('install') },
    createBot: (req) => {
      const b = new FakeBot(req.username);
      made.push(b);
      setTimeout(() => b.emit('spawn'), 1);
      return b as never;
    },
  });
  pool.add('Mirror1');
  await until(() => pool.status('Mirror1') === 'online', 1_000, 'online');
  assert.deepEqual(calls, ['attach', 'setup', 'install']);
  pool.stop();
});

test('stop terminates every worker; later searches stay on the main thread', async () => {
  const pool = newPool({ workers: 2 });
  const { bot } = attached(pool);
  assert.equal(pool.stats().alive, 2);
  await pool.stop();
  assert.equal(pool.stats().alive, 0);
  assert.equal(bot.pathfinder.searchOffload(params(bot, new goals.GoalBlock(1, GROUND + 1, 1), movementsFor(bot, false))), null);
});

test('config: pathfinding.workers defaults to 0, is an integer up to 16, and is capped at the cores but one', async () => {
  const { parseConfig, pathWorkerCount, ConfigError } = await import('../src/config');
  const env = { PAULSBRAWLS_SQUAD_TOKEN: 't' };
  assert.equal(parseConfig({}, env).pathfinding.workers, 0);
  assert.equal(parseConfig({ pathfinding: { workers: 4 } }, env).pathfinding.workers, 4);
  for (const bad of [-1, 1.5, 17, '2']) {
    assert.throws(() => parseConfig({ pathfinding: { workers: bad } }, env), ConfigError, `workers ${String(bad)}`);
  }
  assert.equal(pathWorkerCount({ astarBudgetMs: 0, workers: 8 }, 4), 3);
  assert.equal(pathWorkerCount({ astarBudgetMs: 0, workers: 2 }, 32), 2);
  assert.equal(pathWorkerCount({ astarBudgetMs: 0, workers: 2 }, 1), 0);
});
