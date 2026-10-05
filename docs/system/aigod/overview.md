---
id: aigod.overview
title: AI God (Java /pray God) — overview
system: aigod
summary: What the Java AI God is, the end-to-end /pray flow, component map, the Java-God vs Eden-Dieu distinction, and where every piece of state lives.
tags: [aigod, chatbot, pray, langchain4j, overview, god-body, llmbot, dieu, architecture]
sources: [src/main/java/com/paul/brawl/ChatBot.java, src/main/java/com/paul/brawl/ChatCommand.java, src/main/java/com/paul/brawl/ChatBotFunctions.java, src/main/java/com/paul/brawl/ChatBotActions.java, src/main/java/com/paul/brawl/GodSessionManager.java, src/main/java/com/paul/brawl/GodActionQueue.java, src/main/java/com/paul/brawl/MCPGateway.java, src/main/java/com/paul/brawl/LLMConfig.java, src/main/java/com/paul/brawl/BridgeConfig.java, src/main/java/com/paul/brawl/MCPConfig.java, src/main/java/com/paul/brawl/VillageConfig.java, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/main/java/com/paul/brawl/TradeOffers.java, src/main/java/com/paul/brawl/Raycaster.java, src/main/java/com/paul/brawl/ChatMessageHistory.java, src/main/java/com/paul/brawl/ImageReceiver.java, src/client/java/com/paul/brawl/ClientEntryPoint.java, eden/eden.example.json, eden/src/config.ts, prompt.txt]
verified_at: 4a8081f
---

# AI God (Java /pray God) — overview

**TL;DR.** The "AI God" is a LangChain4j chat agent living inside the Fabric mod (`src/main/java/com/paul/brawl/`).
Players talk to it with `/pray <text>`; it answers in French as "Dieu", and acts on the world through Java tool
POJOs (`Reward`, `Trade`, `Punishment`, …) plus Mineflayer tools discovered over MCP. It may drive a physical
avatar bot (username `LLMBot` by default) through an HTTP bridge. Memory is per-player, client-side, in RAM only.
This God is **not** Eden's village God (`Dieu` avatar username) — they are separate processes and identities.

## What it is

- Two `ChatBot` instances are created at server start (`ChatBot.java:131-169`):
  - `ChatBot.godBot` — reads `prompt.txt`; the `/pray` God. Flags: `hasImage=true`, `needsInfo=true`,
    `needsBuildTools=false`, `needsGodTools=true`, `needsBuildPlan=false`, `needsMcpTools=true`.
  - `ChatBot.buildBot` — reads `build_prompt.txt`; the `/build` architect. Flags: `hasImage=false`,
    `needsInfo=false`, `needsBuildTools=true`, `needsGodTools=false`, `needsBuildPlan=true`, `needsMcpTools=false`.
- `ChatBot.register()` is only called from `ServerEntryPoint.onInitializeServer()` (`ServerEntryPoint.java:32`),
  which is a `DedicatedServerModInitializer`. **The AI God exists only on a dedicated server** — not in
  singleplayer / Open-to-LAN (the client entrypoint never calls it; `ClientEntryPoint.java:9-11`).
- Provider-agnostic: one shared LangChain4j `ChatModel` built from `LLMConfig` (OpenAI, LM Studio, Ollama, or
  Anthropic) — see [llm-pipeline.md](llm-pipeline.md) and [configuration-and-commands.md](configuration-and-commands.md).
- Player-facing strings are French; every God chat line is prefixed `"Dieu : "` (`ChatBot.java:627`).

## The two Gods (do not confuse)

| | Java AI God (this doc set) | Eden village God |
|---|---|---|
| Code | `src/main/java/com/paul/brawl/ChatBot*.java` (JVM, Fabric mod) | `eden/src/god/` (Node, separate process) |
| Trigger | `/pray`, `/prove`, `/build` | Eden's own curriculum/critic/orchestrator loop |
| LLM lib | LangChain4j 1.0.0 (`build.gradle:40-49`) | Eden's own LLM layer |
| Avatar Minecraft username | `BridgeConfig.botUsername`, default **`LLMBot`** (`BridgeConfig.java:36`) | **`Dieu`** (`eden/eden.example.json:26`; Java side knows it as `VillageConfig.edenAvatarName = "Dieu"`, `VillageConfig.java:37`) |
| Avatar driver | Node "unified bridge" at `BridgeConfig.bridgeUrl` (default `http://127.0.0.1:8765`) | Eden's own mineflayer pool |
| Chat persona prefix | `"Dieu : "` (text only — `ChatBot.java:627`) | n/a |

Eden warns if its god name equals `LLMBot` (`eden/src/config.ts:9`, `:366`). Both avatars are auto-opped on join
(`ServerEntryPoint.java:61-74`). Naming hazard: the Java God *calls itself* "Dieu" in chat while Eden's avatar
*username* is `Dieu`; a chat log line `Dieu : …` from `ChatPrinter` (Java God, private) is distinct from a public
chat message *sent by* the player-entity `Dieu` (Eden).

## Component map

| Component | File | Role |
|---|---|---|
| `ChatBot` | `ChatBot.java` | Per-bot state (memory, depth, session-bound flags, Wait deferrals), request assembly, response callback/tool loop, `endPrayerSession`. |
| `ChatCommand` | `ChatCommand.java` | `/pray`, `/pray stop`, `/godbody on|off`, `/prompt`. |
| `ChatBotFunctions` | `ChatBotFunctions.java` | Tool POJOs, `buildToolSpecs`, `checkForFunctions` dispatch, `runOnMain`, gestures, textual `PlaceBlock*` regex scanner. |
| `QueryTerrain` | `QueryTerrain.java` | Tool POJO: ASCII relief map. |
| `JsonSchemaAdapter` / `OptionalField` | `JsonSchemaAdapter.java`, `OptionalField.java` | POJO → LangChain4j `ToolSpecification`. |
| `ChatBotActions` | `ChatBotActions.java` | World effects (give item, lightning, weather, spawn, block placement, avatar invuln), `/block`, `/construction`. |
| `TradeOffers` | `TradeOffers.java` | Pending trade per player + `/accept`. |
| `PlayerDataCollector` | `PlayerDataCollector.java` | Per-turn player JSON snapshot. |
| `ChatMessageHistory` | `ChatMessageHistory.java` | Rolling 40-line server chat/game log fed to the model. |
| `ChatPrinter` | `ChatPrinter.java` | Private `player.sendMessage` helper (+ unused `broadcast`). |
| `LLMConfig` / `LLMCommand` | `LLMConfig.java`, `LLMCommand.java` | Provider settings, shared model + executor, `/llm`. |
| `ImagePayload` / `ImageReceiver` / `Screenshotter` | see [images-and-client.md](images-and-client.md) | `/prove` & `/build` screenshot path. |
| `GodSessionManager` | `GodSessionManager.java` | Single-owner avatar lock, `manifested` flag, idle watchdog. See [god-body.md](god-body.md). |
| `GodActionQueue` | `GodActionQueue.java` | Main-thread FIFO drained on `END_SERVER_TICK`, `MAX_PER_TICK = 8` (`GodActionQueue.java:31`). |
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
        W->>Q: runOnMain(Reward/Trade/Punishment/...) (.get 5s each)
        W->>MCP: execute(kebab-case tool)
        W->>GB: gestures (if manifested)
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

Step citations: echo + claim `ChatCommand.java:87-109`; entry bookkeeping `ChatBot.java:256-267`; worker
assembly `ChatBot.java:400-425`; context hop `ChatBot.java:496-520`; callback `ChatBot.java:522-573`; dispatch
`ChatBotFunctions.java:351-471`; teardown `ChatBot.java:580-587`. Full detail: [llm-pipeline.md](llm-pipeline.md).

### Other entry points into the same pipeline

| Entry | Bot | Notes |
|---|---|---|
| `/pray <text>` (perm 0) | `godBot` | Claims avatar; text-only `UserMessage`. |
| Client `/prove` → `ImagePayload` text `"Prove : …"` | `godBot` (`ChatBot.getCorrectChatBot`, `ChatBot.java:644-651`) | Claims avatar (`ImageReceiver.java:33`); image attached as `ImageContent`. Client command is currently broken — see [images-and-client.md](images-and-client.md). |
| Client `/build "<text>"` → text `"Build : …"` | `buildBot` | No claim; `hasImage=false` so the screenshot is dropped server-side. |
| `BuildPlan` tool | `BuildSubAgent` instances | Separate memory per sub-agent; see [building.md](building.md). |
| `Wait` continuation | same bot | `GodScheduler` thread calls `sendFunctionOutputs` (`ChatBot.java:320-336`). |

## Where state lives

| State | Location | Scope / lifetime | Persisted? |
|---|---|---|---|
| Conversation memory | `ChatBot.memories: ConcurrentHashMap<UUID, ChatMemory>` (`ChatBot.java:85`) — one map per bot instance | Per player, per bot; survives across prayers and session ends; cleared by `clearMemory`, `/construction` (buildBot only), `/llm reload`/provider/host/port/apikey/timeout changes | No (RAM) |
| Tool-loop depth | `ChatBot.functionCallDepth` (`ChatBot.java:43`) | Reset to 0 on each user message | No |
| "Started with the avatar" flag | `ChatBot.sessionBound` (`ChatBot.java:96`) | Set at each user entry point (godBot only) | No |
| Pending `Wait` deferral | `ChatBot.pendingDeferrals` (`ChatBot.java:109`) | At most one per player per bot | No |
| Avatar lock, manifested flag, watchdog | `GodSessionManager` statics (`GodSessionManager.java:30-36`) | Global, single owner | No |
| Pending trade offer | `TradeOffers.offers: HashMap<UUID, TradeOffer>` (`TradeOffers.java:114`) | One per player, expires after 5 min | No |
| `/construction` pivot | `Raycaster.lastPos: HashMap<UUID, BlockPos>` (`Raycaster.java:21`) | Per player | No |
| Server chat/game log | `ChatMessageHistory.messageHistory` (40 lines, `ChatMessageHistory.java:14`) | Global | No |
| Runtime prompt override | `ChatBot.prompt` (set by `/prompt <text>`, `ChatCommand.java:123-124`) | Both bots | No |
| Base persona | `prompt.txt`, `build_prompt.txt` in the JVM cwd (`ChatBot.java:132-133`, `:636-642`) | Re-read on `/prompt` | File |
| LLM provider settings | `llm_config.properties` in cwd (`LLMConfig.java:29`) | Global | File |
| Avatar/bridge settings | `bridge_config.properties` in cwd (`BridgeConfig.java:25`) | Global | File |
| MCP settings | `mcp_config.properties` in cwd (`MCPConfig.java:46`) | Global | File |

The cwd is the server's working directory (production: the `PaulsBrawlsVanilla` server dir; dev
`./gradlew runServer`: `run/`). Nothing about a conversation survives a server restart.

## Threading model in one paragraph

Commands and the `ImagePayload` receiver run on the server thread. All LLM work runs on `llm-worker-N` virtual
threads from `LLMConfig.sharedExecutor()` (`LLMConfig.java:155-163`). The response callback (`thenAccept`) runs on
the worker that completed the future, so tool dispatch happens off-thread; world-touching tools hop to the main
thread through `GodActionQueue.submit(...).get(5, SECONDS)` (`ChatBotFunctions.java:488-498`). Bridge calls
(`GodBody.*`) are async HTTP and never touch world state. Never call a queue-and-join from the main thread
(`collectDynamicContext` guards this explicitly, `ChatBot.java:505-510`).

## Gotchas & known issues

- Dedicated-server only (see above). Testing in singleplayer silently gives you no `/pray` at all.
- Memory is never evicted per *player* (map grows with every distinct UUID that ever prayed); each entry is capped
  at 16 000 tokens.
- `endPrayerSession` does **not** clear memory — the next `/pray` continues the same conversation.
- The Java God's chat prefix "Dieu" collides visually with Eden's avatar username `Dieu` (see table above).
- `fireGestures` checks `GodSessionManager.hasManifested()` globally, not ownership — a bodiless player's
  `Punishment`/`Reward` makes the avatar (manifested for someone else) gesture / look at the bodiless player
  (`ChatBotFunctions.java:506-524`).

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
