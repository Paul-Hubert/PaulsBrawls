import fs from 'fs';
import path from 'path';
import type { EvalContext, Scenario } from '../types.js';
import { pollUntil } from '../util.js';
import { parkAllExcept, settle, sweepScenario } from './helpers.js';

/**
 * S11 needs-reflex (M11) — the drives plumbing end to end with ZERO LLM
 * calls: a pre-seeded low rest level crosses the threshold on the first
 * needs tick, the 'tired' event fires, and a bot-authored reflex (installed
 * through the REAL typecheck+sandbox pipeline at boot) writes the reaction
 * into memory.
 */

const SHOPKEEPER = 'EvalEcu'; // NOT EvalGoujon — S7's preBoot owns that state file
const SKILL = 'eval-tired-note';
const TAG = 'eval_s11';
const NOTE_MARKER = 'epuise-pause';

/** Exported so the unit suite can pin it through the real validation pipeline. */
export const TIRED_REFLEX_CODE = `bot.on('tired', async (e) => {
  bot.remember('${NOTE_MARKER}: repos ' + e.value.toFixed(2) + ' — je fais une pause');
});`;

let mockBaseline = 0;

export const s11NeedsReflex: Scenario = {
  id: 'S11',
  name: 'needs-reflex',
  suite: 'reflex',
  timeoutMs: 45_000,

  async preBoot({ dataDir }): Promise<void> {
    const botsDir = path.join(dataDir, 'bots');
    fs.mkdirSync(botsDir, { recursive: true });
    fs.writeFileSync(
      path.join(botsDir, `${SHOPKEEPER}.json`),
      JSON.stringify(
        {
          skills: [
            {
              name: SKILL,
              kind: 'reflex',
              description: '(eval) note quand la fatigue tombe trop bas',
              code: TIRED_REFLEX_CODE,
              version: 1,
              status: 'active',
              errorCount: 0,
            },
          ],
          memories: [],
          memorySummary: '',
          relations: {},
          needs: { rest: 0.2, social: 1 }, // already under the 0.25 threshold
          mood: '',
          dayPlan: null,
        },
        null,
        1
      ),
      'utf8'
    );
  },

  async setup(ctx: EvalContext): Promise<void> {
    await parkAllExcept(ctx, [SHOPKEEPER]);
    await settle();
    ctx.mock?.reset(); // no scripted replies — this scenario must consume zero LLM
    mockBaseline = ctx.mock?.requestCount ?? 0;
  },

  async trigger(): Promise<void> {
    // Nothing to do: the scan loop's needs tick crosses the threshold by itself.
  },

  async assert(ctx: EvalContext): Promise<void> {
    await pollUntil({ label: 'S11 tired reflex wrote its note', timeoutMs: this.timeoutMs, intervalMs: 1_500 }, async () => {
      const snapshot = await ctx.admin.bot(SHOPKEEPER);
      const memories = snapshot.recentMemories;
      const noted = memories.some((m) => m.text.includes(NOTE_MARKER));
      const llmCalls = (ctx.mock?.requestCount ?? mockBaseline) - mockBaseline;
      return {
        done: noted && llmCalls === 0,
        detail: `noted=${noted} llmCallsDuringScenario=${llmCalls} memWindow=${memories.length}`,
      };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    ctx.mock?.reset();
    await sweepScenario(ctx, TAG);
  },
};
