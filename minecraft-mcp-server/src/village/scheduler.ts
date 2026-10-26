import { log, logDebug } from '../logger.js';
import { THINK_PRIORITY, ThinkKind, ThinkRequest } from './types.js';

/**
 * The village-wide LLM budget (VILLAGE_PLAN §D6).
 *
 * Invariants:
 *  - at most `concurrency` deliberations in flight globally;
 *  - at most ONE deliberation in flight per bot;
 *  - one pending request per (bot, kind) — re-requests merge their reasons
 *    (coalescing), so an event storm becomes one wake-up with many reasons;
 *  - per-bot cooldown between deliberations (urgent kinds use a shorter one);
 *  - aging: waiting requests gain priority so heartbeats never starve forever.
 *
 * Pure logic + injected runner/clock → unit-testable without mineflayer or an
 * actual LLM.
 */

export interface SchedulerOptions {
  concurrency: number;
  /** Cooldown after a bot's deliberation finishes before its next one may start. */
  botCooldownMs: number;
  /** Runner that actually performs a deliberation. Must never reject un-caught. */
  runner: (req: ThinkRequest) => Promise<void>;
  /** Injected clock for tests. */
  now?: () => number;
  /** Priority points gained per this many ms of waiting (default 30 s / point). */
  agingMs?: number;
  /**
   * Hold gate: while true for a (bot, kind), the request stays queued but is
   * never dispatched. Used to keep background wake-ups (error/job/heartbeat)
   * from hijacking a live conversation — a held request is NOT counted by the
   * wake timer, so the releasing side must call pump() (the conversation
   * manager does, on every conversation end).
   */
  isHeld?: (botName: string, kind: ThinkKind) => boolean;
}

const URGENT_KINDS: ReadonlySet<ThinkKind> = new Set(['player', 'combat', 'conversation', 'error']);
/** Urgent work only waits a fraction of the configured cooldown. */
const URGENT_COOLDOWN_FACTOR = 0.2;
const MAX_REASONS = 8;

// Failure memoization (June 2026): the same blocked precondition used to wake
// the LLM over and over, and it reached the same conclusion every time —
// tokens burned, zero strategy change. Identical failures are suppressed with
// exponential backoff, and once one keeps recurring the wake-up escalates from
// 'error' (diagnose) to 'plan' (revise the strategy).
const FAILURE_BACKOFF_BASE_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 10 * 60_000;
const FAILURE_ESCALATE_AFTER = 3;

/** Strip volatile details (numbers, coords, quoted names) so the same blocker
 *  hashes identically across occurrences. */
export function normalizeFailureReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[0-9]+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

interface FailureRecord {
  count: number;
  suppressUntil: number;
}

export class VillageScheduler {
  private readonly opts: Required<SchedulerOptions>;
  /** Pending requests keyed `${bot}/${kind}`. */
  private readonly pending = new Map<string, ThinkRequest>();
  private readonly inFlight = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private paused = false;
  private completed = 0;
  private dropped = 0;
  private suppressedFailures = 0;
  /** Identical-failure memo, keyed `${bot}/${normalized reason}`. */
  private readonly failureMemo = new Map<string, FailureRecord>();
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Deadline the armed wake timer fires at — so a sooner one can preempt it. */
  private wakeDeadline = Infinity;

  constructor(options: SchedulerOptions) {
    this.opts = {
      now: () => Date.now(),
      agingMs: 30_000,
      isHeld: () => false,
      ...options,
    };
  }

  /** Enqueue (or coalesce into) a deliberation request. */
  request(botName: string, kind: ThinkKind, reason: string): void {
    if (kind === 'error') {
      const memoKey = `${botName}/${normalizeFailureReason(reason)}`;
      const rec = this.failureMemo.get(memoKey) ?? { count: 0, suppressUntil: 0 };
      rec.count++;
      const now = this.opts.now();
      if (now < rec.suppressUntil) {
        this.suppressedFailures++;
        this.failureMemo.set(memoKey, rec);
        logDebug('scheduler', `${botName}/error SUPPRESSED (identical failure x${rec.count}): ${reason.slice(0, 120)}`);
        return;
      }
      rec.suppressUntil = now + Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, rec.count - 1), FAILURE_BACKOFF_MAX_MS);
      this.failureMemo.set(memoKey, rec);
      if (rec.count >= FAILURE_ESCALATE_AFTER) {
        // Same diagnosis K times = the diagnosis isn't the problem. Reframe as
        // a plan revision so the deliberation kind (and prompt) changes too.
        kind = 'plan';
        reason =
          `the same failure has now hit ${rec.count}x: "${reason.slice(0, 200)}". ` +
          `Do NOT retry the same action — revise the plan: change strategy, pick a different goal, or drop the blocked step.`;
        logDebug('scheduler', `${botName}/error ESCALATED to plan after ${rec.count} identical failures`);
      }
    }
    const key = `${botName}/${kind}`;
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.reasons.length < MAX_REASONS) {
        existing.reasons.push(reason);
        logDebug('scheduler', `${key} coalesced (${existing.reasons.length} reasons): ${reason.slice(0, 120)}`);
      } else {
        this.dropped++;
        logDebug('scheduler', `${key} reason DROPPED (cap ${MAX_REASONS}): ${reason.slice(0, 120)}`);
      }
    } else {
      this.pending.set(key, {
        botName,
        kind,
        reasons: [reason],
        enqueuedAt: this.opts.now(),
      });
      logDebug('scheduler', `${key} queued: ${reason.slice(0, 120)}`);
    }
    this.pump();
  }

  /** Drop a pending request (e.g. a conversation that ended before its turn ran). */
  cancel(botName: string, kind: ThinkKind): void {
    if (this.pending.delete(`${botName}/${kind}`)) {
      logDebug('scheduler', `${botName}/${kind} cancelled`);
    }
  }

  /** Release valve for the failure memo: call when the bot demonstrably made
   *  progress (a routine finished, a blocked action succeeded) so stale
   *  suppressions don't gag genuinely new failures. */
  clearFailures(botName: string): void {
    const prefix = `${botName}/`;
    for (const key of this.failureMemo.keys()) {
      if (key.startsWith(prefix)) this.failureMemo.delete(key);
    }
  }

  pause(): void {
    this.paused = true;
    logDebug('scheduler', 'paused');
  }

  resume(): void {
    this.paused = false;
    logDebug('scheduler', 'resumed');
    this.pump();
  }

  isPaused(): boolean { return this.paused; }

  stats(): { pending: number; inFlight: number; completed: number; dropped: number; suppressedFailures: number; paused: boolean } {
    return {
      pending: this.pending.size,
      inFlight: this.inFlight.size,
      completed: this.completed,
      dropped: this.dropped,
      suppressedFailures: this.suppressedFailures,
      paused: this.paused,
    };
  }

  /** Drives as many eligible requests as budget allows. Safe to call anytime. */
  pump(): void {
    if (this.paused) return;
    while (this.inFlight.size < this.opts.concurrency) {
      const next = this.pickNext();
      if (!next) {
        // Requests may be blocked purely by cooldown — wake up when the
        // earliest one becomes eligible instead of waiting for outside traffic.
        this.scheduleWake();
        return;
      }
      this.pending.delete(`${next.botName}/${next.kind}`);
      this.inFlight.add(next.botName);
      const dispatchedAt = this.opts.now();
      logDebug(
        'scheduler',
        `dispatch ${next.botName}/${next.kind} after ${dispatchedAt - next.enqueuedAt}ms wait ` +
          `(${next.reasons.length} reason(s), inFlight ${this.inFlight.size}/${this.opts.concurrency}, pending ${this.pending.size})`
      );
      void this.opts
        .runner(next)
        .catch((err) => log('warn', `village deliberation for ${next.botName} threw: ${String(err)}`))
        .finally(() => {
          this.inFlight.delete(next.botName);
          this.cooldownUntil.set(next.botName, this.opts.now() + this.opts.botCooldownMs);
          this.completed++;
          logDebug(
            'scheduler',
            `done ${next.botName}/${next.kind} in ${this.opts.now() - dispatchedAt}ms (completed ${this.completed}, dropped ${this.dropped})`
          );
          this.pump();
        });
    }
  }

  private scheduleWake(): void {
    if (this.pending.size === 0) return;
    const now = this.opts.now();
    let earliest = Infinity;
    for (const req of this.pending.values()) {
      if (this.inFlight.has(req.botName)) continue;
      if (this.opts.isHeld(req.botName, req.kind)) continue; // released by pump(), not by time
      const until = this.effectiveCooldownEnd(req, now);
      if (until > now && until < earliest) earliest = until;
    }
    if (!Number.isFinite(earliest)) return;
    // Re-arm when a sooner deadline appears. The old guard kept the FIRST
    // armed timer (often a slow non-urgent deadline), so an urgent request
    // landing later waited out the FULL cooldown — conversation turns crawled
    // at ~15s instead of ~3s whenever any background request was pending.
    if (this.wakeTimer) {
      if (earliest >= this.wakeDeadline) return;
      clearTimeout(this.wakeTimer);
    }
    this.wakeDeadline = earliest;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeDeadline = Infinity;
      this.pump();
    }, Math.max(10, earliest - now));
    this.wakeTimer.unref?.();
  }

  private effectiveCooldownEnd(req: ThinkRequest, _now: number): number {
    const until = this.cooldownUntil.get(req.botName) ?? 0;
    return URGENT_KINDS.has(req.kind)
      ? until - this.opts.botCooldownMs * (1 - URGENT_COOLDOWN_FACTOR)
      : until;
  }

  private pickNext(): ThinkRequest | null {
    const now = this.opts.now();
    let best: ThinkRequest | null = null;
    let bestScore = Infinity;
    for (const req of this.pending.values()) {
      if (this.inFlight.has(req.botName)) continue;
      if (this.opts.isHeld(req.botName, req.kind)) continue;
      if (now < this.effectiveCooldownEnd(req, now)) continue;
      const age = now - req.enqueuedAt;
      const score = THINK_PRIORITY[req.kind] - age / this.opts.agingMs;
      if (score < bestScore || (score === bestScore && best && req.enqueuedAt < best.enqueuedAt)) {
        best = req;
        bestScore = score;
      }
    }
    return best;
  }
}
