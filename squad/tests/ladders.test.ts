// Bots could not follow anyone up a ladder (found live, docs/29 §16). A synthetic 1.21.1 world (prismarine-chunk
// columns, no server) with a pillar, a ladder on its south face and a platform on top pins each fix of
// patches/mineflayer-pathfinder: someone on the ladder no longer makes it unclimbable, a ladder is entered from its
// front, the block a ladder hangs on is never dug, and a search spread over many ticks ends on the same path as one
// run at once. The pathfinding workers give the same answers.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { PathWorkerPool, type MirroredBot, type SearchParams } from '../src/bots/pathworkers/client';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

const require = createRequire(import.meta.url);
const VERSION = '1.21.1';
const registry = require('prismarine-registry')(VERSION) as any;
const Chunk = require('prismarine-chunk')(registry) as any;
const World = require('prismarine-world')(registry) as any;
const Block = require('prismarine-block')(registry) as any;
const { Vec3 } = require('vec3') as { Vec3: any };
const AStar = require('mineflayer-pathfinder/lib/astar') as any;
const Movements = require('mineflayer-pathfinder/lib/movements') as any;
const Move = require('mineflayer-pathfinder/lib/move') as any;
const goals = require('mineflayer-pathfinder/lib/goals') as any;
const { pathfinder: injectPathfinder } = require('mineflayer-pathfinder') as { pathfinder: (bot: any) => void };

const STONE = registry.blocksByName.stone.defaultState as number;
const LADDER_SOUTH = Block.fromProperties('ladder', { facing: 'south', waterlogged: false }, 0).stateId as number;
const GROUND = 63;
/** The ladder's column: on the south face of a 3×3 pillar (x 4..6, z 4..6) 8 blocks tall. */
const LX = 5;
const LZ = 7;
const TOP = GROUND + 8; // the pillar's and the platform's top block
/** Where the climb ends: on the platform (x 2..8, z 2..6, at y = TOP), north of the ladder. */
const SUMMIT = { x: 5, y: TOP + 1, z: 4 };

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
          if (wx >= 4 && wx <= 6 && wz >= 4 && wz <= 6) for (let y = GROUND + 1; y <= TOP; y++) c.setBlockStateId(new Vec3(x, y, z), STONE);
          if (wx >= 2 && wx <= 8 && wz >= 2 && wz <= 6) c.setBlockStateId(new Vec3(x, TOP, z), STONE);
          if (wx === LX && wz === LZ) for (let y = GROUND + 1; y <= TOP; y++) c.setBlockStateId(new Vec3(x, y, z), LADDER_SOUTH);
        }
      }
      cols.set(`${cx},${cz}`, c);
    }
  }
  return cols;
}

/** Enough of a bot for Movements, A* and the plugin's planning: a world, a packet stream for the worker pool. */
function ladderBot(cols = buildColumns()): any {
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
    entity: { position: new Vec3(LX + 0.5, GROUND + 1, LZ + 5.5), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, effects: {} },
    entities: {},
    inventory: { slots: [], items: () => [] },
    blockAt: (p: any) => world.getBlock(p),
    pathfinder: { bestHarvestTool: () => null },
  });
  return bot;
}

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

/** A player standing on the ladder, `y` its feet. */
function climber(y: number): any {
  return { id: 7, name: 'player', type: 'player', position: new Vec3(LX + 0.5, y, LZ + 0.49), width: 0.6, height: 1.8 };
}

function search(movements: any, goal: unknown, from: { x: number; y: number; z: number }): any {
  const a = new AStar(new Move(from.x, from.y, from.z, 0, 0), movements, goal, 5_000, 40, -1);
  let r = a.compute();
  while (r.status === 'partial') r = a.compute();
  return r;
}

const coords = (path: any[]): number[][] => path.map((n) => [n.x, n.y, n.z]);
const inColumn = (n: { x: number; z: number }): boolean => Math.floor(n.x) === LX && Math.floor(n.z) === LZ;

test('ladders: a ladder someone is on (the player being followed) can still be climbed', () => {
  const bot = ladderBot();
  bot.entities = { 7: climber(GROUND + 4) };
  for (const canDig of [false, true]) {
    const m = movementsFor(bot, canDig);
    m.updateCollisionIndex();
    const r = search(m, new goals.GoalBlock(SUMMIT.x, SUMMIT.y, SUMMIT.z), { x: LX, y: GROUND + 1, z: LZ + 5 });
    // Upstream refused every move up out of a ladder block someone stands in: no path without digging, and with
    // digging a tunnel through the pillar, which drops the ladder.
    assert.equal(r.status, 'success', `canDig=${canDig}`);
    assert.equal(r.path.flatMap((n: any) => n.toBreak).length, 0, `canDig=${canDig}: up the ladder, nothing dug`);
    assert.ok(r.path.filter(inColumn).length >= 7, 'the path climbs the ladder');
  }
  // Building a pillar still needs the space free: an entity there blocks the block placed under the bot.
  const m = movementsFor(bot, false);
  m.allow1by1towers = true;
  bot.entities = { 7: { ...climber(GROUND + 1), position: new Vec3(10.5, GROUND + 1, 10.5) } };
  m.updateCollisionIndex();
  const up = (x: number, z: number) => m.getNeighbors(new Move(x, GROUND + 1, z, 5, 0)).filter((n: any) => n.x === x && n.z === z && n.y === GROUND + 2);
  assert.equal(up(10, 10).length, 0, 'no tower where an entity stands');
  assert.equal(up(11, 11).length, 1, 'a tower where nobody stands');
});

test('ladders: the ladder block is entered from its front only, never from the side', () => {
  const bot = ladderBot();
  const m = movementsFor(bot, false);
  const into = (from: { x: number; z: number }, y = GROUND + 1) => m.getNeighbors(new Move(from.x, y, from.z, 0, 0)).filter(inColumn);
  assert.ok(into({ x: LX, z: LZ + 1 }).length > 0, 'from the front (south)');
  assert.equal(into({ x: LX - 1, z: LZ }).length, 0, 'not from the west: the plate edge stops the body');
  assert.equal(into({ x: LX + 1, z: LZ }).length, 0, 'not from the east');
  assert.equal(into({ x: LX - 1, z: LZ + 1 }).length, 0, 'not diagonally');
  // Up and out at the top stays allowed: from the top ladder block onto the platform.
  const top = m.getNeighbors(new Move(LX, TOP, LZ, 0, 0));
  assert.ok(top.some((n: any) => n.x === LX && n.z === LZ - 1 && n.y === TOP + 1), 'off the top of the ladder');
  // From beside the ladder, the path goes round to its front.
  const r = search(m, new goals.GoalBlock(SUMMIT.x, SUMMIT.y, SUMMIT.z), { x: LX - 1, y: GROUND + 1, z: LZ });
  assert.equal(r.status, 'success');
  const first = r.path.findIndex(inColumn);
  assert.ok(first > 0, 'it reaches the ladder');
  assert.deepEqual([r.path[first - 1].x, r.path[first - 1].z], [LX, LZ + 1], 'the step before the ladder is its front');
});

test('ladders: the block a ladder hangs on is never dug', () => {
  const bot = ladderBot();
  const m = movementsFor(bot, true);
  for (let y = GROUND + 1; y <= TOP; y++) assert.equal(m.safeToBreak(m.getBlock(new Vec3(LX, y, LZ - 1), 0, 0, 0)), false, `the support at y=${y}`);
  assert.ok(m.safeToBreak(m.getBlock(new Vec3(LX - 1, GROUND + 3, LZ - 1), 0, 0, 0)), 'the pillar beside it');
  assert.ok(m.safeToBreak(m.getBlock(new Vec3(LX, GROUND + 3, LZ - 2), 0, 0, 0)), 'the pillar behind the support');
  assert.ok(m.safeToBreak(m.getBlock(new Vec3(LX, GROUND, LZ), 0, 0, 0)), 'the ground under the ladder');
});

/** A bot with the plugin injected over the ladder world. */
function plannerBot(): any {
  const bot = ladderBot();
  delete bot.pathfinder;
  Object.assign(bot, {
    entity: {
      ...bot.entity,
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
  bot.movements = movementsFor(bot, false);
  bot.pathfinder.setMovements(bot.movements);
  return bot;
}

test('ladders: a search over many ticks ends on the same path as one run at once (its nodes are copied, not moved)', () => {
  const bot = plannerBot();
  const goal = new goals.GoalBlock(SUMMIT.x, SUMMIT.y, SUMMIT.z);
  const run = (tickTimeout: number) => {
    const gen = bot.pathfinder.getPathFromTo(bot.movements, bot.entity.position, goal, { tickTimeout });
    let last: any;
    let slices = 0;
    for (const { result } of gen) {
      last = result;
      slices++;
    }
    return { result: last, slices };
  };
  const once = run(1_000);
  assert.equal(once.result.status, 'success');
  const sliced = run(0.02);
  assert.ok(sliced.slices > 5, `spread over ticks (${sliced.slices} slices)`);
  assert.equal(sliced.result.status, 'success');
  // Each partial path hands back the same node objects; moved onto their block again on every slice, the ladder's
  // nodes rose one block per slice to the top of the ladder.
  assert.deepEqual(coords(sliced.result.path), coords(once.result.path));
  const ladder = once.result.path.filter(inColumn).map((n: any) => n.y);
  assert.deepEqual(ladder, [...new Set(ladder)], 'one node per ladder block');
});

const pools: PathWorkerPool[] = [];
after(async () => {
  for (const p of pools) await p.stop();
});

test('ladders: the pathfinding workers find the same paths (someone on the ladder, a start beside it)', async () => {
  const pool = new PathWorkerPool({ workers: 1, version: VERSION });
  pools.push(pool);
  const cols = buildColumns();
  const bot = ladderBot(cols);
  pool.attach(bot as MirroredBot);
  pool.install(bot as MirroredBot);
  login(bot, cols);
  bot.entities = { 7: climber(GROUND + 4) };
  const goal = new goals.GoalBlock(SUMMIT.x, SUMMIT.y, SUMMIT.z);
  for (const from of [
    { x: LX, y: GROUND + 1, z: LZ + 5 },
    { x: LX - 1, y: GROUND + 1, z: LZ },
  ]) {
    const params = (): SearchParams => {
      const movements = movementsFor(bot, true);
      movements.updateCollisionIndex();
      return { start: new Move(from.x, from.y, from.z, 0, 0), movements, goal, timeout: 5_000, tickTimeout: 40, searchRadius: -1 };
    };
    const p = params();
    const local = search(p.movements, goal, from);
    assert.equal(local.status, 'success');
    const ctx = bot.pathfinder.searchOffload(params()) as { compute(): any };
    assert.ok(ctx, 'offloaded');
    let r = ctx.compute();
    const end = Date.now() + 10_000;
    while (r.status === 'partial') {
      if (Date.now() > end) throw new Error('the offloaded search never settled');
      await new Promise((res) => setTimeout(res, 5));
      r = ctx.compute();
    }
    assert.equal(r.status, 'success');
    assert.deepEqual(coords(r.path), coords(local.path), `from ${from.x},${from.z}`);
    assert.equal(r.cost, local.cost);
  }
});

test('ladders: a path never ends on the ladder, even with the goal in reach from it (the bot would slide down)', () => {
  const bot = ladderBot();
  const m = movementsFor(bot, false);
  // Within 3 of a point on the platform: the ladder's top blocks are in range, the platform is further.
  const goal = new goals.GoalNear(LX, TOP + 1, LZ - 2, 3);
  assert.ok(goal.isEnd({ x: LX, y: TOP - 1, z: LZ }), 'the ladder is in range of the goal');
  const r = search(m, goal, { x: LX, y: GROUND + 1, z: LZ + 5 });
  assert.equal(r.status, 'success');
  const end = r.path.at(-1);
  assert.ok(!inColumn(end), `ends off the ladder (at ${end.x},${end.y},${end.z})`);
  assert.equal(end.y, TOP + 1, 'on the platform');
  // Nor over the top of it, where a body hangs on and slides back down: off the top goes onto the platform.
  assert.ok(!r.path.some((n: any) => inColumn(n) && n.y > TOP), 'never up into the air over the ladder');
  // A start on the ladder within reach is not the end either.
  const fromLadder = search(m, goal, { x: LX, y: TOP - 1, z: LZ });
  assert.ok(fromLadder.path.length > 0 && !inColumn(fromLadder.path.at(-1)), 'from the ladder, a path off it');
});

test('ladders: a bot beside the ladder is not sent straight at it, past the step in front (a search over many ticks)', () => {
  const bot = plannerBot();
  // West of the ladder's block, against the pillar: where a bot ends up after sliding off the side of the ladder.
  bot.entity.position = new Vec3(LX - 0.61, GROUND + 1, LZ + 0.46);
  bot.pathfinder.tickTimeout = 0.02; // partial results, so that every update goes through pathFromPlayer
  const updates: any[] = [];
  bot.on('path_update', (r: any) => updates.push({ status: r.status, path: coords(r.path) }));
  bot.pathfinder.setGoal(new goals.GoalBlock(SUMMIT.x, SUMMIT.y, SUMMIT.z));
  for (let i = 0; i < 2_000 && !updates.some((u) => u.status === 'success'); i++) bot.emit('physicsTick');
  const done = updates.find((u) => u.status === 'success');
  assert.ok(done, 'the search ended');
  assert.ok(updates.length > 2, 'over several ticks');
  const [x, , z] = done.path[0];
  // The ladder node sits against the plate, nearer to this bot than the step in front of the ladder: skipping to it
  // walked the bot into the plate's edge until "stuck", then onto the same path again.
  assert.ok(!(Math.floor(x) === LX && Math.floor(z) === LZ), `the first step is not onto the ladder (${done.path[0]})`);
  bot.pathfinder.setGoal(null);
});
