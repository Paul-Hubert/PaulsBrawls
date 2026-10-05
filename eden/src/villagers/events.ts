// EventRouter (layer 3, villagers/) — the reactivity front door (04 §The event system). It listens to
// one bot's raw mineflayer/world signals and emits a closed set of NORMALIZED EdenEvent Envelopes; a
// villager's subscriptions (subscriptions.ts) then match + route those, never the raw signals.
//
// Two design rules the docs make non-negotiable:
//   • The set of emitters is a REGISTRY (S1 / 04): adding an event type is one ROW in EMITTERS, never a
//     new if/else fork. Each row maps a raw signal name → a pure mapper producing an EdenEvent (or null
//     to drop). The mapper has no side effects; routing is the sink's job.
//   • Hysteresis lives IN the emitter (04). The two edge-style events — `health-low` and the
//     `night-falls`/`new-day` day/night phase — fire ONCE on the crossing and re-arm only after the
//     condition clears, so a subscriber never needs debounce logic. Edge state is per-router (per-bot).
//
// The `tick-30s` coarse clock is the only emitter not driven by a raw bot signal; it is pumped by an
// injected `tick()` (deterministic in CI — no real interval in tests; the host arms a 30 s timer that
// calls it). A pulse-rate clock is fine here because tick-30s is COARSE (every 30 s, one event), not a
// physics-rate stream — R44 forbids journaling per-tick streams, and the router journals nothing.
//
// villagers/ may import skills/llm/render/journal/config/types (all downward); never god/ or social/.

import type { Bot, EmitterLike } from '../types/bot';
import type { EdenEvent, Envelope, Priority, RunnerRef, Subscription } from '../types/index';
import type { IJournal } from '../journal/journal';
import type { Lane } from '../llm/scheduler';
import { SkillEngine } from '../skills/engine';
import {
  FilterEvaluator,
  substituteArgs,
  type FilterContext,
  type SubscriptionStore,
} from './subscriptions';

/** The sink the router pushes normalized Envelopes to — wired to subscription routing in M5-3. */
export type EventSink = (env: Envelope) => void;

/** Construction deps. The router owns one bot's reactivity; main.ts wires one per villager. */
export interface EventRouterOptions {
  villager: string;
  bot: Bot;
  /**
   * Where the router ATTACHES its emitter rows. Defaults to {@link bot} (the unit tests emit signals on
   * the bot directly). A real boot passes the per-bot signal adapter's bus (bots/signals.ts), because
   * mineflayer's native `entityHurt(entity)` has the wrong shape and would leak spurious damage-0 hurts;
   * the bus carries the SYNTHETIC normalized signals while the router still reads live STATE off `bot`
   * (health/time for the hysteresis edges).
   */
  signals?: EmitterLike;
  /** Where normalized Envelopes go (the SubscriptionRouter in M5-3; a collector in tests). */
  sink: EventSink;
  /** Journal is accepted for symmetry with the rest of villagers/; the router itself journals nothing
   *  (normalization is pulse-adjacent — R44). Routing (M5-3) owns subscription.fired/-suppressed. */
  journal?: unknown;
  /** Below this health an edge fires `health-low` (S7 hardcoded default 6 — nothing else reads it). */
  healthLowThreshold?: number;
  now?: () => number;
}

/** Mineflayer night band on the 0..24000 day clock (~sunset 12541 → ~sunrise 23459). */
const NIGHT_FROM = 13000;
const NIGHT_TO = 23000;
const DEFAULT_HEALTH_LOW = 6;

/** Per-edge hysteresis latch: armed = ready to fire; it fires once then disarms until the condition clears. */
interface Latch {
  armed: boolean;
}

/**
 * One emitter row: the raw bot event it listens to + a pure mapper to an EdenEvent (or null to drop).
 * Adding an event type is adding a row here — the registry IS the closed-set guarantee (S1).
 */
interface EmitterRow {
  /** The raw mineflayer/world signal name. */
  raw: string;
  /** Map the raw args to a normalized event, or null to suppress (e.g. an un-crossed hysteresis edge). */
  map: (...args: unknown[]) => EdenEvent | null;
}

/** Normalizes one bot's raw signals into EdenEvent Envelopes via an emitter registry. */
export class EventRouter {
  private readonly villager: string;
  private readonly bot: Bot;
  /** What attach/detach bind the emitter rows to — the adapter bus on a real boot, else the bot itself. */
  private readonly signals: EmitterLike;
  private readonly sink: EventSink;
  private readonly healthLow: number;
  private readonly now: () => number;
  private readonly registry: EmitterRow[];
  private readonly bound: Array<[string, (...a: unknown[]) => void]> = [];

  // Hysteresis state (per-bot). health-low arms when health recovers ≥ threshold; the night phase
  // tracks the last observed phase so an edge fires only on a genuine day↔night transition.
  private readonly healthLatch: Latch = { armed: true };
  private nightPhase: 'day' | 'night' | undefined; // undefined until the first `time` observation

  constructor(opts: EventRouterOptions) {
    this.villager = opts.villager;
    this.bot = opts.bot;
    this.signals = opts.signals ?? opts.bot;
    this.sink = opts.sink;
    this.healthLow = opts.healthLowThreshold ?? DEFAULT_HEALTH_LOW;
    this.now = opts.now ?? Date.now;
    this.registry = this.buildRegistry();
  }

  /** Wire every emitter row onto the signal source. Idempotent-unsafe: call once; pair with {@link detach}. */
  attach(): void {
    for (const row of this.registry) {
      const listener = (...args: unknown[]): void => {
        const event = row.map(...args);
        if (event) this.emit(event);
      };
      this.signals.on(row.raw, listener);
      this.bound.push([row.raw, listener]);
    }
  }

  /** Remove every listener this router added (no leaks across reconnect/rebind). */
  detach(): void {
    for (const [raw, listener] of this.bound) this.signals.removeListener(raw, listener);
    this.bound.length = 0;
  }

  /** Pump the coarse clock — the host calls this every 30 s; tests call it deterministically. */
  tick(): void {
    this.emit({ type: 'tick-30s' });
  }

  /** Wrap a normalized event in its Envelope and hand it to the sink. */
  private emit(event: EdenEvent): void {
    this.sink({ at: this.now(), villager: this.villager, event });
  }

  /**
   * The emitter REGISTRY (S1). Each row is a raw→normalized mapping; the two edge events carry their
   * hysteresis INSIDE the mapper (they read live bot state + the per-router latch). This is data, not a
   * switch — a new event type is a new row, never a new branch.
   */
  private buildRegistry(): EmitterRow[] {
    return [
      // ── direct (no hysteresis) — one raw signal → one normalized event ──
      {
        raw: 'entityHurt',
        map: (_self, info) => {
          const i = (info ?? {}) as { damage?: number; byEntity?: string };
          const e: EdenEvent = { type: 'hurt', damage: typeof i.damage === 'number' ? i.damage : 0 };
          if (i.byEntity !== undefined) e.byEntity = i.byEntity;
          return e;
        },
      },
      {
        raw: 'chat',
        map: (from, text, meta) => {
          const m = (meta ?? {}) as { isVillager?: boolean; distance?: number };
          const e: EdenEvent = m.isVillager
            ? { type: 'villager-chat', villager: String(from ?? ''), text: String(text ?? '') }
            : { type: 'player-chat', player: String(from ?? ''), text: String(text ?? '') };
          // The speaker's distance (bots/signals.ts) lets a `within` filter gate who is "talking to me".
          if (typeof m.distance === 'number') e.distance = m.distance;
          return e;
        },
      },
      {
        raw: 'entitySpotted',
        map: (entity) => {
          const en = (entity ?? {}) as { name?: string; id?: number; distance?: number };
          return { type: 'entity-spotted', entity: refOf(en), distance: typeof en.distance === 'number' ? en.distance : 0 };
        },
      },
      {
        raw: 'entityGone',
        map: (entity) => ({ type: 'entity-lost', entity: refOf((entity ?? {}) as { name?: string; id?: number }) }),
      },
      {
        raw: 'itemReceived',
        map: (item) => {
          const it = (item ?? {}) as { name?: string; count?: number };
          return { type: 'item-received', item: String(it.name ?? ''), count: typeof it.count === 'number' ? it.count : 1 };
        },
      },
      {
        raw: 'blockBrokenNearby',
        map: (block) => ({ type: 'block-broken-nearby', block: String((block as { name?: string })?.name ?? '') }),
      },
      {
        raw: 'death',
        map: () => ({ type: 'died' }),
      },
      {
        raw: 'runFinished',
        map: (report) => {
          const r = (report ?? {}) as { skill?: string; ok?: boolean };
          return { type: 'run-finished', skill: String(r.skill ?? ''), ok: r.ok === true };
        },
      },
      {
        raw: 'inbox',
        map: () => ({ type: 'inbox' }),
      },
      // ── hysteresis IN the emitter (04) ──
      {
        // health-low: fire ONCE on the crossing below the threshold; re-arm only when health recovers
        // to ≥ threshold. A second `health` event while still low produces NO event (edge already taken).
        raw: 'health',
        map: () => {
          const hp = this.bot.health ?? 20;
          if (hp >= this.healthLow) {
            this.healthLatch.armed = true; // recovered → re-arm the edge
            return null;
          }
          if (!this.healthLatch.armed) return null; // still low and already fired → suppress
          this.healthLatch.armed = false;
          return { type: 'health-low', health: hp };
        },
      },
      {
        // day/night phase: fire night-falls on day→night and new-day on night→day. Staying in a phase
        // produces no event; the first observation just records the phase (no spurious edge at boot).
        raw: 'time',
        map: () => {
          const phase = nightPhaseOf(this.bot.time?.timeOfDay ?? 0);
          const prev = this.nightPhase;
          this.nightPhase = phase;
          if (prev === undefined || prev === phase) return null; // first obs, or no transition
          if (phase === 'night') return { type: 'night-falls' };
          // mineflayer's bot.time.day is the world's day count; the narrowed seam may omit it (then 0-based from
          // timeOfDay, which is < 24000 and so always 0).
          const day = (this.bot.time as { day?: number } | undefined)?.day;
          return { type: 'new-day', day: typeof day === 'number' ? day : dayOf(this.bot.time?.timeOfDay ?? 0) };
        },
      },
    ];
  }
}

/** Which day/night phase a 0..24000 time-of-day is in. */
function nightPhaseOf(timeOfDay: number): 'day' | 'night' {
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  return t >= NIGHT_FROM && t < NIGHT_TO ? 'night' : 'day';
}

/** A coarse "which day" stamp for new-day (the absolute day count if the clock is monotonic; else 0). */
function dayOf(timeOfDay: number): number {
  return Math.floor(timeOfDay / 24000);
}

/** Render an entity reference the way the snapshot does — `name:id` when an id is known, else the name. */
function refOf(en: { name?: string; id?: number }): string {
  const name = String(en.name ?? 'entity');
  return en.id !== undefined ? `${name}:${en.id}` : name;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SubscriptionRouter (M5-3) — turns a normalized Envelope into the two routing OUTCOMES (04 §Two
// outcomes): a kind:'skill' handler is a ZERO-TOKEN SkillEngine.run; a kind:'deliberate' handler is a
// brain wake-up. The hard constraint is R36: ONE incident → ONE wake-up. One event can match many
// subscriptions; the router OWNS the single escalation — it coalesces every matched deliberate handler
// into ONE wake-up (all hints, highest lane), and journals each match as subscription.fired so the
// reflex story stays legible ("everyone journals; the owner escalates once").
//
// A matched skill handler that FAILS still files a normal RunReport (the SkillEngine journals skill.run
// + the FailureTripwire owns the streak) — never silently swallowed (04). A matched-but-throttled handler
// (cooldown / disabled / notWhileRunning) journals subscription.suppressed. A filter MISS (the event
// simply doesn't apply — too far, wrong kind) is a SILENT skip, not a suppression.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** A coalesced brain wake-up — the router builds ONE per incident (R36); main.ts turns it into a context pack. */
export interface WakeupRequest {
  villager: string;
  /** Verbatim trigger lines (the event), folded into context-pack §2. */
  triggers: string[];
  /** Every matched deliberate handler's hint (coalesced — R36). */
  hints: string[];
  /** The highest scheduler lane among the matched deliberate subs (player>combat>conversation>…). */
  lane: Lane;
  /** The event that caused the wake-up (for callers that want structured access). */
  event: EdenEvent;
}

/** What main.ts wires `wakeup` to: build a context pack from the request + run Brain.deliberate on `lane`. */
export type WakeupFn = (req: WakeupRequest) => Promise<void>;

/** Construction deps. The router reaches the brain only through the injected {@link WakeupFn} (decoupled). */
export interface SubscriptionRouterOptions {
  villager: string;
  runner: RunnerRef;
  store: SubscriptionStore;
  engine: SkillEngine;
  journal: IJournal;
  /** Escalate ONE coalesced wake-up (R36). Injected so events.ts needn't build a full ContextPackInput. */
  wakeup: WakeupFn;
  /** Live world facts the FilterEvaluator reads (vitals + running skills + time). */
  vitals: () => FilterContext;
  now?: () => number;
}

/** Priority (the directive vocabulary) → scheduler Lane (04 §Scheduling: priority maps to the v1 lanes). */
const PRIORITY_LANE: Record<Priority, Lane> = {
  interrupt: 'combat',
  normal: 'conversation',
  background: 'idle',
};
const LANE_RANK: Record<Lane, number> = { god: 0, player: 1, combat: 2, conversation: 3, directive: 4, job: 5, idle: 6 };

/** Routes one villager's normalized events to skill runs / brain wake-ups, honoring R36. */
export class SubscriptionRouter {
  private readonly evaluator = new FilterEvaluator();

  constructor(private readonly opts: SubscriptionRouterOptions) {}

  /**
   * Route one normalized Envelope. Runs every matched ZERO-TOKEN skill handler, and escalates AT MOST
   * ONE coalesced deliberate wake-up (R36). Resolves once all skill runs settle + the wake-up is queued.
   */
  async route(env: Envelope): Promise<void> {
    const ctx = this.opts.vitals();
    const subs = this.opts.store.list(this.opts.villager).filter((s) => s.on === env.event.type);

    const deliberate: Subscription[] = [];
    const skillRuns: Promise<void>[] = [];

    for (const sub of subs) {
      // 1. APPLIES? — match every filter clause EXCEPT notWhileRunning (that one is a suppression, not a
      //    "does this event apply" clause). A miss here is a SILENT skip — the event just doesn't apply.
      if (!this.evaluator.matches(stripRefractory(sub.filter), env, ctx)) continue;

      // 2. SUPPRESSED? — disabled, inside cooldown, or notWhileRunning fails → journal + skip (not silent).
      const reason = this.suppressionReason(sub, env, ctx);
      if (reason) {
        this.opts.journal.append(this.actor(), 'subscription.suppressed', {
          id: sub.id, villager: sub.villager, on: sub.on, reason,
        });
        continue;
      }

      // 3. ROUTE. Skills run now (zero-token); deliberate handlers are collected for ONE coalesced wake-up.
      if (sub.handler.kind === 'skill') {
        this.opts.store.markFired(sub.id);
        this.journalFired(sub, 'skill', sub.handler.name);
        skillRuns.push(this.runSkillHandler(sub, env));
      } else {
        this.opts.store.markFired(sub.id);
        this.journalFired(sub, 'deliberate', sub.handler.hint);
        deliberate.push(sub);
      }
    }

    await Promise.all(skillRuns);

    // R36 — one incident → one wake-up. Coalesce every matched deliberate handler into a single escalation.
    if (deliberate.length > 0) {
      await this.opts.wakeup(this.coalesce(deliberate, env));
    }
  }

  /** Build the ONE coalesced wake-up: all hints, the highest lane among the matched subs (R36). */
  private coalesce(subs: Subscription[], env: Envelope): WakeupRequest {
    const hints: string[] = [];
    let lane: Lane = 'idle';
    for (const sub of subs) {
      if (sub.handler.kind !== 'deliberate') continue;
      hints.push(sub.handler.hint);
      const subLane = laneFor(env.event.type, sub.handler.priority);
      if (LANE_RANK[subLane] < LANE_RANK[lane]) lane = subLane;
    }
    return { villager: this.opts.villager, triggers: [renderTrigger(env.event)], hints, lane, event: env.event };
  }

  /** Run a skill handler as a zero-token engine run. Failures land in the RunReport (never swallowed, 04). */
  private async runSkillHandler(sub: Subscription, env: Envelope): Promise<void> {
    if (sub.handler.kind !== 'skill') return;
    const args = substituteArgs(sub.handler.args, env);
    try {
      // The engine journals skill.run (success OR failure) + the FailureTripwire owns the streak.
      await this.opts.engine.run(sub.handler.name, args, this.opts.runner);
    } catch (e) {
      // Pre-execution problems (skill not found / tier / grant) can't produce a RunReport — journal them
      // as a system.error so a broken reflex is visible, not silent (S10: name the subject + args).
      this.opts.journal.append(this.actor(), 'system.error', {
        message: `subscription ${sub.id} skill "${sub.handler.name}" could not run: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  /** Why a matched subscription does NOT route (suppression), or undefined if it routes. */
  private suppressionReason(sub: Subscription, env: Envelope, ctx: FilterContext): string | undefined {
    if (!sub.enabled) return 'disabled';
    if (this.opts.store.inCooldown(sub.id)) return 'cooldown';
    // notWhileRunning is a refractory clause, not a match clause — its failure is a SUPPRESSION (04).
    if (sub.filter?.notWhileRunning && !this.evaluator.matches({ notWhileRunning: sub.filter.notWhileRunning }, env, ctx)) {
      return 'not-while-running';
    }
    return undefined;
  }

  private journalFired(sub: Subscription, outcome: 'skill' | 'deliberate', target: string): void {
    this.opts.journal.append(this.actor(), 'subscription.fired', {
      id: sub.id, villager: sub.villager, on: sub.on, outcome, target,
    });
  }

  private actor(): string {
    return `villager:${this.opts.villager}`;
  }
}

/** A copy of the filter with the refractory clause (notWhileRunning) removed — that one is a suppression. */
function stripRefractory(filter: Subscription['filter']): Subscription['filter'] {
  if (!filter || filter.notWhileRunning === undefined) return filter;
  const { notWhileRunning: _drop, ...rest } = filter;
  return rest;
}

/** Map a deliberate handler's Priority to a scheduler lane (04 §Scheduling: priority maps to the lanes). */
function laneFor(_eventType: EdenEvent['type'], priority: Priority | undefined): Lane {
  return PRIORITY_LANE[priority ?? 'normal'];
}

/** A one-line verbatim trigger string for the context pack (04 §2 — the event that woke the villager). */
function renderTrigger(event: EdenEvent): string {
  return `évènement ${event.type}: ${JSON.stringify(event)}`;
}
