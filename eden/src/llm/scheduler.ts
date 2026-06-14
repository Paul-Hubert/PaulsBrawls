// The LLM scheduler (layer 2) — v1's scheduler vocabulary kept (global concurrency cap, priority
// lanes, per-villager cooldown, same-(villager,kind) coalescing) with three Eden amendments (04 §Scheduling):
//   1. God preempts — desk calls (lane 'god') outrank every villager lane.
//   2. Rollout immunity — a request carrying a rolloutId bypasses coalescing, cooldown, AND the rate
//      cap (the density invariant: a refinement turn is never suppressed).
//   3. Suppression is curriculum's job — the only engine-side suppressor is a DUMB per-villager
//      per-minute rate cap (R36 circuit breaker). It resets every minute by construction, so it can
//      throttle a burst but never become a permanent gag.
//
// This is the M2-L3 skeleton: the queue/lane/throttle mechanics are live and tested; God desks and
// villager brains route every LLM call through `enqueue` from M3 on. BudgetTracker is a skeleton
// here (caps are consumed in M4-4 / D-13).

/** The scheduling lanes, highest priority first. 'god' is the preempt lane (amendment 1). */
export type Lane = 'god' | 'player' | 'combat' | 'conversation' | 'directive' | 'job' | 'idle';
const LANE_ORDER: readonly Lane[] = ['god', 'player', 'combat', 'conversation', 'directive', 'job', 'idle'];
const LANE_RANK = new Map<Lane, number>(LANE_ORDER.map((l, i) => [l, i]));

/** One scheduled LLM call. `run` is the actual work (a client.chat wrapper); the result flows back. */
export interface WakeupRequest<T> {
  /** Who is waking — a villager name, or a desk actor like 'god:critic'. Keys cooldown + rate cap. */
  villager: string;
  lane: Lane;
  /** For same-(villager,kind) coalescing — a heartbeat collapses, two distinct kinds do not. */
  kind: string;
  /** Set inside an open rollout: bypass coalescing/cooldown/rate cap (the density invariant). */
  rolloutId?: string;
  run: () => Promise<T>;
}

/** A wake-up was dropped by the per-minute rate cap (R36) — a throttled burst, never a permanent gag. */
export class RateCappedError extends Error {
  constructor(villager: string) {
    super(`rate cap: ${villager} exceeded the per-minute wake-up budget — throttled this minute (R36)`);
    this.name = 'RateCappedError';
  }
}

interface Waiter {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}
interface Queued {
  villager: string;
  lane: Lane;
  kind: string;
  bypass: boolean;
  run: () => Promise<unknown>;
  waiters: Waiter[];
  enqueuedAt: number;
}

/** Construction options. The rate cap is a hardcoded circuit breaker (S7) — not a config key. */
export interface LlmSchedulerOptions {
  maxConcurrent: number;
  perVillagerCooldownMs: number;
  /** Max wake-ups per villager per minute before the dumb circuit breaker drops them. Default 12 (R36). */
  rateCapPerMinute?: number;
  now?: () => number;
}

/** The priority-lane scheduler with concurrency cap, coalescing, cooldown, and the R36 rate cap. */
export class LlmScheduler {
  private readonly maxConcurrent: number;
  private readonly cooldownMs: number;
  private readonly rateCap: number;
  private readonly now: () => number;
  private readonly queue: Queued[] = [];
  private running = 0;
  private seq = 0;
  private drainScheduled = false;
  private paused = false;
  private readonly lastRunAt = new Map<string, number>();
  private readonly minuteCount = new Map<string, { window: number; count: number }>();

  constructor(opts: LlmSchedulerOptions) {
    this.maxConcurrent = opts.maxConcurrent;
    this.cooldownMs = opts.perVillagerCooldownMs;
    this.rateCap = opts.rateCapPerMinute ?? 12;
    this.now = opts.now ?? Date.now;
  }

  /** Pending (not-yet-started) wake-ups — surfaced as a queue depth on admin /status. */
  pending(): number {
    return this.queue.length;
  }

  /** Whether LLM scheduling is currently gated (admin POST /pause). */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Gate LLM scheduling (admin POST /pause, 05). Queued + future wake-ups are HELD (not dropped) — the
   * pause is total: even god/rollout-immune work waits, since a paused village should make no LLM calls
   * at all. Skills (zero-token engine runs) and subscriptions keep running — they don't route here.
   */
  pause(): void {
    this.paused = true;
  }

  /** Lift the gate (admin POST /resume) and drain whatever piled up while paused. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.scheduleDrain();
  }

  /** Schedule an LLM call; resolves with its result, or rejects (RateCapped, or the run's own error). */
  enqueue<T>(req: WakeupRequest<T>): Promise<T> {
    const bypass = req.lane === 'god' || req.rolloutId !== undefined;
    if (!bypass) {
      if (this.rateCapped(req.villager)) {
        return Promise.reject(new RateCappedError(req.villager));
      }
      // Coalesce onto an already-queued same-(villager,kind) wake-up (also non-bypass).
      const existing = this.queue.find((q) => !q.bypass && q.villager === req.villager && q.kind === req.kind);
      if (existing) {
        return new Promise<T>((resolve, reject) => existing.waiters.push({ resolve: resolve as (v: unknown) => void, reject }));
      }
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        villager: req.villager,
        lane: req.lane,
        kind: req.kind,
        bypass,
        run: req.run as () => Promise<unknown>,
        waiters: [{ resolve: resolve as (v: unknown) => void, reject }],
        enqueuedAt: this.seq++,
      });
      // Defer the drain so a synchronous BURST of enqueues all land first — only then is the
      // highest-priority lane chosen (else the first arrival grabs the slot regardless of lane),
      // and same-(villager,kind) wake-ups in the same tick can still coalesce.
      this.scheduleDrain();
    });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private rateCapped(villager: string): boolean {
    const minute = Math.floor(this.now() / 60_000);
    const slot = this.minuteCount.get(villager);
    if (!slot || slot.window !== minute) {
      this.minuteCount.set(villager, { window: minute, count: 1 });
      return false;
    }
    if (slot.count >= this.rateCap) return true;
    slot.count++;
    return false;
  }

  private drain(): void {
    if (this.paused) return; // admin POST /pause holds the whole queue (05) — nothing starts.
    while (this.running < this.maxConcurrent) {
      const pick = this.selectEligible();
      if (!pick) break;
      this.queue.splice(this.queue.indexOf(pick), 1);
      this.start(pick);
    }
  }

  /** Highest-priority lane, oldest first, skipping villagers still inside their cooldown (unless bypass). */
  private selectEligible(): Queued | undefined {
    const now = this.now();
    let best: Queued | undefined;
    let soonest = Infinity;
    for (const q of this.queue) {
      if (!q.bypass) {
        const last = this.lastRunAt.get(q.villager);
        if (last !== undefined) {
          const ready = last + this.cooldownMs;
          if (ready > now) {
            soonest = Math.min(soonest, ready - now);
            continue; // in cooldown — not eligible yet
          }
        }
      }
      if (!best || this.outranks(q, best)) best = q;
    }
    if (!best && soonest !== Infinity) {
      // Everything pending is cooling down — re-drain when the earliest becomes eligible.
      const t = setTimeout(() => this.drain(), soonest);
      if (typeof t === 'object') t.unref();
    }
    return best;
  }

  private outranks(a: Queued, b: Queued): boolean {
    const ra = LANE_RANK.get(a.lane) ?? LANE_ORDER.length;
    const rb = LANE_RANK.get(b.lane) ?? LANE_ORDER.length;
    if (ra !== rb) return ra < rb; // lower index = higher priority
    return a.enqueuedAt < b.enqueuedAt; // same lane → FIFO
  }

  private start(q: Queued): void {
    this.running++;
    if (q.lane !== 'god') this.lastRunAt.set(q.villager, this.now());
    Promise.resolve()
      .then(q.run)
      .then(
        (value) => this.settle(q, value, undefined),
        (error: unknown) => this.settle(q, undefined, error),
      );
  }

  private settle(q: Queued, value: unknown, error: unknown): void {
    this.running--;
    // Stamp completion time too, so the cooldown measures from when the work actually ended.
    if (q.lane !== 'god') this.lastRunAt.set(q.villager, this.now());
    for (const w of q.waiters) {
      if (error !== undefined) w.reject(error);
      else w.resolve(value);
    }
    this.drain();
  }
}

/** Per-desk daily token budget (D-13). v0 skeleton: tracks spend + degrade; caps are consumed in M4-4. */
export class BudgetTracker {
  private readonly caps: Record<string, { dailyTokens: number | null }>;
  private readonly spent = new Map<string, number>();

  constructor(caps: Record<string, { dailyTokens: number | null }>) {
    this.caps = caps;
  }

  /** Record tokens a desk spent today. */
  spend(desk: string, tokens: number): void {
    this.spent.set(desk, (this.spent.get(desk) ?? 0) + tokens);
  }

  /** True once a desk is over its daily cap. A `null` cap NEVER degrades (R49: throughput is the limiter). */
  degraded(desk: string): boolean {
    const cap = this.caps[desk]?.dailyTokens;
    if (cap === null || cap === undefined) return false;
    return (this.spent.get(desk) ?? 0) > cap;
  }

  /** Tokens left today, or null if uncapped. */
  remaining(desk: string): number | null {
    const cap = this.caps[desk]?.dailyTokens;
    if (cap === null || cap === undefined) return null;
    return Math.max(0, cap - (this.spent.get(desk) ?? 0));
  }

  /** Reset the daily accumulator (called at dawn / day rollover). */
  resetDay(): void {
    this.spent.clear();
  }
}
