# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Fabric mod for Minecraft 1.21.1 (Java 21), `paulsbrawls`, bundling three loosely-coupled gameplay
features, plus two LLM subsystems that live in Node sub-projects beside the mod:

- **Gibber** — server-wide money system (a custom `coin` item) with admin gift commands and a periodic salary scheduler.
- **Capture the Flag** — auto-drops any banner named "Flag" when its holder takes damage, disables elytra while a Flag is carried, and makes flag-holders glow.
- **AI God** — a LangChain4j-driven `Dieu` who hears prayers (`/pray`), trades, punishes, and rewards. **Has a physical body**: drives a Mineflayer bot (the avatar) over a Node HTTP bridge. Most player-facing strings are French.
- **AI Village (Eden)** — ten LM-powered villager bots + one God acting through a single shared, God-judged library of typed, composable skills. The brain is **Eden**, a from-scratch rewrite in [eden/](eden/) (one Node process). The mod's only contribution is server-authority: the atomic trade-settlement listener, `coin`, op-on-join, and the `/village` command.

> ### Three runtimes — what is active vs legacy (read this first)
>
> | Runtime | Path | Process | Status |
> |---|---|---|---|
> | **The Fabric mod** | [src/](src/) | `./gradlew …` (JVM) | **Active, permanent.** Gibber, CTF, AI God, `:8767` settlement, op-on-join. |
> | **Eden** — the AI Village brain | [eden/](eden/) | `tsx eden/src/main.ts` (one Node process) | **Active.** The current village brain (God + 10 villagers). Avatar `Dieu`, admin port `8770`. |
> | **Unified bridge + MCP** | [minecraft-mcp-server/src/unified/](minecraft-mcp-server/src/unified/) | `npm run unified` | **Active.** Drives the **Java AI-God's** avatar (`LLMBot`) and exposes Mineflayer tools to that God. A *different* surface from the village. |
> | **v1 village brain** | [minecraft-mcp-server/src/village/](minecraft-mcp-server/src/village/) | `npm run village` | **LEGACY / deprecated.** Superseded by Eden. Non-destructive: still runnable, nothing deleted. See [minecraft-mcp-server/DEPRECATED.md](minecraft-mcp-server/DEPRECATED.md). |
>
> There are **two distinct "Gods"**: the Java `/pray` God (LangChain4j, drives `LLMBot` via the unified
> bridge) and Eden's village God (`Dieu`, the critic/curriculum/orchestrator brain). They are separate
> entities and must never share a Minecraft username (R12). Eden replaces only the *v1 village*, not the
> mod and not the Java AI-God.

## Build / run / test commands

### The Fabric mod (JVM)

```powershell
./gradlew build                # compile + remap; auto-copies the jar to mods folders (see below)
./gradlew runServer            # launch dev dedicated server (cwd run/, dev port — read run/server.properties, R28)
./gradlew runClient            # launch dev client
./gradlew genSources           # generate Minecraft sources for IDE navigation
./gradlew clean
```

`build` is finalized by two `Copy` tasks (`copyToMods`, `copyToClientMods`) in [build.gradle:117](build.gradle:117).
They copy the remapped jar into the paths set by `mods_folder` / `client_mods_folder` in
[gradle.properties](gradle.properties). Those point at Paul's local Minecraft installs — on a different
machine, set them to your own mods folder or revert to the placeholder `path/to/your/mods` so the copy is
skipped. (PrismLauncher's instance dir is `minecraft/`, **no dot** — a wrong path silently leaves a stale jar.)

The Java side has no tests. `ci.yml` runs `./gradlew test` + `jacocoTestReport` but no test sources exist —
those steps are effectively no-ops/will fail on a clean checkout.

### Eden — the AI Village brain (Node)

```powershell
cd eden
npm install
cp eden.example.json eden.json   # eden.json is gitignored; holds NO api key (env-only)
npx tsx src/main.ts eden.json    # boot the host: spawns bots + installs process guards (a real run)
```

```powershell
npm run check          # CI gate: lint + tsc --noEmit + dependency-cruiser (0 violations) + ~400 node:test tests
npm test               # node:test via tsx, on the fakes only — NEVER touches Minecraft
npm run test:coverage  # node built-in coverage (~94% line / ~83% branch)
npm run eval           # mock-LLM scenario harness vs a real server (CI-style, deterministic)
npm run live-test      # real server + real LLM scenario suite (NOT in CI — needs a server + OPENAI_API_KEY)
npm run rebuild-stats  # rebuild derived views from the journal by replay (must equal the live fold)
```

- Test runner is **`node:test` via tsx**, NOT ava (v1 used ava; Eden starts clean). Node `>=22` (machine runs 24).
- CI is [.github/workflows/eden-ci.yml](.github/workflows/eden-ci.yml), scoped to `eden/**`, separate from the mod's `ci.yml`.
- A direct boot (`tsx src/main.ts`) sets `spawnBots:true` + `installProcessGuards:true`; `start()` called from tests defaults both **false**, so CI never connects to a server. The host is supervised under **pm2** (Windows, crash-only respawn — D-08); `ecosystem.config.cjs` lives beside `eden.json` (both gitignored).
- The LLM key is read from `process.env.OPENAI_API_KEY` and sent only to the remote (https) provider — never written to a config file or the journal.

### The unified bridge (drives the Java AI-God's avatar + MCP tools)

```powershell
cd minecraft-mcp-server
npm install
# ONE bot, bridge HTTP + MCP-over-SSE on one port:
npm run unified -- --host <mc-host> --port <mc-port> --username LLMBot --bridge-port 8765
# Legacy rollback entrypoints (do NOT run two with the same --username — MC kicks the second login):
npm run bridge  -- ... # bridge HTTP only
npm run dev / start    # MCP stdio only
# LEGACY village brain (deprecated — superseded by Eden):
npm run village -- --roster village.json --admin-port 8766
```

The AI-God feature requires `OPENAI_API_KEY` (optionally `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`), *or* LM
Studio / Ollama running locally and selected with `/llm provider <name>`. The system prompt is loaded at
runtime from [prompt.txt](prompt.txt) in the working directory (not bundled into the jar). LangChain4j
settings persist to `llm_config.properties`; God-Body bridge settings to `bridge_config.properties`.

> **The JVM runs in `PaulsBrawlsVanilla\`** (the production server dir) — that is where the runtime configs
> (`llm_config.properties`, `bridge_config.properties`, …) and logs live, NOT `pauls-brawls/run/`. The
> `./gradlew runServer` dev server runs in `run/` instead. **Two servers, two cwds.**

---

## Architecture — the Fabric mod (`src/`)

### Entry points

Wired in [fabric.mod.json](src/main/resources/fabric.mod.json):

- [ServerEntryPoint.java](src/main/java/com/paul/brawl/ServerEntryPoint.java) (`DedicatedServerModInitializer`) registers everything: Gibber commands, RevenueManager, SalaryScheduler, the `coin` item, FlagManager, ChatBot, the God-Body machinery (`GodActionQueue`, `GodScheduler`, op-on-join for the avatar), and the village trade-settlement listener.
- [ClientEntryPoint.java](src/client/java/com/paul/brawl/ClientEntryPoint.java) (`ClientModInitializer`) registers `Screenshotter` (which owns `/prove` and `/build`) and re-registers `Money`.

Source-set split is `loom.splitEnvironmentSourceSets()` — client-only code under `src/client/`, shared/server under `src/main/`.

### Gibber money flow

Designed so offline players still "earn" salary and receive coins on next login:

1. A single global int `total_revenue` (everyone is *entitled* to it) lives in [PlayerPersistentState](src/main/java/com/paul/brawl/PlayerPersistentState.java).
2. Each player's *paid-out* revenue is stored per-UUID in the same persistent state.
3. `SalaryScheduler` ticks every `salary_period` seconds (default 10), incrementing `total_revenue` by `salary_per_day` — via `RevenueManager.UpdateRevenueAll`, not by iterating players.
4. `RevenueManager.updateRevenue(uuid)` computes `totalRevenue - currentRevenue`, gives that many `coin` items, writes back. Same path runs on `ServerPlayConnectionEvents.JOIN`, so offline players get their backlog at login.

`PlayerPersistentState` uses Minecraft's `PersistentState` API. NBT keys: `gibbers_state` → `player_data` (UUID→int), `global_data` (string→int).

### AI God — LLM client (LangChain4j)

The full request pipeline lives in [ChatBot.java](src/main/java/com/paul/brawl/ChatBot.java). It uses
**LangChain4j** (Chat Completions) with **client-side memory** instead of the OpenAI Responses API's
`previousResponseId` chaining. Every turn rebuilds the full message list from the player's
`TokenWindowChatMemory` (capped at `MAX_MEMORY_TOKENS = 16_000`, budgeted by `OpenAiTokenCountEstimator("gpt-4o")`)
and resends it. The blocking `ChatModel.chat` is wrapped in `CompletableFuture.supplyAsync` on a dedicated
worker pool ([LLMConfig.sharedExecutor](src/main/java/com/paul/brawl/LLMConfig.java)).

Per turn, `buildMessageList` prepends three `SystemMessage`s (persona+override, a `PlayerDataCollector` JSON
snapshot, the global chat log, and nearby blocks via `ChatBotActions.getBlockInfo` — collected on the main
thread through a bounded `GodActionQueue` hop), then appends the player's memory.

Tools are Jackson-annotated POJOs in [ChatBotFunctions.java](src/main/java/com/paul/brawl/ChatBotFunctions.java) —
`Reward`, `Trade`, `Punishment`, `ChangeWeather`, `SpawnCreature`, `Appear`, `Vanish`, `Wait`, `BuildPlan`,
`ListTools` — plus [QueryTerrain.java](src/main/java/com/paul/brawl/QueryTerrain.java) (ASCII relief map).
`Appear`/`Vanish` are gated on `GodSessionManager.isActive(player)`. [JsonSchemaAdapter](src/main/java/com/paul/brawl/JsonSchemaAdapter.java)
turns them into LangChain4j `ToolSpecification`s from `@JsonClassDescription`/`@JsonPropertyDescription`;
mark a field [`@OptionalField`](src/main/java/com/paul/brawl/OptionalField.java) to keep it off `required`.

World-mutating tools dispatch through `GodActionQueue.submit(...).join()` (main thread). `Wait` defers the
next `sendFunctionOutputs` via `GodScheduler`. `BuildPlan` needs an origin (`/construction` →
`Raycaster.setLastPos`); sub-builds run as isolated [BuildSubAgent](src/main/java/com/paul/brawl/BuildSubAgent.java)
instances that emit textual `PlaceBlock`/`PlaceLine`/`PlaceBlocks` (regex-scanned).

Image inputs: client `/prove`/`/build` capture the framebuffer (resize 854×480), ship via the `ImagePayload`
C2S packet; `ImageReceiver` → `ChatBot.sendImageChatRequest` attaches the JPEG as a base64 `ImageContent`.

### AI God — God-Body integration

Plan: [GOD_BOT_INTEGRATION_PLAN.md](GOD_BOT_INTEGRATION_PLAN.md). Verification: [VERIFICATION.md](VERIFICATION.md).

| Concern | Lives where |
|---|---|
| `/tp` (appear/vanish), public chat, gestures | Mineflayer bot, via HTTP bridge → `bot.chat`/`swingArm`/`lookAt` |
| Damage/loot/weather/build, `SpawnCreature` | Server-side `ChatBotActions`, through `GodActionQueue` (main thread) |
| When/where to appear, pacing | The model's `Appear`/`Wait`/`Vanish` tool calls |
| One-encounter-at-a-time | `GodSessionManager` (single-owner busy lock) |
| Avatar invulnerability | `ChatBotActions.buffAvatar/restoreAvatar` flip the `Invulnerable` NBT on `Appear` / every exit |

Java side: [BridgeConfig](src/main/java/com/paul/brawl/BridgeConfig.java) (bridge URL, `botUsername`=`LLMBot`,
clamps, idle watchdog, griefing toggle; persists to `bridge_config.properties`), [BotBridgeClient](src/main/java/com/paul/brawl/BotBridgeClient.java)
(async, best-effort — never throws into the prayer flow), [GodBody](src/main/java/com/paul/brawl/GodBody.java)
(semantic layer; `appear()` computes `playerPos + horizLookDir*distance + (0,height,0)` from yaw only),
[GodActionQueue](src/main/java/com/paul/brawl/GodActionQueue.java) (`ConcurrentLinkedQueue` drained on
`END_SERVER_TICK`, `MAX_PER_TICK=8`), [GodScheduler](src/main/java/com/paul/brawl/GodScheduler.java),
[GodSessionManager](src/main/java/com/paul/brawl/GodSessionManager.java) (busy lock + idle watchdog).

Bridge contract (HTTP, localhost): `GET /health`, `POST /appear {x,y,z,facing?}` (→ `/tp`), `POST /chat {message}`
(strips leading `/`), `POST /look`, `POST /gesture {type}`, `POST /vanish`.

**Termination:** `ChatBot.setupGeneralCallback` computes `willContinue` once; `Vanish` fires only when
`!willContinue && needsGodTools && GodSessionManager.isActive(player)`. The depth cap (`MAX_FUNCTION_CALL_DEPTH=100`),
the API-error branch, and `/pray stop` / `/godbody off` all call `ChatBot.endPrayerSession(player)` →
`restoreAvatar` + `GodBody.vanish()` + `GodSessionManager.endSession`. **Load-bearing invariant:**
`idleTimeoutSeconds > waitMaxSeconds` (else a deliberate `Wait(30)` trips the watchdog).

### MCP toolkit + Mineflayer plugins (`minecraft-mcp-server/`)

The unified entrypoint ([src/unified/main.ts](minecraft-mcp-server/src/unified/main.ts)) runs ONE Mineflayer
bot serving both the bridge HTTP routes and the MCP-over-SSE routes on `--bridge-port` (default 8765). The bot
auto-loads five plugins post-spawn:

| Plugin | Role | Surfaced as |
|---|---|---|
| `mineflayer-pathfinder` | A* nav (pre-spawn) | backs `move-to-position`, `place-block` reach |
| `mineflayer-pvp` | combat tick loop | `attack-entity`, `stop-combat` |
| `mineflayer-collectblock` | find→path→mine→pickup | `collect-block` |
| `mineflayer-tool` | auto-pick best tool | internal (used by collectblock; was used by TEMP-disabled `dig-block`) |
| `mineflayer-auto-eat` | autonomous eat | no tool; `AUTO_EAT_OPTS` is load-bearing |
| `mineflayer-armor-manager` | autonomous best-armor equip | no tool |

The MCP surface is **25 tools** (26 if `dig-block` is restored — currently TEMP-disabled at user request).
Ground truth: [MCP_TOOLS_VERIFICATION.md](MCP_TOOLS_VERIFICATION.md) §0; the executable check is
`node verify-mcp-tools.mjs`. New tool modules go under [src/tools/](minecraft-mcp-server/src/tools/), use
`factory.registerTool(...)`, and **must be registered in BOTH** `main.ts` AND `unified/main.ts`. MCP tools
auto-flow into the God's tool list via `MCPGateway.INSTANCE.tools()` — adding a Node tool requires **zero
Java changes**. `MCPGateway` connects to the unified process via `HttpMcpTransport` (no subprocess spawn);
run **`/mcp reload`** to force a fresh `listTools()`.

### Commands (Brigadier)

Server (permission level 2 unless noted):

- `/gib <amount>` — bump global revenue, pay all online players. `/gib_salary <amount>`, `/gib_salary_period <seconds>` configure the scheduler.
- `/pray <text>` (perm 0) — message God; claims the avatar via `GodSessionManager.claim` (bodiless if the body is owned elsewhere). `/pray stop` (perm 0) ends your session. `/accept` (perm 0) accepts a pending trade.
- `/prompt [text]`, `/block <x> <y> <z>`, `/construction` — prompt overlay, debug placement, set build origin.
- `/llm …` — provider/model/host/port/apikey/timeout/reload + `/llm bridge …`. `timeout` (5–1800 s, default 180) gates every LLM HTTP call (reasoning models exceed langchain4j's 60 s default).
- `/godbody on|off` — admin kill-switch. `/mcp reload` — refresh the MCP tool catalogue.
- `/village` — village admin: bare = config + listener state; `status`/`pause`/`resume` query the **v1 Node** village process; `on`/`off` toggle the `:8767` trade-settlement listener (which Eden *also* uses).

Client (in `Screenshotter`): `/prove <text>`, `/build <text>` — screenshot + ship with a text prefix.

### Thread safety, memory, mixins

- `response.thenAccept(...)` runs on the LLM worker pool, **not** the main thread. Everything touching world state goes through `GodActionQueue.submit(...).join()` (`ChatBotFunctions.runOnMain`) — the `.join()` blocks ~one tick; **never call it on the main thread** (deadlock).
- `TokenWindowChatMemory` is not thread-safe — every `add`/`messages()` is `synchronized(memory)`. Tool-call / tool-result pairs must stay adjacent or the next request 400s.
- Both `paulsbrawls.mixins.json` and `paulsbrawls.client.mixins.json` reference `ExampleMixin` stubs — no real mixin logic yet.

---

## Architecture — Eden, the AI Village brain (`eden/`)

> Eden is the from-scratch rewrite of the AI Village. **The spec is [docs/](docs/), not this file.** Agents
> working *inside* `eden/` should read [eden/CLAUDE.md](eden/CLAUDE.md) and the docs reading order in
> [docs/README.md](docs/README.md). This section is the orientation; the docs are normative.

### The organizing idea

**One God closes every loop.** A single LLM entity judges skill runs (critic), sets the curriculum, and
orchestrates the villagers — through the avatar body it has. Skills are typed, composable JS functions in
**one God-owned library**, written against the full mineflayer API, admitted only after a verified successful
run. This attacks v1's four caps: per-villager skill silos, a closed 27-verb API, no success judge, and a
feedback loop shredded by anti-spam scheduling.

The thirteen owner decisions (never relitigate) and the seven resolved hard mechanisms (D-07…D-13) are in
[docs/README.md](docs/README.md) + [docs/13-open-questions.md](docs/13-open-questions.md). The ten-minute
orientation is [docs/10-architecture-summary.md](docs/10-architecture-summary.md). Status:
**feature-complete M0–M7 + a live test suite**, CI-green; smoke/parity sign-off against a live server is the
remaining open step ([docs/17-parity-signoff.md](docs/17-parity-signoff.md)).

### Process topology & the dependency law

- **One Node process** (D-01): bots, God brain, avatar, skill engine, journal, admin server. The refinement loop is too chatty for cross-process hops. Worker threads are the escape hatch.
- **SQLite is the spine** (D-03): `better-sqlite3`, WAL. Journal + library index + stats + ledger + directives + subscriptions in one DB. Skill *code* stays as plain `.js` files; per-bot memory stays JSON.
- **Crash-only** — state persists when it changes; `kill -9` loses at most in-flight LLM calls.
- **`main.ts` is the ONLY composition root** ([eden/src/main.ts](eden/src/main.ts)): it imports everything and wires it with plain constructor args (no DI container, no singletons).

The **dependency law** is CI-enforced by dependency-cruiser ([eden/.dependency-cruiser.cjs](eden/.dependency-cruiser.cjs)) —
imports run **strictly downward**, an upward import fails the build:

```
  types/ (0)  →  {journal/, config.ts, bots/, render/, views/} (1)  →  {skills/, llm/} (2)  →  {god/, villagers/, social/} (3)
                                                                              admin/, cli/ are pure CONSUMERS (only main.ts imports them)
```

- `types/` imports nothing local (layer 0 — interfaces + enums).
- **Layer-3 actors never import each other.** `god/` reaches a villager only via an injected `Inbox` ([types/inbox.ts](eden/src/types/inbox.ts)); `social/`↔villager goes through [types/social.ts](eden/src/types/social.ts). The renderer + derived views sit at layer 1 ([render/](eden/src/render/), [views/](eden/src/views/)) so both `god/` and `villagers/` can use them without importing a peer.
- The `RolloutCoordinator` (the real refinement loop) touches both `god/` and `villagers/`, so it lives at the composition root (`main.ts`), not in a layer-3 module.

### Skill system ([docs/02](docs/02-skill-system.md), code in [eden/src/skills/](eden/src/skills/))

- **Shape:** every skill is `async (bot, args, ctx)` with a manifest carrying JSON-Schema `params`/`returns`, a one-line English summary, tags, and a tier. Skills return structured data (the critic reads it).
- **D-04 — no static typecheck.** Validation is a **syntax parse only** — no sandbox, no banned-identifier scan, no import scanning. JSON-Schema runtime validation gives readable boundary errors + prompt signatures that can't lie. The full mineflayer API makes static checking meaningless.
- **One global, God-owned library** with **append-only versioning** (`v4` supersedes `v3`; files stay on disk forever). Status machine `draft → active-probation → active`, with three rails against a wrong verdict (D-12): one-directional `check`-veto, **probation-before-composition** (admitted skills aren't a composition dependency until `probationRuns=3` clean runs), and self-healing quarantine. A dumb 5-consecutive-failure tripwire (`autoQuarantineAfter`) backstops a long critic queue.
- **Validation = watchfulness, not gates** (P3): the ONE kept AST pass is the acorn **loop-budget injection** (the answer to `while(true)`), plus a **macrotask-starvation canary** (a synchronous guard inside the loop body — finding **W**: an `await` of an immediately-resolved promise resets the loop budget every iteration AND starves all timer watchdogs). Runtime supervision: per-call wall-clock cap (`runDefaultTimeoutMs` 120 s, 2 h ceiling), a **stall detector** (a pulse is a discrete progress *event* — position/inventory/window/dig/place + pathfinder liveness + `ctx.log`/`sleep`; `stallSeconds=20`, D-10/R46), and the hardened v1 abort protocol on every exit. **Crashes escalate to the LLM loop**, never suppressed. `process.exit`/`reallyExit`/`abort`/`kill` are neutered by a **scope shim** (a provided binding, not a denylist — D-08/R45).
- **Composition:** `ctx.skills.run(name, args)` — args validated against the callee's schema; depth cap `maxCallDepth=8` with cycle detection; one shared budget/signal/report per call tree.
- **D-05 — serialized execution per bot:** one skill tree at a time. Mineflayer can't multiplex one body.
- **Tiers — mortal vs divine** (owner #13): an **engine-enforced** boundary (NOT part of the mutable `GrantPolicy`). Villagers are never op'd; the avatar `Dieu` is the only divine runner. Mortal never calls divine; divine skills are invisible in villager retrieval; when the avatar runs a *mortal* skill, a chat interceptor drops `/`-prefixed messages (R25).
- **Retrieval & prompting** (Voyager-style, owner #8/#10): ~6 exemplar skills always in prompts as **full code**; everything else as `signature — summary` one-liners via multilingual-embedding retrieval with keyword fallback; full code only via the `read_skill` tool. `write_skill` is one upsert tool, hard-capping `maxSkillLines=400`. Descriptions are LLM-generated *from the final code* at admission.
- **Full mineflayer** (owner #11): skill code gets the actual bot object, no wrapper. `STOCK_SKILLS` ([skills/exemplars/index.ts](eden/src/skills/exemplars/index.ts)) seed Voyager primitives (go-to / mine-block / collect-blocks / craft-item / kill-mob / …) at `active`.

### God ([docs/03](docs/03-god.md), code in [eden/src/god/](eden/src/god/))

- **Three desks, one persona:** critic / curriculum / orchestrator, independently promptable and model-tierable (critic + curriculum on `strong`, orchestrator on `fast`), with a `combineDesks` cheap mode. **D-06: desks share one state, never one context window.**
- **Critic** (owner #1): judges `RunReport`s — full code, world before/after, call tree, abort cause — returns a structured `Verdict` (success flag + constructive critique + library action).
- **Curriculum** (owner #6): "what next for the *village*," one task at the edge of ability. The **sole writer of the ledger** (S2). Keeps Voyager's QA-cache, decomposition, warm-up gating, `maxRetries`.
- **Orchestrator** (owner #4): emits **directives — data, not code** (goal + reason + priority + expiry) with anti-thrash rules. Direct in-world intervention via divine skills is allowed but doctrine-bound: **interventions teach, never do a villager's task** — the critic voids a task completed by divine action.
- **The body:** avatar `Dieu` is bot #11 in the same pool, the only divine runner. **God acts through journaled skill runs like everyone else** — `appear-near`, `vanish`, `gesture`, `smite`, `summon-creature` are stock divine skills (P4). A disconnected avatar degrades nothing functional (every directive/critique reaches its villager through the inbox anyway).
- **The refinement loop** (`RolloutCoordinator` in `main.ts`): task → directive → villager plans (reuse or `write_skill`) → trial run → verdict → critique-driven revision. The **density invariant** (D-11): the revision prompt carries full draft code + verbatim error + rendered world state + critique in ONE message; the current payload is **never trimmed** (prior revisions trim oldest-first; `write_skill` source-caps size so the payload always fits the per-tier budget — strong 48k / fast 16k).
- **Cost** (D-13/R49): **throughput-limited** — at `maxConcurrent:3` the ~3000 calls/day ceiling binds, not the wallet. Per-desk daily token caps default null (safety valve + `degradeOnBreach`). Real levers: the strong/fast tier split + zero-token `subscription → skill` reactivity.

### Villager runtime ([docs/04](docs/04-villager-runtime.md), code in [eden/src/villagers/](eden/src/villagers/))

- **Events:** raw mineflayer signals normalize into a small closed typed set; edge-style events (`health-low`, `night-falls`) carry **hysteresis in the emitter** so subscribers never debounce.
- **Subscriptions — filters as data** (P5): declarative AND-composed clauses (proximity/entity kind/name/time-of-day/`notWhileRunning`), no predicate code. Two outcomes: **`skill`** (free, zero tokens — v1's "reflex" rebuilt as a binding to a proven skill) or **`deliberate`** (LLM escalation). Role defaults are config data in [eden/roles.json](eden/roles.json).
- **The brain:** one deliberation = one LLM conversation (context pack → tool calls → `done`). **Direct micro-action tools do not exist** — all world effects go through `run_skill` (P2), so the library stays the single vocabulary of action and every effect is a journaled, criticizable run.
- **Context pack:** deterministic assembly in 8 ordered sections, each with a token ceiling; section sizes journal with the wake-up so prompt bloat is measurable.
- **Memory** ([villagers/memory.ts](eden/src/villagers/memory.ts)): window ~200 → archive 2000 + summarization (keyword/importance/lesson enrichment); ranked retrieval `0.5·relevance + 0.25·recency(2 h) + 0.25·importance` with multilingual embeddings + keyword fallback. **World-stamp (R32):** every data dir is stamped `${host}:${port}`; on mismatch (world regen) Eden **quarantines** stale beliefs behind an admin `wipe|migrate` decision instead of reasoning from a dead world.
- **Scheduling** ([llm/scheduler.ts](eden/src/llm/scheduler.ts)): global concurrency cap, priority lanes, per-villager cooldown, coalescing — with God preemption, **rollout immunity** (revision turns bypass all suppression — the density invariant), and the "identical error → exponential suppression" memo **deleted** (repeated failure becomes ledger/dossier signal that makes God change the task, not an engine silently swallowing wake-ups).
- **Society** ([eden/src/social/](eden/src/social/)): bot↔bot conversations (mirror-gated to game chat) + typed-offer trade. Trade settles via `SettlementClient` POST to the Java `:8767` listener (`coin → paulsbrawls:coin`, so Gibber is the village currency for free).

### Observability ([docs/05](docs/05-observability.md), code in [eden/src/journal/](eden/src/journal/), [eden/src/admin/](eden/src/admin/))

- **The journal is the source of truth** (P4 — *if it didn't journal, it didn't happen*). Append-only SQLite; every event carries `actor` + a `refs` causality column. **Adding a kind = one registry row** in [journal/kinds.ts](eden/src/journal/kinds.ts) (the S1 `JournalKind` union; `types/JournalEvent.kind` is `string` so `types/` imports nothing).
- **Backpressure: instrument and wait** (D-07): synchronous WAL writes (`synchronous=NORMAL`), made safe by **never journaling the hot stream — pulses are in-memory counters** (R44). The v1 event-loop lag monitor is ported as the backpressure canary ([journal/lag-monitor.ts](eden/src/journal/lag-monitor.ts), `system.loop-lag` on `max ≥ 1000 ms`). `vitalsIntervalSeconds=10`.
- **Derived state, not duplicate state** ([eden/src/views/](eden/src/views/)): skill stats, dossier competence, relations, the trade ledger, the rollout index — all folds over journal events, rebuildable by replay (`npm run rebuild-stats` must equal the live fold). Writers append facts; readers fold.
- **Admin API now, website later** (owner #9): localhost HTTP + a WebSocket journal stream on **port 8770**. The future website must be a **pure consumer** of these routes; a needed feature is an API gap to fix here, not website code. Mutating verbs (`prompt`, `pause`, `quarantine`) journal `actor` BEFORE acting. LLM prompt bodies stay OUT of the journal; `debugPrompts:true` writes per-call transcript files (`.eden-data/llm/*.json`) referenced from the `llm.call` event.

### Config, ports, identity

- **Config:** [eden/eden.example.json](eden/eden.example.json) → `eden.json` (gitignored). Holds NO key (env-only). Sections: `minecraft`, `villagers` (roster — `home`/`chest` are **hints**, self-healing anchors snap them to real ground, R18), `god` (name/desks/budget/`combineDesks`/`embodiedVerdicts`), `llm` (strong/fast providers, `maxConcurrent`, cooldown), `skills`, `settlement.url` (`:8767`), `admin.port` (8770), `journal`.
- **Data dir** `.eden-data/` (gitignored): `eden.db` (journal), `library/<skill>/v*.js` (authored code), `bots/<name>.json` (memory/anchors/subscriptions), `llm/*.json` (transcripts).
- **Port map** (R24 — a registry, never folklore): **8770** Eden admin (its only held port) · 8765/8766 v1 (reserved while coexisting) · **8767 Java settlement (shared, stateless per request — Eden POSTs to it; `./gradlew runServer` steals it, R29)** · 25565 `PaulsBrawlsVanilla` (RCON 25575, production/eval) · 25599 dev server. **Read `run/server.properties`, never assume the port (R28).**
- **Identity** (R12): Eden's avatar is **`Dieu`** — never v1's `LLMBot`/`GodBot`; villagers use French roster names; the eval harness namespaces every username `EvalBot*`. Minecraft kicks the second login of a name, so every login across all coexisting systems must be pairwise distinct.

### Live test suite ([docs/19](docs/19-live-test-suite.md), [docs/20](docs/20-live-test-process.md), code in [eden/live-tests/](eden/live-tests/))

A **real server + real LLM + real mineflayer** regression net — distinct from the mock-LLM CI eval in
[eden/eval/](eden/eval/). NOT in `npm run check` (needs a server + paid key, non-deterministic); only the
harness *logic* is CI-checked (typed/lint-clean + `tests/live-tests-catalogue.test.ts` validates structure).

- `npm run live-test [name]` — process-isolated (each scenario in a killable child; the parent hard-kills a wedge from its own healthy event loop). Evidence under `live-tests/.runs/<scenario>-<ts>/` (gitignored): `eden.db`, `llm/*.json`, `journal-report.txt`, `result.json`.
- **Three scenarios** (lowest real-mineflayer risk first): `farm-wheat` (crop break + drop pickup — the end-to-end prover, reaches `skill.admit`), `craft-wooden-tools` (`recipesFor`/`craft` + crafting-table windows), `cooperative-mob-defense` (`pvp.attack` + armor + multi-villager scheduling).
- **The process** (docs/20) is a hardening engine: run → diagnose (read the journal + RCON ground truth) → fix the one spot → re-run → file the finding (a new pitfall becomes the next `R#`, S8). Diagnostic playbook: simultaneous bot disconnects + a frozen journal = **event-loop wedge, not a network bug**; `skill.run ok=false "bot.X is not a function"` = a real-mineflayer API mismatch the fakes didn't model. The first session filed W/C/D1/D2/E.

### Hard-won lessons = acceptance criteria

v1's debugging scars are encoded as requirements **R1–R61** in [docs/07-hard-won-lessons.md](docs/07-hard-won-lessons.md)
(each maps to a real session; R44–R49 from the OQ co-design, R50–R61 from live farming-hamlet sessions). They are pinned by tests, not prose. Clusters:
**crafting** (R1–R3: close stray windows first / window hijack, trust inventory diffs only after packet
quiescence, pause auto-eat/armor-manager around multi-click sequences); **abort** (R4–R5: a *sequence* —
collectblock → pvp → pathfinder `stop()` THEN `setGoal(null)` → close window → macrotask settle); **movement**
(R6–R10/R26: bound the pathfinder at spawn — upstream default is UNBOUNDED — hop far goals in ≤40-block legs,
`viewDistance:'short'`, trunk-logs-only collection); **identity/protocol** (R11–R14); **LLM plumbing**
(R19–R22); **cognition economics** (R33–R37: completion ≠ progress but quiet ≠ futile → you need a *judge*,
not a counter; one incident = one wake-up); **operations** (R28–R32/R38–R43).

### Keeping it simple ([docs/08](docs/08-extension-recipes.md))

The dependency law plus **ten simplicity rules S1–S10** — the load-bearing ones: additions are **registry
rows, never branches** (S1); **one writer per state** (S2); no abstraction before the second consumer (S3,
`GrantPolicy` the one exception); a banned-machinery list — no DI containers, plugin loaders, event-sourcing
for live state, ORMs (S5); prompts in dedicated files with golden snapshot tests (S6); **behavior + docs
change in the same commit** (S8); **special cases feed the judge** — code captures the signal, God's critic
applies the policy (S9); errors carry evidence (S10). docs/08 has mechanical extension recipes (exact files
touched) for every common addition — stepping outside a recipe's file list means the change is fighting the
architecture.

---

## Gotchas

### Eden

- **Work only under `eden/` and `docs/`** when implementing Eden — never touch `minecraft-mcp-server/` or `src/` (v1/Java) from an Eden task. The dependency law is CI-enforced; an upward import fails `npm run check`.
- **Test runner is `node:test` via tsx, not ava.** `monitorEventLoopDelay` must be **armed before** a sync block or it records ~0 ns (cost a debugging detour in the D-07 lag test).
- **`console.*` is banned outside [eden/src/logger.ts](eden/src/logger.ts)** (R23); every error names its subject + args (S10). `tsconfig` is strict with `verbatimModuleSyntax` → use `import type` for type-only imports.
- **Named imports for the mineflayer plugin trio** (`mineflayer-pvp`/`collectblock`/`tool`, R15) — they ship CJS with `__esModule` but no `default`; ava-tsx refuses to synthesize a default. (Same applies in v1's `minecraft-mcp-server`.)
- **A skill run can wedge the whole host** (finding W) — the macrotask-starvation canary catches a microtask-spinning loop; `installProcessGuards` catches an *async* throw from mineflayer's physics tick. Both are opt-in (a real boot sets them; tests must not, or a global handler would swallow the test runner's failures).
- **If you change the skill `ctx` surface, keep the runtime object in lockstep** with what skills are told they can call — a stock/exemplar skill validated against FakeBot but wrong on real mineflayer is exactly the Z/C/E class of live-test finding.

### The Fabric mod / AI God

- **The God-Body avatar needs op for `/tp`.** Op-on-join is automatic if the username matches `BridgeConfig.botUsername` — but only on a **real dedicated server** (Open-to-LAN singleplayer randomizes ports and can't op reliably).
- **`MCPGateway.ensureStarted` is best-effort.** If the SSE handshake fails (404 because the legacy bridge-only entrypoint is running instead of unified; ECONNREFUSED if no Node process), the exception is caught and godBot runs with its Java tool set only — silent in normal play. Check the `MCP gateway up — N tool(s) discovered` / `MCP gateway start FAILED` log line on first `/pray`.
- **`MCPGateway.INSTANCE.tools()` caches** the last successful `listTools()`. Adding/removing Node tools does NOT propagate while healthy — run `/mcp reload`.
- **The 1.21.1 pin is everywhere** — server, mod, and bot must agree (`SUPPORTED_MINECRAFT_VERSION` in `bot-connection.ts`).
- **`dig-block` is TEMP-disabled** at user request (registration commented out, two ava tests `test.skip`'d — NOT a defect). Restore path: grep `TEMP DISABLED`/`TEMP SKIPPED` (five spots) + `CANONICAL_TOOLS` in `verify-mcp-tools.mjs`. `move-in-direction` was **permanently removed** (blind WASD, no obstacle awareness) — don't re-add it.
- **`Mineflayer detected … deprecated event (physicTick)`** on every spawn is harmless upstream noise from a loaded plugin — don't chase it.
- **The bundled LangChain4j + OkHttp/Okio/Kotlin pile** is jar-in-jar'd via `include` in [build.gradle](build.gradle) specifically because `langchain4j-mcp`'s `HttpMcpTransport` is OkHttp-based. Without those lines the first `/pray` NCDFEs on `okhttp3/Interceptor`. When bumping `langchain4j-mcp`, re-derive the pins with `./gradlew dependencyInsight --dependency okhttp`.

### Coexistence & decommission

- **v1 and Eden may run side-by-side** until parity sign-off (the soak). They must **never share a bot username** (R12) and must bind distinct ports (Eden 8770; v1 8765/8766; shared 8767). The cut-over + non-destructive decommission checklist is [docs/17-parity-signoff.md §5](docs/17-parity-signoff.md). What Eden does NOT replace: the Java mod (settlement, Gibber, CTF, AI-God), op-on-join, and the unified bridge/MCP that drives the Java AI-God's avatar.
- **CI uploads to GitHub Releases on push to `main`/`master`** ([.github/workflows/ci.yml](.github/workflows/ci.yml)). The mod's `test` job still calls `./gradlew test` + `jacocoTestReport` though no tests exist and Jacoco isn't applied — both fail until tests are added or the steps are removed. The Eden CI ([eden-ci.yml](.github/workflows/eden-ci.yml)) is the one that actually gates Eden work.

## Reference docs

| Topic | Doc |
|---|---|
| **Verified reference for every system (code-checked; index for MCP serving)** — start at the overview; discrepancies with this file are listed in VERIFICATION-NOTES | [docs/system/README.md](docs/system/README.md), [docs/system/VERIFICATION-NOTES.md](docs/system/VERIFICATION-NOTES.md) |
| Eden — full design spec (reading order, 13 owner decisions) | [docs/README.md](docs/README.md) |
| Eden — 10-minute orientation (every choice, chosen + rejected) | [docs/10-architecture-summary.md](docs/10-architecture-summary.md) |
| Eden — build plan (M0–M7 DAG, tests, risk register) | [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) |
| Eden — session-by-session build log | [docs/PROGRESS.md](docs/PROGRESS.md) |
| Eden — agent orientation (work inside `eden/`) | [eden/CLAUDE.md](eden/CLAUDE.md) |
| Eden — parity sign-off + v1 decommission | [docs/17-parity-signoff.md](docs/17-parity-signoff.md) |
| AI God — body integration plan / verification | [GOD_BOT_INTEGRATION_PLAN.md](GOD_BOT_INTEGRATION_PLAN.md), [VERIFICATION.md](VERIFICATION.md) |
| MCP tools — ground truth | [MCP_TOOLS_VERIFICATION.md](MCP_TOOLS_VERIFICATION.md) |
| v1 village (legacy) — design + decision log | [VILLAGE_PLAN.md](VILLAGE_PLAN.md), [minecraft-mcp-server/DEPRECATED.md](minecraft-mcp-server/DEPRECATED.md) |
