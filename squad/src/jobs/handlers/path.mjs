// The A* job (docs/37 P4): mineflayer-pathfinder's own search (the patched lib/astar, Movements, goals) on a reader
// worker, over the shared world (P1). It replaces the pathfinding worker pool of docs/32 D, whose workers each parsed
// their own copy of every chunk (~9 GB at 14 workers, docs/31 §11.6): here every worker reads the one copy in shared
// memory, and a block is a per-state template specialised by position (world/blocks.mjs), never a new Block.
//
// One search is one job, run in slices, one slice a tick, answering { continue: state } until the search ends. The
// state (the AStar, its Movements, the stand-in bot) stays on this worker (the pool pins a continued job to it). The
// type is elastic (batch.mjs): a slice takes its share of what is left of the worker's budget this tick
// (workers.tickBudgetMs, 40 ms), so a search alone on a worker computes up to 40 ms a tick and ten searches share
// it; the pool packs them by elasticMinMs. A search that has already computed 50 ms keeps a quarter of its share
// when others follow it in the batch (least attained service: the short ones end first). The bot's tickTimeout (10
// ms in Squad) is a main-thread setting, which keeps a search from holding up the bots' event loop: on a worker it does
// not apply. Each slice also answers `progress` (the pool's progress channel, pool.ts): the chunks the search entered
// since the last slice, and, on the first slice and then at most every PROGRESS_MS, the best partial path, so the bot
// starts walking before the search ends. bots/pathworkers/offload.ts is the main-thread side.
//
// thinkTimeout is wall time from the first slice, as on the main thread, except the ticks this search did not get a
// slice because its worker's budget went to other jobs: those do not count, as the time a search waits for the main
// thread's A* budget does not (patches/: AStar.compute).
//
// The input (offload.ts, built with serialize.ts): { dim, start: { x, y, z, remainingBlocks }, goal (WireGoal),
// timeout, tickTimeout, searchRadius, settings (the bot's Movements, as data), entityIntersections, items, effects }.
// The answer: { status, cost, time, visitedNodes, generatedNodes, path (Moves as plain data), chunks }; status
// 'inline' (run on the main thread: the plugin's own search does that better) or 'noWorld' (this thread has no shared
// world) means "not searched here".

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import { BlockTemplates, StoreWorld } from '../../world/blocks.mjs';

const require = createRequire(import.meta.url);

export const type = 'path';

/** The dispatcher's tick (pool.ts TICK_MS). */
const TICK_MS = 50;
/** The smallest useful slice: the pool packs path jobs by it (an elastic type, batch.mjs). */
export const elasticMinMs = 2;
/** A slice never computes less than this, even when the batch's budget is (nearly) spent. */
const MIN_SLICE_MS = 0.5;
/**
 * A search that has computed this long gives up most of its share (keeps OLD_SHARE of it) to the jobs after it in
 * the batch, the newer searches: least attained service, so the short searches end first and the exhaustive ones
 * (gather's unreachable logs: 13 000–20 000 nodes, half a second of compute) do not crowd them out. Alone, it still
 * takes the whole budget.
 */
const OLD_AFTER_MS = 50;
const OLD_SHARE = 0.25;
/**
 * The last job of a batch would take all that is left, so the batch would run the whole budget (40 of 50 ms). The
 * dispatcher follows a bot's physics ticks, 31–62 ms apart on Windows (15.6 ms timers): a worker still busy at the
 * next dispatch skips that tick. Measured: every worker at exactly 20 ms a tick, half its budget. The last slice
 * leaves this much unused (at most a quarter of its share).
 */
const TAIL_MS = 5;
/** The best partial path goes back on the first slice, then at most this often (when it changed). */
export const PROGRESS_MS = 250;

/** What this thread needs to search; null inline or without a shared world. */
let env = null;

export function init({ version, world, inline }) {
  if (inline || !world || !version) return;
  const registry = require('prismarine-registry')(version);
  env = {
    version,
    registry,
    templates: new BlockTemplates(registry),
    AStar: require('mineflayer-pathfinder/lib/astar'),
    Movements: require('mineflayer-pathfinder/lib/movements'),
    Move: require('mineflayer-pathfinder/lib/move'),
    goals: require('mineflayer-pathfinder/lib/goals'),
    nbt: require('prismarine-nbt'),
    Vec3: require('vec3').Vec3,
  };
}

export function run(input, ctx) {
  if (ctx.inline) return { status: 'inline' };
  if (env === null || !ctx.world) return { status: 'noWorld' };
  let s = ctx.state;
  if (s === undefined) {
    s = begin(input, ctx.world);
  } else {
    // Ticks without a slice (its worker had no budget left for it) do not count against thinkTimeout. Capped by the
    // wall time: ticks of one catch-up burst share a single dispatch.
    const skipped = ctx.tick - s.lastTick - 1;
    if (skipped > 0) s.astar.startTime += Math.min(skipped * TICK_MS, Math.max(0, performance.now() - s.lastEnd - TICK_MS));
  }
  // The block cache of Movements lives until the blocks may have changed (lib/tick.js): any store change empties it.
  const version = ctx.world.version();
  if (version !== s.seen) {
    s.seen = version;
    s.bot.emit('blockUpdate');
  }
  const share = ctx.shareMs();
  // A share below what is left means jobs follow in this batch: an old search leaves them most of it.
  const last = share >= ctx.budgetLeftMs();
  const old = s.used >= OLD_AFTER_MS && !last;
  const t0 = performance.now();
  const r = s.astar.computeSlice(Math.max(MIN_SLICE_MS, old ? share * OLD_SHARE : last ? share - Math.min(TAIL_MS, share / 4) : share));
  s.lastTick = ctx.tick;
  s.lastEnd = performance.now();
  s.used += s.lastEnd - t0;
  const chunks = newChunks(s);
  if (r.status !== 'partial') {
    return { status: r.status, cost: r.cost, time: r.time, visitedNodes: r.visitedNodes, generatedNodes: r.generatedNodes, path: r.path, chunks };
  }
  const progress = { chunks };
  const best = s.astar.bestNode;
  if (r.path.length > 0 && best !== s.sentBest && (s.sentBest === null || s.lastEnd - s.sentAt >= PROGRESS_MS)) {
    progress.path = r.path;
    s.sentBest = best;
    s.sentAt = s.lastEnd;
  }
  return { continue: s, progress };
}

// -- one search -----------------------------------------------------------------------------------------------------

function begin(input, reader) {
  const world = new StoreWorld(reader, env.templates, input.dim);
  const bot = standIn(world, input, reader.bounds(input.dim));
  // A Movements without its constructor (which walks the registry, ~1 ms): the settings carry every field it sets
  // (serialize.ts copies all of them, or refuses the search), the rest is per search.
  const movements = Object.create(env.Movements.prototype);
  Object.assign(movements, input.settings);
  movements.bot = bot;
  movements.blocks = new Map();
  movements.blocksClock = -1;
  movements.entityIntersections = input.entityIntersections ?? {};
  // No entity in the way: every getNumEntitiesAt is 0, without the "x,y,z" string it builds per call (2–6 a neighbour).
  if (Object.keys(movements.entityIntersections).length === 0) movements.getNumEntitiesAt = noEntities;
  movements.exclusionAreasStep = [];
  movements.exclusionAreasBreak = [];
  movements.exclusionAreasPlace = [];
  const st = input.start;
  const start = new env.Move(st.x, st.y, st.z, st.remainingBlocks, 0);
  const goal = buildGoal(input.goal, world);
  return {
    astar: new env.AStar(start, movements, goal, input.timeout, input.tickTimeout, input.searchRadius),
    bot,
    seen: -1,
    /** Compute time so far, ms. */
    used: 0,
    lastTick: 0,
    lastEnd: 0,
    /** visitedChunks already reported. */
    sent: 0,
    sentBest: null,
    sentAt: 0,
  };
}

function noEntities() {
  return 0;
}

/** The chunks the search entered since the last report (a Set iterates in insertion order). */
function newChunks(s) {
  const vc = s.astar.visitedChunks;
  if (vc.size === s.sent) return [];
  const out = [];
  let i = 0;
  for (const c of vc) if (i++ >= s.sent) out.push(c);
  s.sent = vc.size;
  return out;
}

/** What Movements reads of a bot: blocks from the store, the inventory and effects of the request's snapshot. */
function standIn(world, input, bounds) {
  const bot = new EventEmitter();
  bot.setMaxListeners(0);
  const items = input.items ?? [];
  const effects = input.effects ?? {};
  Object.assign(bot, {
    username: 'path-search',
    version: env.version,
    registry: env.registry,
    world,
    game: { minY: bounds?.minY ?? -64, height: bounds?.height ?? 384 },
    entity: { effects },
    entities: {},
    inventory: { items: () => items },
    // Movements.getBlock passes a new Vec3 per lookup and keeps only the block: it can be the block's own position.
    blockAt: (pos) => world.blockAtOwned(pos),
    pathfinder: {
      // index.js's own bestHarvestTool, over the snapshot of the inventory.
      bestHarvestTool(block) {
        let fastest = Number.MAX_VALUE;
        let bestTool = null;
        for (const tool of items) {
          const enchants = tool && tool.nbt ? env.nbt.simplify(tool.nbt).Enchantments : [];
          const digTime = block.digTime(tool ? tool.type : null, false, false, false, enchants, effects);
          if (digTime < fastest) {
            fastest = digTime;
            bestTool = tool;
          }
        }
        return bestTool;
      },
    },
  });
  return bot;
}

// -- goals: the serialized forms of serialize.ts, rebuilt as the library's own classes --------------------------------

const SIMPLE_GOALS = new Set(['GoalBlock', 'GoalNear', 'GoalXZ', 'GoalNearXZ', 'GoalY', 'GoalGetToBlock']);

function vec(p) {
  return new env.Vec3(p.x, p.y, p.z);
}

function buildGoal(g, world) {
  const goals = env.goals;
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
