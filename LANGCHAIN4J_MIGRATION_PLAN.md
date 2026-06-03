# LangChain4j Migration Plan

How replacing the **OpenAI Java SDK** (`com.openai:openai-java:2.9.0`, Responses API)
with **LangChain4j** would reshape the pauls-brawls AI God feature. This is a **written
plan only** — no code changes — scoped to the `ChatBot` stack; Gibber and Capture-the-Flag
are untouched.

This is sequenced as **Phase 1** of a larger roadmap: migrate to LangChain4j *first*, then
build the God-Body integration ([GOD_BOT_INTEGRATION_PLAN.md](GOD_BOT_INTEGRATION_PLAN.md))
on top of the new foundation. See §0 for why this order, and §13 for how the God-Body plan's
hooks re-express once this migration lands.

---

## 0. Roadmap & sequencing

Two changes are planned for the AI God: this LangChain4j migration and the God-Body
integration (giving God a physical Mineflayer avatar). **Do LangChain4j first.**

| Phase | Work | Why this order |
|---|---|---|
| **1 — this plan** | Swap OpenAI SDK → LangChain4j. Pure refactor; **no new gameplay**. Same tools, same behavior, new client + client-side memory. | Establishes the final API shape before any new feature touches it. |
| **2 — God-Body** | Mineflayer avatar, bridge, new tools (`Appear` / `Vanish` / `Wait` / `SpawnCreature`), `GodActionQueue`, session lock. | Builds on Phase 1's architecture once, instead of building against the OpenAI API and re-migrating. |

**Why not the reverse, or both at once?** The God-Body plan is written against today's OpenAI
Responses API — it hooks `setupGeneralCallback`'s `hadFunctionCalls` branch, defers
`sendFunctionOutputs` for the `Wait` tool, adds Jackson-POJO tools via `addTool(X.class)`, and
reasons about the `previousResponseId` chain (its §5, §6c, §10). **Every one of those touchpoints
changes under LangChain4j.** If you build God-Body first, you write all four new tools and the
session/termination hooks twice — once OpenAI-style, then again post-migration. Doing the migration
first means Phase 2 targets the final architecture directly.

**Sequencing rule:** keep Phase 1 behavior-neutral. No new tools, no avatar, no session manager —
only the client swap and the move to client-side memory. Land it, verify against §11, *then* start
Phase 2. Phase 2's file-by-file list (its §9) stays valid; only the API idioms it uses are
supplied by Phase 1.

---

## 1. The one decision that drives everything

| | OpenAI SDK (today) | LangChain4j |
|---|---|---|
| API paradigm | **Responses API** (`client.responses().create`) | **Chat Completions** model (`ChatModel.chat(ChatRequest)`) |
| Conversation state | **Server-side**, via `previousResponseId` chaining | **Client-side**, you resend the full message list every turn (`ChatMemory`) |
| Calls | **Async** (`OpenAIClientAsync` → `CompletableFuture<Response>`) | **Blocking** (`ChatModel`) or callback streaming (`StreamingChatModel`) |
| Tools | Jackson POJOs auto-schema'd via `builder.addTool(X.class)` | `ToolSpecification` + `JsonObjectSchema`, or `@Tool` methods via `AiServices` |
| Tool result wire type | `ResponseInputItem.ofFunctionCallOutput(callId, json)` | `ToolExecutionResultMessage.from(request, json)` |
| Multi-provider | OpenAI SDK pointed at a custom `baseUrl` (LM Studio, Ollama) | `langchain4j-open-ai` (custom baseUrl) or dedicated `langchain4j-ollama` |

**LangChain4j has no equivalent of `previousResponseId`.** That single fact is the spine of
this migration. Today the mod sends *one* user message plus a response-id and lets OpenAI
retain the rest of the conversation. LangChain4j instead expects the **complete message list**
(system + every prior user/assistant/tool turn) on every call. So the migration is less "swap
the client" and more "**move conversation state from OpenAI's servers into the mod**."

The good news: the codebase already rebuilds the dynamic context block (player JSON, chat log,
nearby blocks) every turn, and already keeps a per-player history class
([ChatBotPlayerHistory.java](src/main/java/com/paul/brawl/ChatBotPlayerHistory.java)). The bones
of client-side memory are present — they just need to become the *source of truth* instead of an
auxiliary cache.

---

## 2. Where the OpenAI SDK lives today (full inventory)

Seven files import `com.openai`. Two of those imports are already dead weight.

| File | OpenAI coupling | Migration weight |
|---|---|---|
| [LLMConfig.java](src/main/java/com/paul/brawl/LLMConfig.java) | Builds `OpenAIClientAsync` via `OpenAIOkHttpClientAsync.builder()` (baseUrl, apiKey, org, project). Caches one shared client. Multi-provider map (openai / lmstudio / ollama). | **High** — the client factory. Becomes a `ChatModel` factory. |
| [ChatBot.java](src/main/java/com/paul/brawl/ChatBot.java) | The core loop. `ResponseCreateParams`, `EasyInputMessage`, `ResponseInputItem`, `ResponseInputImage`, `Response`, `previousResponseId` chaining, `client.responses().create()`, the whole `getPromptList` / `buildBuilder` / `sendBuilder` / callback machinery. | **Highest** — most of the rewrite is here. |
| [ChatBotFunctions.java](src/main/java/com/paul/brawl/ChatBotFunctions.java) | Tool POJOs with `@JsonClassDescription` / `@JsonPropertyDescription`; `builder.addTool(X.class)`; dispatch via `function.name()` + `function.arguments(X.class)`; `FunctionResult(ResponseFunctionToolCall, …)`; `extractResponseText(Response)`. | **High** — tool definition + dispatch model changes. |
| [BuildSubAgent.java](src/main/java/com/paul/brawl/BuildSubAgent.java) | A second, self-contained Responses loop with its own `previousResponseId` chain. | **Medium** — same patterns as ChatBot, smaller. |
| [ChatBotPlayerHistory.java](src/main/java/com/paul/brawl/ChatBotPlayerHistory.java) | Stores `List<ResponseInputItem>` per player. | **Medium** — element type changes to `ChatMessage`; role *promoted* to source of truth. |
| [ChatBotActions.java](src/main/java/com/paul/brawl/ChatBotActions.java) | Imports six `com.openai.*` types but only calls `ChatBot.buildBot.clearPreviousResponseId(...)`. **The imports are unused.** | **Trivial** — delete dead imports. |
| [ImagePayload.java](src/main/java/com/paul/brawl/ImagePayload.java) | `import com.openai.models.images.ImageEditParams.Image;` — **never used**. | **Trivial** — delete the import. |

What does **not** touch the SDK and therefore does **not change**: all of `ChatBotActions`'
world logic (give item, smite, weather, block placement), the textual `PlaceBlock` / `PlaceLine`
/ `PlaceBlocks` regex scanner in `ChatBotFunctions`, `PlayerDataCollector`, `ChatMessageHistory`,
`ChatPrinter`, `Prompts`, `Raycaster`, the Brigadier commands, `Screenshotter`, and the
`ImagePayload` / `ImageReceiver` packet transport. The image *bytes* still arrive the same way;
only how they're attached to a request changes.

---

## 3. Dependencies (build.gradle)

Remove the OpenAI artifacts and their hand-included transitive pile; add LangChain4j. Note that
LangChain4j pulls **Jackson** itself, and the OpenAI module bundles its own HTTP stack, so several
of the current `include(...)` lines become redundant.

**Remove** ([build.gradle:38-65](build.gradle)):

```groovy
implementation("com.openai:openai-java:2.9.0")
include("com.openai:openai-java:2.9.0")
include("com.openai:openai-java-core:2.9.0")
include("com.openai:openai-java-client-okhttp:2.9.0")
// the victools jsonschema-generator pair was only there to feed the OpenAI SDK's addTool(Class)
include 'com.github.victools:jsonschema-generator:4.38.0'
include 'com.github.victools:jsonschema-module-jackson:4.38.0'
```

**Add**:

```groovy
implementation("dev.langchain4j:langchain4j:1.0.0")
implementation("dev.langchain4j:langchain4j-open-ai:1.0.0")   // keeps custom-baseUrl LM Studio / Ollama working
// optional, only if you want native Ollama instead of its OpenAI-compatible endpoint:
// implementation("dev.langchain4j:langchain4j-ollama:1.0.0")
include("dev.langchain4j:langchain4j:1.0.0")
include("dev.langchain4j:langchain4j-core:1.0.0")
include("dev.langchain4j:langchain4j-open-ai:1.0.0")
// + whatever transitive artifacts loom's jar-in-jar needs (verify with ./gradlew dependencies)
```

Gotchas, mirroring the existing CLAUDE.md warning about jar-in-jar:

- **Re-verify every `include`** after the swap. LangChain4j brings Jackson and an HTTP client
  transitively; keep the Jackson includes (other mod code may use them) but drop anything now
  duplicated. The Kotlin stdlib includes were there for the OpenAI SDK's Kotlin core — check
  whether anything else needs them before removing.
- Pin the LangChain4j version explicitly and confirm loom's `include` resolves the full closure
  (`langchain4j-core`, the `-open-ai` module, and their HTTP/JSON deps) or the runtime jar will
  be missing classes.
- Java 21 / MC 1.21.1 are unaffected; LangChain4j targets Java 17+.

---

## 4. The config layer — `ChatModel` factory (LLMConfig.java)

This is the cleanest win. The provider abstraction `LLMConfig` already maintains (host, port,
model, apiKey per provider, with a `baseUrl()` helper) maps almost one-to-one onto a LangChain4j
model builder.

**Today:** `buildClient()` returns an `OpenAIClientAsync`; `sharedClient()` caches it.

**After:** return a LangChain4j `ChatModel`. Because LM Studio and Ollama already work by
pointing the OpenAI SDK at a custom `baseUrl`, the same trick works with `OpenAiChatModel`:

```java
ChatModel buildModel() {
    ProviderSettings p = active();
    return OpenAiChatModel.builder()
        .baseUrl(p.baseUrl())                 // https://api.openai.com/v1, or localhost:1234/v1, etc.
        .apiKey(resolveApiKey(p))
        .modelName(p.model)
        .build();
}
```

- `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` map to `.organizationId(...)` / `.projectId(...)` on the
  OpenAI builder; keep the same env-var guard.
- `sharedClient()` / `invalidateClient()` / `reloadClients()` keep their exact shape — they just
  hold a `ChatModel` instead of an `OpenAIClientAsync`. The `/llm` command and provider-swap flow
  are unchanged.
- **Async note:** `ChatModel.chat()` is **blocking**. To preserve today's non-blocking
  architecture, either (a) wrap calls in `CompletableFuture.supplyAsync(() -> model.chat(req),
  executor)` on a small dedicated pool, or (b) switch to `StreamingChatModel` and adapt the
  callbacks. Option (a) is the smaller change and keeps `setupGeneralCallback`'s `thenAccept`
  shape intact (see §7).

---

## 5. The core loop — ChatBot.java (the bulk of the work)

### 5a. Conversation state: `previousResponseId` → `ChatMemory`

Replace:

```java
public ConcurrentHashMap<UUID, String> previousResponseIds;   // server-side chain pointer
```

with per-player client-side memory:

```java
public ConcurrentHashMap<UUID, ChatMemory> memories;          // MessageWindowChatMemory.withMaxMessages(N)
```

Every method that read/wrote `previousResponseId` (`getPreviousResponseId`,
`setPreviousId`, `clearPreviousResponseId`, `setPreviousResponse`, `needsPreviousResponse`) folds
into "add this turn's messages to the player's `ChatMemory`." The whole "omit the system prompt on
follow-ups because the server retains it" branch in `getPromptList`
([ChatBot.java:351-359](src/main/java/com/paul/brawl/ChatBot.java)) **disappears** — `ChatMemory`
holds the `SystemMessage` permanently and replays it each call. That's a simplification, not new
complexity.

### 5b. Message construction: `ResponseInputItem` → `ChatMessage`

A direct type-for-type translation:

| OpenAI (Responses) | LangChain4j |
|---|---|
| `EasyInputMessage` role SYSTEM | `SystemMessage.from(text)` |
| `EasyInputMessage` role USER | `UserMessage.from(text)` |
| `ResponseInputImage` (base64 data URL) | `ImageContent.from(base64, "image/jpeg")` inside a `UserMessage` |
| `ResponseInputItem.ofFunctionCallOutput(callId, json)` | `ToolExecutionResultMessage.from(request, json)` |
| assistant output message | `AiMessage` (returned in `ChatResponse`) |

`getPromptList(player)` becomes "assemble the per-call message list": the dynamic context block
(player JSON, chat history, nearby blocks — built **exactly as today**) is added as
`SystemMessage`s/`UserMessage`s each turn, then the player's `ChatMemory` messages are appended
(or vice-versa, matching current ordering).

### 5c. Request + response

`buildBuilder` / `makeBuilder` / `sendBuilder` collapse into building a `ChatRequest`:

```java
ChatRequest req = ChatRequest.builder()
    .messages(messages)                    // system + dynamic context + memory
    .toolSpecifications(toolSpecs)         // §6
    .build();

// async wrapper to keep the existing callback style
CompletableFuture.supplyAsync(() -> model.chat(req), executor)
    .whenComplete((resp, ex) -> { if (ex != null) logApiError(ex, player); })
    .thenAccept(resp -> setupGeneralCallback(resp, player));
```

`Response` → `ChatResponse`. The output-shape walking in `setupGeneralCallback` /
`logResponseShape` / `addOutputsToHistory` / `printOutputs` rewrites against the new shape:

- `ChatBotFunctions.extractResponseText(Response)` → reads `chatResponse.aiMessage().text()`.
  Much simpler than today's `output() → message() → content() → outputText()` stream.
- Function calls: `r.output()...isFunctionCall()` → `chatResponse.aiMessage().toolExecutionRequests()`.
- **Reasoning items**: today `addOutputsToHistory` persists reasoning blocks
  ([ChatBot.java:458-462](src/main/java/com/paul/brawl/ChatBot.java)). LangChain4j's standard
  `AiMessage` does not surface reasoning as a re-submittable item, so that handling is **dropped**
  (no functional loss for the gameplay; it only affected token bookkeeping on the chain).

### 5d. The function-call depth guard stays

`MAX_FUNCTION_CALL_DEPTH` and `functionCallDepth` are pure mod-side bookkeeping — they carry over
unchanged. The cleanup-on-cap logic that today "wipes the chain because OpenAI requires matching
outputs" ([ChatBot.java:204-208](src/main/java/com/paul/brawl/ChatBot.java)) gets *simpler*: with
client-side memory you just drop the offending tool-call/assistant messages from the player's
`ChatMemory` and the next turn is clean — no server-side chain to corrupt.

---

## 6. Tools — ChatBotFunctions.java

LangChain4j offers two routes. **Recommendation: the low-level `ToolSpecification` route**, because
it preserves the existing manual dispatch loop and the codebase already does its own tool
orchestration (it does not want `AiServices` taking over the loop).

### 6a. Defining tools

Today each tool is a Jackson POJO whose `@JsonClassDescription` / `@JsonPropertyDescription`
annotations the OpenAI SDK auto-converts to a JSON schema via victools. LangChain4j wants a
`ToolSpecification` with a `JsonObjectSchema`. Two options:

- **Keep the POJOs, derive specs from them.** `dev.langchain4j.model.chat.request.json` +
  the `@Tool`/`ToolSpecifications` helpers can build a `ToolSpecification` from an annotated
  method; for plain POJOs you write a small adapter that walks the same Jackson annotations you
  already have (so `Reward`, `Trade`, `Punishment`, `ChangeWeather`, `BuildPlan` keep their
  descriptions). This keeps the schema **co-located with the POJO**, matching today's style.
- **Hand-write `ToolSpecification`s.** Explicit `JsonObjectSchema.builder().addStringProperty(...)`
  per tool. More verbose but zero reflection/annotation magic.

`registerGodTools(builder)` / `registerBuildPlanTool(builder)` become
`List<ToolSpecification> godTools()` / `buildPlanTool()` that you attach to the `ChatRequest`
(§5c) instead of mutating a builder.

### 6b. Dispatch

`executeFunction` ([ChatBotFunctions.java:199-208](src/main/java/com/paul/brawl/ChatBotFunctions.java))
keeps its `switch` on the tool name almost verbatim — only the argument-deserialization call
changes:

```java
// today:  function.arguments(Reward.class).execute(player)
// after:  argsFrom(request, Reward.class).execute(player)
//   where argsFrom() Jackson-parses request.arguments() (a JSON string) into the POJO.
```

`ResponseFunctionToolCall` → `ToolExecutionRequest` (has `id()`, `name()`, `arguments()`).
`FunctionResult` record's first field changes type accordingly. `checkForFunctions` keeps its
shape: iterate `aiMessage().toolExecutionRequests()`, dispatch each, collect results, and if any
ran, re-invoke via `sendFunctionOutputs`.

### 6c. Tool outputs back to the model

`sendFunctionOutputs` ([ChatBot.java:196-224](src/main/java/com/paul/brawl/ChatBot.java)) swaps
`ResponseInputItem.ofFunctionCallOutput(callId, json)` for
`ToolExecutionResultMessage.from(request, json)`, appends them (plus the preceding `AiMessage`
carrying the tool calls) to the player's `ChatMemory`, and re-issues the `ChatRequest`. The
**order matters more now**: client-side, each assistant tool-call message must be immediately
followed by its matching tool-result message in memory, or the next request is malformed. The
OpenAI server enforced this for you before; now the mod must.

### 6d. The textual `PlaceBlock` scanner is untouched

The regex-based `PlaceBlock` / `PlaceLine` / `PlaceBlocks` machinery
([ChatBotFunctions.java:210-380](src/main/java/com/paul/brawl/ChatBotFunctions.java)) parses the
model's **text output**, not tool calls — it has zero OpenAI coupling and migrates verbatim. Only
its input, `extractResponseText`, changes one line internally (§5c).

---

## 7. Async & threading

Today everything is async-by-construction (`OpenAIClientAsync`,
`CompletableFuture<Response>`, callbacks on a CF worker thread — never the server main thread).
`ChatModel` is blocking, so to keep that property:

- Introduce one shared `ExecutorService` (e.g. a small fixed pool) in `LLMConfig` or `ChatBot`,
  shut down on `SERVER_STOPPING`.
- Wrap each `model.chat(...)` in `CompletableFuture.supplyAsync(..., pool)` so
  `setupGeneralCallback`'s `thenAccept` and the existing off-main-thread contract are preserved
  byte-for-byte downstream.
- **The pre-existing off-main-thread world-mutation caveat is unchanged** (and unrelated to the
  SDK): callbacks still run off the main thread, so `ChatBotActions` world writes still rely on
  the same patterns they do today. (If you also adopt the God-Body plan's `GodActionQueue`, that
  remains orthogonal to this migration.)

Alternative: `StreamingChatModel` gives token-by-token callbacks and a natural async fit, but it's
a bigger behavioral change (partial-message handling, when to run the tool loop) — not worth it
unless you want streamed chat output in-game.

---

## 8. BuildSubAgent.java

Same transformation as `ChatBot`, smaller surface: its private `previousResponseId` field becomes
a private `ChatMemory` (or a plain `List<ChatMessage>`, since a sub-agent is single-player and
short-lived); `ResponseCreateParams.builder()...create()` becomes a `ChatRequest` + blocking
`model.chat` on the shared pool; `handleResponse(Response)` reads `chatResponse.aiMessage().text()`
and feeds the same `scanAndExecuteWithPivot` textual scanner (untouched). The
"system-prompt-only-on-first-turn" optimization disappears here too — `ChatMemory` retains it.

---

## 9. File-by-file change list

- **build.gradle** — drop `com.openai:*` + victools `include`s; add `langchain4j` +
  `langchain4j-open-ai`; re-verify the jar-in-jar `include` closure (§3).
- **LLMConfig.java** — `OpenAIClientAsync` → `ChatModel`; `buildClient`/`sharedClient`/
  `invalidateClient` return/cache the model; add a shared `ExecutorService` for async wrapping (§4, §7).
- **ChatBot.java** — biggest change: `previousResponseIds` → per-player `ChatMemory`; rewrite
  `getPromptList` / `buildBuilder` / `sendBuilder` / `sendRequest` / `sendChatRequest` /
  `sendImageChatRequest` / `sendFunctionOutputs` / `sendTextualContinuation` against `ChatRequest`
  + `ChatMessage`; rewrite `setupGeneralCallback` / `logResponseShape` / `addOutputsToHistory` /
  `printOutputs` / `extractResponseText` against `ChatResponse` / `AiMessage`; drop reasoning-item
  persistence; keep the depth guard (§5).
- **ChatBotFunctions.java** — tool POJOs → `ToolSpecification`s (keep the Jackson annotations via
  an adapter, or hand-write schemas); `registerGodTools`/`registerBuildPlanTool` return tool lists;
  `executeFunction` dispatch swaps `function.arguments(X.class)` for a Jackson parse of
  `ToolExecutionRequest.arguments()`; `FunctionResult` field type changes; textual scanner
  untouched (§6).
- **ChatBotPlayerHistory.java** — element type `ResponseInputItem` → `ChatMessage`; promote from
  auxiliary cache to the memory source of truth (or fold into LangChain4j `ChatMemory` and delete
  this class).
- **BuildSubAgent.java** — `previousResponseId` → `ChatMemory`/message list; request/response
  rewrite (§8).
- **ChatBotActions.java** — delete six unused `com.openai.*` imports.
- **ImagePayload.java** — delete the unused `ImageEditParams.Image` import.
- **prompt.txt / build_prompt.txt** — no change required (provider-agnostic persona text).

---

## 10. What gets simpler, what gets harder

**Simpler**

- Provider config (§4) — `OpenAiChatModel.builder()` is tidier than the okhttp builder, and the
  LM Studio / Ollama custom-baseUrl story stays intact (or improves with native modules).
- `extractResponseText` collapses from a four-level stream to `aiMessage().text()`.
- The "omit system prompt on follow-ups" special-casing vanishes in both `ChatBot` and
  `BuildSubAgent` — `ChatMemory` handles it.
- The depth-cap "wipe the server chain" hack becomes a local list trim.

**Harder / riskier**

- **Conversation state moves into the mod.** You now own correctness of message ordering
  (assistant-tool-call → tool-result pairing) and memory-window trimming. Get the pairing wrong and
  requests are rejected. This is the main source of migration bugs.
- **Token cost grows.** No server-side chain means resending the full memory window every turn.
  Bound it with `MessageWindowChatMemory.withMaxMessages(N)` or `TokenWindowChatMemory`; today's
  per-player chain was cheaper on follow-ups.
- **Async is now opt-in.** You must add and own the executor; forgetting it would block server
  threads.
- **Tool schema fidelity.** victools/OpenAI-SDK schema generation is replaced by LangChain4j's;
  verify the generated JSON schema for each tool still matches what the model expects (especially
  nested `BuildPlan.builds` → `List<SubBuild>`).
- **Reasoning items dropped** — fine for gameplay, but note it if you later want reasoning traces.

---

## 11. Testing & verification

1. **Build:** `./gradlew build` resolves with the new deps and a clean jar-in-jar closure (no
   missing `langchain4j-core` classes at runtime).
2. **Provider swap:** `/llm` switches openai ↔ lmstudio ↔ ollama and each produces a reply
   (custom-baseUrl path works under `OpenAiChatModel`).
3. **Plain prayer:** `/pray salut` returns God's French text via `ChatPrinter` (text extraction
   path).
4. **Single tool:** `/pray donne-moi un diamant` → `Reward` fires once, the item is granted, and
   the tool-result round-trips so God can comment (validates assistant-tool-call → tool-result
   pairing in client memory).
5. **Multi-tool / depth:** a prayer that chains several tools stays under
   `MAX_FUNCTION_CALL_DEPTH` and terminates on the first tool-less turn.
6. **Image path:** `/prouver` ships a screenshot; `ImageContent` reaches the model and the proof is
   evaluated (validates base64 → `ImageContent`).
7. **Build path:** `/construire` triggers `BuildPlan`; sub-agents place blocks via the untouched
   textual scanner; confirm each sub-agent's memory is isolated.
8. **Memory bound:** a long conversation doesn't grow unbounded (window trim works) and never sends
   an unpaired tool-call message.
9. **Concurrency:** two players pray at once; their `ChatMemory` instances stay separate (the
   per-UUID map still keys correctly).
10. **No stray OpenAI refs:** `grep -rn "com.openai" src/` returns nothing.

---

## 12. Open questions

- **Memory window size / strategy** — `MessageWindowChatMemory` (message count) vs
  `TokenWindowChatMemory` (token budget, needs a tokenizer). Pick one and a default N.
- **Keep `ChatBotPlayerHistory` or fold into `ChatMemory`?** They overlap heavily now; folding
  removes a class but ties you to LangChain4j's memory API.
- **AiServices vs manual loop** — this plan keeps the manual dispatch loop (more control, smaller
  diff). `AiServices` would be more idiomatic but would absorb the tool loop and the textual-scanner
  interleaving, a larger redesign.
- **Streaming** — stick with blocking-wrapped-in-CompletableFuture (recommended), or adopt
  `StreamingChatModel` for in-game streamed replies later?
- **Exact LangChain4j version** — confirm the current GA release and that `langchain4j-open-ai`
  exposes `.organizationId()` / `.projectId()` and custom `baseUrl` on the version you pin.

---

## 13. Phase 2 — how the God-Body plan re-expresses on LangChain4j

Phase 1 deliberately changes no behavior, but it does change the **idioms** the God-Body plan
([GOD_BOT_INTEGRATION_PLAN.md](GOD_BOT_INTEGRATION_PLAN.md)) is written in. This table is the
translation key so Phase 2 builds against the post-migration architecture. Nothing in the
God-Body plan is *cancelled* — its file-by-file list (its §9), the bridge, `GodActionQueue`,
`GodScheduler`, and the session lock are all unaffected. Only the LLM-loop touchpoints move.

| God-Body plan element | Written against (OpenAI) | After Phase 1 (LangChain4j) |
|---|---|---|
| New tools `Appear` / `Vanish` / `Wait` / `SpawnCreature` (its §6) | Jackson POJOs registered via `builder.addTool(X.class)`, dispatched by `function.arguments(X.class)` | `ToolSpecification`s added to the `ChatRequest`, dispatched by Jackson-parsing `ToolExecutionRequest.arguments()` — **same POJOs, new registration/dispatch (this plan's §6).** Write them once, in the new style. |
| Termination hook in `setupGeneralCallback` (its §5, §6c) | `boolean hadFunctionCalls = checkForFunctions(r, …)` on `r.output()` | Same logic on `chatResponse.aiMessage().toolExecutionRequests()`. The `willContinue` restructuring the God-Body plan specifies (its §5) still applies — it just reads the new response shape. |
| `Wait` defers `sendFunctionOutputs` by N seconds (its §6c) | Schedule the `sendFunctionOutputs(results, player)` re-invocation on `GodScheduler` | Identical — but `sendFunctionOutputs` now appends `ToolExecutionResultMessage`s to the player's `ChatMemory` and re-issues a `ChatRequest` (this plan's §6c). The deferral mechanism is unchanged; only what the deferred call does changes. |
| Kill-switch / `/construction` "reset the chain" (its §10, CLAUDE.md gotcha) | `clearPreviousResponseId(player)` wipes the server-side chain | Clear/trim the player's `ChatMemory` — a local list op, no server chain to corrupt (this plan's §5d). The God-Body kill-switch's "clear `GodActionQueue`, cancel `GodScheduler` waits" is orthogonal and unchanged. |
| Re-entrant-`Wait` race on the shared chain (its §10) | Two overlapping prayers race the shared `previousResponseId` chain | Now they'd race the shared `ChatMemory` instead — **the busy lock still solves it**, and message-ordering correctness (assistant-tool-call → tool-result pairing, this plan's §6c/§10) makes the lock even more load-bearing. |
| `MAX_FUNCTION_CALL_DEPTH` bounds `Wait`-deferred loops (its §10) | Carries over | Unchanged — pure mod-side bookkeeping (this plan's §5d). |
| Avatar gestures / bridge / `GodActionQueue` / op-on-join / session lock | — | **Fully API-agnostic. No change** — these never touch the LLM client. |

**Net effect on Phase 2 effort:** the avatar, bridge, thread-queue, and session machinery are
unaffected by the migration. The only God-Body work that *benefits* from going second is the four
new tools and the three LLM-loop hooks (termination, `Wait` deferral, chain/memory reset) — and
"benefits" means *written once* instead of built on OpenAI idioms and then migrated. That saving is
the entire reason for the ordering in §0.
