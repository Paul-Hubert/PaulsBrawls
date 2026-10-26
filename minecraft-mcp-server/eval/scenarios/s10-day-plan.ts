import { toolCalls, type MockHandler } from '../mock-llm.js';
import type { EvalContext, Scenario } from '../types.js';
import { pollUntil } from '../util.js';
import { parkAllExcept, pollBot, settle, sweepScenario } from './helpers.js';

/**
 * S10 day-plan (M11) — the schedule actually drives the day. A scripted
 * `plan` deliberation stores a two-slot schedule via set_day_plan; the slot
 * executor (zero LLM) must then start farm-loop during the work slot, and on
 * `time set` into the home slot stop the job and walk the farmer home.
 *
 * The eval roster runs with dayPlanning=false, so no automatic dawn requests
 * fire — the testThink('plan') here is the only entry, which keeps the
 * scenario deterministic.
 */

const FARMER = 'EvalMargaux';
const HOME = { x: 10, y: 64, z: 10 };
const WORKSTATION = { x: 18, y: 64, z: 14 };
const TAG = 'eval_s10';

const PLAN_SLOTS = [
  { from: 0, to: 11_000, activity: 'job:farm-loop' },
  { from: 11_000, to: 23_500, activity: 'home' },
];

function planHandler(slots: Array<{ from: number; to: number; activity: string }>): MockHandler {
  return (req) => {
    if (req.botName !== FARMER || req.kind !== 'plan') return null;
    if (req.lastToolResult?.startsWith('day plan')) return null; // stored → default done
    if (req.lastToolResult?.startsWith('ERROR')) return null;
    return toolCalls({ name: 'set_day_plan', args: { slots } });
  };
}

async function distanceToHome(ctx: EvalContext): Promise<number> {
  const poll = await pollBot(ctx, FARMER);
  if (!poll.position) return Infinity;
  return Math.hypot(poll.position.x - HOME.x, poll.position.z - HOME.z);
}

export const s10DayPlan: Scenario = {
  id: 'S10',
  name: 'day-plan',
  suite: 'trade',
  timeoutMs: 90_000,
  mockOnly: true, // the plan reply is scripted

  async setup(ctx: EvalContext): Promise<void> {
    await parkAllExcept(ctx, [FARMER]);
    await ctx.rcon.tp(FARMER, WORKSTATION.x, WORKSTATION.y, WORKSTATION.z);
    await ctx.rcon.timeSet(1_000); // inside the work slot
    await settle();
    ctx.mock?.reset();
    ctx.mock?.setHandler(planHandler(PLAN_SLOTS));
  },

  async trigger(ctx: EvalContext): Promise<void> {
    await ctx.admin.testThink(FARMER, 'un nouveau jour commence — décide ton planning du jour avec set_day_plan', 'plan');
  },

  async assert(ctx: EvalContext): Promise<void> {
    // Phase A: plan stored and the work slot starts the routine by itself.
    await pollUntil({ label: 'S10 work slot started farm-loop', timeoutMs: 45_000, intervalMs: 1_500 }, async () => {
      const snapshot = await ctx.admin.bot(FARMER);
      const observation = snapshot.observation as { dayPlan?: { slots?: string[] } | null; activeJob?: { name?: string } | null };
      const planStored = Boolean(observation.dayPlan?.slots?.length);
      const working = observation.activeJob?.name === 'farm-loop';
      return { done: planStored && working, detail: `planStored=${planStored} activeJob=${observation.activeJob?.name ?? 'none'}` };
    });

    // Phase B: jump into the home slot — job stops, farmer heads home.
    await ctx.rcon.timeSet(12_000);
    await pollUntil({ label: 'S10 home slot: job stopped, walked home', timeoutMs: this.timeoutMs, intervalMs: 1_500 }, async () => {
      const snapshot = await ctx.admin.bot(FARMER);
      const observation = snapshot.observation as { activeJob?: { name?: string } | null };
      const jobStopped = !observation.activeJob;
      const distance = await distanceToHome(ctx);
      return { done: jobStopped && distance <= 6, detail: `activeJob=${observation.activeJob?.name ?? 'none'} distHome=${distance.toFixed(1)}` };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    // Clear the plan so later scenarios never inherit slot behavior.
    ctx.mock?.setHandler(planHandler([]));
    await ctx.admin.testThink(FARMER, 'efface ton planning du jour (set_day_plan avec slots vides)', 'plan');
    await pollUntil({ label: 'S10 plan cleared', timeoutMs: 20_000, intervalMs: 1_000 }, async () => {
      const snapshot = await ctx.admin.bot(FARMER);
      const observation = snapshot.observation as { dayPlan?: unknown };
      return { done: !observation.dayPlan, detail: 'waiting for plan clear' };
    });
    ctx.mock?.reset();
    await sweepScenario(ctx, TAG);
  },
};
