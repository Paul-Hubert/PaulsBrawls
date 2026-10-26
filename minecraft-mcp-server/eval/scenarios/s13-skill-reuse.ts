import fs from 'fs';
import path from 'path';
import { ARENA } from '../fixture.js';
import { toolCalls, type MockHandler } from '../mock-llm.js';
import type { EvalContext, Scenario } from '../types.js';
import { pollUntil } from '../util.js';
import { parkAllExcept, settle, sweepScenario } from './helpers.js';

/**
 * S13 skill-reuse (M13) — Voyager's "reuse, don't rewrite", as plumbing: a
 * seeded routine relevant to the wake-up reason must reach the prompt WITH
 * its code (the relevance-gated promptBlock), and start_job must run that
 * existing skill end to end (observable memory note).
 *
 * The mayor is the subject — no other scenario's preBoot owns his state file,
 * and his role has no stock routine, so the seeded one is unambiguous.
 */

const MAYOR = 'EvalBourgmestre';
export const REUSE_SKILL = 'collect-stone';
const TAG = 'eval_s13';
export const RAN_MARKER = 'routine collect-stone executee';

const SKILL_CODE = `bot.remember('${RAN_MARKER}');\nawait sleep(200);`;

/** Shared with S14 (same seed, idempotent if both preBoots run). */
export async function seedMayorSkill(dataDir: string): Promise<void> {
  const botsDir = path.join(dataDir, 'bots');
  fs.mkdirSync(botsDir, { recursive: true });
  fs.writeFileSync(
    path.join(botsDir, `${MAYOR}.json`),
    JSON.stringify(
      {
        skills: [
          {
            name: REUSE_SKILL,
            kind: 'routine',
            description: 'ramasse de la pierre autour du village',
            code: SKILL_CODE,
            version: 1,
            status: 'active',
            errorCount: 0,
          },
        ],
        memories: [],
        memorySummary: '',
        relations: {},
      },
      null,
      1
    ),
    'utf8'
  );
}

function buildHandler(): MockHandler {
  return (req) => {
    if (req.botName !== MAYOR || req.kind !== 'job') return null;
    if (!req.reasons.some((r) => r.includes('pierre'))) return null; // not our stimulus (e.g. the job-done wake)
    if (req.lastToolResult?.includes('started')) return null; // → done
    if (req.lastToolResult?.startsWith('ERROR')) return null;
    return toolCalls({ name: 'start_job', args: { skill: REUSE_SKILL } });
  };
}

export const s13SkillReuse: Scenario = {
  id: 'S13',
  name: 'skill-reuse',
  suite: 'trade',
  timeoutMs: 60_000,
  mockOnly: true, // asserts on the prompt the mock received

  async preBoot({ dataDir }): Promise<void> {
    await seedMayorSkill(dataDir);
  },

  async setup(ctx: EvalContext): Promise<void> {
    await parkAllExcept(ctx, [MAYOR]);
    await ctx.rcon.tp(MAYOR, ARENA.center.x, ARENA.center.y, ARENA.center.z);
    await settle();
    ctx.mock?.reset();
    ctx.mock?.setHandler(buildHandler());
  },

  async trigger(ctx: EvalContext): Promise<void> {
    await ctx.admin.testThink(
      MAYOR,
      "il nous faut de la pierre pour le mur — réutilise une compétence existante plutôt que d'en écrire une nouvelle",
      'job'
    );
  },

  async assert(ctx: EvalContext): Promise<void> {
    await pollUntil({ label: 'S13 skill surfaced with code and ran', timeoutMs: this.timeoutMs, intervalMs: 1_500 }, async () => {
      const req = ctx.mock?.seen.find(
        (r) => r.botName === MAYOR && r.kind === 'job' && r.reasons.some((reason) => reason.includes('pierre'))
      );
      const system = req?.messages.find((m) => m.role === 'system')?.content ?? '';
      const skillListed = system.includes(`${REUSE_SKILL} — ramasse de la pierre`);
      const codeShown = system.includes(RAN_MARKER); // the code body itself reached the prompt
      const snapshot = await ctx.admin.bot(MAYOR);
      const ran = snapshot.recentMemories.some((m) => m.text.includes(RAN_MARKER));
      return {
        done: skillListed && codeShown && ran,
        detail: `promptHasSkill=${skillListed} promptHasCode=${codeShown} jobRan=${ran}`,
      };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    ctx.mock?.reset();
    await sweepScenario(ctx, TAG);
  },
};
