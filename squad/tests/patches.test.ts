// docs/32 B: the library fixes of docs/31 §5.2 are patch-package patches of node_modules (squad/patches/). Each test
// exercises one patched module with small stubs (no Minecraft server), and fails if its patch is missing, so a
// reinstall that skipped the postinstall, or an upgrade that dropped a patch, shows up here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3') as { Vec3: new (x: number, y: number, z: number) => Vec };

interface Vec {
  x: number;
  y: number;
  z: number;
  floored(): Vec;
  offset(dx: number, dy: number, dz: number): Vec;
}

const VERSION = '1.21.1';
const registry = require('prismarine-registry')(VERSION) as any;
const Block = require('prismarine-block')(registry) as { fromStateId(id: number, biome: number): any };
const STONE = registry.blocksByName.stone.defaultState as number;
const AIR = registry.blocksByName.air.defaultState as number;

/** Enough of a mineflayer bot for PlayerState, Physics and Movements; blockAt serves a flat world and counts calls. */
function stubBot(opts: { emitter?: boolean; groundY?: number; unloadedAbove?: number } = {}): any {
  const groundY = opts.groundY ?? 63;
  const bot: any = opts.emitter === false ? {} : new EventEmitter();
  bot.setMaxListeners?.(50);
  Object.assign(bot, {
    version: VERSION,
    registry,
    blockAtCalls: 0,
    entity: {
      position: new Vec3(0.5, groundY + 1, 0.5),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: true,
      elytraFlying: false,
      attributes: {},
      yaw: 0,
      pitch: 0,
      height: 1.8,
      effects: {},
    },
    entities: {},
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    game: { minY: -64, height: 384 },
    inventory: { slots: [], items: () => [] },
    controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    setControlState(k: string, v: boolean) {
      bot.controlState[k] = v;
    },
    clearControlStates() {
      for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false;
    },
    look: () => Promise.resolve(),
    lookAt: () => Promise.resolve(),
    physics: { simulatePlayer: (state: unknown) => state },
    blockAt(pos: Vec) {
      bot.blockAtCalls++;
      const p = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
      if (opts.unloadedAbove !== undefined && p.y > opts.unloadedAbove) return null;
      const b = Block.fromStateId(p.y <= groundY ? STONE : AIR, 0);
      b.position = p;
      return b;
    },
  });
  return bot;
}

test('patch 1, prismarine-physics: PlayerState requires nothing per construction and loads minecraft-data once per version', () => {
  const physicsPath = require.resolve('prismarine-physics');
  const mdPath = createRequire(physicsPath).resolve('minecraft-data');
  const mdEntry = require.cache[mdPath] ?? (require(mdPath), require.cache[mdPath]);
  assert.ok(mdEntry);
  const load = mdEntry.exports as (v: string) => unknown;
  let loads = 0;
  mdEntry.exports = Object.assign((v: string) => {
    loads++;
    return load(v);
  }, load);
  const savedPhysics = require.cache[physicsPath];
  delete require.cache[physicsPath];
  const M = Module as unknown as { _load(request: string, ...rest: unknown[]): unknown };
  const moduleLoad = M._load;
  let requires = 0;
  try {
    const { PlayerState } = require(physicsPath) as { PlayerState: new (bot: unknown, control: unknown) => unknown };
    loads = 0;
    M._load = function (request: string, ...rest: unknown[]) {
      if (request === 'minecraft-data' || request === 'prismarine-nbt') requires++;
      return moduleLoad.call(this, request, ...rest);
    };
    const bot = stubBot();
    for (let i = 0; i < 100; i++) new PlayerState(bot, { ...bot.controlState });
  } finally {
    M._load = moduleLoad;
    mdEntry.exports = load;
    if (savedPhysics) require.cache[physicsPath] = savedPhysics;
  }
  assert.equal(requires, 0, 'PlayerState must not call require() (under tsx every require runs its resolve hook)');
  assert.equal(loads, 1, 'minecraft-data must be loaded once per version, not per PlayerState');
});

test('patch 2, minecraft-protocol: the splitter frames byte-by-byte input without a PartialReadError, and frames it the same', async () => {
  const { createSplitter } = require('minecraft-protocol/src/transforms/framing') as { createSplitter(): any };
  const { types } = require('protodef') as { types: { varint: [unknown, (v: number, b: Buffer, o: number) => number, (v: number) => number] } };
  const [, writeVarInt, sizeOfVarInt] = types.varint;
  // Lengths whose prefix takes 1, 2 and 3 bytes, so the stream is cut inside each kind of varint.
  const payloads = [5, 127, 128, 300, 20_000, 1, 0x3fff, 0x4000].map((n, i) => Buffer.alloc(n, i + 1));
  const framed = Buffer.concat(
    payloads.map((p) => {
      const head = Buffer.alloc(sizeOfVarInt(p.length));
      writeVarInt(p.length, head, 0);
      return Buffer.concat([head, p]);
    }),
  );

  const errors = Error as unknown as { captureStackTrace(o: { name?: string }, c?: unknown): void };
  const capture = errors.captureStackTrace;
  let partialErrors = 0;
  errors.captureStackTrace = function (o: { name?: string }, c?: unknown) {
    if (o?.name === 'PartialReadError') partialErrors++;
    return capture.call(Error, o, c);
  };
  const out: Buffer[] = [];
  try {
    const splitter = createSplitter();
    splitter.on('data', (b: Buffer) => out.push(Buffer.from(b)));
    const ended = new Promise((resolve) => splitter.on('end', resolve));
    // One byte per chunk for the varint-heavy start, then bigger chunks.
    for (let i = 0; i < framed.length; ) {
      const n = i < 2_000 ? 1 : 997;
      splitter.write(framed.subarray(i, i + n));
      i += n;
    }
    splitter.end();
    await ended;
  } finally {
    errors.captureStackTrace = capture;
  }
  assert.equal(partialErrors, 0, 'a chunk ending inside a length prefix must not build a PartialReadError');
  assert.deepEqual(out.map((b) => b.length), payloads.map((p) => p.length));
  assert.ok(out.every((b, i) => b.equals(payloads[i] as Buffer)));

  // Unchanged: a prefix of 5+ continuation bytes is still left to readVarInt (a partial read: the splitter waits), and
  // the legacy ping still passes through.
  const bad = createSplitter();
  const badOut: Buffer[] = [];
  bad.on('data', (b: Buffer) => badOut.push(b));
  bad.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  assert.equal(badOut.length, 0);
  assert.equal(bad.buffer.length, 6);
  const ping = createSplitter();
  ping.recognizeLegacyPing = true;
  const pingOut: Buffer[] = [];
  ping.on('data', (b: Buffer) => pingOut.push(Buffer.from(b)));
  ping.write(Buffer.from([0xfe, 0x01]));
  assert.deepEqual([...(pingOut[0] ?? [])], [0xfe, 0x01, 0x01]);
});

test('patch 3a, pathfinder look-ahead: a decision is reused for 4 ticks for the same node and argument; its blocks are cached for the tick', () => {
  const Physics = require('mineflayer-pathfinder/lib/physics') as new (bot: unknown) => any;
  const bot = stubBot();
  let simulated = 0;
  // Each simulated tick reads the same three blocks.
  bot.physics.simulatePlayer = (state: unknown, world: { getBlock(p: Vec): unknown }) => {
    simulated++;
    world.getBlock(new Vec3(0, 63, 0));
    world.getBlock(new Vec3(0.5, 64.2, 0.5));
    world.getBlock(new Vec3(1, 64, 0));
    return state;
  };
  const physics = new Physics(bot);
  const path = [new Vec3(10.5, 64, 0.5)];

  assert.equal(physics.canSprintJump(path), false);
  const once = simulated;
  assert.ok(once > 0);
  assert.equal(bot.blockAtCalls, 3, 'the look-ahead reads each block once per tick');
  for (let i = 0; i < 4; i++) {
    physics.canSprintJump(path); // ticks 0 to 3
    bot.emit('physicsTick');
  }
  assert.equal(simulated, once, 'the same node and argument within 4 ticks: the decision is reused');
  physics.canSprintJump(path);
  assert.equal(simulated, once * 2, 'after 4 ticks it is decided again');
  physics.canSprintJump(path, 1);
  assert.equal(simulated, once * 3, 'another argument is another decision');
  physics.canSprintJump([new Vec3(10.5, 64, 0.5)]);
  assert.equal(simulated, once * 4, 'another next node (another path[0] object) is another decision');

  const calls = bot.blockAtCalls;
  bot.emit('blockUpdate', null, null);
  physics.canWalkJump(path);
  assert.equal(bot.blockAtCalls, calls + 3, 'a block update empties the cache');

  // A bot that cannot emit events: no memo, no cache, no crash.
  const plain = stubBot({ emitter: false });
  plain.physics.simulatePlayer = bot.physics.simulatePlayer;
  const p2 = new Physics(plain);
  p2.canSprintJump(path);
  p2.canSprintJump(path);
  assert.equal(plain.blockAtCalls, 2 * once * 3, 'without events every lookup goes to blockAt');
});

test('patch 3b, pathfinder Movements.getBlock: cached per absolute position for the tick, never the unloaded placeholder', () => {
  const Movements = require('mineflayer-pathfinder/lib/movements') as new (bot: unknown) => any;
  const bot = stubBot({ unloadedAbove: 100 });
  const m = new Movements(bot);
  const origin = new Vec3(0, 64, 0);

  const a = m.getBlock(origin, 1, -1, 0);
  assert.equal(a.physical, true);
  assert.equal(a.height, 64);
  assert.equal(m.getBlock(origin, 1, -1, 0), a);
  assert.equal(m.getBlock(new Vec3(1, 63, 0), 0, 0, 0), a, 'the key is the absolute position');
  assert.equal(bot.blockAtCalls, 1);

  bot.emit('physicsTick');
  assert.notEqual(m.getBlock(origin, 1, -1, 0), a, 'a new tick reads the block again');
  assert.equal(bot.blockAtCalls, 2);

  // Unloaded: a placeholder whose height is relative to the asking node, so never cached.
  const high = new Vec3(0, 101, 0);
  assert.equal(m.getBlock(high, 0, 0, 0).height, 0);
  assert.equal(m.getBlock(high, 0, 2, 0).height, 2);
  assert.equal(m.getBlock(high, 0, 0, 0).height, 0);
  assert.equal(bot.blockAtCalls, 5);

  // A bot without events (a test fake): every call reads the block, as upstream.
  const plain = stubBot({ emitter: false });
  const pm = new Movements(plain);
  pm.getBlock(origin, 0, 0, 0);
  pm.getBlock(origin, 0, 0, 0);
  assert.equal(plain.blockAtCalls, 2);
});

test('patch 3c, pathfinder tick clock: one physicsTick listener per bot, ahead of the listeners registered before it', () => {
  const Movements = require('mineflayer-pathfinder/lib/movements') as new (bot: unknown) => any;
  const Physics = require('mineflayer-pathfinder/lib/physics') as new (bot: unknown) => any;
  const bot = stubBot();
  const origin = new Vec3(0, 64, 0);
  // Like the pathfinder's own monitorMovement: registered before any Movements reads a block.
  const first = new Movements(bot);
  let readInTick = -1;
  bot.on('physicsTick', () => {
    const before = bot.blockAtCalls;
    first.getBlock(origin, 0, -1, 0);
    readInTick = bot.blockAtCalls - before;
  });
  const listeners = bot.listenerCount('physicsTick');

  first.getBlock(origin, 0, -1, 0);
  const others = [new Movements(bot), new Movements(bot), new Physics(bot), new Physics(bot)];
  for (const o of others) {
    if (o instanceof Movements) o.getBlock(origin, 0, -1, 0);
    else o.canWalkJump([new Vec3(5, 64, 5)]);
  }
  assert.equal(bot.listenerCount('physicsTick'), listeners + 1, 'one clock listener for the bot, not one per instance');
  assert.equal(bot.listenerCount('blockUpdate'), 1);

  bot.emit('physicsTick');
  assert.equal(readInTick, 1, 'a listener registered earlier already sees the new tick (the clock is prepended)');
});

test('patch 3d, pathfinder: "stuck" is 70 physics ticks without reaching a node, not 3.5 s of wall time', () => {
  const { pathfinder, goals } = require('mineflayer-pathfinder') as { pathfinder(bot: unknown): void; goals: { GoalXZ: new (x: number, z: number) => unknown } };
  const bot = stubBot();
  pathfinder(bot);
  const resets: Array<{ reason: string; tick: number }> = [];
  let tick = 0;
  bot.on('path_reset', (reason: string) => resets.push({ reason, tick }));
  bot.pathfinder.setGoal(new goals.GoalXZ(12, 0));
  // The bot never moves: its next node is never reached. 80 ticks take a few ms of wall time.
  const t0 = performance.now();
  for (tick = 1; tick <= 80; tick++) bot.emit('physicsTick');
  assert.ok(performance.now() - t0 < 3_000, 'the ticks must run in less than the old 3.5 s');
  const stuck = resets.filter((r) => r.reason === 'stuck');
  assert.equal(stuck.length, 1, `expected one "stuck" reset in 80 ticks, got ${JSON.stringify(resets)}`);
  assert.ok((stuck[0]?.tick ?? 0) >= 70 && (stuck[0]?.tick ?? 0) <= 75, `"stuck" after about 70 ticks, got tick ${stuck[0]?.tick}`);
});

test('patch 3e, pathfinder AStar.setBudget: all searches share ms per 50 ms window, a refused search waits without timing out, slices get a fair share', async () => {
  const AStar = require('mineflayer-pathfinder/lib/astar') as {
    new (start: unknown, movements: unknown, goal: unknown, timeout: number, tickTimeout?: number): any;
    setBudget(ms: number): void;
  };
  assert.equal(typeof AStar.setBudget, 'function');
  // An endless line of nodes, each neighbour lookup costing about 0.1 ms.
  const node = (x: number) => ({ x, y: 0, z: 0, hash: String(x), cost: 1 });
  const movements = {
    getNeighbors(n: { x: number }) {
      const until = performance.now() + 0.1;
      while (performance.now() < until) {
        // the cost of a real neighbour lookup
      }
      return [node(n.x + 1), node(n.x - 1)];
    },
  };
  const goal = { heuristic: (n: { x: number }) => Math.abs(1e9 - n.x), isEnd: () => false };
  const slice = (search: any) => {
    const t = performance.now();
    const result = search.compute();
    return { result, ms: performance.now() - t };
  };

  try {
    AStar.setBudget(5);
    await sleep(60); // a fresh window
    const a = new AStar(node(0), movements, goal, 10_000, 40);
    const sa = slice(a);
    assert.equal(sa.result.status, 'partial');
    assert.ok(sa.ms >= 4 && sa.ms < 15, `one search alone gets the budget, not its 40 ms tickTimeout (took ${sa.ms.toFixed(1)} ms)`);

    const b = new AStar(node(0), movements, goal, 100, 40);
    const sb = slice(b);
    assert.equal(sb.result.status, 'partial');
    assert.equal(sb.result.visitedNodes, 0, 'the window is spent: the second search waits with its best partial path');
    assert.ok(sb.ms < 2);

    await sleep(150); // longer than b's 100 ms timeout: the wait must not count
    const sb2 = slice(b);
    assert.equal(sb2.result.status, 'partial', 'waiting for the budget does not count against the timeout');
    assert.ok(sb2.result.visitedNodes > 0);
    // Two searches asked in the last window: b's slice is cut to its share, 5 / 2 ms.
    assert.ok(sb2.ms < 4.5, `a fair share of the budget (took ${sb2.ms.toFixed(1)} ms)`);
  } finally {
    AStar.setBudget(0);
  }
  // Off (the default): a slice runs to its own tickTimeout again.
  const c = new AStar(node(0), movements, goal, 10_000, 8);
  const sc = slice(c);
  assert.ok(sc.ms >= 8, `no budget: the tickTimeout (took ${sc.ms.toFixed(1)} ms)`);
});

test('config: pathfinding.astarBudgetMs defaults to 0 (off), is validated, and applyPathfinding reaches the patched AStar', async () => {
  const { parseConfig, applyPathfinding, ConfigError } = await import('../src/config');
  const env = { PAULSBRAWLS_SQUAD_TOKEN: 't' };
  assert.deepEqual(parseConfig({}, env).pathfinding, { astarBudgetMs: 0, workers: 0 });
  assert.deepEqual(parseConfig({ pathfinding: { astarBudgetMs: 20 } }, env).pathfinding, { astarBudgetMs: 20, workers: 0 });
  for (const bad of [-1, 51, '20', Number.NaN]) {
    assert.throws(() => parseConfig({ pathfinding: { astarBudgetMs: bad } }, env), ConfigError, `astarBudgetMs ${String(bad)}`);
  }
  applyPathfinding({ astarBudgetMs: 0, workers: 0 });
});
