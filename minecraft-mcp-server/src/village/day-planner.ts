import { log, logDebug } from '../logger.js';
import * as actions from './actions.js';
import { VillageContext } from './context.js';
import { BotNeeds, DayPlan, DayPlanSlot } from './types.js';
import type { Villager } from './villager.js';

/**
 * Daily rhythm (VILLAGE_PLAN M11): one LLM-authored schedule per bot per
 * Minecraft day, drive levels (rest/social) that decay on the scan tick, and
 * a free slot executor that starts/stops routines and walks bots home — all
 * without burning LLM calls. The only model involvement is the dawn `plan`
 * deliberation (`set_day_plan` tool); everything else is plain code.
 *
 * Simplification vs the paper's plan-time-shifting: slots are anchored to
 * Minecraft day-time, and the executor RE-ASSERTS the current slot whenever
 * the bot is free again — an interruption eats into a slot but never breaks
 * the rest of the day.
 */

export const PLAN_MAX_SLOTS = 8;
/** Day-ticks of grace for the LLM to deliver a plan before the fallback lands. */
export const FALLBACK_GRACE_TICKS = 2_000;
/** Dawn-ish window (≥23000) where a plan request targets the NEXT day. */
const NEXT_DAY_FROM_TICK = 23_000;
const REASSERT_MS = 30_000;
const HOME_RANGE = 4;
const VISIT_RANGE = 3;
/** Failed slot walks back off exponentially (30s, 60s, …) up to this cap… */
const WALK_BACKOFF_MAX_MS = 10 * 60_000;
/** …and after this many consecutive failures the slot's walks are abandoned
 *  (one memory entry, no more pathfinder churn until the next slot). */
const WALK_GIVE_UP_AFTER = 5;

// Spontaneous greet gate (M12) — free checks; passing spends ONE deliberation.
export const GREET_RADIUS = 6;
export const GREET_PAIR_COOLDOWN_MS = 15 * 60_000;
export const GREET_BOT_COOLDOWN_MS = 5 * 60_000;
/** Greet when social is below this… */
const GREET_SOCIAL_GATE = 0.5;
/** …or the relation is at least this warm. */
const GREET_RELATION_GATE = 20;

const ACTIVITY_HELP = "'job:<routine>' | 'visit:<villager>' | 'home' | 'idle'";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export interface PlanValidationContext {
  /** Names of this bot's ACTIVE routine skills. */
  routineNames: ReadonlySet<string>;
  /** All roster names (visit targets). */
  villagerNames: ReadonlySet<string>;
  /** The planning bot itself (cannot visit itself). */
  self: string;
}

export function validateDayPlanSlots(
  raw: unknown,
  ctx: PlanValidationContext
): { ok: true; slots: DayPlanSlot[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'slots must be an array' };
  if (raw.length > PLAN_MAX_SLOTS) return { ok: false, error: `at most ${PLAN_MAX_SLOTS} slots` };

  const slots: DayPlanSlot[] = [];
  for (const item of raw) {
    const slot = item as { from?: unknown; to?: unknown; activity?: unknown };
    const from = Math.floor(Number(slot.from));
    const to = Math.floor(Number(slot.to));
    const activity = String(slot.activity ?? '').trim();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 24_000 || from >= to) {
      return { ok: false, error: `bad slot times (${String(slot.from)}..${String(slot.to)}) — need 0 <= from < to <= 24000` };
    }
    if (activity === 'home' || activity === 'idle') {
      // fine
    } else if (activity.startsWith('job:')) {
      const routine = activity.slice(4);
      if (!ctx.routineNames.has(routine)) {
        return { ok: false, error: `unknown routine '${routine}' — yours: ${Array.from(ctx.routineNames).join(', ') || '(none)'}` };
      }
    } else if (activity.startsWith('visit:')) {
      const target = activity.slice(6);
      if (target === ctx.self) return { ok: false, error: 'cannot visit yourself' };
      if (!ctx.villagerNames.has(target)) return { ok: false, error: `unknown villager '${target}'` };
    } else {
      return { ok: false, error: `bad activity '${activity}' — valid: ${ACTIVITY_HELP}` };
    }
    slots.push({ from, to, activity });
  }

  slots.sort((a, b) => a.from - b.from);
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].from < slots[i - 1].to) {
      return { ok: false, error: `slots overlap around tick ${slots[i].from}` };
    }
  }
  return { ok: true, slots };
}

/** Work-rest default when the model never answers: first active routine
 *  morning + afternoon, an idle midday break, home for the night. */
export function fallbackPlanFor(villager: Pick<Villager, 'skills'>, day: number): DayPlan {
  const work = villager.skills.list().find((s) => s.kind === 'routine' && s.status === 'active');
  const workActivity = work ? `job:${work.name}` : 'idle';
  return {
    day,
    source: 'fallback',
    slots: [
      { from: 0, to: 5_500, activity: workActivity },
      { from: 5_500, to: 7_000, activity: 'idle' },
      { from: 7_000, to: 11_500, activity: workActivity },
      { from: 11_500, to: 23_500, activity: 'home' },
    ],
  };
}

export function currentSlotOf(plan: DayPlan | null, timeOfDay: number): DayPlanSlot | null {
  if (!plan) return null;
  return plan.slots.find((s) => timeOfDay >= s.from && timeOfDay < s.to) ?? null;
}

/** Which day a plan made *now* is for — pre-dawn (≥23000) plans for tomorrow. */
export function planDayFor(day: number, timeOfDay: number): number {
  return timeOfDay >= NEXT_DAY_FROM_TICK ? day + 1 : day;
}

// ---------------------------------------------------------------------------
// The rhythm engine
// ---------------------------------------------------------------------------

interface RhythmBotState {
  lastSlotKey: string | null;
  lastAssertAt: number;
  lastPlanRequestDay: number;
  /** Raw (unrounded) accumulators — BotState gets the rounded copy. */
  needs: BotNeeds | null;
  needLowFired: { rest: boolean; social: boolean };
  lastNeedsTickAt: number;
  lastGreetAt: number;
  /** Consecutive failed walks for the current slot (drives the backoff). */
  walkFailures: number;
  /** No walk attempts before this timestamp (exponential backoff). */
  walkBlockedUntil: number;
  /** Slot key whose walks were abandoned after repeated failures. */
  walkGaveUpKey: string | null;
}

export class DailyRhythm {
  private readonly ctx: VillageContext;
  private readonly now: () => number;
  private readonly state = new Map<string, RhythmBotState>();

  constructor(ctx: VillageContext, now: () => number = () => Date.now()) {
    this.ctx = ctx;
    this.now = now;
  }

  /** Called from bot-host's scan loop (~2.5 s) for every connected villager. */
  tick(villager: Villager): void {
    const bot = villager.bot();
    if (!bot?.entity) return;
    const st = this.botState(villager.name);
    const timeOfDay = Math.floor(bot.time.timeOfDay);
    const planDay = planDayFor(bot.time.day ?? 0, timeOfDay);

    this.updateNeeds(villager, st);
    this.ensurePlan(villager, st, planDay, timeOfDay);
    this.executeSlot(villager, st, timeOfDay);
    this.maybeGreet(villager, st, timeOfDay);
  }

  /** `set_day_plan` tool entry — validates, stores, applies. Returns the tool result line. */
  setPlanFromModel(villager: Villager, rawSlots: unknown): string {
    const bot = villager.bot();
    if (!bot) return 'ERROR: not in the world right now';
    const routineNames = new Set(
      villager.skills.list().filter((s) => s.kind === 'routine' && s.status === 'active').map((s) => s.name)
    );
    const result = validateDayPlanSlots(rawSlots, {
      routineNames,
      villagerNames: this.ctx.villagerNames,
      self: villager.name,
    });
    if (!result.ok) {
      logDebug(villager.name, `set_day_plan rejected: ${result.error}`);
      return `ERROR: ${result.error}`;
    }

    const timeOfDay = Math.floor(bot.time.timeOfDay);
    const day = planDayFor(bot.time.day ?? 0, timeOfDay);
    villager.memory.setDayPlan(result.slots.length > 0 ? { day, slots: result.slots, source: 'llm' } : null);
    const st = this.botState(villager.name);
    st.lastSlotKey = null; // force a transition on the next tick
    st.lastAssertAt = 0;
    if (result.slots.length === 0) {
      logDebug(villager.name, 'day plan cleared by the model');
      return 'day plan cleared';
    }
    const shape = result.slots.map((s) => `${s.from}-${s.to} ${s.activity}`).join('; ');
    logDebug(villager.name, `day plan set (llm) for day ${day}: ${shape}`);
    villager.memory.append('thought', `planning du jour: ${shape}`, undefined, 5);
    return `day plan set for day ${day}: ${shape}`;
  }

  // -- internals --------------------------------------------------------------

  private botState(name: string): RhythmBotState {
    let st = this.state.get(name);
    if (!st) {
      st = {
        lastSlotKey: null,
        lastAssertAt: 0,
        lastPlanRequestDay: -1,
        needs: null,
        needLowFired: { rest: false, social: false },
        lastNeedsTickAt: 0,
        lastGreetAt: 0,
        walkFailures: 0,
        walkBlockedUntil: 0,
        walkGaveUpKey: null,
      };
      this.state.set(name, st);
    }
    return st;
  }

  private updateNeeds(villager: Villager, st: RhythmBotState): void {
    const now = this.now();
    const dtMin = st.lastNeedsTickAt > 0 ? Math.min((now - st.lastNeedsTickAt) / 60_000, 5) : 0;
    st.lastNeedsTickAt = now;
    if (dtMin <= 0) return;

    const cfg = this.ctx.settings.needs;
    st.needs ??= { ...villager.memory.needs() };
    const working = villager.routines.status() !== null;
    const company =
      this.ctx.conversations.get(villager.name) !== undefined ||
      villager.villagersInEarshot(this.ctx.villagers.values()).length > 0;

    st.needs.rest = clamp01(st.needs.rest + dtMin * (working ? -cfg.restDecayPerMin : cfg.restRecoverPerMin));
    st.needs.social = clamp01(st.needs.social + dtMin * (company ? cfg.socialRecoverPerMin : -cfg.socialDecayPerMin));

    const rounded: BotNeeds = { rest: round3(st.needs.rest), social: round3(st.needs.social) };
    const stored = villager.memory.needs();
    if (rounded.rest !== stored.rest || rounded.social !== stored.social) {
      villager.memory.setNeeds(rounded);
    }

    for (const need of ['rest', 'social'] as const) {
      const value = st.needs[need];
      if (value <= cfg.lowThreshold && !st.needLowFired[need]) {
        st.needLowFired[need] = true;
        // No bus rate-key: the hysteresis (re-arm at 2× threshold) is the guard.
        villager.bus.emit({ type: need === 'rest' ? 'tired' : 'lonely', value: round3(value) });
      } else if (value >= cfg.lowThreshold * 2 && st.needLowFired[need]) {
        st.needLowFired[need] = false; // hysteresis re-arm
      }
    }
  }

  private ensurePlan(villager: Villager, st: RhythmBotState, planDay: number, timeOfDay: number): void {
    if (!this.ctx.settings.dayPlanning) return;
    const plan = villager.memory.dayPlan();
    if (plan && plan.day === planDay) return;

    if (st.lastPlanRequestDay !== planDay) {
      st.lastPlanRequestDay = planDay;
      logDebug(villager.name, `day-plan deliberation requested for day ${planDay} (tick ${timeOfDay})`);
      this.ctx.scheduler.request(
        villager.name,
        'plan',
        `un nouveau jour commence (jour ${planDay}) — décide ton planning du jour avec set_day_plan`
      );
      return; // give the deliberation its grace window before falling back
    }
    if (timeOfDay >= FALLBACK_GRACE_TICKS && timeOfDay < NEXT_DAY_FROM_TICK) {
      const fallback = fallbackPlanFor(villager, planDay);
      logDebug(villager.name, `day plan fallback for day ${planDay}: ${fallback.slots.map((s) => `${s.from}-${s.to} ${s.activity}`).join('; ')}`);
      villager.memory.setDayPlan(fallback);
      villager.memory.append('system', 'pas de planning décidé — je suis ma routine habituelle', undefined, 2);
    }
  }

  private executeSlot(villager: Villager, st: RhythmBotState, timeOfDay: number): void {
    const plan = villager.memory.dayPlan();
    if (!plan) return;
    if (this.ctx.conversations.get(villager.name)) return; // never interrupt a conversation

    const slot = currentSlotOf(plan, timeOfDay);
    const key = slot ? `${plan.day}/${slot.from}/${slot.activity}` : null;

    if (key !== st.lastSlotKey) {
      st.lastSlotKey = key;
      st.lastAssertAt = 0;
      st.walkFailures = 0;
      st.walkBlockedUntil = 0;
      const running = villager.routines.status();
      logDebug(
        villager.name,
        `slot transition → ${slot ? slot.activity : '(none)'} (tick ${timeOfDay}${running ? `, running '${running.name}'` : ''})`
      );
      // A transition stops the previous slot's work — but a job matching the
      // NEW slot keeps running, and a no-slot gap stops nothing.
      if (running && slot && slot.activity !== `job:${running.name}`) {
        logDebug(villager.name, `slot transition stops '${running.name}'`);
        villager.routines.stop();
      }
    }
    if (!slot) return;
    if (this.now() - st.lastAssertAt < REASSERT_MS) return;

    const running = villager.routines.status();
    if (slot.activity.startsWith('job:')) {
      if (running) return; // busy — planner's own job, or the model's deliberate pick
      st.lastAssertAt = this.now();
      logDebug(villager.name, `slot assert: starting '${slot.activity}' (tick ${timeOfDay})`);
      const error = villager.routines.start(slot.activity.slice(4));
      if (error) {
        log('info', `[village] ${villager.name} slot '${slot.activity}' could not start: ${error}`);
      }
    } else if (slot.activity === 'home' || slot.activity.startsWith('visit:')) {
      if (running) return;
      // Failure budget: an unreachable target must not become an infinite
      // loop of 30s pathfinder timeouts — back off, then give the slot up.
      if (st.walkGaveUpKey !== null && st.walkGaveUpKey === key) return;
      if (this.now() < st.walkBlockedUntil) return;
      const target =
        slot.activity === 'home'
          ? villager.homeAnchor()
          : this.ctx.villagers.get(slot.activity.slice(6))?.bot()?.entity.position ?? null;
      if (!target) return;
      const bot = villager.bot();
      if (!bot) return;
      const closeEnough = slot.activity === 'home' ? HOME_RANGE : VISIT_RANGE + 2;
      const pos = bot.entity.position;
      const distance = Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z);
      if (distance <= closeEnough) return;
      st.lastAssertAt = this.now();
      logDebug(villager.name, `slot assert: walking ${slot.activity} (${Math.round(distance)} blocks to go)`);
      const range = slot.activity === 'home' ? 2 : VISIT_RANGE;
      void villager
        .runExclusive(() =>
          actions.goTo(villager.requireBot(), Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), range)
        )
        .then(() => {
          st.walkFailures = 0;
          st.walkBlockedUntil = 0;
        })
        .catch((err) => {
          st.walkFailures += 1;
          const backoffMs = Math.min(REASSERT_MS * 2 ** (st.walkFailures - 1), WALK_BACKOFF_MAX_MS);
          st.walkBlockedUntil = this.now() + backoffMs;
          log(
            'info',
            `[village] ${villager.name} slot walk (${slot.activity}) failed (${st.walkFailures}x, next try in ${Math.round(backoffMs / 1000)}s): ${String(err).slice(0, 120)}`
          );
          if (st.walkFailures >= WALK_GIVE_UP_AFTER && key) {
            st.walkGaveUpKey = key;
            log('warn', `[village] ${villager.name} abandoning '${slot.activity}' walks for this slot after ${st.walkFailures} failures`);
            villager.memory.append(
              'system',
              `impossible de rejoindre ${slot.activity === 'home' ? `ma maison (${target.x},${target.y},${target.z})` : slot.activity} après ${st.walkFailures} essais — j'abandonne pour ce créneau`,
              undefined,
              6
            );
          }
        });
    }
    // 'idle': nothing — wander-by-reflex or just stand around.
  }

  /** Per-pair last-greet timestamps, symmetric key. */
  private readonly pairGreetAt = new Map<string, number>();

  private maybeGreet(villager: Villager, st: RhythmBotState, timeOfDay: number): void {
    if (!this.ctx.settings.spontaneousChat) return;
    const now = this.now();
    if (now - st.lastGreetAt < GREET_BOT_COOLDOWN_MS) return;
    if (this.ctx.conversations.get(villager.name)) return;
    if (villager.routines.status()) return; // never break off work to chat
    const bot = villager.bot();
    if (!bot?.entity) return;

    const slot = currentSlotOf(villager.memory.dayPlan(), timeOfDay);
    const social = st.needs?.social ?? villager.memory.needs().social;

    for (const other of this.ctx.villagers.values()) {
      if (other.name === villager.name) continue;
      if (this.ctx.conversations.get(other.name)) continue;
      const otherBot = other.bot();
      if (!otherBot?.entity) continue;
      const a = bot.entity.position;
      const b = otherBot.entity.position;
      const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (distance > GREET_RADIUS) continue;

      const pairKey = [villager.name, other.name].sort().join('/');
      if (now - (this.pairGreetAt.get(pairKey) ?? 0) < GREET_PAIR_COOLDOWN_MS) continue;

      const visiting = slot?.activity === `visit:${other.name}`;
      const lonely = social < GREET_SOCIAL_GATE;
      const friendly = villager.memory.relationWith(other.name).score >= GREET_RELATION_GATE;
      if (!visiting && !lonely && !friendly) continue;

      this.pairGreetAt.set(pairKey, now);
      st.lastGreetAt = now;
      logDebug(
        villager.name,
        `greet gate passed: ${other.name} at ${Math.round(distance)} blocks (visiting=${visiting} lonely=${lonely} friendly=${friendly})`
      );
      this.ctx.scheduler.request(
        villager.name,
        'job',
        `tu croises ${other.name} (${other.roster.role}) à ${Math.round(distance)} blocs — si tu as quelque chose à lui dire, start_conversation; sinon continue ta journée`
      );
      return;
    }
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
