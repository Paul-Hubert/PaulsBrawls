// A* on the reader workers, main-thread side (docs/37 P4). It replaces docs/32 D's pathfinding worker pool, whose
// workers each parsed their own copy of every chunk (one mirror per worker: ~9 GB at 14 workers, docs/31 §11.6). The
// bots, their physics, the look-ahead and the scripts stay on the main thread (O2: scripts get the real bot; O4:
// instant reclaim). Only mineflayer-pathfinder's A* moves, through the `searchOffload` hook that patches/ adds to the
// plugin: its own planning (not a caller's synchronous getPathTo) gets a context whose compute() answers "partial"
// until a worker has the path.
//
// A search is one `path` job of the job pool (jobs/handlers/path.mjs): it runs in slices on a reader worker, within
// that worker's budget per tick (workers.tickBudgetMs), over the shared world (docs/37 P1), the one copy of the chunks
// every thread reads. So nothing is mirrored, resynced or kept per worker. The job's progress (pool.ts onProgress)
// brings the chunks the search entered (the plugin re-plans when one next to them loads) and its best partial path;
// the answer brings the path, rebuilt here as the plugin's Move objects (serialize.ts). A search is submitted once the
// writer has applied what the bots heard (SharedWorld.applied), so a block change heard just before it is in the store.
//
// The probe. A worker's first answer comes 1–3 ticks after the search (the pool dispatches and applies once a tick),
// and meanwhile the plugin resets the search on every block change next to the bot (path_reset 'block_updated'). In
// gather those come all the time (logs cut, leaves decaying, the neighbours chopping): searches were cancelled before
// they could answer, again and again (docs/37 §10). Most of those searches are short (on the main thread, gather's plan
// time is 0.7 ms at the median). So a search first runs here, the plugin's own A* under the A* budget, for at most
// probeMs (3): done by then, it is answered at once, as before; not done, it goes to a worker, and the probe's best
// partial path is what the bot walks until the worker reports.
//
// Fallbacks to the main-thread search (the same search from the start, under the A* budget of
// pathfinding.astarBudgetMs), counted by reason in stats():
//   goal, movements      a goal or Movements that cannot cross threads (serialize.ts: an unknown goal class, exclusion
//                        areas, a subclass);
//   noDimension          the shared world does not follow this bot, or it has not logged in;
//   noColumn             the column the bot stands in is not live in the store (not decoded yet, or dropped);
//   noWorld              the shared world's writer is disabled (it died too often: every read is unknown);
//   noWorker             no reader worker is alive (the pool would run jobs inline: the plugin's own search is that);
//   threw, workerDied, lostInput, clone, unknownType, unavailable, stopped, late
//                        the job failed (jobs/errors.ts); the pool already retried a job whose worker died, once;
//   deadline             no sign of life from the worker for thinkTimeout + grace (a wedged worker, or a queue that
//                        never reached the search).
// A worker search that runs out of thinkTimeout answers 'timeout', as the main-thread search does.

import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import { logger } from '../../logger';
import { JobFailedError, JobLateError } from '../../jobs/errors';
import type { JobSpec } from '../../jobs/pool';
import { itemSnapshot, movementSettings, rebuildPath, serializeGoal, type WireGoal, type WireNode } from './serialize';

const require = createRequire(import.meta.url);

interface AStarResult {
  status: string;
  cost: number;
  time: number;
  visitedNodes: number;
  generatedNodes: number;
  path: unknown[];
  context: unknown;
}
interface AStarLike {
  compute(): AStarResult;
  visitedChunks: Set<string>;
}
const AStar = require('mineflayer-pathfinder/lib/astar') as new (
  start: unknown,
  movements: unknown,
  goal: unknown,
  timeout: number,
  tickTimeout: number,
  searchRadius: number,
) => AStarLike;

/** What the plugin's hook passes (patches/mineflayer-pathfinder, getPathFromTo). */
export interface SearchParams {
  start: { x: number; y: number; z: number; remainingBlocks: number };
  movements: unknown;
  goal: unknown;
  timeout: number;
  tickTimeout: number;
  searchRadius: number;
}

/** The parts of a mineflayer bot read here. Loose on purpose: fakes drive it in tests. */
export interface OffloadedBot {
  on?: (ev: string, fn: (...a: never[]) => void) => unknown;
  world?: unknown;
  inventory?: { items?: () => Array<{ type: number; count: number; nbt?: unknown }> };
  entity?: { effects?: unknown };
  pathfinder?: { searchOffload?: (p: SearchParams) => unknown };
}

/** The job pool, narrowed (pool.ts). */
export interface PathJobs {
  submit<T>(spec: JobSpec): Promise<T>;
  workersAlive(): number;
}

/** The shared world, narrowed (world/shared-world.ts). */
export interface PathWorld {
  dimensionOf(bot: unknown): string | null;
  isLive(dim: string, chunkX: number, chunkZ: number): boolean;
  applied(): Promise<void>;
  readonly writerState: string;
}

export interface PathOffloadOptions {
  jobs: PathJobs;
  world: PathWorld;
  /** How long past thinkTimeout a silent search is waited for before it runs on the main thread. */
  graceMs?: number;
  /** The main-thread probe, ms (DEFAULT_PROBE_MS); 0 offloads every search that can cross (tests). */
  probeMs?: number;
}

/** Counters since the start (bench:load diffs them per phase). */
export interface PathOffloadStats {
  /** Searches the probe finished on the main thread (never offloaded). */
  probed: number;
  /** Searches handed to the workers. */
  offloaded: number;
  /** Answered by a worker (success, noPath, timeout). */
  answered: number;
  /** Dropped by the plugin before their answer (a reset, a new goal, a newer search, the bot gone). */
  cancelled: number;
  /** Partial paths received while searching. */
  partials: number;
  /** Offloaded and not settled yet. */
  inFlight: number;
  /** Searches run on the main thread instead, by reason (see the header). */
  fallbacks: Record<string, number>;
}

/** The job's answer (path.mjs). */
interface PathAnswer {
  status: string;
  cost: number;
  time: number;
  visitedNodes: number;
  generatedNodes: number;
  path: WireNode[];
  chunks: string[];
}

interface PathProgress {
  chunks: string[];
  path?: WireNode[];
}

const DEFAULT_GRACE_MS = 2_000;
/** A search runs this long on the main thread before it moves to a worker (see the header). */
export const DEFAULT_PROBE_MS = 3;
/** At most one warning per reason this often (a dead worker fails every search of its batch). */
const WARN_EVERY_MS = 10_000;

export class PathOffload {
  private readonly current = new WeakMap<object, OffloadedSearch>();
  private readonly graceMs: number;
  private readonly probeMs: number;
  private stopped = false;
  private readonly counters = { probed: 0, offloaded: 0, answered: 0, cancelled: 0, partials: 0, inFlight: 0 };
  private readonly fallbacks: Record<string, number> = {};
  private readonly warned = new Map<string, number>();

  constructor(private readonly opts: PathOffloadOptions) {
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.probeMs = opts.probeMs ?? DEFAULT_PROBE_MS;
  }

  /** Let the bot's pathfinder offload its searches. Call once the pathfinder plugin is loaded (at spawn). */
  install(bot: OffloadedBot): void {
    if (!bot.pathfinder) return;
    bot.pathfinder.searchOffload = (p: SearchParams) => this.offload(bot, p);
    // A stale search is cancelled as soon as the plugin drops it (it then starts the next one on its own).
    for (const ev of ['path_reset', 'goal_updated', 'path_stop', 'end']) bot.on?.(ev, () => this.cancel(bot));
  }

  /** The hook: a context for this search, or null to search on the main thread. */
  private offload(bot: OffloadedBot, p: SearchParams): OffloadedSearch | ProbedSearch | null {
    if (this.stopped) return this.fallback('stopped');
    const world = this.opts.world;
    if (world.writerState !== 'up') return this.fallback('noWorld');
    const dim = world.dimensionOf(bot);
    if (dim === null) return this.fallback('noDimension');
    if (this.opts.jobs.workersAlive() === 0) return this.fallback('noWorker');
    const goal = serializeGoal(p.goal, bot.world);
    if (!goal) return this.fallback('goal');
    const settings = movementSettings(p.movements);
    if (!settings) return this.fallback('movements');
    if (!world.isLive(dim, p.start.x >> 4, p.start.z >> 4)) return this.fallback('noColumn');
    this.cancel(bot); // one search per bot: the new one supersedes the old
    let head: unknown[] = [];
    if (this.probeMs > 0) {
      const local = new AStar(p.start, p.movements, p.goal, p.timeout, this.probeMs, p.searchRadius);
      const r = local.compute();
      if (r.status !== 'partial') {
        this.counters.probed++;
        return new ProbedSearch(local, r);
      }
      head = r.path;
    }
    const input = {
      dim,
      start: { x: p.start.x, y: p.start.y, z: p.start.z, remainingBlocks: p.start.remainingBlocks },
      goal: goal satisfies WireGoal,
      timeout: p.timeout,
      tickTimeout: p.tickTimeout,
      searchRadius: p.searchRadius,
      settings,
      entityIntersections: (p.movements as { entityIntersections?: unknown }).entityIntersections ?? {},
      items: itemSnapshot(bot.inventory?.items?.() ?? []),
      effects: bot.entity?.effects ?? {},
    };
    const search = new OffloadedSearch(this, p, this.graceMs, head);
    this.current.set(bot, search);
    this.counters.offloaded++;
    this.counters.inFlight++;
    void this.run(search, input);
    return search;
  }

  private async run(search: OffloadedSearch, input: unknown): Promise<void> {
    try {
      await this.opts.world.applied();
      if (search.abandoned) return this.abandoned(search);
      const answer = await this.opts.jobs.submit<PathAnswer | { status: 'inline' | 'noWorld' }>({
        type: 'path',
        input,
        signal: search.signal,
        onProgress: (v) => {
          if (search.onProgress(v as PathProgress)) this.counters.partials++;
        },
      });
      if (search.abandoned) return this.abandoned(search);
      if (answer.status === 'inline') search.onDead('noWorker');
      else if (answer.status === 'noWorld') search.onDead('noWorld');
      else {
        this.counters.answered++;
        search.onDone(answer as PathAnswer);
      }
    } catch (e) {
      if (search.abandoned) return this.abandoned(search);
      const reason = e instanceof JobFailedError ? e.reason : e instanceof JobLateError ? 'late' : 'error';
      this.warn(reason, `a search failed on the workers (${reason}: ${e instanceof Error ? e.message : String(e)}); it runs on the main thread`);
      search.onDead(reason);
    } finally {
      this.counters.inFlight--;
    }
  }

  /** Dropped by the plugin (counted), or already running on the main thread (counted as its fallback). */
  private abandoned(search: OffloadedSearch): void {
    if (search.isDropped) this.counters.cancelled++;
  }

  private cancel(bot: OffloadedBot): void {
    const s = this.current.get(bot);
    if (!s) return;
    this.current.delete(bot);
    s.drop();
  }

  private fallback(reason: string): null {
    this.countFallback(reason);
    return null;
  }

  /** Called by a search that falls back to the main thread. */
  countFallback(reason: string): void {
    this.fallbacks[reason] = (this.fallbacks[reason] ?? 0) + 1;
    if (reason === 'deadline') this.warn(reason, 'a search got no answer from the workers in thinkTimeout + grace; it runs on the main thread');
  }

  private warn(reason: string, text: string): void {
    const now = Date.now();
    if (now - (this.warned.get(reason) ?? 0) < WARN_EVERY_MS) return;
    this.warned.set(reason, now);
    logger.warn('paths', text);
  }

  stats(): PathOffloadStats {
    return { ...this.counters, fallbacks: { ...this.fallbacks } };
  }

  /** Later searches stay on the main thread (the job pool's own stop fails the ones in flight: they fall back too). */
  stop(): void {
    this.stopped = true;
  }
}

/**
 * One offloaded search, as the plugin sees it: the AStar context's compute() and visitedChunks. Until the worker
 * answers, compute() returns 'partial' with the best path the worker has reported so far (the start node at first:
 * the bot waits, where the main-thread search would walk its first slice's best guess).
 */
export class OffloadedSearch {
  private partial: unknown[] | null = null;
  private waiting: unknown[] | null = null;
  private final: PathAnswer | null = null;
  private local: AStarLike | null = null;
  private deadReason: string | null = null;
  private dropped = false;
  private readonly chunks = new Set<string>();
  private readonly startedAt = performance.now();
  /** The last sign of life: the offload, then each slice's progress. */
  private lastSign = this.startedAt;
  private readonly controller = new AbortController();

  /** @param head the probe's best partial path (the bot walks it until the worker reports); empty: the start node. */
  constructor(
    private readonly owner: PathOffload,
    private readonly params: SearchParams,
    private readonly graceMs: number,
    head: unknown[] = [],
  ) {
    if (head.length > 0) this.partial = head;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isDropped(): boolean {
    return this.dropped;
  }

  /** Dropped, or run on the main thread instead: the worker's answer is not wanted any more. */
  get abandoned(): boolean {
    return this.dropped || this.local !== null;
  }

  /** The chunks the search went through: the plugin re-plans when one next to them loads. */
  get visitedChunks(): Set<string> {
    return this.local ? this.local.visitedChunks : this.chunks;
  }

  /** A slice's progress; true when it brought a new partial path. */
  onProgress(p: PathProgress): boolean {
    this.lastSign = performance.now();
    for (const c of p.chunks) this.chunks.add(c);
    if (!p.path) return false;
    // Rebuilt once, handed to every compute() until the next one: the plugin works on copies (postProcessPath).
    this.partial = rebuildPath(p.path);
    return true;
  }

  onDone(a: PathAnswer): void {
    for (const c of a.chunks) this.chunks.add(c);
    this.final = a;
  }

  onDead(reason: string): void {
    this.deadReason ??= reason;
  }

  /** The plugin dropped this search (a reset, a new goal, a newer search): the job is cancelled. */
  drop(): void {
    if (this.dropped) return;
    this.dropped = true;
    this.controller.abort();
  }

  compute(): AStarResult {
    if (this.local) return this.local.compute();
    if (this.final) {
      const f = this.final;
      return { status: f.status, cost: f.cost, time: f.time, visitedNodes: f.visitedNodes, generatedNodes: f.generatedNodes, path: rebuildPath(f.path), context: this };
    }
    const now = performance.now();
    const reason = this.deadReason ?? (this.dropped ? 'dropped' : now - this.lastSign > this.params.timeout + this.graceMs ? 'deadline' : null);
    if (reason) return this.runLocally(reason);
    return { status: 'partial', cost: 0, time: now - this.startedAt, visitedNodes: 0, generatedNodes: 0, path: this.waitingPath(), context: this };
  }

  /**
   * The best partial path so far, or, before the worker's first report, the start node alone. Never an empty path:
   * the plugin's goto() takes an empty path_update for "already there" and resolves, so every goTo would end at once
   * (found by the smoke test of docs/32 D). On the start node the executor holds the bot still until a path arrives.
   */
  private waitingPath(): unknown[] {
    if (this.partial) return this.partial;
    const s = this.params.start;
    this.waiting ??= rebuildPath([{ x: s.x, y: s.y, z: s.z, remainingBlocks: s.remainingBlocks, cost: 0, parkour: false, toBreak: [], toPlace: [] }]);
    return this.waiting;
  }

  /** The worker cannot answer: the same search, on the main thread, from the start (with a full thinkTimeout). */
  private runLocally(reason: string): AStarResult {
    this.owner.countFallback(reason);
    const p = this.params;
    this.local = new AStar(p.start, p.movements, p.goal, p.timeout, p.tickTimeout, p.searchRadius);
    this.controller.abort(); // the job, if still out, is not wanted any more
    return this.local.compute();
  }
}

/** A search the probe finished on the main thread: the plugin's own AStar and its answer (asked again, the same). */
export class ProbedSearch {
  constructor(
    private readonly astar: AStarLike,
    private readonly result: AStarResult,
  ) {}

  get visitedChunks(): Set<string> {
    return this.astar.visitedChunks;
  }

  compute(): AStarResult {
    // A copy: the plugin replaces the path of the result it gets (postProcessPath).
    return { ...this.result, path: [...this.result.path], context: this };
  }
}
