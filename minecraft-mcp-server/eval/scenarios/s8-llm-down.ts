import { ARENA } from '../fixture.js';
import type { EvalContext, Scenario } from '../types.js';
import { dist3, pollUntil } from '../util.js';
import { deaths, outfit, parkAllExcept, pollBot, settle, summonEvalZombie, sweepScenario } from './helpers.js';

/**
 * S8 llm-down-degradation — the architecture's degradation guarantee: with the
 * LLM returning HTTP 500 for EVERYTHING, S1's trigger must still resolve
 * through the reflex layer, and the village process must shrug off the failed
 * deliberations. Pass: same reflex outcome as S1, admin API still answering,
 * no crash.
 */

const SUBJECT = 'EvalFirmin';
const TAG = 'eval_s8';

interface S8State {
  start: { x: number; y: number; z: number };
  deathsBefore: number;
}

let state: S8State | null = null;

export const s8LlmDown: Scenario = {
  id: 'S8',
  name: 'llm-down-degradation',
  suite: 'reflex',
  timeoutMs: 35_000,
  mockOnly: true,

  async setup(ctx: EvalContext): Promise<void> {
    state = null;
    if (!ctx.mock) throw new Error('S8 requires the mock LLM');
    await ctx.rcon.killTagged(TAG);
    await parkAllExcept(ctx, [SUBJECT]);
    await ctx.rcon.tp(SUBJECT, ARENA.center.x, ARENA.center.y, ARENA.center.z);
    await settle();
    await outfit(ctx, SUBJECT, { sword: true, armor: true });
    ctx.mock.mode = 'http-500';
  },

  async trigger(ctx: EvalContext): Promise<void> {
    const before = await pollBot(ctx, SUBJECT);
    if (!before.position) throw new Error(`${SUBJECT} is not connected`);
    state = {
      start: before.position,
      deathsBefore: await deaths(ctx, SUBJECT),
    };
    await summonEvalZombie(ctx, ARENA.center.x + 3, ARENA.center.y, ARENA.center.z, TAG);
  },

  async assert(ctx: EvalContext): Promise<void> {
    const s = state;
    if (!s) throw new Error('trigger did not run');
    await pollUntil({ label: 'S8 degraded reflex outcome', timeoutMs: this.timeoutMs, intervalMs: 1_000 }, async () => {
      const died = (await deaths(ctx, SUBJECT)) > s.deathsBefore;
      if (died) throw new Error('S8: the farmer DIED with the LLM down — reflex degradation failed');
      const bot = await pollBot(ctx, SUBJECT);
      const zombieAlive = await ctx.rcon.anyEntityWithTag(TAG);
      const moved = bot.position ? dist3(bot.position, s.start) : 0;
      return {
        done: (!zombieAlive || moved >= 8) && (bot.health ?? 0) > 0,
        detail: `zombieAlive=${zombieAlive} movedBlocks=${moved.toFixed(1)} health=${bot.health}`,
      };
    });
    // The village process must still be standing after eating LLM failures.
    const status = await ctx.admin.status();
    if (!status.ok) throw new Error('S8: village admin API reports not-ok after LLM failures');
  },

  async teardown(ctx: EvalContext): Promise<void> {
    ctx.mock?.reset();
    await sweepScenario(ctx, TAG);
  },
};
