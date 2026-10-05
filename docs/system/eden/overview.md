---
id: eden.overview
title: Eden — overview, module map and village lifecycle
system: eden
summary: What Eden (the AI Village brain) is, its one-process topology, every src/ module and its job, the dependency law, what main.ts actually wires, and a village day end to end.
tags: [eden, overview, architecture, module-map, dependency-law, lifecycle, village, god, villagers]
sources: [eden/src/main.ts, eden/src/config.ts, eden/src/village-launch.ts, eden/src/scenario-loader.ts, eden/src/providers.ts, eden/src/logger.ts, eden/.dependency-cruiser.cjs, eden/package.json, eden/eden.example.json, eden/roles.json, eden/src/god/god.ts, eden/src/bots/pool.ts, eden/src/villagers/memory.ts, eden/CLAUDE.md, CLAUDE.md]
verified_at: 4a8081f
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
| Entrypoint | `tsx src/main.ts [eden.json]` → `start(configPath, { spawnBots: true, installProcessGuards: true })` (`eden/src/main.ts:1188-1199`). |
| Bots | Mineflayer bots, one per villager + the avatar, owned by a single `BotPool` (`eden/src/main.ts:192-210`). |
| LLM | OpenAI-compatible chat completions, two tiers (`strong`, `fast`) resolved from `providers.json` (`eden/src/main.ts:116-129`). |
| State | SQLite journal `.eden-data/eden.db` (append-only history) + JSON/JS files under `.eden-data/` (see [process-config-and-boot.md](process-config-and-boot.md)). |
| Ports | Holds exactly one port: admin `8770` (bound to `127.0.0.1`, `eden/src/admin/server.ts:129-135`). Calls out to the Java settlement listener `:8767` and the Minecraft server (default `127.0.0.1:25599`). |
| Not Eden | The Fabric mod (`src/`), the Java `/pray` AI God, and the unified bridge in `minecraft-mcp-server/` (an empty submodule in this checkout). Eden's only Java contacts are the settlement listener, op-on-join, and the `/villagers` command — see [java-integration.md](java-integration.md). |

Two distinct "Gods" exist in the repo: the Java AI-God (`LLMBot`, driven by the unified bridge) and Eden's
village God (`Dieu`). `config.ts` warns if `god.name` is `LLMBot` (`eden/src/config.ts:365-367`) and throws if a
villager shares the avatar's name (`eden/src/config.ts:379-388`).

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
 │ Journal (better-sqlite3, WAL) ──subscribe──► 5 derived views ──► admin               │
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
| `bots/` | 1 | `BotPool` (staggered login 4 s, reconnect backoff, vitals, world stamp), hardening corpus, plugin loading, signal adapter, anchors. | [bots-and-hardening.md](bots-and-hardening.md) |
| `skills/` | 2 | `SkillLibrary` (versioned store, status machine), `SkillEngine` (sole executor, watchdogs), `instrument.ts` (loop-budget AST pass), `retrieve.ts`, `describe.ts`, `exemplars/` (stock skills). | [skills-library.md](skills-library.md), [skills-engine.md](skills-engine.md), [stock-skills.md](stock-skills.md) |
| `llm/` | 2 | `LlmClient` (OpenAI-compatible, journals `llm.call`), `LlmScheduler` (concurrency cap, lanes, pause), `BudgetTracker`, `EmbeddingsService` (local multilingual MiniLM). | [llm-and-scheduling.md](llm-and-scheduling.md) |
| `god/` | 3 | `GodService` (state, tickets, verdict routing, D-09 recovery), `Curriculum` (sole ledger writer), `Orchestrator` (directives), `CriticDesk`, `GodBody`; prompts in `god/prompts/*.md`. | [god.md](god.md) |
| `villagers/` | 3 | `Brain`, `ToolRegistry`, `ContextPackBuilder`, `VillagerInbox`, `EventRouter`/`SubscriptionStore`/`VillagerReactivity`, role defaults, `VillagerMemory` + summarizer, drives. | [villager-runtime.md](villager-runtime.md), [villager-memory.md](villager-memory.md) |
| `social/` | 3 | `Conversation` (bot↔bot speech) and trade offers + `SettlementClient` (POST to `:8767`). | [social-and-trade.md](social-and-trade.md) |
| `admin/` | consumer | `AdminServer`: REST + WS + static dashboard. Only `main.ts` may import it. | [admin-api.md](admin-api.md) |
| `cli/` | consumer | `rebuild-stats.ts`: rebuild views by journal replay. Nothing imports it. | [journal-and-views.md](journal-and-views.md) |
| `main.ts` | root | Composition root, `RolloutCoordinator`, `VillageLoop`, process guards. | [process-config-and-boot.md](process-config-and-boot.md) |
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

`wireGod` (`eden/src/main.ts:486-697`) constructs, in order: `ProviderRegistry`, `LlmClient`, `LlmScheduler`,
`BudgetTracker`, `EmbeddingsService(localBackend())`, `SkillLibrary` (+ `seedStockSkills`), `AllGranted`,
`SkillEngine`, `SkillRetriever`, `MemorySummarizer`, one `VillagerMemory` per villager, `ToolRegistry`,
`ContextPackBuilder`, `Brain`, one `VillagerInbox` per villager, `GodService`, `Curriculum`, `Orchestrator`,
`CriticDesk`, a discarded `GodBody`, a `SettlementClient` + `TradeBook` (injected into `ToolRegistry`), `RolloutCoordinator`, `SubscriptionStore`,
and (only with a bot pool) role-default seeding + `VillagerReactivity`.

Built and unit-tested but **not constructed by the host** (grep of `src/` for their constructors finds only
tests): `social/conversation.ts` (`Conversation`), trade services in `social/trade.ts`, `villagers/drives.ts`
(`behavior.drives` has no effect), `bots/anchors.ts` (`AnchorService`), `skills/describe.ts` (`DescriptionPass`
— `GodService` is built without a `describer`, `eden/src/main.ts:555`). `GodBody` and `SettlementClient` are
constructed with `void new …` and the instances dropped (`eden/src/main.ts:570`, `eden/src/main.ts:577`).

## A village day at a glance

1. **Boot.** `tsx src/main.ts eden.json`: config + scenario + provider resolved, journal opened, lag monitor
   armed, views subscribed, God wired, admin listening, `system.boot` journaled. No bot is connected yet (deferred
   spawn, `eden/src/main.ts:427-433`).
2. **`/villagers start <scenario>`** in game → Java POSTs `{name,x,z}` to `/scenario/start` → admin journals
   `scenario.start` → `VillageLauncher.start` arms setup and calls `pool.start()` (staggered logins, 4 s apart) →
   `VillageLoop.start()` (`eden/src/main.ts:406-410`).
3. **Each spawn** (`onBotSpawn`, `eden/src/main.ts:205-208`): reactivity attaches; the launcher waits 1.5 s then has
   the bot chat `/spreadplayers <cx> <cz> 2 10 false <name>` and `/give <name> <id> <count>` per scenario item.
4. **Per-villager loop** (`VillageLoop.drive`, `eden/src/main.ts:1108-1135`): poll until connected (2 s), settle
   3 s, then repeatedly `coordinator.runOnce({ trigger: 'idle', villager })`, sleeping 1 s after a task or 5 s
   after no proposal / an error.
5. **`runOnce`**: resume the villager's open task if any, else `curriculum.proposeTask` (strong tier) →
   `assignAndRun`: orchestrator dispatches a directive into the inbox; up to `task.maxRetries` revisions of
   brain deliberation (strong tier) → draft + trial run → `god.fileTicket` → `critic.judge` →
   `god.routeVerdict` → admitted (converged), blocked (R72: close + follow-up acquire task), or revise with the
   critique, draft code and RunReport in the next prompt (`eden/src/main.ts:903-1018`).
6. **In parallel, reactivity**: mineflayer signals → events → subscriptions (seeded from `roles.json` at first
   boot) → zero-token skill runs or fast-tier deliberations; a 30 s `tick` pump (`eden/src/main.ts:221-222`).
7. **Background**: vitals every `vitalsIntervalSeconds` (10 s) per connected bot, lag sample every 60 s.
8. **`/villagers stop`**: loop stopped first, then pool disconnected; on-disk state kept.

## Gotchas & known issues

- `config.villagers[].persona` (from scenarios) is parsed but **never used**: the roster persona is hardcoded to
  `Tu es <name>, <role> du village. Tu parles français.` (`eden/src/main.ts:579`). The `farm` scenario's villager key
  `Harry` has a persona that says "Tu es Firmin" — irrelevant today because personas are ignored.
- Config keys `god.gamemode`, `god.authoring`, `god.combineDesks`, `behavior.drives` are
  parsed but not read by any host code path (grep of `src/` outside `config.ts`/`scenario-loader.ts`).
  `journal.retentionDays` is not even parsed: it is always the hardcoded default `7` (`eden/src/config.ts:132-133`,
  `eden/src/config.ts:340`), and setting it in `eden.json` only draws an unknown-key warning (`eden/src/config.ts:333`).
- `GodState` is in-memory only; nothing rehydrates tasks from the journal at boot, so the D-09 boot recovery
  (`wiring.god.recoverRollouts()`, `eden/src/main.ts:228-231`) iterates an empty task map on a real boot.
- Conversation/drives/anchors are not wired (see above), so `conversation.*` and `chat.*` kinds are never emitted
  by a production host and the relations view stays empty. Trade is wired: `trade.*` events (and the trade
  ledger) appear once villagers use `propose_trade`/`answer_trade`.
- `BotPool` is built without `currentRunOf`, so every `vitals.currentRun` is `null` (`eden/src/bots/pool.ts:271`).

## Related

- [process-config-and-boot.md](process-config-and-boot.md) · [journal-and-views.md](journal-and-views.md) · [admin-api.md](admin-api.md) · [testing-eval-live.md](testing-eval-live.md)
- [types-and-contracts.md](types-and-contracts.md) · [skills-library.md](skills-library.md) · [skills-engine.md](skills-engine.md) · [stock-skills.md](stock-skills.md)
- [bots-and-hardening.md](bots-and-hardening.md) · [god.md](god.md) · [llm-and-scheduling.md](llm-and-scheduling.md) · [social-and-trade.md](social-and-trade.md)
- [villager-runtime.md](villager-runtime.md) · [villager-memory.md](villager-memory.md) · [java-integration.md](java-integration.md)
- [../00-overview.md](../00-overview.md) · [../reference/ports-files-config.md](../reference/ports-files-config.md)
