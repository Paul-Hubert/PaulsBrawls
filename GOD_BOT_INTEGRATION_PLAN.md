# God-Body Integration Plan

Give the pauls-brawls AI God a physical body by driving the
[minecraft-mcp-server](https://github.com/) Mineflayer bot. A player prays; the God decides
— via tools — whether to manifest, when to appear in front of the player, how long to linger,
and which powers to act out through that avatar. When the LLM stops calling tools the
conversation ends and the bot teleports away.

This is a **written plan only** — no code changes yet. It is sequenced in two phases:

| Phase | Work | Deliverable |
|---|---|---|
| **0 — LangChain4j migration** | Swap the OpenAI Java SDK (Responses API) for LangChain4j under the existing `ChatBot` stack. Pure refactor; same tools, same behavior, new client + client-side memory. | [LANGCHAIN4J_MIGRATION_PLAN.md](LANGCHAIN4J_MIGRATION_PLAN.md) (full detail); summarized in §0 below. |
| **1+ — God-Body** | Mineflayer avatar, Java→Node bridge, new tools (`Appear` / `Vanish` / `Wait` / `SpawnCreature`), `GodActionQueue`, session lock, avatar invuln. | This document, §1–§12. |

**Do Phase 0 first.** Everything from §3 onward is written in today's OpenAI-Responses idioms
(it hooks `setupGeneralCallback`'s `hadFunctionCalls` branch, defers `sendFunctionOutputs` for
`Wait`, registers Jackson-POJO tools via `builder.addTool(X.class)`, and reasons about the
`previousResponseId` chain). Every one of those touchpoints changes under LangChain4j. Building
the God-Body first means writing the four new tools and the three LLM-loop hooks twice — once
OpenAI-style, then again post-migration. Migrating first means the God-Body work targets the
final architecture directly. §0.6 is the translation key from the OpenAI wording used in §3–§12
to the LangChain4j shapes Phase 0 establishes.

---

# Phase 0 — Transition to LangChain4j

Replace the **OpenAI Java SDK** (`com.openai:openai-java:2.9.0`, Responses API) with
**LangChain4j** under the `ChatBot` stack. Scope is the LLM client only — Gibber and
Capture-the-Flag are untouched, and so is all of `ChatBotActions`' in-world logic. Phase 0 is
deliberately **behavior-neutral**: no new tools, no avatar, no session manager — just the client
swap and the move to client-side memory. Land it, verify against §0.7, *then* start the
God-Body work. The full treatment is in
[LANGCHAIN4J_MIGRATION_PLAN.md](LANGCHAIN4J_MIGRATION_PLAN.md); this section is the executive
summary plus the parts the rest of this document depends on.

## 0.1 The one decision that drives everything

| | OpenAI SDK (today) | LangChain4j |
|---|---|---|
| API paradigm | **Responses API** (`client.responses().create`) | **Chat Completions** model (`ChatModel.chat(ChatRequest)`) |
| Conversation state | **Server-side**, via `previousResponseId` chaining | **Client-side**, resend the full message list every turn (`ChatMemory`) |
| Calls | **Async** (`OpenAIClientAsync` → `CompletableFuture<Response>`) | **Blocking** (`ChatModel`) or callback streaming (`StreamingChatModel`) |
| Tools | Jackson POJOs auto-schema'd via `builder.addTool(X.class)` | `ToolSpecification` + `JsonObjectSchema`, or `@Tool` methods via `AiServices` |
| Tool result wire type | `ResponseInputItem.ofFunctionCallOutput(callId, json)` | `ToolExecutionResultMessage.from(request, json)` |
| Multi-provider | OpenAI SDK pointed at a custom `baseUrl` (LM Studio, Ollama) | `langchain4j-open-ai` (custom baseUrl) or `langchain4j-ollama` |

**LangChain4j has no equivalent of `previousResponseId`.** That single fact is the spine of the
migration. Today the mod sends *one* user message plus a response-id and lets OpenAI retain the
rest of the conversation. LangChain4j expects the **complete message list** (system + every
prior user/assistant/tool turn) on every call. So Phase 0 is less "swap the client" and more
"**move conversation state from OpenAI's servers into the mod**." The bones already exist: the
codebase rebuilds the dynamic context block every turn and already keeps a per-player
`ChatBotPlayerHistory` — that history just needs to become the *source of truth* instead of an
auxiliary cache.

## 0.2 Where the OpenAI SDK lives today

Seven files import `com.openai`; two of those imports are already dead weight.

| File | Coupling | Weight |
|---|---|---|
| `LLMConfig.java` | Builds `OpenAIClientAsync` (baseUrl, apiKey, org, project); caches one shared client; multi-provider map (openai / lmstudio / ollama). | **High** — becomes a `ChatModel` factory. |
| `ChatBot.java` | The core loop: `ResponseCreateParams`, `EasyInputMessage`, `ResponseInputItem`, `ResponseInputImage`, `Response`, `previousResponseId` chaining, `client.responses().create()`, the whole `getPromptList` / `buildBuilder` / `sendBuilder` / callback machinery. | **Highest** — most of the rewrite. |
| `ChatBotFunctions.java` | Tool POJOs with `@JsonClassDescription` / `@JsonPropertyDescription`; `builder.addTool(X.class)`; dispatch via `function.name()` + `function.arguments(X.class)`; `FunctionResult(ResponseFunctionToolCall, …)`; `extractResponseText(Response)`. | **High** — tool definition + dispatch changes. |
| `BuildSubAgent.java` | A second, self-contained Responses loop with its own `previousResponseId` chain. | **Medium** — same patterns, smaller. |
| `ChatBotPlayerHistory.java` | Stores `List<ResponseInputItem>` per player. | **Medium** — element type → `ChatMessage`; promoted to source of truth. |
| `ChatBotActions.java` | Imports six `com.openai.*` types but only calls `ChatBot.buildBot.clearPreviousResponseId(...)`. **Imports unused.** | **Trivial** — delete dead imports. |
| `ImagePayload.java` | `import com.openai.models.images.ImageEditParams.Image;` — **never used.** | **Trivial** — delete the import. |

Unchanged: all of `ChatBotActions`' world logic, the textual `PlaceBlock` / `PlaceLine` /
`PlaceBlocks` regex scanner, `PlayerDataCollector`, `ChatMessageHistory`, `ChatPrinter`,
`Prompts`, `Raycaster`, the Brigadier commands, `Screenshotter`, and the `ImagePayload` /
`ImageReceiver` transport. Image *bytes* still arrive the same way; only how they attach to a
request changes.

## 0.3 Dependencies (build.gradle)

Drop the OpenAI artifacts and their hand-included transitive pile; add LangChain4j (which pulls
Jackson and its own HTTP stack, so several current `include(...)` lines become redundant).

```groovy
// remove
implementation("com.openai:openai-java:2.9.0")
include("com.openai:openai-java:2.9.0")
include("com.openai:openai-java-core:2.9.0")
include("com.openai:openai-java-client-okhttp:2.9.0")
include 'com.github.victools:jsonschema-generator:4.38.0'        // only fed the OpenAI addTool(Class)
include 'com.github.victools:jsonschema-module-jackson:4.38.0'

// add
implementation("dev.langchain4j:langchain4j:1.0.0")
implementation("dev.langchain4j:langchain4j-open-ai:1.0.0")      // keeps custom-baseUrl LM Studio / Ollama working
include("dev.langchain4j:langchain4j:1.0.0")
include("dev.langchain4j:langchain4j-core:1.0.0")
include("dev.langchain4j:langchain4j-open-ai:1.0.0")
// + whatever transitive artifacts loom's jar-in-jar needs (verify with ./gradlew dependencies)
```

Re-verify every `include` after the swap (the CLAUDE.md jar-in-jar warning applies); pin the
LangChain4j version and confirm loom resolves the full closure or the runtime jar is missing
classes. Java 21 / MC 1.21.1 are unaffected — LangChain4j targets Java 17+.

## 0.4 Config layer — `ChatModel` factory (LLMConfig.java)

The cleanest win. The provider abstraction (host, port, model, apiKey per provider, `baseUrl()`
helper) maps one-to-one onto a LangChain4j model builder:

```java
ChatModel buildModel() {
    ProviderSettings p = active();
    return OpenAiChatModel.builder()
        .baseUrl(p.baseUrl())                 // https://api.openai.com/v1, or localhost:1234/v1, etc.
        .apiKey(resolveApiKey(p))
        .modelName(p.model)
        // .organizationId(...) / .projectId(...) from OPENAI_ORG_ID / OPENAI_PROJECT_ID
        .build();
}
```

`sharedClient()` / `invalidateClient()` / `reloadClients()` keep their shape — they just hold a
`ChatModel` instead of an `OpenAIClientAsync`. The `/llm` command and provider-swap flow are
unchanged. **`ChatModel.chat()` is blocking**, so wrap each call in
`CompletableFuture.supplyAsync(() -> model.chat(req), executor)` on a small dedicated pool to
preserve today's non-blocking architecture and keep `setupGeneralCallback`'s `thenAccept` shape
intact (§0.5, §0.6).

## 0.5 Core loop — ChatBot.java

- **State:** `ConcurrentHashMap<UUID, String> previousResponseIds` → `ConcurrentHashMap<UUID,
  ChatMemory> memories` (`MessageWindowChatMemory.withMaxMessages(N)`). Every
  `previousResponseId` read/write folds into "add this turn's messages to the player's
  `ChatMemory`." The "omit the system prompt on follow-ups" branch in `getPromptList`
  **disappears** — `ChatMemory` holds the `SystemMessage` and replays it each call.
- **Messages:** `ResponseInputItem` → `ChatMessage`. `EasyInputMessage` SYSTEM/USER →
  `SystemMessage.from` / `UserMessage.from`; `ResponseInputImage` (base64 data URL) →
  `ImageContent.from(base64, "image/jpeg")` inside a `UserMessage`; function-call output →
  `ToolExecutionResultMessage.from(request, json)`; assistant output → `AiMessage`.
- **Request/response:** `buildBuilder` / `makeBuilder` / `sendBuilder` collapse into building a
  `ChatRequest` (messages + `toolSpecifications`) and calling `model.chat(req)` on the pool.
  `Response` → `ChatResponse`. `extractResponseText` collapses to `aiMessage().text()`; function
  calls come from `aiMessage().toolExecutionRequests()`. Reasoning-item persistence is **dropped**
  (no gameplay loss).
- **Depth guard:** `MAX_FUNCTION_CALL_DEPTH` / `functionCallDepth` carry over unchanged. The
  cap-cleanup "wipe the server chain" hack becomes a local list trim of the offending messages.

## 0.6 Tools — ChatBotFunctions.java

**Recommended: the low-level `ToolSpecification` route**, which preserves the existing manual
dispatch loop (the codebase does its own orchestration and should not hand the loop to
`AiServices`). Keep the Jackson-annotated POJOs and derive `ToolSpecification`s from them via a
small adapter (so descriptions stay co-located), or hand-write `JsonObjectSchema`s.
`registerGodTools(builder)` / `registerBuildPlanTool(builder)` become
`List<ToolSpecification> godTools()` / `buildPlanTool()` attached to the `ChatRequest`.
`executeFunction`'s `switch` stays almost verbatim — only `function.arguments(X.class)` becomes a
Jackson parse of `ToolExecutionRequest.arguments()`. **Order matters more now:** client-side, each
assistant tool-call message must be immediately followed by its matching
`ToolExecutionResultMessage` in memory, or the next request is malformed. The textual
`PlaceBlock` / `PlaceLine` / `PlaceBlocks` scanner has zero OpenAI coupling and migrates verbatim.

## 0.7 Phase 0 testing & verification

1. `./gradlew build` resolves with the new deps and a clean jar-in-jar closure.
2. `/llm` switches openai ↔ lmstudio ↔ ollama and each produces a reply (custom-baseUrl works).
3. `/pray salut` returns God's French text (text-extraction path).
4. `/pray donne-moi un diamant` → `Reward` fires once and the tool-result round-trips (validates
   assistant-tool-call → tool-result pairing in client memory).
5. A multi-tool prayer stays under `MAX_FUNCTION_CALL_DEPTH` and terminates on the first tool-less
   turn.
6. `/prouver` ships a screenshot; `ImageContent` reaches the model.
7. `/construire` triggers `BuildPlan`; sub-agents place blocks via the untouched textual scanner.
8. A long conversation doesn't grow unbounded (memory window trims) and never sends an unpaired
   tool-call message.
9. Two players pray at once; their `ChatMemory` instances stay separate.
10. `grep -rn "com.openai" src/` returns nothing.

## 0.8 Translation key — reading §3–§12 under LangChain4j

The God-Body sections below are written in OpenAI-Responses idioms. After Phase 0, read them
through this map:

| God-Body element (below) | Written against (OpenAI) | After Phase 0 (LangChain4j) |
|---|---|---|
| New tools `Appear` / `Vanish` / `Wait` / `SpawnCreature` (§6) | Jackson POJOs via `builder.addTool(X.class)`, dispatched by `function.arguments(X.class)` | `ToolSpecification`s on the `ChatRequest`, dispatched by Jackson-parsing `ToolExecutionRequest.arguments()` — **same POJOs, new registration/dispatch.** Write them once, in the new style. |
| Termination hook in `setupGeneralCallback` (§5) | `boolean hadFunctionCalls = checkForFunctions(r, …)` on `r.output()` | Same logic on `chatResponse.aiMessage().toolExecutionRequests()`. The `willContinue` restructuring still applies; it just reads the new response shape. |
| `Wait` defers `sendFunctionOutputs` by N s (§6c) | Schedule `sendFunctionOutputs(results, player)` on `GodScheduler` | Identical deferral — but `sendFunctionOutputs` now appends `ToolExecutionResultMessage`s to the player's `ChatMemory` and re-issues a `ChatRequest`. |
| Kill-switch / `/construction` "reset the chain" (§10) | `clearPreviousResponseId(player)` wipes the server chain | Clear/trim the player's `ChatMemory` — a local list op, no server chain to corrupt. |
| Re-entrant-`Wait` race on the shared chain (§10) | Two prayers race the shared `previousResponseId` chain | They'd race the shared `ChatMemory` instead — the busy lock still solves it, and message-ordering correctness makes the lock even more load-bearing. |
| `MAX_FUNCTION_CALL_DEPTH` bounds `Wait`-deferred loops (§10) | Carries over | Unchanged — pure mod-side bookkeeping. |
| Avatar gestures / bridge / `GodActionQueue` / op-on-join / session lock | — | **Fully API-agnostic. No change** — these never touch the LLM client. |

Net effect: the avatar, bridge, thread-queue, and session machinery are unaffected by the
migration. Only the four new tools and the three LLM-loop hooks (termination, `Wait` deferral,
chain/memory reset) benefit from going second — "benefit" meaning *written once* against the final
architecture instead of built on OpenAI idioms and re-migrated.

---

# Phase 1+ — God-Body Integration

## 1. Decisions locked in

| Decision | Choice |
|---|---|
| Brain / orchestrator | pauls-brawls (Java mod) keeps driving the LLM loop (LangChain4j after Phase 0). It commands the bot over a new Java→Node bridge. |
| Teleport mechanism | Op'd `/tp` commands — the bot is server-op and runs `/tp` (via Mineflayer `bot.chat`) to appear and warp away. |
| Appearing | AI-driven — the model calls an `Appear` tool when it chooses to manifest; `ChatCommand` no longer auto-teleports the bot. Fixes the "appear-then-instantly-vanish" problem. |
| Pacing | `Wait` tool — lets God pause N seconds; the model is only re-invoked after the delay (deferred, non-blocking) so it can linger or build suspense. |
| Tool scope | All existing god powers (Reward, Trade, Punishment, ChangeWeather, BuildPlan) + a visible body (approach, look, gesture) + one new power (spawn creatures) + presence/pacing tools (Appear, Vanish, Wait). |
| Concurrency | One encounter at a time. A single shared avatar is owned by exactly one session; a second player who prays while the body is busy is answered bodiless ("God is occupied"). Removes all cross-session contention over the avatar. |
| Bot voice | God speaks in public chat through the bot (`POST /chat` → `bot.chat`) so nearby players see the avatar talk, alongside the praying player's existing `ChatPrinter` output. |
| Appearing position | In front of the player. `Appear` teleports the bot to `playerPos + horizontalLookDir * distance + (0, height, 0)` (defaulted, clamped tool args) and faces the player via `facing entity`. |
| Thread safety | All world mutations run on the main thread via a single FIFO `GodActionQueue` drained each tick (the LLM callback runs off-thread). |
| Avatar safety | Invulnerable while present — `setInvulnerable(true)` on Appear, undone on every exit. Race-free because the busy lock means one session owns the body at a time. No self-damage timing problem: the explosive magma-ball power was dropped, and Punishment lightning strikes at the player's position, several blocks from the avatar. |
| Griefing | Admin-configurable via `/llm`: a toggle + cap governing whether god-spawned creatures may damage terrain (default off). |
| Termination | When an LLM turn returns zero tool calls (and no textual block placements), the prayer session is over → bot vanishes. God may also end deliberately via `Vanish`. |
| This deliverable | Written plan only. No code changes yet. |

## 2. Where the two systems stand today

**pauls-brawls** (`src/main/java/com/paul/brawl/`) — Fabric server mod, MC 1.21.1, Java 21. The
God ("Dieu") is abstract: it has no entity. A player runs `/pray <text>` (`ChatCommand.java`) →
`ChatBot.godBot.sendChatRequest(...)` → the LLM. Tool calls are Jackson POJOs in
`ChatBotFunctions.java` (Reward, Trade, Punishment, ChangeWeather, BuildPlan). After a response,
`ChatBot.setupGeneralCallback` runs `checkForFunctions(...)`, which returns true if any tool ran
and re-invokes the model via `sendFunctionOutputs`. All in-world effects happen server-side in
`ChatBotActions.java` (e.g. smite spawns a lightning entity via `world.spawnEntity`).

The LLM client is async, so `setupGeneralCallback`'s `response.thenAccept(...)` runs on a
`CompletableFuture` worker thread, **not the server main thread** — which is why the §7
thread-safety work matters. (This stays true after Phase 0, since the LangChain4j calls are
wrapped in `CompletableFuture.supplyAsync` on a worker pool — §0.4.)

**minecraft-mcp-server** — TypeScript/Node, a Mineflayer bot whose username is set by `--username`
in `config.ts` (default `LLMBot`, not `ClaudeBot`), hard-coded
`SUPPORTED_MINECRAFT_VERSION = '1.21.11'` in `bot-connection.ts`. Tools live in `src/tools/`
(position, entity, chat, block, flight, inventory, crafting, furnace, gamestate). `send-chat` is
just `bot.chat(message)`. The bot is reactive — idle until a tool is called. The only transport
today is stdio (for Claude Desktop). `BotConnection` owns the lifecycle (`getBot()`, `connect()`,
`cleanup()`, `checkConnectionAndReconnect()`). `ToolFactory.registerTool` wraps `server.tool()`.

### ⚠️ Blocking version mismatch (resolve first)

pauls-brawls targets MC 1.21.1; the MCP server pins Mineflayer to 1.21.11. The Minecraft server,
the mod, and the bot must all agree on one protocol version. Before any integration work, align
all three:

- **Recommended:** run the dedicated server at 1.21.1, set
  `SUPPORTED_MINECRAFT_VERSION = '1.21.1'` in `bot-connection.ts`, and verify `mineflayer` +
  `minecraft-data` in `package.json` support 1.21.1 (update `README.md`, which also pins it). This
  may turn out to be a real blocker rather than a config flip.
- Or upgrade pauls-brawls to 1.21.11 (larger Fabric/yarn-mapping change — not recommended just
  for this).

This must be a real dedicated Fabric (or Paper) server — Open-to-LAN singleplayer randomizes ports
and can't op a bot reliably.

## 3. Target architecture

```mermaid
sequenceDiagram
    participant P as Player
    participant Mod as pauls-brawls (Java)
    participant AI as LLM (LangChain4j)
    participant Br as Node bridge (HTTP)
    participant Bot as Mineflayer bot (configured username, op)
    participant MC as Minecraft server
    P->>Mod: /pray <text>
    Note over Mod: try to claim the single avatar (busy lock); open session, reset idle timer (no auto-appear)
    loop until response has no tool calls
        Mod->>AI: sendChatRequest / sendFunctionOutputs
        AI-->>Mod: tool call(s) (Appear / Wait / Reward / SpawnCreature / Vanish / ...)
        alt Appear
            Mod->>Br: POST /appear {x,y,z in front of player, facing}
            Br->>Bot: bot.chat("/tp <botName> <x y z> facing entity <player>")
        else world-mutating power
            Mod->>MC: GodActionQueue → effect on main thread (next tick, in order)
            Mod->>Br: POST /gesture (body choreography)
            Br->>Bot: swing / look
        else Wait(seconds)
            Note over Mod: GodScheduler defers sendFunctionOutputs by N s (bot stays present)
        end
        Mod->>AI: sendFunctionOutputs (results) — immediately, or after Wait delay
    end
    AI-->>Mod: text only, 0 tool calls (or explicit Vanish)
    Mod->>Br: POST /vanish
    Br->>Bot: bot.chat("/tp <botName> <parking spot>")
```

### Division of labour

- `/tp` (appear / vanish), public speech, and body gestures → the **Mineflayer bot**. Teleport
  needs op; chat and gestures (swing, look, jump, sneak) do not.
- All damage/loot/weather/build effects + the new `SpawnCreature` power → stay **server-side in
  the mod** (`ChatBotActions`), routed through the main-thread `GodActionQueue` (§7) rather than
  mutating the world from the LLM callback thread as smite does today. The bot performs a matching
  gesture so the avatar looks like it caused the effect.
- Appearing, vanishing, and pacing → driven by the model's `Appear` / `Vanish` / `Wait` tools,
  not hardcoded into the prayer entry point.

The mod is the single source of truth; the bridge is a thin "make the avatar do X" RPC.

## 4. The Java → Node bridge

The MCP server's stdio transport is owned by Claude Desktop and must stay clean (`stdio-filter.ts`).
**Do not add a control channel to the MCP entrypoint.** Add a second Node entrypoint that reuses
the same primitives and exposes a small HTTP control server.

### 4a. Node side — new bridge entrypoint

New files under `src/bridge/`:

- `src/bridge/main.ts` — CLI entry (`npm run bridge`). Parses `--host --port --username
  --bridge-port` (extend `config.ts`), constructs a `BotConnection` (reuse as-is), waits for
  spawn, then starts an HTTP server on `--bridge-port` (default `8765`, bound to `127.0.0.1`).
- `src/bridge/server.ts` — native `http`/Express server mapping endpoints → bot actions.
- `src/bridge/actions.ts` — the bot-action functions.

Recommended refactor: extract each existing tool's handler into a plain function so both
`registerXxxTools` (MCP) and the bridge call the same code. For this feature you only need chat,
look, and a couple of gestures, so scope the refactor to those.

The stdio rule still applies even though this entrypoint isn't MCP: log only via `log()` → stderr;
never `console.log` to stdout.

### 4b. Bridge HTTP contract

All POST (except `/health`), JSON body, localhost only. The bot is op, so most effects are chat
commands.

| Endpoint | Body | Bot action |
|---|---|---|
| `GET /health` | – | `{ connected, username, position }` |
| `POST /appear` | `{ x, y, z, facing? }` | `bot.chat("/tp <botName> <x> <y> <z> facing entity <facing>")` (drops `facing entity ...` when `facing` is absent). Teleports the **bot**, not the player — note `<botName>`, never `<user>`. |
| `POST /chat` | `{ message }` | `bot.chat(message)` — God's spoken line, posted to public chat. |
| `POST /look` | `{ x, y, z }` | `bot.lookAt(new Vec3(x,y,z))` |
| `POST /gesture` | `{ type }` | `swing` → `bot.swingArm()`, `jump`, `sneak`, `nod` (look up/down) |
| `POST /vanish` | `{ }` | `bot.chat("/tp <botName> <parkingSpot>")` or disconnect |

The `x/y/z` passed to `/appear` are already the in-front-of-player coordinates computed Java-side
by `GodBody.appear` (§4c, §6b); the bridge just runs the teleport. Folding the look-at into the
same `/tp ... facing entity <player>` makes appearing atomic (no separate `/look` round-trip, no
degenerate "look at yourself" when the offset is small).

**No `/spawn` endpoint.** The MCP server exposes no spawn/summon tool today, and there's no reason
to add one: `SpawnCreature` spawns its entities server-side in the mod (`ChatBotActions`, via the
§7 `GodActionQueue`) — the single canonical path, precise control, no op dependency,
main-thread-safe. The bridge's only role for that power is the matching gesture.

Return `{ ok: true }` / `{ ok: false, error }`. The mod treats the bridge as **best-effort**: a
bridge failure must never break the existing God flow (effects still fire server-side).

### 4c. Java side — bridge client + body orchestration

New files under `src/main/java/com/paul/brawl/`:

- `BotBridgeClient.java` — wraps `java.net.http.HttpClient`. Async `CompletableFuture` POSTs to the
  bridge base URL. Never blocks the server thread; swallows/logs errors so a down bridge can't
  break prayers.
- `GodBody.java` — semantic layer: `appear(player, distance, height, lookAtPlayer)`,
  `say(player, line)`, `lookAt(player)`, `gesture(player, type)`, `vanish(player)`. `appear`
  computes the spawn point in front of the player from their yaw (horizontal look direction only,
  so distance is independent of pitch):

```java
double yaw  = Math.toRadians(player.getYaw());
double dirX = -Math.sin(yaw), dirZ = Math.cos(yaw);   // MC: yaw 0 → +Z, clockwise
double x = player.getX() + dirX * distance;
double y = player.getY() + height;
double z = player.getZ() + dirZ * distance;
bridge.appear(x, y, z, lookAtPlayer ? player.getName().getString() : null);
```

`say` posts God's line to public chat through `POST /chat`. Everything translates player/world
state into bridge calls; the bridge stays a dumb RPC.

**Config:** add `bridgeUrl` (default `http://127.0.0.1:8765`), `botUsername` (default `LLMBot` —
the single source of truth shared by the bridge `--username` flag, the op-on-join check, and the
avatar lookup), and an `enabled` toggle to `LLMConfig.java` (or a new `BridgeConfig`), surfaced
through `/llm`.

## 5. Lifecycle: appear → interact → vanish

A prayer is a session with a clear start and end.

**Start (claim the body, open session — God does not auto-appear).** In
`ChatCommand.onChatCommand`, before `sendChatRequest`, try to claim the single shared avatar via
`GodSessionManager` (busy lock). If another player already owns the body, this prayer is answered
**bodiless** (text only — God replies but won't manifest) and told God is occupied. If the claim
succeeds, mark the session active and reset the idle timer. **The bot does not teleport here.**
Manifesting is left to the model: God appears only when it calls the `Appear` tool (§6b), which
`/tp`s the bot to a point in front of the player and faces them. (Bot stays connected at the
parking spot between prayers; a connect-on-demand variant adds multi-second join latency.)

This fixes the old "blink-and-miss" problem: a trivial `/pray salut` answered with text and no
tool calls means God never shows up — correct, not an awkward appear-then-vanish. When God does
manifest it has made a tool call, so the loop continues at least one more turn (and it can use
`Wait`, §6c, to linger before acting).

**Interact.** The existing loop runs unchanged. Hook body choreography into
`ChatBotFunctions.executeFunction`: after each server-side effect, fire the matching `GodBody`
gesture (Punishment → swing + look at player while the server spawns lightning; Reward → nod;
ChangeWeather → look at sky; SpawnCreature → arm raise toward the spawn point). God's spoken text
is echoed in public chat through `GodBody.say` (`POST /chat`), alongside the praying player's
`ChatPrinter` output. God paces itself with `Wait` (§6c).

**End (vanish).** God can end deliberately via `Vanish`. Otherwise the natural terminal still
applies: `setupGeneralCallback` computes `willContinue`, and when a turn has no function calls and
no textual block placements, the session is complete → `GodBody.vanish(player)` + clear the
session + release the lock. Also vanish on the existing safety exits: max-function-call-depth and
API error. (If `Appear` was never called, vanish is a no-op.)

Add an **idle watchdog**: if a session has no activity for N seconds, force-vanish. Reuse the
`SalaryScheduler` pattern.

**Concurrency — one encounter at a time.** `GodSessionManager` holds a single owner: an
`AtomicReference<UUID>` (or lock + `SessionState`) naming the player who controls the body, plus
the idle timer. `claim(player)` succeeds only if the body is free or already owned by that same
player (re-praying mid-encounter keeps the bot and resets the timer); any other player's prayer is
served bodiless. `endSession` clears the owner. Because exactly one session ever drives `Appear` /
`Vanish` / the invuln flag, there is no cross-session race over the shared avatar.

### Termination, precisely

The single hook is `ChatBot.setupGeneralCallback`. Watch the branch: the existing
`if (this.needsBuildTools && ...)` block only runs for the build bot — `godBot` has
`needsBuildTools = false`, so vanish logic inside that block would never fire for prayers. The
terminal check must sit **outside** the build-only branch.

Today the method body is:

```java
boolean hadFunctionCalls = ChatBotFunctions.checkForFunctions(r, player, this);
if (this.needsBuildTools && !hadFunctionCalls) {
    int placed = ChatBotFunctions.checkForTextualFunctions(r, player, this);
    if (placed > 0) { this.sendTextualContinuation(placed, player); }
}
```

Restructure so "did this turn keep the conversation alive?" is computed once, then vanish when
nothing continues — guarded on an active session:

```java
boolean hadFunctionCalls = ChatBotFunctions.checkForFunctions(r, player, this);
boolean willContinue = hadFunctionCalls;
if (this.needsBuildTools && !hadFunctionCalls) {
    int placed = ChatBotFunctions.checkForTextualFunctions(r, player, this);
    if (placed > 0) {
        this.sendTextualContinuation(placed, player);
        willContinue = true;
    }
}
if (!willContinue && GodSessionManager.isActive(player)) {
    GodBody.vanish(player);
    GodSessionManager.endSession(player);   // also enqueues restoreAvatar, releases the lock
}
```

For `godBot` (`needsBuildTools == false`) this reduces to "vanish when a turn produced no tool
calls."

**Interaction with `Wait`.** `Wait` is a function call, so a turn containing it has
`hadFunctionCalls == true` → `willContinue == true` → no vanish. The difference is that `Wait`
makes `checkForFunctions` defer the `sendFunctionOutputs` re-invocation by N seconds (§6c). The
idle-watchdog timeout must exceed the max `Wait` duration (or the scheduled wake must reset it).

## 6. New tools

All follow the existing pattern: a Jackson POJO in `ChatBotFunctions`, registered in
`registerGodTools`, dispatched in `executeFunction`. (Post-Phase-0: a `ToolSpecification` derived
from the POJO, dispatched by parsing `ToolExecutionRequest.arguments()` — §0.6/§0.8.) The one new
power (`SpawnCreature`) adds a `ChatBotActions` method that mutates the world server-side (via the
§7 `GodActionQueue`) plus a `GodBody` gesture. The presence/pacing tools (Appear/Vanish, Wait)
don't touch world state.

**Dropped: `ThrowMagmaBall`.** An explosive magma-ball power was considered and cut. It was the
only god power that could damage the avatar itself (point-blank explosion), which forced the
original invulnerability/knockback machinery. Removing it lets the avatar safety story collapse to
a plain `setInvulnerable` flag (§6d). Punishment lightning remains, but it strikes at the player's
position — several blocks from the in-front avatar — so it never endangers the body.

### 6a. SpawnCreature

```java
@JsonClassDescription("Spawns one or more creatures near the player.")
static class SpawnCreature {
    @JsonPropertyDescription("Entity id, e.g. minecraft:zombie, minecraft:cow") String entityType;
    @JsonPropertyDescription("How many to spawn.")                                int count;
    @JsonPropertyDescription("Block offset from the player: x")                   int x;
    @JsonPropertyDescription("Block offset from the player: y")                   int y;
    @JsonPropertyDescription("Block offset from the player: z")                   int z;
    public String execute(ServerPlayerEntity player) {
        return ChatBotActions.spawnCreature(player, entityType, count, x, y, z);
    }
}
```

`ChatBotActions.spawnCreature` resolves the `EntityType` from the registry (a cheap, thread-safe
read it can do synchronously) and calls `world.spawnEntity(...)` at player position + offset on the
main thread via `GodActionQueue` (§7). Single canonical spawn path — no bridge `/spawn` endpoint,
so no second code path to drift. Bot gesture: `GodBody.gesture(player, "summon")`.

**Single source of truth for the username.** The mod config (`BridgeConfig.botUsername`), the Node
bridge `--username` flag, and the op step (§8) must all read the same value. Default `LLMBot`, not
`ClaudeBot`. Do not hardcode the name anywhere. The same null-guarded lookup
(`server.getPlayerManager().getPlayer(BridgeConfig.botUsername)`, which can return null if the bot
hasn't joined or drifted) is used by `buffAvatar`/`restoreAvatar` (§6d).

### 6b. Appear / Vanish (presence — God decides when to manifest)

Teleporting is a tool the model calls, not something `ChatCommand` does automatically. This fixes
the "blink-and-miss" problem: God shows up only when it has a reason to, and appearing is itself a
tool call that keeps the loop alive for at least one more turn.

```java
@JsonClassDescription("Manifest God's physical body in front of the praying player. Call this when you choose to appear before acting or speaking. Use sparingly — appearing is dramatic.")
static class Appear {
    @JsonPropertyDescription("Blocks in front of the player to appear (default 3). Clamped server-side, e.g. 1–6.") double distance = 3.0;
    @JsonPropertyDescription("Vertical offset above the player's feet (default 0 = same level; >0 to float).")       double height   = 0.0;
    @JsonPropertyDescription("Turn to face the player after appearing (default true).")                              boolean lookAtPlayer = true;
    public String execute(ServerPlayerEntity player) {
        double d = MathHelper.clamp(distance, 1.0, 6.0);
        double h = MathHelper.clamp(height,   0.0, 4.0);
        GodBody.appear(player, d, h, lookAtPlayer);                       // bridge: /tp in front, facing entity player
        GodActionQueue.submit(() -> ChatBotActions.buffAvatar(player));   // main thread: setInvulnerable(true) (§6d)
        return "God a pris forme physique devant le joueur.";
    }
}

@JsonClassDescription("Send God's physical body away. Call this to disappear deliberately when the encounter is over.")
static class Vanish {
    public String execute(ServerPlayerEntity player) {
        GodActionQueue.submit(() -> ChatBotActions.restoreAvatar(player));  // main thread: undo the flag
        GodBody.vanish(player);                                            // bridge: /tp to parking spot
        return "God a disparu.";
    }
}
```

`distance`/`height`/`lookAtPlayer` are optional, defaulted fields, so the model can call `Appear()`
with no arguments and get the sensible 3-blocks-ahead, ground-level, facing default; the clamps
bound anything passed.

The `/tp` and facing go through the bridge (async HTTP, best-effort). The avatar buff (just
`setInvulnerable(true)` now) touches the live player entity, so it's enqueued on `GodActionQueue`
for the main thread. `Appear` is idempotent (re-appearing re-teleports, re-applies the flag, resets
the idle timer). `Vanish` is optional: if the model never calls it, the zero-tool-call terminal
(§5) still sends the body away — so vanish/`endSession` **must also run `restoreAvatar`** (and the
kill-switch and idle watchdog likewise), or a dismissed avatar stays invulnerable. Cheap and
race-free now (one owner, one flag), but still mandatory on every exit path.

### 6c. Wait (let time pass, then resume)

`Wait` suspends the model loop for a fixed number of seconds and re-invokes the model after the
delay, letting God linger — appear, wait a beat, strike.

```java
@JsonClassDescription("Let time pass before you act again. You will only be called back after the given number of seconds. Use this to pause, linger, build suspense, or let an effect land before reacting.")
static class Wait {
    @JsonPropertyDescription("Seconds to wait before continuing. Clamped server-side (e.g. 1–30).") int seconds;
    public String execute(ServerPlayerEntity player) {
        return "Le temps passe… " + seconds + " seconde(s) se sont écoulées.";
    }
}
```

**Mechanism — defer the continuation, don't block a thread.** Today `checkForFunctions` runs every
tool then immediately calls `sendFunctionOutputs`. For a batch containing a `Wait`, schedule that
single re-invocation instead:

```java
if (hasWait(results)) {
    long delay = clampSeconds(maxWaitSeconds(results));   // e.g. 1..30
    GodScheduler.schedule(() -> chatBot.sendFunctionOutputs(results, player), delay, SECONDS);
} else {
    chatBot.sendFunctionOutputs(results, player);          // unchanged path
}
```

`GodScheduler` is a small `ScheduledExecutorService` (same pattern as `SalaryScheduler`), created
once and shut down on `SERVER_STOPPING`. Nothing blocks — the timer thread just fires the next LLM
request when the delay elapses.

- The scheduled task only builds an API request; it mutates no world state. Any effects in the
  model's next response still go through the §7 `GodActionQueue`.
- Non-`Wait` effects in the same batch (e.g. `Appear` + `Wait`) execute now; only the
  re-invocation is delayed. If multiple `Wait`s appear, pick largest-or-sum and document it; clamp
  the total.
- `MAX_FUNCTION_CALL_DEPTH` still bounds the deferred continuation, so `Wait` can't spin forever.
- The idle watchdog must not fire during a scheduled wait — set its timeout above the max `Wait`,
  or have the scheduled wake reset it.

### 6d. Avatar invulnerability (now just a flag)

With the magma ball dropped, no god power damages the avatar anymore — Punishment lightning lands
at the player's position, several blocks from the in-front body, and `SpawnCreature` spawns near
the player. So the elaborate invulnerability + 1024-HP scheme is unnecessary. Keep a single
`setInvulnerable(true)` while present purely so ambient hazards (a wandering hostile mob, fall,
lava) can't leave a dead avatar mid-encounter. Because the busy lock guarantees one owner (§5),
there's no concurrent session to clear the flag at the wrong moment — the cross-session race is
gone by construction.

Two tiny server-side helpers in `ChatBotActions`, both run on the main thread via `GodActionQueue`,
applied on `Appear` and undone on every exit:

```java
public static String buffAvatar(ServerPlayerEntity prayingPlayer) {
    ServerPlayerEntity bot = prayingPlayer.getServer().getPlayerManager().getPlayer(BridgeConfig.botUsername);
    if (bot == null) return "Avatar introuvable (pas de buff).";
    bot.setInvulnerable(true);     // immune to all non-bypassing damage (fire, fall, mobs, lava)
    bot.extinguish();              // clear any existing fire ticks
    return "Avatar rendu invincible.";
}

public static String restoreAvatar(ServerPlayerEntity prayingPlayer) {
    ServerPlayerEntity bot = prayingPlayer.getServer().getPlayerManager().getPlayer(BridgeConfig.botUsername);
    if (bot == null) return "Avatar introuvable.";
    bot.setInvulnerable(false);
    return "Avatar redevenu mortel.";
}
```

Notes:

- `setInvulnerable(true)` blocks all damage except the few flagged to bypass it (the void, `/kill`)
  — exactly right for a deity. No max-health attribute juggling needed.
- Restore on **every exit path**, not just `Vanish`: the zero-tool-call terminal, idle watchdog,
  kill-switch, and depth-cap/error exits must all call `restoreAvatar`. Cheap and race-free now,
  but still mandatory.
- Verify the mapping names against 1.21.1 yarn (`setInvulnerable`, `extinguish`) when implementing.

Update `prompt.txt` so God knows it has a body and these tools: when to `Appear` / `Vanish`, how to
pace itself with `Wait`, to use `SpawnCreature` sparingly, and that it now speaks aloud in public
chat (French persona unchanged). The invulnerability is automatic — God needn't think about it.

## 7. Thread safety — main-thread action queue

**The problem.** `setupGeneralCallback` runs inside `response.thenAccept(...)`, on a
`CompletableFuture` worker thread, **not the server main thread**. From there
`checkForFunctions → executeFunction → ChatBotActions.*` calls `world.spawnEntity(...)` directly
today (smite). Minecraft is not thread-safe: mutating world/entity state off the main thread is a
latent crash/corruption bug. smite gets away with it by luck; `SpawnCreature` (entity resolve +
`world.spawnEntity`) is just as capable of tripping concurrent-modification exceptions, chunk
races, or silent desyncs.

**The fix already exists in this codebase — use it consistently.** `SalaryScheduler` hops to the
main thread with `server.execute(...)`; `ChatPrinter`/`FlagManager` drain inside
`ServerTickEvents`. `MinecraftServer` is an executor whose `execute(Runnable)` queue is drained, in
order, on the main thread each tick. Formalize this into a single God action queue.

### 7a. GodActionQueue

```java
public final class GodActionQueue {
    private record QueuedAction(Supplier<String> body, CompletableFuture<String> result) {}
    private static final Queue<QueuedAction> QUEUE = new ConcurrentLinkedQueue<>();
    private static final int MAX_PER_TICK = 8; // rate-limit; pairs with §10 clamps
    public static CompletableFuture<String> submit(Supplier<String> body) {
        var f = new CompletableFuture<String>();
        QUEUE.add(new QueuedAction(body, f));
        return f;
    }
    public static void register() {
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            for (int i = 0; i < MAX_PER_TICK; i++) {
                QueuedAction a = QUEUE.poll();
                if (a == null) break;
                try { a.result().complete(a.body().get()); }
                catch (Throwable t) { a.result().completeExceptionally(t); }
            }
        });
    }
}
```

Lock-free `ConcurrentLinkedQueue` (FIFO): any number of producer threads (per-player LLM callbacks)
enqueue; a single consumer on the main thread drains in enqueue order, so effects apply
deterministically. `MAX_PER_TICK` bounds per-tick work so a burst can't lag-spike; leftover actions
roll to the next tick, still in order.

### 7b. Routing effects through it

Every `ChatBotActions` method that mutates world/entity state is wrapped at the dispatch site. In
`executeFunction`:

```java
case "SpawnCreature" -> GodActionQueue
        .submit(() -> function.arguments(SpawnCreature.class).execute(player))  // runs on main thread
        .join();                                                                // safe: callback thread, not main
```

`executeFunction` runs on the LLM callback thread, so a short `join()` (~one tick, ~50 ms) is
acceptable and preserves the existing contract: the real result string — including failures (bad
entity id, null bot) — flows back to the model via `sendFunctionOutputs`. **Never `join()` on the
main thread** (deadlock against the drain). Be mindful that the callback thread is the SDK's HTTP
worker pool — keep the joined work short.

Notes:

- Cheap, thread-safe validation can stay synchronous. Resolving an `EntityType`/`Item` from the
  immutable registry is fine off-thread; only the world write is deferred.
- Any avatar lookup belongs inside the queued task — `getPlayer(botUsername)` and reading live
  entity state (e.g. in `buffAvatar`/`restoreAvatar`) must run on the main thread.
- Bridge gestures are unaffected — async HTTP, never touch server world state.
- Existing latent bug fixed as a side effect: route smite/giveItem/changeWeather through the queue
  too.

**Why an explicit queue rather than bare `server.execute(...)`?** It buys per-tick rate-limiting
(`MAX_PER_TICK`), a single choke point you can drain/clear on session end or kill-switch (§10), and
uniform result-future + error handling. Fall back to `server.execute(...)` only if you skip those
features.

## 8. Op & permissions

The bot needs op only for `/tp` (appear/vanish). Spawning is server-side, so no `/summon`
permission is required. (Speaking via `POST /chat` is plain `bot.chat`, no op needed.) Options, in
order of preference:

1. **Mod ops the bot on join.** In `ServerEntryPoint`, on `ServerPlayConnectionEvents.JOIN`, if the
   joining player's name equals `BridgeConfig.botUsername`,
   `server.getPlayerManager().addToOperators(...)`. Cleanest — no manual step, survives restarts.
2. **Manual:** run `op <botName>` once in the console (works after the bot has joined once; with
   `online-mode=false` the offline UUID is used).

Document the bot username in one place; the mod, the bridge `--username`, and the op step must
match.

## 9. File-by-file change list

**minecraft-mcp-server (Node)**

- `src/config.ts` — add `--bridge-port` (reuse `--host`/`--port`/`--username`).
- `src/bridge/main.ts` — new bridge entrypoint.
- `src/bridge/server.ts` — HTTP control server (endpoints in §4b).
- `src/bridge/actions.ts` — bot-action functions: appear (`/tp ... facing entity`), chat (public
  spoken line), look, gesture, vanish. No spawn — server-side in the mod.
- `src/bot-connection.ts` — set `SUPPORTED_MINECRAFT_VERSION` to the agreed version.
- `package.json` — add `"bridge": "tsx src/bridge/main.ts"` (+ built variant); add HTTP dep if not
  using native `http`.
- `README.md` — version + how to run the bridge.
- (Optional refactor) extract handlers in `src/tools/*` so MCP + bridge share code.

**pauls-brawls (Java)**

- `BotBridgeClient.java` — new; async HTTP client to the bridge.
- `GodBody.java` — new; appear/say/look/gesture/vanish semantics.
- `GodActionQueue.java` — new (§7); main-thread FIFO queue; `register()` drains on
  `END_SERVER_TICK`.
- `GodScheduler.java` — new (§6c); `ScheduledExecutorService` for deferred `Wait`; shut down on
  `SERVER_STOPPING`.
- `GodSessionManager` — new; single-owner busy lock + idle watchdog (timeout > max `Wait`).
- `ChatCommand.java` — claim the avatar, start session + reset idle timer in `onChatCommand`;
  bodiless if can't claim. No auto-appear.
- `ChatBot.java` — vanish/`endSession` (enqueues `restoreAvatar`, releases the lock) in the
  `setupGeneralCallback` terminal branch (outside `needsBuildTools`), and on depth-cap / error
  exits.
- `ChatBotFunctions.java` — add `SpawnCreature`, `Appear`, `Vanish`, `Wait` POJOs; register in
  `registerGodTools`; dispatch in `executeFunction` (world-mutating via
  `GodActionQueue.submit(...).join()`); fire `GodBody` gestures + `GodBody.say`; special-case
  `Wait` to defer `sendFunctionOutputs` via `GodScheduler`.
- `ChatBotActions.java` — `spawnCreature(...)`, `buffAvatar`/`restoreAvatar` (just the invuln flag);
  route smite/giveItem/changeWeather through `GodActionQueue` (fixes the off-thread bug).
- `LLMConfig.java` (+ `/llm`) — `bridgeUrl`, `enabled`, `botUsername` (single source of truth),
  `Wait`/`SpawnCreature.count` clamps, admin creature-griefing toggle.
- `ServerEntryPoint.java` — register `GodActionQueue` + `GodScheduler`; op the bot on join
  (option 1).
- `prompt.txt` — teach God about its body, the new tools, and public speech.

## 10. Safety & cost

- **Bridge is best-effort:** every `BotBridgeClient` call is wrapped so failures log and return —
  never throw into the prayer flow. Bridge down → God still works, bodiless.
- **Idle watchdog** force-vanishes stale sessions; its timeout must exceed the max `Wait`.
- **Power / pacing clamps:** cap `Appear.distance`/`height`, `SpawnCreature.count`, `Wait.seconds`
  (e.g. 1–30); consider a per-player cooldown.
- **Griefing is admin-configurable:** a `/llm` toggle + cap governs whether god-spawned creatures
  may damage terrain; default off.
- **Kill switch:** a command (`/pray stop` or admin `/godbody off`) that force-vanishes, releases
  the busy lock, clears the `GodActionQueue`, cancels pending `GodScheduler` waits, and disables the
  bridge.
- **Parking spot:** a fixed off-map coordinate the bot `/tp`s to on vanish.
- **Thread confinement:** every world mutation goes through `GodActionQueue` on the main thread;
  `MAX_PER_TICK` bounds per-tick work.
- **One owner, no race (§5):** the busy lock means a single session drives the avatar, so the invuln
  flag (§6d) is set/cleared by exactly one party. Still undo it on every exit path, but no
  concurrent session can corrupt it.
- **Concurrency depth:** `MAX_FUNCTION_CALL_DEPTH` (100) bounds runaway loops (including
  `Wait`-deferred continuations); the session ends the moment a turn has no tool calls.
- **No re-entrant input during a deferred `Wait`:** the busy lock stops the same player launching a
  second overlapping prayer that would race the pending `sendFunctionOutputs` on the shared
  conversation state — a new `/pray` while a session is live just resets the idle timer.

## 11. Testing & verification

- **Version handshake:** dedicated server up; bot joins; `GET /health` returns its position.
- **Op:** bot can run `/tp` (manual `POST /appear`).
- **No-show path:** `/pray salut` yielding pure text and no tool calls → God answers in chat, bot
  never appears.
- **Appear (in front, facing):** God calls `Appear` → bot `/tp`s ≈3 blocks along the player's look
  direction and faces them; distance/height overrides + clamps work from any yaw; session stays
  open.
- **Wait:** `Appear` then `Wait(5)` then act → bot appears, pauses ~5 s with no API call, then
  resumes; idle watchdog does not vanish it.
- **Tool path + speaking:** `/pray donne-moi un diamant` → God appears, speaks its line in public
  chat (visible to a second observer), swings/nods as `Reward` fires, then leaves on the final
  text-only turn (or `Vanish`).
- **SpawnCreature + thread safety:** entities spawn near the player, count clamped, griefing toggle
  respected, effect on the main thread (no off-thread exceptions). Burst test confirms
  `MAX_PER_TICK` spreads work across ticks in order.
- **Avatar invulnerability (§6d):** with God present, summon hostile mobs and call `Punishment` near
  the avatar → bot survives unharmed and doesn't catch fire; invulnerable flag restored after
  vanish, idle watchdog, kill-switch.
- **Busy lock (§5):** A prays, God manifests; B prays mid-encounter → B gets a bodiless "God is
  occupied", avatar does not teleport to B; after A ends, B can claim.
- **Resilience:** kill the bridge mid-session → prayers still resolve server-side; bot doesn't
  move/speak. Restart → next prayer reattaches.
- **Idle watchdog:** dropped API response → bot vanishes after timeout (> max `Wait`); busy lock
  released.
- **Node:** `npm run lint && npx tsc --noEmit && npm run build`. **Java:** `./gradlew build`.

## 12. Decisions settled / still open

**Settled (this revision):**

- **Phase 0 first:** migrate the LLM client to LangChain4j before any God-Body work, so the four
  new tools and three LLM-loop hooks are written once against the final architecture (§0).
- **Magma ball:** dropped — removes the only self-damage source, collapses avatar safety to a single
  invuln flag (§6d).
- **Concurrency:** one encounter at a time — single-owner busy lock (§5); others bodiless. Also
  removes the cross-session invuln race and the re-entrant-`Wait` chain race.
- **Bot voice:** speaks in public chat via the bot (`POST /chat`) alongside `ChatPrinter` (§5, §4b).
- **Griefing:** admin-configurable — `/llm` toggle + cap for spawned-creature terrain damage,
  default off (§10).
- **Appear placement:** in front of the player, `playerPos + horizLookDir*distance + (0,height,0)`,
  facing the player, defaulted/clamped args (§6b).

**Still open:**

- **Bot persistence:** stay connected and teleport in/out (assumed), or fully connect/disconnect per
  prayer (cleaner disappear, multi-second join lag)?
- **Single bot, two processes:** the bridge entrypoint and the existing MCP stdio server both
  construct a `BotConnection` on the same `--username`. Confirm they're never run at once, or give
  them distinct names — otherwise the second login is kicked.
- **Version target:** confirm everything standardizes on 1.21.1 (recommended) vs 1.21.11, and that
  `mineflayer` + `minecraft-data` actually carry 1.21.1 protocol support (may be a blocker, not a
  config flip).
- **Memory window (inherited from Phase 0):** `MessageWindowChatMemory` vs `TokenWindowChatMemory`
  and the default N — picked in Phase 0, but the God-Body `Wait`/tool loops lengthen sessions, so
  re-check the bound holds under a long encounter.
