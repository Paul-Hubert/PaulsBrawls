---
id: eden.overview
title: Eden — overview, module map and village lifecycle
system: eden
summary: What Eden (the AI Village brain) is, its one-process topology, every src/ module and its job, the dependency law, what main.ts actually wires, and a village day end to end.
tags: [eden, overview, architecture, module-map, dependency-law, lifecycle, village, god, villagers]
sources: [eden/src/main.ts, eden/src/config.ts, eden/src/bots/signals.ts, eden/src/social/conversation.ts, eden/src/villagers/tools.ts, eden/src/llm/scheduler.ts, eden/src/village-launch.ts, eden/src/scenario-loader.ts, eden/src/providers.ts, eden/src/logger.ts, eden/.dependency-cruiser.cjs, eden/package.json, eden/eden.example.json, eden/roles.json, eden/src/god/god.ts, eden/src/bots/pool.ts, eden/src/villagers/memory.ts, eden/CLAUDE.md, CLAUDE.md]
verified_at: 98cb908
---

# Eden — overview, module map and village lifecycle

**TL;DR.** Eden is the Node/TypeScript brain of the AI Village: N villager bots plus one God avatar (`Dieu`) in a
single Node process, acting through one shared, God-judged library of JavaScript skills. `eden/src/main.ts` is the
only composition root: it loads config, opens the SQLite journal, folds derived views, wires God's three desks
(critic / curriculum / orchestrator) and the villager brain, and serves an admin HTTP+WebSocket API on 127.0.0.1:8770.
Bots log in only when the Java `/villagers start <scenario>` command POSTs to the admin API; a per-villager
`VillageLoop` then drives the propose-task → author/run skill → critic verdict → revise loop forever.

## What Eden is (and is not)

| Aspect | Fact (from code) |
|---|---|
| Runtime | One Node process (`package.json` `"type": "module"`, `engines.node >=22`), run with `tsx` — no build step (`tsconfig.json` has `noEmit: true`). |
| Entrypoint | `tsx src/main.ts [eden.json]` → `start(configPath, { spawnBots: true, installProcessGuards: true })` (`eden/src/main.ts:1593-1605`), then `installShutdownHandlers(() => host.stop())` (SIGINT/SIGTERM, `eden/src/main.ts:1562-1590`). |
| Bots | Mineflayer bots, one per villager + the avatar, owned by a single `BotPool` (`eden/src/main.ts:226-245`). |
| LLM | OpenAI-compatible chat completions, two tiers (`strong`, `fast`) resolved from `providers.json` (`eden/src/main.ts:125-138`). |
| State | SQLite `.eden-data/eden.db` (append-only `journal` table + a `snapshots` table holding God's working state) + JSON/JS files under `.eden-data/` (see [process-config-and-boot.md](process-config-and-boot.md)). |
| Ports | Holds exactly one port: admin `8770` (bound to `127.0.0.1`, `eden/src/admin/server.ts:131-138`). Calls out to the Java settlement listener `:8767` and the Minecraft server (default `127.0.0.1:25599`). |
| Not Eden | The Fabric mod (`src/`), the Java `/pray` AI God, and the unified bridge in `minecraft-mcp-server/` (an empty submodule in this checkout). Eden's only Java contacts are the settlement listener, op-on-join, and the `/villagers` command — see [java-integration.md](java-integration.md). |

Two distinct "Gods" exist in the repo: the Java AI-God (`LLMBot`, driven by the unified bridge) and Eden's
village God (`Dieu`). `config.ts` warns if `god.name` is `LLMBot` (`eden/src/config.ts:378-380`) and throws if a
villager shares the avatar's name (`assertIdentity`, `eden/src/config.ts:392-401`; re-run after a scenario
replaces the roster, `eden/src/main.ts:148`).

## The organizing idea

- **One God closes every loop.** God's critic desk judges every authored skill run, the curriculum desk proposes
  the village's next task, and the orchestrator desk turns tasks into directives delivered to a villager's inbox.
- **One library.** Skills are `async (bot, args, ctx)` JS functions stored as versioned files; a villager's
  draft enters the shared library only after a critic verdict admits it (probation → active).
- **All world effects are journaled skill runs.** The villager brain has no direct micro-action tools; it acts via
  `run_skill` / `write_skill` (details in [villager-runtime.md](villager-runtime.md)).
- **The journal is the source of truth.** Every fact is an append-only row; dashboards and stats are folds of it
  ([journal-and-views.md](journal-and-views.md)).

## Process topology

```
             Java mod (Fabric, PaulsBrawls server)
   /villagers start|stop|restart ──HTTP POST──┐            ┌── POST /trade/execute (:8767)  [SettlementClient — via the villager trade tools]
                                              v            │
 ┌──────────────────────── one Node process (tsx src/main.ts) ─────────────────────────┐
 │ AdminServer 127.0.0.1:8770  (REST + WS /journal/stream + static website/)            │
 │      │ narrow accessors                                                              │
 │ VillageLauncher ── BotPool (villagers + Dieu) ── mineflayer ──► Minecraft :25599      │
 │ VillageLoop ×N ── RolloutCoordinator ── Curriculum / Orchestrator / CriticDesk (god/) │
 │                                     └── Brain + ToolRegistry + ContextPack (villagers/)│
 │ SkillLibrary + SkillEngine + SkillRetriever (skills/)   LlmClient + LlmScheduler (llm/)│
 │ VillagerReactivity (events → subscriptions → zero-token skill | fast deliberation)   │
 │ ConversationBook + TradeBook (social/)   GodBody (avatar)   AnchorService   drives   │
 │ Journal (better-sqlite3, WAL) ──replay+subscribe──► 5 derived views ──► admin        │
 └──────────────────────────────────────────────────────────────────────────────────────┘
                     │                                   │
                .eden-data/ (db, library, bots, llm)     LLM provider (https, from providers.json)
```

## Module map (`eden/src/`)

Layer numbers follow `eden/.dependency-cruiser.cjs`. Files at the `src/` root are not covered by a layer rule
except `config.ts`.

| Path | Layer | Responsibility | Deep doc |
|---|---|---|---|
| `types/` | 0 | Interfaces + `as const` enums only (bot seam, journal event, skill, task, inbox, social, memory). Imports nothing local. | [types-and-contracts.md](types-and-contracts.md) |
| `config.ts` | 1 | Parse + validate `eden.json` (JSONC), defaults, aliases, R11/R12 identity checks. Returns warnings, never logs. | [process-config-and-boot.md](process-config-and-boot.md) |
| `providers.ts` | root | Load `providers.json` presets and `api-keys.env`. | [process-config-and-boot.md](process-config-and-boot.md) |
| `scenario-loader.ts` | root | Load `scenarios/<name>.json` → roster + God overrides. | [process-config-and-boot.md](process-config-and-boot.md) |
| `village-launch.ts` | root (consumer) | `VillageLauncher`: start/stop/restart the boot pool, `/spreadplayers` + `/give` per villager. | [process-config-and-boot.md](process-config-and-boot.md) |
| `logger.ts` | root | The only module allowed to call `console.*` (ESLint `no-console` elsewhere). | [process-config-and-boot.md](process-config-and-boot.md) |
| `journal/` | 1 | `Journal` (SQLite sole writer), `kinds.ts` (kind registry + payload types), `lag-monitor.ts`. | [journal-and-views.md](journal-and-views.md) |
| `views/` | 1 | Five derived folds over the journal (skill stats, competence, relations, trade ledger, rollouts). | [journal-and-views.md](journal-and-views.md) |
| `render/` | 1 | Pure string renderers: snapshot → text, RunReport → text, token estimate. | [types-and-contracts.md](types-and-contracts.md) |
| `bots/` | 1 | `BotPool` (staggered login 4 s, reconnect backoff, vitals, world stamp), hardening corpus, plugin loading, `signals.ts` (mineflayer → reactivity signal adapter), `anchors.ts` (`AnchorService`). | [bots-and-hardening.md](bots-and-hardening.md) |
| `skills/` | 2 | `SkillLibrary` (versioned store, status machine), `SkillEngine` (sole executor, watchdogs), `instrument.ts` (loop-budget AST pass), `retrieve.ts`, `describe.ts`, `exemplars/` (stock skills). | [skills-library.md](skills-library.md), [skills-engine.md](skills-engine.md), [stock-skills.md](stock-skills.md) |
| `llm/` | 2 | `LlmClient` (OpenAI-compatible, journals `llm.call`), `LlmScheduler` (concurrency cap, lanes, pause), `BudgetTracker`, `EmbeddingsService` (local multilingual MiniLM). | [llm-and-scheduling.md](llm-and-scheduling.md) |
| `god/` | 3 | `GodService` (state, tickets, verdict routing, D-09 recovery), `Curriculum` (sole ledger writer), `Orchestrator` (directives), `CriticDesk`, `GodBody`; prompts in `god/prompts/*.md`. | [god.md](god.md) |
| `villagers/` | 3 | `Brain`, `ToolRegistry`, `ContextPackBuilder`, `VillagerInbox`, `EventRouter`/`SubscriptionStore`/`VillagerReactivity`, role defaults, `VillagerMemory` + summarizer, `DriveTracker`, `ConversationTurner` (fast-tier conversation turns). | [villager-runtime.md](villager-runtime.md), [villager-memory.md](villager-memory.md) |
| `social/` | 3 | `ConversationBook`/`Conversation` (bot↔bot speech, D-18) and `TradeBook`/`TradeService` (consented offers) + `SettlementClient` (POST to `:8767`). | [social-and-trade.md](social-and-trade.md) |
| `admin/` | consumer | `AdminServer`: REST + WS + static dashboard. Only `main.ts` may import it. | [admin-api.md](admin-api.md) |
| `cli/` | consumer | `rebuild-stats.ts`: rebuild views by journal replay. Nothing imports it. | [journal-and-views.md](journal-and-views.md) |
| `main.ts` | root | Composition root, `RolloutCoordinator`, `VillageLoop`, `persistGodState`, `wireDrives`, `makeTripwireHandler`, process guards + shutdown handlers. | [process-config-and-boot.md](process-config-and-boot.md) |
| `vendor-mineflayer.d.ts` | — | Ambient declarations for two mineflayer plugins that ship no types. | — |

Outside `src/`: `website/` (static dashboard served by the admin server), `scenarios/*.json`, `roles.json`
(role-default reflex subscriptions), `eval/` (dry-run eval scaffold), `live-tests/` (real-server harness),
`tests/` (node:test suite on fakes) — see [testing-eval-live.md](testing-eval-live.md).

## The dependency law (brief)

Enforced by dependency-cruiser (`npm run depcruise`, part of `npm run check`) and by
`tests/dependency-law.test.ts`, which also plants an upward import and asserts it fails. Rules in
`eden/.dependency-cruiser.cjs`:

| Rule | Forbids |
|---|---|
| `no-circular` | Any import cycle. |
| `types-imports-nothing` | `src/types/` importing any other `src/` path. |
| `journal-only-types` | `src/journal/` importing anything but `journal/`, `types/`. |
| `config-only-types` | `src/config.ts` importing anything but `types/`. |
| `render-only-types` | `src/render/` importing anything but `render/`, `types/`. |
| `views-only-journal-types` | `src/views/` importing anything but `views/`, `journal/`, `types/`. |
| `bots-no-upward` | `src/bots/` importing `skills|llm|god|villagers|social|admin`. |
| `engines-no-actors` | `src/skills/`, `src/llm/` importing `god|villagers|social|admin`. |
| `god-no-peers` / `villagers-no-peers` / `social-no-peers` | A layer-3 actor importing another layer-3 actor or `admin`. |
| `no-import-admin` | Anything except `admin/` and `main.ts` importing `admin/`. |
| `no-import-cli` | Anything outside `cli/` importing `cli/`. |

Consequence: anything that touches both `god/` and `villagers/` (the `RolloutCoordinator`, `VillageLoop`, the
reactive wake-up closure) lives in `main.ts`. Full treatment: [types-and-contracts.md](types-and-contracts.md).

## What `main.ts` actually wires (production boot)

`start()` (`eden/src/main.ts:116-509`) builds the five views (replayed from the journal, then folded live,
`:174-193`), an `AnchorService` (anchors healed 10 s after each villager spawn, `:206-220`), the `BotPool`
(`:226-245`), then calls `wireGod`, `persistGodState` (restore God's last snapshot, then save 250 ms after any
`god.*` event, `:271`) and D-09 `recoverRollouts` (`:272-275`), the `VillageLauncher` (`:281-297`, with a
`resetVillager` hook that clears the villager's memory and self-authored subscriptions on restart), the
`VillageLoop` (`:306-312`) and the `AdminServer` (`:335-475`).

`wireGod` (`eden/src/main.ts:546-896`) constructs, in order: `ProviderRegistry`, `LlmClient`, `LlmScheduler`,
`BudgetTracker`, `EmbeddingsService(localBackend())`, `SkillLibrary` (+ `verifyHashes()` + `seedStockSkills`),
`AllGranted`, `SkillEngine` (with the tripwire hook), `SkillRetriever`, `MemorySummarizer`, one `VillagerMemory`
per villager, one `VillagerInbox` per villager (a non-trade `tell` raises the reactive `inbox` signal), a
`SettlementClient` + `TradeBook` (+ `closeOrphans()` at boot), a `ConversationTurner` + `ConversationBook`, the
`SubscriptionStore`, `ToolRegistry` (trade, subscriptions and conversations injected), `ContextPackBuilder`,
`Brain`, `GodService` (with a `DescriptionPass` describer), `Curriculum`, `GodBody`, `Orchestrator` (given the
body for `intervene`), `CriticDesk`, the tripwire handler (`makeTripwireHandler`, `:904-933`), and the
`RolloutCoordinator` (given the body for embodied verdicts). Only with a bot pool (`:795-893`): role-default
seeding, `VillagerReactivity` (whose `attach` wires `bots/signals.ts`) and, when `behavior.drives` is on,
`wireDrives` (`:1016-1036`), ticked on the same 30 s clock as reactivity (`:256-262`).

Still **not wired** in a production boot (checked in code at `98cb908`):

- `god.authoring` and `god.gamemode` are parsed (`config.ts`, `scenario-loader.ts`) but no other `src/` file reads them.
- The `item-received`, `block-broken-nearby` and `run-finished` events have router rows
  (`eden/src/villagers/events.ts:174-193`) but `bots/signals.ts` never emits their raw signals (`eden/src/bots/signals.ts:18`).
- Curriculum triggers other than `idle`: `VillageLoop` is the only production caller of `runOnce` and always
  passes `trigger: 'idle'` (`eden/src/main.ts:1483`).
- `BudgetTracker.resetDay()` (`eden/src/llm/scheduler.ts:255`) has no caller, so per-desk daily token caps (when set) never reset.
- `report_to_god`: the tool returns `reportedToGod` and `Brain` collects it into `reportsToGod`
  (`eden/src/villagers/tools.ts:212-213`, `eden/src/villagers/brain.ts:164`), but nothing reads that array and
  `Orchestrator.reportToGod` (`eden/src/god/orchestrator.ts:297`) has no caller.
- Revision history: the coordinator always passes `history: []` (`eden/src/main.ts:1308`).
- `journal.retentionDays` is not parsed (always `7`, `eden/src/config.ts:136`, `:353`) and nothing prunes the journal.
- No admin route resolves an R32 world-stamp quarantine: `VillagerMemory.resolveQuarantine('wipe'|'migrate')`
  (`eden/src/villagers/memory.ts:234`) has no caller outside tests.

## A village day at a glance

1. **Boot.** `tsx src/main.ts eden.json`: config + scenario + provider resolved, journal opened, lag monitor
   armed, views replayed then subscribed, God wired, God's snapshot restored + D-09 recovery, admin listening,
   `system.boot` journaled. No bot is connected yet (deferred spawn, `eden/src/main.ts:480-486`).
2. **`/villagers start <scenario>`** in game → Java POSTs `{name,x,z}` to `/scenario/start` → admin journals
   `scenario.start` → `VillageLauncher.start` arms setup and calls `pool.start()` (staggered logins, 4 s apart) →
   `VillageLoop.start()` (`eden/src/main.ts:458-462`).
3. **Each spawn** (`onBotSpawn`, `eden/src/main.ts:239-243`): reactivity attaches; the launcher waits 1.5 s then has
   the bot chat `/spreadplayers <cx> <cz> 2 10 false <name>` and `/give <name> <id> <count>` per scenario item;
   10 s after spawn the villager's home/chest anchors are healed (`AnchorService`).
4. **Per-villager loop** (`VillageLoop.drive`, `eden/src/main.ts:1464-1491`): poll until connected (2 s), settle
   3 s, then repeatedly `coordinator.runOnce({ trigger: 'idle', villager })`, sleeping 1 s after a task or 5 s
   after no proposal / an error.
5. **`runOnce`**: resume the villager's open task if any, else `curriculum.proposeTask` (strong tier) →
   `assignAndRun`: orchestrator dispatches a directive into the inbox; up to `task.maxRetries` revisions of
   brain deliberation (strong tier) → draft + trial run → `god.fileTicket` → `critic.judge` →
   `god.routeVerdict` → admitted (converged), blocked (R72: close + follow-up acquire task), or revise with the
   critique, draft code and RunReport in the next prompt (`eden/src/main.ts:1229-1374`). An admission or a
   quarantine is also delivered in person by `GodBody` when `embodiedVerdicts` is on (`eden/src/main.ts:1331-1333`).
6. **In parallel, reactivity**: mineflayer signals (hurt/health/death, chat, entity spotted/lost, night/day,
   inbox) → events → subscriptions (seeded from `roles.json` at first boot) → zero-token skill runs or
   fast-tier deliberations; a 30 s `tick` pump that also ticks the drives (`eden/src/main.ts:256-262`).
   Villagers can talk (`say`/`tell`/`start_conversation`) and trade (`propose_trade`/`answer_trade`).
7. **Background**: vitals every `vitalsIntervalSeconds` (10 s) per connected bot, lag sample every 60 s.
8. **`/villagers stop`**: loop stopped first, then pool disconnected; on-disk state kept.

## Gotchas & known issues

- `config.villagers[].persona` (from scenarios) is parsed but **never used**: the roster persona is hardcoded to
  `Tu es <name>, <role> du village. Tu parles français.` (`eden/src/main.ts:754`, and again in the admin summary,
  `eden/src/main.ts:1100`); conversation turns use `Tu es <role> du village.` (`eden/src/main.ts:712`). The
  `farm` scenario's villager key `Harry` has a persona that says "Tu es Firmin" — irrelevant today because
  personas are ignored.
- The unwired items listed above (config keys, inert events, non-`idle` triggers, `resetDay`, `report_to_god`,
  revision history, retention, R32 resolution).
- God's working state is no longer RAM-only: it is restored from the `snapshots` table at boot, so D-09
  recovery (`eden/src/main.ts:272-275`) has tasks to recover. A snapshot from another `worldId` is ignored
  (`eden/src/main.ts:958-959`).
- `BotPool` is built without `currentRunOf`, so every `vitals.currentRun` is `null` (`eden/src/bots/pool.ts:279`).

## Related

- [process-config-and-boot.md](process-config-and-boot.md) · [journal-and-views.md](journal-and-views.md) · [admin-api.md](admin-api.md) · [testing-eval-live.md](testing-eval-live.md)
- [types-and-contracts.md](types-and-contracts.md) · [skills-library.md](skills-library.md) · [skills-engine.md](skills-engine.md) · [stock-skills.md](stock-skills.md)
- [bots-and-hardening.md](bots-and-hardening.md) · [god.md](god.md) · [llm-and-scheduling.md](llm-and-scheduling.md) · [social-and-trade.md](social-and-trade.md)
- [villager-runtime.md](villager-runtime.md) · [villager-memory.md](villager-memory.md) · [java-integration.md](java-integration.md)
- [../00-overview.md](../00-overview.md) · [../reference/ports-files-config.md](../reference/ports-files-config.md)
