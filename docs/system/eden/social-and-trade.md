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

**TL;DR.** `eden/src/social/` holds two engines: `Conversation` (bot↔bot alternating turns, hard cap 12 turns, 30 s per-turn deadline, game-chat mirror only when a player is in earshot and at most once per 4 s per speaker, structured leave → relation + memory) and `TradeService`/`SettlementClient` (typed offers, R33 walk-then-talk, POST to `settlement.url` default `http://127.0.0.1:8767/trade/execute`, `coin` → `paulsbrawls:coin`). Both are fully tested on fakes but **not reachable in production**: no villager tool starts a conversation or a trade, and `main.ts` constructs a `SettlementClient` only to discard it. The settlement body now matches the Java listener's contract (`{botA, botB, aGives, bGives}`, mapped by `toSettlementRequest`); it used to send `from/to/give/want`, which the listener rejected with HTTP 400 `missing botA` (bug #1, fixed — see "Contract" under *The Java side it targets* below).

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
interface TradeOffer { from: string; to: string; give: TradeItem[]; want: TradeItem[] } // :32
interface SettlementRequest { botA: string; botB: string; aGives: TradeItem[]; bGives: TradeItem[] } // :44 — the Java wire body
function toSettlementRequest(offer: TradeOffer): SettlementRequest                     // :52
interface SettlementResult { ok: boolean; reason?: string }                             // :62
interface ReachStrategy { inRange(): boolean; walkTo(): Promise<void> }                  // :136
```

### `TradeService.propose(offer)` (`:168-189`)
1. `tradeId = ulid()`.
2. R33 walk-then-talk (only if a `reach` strategy was injected): if `!inRange()`, `await walkTo()`; if still out of range → journal `trade.proposed` then `trade.failed {reason: 'partenaire "<to>" hors de portée (impossible de l\'atteindre) — échange annulé (R33)'}` and return `{ok:false}` without contacting settlement.
3. Journal `trade.proposed {id, from, to, give, want}` (actor `villager:<from>`, refs `{tradeId}`).
4. `settlement.settle(tradeId, offer)`.

### `SettlementClient.settle(tradeId, offer)` (`:97-128`)
| Aspect | Value |
|---|---|
| URL | `opts.url` = `config.settlement.url`, default `http://127.0.0.1:8767/trade/execute` (`eden/src/config.ts:127`) |
| Method / headers | `POST`, `content-type: application/json`, no auth |
| Body sent | `toSettlementRequest(offer)` (`:52-59`) = `{botA: from, botB: to, aGives: give, bGives: want}`, each `item === 'coin'` rewritten to `paulsbrawls:coin` (`resolveItem`, `:193-195`; `COIN_ITEM`, `:29`). The offer itself is not mutated. |
| Timeout | `10_000` ms via `AbortController` (`:90`, `:99-100`) |
| Retries | none |
| 2xx | journal `trade.settled {id, from, to, give, want}` (original, un-aliased items) → `{ok:true}` |
| non-2xx | journal `trade.failed {id, from, to, reason:"settlement HTTP <status>: <body ≤160 chars>"}` → `{ok:false, reason}` |
| network error | `reason: "settlement could not reach <url>: <msg>"` |
| timeout | `reason: "settlement timed out after <ms>ms (to <url>)"` |
| Throws? | never |

### The Java side it targets (`src/main/java/com/paul/brawl/VillageHttpListener.java`)
- Bound to `127.0.0.1:<VillageConfig.listenerPort>` (default `8767`, `VillageConfig.java:31`), context `/trade/execute` (`:94`), enabled by `VillageConfig.enabled` (default `true`, `VillageConfig.java:28`); no auth.
- Expected body (`TradeRequest`, `:63-68`): `{"botA": "...", "botB": "...", "aGives": [{"item","count"}], "bGives": [{"item","count"}]}`. Limits: body ≤ 64 KiB, ≤ 6 lines per side, count 1..512 (`:47-50`). Shape errors → HTTP 400 `{ok:false, error}`, e.g. `missing botA` (`:158`).
- Validation + swap run atomically on the server main thread; both players must be online and hold the items; overflow drops at the receiver's feet. Success → 200 `{"ok":true}`; failure → 400 `{"ok":false,"error":"…"}` (`:152`).
- Item resolution: no namespace → `minecraft:<n>`, falling back to `paulsbrawls:<n>` (`:225-233`) — so bare `coin` would already work; Eden's explicit `paulsbrawls:coin` also resolves.

> **Contract (bug #1, fixed).** Eden used to send `from/to/give/want`; Gson left the Java fields `null`, `validateShape` returned `missing botA`, and every settlement failed with `settlement HTTP 400: {"ok":false,"error":"missing botA"}`. The client now maps `from→botA, to→botB, give→aGives, want→bGives` (`toSettlementRequest`), with no Java change. Two guards keep it pinned:
> - `eden/tests/social-trade.test.ts` (`bug #1 (Java contract)` tests) `deepEqual`s the exact POST body against the Java field names and checks that only those four keys are sent.
> - `FakeSettlement` (`eden/tests/fakes/fake-settlement.ts`) now ports `VillageHttpListener.validateShape`: same checks, same order, same error strings (≤ 6 lines per side, count 1..512). It answers 400 `{ok:false, error}` like the mod, so every happy-path test fails if the body drifts again.
>
> Only the **shape** is proven in CI. Item resolution, online checks and the swap itself still need a live `:8767` smoke run (R29).

## Production wiring status

| Piece | State | Evidence |
|---|---|---|
| `SettlementClient` | body now matches the Java contract, but the client is constructed with `config.settlement.url` and immediately discarded (`void new …`) | `eden/src/main.ts:577` |
| `TradeService` | never constructed outside tests | grep: only `social/trade.ts` |
| `Conversation` | never constructed outside tests | grep: only `social/conversation.ts` |
| Villager social tools (`say`, `tell`, `start_conversation`, `leave_conversation`, trade) | **absent** — the registry has `search_skills, read_skill, write_skill, run_skill, report_to_god, done, remember, recall, subscribe, unsubscribe, list_subscriptions` | `eden/src/villagers/tools.ts:82-154` |
| Admin "tell" | `POST /villagers/:name/prompt` (`eden/src/admin/server.ts:248`) delivers `{from:'villager', kind:'tell', payload:{text, from}}` to a villager inbox — not a conversation | `eden/src/main.ts:393-402` |

Consequently no `conversation.*`, `chat.*` or `trade.*` events are produced by a live Eden host at this commit. Fixing the body shape (bug #1) made settlement *callable*; it is still not *called*.

## Views fed by social events (`eden/src/views/index.ts`)

Both are folded live from the journal stream (`eden/src/main.ts:165-178`) and by `npm run rebuild-stats`.

| View | Folds | Value shape | Notes |
|---|---|---|---|
| `RelationsView` (`:114`) | `conversation.started` (records pair), `conversation.ended` with `opinion` | `{[villager]: {[other]: {score, note, at}}}` — `score += opinion`, `note = headline` | **Unclamped** sum, unlike `VillagerMemory` (±100); not exposed by any admin route — the admin villager summary reads `memory.relations()` instead (`eden/src/main.ts:763`) |
| `TradeLedgerView` (`:167`) | `trade.proposed` → `proposed`; `trade.settled` → `settled`; `trade.failed` → `failed` + `reason` | `TradeLedgerEntry[] {id, from, to, give, want, status, reason?, at}` sorted by `at` | Not exposed by any admin route at this commit |

Journal payload types: `eden/src/journal/kinds.ts:176-202` (`chat.said`, `chat.heard`, `conversation.started/turn/ended`, `trade.proposed/settled/failed`).

## How to extend (wiring the layer for real)

1. Add villager tools in `eden/src/villagers/tools.ts` (e.g. `start_conversation`, `propose_trade`) — but `villagers/` may not import `social/`; the construction must happen in `main.ts` and be injected (as with `memoryFor`).
2. In `main.ts`, keep the `SettlementClient` instance, build `Conversant`s from `VillagerMemory` + a bot-backed `sayInGame`/`playerInEarshot`, and a `ReachStrategy` that runs the `go-to` skill via `SkillEngine`.
3. ~~Fix the body mapping to the Java contract~~ — done (`toSettlementRequest`). Before trusting it in production, run one live `:8767` smoke trade (two online villagers, a `coin` line).
4. Expose `views.tradeLedger` / `views.relations` through admin accessors if the website needs them.

## Gotchas & known issues

- ~~Settlement JSON field names mismatch the Java listener~~ — fixed. The body is `{botA, botB, aGives, bGives}`, pinned by tests and by a fake that runs the Java shape check. Java-side bug #2 (duplicate item lines are each validated against the whole inventory) still applies to whatever Eden sends.
- Social engines are dead code in production (no tools, discarded client).
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
