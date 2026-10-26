import { ARENA } from '../fixture.js';
import type { EvalContext, Scenario } from '../types.js';
import { pollUntil } from '../util.js';
import { parkAllExcept, pollBot, settle, sweepScenario } from './helpers.js';

/**
 * S4 auto-eat — survival is plugin-level (mineflayer-auto-eat), below even the
 * reflex layer. Give the lumberjack 8 bread, slam them with a strong hunger
 * effect, and assert the bot eats its way back: bread count drops
 * (authoritative `data get`) and food recovers to ≥15 — with ZERO LLM calls.
 */

const SUBJECT = 'EvalBrindille';
const TAG = 'eval_s4';
const BREAD = 8;

let completedBefore = 0;

export const s4AutoEat: Scenario = {
  id: 'S4',
  name: 'auto-eat',
  suite: 'reflex',
  timeoutMs: 120_000,

  async setup(ctx: EvalContext): Promise<void> {
    await parkAllExcept(ctx, [SUBJECT]);
    await ctx.rcon.tp(SUBJECT, ARENA.center.x, ARENA.center.y, ARENA.center.z);
    await settle();
    await ctx.rcon.clearInventory(SUBJECT);
    await ctx.rcon.give(SUBJECT, 'minecraft:bread', BREAD);
  },

  async trigger(ctx: EvalContext): Promise<void> {
    completedBefore = await ctx.admin.schedulerCompleted();
    // Hunger V0 (amplifier 49) drains ~5 exhaustion/s: food visibly craters in
    // ~10 s, then the 15 s effect ends — fast dip, no starvation-death risk.
    await ctx.rcon.effect(SUBJECT, 'minecraft:hunger', 15, 49);
  },

  async assert(ctx: EvalContext): Promise<void> {
    await pollUntil({ label: 'S4 auto-eat recovery', timeoutMs: this.timeoutMs, intervalMs: 1_000 }, async () => {
      const inventory = await ctx.rcon.inventory(SUBJECT);
      const breadLeft = inventory['bread'] ?? 0;
      const bot = await pollBot(ctx, SUBJECT);
      const ate = breadLeft < BREAD;
      const recovered = (bot.food ?? 0) >= 15;
      return {
        done: ate && recovered,
        detail: `breadLeft=${breadLeft}/${BREAD} food=${bot.food} health=${bot.health}`,
      };
    });
    const llmCalls = (await ctx.admin.schedulerCompleted()) - completedBefore;
    if (llmCalls > 0) {
      throw new Error(`S4: auto-eat worked but ${llmCalls} LLM call(s) were consumed — survival must be free`);
    }
  },

  async teardown(ctx: EvalContext): Promise<void> {
    await ctx.rcon.effectClear(SUBJECT);
    await ctx.rcon.clearInventory(SUBJECT);
    await sweepScenario(ctx, TAG);
  },
};
