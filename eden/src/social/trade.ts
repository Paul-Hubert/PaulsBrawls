// Trade (layer 3, social/) — typed offer objects negotiated inside a conversation, settled via the Java
// mod (04 §Trade). Two pieces:
//   • SettlementClient — POSTs a typed offer to {settlement.url} (default 127.0.0.1:8767/trade/execute,
//     the mod's VillageHttpListener). `coin` resolves to `paulsbrawls:coin` so Gibber is the village
//     currency for free. The mod re-validates + swaps inventories ATOMICALLY on the main thread — so a
//     non-2xx (or a network error) means NOTHING swapped (inventories untouched). Journals trade.settled
//     on 2xx, trade.failed otherwise (the cause named — S10).
//   • TradeService — orchestrates one trade: R33 walk-then-talk recovery (an out-of-range partner is
//     walked to FIRST — composing the go-to skill in production — before the offer is put + settled),
//     then propose (journal trade.proposed) → settle.
//
// social/ is LAYER 3 and may import skills/llm/render/journal/config/bots/types — never god/ or
// villagers/ (the social-no-peers rule). The R33 `reach` strategy (inRange/walkTo) is injected so the
// go-to-skill composition is wired at main.ts (engine.run('go-to', …)) and this module proves on fakes.
//
// The REAL :8767 integration (against the paulsbrawls mod) is a SMOKE-time concern — R29: stop
// ./gradlew runServer first (it steals 8767). CI proves proposed→settled + failed on FakeSettlement.

import { monotonicFactory } from 'ulid';

import type { IJournal } from '../journal/journal';
import type { TradeItem } from '../types/index';

const ulid = monotonicFactory();

/** The `coin` alias → the mod's Gibber item id (04 §Trade: coin is the village currency for free). */
const COIN_ITEM = 'paulsbrawls:coin';

/** A typed two-sided offer: `from` gives `give`, wants `want` from `to`. Never free text (re-validatable). */
export interface TradeOffer {
  from: string;
  to: string;
  give: TradeItem[];
  want: TradeItem[];
}

/** The settlement outcome — ok on a 2xx swap, else a named failure (the inventories are untouched). */
export interface SettlementResult {
  ok: boolean;
  /** The cause when !ok (HTTP status / network error / re-validation reject) — S10. */
  reason?: string;
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
}

/** POSTs a typed offer to the mod's atomic settlement endpoint; coin → paulsbrawls:coin. */
export class SettlementClient {
  private readonly url: string;
  private readonly journal: IJournal;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: SettlementClientOptions) {
    this.url = opts.url;
    this.journal = opts.journal;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /**
   * Settle `offer` via the mod. Journals trade.settled on a 2xx (atomic swap done), trade.failed
   * otherwise. NEVER throws into the flow — a network/HTTP error is a SettlementResult{ok:false}.
   */
  async settle(tradeId: string, offer: TradeOffer): Promise<SettlementResult> {
    const body = {
      from: offer.from,
      to: offer.to,
      give: offer.give.map(resolveItem),
      want: offer.want.map(resolveItem),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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

/** Orchestrates one trade: R33 reach recovery → propose → settle. The brain calls this from a tool. */
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
   * Put a typed offer on the table and settle it. R33: if a `reach` strategy says the partner is out of
   * range, walk to them FIRST (recover-in-tool) before proposing; if still unreachable, fail without
   * settling. Journals trade.proposed (always) then trade.settled / trade.failed (via the client).
   */
  async propose(offer: TradeOffer): Promise<SettlementResult> {
    const tradeId = ulid();

    // R33 walk-then-talk: an out-of-range partner burns deliberations across LLM calls; recover here.
    if (this.reach && !this.reach.inRange()) {
      await this.reach.walkTo();
      if (!this.reach.inRange()) {
        const reason = `partenaire "${offer.to}" hors de portée (impossible de l'atteindre) — échange annulé (R33)`;
        this.journal.append(`villager:${offer.from}`, 'trade.proposed', {
          id: tradeId, from: offer.from, to: offer.to, give: offer.give, want: offer.want,
        }, { tradeId });
        this.journal.append(`villager:${offer.from}`, 'trade.failed', { id: tradeId, from: offer.from, to: offer.to, reason }, { tradeId });
        return { ok: false, reason };
      }
    }

    this.journal.append(`villager:${offer.from}`, 'trade.proposed', {
      id: tradeId, from: offer.from, to: offer.to, give: offer.give, want: offer.want,
    }, { tradeId });

    return this.settlement.settle(tradeId, offer);
  }
}

/** Resolve the `coin` alias to the mod's Gibber item id; pass other items through unchanged. */
function resolveItem(it: TradeItem): TradeItem {
  return it.item === 'coin' ? { item: COIN_ITEM, count: it.count } : it;
}
