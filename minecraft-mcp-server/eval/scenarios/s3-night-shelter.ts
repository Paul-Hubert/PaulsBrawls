import { EVAL_BOTS, NIGHT_SHELTER_ROLES } from '../fixture.js';
import type { EvalContext, Scenario } from '../types.js';
import { dist3, pollUntil, sleep } from '../util.js';
import { settle } from './helpers.js';

/**
 * S3 night-shelter — `time set 13000` and every civilian must walk home, via
 * the stock `night-shelter` reflex on the day→night transition (the shared
 * scan loop latches it; no LLM involved). Guards and the miner deliberately
 * lack the reflex (see stock-skills.ts roles), so the assertion covers the
 * seven shelter-seeking civilians: within 90 s each is ≤4 blocks from its
 * roster home.
 */

const CIVILIANS = EVAL_BOTS.filter((b) => NIGHT_SHELTER_ROLES.has(b.role));

export const s3NightShelter: Scenario = {
  id: 'S3',
  name: 'night-shelter',
  suite: 'reflex',
  timeoutMs: 90_000,

  async setup(ctx: EvalContext): Promise<void> {
    // Daytime first, and give the 2.5 s scan loop a couple of ticks to latch
    // wasNight=false, or the transition won't fire.
    await ctx.rcon.timeSet(1_000);
    // Everyone starts a short walk from home: civilians 6 blocks off their
    // home, guards at their posts (they should NOT walk home).
    for (const bot of EVAL_BOTS) {
      if (NIGHT_SHELTER_ROLES.has(bot.role)) {
        await ctx.rcon.tp(bot.name, bot.home.x + 6, bot.home.y, bot.home.z + 6);
      } else {
        const post = bot.workstation ?? bot.home;
        await ctx.rcon.tp(bot.name, post.x, post.y, post.z);
      }
    }
    await settle(6_000);
  },

  async trigger(ctx: EvalContext): Promise<void> {
    await ctx.rcon.timeSet(13_000);
  },

  async assert(ctx: EvalContext): Promise<void> {
    await pollUntil({ label: 'S3 civilians home', timeoutMs: this.timeoutMs, intervalMs: 1_500 }, async () => {
      const away: string[] = [];
      for (const bot of CIVILIANS) {
        const snapshot = await ctx.admin.bot(bot.name);
        const distance = snapshot.position ? dist3(snapshot.position, bot.home) : Infinity;
        if (distance > 4) away.push(`${bot.name}@${distance.toFixed(1)}`);
      }
      return {
        done: away.length === 0,
        detail: away.length === 0 ? 'all civilians home' : `still away: ${away.join(', ')}`,
      };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    await ctx.rcon.timeSet(1_000);
    await sleep(500);
  },
};
