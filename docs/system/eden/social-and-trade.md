---
id: eden.social-and-trade
title: Eden social layer — bot conversations, typed-offer trade and settlement
system: eden
summary: Eden's Conversation engine (turn cap, deadline, chat mirror gate), TradeService/SettlementClient contract with the Java :8767 listener, and the relation/trade views they feed.
tags: [eden, social, conversation, chat, mirror, earshot, relations, trade, settlement, 8767, coin, paulsbrawls:coin, gibber, TradeLedgerView, RelationsView]
sources: [eden/src/social/conversation.ts, eden/src/social/trade.ts, eden/tests/fakes/fake-settlement.ts, eden/src/types/social.ts, eden/src/types/memory.ts, eden/src/villagers/memory.ts, eden/src/villagers/tools.ts, eden/src/views/index.ts, eden/src/journal/kinds.ts, eden/src/main.ts, eden/src/config.ts, eden/src/admin/server.ts, src/main/java/com/paul/brawl/VillageHttpListener.java, src/main/java/com/paul/brawl/VillageConfig.java, eden/tests/social-conversation.test.ts, eden/tests/social-trade.test.ts]
verified_at: 4a8081f
---

# Eden social layer — conversations, trade, settlement

**TL;DR.** `eden/src/social/` holds two engines: `Conversation` (bot↔bot alternating turns, hard cap 12 turns, 30 s per-turn deadline, game-chat mirror only when a player is in earshot and at most once per 4 s per speaker, structured leave → relation + memory) and trade. **Trade is wired**: villagers get three tools — `propose_trade`, `answer_trade`, `list_trades` — backed by a `TradeBook` that adds consent (an offer moves nothing until the *partner* accepts; offers expire after 5 min; only roster villagers can be parties). An accept runs `TradeService` (R33 walk-then-talk via the `go-to` skill) then `SettlementClient` POSTs `{botA, botB, aGives, bGives}` to `settlement.url` (default `http://127.0.0.1:8767/trade/execute`, `coin` → `paulsbrawls:coin`, `X-Village-Token` from `EDEN_SETTLEMENT_TOKEN` when set). **Conversations are wired too (D-18):** `say`, `tell` and `start_conversation` reach a `ConversationBook` through the `types/` `ConversationDesk` seam; a conversation runs in the background with fast-tier turns (`villagers/conversation-turn.ts`).

## Layering

`social/` is layer 3: it may import `skills/llm/render/journal/config/bots/types` but never `god/` or `villagers/` (`eden/src/social/conversation.ts:6-9`, `eden/src/social/trade.ts:12-14`). It reaches a villager through the layer-0 seams in `eden/src/types/social.ts`:

```ts
interface TradeItem { item: string; count: number }                         // :14
interface MemorySeed { kind: MemoryEntry['kind']; text: string; tags?: string[]; importance?: number } // :20
interface MemoryWriter {                                                      // :33
  readonly villager: string;
  remember(seed: MemorySeed): void;
  moveRelation(other: string, delta: number, note: string): Relation;
}
interface Conversant {                                                        // :48
  readonly name: string; readonly memory: MemoryWriter;
  sayInGame(line: string): void;       // game-chat sink (mirror target)
  playerInEarshot(): boolean;          // the mirror gate
}
```
`VillagerMemory` implements `MemoryWriter` (`eden/src/villagers/memory.ts:91`); `moveRelation` clamps the score to ±`RELATION_SCORE_BAND` = 100 (`eden/src/villagers/memory.ts:53`, `eden/src/villagers/memory.ts:144-155`) and persists the bot's JSON.

## Conversation (`eden/src/social/conversation.ts`)

### Construction (`ConversationOptions`, `:48-63`)
| Option | Default | Line |
|---|---|---|
| `journal` | required | |
| `initiator`, `partner` | `{conversant: Conversant, speak: SpeakFn}` | `:39-42` |
| `eavesdroppers` | `[]` (`MemoryWriter[]`) | |
| `maxTurns` | `12` | `:65` |
| `turnDeadlineMs` | `30_000` | `:66` |
| `mirrorMinIntervalMs` | `4_000` | `:67` |
| `topic` | — | recorded on `conversation.started` |

`SpeakFn = () => Promise<{say: string} | {leave: {opinion: number; note: string; headline: string}}>` (`:23-36`). The engine needs no LLM; production would supply a brain turn.

### `run()` lifecycle (`:107-161`)
1. Journal `conversation.started {id, initiator, partner, topic?}`, refs `{conversationId}`, actor `villager:<initiator>`.
2. For `turn = 1..maxTurns`, the current speaker's `speak()` is raced against the deadline (`withDeadline`, `:204-213`, unref'd timer):
   - throws/times out → `reason='deadline'`, ended by the speaker.
   - `{leave}` → `applyLeave` then `reason='left'`.
   - `{say}` → journal `conversation.turn {id, speaker, turn}` then `say(...)`; the floor passes to the other party.
   - after the last allowed `say`, `reason='turn-cap'`, ended by the would-be next speaker.
3. Journal exactly one `conversation.ended {id, by, reason, opinion?, headline?}` (opinion/headline only for `left`) and return `reason`.

`EndReason = 'left' | 'turn-cap' | 'deadline' | 'partner-gone'` (`:45`) — `partner-gone` is declared (and in the journal kind) but **never produced**.

### `say(speaker, listener, text)` (`:164-181`)
1. Journal `chat.said {from, to, text}` (actor speaker).
2. Listener hears: `chat.heard {hearer, from, text, eavesdrop:false}` + `remember({kind:'social', text:"<from> m'a dit: « text »", importance:3})`.
3. Each eavesdropper: `chat.heard {…, eavesdrop:true}` + `remember({kind:'social', text:"Entendu <from> dire: « text »", importance:3})` (`OVERHEARD_IMPORTANCE`, `:71`).
4. **Mirror gate**: `sayInGame(text)` only if `speaker.conversant.playerInEarshot()` **and** at least `mirrorMinIntervalMs` since that speaker's last mirrored line in this conversation (`canMirror`, `:216-220`). Lines that fail the rate limit are dropped from game chat (still journaled).

### Leave (`applyLeave`, `:195-201`)
- Leaver: `memory.moveRelation(partner, opinion, note)` (only the leaver's relation moves).
- Both parties: `remember({kind:'social', text: headline, importance: 8})` (`HEADLINE_IMPORTANCE`, `:69`).

## Trade (`eden/src/social/trade.ts`)

### Types
```ts
// eden/src/types/social.ts (layer 0, so villagers/tools.ts can reach trade without importing social/)
interface TradeOffer { from: string; to: string; give: TradeItem[]; want: TradeItem[] }
interface SettlementResult { ok: boolean; reason?: string }
interface PendingTrade { id: string; offer: TradeOffer; expiresAt: number }
interface TradeDesk {                       // the seam the villager tools get; TradeBook implements it
  propose(offer): {ok:true, trade: PendingTrade} | {ok:false, reason: string};
  answer(id, by, accept): Promise<SettlementResult>;
  pendingFor(villager): PendingTrade[];
}
// eden/src/social/trade.ts (re-exports TradeOffer / SettlementResult / PendingTrade)
interface SettlementRequest { botA: string; botB: string; aGives: TradeItem[]; bGives: TradeItem[] } // :47 — the Java wire body
function toSettlementRequest(offer: TradeOffer): SettlementRequest                     // :55
interface ReachStrategy { inRange(): boolean; walkTo(): Promise<void> }
const TOKEN_HEADER = 'X-Village-Token'                                                  // :37
```

### `TradeBook` — consent (`:224-324`)
| Method | Behaviour |
|---|---|
| `propose(offer)` (`:234`) | Expire stale offers, then validate (`:309-323`): both parties are roster villagers (`isVillager` — a human would otherwise be swappable, the Java listener can't tell), not the same name (case-insensitive), ≤ 6 lines per side, not both empty, each `item` non-blank, each `count` an integer 1..512 (the Java caps, so a bad offer fails *before* the partner says yes), and the proposer has < 3 offers open. On success: store it with `expiresAt = now + ttlMs` (default 5 min), journal `trade.proposed`, `notify(to, "<from> te propose un échange (id …) …", 'offer')`. Nothing is POSTed. |
| `answer(id, by, accept)` (`:254`) | Unknown/expired id → `{ok:false}`. Only the partner (`to`) may accept; the partner may decline; the proposer may withdraw (`accept:false`). Anyone else, or the proposer accepting, → `{ok:false, reason:"seul <to> peut …"}` and the offer stays open. The offer is removed **before** settling, so two concurrent accepts settle once. Decline/withdraw → `trade.failed {reason:"refusée par <to>" / "retirée par <from>"}` and `{ok:true}`. Accept → `new TradeService({reach: reachFor(offer)}).settleProposed(id, offer)`, then `notify(from, <outcome>, 'outcome')`. |
| `pendingFor(villager)` | Live offers the villager made or received. |
| expiry (`sweep`, `:294`) | Lazy, on every call: an expired offer is dropped and journaled `trade.failed {reason:"expirée sans réponse de <to>"}`. Offers live in RAM only; at boot `main.ts` calls `closeOrphans()`, which journals `trade.failed {reason:"hôte redémarré"}` for every `trade.proposed` with no `trade.settled`/`trade.failed` (B4), so the ledger never shows a dead offer as pending. |

### Villager tools (`eden/src/villagers/tools.ts`)
- `propose_trade {to, give:[{item,count}], want:[…]}` — proposes **as the acting villager** (`from = ctx.villager`, never an argument).
- `answer_trade {id, accept:boolean}` — an accepted trade that fails to settle is reported with its cause ("rien n'a bougé").
- `list_trades {}` — the villager's open offers with their expiry.
- Without a wired desk the three return honest `(échange non câblé…)` stubs.

### Wiring (`eden/src/main.ts:552-593`)
- `SettlementClient({url: config.settlement.url, journal, token: process.env.EDEN_SETTLEMENT_TOKEN})` (`:556`).
- `isVillager` = the `config.villagers` names.
- `reachFor` (live pool only): `inRange` = both bots' positions within `TRADE_REACH = 8` blocks (the mod refuses beyond its `maxTradeDistance`, default 16); `walkTo` = `engine.run('go-to', {x,y,z of the proposer, range: 3}, <partner, mortal>)`. Throws if the proposer is offline → the trade fails with that cause.
- `notify`: always delivers an inbox `tell` `{text}`; an `'offer'` also wakes the partner on the `conversation` lane (`wakeForTrade`, `:708` — live pool only) with the hint "réponds à l'offre d'échange avec answer_trade"; an `'outcome'` is written to the proposer's memory as a `trade` entry instead (no LLM call).

### `TradeService` (`:151-197`)
- `propose(offer)` — `tradeId = ulid()`, journal `trade.proposed {id, from, to, give, want}` (actor `villager:<from>`, refs `{tradeId}`), then `settleProposed`. Settles immediately with no consent step; villagers go through `TradeBook` instead.
- `settleProposed(tradeId, offer)` (`:180`) — R33 walk-then-talk (only if a `reach` strategy was injected): if `!inRange()`, `await walkTo()` (a throw is caught and named in the reason); if still out of range → `trade.failed {reason: 'partenaire "<to>" hors de portée (impossible de l\'atteindre[ (<error>)]) — échange annulé (R33)'}` and `{ok:false}` without contacting settlement. Otherwise `settlement.settle(tradeId, offer)`.

### `SettlementClient.settle(tradeId, offer)` (`:97-129`)
| Aspect | Value |
|---|---|
| URL | `opts.url` = `config.settlement.url`, default `http://127.0.0.1:8767/trade/execute` (`eden/src/config.ts:127`) |
| Method / headers | `POST`, `content-type: application/json`; plus `X-Village-Token: <token>` when `opts.token` is non-empty (`:104`) — main.ts passes `process.env.EDEN_SETTLEMENT_TOKEN` |
| Body sent | `toSettlementRequest(offer)` (`:55-62`) = `{botA: from, botB: to, aGives: give, bGives: want}`, each `item === 'coin'` rewritten to `paulsbrawls:coin` (`resolveItem`, `:332-334`; `COIN_ITEM`, `:40`). The offer itself is not mutated. |
| Timeout | `10_000` ms via `AbortController` (`:100`) |
| Retries | none |
| 2xx | journal `trade.settled {id, from, to, give, want}` (original, un-aliased items) → `{ok:true}` |
| non-2xx | journal `trade.failed {id, from, to, reason:"settlement HTTP <status>: <body ≤160 chars>"}` → `{ok:false, reason}` |
| network error | `reason: "settlement could not reach <url>: <msg>"` |
| timeout | `reason: "settlement timed out after <ms>ms (to <url>)"` |
| Throws? | never |

### The Java side it targets (`src/main/java/com/paul/brawl/VillageHttpListener.java`)
- Bound to `127.0.0.1:<VillageConfig.listenerPort>` (default `8767`, `VillageConfig.java:31`), context `/trade/execute` (`:107`), enabled by `VillageConfig.enabled` (default `true`, `VillageConfig.java:28`); auth only if `VillageConfig.settlementToken` is set (`X-Village-Token` header — Eden sends it when `EDEN_SETTLEMENT_TOKEN` holds the same value).
- Expected body (`TradeRequest`, `:76-81`): `{"botA": "...", "botB": "...", "aGives": [{"item","count"}], "bGives": [{"item","count"}]}`. Limits: body ≤ 64 KiB, ≤ 6 lines per side, count 1..512 per line (`:60-62`). Shape errors → HTTP 400 `{ok:false, error}`, e.g. `missing botA` (`:178`).
- Validation + swap run atomically in one main-thread task: both players must be online, in the same dimension and within `maxTradeDistance` (16 blocks); lines are summed per item and each total must be held in the giver's 36 main/hotbar slots; the real stacks move (components kept) and overflow drops at the receiver's feet. Success → 200 `{"ok":true}`; failure → 400 `{"ok":false,"error":"…"}` (`:172`). Details: [java-integration.md](java-integration.md).
- Item resolution: no namespace → `minecraft:<n>`, falling back to `paulsbrawls:<n>` (`:271-282`) — so bare `coin` would already work; Eden's explicit `paulsbrawls:coin` also resolves.

> **Contract (bug #1, fixed).** Eden used to send `from/to/give/want`; Gson left the Java fields `null`, `validateShape` returned `missing botA`, and every settlement failed with `settlement HTTP 400: {"ok":false,"error":"missing botA"}`. The client now maps `from→botA, to→botB, give→aGives, want→bGives` (`toSettlementRequest`), with no Java change. Two guards keep it pinned:
> - `eden/tests/social-trade.test.ts` (`bug #1 (Java contract)` tests) `deepEqual`s the exact POST body against the Java field names and checks that only those four keys are sent.
> - `FakeSettlement` (`eden/tests/fakes/fake-settlement.ts`) now ports `VillageHttpListener.validateShape`: same checks (incl. the case-insensitive `botA`/`botB` comparison), same order, same error strings (≤ 6 lines per side, count 1..512). It answers 400 `{ok:false, error}` like the mod, so every happy-path test fails if the body drifts again.
>
> Only the **shape** (and the token header) is proven in CI. Item resolution, online/distance checks and the swap itself still need a live `:8767` smoke run (R29).

## Production wiring status

| Piece | State | Evidence |
|---|---|---|
| `SettlementClient` | **wired** — one instance, token from `EDEN_SETTLEMENT_TOKEN` | `eden/src/main.ts:556` |
| `TradeBook` / `TradeService` | **wired** — the book is injected into `ToolRegistry` as `trade`; a `TradeService` is built per accepted offer with that offer's `ReachStrategy` | `eden/src/main.ts:581-593` |
| Trade tools | `propose_trade`, `answer_trade`, `list_trades` | `eden/src/villagers/tools.ts:162-176`, `:367-406` |
| `ConversationBook` | **wired** — injected into `ToolRegistry` as `conversations`; conversants come from the live pool (offline = refused), memories from `VillagerMemory`, turns from `ConversationTurner` | `eden/src/main.ts` (`wireGod`) |
| Speech tools | `say {text}`, `tell {to, text}`, `start_conversation {with, topic}`; `leave_conversation` is the turn's `{"leave"}` reply | `eden/src/villagers/tools.ts` |
| Admin "tell" | `POST /villagers/:name/prompt` delivers `{from:'villager', kind:'tell', payload:{text, from}}` to a villager inbox — it raises the `inbox` event (D-17), not a conversation | `eden/src/main.ts` `onPrompt` |

A live host produces `trade.*`, `chat.said`/`chat.heard` and `conversation.*` events. Negotiation still happens through
the offer itself (propose → accept/decline, or a new counter-offer), not inside a conversation (D-18).

### `ConversationBook` (D-18)

| Method | Refusals (French, read by the villager) | Effect |
|---|---|---|
| `say(v, text)` | empty; `<v> n'est pas connecté`; `tu viens de parler — attends un peu` (< 4 s) | journal `chat.said {from:v, to:'*', text}`; `sayInGame(text)` (a leading `/` stripped — villagers are op'd) |
| `tell(from, to, text)` | empty; to self; `<to> n'est pas un villageois` | journal `chat.said {from, to, text}`; `deliverTell` → inbox `tell` `{text, from}` as actor `villager:<from>` (raises D-17 `inbox`) |
| `start(a, b, topic)` | self; not a villager; either side already talking; `trop de conversations en cours (max 2)`; either offline; `trop loin` (> 16 blocks) | a `Conversation` (8 turns, 60 s/turn) with `speakerFor` turns and nearby villagers as eavesdroppers; runs detached; both sides are freed when it ends; a throw journals `system.error` |

Every spoken line is trimmed to one line of ≤ 280 characters. Each `Conversation` turn now receives the transcript so
far (`SpeakFn(transcript)`, types moved to `types/social.ts`).

## Views fed by social events (`eden/src/views/index.ts`)

Both are folded live from the journal stream (`eden/src/main.ts:165-178`) and by `npm run rebuild-stats`.

| View | Folds | Value shape | Notes |
|---|---|---|---|
| `RelationsView` (`:114`) | `conversation.started` (records pair), `conversation.ended` with `opinion` | `{[villager]: {[other]: {score, note, at}}}` — `score += opinion`, `note = headline` | **Unclamped** sum, unlike `VillagerMemory` (±100); not exposed by any admin route — the admin villager summary reads `memory.relations()` instead (`eden/src/main.ts:763`) |
| `TradeLedgerView` (`:167`) | `trade.proposed` → `proposed`; `trade.settled` → `settled`; `trade.failed` → `failed` + `reason` | `TradeLedgerEntry[] {id, from, to, give, want, status, reason?, at}` sorted by `at` | Not exposed by any admin route at this commit |

Journal payload types: `eden/src/journal/kinds.ts:176-202` (`chat.said`, `chat.heard`, `conversation.started/turn/ended`, `trade.proposed/settled/failed`).

## How to extend (wiring the layer for real)

1. ~~Trade tools + `SettlementClient`/`TradeService` wiring~~ — done (`TradeBook` behind the `types/` `TradeDesk` seam, as with `memoryFor`). Before trusting it in production, run one live `:8767` smoke trade (two online villagers, a `coin` line).
2. ~~Conversations~~ — done (D-18, `ConversationBook` behind `ConversationDesk`). Before trusting it, run one live
   conversation between two online villagers (only a live run proves the mirror gate and the turn latency).
3. ~~Fix the body mapping to the Java contract~~ — done (`toSettlementRequest`).
4. Expose `views.tradeLedger` / `views.relations` through admin accessors if the website needs them.

## Gotchas & known issues

- ~~Settlement JSON field names mismatch the Java listener~~ — fixed. The body is `{botA, botB, aGives, bGives}`, pinned by tests and by a fake that runs the Java shape check. Java-side bug #2 (duplicate item lines each validated against the whole inventory) is fixed too: the listener sums lines per item before validating — see [java-integration.md](java-integration.md).
- ~~`Conversation` is dead code in production~~ — wired (D-18). Trade is live.
- ~~Pending offers are RAM-only: a host restart leaves `trade.proposed` with no close event~~ **Fixed (B4):** the offers stay RAM-only, but `TradeBook.closeOrphans()` closes each orphan at boot as `trade.failed {reason:"hôte redémarré"}`. A villager whose offer was closed this way is not told.
- If the mod has a `settlementToken` but `EDEN_SETTLEMENT_TOKEN` is unset or different, every accepted trade fails with `settlement HTTP 401`.
- `TRADE_REACH` (8) is a constant, not read from the mod: if the mod's `maxTradeDistance` is lowered below 8, an "in range" pair can still be refused.
- `partner-gone` end reason is declared but never emitted.
- A `deadline` end leaves the speaker's `speak()` promise running (not cancelled).
- Mirror rate-limit state is per `Conversation` instance, so two concurrent conversations can each mirror the same speaker.
- `RelationsView` (unclamped, journal-derived) and `VillagerMemory` relations (clamped ±100, JSON-persisted) can diverge; only the leaver's relation moves.
- `trade.settled` journals the original (`coin`) items and the offer's `from/to/give/want` names, not the resolved `paulsbrawls:coin` / `botA…bGives` wire body actually sent.
- Port 8767 is shared with `./gradlew runServer`'s dev server (R29 per comments, `eden/src/social/trade.ts:16-17`): whichever JVM binds first wins.

## Related

- [java-integration.md](java-integration.md) — the Java `:8767` settlement listener, `/village`, `VillageConfig`
- [villager-memory.md](villager-memory.md) — `VillagerMemory`, relations, `remember`
- [villager-runtime.md](villager-runtime.md) — tool registry, inbox
- [journal-and-views.md](journal-and-views.md) — `RelationsView`, `TradeLedgerView`, rebuild-stats
- [god.md](god.md)
- [../gibber/money-system.md](../gibber/money-system.md) — the `coin` item
