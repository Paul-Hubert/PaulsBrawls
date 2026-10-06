---
id: aigod.overview
title: AI God (Java /pray God) — overview
system: aigod
summary: What the Java AI God is, the end-to-end /pray flow, component map, the Java-God vs Eden-Dieu distinction, and where every piece of state lives.
tags: [aigod, chatbot, pray, langchain4j, overview, god-body, llmbot, dieu, architecture]
sources: [src/main/java/com/paul/brawl/ChatBot.java, src/main/java/com/paul/brawl/BuildGuard.java, src/main/java/com/paul/brawl/GodToolGate.java, src/client/java/com/paul/brawl/Screenshotter.java, src/main/java/com/paul/brawl/ChatCommand.java, src/main/java/com/paul/brawl/ChatBotFunctions.java, src/main/java/com/paul/brawl/ChatBotActions.java, src/main/java/com/paul/brawl/GodService.java, src/main/java/com/paul/brawl/GodWorld.java, src/main/java/com/paul/brawl/MinecraftGodWorld.java, src/main/java/com/paul/brawl/BuildService.java, src/main/java/com/paul/brawl/MinecraftBuildWorld.java, src/main/java/com/paul/brawl/MainThread.java, src/main/java/com/paul/brawl/WorldRefusal.java, src/main/java/com/paul/brawl/GodSessionManager.java, src/main/java/com/paul/brawl/GodActionQueue.java, src/main/java/com/paul/brawl/MCPGateway.java, src/main/java/com/paul/brawl/LLMConfig.java, src/main/java/com/paul/brawl/BridgeConfig.java, src/main/java/com/paul/brawl/MCPConfig.java, src/main/java/com/paul/brawl/VillageConfig.java, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/main/java/com/paul/brawl/TradeOffers.java, src/main/java/com/paul/brawl/Raycaster.java, src/main/java/com/paul/brawl/ChatMessageHistory.java, src/main/java/com/paul/brawl/ImageReceiver.java, src/client/java/com/paul/brawl/ClientEntryPoint.java, eden/eden.example.json, eden/src/config.ts, prompt.txt]
verified_at: 98cb908
---

# AI God (Java /pray God) — overview

**TL;DR.** The "AI God" is a LangChain4j chat agent living inside the Fabric mod (`src/main/java/com/paul/brawl/`).
Players talk to it with `/pray <text>`; it answers in French as "Dieu", and acts on the world through Java tool
POJOs (`Reward`, `Trade`, `Punishment`, …) plus Mineflayer tools discovered over MCP. It may drive a physical
avatar bot (username `LLMBot` by default) through an HTTP bridge. Memory is per-player, client-side, in RAM only.
This God is **not** Eden's village God (`Dieu` avatar username) — they are separate processes and identities.

## What it is

- Two `ChatBot` instances are created at server start (`ChatBot.java:131-171`):
  - `ChatBot.godBot` — reads `prompt.txt`; the `/pray` God. Flags: `hasImage=true`, `needsInfo=true`,
    `needsBuildTools=false`, `needsGodTools=true`, `needsBuildPlan=false`, `needsMcpTools=true`.
  - `ChatBot.buildBot` — reads `build_prompt.txt`; the `/build` architect. Flags: `hasImage=true` (bug #9; was `false`),
    `needsInfo=false`, `needsBuildTools=true`, `needsGodTools=false`, `needsBuildPlan=true`, `needsMcpTools=false`.
- `ChatBot.register()` is only called from `ServerEntryPoint.onInitializeServer()` (`ServerEntryPoint.java:32`),
  which is a `DedicatedServerModInitializer`. **The AI God exists only on a dedicated server** — not in
  singleplayer / Open-to-LAN (the client entrypoint never calls it; `ClientEntryPoint.java:9-11`).
- Provider-agnostic: one shared LangChain4j `ChatModel` built from `LLMConfig` (OpenAI, LM Studio, Ollama, or
  Anthropic) — see [llm-pipeline.md](llm-pipeline.md) and [configuration-and-commands.md](configuration-and-commands.md).
- Player-facing strings are French; every God chat line is prefixed `"Dieu : "` (`ChatBot.java:629`).

## The two Gods (do not confuse)

| | Java AI God (this doc set) | Eden village God |
|---|---|---|
| Code | `src/main/java/com/paul/brawl/ChatBot*.java` (JVM, Fabric mod) | `eden/src/god/` (Node, separate process) |
| Trigger | `/pray`, `/prove`, `/build` | Eden's own curriculum/critic/orchestrator loop |
| LLM lib | LangChain4j 1.0.0 (`build.gradle:40-49`) | Eden's own LLM layer |
| Avatar Minecraft username | `BridgeConfig.botUsername`, default **`LLMBot`** (`BridgeConfig.java:36`) | **`Dieu`** (`eden/eden.example.json:26`; Java side knows it as `VillageConfig.edenAvatarName = "Dieu"`, `VillageConfig.java:50`) |
| Avatar driver | Node "unified bridge" at `BridgeConfig.bridgeUrl` (default `http://127.0.0.1:8765`) | Eden's own mineflayer pool |
| Chat persona prefix | `"Dieu : "` (text only — `ChatBot.java:629`) | n/a |

Eden warns if its god name equals `LLMBot` (`eden/src/config.ts:9`, `:378-379`). Both avatars are auto-opped on join
(`ServerEntryPoint.java:65-78`). Naming hazard: the Java God *calls itself* "Dieu" in chat while Eden's avatar
*username* is `Dieu`; a chat log line `Dieu : …` from `ChatPrinter` (Java God, private) is distinct from a public
chat message *sent by* the player-entity `Dieu` (Eden).

## Component map

| Component | File | Role |
|---|---|---|
| `ChatBot` | `ChatBot.java` | Per-bot state (memory, depth, session-bound flags, Wait deferrals), request assembly, response callback/tool loop, `endPrayerSession`. |
| `ChatCommand` | `ChatCommand.java` | `/pray`, `/pray stop`, `/godbody on|off`, `/prompt`. |
| `GodClamps` / `ItemIds` / `GodToolGate` / `BuildGuard` | `GodClamps.java`, `ItemIds.java`, `GodToolGate.java`, `BuildGuard.java` | Minecraft-free limits added by bugs #6/#7/#8: Reward/Punishment/Spawn clamps, item-id parsing, MCP-tool ownership gate, sub-build and per-call block caps. |
| `ChatBotFunctions` | `ChatBotFunctions.java` | Tool POJOs (thin: world tools forward to `GodService`), `buildToolSpecs`, `checkForFunctions` dispatch, textual `PlaceBlock*` regex scanner (placements go through `BuildService`). |
| `GodService` / `GodWorld` / `MinecraftGodWorld` | `GodService.java`, `GodWorld.java`, `MinecraftGodWorld.java` | God's world layer (docs/27 phase 2): `GodService` holds the clamps, refusals, the owner gate for `Appear`/`Vanish` and the gestures, and calls the Minecraft-free `GodWorld` port; `MinecraftGodWorld` applies effects on the main thread. Unit-tested by `GodServiceTest` with a recording world. |
| `BuildService` / `BuildWorld` / `MinecraftBuildWorld` / `BuildShapes` | `BuildService.java`, `BuildWorld.java`, `MinecraftBuildWorld.java`, `BuildShapes.java` | Builder world layer: per-call block cap + known-block check, one bulk-lane `GodActionQueue` task per call, line/points offset walks. See [building.md](building.md). |
| `MainThread` / `WorldRefusal` | `MainThread.java`, `WorldRefusal.java` | Bounded (5 s) main-thread hop, inline on the server thread; the refusal exception whose message the model reads. |
| `QueryTerrain` | `QueryTerrain.java` | Tool POJO: ASCII relief map. |
| `JsonSchemaAdapter` / `OptionalField` | `JsonSchemaAdapter.java`, `OptionalField.java` | POJO → LangChain4j `ToolSpecification`. |
| `ChatBotActions` | `ChatBotActions.java` | Already-checked world effects (give item, lightning, weather, spawn, block placement, avatar invuln; failures thrown as `WorldRefusal`), `/block`, `/construction`. |
| `TradeOffers` | `TradeOffers.java` | Pending trade per player + `/accept`. |
| `PlayerDataCollector` | `PlayerDataCollector.java` | Per-turn player JSON snapshot. |
| `ChatMessageHistory` | `ChatMessageHistory.java` | Rolling 40-line server chat/game log fed to the model. |
| `ChatPrinter` | `ChatPrinter.java` | Private `player.sendMessage` helper (+ unused `broadcast`). |
| `LLMConfig` / `LLMCommand` | `LLMConfig.java`, `LLMCommand.java` | Provider settings, shared model + executor, `/llm`. |
| `ImagePayload` / `ImageReceiver` / `Screenshotter` | see [images-and-client.md](images-and-client.md) | `/prove` & `/build` screenshot path. |
| `GodSessionManager` | `GodSessionManager.java` | Single-owner avatar lock (player and UUID forms), `manifested` flag, idle watchdog, session `generation` counter, end listeners. See [god-body.md](god-body.md). |
| `GodActionQueue` | `GodActionQueue.java` | Main-thread FIFO lanes drained on `END_SERVER_TICK`: 8 God actions then 8 build placements per tick; a waiter can withdraw an unstarted action. |
| `GodScheduler` | `GodScheduler.java` | Background scheduler used for `Wait` deferrals and the watchdog. |
| `GodBody` / `BotBridgeClient` / `BridgeConfig` | see [god-body.md](god-body.md) | Avatar HTTP bridge. |
| `MCPGateway` / `MCPConfig` / `MCPCommand` | see [mcp-gateway.md](mcp-gateway.md) | Mineflayer tools over MCP-SSE. |
| `BuildSubAgent` / `Raycaster` | see [building.md](building.md) | `BuildPlan` sub-agents, `/construction` pivot. |

## End-to-end flow of a `/pray`

```mermaid
sequenceDiagram
    autonumber
    participant P as Player
    participant MT as Server main thread
    participant GSM as GodSessionManager
    participant CB as ChatBot.godBot
    participant W as llm-worker (virtual thread)
    participant Q as GodActionQueue (END_SERVER_TICK)
    participant MCP as MCPGateway
    participant LLM as ChatModel (provider)
    participant GB as GodBody → bridge

    P->>MT: /pray <text>
    MT->>P: "<name> : <text>" (private echo)
    MT->>GSM: claim(player)
    alt another player owns the avatar
        MT->>P: "Dieu : (occupé ailleurs — je t'écoute, mais sans forme.)"
    end
    MT->>CB: sendChatRequest(text, player)
    Note over CB: flushPendingDeferral; depth=0;<br/>sessionBound=isActive(player);<br/>memory.add(UserMessage)
    CB->>W: supplyAsync(...)
    W->>Q: submit(collect player JSON + chat log + block info) .get(5s)
    Q-->>W: context strings (or "" on timeout)
    W->>MCP: tools() (lazy connect on first use)
    W->>LLM: chat(system msgs + memory, tool specs)
    LLM-->>W: ChatResponse
    Note over W: setupGeneralCallback:<br/>drop if session ended mid-flight;<br/>memory.add(AiMessage); print "Dieu : text"
    opt manifested & owner
        W->>GB: say(text)
    end
    alt response has tool calls
        W->>Q: GodService → MainThread.call(Reward/Trade/Punishment/...) (.get 5s each)
        W->>MCP: execute(kebab-case tool) (only if bridge enabled & owner)
        W->>GB: gestures after each effect (if manifested & owner)
        alt a Wait was called
            W-->>W: GodScheduler defers sendFunctionOutputs N s
        else
            W->>CB: sendFunctionOutputs → new LLM turn (loop, depth ≤ 100)
        end
    else no tool calls and player owns session
        W->>GB: endPrayerSession → restoreAvatar + vanish (if manifested)
        W->>GSM: endSession(player)
    end
```

Step citations: echo + claim `ChatCommand.java:91-113`; entry bookkeeping `ChatBot.java:258-269`; worker
assembly `ChatBot.java:402-427`; context hop `ChatBot.java:498-522`; callback `ChatBot.java:524-575`; dispatch
`ChatBotFunctions.java:335-461`; teardown `ChatBot.java:582-589`. Full detail: [llm-pipeline.md](llm-pipeline.md).

### Other entry points into the same pipeline

| Entry | Bot | Notes |
|---|---|---|
| `/pray <text>` (perm 0) | `godBot` | Claims avatar; text-only `UserMessage`. |
| Client `/prove <text>` → `ImagePayload` text `"Prove : …"` | `godBot` (`ChatBot.getCorrectChatBot`, `ChatBot.java:646-653`) | Claims avatar (`ImageReceiver.java:33`); image attached as `ImageContent`. ~~Client command is currently broken~~ **Fixed (bug #9):** `/prove` now runs (`greedyString` argument, `Screenshotter.java:52-53`) — see [images-and-client.md](images-and-client.md). |
| Client `/build <text>` → text `"Build : …"` | `buildBot` | No claim; ~~`hasImage=false` so the screenshot is dropped server-side~~ **Fixed (bug #9):** `buildBot.hasImage=true`, so the screenshot is attached (`ChatBot.java:135-138`). |
| `BuildPlan` tool | `BuildSubAgent` instances | Separate memory per sub-agent; see [building.md](building.md). |
| `Wait` continuation | same bot | `GodScheduler` thread calls `sendFunctionOutputs` (`ChatBot.java:322-338`). |

## Where state lives

| State | Location | Scope / lifetime | Persisted? |
|---|---|---|---|
| Conversation memory | `ChatBot.memories: ConcurrentHashMap<UUID, ChatMemory>` (`ChatBot.java:85`) — one map per bot instance | Per player, per bot; survives across prayers and session ends; cleared by `clearMemory`, `/construction` (buildBot only), `/llm reload`/provider/host/port/apikey/timeout changes | No (RAM) |
| Tool-loop depth | `ChatBot.functionCallDepth` (`ChatBot.java:43`) | Reset to 0 on each user message | No |
| "Started with the avatar" flag | `ChatBot.sessionBound` (`ChatBot.java:96`) | Set at each user entry point (godBot only) | No |
| Pending `Wait` deferral | `ChatBot.pendingDeferrals` (`ChatBot.java:109`) | At most one per player per bot | No |
| Avatar lock, manifested flag, watchdog | `GodSessionManager` statics (`GodSessionManager.java:32-49`) | Global, single owner | No |
| Pending trade offer | `TradeOffers.offers: HashMap<UUID, TradeOffer>` (`TradeOffers.java:110`) | One per player, expires after 5 min | No |
| `/construction` pivot | `Raycaster.lastPos: HashMap<UUID, BlockPos>` (`Raycaster.java:21`) | Per player | No |
| Server chat/game log | `ChatMessageHistory.messageHistory` (40 lines, `ChatMessageHistory.java:14`) | Global | No |
| Runtime prompt override | `ChatBot.prompt` (set by `/prompt <text>`, `ChatCommand.java:127-128`) | Both bots | No |
| Base persona | `prompt.txt`, `build_prompt.txt` in the JVM cwd (`ChatBot.java:132-133`, `:638-644`) | Re-read on `/prompt` | File |
| LLM provider settings | `llm_config.properties` in cwd (`LLMConfig.java:29`) | Global | File |
| Avatar/bridge settings | `bridge_config.properties` in cwd (`BridgeConfig.java:25`) | Global | File |
| MCP settings | `mcp_config.properties` in cwd (`MCPConfig.java:46`) | Global | File |

The cwd is the server's working directory (production: the `PaulsBrawlsVanilla` server dir; dev
`./gradlew runServer`: `run/`). Nothing about a conversation survives a server restart.

## Threading model in one paragraph

Commands and the `ImagePayload` receiver run on the server thread. All LLM work runs on `llm-worker-N` virtual
threads from `LLMConfig.sharedExecutor()` (`LLMConfig.java:155-163`). The response callback (`thenAccept`) runs on
the worker that completed the future, so tool dispatch happens off-thread; world-touching tools hop to the main
thread through `GodService` → `MinecraftGodWorld` → `MainThread.call` = `GodActionQueue.submit(...).get(5, SECONDS)`
(`MainThread.java:31-63`; inline when already on the server thread, a `WorldRefusal` message on timeout). Bridge calls
(`GodBody.*`) are async HTTP and never touch world state. Never call a queue-and-join from the main thread
(`collectDynamicContext` guards this explicitly, `ChatBot.java:507-512`).

## Gotchas & known issues

- Dedicated-server only (see above). Testing in singleplayer silently gives you no `/pray` at all.
- Memory is never evicted per *player* (map grows with every distinct UUID that ever prayed); each entry is capped
  at 16 000 tokens.
- `endPrayerSession` does **not** clear memory — the next `/pray` continues the same conversation.
- The Java God's chat prefix "Dieu" collides visually with Eden's avatar username `Dieu` (see table above).
- ~~`fireGestures` checks `GodSessionManager.hasManifested()` globally, not ownership~~ **Fixed (bug #8):** the gesture
  (now fired by `GodService.gesture`, `fireGestures` is gone) also requires `GodSessionManager.isOwner(uuid)`, so a
  bodiless player's `Punishment`/`Reward` no longer moves the owner's avatar (`GodService.java:226-238`).

## Related

- [llm-pipeline.md](llm-pipeline.md) — request assembly, memory, tool loop, threading, providers
- [tools-catalogue.md](tools-catalogue.md) — every tool, schema, dispatch
- [actions-and-trades.md](actions-and-trades.md) — world effects, trades, `/accept`
- [images-and-client.md](images-and-client.md) — `/prove`, `/build`, `ImagePayload`
- [configuration-and-commands.md](configuration-and-commands.md) — `LLMConfig`, `/llm`, `/pray`, `/prompt`, prompt.txt
- [god-body.md](god-body.md) — avatar, bridge, session lock, watchdog
- [mcp-gateway.md](mcp-gateway.md) — MCP tools
- [building.md](building.md) — `BuildPlan`, `BuildSubAgent`, `/construction`
- [../eden/overview.md](../eden/overview.md) — Eden, the *other* God
- [../platform/entrypoints-and-wiring.md](../platform/entrypoints-and-wiring.md)
