---
id: platform.entrypoints-and-wiring
title: Mod entrypoints and event wiring
system: platform
summary: Line-by-line map of ServerEntryPoint and ClientEntryPoint - every registration, Fabric event hook, its order, and which class owns which subsystem.
tags: [fabric, entrypoint, ServerEntryPoint, ClientEntryPoint, events, JOIN, SERVER_STARTED, tick, commands, op-on-join, wiring]
sources: [src/main/java/com/paul/brawl/ServerEntryPoint.java, src/client/java/com/paul/brawl/ClientEntryPoint.java, src/client/java/com/paul/brawl/Screenshotter.java, src/main/java/com/paul/brawl/ChatBot.java, src/main/java/com/paul/brawl/ChatMessageHistory.java, src/main/java/com/paul/brawl/ChatCommand.java, src/main/java/com/paul/brawl/ChatBotActions.java, src/main/java/com/paul/brawl/ChatPrinter.java, src/main/java/com/paul/brawl/ImageReceiver.java, src/main/java/com/paul/brawl/ImagePayload.java, src/main/java/com/paul/brawl/TradeOffers.java, src/main/java/com/paul/brawl/LLMCommand.java, src/main/java/com/paul/brawl/MCPCommand.java, src/main/java/com/paul/brawl/GodActionQueue.java, src/main/java/com/paul/brawl/GodScheduler.java, src/main/java/com/paul/brawl/GibCommand.java, src/main/java/com/paul/brawl/RevenueManager.java, src/main/java/com/paul/brawl/SalaryScheduler.java, src/main/java/com/paul/brawl/Money.java, src/main/java/com/paul/brawl/FlagManager.java, src/main/java/com/paul/brawl/VillageCommand.java, src/main/java/com/paul/brawl/VillagersCommand.java, src/main/java/com/paul/brawl/VillageHttpListener.java, src/main/java/com/paul/brawl/BridgeConfig.java, src/main/java/com/paul/brawl/VillageConfig.java, src/main/java/com/paul/brawl/Prompts.java, src/main/resources/fabric.mod.json, src/main/java/com/paul/brawl/FlagGlow.java, src/main/java/com/paul/brawl/BuildGuard.java]
verified_at: 98cb908
---

# Mod entrypoints and event wiring

**TL;DR** — `ServerEntryPoint.onInitializeServer()` (dedicated server only) calls ten `register()`
methods in a fixed order and then adds its own `SERVER_STARTED`, `SERVER_STOPPING` and `JOIN` hooks.
`ClientEntryPoint.onInitializeClient()` registers only `Screenshotter` and the `coin` item. Nothing is
registered in a common `main` entrypoint, so an integrated (single-player/LAN) server runs none of the
server features. Fabric invokes same-event listeners in registration order, so the order below is the
runtime order.

## Entrypoint declaration

`src/main/resources/fabric.mod.json` declares only `server` → `com.paul.brawl.ServerEntryPoint` and
`client` → `com.paul.brawl.ClientEntryPoint`. `ServerEntryPoint` implements
`DedicatedServerModInitializer` (`ServerEntryPoint.java:11`); `ClientEntryPoint` implements
`ClientModInitializer` (`ClientEntryPoint.java:5`). The server logger is named `"Gibber"`
(`ServerEntryPoint.java:13`) even though it logs for every subsystem.

## `ServerEntryPoint.onInitializeServer()` — step by step

| # | Line | Call | What it registers (immediately or as a listener) |
|---|---|---|---|
| 1 | `:20` | `GibCommand.register()` | 3 × `CommandRegistrationCallback`: `/gib`, `/gib_salary`, `/gib_salary_period` (`GibCommand.java:20,49,72`) |
| 2 | `:22` | `RevenueManager.register()` | `ServerPlayConnectionEvents.JOIN` listener **#1** → `updateRevenue(uuid)` (backlog payout) (`RevenueManager.java:19-26`) |
| 3 | `:24` | `SalaryScheduler.register()` | `SERVER_STARTED` **#1** → `start(server)`; `SERVER_STOPPING` **#1** → `stop()` (`SalaryScheduler.java:21-28`) |
| 4 | `:26` | `Money.register()` | Immediate `Registry.register(Registries.ITEM, "paulsbrawls:coin", maxCount 99)` (`Money.java:18-23`) |
| 5 | `:30` | `FlagManager.register()` | `EntityElytraEvents.ALLOW`, `ServerLivingEntityEvents.ALLOW_DAMAGE`, `ServerTickEvents.START_WORLD_TICK`, `ServerPlayConnectionEvents.DISCONNECT` (forget the player's glow ownership) (`FlagManager.java:37,49,60,66`) |
| 6 | `:32` | `ChatBot.register()` | Builds `godBot` (`prompt.txt`) and `buildBot` (`build_prompt.txt`) — each constructor reads its prompt file from the cwd — then the sub-registrations in the next table (`ChatBot.java:131-171`) |
| 7 | `:35` | `GodActionQueue.register()` | `ServerTickEvents.END_SERVER_TICK` → drain up to `MAX_PER_TICK = 8` queued main-thread actions, then up to `MAX_BULK_PER_TICK = 8` build placements (`GodActionQueue.java:31,69-83`) |
| 8 | `:36` | `GodScheduler.register()` | `SERVER_STARTED` **#2** → `ensureStarted()` (daemon `god-scheduler-N` thread); `SERVER_STOPPING` **#2** → `shutdown()` (`GodScheduler.java:34-58`) |
| 9 | `:39` | `VillageCommand.register()` | `/village` command (`VillageCommand.java:42-82`) |
| 10 | `:42` | `VillagersCommand.register()` | `/villagers` command (`VillagersCommand.java:75-114`) |
| 11 | `:46-50` | inline `SERVER_STARTED` **#3** | `ChatBotActions.setServer(server)`; log `BridgeConfig loaded: …`; `VillageHttpListener.start(server)` (binds `127.0.0.1:8767` if enabled) |
| 12 | `:51-60` | inline `SERVER_STOPPING` **#3** | `GodActionQueue.clear()`; `ChatBotActions.restoreAvatarOnMain(server)` (clears the avatar's `Invulnerable` flag before players are saved, bug #5); `BuildGuard.cancelAll()` (bug #7); `GodSessionManager.forceEndSession()`; `ChatBotActions.setServer(null)`; `VillageHttpListener.stop()` |
| 13 | `:65-78` | inline `JOIN` **#2** | **Op-on-join** (below) |

### `ChatBot.register()` sub-registrations (`ChatBot.java:155-169`)

| Order | Call | Registers |
|---|---|---|
| a | `ChatMessageHistory.register()` | `ServerMessageEvents.CHAT_MESSAGE`, `COMMAND_MESSAGE`, `GAME_MESSAGE` → rolling chat log fed to the God prompt (`ChatMessageHistory.java:17-21`) |
| b | `ChatCommand.register()` | `/pray` (perm 0, incl. `/pray stop`), `/godbody on|off` (perm 2), `/prompt <text>` and `/prompt` (perm 2; registered twice, Brigadier merges the literal) (`ChatCommand.java:26,58,119,140`) |
| c | `ChatBotActions.register()` | `/block <x> <y> <z>` (perm 2, places stone), `/construction` (perm 2, sets build origin + clears build memory); both player-only via `getPlayerOrThrow`, so the console gets an error instead of an NPE (bug #18) (`ChatBotActions.java:56-57`, `:191-227`) |
| d | `ImageReceiver.commonRegister()` | `PayloadTypeRegistry.playC2S()` for `ImagePayload` id `screenshot:image` (`ImageReceiver.java:14-16`, `ImagePayload.java:11-13`) |
| e | `ImageReceiver.register()` | `ServerPlayNetworking.registerGlobalReceiver(ImagePayload.ID, …)` → `ChatBot.sendImageChatRequest` (`ImageReceiver.java:18-26`) |
| f | `TradeOffers.register()` | `/accept` (no `.requires` → perm 0) (`TradeOffers.java:120-130`) |
| g | `LLMCommand.register()` | `/llm …` incl. `/llm bridge …` (perm 2) (`LLMCommand.java:22-25`) |
| h | `MCPCommand.register()` | `/mcp` and `/mcp status` (no requirement), `/mcp reload` (perm 2; runs `MCPGateway.reload()` on the LLM worker pool, not the server thread, bug #18) (`MCPCommand.java:30-59`) |

Details of the AI God commands are in [../aigod/configuration-and-commands.md](../aigod/configuration-and-commands.md).

### Lazy / late registrations

- `ChatPrinter.broadcast(text)` registers a `ServerTickEvents.START_SERVER_TICK` listener the **first
  time it is called** (guarded by a plain `static boolean registered`) and then flushes queued broadcast
  strings each tick (`ChatPrinter.java:14-28`).
- Config singletons (`BridgeConfig.INSTANCE`, `VillageConfig.INSTANCE`, …) load their `.properties`
  file on first class use — for `BridgeConfig`/`VillageConfig` that is the `SERVER_STARTED` #3 log line or
  the first `JOIN`.

## Event hooks — consolidated, in invocation order

| Fabric event | Listeners in order | Thread |
|---|---|---|
| `ServerLifecycleEvents.SERVER_STARTED` | 1 `SalaryScheduler.start` · 2 `GodScheduler.ensureStarted` · 3 `ServerEntryPoint` (setServer, log, `VillageHttpListener.start`) | server thread |
| `ServerLifecycleEvents.SERVER_STOPPING` | 1 `SalaryScheduler.stop` · 2 `GodScheduler.shutdown` · 3 `ServerEntryPoint` (queue clear, avatar restore, sub-build cancel, force-end session, setServer(null), listener stop) | server thread |
| `ServerPlayConnectionEvents.JOIN` | 1 `RevenueManager` coin backlog · 2 op-on-join | server thread |
| `ServerPlayConnectionEvents.DISCONNECT` | `FlagManager` → `FlagGlow.forget(uuid)` | server thread |
| `ServerTickEvents.START_WORLD_TICK` | `FlagManager` glow update (per world, per tick) | server thread |
| `ServerTickEvents.END_SERVER_TICK` | `GodActionQueue` drain | server thread |
| `ServerTickEvents.START_SERVER_TICK` | `ChatPrinter` broadcast flush (lazy) | server thread |
| `ServerLivingEntityEvents.ALLOW_DAMAGE` | `FlagManager` drop-flag-on-hit (always returns `true`) | server thread |
| `EntityElytraEvents.ALLOW` | `FlagManager` elytra ban | (Fabric-invoked; server-side registration only) |
| `ServerMessageEvents.CHAT_MESSAGE` / `COMMAND_MESSAGE` / `GAME_MESSAGE` | `ChatMessageHistory` | server thread |
| `CommandRegistrationCallback` | `/gib`, `/gib_salary`, `/gib_salary_period`, `/pray`, `/godbody`, `/prompt`×2, `/block`, `/construction`, `/accept`, `/llm`, `/mcp`, `/village`, `/villagers` | — |
| C2S payload `screenshot:image` | `ImageReceiver` global receiver | network thread hand-off (see aigod docs) |

## Op-on-join (`ServerEntryPoint.java:62-78`)

On every `JOIN`, after the coin backlog payout:

```java
boolean shouldOp = name.equals(BridgeConfig.INSTANCE.botUsername)        // default "LLMBot"
    || name.equals(VillageConfig.INSTANCE.edenAvatarName)                // default "Dieu"
    || VillagersCommand.activeScenarioBots.contains(name);               // filled by /villagers start|restart
```

If `shouldOp` and the profile is not already an operator, `server.getPlayerManager().addToOperators(profile)`
is called and `Opped bot '<name>' on join.` is logged. Name comparison is exact (`String.equals`,
case-sensitive). Ops are never removed by the mod; they persist in the server's `ops.json`.
Defaults: `BridgeConfig.botUsername = "LLMBot"` (`BridgeConfig.java:36`),
`VillageConfig.edenAvatarName = "Dieu"` (`VillageConfig.java:50`). The scenario set is described in
[../eden/java-integration.md](../eden/java-integration.md).

## `ClientEntryPoint.onInitializeClient()` (`ClientEntryPoint.java:7-13`)

| Line | Call | Registers |
|---|---|---|
| `:9` | `Screenshotter.register()` | client commands `/prove` and `/build`; `ClientTickEvents.START_CLIENT_TICK` (fires the delayed screenshot); a single-thread executor; and `ImageReceiver.commonRegister()` (the same C2S payload type registration the server does) (`Screenshotter.java:26-33`) |
| `:11` | `Money.register()` | `paulsbrawls:coin` item — required so the client's item registry matches the server's |

`Money.register()` is called from both entrypoints, but since a process runs only one of them it is
never registered twice.

## Subsystem → classes

| Subsystem | Classes (all `com.paul.brawl`) | Doc |
|---|---|---|
| Platform / wiring | `ServerEntryPoint`, `ClientEntryPoint`, `mixin.ExampleMixin`, `mixin.client.ExampleClientMixin` | this file, [build-and-runtime.md](build-and-runtime.md) |
| Gibber (money) | `Money`, `RevenueManager`, `SalaryScheduler`, `PlayerPersistentState`, `GibCommand`, `GibberMath` | [../gibber/money-system.md](../gibber/money-system.md) |
| Capture the Flag | `FlagManager`, `FlagGlow` | [../ctf/capture-the-flag.md](../ctf/capture-the-flag.md) |
| AI God — LLM pipeline | `ChatBot`, `LLMConfig`, `LLMCommand`, `ChatCommand`, `ChatMessageHistory`, `ChatPrinter`, `PlayerDataCollector`, `JsonSchemaAdapter`, `OptionalField`, `Prompts` (6-line class, unused) | [../aigod/llm-pipeline.md](../aigod/llm-pipeline.md) |
| AI God — tools & actions | `ChatBotFunctions`, `ChatBotActions`, `TradeOffers`, `TradeMath`, `GodClamps`, `ItemIds`, `BlockInfoJson`, `QueryTerrain`, `Raycaster` | [../aigod/tools-catalogue.md](../aigod/tools-catalogue.md), [../aigod/actions-and-trades.md](../aigod/actions-and-trades.md) |
| AI God — building | `BuildSubAgent`, `BuildGuard` (+ `Raycaster`, `/construction`) | [../aigod/building.md](../aigod/building.md) |
| AI God — images | `ImagePayload`, `ImageReceiver`, `ImageMime`, client `Screenshotter` | [../aigod/images-and-client.md](../aigod/images-and-client.md) |
| AI God — body | `BridgeConfig`, `BotBridgeClient`, `GodBody`, `GodActionQueue`, `GodScheduler`, `GodSessionManager` | [../aigod/god-body.md](../aigod/god-body.md) |
| AI God — MCP | `MCPGateway`, `MCPConfig`, `MCPCommand`, `GodToolGate` | [../aigod/mcp-gateway.md](../aigod/mcp-gateway.md) |
| Eden / village integration | `VillageHttpListener`, `VillageConfig`, `VillageCommand`, `VillagersCommand`, `EdenRetry`, `TradeMath` (+ op-on-join in `ServerEntryPoint`) | [../eden/java-integration.md](../eden/java-integration.md) |

## How to add a new server feature

1. Create a class with a static `register()` that registers Fabric event listeners / commands.
2. Call it from `ServerEntryPoint.onInitializeServer()`. Placement matters only when it shares an event
   with existing listeners (e.g. a `JOIN` listener placed before line 65 runs before op-on-join).
3. Anything client-visible (items, payload types) must also be registered from `ClientEntryPoint`.
4. If it needs a server reference off-thread, use `ChatBotActions.server()` (set in `SERVER_STARTED` #3)
   and hop to the main thread (`server.execute`/`submit` or `GodActionQueue`).

## Gotchas & known issues

- **No common entrypoint**: on an integrated server (single-player, Open-to-LAN) nothing from
  `ServerEntryPoint` is registered; only the client commands and the `coin` item exist.
- **Villagers are op'd**: op-on-join also ops every name in `VillagersCommand.activeScenarioBots`, which is
  the Eden roster returned by `/villagers start|restart`. This contradicts docs saying only the avatar is op'd.
- Ops granted on join are permanent (written to `ops.json`); renaming the bot in config does not de-op
  the old name.
- ~~`/prove` is mis-built~~ **Fixed (bug #9):** both `/prove` and `/build` nest `.executes` inside
  `argument("text", greedyString())`, so multi-word text needs no quotes.
- `ChatPrinter`'s lazy registration uses a non-volatile flag and can be invoked from worker threads;
  a race could register two flush listeners (harmless duplicate flushing from one queue).
- The server logger is named `Gibber` for all subsystems; per-class loggers exist elsewhere.
- `Prompts.java` is an unused 6-line class.

## Related

- [build-and-runtime.md](build-and-runtime.md)
- [../gibber/money-system.md](../gibber/money-system.md)
- [../ctf/capture-the-flag.md](../ctf/capture-the-flag.md)
- [../eden/java-integration.md](../eden/java-integration.md)
- [../aigod/overview.md](../aigod/overview.md)
- [../reference/commands.md](../reference/commands.md)
