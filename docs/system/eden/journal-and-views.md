---
id: eden.journal-and-views
title: Eden — journal (SQLite), event kinds, lag monitor and derived views
system: eden
summary: The eden.db schema and pragmas, append/query/subscribe semantics, actor and refs conventions, every registered journal kind with payload and emitter, the lag canary, the five derived views, and rebuild-stats.
tags: [eden, journal, sqlite, better-sqlite3, wal, event-kinds, actor, refs, lag-monitor, views, rebuild-stats, observability]
sources: [eden/src/journal/journal.ts, eden/src/journal/kinds.ts, eden/src/journal/lag-monitor.ts, eden/src/types/journal.ts, eden/src/types/skill.ts, eden/src/views/index.ts, eden/src/cli/rebuild-stats.ts, eden/src/main.ts, eden/src/admin/server.ts, eden/src/bots/pool.ts, eden/src/skills/library.ts, eden/src/skills/engine.ts, eden/src/llm/client.ts, eden/src/villagers/context-pack.ts, eden/src/villagers/brain.ts, eden/src/villagers/inbox.ts, eden/src/villagers/events.ts, eden/src/villagers/subscriptions.ts, eden/src/villagers/memory.ts, eden/src/god/god.ts, eden/src/god/body.ts, eden/src/god/curriculum.ts, eden/src/god/orchestrator.ts, eden/src/social/conversation.ts, eden/src/social/trade.ts, eden/tests/fakes/memory-journal.ts, docs/05-observability.md]
verified_at: 4a8081f
---

# Eden — journal (SQLite), event kinds, lag monitor and derived views

**TL;DR.** Every Eden fact is one row in a single SQLite table `journal` in `.eden-data/eden.db`, written
synchronously by `Journal.append(actor, kind, payload, refs)` (better-sqlite3, WAL, `synchronous=NORMAL`). Kinds are
a closed registry of 42 entries in `eden/src/journal/kinds.ts`; appending an unregistered kind throws. Each append
fans out in-process to subscribers (the admin WebSocket and five derived views). Views are folds of the journal;
`npm run rebuild-stats` recomputes them by replay. A lag monitor journals `system.loop-lag` when the event loop
stalls ≥ 1000 ms.

## SQLite schema (`eden/src/journal/journal.ts:46-69`)

Pragmas: `journal_mode = WAL`, `synchronous = NORMAL`. One table:

| Column | Type | Content |
|---|---|---|
| `id` | TEXT PRIMARY KEY | ULID from `ulid`'s `monotonicFactory()` (sortable, unique within the process). |
| `at` | INTEGER NOT NULL | `Date.now()` epoch ms at append. |
| `actor` | TEXT NOT NULL | Who acted (see Actor conventions). |
| `kind` | TEXT NOT NULL | A registered `JournalKind`. |
| `payload` | TEXT NOT NULL | `JSON.stringify(payload)`. |
| `refs` | TEXT NOT NULL | `JSON.stringify(refs)` — causality object (default `{}`). |

Indexes: `idx_journal_at(at)`, `idx_journal_actor_at(actor, at)`, `idx_journal_kind_at(kind, at)`, and expression
indexes on `json_extract(refs,'$.runId')`, `'$.rolloutId'`, `'$.skill'`.

One other table since B3.9: `snapshots(key TEXT PRIMARY KEY, at INTEGER, value TEXT)` — the crash-only working state of
a RAM-held owner (today only `god`, see [god.md](god.md)); `putSnapshot(key, value)` upserts, `getSnapshot(key)`
returns `{at, value}` or `undefined` (an unreadable row reads as absent). Snapshots are not journal events. Library
index, subscriptions and memory are not in SQLite (JSON files — see [process-config-and-boot.md](process-config-and-boot.md)). No retention/pruning code exists: rows are kept forever.

## API (`IJournal`)

| Method | Semantics |
|---|---|
| `append(actor, kind, payload, refs = {}) → id` | Throws `journal.append: unregistered kind "<k>" — add a row to journal/kinds.ts (S1)` if `isKnownKind` fails. Synchronous INSERT (prepared statement), then `fan(event)` to every listener; listener exceptions are swallowed. Returns the ULID. |
| `query(q = {}) → JournalEvent[]` | Builds `WHERE` from `kinds` (`IN`), `actor` (=), `id` (=), `since` (`at >=`), `until` (`at <=`), `ref` (`EXISTS (SELECT 1 FROM json_each(journal.refs) WHERE json_each.value = ?)` — matches the value in ANY refs field). With `limit` the scan is `ORDER BY at DESC, id DESC LIMIT n` (the newest N); result order is `asc` (chronological, default) or `desc` (`order:'desc'`). No limit → the whole match set. |
| `subscribe(listener) → unsubscribe` | In-process fan-out of each appended event (same object as the row). |
| `count()` / `close()` | Row count; close the DB (host shutdown). |

`JournalEvent = { id, at, actor, kind, payload, refs }` (`eden/src/types/journal.ts:24-34`); `kind` is typed
`string` in `types/` so layer 0 imports nothing; the union lives in `kinds.ts`.

Test double: `tests/fakes/memory-journal.ts` `MemoryJournal` implements the same surface in an array with ids
`mem-00000000…`.

## Refs (causality column, `eden/src/types/journal.ts:5-16`)

| Field | Set by (examples) |
|---|---|
| `runId` | `skill.run`, `skill.log`, `god.ticket` |
| `rolloutId` | `skill.run`/`skill.log` (when run inside a rollout), `god.ticket`, `god.verdict`, `skill.admit`, `god.rollout-abandoned`, `brain.*` revision wake-ups, `god.appearance` (body) |
| `taskId` | `god.ticket`, `god.verdict`, `god.task-*`, `god.directive*`, `god.rollout-abandoned` |
| `verdictId` | `god.verdict`, `god.task-closed` (verdict close) |
| `directiveId` | `god.directive`, `god.directive-closed` |
| `skill`, `skillVersion` | `skill.*`, `god.ticket`, `god.verdict`, admin `skill.quarantine` |
| `conversationId`, `tradeId` | `conversation.*`, `chat.*`, `trade.*` |
| `llmCallId` | `llm.call` (key of the debug transcript file) |

A rollout replay is `GET /journal?ref=<rolloutId>` ([admin-api.md](admin-api.md)). `skill.draft` refs carry only
`{skill, skillVersion}` (no `rolloutId`).

## Actor conventions (observed in emitters)

| Actor | Used for |
|---|---|
| `engine` | `system.boot`, `system.config-warning` (boot), `system.error` (process guards), `system.loop-lag`, `inbox.delivered` (inbox impl), library `skill.quarantine`, stock-authored `skill.draft` |
| `admin` | Admin POST verbs (`skill.quarantine`, `scenario.*`, pause/resume `system.config-warning`, `inbox.delivered` without `from`) |
| `player:<from>` | `POST /villagers/:name/prompt` with a `from` field |
| `bot:<name>` | `BotPool`: `system.bot-connected`, `system.bot-disconnected`, `vitals`, `world.death` |
| `villager:<name>` | Brain, context pack, mortal skill runs/logs, villager-authored drafts, subscriptions, memory world-stamp warning, social events, `llm.call` from villager callers |
| `god:critic` / `god:curriculum` / `god:orchestrator` | Desk events and their `llm.call`s; `god:critic` also emits `skill.admit`/`skill.archive` |
| `god:body` | Divine-tier `skill.run`/`skill.log`; `GodBody` `god.appearance` |
| `god:authoring` | God-authored `skill.draft` |
| `god` | `god.rollout-abandoned` |
| `god:describe` | `llm.call` default caller of `DescriptionPass` (not wired in host) |

## Every journal kind (`eden/src/journal/kinds.ts:9-66` list, `:76-235` payloads)

| Kind | Payload | Emitter (file:line) · actor |
|---|---|---|
| `system.boot` | `{ config }` (secrets redacted) | `eden/src/main.ts:424` · engine |
| `system.config-warning` | `{ message }` | `eden/src/main.ts:147` · engine (config warnings); `eden/src/admin/server.ts:298` · admin (`admin: pause|resume LLM scheduling`); `eden/src/villagers/memory.ts:326` · villager:<n> (R32 memory quarantine) |
| `system.bot-connected` | `{ name }` | `eden/src/bots/pool.ts:206` · bot:<n> |
| `system.bot-disconnected` | `{ name, reason? }` | `eden/src/bots/pool.ts:225` · bot:<n> |
| `system.error` | `{ message, stack? }` | `eden/src/main.ts:1173`, `:1178` · engine (process guards); `eden/src/villagers/events.ts:372` · villager:<n> |
| `system.loop-lag` | `{ p99, max }` (ms, rounded) | `eden/src/journal/lag-monitor.ts:51` · engine |
| `vitals` | `{ name, health, food, position:[x,y,z], held, currentRun }` | `eden/src/bots/pool.ts:265` · bot:<n> (each connected bot every `vitalsIntervalSeconds`) |
| `world.death` | `{ name, cause? }` (cause from `death_combat_event`) | `eden/src/bots/pool.ts:233` · bot:<n> |
| `skill.draft` | `{ name, version, author:{kind,name?}, tier, lines }` | `eden/src/skills/library.ts:119` · villager:<n> / god:authoring / engine |
| `skill.admit` | `{ name, version, provenance? }` | `eden/src/skills/library.ts:147` (admit) and `:196` (unquarantine → probation) · god:critic |
| `skill.quarantine` | `{ name, version, reason }` | `eden/src/skills/library.ts:178` · engine; `eden/src/admin/server.ts:243` · admin (with `version: -1`) |
| `skill.archive` | `{ name, version }` | `eden/src/skills/library.ts:219` · god:critic |
| `skill.run` | full `RunReport` `{ runId, rolloutId?, skill, version, villager, args, outcome:{ok,value?｜error,errorKind?}, aborted?, startedAt, durationMs, pulses, deepestDepth, callTree, worldBefore, worldAfter }` | `eden/src/skills/engine.ts:406` · villager:<n> or god:body (divine) |
| `skill.log` | `{ skill, message }` | `eden/src/skills/engine.ts:318` · same as run |
| `llm.call` | `{ caller, model, tier, latencyMs, promptTokens, completionTokens, finishReason, retries }` | `eden/src/llm/client.ts:320` · `req.caller` |
| `brain.wakeup` | `{ villager, triggers[], sections{}, totalTokens, trimmedPairs, tier }` | `eden/src/villagers/context-pack.ts:174` · villager:<n> |
| `brain.tool-call` | `{ villager, tool, ok }` (args not logged) | `eden/src/villagers/brain.ts:157` · villager:<n> |
| `brain.done` | `{ villager, summary, mood?, toolCalls }` | `eden/src/villagers/brain.ts:187` · villager:<n> |
| `god.ticket` | `{ source:'rollout'｜'tripwire'｜'plea'｜'second-opinion', skill?, version? }` | `eden/src/god/god.ts:136` · god:critic |
| `god.verdict` | `{ ticketId, success, libraryAction, score?, critique }` | `eden/src/god/god.ts:155` · god:critic |
| `god.appearance` | `{ villager, action, ok }` | `eden/src/god/body.ts:65` · god:body; `eden/src/god/orchestrator.ts:248` · god:orchestrator |
| `god.rollout-abandoned` | `{ reason:'crash-recovery', taskId }` | `eden/src/god/god.ts:223` · god |
| `god.task-proposed` | `{ taskId, goal, assignee?, trigger, parent? }` | `eden/src/god/curriculum.ts:457` · god:curriculum |
| `god.task-closed` | `{ taskId, goal, outcome:'completed'｜'failed'｜'retired', reason? }` | `eden/src/god/curriculum.ts:357-362` and `:421` (retired) · god:curriculum |
| `god.directive` | `{ directiveId, to, goal, priority, superseded? }` | `eden/src/god/orchestrator.ts:230` · god:orchestrator |
| `god.directive-closed` | `{ directiveId, to, reason:'completed'｜'expired'｜'superseded' }` | `eden/src/god/orchestrator.ts:203`, `:276`, `:288` · god:orchestrator |
| `inbox.delivered` | `{ to, from, kind }` | `eden/src/villagers/inbox.ts:23` · engine (every delivery); `eden/src/admin/server.ts:260` · admin/player:<from> |
| `chat.said` | `{ from, to, text }` | `eden/src/social/conversation.ts:168` · villager:<n> |
| `chat.heard` | `{ hearer, from, text, eavesdrop }` | `eden/src/social/conversation.ts:185` · villager:<n> |
| `conversation.started` | `{ id, initiator, partner, topic? }` | `eden/src/social/conversation.ts:109` |
| `conversation.turn` | `{ id, speaker, turn }` | `eden/src/social/conversation.ts:140` |
| `conversation.ended` | `{ id, by, reason:'left'｜'turn-cap'｜'deadline'｜'partner-gone', opinion?, headline? }` | `eden/src/social/conversation.ts:154` |
| `trade.proposed` | `{ id, from, to, give:TradeItem[], want:TradeItem[] }` | `eden/src/social/trade.ts:169` (TradeService), `:241` (TradeBook) · villager:<from> |
| `trade.settled` | same as proposed | `eden/src/social/trade.ts:114` · villager:<from> |
| `trade.failed` | `{ id, from, to, reason }` — settlement failure, R33 unreachable, or a declined/withdrawn/expired offer | `eden/src/social/trade.ts:131`, `:191`, `:306` · villager:<from> |
| `subscription.created` | `{ id, villager, on, handler:'skill'｜'deliberate', source }` | `eden/src/villagers/subscriptions.ts:85` · villager:<n> |
| `subscription.removed` | `{ id, villager }` | `eden/src/villagers/subscriptions.ts:102` · villager:<n> |
| `subscription.fired` | `{ id, villager, on, outcome:'skill'｜'deliberate', target }` | `eden/src/villagers/events.ts:390` · villager:<n> |
| `subscription.suppressed` | `{ id, villager, on, reason }` | `eden/src/villagers/events.ts:323` · villager:<n> |
| `scenario.start` | `{ name, cx, cz }` | `eden/src/admin/server.ts:278` · admin |
| `scenario.stop` | `{}` | `eden/src/admin/server.ts:288` · admin |
| `scenario.restart` | `{ name, cx, cz }` | `eden/src/admin/server.ts:280` · admin |

(`TradeItem = { item, count }`.) Social kinds (`chat.*`, `conversation.*`, `trade.*`) have no production emitter
path: the host never constructs `Conversation` or the trade services ([overview.md](overview.md)).

`KIND_REGISTRY` (`eden/src/journal/kinds.ts:245-288`) holds a one-line `doc` per kind, enforced complete by
`satisfies Record<JournalKind, KindDoc>`; `describeKinds()` serves it at `GET /kinds`.

### Adding a kind (S1 recipe)

1. Add the string to `JOURNAL_KINDS`. 2. Add its payload to `KindPayloads` (compile error otherwise). 3. Add a
`KIND_REGISTRY` doc row (compile error otherwise). 4. Emit it from exactly one writer module. 5. If the dashboard
should facet it, add it to `KIND_DOMAINS` in `eden/website/api.js` (it falls back to the prefix otherwise).
`tests/journal-kinds.test.ts` pins the registry.

## Lag monitor (`eden/src/journal/lag-monitor.ts`)

| Parameter | Value | Configurable? |
|---|---|---|
| Histogram | `monitorEventLoopDelay({ resolution: 20 })`, enabled at creation | `resolutionMs` option (tests) |
| Threshold | `max ≥ 1000 ms` → append `system.loop-lag { p99, max }` | `thresholdMs` option only; not an `eden.json` key |
| Sample/reset interval | every 60 000 ms (`setInterval`, unref'd), histogram reset after each sample | `resetMs` option |

So at most one `system.loop-lag` per 60 s window. `stop()` clears the timer and disables the histogram. There is no
p99-based debug log (docs/05 describes one; the code has none).

## Write volume and hot-path rules

- `vitals`: one row per connected bot per `vitalsIntervalSeconds` (default 10 s); config warns below 5 s.
- Pulses (stall-detector liveness) are never journaled; only `skill.run` summaries are.
- `llm.call` carries metrics only; prompt bodies go to `.eden-data/llm/<callId>.json` when `journal.debugPrompts`.

## Derived views (`eden/src/views/index.ts`)

Base class `DerivedView<V>`: `fold(event)` (live), `value()` (fresh copy), `reset()`, and
`rebuildByReplay(journal)` = `reset()` then fold every event of `journal.query()` (whole table, chronological).
`ALL_VIEWS` lists the five classes. In the host (B3.9) they are first replayed from ONE journal scan of every kind but
`vitals` (no view folds it), then subscribed live.

| View | Folds kinds | Output shape | Consumers |
|---|---|---|---|
| `SkillStatsView` | `skill.run` | `Record<skill, { runs, successes, failures, stalls, avgMs (rounded in value()), lastError?, lastRunAt? }>`; `stalls` counts `aborted === 'stalled'`. | `GET /skills`, `GET /skills/:name` (`stats`, normalized to `avg_ms`) |
| `CompetenceView` | `skill.run` | `Record<villager, Record<skill, { runs, successes }>>` (keyed by skill, not tag) | `usedBy` in skill responses |
| `RelationsView` | `conversation.started`, `conversation.ended` (with `opinion`) | `Record<villager, Record<other, { score (sum of opinions), note (latest headline), at }>>` | Not served by the admin (admin relations come from `VillagerMemory`) |
| `TradeLedgerView` | `trade.proposed`/`settled`/`failed` | `TradeLedgerEntry[] { id, from, to, give, want, status, reason?, at }` sorted by `at` | Not served by the admin |
| `RolloutsView` | any event with `refs.rolloutId`; `god.task-closed` | `RolloutEntry[] { rolloutId, taskId?, villager?, skill?, status:'open'｜'admitted'｜'exhausted'｜'abandoned', trials, startedAt, endedAt }` sorted by `startedAt`, then id | `GET /rollouts` |

`RolloutsView` rules: `trials` += 1 per `god.verdict`; first successful verdict → `admitted`;
`god.rollout-abandoned` → `abandoned`; `god.task-closed{outcome:'failed'}` marks every still-open rollout of that
`taskId` `exhausted`; `villager`/`skill` come from `skill.run` payload or a `villager` payload field.

## `rebuild-stats` CLI (`eden/src/cli/rebuild-stats.ts`)

```
npm run rebuild-stats -- [dataDir]     # tsx src/cli/rebuild-stats.ts; default '.eden-data'
```

Opens `<dataDir>/eden.db` (creating the dir and an empty DB if absent), runs `rebuildStats(journal)` (all five
views `rebuildByReplay`), logs a one-line summary (`rebuild-stats from <db>: N skill(s), N villager(s), N relation
edge(s), N trade(s), N rollout(s)`) and the full JSON via `logger.info('admin', …)`, then closes. Safe against a live
host (WAL allows concurrent readers), though it re-runs the CREATE/pragma statements.

**Replay invariant:** a view rebuilt by replay must equal the same view folded live. Pinned by
`tests/views.test.ts` and `tests/rebuild-stats.test.ts`. The host replays at boot (B3.9), so the admin's views
cover the whole history, like the CLI's fold.

## Gotchas & known issues

- `GET /journal` with no `limit` returns the entire matching table (no server-side cap).
- `ref` matching is by value across all ref fields, so `ref=<skillName>` also matches events where that string is
  another field's value; numeric `skillVersion` never matches a text param.
- `inbox.delivered` is double-journaled for admin prompts: once by the admin (actor `admin`/`player:<from>`) and
  again by `VillagerInbox.deliver` (actor `engine`).
- Admin quarantine journals `skill.quarantine` with `version: -1` before acting, then the library journals a second
  `skill.quarantine` (actor `engine`) with the real version — two rows per admin quarantine.
- Pause/resume reuse `system.config-warning` instead of a dedicated kind.
- The website's `KIND_DOMAINS` (`eden/website/api.js`) omits the `scenario.*` kinds.
- Docs/05 "configurable 7-day retention" for `vitals`/`subscription.fired` is not implemented (no key, no pruning).

## Related

- [overview.md](overview.md) · [admin-api.md](admin-api.md) · [process-config-and-boot.md](process-config-and-boot.md) · [testing-eval-live.md](testing-eval-live.md)
- [types-and-contracts.md](types-and-contracts.md) · [skills-engine.md](skills-engine.md) · [god.md](god.md) · [villager-runtime.md](villager-runtime.md) · [social-and-trade.md](social-and-trade.md)
