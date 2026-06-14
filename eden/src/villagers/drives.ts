// DriveTracker (layer 3, villagers/) — M6-4, the OPTIONAL rest/social drives (04 §Memory Simplification
// 2: "mood/needs become optional config (drives:true) rather than core — they generate wake-ups, not
// architecture"). Two drives (rest, social) decay each `tick()`; when they cross a low threshold the
// tracker fires a `tired` / `lonely` wake-up ONCE (hysteresis: it re-arms only after the drive recovers
// above the threshold). When `enabled` is false the tracker is inert — the architecture is unchanged.
//
// Design note (deliberate, see PROGRESS.md): the plan's M6-4 sketch said to add `tired`/`lonely` ROWS to
// M5's emitter registry in events.ts. Doing so would extend the FROZEN EdenEvent union (types/events.ts)
// and touch M5's events.ts/subscriptions.ts contract. Per the plan's own escape hatch ("if M6-4 risks
// destabilizing M5's events.ts, implement it minimally"), this is the MINIMAL form: the wake-up is
// reached through an INJECTED callback (the exact decoupling M5's SubscriptionRouter uses via WakeupFn),
// so drives stay self-contained, M5's emitter registry + the frozen union are untouched, and every M5
// test stays green. main.ts ticks one tracker per villager off the same 30 s host clock that drives M5's
// tick-30s, and wires the wake-up to a brain deliberation on the conversation lane.
//
// villagers/ may import journal/llm/render/config/types (downward) — never god/ or social/. This module
// needs none of them: it is pure decay arithmetic with an injected sink.

/** The two drive kinds and the wake-up they fire when depleted. */
export type DriveKind = 'tired' | 'lonely';

/** Fire a wake-up for a depleted drive — injected (main.ts → a brain deliberation; a collector in tests). */
export type DriveWakeupFn = (kind: DriveKind, villager: string) => void;

/** Construction options. Thresholds + decay rates are tunables (S7 hardcoded defaults — config gates ON/OFF). */
export interface DriveTrackerOptions {
  villager: string;
  /** behavior.drives — when false the tracker is inert (no decay effect, no wake-ups). */
  enabled: boolean;
  wakeup: DriveWakeupFn;
  /** Rest lost per tick (default 1). */
  restDecayPerTick?: number;
  /** Social lost per tick (default 1). */
  socialDecayPerTick?: number;
  /** Rest below this fires `tired` (default 25). */
  tiredBelow?: number;
  /** Social below this fires `lonely` (default 25). */
  lonelyBelow?: number;
}

/** A point-in-time view of both drives (the mood string is a side-output of `done`, not here). */
export interface DriveSnapshot {
  rest: number;
  social: number;
}

const FULL = 100;
const DEFAULT_DECAY = 1;
const DEFAULT_THRESHOLD = 25;

/** Decays rest/social per tick; fires a one-shot tired/lonely wake-up on the low-crossing (hysteresis). */
export class DriveTracker {
  private readonly villager: string;
  private readonly enabled: boolean;
  private readonly wakeup: DriveWakeupFn;
  private readonly restDecay: number;
  private readonly socialDecay: number;
  private readonly tiredBelow: number;
  private readonly lonelyBelow: number;

  private restLevel = FULL;
  private socialLevel = FULL;
  // Hysteresis latches — armed = ready to fire; fires once then disarms until the drive recovers.
  private tiredArmed = true;
  private lonelyArmed = true;

  constructor(opts: DriveTrackerOptions) {
    this.villager = opts.villager;
    this.enabled = opts.enabled;
    this.wakeup = opts.wakeup;
    this.restDecay = opts.restDecayPerTick ?? DEFAULT_DECAY;
    this.socialDecay = opts.socialDecayPerTick ?? DEFAULT_DECAY;
    this.tiredBelow = opts.tiredBelow ?? DEFAULT_THRESHOLD;
    this.lonelyBelow = opts.lonelyBelow ?? DEFAULT_THRESHOLD;
  }

  /** Advance both drives one tick. No-op when drives are disabled (architecture unchanged). */
  tick(): void {
    if (!this.enabled) return;
    this.restLevel = clamp(this.restLevel - this.restDecay, 0, FULL);
    this.socialLevel = clamp(this.socialLevel - this.socialDecay, 0, FULL);
    this.checkEdge('tired', this.restLevel, this.tiredBelow);
    this.checkEdge('lonely', this.socialLevel, this.lonelyBelow);
  }

  /** Restore rest (e.g. after a sleep skill). Recovering above the threshold re-arms the `tired` edge. */
  rest(to = FULL): void {
    this.restLevel = clamp(to, 0, FULL);
    if (this.restLevel >= this.tiredBelow) this.tiredArmed = true;
  }

  /** Restore social (e.g. after a conversation). Recovering above the threshold re-arms the `lonely` edge. */
  socialize(to = FULL): void {
    this.socialLevel = clamp(to, 0, FULL);
    if (this.socialLevel >= this.lonelyBelow) this.lonelyArmed = true;
  }

  /** The current drive levels (admin/mood rendering). */
  snapshot(): DriveSnapshot {
    return { rest: this.restLevel, social: this.socialLevel };
  }

  /** Fire ONCE on the crossing below the threshold; re-arm only after recovery above it (hysteresis). */
  private checkEdge(kind: DriveKind, level: number, threshold: number): void {
    const armed = kind === 'tired' ? this.tiredArmed : this.lonelyArmed;
    if (level < threshold) {
      if (!armed) return; // already fired while held below
      if (kind === 'tired') this.tiredArmed = false;
      else this.lonelyArmed = false;
      this.wakeup(kind, this.villager);
    } else if (kind === 'tired') {
      this.tiredArmed = true; // recovered → re-arm
    } else {
      this.lonelyArmed = true;
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
