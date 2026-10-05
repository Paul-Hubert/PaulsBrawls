---
id: eden.process-config-and-boot
title: Eden — process, configuration and boot
system: eden
summary: main.ts boot order and start() options, process guards and shutdown, every eden.json key with default and validation, providers/api-keys/scenarios, VillageLauncher, VillageLoop, .eden-data layout, env vars, ports.
tags: [eden, boot, main.ts, config, eden.json, providers.json, scenarios, village-launch, process-guards, data-dir, env, ports, pm2]
sources: [eden/src/main.ts, eden/src/config.ts, eden/src/providers.ts, eden/src/scenario-loader.ts, eden/src/village-launch.ts, eden/src/logger.ts, eden/eden.example.json, eden/providers.example.json, eden/api-keys.example.env, eden/scenarios/farm.json, eden/scenarios/farming-hamlet.json, eden/scenarios/mining-crew.json, eden/scenarios/trading-post.json, eden/roles.json, eden/start.ps1, eden/.gitignore, eden/package.json, eden/src/bots/pool.ts, eden/src/bots/anchors.ts, eden/src/journal/journal.ts, eden/src/skills/library.ts, eden/src/villagers/memory.ts, eden/src/villagers/subscriptions.ts, eden/src/llm/client.ts, src/main/java/com/paul/brawl/VillagersCommand.java, src/main/java/com/paul/brawl/VillageConfig.java, src/main/java/com/paul/brawl/EdenRetry.java]
verified_at: 98cb908
---

# Eden — process, configuration and boot

**TL;DR.** `tsx src/main.ts [eden.json]` calls `start(configPath, { spawnBots: true, installProcessGuards: true })`.
`start()` loads `eden.json` (JSONC), resolves the named `provider` (from `providers.json` + `api-keys.env`) and
`scenario` (from `scenarios/<name>.json`), opens `.eden-data/eden.db`, arms the lag monitor, replays the views, wires
God + villagers, restores God's snapshot, starts the admin server on `127.0.0.1:<admin.port>` (8770), and journals `system.boot` last. Bots do not connect at
boot; they connect when the in-game `/villagers start <scenario>` POSTs to `/scenario/start`. Unknown config keys
warn; duplicate villager names, a villager named like the avatar, or a bad `settlement.reach` throw. A direct
boot also installs SIGINT/SIGTERM shutdown handlers.

## Entrypoints

| Command | What runs | Source |
|---|---|---|
| `npx tsx src/main.ts eden.json` (cwd `eden/`) | `start(argv[2] ?? 'eden.json', { spawnBots: true, installProcessGuards: true })`; on success `installShutdownHandlers(() => host.stop())`; on rejection logs `boot FAILED: …` and sets `process.exitCode = 1`. | `eden/src/main.ts:1593-1605` |
| `eden/start.ps1` | `Set-Location $PSScriptRoot; npx tsx src/main.ts eden.json` — nothing else. | `eden/start.ps1` |
| pm2 | Docs say the host runs under pm2 with `ecosystem.config.cjs` beside `eden.json`. | — |

> ⚠ Unverified: `ecosystem.config.cjs` is gitignored (`eden/.gitignore:11`) and not present in this checkout, so the
> pm2 configuration (name, restart policy, cwd, env) cannot be checked. `api-keys.example.env` notes pm2 needs
> `--update-env` to pick up exported keys.

## `start()` options (`EdenHostOptions`, `eden/src/main.ts:58-93`)

| Option | Type | Default | Effect |
|---|---|---|---|
| `dataDir` | string | `'.eden-data'` (relative to cwd) | Where `eden.db` and all per-bot/library state live. |
| `spawnBots` | boolean | `false` | Build a `BotPool` (only if the roster is non-empty). Direct boot sets `true`. |
| `autoSpawn` | boolean | `false` | Call `pool.start()` at boot instead of waiting for `/villagers start`. Used by the live-test harness. Launcher stays unarmed, so no `/spreadplayers`/`/give`. |
| `enableGod` | boolean | `= spawnBots` | Run `wireGod` (desks, brain, coordinator, reactivity) and D-09 recovery. |
| `installProcessGuards` | boolean | `false` | Install `uncaughtException` / `unhandledRejection` handlers that journal and survive. Tests must not set it. |
| `serveWeb` | boolean | `= spawnBots` | Serve `eden/website/` as the admin static root (resolved via `new URL('../website/', import.meta.url)`). |

Returned `EdenHost` (`eden/src/main.ts:96-109`): `adminPort` (actually-bound port), `config` (post-scenario,
post-provider), `journal`, `coordinator?`, `god?` and `tools?` (the `ToolRegistry`; all three present only when
God is wired), `stop()`.

## Boot sequence (exact order, `eden/src/main.ts:116-509`)

| # | Step | Line(s) | Notes |
|---|---|---|---|
| 1 | `loadConfig(configPath, w => warnings.push(w))` | 120-121 | Throws on unreadable file, bad JSON, R12 identity violation, bad `settlement.reach`. |
| 1a | If `config.provider`: `loadEnvFile(<configDir>/api-keys.env)`, `loadProviders(<configDir>/providers.json)`, `resolveProvider` → replace `llm.providers` + set `apiKeyEnv` | 125-138 | Missing `providers.json` or unknown name throws. |
| 1b | If `config.scenario`: `applyScenario(config, loadScenario(<configDir>/scenarios/<name>.json))`, then `assertIdentity` again | 142-149 | Re-check needed because `parseConfig` only saw the pre-scenario roster. |
| 2 | `mkdirSync(dataDir)`, `new Journal(<dataDir>/eden.db)`; each warning → `logger.warn('config', w)` + `system.config-warning` (actor `engine`) | 152-157 | |
| 3 | `createLagMonitor(journal).start()` | 160-161 | 60 s sample interval (unref'd). |
| 4 | `installProcessGuards(journal)` if opted in | 167-168 | |
| 5 | Construct 5 views; replay one journal scan (all kinds but `vitals`) into them (B3.9), then `journal.subscribe` folds every appended event into each | 174-193 | Views carry the whole history. |
| 6 | `new AnchorService(dataDir)` + `healAnchors` (heal a villager's anchors `ANCHOR_SETTLE_MS` = 10 s after spawn, if the same bot is still connected) | 206-220 | B3.6. |
| 7 | Build `BotPool` iff `spawnBots && villagers.length > 0` | 226-245 | `worldId = host:port`; `vitalsIntervalMs = vitalsIntervalSeconds*1000`; `onBotSpawn` → reactivity attach + launcher setup + `healAnchors`. |
| 8 | `wireGod(...)` iff `enableGod` (gets `homeOf` = the healed home anchor) | 248-251 | Throws if the provider declares `apiKeyEnv` and that env var is empty (R56, lines 563-572). |
| 9 | 30 s `setInterval` → `reactivity.tick()` + `drives.tick()` (unref'd) iff reactivity exists | 256-262 | |
| 10 | `persistGodState(...)`: restore God's snapshot (same `worldId` only), then save 250 ms after any `god.*` event or any event tagged with a `rolloutId` (so an in-flight rollout is saved before its first verdict) | 271 | B3.9; defined at 951-997. |
| 11 | `wiring.god.recoverRollouts()` (D-09) | 272-275 | Logs `boot recovery: re-enqueued N …` if N>0. |
| 12 | `new VillageLauncher({ pool, villagers, avatarName, scenarioName, dataDir, journal, resetVillager? })` | 281-297 | `resetVillager` (God wired only) = `memory.reset()` + `store.removeSelfAuthored(name)`. |
| 13 | `new VillageLoop(...)` iff God wired AND pool exists | 306-312 | Not started until `/scenario/start` succeeds. |
| 14 | `new AdminServer({...accessors, handlers})`, `await admin.start()` | 335-475 | Binds `127.0.0.1:<admin.port>`. |
| 15 | `journal.append('engine', 'system.boot', { config: redactSecrets(config) })`; log `Eden host up — admin on http://127.0.0.1:<port>` | 477-478 | Presence of `system.boot` = complete boot. |
| 16 | If `pool && autoSpawn`: `void pool.start()` | 486 | |

`redactSecrets` replaces with `'***'` the value of any key matching `/secret|passw(or)?d/i` or ending in `key`/`token`
(`/(key|token)$/i`). Budgets (`inputTokenBudget`, `dailyTokens`) and the env-var name `apiKeyEnv` stay readable
(bug #17 — the old `/key|secret|token|password/i` substring test masked them).

### `wireGod` construction order (`eden/src/main.ts:546-896`)

`ProviderRegistry` → API-key check → `LlmClient({ providers, journal, dataDir, debugPrompts, apiKey })` →
`LlmScheduler({ maxConcurrent, perVillagerCooldownMs })` → `BudgetTracker(god.budget.perDesk)` →
`EmbeddingsService({ backend: localBackend() })` → `SkillLibrary({ dataDir, journal, probationRuns })` →
`library.verifyHashes()` (quarantine a code file whose hash drifted) → `seedStockSkills(library)` (logs seeded /
unchanged / overridden) → `AllGranted` → `SkillEngine({ runDefaultTimeoutMs, stallSeconds, maxCallDepth,
autoQuarantineAfter, resolveBot: pool.bot, onTripwire })` → `SkillRetriever` → `MemorySummarizer(client)` →
`VillagerMemory` per villager → `VillagerInbox` per villager (a non-trade `tell` signals the reactive `inbox`
event) → `SettlementClient({ url, journal, token: $EDEN_SETTLEMENT_TOKEN })` → `TradeBook({ isVillager, reachFor
(pool only, reach = settlement.reach), notify })` + `tradeBook.closeOrphans()` → `ConversationTurner` →
`ConversationBook` (earshot 16 blocks) → `SubscriptionStore` → `ToolRegistry({ maxSkillLines, memoryFor, trade,
subscriptions, conversations })` → `ContextPackBuilder` → `Brain` → `GodService({ journal, library, inboxes,
describer: DescriptionPass })` → desk prompts (if `god.godPrompt`, appended as
`\n\n## Scenario instructions\n<godPrompt>` to each desk's `.md` prompt) → `Curriculum` (then force-assigned as
`god.ledger`, line 744) → `GodBody({ engine, journal, avatarName, embodiedVerdicts })` → `Orchestrator({ …, body })`
→ `CriticDesk({ batchMax: 3 })` → tripwire handler → roster map → exemplars (mortal stock skills with `exemplar`)
→ primitives (mortal non-exemplar stock skills as one-liners) → `snapshotFor` (live position/health/food/inventory
only) → `RolloutCoordinator({ …, body })` → (pool only) `seedRoleDefaults` per villager, reactive `wakeup` closure
(fast tier, k=8 skills, 5 memories; also the trade-offer wake-up), `vitalsFor`, `VillagerReactivity` (with
`scopeFor` → home anchor), and `wireDrives` iff `behavior.drives`.

## Process guards (`installProcessGuards`, `eden/src/main.ts:1531-1548`)

| Event | Action |
|---|---|
| `uncaughtException` | `logger.error('engine', 'host: uncaughtException survived — <msg>')` + `system.error { message, stack? }` (actor `engine`). No exit. |
| `unhandledRejection` | Same with `unhandledRejection`. No exit. |

Returns a detacher that `stop()` calls first. Purpose: an async throw from mineflayer's physics tick (e.g. a bad
pathfinder goal) would otherwise kill the whole host.

## Shutdown (`EdenHost.stop()`, `eden/src/main.ts:495-507`)

Order: remove process guards → `villageLoop.stop()` → clear 30 s reactivity tick → `reactivity.detach()` →
`await launcher.stop()` → `pool.stop()` → `lag.stop()` → `await admin.stop()` (terminates WS clients) →
`persister.flush()` + `persister.stop()` (last God snapshot) → `journal.close()`. A direct boot (`tsx src/main.ts`)
installs `installShutdownHandlers` (bug #17, `eden/src/main.ts:1562-1590`): the first
SIGINT/SIGTERM runs `host.stop()` once and then exits 0 (1 if stop throws); a second signal while stopping forces
`exit(1)`. `start()` itself installs nothing (tests never get a signal handler). A SIGKILL still relies on
crash-only persistence (synchronous journal writes, JSON files written on change).

## `VillageLoop` — the production pump (`eden/src/main.ts:1393-1492`)

| Constant | Default | Meaning |
|---|---|---|
| `connectPollMs` | 2000 | Poll interval while the villager's bot is not connected. |
| `settleMs` | 3000 | Wait once after (re)connect before the first proposal. |
| `turnDelayMs` | 1000 | Sleep after a task-producing turn (also the guaranteed macrotask yield). |
| `idleBackoffMs` | 5000 | Sleep after `runOnce` returned `undefined` or threw. |

One detached loop per villager (`villagers` = roster names; the avatar is not driven). `start()` is idempotent;
`stop()` bumps an epoch so a loop awaiting a long rollout exits at its next boundary; in-flight rollouts are not
awaited. All sleeps are unref'd timers. Wired to the launcher: start on successful `/scenario/start|restart`,
stop before `/scenario/stop|restart` and in `host.stop()`. Not started under `autoSpawn`.

## `RolloutCoordinator` (`eden/src/main.ts:1217-1381`)

- `runOnce({ trigger, villager? })`: if the villager has an open non-running task (`curriculum.nextOpenTaskFor`),
  re-run it (R70); else `curriculum.proposeTask({ trigger, villager, snapshot })`; `undefined` if nothing proposed.
- `assignAndRun(task, { trigger })`: `orchestrator.dispatch` (curriculum trigger mapped: `idle→idle-sweep`,
  `verdict-close→closed-task`, `critic-follow-up→verdict-follow-up`, `dawn→new-task`, else `admin`);
  `god.openRollout`; retrieve top-10 mortal skills for `task.goal` (minus exemplars) and top-6 memories once;
  then up to `task.maxRetries` iterations of strong-tier `brain.deliberate` with a density payload (draft code +
  last RunReport + last critique) → `god.fileTicket` → `critic.judge` → `god.routeVerdict`. Outcomes:
  converged (`route.rolloutClosed`), blocked (`verdict.blocked`: close task failed with
  `blocked-on-resource: …`, enqueue follow-up), or exhausted (`curriculum.noteExhausted`, R65). An admission or a
  quarantine verdict is also handed to `GodBody.deliverVerdict` (fire-and-forget). Revision history is always `[]`.
- Strong-tier context budget = `llm.providers.strong.inputTokenBudget` (default 48000 if not passed).

Deep behavior of the desks: [god.md](god.md); of the brain/context pack: [villager-runtime.md](villager-runtime.md).

## `eden.json` schema (`eden/src/config.ts`)

Parsing rules (`parseConfig`, `eden/src/config.ts:185-383`): the file is JSONC (`strip-json-comments` with
`trailingCommas: true`). A value of the wrong JS type silently falls back to the default (`num`/`bool`/`str`
helpers, lines 171-182). Every unknown key adds `config: unknown key <section>.<key> ignored (R22)`. Warnings are
journaled as `system.config-warning` at boot. Only identity violations and a bad `settlement.reach` throw.

### Top level

| Key | Type | Default | Validation / notes |
|---|---|---|---|
| `minecraft` | object | see below | |
| `scenario` | string | `undefined` | Bare name → `<configDir>/scenarios/<name>.json`. If both `scenario` and `villagers` are set, warns `"scenario" takes precedence`. |
| `provider` | string | `undefined` | Name in `<configDir>/providers.json`. If set, `llm.providers` is ignored with a warning. |
| `villagers` | array | `[]` | Warns `no villagers array — defaulting to empty` if absent and no scenario. |
| `god`, `behavior`, `llm`, `skills`, `settlement`, `admin`, `journal` | object | see below | |
| `apiKeyEnv` | — | — | Not an input key (it is in `EdenConfig` but filled from the provider preset; writing it into the file triggers an unknown-key warning). |

### `minecraft`

| Key | Type | Default | Notes |
|---|---|---|---|
| `host` | string | `'127.0.0.1'` | Also part of `worldId = host:port` (memory world-stamp). |
| `port` | number | `25599` | The dev server port; production is 25565 — read `run/server.properties` (R28). |
| `version` | string | `'1.21.1'` | Any other value warns `!= pinned 1.21.1 (R11)`. |

### `villagers[i]` (inline roster)

| Key | Type | Default | Notes |
|---|---|---|---|
| `name` | string | `villager<i>` | Must be unique and differ from `god.name` (throws, R12). |
| `role` | string | `'villager'` | Selects `roles.json` reflex block (`everyone` + role). |
| `persona` | string | unset | Parsed but unused by the host (see Gotchas). |
| `items` | `{id, count}[]` | unset | `count` default 1; entries with empty `id` dropped. Given via `/give` at `/villagers start`. |

Other keys (e.g. `home`, `chest`) warn as unknown.

### `god`

| Key | Type | Default | Notes |
|---|---|---|---|
| `name` | string | `'Dieu'` | Avatar username; `LLMBot` warns (v1 reserved). |
| `gamemode` | string | `'creative'` | Not read by host code. |
| `authoring` | `'villager'｜'god'` | `'villager'` | Anything but `'god'` → `'villager'`. Not read by host code. |
| `desks.critic.model` | `'strong'｜'fast'` | `'strong'` | Anything but `'fast'` → `'strong'`. |
| `desks.curriculum.model` | same | `'strong'` | |
| `desks.orchestrator.model` | same | `'fast'` | |
| `budget.perDesk.<desk>.dailyTokens` | number｜null | `null` | Non-number → `null` (uncapped). |
| `budget.degradeOnBreach` | boolean | `true` | Passed to each desk. |
| ~~`combineDesks`~~ | — | — | Removed (D-19); an unknown key now. |
| `embodiedVerdicts` | boolean | `true` | Passed to `GodBody`: deliver admissions/quarantines in person. |
| `godPrompt` | string | unset | Appended to all three desk prompts; also sets `hasMissionDirective` on Curriculum. |

### `behavior`

| Key | Type | Default | Notes |
|---|---|---|---|
| `drives` | boolean | `false` | `true` (with a live pool) → `wireDrives`: one `DriveTracker` per villager, ticked every 30 s; a depleted rest/social drive wakes the villager once (B3.7). |

### `llm` (aliases: `maxConcurrency`→`maxConcurrent`, `perVillagerCooldownSec`→`perVillagerCooldownSeconds`, each with a deprecation warning)

| Key | Type | Default | Notes |
|---|---|---|---|
| `providers.strong` | `{baseUrl, model, inputTokenBudget}` | `{'', '', 48000}` | Overwritten when `provider` is set. |
| `providers.fast` | same | `{'', '', 16000}` | |
| `maxConcurrent` | number | `3` | Global LLM concurrency cap. |
| `perVillagerCooldownSeconds` | number | `15` | Scheduler per-villager cooldown (×1000 ms). |

Reserve-floor warning (D-11/R47, lines 364-374): warns if
`providers.strong.inputTokenBudget < 2 × maxSkillLines × 12 + 8000` (= 17 600 with defaults). It is evaluated on the
inline `llm.providers` before provider resolution, so with `provider` set and no inline block it checks the 48000
default, not the preset.

### `skills`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `runDefaultTimeoutMs` | number | `120000` | Per-run wall-clock cap. |
| `stallSeconds` | number | `20` | No-pulse abort. |
| `maxCallDepth` | number | `8` | Composition depth cap. |
| `maxSkillLines` | number | `400` | `write_skill` size cap. |
| `probationRuns` | number | `3` | Clean runs before probation → active. |
| `autoQuarantineAfter` | number | `5` | Consecutive-failure tripwire. |

### `settlement`, `admin`, `journal`

| Key | Type | Default | Notes |
|---|---|---|---|
| `settlement.url` | string | `'http://127.0.0.1:8767/trade/execute'` | Java settlement listener. |
| `settlement.reach` | number | `8` | R33: on accept the partner walks until the bots are this close. Must be > 0 and < `maxTradeDistance`, or `parseConfig` throws (B4). |
| `settlement.maxTradeDistance` | number | `16` | Must equal the mod's `maxTradeDistance` (`village_config.properties`); Eden cannot read that file. Only used to validate `reach`. |
| `admin.port` | number | `8770` | `0` = ephemeral (tests). |
| `journal.vitalsIntervalSeconds` | number | `10` | Alias `vitalsIntervalSec`. Warns if `< 5`. |
| `journal.debugPrompts` | boolean | `false` | Write `.eden-data/llm/<callId>.json` per LLM call. |
| `journal.retentionDays` | — | `7` (hardcoded) | Not an accepted key (known list is `vitalsIntervalSeconds`, `debugPrompts`); no pruning code exists. |

## `providers.json` (`eden/src/providers.ts`, template `eden/providers.example.json`)

Root: object of named presets; each `{ strong: ProviderConfig, fast: ProviderConfig, apiKeyEnv: string｜null }`.
Missing tier fields default to `''`/`''`/48000 (strong) or 16000 (fast). Non-object root/entry throws.
Unknown name throws `providers: unknown provider "<n>" — available: …`.

| Preset (example file) | strong | fast | `apiKeyEnv` |
|---|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1`, `deepseek-reasoner`, 48000 | `deepseek-chat`, 16000 | `DEEPSEEK_API_KEY` |
| `openai` | `https://api.openai.com/v1`, `gpt-4o`, 48000 | `gpt-4o-mini`, 16000 | `OPENAI_API_KEY` |
| `local` | `http://127.0.0.1:1234/v1`, `your-model-name`, 32000 | same URL, 16000 | `null` |

## Environment variables and `api-keys.env`

| Variable | Read by | Behavior |
|---|---|---|
| `<preset.apiKeyEnv>` (e.g. `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`) | `wireGod` (`eden/src/main.ts:563-572`) | Required when the preset names one; empty → boot throws (no fallback, R56). |
| `OPENAI_API_KEY` | `LlmClient` default (`eden/src/llm/client.ts:224`) | Used only when `apiKey` was not passed (i.e. no `provider`, or a `null` `apiKeyEnv`). Sent as `Authorization: Bearer` only to non-local base URLs (`eden/src/llm/client.ts:273-275`). |
| `EDEN_SETTLEMENT_TOKEN` | `wireGod` → `SettlementClient` (`eden/src/main.ts:642`) | Sent as `X-Village-Token` when the mod sets `settlementToken`; never read from `eden.json`. |
| `EDEN_LIVE_RUNDIR`, `EDEN_LIVE_PROVIDER` | `live-tests/run-one.ts` | Set by the live-test parent for each child. |

`api-keys.env` (`eden/api-keys.example.env`): `KEY=value` lines, `#` comments; loaded by `loadEnvFile`
(`eden/src/providers.ts:65-76`) from the directory of `eden.json`, only when `provider` is set. Existing env vars win.

## Scenarios (`eden/src/scenario-loader.ts`, `eden/scenarios/*.json`)

Shape: `{ name, description, god?: { name?, embodiedVerdicts?, authoring?, godPrompt? },
villagers: { <username>: { role, persona?, items?: [{id,count}] } } }`. `loadScenario` (JSONC, no trailing commas)
throws on missing file / bad JSON; unknown keys are ignored silently. `applyScenario` replaces `villagers`, sets
`scenario` to the file's `name`, and shallow-merges `god`. It also computes `setupCommands`
(`give <name> <id> <count>`), which nothing in `src/` uses (the launcher issues its own `/give`).

| File | `name` | God overrides | Villagers (role) and items |
|---|---|---|---|
| `farm.json` | `farm` | embodiedVerdicts true, authoring villager, long `godPrompt` teaching 4 skills in order (till-and-sow, reap-mature, bake-bread, store-bread) | `Harry` (farmer): iron_hoe×1, wheat_seeds×32 |
| `farming-hamlet.json` | `farming-hamlet` | same flags, `godPrompt` on food security; Bertrand defensive | `Firmin` (farmer): iron_hoe, wheat_seeds×32, bread×10; `Margot` (farmer): iron_hoe, carrot×16, potato×16, bread×10; `Bertrand` (guard): iron_sword, iron_chestplate, iron_helmet, cooked_beef×5 |
| `mining-crew.json` | `mining-crew` | same flags, no `godPrompt` | `Gaspard` (miner): iron_pickaxe, iron_shovel, torch×64, bread×10; `Céleste` (miner): iron_pickaxe, torch×64, bread×10, bucket; `Honoré` (crafter): crafting_table, furnace×2, coal×32, bread×10 |
| `trading-post.json` | `trading-post` | embodiedVerdicts false, authoring god | `Théodore` (merchant): gold_ingot×20, emerald×10, paper×16, bread×15; `Aurélie` (crafter): anvil, iron_ingot×32, iron_pickaxe×2, iron_sword×2, bread×10; `Rodolphe` (guard): iron_sword, iron_chestplate, iron_leggings, shield, cooked_beef×5 |

`eden.example.json` boots `"scenario": "farming-hamlet"`, `"provider": "openai"`.

## `VillageLauncher` (`eden/src/village-launch.ts`)

| Method | Behavior |
|---|---|
| `start(name, cx, cz)` | Guard: no pool → `{ok:false, 'no village configured — set "scenario" (or villagers) in eden.json and reboot'}`; booted scenario ≠ `name` → `{ok:false, 'booted scenario is "<s>", not "<name>" — runtime scenario switching needs a reboot'}`. Already running → `{ok:true,'village already running'}`. Else arm `{cx,cz,clear:false}`, `void pool.start()`, return `{ok:true, 'village started (N villager(s))', botNames}`. |
| `stop()` | No pool or not running → `{ok:true,'no village running'}`; else `pool.stop()`, disarm, `{ok:true,'village stopped'}`. |
| `restart(name, cx, cz)` | Guard as start; stop pool if running; `rmSync(<dataDir>/bots/<v>.json)` + `resetVillager(v)` for every villager; arm `{cx,cz,clear:true}`; `void pool.start()`; `'village restarted (N villager(s))'`. |
| `onSpawn(name, bot)` | Skip if disarmed, the avatar, unknown, or already set up this (re)start. After `spawnDelayMs` (1500 ms default) the bot chats `/spreadplayers <cx> <cz> 2 10 false <name>`, then `/clear <name>` (restart only), then `/give <name> <id> <count>` per item. Requires the bot to be op'd (Java op-on-join). |

The scenario guard is skipped when `scenarioName` is undefined (inline `villagers` config): any name is accepted.
The Java side sends `{ name, x, z }` (integer player position) with a 10 s timeout (`VillagersCommand.java:118-136`),
retrying a transient failure up to 3 times 750 ms apart; `restart` is retried only when the connection was refused
(`EdenRetry.isIdempotent`, `EdenRetry.java:24-26`). `VillageConfig.edenAdminUrl` defaults to `http://127.0.0.1:8770`
(`VillageConfig.java:53`). `refusal(name)` exposes the same guard message for the admin's pre-journal check.

## Data directory layout (`.eden-data/`, gitignored)

| Path | Writer | Content |
|---|---|---|
| `eden.db` (+ `-wal`, `-shm`) | `Journal` | Two tables: `journal` (append-only events) and `snapshots` (God's working state under key `god`) ([journal-and-views.md](journal-and-views.md)). |
| `world.json` | `stampWorldId` (`eden/src/bots/pool.ts:362-372`) | `{ worldId, stampedAt }`; mismatch only logs a warning. |
| `library/<skill>/skill.json` | `SkillLibrary.persist` (`eden/src/skills/library.ts:395-400`) | The skill record (versions, statuses, manifests). |
| `library/<skill>/v<N>.js` | `SkillLibrary.writeCode` | Source per version, append-only. |
| `bots/<name>.json` | `VillagerMemory.persist` (`memory` key), `AnchorService` (`anchors` key, `eden/src/bots/anchors.ts:174-188`) | Memory window/archive/relations/life summary + `worldId`; home/chest anchors. |
| `subscriptions/<villager>.json` | `SubscriptionStore` (`eden/src/villagers/subscriptions.ts:151-155`) | Persisted subscriptions; deleting it re-seeds role defaults on next boot. |
| `llm/<callId>.json` | `LlmClient.dumpTranscript` (`eden/src/llm/client.ts:340-344`) | `{ request, response }` body (no headers), only when `debugPrompts`. |

Other gitignored paths: `.eden-data*/`, `.eden-eval-data/`, `eden.json`, `providers.json`, `api-keys.env`,
`ecosystem.config.cjs`, `logs/`, `*.log`, `*.db`, `dist/`, `coverage/`, `.smoke/`, `live-tests/.runs/` (`eden/.gitignore`).

## Ports

| Port | Owner | Eden's role |
|---|---|---|
| 8770 | Eden admin (`admin.port`) | Listens, `127.0.0.1` only. |
| 8767 | Java settlement listener | Client (`settlement.url`); `./gradlew runServer` also binds it (R29). |
| 25599 / 25565 | Minecraft dev / production | Bot client (`minecraft.port`). |
| 8765 / 8766 | v1 unified bridge / v1 village admin | Reserved; Eden never binds them. |

## Logger (`eden/src/logger.ts`)

`logger.line|info|warn|error(actor, msg)` → `console.log|warn|error` as `[HH:MM:SS.mmm] <actor>  <msg>`; warn/error
prefix `WARN ` / `ERROR `. ESLint `no-console: error` everywhere except `src/logger.ts`, `tests/**`, `website/**`.

## Gotchas & known issues

- Scenario personas never reach prompts: the roster persona is hardcoded (`eden/src/main.ts:754`).
- ~~`/villagers restart` deletes `bots/<name>.json`, but the live `VillagerMemory` keeps its window in RAM and
  rewrites the file~~ **Fixed (bug #16):** after deleting the file the launcher calls `resetVillager(name)`, which
  `main.ts` wires to `VillagerMemory.reset()` (clears window, archive, relations, summary, R32 quarantine; an
  in-flight summary of the old life is dropped) and `SubscriptionStore.removeSelfAuthored(name)` (self-authored
  subscriptions go) then `resetRoleDefaults` (the full current role defaults come back, including any the villager had
  unsubscribed — review fix; God/admin ones stay). Pinned through `start()` in `tests/main-full-wiring.test.ts`.
  **Still open:** work already in flight when the restart lands (a deliberation's `remember`, a conversation that ends
  just after, a trade notice) can still write the old life into the new memory — `reset()` guards only its own
  in-flight summary.
- ~~`redactSecrets` masks `inputTokenBudget` and `apiKeyEnv`~~ Fixed (bug #17), see above.
- ~~Views are only fed live~~ — replayed at boot since B3.9.
- `GodService` gets a `DescriptionPass` describer (B3.4); its ledger is injected by a cast
  (`(god as unknown as { ledger: Curriculum }).ledger = curriculum`, line 744).
- ~~D-09 recovery runs on an always-empty `GodState`~~ — the God snapshot is restored first (B3.9).
- `eden.example.json` comment says `scenarios/<name>.json` is gitignored; it is not (four scenarios are tracked).
- ~~No signal handlers~~ — a direct boot stops gracefully on SIGINT/SIGTERM (bug #17).

## Related

- [overview.md](overview.md) · [journal-and-views.md](journal-and-views.md) · [admin-api.md](admin-api.md) · [testing-eval-live.md](testing-eval-live.md)
- [god.md](god.md) · [villager-runtime.md](villager-runtime.md) · [villager-memory.md](villager-memory.md) · [llm-and-scheduling.md](llm-and-scheduling.md) · [bots-and-hardening.md](bots-and-hardening.md)
- [java-integration.md](java-integration.md) · [../reference/ports-files-config.md](../reference/ports-files-config.md)
