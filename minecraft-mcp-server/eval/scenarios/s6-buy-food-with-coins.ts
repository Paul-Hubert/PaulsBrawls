import { MARKET } from '../fixture.js';
import { toolCalls, type MockHandler } from '../mock-llm.js';
import type { EvalContext, Scenario } from '../types.js';
import { ledgerHasTrade, pollUntil } from '../util.js';
import { parkAllExcept, pollBot, settle, sweepScenario } from './helpers.js';

/**
 * S6 buy-food-with-coins — Gibber integration: the fisher pays 10 `coin`
 * (paulsbrawls:coin, the mod's currency) for the shopkeeper's 16 bread, and
 * then auto-eat fixes the hunger that motivated the purchase. Pass: ledger
 * entry coins⇄bread, the shopkeeper authoritatively holds the coins, and the
 * fisher's food recovers to ≥15.
 *
 * Note: coins are a MODDED item — mineflayer sees them as 'unknown' (not in
 * vanilla minecraft-data), which is exactly why the trade pre-validation skips
 * unresolvable names and lets the Java listener validate authoritatively.
 */

const FISHER = 'EvalGoujon';
const SHOPKEEPER = 'EvalEcu';
const TAG = 'eval_s6';
const COINS = 10;
const BREAD = 16;

let since = 0;

function buildHandler(): MockHandler {
  let shopkeeperWakes = 0;
  return (req) => {
    if (req.lastToolResult?.startsWith('ERROR')) return null;

    if (req.botName === FISHER) {
      if (req.lastToolResult && /conversation started/i.test(req.lastToolResult)) return null;
      if (req.lastToolResult && /trade completed/i.test(req.lastToolResult)) {
        return toolCalls({ name: 'say', args: { message: 'Merci, bon pain !' } });
      }
      if (req.offerFromOther && req.isFirstRound) {
        return toolCalls({ name: 'accept_trade', args: {} });
      }
      if (!req.inConversationWith && req.reasons.some((r) => r.includes('EVAL_BUY'))) {
        return toolCalls({
          name: 'start_conversation',
          args: { with: SHOPKEEPER, opening: "J'ai grand faim — vends-moi du pain, j'ai des pièces." },
        });
      }
      return null;
    }

    if (req.botName === SHOPKEEPER && req.inConversationWith) {
      if (req.isFirstRound) shopkeeperWakes++;
      if (req.lastToolResult && /offer placed/i.test(req.lastToolResult)) {
        return toolCalls({ name: 'say', args: { message: `${BREAD} pains contre ${COINS} pièces, prix d'ami.` } });
      }
      if (req.isFirstRound && shopkeeperWakes === 1) {
        return toolCalls({
          name: 'propose_trade',
          args: {
            give: [{ item: 'bread', count: BREAD }],
            want: [{ item: 'coin', count: COINS }],
          },
        });
      }
      if (req.isFirstRound) {
        return toolCalls({ name: 'leave_conversation', args: { farewell: 'Reviens quand tu veux !' } });
      }
    }
    return null;
  };
}

export const s6BuyFoodWithCoins: Scenario = {
  id: 'S6',
  name: 'buy-food-with-coins',
  suite: 'trade',
  timeoutMs: 120_000,

  async setup(ctx: EvalContext): Promise<void> {
    await parkAllExcept(ctx, [FISHER, SHOPKEEPER]);
    await ctx.rcon.tp(FISHER, MARKET.a.x, MARKET.a.y, MARKET.a.z);
    await ctx.rcon.tp(SHOPKEEPER, MARKET.b.x, MARKET.b.y, MARKET.b.z);
    await settle();
    await ctx.rcon.clearInventory(FISHER);
    await ctx.rcon.clearInventory(SHOPKEEPER);
    await ctx.rcon.give(FISHER, 'paulsbrawls:coin', COINS);
    await ctx.rcon.give(SHOPKEEPER, 'minecraft:bread', BREAD);
    ctx.mock?.setHandler(buildHandler());
    since = Date.now();
  },

  async trigger(ctx: EvalContext): Promise<void> {
    // Hunger first (the motive), then the wake-up.
    await ctx.rcon.effect(FISHER, 'minecraft:hunger', 15, 49);
    await ctx.admin.testThink(
      FISHER,
      `EVAL_BUY: tu meurs de faim et tu as ${COINS} pièces (coin). ${SHOPKEEPER} vend du pain — achète-en.`,
      'job'
    );
  },

  async assert(ctx: EvalContext): Promise<void> {
    await pollUntil({ label: 'S6 coins for bread', timeoutMs: this.timeoutMs, intervalMs: 1_500 }, async () => {
      const trades = await ctx.admin.ledger();
      const inLedger = ledgerHasTrade(trades, since, [FISHER, SHOPKEEPER], [
        { item: 'bread', count: BREAD },
        { item: 'coin', count: COINS },
      ]);
      if (!inLedger) {
        return { done: false, detail: `no matching ledger entry yet (${trades.length} total trades)` };
      }
      const shopInv = await ctx.rcon.inventory(SHOPKEEPER);
      const fisherInv = await ctx.rcon.inventory(FISHER);
      const fisher = await pollBot(ctx, FISHER);
      const coinsPaid = (shopInv['paulsbrawls:coin'] ?? 0) >= COINS;
      const breadDelivered = (fisherInv['bread'] ?? 0) > 0; // some already eaten is fine
      const recovered = (fisher.food ?? 0) >= 15;
      return {
        done: coinsPaid && breadDelivered && recovered,
        detail: `ledger=yes shopCoins=${shopInv['paulsbrawls:coin'] ?? 0} fisherBread=${fisherInv['bread'] ?? 0} fisherFood=${fisher.food}`,
      };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    ctx.mock?.reset();
    await ctx.rcon.effectClear(FISHER);
    await ctx.rcon.clearInventory(FISHER);
    await ctx.rcon.clearInventory(SHOPKEEPER);
    await sweepScenario(ctx, TAG);
  },
};
