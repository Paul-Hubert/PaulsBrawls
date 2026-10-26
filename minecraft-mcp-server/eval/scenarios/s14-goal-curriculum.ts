import { ARENA } from '../fixture.js';
import { toolCalls, type MockHandler } from '../mock-llm.js';
import type { EvalContext, Scenario } from '../types.js';
import { pollUntil } from '../util.js';
import { parkAllExcept, settle, sweepScenario } from './helpers.js';
import { REUSE_SKILL, seedMayorSkill } from './s13-skill-reuse.js';

/**
 * S14 goal-curriculum (M13) — self-verification feeding the curriculum loop:
 * a job started with a declarative goal (1x diamond, unobtainable here) ends
 * with an OBJECTIF MANQUÉ verdict that (a) arrives in the job-done wake-up
 * reason and (b) resurfaces in the next heartbeat's PROGRESSION block, where
 * the prompt asks the bot to pick a corrective next step.
 */

const MAYOR = 'EvalBourgmestre';
const TAG = 'eval_s14';

function buildHandler(): MockHandler {
  return (req) => {
    if (req.botName !== MAYOR || req.kind !== 'job') return null;
    if (!req.reasons.some((r) => r.includes('diamant'))) return null;
    if (req.lastToolResult?.includes('started')) return null;
    if (req.lastToolResult?.startsWith('ERROR')) return null;
    return toolCalls({ name: 'start_job', args: { skill: REUSE_SKILL, goalItem: 'diamond', goalCount: 1 } });
  };
}

export const s14GoalCurriculum: Scenario = {
  id: 'S14',
  name: 'goal-curriculum',
  suite: 'trade',
  timeoutMs: 60_000,
  mockOnly: true,

  async preBoot({ dataDir }): Promise<void> {
    await seedMayorSkill(dataDir); // idempotent with S13's preBoot
  },

  async setup(ctx: EvalContext): Promise<void> {
    await parkAllExcept(ctx, [MAYOR]);
    await ctx.rcon.tp(MAYOR, ARENA.center.x, ARENA.center.y, ARENA.center.z);
    await ctx.rcon.clearInventory(MAYOR); // guarantees the goal is missed
    await settle();
    ctx.mock?.reset();
    ctx.mock?.setHandler(buildHandler());
  },

  async trigger(ctx: EvalContext): Promise<void> {
    await ctx.admin.testThink(MAYOR, "trouve un diamant aujourd'hui — lance un job avec un objectif vérifiable", 'job');
  },

  async assert(ctx: EvalContext): Promise<void> {
    // Phase A: the verdict reaches the job-done wake-up.
    await pollUntil({ label: 'S14 verdict in the job-done wake-up', timeoutMs: 40_000, intervalMs: 1_500 }, async () => {
      const verdictWake = ctx.mock?.seen.find(
        (r) => r.botName === MAYOR && r.kind === 'job' && r.reasons.some((reason) => reason.includes('OBJECTIF MANQUÉ'))
      );
      return { done: Boolean(verdictWake), detail: `mockSeen=${ctx.mock?.seen.length ?? 0}` };
    });

    // Phase B: the missed goal resurfaces in the heartbeat's curriculum block.
    await ctx.admin.testThink(MAYOR, 'moment de réflexion', 'heartbeat');
    await pollUntil({ label: 'S14 curriculum block carries the missed goal', timeoutMs: this.timeoutMs, intervalMs: 1_500 }, async () => {
      const heartbeat = ctx.mock?.seen.find((r) => r.botName === MAYOR && r.kind === 'heartbeat');
      const user = heartbeat?.messages.find((m) => m.role === 'user')?.content ?? '';
      const hasBlock = user.includes('PROGRESSION (curriculum)');
      const hasVerdict = user.includes('OBJECTIF MANQUÉ') && user.includes('diamond');
      return { done: hasBlock && hasVerdict, detail: `hasBlock=${hasBlock} hasVerdict=${hasVerdict}` };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    ctx.mock?.reset();
    await sweepScenario(ctx, TAG);
  },
};
