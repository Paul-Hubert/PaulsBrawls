// Trade (layer 3, social/) — typed offer objects negotiated inside a conversation, settled via the Java
// mod (04 §Trade). Two pieces:
//   • SettlementClient — POSTs a typed offer to {settlement.url} (default 127.0.0.1:8767/trade/execute,
//     the mod's VillageHttpListener). The wire body is the JAVA contract `{botA, botB, aGives, bGives}`
//     (VillageHttpListener.TradeRequest), mapped from the offer by toSettlementRequest — NOT the offer's
//     own `from/to/give/want` names (Gson would leave the Java fields null → 400 `missing botA`).
//     `coin` resolves to `paulsbrawls:coin` so Gibber is the village currency for free. The mod re-validates + swaps inventories ATOMICALLY on the main thread — so a
//     non-2xx (or a network error) means NOTHING swapped (inventories untouched). Journals trade.settled
//     on 2xx, trade.failed otherwise (the cause named — S10).
//     If the mod has a `settlementToken`, the client sends it as `X-Village-Token` (main.ts reads it from
//     the EDEN_SETTLEMENT_TOKEN env var — a secret, so never eden.json).
//   • TradeService — orchestrates one trade: R33 walk-then-talk recovery (an out-of-range partner is
//     walked to FIRST — composing the go-to skill in production — before the offer is settled),
//     then propose (journal trade.proposed) → settle.
//   • TradeBook — the CONSENT layer the villager tools use (via the types/ TradeDesk seam): propose_trade
//     only records a pending offer and notifies the partner; nothing moves until the partner accepts with
//     answer_trade. Offers expire (default 5 min); only roster villagers can be parties, because the Java
//     listener cannot tell a bot from a human.
//
// social/ is LAYER 3 and may import skills/llm/render/journal/config/bots/types — never god/ or
// villagers/ (the social-no-peers rule). The R33 `reach` strategy (inRange/walkTo) is injected so the
// go-to-skill composition is wired at main.ts (engine.run('go-to', …)) and this module proves on fakes.
//
// The REAL :8767 integration (against the paulsbrawls mod) is a SMOKE-time concern — R29: stop
// ./gradlew runServer first (it steals 8767). CI proves proposed→settled + failed on FakeSettlement.

import { monotonicFactory } from 'ulid';

import type { IJournal } from '../journal/journal';
import type { PendingTrade, SettlementResult, TradeDesk, TradeItem, TradeOffer } from '../types/index';

export type { PendingTrade, SettlementResult, TradeOffer } from '../types/index';

const ulid = monotonicFactory();

/** The header the Java listener checks when its `settlementToken` is set (VillageHttpListener.TOKEN_HEADER). */
export const TOKEN_HEADER = 'X-Village-Token';

/** The `coin` alias → the mod's Gibber item id (04 §Trade: coin is the village currency for free). */
const COIN_ITEM = 'paulsbrawls:coin';

/**
 * The exact JSON body the Java listener parses (`VillageHttpListener.TradeRequest`): `botA` gives
 * `aGives` to `botB`, who gives `bGives` back. Field names are the wire contract — renaming one makes
 * every settlement a 400. Pinned by tests/social-trade.test.ts.
 */
export interface SettlementRequest {
  botA: string;
  botB: string;
  aGives: TradeItem[];
  bGives: TradeItem[];
}

/** Map a typed offer to the Java wire body: from→botA, to→botB, give→aGives, want→bGives; coin → paulsbrawls:coin. */
export function toSettlementRequest(offer: TradeOffer): SettlementRequest {
  return {
    botA: offer.from,
    botB: offer.to,
    aGives: offer.give.map(resolveItem),
    bGives: offer.want.map(resolveItem),
  };
}

/** Construction options for {@link SettlementClient}. */
export interface SettlementClientOptions {
  /** The mod's settlement endpoint (EdenConfig.settlement.url). */
  url: string;
  journal: IJournal;
  /** Injectable fetch for deterministic tests (R42); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** POST timeout in ms (R39 valve). Default 10 s. */
  timeoutMs?: number;
  /** The mod's `settlementToken`, sent as `X-Village-Token`. Omit/empty → no header (the mod's default). */
  token?: string;
}

/** POSTs a typed offer to the mod's atomic settlement endpoint; coin → paulsbrawls:coin. */
export class SettlementClient {
  private readonly url: string;
  private readonly journal: IJournal;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly token: string | undefined;

  constructor(opts: SettlementClientOptions) {
    this.url = opts.url;
    this.journal = opts.journal;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.token = opts.token ? opts.token : undefined;
  }

  /**
   * Settle `offer` via the mod. Journals trade.settled on a 2xx (atomic swap done), trade.failed
   * otherwise. NEVER throws into the flow — a network/HTTP error is a SettlementResult{ok:false}.
   */
  async settle(tradeId: string, offer: TradeOffer): Promise<SettlementResult> {
    const body = toSettlementRequest(offer);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.token ? { [TOKEN_HEADER]: this.token } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const reason = `settlement HTTP ${res.status}: ${text.slice(0, 160)}`;
        this.journalFailed(tradeId, offer, reason);
        return { ok: false, reason };
      }
      this.journal.append(`villager:${offer.from}`, 'trade.settled', {
        id: tradeId, from: offer.from, to: offer.to, give: offer.give, want: offer.want,
      }, { tradeId });
      return { ok: true };
    } catch (e) {
      const aborted = controller.signal.aborted;
      const reason = aborted
        ? `settlement timed out after ${this.timeoutMs}ms (to ${this.url})`
        : `settlement could not reach ${this.url}: ${e instanceof Error ? e.message : String(e)}`;
      this.journalFailed(tradeId, offer, reason);
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  private journalFailed(tradeId: string, offer: TradeOffer, reason: string): void {
    this.journal.append(`villager:${offer.from}`, 'trade.failed', { id: tradeId, from: offer.from, to: offer.to, reason }, { tradeId });
  }
}

/** R33 walk-then-talk strategy — injected so the go-to-skill composition wires at main.ts. */
export interface ReachStrategy {
  /** Is the partner within trading range right now? */
  inRange(): boolean;
  /** Walk to the partner (composes the go-to library skill in production) — recover IN the tool (R33). */
  walkTo(): Promise<void>;
}

/** Construction options for {@link TradeService}. */
export interface TradeServiceOptions {
  journal: IJournal;
  settlement: SettlementClient;
  /** R33: omit when range doesn't apply (the brain already stood next to the partner) — then no walk. */
  reach?: ReachStrategy;
}

/** Orchestrates one trade: R33 reach recovery → settle. TradeBook calls settleProposed once the partner accepts. */
export class TradeService {
  private readonly journal: IJournal;
  private readonly settlement: SettlementClient;
  private readonly reach?: ReachStrategy;

  constructor(opts: TradeServiceOptions) {
    this.journal = opts.journal;
    this.settlement = opts.settlement;
    if (opts.reach) this.reach = opts.reach;
  }

  /**
   * Put a typed offer on the table and settle it at once (no consent step — villagers go through
   * TradeBook instead). Journals trade.proposed, then settleProposed (R33 reach → settle).
   */
  async propose(offer: TradeOffer): Promise<SettlementResult> {
    const tradeId = ulid();
    this.journal.append(`villager:${offer.from}`, 'trade.proposed', {
      id: tradeId, from: offer.from, to: offer.to, give: offer.give, want: offer.want,
    }, { tradeId });
    return this.settleProposed(tradeId, offer);
  }

  /**
   * Settle an offer whose trade.proposed is ALREADY journaled (TradeBook journals it when the offer is put
   * on the table, then calls this on accept). R33: walk to the partner first if out of range; if still
   * unreachable, journal trade.failed without settling.
   */
  async settleProposed(tradeId: string, offer: TradeOffer): Promise<SettlementResult> {
    // R33 walk-then-talk: an out-of-range partner burns deliberations across LLM calls; recover here.
    if (this.reach && !this.reach.inRange()) {
      let walkError = '';
      try {
        await this.reach.walkTo();
      } catch (e) {
        walkError = ` (${e instanceof Error ? e.message : String(e)})`;
      }
      if (!this.reach.inRange()) {
        const reason = `partenaire "${offer.to}" hors de portée (impossible de l'atteindre${walkError}) — échange annulé (R33)`;
        this.journal.append(`villager:${offer.from}`, 'trade.failed', { id: tradeId, from: offer.from, to: offer.to, reason }, { tradeId });
        return { ok: false, reason };
      }
    }
    return this.settlement.settle(tradeId, offer);
  }
}

/** Java's caps (VillageHttpListener MAX_OFFER_LINES / MAX_STACK_COUNT) — checked here so a bad offer is
 *  refused with a readable reason at propose time, not as a 400 after the partner already said yes. */
const MAX_OFFER_LINES = 6;
const MAX_STACK_COUNT = 512;
/** Outstanding offers one villager may have on the table at once (keeps a looping brain from spamming). */
const MAX_PENDING_PER_PROPOSER = 3;

/** Construction options for {@link TradeBook}. */
export interface TradeBookOptions {
  journal: IJournal;
  settlement: SettlementClient;
  /** Only roster villagers may trade: the Java listener would swap ANY two online players, humans included. */
  isVillager: (name: string) => boolean;
  /** R33 per-trade reach (the accepting partner walks to the proposer). Omit/undefined → no walk. */
  reachFor?: (offer: TradeOffer) => ReachStrategy | undefined;
  /** Tell a villager about a new offer ('offer' — main.ts wakes the partner on the conversation lane) or
   *  about how one of its offers ended ('outcome' — main.ts records it as a trade memory, no LLM call). */
  notify?: (to: string, line: string, kind: 'offer' | 'outcome') => void;
  /** How long an offer stays acceptable. Default 5 min. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Pending offers + consent. Implements the types/ TradeDesk seam the villager tools are given. */
export class TradeBook implements TradeDesk {
  private readonly pending = new Map<string, PendingTrade>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: TradeBookOptions) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  propose(offer: TradeOffer): { ok: true; trade: PendingTrade } | { ok: false; reason: string } {
    this.sweep();
    const problem = this.validate(offer);
    if (problem) return { ok: false, reason: problem };
    const id = ulid();
    const trade: PendingTrade = { id, offer, expiresAt: this.now() + this.ttlMs };
    this.pending.set(id, trade);
    this.opts.journal.append(`villager:${offer.from}`, 'trade.proposed', {
      id, from: offer.from, to: offer.to, give: offer.give, want: offer.want,
    }, { tradeId: id });
    const until = new Date(trade.expiresAt).toISOString().slice(11, 16);
    this.opts.notify?.(
      offer.to,
      `${offer.from} te propose un échange (id ${id}) : il te donne ${fmt(offer.give)} contre ${fmt(offer.want)}. ` +
        `Réponds avec answer_trade { id: "${id}", accept: true } ou accept: false, avant ${until} UTC.`,
      'offer',
    );
    return { ok: true, trade };
  }

  async answer(id: string, by: string, accept: boolean): Promise<SettlementResult> {
    this.sweep();
    const trade = this.pending.get(id);
    if (!trade) return { ok: false, reason: `aucune offre "${id}" en attente (inconnue, expirée ou déjà réglée)` };
    const { offer } = trade;
    const isPartner = by === offer.to;
    const isProposer = by === offer.from;
    // The proposer may withdraw its own offer, but only the partner can accept it.
    if (!isPartner && !(isProposer && !accept)) {
      return { ok: false, reason: `seul ${offer.to} peut ${accept ? 'accepter' : 'refuser'} l'offre "${id}"` };
    }
    // Remove BEFORE settling, so a second accept of the same id cannot race the first into a double swap.
    this.pending.delete(id);

    if (!accept) {
      const reason = isPartner ? `refusée par ${by}` : `retirée par ${by}`;
      this.fail(trade, reason);
      if (isPartner) this.opts.notify?.(offer.from, `${by} a refusé ton offre d'échange ${id}.`, 'outcome');
      return { ok: true };
    }

    const reach = this.opts.reachFor?.(offer);
    const service = new TradeService({ journal: this.opts.journal, settlement: this.opts.settlement, ...(reach ? { reach } : {}) });
    const result = await service.settleProposed(id, offer);
    this.opts.notify?.(
      offer.from,
      result.ok
        ? `Échange ${id} conclu avec ${offer.to} : tu as donné ${fmt(offer.give)} et reçu ${fmt(offer.want)}.`
        : `Échange ${id} avec ${offer.to} accepté mais pas réglé : ${result.reason ?? 'raison inconnue'}. Rien n'a bougé.`,
      'outcome',
    );
    return result;
  }

  pendingFor(villager: string): PendingTrade[] {
    this.sweep();
    return [...this.pending.values()].filter((t) => t.offer.from === villager || t.offer.to === villager);
  }

  /** Expire stale offers (journaled as trade.failed so the ledger closes them). */
  private sweep(): void {
    const t = this.now();
    for (const [id, trade] of this.pending) {
      if (trade.expiresAt <= t) {
        this.pending.delete(id);
        this.fail(trade, `expirée sans réponse de ${trade.offer.to}`);
      }
    }
  }

  private fail(trade: PendingTrade, reason: string): void {
    const { offer } = trade;
    this.opts.journal.append(`villager:${offer.from}`, 'trade.failed', { id: trade.id, from: offer.from, to: offer.to, reason }, { tradeId: trade.id });
  }

  private validate(offer: TradeOffer): string | null {
    if (!this.opts.isVillager(offer.from)) return `"${offer.from}" n'est pas un villageois`;
    if (!this.opts.isVillager(offer.to)) return `"${offer.to}" n'est pas un villageois (on n'échange qu'entre villageois)`;
    if (offer.from.toLowerCase() === offer.to.toLowerCase()) return 'on ne peut pas échanger avec soi-même';
    if (!Array.isArray(offer.give) || !Array.isArray(offer.want)) return 'give et want doivent être des listes';
    if (offer.give.length === 0 && offer.want.length === 0) return 'rien à échanger';
    if (offer.give.length > MAX_OFFER_LINES || offer.want.length > MAX_OFFER_LINES) return `trop de lignes (max ${MAX_OFFER_LINES} par côté)`;
    for (const it of [...offer.give, ...offer.want]) {
      if (!it || typeof it.item !== 'string' || it.item.trim() === '') return 'chaque ligne requiert un "item"';
      if (!Number.isInteger(it.count) || it.count < 1 || it.count > MAX_STACK_COUNT) return `quantité invalide pour ${it.item} (1..${MAX_STACK_COUNT})`;
    }
    const open = [...this.pending.values()].filter((t) => t.offer.from === offer.from).length;
    if (open >= MAX_PENDING_PER_PROPOSER) return `déjà ${open} offres en attente (max ${MAX_PENDING_PER_PROPOSER}) — attends une réponse`;
    return null;
  }
}

/** "3 coin, 1 bread" — for notification lines. */
function fmt(items: TradeItem[]): string {
  return items.length === 0 ? 'rien' : items.map((i) => `${i.count} ${i.item}`).join(', ');
}

/** Resolve the `coin` alias to the mod's Gibber item id; pass other items through unchanged. */
function resolveItem(it: TradeItem): TradeItem {
  return it.item === 'coin' ? { item: COIN_ITEM, count: it.count } : it;
}
