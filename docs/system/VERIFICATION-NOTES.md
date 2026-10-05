---
id: verification-notes
title: Verification notes — where existing docs disagree with the code, and bugs found
system: meta
summary: Every place CLAUDE.md, README, docs/*.md or code comments contradict the code at 4a8081f, plus a ranked list of real bugs and sharp edges found during verification.
tags: [verification, discrepancies, errata, bugs, known-issues, claude.md, stale-docs]
sources: [CLAUDE.md, README.md, eden/CLAUDE.md, docs/README.md, src/main/java/com/paul/brawl/VillageHttpListener.java, src/main/java/com/paul/brawl/TradeOffers.java, src/main/java/com/paul/brawl/TradeMath.java, eden/src/social/trade.ts, eden/src/main.ts]
verified_at: 4a8081f
---

# Verification notes

**TL;DR** — The whole corpus was written by reading the code, then re-audited citation by citation. This file lists
(1) every claim in the existing docs that the code contradicts and (2) the bugs and sharp edges found along the way,
ranked. The biggest themes:
- Several Eden features documented as live are **constructed in tests only**.
- The Eden→Java **trade settlement** was never called and sent the wrong JSON shape (bug #1). Both are fixed: villagers trade through `propose_trade`/`answer_trade`, and the body matches the listener.
- The CI workflows **don't exist in the repo**.
- A handful of Java exploits let players **duplicate items or coins** (the two trade paths, #2 and #3, are fixed).

Citations are `path:line` at `4a8081f`.

## 1. Ranked bugs and sharp edges

| # | Sev | Area | Finding | Evidence |
|---|---|---|---|---|
| 1 | ~~High~~ Fixed | Eden ↔ Java | ~~**Settlement contract mismatch.** Eden POSTs `{from,to,give,want}`; the Java listener requires `{botA,botB,aGives,bGives}` and answers 400 `missing botA`. The client is never wired, and `TradeService` is never constructed.~~ **Fixed.** Shape: `toSettlementRequest` maps `from→botA, to→botB, give→aGives, want→bGives` (coin → `paulsbrawls:coin`), pinned by a test and by `FakeSettlement` running the Java shape check (incl. the case-insensitive same-party check). Wiring: `main.ts` builds one `SettlementClient` (sending `X-Village-Token` from `EDEN_SETTLEMENT_TOKEN` when set) and a `TradeBook` injected into the villager tools `propose_trade`/`answer_trade`/`list_trades`; an offer settles only when the partner accepts, only between roster villagers, after an R33 walk. **Still open:** no live `:8767` smoke trade yet; `Conversation` is still unwired. | `eden/src/social/trade.ts`, `eden/src/villagers/tools.ts`, `eden/src/main.ts:552-593`, `VillageHttpListener.java:76-81,176-181`, [eden/social-and-trade.md](eden/social-and-trade.md) |
| 2 | ~~High~~ Fixed | Java settlement | ~~**Item duplication.** Duplicate item lines are each validated against the whole inventory: with 15 coins, two lines of 10 pass, 15 are removed and 20 created.~~ **Fixed:** lines are summed per item before validation, and validation and removal use the same totals in one main-thread task. The real stacks now move (damage, enchantments and names survive). Only the 36 main/hotbar slots count (no armour or offhand). Partial-insert overflow, which was silently deleted, now drops. The parties must share a dimension and be within `maxTradeDistance` (16). An optional `settlementToken` header check exists, off by default. **Still open:** any two nearby online players, humans included, can be swapped by a local caller unless the token is set. | [eden/java-integration.md](eden/java-integration.md), `VillageHttpListener.java:214-317`, `TradeMath.java` |
| 3 | ~~High~~ Fixed | AI God trades | ~~**Negative `Trade.takeAmount` duplicates items** on `/accept`.~~ **Fixed:** both amounts must be 1–512. This is checked at tool execution, in `updateOffer` and again on `/accept`, and `planTakes` rejects a non-positive need. Items are matched by registry item, not display name. Offers expire after 5 minutes. | [aigod/actions-and-trades.md](aigod/actions-and-trades.md), `TradeOffers.java:56-159` |
| 4 | ~~High~~ Fixed | Eden tests | ~~`npm test` / `npm run check` **fail on a clean checkout**: `tests/live-tests-catalogue.test.ts` loads the gitignored `eden/providers.json`.~~ **Fixed:** `baseConfig` takes the provider presets as an argument and the catalogue test injects the committed `providers.example.json`. Also fixed in the same phase: 28 tests were *cancelled* on Node 22 because they awaited promises only `unref()`'d timers resolve (R73); those files now hold the loop per test (`tests/fakes/keep-alive.ts`). | [eden/testing-eval-live.md](eden/testing-eval-live.md) |
| 5 | ~~Med~~ Fixed | AI God body | ~~`/godbody off` and server shutdown **leave the avatar invulnerable**: `restoreAvatar` is never queued, and the NBT flag persists.~~ **Fixed:** both paths are on the server thread and call `ChatBotActions.restoreAvatarOnMain(server)` directly after clearing the queue. In-game check only. | `ChatCommand.java:62-73`, `ServerEntryPoint.java:51-56` |
| 6 | ~~Med~~ Fixed | AI God | ~~`Reward`/`Punishment` amounts and `SpawnCreature` offsets are **unclamped** (e.g. mass lightning in one tick). `Reward`'s advertised item-component syntax always fails because `getItemFromString` splits on `:`.~~ **Fixed:** `GodClamps` applies new `BridgeConfig` maxima (`rewardMax` 64, `punishmentMax` 3, `spawnOffsetMax` 16); `Reward` parses like `/give` (components kept, namespace optional, overflow dropped); `getItemFromString` uses `ItemIds.baseId`. Clamps and id parsing unit-tested; the in-world effect needs an in-game check. | [aigod/actions-and-trades.md](aigod/actions-and-trades.md) |
| 7 | ~~Med~~ Fixed | Building | ~~Text-mode block placement (`PlaceBlock`…) calls `setBlockState` **off the main thread**, including from parallel build sub-agents. Sub-builds have no cancel path and no cap.~~ **Fixed:** each matched call is one `GodActionQueue` task (awaited, 30 s bound); `BuildGuard` caps sub-agents at 4 server-wide and a call at 128 blocks; `/godbody off` and server stop cancel running sub-builds. Caps unit-tested (`BuildGuardTest`); the thread hop needs an in-game check. | `ChatBotFunctions.java` (`scanAndExecute`), `BuildSubAgent.java`, `BuildGuard.java` |
| 8 | ~~Med~~ Fixed | AI God body | ~~The idle watchdog resets only on claim, `Appear` and `Wait`, so a long chain of other tool calls (e.g. slow MCP) is killed mid-chain after ~90 s and memory is wiped. MCP tools have no session-ownership gate. `fireGestures` checks only the global `hasManifested`.~~ **Fixed:** the owner's watchdog resets around every tool dispatch; MCP tools refuse a non-owner or a disabled bridge (`GodToolGate`, unit-tested); `fireGestures` requires ownership. In-game check for the wiring. | [aigod/god-body.md](aigod/god-body.md) |
| 9 | ~~Med~~ Fixed | Client | ~~**`/prove` cannot run**: `.executes` hangs off the literal, not the argument. `/build` uploads a screenshot the server then discards (`buildBot.hasImage=false`).~~ **Fixed:** `.executes` sits on a `greedyString()` argument for both commands; `buildBot.hasImage=true`; the image is labelled by `ImageMime.sniff` (PNG, not `image/jpeg`); `img2` is closed. MIME sniffing unit-tested; the commands need an in-game check. | `Screenshotter.java`, `ChatBot.java`, `ImageMime.java` |
| 10 | Med | Gibber | `giveItemStack`'s result is ignored and the player is marked paid anyway, so coins that don't fit are lost. Other edges: int overflow, negative `/gib`, and every new player or bot receives the full historical total. | [gibber/money-system.md](gibber/money-system.md) |
| 11 | ~~Med~~ Fixed | CTF | ~~A Flag in the **offhand or armour slots** bypasses every rule, because only `inventory.main` is scanned. The per-tick `setGlowing(false)` clobbers glowing from other sources.~~ **Fixed:** `findFlags` scans main + armour + offhand (and every Flag drops on a hit); `FlagGlow` clears only a glow the mod set (`FlagGlowTest`). Still by design: any environmental damage drops the flag. | `FlagManager.java`, `FlagGlow.java` |
| 12 | ~~Med~~ Fixed | Eden skills | ~~Stock skills are **re-seeded as a new version on every boot** (37 new versions and 37 `skill.draft` rows each time), shadowing admitted overrides.~~ **Fixed:** `seedStockIfChanged` appends only when the code hash or seed manifest differs from the newest stock version, and returns `overridden` (logged, not seeded) when a live non-stock version is newer. Pinned by a two-boot test through `start()`. **Still open:** overriding a stock name breaks every skill that composes it until probation passes (D-12 by design). | `eden/src/skills/library.ts` (`seedStockIfChanged`), `eden/src/main.ts` (`wireGod`) |
| 13 | ~~Med~~ Fixed | Eden skills | ~~**Aborted skill code keeps running** after timeout, stall or preempt (`Promise.race`), so the next tree can start on the same body (breaks D-05).~~ **Fixed:** an abort fences the tree (its next loop iteration, `await` or composition throws) and the root holds the bot until the code settles, bounded by `abortSettleMs` (1 s). ~~Skill names are not sanitised as directory names (`/` nests, `..` escapes `library/`).~~ **Fixed:** `upsertDraft` rejects `/`, `\`, `..`, a leading `.`, `:` and control characters with a named `InvalidSkillNameError`. | [eden/skills-engine.md](eden/skills-engine.md), [eden/skills-library.md](eden/skills-library.md) |
| 14 | ~~Med~~ Fixed | Eden skills | ~~`use-chest` / `smelt-item` call `pauseMutators` before the `try`, so a failed open leaves auto-eat and armor-manager **disabled**.~~ **Fixed:** the pause and the open moved inside the `try`; the `finally` closes only an opened window and always resumes. Pinned by FakeBot tests whose open rejects. | [eden/stock-skills.md](eden/stock-skills.md) |
| 15 | Med | Eden | God state (ledger, dossiers, QA cache, directives) is **RAM-only**. Derived views are not replayed at boot, so admin stats forget all history on restart. D-09 recovery is a no-op. | [eden/god.md](eden/god.md) |
| 16 | Low → part fixed | Eden | ~~`/villagers restart` deletes `bots/<n>.json`, but live memory rewrites it and subscriptions survive.~~ **Fixed:** the launcher's `resetVillager` hook resets the live `VillagerMemory` and removes self-authored subscriptions. The request is retried on timeout although it is not idempotent. **Owner decision:** op'd villagers can run any `/` command. | [eden/java-integration.md](eden/java-integration.md) |
| 17 | ~~Low~~ Fixed | Eden admin | ~~Double journaling (quarantine, prompt). `/scenario/start` journals before its guard. `GET /journal` is uncapped. No SIGINT/SIGTERM handler. `redactSecrets` masks token budgets.~~ **Fixed:** the callee journals once with the admin's actor; a refused scenario start/restart 404s before any row; `GET /journal` defaults to 1000 and clamps at 10000; a direct boot stops gracefully on SIGINT/SIGTERM; `redactSecrets` masks only secret-valued keys. **Owner decision:** no auth (localhost-only by design, R24). | [eden/admin-api.md](eden/admin-api.md), [eden/process-config-and-boot.md](eden/process-config-and-boot.md) |
| 18 | Low | Java | Console NPEs: `/prompt`, `/block`, `/construction`, and `ChatMessageHistory` on console signed messages. `/mcp reload` blocks the server thread. `QueryTerrain` still has a TEMP chat echo. `getBlockInfo` emits malformed pseudo-JSON. | [aigod/llm-pipeline.md](aigod/llm-pipeline.md), [aigod/mcp-gateway.md](aigod/mcp-gateway.md) |
| 19 | Low | Ops | The RCON password is committed in plain text in `run/server.properties`. Op-on-join trusts usernames, which is exploitable in offline mode. | `run/server.properties:44` |

## 2. Repository-level discrepancies

| Claim (where) | Code reality |
|---|---|
| CI: `.github/workflows/ci.yml` and `eden-ci.yml` gate the build and upload releases (CLAUDE.md) | `.github` is gitignored (`.gitignore:1`) and absent from all of git history. No CI is defined in the repo. |
| `./gradlew build` etc. (CLAUDE.md) | `gradlew*` and `gradle/` are gitignored (`.gitignore:5-6`), so a clean clone has no wrapper. |
| Copy tasks at `build.gradle:117` (CLAUDE.md) | At `build.gradle:144-163`. |
| `build.gradle:43-47` comment: MCP uses `StdioMcpTransport` | `MCPGateway` uses `HttpMcpTransport` (`MCPGateway.java:16,219`). |
| `minecraft-mcp-server/` source is in the repo (CLAUDE.md, README) | Gitlink `c0e56f2` with **no `.gitmodules`**; the directory is empty. All Node-side claims (25 MCP tools, plugin list, bridge routes) are unverifiable here. |
| Hard-won lessons "R1–R61" (CLAUDE.md, eden/CLAUDE.md) | `docs/07` runs to R72; `pool.ts` cites R66. |
| "~400 tests" (CLAUDE.md) | 62 test files and ~530 `test(` call sites. |

## 3. Gibber, CTF, entrypoints

| Claim | Code reality |
|---|---|
| Salary defaults (CLAUDE.md: "ticks every `salary_period` (default 10), incrementing by `salary_per_day`") | `salary_per_day` defaults to **0**, so nothing is paid until `/gib_salary`. The first tick fires immediately (initialDelay 0). `SalaryScheduler.java:30-39,53-56,64` |
| "Banner named Flag" (README, CLAUDE.md) | Case-sensitive **substring** `contains("Flag")`, in main, armour and offhand slots (bug #11; it used to be `inventory.main` only). |
| `giveGoodReward` gives coin rewards | No callers (dead code), along with `giveBadReward`, `giveItemWithCommand`, `stripArguments`, `Prompts`, `PROMPT_STATE_KEY` and `ChatPrinter.broadcast`. |
| Mod features work in-game generally | Everything server-side is registered from a `DedicatedServerModInitializer`, so **singleplayer and LAN have none of it**. |
| "Villagers are never op'd" (CLAUDE.md, tier text) | Op-on-join ops `LLMBot`, `Dieu` **and every active scenario villager** (`ServerEntryPoint.java:61-74`); Eden needs it for `/spreadplayers`, `/clear` and `/give` (`eden/src/village-launch.ts:115-132`). |

## 4. AI God

| Claim | Code reality |
|---|---|
| `buildMessageList` prepends **three** SystemMessages | **Four** when context is needed: persona plus three context messages (`ChatBot.java:451-466`). |
| "Dedicated worker pool" / "only 4 workers" comment | Unbounded virtual-thread-per-task executor `llm-worker-N` (`LLMConfig.java:155-163`); the comment at `ChatBotFunctions.java:478-480` is stale. |
| World mutations use `GodActionQueue.submit(...).join()`, "blocks ~one tick" | `runOnMain` uses `.get(5, SECONDS)` and returns a French error string on timeout. Text-mode building now goes through the queue as well (bug #7, fixed). |
| Providers: OpenAI, LM Studio, Ollama | Also **Anthropic** (`AnthropicChatModel`, default model `claude-opus-4-8`, `ANTHROPIC_API_KEY`) (`LLMConfig.java:73,101-107`). |
| `OPENAI_API_KEY` is required | A non-empty `openai.apikey` in `llm_config.properties` wins over the env var; with neither, the provider *name* is sent as the key (`LLMConfig.java:170-182`). |
| `/llm model` switches model | Saved but not applied until `/llm reload` (`LLMCommand.java:190-196`). |
| `BuildPlan` is among the God's tools | Attached only to `buildBot` (`godBot.needsBuildPlan=false`, `ChatBot.java:147-148`). |
| "Nearby blocks via getBlockInfo" | Blocks around the admin-set `/construction` pivot only; empty for everyone else (`ChatBotActions.java:257-259`). |
| `Appear`/`Vanish` are gated on `isActive` (tool-list gating) | Always offered; the gate runs at execution and returns a French refusal (`ChatBotFunctions.java:105-107,127-129`). |
| `/prove` / `/build` attach "the JPEG" | ~~Bytes come from `NativeImage.getBytes()` (believed PNG) but are labelled `image/jpeg`. `/build`'s image is dropped, and `/prove` never runs.~~ Fixed (bug #9): the label is sniffed from the bytes; both commands run and attach the image. |
| `/godbody off` → `endPrayerSession` | Clears the queue, vanishes, `forceEndSession()`, disables the bridge, **no** `restoreAvatar` (`ChatCommand.java:62-73`). |
| Invulnerability restored "on every exit" | Not on `/godbody off` or `SERVER_STOPPING`. |
| Bridge `POST /vanish` has no body | Sends `{x,y,z}` = parking spot (`BotBridgeClient.java:75-80`). `GET /health` exists in the client but has no caller. |
| `idleTimeoutSeconds > waitMaxSeconds` is a fragile invariant | Enforced three ways: the watchdog uses `max(idle, waitMax+5)` (`GodSessionManager.java:123-124`); `waitmax` auto-bumps idle; `idle` rejects values ≤ waitMax. |
| Log line `MCP gateway start FAILED` | Actual: `MCP gateway connect failed (...); will retry in 30s.`, with automatic 30 s retry (`MCPGateway.java:246`). |
| `/mcp reload` refreshes everything | Reconnects and re-lists tools, but `mcp_config.properties` is read once at class init. `/mcp` and `/mcp status` are perm 0. |
| Op-on-join covers the avatar | Covers `LLMBot`, `Dieu` and the scenario roster. |
| `/construction`, `/block` live in `ChatCommand` | Registered in `ChatBotActions.java:162-195`. `/block` coordinates are pivot-relative. |
| `build_prompt.txt`: calls "execute in order" | All `PlaceBlock` calls run first, then `PlaceLine`, then `PlaceBlocks` (`ChatBotFunctions.java:607-613`). The "blocs placés" counts are call lines, not blocks. The repo-root and `run/` prompt copies differ, and `run/max_build_prompt.txt` is never loaded. |
| VERIFICATION.md 10b: `waitmax 60` bumps idle to ≥ 65 | Idle becomes `N+30` only if idle ≤ N (`LLMCommand.java:146-155`). |
| Tool counts: 22 (HIGHER_LEVEL_TOOLS.md) vs 25 (MCP_TOOLS_VERIFICATION.md) | Unverifiable (Node source absent). `verify-mcp-tools.mjs` tests the stdio entry, not the SSE endpoint the God uses. |

## 5. Eden ↔ mod integration

| Claim | Code reality |
|---|---|
| "Trade settles via `SettlementClient` POST to :8767" | ~~Never wired (bug #1).~~ Wired: an offer accepted through `answer_trade` is POSTed with the listener's body shape (and the token header when set). |
| `/village status|pause|resume` controls the village | Targets the **legacy v1** admin on :8766; Eden is controlled by `/villagers start|stop|restart` (missing from CLAUDE.md's command list) and `POST /pause|/resume` on :8770. |
| `VillagersCommand` loads `eden/scenarios/<name>.json` | Eden loads nothing on that call; `name` must equal the scenario Eden booted with, or 404 (`eden/src/village-launch.ts:143-152`). |
| `VillageConfig` can be tuned "without a restart" | Read once at class init; written only by `/village on|off`. |

## 6. Eden

### Persistence and observability
| Claim | Code reality |
|---|---|
| "SQLite is the spine: journal + library index + stats + ledger + directives + subscriptions" | The only table is `journal` (`eden/src/journal/journal.ts:50-65`). Library is `library/<skill>/skill.json` + `v<N>.js`; subscriptions and memory are JSON files; God state lives in RAM only. |
| Configurable 7-day retention for vitals / `subscription.fired` | `journal.retentionDays` is not parsed (always the hardcoded default 7, and setting it only triggers an unknown-key warning), and no pruning code exists. |
| Lag monitor logs debug at p99 ≥ 100 ms | Journals `system.loop-lag` only when max ≥ 1000 ms (`eden/src/journal/lag-monitor.ts:40-51`). |
| `npm run eval` is a mock-LLM run against a real server | **Dry run**: builds and validates 4 scenarios, logs the plan, connects nothing (`eden/eval/run.ts:96-109`). `mock-llm.ts` is unused by it. |
| pm2 via `ecosystem.config.cjs` | Gitignored and absent; `start.ps1` is just `npx tsx src/main.ts eden.json`. |
| `admin/` and `cli/` are imported only by `main.ts` | dependency-cruiser forbids *every* importer of `cli/`, including `main.ts`. render/ and views/ are also layer 1 though the header lists only journal/config/bots. |

### Skills
| Claim | Code reality |
|---|---|
| ~6 exemplars | 7 (go-to, mine-block, find-block, collect-blocks, craft-item, use-chest, deposit). |
| ~10 stock primitives; 5 divine skills | **37** stock skills: 28 mortal + 9 divine (appear-near, vanish, gesture, fly-to, summon-creature, smite, teleport-entity, give-items, set-weather). |
| Stall pulses include block place | No place event. Pulses: pathfinder events, dig start/complete, window open/close, a 500 ms position/inventory sampler, `ctx.log`, `sleep` (`eden/src/skills/engine.ts:534-567`). till-block, sow-seed and kill-mob don't pulse. |
| Stall raises `SkillStalledError('no progress')` | Outcome `{errorKind:'stalled'}`; `SkillStalledError` is the loop-budget error. |
| `SkillContext` has 5 fields | 8: `skills.run, log, signal, runner, depth, Vec3, goals, mcData`; `sleep` is a scope global. |
| Manifest-sanity step at write time | `write_skill` checks only the line cap and compile. |
| Probation = N critic re-judged runs | Counts clean root runs; failures don't reset it. |
| `autoQuarantineAfter` tripwire files critic tickets | `onTripwire` is never passed (`eden/src/main.ts:526-533`), so it is inert. |
| Descriptions are LLM-generated at admission | No describer is wired (`eden/src/main.ts:555`); the author's summary stays. |
| `verifyHashes` runs at boot; anchors snap `home`/`chest` hints | Neither is called. `home`/`chest` are not accepted config keys (`eden/src/config.ts:223`). |

### God
| Claim | Code reality |
|---|---|
| `combineDesks` cheap mode | Parsed, never read. Same for `god.authoring` and `god.gamemode`. |
| `embodiedVerdicts`: the avatar delivers critiques | `GodBody` instance discarded (`eden/src/main.ts:570`); `gesture` nod/sneak are no-ops. |
| "Interventions teach"; the critic voids divine-assisted success | The rail exists, but `intervene` is never called and `GodBody` lacks `runAction`. |
| QA cache persisted; warm-up is config | In-memory array; hardcoded `WARMUP_COMPLETED=8`. |
| Curriculum triggers (dawn, decompose…) | Only `idle` in production. |
| Daily caps reset at dawn; a breach warns | `resetDay()` never called; no breach journal. |
| God desk priority ordering in the scheduler | One FIFO `god` lane. |
| Critic tickets from tripwire, plea, second opinion | Only `source:'rollout'`. |
| D-11: revision history trimmed oldest-first | The coordinator always passes `history: []` (`eden/src/main.ts:957`). The 48k/16k budgets are real but bound only the initial pack. |
| Orchestrator sees runs and dossiers; directives expire | It sees trigger, task, event and open directives; the directive tool has no expiry. |

### Villagers and society
| Claim | Code reality |
|---|---|
| Event payload shapes (docs/04) | Differ: `byEntity`, not `attacker`; chat uses `player`/`villager`; etc. (`eden/src/types/events.ts:8-22`). |
| Edge events with hysteresis fire live | The live signal adapter forwards only health/death/hurt, plus a 30 s tick. Chat, entity-spotted, night-falls, new-day and inbox **never fire**. |
| Villager tools include `say`, `tell`, conversations, trade | 14 tools: search_skills, read_skill, write_skill, run_skill, report_to_god, done, remember, recall, subscribe, unsubscribe, list_subscriptions, and the trade tools propose_trade, answer_trade, list_trades. No `say`/`tell`/conversation tools. |
| `report_to_god` reaches critic/orchestrator queues | Result discarded. |
| Context pack carries recent events, mood, standing orders, config persona | §5 is always empty. The persona is hardcoded `Tu es ${name}, ${role} du village. Tu parles français.` (`eden/src/main.ts:579`). |
| `run_skill` has a `wait` arg | Params: `name, args, timeoutMs?`. |
| Villagers author their own subscriptions via `subscribe` | ~~The three subscription tools were stubs in the live host (`ToolRegistry` built before the store).~~ **Fixed:** `wireGod` builds the `SubscriptionStore` first and passes it as `subscriptions`; pinned through the composition root by `tests/main-full-wiring.test.ts`. |
| Subscriptions auto-disable on skill quarantine | `setEnabled` has no caller. |
| Drives tick per villager | `DriveTracker` never constructed; `behavior.drives` unused. |
| R32 world-stamp → admin `wipe|migrate` | No admin route; `resolveQuarantine` is never called. |
| Relations are journal-derived only | Stored in `bots/<name>.json` (clamped ±100); a separate unclamped `RelationsView` fold also exists. |
| `roles.json`: a duplicate role spec is skipped | It **replaces** (`eden/src/villagers/role-defaults.ts:78-82`). |
| Admin `tell` wakes the villager | Waits for the next rollout revision drain. |

## Related
- [00-overview.md](00-overview.md) · [README.md](README.md)
- [reference/commands.md](reference/commands.md) · [reference/ports-files-config.md](reference/ports-files-config.md)
