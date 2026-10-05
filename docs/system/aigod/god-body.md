---
id: aigod.god-body
title: AI God — Physical Body (GodBody, bridge client, session lock, action queue, avatar safety)
system: aigod
summary: How the Java God drives its Mineflayer avatar - appear math, bridge HTTP contract, BridgeConfig keys, busy lock + idle watchdog, main-thread queue, invulnerability, op-on-join, termination.
tags: [aigod, godbody, bridge, http, mineflayer, avatar, llmbot, session, watchdog, godactionqueue, godscheduler, appear, vanish, wait, invulnerable, op]
sources:
  - src/main/java/com/paul/brawl/GodBody.java
  - src/main/java/com/paul/brawl/BotBridgeClient.java
  - src/main/java/com/paul/brawl/BridgeConfig.java
  - src/main/java/com/paul/brawl/GodActionQueue.java
  - src/main/java/com/paul/brawl/GodScheduler.java
  - src/main/java/com/paul/brawl/GodSessionManager.java
  - src/main/java/com/paul/brawl/ChatBot.java
  - src/main/java/com/paul/brawl/ChatBotFunctions.java
  - src/main/java/com/paul/brawl/ChatBotActions.java
  - src/main/java/com/paul/brawl/ChatCommand.java
  - src/main/java/com/paul/brawl/LLMCommand.java
  - src/main/java/com/paul/brawl/ServerEntryPoint.java
  - src/main/java/com/paul/brawl/ImageReceiver.java
  - src/main/java/com/paul/brawl/LLMConfig.java
  - GOD_BOT_INTEGRATION_PLAN.md
  - VERIFICATION.md
  - HIGHER_LEVEL_TOOLS.md
verified_at: 4a8081f
---

# AI God — Physical Body

**TL;DR.** The Java God has one shared avatar, a Mineflayer bot (default username `LLMBot`) driven over a localhost HTTP
**bridge** (`http://127.0.0.1:8765`). `GodBody` turns intents (appear in front of a player, speak, look, gesture,
vanish) into `BotBridgeClient` POSTs that are async and never throw. One player at a time owns the body
(`GodSessionManager` busy lock + idle watchdog). World-touching work hops to the server thread via `GodActionQueue`
(8 per tick); `Wait` deferrals run on `GodScheduler`. The avatar is made invulnerable on `Appear` and mortal again on most
exits; the bot is auto-op'd on join so it can `/tp`.

> ⚠ Unverified: the Node side of the bridge (`minecraft-mcp-server/`, an empty submodule gitlink in this checkout) is not
> available. Everything below about what a route *does* inside Mineflayer (e.g. `/appear` → `bot.chat("/tp …")`,
> `/chat` stripping a leading `/`, gesture names `jump`/`sneak`) comes from `GOD_BOT_INTEGRATION_PLAN.md` §4,
> `VERIFICATION.md` and `CLAUDE.md`, not from code. Only the Java client side is verified.

## Component map

| Class | File | Responsibility |
|---|---|---|
| `GodBody` | `src/main/java/com/paul/brawl/GodBody.java` | Semantic layer: computes positions from the player, calls the bridge |
| `BotBridgeClient` | `src/main/java/com/paul/brawl/BotBridgeClient.java` | Singleton `java.net.http.HttpClient` wrapper; best-effort async |
| `BridgeConfig` | `src/main/java/com/paul/brawl/BridgeConfig.java` | Bridge URL, bot username, clamps, watchdog; `bridge_config.properties` |
| `GodSessionManager` | `src/main/java/com/paul/brawl/GodSessionManager.java` | Single-owner lock, `manifested` flag, idle watchdog |
| `GodActionQueue` | `src/main/java/com/paul/brawl/GodActionQueue.java` | Off-thread → main-thread FIFO drained on `END_SERVER_TICK` |
| `GodScheduler` | `src/main/java/com/paul/brawl/GodScheduler.java` | Single daemon scheduled thread for `Wait` and the watchdog |
| Tools `Appear`/`Vanish`/`Wait` | `ChatBotFunctions.java:89-149` | Model-facing presence/pacing |
| Avatar helpers | `ChatBotActions.java:382-428` | `findAvatar`, `buffAvatar`, `restoreAvatar`, `dismissAvatarOnWatchdog` |
| Session teardown | `ChatBot.java:580-587` | `endPrayerSession` |
| Wiring | `ServerEntryPoint.java:35-74` | Queue/scheduler registration, lifecycle hooks, op-on-join |

## GodBody — exact math and calls

| Method | Bridge call | Details (`GodBody.java`) |
|---|---|---|
| `appear(player, distance, height, lookAtPlayer)` | `POST /appear` | `yaw = toRadians(player.getYaw())`; `dirX = -sin(yaw)`, `dirZ = cos(yaw)`; `x = player.getX() + dirX*distance`, `y = player.getY() + height`, `z = player.getZ() + dirZ*distance` (feet position, **yaw only** — pitch ignored, no ground snapping). `facing = player name` if `lookAtPlayer`, else omitted. Returns `false` future if `player == null`. (`:27-47`) |
| `say(line)` | `POST /chat` | No-op (`false`) for null/blank. (`:50-53`) |
| `lookAt(player)` | `POST /look` | Target `(player.getX(), player.getY() + 1.6, player.getZ())` (approx. eye height). (`:56-59`) |
| `gesture(type)` | `POST /gesture` | Pass-through string. (`:61-63`) |
| `vanish()` | `POST /vanish` | Sends the configured parking spot. "Safe to call when not currently appeared." (`:66-68`) |

Every method returns the bridge `CompletableFuture<Boolean>`; no caller in the codebase waits on it.

## BotBridgeClient — the HTTP contract as the Java client uses it

Client: `HttpClient.newBuilder().connectTimeout(2 s)` (`BotBridgeClient.java:29-31`); default HTTP version and executor.

**Active gate** (`BotBridgeClient.java:36-40`): `BridgeConfig.enabled && bridgeUrl != null && !bridgeUrl.isBlank()`.
When inactive every call returns an already-completed `false` (or `null` for `GET`) without network I/O.

URL = `BridgeConfig.bridgeUrl + path` (plain string concatenation — a trailing `/` in `bridgeUrl` yields `//route`).

| Route | Method | Body (exact JSON shape) | Caller(s) |
|---|---|---|---|
| `/health` | GET | — (no Content-Type) | `BotBridgeClient.health()` — **no caller anywhere in the mod** |
| `/appear` | POST | `{"x":<num>,"y":<num>,"z":<num>,"facing":"<playerName>"}`; `facing` key omitted when null/blank | `GodBody.appear` ← `Appear` tool |
| `/chat` | POST | `{"message":"<string>"}` (null → `""`) | `GodBody.say` ← `ChatBot.printOutputs` |
| `/look` | POST | `{"x":<num>,"y":<num>,"z":<num>}` | `GodBody.lookAt` ← gestures for `Punishment`, `ChangeWeather` |
| `/gesture` | POST | `{"type":"<string>"}` (null → `""`) | `fireGestures`: `"swing"`, `"nod"`, `"summon"` |
| `/vanish` | POST | `{"x":parkingX,"y":parkingY,"z":parkingZ}` | `Vanish` tool, `endPrayerSession`, `/godbody off`, watchdog |

Encoding details:

- Numbers via `String.valueOf(double)`; NaN/Infinity → `0` (`BotBridgeClient.java:128-131`). Large values may serialize
  as e.g. `1.0E7` (valid JSON).
- Strings via a hand-written escaper: `\\`, `\"`, `\b`, `\f`, `\n`, `\r`, `\t`, other `< 0x20` → `\u00XX`
  (`BotBridgeClient.java:134-157`).
- POST headers: `Content-Type: application/json`; body UTF-8; **request timeout 3 s** (`BotBridgeClient.java:85-90`).
  GET timeout also 3 s.

Result / error policy (`BotBridgeClient.java:82-126`):

| Outcome | POST result | Log |
|---|---|---|
| Request build fails (bad URI) | `false` | `warn "bridge {path} build failed: …"` |
| Network error / timeout | `false` | `warn "bridge {path} failed: …"` |
| HTTP status `>= 300` | `false` | `warn "bridge {path} returned {code}: {body}"` |
| HTTP 2xx | `true` (body ignored) | — |

No retries, no queueing, never throws into the prayer flow. A down bridge leaves God answering bodiless.

> ⚠ Unverified (Node side, per `GOD_BOT_INTEGRATION_PLAN.md` §4 / `VERIFICATION.md` §2): `/appear` runs
> `bot.chat("/tp <botName> <x> <y> <z> facing entity <facing>")`; `/vanish` teleports to the parking spot; `/chat` →
> `bot.chat` (CLAUDE.md says a leading `/` is stripped); `/look` → `bot.lookAt`; `/health` returns
> `{"ok":true,"detail":{"connected":…,"username":…,"position":…}}`; gesture vocabulary `swing`/`jump`/`sneak`/`nod`/`summon`
> (HIGHER_LEVEL_TOOLS.md §4). The plan documents `/vanish` with body `{}`; the Java client actually sends the parking
> coordinates.

## BridgeConfig — every field

File: `bridge_config.properties` in the JVM cwd (`BridgeConfig.java:25`). Loaded once in the singleton constructor;
**not created on first boot** (only `save()` writes it, i.e. after any `/llm bridge …` or `/godbody` change). `save()`
writes all keys (`p.store(out, "God-Body bridge configuration")`). Unparseable values fall back to the current value.
Logged at `SERVER_STARTED` as `BridgeConfig loaded: <describe()>` (`ServerEntryPoint.java:46-50`).

| Field = properties key | Type | Default | Used by | Settable in game |
|---|---|---|---|---|
| `bridgeUrl` | String | `http://127.0.0.1:8765` | all bridge calls | `/llm bridge url <url>` |
| `enabled` | bool | `true` | bridge active gate | `/llm bridge enabled <bool>`, `/godbody on|off` |
| `botUsername` | String | `LLMBot` | `findAvatar`, op-on-join | `/llm bridge bot <name>` |
| `parkingX` / `parkingY` / `parkingZ` | double | `0` / `-64` / `0` | `/vanish` body | file only |
| `appearMinDistance` / `appearMaxDistance` | double | `1.0` / `6.0` | `Appear.distance` clamp | file only |
| `appearMinHeight` / `appearMaxHeight` | double | `0.0` / `4.0` | `Appear.height` clamp | file only |
| `waitMinSeconds` / `waitMaxSeconds` | int | `1` / `30` | `Wait` clamp; watchdog floor | `/llm bridge waitmax <1..600>` (max only) |
| `spawnCountMax` | int | `8` | `SpawnCreature` count clamp | `/llm bridge spawnmax <1..64>` |
| `creatureGriefingAllowed` | bool | `false` | `SpawnCreature` (`setCanPickUpLoot(false)` when off) | `/llm bridge griefing <bool>` |
| `idleTimeoutSeconds` | int | `90` | idle watchdog | `/llm bridge idle <5..3600>` |

`describe()` format: `BridgeConfig{enabled=…, url=…, bot=…, appear=[min..max], h=[min..max], wait=[min..maxs], spawnMax=…, griefing=…, idle=…s}`.

## The presence tools (model-facing)

| Tool | Args (schema) | Behaviour | Result string |
|---|---|---|---|
| `Appear` | `distance` (number, optional, default 3), `height` (number, optional, default 0), `lookAtPlayer` (bool, optional, default true) | Gate: `GodSessionManager.isActive(player)`. Clamp `d` to `[appearMinDistance, appearMaxDistance]`, `h` to `[appearMinHeight, appearMaxHeight]` (`MathHelper.clamp`). Then `GodBody.appear` (async bridge) → `GodActionQueue.submit(buffAvatar)` (not awaited) → `markManifested()` → `resetIdleTimer(player)`. Runs on the LLM worker. | Not owner: `Le corps de Dieu est occupé avec un autre fidèle — cette rencontre reste sans forme.` Else: `God a pris forme physique devant le joueur.` (regardless of bridge success) |
| `Vanish` | none | Gate: `isActive`. `submit(restoreAvatar)` → `GodBody.vanish()` → `clearManifested()`. The session **continues** (lock kept). | Not owner: `Tu ne tiens pas le corps de Dieu — rien à faire disparaître.` Else `God a disparu.` |
| `Wait` | `seconds` (integer, required) | Clamp to `[waitMinSeconds, waitMaxSeconds]`. No ownership gate. | `Le temps passe… N seconde(s) se sont écoulées.` |

Code: `ChatBotFunctions.java:89-149`; dispatch without `runOnMain` at `ChatBotFunctions.java:430-432`.

**Wait mechanics** (`ChatBotFunctions.java:351-389`, `ChatBot.java:320-360`): all tool calls in the batch execute
immediately; if any is `Wait`, the **largest** clamped value is used and the tool results are submitted via
`chatBot.deferFunctionOutputs(results, player, seconds)` → `GodScheduler.schedule(...)`, then
`GodSessionManager.resetIdleTimer(player)`. If scheduling throws or returns null, outputs are sent immediately. A new
user message (`/pray`, `/prove`) during the wait cancels the scheduled task and flushes the withheld tool results into
memory without firing the continuation (`flushPendingDeferral`).

**Gestures** (`ChatBotFunctions.java:506-524`), fired after each tool batch only if `GodSessionManager.hasManifested()`:
`Punishment` → `lookAt(player)` + `gesture("swing")`; `Reward` → `"nod"`; `ChangeWeather` → `lookAt(player)` +
`"summon"`; `SpawnCreature` → `"summon"`; `Trade` → `"nod"`.

**Speech**: `ChatBot.printOutputs` (`ChatBot.java:621-633`) always sends `"Dieu : " + text` to the player, and also
`GodBody.say(text)` when `needsGodTools && isActive(player) && hasManifested()`.

## GodSessionManager — busy lock and idle watchdog

State (`GodSessionManager.java:30-36`): `AtomicReference<UUID> owner`, `volatile boolean manifested`,
`volatile ScheduledFuture<?> watchdog`. All global (one avatar).

| Method | Semantics |
|---|---|
| `claim(player)` (sync) | Fails (`false`) if another UUID owns it; otherwise sets owner (re-claim by same player OK) and `resetIdleTimer`. Called by `/pray` (`ChatCommand.java:97`) and by `/prove` (`ImageReceiver.java:33`, only for bots with `needsGodTools`). |
| `isActive(player)` | `player.getUuid().equals(owner)` |
| `isBusy()`, `currentOwner()` | owner != null / owner |
| `markManifested()` / `clearManifested()` / `hasManifested()` | Global flag set by `Appear`, cleared by `Vanish` and `forceEndSession` |
| `endSession(player)` (sync) | No-op if `player` is not the owner; else `forceEndSession()` |
| `forceEndSession()` (sync) | `owner = null`, `manifested = false`, cancel watchdog. Manages lock state only — no vanish/restore. |
| `resetIdleTimer(player)` (sync) | Ignored unless `player` is the owner. Cancels the old watchdog; schedules a new one after `max(idleTimeoutSeconds, waitMaxSeconds + 5)` seconds (`:123-124`). |

Watchdog fire (`GodSessionManager.java:125-134`): if owner still equals the pinned UUID →
`ChatBotActions.dismissAvatarOnWatchdog(pinned)` (queues `setInvulnerable(false)` on the bot found by `botUsername` + calls
`GodBody.vanish()` directly) → `forceEndSession()`. Any in-flight LLM response for that player is then dropped and its
memory wiped (`ChatBot.java:539-546`).

**What resets the watchdog**: `claim` (each `/pray` / `/prove` by the owner), `Appear`, and a batch containing `Wait`.
Ordinary tool calls and LLM turns do **not** reset it.

### The `idleTimeoutSeconds > waitMaxSeconds` invariant — enforced three ways

| Layer | Enforcement |
|---|---|
| Runtime | Watchdog delay is `max(idleTimeoutSeconds, waitMaxSeconds + 5)` — holds even if the file is hand-edited (`GodSessionManager.java:123-124`). |
| `/llm bridge waitmax N` | Sets `waitMaxSeconds = N`; if `idleTimeoutSeconds <= N` it becomes `N + 30` (`LLMCommand.java:146-155`). |
| `/llm bridge idle N` | Rejected with `idle timeout must exceed waitMax (Ns)` when `N <= waitMaxSeconds` (`LLMCommand.java:164-173`). |

## GodActionQueue — main-thread hop

| Item | Value |
|---|---|
| Queue | `ConcurrentLinkedQueue<QueuedAction(Supplier<String> body, CompletableFuture<String> result)>` (`GodActionQueue.java:33-35`) |
| `MAX_PER_TICK` | `8` (`GodActionQueue.java:31`) |
| Drain | `ServerTickEvents.END_SERVER_TICK`: poll up to 8, `complete(body.get())`; a throwing body logs `queued action threw on main thread` and `completeExceptionally` (`:69-82`). Leftovers roll to the next tick, FIFO. |
| `submit(body)` | Enqueue from any thread; returns the future. |
| `clear()` | Polls everything, `cancel(false)` each future, returns count. Used by `/godbody off` and `SERVER_STOPPING`. |
| Registration | `GodActionQueue.register()` from `ServerEntryPoint.java:35` |

**Waiting on it**: `ChatBotFunctions.runOnMain` uses `submit(body).get(5, SECONDS)` (not `.join()`); on timeout returns
`Erreur côté serveur: action différée non exécutée (serveur indisponible).`, on other failure
`Erreur côté serveur lors de l'exécution de cette action.` (`ChatBotFunctions.java:488-498`).
`ChatBot.collectDynamicContext` also hops with a 5 s bound and runs the body directly if already on the server thread
(`ChatBot.java:496-520`). **Deadlock rule:** never block on a queued future from the server thread — the drain runs on
that same thread at end of tick.

Avatar helpers queued but **not awaited**: `buffAvatar` (Appear), `restoreAvatar` (Vanish, `endPrayerSession`), the
watchdog's invuln clear.

## GodScheduler

`GodScheduler.java`: one `newSingleThreadScheduledExecutor` with daemon threads named `god-scheduler-N`. Started on
`SERVER_STARTED`, `shutdownNow()` on `SERVER_STOPPING`; `schedule(task, seconds)` lazily (re)starts it, wraps the task
so throws are logged (`scheduled task threw`). Used for `Wait` continuations and the idle watchdog. Tasks run on the
scheduler thread — anything touching the world must re-enter `GodActionQueue`.

## Avatar invulnerability and op-on-join

| Helper | Thread | Effect (`ChatBotActions.java`) |
|---|---|---|
| `findAvatar(prayingPlayer)` | any | `server.getPlayerManager().getPlayer(BridgeConfig.botUsername)` (server from the player, else the captured `SERVER`) (`:383-389`) |
| `buffAvatar` | main (queued) | `bot.setInvulnerable(true); bot.extinguish();` → `Avatar rendu invincible.` / `Avatar introuvable (pas de buff).` (`:396-405`) |
| `restoreAvatar` | main (queued) | `bot.setInvulnerable(false)` → `Avatar redevenu mortel.` / `Avatar introuvable.` (`:407-412`) |
| `dismissAvatarOnWatchdog(uuid)` | scheduler | queue invuln clear + `GodBody.vanish()` (`:418-428`) |

`setInvulnerable` sets the entity's `Invulnerable` flag (persisted in entity NBT).

**Op-on-join** (`ServerEntryPoint.java:61-74`): on `ServerPlayConnectionEvents.JOIN`, if the joining name equals
`BridgeConfig.botUsername`, `VillageConfig.edenAvatarName` (default `Dieu`), or is in
`VillagersCommand.activeScenarioBots`, and is not already an operator, `addToOperators(profile)` and log
`Opped bot '<name>' on join.` Op is permanent (written to the server ops list) and never revoked. Required because
appear/vanish are done by the bot issuing `/tp` (per the plan). Only meaningful on a dedicated server
(`DedicatedServerModInitializer`).

## Termination paths

| Path | Trigger | Restore invuln | Vanish | Lock released | Where |
|---|---|---|---|---|---|
| Natural terminal | God turn with no tool calls (and `isActive`) | if `hasManifested` | if `hasManifested` | yes | `ChatBot.java:565-567` → `endPrayerSession` |
| Deliberate `Vanish` | model tool | yes | yes | **no** (session continues, `manifested=false`) | `ChatBotFunctions.java:122-137` |
| Depth cap | `functionCallDepth > MAX_FUNCTION_CALL_DEPTH (100)` in `sendFunctionOutputs`; chat `Dieu : (chaîne d'appels coupée — relance ta requête.)`, memory wiped | if manifested | if manifested | yes (if owner) | `ChatBot.java:287-302` |
| LLM API error | exceptional future | if manifested | if manifested | yes (if owner) | `ChatBot.java:427-439` |
| `/pray stop` | owner, perm 0; chat `Dieu : (la séance est close.)` | if manifested | if manifested | yes | `ChatCommand.java:30-39` |
| Idle watchdog | no reset for `max(idle, waitMax+5)` s | yes (queued) | always | yes (force) | `GodSessionManager.java:125-134` |
| `/godbody off` | admin | **no** | always (sent before disabling) | yes (force) | `ChatCommand.java:62-73` |
| Server stopping | `SERVER_STOPPING` | **no** | **no** | yes (force) + queue cleared | `ServerEntryPoint.java:51-56` |

`endPrayerSession(player)` (`ChatBot.java:580-587`): `if hasManifested() { submit(restoreAvatar); GodBody.vanish(); }`
then `GodSessionManager.endSession(player)`. Idempotent.

After a session ends mid-flight, responses and deferred `Wait` continuations for conversations that started bound to the
session (`sessionBound`) are dropped and memory cleared (`ChatBot.java:278-285`, `ChatBot.java:539-546`); bodiless
conversations are answered normally.

## Commands

| Command | Perm | Effect | Code |
|---|---|---|---|
| `/godbody off` | 2 | `GodActionQueue.clear()`, `GodBody.vanish()`, `forceEndSession()`, `enabled=false` + save; feedback `Killed god-body: N queued action(s) dropped, session released, bridge disabled.` (broadcast to ops) | `ChatCommand.java:62-73` |
| `/godbody on` | 2 | `enabled=true` + save; `Bridge re-enabled.` | `ChatCommand.java:75-81` |
| `/godbody` (bare) | 2 | no executes → incomplete command | — |
| `/llm bridge` | 2 | print `describe()` | `LLMCommand.java:73-77` |
| `/llm bridge enabled <bool>` | 2 | set + save + print | `:78-82`, `:118-123` |
| `/llm bridge url <greedy string>` | 2 | set + save (not validated) | `:83-87` |
| `/llm bridge bot <word>` | 2 | set `botUsername` + save | `:88-92` |
| `/llm bridge griefing <bool>` | 2 | set + save | `:93-97` |
| `/llm bridge waitmax <1..600>` | 2 | set; bump idle to `N+30` if needed | `:98-102`, `:146-155` |
| `/llm bridge spawnmax <1..64>` | 2 | set + save | `:103-107` |
| `/llm bridge idle <5..3600>` | 2 | set if `> waitMax`, else error | `:108-112`, `:164-173` |
| `/pray stop` | 0 | owner ends own session | `ChatCommand.java:30-39` |

## Gotchas & known issues

- **`/godbody off` and server stop never clear invulnerability.** Neither path queues `restoreAvatar`; `/godbody off`
  even clears the queue (dropping a pending restore). The avatar can remain invulnerable (flag persists in NBT) until the
  next Appear→exit cycle. CLAUDE.md claims `/godbody off` calls `endPrayerSession` — it does not.
- **`/godbody off` does not disable MCP tools**: the God can still move the bot through `MCPGateway` tools (see
  [mcp-gateway.md](mcp-gateway.md)).
- **Watchdog is not reset per turn.** A long chain of non-`Wait` tool calls (e.g. slow MCP tools) lasting more than
  `idleTimeoutSeconds` (90 s) after the last `/pray`/`Appear`/`Wait` force-ends the session mid-chain; the next response is
  dropped and memory wiped. The class Javadoc's "per-turn hooks in ChatBot" do not exist.
- **Gestures ignore ownership**: `fireGestures` checks only the global `hasManifested()`, so a bodiless player's
  `Reward`/`Punishment` makes the owner's manifested avatar nod/swing and look at the bodiless player.
- **`Appear` reports success even when the bridge is disabled/down** (`God a pris forme physique…`).
- **`GET /health` is dead code** in the mod; nothing probes bridge liveness.
- **Bot name changes**: `/llm bridge bot` affects `findAvatar` and future op-on-join only; the Node `--username` must be
  changed separately (unverified Node side). Op-on-join trusts the name: on an offline-mode server anyone joining as
  `LLMBot` (or `Dieu`) is op'd.
- Watchdog race: the owner check and `forceEndSession()` are not atomic; a claim by another player between them could be
  released.
- `parking*`, `appear*` and `waitMinSeconds` have no command; edit `bridge_config.properties` (cwd) and restart.
- `GodBody.say` sends the whole reply text; Minecraft chat length limits / command-prefix stripping depend on the Node
  side (unverified).

## Related

- [overview.md](overview.md)
- [llm-pipeline.md](llm-pipeline.md)
- [tools-catalogue.md](tools-catalogue.md)
- [configuration-and-commands.md](configuration-and-commands.md)
- [mcp-gateway.md](mcp-gateway.md)
- [building.md](building.md)
- [../eden/java-integration.md](../eden/java-integration.md)
- [../reference/ports-files-config.md](../reference/ports-files-config.md)
