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
// time is 0.7 ms at the median). So a search first runs here, the plugin's own A*, for at most probeMs (3): done by
// then, it is answered at once, as before; not done, it goes to a worker, and the probe's best partial path is what
// the bot walks until the worker reports. The probes have their own budget, PROBE_BUDGET_MS of main-thread A* per 50 ms
// window for all bots together (past it a search goes straight to a worker), not the A* budget's: that one splits its
// window evenly between the bots searching, ~0.7 ms each at 30 bots, which left most probes too short to finish.
//
// Carried over a block change (docs/37 §14). Most of gather's resets are not about the path: at 30 bots, 87 % of the
// block_updated resets of a pending search were leaves decaying a block or two from the bot, and they came every
// 0.15–2 s, so a search waiting on a worker restarted from nothing again and again (469 of 663 cancelled) and the long
// ones never answered. So a search is not cancelled on a block_updated reset: when the plugin plans again (the next
// tick) with the same goal and Movements, from a node of the path it was walking, the search carries on, if every step
// of that path near a block changed since the search began is still a step the plugin's own Movements would take, over
// the bot's world as it is now (getNeighbors from the node before; a step whose blocks to break or place changed takes
// the fresh Move). The worker's search reads the shared world, so its later slices see the change. Every path the
// worker sends (partial or final) is checked the same way when it arrives: a partial path is cut before a step that
// is no longer possible; a final one with such a step is searched again from where the bot is. So no path handed to
// the plugin goes through a block that changed since it was searched, as on the main thread (which only resets on a
// change near the path it holds).
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
//                        never reached the search);
//   stale                its final path broke again after MAX_RESTARTS searches again (the store behind the bot).
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
  /** patches/: one slice of at most `ms`, outside the A* budget. */
  computeSlice(ms: number): AStarResult;
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
const Move = require('mineflayer-pathfinder/lib/move') as new (x: number, y: number, z: number, remainingBlocks: number, cost: number) => PathNode;
const { Vec3 } = require('vec3') as { Vec3: new (x: number, y: number, z: number) => XYZ };

/** A node of a path (the plugin's Move): a position, and its hash "x,y,z". */
interface PathNode {
  x: number;
  y: number;
  z: number;
  hash: string;
  remainingBlocks: number;
}

/** What is read of the plugin's Movements to check a path (lib/movements.js). */
interface StepRules {
  getNeighbors(node: PathNode): PathNode[];
  emptyBlocks?: Set<number>;
  countScaffoldingItems?(): number;
}

/** What the plugin's hook passes (patches/mineflayer-pathfinder, getPathFromTo). */
export interface SearchParams {
  start: { x: number; y: number; z: number; remainingBlocks: number };
  movements: unknown;
  goal: unknown;
  timeout: number;
  tickTimeout: number;
  searchRadius: number;
}

interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** The parts of a mineflayer bot read here. Loose on purpose: fakes drive it in tests. */
export interface OffloadedBot {
  on?: (ev: string, fn: (...a: never[]) => void) => unknown;
  prependListener?: (ev: string, fn: (...a: never[]) => void) => unknown;
  world?: unknown;
  inventory?: { items?: () => Array<{ type: number; count: number; nbt?: unknown }> };
  entity?: { effects?: unknown; position?: XYZ; onGround?: boolean };
  blockAt?: (p: XYZ) => { type: number } | null;
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
  /** Carry a search over a block_updated reset when its path still holds (default true; false: cancelled, as before). */
  carry?: boolean;
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
  /** block_updated resets a search was carried over (its path still held). */
  carried: number;
  /**
   * block_updated resets that ended the search, by why: `broken` (a step of its path no longer holds), `moved` (the bot
   * is not on its path), `goal` (planned again for another goal or Movements), `final` (it had answered noPath or
   * timeout), `changes` (more block changes than it keeps), `ended` (failed or dropped meanwhile), `late` (no new plan
   * within CARRY_WINDOW_MS).
   */
  notCarried: Record<string, number>;
  /** Paths from a worker with a step a block change broke: partial ones cut before it, final ones searched again. */
  stale: { partial: number; final: number };
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
/** All probes together compute at most this long per PROBE_WINDOW_MS. */
export const PROBE_BUDGET_MS = 10;
const PROBE_WINDOW_MS = 50;
/** At most one warning per reason this often (a dead worker fails every search of its batch). */
const WARN_EVERY_MS = 10_000;
/** A search held over a block_updated reset is cancelled when the plugin has not planned again by then (5 ticks). */
export const CARRY_WINDOW_MS = 250;
/**
 * Block changes a search keeps for its checks. A bot hears every change of its loaded chunks (leaves decaying all over
 * a forest), tens a second; past this many, the search is never carried, and its paths go unchecked, as before.
 */
export const MAX_CHANGES = 2_048;
/** A search is searched again at most this many times for a final path that broke (then on the main thread). */
const MAX_RESTARTS = 2;
/** A bot farther than this (blocks) from every node of the path it was walking is not on it: no carry. */
const MAX_OFF_PATH = 2;

export class PathOffload {
  private readonly current = new WeakMap<object, OffloadedSearch>();
  private readonly graceMs: number;
  private readonly probeMs: number;
  private readonly carry: boolean;
  private probeWindow = { start: -Infinity, spent: 0 };
  private stopped = false;
  private readonly counters = { probed: 0, offloaded: 0, answered: 0, cancelled: 0, partials: 0, inFlight: 0, carried: 0 };
  private readonly fallbacks: Record<string, number> = {};
  private readonly notCarried: Record<string, number> = {};
  private readonly stale = { partial: 0, final: 0 };
  private readonly warned = new Map<string, number>();

  constructor(private readonly opts: PathOffloadOptions) {
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.probeMs = opts.probeMs ?? DEFAULT_PROBE_MS;
    this.carry = opts.carry ?? true;
  }

  /** Let the bot's pathfinder offload its searches. Call once the pathfinder plugin is loaded (at spawn). */
  install(bot: OffloadedBot): void {
    if (!bot.pathfinder) return;
    bot.pathfinder.searchOffload = (p: SearchParams) => this.offload(bot, p);
    // The block changes a search's paths are checked against. Prepended: noted before the plugin's own listener
    // resets the path on the same change. The plugin's filter: a change of block type (not of a state).
    const listen = bot.prependListener ?? bot.on;
    listen?.call(bot, 'blockUpdate', ((oldBlock: { type: number; position: XYZ } | null, newBlock: { type: number } | null) => {
      if (!oldBlock || !newBlock || oldBlock.type === newBlock.type) return;
      this.current.get(bot)?.noteChange(oldBlock.position);
    }) as never);
    // A stale search is cancelled as soon as the plugin drops it (it then starts the next one on its own). A
    // block_updated reset only holds it until the plugin plans again (offload: carried over, or cancelled).
    bot.on?.('path_reset', ((reason: string) => {
      if (reason === 'block_updated' && this.carry) this.hold(bot);
      else this.cancel(bot);
    }) as never);
    for (const ev of ['goal_updated', 'path_stop', 'end']) bot.on?.(ev, () => this.cancel(bot));
  }

  /** The hook: a context for this search, or null to search on the main thread. */
  private offload(bot: OffloadedBot, p: SearchParams): OffloadedSearch | ProbedSearch | null {
    if (this.stopped) return this.fallback('stopped');
    const world = this.opts.world;
    if (world.writerState !== 'up') return this.fallback('noWorld');
    const held = this.current.get(bot);
    if (held?.isHeld) {
      const why = held.carry(p);
      if (why === null) {
        this.counters.carried++;
        return held;
      }
      this.notCarried[why] = (this.notCarried[why] ?? 0) + 1;
    }
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
    const probeMs = this.probeSlice();
    if (probeMs > 0) {
      const local = new AStar(p.start, p.movements, p.goal, p.timeout, p.tickTimeout, p.searchRadius);
      const t0 = performance.now();
      const r = local.computeSlice(probeMs);
      this.probeWindow.spent += performance.now() - t0;
      if (r.status !== 'partial') {
        this.counters.probed++;
        return new ProbedSearch(local, r);
      }
      head = r.path;
    }
    const search = new OffloadedSearch(this, bot, p, this.graceMs, head, { dim, goal, settings });
    this.current.set(bot, search);
    this.counters.offloaded++;
    this.submit(search, p.start);
    return search;
  }

  /** How long this search may probe: probeMs, or what is left of the probes' window (0: straight to a worker). */
  private probeSlice(): number {
    if (this.probeMs <= 0) return 0;
    const now = performance.now();
    if (now - this.probeWindow.start >= PROBE_WINDOW_MS) this.probeWindow = { start: now, spent: 0 };
    const left = PROBE_BUDGET_MS - this.probeWindow.spent;
    return left < 0.5 ? 0 : Math.min(this.probeMs, left);
  }

  /** A job for this search from `start`: the first one, or the search again after its final path broke. */
  submit(search: OffloadedSearch, start: SearchParams['start']): void {
    const p = search.params;
    const w = search.wire;
    const bot = search.bot;
    const input = {
      dim: w.dim,
      start: { x: start.x, y: start.y, z: start.z, remainingBlocks: start.remainingBlocks },
      goal: w.goal,
      timeout: p.timeout,
      tickTimeout: p.tickTimeout,
      searchRadius: p.searchRadius,
      settings: w.settings,
      entityIntersections: (p.movements as { entityIntersections?: unknown }).entityIntersections ?? {},
      items: itemSnapshot(bot.inventory?.items?.() ?? []),
      effects: bot.entity?.effects ?? {},
    };
    this.counters.inFlight++;
    void this.run(search, search.newJob(), input);
  }

  private async run(search: OffloadedSearch, job: number, input: unknown): Promise<void> {
    try {
      await this.opts.world.applied();
      if (!search.wants(job)) return this.abandoned(search, job);
      const answer = await this.opts.jobs.submit<PathAnswer | { status: 'inline' | 'noWorld' }>({
        type: 'path',
        input,
        signal: search.signal,
        onProgress: (v) => {
          if (search.wants(job) && search.onProgress(v as PathProgress)) this.counters.partials++;
        },
      });
      if (!search.wants(job)) return this.abandoned(search, job);
      if (answer.status === 'inline') search.onDead('noWorker');
      else if (answer.status === 'noWorld') search.onDead('noWorld');
      else {
        this.counters.answered++;
        search.onDone(answer as PathAnswer);
      }
    } catch (e) {
      if (!search.wants(job)) return this.abandoned(search, job);
      const reason = e instanceof JobFailedError ? e.reason : e instanceof JobLateError ? 'late' : 'error';
      this.warn(reason, `a search failed on the workers (${reason}: ${e instanceof Error ? e.message : String(e)}); it runs on the main thread`);
      search.onDead(reason);
    } finally {
      this.counters.inFlight--;
    }
  }

  /** Dropped by the plugin (counted), superseded by its own search again (not), or run on the main thread (a fallback). */
  private abandoned(search: OffloadedSearch, job: number): void {
    if (search.isDropped && search.isLastJob(job)) this.counters.cancelled++;
  }

  /** A block_updated reset: the search is held until the plugin plans again (offload), at most CARRY_WINDOW_MS. */
  private hold(bot: OffloadedBot): void {
    const s = this.current.get(bot);
    if (!s || s.isHeld) return;
    s.hold();
    const t = setTimeout(() => {
      if (this.current.get(bot) !== s || !s.isHeld) return;
      this.notCarried.late = (this.notCarried.late ?? 0) + 1;
      this.cancel(bot);
    }, CARRY_WINDOW_MS);
    t.unref?.();
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

  /** Called by a search whose worker path a block change broke. */
  countStale(kind: 'partial' | 'final'): void {
    this.stale[kind]++;
  }

  private warn(reason: string, text: string): void {
    const now = Date.now();
    if (now - (this.warned.get(reason) ?? 0) < WARN_EVERY_MS) return;
    this.warned.set(reason, now);
    logger.warn('paths', text);
  }

  stats(): PathOffloadStats {
    return { ...this.counters, fallbacks: { ...this.fallbacks }, notCarried: { ...this.notCarried }, stale: { ...this.stale } };
  }

  /** Later searches stay on the main thread (the job pool's own stop fails the ones in flight: they fall back too). */
  stop(): void {
    this.stopped = true;
  }
}

/** What a search's jobs are sent, fixed at the offload (serialize.ts). */
interface WireSearch {
  dim: string;
  goal: WireGoal;
  settings: unknown;
}

/**
 * One offloaded search, as the plugin sees it: the AStar context's compute() and visitedChunks. Until the worker
 * answers, compute() returns 'partial' with the best path the worker has reported so far (the start node at first:
 * the bot waits, where the main-thread search would walk its first slice's best guess). It keeps the block changes
 * the bot hears from its start on, and every path it hands out is checked against them (check).
 */
export class OffloadedSearch {
  private partial: PathNode[] | null = null;
  private waiting: unknown[] | null = null;
  private final: PathAnswer | null = null;
  private finalPath: PathNode[] | null = null;
  /** A carry's path, from the bot on: the next compute() returns it (the plugin's planPath does not trim a path). */
  private handOut: PathNode[] | null = null;
  private local: AStarLike | null = null;
  private deadReason: string | null = null;
  private dropped = false;
  private held = false;
  private readonly chunks = new Set<string>();
  private readonly startedAt = performance.now();
  /** The last sign of life: the offload, then each slice's progress. */
  private lastSign = this.startedAt;
  private controller = new AbortController();
  /** The current job (a final path that broke is searched again by a new one); older jobs' answers are ignored. */
  private job = 0;
  /** Where the current job's paths start (an A* path leaves its start node out). */
  private origin: PathNode;
  /** Block changes since the current job began: x, y, z, … */
  private readonly changes: number[] = [];
  private overflow = false;
  /** Searched again after a final path broke. */
  private restarts = 0;

  /** @param head the probe's best partial path (the bot walks it until the worker reports); empty: the start node. */
  constructor(
    private readonly owner: PathOffload,
    readonly bot: OffloadedBot,
    public params: SearchParams,
    private readonly graceMs: number,
    head: unknown[],
    readonly wire: WireSearch,
  ) {
    this.origin = params.start as PathNode;
    if (head.length > 0) this.partial = head as PathNode[];
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isDropped(): boolean {
    return this.dropped;
  }

  /** Held over a block_updated reset, until the plugin plans again. */
  get isHeld(): boolean {
    return this.held;
  }

  /** A new job, with its own signal: the older job is not wanted any more. */
  newJob(): number {
    if (this.job > 0) this.controller.abort();
    this.controller = new AbortController();
    return ++this.job;
  }

  isLastJob(job: number): boolean {
    return job === this.job;
  }

  /** The job's answer is still wanted: not dropped, not run on the main thread, not superseded. */
  wants(job: number): boolean {
    return !this.dropped && this.local === null && job === this.job;
  }

  /** The chunks the search went through: the plugin re-plans when one next to them loads. */
  get visitedChunks(): Set<string> {
    return this.local ? this.local.visitedChunks : this.chunks;
  }

  noteChange(p: XYZ): void {
    if (this.overflow || this.local) return;
    if (this.changes.length >= MAX_CHANGES * 3) {
      this.overflow = true;
      return;
    }
    this.changes.push(p.x, p.y, p.z);
  }

  /** A slice's progress; true when it brought a new partial path. */
  onProgress(p: PathProgress): boolean {
    this.lastSign = performance.now();
    for (const c of p.chunks) this.chunks.add(c);
    if (!p.path) return false;
    // Rebuilt once, handed to every compute() until the next one: the plugin works on copies (postProcessPath).
    const path = rebuildPath(p.path) as unknown as PathNode[];
    const broken = this.check(path, 0);
    if (broken >= 0) {
      // Searched (in part) before a block change that broke a step: the bot walks what comes before it.
      this.owner.countStale('partial');
      if (broken === 0) return false;
      path.length = broken;
    }
    this.partial = path;
    return true;
  }

  onDone(a: PathAnswer): void {
    for (const c of a.chunks) this.chunks.add(c);
    const path = rebuildPath(a.path) as unknown as PathNode[];
    const broken = this.check(path, 0);
    if (broken >= 0) {
      this.owner.countStale('final');
      if (a.status === 'success') {
        // A path to the goal through a step that no longer holds: searched again, from where the bot stands, which
        // waits there (the waiting path) until the new search reports. A search whose answers keep breaking (the
        // store behind the bot's world) runs on the main thread, over the bot's own world.
        this.restart(this.restarts++ >= MAX_RESTARTS);
        return;
      }
      // noPath or timeout: the plugin gives the goal up anyway (goto rejects); its best path is cut before the step.
      path.length = broken;
    }
    this.final = a;
    this.finalPath = path;
  }

  onDead(reason: string): void {
    this.deadReason ??= reason;
  }

  /** The plugin dropped this search (a reset, a new goal, a newer search): the job is cancelled. */
  drop(): void {
    if (this.dropped) return;
    this.dropped = true;
    this.held = false;
    this.controller.abort();
  }

  hold(): void {
    this.held = true;
  }

  /**
   * The plugin plans again after a block_updated reset (`p`). The search carries on if it is the same plan (goal and
   * Movements), the bot stands on the path it was walking (or at its start), and that path still holds from there.
   * Returns null when carried, else why not (the caller then starts a new search).
   */
  carry(p: SearchParams): string | null {
    this.held = false;
    if (this.dropped || this.local || this.deadReason) return 'ended';
    if (p.goal !== this.params.goal || p.movements !== this.params.movements) return 'goal';
    // The same object is not always the same goal: GoalFollow's hasChanged() moves it in place (to where the entity is
    // now), and a reset of an empty path emits nothing. The worker searches for the snapshot it was sent.
    if (JSON.stringify(serializeGoal(p.goal, this.bot.world)) !== JSON.stringify(this.wire.goal)) return 'goal';
    if (this.final && this.final.status !== 'success') return 'final';
    if (this.overflow) return 'changes';
    const path = this.finalPath ?? this.partial ?? [];
    const from = this.nextNode(path, p.start);
    if (from < 0) return 'moved';
    if (this.check(path, from) >= 0) return 'broken';
    this.params = p;
    this.handOut = path.slice(from);
    return null;
  }

  /**
   * Where the bot is on `path`: the index of the node it walks to next (0: it is at the start), found as the plugin's
   * pathFromPlayer finds it (the nearest node, none past one with blocks to break or place; the one after it when the
   * bot has reached it, or is between the two); -1 when the bot is more than MAX_OFF_PATH blocks from every node.
   */
  private nextNode(path: PathNode[], start: XYZ): number {
    const pos = this.bot.entity?.position ?? { x: start.x + 0.5, y: start.y, z: start.z + 0.5 };
    const at = (i: number): PathNode => (i === 0 ? this.origin : path[i - 1]!);
    const d2 = (n: XYZ, q: XYZ): number => (n.x + 0.5 - q.x) ** 2 + (n.y - q.y) ** 2 + (n.z + 0.5 - q.z) ** 2;
    let best = -1;
    let bestD = MAX_OFF_PATH * MAX_OFF_PATH;
    for (let i = 0; i <= path.length; i++) {
      const n = at(i);
      if (i > 0 && hasWork(n)) break;
      const d = d2(n, pos);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return -1;
    const n1 = at(best);
    if (best < path.length && !hasWork(n1)) {
      const n2 = at(best + 1);
      const reached = Math.abs(n1.x + 0.5 - pos.x) <= 0.35 && Math.abs(n1.z + 0.5 - pos.z) <= 0.35 && Math.abs(n1.y - pos.y) < 1;
      if (reached || d2(n1, { x: n2.x + 0.5, y: n2.y, z: n2.z + 0.5 }) > d2(n2, pos)) best++;
    }
    return Math.max(0, best - 1);
  }

  /**
   * The first node of `path` (from index `from`) that the block changes since this job began make unreachable, by the
   * plugin's own Movements over the bot's world as it is now; -1 when every step holds. Only the steps next to a change
   * are asked (getNeighbors of the node before: does it still lead there?), and a step that holds takes the fresh Move
   * (its blocks to break or place may have changed: a leaf on the way that has decayed is not dug any more).
   */
  private check(path: PathNode[], from: number): number {
    if (this.changes.length === 0 || this.overflow || path.length <= from) return -1;
    const rules = this.params.movements as StepRules | null;
    if (typeof rules?.getNeighbors !== 'function') return -1;
    const before = from === 0 ? this.origin : path[from - 1]!;
    const near = nearChanges(before, path, from, this.changes);
    if (near === null) return -1;
    let prev = before;
    for (let i = from; i < path.length; i++) {
      // A step changes when a block next to either end of it did.
      if (near[i - from] || near[i - from + 1]) {
        const node = path[i]!;
        const fresh = rules.getNeighbors(prev).find((n) => n.hash === node.hash);
        if (!fresh) return i;
        path[i] = fresh;
      }
      prev = path[i]!;
    }
    return -1;
  }

  /** A final path that broke: the search again from where the bot stands, as a new job, its changes from now on. */
  private restart(local: boolean): void {
    const start = startOf(this.bot, this.params.movements as StepRules) ?? this.params.start;
    this.final = null;
    this.finalPath = null;
    this.partial = null;
    this.waiting = null;
    this.changes.length = 0;
    this.origin = start as PathNode;
    this.params = { ...this.params, start };
    this.lastSign = performance.now();
    if (local) this.onDead('stale');
    else this.owner.submit(this, start);
  }

  compute(): AStarResult {
    if (this.local) return this.local.compute();
    const out = this.handOut;
    this.handOut = null;
    if (this.final) {
      const f = this.final;
      return { status: f.status, cost: f.cost, time: f.time, visitedNodes: f.visitedNodes, generatedNodes: f.generatedNodes, path: [...(out ?? this.finalPath ?? [])], context: this };
    }
    const now = performance.now();
    const reason = this.deadReason ?? (this.dropped ? 'dropped' : now - this.lastSign > this.params.timeout + this.graceMs ? 'deadline' : null);
    if (reason) return this.runLocally(reason);
    // A carry's path; or, the bot at the end of it, the node it stands on (the plugin's planPath does not trim a path).
    const path = out ? (out.length > 0 ? [...out] : this.startNode()) : this.waitingPath();
    return { status: 'partial', cost: 0, time: now - this.startedAt, visitedNodes: 0, generatedNodes: 0, path, context: this };
  }

  /**
   * The best partial path so far, or, before the worker's first report, the start node alone. Never an empty path:
   * the plugin's goto() takes an empty path_update for "already there" and resolves, so every goTo would end at once
   * (found by the smoke test of docs/32 D). On the start node the executor holds the bot still until a path arrives.
   */
  private waitingPath(): unknown[] {
    if (this.partial && this.partial.length > 0) return this.partial;
    return this.startNode();
  }

  /** The start node alone (the latest: a carry moves it to where the bot stands). */
  private startNode(): unknown[] {
    const s = this.params.start;
    if (!this.waiting || !sameNode(this.waiting[0] as XYZ, s)) {
      this.waiting = rebuildPath([{ x: s.x, y: s.y, z: s.z, remainingBlocks: s.remainingBlocks, cost: 0, parkour: false, toBreak: [], toPlace: [] }]);
    }
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

/** A node whose step breaks or places blocks (the plugin's pathFromPlayer never skips one). */
function hasWork(n: PathNode): boolean {
  const m = n as PathNode & { toBreak?: unknown[]; toPlace?: unknown[] };
  return (m.toBreak?.length ?? 0) > 0 || (m.toPlace?.length ?? 0) > 0;
}

function sameNode(a: XYZ, b: XYZ): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * Whether a block change is next to a node: within one block across, two down or up (the plugin's own test of a block
 * update near the path, isPositionNearPath, and the block over the head, which a jump needs).
 */
function isNear(n: XYZ, x: number, y: number, z: number): boolean {
  return Math.abs(n.x - x) <= 1 && Math.abs(n.z - z) <= 1 && y - n.y >= -2 && y - n.y <= 2;
}

/**
 * Whether a change is next to each node: `before` (index 0, the node the first step leaves) and the path from `from`
 * (index 1 on); null when no change is (the path's box is tested first).
 */
function nearChanges(before: XYZ, path: PathNode[], from: number, changes: number[]): boolean[] | null {
  let x0 = before.x;
  let x1 = before.x;
  let y0 = before.y;
  let y1 = before.y;
  let z0 = before.z;
  let z1 = before.z;
  for (let i = from; i < path.length; i++) {
    const n = path[i]!;
    if (n.x < x0) x0 = n.x;
    else if (n.x > x1) x1 = n.x;
    if (n.y < y0) y0 = n.y;
    else if (n.y > y1) y1 = n.y;
    if (n.z < z0) z0 = n.z;
    else if (n.z > z1) z1 = n.z;
  }
  let near: boolean[] | null = null;
  for (let c = 0; c < changes.length; c += 3) {
    const x = changes[c]!;
    const y = changes[c + 1]!;
    const z = changes[c + 2]!;
    if (x < x0 - 1 || x > x1 + 1 || z < z0 - 1 || z > z1 + 1 || y < y0 - 2 || y > y1 + 2) continue;
    if (isNear(before, x, y, z)) (near ??= new Array<boolean>(path.length - from + 1).fill(false))[0] = true;
    for (let i = from; i < path.length; i++) {
      if (isNear(path[i]!, x, y, z)) (near ??= new Array<boolean>(path.length - from + 1).fill(false))[i - from + 1] = true;
    }
  }
  return near;
}

/** The plugin's start node for the bot where it stands now (getPathFromTo's), or null when it cannot be read. */
function startOf(bot: OffloadedBot, movements: StepRules): SearchParams['start'] | null {
  const pos = bot.entity?.position;
  if (!pos || typeof bot.blockAt !== 'function') return null;
  const p = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
  const b = bot.blockAt(p);
  const offset = b && pos.y - p.y > 0.001 && bot.entity?.onGround && !movements.emptyBlocks?.has(b.type) ? 1 : 0;
  return new Move(p.x, p.y + offset, p.z, movements.countScaffoldingItems?.() ?? 0, 0);
}
