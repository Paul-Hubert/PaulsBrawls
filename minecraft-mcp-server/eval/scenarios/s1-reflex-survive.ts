import { ARENA } from '../fixture.js';
import type { EvalContext, Scenario } from '../types.js';
import { dist3, pollUntil } from '../util.js';
import { deaths, outfit, parkAllExcept, pollBot, settle, summonEvalZombie, sweepScenario } from './helpers.js';

/**
 * S1 reflex-survive — a zombie spawns 3 blocks from a lone farmer. The stock
 * `self-defense` reflex must resolve it WITHOUT waking the brain: no guards in
 * range and full health means the farmer fights back (or flees). Pass: within
 * 30 s the farmer is alive AND (≥8 blocks from its start OR the zombie is
 * dead), with at most 1 LLM call consumed (a low-health escalation is allowed;
 * a deliberation-driven rescue is not).
 */

const SUBJECT = 'EvalFirmin';
const TAG = 'eval_s1';

interface S1State {
  start: { x: number; y: number; z: number };
  deathsBefore: number;
  completedBefore: number;
}

let state: S1State | null = null;

export const s1ReflexSurvive: Scenario = {
  id: 'S1',
  name: 'reflex-survive',
  suite: 'reflex',
  timeoutMs: 35_000,

  async setup(ctx: EvalContext): Promise<void> {
    state = null;
    await ctx.rcon.killTagged(TAG);
    await parkAllExcept(ctx, [SUBJECT]);
    await ctx.rcon.tp(SUBJECT, ARENA.center.x, ARENA.center.y, ARENA.center.z);
    await settle();
    await outfit(ctx, SUBJECT, { sword: true, armor: true });
  },

  async trigger(ctx: EvalContext): Promise<void> {
    const before = await pollBot(ctx, SUBJECT);
    if (!before.position) throw new Error(`${SUBJECT} is not connected`);
    state = {
      start: before.position,
      deathsBefore: await deaths(ctx, SUBJECT),
      completedBefore: await ctx.admin.schedulerCompleted(),
    };
    await summonEvalZombie(ctx, ARENA.center.x + 3, ARENA.center.y, ARENA.center.z, TAG);
  },

  async assert(ctx: EvalContext): Promise<void> {
    const s = state;
    if (!s) throw new Error('trigger did not run');
    await pollUntil({ label: 'S1 reflex outcome', timeoutMs: this.timeoutMs, intervalMs: 1_000 }, async () => {
      const died = (await deaths(ctx, SUBJECT)) > s.deathsBefore;
      if (died) throw new Error('S1: the farmer DIED to a single zombie — self-defense reflex failed');
      const bot = await pollBot(ctx, SUBJECT);
      const zombieAlive = await ctx.rcon.anyEntityWithTag(TAG);
      const moved = bot.position ? dist3(bot.position, s.start) : 0;
      const resolved = !zombieAlive || moved >= 8;
      return {
        done: resolved && (bot.health ?? 0) > 0,
        detail: `zombieAlive=${zombieAlive} movedBlocks=${moved.toFixed(1)} health=${bot.health}`,
      };
    });
    const llmCalls = (await ctx.admin.schedulerCompleted()) - s.completedBefore;
    if (llmCalls > 1) {
      throw new Error(`S1: reflex outcome reached but ${llmCalls} LLM calls were consumed (expected ≤1 — this should be reflex work, not brain work)`);
    }
  },

  async teardown(ctx: EvalContext): Promise<void> {
    await sweepScenario(ctx, TAG);
  },
};
