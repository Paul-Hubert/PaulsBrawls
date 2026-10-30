// The pathfinding worker pool, main-thread side (docs/32 D, docs/31 §6.2). The bots, their physics, the look-ahead and
// the scripts stay on the main thread (O2: scripts get the real bot; O4: instant reclaim). Only mineflayer-pathfinder's
// A* moves, through the `searchOffload` hook that patches/ adds to the plugin: its own planning (not a caller's
// synchronous getPathTo) gets a context whose compute() answers "partial" until a worker has the path.
//
// The workers search over a MIRROR of the world, fed from the bots' own packets: one world per dimension in each
// worker, shared by every bot. A chunk is forwarded once, by the first bot that receives it, and refcounted by bot: it
// leaves the mirror when the last bot holding it unloads it, leaves the dimension or disconnects. Its bytes are copied
// once into a SharedArrayBuffer that every worker reads (no copy per worker, none per search). Block changes are
// forwarded from every holder, deduplicated per batch, and all world updates are batched per macrotask.
//
// Fallbacks to the main-thread search: a goal or Movements that cannot cross threads (unknown goal class, exclusion
// areas, a subclass), no live worker, a worker that died or threw, and a worker that did not answer by thinkTimeout +
// grace. A worker search that runs out of thinkTimeout answers 'timeout', as the main-thread search does.

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import { logger } from '../../logger';
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

/** The parts of a mineflayer bot the mirror and the hook read. Loose on purpose: fakes drive it in tests. */
export interface MirroredBot {
  _client?: { on?: (ev: string, fn: (packet: never) => void) => unknown };
  on?: (ev: string, fn: (...a: never[]) => void) => unknown;
  game?: { minY?: number; height?: number };
  world?: { getColumn?: (x: number, z: number) => { dump?: () => Buffer } | null | undefined };
  inventory?: { items?: () => Array<{ type: number; count: number; nbt?: unknown }> };
  entity?: { effects?: unknown };
  pathfinder?: { searchOffload?: (p: SearchParams) => unknown };
}

export interface PathWorkerOptions {
  workers: number;
  /** The Minecraft version of the registry the workers load. */
  version: string;
  /** Tests: another worker script. */
  workerUrl?: URL;
  /** How long past thinkTimeout a silent worker is waited for before the search falls back to the main thread. */
  graceMs?: number;
}

/** Counters for the smoke test and the vitals (since the pool started). */
export interface PathWorkerStats {
  workers: number;
  alive: number;
  inFlight: number;
  chunks: number;
  offloaded: number;
  done: number;
  fallbacks: Record<string, number>;
  restarts: number;
}

type WorldOp = Array<string | number | SharedArrayBuffer>;

interface Holder {
  bot: MirroredBot;
  dim: string | null;
  dimId: unknown;
  /** "dim|x,z" of every chunk this bot instance holds. */
  chunks: Set<string>;
  current: OffloadedSearch | null;
}

interface Slot {
  index: number;
  worker: Worker | null;
  inFlight: Map<number, OffloadedSearch>;
  crashes: number[];
  disabled: boolean;
}

const DEFAULT_GRACE_MS = 2_000;
/** A slot whose worker dies this many times in a minute is not restarted again. */
const MAX_CRASHES_PER_MINUTE = 3;

export class PathWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly holders = new WeakMap<object, Holder>();
  /** "dim|x,z" → the bot instances holding that chunk. */
  private readonly chunks = new Map<string, Set<Holder>>();
  private pending: WorldOp[] = [];
  /** Block position → the state last queued for it in this batch: N bots hearing one change send it once. */
  private pendingSets = new Map<string, number>();
  private flushScheduled = false;
  private seq = 0;
  private stopping = false;
  private readonly graceMs: number;
  private readonly workerUrl: URL;
  private readonly counters = { offloaded: 0, done: 0, restarts: 0, fallbacks: {} as Record<string, number> };

  constructor(private readonly opts: PathWorkerOptions) {
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.workerUrl = opts.workerUrl ?? new URL('./worker.mjs', import.meta.url);
    for (let i = 0; i < opts.workers; i++) {
      const slot: Slot = { index: i, worker: null, inFlight: new Map(), crashes: [], disabled: false };
      this.slots.push(slot);
      this.spawn(slot);
    }
    logger.info('pathworkers', `${opts.workers} pathfinding worker(s) started`);
  }

  // -- the mirror ------------------------------------------------------------------------------------------------

  /** Feed a bot's chunk and block packets to the mirror. Call right after createBot, before its first packet. */
  attach(bot: MirroredBot): void {
    const client = bot._client;
    if (typeof client?.on !== 'function' || this.holders.has(bot)) return;
    const h: Holder = { bot, dim: null, dimId: undefined, chunks: new Set(), current: null };
    this.holders.set(bot, h);
    const on = (ev: string, fn: (p: Record<string, unknown>) => void): void => {
      client.on!(ev, ((p: Record<string, unknown>) => {
        if (this.stopping) return;
        try {
          fn(p);
        } catch (e) {
          logger.warn('pathworkers', `mirror: ${ev} failed: ${(e as Error).message}`);
        }
      }) as never);
    };
    // Dimensions, as mineflayer's blocks plugin decides them (1.20.5+: worldState): a new world drops every column.
    on('login', (p) => {
      const ws = (p.worldState ?? p) as Record<string, unknown>;
      this.enterDimension(h, String(ws.name ?? ws.worldName ?? ws.dimension), ws.dimension);
    });
    on('respawn', (p) => {
      const ws = (p.worldState ?? p) as Record<string, unknown>;
      const name = String(ws.name ?? ws.worldName ?? ws.dimension);
      if (h.dimId === ws.dimension) return;
      if (h.dim === name && Boolean(p.copyMetadata)) return;
      this.enterDimension(h, name, ws.dimension);
    });
    on('map_chunk', (p) => this.onChunk(h, p.x as number, p.z as number, p.chunkData as Buffer));
    on('unload_chunk', (p) => {
      if (h.dim !== null) this.release(h, `${h.dim}|${p.chunkX as number},${p.chunkZ as number}`);
    });
    on('block_change', (p) => {
      const l = p.location as { x: number; y: number; z: number };
      this.onBlock(h, l.x, l.y, l.z, p.type as number);
    });
    on('multi_block_change', (p) => {
      const c = p.chunkCoordinates as { x: number; y: number; z: number };
      for (const r of p.records as number[]) {
        // 1.20+: one long per record, stateId << 12 | x << 8 | z << 4 | y (mineflayer's usesMultiblockSingleLong).
        this.onBlock(h, c.x * 16 + ((r >> 8) & 15), c.y * 16 + (r & 15), c.z * 16 + ((r >> 4) & 15), r >> 12);
      }
    });
    on('explosion', (p) => {
      const offsets = p.affectedBlockOffsets as Array<{ x: number; y: number; z: number }> | undefined;
      if (!offsets) return;
      for (const o of offsets) {
        this.onBlock(h, Math.floor((p.x as number) + o.x), Math.floor((p.y as number) + o.y), Math.floor((p.z as number) + o.z), 0);
      }
    });
    bot.on?.('end', () => {
      this.releaseAll(h);
      this.cancel(h);
      for (const s of this.slots) s.worker?.postMessage({ t: 'forget', bot: botKey(h) });
    });
  }

  /** Let the bot's pathfinder offload its searches. Call once the pathfinder plugin is loaded (at spawn). */
  install(bot: MirroredBot): void {
    const h = this.holders.get(bot);
    if (!h || !bot.pathfinder) return;
    bot.pathfinder.searchOffload = (p: SearchParams) => this.offload(h, p);
    // A stale search is cancelled as soon as the plugin drops it (it then starts the next one on its own).
    for (const ev of ['path_reset', 'goal_updated', 'path_stop']) bot.on?.(ev, () => this.cancel(h));
  }

  private enterDimension(h: Holder, name: string, id: unknown): void {
    this.releaseAll(h);
    h.dim = name;
    h.dimId = id;
  }

  private onChunk(h: Holder, x: number, z: number, data: Buffer | undefined): void {
    if (h.dim === null || !data) return;
    const key = `${h.dim}|${x},${z}`;
    let set = this.chunks.get(key);
    if (!set) {
      set = new Set();
      this.chunks.set(key, set);
    } else if (set.size > 0 && !set.has(h)) {
      // Another bot already mirrors this chunk, and its block changes keep the mirror current: not parsed twice.
      set.add(h);
      h.chunks.add(key);
      return;
    }
    // New to the mirror, or a re-send to the bot that holds it: (re)load it.
    set.add(h);
    h.chunks.add(key);
    this.push(['load', h.dim, x, z, h.bot.game?.minY ?? -64, h.bot.game?.height ?? 384, shared(data)]);
  }

  private onBlock(h: Holder, x: number, y: number, z: number, state: number): void {
    if (h.dim === null || !h.chunks.has(`${h.dim}|${x >> 4},${z >> 4}`)) return; // mineflayer ignores these too
    const k = `${h.dim}|${x},${y},${z}`;
    if (this.pendingSets.get(k) === state) return; // the same change, heard by another bot in this batch
    this.pendingSets.set(k, state);
    this.push(['set', h.dim, x, y, z, state]);
  }

  private release(h: Holder, key: string): void {
    if (!h.chunks.delete(key)) return;
    const set = this.chunks.get(key);
    if (!set) return;
    set.delete(h);
    if (set.size > 0) return;
    this.chunks.delete(key);
    const bar = key.indexOf('|');
    const [x, z] = key.slice(bar + 1).split(',').map(Number) as [number, number];
    this.push(['unload', key.slice(0, bar), x, z]);
  }

  private releaseAll(h: Holder): void {
    for (const key of [...h.chunks]) this.release(h, key);
  }

  private push(op: WorldOp): void {
    this.pending.push(op);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flush());
  }

  /** Send the batched world updates to every worker (also right before a search, so it sees them). */
  private flush(): void {
    this.flushScheduled = false;
    if (this.pending.length === 0) return;
    const ops = this.pending;
    this.pending = [];
    this.pendingSets = new Map();
    for (const s of this.slots) s.worker?.postMessage({ t: 'world', ops });
  }

  /** A new or replacement worker starts empty: give it every mirrored chunk, from a bot's own world. */
  private resync(slot: Slot): void {
    const ops: WorldOp[] = [];
    for (const [key, set] of this.chunks) {
      const bar = key.indexOf('|');
      const [x, z] = key.slice(bar + 1).split(',').map(Number) as [number, number];
      for (const h of set) {
        const data = h.bot.world?.getColumn?.(x, z)?.dump?.();
        if (!data) continue;
        ops.push(['load', key.slice(0, bar), x, z, h.bot.game?.minY ?? -64, h.bot.game?.height ?? 384, shared(data)]);
        break;
      }
    }
    if (ops.length > 0) slot.worker?.postMessage({ t: 'world', ops });
  }

  // -- the searches ------------------------------------------------------------------------------------------------

  private fallback(reason: string): null {
    this.counters.fallbacks[reason] = (this.counters.fallbacks[reason] ?? 0) + 1;
    return null;
  }

  /** The hook: a context for this search, or null to search on the main thread. */
  private offload(h: Holder, p: SearchParams): OffloadedSearch | null {
    if (this.stopping) return this.fallback('stopped');
    if (h.dim === null) return this.fallback('noDimension');
    const goal = serializeGoal(p.goal, (h.bot as { world?: unknown }).world);
    if (!goal) return this.fallback('goal');
    const settings = movementSettings(p.movements);
    if (!settings) return this.fallback('movements');
    const slot = this.pickSlot();
    if (!slot?.worker) return this.fallback('noWorker');
    this.cancel(h); // one search per bot: the new one supersedes the old
    if (this.flushScheduled) this.flush();
    const id = ++this.seq;
    const search = new OffloadedSearch(this, slot, id, p, performance.now() + p.timeout + this.graceMs);
    try {
      slot.worker.postMessage({
        t: 'search',
        id,
        dim: h.dim,
        bot: botKey(h),
        start: { x: p.start.x, y: p.start.y, z: p.start.z, remainingBlocks: p.start.remainingBlocks },
        goal: goal satisfies WireGoal,
        timeout: p.timeout,
        searchRadius: p.searchRadius,
        settings,
        entityIntersections: (p.movements as { entityIntersections?: unknown }).entityIntersections ?? {},
        items: itemSnapshot(h.bot.inventory?.items?.() ?? []),
        effects: h.bot.entity?.effects ?? {},
      });
    } catch {
      return this.fallback('clone'); // something in the snapshot cannot be cloned
    }
    slot.inFlight.set(id, search);
    h.current = search;
    this.counters.offloaded++;
    return search;
  }

  private pickSlot(): Slot | undefined {
    let best: Slot | undefined;
    for (const s of this.slots) {
      if (!s.worker || s.disabled) continue;
      if (!best || s.inFlight.size < best.inFlight.size) best = s;
    }
    return best;
  }

  private cancel(h: Holder): void {
    const s = h.current;
    if (!s) return;
    h.current = null;
    s.drop();
  }

  /** Called by a search that is dropped or that gave up on its worker. */
  forget(slot: Slot, id: number, notifyWorker: boolean): void {
    if (!slot.inFlight.delete(id)) return;
    if (notifyWorker) slot.worker?.postMessage({ t: 'cancel', id });
  }

  /** Called by a search that falls back to the main thread. */
  countFallback(reason: string): void {
    this.counters.fallbacks[reason] = (this.counters.fallbacks[reason] ?? 0) + 1;
  }

  // -- the workers -------------------------------------------------------------------------------------------------

  private spawn(slot: Slot): void {
    const w = new Worker(this.workerUrl, { workerData: { version: this.opts.version } });
    w.unref(); // the bots and the HTTP server keep the process alive, never an idle worker
    slot.worker = w;
    w.on('message', (m: WorkerMessage) => this.onMessage(slot, m));
    w.on('error', (e) => logger.warn('pathworkers', `worker ${slot.index} failed: ${e.message}`));
    w.on('exit', (code) => this.onExit(slot, w, code));
    this.resync(slot);
  }

  private onMessage(slot: Slot, m: WorkerMessage): void {
    if (m.t === 'ready') return;
    const search = slot.inFlight.get(m.id);
    if (!search) return; // cancelled meanwhile
    if (m.t === 'progress') search.onProgress(m.path, m.visitedChunks);
    else if (m.t === 'done') {
      slot.inFlight.delete(m.id);
      this.counters.done++;
      search.onDone(m);
    } else if (m.t === 'failed') {
      slot.inFlight.delete(m.id);
      logger.warn('pathworkers', `a search failed in worker ${slot.index} (${m.error}); it runs on the main thread`);
      search.onDead('failed');
    }
  }

  private onExit(slot: Slot, w: Worker, code: number): void {
    if (slot.worker !== w) return;
    slot.worker = null;
    for (const s of slot.inFlight.values()) s.onDead('workerDied');
    slot.inFlight.clear();
    if (this.stopping) return;
    const now = Date.now();
    slot.crashes = slot.crashes.filter((t) => now - t < 60_000);
    slot.crashes.push(now);
    if (slot.crashes.length >= MAX_CRASHES_PER_MINUTE) {
      slot.disabled = true;
      logger.warn('pathworkers', `worker ${slot.index} exited (${code}) ${slot.crashes.length} times in a minute: disabled`);
      return;
    }
    logger.warn('pathworkers', `worker ${slot.index} exited (${code}); restarting it`);
    this.counters.restarts++;
    this.spawn(slot);
  }

  stats(): PathWorkerStats {
    let inFlight = 0;
    let alive = 0;
    for (const s of this.slots) {
      inFlight += s.inFlight.size;
      if (s.worker && !s.disabled) alive++;
    }
    return { workers: this.slots.length, alive, inFlight, chunks: this.chunks.size, ...this.counters, fallbacks: { ...this.counters.fallbacks } };
  }

  /** Tests: end a worker as a crash would. */
  async killWorker(index: number): Promise<void> {
    await this.slots[index]?.worker?.terminate();
  }

  /** Terminate every worker. In-flight searches fall back to the main thread if anything still asks them. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const ws = this.slots.map((s) => s.worker).filter((w): w is Worker => w !== null);
    await Promise.all(ws.map((w) => w.terminate()));
    for (const s of this.slots) {
      for (const search of s.inFlight.values()) search.onDead('stopped');
      s.inFlight.clear();
      s.worker = null;
    }
    this.chunks.clear();
    this.pending = [];
  }
}

type WorkerMessage =
  | { t: 'ready' }
  | { t: 'progress'; id: number; path: WireNode[]; visitedChunks: string[] }
  | { t: 'done'; id: number; status: string; cost: number; time: number; visitedNodes: number; generatedNodes: number; path: WireNode[]; visitedChunks: string[] }
  | { t: 'failed'; id: number; error: string };

/**
 * One offloaded search, as the plugin sees it: the AStar context's compute() and visitedChunks. Until the worker
 * answers, compute() returns 'partial' with the best path the worker has reported so far (the start node at first:
 * the bot waits, where the main-thread search would walk its first 10 ms of best guess).
 */
export class OffloadedSearch {
  private partial: WireNode[] = [];
  private final: Extract<WorkerMessage, { t: 'done' }> | null = null;
  private local: AStarLike | null = null;
  private deadReason: string | null = null;
  private dropped = false;
  private chunksSeen = new Set<string>();
  private readonly startedAt = performance.now();

  constructor(
    private readonly pool: PathWorkerPool,
    private readonly slot: Slot,
    private readonly id: number,
    private readonly params: SearchParams,
    private readonly deadline: number,
  ) {}

  /** The chunks the search went through: the plugin re-plans when one next to them loads. */
  get visitedChunks(): Set<string> {
    return this.local ? this.local.visitedChunks : this.chunksSeen;
  }

  onProgress(path: WireNode[], chunks: string[]): void {
    this.partial = path;
    for (const c of chunks) this.chunksSeen.add(c);
  }

  onDone(m: Extract<WorkerMessage, { t: 'done' }>): void {
    this.final = m;
    this.chunksSeen = new Set(m.visitedChunks);
  }

  onDead(reason: string): void {
    this.deadReason ??= reason;
  }

  /** The plugin dropped this search (a reset, a new goal, a newer search). */
  drop(): void {
    this.dropped = true;
    this.pool.forget(this.slot, this.id, true);
  }

  compute(): AStarResult {
    if (this.local) return this.local.compute();
    if (this.final) {
      const f = this.final;
      return { status: f.status, cost: f.cost, time: f.time, visitedNodes: f.visitedNodes, generatedNodes: f.generatedNodes, path: rebuildPath(f.path), context: this };
    }
    const reason = this.deadReason ?? (this.dropped ? 'dropped' : performance.now() > this.deadline ? 'deadline' : null);
    if (reason) return this.runLocally(reason);
    return { status: 'partial', cost: 0, time: performance.now() - this.startedAt, visitedNodes: 0, generatedNodes: 0, path: this.waitingPath(), context: this };
  }

  /**
   * The best partial path so far, or, before the worker's first report, the start node alone. Never an empty path:
   * the plugin's goto() takes an empty path_update for "already there" and resolves, so every goTo would end at once
   * (found by the smoke test). On the start node the executor holds the bot still until a real path arrives.
   */
  private waitingPath(): unknown[] {
    if (this.partial.length > 0) return rebuildPath(this.partial);
    const s = this.params.start;
    return rebuildPath([{ x: s.x, y: s.y, z: s.z, remainingBlocks: s.remainingBlocks, cost: 0, parkour: false, toBreak: [], toPlace: [] }]);
  }

  /** The worker cannot answer: the same search, on the main thread, from the start (with a full thinkTimeout). */
  private runLocally(reason: string): AStarResult {
    this.pool.forget(this.slot, this.id, true);
    this.pool.countFallback(reason);
    const p = this.params;
    this.local = new AStar(p.start, p.movements, p.goal, p.timeout, p.tickTimeout, p.searchRadius);
    return this.local.compute();
  }
}

/** A bot instance's key in the worker (its Movements and stand-in): unique per instance, so a reconnect starts clean. */
const botKeys = new WeakMap<Holder, string>();
let botSeq = 0;
function botKey(h: Holder): string {
  let k = botKeys.get(h);
  if (!k) {
    k = `b${++botSeq}`;
    botKeys.set(h, k);
  }
  return k;
}

/** The chunk's bytes, copied once into memory every worker can read (a Buffer's own ArrayBuffer may be a whole pool). */
function shared(data: Buffer): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(data.byteLength);
  new Uint8Array(sab).set(data);
  return sab;
}
