// The job pool, main-thread side (docs/37 §2.5, D1): every read-only calculation of the runtime (aim, raycasts, line
// of sight, A*, block searches, as later phases add their handlers) runs on reader workers, in batches, each worker
// with a CPU budget per 50 ms tick (workers.tickBudgetMs, 40). The bots, their physics and the scripts stay here
// (§2.6); a caller submits a job and gets a promise.
//
// One tick of the dispatcher:
//  1. apply: the answers that came back since the last tick resolve (or reject) their promises, all at the start of
//     the tick, not whenever a worker's message lands (the main thread's "apply" step: look, release, set a path);
//  2. (after those promises' callbacks, on setImmediate, so a job they submit makes this tick) publish the entity
//     snapshot (snapshot.ts) when jobs are about;
//  3. dispatch: hand each idle worker a batch, in priority order (then deadline, then submit order), sized by a
//     running estimate (EWMA) of each job type's cost so it fits the budget. The worker stops early if the budget runs
//     out anyway (batch.mjs); what it did not start comes back and is queued again.
//
// The tick source. The dispatcher follows a bot's physicsTick (useTickSource, fed by ticks.ts with one online bot),
// so its ticks are the bots' ticks: mineflayer's physics keeps 20 ticks/s with its own catch-up, where a free-running
// setInterval(50) on Windows (15.6 ms timer quantum) fires late every time and drifts. Without a bot, or when the
// bot's ticks stop for 1.5 ticks, a self-correcting timer ticks instead (each tick aimed at start + n × 50 ms, at
// most 4 ticks of catch-up, as mineflayer). `ticks: 'manual'` (tests) leaves tick() to the caller.
//
// Long jobs answer { continue: state } and are resumed next tick on the same worker (their state stays there);
// `affinity` keys pin related jobs to one worker. A job not answered by its deadlineTick rejects with JobLateError.
//
// Fallbacks: no live worker (count 0, or every slot disabled after crashes) runs the same handler modules here,
// imported on first need, with a smaller budget (inlineBudgetMs). A dead worker is restarted (at most
// maxCrashesPerMinute a minute, then its slot is disabled, as pathworkers/client.ts); the jobs it had are queued again
// once, then fail. A restarted worker needs no resync: the world and the entities are shared memory. What a dead
// worker held there is released by this thread (its entity hold; its world reader, through world.release), since a
// worker killed inside a batch never got to leave().

import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers';

import { logger } from '../logger';
import { loadHandlers, runBatch, serializeError, type BatchEnv, type WireJob, type WireResult, type WorldReaderLike } from './batch.mjs';
import { openEntities, releaseReader } from './entities.mjs';
import { JobFailedError, JobLateError, type JobFailReason } from './errors';
import { EntitySnapshot, type EntitySource, type SnapshotStats } from './snapshot';

export { JobFailedError, JobLateError, type JobFailReason } from './errors';

export const TICK_MS = 50;
export const DEFAULT_TICK_BUDGET_MS = 40;
/** The main thread's budget per tick when jobs run inline: it also runs every bot. */
export const DEFAULT_INLINE_BUDGET_MS = 10;
/** A job type's cost before its first measurement. */
export const DEFAULT_COST_MS = 0.5;
/** The bot tick source counts as live while its last tick is this recent; then the timer takes over. */
export const SOURCE_GRACE_MS = 75;
const MAX_CATCHUP_TICKS = 4;
/** The snapshot is published while a job was submitted within this many ticks (an idle pool publishes nothing). */
const ACTIVE_TICKS = 20;
const DEFAULT_MAX_CRASHES_PER_MINUTE = 3;
/** Latencies kept per type and window for the percentiles. */
const LATENCY_SAMPLES = 2048;
const COST_ALPHA = 0.2;

/** A job, as a caller submits it. */
export interface JobSpec<I = unknown> {
  /** The handler's `type`. */
  type: string;
  /** Structured-cloned to the worker (or moved, for the buffers in `transfer`). */
  input: I;
  /** Higher first (default 0). Within a priority, the earlier deadline, then the earlier submit. */
  priority?: number;
  /** The last tick at whose apply step the answer is still wanted; later, the promise rejects with JobLateError. */
  deadlineTick?: number;
  /** Jobs with the same key run on the same worker (while one of them is queued or running). */
  affinity?: string;
  /**
   * Buffers moved to the worker with the input instead of copied. The job then lives on that worker: if it dies, the
   * job fails (`lostInput`) instead of being queued again.
   */
  transfer?: ArrayBuffer[];
  /** Cancels the job (its promise rejects with the signal's reason). */
  signal?: AbortSignal;
}

/** What useTickSource follows: a mineflayer bot (or anything emitting physicsTick). */
export interface TickSource {
  on(event: 'physicsTick', fn: () => void): unknown;
  removeListener(event: 'physicsTick', fn: () => void): unknown;
}

export interface JobPoolOptions {
  /** Worker threads; 0 runs every job inline. */
  workers: number;
  /** Per-worker budget per tick (workers.tickBudgetMs). */
  tickBudgetMs?: number;
  inlineBudgetMs?: number;
  /** The job handler modules (`export const type`, `export function run`). */
  handlers: URL[];
  /** The Minecraft version, for handlers that load the registry (ctx.version). */
  version?: string;
  /**
   * P1's shared world: descriptor() is called once per worker started (restarts too) and once for the inline reader.
   * release(descriptor), if the world has it, is called when that worker has died or stopped: a worker killed inside a
   * batch never called leave(), so its epoch would otherwise hold back the reuse of freed memory for good.
   */
  world?: { descriptor(): unknown; release?(descriptor: unknown): void };
  /** The module exporting openWorld(descriptor) (P1's squad/src/world/reader.mjs). */
  worldModule?: URL;
  /** The entity snapshot's source (the pool's online bots); absent, the snapshot stays empty. */
  entities?: EntitySource;
  entityCapacity?: number;
  /** 'auto' (default): bot ticks or the fallback timer; 'manual': only tick(). */
  ticks?: 'auto' | 'manual';
  maxCrashesPerMinute?: number;
  /** Tests: another worker script. */
  workerUrl?: URL;
}

export interface JobTypeStats {
  submitted: number;
  done: number;
  /** Sent to a worker but not started there (its budget ran out): queued again. */
  carried: number;
  /** Slices that answered { continue } and were resumed. */
  continued: number;
  late: number;
  failed: number;
  /** Run on the main thread (no worker alive). */
  inline: number;
  /** Queued again after their worker died. */
  retried: number;
  cancelled: number;
  /** Submit → resolve, of the jobs done in the window (null: none). */
  latencyMs: { p50: number | null; p95: number | null };
  /** The running estimate of one run (one slice), ms. */
  costMs: number | null;
}

export interface JobWorkerStats {
  index: number;
  alive: boolean;
  ready: boolean;
  disabled: boolean;
  restarts: number;
  batches: number;
  jobs: number;
  /** Budget use: ms per tick over the window (idle ticks count 0) and the longest batch. */
  budgetMs: { mean: number; max: number };
}

export interface JobStats {
  workers: number;
  alive: number;
  restarts: number;
  budgetMs: number;
  tick: number;
  tickSource: 'bot' | 'timer' | 'manual';
  /** Ticks in the window. */
  ticks: number;
  queue: number;
  queueMax: number;
  /** Out on a worker (or inline), not answered yet. */
  inFlight: number;
  /** Answered, waiting for the next tick's apply. */
  answered: number;
  /** The dispatcher's own main-thread time per tick (apply + publish + dispatch; not the jobs it runs inline). */
  dispatchMs: { mean: number; max: number };
  entities: SnapshotStats;
  inline: { loaded: boolean; budgetMs: number; batches: number; usedMs: { mean: number; max: number } };
  types: Record<string, JobTypeStats>;
  perWorker: JobWorkerStats[];
}

const ANY = -1;
const INLINE = -2;

interface Job {
  id: number;
  type: string;
  input: unknown;
  priority: number;
  deadlineTick: number;
  affinity?: string;
  transfer?: ArrayBuffer[];
  /** Its input went to a worker in a transfer list: only that worker has it. */
  transferred: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  submittedAt: number;
  /** ANY, INLINE, or the slot whose thread holds its state (or its transferred input). */
  home: number;
  /** Its state or input is held on `home`: it is sent as { resume: true }. */
  resume: boolean;
  retries: number;
  settled: boolean;
}

interface Meter {
  batches: number;
  jobs: number;
  usedMs: number;
  maxMs: number;
}

interface Slot {
  index: number;
  worker: Worker | null;
  /** Bumped by every start: an answer from an earlier worker of this slot holds no state any more. */
  gen: number;
  ready: boolean;
  /** A batch is out. */
  busy: boolean;
  batch: Job[];
  crashes: number[];
  disabled: boolean;
  restarts: number;
  meter: Meter;
  /** The world descriptor its current worker got (released when it ends). */
  world: unknown;
}

interface Arrived {
  slot: Slot | null;
  gen: number;
  results: WireResult[];
}

interface TypeCounters {
  submitted: number;
  done: number;
  carried: number;
  continued: number;
  late: number;
  failed: number;
  inline: number;
  retried: number;
  cancelled: number;
  lat: number[];
  latNext: number;
}

interface Inline {
  env: BatchEnv;
}

const newMeter = (): Meter => ({ batches: 0, jobs: 0, usedMs: 0, maxMs: 0 });

export class JobPool {
  private readonly slots: Slot[] = [];
  private queue: Job[] = [];
  private readonly inFlight = new Map<number, Job>();
  private arrived: Arrived[] = [];
  private readonly costs = new Map<string, number>();
  private readonly counters = new Map<string, TypeCounters>();
  private readonly affinities = new Map<string, { slot: number; refs: number }>();
  private readonly snapshot: EntitySnapshot;
  private readonly budgetMs: number;
  private readonly inlineBudgetMs: number;
  private readonly maxCrashes: number;
  private readonly workerUrl: URL;
  private readonly handlerHrefs: string[];
  private knownTypes: Set<string> | null = null;
  private seq = 0;
  private tickNo = 0;
  private activeUntil = -1;
  private stopped = false;
  private dispatching: Promise<void> | undefined;
  private pendingApplyMs = 0;
  private source: TickSource | null = null;
  private lastSourceAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextAt = 0;
  private inline: Inline | null = null;
  private inlineLoading: Promise<Inline | null> | null = null;
  private inlineFailed: string | null = null;
  private inlineBusy = false;
  private inlineMeter = newMeter();
  private readyWaiters: Array<() => void> = [];
  private restarts = 0;
  private window = { ticks: 0, queueMax: 0, dispatchSum: 0, dispatchMax: 0, dispatches: 0 };

  constructor(private readonly opts: JobPoolOptions) {
    this.budgetMs = opts.tickBudgetMs ?? DEFAULT_TICK_BUDGET_MS;
    this.inlineBudgetMs = opts.inlineBudgetMs ?? Math.min(DEFAULT_INLINE_BUDGET_MS, this.budgetMs);
    this.maxCrashes = opts.maxCrashesPerMinute ?? DEFAULT_MAX_CRASHES_PER_MINUTE;
    this.workerUrl = opts.workerUrl ?? new URL('./worker.mjs', import.meta.url);
    this.handlerHrefs = opts.handlers.map((u) => u.href);
    // One hold slot per worker slot, plus the main thread's (the inline fallback).
    this.snapshot = new EntitySnapshot({ capacity: opts.entityCapacity, readers: opts.workers + 1 });
    for (let i = 0; i < opts.workers; i++) {
      const slot: Slot = {
        index: i,
        worker: null,
        gen: 0,
        ready: false,
        busy: false,
        batch: [],
        crashes: [],
        disabled: false,
        restarts: 0,
        meter: newMeter(),
        world: undefined,
      };
      this.slots.push(slot);
      this.spawn(slot);
    }
    if (opts.ticks !== 'manual') {
      this.nextAt = performance.now() + TICK_MS;
      this.armTimer();
    }
    if (opts.workers > 0) logger.info('jobs', `${opts.workers} reader worker(s) started (budget ${this.budgetMs} ms per tick)`);
  }

  // -- submitting --------------------------------------------------------------------------------------------------

  /** Queue a job; the promise is its callback, resolved at the start of the tick after its answer came back. */
  submit<T = unknown>(spec: JobSpec): Promise<T> {
    const type = spec.type;
    if (this.stopped) return Promise.reject(new JobFailedError(type, 'stopped', 'the job pool is stopped'));
    if (this.knownTypes && !this.knownTypes.has(type)) {
      return Promise.reject(new JobFailedError(type, 'unknownType', `no handler for job type ${type}`));
    }
    if (spec.signal?.aborted) return Promise.reject(spec.signal.reason);
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        id: ++this.seq,
        type,
        input: spec.input,
        priority: spec.priority ?? 0,
        deadlineTick: spec.deadlineTick ?? Infinity,
        affinity: spec.affinity,
        transfer: spec.transfer && spec.transfer.length > 0 ? spec.transfer : undefined,
        transferred: false,
        signal: spec.signal,
        resolve: resolve as (v: unknown) => void,
        reject,
        submittedAt: performance.now(),
        home: ANY,
        resume: false,
        retries: 0,
        settled: false,
      };
      if (spec.signal) {
        job.onAbort = () => this.cancel(job);
        spec.signal.addEventListener('abort', job.onAbort, { once: true });
      }
      if (job.affinity !== undefined) {
        const a = this.affinities.get(job.affinity);
        if (a) a.refs++;
        else this.affinities.set(job.affinity, { slot: ANY, refs: 1 });
      }
      this.counter(type).submitted++;
      this.enqueue(job);
      this.activeUntil = this.tickNo + ACTIVE_TICKS;
    });
  }

  /** The number of the last tick. */
  get currentTick(): number {
    return this.tickNo;
  }

  /** Resolves when every worker that is not disabled has loaded its handlers (at once with no worker). */
  ready(): Promise<void> {
    if (!this.slots.some((s) => !s.disabled)) return this.loadInline().then(() => undefined);
    if (this.allReady()) return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }

  // -- the tick ----------------------------------------------------------------------------------------------------

  /** Follow a bot's physics ticks (null: back to the timer). */
  useTickSource(src: TickSource | null): void {
    if (this.source) this.source.removeListener('physicsTick', this.onSourceTick);
    this.source = src;
    if (src) src.on('physicsTick', this.onSourceTick);
  }

  private readonly onSourceTick = (): void => {
    this.lastSourceAt = performance.now();
    void this.tick();
  };

  private armTimer(): void {
    const delay = Math.max(0, this.nextAt - performance.now());
    this.timer = setTimeout(this.onTimer, delay);
    this.timer.unref();
  }

  private readonly onTimer = (): void => {
    this.timer = undefined;
    if (this.stopped) return;
    const now = performance.now();
    if (now - this.nextAt > MAX_CATCHUP_TICKS * TICK_MS) this.nextAt = now; // a stalled loop: no burst of catch-up ticks
    this.nextAt += TICK_MS;
    if (now - this.lastSourceAt >= SOURCE_GRACE_MS) void this.tick();
    this.armTimer();
  };

  /**
   * One tick: apply the answers now, then (setImmediate, after their callbacks) publish and dispatch. Ticks within one
   * macrotask (mineflayer's catch-up) share one dispatch. Resolves once the dispatch ran.
   */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.tickNo++;
    this.window.ticks++;
    const t0 = performance.now();
    this.apply();
    this.pendingApplyMs += performance.now() - t0;
    return (this.dispatching ??= new Promise<void>((resolve) => {
      setImmediate(() => {
        this.dispatching = undefined;
        this.dispatch().then(resolve, (e: unknown) => {
          logger.warn('jobs', `dispatch failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
          resolve();
        });
      });
    }));
  }

  // -- apply -------------------------------------------------------------------------------------------------------

  private apply(): void {
    if (this.arrived.length === 0) return;
    const arrived = this.arrived;
    this.arrived = [];
    for (const a of arrived) for (const r of a.results) this.applyResult(a, r);
  }

  private applyResult(a: Arrived, r: WireResult): void {
    const job = this.inFlight.get(r.id);
    if (!job) return;
    this.inFlight.delete(r.id);
    const lost = a.slot !== null && a.gen !== a.slot.gen; // its worker died since: whatever it held is gone
    if (job.settled) {
      // Cancelled meanwhile: let its thread forget what it holds for it.
      if (!lost && (r.r === 'continue' || (r.r === 'notStarted' && r.held))) this.dropOn(a.slot, [job.id]);
      return;
    }
    const c = this.counter(job.type);
    if (a.slot === null && r.r !== 'notStarted') c.inline++;
    switch (r.r) {
      case 'done': {
        this.observeCost(job.type, r.ms);
        if (job.deadlineTick < this.tickNo) return this.late(job, c);
        c.done++;
        this.recordLatency(c, performance.now() - job.submittedAt);
        this.settle(job);
        job.resolve(r.value);
        return;
      }
      case 'failed': {
        if (r.ms > 0) this.observeCost(job.type, r.ms);
        if (r.lost) return this.lose(job);
        const reason: JobFailReason = r.unknownType ? 'unknownType' : r.clone ? 'clone' : 'threw';
        return this.fail(job, new JobFailedError(job.type, reason, r.error.message, r.error));
      }
      case 'continue': {
        this.observeCost(job.type, r.ms);
        c.continued++;
        if (lost) return this.lose(job);
        job.home = a.slot ? a.slot.index : INLINE;
        job.resume = true;
        this.enqueue(job);
        return;
      }
      case 'notStarted': {
        c.carried++;
        if (r.held) {
          if (lost) return this.lose(job);
          job.home = a.slot ? a.slot.index : INLINE;
          job.resume = true;
        }
        this.enqueue(job);
        return;
      }
    }
  }

  // -- dispatch ----------------------------------------------------------------------------------------------------

  private async dispatch(): Promise<void> {
    if (this.stopped) return;
    const t0 = performance.now();
    const tick = this.tickNo;
    if (this.opts.entities && tick <= this.activeUntil) {
      try {
        this.snapshot.write(tick, this.opts.entities);
      } catch (e) {
        logger.warn('jobs', `entity snapshot failed: ${(e as Error).message}`);
      }
    }
    if (this.queue.length > this.window.queueMax) this.window.queueMax = this.queue.length;
    if (!this.slots.some((s) => !s.disabled)) {
      const inlineJobs = this.pickInline(tick);
      this.endDispatch(t0);
      if (inlineJobs) await this.runInline(tick, inlineJobs);
      return;
    }
    this.assign(tick);
    this.endDispatch(t0);
  }

  private endDispatch(t0: number): void {
    const ms = this.pendingApplyMs + (performance.now() - t0);
    this.pendingApplyMs = 0;
    const w = this.window;
    w.dispatchSum += ms;
    w.dispatches++;
    if (ms > w.dispatchMax) w.dispatchMax = ms;
  }

  /** Fill each idle worker's batch in priority order, by estimated cost, up to its budget. */
  private assign(tick: number): void {
    const cands: Array<{ slot: Slot; load: number; jobs: Job[] }> = [];
    for (const s of this.slots) if (s.worker && s.ready && !s.busy && !s.disabled) cands.push({ slot: s, load: 0, jobs: [] });
    const keep: Job[] = [];
    let full = cands.length === 0;
    for (const job of this.queue) {
      // A worker's answer is applied next tick: a job due by this tick cannot make it.
      if (job.deadlineTick <= tick) {
        this.late(job, this.counter(job.type));
        continue;
      }
      if (full) {
        keep.push(job);
        continue;
      }
      const est = this.costs.get(job.type) ?? DEFAULT_COST_MS;
      const pin = job.home >= 0 ? job.home : job.affinity !== undefined ? (this.affinities.get(job.affinity)?.slot ?? ANY) : ANY;
      let target: (typeof cands)[number] | undefined;
      if (pin >= 0) {
        target = cands.find((c) => c.slot.index === pin);
        // Its worker is busy (or full) this tick: it waits for it, without holding back the others.
        if (!target || (target.load > 0 && target.load + est > this.budgetMs)) {
          keep.push(job);
          continue;
        }
      } else {
        for (const c of cands) {
          if (c.load > 0 && c.load + est > this.budgetMs) continue;
          if (!target || c.load < target.load) target = c;
        }
        if (!target) {
          // Strict priority: nothing lower goes before it.
          full = true;
          keep.push(job);
          continue;
        }
      }
      target.load += est;
      target.jobs.push(job);
      if (job.affinity !== undefined) {
        const a = this.affinities.get(job.affinity);
        if (a && a.slot === ANY) a.slot = target.slot.index;
      }
      if (cands.every((c) => c.load >= this.budgetMs)) full = true;
    }
    this.queue = keep;
    for (const c of cands) if (c.jobs.length > 0) this.send(c.slot, c.jobs, tick);
  }

  private send(slot: Slot, jobs: Job[], tick: number): void {
    const transfer: ArrayBuffer[] = [];
    const wire: WireJob[] = jobs.map((j) => {
      const est = this.costs.get(j.type) ?? DEFAULT_COST_MS;
      if (j.resume) return { id: j.id, type: j.type, resume: true, deadlineTick: j.deadlineTick, est };
      if (j.transfer) transfer.push(...j.transfer);
      return { id: j.id, type: j.type, input: j.input, transferred: j.transfer !== undefined, deadlineTick: j.deadlineTick, est };
    });
    const msg = { t: 'batch', tick, budgetMs: this.budgetMs, jobs: wire };
    try {
      slot.worker!.postMessage(msg, transfer);
    } catch (e) {
      // An input that cannot be copied fails alone; the rest go.
      const ok: Job[] = [];
      for (const j of jobs) {
        if (j.resume || j.transfer) {
          ok.push(j);
          continue;
        }
        try {
          structuredClone(j.input);
          ok.push(j);
        } catch (err) {
          this.fail(j, new JobFailedError(j.type, 'clone', `the job's input cannot be copied to a worker: ${(err as Error).message}`));
        }
      }
      if (ok.length === jobs.length) {
        for (const j of jobs) this.fail(j, new JobFailedError(j.type, 'clone', `the batch cannot be sent to a worker: ${(e as Error).message}`));
        return;
      }
      if (ok.length > 0) this.send(slot, ok, tick);
      return;
    }
    for (const j of jobs) {
      if (j.transfer) j.transferred = true;
      this.inFlight.set(j.id, j);
    }
    slot.busy = true;
    slot.batch = jobs;
  }

  // -- inline (no worker alive) ------------------------------------------------------------------------------------

  /** This tick's inline batch, or null (busy, still loading, or nothing to run). */
  private pickInline(tick: number): Job[] | null {
    const keep: Job[] = [];
    const picked: Job[] = [];
    let load = 0;
    const ready = this.inline !== null && !this.inlineBusy;
    for (const job of this.queue) {
      // Inline, an answer is applied at once: a job due by this very tick still makes it.
      if (job.deadlineTick < tick) {
        this.late(job, this.counter(job.type));
        continue;
      }
      if (!ready || job.home >= 0) {
        // Its state is on a worker that died: lose() takes it; never run a resume here without its state.
        keep.push(job);
        continue;
      }
      const est = this.costs.get(job.type) ?? DEFAULT_COST_MS;
      if (picked.length > 0 && load + est > this.inlineBudgetMs) {
        keep.push(job);
        continue;
      }
      load += est;
      picked.push(job);
    }
    this.queue = keep;
    if (!this.inline && !this.inlineBusy && this.queue.length > 0) void this.loadInline();
    if (this.inlineFailed) {
      for (const job of this.queue) this.fail(job, new JobFailedError(job.type, 'unavailable', `no worker is alive and the main thread cannot run jobs: ${this.inlineFailed}`));
      this.queue = [];
    }
    return picked.length > 0 ? picked : null;
  }

  private async runInline(tick: number, jobs: Job[]): Promise<void> {
    const inl = this.inline!;
    this.inlineBusy = true;
    const wire: WireJob[] = jobs.map((j) => {
      this.inFlight.set(j.id, j);
      const est = this.costs.get(j.type) ?? DEFAULT_COST_MS;
      return j.resume
        ? { id: j.id, type: j.type, resume: true, deadlineTick: j.deadlineTick, est }
        : { id: j.id, type: j.type, input: j.input, deadlineTick: j.deadlineTick, est };
    });
    let out: { results: WireResult[]; usedMs: number };
    try {
      out = await runBatch({ tick, budgetMs: this.inlineBudgetMs, jobs: wire }, inl.env);
    } catch (e) {
      // Not a handler (runBatch catches those): the world's enter/leave or the entity reader threw.
      const err = serializeError(e);
      for (const j of jobs) {
        this.inFlight.delete(j.id);
        this.fail(j, new JobFailedError(j.type, 'threw', `the inline batch failed: ${err.message}`, err));
      }
      return;
    } finally {
      this.inlineBusy = false;
    }
    this.record(this.inlineMeter, out.usedMs, out.results);
    // Computed at this tick: applied at once, not at the next one.
    const a: Arrived = { slot: null, gen: 0, results: out.results };
    for (const r of out.results) this.applyResult(a, r);
  }

  private loadInline(): Promise<Inline | null> {
    if (this.inline) return Promise.resolve(this.inline);
    if (this.inlineFailed) return Promise.resolve(null);
    return (this.inlineLoading ??= (async () => {
      try {
        let world: WorldReaderLike | null = null;
        if (this.opts.worldModule) {
          const mod = (await import(this.opts.worldModule.href)) as { openWorld(d: unknown): WorldReaderLike };
          world = mod.openWorld(this.opts.world?.descriptor());
        }
        const { handlers, errors } = await loadHandlers(this.handlerHrefs, { version: this.opts.version, world, inline: true, worker: -1 });
        for (const e of errors) logger.warn('jobs', `inline: handler ${e.url} not loaded: ${e.message}`);
        this.knownTypes ??= new Set(handlers.keys());
        const entities = openEntities(this.snapshot.handles, this.opts.workers);
        this.inline = {
          env: { handlers, held: new Map(), costs: new Map(), world, entities, version: this.opts.version, worker: -1, inline: true },
        };
        logger.info('jobs', 'no reader worker alive: jobs run on the main thread');
        return this.inline;
      } catch (e) {
        this.inlineFailed = e instanceof Error ? e.message : String(e);
        logger.warn('jobs', `the inline fallback cannot load: ${this.inlineFailed}`);
        return null;
      } finally {
        this.inlineLoading = null;
      }
    })());
  }

  // -- settling ----------------------------------------------------------------------------------------------------

  private enqueue(job: Job): void {
    const q = this.queue;
    let lo = 0;
    let hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(q[mid]!, job)) lo = mid + 1;
      else hi = mid;
    }
    q.splice(lo, 0, job);
  }

  private settle(job: Job): void {
    job.settled = true;
    if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
    if (job.affinity !== undefined) {
      const a = this.affinities.get(job.affinity);
      if (a && --a.refs <= 0) this.affinities.delete(job.affinity);
    }
  }

  private late(job: Job, c: TypeCounters): void {
    c.late++;
    this.forgetHeld(job);
    this.settle(job);
    job.reject(new JobLateError(job.type, job.deadlineTick, this.tickNo));
  }

  private fail(job: Job, e: JobFailedError): void {
    if (job.settled) return;
    this.counter(job.type).failed++;
    this.forgetHeld(job);
    this.settle(job);
    job.reject(e);
  }

  private cancel(job: Job): void {
    if (job.settled) return;
    const i = this.queue.indexOf(job);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.forgetHeld(job);
    }
    this.counter(job.type).cancelled++;
    this.settle(job);
    job.reject(job.signal?.reason);
  }

  /** A queued job whose state or input waits on a thread: that thread can drop it. */
  private forgetHeld(job: Job): void {
    if (!job.resume || this.inFlight.has(job.id)) return;
    if (job.home >= 0) this.dropOn(this.slots[job.home] ?? null, [job.id]);
    else if (job.home === INLINE) this.inline?.env.held.delete(job.id);
  }

  private dropOn(slot: Slot | null, ids: number[]): void {
    if (slot === null) {
      for (const id of ids) this.inline?.env.held.delete(id);
      return;
    }
    try {
      slot.worker?.postMessage({ t: 'drop', ids });
    } catch {
      /* gone */
    }
  }

  /** Its worker died with its state or its input: queued again once (from scratch), else failed. */
  private lose(job: Job): void {
    if (job.settled) return;
    if (job.transferred) {
      this.fail(job, new JobFailedError(job.type, 'lostInput', 'its worker died holding its transferred input'));
      return;
    }
    if (job.retries >= 1) {
      this.fail(job, new JobFailedError(job.type, 'workerDied', 'its worker died twice while running it'));
      return;
    }
    job.retries++;
    job.home = ANY;
    job.resume = false;
    this.counter(job.type).retried++;
    this.enqueue(job);
  }

  // -- the workers -------------------------------------------------------------------------------------------------

  private spawn(slot: Slot): void {
    let w: Worker;
    try {
      slot.world = this.opts.world?.descriptor();
      w = new Worker(this.workerUrl, {
        workerData: {
          handlers: this.handlerHrefs,
          budgetMs: this.budgetMs,
          worldModule: this.opts.worldModule?.href,
          world: slot.world,
          entities: this.snapshot.handles,
          version: this.opts.version,
          index: slot.index,
        },
      });
    } catch (e) {
      logger.warn('jobs', `worker ${slot.index} cannot start: ${(e as Error).message}`);
      this.releaseSlot(slot);
      slot.disabled = true;
      this.checkReady();
      return;
    }
    w.unref(); // the bots and the HTTP server keep the process alive, never an idle worker
    slot.worker = w;
    slot.gen++;
    slot.ready = false;
    slot.busy = false;
    slot.batch = [];
    w.on('message', (m: WorkerMessage) => this.onMessage(slot, w, m));
    w.on('error', (e) => logger.warn('jobs', `worker ${slot.index} failed: ${e.stack ?? e.message}`));
    w.on('exit', (code) => this.onExit(slot, w, code));
  }

  private onMessage(slot: Slot, w: Worker, m: WorkerMessage): void {
    if (slot.worker !== w) return;
    if (m.t === 'ready') {
      slot.ready = true;
      this.knownTypes ??= new Set(m.types);
      for (const e of m.errors) logger.warn('jobs', `worker ${slot.index}: handler ${e.url} not loaded: ${e.message}`);
      this.checkReady();
      return;
    }
    if (m.t === 'done') {
      slot.busy = false;
      slot.batch = [];
      this.record(slot.meter, m.usedMs, m.results);
      this.arrived.push({ slot, gen: slot.gen, results: m.results });
    }
  }

  /** What a dead (or stopped) worker held in shared memory: its entity hold and its world reader's epoch. */
  private releaseSlot(slot: Slot): void {
    releaseReader(this.snapshot.handles, slot.index);
    const d = slot.world;
    slot.world = undefined;
    if (d === undefined || !this.opts.world?.release) return;
    try {
      this.opts.world.release(d);
    } catch (e) {
      logger.warn('jobs', `worker ${slot.index}: releasing its world reader failed: ${(e as Error).message}`);
    }
  }

  private onExit(slot: Slot, w: Worker, code: number): void {
    if (slot.worker !== w) return;
    slot.worker = null;
    // Answers it sent that are not applied yet hold no state any more (even if the slot is disabled, not restarted).
    slot.gen++;
    slot.ready = false;
    slot.busy = false;
    this.releaseSlot(slot);
    const out = slot.batch;
    slot.batch = [];
    if (this.stopped) return;
    for (const job of out) {
      this.inFlight.delete(job.id);
      this.lose(job);
    }
    // Queued jobs whose state was on it.
    const stranded = this.queue.filter((j) => j.home === slot.index && j.resume);
    if (stranded.length > 0) {
      this.queue = this.queue.filter((j) => !(j.home === slot.index && j.resume));
      for (const j of stranded) this.lose(j);
    }
    for (const a of this.affinities.values()) if (a.slot === slot.index) a.slot = ANY;
    const now = Date.now();
    slot.crashes = slot.crashes.filter((t) => now - t < 60_000);
    slot.crashes.push(now);
    if (slot.crashes.length >= this.maxCrashes) {
      slot.disabled = true;
      logger.warn('jobs', `worker ${slot.index} exited (${code}) ${slot.crashes.length} times in a minute: disabled`);
      if (!this.slots.some((s) => !s.disabled)) logger.warn('jobs', 'every reader worker is disabled: jobs run on the main thread');
      this.checkReady();
      return;
    }
    logger.warn('jobs', `worker ${slot.index} exited (${code}); restarting it`);
    slot.restarts++;
    this.restarts++;
    this.spawn(slot);
  }

  private allReady(): boolean {
    return this.slots.every((s) => s.disabled || s.ready);
  }

  private checkReady(): void {
    if (!this.allReady() || this.readyWaiters.length === 0) return;
    const ws = this.readyWaiters;
    this.readyWaiters = [];
    if (!this.slots.some((s) => !s.disabled)) {
      void this.loadInline().then(() => ws.forEach((r) => r()));
      return;
    }
    for (const r of ws) r();
  }

  // -- stats -------------------------------------------------------------------------------------------------------

  private counter(type: string): TypeCounters {
    let c = this.counters.get(type);
    if (!c) {
      c = { submitted: 0, done: 0, carried: 0, continued: 0, late: 0, failed: 0, inline: 0, retried: 0, cancelled: 0, lat: [], latNext: 0 };
      this.counters.set(type, c);
    }
    return c;
  }

  private observeCost(type: string, ms: number): void {
    const prev = this.costs.get(type);
    this.costs.set(type, prev === undefined ? ms : prev + COST_ALPHA * (ms - prev));
  }

  private recordLatency(c: TypeCounters, ms: number): void {
    if (c.lat.length < LATENCY_SAMPLES) c.lat.push(ms);
    else {
      c.lat[c.latNext] = ms;
      c.latNext = (c.latNext + 1) % LATENCY_SAMPLES;
    }
  }

  private record(m: Meter, usedMs: number, results: WireResult[]): void {
    m.batches++;
    for (const r of results) if (r.r !== 'notStarted') m.jobs++;
    m.usedMs += usedMs;
    if (usedMs > m.maxMs) m.maxMs = usedMs;
  }

  /** Counters since the last reset (or the start); with `reset`, start a new window (the vitals sampler does). */
  stats(reset = false): JobStats {
    const w = this.window;
    const ticks = Math.max(1, w.ticks);
    const types: Record<string, JobTypeStats> = {};
    for (const [type, c] of this.counters) {
      const cost = this.costs.get(type);
      types[type] = {
        submitted: c.submitted,
        done: c.done,
        carried: c.carried,
        continued: c.continued,
        late: c.late,
        failed: c.failed,
        inline: c.inline,
        retried: c.retried,
        cancelled: c.cancelled,
        latencyMs: { p50: percentile(c.lat, 0.5), p95: percentile(c.lat, 0.95) },
        costMs: cost === undefined ? null : round(cost, 3),
      };
    }
    let answered = 0;
    for (const a of this.arrived) answered += a.results.length;
    const s: JobStats = {
      workers: this.slots.length,
      alive: this.slots.filter((x) => x.worker !== null && !x.disabled).length,
      restarts: this.restarts,
      budgetMs: this.budgetMs,
      tick: this.tickNo,
      tickSource: this.opts.ticks === 'manual' ? 'manual' : performance.now() - this.lastSourceAt < SOURCE_GRACE_MS ? 'bot' : 'timer',
      ticks: w.ticks,
      queue: this.queue.length,
      queueMax: Math.max(w.queueMax, this.queue.length),
      inFlight: this.inFlight.size - answered,
      answered,
      dispatchMs: { mean: round(w.dispatches > 0 ? w.dispatchSum / w.dispatches : 0, 3), max: round(w.dispatchMax, 3) },
      entities: this.snapshot.stats(reset),
      inline: {
        loaded: this.inline !== null,
        budgetMs: this.inlineBudgetMs,
        batches: this.inlineMeter.batches,
        usedMs: { mean: round(this.inlineMeter.usedMs / ticks, 3), max: round(this.inlineMeter.maxMs, 3) },
      },
      types,
      perWorker: this.slots.map((x) => ({
        index: x.index,
        alive: x.worker !== null && !x.disabled,
        ready: x.ready,
        disabled: x.disabled,
        restarts: x.restarts,
        batches: x.meter.batches,
        jobs: x.meter.jobs,
        budgetMs: { mean: round(x.meter.usedMs / ticks, 3), max: round(x.meter.maxMs, 3) },
      })),
    };
    if (reset) {
      this.window = { ticks: 0, queueMax: this.queue.length, dispatchSum: 0, dispatchMax: 0, dispatches: 0 };
      for (const c of this.counters.values()) {
        c.submitted = c.done = c.carried = c.continued = c.late = c.failed = c.inline = c.retried = c.cancelled = 0;
        c.lat = [];
        c.latNext = 0;
      }
      for (const x of this.slots) x.meter = newMeter();
      this.inlineMeter = newMeter();
    }
    return s;
  }

  // -- tests and shutdown ------------------------------------------------------------------------------------------

  /** Tests: end a worker as a crash would. */
  async killWorker(index: number): Promise<void> {
    await this.slots[index]?.worker?.terminate();
  }

  /** Terminate the workers; every job still pending rejects (`stopped`). */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.useTickSource(null);
    const ws = this.slots.map((s) => s.worker).filter((w): w is Worker => w !== null);
    for (const s of this.slots) s.worker = null;
    await Promise.all(ws.map((w) => w.terminate()));
    for (const s of this.slots) this.releaseSlot(s);
    const pending = [...this.queue, ...this.inFlight.values()];
    this.queue = [];
    this.inFlight.clear();
    this.arrived = [];
    for (const j of pending) this.fail(j, new JobFailedError(j.type, 'stopped', 'the job pool stopped'));
    for (const r of this.readyWaiters) r();
    this.readyWaiters = [];
  }
}

type WorkerMessage =
  | { t: 'ready'; types: string[]; errors: Array<{ url: string; message: string }> }
  | { t: 'done'; tick: number; usedMs: number; results: WireResult[] };

/** Queue order: higher priority, then earlier deadline, then earlier submit. */
function before(a: Job, b: Job): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  if (a.deadlineTick !== b.deadlineTick) return a.deadlineTick < b.deadlineTick;
  return a.id < b.id;
}

function percentile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return round(s[Math.min(s.length - 1, Math.floor(q * s.length))]!, 2);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
