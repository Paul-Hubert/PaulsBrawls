---
id: eden.bots.hardening
title: Eden bot pool, plugins, signals, anchors, hardening and render layer
system: eden
summary: How Eden connects its 11 mineflayer bots (options, stagger, reconnect, vitals, death), which plugins load with what options, the signal adapter, anchors, every hardening guard, and the snapshot/RunReport renderers.
tags: [eden, bots, mineflayer, pool, plugins, pathfinder, auto-eat, reconnect, vitals, signals, anchors, hardening, abort, render, snapshot]
sources: [eden/src/bots/pool.ts, eden/src/bots/plugins.ts, eden/src/bots/signals.ts, eden/src/bots/anchors.ts, eden/src/bots/helpers.ts, eden/src/bots/hardening.ts, eden/src/render/tokens.ts, eden/src/render/run-report.ts, eden/src/render/snapshot.ts, eden/src/vendor-mineflayer.d.ts, eden/src/types/bot.ts, eden/src/types/skill.ts, eden/src/config.ts, eden/src/main.ts, eden/src/village-launch.ts, eden/src/villagers/reactivity.ts, eden/src/villagers/events.ts, eden/src/skills/engine.ts, eden/package.json, eden/tests/bots-pool.test.ts, eden/tests/bots-pool-coverage.test.ts, eden/tests/bots-hardening.test.ts, eden/tests/bots-hardening-coverage.test.ts, eden/tests/bots-helpers.test.ts, eden/tests/bots-anchors.test.ts, eden/tests/fakes/fake-bot.ts, docs/07-hard-won-lessons.md]
verified_at: 4a8081f
---

# Eden bot pool, plugins, signals, anchors, hardening and render layer

**TL;DR.** `BotPool` (`eden/src/bots/pool.ts`) owns every mineflayer connection: the villagers (mortal)
plus the avatar (divine, logged in last), staggered 4 s apart, pinned to `1.21.1`, `viewDistance:'short'`,
90 s keepalive, unlimited reconnects with 1→30 s backoff. On each spawn it bounds the pathfinder and loads
pvp / armor-manager / tool / collectblock / auto-eat (each independently fallible). `bots/hardening.ts` holds
the abort sequence and chat interceptor the engine uses. `render/` turns snapshots and `RunReport`s into
the deterministic text the critic and villagers read. Several layer-1 modules (anchors, helpers,
quiescence helpers) are tested but **not wired** into the running host.

## Files and runtime status

| File | Exports | Runtime caller | Status |
|---|---|---|---|
| `eden/src/bots/pool.ts` | `BotPool`, `stampWorldId`, `LOGIN_STAGGER_MS` | `main.ts:193-210`, `village-launch.ts` | wired (only when `spawnBots` and villagers > 0) |
| `eden/src/bots/plugins.ts` | `loadPlugins`, `AUTO_EAT_OPTS`, `pathfinder` | `pool.ts` | wired |
| `eden/src/bots/hardening.ts` | `boundPathfinder`, `abortActiveTasks`, `installChatInterceptor`, `craftQuiescence`, `waitForInventoryQuiescence` | pool (bound), engine (abort, interceptor) | quiescence helpers: tests only |
| `eden/src/bots/signals.ts` | `attachReactivitySignals` | `eden/src/villagers/reactivity.ts:63` | wired |
| `eden/src/bots/anchors.ts` | `AnchorService` | none | **not wired** (tests only) |
| `eden/src/bots/helpers.ts` | `goToHops`, `collectTrunk`, `useChest`, `deposit`, `withdraw`, `MAX_HOP_BLOCKS` | none | **not wired** — stock skills inline their own copies |
| `eden/src/render/*.ts` | `estimateTokens`, `renderSnapshot`, `renderRunReport` | `god/critic.ts`, `villagers/context-pack.ts` | wired |
| `eden/src/types/bot.ts` | narrowed `Bot` seam (D-14) | everything in bots/ + engine | — |
| `eden/src/vendor-mineflayer.d.ts` | ambient types for `mineflayer-pathfinder`, `mineflayer-armor-manager` | — | type-only |

Layer rules: bots/ and render/ are layer 1 — they import only `types/`, `journal/`, `config`, `logger`
and npm packages, never engines or actors.

## The `Bot` seam (D-14)

`eden/src/types/bot.ts:114-149` declares the narrowed interface both real mineflayer and the test
`FakeBot` (`eden/tests/fakes/fake-bot.ts`) satisfy: `username`, `entity {position} | null`, `game`,
`health`, `food`, `time.timeOfDay`, `inventory.items()`, `heldItem`, `currentWindow`, `_client` (packet
emitter), optional plugin objects `pathfinder` / `pvp` / `collectBlock` / `autoEat` / `armorManager`,
`registry` (`itemsByName`, `blocksByName`), and methods `chat`, `closeWindow`, `blockAt`, `openContainer`,
`dig`, `loadPlugin`, `quit`, plus `on/once/removeListener`. Skills receive the **real** bot object at
runtime (full mineflayer API), the seam only types Eden's own TS code. `pool.ts` casts
`mineflayer.createBot(...)` through `unknown` at one boundary (`pool.ts:88-100`).

## BotPool

### Construction (`BotPoolOptions`, `pool.ts:52-75`)

| Option | Meaning | Main wiring (`main.ts:193-210`) |
|---|---|---|
| `createBot?` | factory seam; default real `mineflayer.createBot` | default |
| `journal` | journal appender | shared journal |
| `host`, `port` | server | `config.minecraft.host/port` (defaults `127.0.0.1:25599`, `config.ts:86`) |
| `version?` | protocol pin; default `'1.21.1'` | `config.minecraft.version` (warns if ≠ 1.21.1, `config.ts:206-210`) |
| `villagers` | `{name, role}[]` | `config.villagers` |
| `avatarName` | the divine member | `config.god.name` (default `'Dieu'`) |
| `dataDir` | for `world.json` | `.eden-data` |
| `worldId` | R32 stamp | `` `${host}:${port}` `` |
| `vitalsIntervalMs` | vitals cadence | `journal.vitalsIntervalSeconds * 1000` (default 10 s) |
| `staggerMs?` | login stagger override | not set → 4000 |
| `currentRunOf?` | vitals `currentRun` source | **not set** → always `null` |
| `onBotSpawn?` | per-(re)spawn hook | reactivity `attach` + `VillageLauncher.onSpawn` |

Members: every villager as `{tier:'mortal', isAvatar:false}`, then the avatar `{role:'avatar',
tier:'divine', isAvatar:true}` **last** (`pool.ts:117-123`). The pool never ops anyone (R14);
`roster()` exposes tiers.

### Connection options (`SpawnRequest`, `pool.ts:28-38, 172-180`)

`mineflayer.createBot({ host, port, username: member.name, version, viewDistance: 'short',
checkTimeoutInterval: 90_000, plugins: { pathfinder } })` (`pool.ts:91-99`).

| Setting | Value | Why |
|---|---|---|
| `version` | `'1.21.1'` unless config overrides | R11 protocol pin |
| `viewDistance` | `'short'` | R8 — `'tiny'` makes 32-block searches scan unloaded chunks |
| `checkTimeoutInterval` | `90_000` ms | R13 keepalive rope |
| `plugins` | `{ pathfinder }` | the only pre-spawn plugin |
| `auth` / `password` | not passed | mineflayer default (offline-mode username) |

### Lifecycle

| Phase | Behaviour | Code |
|---|---|---|
| `start()` | reset `stopping=false`; `stampWorldId`; on mismatch `logger.warn('bots', 'world id changed A → B — persisted memories may be from a dead world (R32)…')`; `spawnAll()`; `startVitals()` | `pool.ts:146-161` |
| `spawnAll()` | `connect()` each member in order, `await delay(4000)` **between** connects (does not wait for spawn) | `pool.ts:164-169` |
| `connect()` | create bot, record `state:'connecting'`, attach `once('spawn')`, `on('end')`, `on('kicked')`, `_client.on('death_combat_event')` — all closed over **this bot instance** (R66) | `pool.ts:172-197` |
| spawn | identity guard; `state:'connected'`; reset backoff; `boundPathfinder(bot)`; `loadPlugins(bot)`; journal `system.bot-connected {name}` (actor `bot:<name>`); `logger.info`; `onBotSpawn(name, bot)` (throws are caught and warned) | `pool.ts:199-215` |
| end / kicked | identity guard (a superseded instance's events are ignored); `state:'disconnected'`, `bot=null`; journal `system.bot-disconnected {name, reason}`; reconnect unless stopping | `pool.ts:217-227` |
| death | journal `world.death {name, cause?}` from the packet's `message` (string, or JSON of an object) — R27 authoritative cause | `pool.ts:229-238, 333-339` |
| reconnect | backoff `[1000, 2000, 5000, 10000, 30000]` ms indexed by attempts (clamped to 30 s), **no attempt limit**, timer `unref`'d, reset to 0 on spawn | `pool.ts:25, 241-251` |
| vitals | every `vitalsIntervalMs`, for each **connected** bot journal `vitals {name, health (?? 0), food (?? 0), position [rounded x,y,z] or [0,0,0], held (heldItem.name ?? null), currentRun}` | `pool.ts:254-274` |
| `stop()` | `stopping=true`; clear vitals; cancel reconnect timers; `bot.quit('pool shutdown')` (best-effort); all records disconnected | `pool.ts:277-293` |

Reason formatting (`formatEndReason`/`reasonText`, `pool.ts:302-330`): `end` → text or `'end'`; `kicked` →
`'kicked: <text>'`. Text extraction handles strings, JSON strings, and chat components (`text`, `value`,
`translate`, else `JSON.stringify`) so 1.21 kick objects never render as `[object Object]`.

Accessors: `bot(name)`, `avatar()`, `connectedCount()`, `roster()`.

### World stamp (R32)

`stampWorldId(dataDir, worldId)` (`pool.ts:353-363`) writes `<dataDir>/world.json` =
`{"worldId": "<host>:<port>", "stampedAt": <ms>}` on first boot and returns `fresh`; later boots return
`match` or `mismatch` (original stamp left in place). The pool only warns; quarantining stale memories is
handled elsewhere (see [villager-memory.md](villager-memory.md)).

### When the pool exists

`main.ts` builds a pool only for `opts.spawnBots && config.villagers.length > 0`; the direct boot sets
`spawnBots:true` (`main.ts:1195`). Spawning itself is deferred to the in-game `/villagers start`
(`VillageLauncher.start` → `pool.start()`, `eden/src/village-launch.ts:75-83`); `restart` deletes
`bots/<name>.json` for every villager before reconnecting (`:96-107`). The engine resolves a runner's bot via
`pool.bot(name)` (`main.ts:528`).

## Plugins (`bots/plugins.ts`)

Pre-spawn: `pathfinder` (from `mineflayer-pathfinder` default export, `plugins.ts:20`).
Post-spawn `loadPlugins(bot)` (`plugins.ts:62-80`) loads, in v1's order, each in its own try/catch:

| # | Key | Import (R15) | Package (package.json) | Notes |
|---|---|---|---|---|
| 1 | `pvp` | `import { plugin as pvp } from 'mineflayer-pvp'` | `^1.3.2` | `bot.pvp.attack/stop` |
| 2 | `armorManager` | `import armorManager from 'mineflayer-armor-manager'` (flagless CJS, default ok) | `^2.0.1` | autonomous equip; paused during window ops (R3) |
| 3 | `tool` | `import { plugin as tool } from 'mineflayer-tool'` | `^1.2.0` | loaded; not called by stock skills |
| 4 | `collectBlock` | `import { plugin as collectBlock } from 'mineflayer-collectblock'` | `^1.6.0` | cleared by the abort sequence |
| 5 | `autoEat` | `import { loader as autoEat } from 'mineflayer-auto-eat'` (native ESM) | `^5.0.3` | configured then enabled |
| pre | `pathfinder` | `import pathfinderPkg from 'mineflayer-pathfinder'` then `.pathfinder` / `{ goals }` | `^2.4.5` | bounded at spawn |

The pvp/collectblock/tool trio ship CJS with `__esModule` but no `default` — **named imports only**
(R15). A failed load calls `onWarn('plugin "<key>" failed to load: <msg> (R16)')` (pool routes it to
`logger.warn('bot:<name>', …)`) and the bot stays online. Afterwards: `bot.autoEat?.setOpts?.(AUTO_EAT_OPTS)`
then `bot.autoEat?.enableAuto()` (R17).

`AUTO_EAT_OPTS` (`plugins.ts:28-36`, ported verbatim from v1):

| Key | Value |
|---|---|
| `priority` | `'foodPoints'` |
| `minHunger` | `15` |
| `minHealth` | `14` |
| `bannedFood` | `['rotten_flesh','pufferfish','chorus_fruit','poisonous_potato','spider_eye']` |
| `returnToLastItem` | `true` |
| `offhand` | `false` |
| `eatingTimeout` | `3000` |

### Pathfinder bounds — `boundPathfinder` (R6, `hardening.ts:14-20`)

Called on every spawn: `thinkTimeout = 2000`, `tickTimeout = 10`, `searchRadius = 64` (upstream defaults
5000 / 40 / −1 unbounded). No custom `Movements` is set anywhere in `eden/src` (land-bot tuning deferred;
`vendor-mineflayer.d.ts:8-16` only declares the knobs).

## Hardening guards (`bots/hardening.ts`)

| Guard | R# | Behaviour | Used by |
|---|---|---|---|
| `boundPathfinder(bot)` | R6 | see above; no-op if pathfinder missing | pool onSpawn |
| `abortActiveTasks(bot)` | R4/R5 | ordered, each step try/caught: (1) `collectBlock.cancelTask?.()` + empty `collectBlock.targets`; (2) `await pvp.stop()`; (3) `pathfinder.stop()` **then** `pathfinder.setGoal(null)` (a lone `stop()` arms a latent flag that cancels the next goal); (4) close `currentWindow`; (5) `await setImmediate` | engine on timeout/stall/preempt (`engine.ts:373`) |
| `installChatInterceptor(bot)` | R25 | replaces `bot.chat` with a wrapper dropping `/^\s*\//` messages silently; returns a restorer | engine when a divine runner runs a mortal root skill |
| `waitForInventoryQuiescence(bot, {quietMs=120, timeoutMs=2000})` | R2/R39 | resolves after `quietMs` without `set_slot`/`window_items` on `bot._client`, or at the hard `timeoutMs` | tests only |
| `craftQuiescence(bot, fn, opts)` | R1–R3 | close stray window, pause auto-eat + armor-manager, run `fn`, wait quiescence; always resume in `finally` | tests only |

The stock `craft-item` skill inlines its own variant (80 ms quiet window, **no hard ceiling**) — see
[stock-skills.md](stock-skills.md).

### Host process guards (Blocker Z)

Not in bots/, but the last hardening layer: `installProcessGuards(journal)` (`eden/src/main.ts:1169-1189`)
adds `uncaughtException` / `unhandledRejection` handlers that log and journal `system.error {message,
stack?}` (actor `engine`) and **do not exit** — an async throw from mineflayer's physics tick (e.g. a skill
passing a plain-object goal to pathfinder) would otherwise kill the whole village. Installed only on a
direct boot (`installProcessGuards:true`), never under tests.

## Helpers (`bots/helpers.ts`) — not wired

TS twins of the stock primitives, ported from v1, exercised only by tests:

| Function | Behaviour |
|---|---|
| `goToHops(bot, target, range=1)` | R7: legs of ≤ `MAX_HOP_BLOCKS = 40` with `GoalNear(...,2)`, max 1024 legs, then final `GoalNear(target, range)`; throws if no pathfinder / no entity (`helpers.ts:26-42`) |
| `collectTrunk(bot, base, {maxHeight=32})` | R10: dig upward while `_log/_wood/_stem/_hyphae`, skip failed digs; returns count (`:61-76`) |
| `useChest(bot, pos, fn)` | goToHops range 3, `blockAt` (throws `useChest: no block at (x, y, z) — chest gone or chunk unloaded (R8)`), pause mutators, `openContainer`, `fn`, always close + resume (`:82-98`) |
| `deposit` / `withdraw(bot, pos, items)` | via `useChest` + `registry.itemsByName` id (`:107-118`) |

## Signals (`signals.ts`)

`attachReactivitySignals(bot)` (`signals.ts:56-85`) creates a fresh `EventEmitter` bus (max listeners
unlimited) for the villager `EventRouter` (`eden/src/villagers/reactivity.ts:63-77`), so the router never sees
mineflayer's native per-entity `entityHurt`.

| Native bot event | Synthetic bus emission |
|---|---|
| `health` | if health dropped since last observation: `entityHurt(bot.entity, {damage: last - hp, byEntity?})` where `byEntity` is the **name of the nearest hostile** in `bot.entities`; then always `health` (no args) |
| `death` | `death` |

The baseline is `bot.health` at attach time (first observation never emits a hurt); `undefined` health
reads as 20. Hostile names (27): zombie, zombie_villager, husk, drowned, skeleton, stray, wither_skeleton,
creeper, spider, cave_spider, witch, slime, silverfish, phantom, pillager, vindicator, illusioner,
ravager, evoker, blaze, ghast, magma_cube, zoglin, hoglin, piglin, piglin_brute, enderman
(`signals.ts:28-33`). `detach()` removes both native listeners and clears the bus.

Only `entityHurt`, `health` and `death` are ever emitted. The EventRouter also binds `chat`,
`entitySpotted`, `entityGone`, `itemReceived`, `blockBrokenNearby`, `runFinished`, `inbox` and `time`
(`eden/src/villagers/events.ts:142-215`), so on a live bot **`player-chat`, `entity-spotted`, `night-falls`,
`new-day`, `inbox` etc. never fire from this bus** (only `tick-30s` is pumped separately). Stall-detector
pulses are a different mechanism (engine-side bot listeners, see [skills-engine.md](skills-engine.md#pulse-sources-d-10--r26--r46)).

## Anchors (`anchors.ts`) — not wired

`AnchorService(dataDir, {searchRadius=16, onWarn})` (`anchors.ts:40-50`); `heal(botName, bot, {})`
(`anchors.ts:57-91`):

- **home:** reuse persisted `anchors.home` if still standable (solid below, non-solid at feet and head);
  else cube-scan ±16 around the bot (floored position) for the nearest standable cell; else silently use
  the bot's raw (unfloored) position.
- **chest:** a persisted chest is trusted unconditionally (chunk may be unloaded at boot); else the nearest
  `chest`/`trapped_chest`/`barrel` in ±16 around home; else one warning
  `no chest/trapped_chest/barrel found near "<name>" — leaving it unset` and `null`.
- "Solid" = `blockAt` non-null and name not in `air, short_grass, tall_grass, fern, snow`.
- Persisted to `<dataDir>/bots/<name>.json` under the `anchors` key `{home:[x,y,z], chest:[x,y,z]|null}`,
  preserving other keys (memory etc.); a corrupt file is treated as empty.

`AnchorInput` is an empty interface: configured home/chest hints are **not** an input, and
`VillagerConfig` has no `home`/`chest` keys (allowed keys: `name, role, persona, items`, `config.ts:223`).
Nothing in `eden/src` instantiates `AnchorService`.

## Render layer

All in `eden/src/render/` (layer 1, imports only `types/`), deterministic (S6):

**`estimateTokens(text)`** (`tokens.ts:12-15`): `0` for empty, else `max(1, ceil(length / 4))` — a
≈4 chars/token heuristic shared by the context pack and brain (R19).

**`renderSnapshot(s)`** (`snapshot.ts:18-37`), six lines:

```
biome=<biome> time=<time> pos=<x>,<y>,<z> hp=<health>/20 food=<hunger>/20
equipment: <a, b> | (none)
inventory: <name>×<count>, … | (empty)
entities: <name>@<dist>m, … (nearest-first, ties by name) | (none)
blocks: <a, b> | (none)
chests: <x>,<y>,<z> | … | (none)
```

Positions and entity distances are rounded to 0.1.

**`renderRunReport(r)`** (`run-report.ts:13-31`):

```
skill=<s> v<k> villager=<v> durationMs=<ms> pulses=<n>
args=<stable JSON, sorted keys>
outcome=OK value=<stable JSON>            | outcome=FAIL errorKind=<kind|(none)> error=<verbatim error>
aborted=<cause>                           (only when aborted)
callTree: a@v1(12ms) → b@v2✗(30ms)        (only when non-empty; ✗ marks a failed frame)
--- monde AVANT ---
<renderSnapshot(worldBefore) | (aucun)>
--- monde APRÈS ---
<renderSnapshot(worldAfter) | (aucun)>
```

The error is printed verbatim and never elided (D-11). Consumers: `god/critic.ts` and
`villagers/context-pack.ts`. Because the engine's `captureSnapshot` only fills position/health/food/
inventory, the `biome=unknown time=0` and empty equipment/entities/blocks/chests lines are what the critic
actually sees for run evidence.

## Gotchas & known issues

- **AnchorService and helpers.ts are dead code at runtime** — R18 "homes snap to real ground" is
  implemented and tested but never invoked; villager config carries no home/chest.
- **Vitals `currentRun` is always `null`** — `currentRunOf` is not passed (`engine.runningSkills` exists).
- **Most reactivity events have no source** — the signal bus emits only hurt/health/death; `night-falls`
  / `new-day` reflexes in `roles.json` (go-home, harvest-field) never fire live.
- **`stampWorldId` throws on a corrupt `world.json`** (`JSON.parse` without try, `pool.ts:357`), which
  rejects `pool.start()`.
- **`start()` is not idempotent at the pool level**: a second call without `stop()` connects a second bot
  per member (same usernames → server kicks; R66 guards only the bookkeeping). `VillageLauncher` guards it
  with its own `running` flag.
- **Infinite reconnects**: a permanently refused login (whitelist, ban, wrong version) retries every 30 s
  forever, journaling `system.bot-disconnected` each time.
- `spawnAll` staggers *connect calls*, not spawns; slow logins can still overlap.
- `death_combat_event` is subscribed on `bot._client` per instance; the payload `message` is a chat
  component on 1.21 and is stored as JSON text.
- The anchor scans call `blockAt` ~(2·16+1)³ ≈ 36k times synchronously per heal (would block the event
  loop if wired).
- `VillageLauncher.onSpawn` issues `/spreadplayers`, `/clear`, `/give` through the **villager's** own
  `bot.chat` (`village-launch.ts:124-128`); villagers are never op'd by design (R14), so these succeed only
  if the server grants them permission some other way.

## Related

- [skills-engine.md](skills-engine.md) — abort protocol, interceptor and pulse sources in context
- [stock-skills.md](stock-skills.md) — inline versions of the hardening corpus
- [skills-library.md](skills-library.md)
- [villager-runtime.md](villager-runtime.md) — EventRouter / subscriptions consuming the signal bus
- [villager-memory.md](villager-memory.md) — world-stamp quarantine of beliefs, `bots/<name>.json`
- [process-config-and-boot.md](process-config-and-boot.md) — `spawnBots`, `/villagers start`, config keys
- [journal-and-views.md](journal-and-views.md) — `vitals`, `system.bot-*`, `world.death` kinds
- [java-integration.md](java-integration.md) — op-on-join for the avatar
- [god.md](god.md) — critic consumption of `renderRunReport`
