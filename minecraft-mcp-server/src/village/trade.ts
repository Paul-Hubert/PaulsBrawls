import { log, logDebug } from '../logger.js';
import { goTo, inventoryCount, isRegistryItem } from './actions.js';
import { Conversation } from './conversation.js';
import { VillageContext } from './context.js';
import { ItemStack } from './types.js';
import type { Villager } from './villager.js';

/**
 * Barter (VILLAGE_PLAN §5): negotiation rides on a conversation as typed offer
 * objects (the prose is flavor, the offer object is the contract); settlement
 * is a server-authoritative atomic swap performed by the Java mod's village
 * listener — never item tossing.
 *
 * {@link TradeManager.give} (M14) is the one-way variant: a "trade" with an
 * empty return side, settled through the same Java endpoint, with an
 * item-toss fallback for when the settlement service is down. It exists so a
 * two-bot village without a chest can still hand items over ("give 8 seeds to
 * Froment") instead of deadlocking on missing infrastructure.
 */

const ITEM_NAME_RE = /^[a-z0-9_]{1,64}$/;
const MAX_OFFER_LINES = 6;
const MAX_STACK_COUNT = 512;

export function formatStacks(stacks: ItemStack[]): string {
  return stacks.length === 0 ? '(nothing)' : stacks.map((s) => `${s.count}x ${s.item}`).join(', ');
}

function validateStacks(stacks: unknown, label: string): ItemStack[] {
  if (!Array.isArray(stacks)) throw new Error(`${label} must be an array of { item, count }`);
  if (stacks.length > MAX_OFFER_LINES) throw new Error(`${label}: at most ${MAX_OFFER_LINES} item lines`);
  const result: ItemStack[] = [];
  for (const raw of stacks) {
    const item = String((raw as { item?: unknown }).item ?? '').toLowerCase().replace(/^minecraft:/, '');
    const count = Number((raw as { count?: unknown }).count);
    if (!ITEM_NAME_RE.test(item)) throw new Error(`${label}: bad item name '${item}'`);
    if (!Number.isInteger(count) || count < 1 || count > MAX_STACK_COUNT) {
      throw new Error(`${label}: bad count for ${item} (1..${MAX_STACK_COUNT})`);
    }
    result.push({ item, count });
  }
  return result;
}

interface SettleResponse {
  ok: boolean;
  error?: string;
}

export class TradeManager {
  private ctx!: VillageContext;

  init(ctx: VillageContext): void {
    this.ctx = ctx;
  }

  /**
   * Put an offer on the table (also serves as a counter-offer — it replaces
   * whatever was there). Returns a human-readable result for the tool output.
   */
  propose(conv: Conversation, from: string, giveRaw: unknown, wantRaw: unknown): string {
    const give = validateStacks(giveRaw, 'give');
    const want = validateStacks(wantRaw, 'want');
    if (give.length === 0 && want.length === 0) throw new Error('an offer needs at least one item on one side');

    const bot = this.ctx.villagers.get(from)?.bot();
    if (bot) {
      for (const stack of give) {
        // Modded items (the coin!) appear as 'unknown' to mineflayer — skip
        // the local count and let the Java settlement validate authoritatively.
        if (!isRegistryItem(bot, stack.item)) continue;
        const have = inventoryCount(bot, stack.item);
        if (have < stack.count) {
          throw new Error(`you only have ${have}x ${stack.item} — offer less or get more first`);
        }
      }
    }

    conv.offer = { from, give, want };
    logDebug(from, `trade offer #${conv.id}: give [${formatStacks(give)}] want [${formatStacks(want)}]`);
    return `offer placed: you give [${formatStacks(give)}] for [${formatStacks(want)}]. ${this.otherName(conv, from)} must accept_trade for it to happen.`;
  }

  reject(conv: Conversation, by: string): string {
    if (!conv.offer) return 'there is no offer on the table';
    const was = conv.offer;
    conv.offer = null;
    logDebug(by, `trade offer #${conv.id} from ${was.from} rejected`);
    return `offer from ${was.from} rejected by ${by}`;
  }

  /** Accept the standing offer (must come from the non-proposing party). Settles atomically via the Java mod. */
  async accept(conv: Conversation, accepter: string): Promise<string> {
    const offer = conv.offer;
    if (!offer) throw new Error('there is no offer on the table');
    if (offer.from === accepter) throw new Error('you proposed this offer — the other party must accept it');

    const proposer = this.ctx.villagers.get(offer.from);
    const acceptingVillager = this.ctx.villagers.get(accepter);
    if (!proposer || !acceptingVillager) throw new Error('participant disappeared');

    // Pre-validate both sides from the live inventories (the Java side
    // re-validates authoritatively — this just produces better error messages).
    const proposerBot = proposer.bot();
    const accepterBot = acceptingVillager.bot();
    if (!proposerBot || !accepterBot) throw new Error('one of you is not connected');
    for (const stack of offer.give) {
      if (!isRegistryItem(proposerBot, stack.item)) continue;
      if (inventoryCount(proposerBot, stack.item) < stack.count) {
        conv.offer = null;
        throw new Error(`deal is off — ${offer.from} no longer has ${stack.count}x ${stack.item}`);
      }
    }
    for (const stack of offer.want) {
      if (!isRegistryItem(accepterBot, stack.item)) continue;
      if (inventoryCount(accepterBot, stack.item) < stack.count) {
        conv.offer = null;
        throw new Error(`you don't have ${formatStacks([stack])} to pay with`);
      }
    }

    const tradeTags = [offer.from, accepter, ...offer.give.map((s) => s.item), ...offer.want.map((s) => s.item)];
    const result = await this.settle(offer.from, accepter, offer.give, offer.want);
    if (!result.ok) {
      conv.offer = null;
      proposer.memory.append('trade', `trade with ${accepter} fell through: ${result.error}`, tradeTags);
      acceptingVillager.memory.append('trade', `trade with ${offer.from} fell through: ${result.error}`, tradeTags);
      throw new Error(`settlement failed: ${result.error ?? 'unknown error'}`);
    }

    conv.offer = null;
    this.ctx.persistence.appendLedger({
      at: Date.now(),
      a: offer.from,
      b: accepter,
      aGave: offer.give,
      bGave: offer.want,
    });
    const summary = `échange conclu: ${offer.from} a donné [${formatStacks(offer.give)}] contre [${formatStacks(offer.want)}] de ${accepter}`;
    proposer.memory.append('trade', summary, tradeTags);
    acceptingVillager.memory.append('trade', summary, tradeTags);
    proposer.memory.adjustRelation(accepter, 4, 'bon partenaire commercial');
    acceptingVillager.memory.adjustRelation(offer.from, 4, 'bon partenaire commercial');
    log('info', `[village] TRADE ${offer.from} ⇄ ${accepter}: [${formatStacks(offer.give)}] for [${formatStacks(offer.want)}]`);
    return `trade completed! You received [${formatStacks(offer.give)}] and paid [${formatStacks(offer.want)}].`;
  }

  /**
   * One-way item transfer between villagers. Primary path: the Java settlement
   * listener (atomic, server-authoritative, works at any distance — the
   * existing /trade/execute endpoint accepts an empty return side). Fallback:
   * walk to the receiver and toss the stack, confirming via the receiver's
   * inventory delta. Returns how many items were actually delivered.
   */
  async give(giverName: string, receiverName: string, itemNameRaw: string, countRaw: number): Promise<number> {
    const itemName = String(itemNameRaw).toLowerCase().replace(/^minecraft:/, '');
    const count = Math.floor(Number(countRaw));
    if (!ITEM_NAME_RE.test(itemName)) throw new Error(`bad item name '${itemName}'`);
    if (!Number.isInteger(count) || count < 1 || count > MAX_STACK_COUNT) {
      throw new Error(`bad count for ${itemName} (1..${MAX_STACK_COUNT})`);
    }
    const giver = this.ctx.villagers.get(giverName);
    const receiver = this.ctx.villagers.get(receiverName);
    if (!giver) throw new Error(`no villager named '${giverName}'`);
    if (!receiver) throw new Error(`no villager named '${receiverName}' — give works between villagers`);
    if (giverName === receiverName) throw new Error('cannot give to yourself');
    const bot = giver.bot();
    if (!bot) throw new Error('you are not in the world right now');
    if (isRegistryItem(bot, itemName)) {
      const have = inventoryCount(bot, itemName);
      if (have < count) throw new Error(`you only have ${have}x ${itemName}`);
    }

    const settled = await this.settle(giverName, receiverName, [{ item: itemName, count }], []);
    let delivered: number;
    let via: string;
    if (settled.ok) {
      delivered = count;
      via = 'settlement';
    } else {
      delivered = await this.giveByToss(giver, receiver, itemName, count, settled.error);
      via = 'toss';
    }
    this.ctx.persistence.appendLedger({
      at: Date.now(),
      a: giverName,
      b: receiverName,
      aGave: [{ item: itemName, count: delivered }],
      bGave: [],
    });
    giver.memory.append('trade', `j'ai donné ${delivered}x ${itemName} à ${receiverName}`, [receiverName, itemName], 5);
    receiver.memory.append('trade', `${giverName} m'a donné ${delivered}x ${itemName}`, [giverName, itemName], 5);
    log('info', `[village] GIVE ${giverName} → ${receiverName}: ${delivered}x ${itemName} (${via})`);
    return delivered;
  }

  /**
   * Toss fallback. Failure modes handled: modded items (can't be tossed —
   * mineflayer's registry doesn't know them), receiver offline, nothing
   * picked up (items despawn-safe on the ground; we report WHERE). Tossed
   * items carry a ~2 s pickup delay, so we poll the receiver's inventory
   * (same process — authoritative enough) rather than trusting item physics.
   */
  private async giveByToss(giver: Villager, receiver: Villager, itemName: string, count: number, settleError?: string): Promise<number> {
    const bot = giver.requireBot();
    const receiverBot = receiver.bot();
    if (!receiverBot?.entity) {
      throw new Error(`${receiver.name} is not in the world right now (settlement also failed: ${settleError ?? 'unavailable'})`);
    }
    const info = (bot.registry as { itemsByName: Record<string, { id: number } | undefined> }).itemsByName[itemName];
    if (!info) {
      throw new Error(
        `settlement service unavailable (${settleError ?? 'unreachable'}) and '${itemName}' is a modded item that cannot be tossed — retry when the mod's village listener is up`
      );
    }
    const target = receiverBot.entity.position;
    await goTo(bot, Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), 2);
    const receiverHas = (): number => inventoryCount(receiverBot, itemName);
    const beforePickup = receiverHas();
    const toToss = Math.min(count, inventoryCount(bot, itemName));
    if (toToss < 1) throw new Error(`no ${itemName} left to give`);
    await bot.lookAt(receiverBot.entity.position.offset(0, 1, 0), true);
    await bot.toss(info.id, null, toToss);
    const deadline = Date.now() + 10_000;
    let received = 0;
    while (Date.now() < deadline) {
      received = receiverHas() - beforePickup;
      if (received >= toToss) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (received <= 0) {
      throw new Error(
        `tossed ${toToss}x ${itemName} toward ${receiver.name} but nothing was picked up within 10s — ` +
        `the items are on the ground near (${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)})`
      );
    }
    return Math.min(received, toToss);
  }

  /** POST to the Java mod's localhost settlement listener. */
  private async settle(botA: string, botB: string, aGives: ItemStack[], bGives: ItemStack[]): Promise<SettleResponse> {
    const url = `${this.ctx.settings.settlementUrl.replace(/\/+$/, '')}/trade/execute`;
    logDebug('trade', `settlement POST ${url}: ${botA} gives [${formatStacks(aGives)}], ${botB} gives [${formatStacks(bGives)}]`);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botA, botB, aGives, bGives }),
        signal: controller.signal,
      });
      const body = (await resp.json().catch(() => ({}))) as SettleResponse;
      logDebug('trade', `settlement reply in ${Date.now() - startedAt}ms: HTTP ${resp.status}, ok=${body.ok === true}${body.error ? `, error=${body.error}` : ''}`);
      if (!resp.ok) return { ok: false, error: body.error ?? `HTTP ${resp.status}` };
      return { ok: body.ok === true, error: body.error };
    } catch (err) {
      const message = controller.signal.aborted ? 'settlement request timed out' : String(err);
      logDebug('trade', `settlement FAILED after ${Date.now() - startedAt}ms: ${message}`);
      return { ok: false, error: `cannot reach the village settlement service (${message}) — is the mod running with /village on?` };
    } finally {
      clearTimeout(timer);
    }
  }

  private otherName(conv: Conversation, name: string): string {
    return conv.participants[0] === name ? conv.participants[1] : conv.participants[0];
  }
}
