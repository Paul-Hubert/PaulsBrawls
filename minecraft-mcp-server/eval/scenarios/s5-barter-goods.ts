import { MARKET } from '../fixture.js';
import { toolCalls, type MockHandler } from '../mock-llm.js';
import type { EvalContext, Scenario } from '../types.js';
import { ledgerHasTrade, pollUntil } from '../util.js';
import { parkAllExcept, settle, sweepScenario } from './helpers.js';

/**
 * S5 barter-goods — the full trade pipeline, deterministically scripted:
 * test-hook think → start_conversation → propose_trade → accept_trade →
 * atomic settlement in the Java mod. Pass: the ledger records the trade AND
 * `data get` proves both inventories actually swapped (32 carrots ⇄ 8 oak
 * planks).
 *
 * Mock script flow (each deliberation is a fresh chat; progress within one is
 * read from tool results, progress across wake-ups from closure counters):
 *   Margaux #1 (job, EVAL_TRADE):  start_conversation → done
 *   Enclume #1 (conversation):      propose_trade → say (turn passes)
 *   Margaux #2 (conversation, offer on table): accept_trade → say
 *   Enclume #2 (conversation):      leave_conversation
 */

const FARMER = 'EvalMargaux';
const CRAFTER = 'EvalEnclume';
const TAG = 'eval_s5';
const CARROTS = 32;
const PLANKS = 8;

let since = 0;

function buildHandler(): MockHandler {
  let crafterWakes = 0;
  return (req) => {
    if (req.lastToolResult?.startsWith('ERROR')) return null; // give up cleanly → done

    if (req.botName === FARMER) {
      if (req.lastToolResult && /conversation started/i.test(req.lastToolResult)) return null;
      if (req.lastToolResult && /trade completed/i.test(req.lastToolResult)) {
        return toolCalls({ name: 'say', args: { message: 'Marché conclu, merci !' } });
      }
      if (req.offerFromOther && req.isFirstRound) {
        return toolCalls({ name: 'accept_trade', args: {} });
      }
      if (!req.inConversationWith && req.reasons.some((r) => r.includes('EVAL_TRADE'))) {
        return toolCalls({
          name: 'start_conversation',
          args: { with: CRAFTER, opening: "J'ai 32 carottes à troquer contre tes planches." },
        });
      }
      return null;
    }

    if (req.botName === CRAFTER && req.inConversationWith) {
      if (req.isFirstRound) crafterWakes++;
      if (req.lastToolResult && /offer placed/i.test(req.lastToolResult)) {
        return toolCalls({ name: 'say', args: { message: `${PLANKS} planches contre ${CARROTS} carottes, marché ?` } });
      }
      if (req.isFirstRound && crafterWakes === 1) {
        return toolCalls({
          name: 'propose_trade',
          args: {
            give: [{ item: 'oak_planks', count: PLANKS }],
            want: [{ item: 'carrot', count: CARROTS }],
          },
        });
      }
      if (req.isFirstRound) {
        return toolCalls({ name: 'leave_conversation', args: { farewell: 'Bonne journée !' } });
      }
    }
    return null;
  };
}

export const s5BarterGoods: Scenario = {
  id: 'S5',
  name: 'barter-goods',
  suite: 'trade',
  timeoutMs: 120_000,

  async setup(ctx: EvalContext): Promise<void> {
    await parkAllExcept(ctx, [FARMER, CRAFTER]);
    await ctx.rcon.tp(FARMER, MARKET.a.x, MARKET.a.y, MARKET.a.z);
    await ctx.rcon.tp(CRAFTER, MARKET.b.x, MARKET.b.y, MARKET.b.z);
    await settle();
    await ctx.rcon.clearInventory(FARMER);
    await ctx.rcon.clearInventory(CRAFTER);
    await ctx.rcon.give(FARMER, 'minecraft:carrot', CARROTS);
    await ctx.rcon.give(CRAFTER, 'minecraft:oak_planks', PLANKS);
    ctx.mock?.setHandler(buildHandler());
    since = Date.now();
  },

  async trigger(ctx: EvalContext): Promise<void> {
    await ctx.admin.testThink(
      FARMER,
      `EVAL_TRADE: tu as ${CARROTS} carottes en trop et besoin de planches. Va troquer avec ${CRAFTER} (il a ${PLANKS} oak_planks).`,
      'job'
    );
  },

  async assert(ctx: EvalContext): Promise<void> {
    await pollUntil({ label: 'S5 barter settled', timeoutMs: this.timeoutMs, intervalMs: 1_500 }, async () => {
      const trades = await ctx.admin.ledger();
      const inLedger = ledgerHasTrade(trades, since, [FARMER, CRAFTER], [
        { item: 'carrot', count: CARROTS },
        { item: 'oak_planks', count: PLANKS },
      ]);
      if (!inLedger) {
        return { done: false, detail: `no matching ledger entry yet (${trades.length} total trades)` };
      }
      // Ledger says settled — now the authoritative inventory check.
      const farmerInv = await ctx.rcon.inventory(FARMER);
      const crafterInv = await ctx.rcon.inventory(CRAFTER);
      const swapped =
        (farmerInv['oak_planks'] ?? 0) >= PLANKS &&
        (farmerInv['carrot'] ?? 0) === 0 &&
        (crafterInv['carrot'] ?? 0) >= CARROTS &&
        (crafterInv['oak_planks'] ?? 0) === 0;
      return {
        done: swapped,
        detail: `ledger=yes farmer={planks:${farmerInv['oak_planks'] ?? 0},carrot:${farmerInv['carrot'] ?? 0}} crafter={carrot:${crafterInv['carrot'] ?? 0},planks:${crafterInv['oak_planks'] ?? 0}}`,
      };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    ctx.mock?.reset();
    await ctx.rcon.clearInventory(FARMER);
    await ctx.rcon.clearInventory(CRAFTER);
    await sweepScenario(ctx, TAG);
  },
};
