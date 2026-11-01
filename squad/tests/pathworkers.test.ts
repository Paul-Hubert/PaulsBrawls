// docs/37 P4: A* on the reader workers, over the shared world. A small synthetic 1.21.1 world (prismarine-chunk
// columns) reaches the shared world through the same packet listeners a real bot has ('login', 'map_chunk',
// 'block_change', 'unload_chunk'), and the worker's answer is compared with mineflayer-pathfinder's own A* run on this
// thread over the bot's own copy. Then: partial paths while it searches, cancellation, thinkTimeout, a worker dying
// mid-search, what cannot cross threads, world changes, the worker's budget (and that its waits do not count against
// thinkTimeout), a silent worker, the plugin's hook, the bot pool's seam, a clean stop, the store's blocks, the config.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { type SearchParams } from '../src/bots/pathworkers/offload';
import { movementSettings, serializeGoal } from '../src/bots/pathworkers/serialize';
import { BotPool } from '../src/bots/pool';
import { BlockTemplates, StoreWorld } from '../src/world/blocks.mjs';
import { Vitals, type LoopSource } from '../src/vitals/metrics';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { until } from './fakes/harness';
import { PATH_HANDLER, pathRig, type PathRig, type PathRigOptions } from './fakes/path-rig';

holdEventLoopPerTest(60_000);

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
const BURN = new URL('./fixtures/jobs/burn.mjs', import.meta.url);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Where the wall at x = 10 lets a bot through. */
const GAP_Z = 30;
/** East of the wall, reached only through the gap: a search of many slices at a small tickTimeout. */
const FAR = { x: 28, y: GROUND + 1, z: 26 };

/**
 * 3×3 columns (x and z from -16 to 31): stone up to y = 63, a 2-high wall at x = 10 with a gap at z = 30 (far enough
 * that digging through is cheaper when allowed), and a small hill. Returned as the columns themselves: tests build the
 * main-thread world and the packets from them.
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

/** A bot as the shared world and Movements see it: a packet stream (`_client`), its own world, a game, an inventory. */
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

function params(goal: unknown, movements: any, timeout = 5_000, tickTimeout = 10): SearchParams {
  return { start: new Move(0, GROUND + 1, 0, 0, 0), movements, goal, timeout, tickTimeout, searchRadius: -1 };
}

/** The main thread's own search, to the end. */
function mainThread(p: SearchParams): any {
  const a = new AStar(p.start, p.movements, p.goal, p.timeout, p.tickTimeout, p.searchRadius);
  let r = a.compute();
  while (r.status === 'partial') r = a.compute();
  return r;
}

const coords = (path: any[]): number[][] => path.map((n) => [n.x, n.y, n.z]);

const rigs: PathRig[] = [];
async function newRig(opts: PathRigOptions = {}): Promise<PathRig> {
  const r = await pathRig(opts);
  rigs.push(r);
  return r;
}
after(async () => {
  for (const r of rigs) await r.stop();
});

/** A bot that logged in over the columns, its columns live in the store. */
async function attached(rig: PathRig, cols = buildColumns()): Promise<{ bot: any; cols: Map<string, any> }> {
  const bot = fakeMcBot(cols);
  rig.attach(bot);
  login(bot, cols);
  await rig.world.settle();
  return { bot, cols };
}

/** Tick the pool until `cond()` holds. */
async function pumpUntil(rig: PathRig, cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await rig.jobs.tick();
    await sleep(2);
  }
}

const pathStats = (rig: PathRig) => rig.jobs.stats().types.path ?? { submitted: 0, done: 0, continued: 0, cancelled: 0, retried: 0 };

test('a search runs on a reader worker over the shared world: the same path as the main thread, Moves rebuilt', async () => {
  const rig = await newRig();
  const { bot } = await attached(rig);
  for (const canDig of [false, true]) {
    const goal = new goals.GoalBlock(12, GROUND + 1, -10);
    const local = mainThread(params(goal, movementsFor(bot, canDig)));
    assert.equal(local.status, 'success');
    const ctx = bot.pathfinder.searchOffload(params(goal, movementsFor(bot, canDig)));
    assert.ok(ctx, 'offloaded');
    const first = ctx.compute();
    assert.equal(first.status, 'partial', 'the first tick only submits the search');
    // Never an empty partial path: goto() would take it for "already there".
    assert.deepEqual(coords(first.path), [[0, GROUND + 1, 0]], 'the start node while waiting');
    const r = await rig.settle(ctx);
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
  // GoalFollow becomes a snapshot of where the entity is; composite and look-at goals cross too (a look-at goal
  // raycasts the store from the worker).
  const entity = { position: new Vec3(20.5, GROUND + 1, 5.5) };
  const more = [
    new goals.GoalFollow(entity, 2),
    new goals.GoalCompositeAny([new goals.GoalBlock(-5, GROUND + 1, 20), new goals.GoalNear(25, GROUND + 1, -5, 2)]),
    new goals.GoalLookAtBlock(new Vec3(20, GROUND, 5), bot.world),
    new goals.GoalGetToBlock(20, GROUND + 1, 12),
  ];
  for (const goal of more) {
    const local = mainThread(params(goal, movementsFor(bot, false)));
    const r = await rig.settle(bot.pathfinder.searchOffload(params(goal, movementsFor(bot, false))));
    assert.equal(r.status, local.status, goal.constructor.name);
    assert.deepEqual(coords(r.path), coords(local.path), goal.constructor.name);
  }
  const s = rig.paths.stats();
  assert.deepEqual(s.fallbacks, {});
  assert.equal(s.answered, 6);
  assert.equal(pathStats(rig).done, 6, 'six path jobs answered by the pool');
  assert.equal(pathStats(rig).inline, 0, 'none on the main thread');
});

test("the probe: a short search is answered on the main thread at once; a long one moves to a worker, walking the probe's best path meanwhile", async () => {
  const rig = await newRig({ probeMs: 3, tickBudgetMs: 1 });
  const { bot } = await attached(rig);
  // Short: done within the probe, never submitted.
  const near = new goals.GoalBlock(4, GROUND + 1, 1);
  const local = mainThread(params(near, movementsFor(bot, false)));
  const ctx = bot.pathfinder.searchOffload(params(near, movementsFor(bot, false)));
  const r = ctx.compute();
  assert.equal(r.status, 'success', 'answered at the first compute()');
  assert.deepEqual(coords(r.path), coords(local.path));
  assert.deepEqual(coords(ctx.compute().path), coords(local.path), 'asked again, the same answer');
  assert.equal(rig.paths.stats().probed, 1);
  assert.equal(rig.paths.stats().offloaded, 0);
  // Long (canDig through the wall to the far side, many nodes): the probe's best path at once, then the worker's answer.
  const goal = new goals.GoalBlock(FAR.x, FAR.y, FAR.z);
  const far = mainThread(params(goal, movementsFor(bot, true)));
  const fctx = bot.pathfinder.searchOffload({ ...params(goal, movementsFor(bot, true)), searchRadius: -1 });
  const first = fctx.compute();
  if (first.status === 'partial') {
    assert.ok(first.path.length >= 1, 'a path to walk at once');
    assert.notDeepEqual(coords(first.path), [[0, GROUND + 1, 0]], "the probe's best path, not the start node");
    const done = await rig.settle(fctx);
    assert.deepEqual(coords(done.path), coords(far.path));
    assert.equal(rig.paths.stats().offloaded, 1);
  } else {
    // A machine fast enough to finish it in 3 ms: the probe answered it, as it should.
    assert.deepEqual(coords(first.path), coords(far.path));
  }
});

test('a bot carrying scaffolding: the same path as an uncached search on the main thread (blocks to place)', async () => {
  const rig = await newRig();
  const { bot } = await attached(rig);
  // The reference reads every block afresh, as upstream: a bot without events has no block cache.
  const plain = { registry, game: bot.game, entity: bot.entity, entities: {}, inventory: bot.inventory, blockAt: bot.blockAt, pathfinder: bot.pathfinder };
  for (const goal of [new goals.GoalBlock(4, GROUND + 6, -6), new goals.GoalNear(-6, GROUND + 5, -6, 1)]) {
    const p = (b: any): SearchParams => ({ ...params(goal, movementsFor(b, true)), start: new Move(0, GROUND + 1, 0, 64, 0) });
    const local = mainThread(p(plain));
    assert.equal(local.status, 'success', `${goal.constructor.name}: reachable by placing blocks`);
    const r = await rig.settle(bot.pathfinder.searchOffload(p(bot)));
    assert.equal(r.status, 'success', goal.constructor.name);
    assert.deepEqual(coords(r.path), coords(local.path), goal.constructor.name);
    assert.ok(r.path.some((n: any) => n.toPlace.length > 0), 'the path places blocks');
  }
});

test('while it searches, compute() hands out the partial paths the worker sends; the search runs in slices', async () => {
  // A worker budget of 1 ms a tick: the search needs many slices.
  const rig = await newRig({ tickBudgetMs: 1 });
  const { bot } = await attached(rig);
  const goal = new goals.GoalBlock(FAR.x, FAR.y, FAR.z);
  const local = mainThread(params(goal, movementsFor(bot, false)));
  assert.equal(local.status, 'success');
  const ctx = bot.pathfinder.searchOffload(params(goal, movementsFor(bot, false)));
  let r = ctx.compute();
  let partials = 0;
  const end = Date.now() + 20_000;
  while (r.status === 'partial') {
    if (Date.now() > end) throw new Error('never settled');
    // Anything but the start node alone (the waiting path) is a partial path from the worker.
    if (JSON.stringify(coords(r.path)) !== JSON.stringify([[0, GROUND + 1, 0]])) partials++;
    await rig.jobs.tick();
    await sleep(2);
    r = ctx.compute();
  }
  assert.equal(r.status, 'success');
  assert.deepEqual(coords(r.path), coords(local.path), 'slicing does not change the answer');
  assert.ok(partials > 0, 'a partial path (not the start node) before the answer');
  assert.ok(rig.paths.stats().partials >= 1);
  assert.ok(pathStats(rig).continued > 3, `in slices (${pathStats(rig).continued} continued)`);
  assert.ok(ctx.visitedChunks.size >= 2, 'the chunks it entered, reported along the way');
});

test('cancellation: a search the plugin drops is cancelled in the pool (its state on the worker dropped); a newer one supersedes it', async () => {
  const rig = await newRig({ tickBudgetMs: 1 });
  const { bot } = await attached(rig);
  const slow = (): SearchParams => params(new goals.GoalBlock(FAR.x, FAR.y, FAR.z), movementsFor(bot, false));
  const ctx = bot.pathfinder.searchOffload(slow());
  ctx.compute();
  await pumpUntil(rig, () => pathStats(rig).continued > 0, 'the first slice');
  bot.emit('goal_updated'); // the plugin's setGoal
  await pumpUntil(rig, () => rig.paths.stats().cancelled === 1, 'the cancel');
  assert.equal(pathStats(rig).cancelled, 1, 'the job was cancelled in the pool');
  await rig.pump(30);
  assert.equal(rig.jobs.stats().queue + rig.jobs.stats().inFlight, 0, 'nothing left queued or out');

  // One search per bot: a new one cancels the one in flight.
  const first = bot.pathfinder.searchOffload(slow());
  first.compute();
  const before = pathStats(rig).continued;
  await pumpUntil(rig, () => pathStats(rig).continued > before, 'the second search running');
  const goal = new goals.GoalBlock(12, GROUND + 1, -10);
  const local = mainThread(params(goal, movementsFor(bot, false)));
  const second = bot.pathfinder.searchOffload(params(goal, movementsFor(bot, false)));
  const r = await rig.settle(second);
  assert.equal(r.status, 'success');
  assert.deepEqual(coords(r.path), coords(local.path));
  await pumpUntil(rig, () => rig.paths.stats().cancelled === 2, 'the superseded one cancelled');
  assert.deepEqual(rig.paths.stats().fallbacks, {}, 'a dropped search is not run on the main thread');
});

test('a worker search that exceeds thinkTimeout answers timeout, like the main thread', async () => {
  const rig = await newRig();
  const { bot } = await attached(rig);
  // Unreachable and unbounded: the search would explore the whole store. 1 ms is never enough.
  const r = await rig.settle(bot.pathfinder.searchOffload(params(new goals.GoalBlock(500, GROUND + 1, 500), movementsFor(bot, true), 1)));
  assert.equal(r.status, 'timeout');
  assert.deepEqual(rig.paths.stats().fallbacks, {});
});

test('a worker dying mid-search: the pool runs the search again on the restarted worker; with no worker left, the main thread does', async () => {
  const goal = new goals.GoalBlock(FAR.x, FAR.y, FAR.z);
  for (const disable of [false, true]) {
    const rig = await newRig({ tickBudgetMs: 1, ...(disable ? { maxCrashesPerMinute: 1 } : {}) });
    const { bot } = await attached(rig);
    const local = mainThread(params(goal, movementsFor(bot, false)));
    const ctx = bot.pathfinder.searchOffload(params(goal, movementsFor(bot, false)));
    ctx.compute();
    await pumpUntil(rig, () => pathStats(rig).continued > 0, 'the search under way');
    await rig.jobs.killWorker(0);
    const r = await rig.settle(ctx);
    assert.equal(r.status, 'success', `disable=${disable}`);
    assert.deepEqual(coords(r.path), coords(local.path), `disable=${disable}`);
    if (!disable) {
      assert.equal(pathStats(rig).retried, 1, 'queued again once, from the start');
      assert.equal(rig.jobs.stats().restarts, 1);
      assert.deepEqual(rig.paths.stats().fallbacks, {}, 'answered by the restarted worker');
    } else {
      // The slot is disabled: the pool would run the job inline, where the plugin's own search is the better one.
      assert.equal(rig.jobs.workersAlive(), 0);
      assert.equal(rig.paths.stats().fallbacks.noWorker, 1);
      assert.equal(bot.pathfinder.searchOffload(params(goal, movementsFor(bot, false))), null, 'later searches stay here');
      assert.equal(rig.paths.stats().fallbacks.noWorker, 2);
    }
  }
});

test('fallbacks: unknown goals, exclusion areas, subclassed Movements, an unknown dimension or column stay on the main thread', async () => {
  const rig = await newRig();
  const { bot, cols } = await attached(rig);
  const MyGoal: any = class extends goals.GoalBlock {};
  assert.equal(bot.pathfinder.searchOffload(params(new MyGoal(1, GROUND + 1, 1), movementsFor(bot, false))), null);
  assert.equal(bot.pathfinder.searchOffload(params(new goals.GoalBreakBlock(1, GROUND, 1, bot), movementsFor(bot, false))), null);
  // A look-at goal over another world than the bot's cannot be searched over the store.
  assert.equal(bot.pathfinder.searchOffload(params(new goals.GoalLookAtBlock(new Vec3(1, GROUND, 1), new World(null, null, 0).sync), movementsFor(bot, false))), null);
  const excl = movementsFor(bot, false);
  excl.exclusionAreasStep.push(() => 0);
  assert.equal(bot.pathfinder.searchOffload(params(new goals.GoalBlock(1, GROUND + 1, 1), excl)), null);
  const MyMovements: any = class extends Movements {};
  assert.equal(bot.pathfinder.searchOffload(params(new goals.GoalBlock(1, GROUND + 1, 1), new MyMovements(bot))), null);
  // Standing in a column the store does not hold (never sent, here).
  const outside: SearchParams = { ...params(new goals.GoalBlock(1, GROUND + 1, 1), movementsFor(bot, false)), start: new Move(100, GROUND + 1, 100, 0, 0) };
  assert.equal(bot.pathfinder.searchOffload(outside), null);
  // A bot the shared world follows but that has not logged in.
  const early = fakeMcBot(cols);
  rig.attach(early);
  assert.equal(early.pathfinder.searchOffload(params(new goals.GoalBlock(1, GROUND + 1, 1), movementsFor(early, false))), null);
  assert.deepEqual(rig.paths.stats().fallbacks, { goal: 3, movements: 2, noColumn: 1, noDimension: 1 });
  assert.equal(rig.paths.stats().offloaded, 0);

  // The serializers themselves, for the record.
  assert.equal(serializeGoal(new goals.GoalInvert(new MyGoal(0, 0, 0)), null), null);
  assert.deepEqual(serializeGoal(new goals.GoalY(70), null), { t: 'GoalY', f: { y: 70 } });
  const s = movementSettings(movementsFor(bot, true))!;
  assert.equal(s.canDig, true);
  assert.ok(s.blocksCantBreak instanceof Set && !('bot' in s) && !('blocks' in s));
});

test('world changes reach a later search: a block change closes the wall; a column leaves the store with its last bot', async () => {
  const rig = await newRig();
  const cols = buildColumns();
  const a = (await attached(rig, cols)).bot;
  const b = fakeMcBot(cols);
  rig.attach(b);
  login(b, cols);
  await rig.world.settle();
  const goal = new goals.GoalBlock(20, GROUND + 1, 5);
  assert.equal((await rig.settle(a.pathfinder.searchOffload(params(goal, movementsFor(a, false))))).status, 'success', 'through the gap');

  // Close the gap in the wall: the bots hear the change (the shared world takes it from the column's first holder);
  // the main-thread world gets it too. The search is submitted after the writer applied it (SharedWorld.applied).
  const gap = new Vec3(10, GROUND + 1, GAP_Z);
  for (const bot of [a, b]) bot._client.emit('block_change', { location: gap, type: STONE });
  a._client.emit('multi_block_change', { chunkCoordinates: { x: 0, y: 4, z: GAP_Z >> 4 }, records: [(STONE << 12) | (10 << 8) | ((GAP_Z & 15) << 4) | 1] });
  a.world.setBlockStateId(gap, STONE);
  a.world.setBlockStateId(gap.offset(0, 1, 0), STONE);
  const local = mainThread(params(goal, movementsFor(a, false)));
  assert.equal(local.status, 'noPath', 'the wall is closed');
  const r = await rig.settle(a.pathfinder.searchOffload(params(goal, movementsFor(a, false))));
  assert.equal(r.status, 'noPath', 'the worker sees the change at once');

  // The goal's column (west of the start, this side of the wall): a lets it go, b still holds it (a path ends there);
  // then b lets it go too (its blocks are unknown now).
  const near = new goals.GoalBlock(-5, GROUND + 1, 5);
  a._client.emit('unload_chunk', { chunkX: -1, chunkZ: 0 });
  await rig.world.settle();
  assert.equal((await rig.settle(a.pathfinder.searchOffload(params(near, movementsFor(a, false))))).status, 'success');
  b._client.emit('unload_chunk', { chunkX: -1, chunkZ: 0 });
  await rig.world.settle();
  assert.equal((await rig.settle(a.pathfinder.searchOffload(params(near, movementsFor(a, false))))).status, 'noPath');
  // And the start's own column gone: the search stays on the main thread (over the bot's own world).
  for (const bot of [a, b]) bot._client.emit('unload_chunk', { chunkX: 0, chunkZ: 0 });
  await rig.world.settle();
  assert.equal(a.pathfinder.searchOffload(params(near, movementsFor(a, false))), null);
  assert.equal(rig.paths.stats().fallbacks.noColumn, 1);
});

test("the worker's budget: path slices share workers.tickBudgetMs, a lone search takes all of it", async () => {
  const BUDGET = 10;
  const rig = await newRig({ tickBudgetMs: BUDGET });
  const cols = buildColumns();
  const bots = [];
  for (let i = 0; i < 5; i++) {
    const bot = fakeMcBot(cols);
    rig.attach(bot);
    login(bot, cols);
    bots.push(bot);
  }
  await rig.world.settle();
  const goal = new goals.GoalBlock(FAR.x, FAR.y, FAR.z);
  const local = mainThread(params(goal, movementsFor(bots[0], true)));
  // Alone: its slices are the whole budget (an elastic job type), not the bot's 10 ms tickTimeout of the main thread.
  const alone = await rig.settle(bots[0].pathfinder.searchOffload(params(goal, movementsFor(bots[0], true), 5_000, 1)));
  assert.deepEqual(coords(alone.path), coords(local.path));
  const lone = pathStats(rig).costMs ?? 0;
  assert.ok(lone > 1.5, `a lone search's slice takes the budget, not its 1 ms tickTimeout (${lone} ms)`);
  // Five long searches at once, on one worker with 10 ms per tick: packed together, each gets a share.
  rig.jobs.stats(true);
  const results = await Promise.all(bots.map((bot) => rig.settle(bot.pathfinder.searchOffload(params(goal, movementsFor(bot, true))))));
  for (const r of results) assert.deepEqual(coords(r.path), coords(local.path));
  const s = rig.jobs.stats();
  const used = s.perWorker[0]!.budgetMs.max;
  assert.ok(used <= BUDGET * 1.8, `a batch used about the budget (${used} ms for ${BUDGET})`);
  assert.ok((s.types.path?.costMs ?? 99) < BUDGET, `a slice is a share (${s.types.path?.costMs} ms)`);
});

test('ticks where a search got no slice (its worker had no budget left) do not count against its thinkTimeout', async () => {
  const BUDGET = 3;
  const rig = await newRig({ tickBudgetMs: BUDGET, handlers: [PATH_HANDLER, BURN] });
  const { bot } = await attached(rig);
  const goal = new goals.GoalBlock(FAR.x, FAR.y, FAR.z);
  const local = mainThread(params(goal, movementsFor(bot, true)));
  // A search under way, then 30 ticks where a higher-priority job takes the worker's whole budget: ~500 ms of wall
  // time without a slice, more than its 400 ms thinkTimeout. Those ticks do not count (as the main-thread A* budget's
  // waits do not): it still succeeds. (Its slices of 3 ms need several ticks: on Windows a tick here is ~16 ms.)
  const ctx = bot.pathfinder.searchOffload(params(goal, movementsFor(bot, true), 400));
  ctx.compute();
  await pumpUntil(rig, () => pathStats(rig).continued > 0, 'the search under way');
  assert.equal(rig.paths.stats().inFlight, 1, 'not done after one slice');
  const t0 = Date.now();
  const before = pathStats(rig).continued;
  for (let i = 0; i < 30; i++) {
    rig.jobs.submit({ type: 'burn', input: { ms: BUDGET + 2, id: i }, priority: 10 }).catch(() => undefined);
    await rig.jobs.tick();
    await sleep(15);
  }
  assert.ok(Date.now() - t0 > 450, `longer than the timeout (${Date.now() - t0} ms)`);
  assert.ok(pathStats(rig).continued - before <= 2, 'the search got (almost) no slice meanwhile');
  const r = await rig.settle(ctx);
  assert.equal(r.status, 'success', `not timed out by the ticks it waited (it counted ${Math.round(r.time)} ms)`);
  assert.deepEqual(coords(r.path), coords(local.path));
});

test('a worker that does not answer by thinkTimeout + grace: the search runs on the main thread', async () => {
  const rig = await newRig({ workerUrl: SILENT_WORKER, graceMs: 0 });
  const { bot } = await attached(rig);
  const goal = new goals.GoalBlock(20, GROUND + 1, 5);
  const ctx = bot.pathfinder.searchOffload(params(goal, movementsFor(bot, false), 50));
  assert.equal(ctx.compute().status, 'partial');
  await rig.pump(80);
  const r = ctx.compute();
  // The main-thread search starts with its own full timeout (50 ms here) and may need a few slices.
  const final = r.status === 'partial' ? await rig.settle(ctx) : r;
  assert.ok(['success', 'timeout'].includes(final.status), final.status);
  assert.equal(rig.paths.stats().fallbacks.deadline, 1);
});

test("the plugin's hook: its own planning is offloaded, a synchronous getPathTo is not", async () => {
  const rig = await newRig();
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
  rig.attach(bot);
  login(bot, cols);
  await rig.world.settle();
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
  for (let i = 0; i < 1_000 && !updates.some((u) => u.status !== 'partial'); i++) {
    bot.emit('physicsTick');
    await rig.jobs.tick();
    await sleep(3);
  }
  assert.equal(asked, 1, 'the plugin planned through the hook');
  assert.equal(updates[0].status, 'partial', 'partial until the worker answers');
  assert.ok(updates.every((u) => u.length > 0), 'no empty path_update while waiting (goto would resolve on it)');
  const done = updates.find((u) => u.status !== 'partial');
  assert.equal(done?.status, 'success');
  assert.ok(done.length > 0, 'the bot got a path to walk');
  assert.equal(rig.paths.stats().answered, 1);
});

test('/api/metrics carries the offload\'s counters as paths', async () => {
  const rig = await newRig();
  const { bot } = await attached(rig);
  await rig.settle(bot.pathfinder.searchOffload(params(new goals.GoalBlock(12, GROUND + 1, -10), movementsFor(bot, false))));
  const MyGoal: any = class extends goals.GoalBlock {};
  assert.equal(bot.pathfinder.searchOffload(params(new MyGoal(1, GROUND + 1, 1), movementsFor(bot, false))), null);
  const loop: LoopSource = { read: () => ({ seconds: 10, p50: 1, p99: 2, max: 3, elu: 0.1, cpuPct: 5, rssMb: 100, heapMb: 50 }), stop: () => undefined };
  const m = new Vitals({ pool: { readMeters: () => [] }, loop, jobs: rig.jobs, paths: rig.paths }).sample();
  assert.equal(m.paths?.offloaded, 1);
  assert.equal(m.paths?.answered, 1);
  assert.deepEqual(m.paths?.fallbacks, { goal: 1 });
  assert.equal(m.jobs?.types.path?.done, 1);
});

test('the bot pool feeds the shared world before the first packet and installs the hook at spawn', async () => {
  const calls: string[] = [];
  const pool = new BotPool({
    host: 'x',
    port: 1,
    staggerMs: 1,
    setup: () => calls.push('setup'),
    world: { attach: () => calls.push('attach') },
    pathSearch: { install: () => calls.push('install') },
    createBot: (req) => {
      const b = new FakeBot(req.username);
      setTimeout(() => b.emit('spawn'), 1);
      return b as never;
    },
  });
  pool.add('Mirror1');
  await until(() => pool.status('Mirror1') === 'online', 1_000, 'online');
  assert.deepEqual(calls, ['attach', 'setup', 'install']);
  pool.stop();
});

test('stop: later searches stay on the main thread; one in flight when the pool stops runs there too', async () => {
  const rig = await pathRig({ tickBudgetMs: 1 });
  const { bot } = await attached(rig);
  const goal = new goals.GoalBlock(FAR.x, FAR.y, FAR.z);
  const ctx = bot.pathfinder.searchOffload(params(goal, movementsFor(bot, false)));
  ctx.compute();
  await pumpUntil(rig, () => pathStats(rig).continued > 0, 'the search under way');
  await rig.jobs.stop();
  await until(() => rig.paths.stats().inFlight === 0, 2_000, 'the job failed');
  const r = await rig.settle(ctx);
  assert.equal(r.status, 'success');
  assert.equal(rig.paths.stats().fallbacks.stopped, 1);
  rig.paths.stop();
  assert.equal(bot.pathfinder.searchOffload(params(goal, movementsFor(bot, false))), null);
  assert.equal(rig.paths.stats().fallbacks.stopped, 2);
  await rig.world.stop();
});

test("the store's blocks: one template per state, specialised by position; getBlock and raycast as prismarine-world's", async () => {
  const rig = await newRig();
  const { bot } = await attached(rig);
  const ladder = registry.blocksByName.ladder;
  // A few more states for the comparison: a ladder (its properties), a slab, an open fence gate.
  const extra: Array<[number, number, number, number]> = [
    [2, GROUND + 1, 8, ladder.minStateId + 2],
    [3, GROUND + 1, 8, registry.blocksByName.oak_slab.defaultState],
    [4, GROUND + 1, 8, registry.blocksByName.oak_fence_gate.minStateId + 4],
  ];
  for (const [x, y, z, s] of extra) {
    bot._client.emit('block_change', { location: { x, y, z }, type: s });
    bot.world.setBlockStateId(new Vec3(x, y, z), s);
  }
  await rig.world.settle();
  const templates = new BlockTemplates(registry);
  const store = new StoreWorld(rig.world.reader, templates, 'minecraft:overworld');
  const reader = rig.world.reader;
  reader.enter();
  try {
    for (const p of [new Vec3(0, GROUND, 0), new Vec3(10, 64, 3), new Vec3(5.7, 64.2, 3.1), new Vec3(-7, 20, 30), new Vec3(1, 200, 1), ...extra.map(([x, y, z]) => new Vec3(x, y, z))]) {
      const ours: any = store.getBlock(p);
      const theirs = bot.world.getBlock(p);
      for (const k of ['type', 'name', 'stateId', 'metadata', 'boundingBox', 'shapes', 'hardness', 'diggable', 'transparent']) {
        assert.deepEqual(ours[k], theirs[k], `${k} at ${p}`);
      }
      assert.deepEqual(ours.getProperties(), theirs.getProperties(), `properties at ${p}`);
      assert.ok(ours.position.equals(theirs.position), `position at ${p}`);
      assert.equal(ours.digTime(null, false, false, false, [], {}), theirs.digTime(null, false, false, false, [], {}));
    }
    assert.equal(store.getBlock(new Vec3(100, 64, 100)), null, 'a column the store does not hold');
    // Writes land on the specialised block, never on the template another block of the state shares.
    const a: any = store.getBlock(new Vec3(0, GROUND, 0));
    const b2: any = store.getBlock(new Vec3(1, GROUND, 0));
    a.safe = true;
    a.height = 7;
    assert.equal(b2.safe, undefined);
    assert.equal(templates.template(STONE).height, undefined);
    assert.notEqual(a.position, b2.position);
    // Raycasts: the same block, face and point as the bot's own world.
    for (const [from, dir] of [
      [new Vec3(0.5, GROUND + 1.6, 0.5), new Vec3(1, -0.4, 0.1)],
      [new Vec3(-3.2, GROUND + 2.6, 30.5), new Vec3(1, 0, 0)],
      [new Vec3(2.5, GROUND + 1.6, 6.5), new Vec3(0, -0.2, 1)],
      [new Vec3(3.5, GROUND + 1.9, 6.4), new Vec3(0.05, -0.5, 1)],
    ]) {
      const ours: any = store.raycast(from, dir.normalize(), 20);
      const theirs = bot.world.raycast(from, dir.normalize(), 20);
      assert.equal(ours?.stateId, theirs?.stateId, `ray from ${from}`);
      if (theirs) {
        assert.ok(ours.position.equals(theirs.position));
        assert.equal(ours.face, theirs.face);
        assert.ok(ours.intersect.distanceTo(theirs.intersect) < 1e-9);
      }
    }
  } finally {
    reader.leave();
  }
  assert.ok(templates.built <= 10, `templates built once per state (${templates.built})`);
});

test('config: pathfinding.workers is an alias of workers.count (workers.count wins); workers turn the shared world on', async () => {
  const { parseConfig, jobWorkerCount, ConfigError } = await import('../src/config');
  const env = { PAULSBRAWLS_SQUAD_TOKEN: 't' };
  const off = parseConfig({}, env);
  assert.equal(off.workers.count, 0);
  assert.equal(off.world.enabled, false, 'no workers, no shared world by default');
  const alias = parseConfig({ pathfinding: { workers: 4 } }, env);
  assert.equal(alias.workers.count, 4, 'the old key still works');
  assert.equal(alias.world.enabled, true, 'workers read the shared world: on with them');
  assert.ok(!('workers' in alias.pathfinding), 'one count, under workers');
  assert.equal(parseConfig({ pathfinding: { workers: 4 }, workers: { count: 2 } }, env).workers.count, 2, 'workers.count wins');
  assert.equal(parseConfig({ pathfinding: { workers: 4 }, workers: { count: 0 } }, env).workers.count, 0, 'even when it is 0');
  assert.equal(parseConfig({ workers: { count: 3 }, world: { enabled: false } }, env).world.enabled, false, 'an explicit false stays');
  assert.equal(parseConfig({ world: { enabled: true } }, env).world.enabled, true);
  for (const bad of [-1, 1.5, 17, '2']) {
    assert.throws(() => parseConfig({ pathfinding: { workers: bad } }, env), ConfigError, `pathfinding.workers ${String(bad)}`);
    assert.throws(() => parseConfig({ workers: { count: bad } }, env), ConfigError, `workers.count ${String(bad)}`);
  }
  assert.equal(jobWorkerCount({ count: 8, tickBudgetMs: 40 }, 4), 3);
  assert.equal(jobWorkerCount({ count: 2, tickBudgetMs: 40 }, 32), 2);
  assert.equal(jobWorkerCount({ count: 2, tickBudgetMs: 40 }, 1), 0);
});
