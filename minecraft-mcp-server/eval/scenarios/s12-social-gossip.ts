import { ARENA } from '../fixture.js';
import { toolCalls, type MockHandler } from '../mock-llm.js';
import type { EvalContext, Scenario } from '../types.js';
import { pollUntil } from '../util.js';
import { parkAllExcept, settle, sweepScenario } from './helpers.js';

/**
 * S12 social-gossip (M12) — the structured conversation wrap-up, end to end:
 * a scripted conversation between two farmers ends with leave_conversation
 * carrying {opinion, note, headline}. Afterwards the leaver's relation score
 * moved by the opinion, BOTH parties hold the headline as a high-importance
 * memory, and a third villager standing in earshot picked up the exchange for
 * free (the passive half of gossip diffusion).
 */

const MARGAUX = 'EvalMargaux';
const FIRMIN = 'EvalFirmin';
const WITNESS = 'EvalBrindille';
const TAG = 'eval_s12';

const HEADLINE = 'filon de fer pres de la riviere';

function buildHandler(): MockHandler {
  return (req) => {
    // Margaux's opener deliberation (job kind, outside a conversation).
    if (req.botName === MARGAUX && req.kind === 'job' && !req.inConversationWith) {
      if (req.lastToolResult?.includes('conversation started')) return null; // → done
      if (req.lastToolResult?.startsWith('ERROR')) return null;
      return toolCalls({
        name: 'start_conversation',
        args: { with: FIRMIN, opening: 'Firmin ! Grande nouvelle du cote de la riviere.' },
      });
    }
    // Firmin replies once (plain content = his line, passes the turn).
    if (req.botName === FIRMIN && req.inConversationWith === MARGAUX) {
      return { content: 'Ah oui ? Raconte-moi ca.' };
    }
    // Margaux's conversation turn: wrap up with the structured rating.
    if (req.botName === MARGAUX && req.inConversationWith === FIRMIN) {
      return toolCalls({
        name: 'leave_conversation',
        args: {
          farewell: 'Je retourne au champ, a plus !',
          opinion: 5,
          note: 'bonne oreille',
          headline: HEADLINE,
        },
      });
    }
    return null;
  };
}

export const s12SocialGossip: Scenario = {
  id: 'S12',
  name: 'social-gossip',
  suite: 'trade',
  timeoutMs: 90_000,
  mockOnly: true,

  async setup(ctx: EvalContext): Promise<void> {
    await parkAllExcept(ctx, [MARGAUX, FIRMIN, WITNESS]);
    const { x, y, z } = ARENA.center;
    await ctx.rcon.tp(MARGAUX, x, y, z);
    await ctx.rcon.tp(FIRMIN, x + 3, y, z);
    await ctx.rcon.tp(WITNESS, x, y, z + 10); // inside the 32-block earshot
    await settle();
    ctx.mock?.reset();
    ctx.mock?.setHandler(buildHandler());
  },

  async trigger(ctx: EvalContext): Promise<void> {
    await ctx.admin.testThink(MARGAUX, 'tu croises Firmin — salue-le et partage ta nouvelle', 'job');
  },

  async assert(ctx: EvalContext): Promise<void> {
    await pollUntil({ label: 'S12 relation moved + headline diffused', timeoutMs: this.timeoutMs, intervalMs: 1_500 }, async () => {
      const margaux = await ctx.admin.bot(MARGAUX);
      const firmin = await ctx.admin.bot(FIRMIN);
      const witness = await ctx.admin.bot(WITNESS);

      const relations = (margaux.raw.relations ?? []) as Array<{ name: string; score: number }>;
      const score = relations.find((r) => r.name === FIRMIN)?.score ?? 0;
      const relationMoved = score >= 5; // explicit +5, plus the generic end-of-conversation +1

      const margauxKeeps = margaux.recentMemories.some((m) => m.text.includes(HEADLINE));
      const firminHeard = firmin.recentMemories.some((m) => m.text.includes("m'a confié") && m.text.includes(HEADLINE));
      const witnessOverheard = witness.recentMemories.some((m) => m.text.includes('(entendu)') && m.text.includes(MARGAUX));

      return {
        done: relationMoved && margauxKeeps && firminHeard && witnessOverheard,
        detail: `relation=${score} margauxKeeps=${margauxKeeps} firminHeard=${firminHeard} witnessOverheard=${witnessOverheard}`,
      };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    ctx.mock?.reset();
    await sweepScenario(ctx, TAG);
  },
};
