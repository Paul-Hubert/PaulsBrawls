---
id: squad.overview
title: Squad — player-owned Mineflayer bots ordered by LLM-written commands (as built)
system: squad
summary: What runs today for /bots — the Node runtime in squad/ (processes, threads incl. the optional pathfinding workers, bots, leases, orders, the command dialect, authoring over MCP, storage, HTTP API, the patched dependencies, the lag monitor, /api/metrics and the vitals journal) and the mod's thin front in com.paul.brawl.squad (incl. /bots status) — with the live results on the production server, the protocol hardening, and what is still unverified.
tags: [squad, bots, mineflayer, orders, leases, reclaim, authoring, mcp, squad-author, claude-code, kits, 8772, production, performance, patch-package, lag-monitor, metrics, vitals, pathfinding-workers, astar-budget]
sources:
  - docs/29-squad-design.md
  - docs/31-squad-performance-review.md
  - squad/src/main.ts
  - squad/src/supervisor.ts
  - squad/src/bots/pool.ts
  - squad/src/bots/protocol.ts
  - squad/src/bots/hardening.ts
  - squad/src/bots/pathworkers/client.ts
  - squad/src/bots/pathworkers/worker.mjs
  - squad/src/bots/pathworkers/serialize.ts
  - squad/src/config.ts
  - squad/src/vitals/lag-monitor.ts
  - squad/src/vitals/metrics.ts
  - squad/patches/
  - squad/src/leases.ts
  - squad/src/orders/runner.ts
  - squad/src/orders/order.ts
  - squad/src/orders/guard.ts
  - squad/src/api/squad.ts
  - squad/src/api/helpers.ts
  - squad/src/api/scope.ts
  - squad/src/service.ts
  - squad/src/script/compile.ts
  - squad/src/script/check.ts
  - squad/src/script/typecheck-worker.mjs
  - squad/src/stock/
  - squad/src/authoring.ts
  - squad/src/http/server.ts
  - squad/src/http/mcp.ts
  - squad/src/journal/journal.ts
  - squad/reference/squad.d.ts
  - squad/agent/prompts/squad-author.md
  - src/main/java/com/paul/brawl/squad/
verified_at: 2026-10-30 (branch rework at 32e086a)
---

# Squad — as built

**TL;DR.**
- An admin spawns Mineflayer bots and gives them owners (`/bots spawn`) and role kits (`/bots equip`).
- A player asks for a command in words (`/bots create NAME …`). The `squad-author` agent (headless Claude Code, MCP
  tools only) writes one JS file controlling all the player's bots, typechecks it against mineflayer's types,
  test-runs it, and submits it. `/bots order NAME` runs it.
- Co-owners reclaim busy bots per role, and reclaimed bots return to their previous order.
- No sandbox: players are trusted (docs/29 O1).
- The runtime is one Node process in `squad/` on `127.0.0.1:8772`; the mod is a thin front. Design and decisions:
  [docs/29](../../29-squad-design.md); §16 there lists where the code differs.
- Performance: patched library hot spots, an A* budget on by default, an optional pathfinding worker pool, and a lag
  monitor with `POST /api/metrics`, a vitals journal and `/bots status` ([docs/31 §11](../../31-squad-performance-review.md)).

## Processes and threads

| What | Where | Notes |
|---|---|---|
| Supervisor | `squad/src/supervisor.ts` | The parent process (`npm start`). It forks the runtime with `--import tsx`, expects an IPC heartbeat every second, kills the runtime after 10 s of silence (`HEARTBEAT_TIMEOUT_MS`, :15) and restarts it with backoff 1/2/5/10/30 s |
| Runtime, main thread | `squad/src/main.ts` `start()` :35 | **Everything else**: every mineflayer bot (protocol decoding, physics ticks, the pathfinder's look-ahead, and A* unless the workers are on; plugins), every order's script, the leases, the HTTP + SSE + MCP server, the synchronous SQLite journal, the vitals sampler |
| Pathfinding workers (optional) | `squad/src/bots/pathworkers/client.ts` `PathWorkerPool` :113, `worker.mjs`; built in `main.ts` :53 | **Off by default** (`pathfinding.workers` 0). When on: the bots' own A* searches, over a mirror of the world. Details below |
| Typecheck worker | `squad/src/script/typecheck-worker.mjs`, started by `check.ts` `typecheckWorker()` :156 | TypeScript `checkJs` for `check_script`/`submit_command`. First check about 5 s (it parses the library types), later ones 0.1–0.3 s; warmed 2 s after boot. Unref'd when idle |
| The mod | `com.paul.brawl.squad` in the server JVM | `/bots` commands and the commander snapshot on the server thread; HTTP to the runtime is async; the SSE reader is a virtual thread (`squad-events`); authoring turns are virtual threads running `claude -p` (`ClaudeCodeClient`) |

With the workers off there is no other parallelism. All bots share one event loop: a heavy pathfind, a script's
synchronous loop, or a big decode delays the physics of every bot. The loop budget and the starvation canary
(`compile.ts` `createLoopBudget` :252, `STARVATION_MS` 3 s) stop a runaway script, and the supervisor's heartbeat is
the backstop. Two settings decide where A* runs and how much of the loop it may take (`config.ts`, applied once at
start, `main.ts` :42 and :49):

| Key in `squad.json` | Default | What |
|---|---|---|
| `pathfinding.astarBudgetMs` | **20** (`DEFAULT_ASTAR_BUDGET_MS`, `config.ts` :53); 0 = off, at most 50 (:55) | All A* searches together spend at most this many ms per 50 ms window (the patched `AStar.setBudget`, applied by `applyPathfinding` :133, which throws if the patches are missing). A search that finds the window spent waits with its best partial path; the wait does not count against `thinkTimeout` |
| `pathfinding.workers` | **0** (off); an integer up to 16 (`MAX_PATH_WORKERS` :58) | Pathfinding worker threads, capped at the cores minus one (`pathWorkerCount` :145; `main.ts` :51 warns when it caps) |

Why these defaults (measured on a desktop, [docs/31 §11](../../31-squad-performance-review.md)): the budget was better
than none in every moving phase at 10–30 bots; with it, the main thread was not saturated at 30 moving bots, and the
workers cost about 9 GB of RSS at 30 gathering bots and did less gather work.

**The pathfinding worker pool** (`bots/pathworkers/`, docs/32 D):
- **What moves:** only the pathfinder plugin's own planning, through the `bot.pathfinder.searchOffload` hook the patch
  adds (`client.ts` :202). A caller's synchronous `getPathTo` stays on the main thread. The bots, physics, look-ahead
  and scripts stay there too, so O2 (the real bot) and O4 (instant reclaim) hold.
- **The mirror:** the pool attaches to each bot before its first packet (`pool.ts` :262) and installs the hook at spawn
  (:278). Login/respawn, chunk, block-change and explosion packets are forwarded; one world per dimension is shared by
  every bot, each chunk is copied once into a `SharedArrayBuffer` (`client.ts` `shared` :537) and refcounted by bot.
- **The search:** the worker runs mineflayer-pathfinder's own `AStar` and `Movements` over a stand-in bot (blocks from
  the mirror; inventory, effects, registry from a snapshot sent per search), in 10 ms slices (`worker.mjs`
  `SLICE_MS` :39), with partial paths every 250 ms (`PROGRESS_MS` :41). Each search starts with an empty block cache
  (`worker.mjs` :170).
- **On the main thread** (`OffloadedSearch`, `client.ts` :450): the start node until the worker answers, then its path
  as `Move` objects. Goals are serialized by class (`serialize.ts`; `GoalFollow` becomes a `GoalNear` snapshot and the
  main thread keeps `hasChanged`).
- **Fallbacks to the main-thread search:** an unknown goal, exclusion areas or a non-plain `Movements`, no live worker,
  a worker that died or threw, no answer by `thinkTimeout` + 2 s (`DEFAULT_GRACE_MS` :109). A dead worker is restarted
  and refilled; a slot that dies 3 times in a minute is disabled (`MAX_CRASHES_PER_MINUTE` :111). `stats()` (:408)
  counts offloaded, answered, fallbacks and restarts, but nothing reports it yet (the bench prints it).

## Patched dependencies (`squad/patches/`, docs/32 B)

`npm install` runs `patch-package --error-on-fail` (`package.json` postinstall; `patch-package` 8.0.1 is a runtime
dependency, so `--omit=dev` applies them too). A patch that no longer applies fails the install, and
`tests/patches.test.ts` fails without each one. The patches, each measured in docs/31 §4:
- **prismarine-physics** `index.js`: `PlayerState`'s requires hoisted, minecraft-data kept per version.
- **minecraft-protocol** `src/transforms/framing.js`: `readVarInt` only once a whole varint is buffered.
- **mineflayer-pathfinder:** `lib/tick.js` (one tick clock per bot, a module-level `WeakMap`); `lib/physics.js` (the
  look-ahead reuses a decision for the same next node for 4 ticks and caches its block reads); `lib/movements.js` (A*'s
  `getBlock` cached until the block may have changed, never the unloaded placeholder; `getMoveJumpUp` uses a local
  height, the fix of `32e086a`); `index.js` ("stuck" after 70 physics ticks instead of 3.5 s; the `searchOffload`
  hook); `lib/astar.js` (`AStar.setBudget(ms)`).
- **mineflayer-pathfinder, ladders** (docs/29 §16, 2026-10-31; upstream faults, `tests/ladders.test.ts`): someone on a
  ladder only adds to the cost of climbing it (`getMoveUp` refused it); the block a ladder hangs on is never dug
  (`safeToBreak`); a ladder block is entered from its front only (`getNeighbors`), and a partial path is never trimmed past the step in
  front of a ladder (`pathFromPlayer`, `stepsOntoLadder`); a path never ends on a ladder nor
  rises over its top (`AStar.computeSlice`, `getMoveUp`), and the executor does not count a goal as reached while the
  bot hangs on one (`index.js` `onClimbable`); `postProcessPath` works on copies of the nodes, so a search spread over
  ticks is not changed under it (`copyMove`). The workers run the same `lib/`, so they find the same paths.

## Observability (docs/32 C)

- **Lag monitor** (`vitals/lag-monitor.ts`, copied from Eden and owned here): `monitorEventLoopDelay` at 10 ms
  resolution, reported as lateness beyond 10 ms (like the bench), plus ELU, process CPU, RSS and heap. Armed first in
  `start()` (`main.ts` :41), so it sees the boot.
- **Per-bot counters** in the pool (`pool.ts` `meter` :315, read by `readMeters` :196): physics ticks, `path_update`
  outcomes (success, noPath, timeout, other), `path_reset` reasons, deaf trips; plus a process-wide count of skipped
  packets (`skippedPackets` :377). Bound to one bot instance (R66).
- **The sampler** (`vitals/metrics.ts` `Vitals` :95, built in `main.ts` :63) closes a 10 s window (`SAMPLE_MS` :18).
  It warns at most once a minute when the loop p99 > 250 ms or ELU > 0.9 (:21–23).
- **`POST /api/metrics`** (`http/server.ts` :132, `service.ts` :78) returns the last complete window (the window so far,
  `complete: false`, in the first 10 s): `{ ok, text, window: { seconds, endedAt, complete }, loop: { p50, p99, max },
  elu, cpuPct, rssMb, heapMb, skippedPackets, bots: [{ name, status, ticksPerSec, path: { success, noPath, timeout,
  other }, resets, deafTrips }] }` (`Metrics` :52). `text` is the French line for players.
- **The journal's `vitals` table** (`journal/journal.ts` :71): one row per minute (time-weighted ELU, worst p99, the
  slowest bot, counts summed, details as JSON in `data`), written by `saveVitals` (:146), which deletes rows older than
  7 days (`VITALS_KEEP_MS` :46). Never the hot stream (R44).
- **`/bots status`** (perm 0, `SquadCommand` :90, :367): ELU, loop p99 and the slowest bot's ticks/s from
  `/api/metrics`, formatted by the Minecraft-free `SquadStatusFormat` (« surchargé » past the warning thresholds).

## The runtime (`squad/src/`)

| Area | Files | What it does |
|---|---|---|
| Bots | `bots/pool.ts`, `plugins.ts`, `hardening.ts`, `protocol.ts` | Dynamic pool, logins 4 s apart, reconnect with backoff, version pinned to 1.21.1, `viewDistance: 'short'`. Plugins: pathfinder, pvp, armor-manager, tool, collectblock, hawkEye (one copy of the module per bot: it keeps its bot and target in module variables, `freshHawkEye`), auto-eat. Pathfinder bounded (searchRadius 64, thinkTimeout 5 s, `hardening.ts`), its library patched and its A* budgeted (above). Per-bot vitals counters. Protocol hardening, below |
| Roster | `roster.ts` | Bots, owners, tags in `.squad-data/roster.json`; the runtime is its only writer |
| Leases | `leases.ts` | A lease stack per bot (depth 4). `plan` :84 grants idle bots first, then busy ones for `take: 'reclaim'` roles, all or nothing. `apply` :106 runs the old order's cleanup before reuse. `release` :130 hands a bot back to the live order below |
| Orders | `orders/runner.ts`, `order.ts`, `guard.ts`, `claims.ts` | `start` :141 (tracked per binding, below) → `launch` :147 resolves, compiles (once per version) and runs. Each script gets a **lease-guarded Proxy** of each bot (`guardBot` :81): calls check the lease, listeners and timers are tracked, chat is rate-limited, `quit` is refused. Every leave and every end runs the R4/R5 abort sequence. Claims are shared across orders. `trigger` :208: a bound item's click delivers to, restarts, starts or stops the player's order of that command (below) |
| Dialect | `api/squad.ts`, `api/helpers.ts`, `api/scope.ts`, `reference/squad.d.ts` | `squad.parallel`, `squad.tasks` (work queue, re-queues the work of a leaving bot), claims, acquire/release, `ctx.commander` (with `on('trigger')`, `off`, `next`), `ctx.run`. Voyager-named helpers (`mineBlock`, `craftItem`, `goTo`, `shoot`…), and the formation helpers of bound items (`lookDir`, `lineSlots`, `groundAt`, `faceYaw`, `raiseShield`, `entityOf`; below) |
| Scripts | `script/compile.ts`, `manifest.ts`, `check.ts` | ESM rewritten in place, keeping lines (`vm.Script` filename `squad:<author>/<name>@vN.mjs`); loop budget + fences; manifest and args (French errors for players); `check_script` = compile + dry module run + typecheck (`BLOCKING_CODES` :40) |
| Authoring | `authoring.ts`, `http/mcp.ts`, `agent/` | `cmd-…` tickets (30 min; manual 2 h). Seven MCP tools (`get_api_reference`, `get_context`, `list_commands`, `read_command`, `check_script`, `trial_run` ≤ 60 s on idle bots, `submit_command`). Claude Code config in `agent/claude-code/`, opencode config in `agent/opencode.json` |
| Storage | `store/commands.ts`, `journal/journal.ts` | `.squad-data/commands/<uuid>/<name>/meta.json` + `vN.mjs` (append-only, shares, revert); SQLite `squad.db` (WAL, `synchronous=NORMAL`), one row per order with its full report, and one `vitals` row per minute |
| HTTP | `http/server.ts` | 21 `POST /api/...` routes (incl. `/api/metrics`, `/api/orders/check`, `/api/orders/trigger`), `GET /events` (SSE: `hello`, `notice`, `state`; notices buffered while no mod listens), `POST /mcp/squad`; bearer `PAULSBRAWLS_SQUAD_TOKEN` |
| Stock | `src/stock/*.mjs` | `come`, `follow`, `defend`, `gather`, `deposit`, `attack`, `bring`, `raid`, and for bound items `mur-de-boucliers`, `epee`, `ligne-archers`, `tir`. Usable by everyone, and the agent's examples. `defend`, `raid` and the four: below |

## Orders bound to items — the runtime (docs/29 §5.4, 2026-10-31)

The mod keeps the binding on the item stack and sends each click; the runtime decides what a click does.

- **`POST /api/orders/check`** `{ by, command, tokens, filters }` (`SquadService.checkOrder`, `service.ts` :167), for
  `/bots orders bind`. The same rules as `/bots order`, without owning a bot (a captain may bind items to hand out):
  - every `@filter` names one of the player's bots;
  - the command resolves for the player (`store.resolve`);
  - the manifest loads (`checkScript`, no typecheck), and the args parse against it.
  It answers `{ ok, text: '[Bots] Ordre « X » : <summary>', command, summary }`. `command` is canonical, what the item
  stores: the stock name, else `author:name`. A refusal is `{ ok: false, text }`, with the usage line on bad args.
- **`POST /api/orders/trigger`** `{ by, command, tokens, filters, take?, stop?, snap }` (`OrderRunner.trigger`,
  `orders/runner.ts` :208). The binding's order is keyed by (commander = `by`, the command's author uuid + name; not
  the version). It is the player's running, non-trial order of that command, whether a click or `/bots order` started
  it:
  - `stop: true`: stopped, `[Bots] « X » arrêté.` (`[Bots] Aucun ordre « X » en cours.` when none runs). It also
    stops an order whose command no longer resolves for the player (unshared, deleted), matched by its canonical name.
  - **Running and listening** (`order.listening`, set by `ctx.commander.on('trigger')` or `next()`): delivered,
    `{ ok: true, text: '', orderId, delivered: true }`. Nothing is stopped, granted or reclaimed (O4).
  - **Running, not listening:** every running order of that binding is stopped, then one is started with the new
    snapshot, tokens, filters and take: the start's answer plus `restarted: true`.
  - **Not running:** `launch`, exactly as `/api/orders/start`, plus `started: true`.
  - Several running orders of one binding (two `/bots order`): delivery goes to the newest; a stop or a restart takes
    them all.
  - A restart and a stop end the old order without its « X » arrêté. notice (`order.silentEnd`): the route's answer is
    the player's line. When a restart's new start is refused, the answer names the stopped order too.
- **Starts in flight.** `runner.starting` (:83) maps a binding key to its start's promise. Every start is registered,
  `/bots order` included (`start` → `track`), and so is a trigger's stop-then-start. A trigger that finds one waits
  for it and loops until none is left, then decides synchronously, so two clicks never start two orders. The order
  that start produced gets the trigger even before it listens: a bow's arrow-hit reaches the order its arrow-release
  started. If that start failed, the first waiting trigger starts the order and the others are delivered to it.
- **The script side** (`api/scope.ts`, `commanderOf` :166). One commander object per order, in a `WeakMap`, shared by
  its `ctx.run` subroutines, so a click reaches the whole order once.
  - On delivery (`Order.deliverTrigger`, `order.ts` :449) `order.snap` is replaced; `report.snap` keeps the start one.
  - `atOf` (:140) builds a new `ctx.commander.at` (positions as `Vec3`, `trigger.hit` too). Every listener gets it.
  - Then every pending `next()` resolves with it, or, with none waiting, it fills the one slot (latest wins).
  - Listeners are wrapped by `Order.wrapCallback`, so a throwing listener fails that order only. They are dropped at
    order end.
  - `next(timeoutMs?)` resolves `null` on timeout (no timeout when omitted or infinite). It rejects with the order's
    `OrderStoppedError` when the order ends: it listens to `order.signal`, aborted after the status is set.
- **The report.** Each trigger is one `ReportEvent` `{ kind: 'trigger', outcome: started|restarted|delivered|stopped,
  trigger, item, pos?, entity? }` on the order it reached (`noteTrigger` :461), at most 200 (`MAX_TRIGGER_EVENTS`),
  then dropped silently. Events are journaled with the report at its start and end, never one write per click (R44).
- **Sanitizing** (`snapshot`, `http/server.ts` :282). The snapshot of every route is rebuilt field by field: numbers
  coerced, strings checked, unknown keys dropped. An entity `id` is kept only when it is an integer. A trigger is kept
  only with a kind of `use|arrow-release|arrow-hit`; a non-string `item` becomes `''`.
- **Reference and prompt.** `squad.d.ts` types `SquadCommanderAt`, `SquadAtTrigger`, `SquadAtEntity` (with `id`) and
  `on` / `off` / `next`. The `squad-author` prompt has one paragraph: re-aim a running order rather than let it
  restart. Tests: `squad/tests/triggers.test.ts`, plus the HTTP round trip in `tests/http.test.ts`.

## Orders bound to items — the helpers and the four stock commands (docs/29 §5.4 items 7–8)

**The yaw convention.** Every formation helper takes yaw as `ctx.commander.at.yaw` gives it: Minecraft's degrees,
0 = south (+Z), 90 = west (−X); pitch negative = up. Mineflayer's `bot.entity.yaw`/`pitch` are radians from another
origin: `faceYaw` converts with mineflayer's own formulas (`lib/conversions.js`; `mineflayerYaw`/`mineflayerPitch` in
`helpers.ts`, checked against mineflayer's in `tests/helpers.test.ts`).

The helpers (`api/helpers.ts`; scope globals through `HELPERS` and `compile.ts` `SCOPE_NAMES`; typed in `squad.d.ts`):
- `lookDir(yaw, pitch = 0)`: the unit view vector (yaw 0 → (0, 0, 1), yaw 90 → (−1, 0, 0)).
- `lineSlots(center, yaw, count, { spacing = 1.5, ranks = 1, depth = 2 })`: pure. Left to right as the commander sees it
  (their right is `lookDir(yaw + 90)`, −X when facing south); `Math.ceil(count / ranks)` per rank, each rank centred,
  rank r `depth × r` blocks behind, toward the commander. Slots keep center's y.
- `groundAt(bot, pos, { up = 3, down = 4 })`: the block-centre feet position nearest `pos.y` with feet and head open (not
  lava, fire, a berry bush, powder snow, cobweb or a wither rose) and a solid block under; null when there is none or the
  chunk is not loaded. Between two equally near, the lower (the ground under a canopy, not the leaves).
- `faceYaw(bot, yaw, pitch = 0)`: `bot.look(…, true)`; returns `{ yaw, pitch }`.
- `raiseShield(bot, on = true)`: a shield not in the off-hand (slot 45, which `inventory.items()` does not include) is
  equipped there, else "no shield in the off-hand or the inventory …" (English, for the author). Then
  `bot.activateItem(true)`: in 1.21.1 mineflayer sends `use_item` with hand 1 (its `useItemWithOwnPacket` path).
  `bot.deactivateItem()` (`block_dig` status 5) lowers it. Mineflayer's `usingHeldItem` is only a hint: any
  `entity_status` packet, for any entity, clears it, and an axe's cooldown packet for an off-hand shield does not
  (mineflayer checks the cooldown against the main-hand item). So `raiseShield` keeps its own record per body: it sends
  again when the flag is false (harmless: the server ignores a use while one is held), and at most every 5 s while it
  is true (`SHIELD_REASSERT_MS`, which recovers a shield the server dropped). Nothing is sent while auto-eat eats
  (`autoEat.isEating`): auto-eat lowers the shield itself (`deactivateItem` before eating), and the next call raises it
  again. A bot leaving an order lowers it (the abort sequence's `deactivateItem`).
- `shoot(bot, target)`: an entity (anything with `isValid`, as prismarine-entity's are) or a position (a Vec3,
  `[x, y, z]`, a block, a snapshot ref). A position goes to hawkEye as `{ position, isValid: true }`: hawkEye takes a
  target without `type` for a point (`isEntity` is `"type" in e`), aims at it with no height offset, and derives its
  velocity from the position history, not from a field. hawkEye is asked first (`getMasterGrade`): its block check
  raycasts every step of the arc (`bot.world.raycast`), so a point on the ground can count as blocked. Without a
  trajectory the bow is aimed by `bowAim` (exported, not a global): the arrow's flight tick by tick, as
  `PersistentProjectileEntity` moves it (from the eyes − 0.1, 3 blocks per tick at full draw; move, then × 0.99, then
  y − 0.05), the low arc (the first elevation whose flight passes through the point, refined by bisection), and out of
  range the elevation that carries farthest. A hand-aimed release now waits 60 ms after the look (`LOOK_SETTLE_MS`):
  `bot.look(…, true)` only sets the yaw and pitch, the look packet goes out with the next physics tick, and a release
  sent at once (as the entity path did after hawkEye gave up) flew at the old aim.
- `entityOf(bot, ref)`: by `id` in `bot.entities`, else a player by `username`, else the nearest entity of that `name`
  within 4 blocks of the ref's position, the last only for a ref without an id: the id is the same for every client,
  so a ref whose id the bot lacks is dead or out of its sight, and another zombie next to where it stood is not it.
- `isFriend` accepts a snapshot entity too (it reads `type` and `username`).

**What the four commands share** (`src/stock/mur-de-boucliers.mjs`, `epee.mjs`, `ligne-archers.mjs`, `tir.mjs`):
- `ctx.commander.on('trigger', …)` is their first statement, so every later click is delivered (re-aim), never a restart.
- One state object with a version number. A click recomputes it; every bot's loop looks again every 100–200 ms and
  never awaits a long goal. Walking is a pathfinder goal set directly and kept while it is the same spot (`GoalBlock`
  on a ground slot; `GoalNear` range 2 after 10 s without reaching it, or for a slot off known ground). A fight ends at
  once on a new version (`attack`'s `until`).
- The point: the block looked at (`lookBlock` + (0.5, 1, 0.5) through `groundAt`) when within `distance`
  horizontally, else the commander's position + `lookDir(yaw)` × 5 (`mur-de-boucliers`) or × 10 (`ligne-archers`)
  through `groundAt`; the raw point when no bot knows that chunk. `groundAt` runs with whichever bot knows it.
- One loop per bot, started again for a bot that comes back from another order (`squad.on('joined')`). A token per bot
  ends a stale loop: a returning bot gets the same guard object, so the old loop's calls would pass again.
- A line keeps a bot's slot while it is away (reclaimed); a click, or a bot without a slot joining, re-forms it. The
  slots go to the bots by their position along the line (the front-most to the front rank), so no two paths cross.

| Command | Item | Roles | Params | As built |
|---|---|---|---|---|
| `mur-de-boucliers` | shield | `guards` (`hasItem: 'shield'`, min 1, reclaim) | `distance` 24, `spacing` 1 (1–3), `reach` 4; until stopped | `lineSlots(point, yaw, n, { spacing })` through `groundAt`. Shield down to walk; on the slot `faceYaw(yaw)` and `raiseShield`, re-asserted every look. A hostile, or a non-friend player who is not a spectator, within `reach` of the slot: shield down, `attack` leashed to the slot (radius `reach` + 1), then back to the slot. « Mur de boucliers rompu. » |
| `epee` | sword | `archers` (bow, reclaim), `melee` (no bow, reclaim) | `radius` 16, `seconds` 60; until stopped | A non-friend `lookEntity` that `entityOf` resolves is the target, tracked by its id from then on: archers shoot it, at most 2 guards fight it, the other guards fight threats within `radius` of it (leashed to it), a bot that does not see it holds near the commander. Dead or gone (« Cible abattue (zombie). » when it was last within 20 blocks of a bot, else « Cible perdue de vue (…) : je reviens te défendre. ») or `seconds` (« Cible toujours debout après … ») → defend the commander. A `lookBlock`: defend that point (threats within `radius` of it, guards on a ring of 3, archers of 6 around it, by goals; fights leashed to it). The sky or a friend: defend the commander as `defend` does (rings via `follow` with `offset`). Guards at most 2 per threat, archers prefer an untaken one and step 1–2 blocks aside after "no clear line of fire" |
| `ligne-archers` | arrow (right-click) | `archers` (bow, min 1, reclaim) | `distance` 24, `spacing` 2, `back` 4, `range` 24; until stopped | Centre = point − `lookDir(yaw)` × `back`, through `groundAt`; two ranks (depth 2) past 8 archers. On its slot an archer faces the view and shoots threats within `range` of the centre: in front of the line (dot with `lookDir` > 0) and untaken first, then in front, then untaken. After "no clear line of fire": 1–2 blocks aside, shooting from there for 3 s, then back to the slot |
| `tir` | bow | `archers` (bow, min 1, reclaim) | `volley` 3 (1–16), `spread` 3, `seconds` 8; bounded, `maxMinutes` 1 | The target: `arrow-hit` with an entity → it, without → the point hit; `arrow-release` with a `lookEntity` → it, without → `ctx.commander.next(4000)`, then the `lookBlock`, else « Aucune cible. »; no trigger or `use` → `lookEntity`, else `lookBlock`. One of ours → « X est des nôtres : je ne tire pas dessus. »; an entity no archer sees → « Cible hors de vue des archers. ». Archers never move. An entity: every archer shoots it until dead or gone, or `seconds`. The ground: `volley` arrows per archer at points uniform over a disc of radius `spread`, y from `groundAt`. A later click retargets (a release waits for its hit, the next click). « Volée tirée : 9 flèches. », « Cible abattue (zombie) : 5 flèches. ». Archers reclaimed from a `ligne-archers` return to their slots there |

## `defend` and the damage rules (after a 20-bot fight, docs/29 §16)

- **Damage rules (the mod).** `Squad.registerFriendlyFire` (an `ALLOW_DAMAGE` hook, registered in `ServerEntryPoint`
  before FlagManager's, so a cancelled hit drops no Flag) cancels damage when the attacker (`source.getAttacker()`,
  the shooter for an arrow) is a roster bot and the victim is a roster bot sharing an owner with it, or a player who
  owns it. The decision is the Minecraft-free `SquadFriends`, rebuilt from the cached state (`bots[].owners`) on each
  `refreshState`, so a hit costs two map lookups. Everything else is unchanged: bots hurt mobs, other players and
  other owners' bots (PvP on, O5).
- **Friends (the scripts).** `isFriend` / `ctx.friends` are the same team: the commander, the co-owners of the
  order's bots, and every roster bot sharing an owner with them (`OrderRunner.refreshFriends`, `orders/runner.ts`).
  The set is rebuilt in place on every `state` event (a spawn, despawn, owner change, lease change), so a bot spawned
  mid-order joins its side. Until 2026-10-31 every roster bot was a friend of every order, so two players' armies
  never fought; another owner's bots are enemies now (`tests/raid.test.ts`).
- **Threats are relative to the commander.** Only threats within `radius` (default 16) of the commander as the bot
  sees them (`nearestHostile`/`nearestEntity` with `from`), nearest to the commander first, hostiles before
  non-friend players. A bot that cannot see the commander defends itself (distances from the bot).
- **Guards** (`melee`, `take: 'free'`): at most 2 on one threat, an untaken threat first (a per-order map of who
  fights what). `attack(…, { leash: { center: commander, radius } })` breaks off when the target leaves the circle or
  the guard is more than radius + 4 from the commander; the guard then goes back to its slot.
- **Archers** (`archers`, `take: 'reclaim'`): one shot, then the next target at once, preferring a threat no other
  archer shoots. `shoot` returns when the arrow count drops. After "no clear line of fire" the archer steps 2 blocks
  aside.
- **Slots.** Between threats each bot follows its own point around the commander (`follow` with `offset`, a
  `GoalFollowOffset`, `bots/follow-goal.ts`): guards on a ring of 3, archers of 6, an angle by the bot's index in its
  role. Idle bots look for threats every 200 ms (`follow` keeps its goal between calls). While nobody could stand at
  the slot (the commander on a ladder, at the edge of a tower: `slotStandable`, no floor within a block of the
  commander's height), the bot follows the commander itself at the same range, and goes back to the slot once it is
  open again (docs/29 §16).

## `raid` and `/bots raid` (an enemy army, 2026-10-31)

- **The stock `raid`** (`src/stock/raid.mjs`; params `x y z` the point, default the block the commander looks at;
  `target` a player; `radius` 24; `quiet` 60 s; roles `archers` (bow) and `melee`, both `reclaim`; until stopped).
  The leader (the first melee bot, else the first archer; the live role lists replace a dead one) walks toward the
  point in 12-block steps (`GoalNearXZ`), waits while more than half the others are over 14 blocks away, and steps
  aside after 8 s without moving. The others hold slots behind it, facing the march rounded to one of 8 directions
  (so slots do not change with each small turn): melee in rows of 5, 2 blocks apart, just behind the leader;
  archers 4 blocks behind the melee. A bot out of sight of the leader walks to the leader's position (`goTo`).
- **Fights:** any enemy within `radius` of the leader: a non-friend player who is not a spectator (the other army's
  bots included) or a hostile mob, whichever is nearer. Guards at most 2 per enemy, untaken first, leashed to the
  leader (the leader to where its fight began); archers prefer an enemy no other archer shoots, and step aside after
  "no clear line of fire", as in `defend`.
- **The hunt:** whenever a bot sees `target`, the point moves to them. At the point, the leader looks for the enemy
  player nearest the target's last known position (their bots stand around them) within 64 blocks and marches on.
  With no enemy player for `quiet` seconds at the point, the order ends (« Raid terminé … »).
- **`/bots raid [distance] [archers] [guards]`** (admin, run by a player; defaults 200, 10, 10; `SquadRaid`, the
  Minecraft-free part in `SquadRaidPlan`): the point is the caller's position plus their horizontal look direction
  × distance; the chunk is loaded (`getChunk`) and `MOTION_BLOCKING_NO_LEAVES` gives the ground. Raiders
  `EnnGarde01…` and `EnnArcher01…` (skipping names in the roster, online, reserved, or with a `playerdata` file) are
  owned by the virtual player `Envahisseur` (offline UUID), never by the caller: owned by the caller they would be
  its own team. Each goes through `/api/bots/spawn` and the whitelist like `/bots spawn`, one after the other (the
  first refusal, e.g. `limits.maxBots`, stops the spawning). On its first join it is teleported to its place (rows
  of 5 around the point, guards nearer the caller, facing them: `Squad.expectArrival` with a target position and a
  callback) and gets its kit and role tag (`Squad.equip`, `/api/bots/tag`). 3 s after the last arrival, or after
  4 s × count + 30 s, the mod starts `raid` through `/api/orders/start` as `Envahisseur` (`admin: true`; the
  runtime takes `by` as the commander, so no new route), with the commander snapshot at the spawn point, `x y z` =
  the caller's position at the call and `target` = the caller. `/bots raid stop` stops `Envahisseur`'s orders;
  `/bots raid clear` despawns every bot `Envahisseur` owns (and cancels a raid still assembling).
- **Limits:** 20 defenders + 20 raiders need `limits.maxBots` ≥ 40 in `squad.json` (default 30).

## Protocol hardening (found live, docs/29 §16)

Mineflayer's 1.21.1 data cannot decode some items. When protodef's `FullPacketParser` gets a non-partial decode
error it fails its stream, and **the bot goes deaf while staying connected**: no inventory, block or entity updates.
On production this came from Universal Shops' Polymer Trade Shop item in the login recipe list (the mod was removed).
Three layers now:
1. `declare_recipes` is read as raw bytes (`RECIPES_AS_BYTES`, passed as `customPackets`, `pool.ts` :369).
2. `keepDecodersAlive` (`protocol.ts`) drops any undecodable packet, reported once a minute per kind.
3. A deaf-bot watchdog (`DEAF_MS` 20 s, `pool.ts` :27) reconnects a bot that has received nothing for 20 s.

## The mod (`src/main/java/com/paul/brawl/squad/`)

| Class | Role |
|---|---|
| `SquadCommand` | `/bots …` (Brigadier), permissions, tab completion from the cache, async calls; `/bots status` (perm 0); `/bots orders bind\|unbind\|bound` (perm 0, below) |
| `SquadBinding` | An order bound to an item stack: `custom_data` `squad: {order, line, glint, lore}`, the lore line and the glint override it adds and removes, the bind line's parsing. The record, its NBT form and the lore edit are JUnit-tested (no bootstrap) |
| `SquadTriggers` | The bound items' clicks on the server thread: `UseItemCallback` (always `PASS`), `ServerEntityEvents.ENTITY_LOAD` for a bound bow's arrow, and the hit from `mixin/PersistentProjectileEntityMixin`; the snapshot with `trigger`, the async `/api/orders/trigger` call, the answer |
| `SquadTriggerLimiter`, `SquadArrows`, `SquadTriggerJson` | Minecraft-free, JUnit: the per-player bucket (4, refilled at 4/s), one release per shot, a repeated answer shown once per 2 s; the tracked arrows (first hit only, 10 s); the trigger's JSON and the entity shape it shares with `CommanderSnap` |
| `SquadStatusFormat` | The `/bots status` line from `/api/metrics` (Minecraft-free, JUnit) |
| `SquadFriends` | Friendly fire: which roster bot must not hurt whom (shared owner, or its own owner). Minecraft-free, JUnit; the hook is `Squad.registerFriendlyFire` |
| `SquadRaid`, `SquadRaidPlan` | `/bots raid` (above); the plan (arguments, point, names, spread, timeout) is Minecraft-free, JUnit |
| `Squad` | Lifecycle, the SSE loop and the cache, notices (kept for offline players), whitelist, join gate (a bot name from a non-loopback address is kicked), arrival teleport (to the admin, or to a given spot with a callback), `hasPlayed` (spawn refuses names with a `playerdata` file), `equip` |
| `SquadKits` | Kits for archer, guard, miner and farmer (Minecraft-free); `equip` wears armor, holds weapons and puts the shield in the off-hand |
| `SquadAuthoring` | One `squad-author` turn: reserve the slot, open, run the agent, close, announce « Commande X prête » |
| `SquadClient`, `SquadArgs`, `SquadNotice`, `CommanderSnap`, `SquadConfig` | HTTP/1.1 client and SSE framing; argument tokenizing; lines with clicks; exact position and look target (`lookEntity` with its network `id`); `squad.properties` |

## Orders bound to items — the mod (docs/29 §5.4 items 1–5)

The runtime side is above ("Orders bound to items — the runtime"). The mod keeps the binding on the stack, catches the
clicks and sends each one; it decides nothing about what a click does.

- **The binding** (`SquadBinding`) is `minecraft:custom_data` `{squad: {order, line, glint, lore}}`:
  - `order`: the canonical name `/api/orders/check` answered (`command`: the stock name, else `author:name`);
  - `line`: the rest of the bind line as typed, parsed by `SquadArgs.order` at each click;
  - `glint`: true when the bind set `enchantment_glint_override` (only when the item had none, so an enchanted golden
    apple's own glint is left alone);
  - `lore`: the exact lore line the bind appended, « Ordre : NAME LINE » (gold, not italic, cut at 60 characters).
  - A rebind clears the old binding first. `clear` removes the `squad` key (`NbtComponent.set` drops the whole
    component once it is empty), the last lore line whose text is `lore` (setting `LoreComponent.DEFAULT` when no line
    is left, so the stack carries no "lore removed" change), and the glint override only if `glint`.
- **The commands** (perm 0, under `orders`; bare `/bots orders` still lists the running orders):
  - `/bots orders bind <order> [args…]` (greedy; tab completion as `/bots order`): a player with a non-empty main hand.
    The order token must be `NAME` or `author:NAME`. `POST /api/orders/check` `{ by, admin, command, tokens, filters }`;
    on `ok`, back on the server thread, the binding is written if the player still holds the same item in the same
    hotbar slot (else « Tu n'as plus le même objet en main : rien n'a été lié. »). Answer: « Ordre « X » lié à ton
    objet (Bouclier) : clic droit pour lancer ou réorienter, accroupi + clic droit pour arrêter. » (a bow or crossbow:
    « tire une flèche »). The sentence agrees with « Ordre », since an item's name may be feminine. A refusal shows the
    runtime's text.
  - `/bots orders unbind`: the held item (« Cet objet n'est lié à aucun ordre. » when it has none).
  - `/bots orders bound`: the bound stacks of the main inventory and the off-hand, one line each (item, order, line).
  - `unbind` and `bound` touch only the stack, so they work with Squad off.
- **The triggers** (`SquadTriggers`, all on the server thread, none cancels vanilla). Nothing triggers for a stack
  without a binding, on a client world, with Squad off, for a spectator, or for a roster bot (case-insensitive: bots
  use items too, `raiseShield`).
  - `UseItemCallback`, always `PASS` (the shield still blocks, the bow still draws). It fires in
    `ServerPlayerInteractionManager.interactItem`, which the client sends for a right-click in the air, on a block or
    entity that did not take the interaction, once per hand. Sneaking: a stop trigger (`stop: true`, kind `use`) for
    any bound item, a bow too. A bow or crossbow (`RangedWeaponItem`) not sneaking: nothing (its arrow is the trigger).
    Anything else: `use`.
  - `ServerEntityEvents.ENTITY_LOAD` (fired at the tail of `ServerEntityHandler.startTracking`, so inside
    `world.spawnEntity` of `RangedWeaponItem.shootAll`, after the velocity is set): a `PersistentProjectileEntity`
    whose owner is a player (not sneaking), whose `getWeaponStack()` is a bound bow or crossbow, and which is within 2
    blocks of the owner's eyes (an arrow loaded with its chunk is not a shot). `getWeaponStack()` (intermediary
    `class_1665.method_59958`) returns the `weapon` field: a copy of the bow or crossbow stack made in the arrow's
    constructor when shot on a server (`ArrowItem.createArrow(world, arrow, shooter, weapon)`), null for a dispenser's
    arrow. One release per player per server tick, so a multishot crossbow's three arrows are one trigger. An
    `arrow-release` trigger, and the arrow is tracked (`SquadArrows`: by its UUID, 10 s, first hit only) unless the
    limiter dropped the release.
  - The mixin `PersistentProjectileEntityMixin` injects at HEAD of `onEntityHit(EntityHitResult)` and
    `onBlockHit(BlockHitResult)`, both declared by `PersistentProjectileEntity` (yarn 1.21.1+build.3; intermediary
    `class_1665.method_7454(Lclass_3966;)V` and `method_24920(Lclass_3965;)V`, checked in the named and the
    intermediary jars, and in the generated refmap). `SquadTriggers.onArrowHit` returns at once for a client arrow or an
    untracked one, and never throws into vanilla. A tracked arrow's first hit, with its shooter online: an `arrow-hit`
    trigger, `hit.position` = the exact point on the block (`BlockHitResult.getPos()`) or the entity's position, and
    `hit.entity` for an entity.
- **The snapshot** is `CommanderSnap.of(player)` at the click (at the hit for `arrow-hit`) plus `trigger: { kind,
  item, hit? }`, `item` being the item id's path (`shield`, `bow`). An entity, in `hit.entity` and `lookEntity`, is
  `{ id, name, type: 'player'|'mob', username?, position }`, `id` the network entity id (`CommanderSnap.entity`, the
  JSON in `SquadTriggerJson`).
- **The call:** async `POST /api/orders/trigger` with `by`, `admin` (perm ≥ 2), `command` = the binding's order,
  `tokens`/`filters`/`take` from `SquadArgs.order(line)`, `stop` for the stop gesture, `snap`. A non-blank answer is
  rendered like any `/bots` answer (`Squad.render`, with its click); a delivered click answers `''`, so nothing is
  shown. The same answer to the same player is shown once per 2 s, because a held right-click repeats every 4 ticks
  and a refused start would answer each one.
- **The limiter** (`SquadTriggerLimiter`, server thread only): per player a bucket of 4 refilled at 4/s; a trigger
  without a token (a stop or an arrow hit too) is dropped silently. A player is forgotten on disconnect, and past 512
  entries the idle ones are dropped.
- Registered from `ServerEntryPoint` (`SquadTriggers.register()`, after `SquadCommand.register()`); the mixin is in
  `paulsbrawls.mixins.json` (`defaultRequire: 1`: a wrong target fails at startup).

## Tests

- **`squad/`:** `npm run check` = lint + tsc + 159 `node:test` tests on fakes (compile, leases, guard, orders and
  reclaim, check/typecheck of the stock commands, HTTP + the real MCP client, supervisor wedge, protocol hardening,
  helpers, agent config drift, `follow`, the `gather` freeze, one test per dependency patch, the vitals, the worker
  pool: same path as the main thread on a synthetic world, the mirror's refcounts, every fallback, a clean stop;
  `defend`: commander-relative threats, the leash, two guards per target, distinct slots, quick shots, a hawkEye
  copy per bot, the slot fallback; friends (`raid.test.ts`: the team only, kept up to date; a guard attacks another
  owner's bot) and `raid` (the march formation, two guards per enemy, archers' fire, the hunt and the end); ladders on a synthetic world: each pathfinder patch, the workers' same paths;
  bound items (`triggers.test.ts`: delivery without restart, the slot, restart, start, stop, starts in flight, the
  report's cap, a throwing listener, `ctx.run`, the reference typecheck, the check route, the snapshot sanitizer); the
  formation helpers (`helpers.test.ts`: `lookDir`/`lineSlots` at yaw 0/90/180/−90 and ranks, `groundAt` on a synthetic
  column, `faceYaw` against mineflayer's conversions, `raiseShield`, `shoot` at a position through hawkEye and through
  the ballistics checked by an independent flight, `bowAim`, `entityOf`); the four item commands
  (`item-orders.test.ts`: the wall along z facing west, shields raised on arrival, a click re-forming it, a guard
  fighting at its slot; `epee`'s target with two guards on it and the anchor rings; the archer line `back` blocks short,
  front threats first, two ranks; `tir`'s volley count and spread, release then hit, the 4 s wait, a friend refused, and
  archers taken from a line returning to their own slots)).
- **Mod:** 54 JUnit tests in `src/test/java/com/paul/brawl/squad/` (incl. `SquadStatusFormatTest`, `SquadFriendsTest`,
  `SquadRaidPlanTest`; for bound items `SquadBindingTest`: the bind line, order names, the lore line and its removal,
  the custom-data round trip on a real `NbtCompound`; `SquadTriggerLimiterTest`: the burst, the refill, per-player
  buckets, the bound map, one release per shot, the repeated answer; `SquadArrowsTest`; `SquadTriggerJsonTest`: the
  trigger, hit and entity JSON and the request body). The stack edits themselves (`ItemStack` needs a bootstrap), the
  hooks and the mixin are checked only in game.
- **Live:** `npm run live-test`, using RCON against the dev server (`run/`) or production
  (`SERVER_PROPERTIES=../server/server.properties`). `LIVE_PATH_WORKERS=N` runs it with N pathfinding workers.
  On the dev world only, it builds a ladder high over the world and checks that a bot follows a climbing bot up it with
  `follow`, then with `defend`.
- **Load:** `npm run bench:load` and the other `bench:*` tools ([squad/bench/README.md](../../../squad/bench/README.md)).

## State on the production server (`server/`, as of 2026-10-29)

- **The mod jar** in `server/mods/` has `/bots` and `/bots equip`. Universal Shops was removed (backup in
  `server/mods-backup/`), and RCON is on (port 25575, password only in `server.properties`).
- **Runtime config:** `squad/squad.json` (production port and token) and `server/squad.properties`, which has the same
  token and the absolute `claudeDir`.
- **Live test,** three runs on 2026-10-27. The last one passed 4/5: `come`, reclaim (the archer shot the husk and
  went back to `follow`), despawn. `gather` failed only because that spawn had no tree within 48 blocks.
- **Real use:** a roster of `Guard1`–`Guard3` (tag `guard`) and `Archer1`–`Archer2` (tag `archer`), all owned by
  PUALHubert. Orders so far: `follow`, `attack`, and `defend` with 5 bots.

## Not verified yet

- **Authoring:** `/bots create` has **never run a real model turn** (no `squad-author` session yet), and neither
  have `/bots fix`, `trial_run` from an agent, or `/bots ticket`. Only the MCP flow is tested, with the official
  client on fakes. The opencode backend is untested.
- **Helpers never exercised on a real server:** `craftItem`, `smeltItem`, `placeItem`, the chest helpers,
  `exploreUntil`, `bring`, `deposit`.
- **Capacity: measured in [docs/31](../../31-squad-performance-review.md).**
  - **Before the fixes (Paul's laptop, §2):** about 5 bots moving at once ran smoothly; the event loop saturated at 6–8
    moving bots (A* 70–77% of it); 30 standing bots took 62% of the loop.
  - **With today's defaults (a Ryzen 9 9950X3D desktop, no Minecraft client, §11):** 30 bots walking at ELU 0.58,
    gathering at 0.62, every bot at 20 ticks/s, loop p99 ≤ 37 ms. With 14 workers the main thread's ELU was 0.2–0.34,
    at up to 9.2 GB RSS.
  - **Not measured:** the laptop with the client running (the production case), more than 30 bots.
  - **Squad's own code** (the guard proxy, journal, loop budget) is under 0.5% of the busy time.
- **The reworked `defend` and the friendly-fire hook** (2026-10-31) ran only on fakes and JUnit, not yet in a fight
  on a server; nor has the per-bot hawkEye copy.
- **The formation helpers and the four item commands** (2026-10-31) ran only on fakes: never on a server. In
  particular not verified live: the off-hand `use_item` raising a real shield (and staying up through mob noise),
  `raiseShield`'s equip into slot 45, hawkEye's `{ position, isValid: true }` targets and how often its block check
  refuses a point on the ground, the ballistic fallback's accuracy with the arrow's random divergence, and `groundAt`
  with real blocks (slabs, snow layers, water). `CommanderSnap` now sends the entity `id` (`lookEntity`, `hit.entity`),
  so `entityOf` finds a looked-at mob by id; that path has not met a real server either.
- **The mod side of bound items** (2026-10-31): only its JUnit tests ran, and `remapJar` (the mixin and its refmap in
  the jar). Never run on a server: the mixin applying at startup, `/bots orders bind|unbind|bound`, the lore and glint
  on a real stack (and their sync to the client), the use, release and hit triggers, multishot, a held right-click
  against the limiter.
- **`raid` and `/bots raid`** (2026-10-31) ran only on fakes and JUnit: never on a server (the surface, the
  arrival teleport and kit, the start as `Envahisseur`, a real 20-vs-20 fight, 40 bots on one runtime). A raider that
  dies respawns idle (it leaves its order, docs/29 §4) and does not rejoin the raid; one that arrives after the
  timeout is equipped but stays idle.
- **`/bots status` in game:** only its JUnit test ran. **The worker pool's stats** are not in `/api/metrics` or the
  vitals.
- **The worker pool on production:** only the dev server and the bench ran it (live test 5/5 with 4 and 14 workers).
- **A bot given back runs its loop again (fixed 2026-10-31).** `squad.parallel` over the order's own live array
  (`squad.bots`, `squad.roles.x`) also runs `fn` for a bot that joins it while the call runs (a bot reclaimed by another
  order and given back, §6.3), and does not resolve while a reclaimed bot can still come back (`Order.suspended()`,
  looked at again every second, since a death clears the lease stack silently). Before, `defend`, `raid` and `follow`
  left such a bot idle: `defend`'s guards stood still after a shield wall borrowed them, and a `defend` whose bots
  were all borrowed ended. `parallel` over a copy or a single bot is unchanged; the four item commands use
  `parallel(bot, …)` per bot with their own `squad.on('joined')` (`tests/orders.test.ts`).
- **Known, not fixed (docs/31 §11.9):** mineflayer-collectblock adds two listeners per cancelled stalled `mineBlock`
  (`MaxListenersExceededWarning` on sites with many stalls); unreachable logs are searched again by every bot and every
  `mineBlock` call (remembering them per order is recommended, not done).
