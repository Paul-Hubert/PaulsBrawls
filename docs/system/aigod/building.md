---
id: aigod.building
title: AI God — Building System (/construction, /build, BuildPlan, BuildSubAgent, Place* grammar)
system: aigod
summary: End-to-end build pipeline - pivot selection by raycast, the buildBot loop, BuildPlan fan-out to BuildSubAgents, the exact PlaceBlock/PlaceLine/PlaceBlocks regex grammar and how blocks land.
tags: [aigod, build, buildbot, buildplan, subagent, placeblock, placeline, placeblocks, raycaster, construction, regex, prompt]
sources:
  - src/main/java/com/paul/brawl/BuildSubAgent.java
  - src/main/java/com/paul/brawl/Raycaster.java
  - src/main/java/com/paul/brawl/ChatBotFunctions.java
  - src/main/java/com/paul/brawl/ChatBotActions.java
  - src/main/java/com/paul/brawl/ChatBot.java
  - src/main/java/com/paul/brawl/ChatCommand.java
  - src/main/java/com/paul/brawl/ImageReceiver.java
  - src/main/java/com/paul/brawl/ImagePayload.java
  - src/main/java/com/paul/brawl/JsonSchemaAdapter.java
  - src/main/java/com/paul/brawl/LLMConfig.java
  - src/client/java/com/paul/brawl/Screenshotter.java
  - build_prompt.txt
  - run/build_prompt.txt
  - run/max_build_prompt.txt
  - LANGCHAIN4J_MIGRATION_PLAN.md
verified_at: 4a8081f
---

# AI God — Building System

**TL;DR.** An op runs `/construction` to raycast-pick a **pivot block** (stored per player UUID, in memory only).
A player then runs the client command `/build "<text>"`; the text (prefixed `Build : `) reaches the
**`buildBot`** `ChatBot`, whose prompt is `build_prompt.txt` from the JVM cwd. The model either emits textual
`PlaceBlock` / `PlaceLine` / `PlaceBlocks` lines (regex-scanned, executed relative to the pivot, looped until a
reply has zero call lines) or calls the **`BuildPlan`** tool, which spawns N parallel **`BuildSubAgent`**s, each with
its own anchor pivot, private memory and 5 automatic refinement passes. Blocks are written with
`world.setBlockState` **from the LLM worker thread** (not via `GodActionQueue`).

## Components and where they live

| Piece | File | Role |
|---|---|---|
| `/construction`, `/block` commands | `src/main/java/com/paul/brawl/ChatBotActions.java:162-195` | Set pivot (and wipe buildBot memory); debug-place stone |
| Pivot store + raycast | `src/main/java/com/paul/brawl/Raycaster.java` | `HashMap<UUID, BlockPos> lastPos` (`Raycaster.java:21`) |
| Client `/build` | `src/client/java/com/paul/brawl/Screenshotter.java:58-73` | Captures screenshot, sends `ImagePayload` with text `"Build : " + s` |
| Routing | `ImageReceiver.java:28-37`, `ChatBot.java:644-651` | `"Build :"` substring → `ChatBot.buildBot` |
| `buildBot` instance + flags | `ChatBot.java:131-151` | `new ChatBot("build_prompt.txt")` |
| Main build loop | `ChatBot.java:522-573` (`setupGeneralCallback`), `ChatBot.java:362-383` (`sendTextualContinuation`) | Scan text, place, continue |
| `BuildPlan` / `SubBuild` tool POJOs | `ChatBotFunctions.java:205-297` | Fan-out to sub-agents |
| Textual grammar (regexes, scanners) | `ChatBotFunctions.java:536-701` | `PLACE_BLOCK_PATTERN` etc. |
| Placement primitives | `ChatBotActions.java:197-314` | `placeBlockAt`, `placeLineAt`, `placeBlocksAt`, `parseBlockState` |
| Sub-agent worker | `src/main/java/com/paul/brawl/BuildSubAgent.java` | Isolated multi-pass loop |
| System prompt | `build_prompt.txt` (repo root) and `run/build_prompt.txt` (dev cwd) | Loaded from the JVM working dir |

## End-to-end flow

```
/construction (op, perm 2)                       /build "a stone tower"   (client cmd, any player)
   │ Raycaster.setLastPos(player)                    │ Screenshotter: chat "Capture d'écran dans 1 seconde"
   │ buildBot.clearMemory(player)                    │ +1 s, next client tick: framebuffer → 854x480 → ImagePayload("Build : a stone tower")
   ▼                                                 ▼
lastPos[uuid] = looked-at BlockPos (or null)     ImageReceiver.checkProof → getCorrectChatBot → buildBot
                                                     │ buildBot.sendImageChatRequest(text, bytes, player)
                                                     │   hasImage=false → only the TEXT is added to memory
                                                     ▼
                                   doRequest (llm-worker virtual thread): [System(build_prompt + /prompt overlay)] + memory,
                                   tools = [BuildPlan, ListTools]
                                                     │
                     ┌───────────────────────────────┴──────────────────────────────┐
             reply has tool calls                                            reply has no tool calls
     checkForFunctions → BuildPlan.execute                         checkForTextualFunctions → scanAndExecute(pivot=null)
     → N × new BuildSubAgent(...).start()                          placed>0 → sendTextualContinuation (loop)
     → tool result → sendFunctionOutputs (buildBot continues)      placed==0 → loop ends
```

## Pivot selection — `/construction` and `Raycaster`

| Aspect | Behaviour (code) |
|---|---|
| Command | `/construction`, no args, `requires(hasPermissionLevel(2))` — `ChatBotActions.java:181-193` |
| Effect | `Raycaster.setLastPos(player)` then `ChatBot.buildBot.clearMemory(player)` (drops buildBot memory, depth counter, sessionBound, pending Wait deferral for that player — `ChatBot.java:201-207`). No chat feedback is sent. |
| Storage | `private static HashMap<UUID, BlockPos> lastPos` (`Raycaster.java:21`) — static, in-memory, lost on restart, not thread-safe (written on main thread, read from LLM worker threads). |
| `setLastPos` | `lastPos.put(uuid, raycast(player, 0, 0))` (`Raycaster.java:145-147`). A miss stores `null`. |
| Direction | `player.getRotationVec(0.1f)` (`Raycaster.java:24`). The `x,y` screen-offset rotation (`fov = 70°`, `Raycaster.java:28`) is a no-op for `(0,0)`. |
| Block ray | From `getCameraPosVec(0.1f)` (eye) for **100 blocks** (`Raycaster.java:97`), `ShapeType.OUTLINE`, `FluidHandling.NONE` (fluids ignored) — `Raycaster.java:125-138`. |
| Entity ray | `ProjectileUtil.raycast` over the bounding box stretched 100 blocks along the look vector, expanded by 1; predicate `!isSpectator() && (groundCollision || verticalCollision || horizontalCollision)` (`Raycaster.java:109-115`). |
| Precedence | **Any** entity hit wins over the block hit regardless of distance (`Raycaster.java:118-122`); an entity hit returns `null` pivot. |
| Result | The hit block's own `BlockPos` — **not** the adjacent face (`.add(side)` is commented out). So offset `(0,0,0)` *replaces the block you looked at*; `y=0` is the ground layer. |
| Debug noise | `System.out.println(cameraDirection)` and `"Null"`/`"Miss"`/`"Entity"` printed to stdout on every call. |

Pivot is **per player UUID**: the pivot used by `/build` is the one set by the *same* player's `/construction`.
Since `/construction` needs perm 2, a non-op's `/build` has no pivot (see Gotchas).

Other consumers of `Raycaster.getLastPos`: `BuildPlan.execute` (`ChatBotFunctions.java:229`), the pivot-less
`placeBlock/placeLine/placeBlocks` wrappers (`ChatBotActions.java:197-222`), and `ChatBotActions.getBlockInfo`
(`ChatBotActions.java:252-281`) — the godBot's "blocks near the player's cursor" context is actually sampled around
this `/construction` pivot (empty string if none).

### `/block <x> <y> <z>`

`ChatBotActions.java:164-179`, perm 2, `IntegerArgumentType` ×3. Calls `placeBlock(player, x, y, z, "minecraft:stone")`,
i.e. places stone at **pivot + (x,y,z)** (relative, not absolute). Silently does nothing without a pivot. Runs on the main
thread (command context).

## The `buildBot`

Configured in `ChatBot.register()` (`ChatBot.java:131-151`):

| Flag | buildBot | godBot | Effect for buildBot |
|---|---|---|---|
| `promptPath` | `build_prompt.txt` | `prompt.txt` | Read with `Files.readString(Path.of(promptPath))` relative to JVM cwd (`ChatBot.java:636-642`); on IOException the stack is printed and `hardcodedPrompt` stays `""`. |
| `hasImage` | `false` | `true` | The `/build` screenshot is **discarded**; only the text is stored (`ChatBot.java:236-247`). |
| `needsInfo` | `false` | `true` | No player-JSON / chat-log / block-info system messages. |
| `needsBuildTools` | `true` | `false` | Textual Place* scan active; prose is stripped of call lines before printing. |
| `needsGodTools` | `false` | `true` | No session claim, no Appear/Vanish logic. |
| `needsBuildPlan` | `true` | `false` | `BuildPlan` tool attached (godBot never gets it). |
| `needsMcpTools` | `false` | `true` | No Mineflayer tools. |

Per-turn request: one `SystemMessage(hardcodedPrompt + "\n" + prompt)` + the player's `TokenWindowChatMemory`
(16 000 tokens), tools `[BuildPlan, ListTools]` (`ChatBotFunctions.java:313-340`). `prompt` is the `/prompt <text>`
overlay — `/prompt <text>` sets it on **both** bots; bare `/prompt` re-reads both prompt files from disk
(`ChatCommand.java:112-148`).

**Model:** `LLMConfig.INSTANCE.sharedModel()` — the same cached `ChatModel` as the God (active `/llm` provider + model,
request timeout `timeoutSeconds`, default 180). There is no separate build model. Requests run on
`LLMConfig.sharedExecutor()`, a virtual-thread-per-task executor named `llm-worker-N` (`LLMConfig.java:155-163`).

### Direct (textual) mode loop

In `setupGeneralCallback` (`ChatBot.java:555-563`):

1. Assistant message is appended to memory; text is printed as `"Dieu : " + strippedText` (`ChatBot.java:621-627`).
2. `checkForFunctions` runs first. If the reply had **any** tool call, textual call lines in the same reply are
   **ignored**.
3. Otherwise `checkForTextualFunctions` → `scanAndExecute(text, player, pivot=null)` (the pivot is looked up per call
   from `Raycaster.getLastPos`).
4. If `placed > 0`, `sendTextualContinuation(placed)` appends the user message
   `"[system] Executed N textual placement call(s) from your previous reply. If the build is now complete, reply with one short French sentence and no call lines. Otherwise emit more PlaceBlock / PlaceLine / PlaceBlocks lines and the system will call you again."`
   and re-requests.
5. A reply with zero matched call lines ends the loop.

Depth cap: `functionCallDepth` increments per continuation; above `MAX_FUNCTION_CALL_DEPTH = 100` the memory is wiped and
the player sees `"Dieu : (construction interrompue — limite de tours atteinte.)"` (`ChatBot.java:362-371`).
The depth counter resets to 0 on each new `/build` (`ChatBot.java:228`).

## `BuildPlan` tool (multi-structure fan-out)

Schema is generated by `JsonSchemaAdapter` from the POJOs; every annotated field is **required** (no `@OptionalField`).

| Tool | Field | JSON type | Meaning |
|---|---|---|---|
| `BuildPlan` | `builds` | array of `SubBuild` | Independent sub-builds, run in parallel |
| `SubBuild` | `anchorX` | integer | Offset east(+)/west(-) from the `/construction` pivot; becomes the sub-agent's `(0,0,0)` |
| | `anchorY` | integer | Offset up(+)/down(-); usually 0 |
| | `anchorZ` | integer | Offset south(+)/north(-) |
| | `description` | string | The only free-text context the sub-agent sees |
| | `style` | string | e.g. `medieval-stone`, `japanese-pagoda` |
| | `size` | string | `small/medium/large` or `XxZxY` like `8x8x12`; "stay under ~32 blocks per axis" |
| | `purpose` | string | e.g. `dwelling`, `watchtower`; used in the label |

`BuildPlan.execute(player)` (`ChatBotFunctions.java:228-292`), dispatched directly on the LLM worker (no `runOnMain`):

| Condition | Returned tool result (verbatim) |
|---|---|
| No pivot | `Aucun point de référence : l'admin doit lancer /construction avant d'utiliser BuildPlan.` |
| `builds` null/empty | `BuildPlan reçu sans aucun sous-build — rien à faire.` |
| `ChatBot.buildBot == null` | `Erreur interne : buildBot non initialisé. Impossible de lancer les sous-constructions.` |
| All entries null | `BuildPlan ne contenait que des sous-builds nuls — rien à faire.` |
| Success | `Plan accepté : N sous-construction(s) lancée(s) en parallèle. Chaque sous-agent fera ~6 passes (initiale + refinements).` |

For each non-null `SubBuild` i (1-based) of n:

- `subPivot = basePivot.add(anchorX, anchorY, anchorZ)`
- `label = i + "/" + n + " " + (purpose or "structure")`
- **System prompt** = `buildBot.hardcodedPrompt + "\n" + buildBot.prompt + "\n\n# Sub-build assignment\n" + ...` — the
  addendum says it is one of n parallel sub-agents, cannot see the others, builds one thing at offsets from its own
  `(0,0,0)`, will receive refinement passes, and must reply with zero call lines to finish a pass.
- **Initial user message**: `Sub-build <label>.` / `Purpose:` / `Style:` / `Size:` / `Description:` (blank →
  `(unspecified)` / `(no description)`) then `"Pass 1 — primary structure. Build the floor, walls, and roof in that order. ..."`.
- `new BuildSubAgent(player, subPivot, systemPrompt, initialUser, label, DEFAULT_REFINEMENTS).start()`.

There is no cap on n. The tool returns immediately; builds run asynchronously. The tool result goes back to buildBot via
`sendFunctionOutputs`, so the planner gets one more turn.

## `BuildSubAgent` (isolated worker)

| Property | Value / behaviour | Where |
|---|---|---|
| `MAX_TURNS` | `60` (counts every request, including the first) | `BuildSubAgent.java:45` |
| Memory | `MessageWindowChatMemory.withMaxMessages(MAX_TURNS*2+2 = 122)`, seeded once with the `SystemMessage`; private to the agent (never sees planner history) | `BuildSubAgent.java:79-80` |
| Model / executor | `LLMConfig.INSTANCE.sharedModel()` on `sharedExecutor()` | `BuildSubAgent.java:102-106` |
| Tools | **None** — `ChatRequest` carries only messages (so no recursive `BuildPlan`) | `BuildSubAgent.java:98-100` |
| Pivot | Fixed `subPivot`; calls go through `ChatBotFunctions.scanAndExecuteWithPivot(text, player, pivot)` | `BuildSubAgent.java:132` |
| Player | Holds the `ServerPlayerEntity` of the planner's caller; messages go to that player only | — |

Loop (`BuildSubAgent.java:83-160`):

1. `start()` → chat `"[sub-build <label>] start @ x,y,z"` → `sendTurn(initialUserMessage)`.
2. Each response: append AI message, scan & execute placements against the pivot, print prose as `"[<label>] <prose>"`.
3. `placed > 0` → send `"[system] Executed N textual placement call(s) from your previous reply. If this pass is now complete, reply with one short French sentence and no call lines. Otherwise emit more PlaceBlock / PlaceLine / PlaceBlocks lines and the system will call you again."`
4. `placed == 0` and refinements remain → send the next refinement (FIFO).
5. `placed == 0`, none left → `"[sub-build <label>] terminé (N blocs placés)."`

`DEFAULT_REFINEMENTS` (`BuildSubAgent.java:48-54`), in order: **Pass 2 — gap fix** (close holes, wall under eaves; use
`minecraft:glass` not `glass_pane`), **Pass 3 — interior** (floor, ceiling, lighting, furniture for the purpose),
**Pass 4 — exterior** (foundation, path/stairs, trim, accents), **Pass 5 — roof and walls-under-roof** (replace leftover
glass panes), **Final pass** (close gaps, end with one short French sentence and zero call lines). Total: 1 initial + 5
refinement passes.

Failure handling:

| Event | Behaviour |
|---|---|
| Turn > 60 | Log warn; chat `"[sub-build <label>] arrêt — limite de tours atteinte (N blocs)."`; stop |
| LLM call throws | Log root cause; chat `"[sub-build <label>] échec de l'appel LLM — construction interrompue (N blocs placés)."`; stop (no retry) |
| `handleResponse` throws | Logged only (`"Sub-build '{}' handler threw"`); agent silently stops |
| `BuildGuard.cancelAll()` ran since the agent started | chat `"[sub-build <label>] annulée (N blocs placés)."` at its next turn (or when its in-flight reply lands — nothing is placed); stop |

Every terminal path releases the agent's `BuildGuard` slot exactly once. **Cancel (bug #7):** `/godbody off` and
`SERVER_STOPPING` call `BuildGuard.cancelAll()`; `/construction`, `/llm reload` and player logout still do not stop
running sub-agents. `N blocs` is actually the number of executed **call lines**, not blocks.

**Caps (bug #7, `BuildGuard`, unit-tested):** at most `MAX_CONCURRENT_SUB_BUILDS = 4` sub-agents run server-wide —
`BuildPlan` launches what fits and says how many it skipped (`Plan refusé : 4 sous-constructions tournent déjà…` when
none fit); one `PlaceLine`/`PlaceBlocks` call may place at most `MAX_BLOCKS_PER_CALL = 128` blocks (a larger one is
skipped with a warning, not counted).

## Textual grammar (exact)

Defined in `ChatBotFunctions.java:536-569`:

```java
INT        = "-?\\d+"
WS         = "\\s*"                                  // includes newlines: a call may span lines
BLOCK_ID   = "[A-Za-z][A-Za-z0-9_]*:[A-Za-z][A-Za-z0-9_/]*(?:\\[[^\\]]*\\])?"
BLOCK_NAME = "(?:\"(" + BLOCK_ID + ")\"|'(" + BLOCK_ID + ")'|`(" + BLOCK_ID + ")`|(" + BLOCK_ID + "))"
INT_ARRAY  = "\\[" + WS + "(" + INT + "(?:" + WS + "," + WS + INT + ")*)?" + WS + "\\]"

PLACE_BLOCK_PATTERN  = "PlaceBlock"  WS "\(" WS (INT) WS "," WS (INT) WS "," WS (INT) WS "," WS BLOCK_NAME WS "\)"
PLACE_LINE_PATTERN   = "PlaceLine"   WS "\(" WS (INT)×6 separated by WS "," WS, then "," WS BLOCK_NAME WS "\)"
PLACE_BLOCKS_PATTERN = "PlaceBlocks" WS "\(" WS (INT_ARRAY) WS "," WS (INT_ARRAY) WS "," WS (INT_ARRAY) WS "," WS BLOCK_NAME WS "\)"
```

| Call | Groups used | Semantics |
|---|---|---|
| `PlaceBlock(x, y, z, "ns:id[props]")` | 1-3 ints, block = first non-null of 4-7 | One block at pivot+(x,y,z) |
| `PlaceLine(x1,y1,z1,x2,y2,z2, "ns:id")` | 1-6 ints, block 7-10 | `maxLen = max(1, max(|dx|,|dy|,|dz|))`; for `i=0..maxLen`: `(x + dx*i/maxLen, ...)` with Java integer division (truncation toward zero); both endpoints inclusive (`ChatBotActions.java:230-242`) |
| `PlaceBlocks([xs],[ys],[zs], "ns:id")` | arrays = groups 1, 3, 5 (2/4/6 are the arrays' inner groups), block 7-10 | Ints extracted with `INT_TOKEN_PATTERN`; iterates `min(len(xs),len(ys),len(zs))` — unequal lengths are silently truncated; `[]` allowed (`ChatBotActions.java:244-249`) |

Matching rules that matter:

- `Matcher.find()` — calls match **anywhere** in the text (mid-line, inside code fences); the prompt's "own line, no
  markdown" rule is advisory only.
- Block name may be double-, single-, back-quoted or bare. Namespace/path allow only letters, digits, `_` (and `/` in the
  path); no `-`, `.`, `#tags`, or `{nbt}`. Blockstate `[...]` is optional, any chars except `]`.
- **Execution order is by kind, not by text order**: all `PlaceBlock` matches, then all `PlaceLine`, then all
  `PlaceBlocks` (`ChatBotFunctions.java:607-613`). A later kind overwrites an earlier one at the same cell.
- The return value counts **calls**, incremented after the place call returns even if the block id failed to parse or
  no pivot existed; only an exception (e.g. `Integer.parseInt` overflow) skips the count.
- `stripTextualFunctionCalls` (`ChatBotFunctions.java:578-586`) removes matches (PlaceBlocks → PlaceLine → PlaceBlock),
  strips trailing spaces before line breaks, collapses 3+ line breaks to one blank line, trims. Unmatched call-like text is
  shown verbatim to the player.

### Coordinates and block ids

- Coordinates are **always relative** to a pivot: `pivot.add(x, y, z)`. Axes: X east+, Y up+, Z south+. Direct mode →
  `/construction` pivot of the caller; sub-agent → its `subPivot`.
- Block parsing (`ChatBotActions.java:292-314`): `BlockArgumentParser.block(registryWrapper(BLOCK), blockType, allowNbt=false)`.
  On `CommandSyntaxException`, if the string contains `[`, it retries with the base id (orientation lost, warn logged);
  else returns null → nothing placed (warn `Failed to parse block ...`).
- Write: `player.getWorld().setBlockState(pos, state)` (default flags) in `changeBlockAtPos` (`ChatBotActions.java:285-290`).
  No bounds/protection/size check — "keep within ~32 blocks" is prompt guidance only. Any existing block (including
  containers) is overwritten; no undo.

### Thread of placement

Placements run **on the LLM worker thread** that completed the request: `buildBot`'s `thenAccept` callback
(`ChatBot.java:523`) and `BuildSubAgent`'s `whenComplete` (`BuildSubAgent.java:108`). They do **not** go through
`GodActionQueue`. Only `/block` places on the main thread.

## `build_prompt.txt` contents (summary)

Two copies are tracked and **differ**; the one used is whichever sits in the JVM cwd (`run/` for `./gradlew runServer`,
the production server dir otherwise — not in the repo).

| Section | Content |
|---|---|
| Persona | "You are Dieu, the master builder of Minecraft." Build directly or plan with `BuildPlan`. |
| Two ways to build | `BuildPlan` for multi-structure requests (each SubBuild self-contained; refinement passes automatic); textual calls for one structure. Never mix both in one reply. |
| Anchors | Root copy: "at least 8 blocks apart". `run/` copy adds a sizing procedure: put X/Z/Y footprint in `size` and description; min centre distance per axis = `(sizeA + sizeB)/2 + 8` (worked example 20-wide + 14-wide → 25). |
| Loop | Each reply scanned; ≥1 call → continuation; zero calls = "I'm done". |
| Call format | The three grammars; one call per line; no markdown; namespaced double-quoted ids; equal-length arrays. |
| Coordinates | Relative to the pivot (the block looked at during `/construction`); X east, Y up, Z south. |
| Picking calls | PlaceBlock for accents, PlaceLine for pillars/edges (inclusive, integer interpolation), PlaceBlocks for surfaces with openings. |
| Block naming / blockstates | Vanilla ids; suffix `[k=v,...]` examples for logs, stairs, slabs, doors, fences, lanterns; bad suffix falls back to base block. `run/` copy adds a stair-`facing` explanation. |
| Strategy & pacing | Palette of 2-4 blocks; floor → walls → roof → details; ≤ ~32 blocks from pivot; suggested 5-turn pacing. |
| Ending | One short French sentence, no call lines. |

`run/max_build_prompt.txt` (an older textual-only prompt: "There is no tool / function-call channel") is **not loaded by
any code**.

## How to extend the grammar (recipe)

1. `ChatBotFunctions.java`: add a `Pattern` built from `INT`/`WS`/`BLOCK_NAME`/`INT_ARRAY`; make sure its literal name
   cannot prefix-match an existing one (e.g. `PlaceBlock` vs `PlaceBlocks` is safe only because `\(` must follow).
2. Add a `scanX(text, player, pivot)` mirroring `scanPlaceLine` (count, try/catch per match, `pivot == null` →
   `Raycaster` pivot wrapper) and add it to `scanAndExecute`.
3. Add it to `stripTextualFunctionCalls` (longest names first).
4. `ChatBotActions.java`: add `xAt(player, pivot, ...)` using `changeBlockAtPos` (and a pivot-less wrapper if direct mode
   should support it). Route the world write through `placeOnMain(player, pending, …)` like the existing three
   (bug #7), and check its size against `BuildGuard.withinCallCap`.
5. Teach the model: `build_prompt.txt` in the **runtime cwd** (and both tracked copies), the `ListTools` text-placement
   hint (`ChatBotFunctions.java:177-182`), the continuation strings (`ChatBot.java:373-375`, `BuildSubAgent.java:144-146`),
   and `DEFAULT_REFINEMENTS` / the BuildPlan addendum if they name the calls.

## Gotchas & known issues

- ~~**Off-thread world writes.**~~ **Fixed (bug #7):** `scanAndExecute` submits each matched call as one
  `GodActionQueue` task (≤ 8 per tick) and waits up to 30 s for them before returning the count; on the server thread
  it runs inline. Only an in-game check proves the thread hop; the caps are unit-tested.
- ~~**`/build` screenshot is never sent to the model**; `/build` takes one word~~ **Fixed (bug #9):** `buildBot.hasImage
  = true`; the argument is `greedyString()`.
- **Non-ops cannot really build**: `/build` is a client command open to all, but the pivot comes from the same player's
  `/construction` (perm 2). Without a pivot, direct-mode calls silently place nothing yet still count as executed, so the
  loop keeps going until the model stops or the 100-depth cap hits.
- **Silent `/construction` miss**: an entity on the ray (anywhere along 100 blocks) or open sky stores `null`; no feedback
  is given until `BuildPlan` complains.
- **Order by kind**: a `PlaceBlock` window followed in the text by a `PlaceBlocks` wall covering the same cell ends up as
  wall.
- **Counts are calls, not blocks**: messages saying `blocs placés` report call-line counts.
- ~~**Unbounded fan-out**; no cancel/kill switch~~ **Fixed (bug #7):** 4 parallel sub-agents server-wide, and
  `BuildGuard.cancelAll()` on `/godbody off` / server stop. Each agent can still make up to 60 provider calls.
- **Prompt drift**: `build_prompt.txt` (root) ≠ `run/build_prompt.txt`; production uses neither tracked file directly.
  The sub-agent system prompt reuses the planner prompt, which still describes the `BuildPlan` tool that sub-agents do not
  have.
- `Raycaster.lastPos` is a plain `HashMap` read cross-thread and lost on restart.

## Related

- [overview.md](overview.md)
- [llm-pipeline.md](llm-pipeline.md)
- [tools-catalogue.md](tools-catalogue.md)
- [images-and-client.md](images-and-client.md)
- [configuration-and-commands.md](configuration-and-commands.md)
- [god-body.md](god-body.md)
- [../reference/commands.md](../reference/commands.md)
