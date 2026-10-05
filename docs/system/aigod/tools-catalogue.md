---
id: aigod.tools-catalogue
title: AI God — tools catalogue (ChatBotFunctions + QueryTerrain)
system: aigod
summary: Every Java tool the AI God can call - exact name, description, parameters, execution thread, behaviour, return strings, gating - plus JsonSchemaAdapter mapping and name-based dispatch.
tags: [aigod, tools, function-calling, toolspecification, jsonschema, reward, trade, punishment, appear, vanish, wait, spawncreature, queryterrain, buildplan, listtools, dispatch]
sources: [src/main/java/com/paul/brawl/ChatBotFunctions.java, src/main/java/com/paul/brawl/QueryTerrain.java, src/main/java/com/paul/brawl/JsonSchemaAdapter.java, src/main/java/com/paul/brawl/OptionalField.java, src/main/java/com/paul/brawl/ChatBotActions.java, src/main/java/com/paul/brawl/ChatBot.java, src/main/java/com/paul/brawl/BridgeConfig.java, src/main/java/com/paul/brawl/MCPGateway.java, src/main/java/com/paul/brawl/GodSessionManager.java]
verified_at: 4a8081f
---

# AI God — tools catalogue

**TL;DR.** Tools are Jackson-annotated POJOs in `ChatBotFunctions.java` (+ `QueryTerrain.java`). The tool *name* is the
class simple name; the description comes from `@JsonClassDescription`; every `@JsonPropertyDescription` field is a
required parameter unless marked `@OptionalField`. Dispatch is a `switch` on the name in `executeFunction`; unknown
names fall through to `MCPGateway`, else an error string. Tool execution never throws — every path returns a string.

## Attachment matrix (`buildToolSpecs`, `ChatBotFunctions.java:313-340`)

| Tool | Group flag | godBot | buildBot | Executes on |
|---|---|---|---|---|
| `Reward` | `needsGodTools` | yes | no | main thread (`runOnMain`) |
| `Trade` | `needsGodTools` | yes | no | main thread |
| `Punishment` | `needsGodTools` | yes | no | main thread |
| `ChangeWeather` | `needsGodTools` | yes | no | main thread |
| `SpawnCreature` | `needsGodTools` | yes | no | main thread |
| `Appear` | `needsGodTools` | yes | no | worker (queues its own main-thread `buffAvatar`) |
| `Vanish` | `needsGodTools` | yes | no | worker (queues its own `restoreAvatar`) |
| `Wait` | `needsGodTools` | yes | no | worker (pure token) |
| `QueryTerrain` | `needsGodTools` | yes | no | main thread |
| `BuildPlan` | `needsBuildPlan` | **no** | yes | worker |
| MCP tools (kebab-case) | `needsMcpTools` | yes | no | worker → MCP HTTP |
| `ListTools` | added if list non-empty | yes | yes | worker |

## Schema generation (`JsonSchemaAdapter`, `JsonSchemaAdapter.java`)

- `toolSpec(cls)` (`:39-51`): `name = cls.getSimpleName()`, `description = @JsonClassDescription.value()` (or the simple
  name), `parameters = buildObjectSchema(cls)`.
- `buildObjectSchema(cls)` (`:53-75`): sets the object's description to the class description too (so the top-level
  parameters object repeats the tool description); iterates `getDeclaredFields()`, skipping `static` fields and fields
  without `@JsonPropertyDescription`; property name = Java field name; adds to `required` unless the field has
  `@OptionalField` (`OptionalField.java` — runtime-retained, field-targeted marker). `required` is only set if non-empty.
- `schemaFor(type, description)` (`:77-112`):

| Java type | JSON schema |
|---|---|
| `String` | `JsonStringSchema` |
| `int/Integer/long/Long/short/Short` | `JsonIntegerSchema` |
| `double/Double/float/Float` | `JsonNumberSchema` |
| `boolean/Boolean` | `JsonBooleanSchema` |
| other class (POJO) | recursive `buildObjectSchema` (property description dropped; class description used) |
| `List<T>` | `JsonArraySchema` with property description and `items = schemaFor(T, "")` |
| anything else | `JsonStringSchema` fallback |

Field declaration order from reflection determines property order (JVM-dependent but stable in practice).

## Argument parsing and dispatch

- `parseArgs(req, cls)` (`ChatBotFunctions.java:526-534`): null/blank arguments → `"{}"`; Jackson `MAPPER` with
  `FAIL_ON_UNKNOWN_PROPERTIES=false` (`:35-36`). Missing primitive `int` fields default to `0`; missing wrappers to
  `null`. Parse failure throws `RuntimeException("Failed to parse args for <name>: <args>")`.
- `executeFunction(req, player, chatBot)` (`:412-471`) — `switch (name)`:
  - `Reward/Trade/Punishment/ChangeWeather/SpawnCreature/QueryTerrain` → `runOnMain(() -> parseArgs(...).execute(player))`
    (parse errors inside `runOnMain` surface as `"Erreur côté serveur lors de l'exécution de cette action."`).
  - `Appear/Vanish/Wait/BuildPlan` → direct `parseArgs(...).execute(player)`.
  - `ListTools` → `new ListTools().execute(chatBot)` (no args parsed).
  - default → `MCPGateway.INSTANCE.handlesTool(name)` ? `MCPGateway.INSTANCE.execute(req)` : error string
    `Unknown tool '<name>'. Pick from the tool specs attached to this request; do not invent names. If you are unsure what you have, call `ListTools` (no arguments) to enumerate the exact set attached to this turn.`
  - Any thrown exception → `"Erreur lors de l'exécution de '<name>': <message or exception class>"`.
- MCP names are kebab-case and cannot collide with the PascalCase Java names (`:444-446`).
- Results are returned to the model as `ToolExecutionResultMessage.from(call, result)` in the same order as the calls
  (`ChatBot.java:306-308`).

### Post-dispatch gestures (`fireGestures`, `:506-524`)

Only if `GodSessionManager.hasManifested()` (global flag — no ownership check):

| Tool | Bridge calls |
|---|---|
| `Punishment` | `GodBody.lookAt(player)` + `GodBody.gesture("swing")` |
| `Reward` | `gesture("nod")` |
| `ChangeWeather` | `lookAt(player)` + `gesture("summon")` |
| `SpawnCreature` | `gesture("summon")` |
| `Trade` | `gesture("nod")` |
| others | nothing |

---

## Reward

`ChatBotFunctions.java:38-48`

| | |
|---|---|
| Description | `Gives a reward to the player in the form of an item.` |
| Gating | godBot; no ownership check (bodiless prayers can be rewarded) |
| Calls | `ChatBotActions.giveItemFromString(player, itemName, amount)` on main thread |

| Param | Type | Req | Description |
|---|---|---|---|
| `itemName` | string | yes | `The name of the item to give. Examples: minecraft:diamond, minecraft:enchanted_book[minecraft:enchantments={mending: 1, sharpness: 4, unbreaking: 3}]` |
| `amount` | integer | yes | `The number of items to give (clamped server-side, default max 64).` |

Returns `"You gave the player a reward: <n> <itemName>[ (limité à …)]"`, or a `Reward cancelled, …` refusal. `amount` is
clamped to `1..BridgeConfig.rewardMax`; the item string is parsed like `/give`, so the component syntax works (bug #6) —
see [actions-and-trades.md](actions-and-trades.md#item-parsing).

## Trade

`ChatBotFunctions.java:50-65`

| | |
|---|---|
| Description | `Offers a trade to the player.` |
| Calls | `TradeOffers.checkAmounts` (both amounts must be 1–512), then `ChatBotActions.sendTradeOffer(...)` on main thread → `TradeOffers.updateOffer` |

| Param | Type | Req | Description |
|---|---|---|---|
| `giveItemName` | string | yes | `The name of the item to give to the player in the trade. Example: minecraft:diamond` |
| `giveAmount` | integer | yes | `The number of items to give to the player in the trade (1-512).` |
| `takeItemName` | string | yes | `The name of the item to take from the player in the trade. Example: minecraft:diamond` |
| `takeAmount` | integer | yes | `The number of items to take from the player in the trade (1-512).` |

Returns on success `"God offered a trade to the player: God gives <ga> <give> for <ta> <take>\nThe player may accept or decline this trade."`
and messages the player `God has offered you a trade: \n You receive … \n Type /accept within 5 minutes.`. On an
amount outside 1–512: `"Trade cancelled. giveAmount and takeAmount must both be between 1 and 512 (got <ga> and <ta>). Please try again."`
(no offer stored). On a bad item: `"Trade cancelled. <name> was not a correct item. Please try again."`. Player accepts with
`/accept` within 5 minutes; see [actions-and-trades.md](actions-and-trades.md).

## Punishment

`ChatBotFunctions.java:67-75`

| | |
|---|---|
| Description | `Punishes the player by inflicting a number of punishments.` |
| Calls | `ChatBotActions.smite(player, amount)` — `amount` lightning bolts at the player's block pos, same tick |

| Param | Type | Req | Description |
|---|---|---|---|
| `amount` | integer | yes | `The number of punishments (lightning strikes) to inflict to the player (clamped server-side, default max 3).` |

Returns `"God punished the player <n> times.[ (limité à <n> sur <asked> demandés)]"`. `amount` is clamped to
`0..BridgeConfig.punishmentMax` (bug #6).

## ChangeWeather

`ChatBotFunctions.java:77-87`

| | |
|---|---|
| Description | `Changes the weather of the player's world.` |
| Calls | `ChatBotActions.changeWeather` → runs `/weather <weatherType.toLowerCase()> <durationSeconds>` as the server command source |

| Param | Type | Req | Description |
|---|---|---|---|
| `weatherType` | string | yes | `Type of weather to set. Examples: clear, rain, thunder` |
| `durationSeconds` | integer | yes | `Weather duration in seconds. 0 for permanent.` |

Returns `"La météo a été changée en <type> pour <n> secondes."` or `… pour une durée indéterminée.` (when ≤ 0) — always
reports success; the command result is not checked. Unit/zero caveats: [actions-and-trades.md](actions-and-trades.md#changeweather).

## SpawnCreature

`ChatBotFunctions.java:187-203`

| | |
|---|---|
| Description | `Spawns one or more creatures near the player. Use sparingly. Counts above the admin-configured cap are clamped silently.` |
| Calls | `ChatBotActions.spawnCreature(player, entityType, count, x, y, z)` |

| Param | Type | Req | Description |
|---|---|---|---|
| `entityType` | string | yes | `Entity id, e.g. minecraft:zombie, minecraft:cow, minecraft:wolf` |
| `count` | integer | yes | `How many to spawn (clamped server-side).` |
| `x` | integer | yes | `Block offset from the player on the X axis (east+/west-), clamped server-side (default ±16).` |
| `y` | integer | yes | `Block offset from the player on the Y axis (up+/down-).` |
| `z` | integer | yes | `Block offset from the player on the Z axis (south+/north-).` |

`count` clamped to `1..BridgeConfig.spawnCountMax` (default 8); each offset to `±BridgeConfig.spawnOffsetMax` (16, bug #6). Returns
`"God a fait apparaître <n> <entityType>[s] près du joueur[ (griefing désactivé)]."` or a `Spawn annulé : …` /
`Impossible de spawner : …` error.

## Appear

`ChatBotFunctions.java:89-120`

| | |
|---|---|
| Description | `Manifest God's physical body in front of the praying player. Call this when you choose to appear before acting or speaking. Use sparingly — appearing is dramatic. Optional fields default to 3 blocks ahead at ground level, facing the player.` |
| Gating | `GodSessionManager.isActive(player)` at execute time; otherwise returns `"Le corps de Dieu est occupé avec un autre fidèle — cette rencontre reste sans forme."` |

| Param | Type | Req | Description |
|---|---|---|---|
| `distance` | number | optional | `Blocks in front of the player to appear (default 3). Clamped server-side (typically 1..6).` |
| `height` | number | optional | `Vertical offset above the player's feet (default 0 = same level; positive to float).` |
| `lookAtPlayer` | boolean | optional | `Whether to turn and face the player after appearing (default true).` |

Behaviour: defaults `d=3.0`, `h=0.0`, `face=true`; clamps `d` to `[appearMinDistance=1.0, appearMaxDistance=6.0]`,
`h` to `[appearMinHeight=0.0, appearMaxHeight=4.0]` (`BridgeConfig.java:44-47`); `GodBody.appear(player,d,h,face)`
(bridge, async); `GodActionQueue.submit(buffAvatar)`; `markManifested()`; `resetIdleTimer(player)`. Returns
`"God a pris forme physique devant le joueur."` (even if the bridge call later fails). Geometry: [god-body.md](god-body.md).

## Vanish

`ChatBotFunctions.java:122-137` — no parameters.

| | |
|---|---|
| Description | `Send God's physical body away. Call this to disappear deliberately when the encounter is over. Optional — if you stop calling tools the body vanishes automatically.` |
| Gating | `isActive(player)`; else `"Tu ne tiens pas le corps de Dieu — rien à faire disparaître."` |

Behaviour: queue `restoreAvatar`, `GodBody.vanish()`, `GodSessionManager.clearManifested()` — the **session stays
open** (lock held) until the loop ends. Returns `"God a disparu."`.

## Wait

`ChatBotFunctions.java:139-149`

| | |
|---|---|
| Description | `Pause before you act again. You will only be called back after the given number of seconds — use this to linger, build suspense, or let an effect land before reacting. Clamped server-side (typically 1..30).` |

| Param | Type | Req | Description |
|---|---|---|---|
| `seconds` | integer | yes | `Seconds to wait before continuing.` |

`execute` only formats `"Le temps passe… <clamped> seconde(s) se sont écoulées."` with clamp
`[waitMinSeconds, waitMaxSeconds]` (default 1..30). The actual delay is applied by `checkForFunctions`: the whole
batch's results are deferred by the **max** Wait in the batch via `ChatBot.deferFunctionOutputs`; non-Wait tools in
the same batch already ran. A new user message during the wait flushes the results without calling the LLM.

## QueryTerrain

`QueryTerrain.java:43-231`

| | |
|---|---|
| Description | `Returns a compact ASCII relief map of the terrain centered on a position. Call this before planning builds, picking creature spawn spots, choosing where to appear, or describing the landscape — it is much cheaper than walking the world block-by-block. Output is a 16x16 grid using the characters ' .:-=+*#%@' to show elevation from low to high relative to the visible Y range, with '~' marking water columns, plus a header naming the center column's biome, Y range, and dominant slope direction. The center is clamped to within 128 blocks of the player; columns in unloaded chunks render as '?' rather than forcing the server to load them.` |

| Param | Type | Req | Description |
|---|---|---|---|
| `centerX` | integer | optional | `Absolute world X to center the snapshot on. Omit to center on the praying player.` |
| `centerZ` | integer | optional | `Absolute world Z to center the snapshot on. Omit to center on the praying player.` |
| `radius` | integer | optional | `Half-width of the sampled area in blocks. Clamped 8..64, default 32. Larger radius covers more area at coarser resolution; the output grid is always 16x16 cells.` |

Algorithm (`:80-211`): constants `GRID=16`, `SHADE=" .:-=+*#%@"`, `DEFAULT_RADIUS=32`, `MIN_RADIUS=8`,
`MAX_RADIUS=64`, `MAX_CENTER_OFFSET=128`. Center clamped to ±128 of the player; `step = max(1, 2r/16)`; cell
`(gx,gz)` samples world `(cx - r + gx·step, cz - r + gz·step)`; unloaded chunks → `?` (never loaded); surface Y =
`getTopY(MOTION_BLOCKING_NO_LEAVES) - 1`; fluid at surface → `~`; else shade index
`round((y - minY)/max(1,maxY-minY) · 9)`. Slope = gradient of mean E-vs-W column and S-vs-N row heights;
`< 1.5` → `flat (Δx.x across area)`, else `rising toward <E|SE|S|SW|W|NW|N|NE> (Δx.x)`. Biome from
`world.getBiome(cx, playerY, cz)`. Output: header line, `Biome=… Y range a..b (Δn) playerY=… slope=…`, legend line,
16 rows of `c ` cells (top row = north). All-unloaded → `QueryTerrain: la zone autour de (cx,cz) n'est pas chargée — recentre plus près du joueur.`
The map goes to the model only (bug #18 removed the TEMP line-by-line echo into the praying player's chat).

## BuildPlan (buildBot only)

`ChatBotFunctions.java:205-297` — dispatches parallel `BuildSubAgent`s; full semantics in [building.md](building.md).

| | |
|---|---|
| Description | `Plans a multi-structure build by dispatching N independent sub-builds in parallel, each at its own anchor offset relative to the admin's /construction pivot. …` (full text at `:223`) |

| Param | Type | Req | Description |
|---|---|---|---|
| `builds` | array of `SubBuild` | yes | `The list of independent sub-builds. Each becomes a separate isolated sub-agent. Order does not matter — they all run in parallel.` |

`SubBuild` object (all required; description `One isolated build job inside a BuildPlan. …`, `:205`):
`anchorX`, `anchorY`, `anchorZ` (integer offsets from the `/construction` pivot), `description`, `style`, `size`,
`purpose` (strings). Error returns: `Aucun point de référence : l'admin doit lancer /construction avant d'utiliser BuildPlan.`,
`BuildPlan reçu sans aucun sous-build — rien à faire.`, `Erreur interne : buildBot non initialisé. …`,
`BuildPlan ne contenait que des sous-builds nuls — rien à faire.`; success
`Plan accepté : <n> sous-construction(s) lancée(s) en parallèle. Chaque sous-agent fera ~6 passes (initiale + refinements).`
(`1 + DEFAULT_REFINEMENTS.size()` = 1 + 5).

## ListTools

`ChatBotFunctions.java:151-185` — no parameters.

| | |
|---|---|
| Description | `Lists every tool currently attached to your conversation — name plus one-line purpose. Call this with no arguments when you are unsure what you can call. Returns exactly the set the model received in this request's tool specs, so the answer never lies; there are no hidden tools. Costs one round trip — do not call it before every action, only when you actually need to refresh.` |

Rebuilds `buildToolSpecs(bot.needsGodTools, bot.needsBuildPlan, bot.needsMcpTools)` and returns
`Tools attached to this request (N):\n- Name: one-line description…` (descriptions collapsed to one line, cut at 217
chars + `...` when > 220). For bots with `needsBuildTools` it appends the textual `PlaceBlock(x, y, z, "minecraft:foo")`,
`PlaceLine(x1, y1, z1, x2, y2, z2, "minecraft:foo")`, `PlaceBlocks([x...], [y...], [z...], "minecraft:foo")` reminder.
With `chatBot == null` every flag is false and it lists nothing. Note: for godBot it may trigger an MCP connect
attempt (via `MCPGateway.tools()`).

## Textual placement calls (not tools)

Build bots emit `PlaceBlock`, `PlaceLine`, `PlaceBlocks` as plain text; regexes at `ChatBotFunctions.java:538-567`
accept ints (incl. negative), whitespace, and block ids quoted with `"`, `'`, backticks, or bare
(`[A-Za-z][A-Za-z0-9_]*:[A-Za-z][A-Za-z0-9_/]*` + optional `[...]` state). See [building.md](building.md).

## MCP tools

Appended verbatim from `MCPGateway.INSTANCE.tools()` (cached `listTools()` result). Dispatched by
`MCPGateway.execute(req)` → `client.executeTool(req)`, returning the server's text or an error string such as
`MCP gateway not connected — tool '<name>' could not be dispatched. Will auto-retry; admin can force with `/mcp reload`.`
(`MCPGateway.java:110-128`). The tool set itself lives in the Node `minecraft-mcp-server` (not in this checkout).
See [mcp-gateway.md](mcp-gateway.md).

## How to add a Java tool

1. Add a `static class Foo` in `ChatBotFunctions` with `@JsonClassDescription`, `@JsonPropertyDescription` fields
   (`@OptionalField` for optional ones), and `public String execute(ServerPlayerEntity player)` that never throws.
2. Register it in `buildToolSpecs` under the right flag.
3. Add a `case "Foo" ->` arm in `executeFunction` — wrap in `runOnMain` if it touches world/entity state.
4. Optionally add a gesture in `fireGestures` and mention it in `prompt.txt`.
`ListTools` picks it up automatically.

## Gotchas & known issues

- ~~`Punishment.amount` / `Reward.amount` / `SpawnCreature` offsets unclamped; `Reward`'s component example always
  fails~~ **Fixed (bug #6):** `GodClamps` + `BridgeConfig.rewardMax/punishmentMax/spawnOffsetMax`, `/give`-style parsing.
  The clamps are unit-tested; the in-world effect needs an in-game check. Only the `x` param description names the
  offset clamp.
- `ChangeWeather` always claims success.
- ~~`QueryTerrain` spams the player's chat with the grid (TEMP debug).~~ Fixed (bug #18).
- Gestures fire based on the global manifested flag, not the caller's ownership.
- `CLAUDE.md` lists `BuildPlan` among the God's tools; it is only attached to `buildBot`.

## Related

- [llm-pipeline.md](llm-pipeline.md) · [actions-and-trades.md](actions-and-trades.md) · [god-body.md](god-body.md)
- [building.md](building.md) · [mcp-gateway.md](mcp-gateway.md) · [overview.md](overview.md)
