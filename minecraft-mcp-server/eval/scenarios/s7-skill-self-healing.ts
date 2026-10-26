import fs from 'fs';
import path from 'path';
import { ARENA } from '../fixture.js';
import { toolCalls, type MockHandler } from '../mock-llm.js';
import type { EvalContext, Scenario } from '../types.js';
import { pollUntil, sleep } from '../util.js';
import { parkAllExcept, settle, sweepScenario } from './helpers.js';

/**
 * S7 skill-self-healing — the circuit breaker + rewrite loop. A deliberately
 * broken reflex is pre-seeded into the fisher's state file BEFORE the village
 * process boots (it typechecks — strict:false — but throws at runtime). Three
 * `/damage` hits strike it out: the skill flips to `disabled`, the engine
 * queues a fix-it deliberation, the (mock) LLM answers with write_skill, and
 * the skill comes back `active` at v2.
 */

const FISHER = 'EvalGoujon';
const SKILL = 'eval-broken-reflex';
const TAG = 'eval_s7';

/** Typechecks (readings[2] is `number` without strictNullChecks) but throws
 *  TypeError at runtime — exactly the class of bug the breaker exists for.
 *  Exported so the unit tests can pin both through the REAL validation
 *  pipeline (typecheck + AST guards). */
export const BROKEN_CODE = `// (eval) deliberately broken: readings[2] is undefined at runtime
bot.on('hurt', async (e) => {
  const readings = [1];
  bot.remember('seuil de douleur: ' + readings[2].toFixed(1));
});`;

export const FIXED_CODE = `bot.on('hurt', async (e) => {
  bot.remember('aie — reflexe repare et operationnel');
});`;

interface S7State {
  sawFixRequest: boolean;
  triedFallback: boolean;
}

let state: S7State = { sawFixRequest: false, triedFallback: false };

function buildHandler(s: S7State): MockHandler {
  return (req) => {
    if (req.botName !== FISHER) return null;
    const fixRequest = req.reasons.some((r) => r.includes('DISABLED') && r.includes(SKILL));
    if (!fixRequest) return null;
    if (req.lastToolResult && /installed and live/i.test(req.lastToolResult)) return null; // → done
    if (req.lastToolResult?.startsWith('ERROR') || req.lastToolResult?.includes('FAILED')) return null;
    s.sawFixRequest = true;
    return toolCalls({
      name: 'write_skill',
      args: { name: SKILL, kind: 'reflex', description: 'capteur de douleur (réparé)', code: FIXED_CODE },
    });
  };
}

export const s7SkillSelfHealing: Scenario = {
  id: 'S7',
  name: 'skill-self-healing',
  suite: 'trade',
  timeoutMs: 60_000,

  async preBoot({ dataDir }): Promise<void> {
    const botsDir = path.join(dataDir, 'bots');
    fs.mkdirSync(botsDir, { recursive: true });
    const stateFile = path.join(botsDir, `${FISHER}.json`);
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        {
          skills: [
            {
              name: SKILL,
              kind: 'reflex',
              description: '(eval) capteur de douleur — volontairement cassé',
              code: BROKEN_CODE,
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
  },

  async setup(ctx: EvalContext): Promise<void> {
    state = { sawFixRequest: false, triedFallback: false };
    await parkAllExcept(ctx, [FISHER]);
    await ctx.rcon.tp(FISHER, ARENA.center.x, ARENA.center.y, ARENA.center.z);
    await settle();
    await ctx.rcon.clearInventory(FISHER);
    ctx.mock?.setHandler(buildHandler(state));
  },

  async trigger(ctx: EvalContext): Promise<void> {
    // Three strikes, spaced past the 'hurt' event's 2 s coalescing window.
    for (let i = 0; i < 3; i++) {
      await ctx.rcon.damage(FISHER, 1);
      await sleep(3_500);
    }
  },

  async assert(ctx: EvalContext): Promise<void> {
    const started = Date.now();
    await pollUntil({ label: 'S7 skill healed', timeoutMs: this.timeoutMs, intervalMs: 1_000 }, async () => {
      const snapshot = await ctx.admin.bot(FISHER);
      const skill = snapshot.skills.find((s) => s.name === SKILL);
      if (!skill) {
        return { done: false, detail: `skill '${SKILL}' missing from the library` };
      }
      const healed = skill.status === 'active' && skill.version >= 2;
      const fixSeen = ctx.mock ? state.sawFixRequest : true; // real mode: outcome only
      // Order-independence net: if the breaker already tripped in an earlier
      // run/scenario and its fix request was consumed elsewhere, re-issue it.
      if (
        !healed &&
        !state.triedFallback &&
        skill.status === 'disabled' &&
        Date.now() - started > 20_000
      ) {
        state.triedFallback = true;
        await ctx.admin.testThink(
          FISHER,
          `my reflex '${SKILL}' was DISABLED after repeated errors (last: ${skill.lastError ?? 'runtime error'}). Fix it with write_skill or remove it.`,
          'job'
        );
      }
      return {
        done: healed && fixSeen,
        detail: `status=${skill.status} v${skill.version} errors=${skill.errorCount} lastError=${(skill.lastError ?? '').slice(0, 60)} fixRequestSeen=${state.sawFixRequest}`,
      };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    ctx.mock?.reset();
    await sweepScenario(ctx, TAG);
  },
};
