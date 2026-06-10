# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Fabric mod for Minecraft 1.21.1 (Java 21). Three loosely-coupled gameplay features bundled into one mod (`paulsbrawls`):

- **Gibber** — server-wide money system (a custom `coin` item) with admin gift commands and a periodic salary scheduler.
- **Capture the Flag** — auto-drops any banner named "Flag" when its holder takes damage, disables elytra while a Flag is carried, and makes flag-holders glow.
- **AI God** — LangChain4j-driven `Dieu` who hears prayers (`/pray`), trades, punishes, and rewards. **Has a physical body** since the God-Body integration: drives a Mineflayer bot (the avatar) over a Node HTTP bridge. Most player-facing strings are French.

There is also a vendored Node sub-project under [minecraft-mcp-server/](minecraft-mcp-server/) — a fork of yuniko-software's Mineflayer MCP server. The mod talks to it via a **unified** Node entrypoint (`src/unified/main.ts`) that runs ONE Mineflayer bot and serves both surfaces on one HTTP port:
- the bridge HTTP control endpoints (`/appear /chat /look /gesture /vanish /health`) — puppet the avatar
- the MCP-over-SSE endpoints (`/mcp/sse` + `/mcp/messages?sessionId=…`) — expose Mineflayer-driven tools (mine/place/move/craft/combat/collect/…) to the LLM

The bot auto-loads five Mineflayer plugins post-spawn (`pvp`, `auto-eat`, `armor-manager`, `collectblock`, `tool`) — see §"MCP toolkit + Mineflayer plugins" below for the split between LLM-callable tools and autonomous behaviours.

The standalone `src/main.ts` (MCP stdio) and `src/bridge/main.ts` (bridge HTTP only) entrypoints are kept as a rollback path. **Do not run the unified entrypoint alongside either standalone one with the same `--username`** — Minecraft will kick the second login.

## Build / run commands

```powershell
./gradlew build                # compile + remap; auto-copies the jar to mods folders (see below)
./gradlew runServer            # launch dev dedicated server
./gradlew runClient            # launch dev client
./gradlew genSources           # generate Minecraft sources for IDE navigation
./gradlew clean
```

The Node side (only needed if you want God to have a body and/or MCP tools):

```powershell
cd minecraft-mcp-server
npm install
# Unified entrypoint — ONE bot, bridge HTTP + MCP SSE on one port:
npm run unified -- --host <mc-host> --port <mc-port> --username LLMBot --bridge-port 8765
# Legacy bridge-only entrypoint (kept for rollback):
npm run bridge  -- --host <mc-host> --port <mc-port> --username LLMBot --bridge-port 8765
```

There are no tests in this project. The `ci.yml` workflow runs `./gradlew test` and `jacocoTestReport`, but no test sources exist — those steps are effectively no-ops/will fail on a clean checkout.

`build` is finalized by two `Copy` tasks (`copyToMods`, `copyToClientMods`) defined in [build.gradle:117](build.gradle:117). They copy the remapped jar into the paths set by `mods_folder` and `client_mods_folder` in [gradle.properties](gradle.properties). These properties point at Paul's local Minecraft installs — if you build on a different machine, either set them to your own mods folder or revert them to the placeholder `path/to/your/mods` so the copy is skipped.

The AI God feature requires `OPENAI_API_KEY` (optionally `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`) in the environment, *or* one of LM Studio / Ollama running locally and selected with `/llm provider <name>`. The system prompt is loaded at runtime from [prompt.txt](prompt.txt) in the working directory (not bundled into the jar). LangChain4j provider settings persist to `llm_config.properties`; God-Body bridge settings persist to `bridge_config.properties`.

## Architecture

### Entry points

Wired in [fabric.mod.json](src/main/resources/fabric.mod.json):

- [ServerEntryPoint.java](src/main/java/com/paul/brawl/ServerEntryPoint.java) (`DedicatedServerModInitializer`) registers everything: Gibber commands, RevenueManager, SalaryScheduler, the `coin` item, FlagManager, ChatBot, and the God-Body machinery (`GodActionQueue`, `GodScheduler`, op-on-join for the bot avatar).
- [ClientEntryPoint.java](src/client/java/com/paul/brawl/ClientEntryPoint.java) (`ClientModInitializer`) registers `Screenshotter` (which owns the `/prove` and `/build` client commands) and re-registers `Money` so the item is also known client-side.

Source set split is configured via `loom.splitEnvironmentSourceSets()` — client-only code lives under `src/client/`, shared/server code under `src/main/`.

### Gibber money flow

Designed so offline players still "earn" salary and receive their coins on next login:

1. The "total revenue" everyone is *entitled* to is a single global int stored in [PlayerPersistentState](src/main/java/com/paul/brawl/PlayerPersistentState.java) under key `total_revenue`.
2. Each player's *paid-out* revenue is stored per-UUID in the same persistent state.
3. `SalaryScheduler` ticks every `salary_period` seconds (default 10) and increments `total_revenue` by `salary_per_day`. It does NOT iterate players directly — it calls `RevenueManager.UpdateRevenueAll`.
4. `RevenueManager.updateRevenue(uuid)` computes `totalRevenue - currentRevenue` and gives that many `coin` items to the player, then writes back the new `currentRevenue`. The same path runs on `ServerPlayConnectionEvents.JOIN`, so offline players get their backlog at login.

`PlayerPersistentState` uses Minecraft's `PersistentState` API (saved per-world in the overworld's persistent state manager). NBT keys: `gibbers_state` → `player_data` (UUID→int) and `global_data` (string→int).

### AI God — LLM client (LangChain4j)

The complete request pipeline lives in [ChatBot.java](src/main/java/com/paul/brawl/ChatBot.java). The OpenAI Responses API has been replaced with **LangChain4j** (Chat Completions); the spine of the difference is **client-side memory** instead of server-side `previousResponseId` chaining. Every turn rebuilds the full message list from the player's [`ChatMemory`](https://docs.langchain4j.dev/) and resends it. The blocking `ChatModel.chat` is wrapped in `CompletableFuture.supplyAsync` on a dedicated worker pool ([LLMConfig.sharedExecutor](src/main/java/com/paul/brawl/LLMConfig.java)) so callers keep the old `.thenAccept` async shape.

Per turn, [`ChatBot.buildMessageList`](src/main/java/com/paul/brawl/ChatBot.java) prepends three `SystemMessage`s: hardcoded persona + override, a JSON snapshot from `PlayerDataCollector`, the global chat log from `ChatMessageHistory`, and nearby blocks from `ChatBotActions.getBlockInfo` (those three are collected on the main thread via a bounded `GodActionQueue` hop — `buildMessageList` itself runs on an llm-worker thread). Then it appends the player's `TokenWindowChatMemory` (capped at `MAX_MEMORY_TOKENS = 16_000`, budgeted by `OpenAiTokenCountEstimator("gpt-4o")`).

Tools are Jackson-annotated POJOs in [ChatBotFunctions.java](src/main/java/com/paul/brawl/ChatBotFunctions.java) — `Reward`, `Trade`, `Punishment`, `ChangeWeather`, `SpawnCreature`, `Appear`, `Vanish`, `Wait`, `BuildPlan`, `ListTools` — plus [QueryTerrain.java](src/main/java/com/paul/brawl/QueryTerrain.java) (ASCII relief map; center clamped to ±128 blocks of the player, unloaded chunks render as `?`). `Appear` and `Vanish` are gated on `GodSessionManager.isActive(player)` so a bodiless prayer can't steal the shared avatar or clobber the owner's idle watchdog. They are turned into LangChain4j `ToolSpecification`s by [JsonSchemaAdapter](src/main/java/com/paul/brawl/JsonSchemaAdapter.java), which derives the schema from `@JsonClassDescription` / `@JsonPropertyDescription`. Mark a field with [`@OptionalField`](src/main/java/com/paul/brawl/OptionalField.java) to keep it off the `required` list (used by `Appear`'s defaulted fields).

After a response, `checkForFunctions` dispatches each tool by name. World-mutating tools (`Reward`, `Trade`, `Punishment`, `ChangeWeather`, `SpawnCreature`) are wrapped in `GodActionQueue.submit(...).join()` at the dispatch site so they execute on the main server thread — see §"Thread safety" below. `Wait` is a special case: when present in a batch, the next `sendFunctionOutputs` call is deferred via `GodScheduler` instead of fired immediately, so God can linger without burning a thread.

Image inputs: the client `/prove` and `/build` commands trigger `Screenshotter` to capture the framebuffer, resize to 854×480, and ship it via the custom `ImagePayload` C2S packet. The server-side `ImageReceiver` calls `ChatBot.sendImageChatRequest`, which attaches the JPEG as a base64 `ImageContent` on a `UserMessage`. The user text gets prefixed with `Prompts.proofPrompt` or `Prompts.buildPrompt` depending on whether it contains `Prove :` or `Build :` — those prefix constants are empty by default and meant to be filled in.

The `BuildPlan` tool needs an origin. Admins set it by running `/construction`, which calls `Raycaster.setLastPos` to store the block the admin is currently looking at, keyed by UUID. Sub-builds run as isolated [BuildSubAgent](src/main/java/com/paul/brawl/BuildSubAgent.java) instances, each with its own `ChatMemory` and pivot. Sub-agents emit textual `PlaceBlock` / `PlaceLine` / `PlaceBlocks` calls (regex-scanned in `ChatBotFunctions`) rather than tool calls; the scanner has zero coupling to the LLM client.

### MCP toolkit + Mineflayer plugins

Two layers sit on top of mineflayer in the vendored sub-project.

**Plugins loaded in [bot-connection.ts](minecraft-mcp-server/src/bot-connection.ts)**:

| Plugin | Loaded | Role | Surfaced as |
|---|---|---|---|
| `mineflayer-pathfinder` | pre-spawn (`botOptions.plugins`) | A* navigation, `Movements` cost model | Backs `move-to-position`, `place-block` reach, etc. The ONLY plugin that goes in the construction-time slot |
| `mineflayer-pvp` | post-spawn | Combat tick loop (attack-to-kill, range/swing timing) | `attack-entity`, `stop-combat` MCP tools in [combat-tools.ts](minecraft-mcp-server/src/tools/combat-tools.ts) |
| `mineflayer-collectblock` | post-spawn | Find→path→equip→mine→pick-up bundle | `collect-block` MCP tool in [collection-tools.ts](minecraft-mcp-server/src/tools/collection-tools.ts) |
| `mineflayer-tool` | post-spawn | Auto-pick best tool for a block | Invisible — used internally by collectblock, was used by `dig-block` (currently TEMP-disabled) |
| `mineflayer-auto-eat` | post-spawn | Autonomous eat when `hunger<15` or `health<14` | No tool. `setOpts({...})` + `enableAuto()` called once at spawn. `returnToLastItem: true` and the explicit `bannedFood` list are load-bearing |
| `mineflayer-armor-manager` | post-spawn | Autonomous best-armor equip on `playerCollect` | No tool |

Plugin loading is wrapped in a single try/catch — one failed `bot.loadPlugin(...)` logs a warning but doesn't take the bot offline.

**MCP tool surface** — currently **25** tools (26 if `dig-block` is restored). Full ground truth: [MCP_TOOLS_VERIFICATION.md](MCP_TOOLS_VERIFICATION.md) §0; the executable check is `node verify-mcp-tools.mjs` from the repo root, which spawns the stdio MCP server, runs `tools/list`, and validates the name set + schema spot-checks against `CANONICAL_TOOLS` in [verify-mcp-tools.mjs](verify-mcp-tools.mjs:17). New tool modules go under [src/tools/](minecraft-mcp-server/src/tools/), use `factory.registerTool(...)` only (never `server.tool()` directly), and **must be registered in BOTH** [main.ts](minecraft-mcp-server/src/main.ts) AND [unified/main.ts](minecraft-mcp-server/src/unified/main.ts) — pauls-brawls runs unified exclusively, missing the unified registration means silent omission in production.

These MCP tools auto-flow into the God's tool list via `MCPGateway.INSTANCE.tools()` in [ChatBotFunctions.java:277](src/main/java/com/paul/brawl/ChatBotFunctions.java:277) — adding a tool in the Node side requires **zero Java changes**. Kebab-case MCP names dispatch through `MCPGateway.handlesTool(name)` in [ChatBotFunctions.java:383](src/main/java/com/paul/brawl/ChatBotFunctions.java:383); PascalCase Java POJO names dispatch through their own switch, so there's no collision risk.

`dig-block` is currently TEMP-disabled at user request (registration commented out, two ava tests `test.skip`'d — NOT a code defect). `move-in-direction` was permanently removed — it was blind WASD without obstacle awareness, strictly worse than `move-to-position`. See the Gotchas section for the restoration path.

### AI God — God-Body integration

Plan: [GOD_BOT_INTEGRATION_PLAN.md](GOD_BOT_INTEGRATION_PLAN.md). Verification: [VERIFICATION.md](VERIFICATION.md).

Division of labour:

| Concern | Lives where |
|---|---|
| `/tp` (appear/vanish), public chat, body gestures | Mineflayer bot, driven via HTTP bridge → `bot.chat`/`swingArm`/`lookAt` |
| Damage/loot/weather/build effects, `SpawnCreature` | Server-side in `ChatBotActions`, routed through `GodActionQueue` (main thread) |
| When/where to appear, pacing | Model's `Appear` / `Wait` / `Vanish` tool calls. `/pray` no longer auto-appears |
| One-encounter-at-a-time semantics | `GodSessionManager` (single-owner busy lock) |
| Avatar invulnerability | `ChatBotActions.buffAvatar/restoreAvatar` flip the `Invulnerable` NBT on the bot; applied on `Appear`, undone on every exit path |

Files added for this:

- [BridgeConfig.java](src/main/java/com/paul/brawl/BridgeConfig.java) — singleton; bridge URL, `botUsername` (default `LLMBot`), Appear/Wait/SpawnCount clamps, idle watchdog timeout, griefing toggle. Persists to `bridge_config.properties`. Surfaced via `/llm bridge …`.
- [BotBridgeClient.java](src/main/java/com/paul/brawl/BotBridgeClient.java) — async `java.net.http.HttpClient` wrapping the six bridge endpoints. **Best-effort**: errors log + return; never throw into the prayer flow.
- [GodBody.java](src/main/java/com/paul/brawl/GodBody.java) — semantic layer. `appear()` computes `playerPos + horizLookDir*distance + (0,height,0)` from yaw only (so pitch doesn't move the avatar vertically); `say`/`lookAt`/`gesture`/`vanish` are thin pass-throughs.
- [GodActionQueue.java](src/main/java/com/paul/brawl/GodActionQueue.java) — `ConcurrentLinkedQueue` drained on `END_SERVER_TICK`. `MAX_PER_TICK = 8` bounds per-tick work. Every off-thread world mutation goes through here.
- [GodScheduler.java](src/main/java/com/paul/brawl/GodScheduler.java) — daemon `ScheduledExecutorService` for `Wait` deferrals; shut down on `SERVER_STOPPING`.
- [GodSessionManager.java](src/main/java/com/paul/brawl/GodSessionManager.java) — `AtomicReference<UUID>` busy lock + `markManifested` flag + idle watchdog that fires `ChatBotActions.dismissAvatarOnWatchdog` after `BridgeConfig.idleTimeoutSeconds`. **Load-bearing invariant:** `idleTimeoutSeconds > waitMaxSeconds` so a deliberate `Wait(30)` doesn't trip the watchdog.

The bridge contract (HTTP, localhost only):

| Endpoint | Body | Bot action |
|---|---|---|
| `GET /health` | – | `{ connected, username, position }` |
| `POST /appear` | `{ x, y, z, facing? }` | `bot.chat("/tp <botName> x y z facing entity <player>")` |
| `POST /chat` | `{ message }` | `bot.chat(message)` — strips leading `/` to prevent the model running commands |
| `POST /look` | `{ x, y, z }` | `bot.lookAt(new Vec3(...))` |
| `POST /gesture` | `{ type }` | `swing` / `jump` / `sneak` / `nod` / `summon` |
| `POST /vanish` | `{ x?, y?, z? }` | `bot.chat("/tp <botName> <parking>")` |

The preferred entrypoint is `minecraft-mcp-server/src/unified/main.ts` (`npm run unified`). It owns ONE `BotConnection` and serves both the bridge HTTP routes and the MCP-over-SSE routes on one `--bridge-port`. The legacy `src/bridge/main.ts` (`npm run bridge`, HTTP only) and `src/main.ts` (`npm run dev`/`start`, MCP stdio only) entrypoints stay in tree as a rollback path. **Never run two entrypoints together with the same `--username`** — Minecraft kicks the second login. That dual-bot setup is exactly what `MCPGateway` no longer creates.

#### Termination, precisely

`ChatBot.setupGeneralCallback` computes `willContinue` once: true if there were tool calls, or (for the build bot) textual placements. Vanish only fires when `!willContinue && needsGodTools && GodSessionManager.isActive(player)`. The depth-cap (`MAX_FUNCTION_CALL_DEPTH = 100`) in `sendFunctionOutputs`, the API-error branch in `logApiError`, and the `/pray stop` / `/godbody off` paths all call the same `ChatBot.endPrayerSession(player)` so the avatar is always cleaned up — `restoreAvatar` (clears `Invulnerable`) + `GodBody.vanish()` + `GodSessionManager.endSession`.

### Commands (Brigadier)

Server (require permission level 2 unless noted):

- `/gib <amount>` — bump global revenue, immediately pays all online players.
- `/gib_salary <amount>`, `/gib_salary_period <seconds>` — configure the scheduler. Period change restarts the scheduler.
- `/pray <text>` — open to everyone (perm 0); send a message to God. Claims the single avatar via `GodSessionManager.claim`; if another player owns the body, the prayer is answered **bodiless**.
- `/pray stop` — open to everyone; end your own active session (vanish + release lock).
- `/accept` — open to everyone; accept the pending trade for this player.
- `/prompt [text]` — read or replace the custom prompt overlay (in-memory only, not persisted; the hardcoded prompt is reloaded from `prompt.txt`).
- `/block <x> <y> <z>` — debug stone placement at offset from the last raycast position.
- `/construction` — set the admin's current look target as the placement origin; also clears `buildBot`'s `ChatMemory` for this admin.
- `/llm …` — provider/model/host/port/apikey/timeout/reload, plus `/llm bridge …` for bridge config (enabled/url/bot/griefing/waitmax/spawnmax/idle). `timeout` is the HTTP request timeout in seconds (5–1800, default 180; reasoning models like gpt-5 routinely exceed langchain4j's built-in 60 s).
- `/godbody on|off` — admin kill-switch. `off` clears `GodActionQueue`, force-ends any live session, disables the bridge. `on` re-enables.

Client (registered in `Screenshotter`):

- `/prove <text>`, `/build <text>` — screenshot + ship to server with text prefix (`Prove :` / `Build :`).

### Conversation memory — caveats

[`ChatBot.memories`](src/main/java/com/paul/brawl/ChatBot.java) is `ConcurrentHashMap<UUID, ChatMemory>` using `TokenWindowChatMemory.withMaxTokens(16_000, …)` — token-budgeted (not message-count-budgeted) because one image or MCP tool result can outweigh dozens of chat lines; the estimator is `OpenAiTokenCountEstimator("gpt-4o")` (o200k_base, approximate for local providers, which is fine for budgeting). The window trims old messages (LC4j keeps tool-call/tool-result pairs together when evicting) but keeps the system + dynamic-context block rebuilt fresh each call (those are NOT stored in memory; `buildMessageList` prepends them). `TokenWindowChatMemory` is not thread-safe — every `add`/`messages()` is wrapped in `synchronized(memory)`. Images are added inline to a `UserMessage` and DO ride along on retries, but the memory window will eventually evict them. Tool-call / tool-result pairs must remain adjacent in memory or the next request 400s — `sendFunctionOutputs` always immediately follows the assistant turn that contained the calls; the depth-cap path wipes memory rather than corrupt it. A `Wait` deferral holds the tool results back for up to `waitMaxSeconds`, so a new prayer landing in that window cancels + flushes the pending results into memory first (`ChatBot.flushPendingDeferral`) instead of inserting a `UserMessage` between the tool_call and its results.

Per-conversation session semantics: each user entry point records whether the conversation started while owning the avatar (`ChatBot.sessionBound`). The "session ended mid-flight → drop response + wipe memory" guard in `setupGeneralCallback` only fires for session-bound conversations — a deliberately bodiless prayer (avatar busy elsewhere) is answered normally, it just can't `Appear`. `/prove` claims the session the same way `/pray` does.

`ChatMessageHistory` (different concept — server-wide chat/command/game-message log) is in-memory only, capped at 40 entries, shared across all players.

### Thread safety — main-thread queue

`response.thenAccept(...)` runs on the LLM worker pool, **not** the main server thread. Mutating world/entity state from there is a latent crash bug. Everything that touches world state goes through `GodActionQueue.submit(...).join()` at the dispatch site (`ChatBotFunctions.runOnMain`). The `.join()` blocks the LLM callback thread for ~one tick (~50 ms) — never call this on the main thread (deadlock against the drain). Bridge HTTP calls are async and never touch world state, so they don't need the queue.

### Mixins

Both `paulsbrawls.mixins.json` and `paulsbrawls.client.mixins.json` exist and reference single `ExampleMixin` stubs — currently no real mixin logic. Add new mixins under the matching package and register them in those JSON files.

## Gotchas

- The CI workflow uploads to GitHub Releases on push to `main`/`master` — see [.github/workflows/ci.yml](.github/workflows/ci.yml). The `test` job still calls `./gradlew test` and `jacocoTestReport` even though no tests exist and the Jacoco plugin isn't applied — both will fail until tests are added or those steps are removed.
- LangChain4j has no equivalent of the OpenAI `previousResponseId` chain. Every call resends the full message list from `ChatMemory`. If you ever see "tool_call without tool_result" 400s from the model, it means an assistant turn made it into memory without its matching `ToolExecutionResultMessage` — check the depth-cap and error branches in `ChatBot.sendFunctionOutputs`.
- The God-Body avatar needs op for `/tp`. Op-on-join is automatic if the bot's username matches `BridgeConfig.botUsername` — but only if it's a **real dedicated Fabric/Paper server**. Open-to-LAN singleplayer randomizes ports per session and can't op a bot reliably.
- The Mineflayer side is pinned to Minecraft 1.21.1 in `minecraft-mcp-server/src/bot-connection.ts` (`SUPPORTED_MINECRAFT_VERSION`). All three (server, mod, bot) must agree on the protocol version.
- `BridgeConfig.idleTimeoutSeconds > BridgeConfig.waitMaxSeconds` is a load-bearing invariant. `LLMCommand` enforces it on the setter side; if you ever set it directly, keep the invariant or a deliberate `Wait(30)` will trip the watchdog.
- A large pile of LangChain4j + Jackson + OkHttp + Okio + Kotlin transitive deps is bundled via `include` (jar-in-jar) — see [build.gradle](build.gradle). The OkHttp / Okio / kotlin-stdlib pile exists specifically because `langchain4j-mcp`'s `HttpMcpTransport` is OkHttp-based (the LLM HTTP client itself is JDK-native `java.net.http`). Without those `include` lines, the first `/pray` that builds tools NCDFEs on `okhttp3/Interceptor` inside `HttpMcpTransport$Builder.build`. When bumping `langchain4j-mcp`, re-derive the version pins with `./gradlew dependencyInsight --dependency okhttp` and update the `include` block to match — loom's `include` does NOT pull these transitives automatically.
- `minecraft-mcp-server/` is a vendored Node sub-project. pauls-brawls consumes it via `src/unified/main.ts` (`npm run unified`), which runs ONE Mineflayer bot serving both the bridge HTTP and MCP-over-SSE on `--bridge-port`. The legacy entrypoints (`src/main.ts` MCP-stdio-only, `src/bridge/main.ts` bridge-only) are still runnable for rollback — running any two of the three simultaneously with the same `--username` will kick one of them.
- `MCPGateway` no longer spawns a Node subprocess. It connects to the unified node process via `HttpMcpTransport` pointed at `MCPConfig.sseUrl` (default `http://127.0.0.1:8765/mcp/sse`). If you see stale `node_binary` / `mcp_server_script` / `mc_username` keys in `mcp_config.properties`, the first boot after upgrading logs a migration warning and rewrites the file with just `enabled` / `sse_url` / `timeout_seconds`.
- `MCPGateway.ensureStarted` is best-effort: if the SSE handshake fails (404 because the legacy bridge-only entrypoint is running instead of unified, ECONNREFUSED if no node process at all, etc.), the exception is caught and godBot proceeds with its Java tool set only. You'll see `MCP gateway start FAILED ... godBot will run without Mineflayer tools` in the log and the bot will answer prayers but can't call mine/move/place/craft. So a missing/broken unified process is silent in normal play — check that log line on first `/pray` after server start to confirm the unified process is actually wired up. The bridge-only `npm run bridge` entrypoint serves `/health` + the puppeting endpoints but returns 404 on `/mcp/sse`; `npm run unified` is the only entrypoint that mounts both.
- `LLMConfig.timeoutSeconds` (default 180 s, set via `/llm timeout <s>`, persisted as `timeout_seconds` in `llm_config.properties`) gates every LLM HTTP call via `OpenAiChatModel.builder().timeout(...)`. Bumped above langchain4j's built-in 60 s default because OpenAI reasoning models (gpt-5) routinely exceed 60 s on long chats with full tool definitions. If you see `dev.langchain4j.exception.TimeoutException` mid-prayer, the model genuinely took longer than this — increase the timeout (`/llm timeout 300`), don't bandaid in retries. Connection-reset retriable warnings (`A retriable exception occurred ... java.io.IOException: Connection reset`) are a different beast: those are TCP RSTs from stale-keepalive pool reuse in the JDK HttpClient, not timeouts, and langchain4j's built-in `RetryUtils` handles them automatically.
- `dig-block` is currently TEMP-disabled (registration commented out in [block-tools.ts](minecraft-mcp-server/src/tools/block-tools.ts); two ava tests are `test.skip`'d with `// eslint-disable-next-line ava/no-skip-test`). The `mineflayer-tool` plugin stays loaded so `collect-block` keeps its auto-equip path. **To restore:** grep for `TEMP DISABLED` / `TEMP SKIPPED` markers — five spots covering the registration, the two tests, `CANONICAL_TOOLS` in [verify-mcp-tools.mjs](verify-mcp-tools.mjs), and the counts/banner in [MCP_TOOLS_VERIFICATION.md](MCP_TOOLS_VERIFICATION.md). When active, `dig-block` silently calls `bot.tool.equipForBlock(block, {})` before `bot.dig` — the held item afterwards is whatever the plugin picked (e.g. iron pickaxe), NOT what was in hand before. If you need a specific item in-hand post-dig, re-equip after the call. (mineflayer-auto-eat's `returnToLastItem: true` doesn't help — it only restores the item the *eat* swapped from, not the dig.)
- `move-in-direction` was **permanently removed** (not temp). It was a blind WASD pulse (`bot.setControlState('forward', true)` for N ms) with zero obstacle awareness — strictly worse than `move-to-position` for any non-trivial movement. Don't re-add it; if you need short-burst movement, compose `move-to-position` with a small `range` + `timeoutMs`.
- Mineflayer plugins compiled from TypeScript (`mineflayer-pvp`, `mineflayer-collectblock`, `mineflayer-tool`) ship CJS with `Object.defineProperty(exports, "__esModule", { value: true })` set and a named `exports.plugin` — but no `exports.default`. Under `npm run unified` (tsx in production mode), `import pkg from 'x'; const { plugin } = pkg;` works because tsx synthesises the default. Under `npm test` (tsx-under-ava), the same import lands `undefined` because ava-tsx strictly honours `__esModule` and refuses to synthesise. **Always use named imports for these three** (`import { plugin as pvp } from 'mineflayer-pvp'`) — there's a long comment explaining this in [bot-connection.ts](minecraft-mcp-server/src/bot-connection.ts). Pure-CJS plugins without the `__esModule` flag (`mineflayer-pathfinder`, `mineflayer-armor-manager`) work either way; ESM-native plugins (`mineflayer-auto-eat`, `"type": "module"`) require named imports natively.
- `MCPGateway.INSTANCE.tools()` caches the spec list from the last successful `listTools()`. Connect failures auto-retry with a 30 s backoff (`RECONNECT_BACKOFF_MS`); a tool-dispatch failure tears the client down and zeroes the backoff so the next call reconnects immediately. The cached catalogue is preserved across disconnects so in-flight assistant turns stay consistent. Adding/removing MCP tools on the Node side therefore does NOT propagate while the connection is healthy — run **`/mcp reload`** (admin) to force a tear-down + fresh `listTools()`, no Java restart needed. The `MCP gateway up — N tool(s) discovered: [...]` log line tells you what the cache actually saw — compare against `node verify-mcp-tools.mjs` if N looks wrong.
- `Mineflayer detected that you are using a deprecated event (physicTick)! Please use this event (physicsTick) instead.` is printed on every bot spawn — it's emitted from inside one of the loaded Mineflayer plugins (likely pvp or auto-eat's tick hook still listening to the old event name). Harmless upstream noise, not a wiring bug. Don't chase it; it'll disappear when those plugins rename their listeners.
