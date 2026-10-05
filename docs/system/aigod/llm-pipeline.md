---
id: aigod.llm-pipeline
title: AI God — ChatBot LLM request pipeline
system: aigod
summary: ChatBot internals - per-player token-window memory, per-turn message list, tool-spec assembly, the response/tool loop, Wait deferrals, depth cap, error path, threading, timeouts, provider builders.
tags: [aigod, chatbot, langchain4j, memory, tokenwindowchatmemory, tool-loop, threading, executor, provider, openai, lmstudio, ollama, anthropic]
sources: [src/main/java/com/paul/brawl/ChatBot.java, src/main/java/com/paul/brawl/ChatBotFunctions.java, src/main/java/com/paul/brawl/LLMConfig.java, src/main/java/com/paul/brawl/PlayerDataCollector.java, src/main/java/com/paul/brawl/ChatMessageHistory.java, src/main/java/com/paul/brawl/ChatBotActions.java, src/main/java/com/paul/brawl/GodSessionManager.java, src/main/java/com/paul/brawl/GodActionQueue.java, src/main/java/com/paul/brawl/GodScheduler.java, src/main/java/com/paul/brawl/MCPGateway.java, src/main/java/com/paul/brawl/MCPConfig.java, src/main/java/com/paul/brawl/BridgeConfig.java, src/main/java/com/paul/brawl/ChatCommand.java, build.gradle]
verified_at: 4a8081f
---

# AI God — ChatBot LLM request pipeline

**TL;DR.** Each turn, `ChatBot.doRequest` rebuilds the full message list (1 persona `SystemMessage` + 3 dynamic
context `SystemMessage`s + the player's `TokenWindowChatMemory`, 16 000-token cap) and the tool list, then calls the
blocking `ChatModel.chat` on a virtual-thread executor. The callback commits the assistant turn, prints it, runs any
tool calls, and either loops (`sendFunctionOutputs`), defers (`Wait`), or ends the avatar session. Depth is capped at
100 turns per user message. All code: `src/main/java/com/paul/brawl/ChatBot.java` unless noted.

## Key constants

| Constant | Value | Where |
|---|---|---|
| `MAX_FUNCTION_CALL_DEPTH` | `100` | `ChatBot.java:42` |
| `MAX_MEMORY_TOKENS` | `16_000` | `ChatBot.java:70` |
| `TOKEN_ESTIMATOR` | `new OpenAiTokenCountEstimator("gpt-4o")` (static, shared) | `ChatBot.java:82-83` |
| Dynamic-context main-thread hop timeout | 5 s | `ChatBot.java:512` |
| `runOnMain` tool hop timeout | 5 s | `ChatBotFunctions.java:490` |
| LLM HTTP timeout | `LLMConfig.timeoutSeconds`, default `180` | `LLMConfig.java:64` |
| MCP connect / call timeout | `MCPConfig.timeoutSeconds`, default `60` | `MCPConfig.java:61` |
| Wait clamp | `BridgeConfig.waitMinSeconds=1` .. `waitMaxSeconds=30` | `BridgeConfig.java:50-51` |

## Memory

- **Type:** LangChain4j `TokenWindowChatMemory.withMaxTokens(MAX_MEMORY_TOKENS, TOKEN_ESTIMATOR)`, created lazily per
  player by `memoryFor(player)` (`ChatBot.java:215-218`).
- **Keying:** `memories: ConcurrentHashMap<UUID, ChatMemory>` keyed by `player.getUuid()` (`ChatBot.java:85`). Each
  `ChatBot` instance (`godBot`, `buildBot`) has its own map, so a player's `/pray` and `/build` histories are separate.
  `BuildSubAgent`s keep their own histories (see [building.md](building.md)).
- **Contents:** only `UserMessage`, `AiMessage`, `ToolExecutionResultMessage`. System messages are *never* stored —
  they are rebuilt and prepended each turn (`ChatBot.java:448-481`).
- **Estimator:** o200k_base tokenizer via `jtokkit` (jar-in-jar'd, `build.gradle:64`). For non-OpenAI providers it is
  an approximation (source comment `ChatBot.java:72-81`).
- **Eviction:** handled by LangChain4j's `TokenWindowChatMemory`. The source comment (`ChatBot.java:59-62`) states it
  evicts a tool-call `AiMessage` together with its following tool results.
  > ⚠ Unverified: that eviction behaviour is a property of the LangChain4j 1.0.0 library, not of code in this repo.
- **Synchronization:** `TokenWindowChatMemory` is not thread-safe; every `add` and `messages()` in `ChatBot` is wrapped
  in `synchronized (memory)` (`:236`, `:262`, `:305`, `:353`, `:378`, `:475`, `:616`). `buildMessageList` copies a
  snapshot into an `ArrayList` under the lock (`:473-477`).
- **Clearing:** `clearMemory(player)` (`:201-207`) removes memory, depth, `sessionBound`, and cancels a pending Wait
  deferral. `reloadClients()` (`:176-190`) clears *all* players for both bots. Neither `endPrayerSession` nor
  `/pray stop` clears memory.

## Entry points and per-turn bookkeeping

| Method | Lines | Does |
|---|---|---|
| `sendChatRequest(input, player[, callback])` | `:252-267` | `flushPendingDeferral`; `functionCallDepth=0`; if `needsGodTools`, `sessionBound = GodSessionManager.isActive(player)`; add `UserMessage.from(input)`; `doRequest`. |
| `sendImageChatRequest(input, bytes, player[, callback])` | `:221-250` | Same bookkeeping; if `hasImage`, adds `UserMessage(TextContent(input), ImageContent(base64, "image/jpeg"))`, else text only. |
| `sendFunctionOutputs(results, player)` | `:270-312` | Session-ended guard → depth check → add one `ToolExecutionResultMessage` per result → `doRequest`. |
| `deferFunctionOutputs(results, player, seconds)` | `:320-336` | `GodScheduler.schedule(...)`; remembers a `PendingDeferral`; if scheduling fails, runs outputs immediately. |
| `sendTextualContinuation(placedCount, player)` | `:362-383` | buildBot only: depth check, adds a `[system] Executed N textual placement call(s)…` `UserMessage`, `doRequest`. |

`flushPendingDeferral` (`:348-360`): if a Wait is pending and `cancel(false)` succeeds, writes the withheld tool
results into memory **without** an LLM call, so the new `UserMessage` does not follow an unanswered tool call.

## Message list construction (`buildMessageList`, `:448-481`)

Order, every turn:

| # | Message | Content | Condition |
|---|---|---|---|
| 1 | `SystemMessage` | `hardcodedPrompt + "\n" + prompt` — file persona (`prompt.txt` / `build_prompt.txt`) + `/prompt` override | always |
| 2 | `SystemMessage` | `"The player you are interacting with has their information in JSON format here: \n" + PlayerDataCollector.collect(player)` | `needsInfo` (godBot only) |
| 3 | `SystemMessage` | `"The history of chat, commands, and game messages is shown here: \n" + ChatMessageHistory.getHistory()` | `needsInfo` |
| 4 | `SystemMessage` | `"Here is the information about the blocks near the player's cursor: \n" + ChatBotActions.getBlockInfo(player)` | `needsInfo` |
| 5… | memory snapshot | all stored User/AI/ToolResult messages, oldest first | always |

### Dynamic context collection (`collectDynamicContext`, `:496-520`)

- `buildMessageList` runs on an `llm-worker` virtual thread. The three context reads touch live entity/world state,
  so they run in one `GodActionQueue.submit(body).get(5, TimeUnit.SECONDS)` hop onto the server thread.
- If already on the server thread (`server.isOnThread()`), it collects directly (deadlock guard, `:505-510`).
- On timeout/exception it logs `Dynamic-context collection on main thread failed (…); sending turn without context.`
  and returns three empty strings (fresh array — the late queued action may still write the old one).

### Context payloads

**Player JSON** — `PlayerDataCollector.collect` (`PlayerDataCollector.java:14-84`), a Gson `JsonObject`:

| Key | Value |
|---|---|
| `name` | player name |
| `x`,`y`,`z` | `getBlockPos()` ints |
| `dimension` | `world.getRegistryKey().getValue().toString()` e.g. `minecraft:overworld` |
| `health` | float |
| `xp_level` | int |
| `inventory` | array of `{item: Item.toString(), count}` over `inventory.main` (36 slots; armor/offhand excluded) |
| `effects` | array of `{effect: getEffectType().toString(), duration, amplifier}` |
| `tags` | command tags |
| `scores` | `{objectiveName: score}` for every scoreboard objective |
| `world` | `{time: getTimeOfDay(), is_raining, is_thundering}` (only for `ServerWorld`) |

> ⚠ Unverified: the exact string form of `Item.toString()` / `RegistryEntry.toString()` in MC 1.21.1 (no Minecraft
> sources in this checkout); effect entries may render as verbose registry-entry strings.

**Chat history** — `ChatMessageHistory` (`ChatMessageHistory.java`): a global `LinkedList` capped at
`MAX_HISTORY = 40` (`:14`), fed by Fabric `ServerMessageEvents`:

| Event | Line format |
|---|---|
| `CHAT_MESSAGE` | `<sender> : <content>` (`:32-35`) |
| `COMMAND_MESSAGE` (broadcast signed-message commands like `/say`, `/me`; not `/msg`, which is sent per-recipient) | `<player> command : <content>` (`:37-40`) |
| `GAME_MESSAGE` (broadcast system text: joins, deaths, …) | `Game : <text>` (`:42-45`) |

`getHistory()` joins with `"\n"` starting from `""`, so output begins with a newline (`:47-51`). Private
`ChatPrinter.sendMessage` lines (all of God's text replies) are **not** captured; the avatar's public `GodBody.say`
lines are (they are real chat from `LLMBot`).

**Block info** — `ChatBotActions.getBlockInfo` (`ChatBotActions.java:252-281`) samples around
`Raycaster.getLastPos(uuid)`, which is only set by the admin `/construction` command. For any player who never ran
`/construction`, it returns `""` and message 4 is just the header. Details in
[actions-and-trades.md](actions-and-trades.md#getblockinfo).

## Tool spec assembly

`ChatBotFunctions.buildToolSpecs(needsGodTools, needsBuildPlan, needsMcpTools)` (`ChatBotFunctions.java:313-340`),
called inside the worker for every request (`ChatBot.java:405`):

1. `needsGodTools` → `Reward, Trade, Punishment, ChangeWeather, SpawnCreature, Appear, Vanish, Wait, QueryTerrain`
   (in that order).
2. `needsBuildPlan` → `BuildPlan`.
3. `needsMcpTools` → `MCPGateway.INSTANCE.tools()` appended (lazy connect; empty if disabled/down).
4. If the list is non-empty → `ListTools` appended last.

| Bot | Attached tools |
|---|---|
| `godBot` | 9 god tools + MCP tools + `ListTools` (**no `BuildPlan`**) |
| `buildBot` | `BuildPlan` + `ListTools` (+ textual `PlaceBlock*` scanning, not tools) |

No tool is conditionally removed by session state: `Appear`/`Vanish` are always attached for godBot and refuse at
execute time when the caller doesn't own the avatar. If the tool list is empty, `toolSpecifications` is not set
(`ChatBot.java:407-410`). The request carries **only** messages + tools — no temperature, max tokens, or
`tool_choice`. Full catalogue: [tools-catalogue.md](tools-catalogue.md).

The MCP handshake happens on the worker on purpose: a down Node process would otherwise stall the server tick for up
to `MCPConfig.timeoutSeconds` (source comment `ChatBot.java:391-399`). See [mcp-gateway.md](mcp-gateway.md).

## `doRequest` and the callback chain (`:400-425`)

```
model = LLMConfig.INSTANCE.sharedModel()            // captured on caller thread
response = supplyAsync(() -> {
    messages = buildMessageList(player)
    tools    = buildToolSpecs(needsGodTools, needsBuildPlan, needsMcpTools)
    return model.chat(ChatRequest{messages, tools?})
}, LLMConfig.INSTANCE.sharedExecutor())
response.whenComplete((r, ex) -> if ex: logApiError(ex, player))
setupCustomCallback(response, callback)   // optional BiConsumer<ChatResponse, String text>
setupGeneralCallback(response, player)
```

### `setupGeneralCallback` (`:522-573`)

Runs (via `thenAccept`, i.e. on the completing `llm-worker` thread) only for successful responses:

1. `r == null` → return. `logResponseShape` logs `Response for player X: text=0|1, function_call(s)=N, finishReason=…`.
2. **Session-ended-mid-flight drop:** if `needsGodTools && sessionBound[player] && !GodSessionManager.isActive(player)`
   → log `Dropping LLM response …`, `clearMemory(player)`, return (no tools run, assistant turn not stored).
3. `addAssistantToHistory` — `memory.add(aiMessage)` (`:612-619`). Must precede tool results.
4. `printOutputs` (`:621-633`) — text (with `PlaceBlock*` calls stripped for build bots) sent privately as
   `"Dieu : " + text`; if godBot owns an active, manifested session also `GodBody.say(text)` (public chat via avatar).
5. `hadFunctionCalls = ChatBotFunctions.checkForFunctions(r, player, this)` — executes every tool call, then
   `sendFunctionOutputs` or `deferFunctionOutputs` (see below).
6. `willContinue = hadFunctionCalls`; for build bots with no tool calls, `checkForTextualFunctions` scans
   `PlaceBlock/PlaceLine/PlaceBlocks` text, and if `placed > 0` calls `sendTextualContinuation` → `willContinue=true`.
7. **Natural terminal:** `if (!willContinue && needsGodTools && GodSessionManager.isActive(player)) endPrayerSession(player)`.
8. Any exception in the callback is `printStackTrace()`'d and swallowed.

### `checkForFunctions` (`ChatBotFunctions.java:351-389`)

- Executes each `ToolExecutionRequest` sequentially via `executeFunction` (never throws; always yields a string) and
  collects `FunctionResult(call, result)` records (`:349`).
- Tracks the **longest** clamped `Wait.seconds` in the batch (`extractWaitSeconds`, `:391-399` — returns 0 on parse
  failure, otherwise clamped to `[waitMinSeconds, waitMaxSeconds]`, so any parsed Wait defers ≥ 1 s).
- `fireGestures` (best-effort bridge choreography).
- `waitSeconds > 0` → `chatBot.deferFunctionOutputs(results, player, waitSeconds)` + `GodSessionManager.resetIdleTimer`.
  Otherwise → `chatBot.sendFunctionOutputs(results, player)` immediately (next LLM turn).

### Depth cap

`sendFunctionOutputs` and `sendTextualContinuation` increment `functionCallDepth[player]`; above 100:

| Path | Effect |
|---|---|
| Tool loop (`:287-302`) | `clearMemory`; private `"Dieu : (chaîne d'appels coupée — relance ta requête.)"`; `endPrayerSession` if godBot owns the session. |
| Textual build loop (`:364-371`) | `clearMemory`; `"Dieu : (construction interrompue — limite de tours atteinte.)"`. |

Memory is wiped because the last assistant turn's tool calls would otherwise be left unanswered.

### Session-ended guard on deferred outputs (`:278-285`)

If a Wait continuation fires after the session ended (`/pray stop`, watchdog, `/godbody off`) and the conversation
was `sessionBound`, it logs `Skipping function outputs …`, clears memory and makes no LLM call. Bodiless conversations
(`sessionBound=false`) pass through.

### Error branch (`logApiError`, `:427-439`)

Exceptional completion (HTTP error, timeout, provider error, exception during assembly) → walk to the root cause,
`LOGGER.error("LLM API call failed for player …", root)`, and if godBot owns an active session, `endPrayerSession`.
The player gets **no** chat message; memory is left as-is (the pending `UserMessage`/tool results stay).

### `endPrayerSession(player)` (static, `:580-587`)

```
if player == null: return
if GodSessionManager.hasManifested():
    GodActionQueue.submit(() -> ChatBotActions.restoreAvatar(player))   // invulnerable=false
    GodBody.vanish()                                                     // bridge POST /vanish
GodSessionManager.endSession(player)                                     // releases lock only if player owns it
```

Callers: natural terminal, depth cap, `logApiError`, `/pray stop` (`ChatCommand.java:35`). `/godbody off` uses
`GodSessionManager.forceEndSession()` directly (`ChatCommand.java:64-66`).

## Executor / threading

| Work | Thread |
|---|---|
| `/pray`, `/prompt`, `/llm`, `/accept`, `ImagePayload` receiver | server main thread |
| `buildMessageList`, `buildToolSpecs`, `model.chat` | `llm-worker-N` virtual thread |
| `setupGeneralCallback`, tool dispatch, MCP calls | the `llm-worker` that completed the future |
| `Reward/Trade/Punishment/ChangeWeather/SpawnCreature/QueryTerrain` bodies, context collection, `buffAvatar`/`restoreAvatar` | main thread via `GodActionQueue` (drained `END_SERVER_TICK`, max 8/tick) |
| Wait continuation, idle watchdog | `GodScheduler` thread |
| `GodBody.*` | async HTTP (`BotBridgeClient`) |

`LLMConfig.sharedExecutor()` (`LLMConfig.java:155-163`) = `Executors.newThreadPerTaskExecutor(Thread.ofVirtual()
.name("llm-worker-", 1).factory())` — unbounded, one virtual thread per task, shared by both bots and every
`BuildSubAgent`. `LLMConfig.sharedModel()` (`:130-133`) caches one `ChatModel` until `invalidateClient()`.

## Timeouts

- **LLM call:** only the provider HTTP timeout (`Duration.ofSeconds(timeoutSeconds)`); there is no future-level
  timeout. `/llm timeout <5..1800>` changes it and rebuilds the client.
- **Main-thread hops:** 5 s (`runOnMain`, `collectDynamicContext`). On `runOnMain` timeout the tool result is
  `"Erreur côté serveur: action différée non exécutée (serveur indisponible)."`; other failure:
  `"Erreur côté serveur lors de l'exécution de cette action."` (`ChatBotFunctions.java:491-497`). The queued action is
  not cancelled and may still run later.
- **Wait:** 1..30 s by default; idle watchdog = `max(idleTimeoutSeconds (90), waitMaxSeconds + 5)`
  (`GodSessionManager.java:123-124`).

## Provider construction (`LLMConfig.buildModel`, `LLMConfig.java:98-123`)

| Provider key | Builder | Exact params |
|---|---|---|
| `openai` | `OpenAiChatModel.builder()` | `.baseUrl(host + ":" + port + "/v1")` (default `https://api.openai.com:443/v1`), `.apiKey(resolveApiKey)`, `.modelName(model)` (default `gpt-5`), `.timeout(Duration.ofSeconds(timeoutSeconds))`; plus `.organizationId(env OPENAI_ORG_ID)` and `.projectId(env OPENAI_PROJECT_ID)` when set and non-empty. |
| `lmstudio` | `OpenAiChatModel.builder()` | same base params; default `http://localhost:1234/v1`, model `openai/gpt-oss-20b`, key `lm-studio`. |
| `ollama` | `OpenAiChatModel.builder()` | same base params; default `http://localhost:11434/v1`, model `llama3.2`, key `ollama`. |
| `anthropic` | `dev.langchain4j.model.anthropic.AnthropicChatModel.builder()` | `.apiKey(resolveApiKey)`, `.modelName(model)` (default `claude-opus-4-8`), `.timeout(...)`. Host/port are **ignored**. |

`resolveApiKey` (`:170-182`): configured key if non-empty → else `OPENAI_API_KEY` (openai) / `ANTHROPIC_API_KEY`
(anthropic) env → else the provider name string itself (e.g. `"openai"`). See
[configuration-and-commands.md](configuration-and-commands.md) for persistence.

## Gotchas & known issues

- **Image MIME label:** the image is always tagged `"image/jpeg"` (`ChatBot.java:241`) but the client sends
  `NativeImage.getBytes()` output, which is PNG-encoded. See [images-and-client.md](images-and-client.md).
- **Stale comment:** `ChatBotFunctions.runOnMain` says "only 4 workers in sharedExecutor" (`ChatBotFunctions.java:478-480`);
  the executor is now unbounded virtual threads.
- **Error path is silent to the player** — a timeout or 4xx just ends the session; the player sees nothing.
- **`/llm model` does not rebuild the cached model** (`LLMCommand.java:190-196` calls `save()` only) — the old model
  name keeps being used until `/llm reload` or another reload-triggering change / restart.
- **Block-info context is misleading:** labelled "near the player's cursor" but is around the last `/construction`
  hit, captured whenever that command ran; empty for normal players.
- Callback exceptions are swallowed with `printStackTrace` (`ChatBot.java:569-571`).
- `PROMPT_STATE_KEY` (`ChatBot.java:111`) is unused.

## Related

- [overview.md](overview.md) · [tools-catalogue.md](tools-catalogue.md) · [actions-and-trades.md](actions-and-trades.md)
- [configuration-and-commands.md](configuration-and-commands.md) · [images-and-client.md](images-and-client.md)
- [god-body.md](god-body.md) — watchdog, `GodScheduler`, bridge · [mcp-gateway.md](mcp-gateway.md) · [building.md](building.md)
