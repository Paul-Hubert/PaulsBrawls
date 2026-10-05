---
id: eden.types-and-contracts
title: Eden shared types (layer 0) and the dependency law
system: eden
summary: Every exported type/interface/enum in eden/src/types/, the Inbox and Social seams that decouple layer-3 actors, and the dependency law exactly as .dependency-cruiser.cjs enforces it.
tags: [eden, types, contracts, interfaces, enums, Bot, RunReport, Task, Verdict, EdenEvent, Subscription, Inbox, MemoryWriter, Conversant, TradeDesk, ConversationDesk, dependency-cruiser, layers, dependency-law]
sources: [eden/src/types/index.ts, eden/src/types/enums.ts, eden/src/types/bot.ts, eden/src/types/skill.ts, eden/src/types/task.ts, eden/src/types/events.ts, eden/src/types/journal.ts, eden/src/types/inbox.ts, eden/src/types/memory.ts, eden/src/types/social.ts, eden/.dependency-cruiser.cjs, eden/package.json, eden/src/main.ts, eden/src/villagers/inbox.ts, eden/src/villagers/memory.ts, eden/src/social/conversation.ts, eden/src/social/trade.ts, eden/src/villagers/tools.ts, eden/src/villagers/conversation-turn.ts, eden/src/god/god.ts, eden/src/god/orchestrator.ts, eden/src/journal/kinds.ts, eden/tests/types.test.ts, CLAUDE.md, eden/CLAUDE.md, docs/11-class-model.md]
verified_at: 98cb908
---

# Eden shared types (layer 0) and the dependency law

**TL;DR.** `eden/src/types/` is layer 0: pure interfaces, unions and four `as const` enum arrays, re-exported by the
barrel `types/index.ts`, importing nothing outside `types/`. It defines the cross-module contracts — the narrowed
mineflayer `Bot` seam, skills/RunReport, God's task/verdict/directive model, the closed `EdenEvent` union and
subscriptions, journal rows, and the decoupling seams (`Inbox` for God→villager; `MemoryWriter`/`Conversant`/`SpeakFn`
for social→villager; `TradeDesk`/`ConversationDesk` for villager→social). The dependency law is enforced by 13 `forbidden` rules in `eden/.dependency-cruiser.cjs`, run by
`npm run depcruise` inside `npm run check`.

## File map

| File | Exports |
|---|---|
| `types/index.ts` | barrel: `export *` from enums, bot, skill, task, events, journal, inbox, memory, social (`eden/src/types/index.ts:4-12`) |
| `types/enums.ts` | `TIERS`/`Tier`, `SKILL_STATUSES`/`SkillStatus`, `ABORT_CAUSES`/`AbortCause`, `PRIORITIES`/`Priority` |
| `types/bot.ts` | `Vec3Like`, `BotItem`, `BotBlock`, `BotWindow`, `PathfinderLike`, `PvpLike`, `CollectBlockLike`, `AutoEatLike`, `ArmorManagerLike`, `ItemRegistry`, `BotContainer`, `EmitterLike`, `Bot` |
| `types/skill.ts` | `JsonSchema`, `Author`, `Provenance`, `SkillManifest`, `SkillVersion`, `SkillStats`, `Snapshot`, `CallFrame`, `RunOutcome`, `RunReport`, `RunnerRef` |
| `types/task.ts` | `ItemCheck`, `Task`, `TaskRecord`, `TaskLedger`, `DirectiveSuggestion`, `TaskSuggestion`, `Directive`, `CriticTicket`, `Verdict`, `Rollout`, `VerdictRef`, `Competence`, `Dossier` |
| `types/events.ts` | `EdenEvent`, `EventType`, `Envelope`, `Filter`, `ArgTemplate`, `SkillHandler`, `DeliberateHandler`, `SubscriptionHandler`, `Subscription` |
| `types/journal.ts` | `Refs`, `JournalEvent`, `JournalQuery` |
| `types/inbox.ts` | `InboxMessage`, `Inbox` |
| `types/memory.ts` | `MemoryEntry`, `Relation` |
| `types/social.ts` | `TradeItem`, `MemorySeed`, `MemoryWriter`, `Conversant`, `TradeOffer`, `SettlementResult`, `PendingTrade`, `TradeDesk`, `LeaveDecision`, `SpeakResult`, `TranscriptLine`, `SpeakFn`, `ConversationDesk` |

Some modules import `types/bot` directly rather than the barrel (`eden/src/bots/signals.ts:24`, `eden/src/villagers/events.ts:20`,
`eden/src/villagers/reactivity.ts:17`).

## Enums (`types/enums.ts`)

Each is an `as const` array (runtime-visible) plus the derived union.

| Array | Members | Meaning |
|---|---|---|
| `TIERS` | `mortal`, `divine` | runner tier; `divine` = the God avatar only (`eden/src/types/enums.ts:5`) |
| `SKILL_STATUSES` | `draft`, `active-probation`, `active`, `quarantined`, `archived` | D-12 lifecycle; `active-probation` = runnable + retrievable, not yet composable (`:12-18`) |
| `ABORT_CAUSES` | `preempted`, `stalled`, `timeout` | why a run aborted (`:22`) |
| `PRIORITIES` | `background`, `normal`, `interrupt` | directive/handler priority, low→high (`:26`) |

Pinned by `eden/tests/types.test.ts:24-41`.

## The Bot seam (`types/bot.ts`, D-14)

A **narrowed** mineflayer surface that both the real bot (structurally, cast once through `unknown` in the pool) and
the test `FakeBot` satisfy. No `any`; listener args are `unknown[]`.

| Type | Key fields | Purpose |
|---|---|---|
| `Vec3Like` | `x, y, z` | any position (mineflayer `Vec3` satisfies it) |
| `BotItem` | `name, count, slot?` | inventory item |
| `BotBlock` | `name, position` | world block |
| `BotWindow` | `id, type?, title?` | open window (R1 stray-window hijack) |
| `PathfinderLike` | `thinkTimeout, tickTimeout, searchRadius, setMovements(), setGoal(goal, dynamic?), stop(), goto()` | bounded at spawn (R6/R7); abort order `stop()` then `setGoal(null)` (R4) |
| `PvpLike` | `stop()` | abort sequence |
| `CollectBlockLike` | `cancelTask?`, `targets?` | abort clears targets (R4/R10) |
| `AutoEatLike` | `enableAuto(), disableAuto(), setOpts?()` | paused around multi-click ops (R17/R3) |
| `ArmorManagerLike` | `pause?(), resume?()` | paused during window ops (R3) |
| `ItemRegistry` | `itemsByName`, `blocksByName?` (`name → {id}`) | `bot.registry`; surfaced to skills as `ctx.mcData` |
| `BotContainer` | `deposit(type, metadata, count)`, `withdraw(…)`, `containerItems?()`, `close()` | chest ops |
| `EmitterLike` | `on, once, removeListener` | minimal emitter (also the signal-adapter bus) |
| `Bot` (extends `EmitterLike`) | `username`, `entity: {position} \| null`, `game?.dimension`, `health?`, `food?`, `time?.timeOfDay`, `inventory.items()`, `heldItem?`, `currentWindow`, `_client`, plugins `pathfinder?/pvp?/collectBlock?/autoEat?/armorManager?`, `registry?`; methods `chat, closeWindow, blockAt, openContainer, dig, loadPlugin, quit` | the only bot type anything outside the pool sees (`eden/src/types/bot.ts:114-149`) |

Things the seam does **not** expose (e.g. `bot.entities`, `bot.findBlock`) are reached via localized casts
(e.g. `eden/src/bots/signals.ts:165`, `:174-176`); skill code receives the real bot object regardless.

## Skills and runs (`types/skill.ts`)

| Type | Key fields | Notes |
|---|---|---|
| `JsonSchema` | `Record<string, unknown>` | params/returns fragments |
| `Author` | `kind: 'god'\|'villager'\|'stock'`, `name?` | |
| `Provenance` | `rolloutId, verdictId` | set on admit |
| `SkillManifest` | `name, summary, description, params, returns, signature, tags, tier, exemplar` | what retrieval/prompts render; `signature` rendered from params/returns |
| `SkillVersion` | `name, version, codePath, codeHash, status, probationRunsLeft?, author, provenance?, createdAt` | append-only version row |
| `SkillStats` | `runs, successes, failures, stalls, avgMs, lastError?, lastRunAt?` | **derived** (journal fold), never primary |
| `Snapshot` | `biome, time, position[3], health, hunger, equipment[], inventory[{name,count}], nearbyEntities[{name,distance}], nearbyBlocks[], knownChests[[x,y,z]]` | Voyager-style world view shared by villager context pack and critic |
| `CallFrame` | `skill, version, ok, ms` | one node in a run's call tree |
| `RunOutcome` | `{ok:true, value?}` \| `{ok:false, error, errorKind?}` | |
| `RunReport` | `runId, rolloutId?, skill, version, villager, args, outcome, aborted?, startedAt, durationMs, pulses, deepestDepth, callTree, worldBefore, worldAfter` | the critic's full evidence record; journaled as `skill.run` payload |
| `RunnerRef` | `name, role, tier` | who runs a skill; the tier gate reads it |

## God's task model (`types/task.ts`)

| Type | Key fields | Notes |
|---|---|---|
| `ItemCheck` | `item, count` | D-12 objective check; a satisfied check force-vetoes admission (one-directional) |
| `Task` | `id, goal, assignee?, successCriteria, check?, context, maxRetries, parent?, currentRolloutId?` | `context` = QA-cache answer; `currentRolloutId` set at assignment, cleared on boot abandon (D-09) |
| `TaskRecord` | `task, closedAt, verdictId?, reason?` | `reason` set for non-verdict closes (R65 breaker / R72 blocked) |
| `TaskLedger` | `completed[], failed[], open[]` | curriculum is sole writer (S2) |
| `DirectiveSuggestion` | `to: string\|string[]\|'all', goal, reason, priority?` | verdict follow-up (orchestration); not imported anywhere outside `types/` |
| `TaskSuggestion` | `goal, successCriteria?, assignee?, parent?, check?` | verdict follow-up (curriculum); `check` per R72 |
| `Directive` | `id, to, goal, reason, priority, taskRef?, expiresAt?, standing?` | data, not code; delivered via inbox |
| `CriticTicket` | `id, source: 'rollout'\|'tripwire'\|'plea'\|'second-opinion', runReportRef, taskRef?, filedAt` | |
| `Verdict` | `ticketId, success, score?, critique, libraryAction: 'admit'\|'keep-draft'\|'quarantine'\|'archive'\|'none', followUp?: DirectiveSuggestion\|TaskSuggestion, praise?, blocked?` | `blocked` (R72) implies `success:false`, `libraryAction:'none'`; host distinguishes follow-ups with `'to' in fu` (`eden/src/main.ts:1350`) |
| `Rollout` | `id, taskId, villager, attempt, draftVersions[], critiqueChain[], open` | one draft→run→verdict→revise attempt |
| `VerdictRef` | `verdictId, at, success` | dossier back-reference |
| `Competence` | `Record<tag, {runs, successes}>` | |
| `Dossier` | `villager, competence, recentVerdicts, notes, standingOrders?` | God's file on a villager (`standingOrders` never reaches the context pack today) |

## Events and subscriptions (`types/events.ts`)

`EdenEvent` — closed discriminated union (`eden/src/types/events.ts:8-22`):

| `type` | Fields |
|---|---|
| `hurt` | `damage: number`, `byEntity?: string` |
| `entity-spotted` | `entity: string`, `distance: number` |
| `entity-lost` | `entity: string` |
| `player-chat` | `player: string`, `text: string`, `distance?: number` |
| `villager-chat` | `villager: string`, `text: string`, `distance?: number` |
| `inbox` | — |
| `item-received` | `item: string`, `count: number` |
| `health-low` | `health: number` |
| `night-falls` | — |
| `new-day` | `day: number` |
| `died` | `byEntity?: string` |
| `run-finished` | `skill: string`, `ok: boolean` |
| `block-broken-nearby` | `block: string` |
| `tick-30s` | — |

| Type | Shape | Notes |
|---|---|---|
| `EventType` | `EdenEvent['type']` | a subscription's `on` |
| `Envelope` | `{at, villager, event}` | what routers carry |
| `Filter` | `within?: number, entityKind?: string, nameMatches?: string, timeOfDay?: 'day'\|'night'\|'dawn'\|'dusk', healthBelow?, foodBelow?, notWhileRunning?: string[]` | declarative only (P5), AND-composed |
| `ArgTemplate` | `Record<string, unknown>` | `"$event.<path>"` (and, since B3.6, host-scoped roots such as `"$home.x"`) resolve at fire time |
| `SkillHandler` | `{kind:'skill', name, args}` | zero-token reflex |
| `DeliberateHandler` | `{kind:'deliberate', hint, priority?: Priority}` | LLM wake-up |
| `SubscriptionHandler` | `SkillHandler \| DeliberateHandler` | |
| `Subscription` | `id, villager, on, filter?, handler, cooldownMs?, source: 'role-default'\|'self'\|'god'\|'admin', enabled` | policy as data |

Semantics (emitters, clause behaviour, routing) are in [villager-runtime.md](villager-runtime.md).

## Journal rows (`types/journal.ts`)

| Type | Fields | Notes |
|---|---|---|
| `Refs` | `runId?, rolloutId?, taskId?, verdictId?, directiveId?, skill?, skillVersion?, conversationId?, tradeId?, llmCallId?` | causality column; rollout view = `WHERE refs.rolloutId = ?` |
| `JournalEvent` | `id` (ulid), `at` (epoch ms), `actor` (`villager:<n>`, `god:critic`, `engine`, `admin`, `player:<n>` — R41), `kind: string`, `payload: object`, `refs` | `kind` is `string` here because `types/` imports nothing; the canonical union + payload types live in `eden/src/journal/kinds.ts` (enforced at `append`) |
| `JournalQuery` | `kinds?, actor?, id?, ref?` (any ref field equals), `since?, until?, limit?, order?: 'asc'\|'desc'` | with `limit`, both orders select the most-recent N |

## Memory (`types/memory.ts`)

`MemoryEntry { kind: 'event'|'social'|'trade'|'thought'|'system'|'lesson', text, tags, importance 0–10, at }` and
`Relation { other, score, note, at }`. Details in [villager-memory.md](villager-memory.md).

## The decoupling seams

Layer-3 actors (`god/`, `villagers/`, `social/`) never import each other; they meet through `types/` interfaces whose
concrete instances `main.ts` wires.

### Inbox — the ONLY God→villager channel (`types/inbox.ts`)

```ts
interface InboxMessage { from: 'god' | 'villager'; kind: 'directive' | 'critique' | 'tell'; payload: object; at: number }
interface Inbox { deliver(m: InboxMessage, actor?: string): void; drain(): InboxMessage[] }
```

- `actor` (default `engine`) names who spoke on the single `inbox.delivered` row, e.g. `player:<name>` for an admin
  tell (bug #17, `eden/src/types/inbox.ts:13-18`).
- Concrete: `VillagerInbox` (`eden/src/villagers/inbox.ts:13`) — journals `inbox.delivered` first, then calls an optional
  `onDeliver` hook (D-17), FIFO `drain`, plus non-interface `peek()` and `depth()` that main.ts duck-types
  (`eden/src/main.ts:1039-1041`, `:1067`).
- Wiring: `inboxes = new Map<string, Inbox>` (one per villager, `eden/src/main.ts:631-636`) handed to `GodService` and
  `Orchestrator`, which hold only the interface (`eden/src/god/god.ts:16`, `eden/src/god/orchestrator.ts:28`).
- Producers/consumer: see the Inbox section of [villager-runtime.md](villager-runtime.md).

### Social seam (`types/social.ts`)

| Type | Shape | Concrete / user |
|---|---|---|
| `TradeItem` | `{item, count}` — `coin` aliases `paulsbrawls:coin` at settlement | `social/trade.ts`, `journal/kinds.ts`, `views/` |
| `MemorySeed` | `{kind, text, tags?, importance?}` | input to `remember` |
| `MemoryWriter` | `readonly villager; remember(seed): void; moveRelation(other, delta, note): Relation` | implemented by `VillagerMemory` (`eden/src/villagers/memory.ts:91`); consumed by `eden/src/social/conversation.ts:18` |
| `Conversant` | `readonly name; readonly memory: MemoryWriter; sayInGame(line): void; playerInEarshot(): boolean` | built per live villager by `main.ts`'s `conversantFor` (`eden/src/main.ts:694-710`); consumed by `social/conversation.ts` |
| `TradeOffer` / `PendingTrade` / `SettlementResult` | `{from, to, give, want}` / `{id, offer, expiresAt}` / `{ok, reason?}` | `social/trade.ts` |
| `TradeDesk` | `propose(offer)`, `answer(id, by, accept): Promise<SettlementResult>`, `pendingFor(villager)` — never throw | implemented by `TradeBook`; consumed by the villager trade tools (`eden/src/villagers/tools.ts:420-459`) |
| `LeaveDecision` / `SpeakResult` / `TranscriptLine` / `SpeakFn` | `{opinion, note, headline}` / `{say}\|{leave}` / `{from, text}` / `(transcript) => Promise<SpeakResult>` | D-18 turn types: `villagers/conversation-turn.ts` produces turns, `social/conversation.ts` runs them |
| `ConversationDesk` | `say(v, text)`, `tell(from, to, text)`, `start(initiator, partner, topic)` — named French refusals, never throw | implemented by `ConversationBook` (`eden/src/social/conversation.ts:261`); consumed by the speech tools (`eden/src/villagers/tools.ts:392-417`) |

## The dependency law (`eden/.dependency-cruiser.cjs`)

Run as `depcruise src --config .dependency-cruiser.cjs` (`package.json` script `depcruise`), part of
`npm run check` = `lint && typecheck && depcruise && test`. Options: `tsPreCompilationDeps: true` (type-only imports
count), `tsConfig: tsconfig.json`, `doNotFollow: node_modules`. All rules are `severity: 'error'`.

### Intended layering

```
layer 0   types/
layer 1   journal/  config.ts  render/  views/  bots/
layer 2   skills/  llm/
layer 3   god/  villagers/  social/          (never import each other)
consumers admin/ (only main.ts may import)   cli/ (nothing may import)
root      main.ts (composition root, imports anything)
```

### Every rule (exactly as configured)

| # | Rule | From | Forbidden target |
|---|---|---|---|
| 1 | `no-circular` | anything | any cycle |
| 2 | `types-imports-nothing` | `^src/types/` | `^src/` except `^src/types/` |
| 3 | `journal-only-types` | `^src/journal/` | `^src/` except `journal/`, `types/` |
| 4 | `config-only-types` | `^src/config\.ts$` | `^src/` except `types/` |
| 5 | `render-only-types` | `^src/render/` | `^src/` except `render/`, `types/` |
| 6 | `views-only-journal-types` | `^src/views/` | `^src/` except `views/`, `journal/`, `types/` |
| 7 | `bots-no-upward` | `^src/bots/` | `skills/ llm/ god/ villagers/ social/ admin/` |
| 8 | `engines-no-actors` | `^src/(skills\|llm)/` | `god/ villagers/ social/ admin/` |
| 9 | `god-no-peers` | `^src/god/` | `villagers/ social/ admin/` |
| 10 | `villagers-no-peers` | `^src/villagers/` | `god/ social/ admin/` |
| 11 | `social-no-peers` | `^src/social/` | `god/ villagers/ admin/` |
| 12 | `no-import-admin` | `^src/` except `admin/`, `main.ts` | `^src/admin/` |
| 13 | `no-import-cli` | `^src/` except `cli/` | `^src/cli/` |

### What the rules actually permit (read carefully before adding an import)

- `skills/` ↔ `llm/` (same layer) may import each other (only cycles are blocked); both may import `bots/`,
  `render/`, `views/`, `journal/`, `config.ts`, `logger.ts`.
- `bots/` may import `journal/`, `config.ts`, `render/`, `views/`, `logger.ts` (rule 7 only lists upward dirs).
  `villagers/` legally imports `bots/` (`eden/src/villagers/reactivity.ts:21` → `bots/signals.ts`).
- Strict layer-1 modules (`journal/`, `config.ts`, `render/`, `views/`) may not import `src/logger.ts`.
- Root-level files `logger.ts`, `providers.ts`, `scenario-loader.ts`, `village-launch.ts` have no layer rule beyond
  rules 1, 12, 13 (they import `config`, `journal`, `logger`).
- `main.ts` may import `admin/` (rule 12 exempts it) but **not** `cli/` (rule 13 exempts only `cli/` itself) —
  `cli/rebuild-stats.ts` is a standalone entry point.
- To cross between layer-3 actors, add an interface to `types/` and inject the concrete instance from `main.ts`
  (the Inbox / MemoryWriter / Conversant / TradeDesk / ConversationDesk pattern). Code that needs both `god/` and `villagers/` (e.g. the
  `RolloutCoordinator`, `VillageLoop`) lives in `main.ts`.

## Gotchas & known issues

- `CLAUDE.md` says "admin/, cli/ are pure CONSUMERS (only main.ts imports them)"; for `cli/` the config forbids
  every importer including `main.ts`.
- The config's header comment (`eden/.dependency-cruiser.cjs:2`) lists layer 1 as `{journal, config, bots}`; `render/` and
  `views/` are layer-1 too by their own rules (5, 6).
- `docs/04`'s `EdenEvent` sketch differs from the code: `hurt.attacker` → `byEntity`; `player-chat`/`villager-chat`
  use `player`/`villager` not `from`; `entity-spotted` carries `distance`; `inbox` has no fields; `new-day` has `day`;
  `run-finished` is `{skill, ok}` not a report ref; `block-broken-nearby` has no `by`; `died` has `byEntity?`.
- `InboxMessage.from` has no `admin`/`player` member, so the admin prompt route labels its tell `from:'villager'`
  (the journal row's `actor` carries the real speaker).
- Several types are declared but unused outside `types/` (`DirectiveSuggestion` as a named import, `VerdictRef`/
  `Competence` only via `Dossier`, the runtime arrays `TIERS`/`SKILL_STATUSES`/`ABORT_CAUSES`/`PRIORITIES` only in tests;
  `eden/src/god/orchestrator.ts:67` keeps its own copy of the priorities list instead of importing `PRIORITIES`).
- Adding an `EdenEvent` variant changes a frozen contract: update `types/events.ts`, add an emitter row in
  `villagers/events.ts`, give it a live source in `bots/signals.ts`, and docs (S8). The B3.1 chat `distance?` field
  was added this way.

## Related

- [overview.md](overview.md) — Eden at a glance
- [villager-runtime.md](villager-runtime.md) — events, subscriptions, Inbox usage
- [villager-memory.md](villager-memory.md) — `MemoryEntry`, `Relation`, `MemoryWriter` implementation
- [skills-engine.md](skills-engine.md) — `RunReport`, `RunnerRef`, tiers, abort causes
- [skills-library.md](skills-library.md) — `SkillManifest`, `SkillVersion`, statuses
- [god.md](god.md) — `Task`, `Verdict`, `Directive`, `Dossier`, `Rollout`
- [journal-and-views.md](journal-and-views.md) — `JournalEvent`, `Refs`, kinds registry
- [social-and-trade.md](social-and-trade.md) — `TradeItem`, `Conversant`
- [bots-and-hardening.md](bots-and-hardening.md) — the `Bot` seam in use
- [process-config-and-boot.md](process-config-and-boot.md) — `main.ts` composition root
