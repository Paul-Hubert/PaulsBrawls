// A pathfinding worker (docs/32 D, docs/31 §6.2). The bots, their physics and the scripts stay on the main thread
// (O2, O4); only the A* search of mineflayer-pathfinder runs here, over a mirror of the world.
//
// Plain JS so the worker needs no loader (the same reason as script/typecheck-worker.mjs). It loads the registry,
// prismarine-chunk/world and mineflayer-pathfinder's lib/ (AStar, Movements, goals), never mineflayer itself.
//
// Messages in (see client.ts for the other side):
//   { t: 'world', ops }   ops in order: ['load', dim, x, z, minY, height, SharedArrayBuffer] | ['unload', dim, x, z]
//                         | ['set', dim, x, y, z, stateId]
//   { t: 'search', id, dim, bot, start, goal, timeout, searchRadius, settings, entityIntersections, items, effects }
//   { t: 'cancel', id }
//   { t: 'forget', bot }                         a bot instance ended: drop its Movements
// Messages out:
//   { t: 'ready' }
//   { t: 'progress', id, path, visitedChunks }   the best partial path so far, at most every PROGRESS_MS
//   { t: 'done', id, status, cost, time, visitedNodes, generatedNodes, path, visitedChunks }
//   { t: 'failed', id, error }                   the search threw: the main thread runs it itself

import { parentPort, workerData } from 'node:worker_threads';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
const nbt = require('prismarine-nbt');
const AStar = require('mineflayer-pathfinder/lib/astar');
const Movements = require('mineflayer-pathfinder/lib/movements');
const Move = require('mineflayer-pathfinder/lib/move');
const goals = require('mineflayer-pathfinder/lib/goals');

const registry = require('prismarine-registry')(workerData.version);
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);

/** The A* time of one slice. Between slices the worker reads its messages (world updates, cancels, new searches). */
const SLICE_MS = 10;
/** How often a running search sends its best partial path, so the bot can start walking meanwhile. */
const PROGRESS_MS = 250;

// -- the mirror: one world per dimension, shared by every bot -------------------------------------------------------

/** dim → { world, minY, height } */
const worlds = new Map();
/** Bumped by every world change: a search's Movements drops its block cache when it moves (see standIn). */
let worldVersion = 0;

function worldOf(dim) {
  return worlds.get(dim)?.world ?? null;
}

function applyWorld(ops) {
  for (const op of ops) {
    const kind = op[0];
    if (kind === 'set') {
      const w = worldOf(op[1]);
      // A block change for a column the mirror does not hold is ignored, as mineflayer does.
      if (w && w.getColumn(op[2] >> 4, op[4] >> 4)) w.setBlockStateId(new Vec3(op[2], op[3], op[4]), op[5]);
    } else if (kind === 'load') {
      const [, dim, x, z, minY, height, sab] = op;
      let entry = worlds.get(dim);
      if (!entry || entry.minY !== minY || entry.height !== height) {
        entry = { world: new World(null, null, 0).sync, minY, height };
        worlds.set(dim, entry);
      }
      const column = new Chunk({ minY, worldHeight: height });
      try {
        column.load(Buffer.from(sab));
        entry.world.setColumn(x, z, column);
      } catch {
        entry.world.unloadColumn(x, z); // an unreadable column is a hole, never stale data
      }
    } else if (kind === 'unload') {
      worldOf(op[1])?.unloadColumn(op[2], op[3]);
    }
  }
  worldVersion++;
}

// -- the stand-in bot: what Movements reads, served from the mirror and the request's snapshot ---------------------

/** bot name → { standIn, movements }: one Movements per bot, built once (its constructor walks the registry). */
const perBot = new Map();

function botState(name) {
  let s = perBot.get(name);
  if (s) return s;
  const standIn = new EventEmitter();
  standIn.setMaxListeners(0);
  let items = [];
  Object.assign(standIn, {
    username: name,
    version: workerData.version,
    registry,
    world: null,
    game: { minY: -64, height: 384 },
    entity: { effects: {} },
    entities: {},
    inventory: { items: () => items },
    blockAt: (pos) => standIn.world?.getBlock(pos) ?? null,
    pathfinder: {
      // index.js's own bestHarvestTool, over the snapshot of the inventory.
      bestHarvestTool(block) {
        let fastest = Number.MAX_VALUE;
        let bestTool = null;
        for (const tool of items) {
          const enchants = tool && tool.nbt ? nbt.simplify(tool.nbt).Enchantments : [];
          const digTime = block.digTime(tool ? tool.type : null, false, false, false, enchants, standIn.entity.effects);
          if (digTime < fastest) {
            fastest = digTime;
            bestTool = tool;
          }
        }
        return bestTool;
      },
    },
    setItems(next) {
      items = next;
    },
    seenVersion: -1,
  });
  s = { standIn, movements: new Movements(standIn) };
  perBot.set(name, s);
  return s;
}

// -- goals: the serialized forms of client.ts/serialize.ts, rebuilt as the library's own classes -------------------

const SIMPLE_GOALS = new Set(['GoalBlock', 'GoalNear', 'GoalXZ', 'GoalNearXZ', 'GoalY', 'GoalGetToBlock']);

function vec(p) {
  return new Vec3(p.x, p.y, p.z);
}

function buildGoal(g, world) {
  if (SIMPLE_GOALS.has(g.t)) return Object.assign(Object.create(goals[g.t].prototype), g.f);
  switch (g.t) {
    case 'GoalCompositeAny':
    case 'GoalCompositeAll':
      return new goals[g.t](g.goals.map((c) => buildGoal(c, world)));
    case 'GoalInvert':
      return new goals.GoalInvert(buildGoal(g.goal, world));
    case 'GoalLookAtBlock':
      return new goals.GoalLookAtBlock(vec(g.pos), world, { reach: g.reach, entityHeight: g.entityHeight });
    case 'GoalPlaceBlock': {
      // Rebuilt field by field: its constructor would turn `facing` into an index a second time.
      const goal = Object.create(goals.GoalPlaceBlock.prototype);
      goal.pos = vec(g.pos);
      goal.world = world;
      goal.options = { ...g.options, faces: g.options.faces.map(vec) };
      goal.facesPos = g.facesPos.map(([dir, center, ref]) => [vec(dir), vec(center), vec(ref)]);
      return goal;
    }
    default:
      throw new Error(`unknown goal ${g.t}`);
  }
}

// -- the searches: round-robin slices, so one long search never starves the short ones ------------------------------

/** id → job */
const jobs = new Map();
let running = false;

function startSearch(m) {
  const world = worldOf(m.dim);
  const { standIn, movements } = botState(m.bot);
  if (standIn.world !== world) standIn.seenVersion = -1; // another dimension: the cached blocks are of the old one
  standIn.world = world;
  standIn.game = { minY: worlds.get(m.dim)?.minY ?? -64, height: worlds.get(m.dim)?.height ?? 384 };
  standIn.entity = { effects: m.effects ?? {} };
  standIn.setItems(m.items ?? []);
  // The settings of the bot's Movements on the main thread (serialize.ts copies only plain values and Sets).
  Object.assign(movements, m.settings);
  movements.entityIntersections = m.entityIntersections ?? {};
  const start = new Move(m.start.x, m.start.y, m.start.z, m.start.remainingBlocks, 0);
  const goal = buildGoal(m.goal, world);
  const astar = new AStar(start, movements, goal, m.timeout, SLICE_MS, m.searchRadius);
  jobs.set(m.id, { id: m.id, astar, standIn, lastProgress: performance.now() });
  schedule();
}

function schedule() {
  if (running || jobs.size === 0) return;
  running = true;
  setImmediate(runSlices);
}

function runSlices() {
  running = false;
  // One slice per job, then back to the event loop so that messages land between rounds.
  for (const job of [...jobs.values()]) {
    if (!jobs.has(job.id)) continue;
    // getClock (lib/tick.js) bumps the Movements' block clock on 'blockUpdate': its block cache never outlives a change.
    if (job.standIn.seenVersion !== worldVersion) {
      job.standIn.seenVersion = worldVersion;
      job.standIn.emit('blockUpdate');
    }
    let result;
    try {
      result = job.astar.compute();
    } catch (e) {
      jobs.delete(job.id);
      parentPort.postMessage({ t: 'failed', id: job.id, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (result.status === 'partial') {
      const now = performance.now();
      if (now - job.lastProgress >= PROGRESS_MS && result.path.length > 0) {
        job.lastProgress = now;
        parentPort.postMessage({ t: 'progress', id: job.id, path: result.path, visitedChunks: [...job.astar.visitedChunks] });
      }
      continue;
    }
    jobs.delete(job.id);
    parentPort.postMessage({
      t: 'done',
      id: job.id,
      status: result.status,
      cost: result.cost,
      time: result.time,
      visitedNodes: result.visitedNodes,
      generatedNodes: result.generatedNodes,
      path: result.path,
      visitedChunks: [...job.astar.visitedChunks],
    });
  }
  schedule();
}

parentPort.on('message', (m) => {
  if (m.t === 'world') applyWorld(m.ops);
  else if (m.t === 'cancel') jobs.delete(m.id);
  else if (m.t === 'forget') perBot.delete(m.bot); // that bot instance disconnected
  else if (m.t === 'search') {
    try {
      startSearch(m);
    } catch (e) {
      parentPort.postMessage({ t: 'failed', id: m.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
});

parentPort.postMessage({ t: 'ready' });
