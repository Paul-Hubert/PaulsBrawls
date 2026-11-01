---
id: squad.overview
title: Squad — player-owned Mineflayer bots ordered by LLM-written commands (as built)
system: squad
summary: What runs today for /bots — the Node runtime in squad/ (processes, threads incl. the optional reader workers that run A*, bots, leases, orders, the command dialect, authoring over MCP, storage, HTTP API, the patched dependencies, the lag monitor, /api/metrics and the vitals journal) and the mod's thin front in com.paul.brawl.squad (incl. /bots status) — with the live results on the production server, the protocol hardening, and what is still unverified.
tags: [squad, bots, mineflayer, orders, leases, reclaim, authoring, mcp, squad-author, claude-code, kits, 8772, production, performance, patch-package, lag-monitor, metrics, vitals, pathfinding-workers, astar-budget, reader-workers, jobs]
sources:
  - docs/29-squad-design.md
  - docs/31-squad-performance-review.md
  - squad/src/main.ts
  - squad/src/supervisor.ts
  - squad/src/bots/pool.ts
  - squad/src/bots/protocol.ts
  - squad/src/bots/hardening.ts
  - squad/src/bots/pathworkers/offload.ts
  - squad/src/bots/pathworkers/serialize.ts
  - squad/src/jobs/handlers/path.mjs
  - squad/src/jobs/pool.ts
  - squad/src/jobs/worker.mjs
  - squad/src/jobs/batch.mjs
  - squad/src/jobs/entities.mjs
  - squad/src/jobs/snapshot.ts
  - squad/src/jobs/handlers/
  - squad/src/api/block-search.ts
  - squad/src/world/
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
- Performance: patched library hot spots, an A* budget on by default, optional reader workers that run A* over a
  shared world (docs/37 P4), optionally the bots themselves reading that shared world instead of keeping their own
  (`world.shared`, docs/37 P5), and a lag monitor with `POST /api/metrics`, a vitals journal and `/bots status` ([docs/31 §11](../../31-squad-performance-review.md)).

## Processes and threads

| What | Where | Notes |
|---|---|---|
| Supervisor | `squad/src/supervisor.ts` | The parent process (`npm start`). It forks the runtime with `--import tsx`, expects an IPC heartbeat every second, kills the runtime after 10 s of silence (`HEARTBEAT_TIMEOUT_MS`, :15) and restarts it with backoff 1/2/5/10/30 s |
| Runtime, main thread | `squad/src/main.ts` `start()` :35 | **Everything else**: every mineflayer bot (protocol decoding, physics ticks, the pathfinder's look-ahead, and A* unless the workers are on; plugins), every order's script, the leases, the HTTP + SSE + MCP server, the synchronous SQLite journal, the vitals sampler |
| Reader workers (optional) | `squad/src/jobs/pool.ts` `JobPool`, `worker.mjs`; built in `main.ts` `startJobs` | **Off by default** (`workers.count` 0). When on: batches of read-only jobs under a per-tick CPU budget, ticked on one online bot's `physicsTick`; an entity snapshot in shared memory ([docs/37 §8](../../37-squad-worker-reads-plan.md)). Job types: the bots' A* (`path`, docs/37 P4), `findBlocks` (P6: mineflayer's `findBlocks` over the shared world, used by `mineBlock`), `aim` (P3) and the trivial `echo`. They replaced docs/32 D's pathfinding worker pool |
| Shared-world writer (optional) | `squad/src/world/shared-world.ts` `SharedWorld`, `writer.mjs`, `store.mjs`; built in `main.ts` when `world.enabled` | **Off by default.** One copy of the bots' chunks in SharedArrayBuffers, decoded by this thread and readable by any thread (`reader.mjs`). P1 of [docs/37](../../37-squad-worker-reads-plan.md) (§9 there is the as-built): read by `world.verify` and, with the reader workers on, by the `findBlocks` job (P6, §10 there). With `world.shared` (P5, §13 there) the bots read it too, and this thread is the only one that decodes a chunk |
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
| `workers.count`, `workers.tickBudgetMs` | **0** (off), **40** ms (`config.ts` `WorkersConfig`) | The reader workers of docs/37 (an integer up to 16, capped at the cores minus one by `jobWorkerCount`; a budget above 0 and at most 50 ms per 50 ms tick). With them on, the bots' A* runs there. `pathfinding.workers` (the old pool's key) is an alias, read only when `workers.count` is not set |
| `world.enabled` | **true when `workers.count` > 0 or `world.shared`**, else false (`parseConfig`) | The shared world the workers read. An explicit `false` with workers on keeps A* on the main thread (`main.ts` warns); with `world.shared` it is a `ConfigError` |
| `world.shared` | **false** (`config.ts` `DEFAULT_WORLD`) | docs/37 P5: the bots read the shared world (below) instead of keeping their own. Off until the defaults are flipped after the final measurements |

Why these defaults (measured on a desktop, [docs/31 §11](../../31-squad-performance-review.md)): the budget was better
than none in every moving phase at 10–30 bots; with it, the main thread was not saturated at 30 moving bots, and
docs/32 D's workers cost about 9 GB of RSS at 30 gathering bots and did less gather work. A* on the reader workers
(docs/37 P4) costs ~60 MB a worker, walks as well or better and cuts the main thread's ELU about 2×, but was not shown
to gather as well at 30 bots ([docs/37 §12.1](../../37-squad-worker-reads-plan.md)): `workers.count` stays 0.

**A* on the reader workers** (docs/37 P4; it replaced docs/32 D's pathfinding worker pool, whose workers each parsed
their own copy of every chunk):
- **What moves:** only the pathfinder plugin's own planning, through the `bot.pathfinder.searchOffload` hook the patch
  adds (`bots/pathworkers/offload.ts` `install` :174, installed at spawn by `bots/pool.ts` `withPathSearch` :325). A
  caller's synchronous `getPathTo` stays on the main thread. The bots, physics, look-ahead and scripts stay there too,
  so O2 (the real bot) and O4 (instant reclaim) hold.
- **The probe:** a search that can cross first runs on the main thread for at most 3 ms (`DEFAULT_PROBE_MS`, the
  plugin's own A*; all probes together at most 10 ms per 50 ms window, `PROBE_BUDGET_MS`). Most of gather's searches end there and are answered at once; the others move
  to a worker, and the bot walks the probe's best path meanwhile. Without it, gather's searches were reset by nearby
  block changes before a worker could answer (docs/37 §12).
- **The world:** the shared world of docs/37 P1, which follows every bot's packets from its first one (`pool.ts` :282).
  Nothing is mirrored or kept per worker. A search is submitted once the writer has applied what the bots heard
  (`SharedWorld.applied` :422), so a block change heard just before it is in the store.
- **The job:** one search is one `path` job (`jobs/handlers/path.mjs`): mineflayer-pathfinder's own `AStar`,
  `Movements` and goals over a stand-in bot (blocks from the store; inventory, effects and the Movements' settings
  from a snapshot sent with the job, `serialize.ts`), run in slices, one per tick, each slice its share of the
  worker's `workers.tickBudgetMs` (an elastic job type: `elasticMinMs` 2 ms, `path.mjs` :40; a search alone takes up
  to 40 ms a tick, ten share it; one that has computed 50 ms keeps a quarter of its share when others follow it; the
  batch's last slice leaves up to 5 ms unused, or the worker misses the next dispatch). The search's state stays on
  its worker (the pool pins a continued job). Each slice answers `progress` (the pool's `onProgress`): the chunks it
  entered, and the best partial path on the first slice and then at most every 250 ms (`PROGRESS_MS`). Ticks where its worker had no budget left for it do not count
  against `thinkTimeout` (`run` :80), as the main-thread A* budget's waits do not.
- **Memory:** each reader worker's V8 heap is sized (`main.ts` `READER_HEAP`: young 16 MB, old 512 MB). A worker
  holds ~26 MB after a GC; without the cap each isolate let A*'s garbage grow to 335–442 MB against V8's default
  limit. Measured live at 30 gathering bots: 2.0 / 2.2 / 2.45 GB of RSS with 1 / 4 / 8 workers (docs/37 §12.1).
- **Blocks:** `world/blocks.mjs` `BlockTemplates` :22: one prismarine `Block` per state id, built once, specialised by
  position (`at` :42: `Object.create(template)` + position); `StoreWorld` :54 is prismarine-world's sync
  `getBlock`/`raycast` over the store (for look-at and place goals). No biome, light or block entity.
- **On the main thread** (`OffloadedSearch`, `offload.ts` :311): the start node until the worker reports, then its
  partial paths, then its path as `Move` objects. Goals are serialized by class (`serialize.ts`; `GoalFollow` becomes
  a `GoalNear` snapshot and the main thread keeps `hasChanged`). The plugin's `path_reset`, `goal_updated`,
  `path_stop` and the bot's `end` cancel the job (its state on the worker is dropped); a newer search supersedes it.
- **Fallbacks to the main-thread search** (the same search from the start, under `pathfinding.astarBudgetMs`),
  counted by reason in `stats()` (:296): `goal`, `movements` (cannot cross threads), `noDimension`, `noColumn` (the
  bot's column is not live in the store), `noWorld` (the writer disabled), `noWorker` (no live worker: the pool would
  run the job inline, where the plugin's own search is the better one), a failed job (`threw`, `workerDied`,
  `lostInput`, `clone`, `unknownType`, `unavailable`, `stopped`, `late`; the pool retries a job whose worker died
  once, on the restarted worker), and `deadline`: no sign of life for `thinkTimeout` + 2 s (`DEFAULT_GRACE_MS`
  :149). `/api/metrics` shows them as `paths`.

**The bots on the shared world** (`world.shared`, docs/37 P5; the as-built and the measurements are docs/37 §13):
- **How:** `bots/pool.ts` gives `createBot` `plugins: { pathfinder, blocks }` with `SharedWorld.blocksPlugin()`, which
  replaces mineflayer's internal blocks plugin (no file under `node_modules` changes). `world/blocks-plugin.ts` is a
  port of mineflayer 4.39's `lib/plugins/blocks.js` (`blockAt`, `findBlocks`, `findBlock`, `canSeeBlock`,
  `waitForChunksToLoad`, digging's `_updateBlockState`, signs, paintings, the chunk-batch acknowledgements, the
  `blockUpdate`/`chunkColumnLoad`/`chunkColumnUnload` listener proxy); `bot.world` is a `SharedBotWorld`
  (`world/bot-world.ts`): prismarine-world's sync API over the store, blocks from the per-state templates of
  `world/blocks.mjs`. The chunk packets reach only `SharedWorld` (P1's routing: holders, primary, forwarding);
  `protocol.ts` `SHARED_WORLD_PACKETS` also reads `map_chunk`'s and `update_light`'s light as raw bytes.
- **What a bot sees:** the columns it holds, once the writer has published them (a few ms after the packet;
  `chunkColumnLoad` then). A block change it hears (or digging's prediction) is shown to it at once by its overlay,
  with mineflayer's `blockUpdate` events in the packet's handler, until the store shows it (or 5 s,
  `OVERLAY_MS`). Block entities per column, one copy for every bot holding it. No light (0) and no biome (the first).
- **`findBlocks` by block ids** (what the helpers pass) is the store's search on the main thread over the bot's own
  columns (`find-blocks.mjs` with a column filter): mineflayer's answer in ~0.1 ms instead of 15 ms. With a matcher
  function it is mineflayer's walk over `blockAt`.
- **The writer's restart** rebuilds the bots' columns from the store itself (`encode.mjs`; the bots have no world to
  re-send from) and the payloads not acknowledged yet (kept until then); after three deaths in a minute the main
  thread runs the writer's logic itself (`applyOps`) instead of leaving the bots blind.

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
  ticks is not changed under it (`copyMove`). The reader workers run the same `lib/`, so they find the same paths.

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
  other }, resets, deafTrips }] }` (`Metrics` :52). `text` is the French line for players. With the reader workers
  on, a `jobs` object too (`JobStats` in `jobs/pool.ts`: per job type submitted, done, carried, late, failed, inline,
  latency p50/p95; per worker its budget use; the queue; the dispatcher's own time per tick), summed per minute into
  the journal row's `data.jobs`, and `text` ends with « calculs : … ».
- **The journal's `vitals` table** (`journal/journal.ts` :71): one row per minute (time-weighted ELU, worst p99, the
  slowest bot, counts summed, details as JSON in `data`), written by `saveVitals` (:146), which deletes rows older than
  7 days (`VITALS_KEEP_MS` :46). Never the hot stream (R44).
- **`/bots status`** (perm 0, `SquadCommand` :90, :367): ELU, loop p99 and the slowest bot's ticks/s from
  `/api/metrics`, formatted by the Minecraft-free `SquadStatusFormat` (« surchargé » past the warning thresholds).

## The runtime (`squad/src/`)

| Area | Files | What it does |
|---|---|---|
| Bots | `bots/pool.ts`, `plugins.ts`, `hardening.ts`, `protocol.ts` | Dynamic pool, logins 4 s apart, reconnect with backoff, version pinned to 1.21.1, `viewDistance: 'short'`. Plugins: pathfinder, pvp, armor-manager, tool, collectblock, auto-eat (hawkEye, which aimed the bows, is gone since docs/37 P3: `shoot` aims with `aim/`). Pathfinder bounded (searchRadius 64, thinkTimeout 5 s, `hardening.ts`), its library patched and its A* budgeted (above). With `world.shared`, mineflayer's blocks plugin replaced by the shared world's and the chunks' light read as bytes (above). Per-bot vitals counters. Protocol hardening, below |
| Roster | `roster.ts` | Bots, owners, tags in `.squad-data/roster.json`; the runtime is its only writer |
| Leases | `leases.ts` | A lease stack per bot (depth 4). `plan` :84 grants idle bots first, then busy ones for `take: 'reclaim'` roles, all or nothing. `apply` :106 runs the old order's cleanup before reuse. `release` :130 hands a bot back to the live order below |
| Orders | `orders/runner.ts`, `order.ts`, `guard.ts`, `claims.ts` | `start` :141 (tracked per binding, below) → `launch` :147 resolves, compiles (once per version) and runs. Each script gets a **lease-guarded Proxy** of each bot (`guardBot` :81): calls check the lease, listeners and timers are tracked, chat is rate-limited, `quit` is refused. Every leave and every end runs the R4/R5 abort sequence. Claims are shared across orders. `trigger` :208: a bound item's click delivers to, restarts, starts or stops the player's order of that command (below) |
| Dialect | `api/squad.ts`, `api/helpers.ts`, `api/scope.ts`, `reference/squad.d.ts` | `squad.parallel`, `squad.tasks` (work queue, re-queues the work of a leaving bot), claims, acquire/release, `ctx.commander` (with `on('trigger')`, `off`, `next`), `ctx.run`. Voyager-named helpers (`mineBlock`, `craftItem`, `goTo`, `shoot`…), and the formation helpers of bound items (`lookDir`, `lineSlots`, `groundAt`, `faceYaw`, `raiseShield`, `entityOf`; below) |
| Scripts | `script/compile.ts`, `manifest.ts`, `check.ts` | ESM rewritten in place, keeping lines (`vm.Script` filename `squad:<author>/<name>@vN.mjs`); loop budget + fences; manifest and args (French errors for players); `check_script` = compile + dry module run + typecheck (`BLOCKING_CODES` :40) |
| Authoring | `authoring.ts`, `http/mcp.ts`, `agent/` | `cmd-…` tickets (30 min; manual 2 h). Seven MCP tools (`get_api_reference`, `get_context`, `list_commands`, `read_command`, `check_script`, `trial_run` ≤ 60 s on idle bots, `submit_command`). Claude Code config in `agent/claude-code/`, opencode config in `agent/opencode.json` |
| Storage | `store/commands.ts`, `journal/journal.ts` | `.squad-data/commands/<uuid>/<name>/meta.json` + `vN.mjs` (append-only, shares, revert); SQLite `squad.db` (WAL, `synchronous=NORMAL`), one row per order with its full report, and one `vitals` row per minute |
| HTTP | `http/server.ts` | 21 `POST /api/...` routes (incl. `/api/metrics`, `/api/orders/check`, `/api/orders/trigger`), `GET /events` (SSE: `hello`, `notice`, `state`; notices buffered while no mod listens), `POST /mcp/squad`; bearer `PAULSBRAWLS_SQUAD_TOKEN` |
| Stock | `src/stock/*.mjs` | `come`, `follow`, `defend`, `gather`, `deposit`, `attack`, `bring`, `raid`, and for bound items `mur-de-boucliers`, `epee`, `ligne-archers`, `tir`. Usable by everyone, and the agent's examples. `defend`, `raid` and the four: below |

**Block searches** (`api/block-search.ts`, [docs/37 §10](../../37-squad-worker-reads-plan.md), P6). `mineBlock`, so
`gather`, finds its blocks with `findBlockPositions`: mineflayer's `bot.findBlocks({ matching, maxDistance, count })`
(gather: every `_log` within 48, count 64). With the reader workers and the shared world both on (`workers.count` > 0
and `world.enabled`; `main.ts` calls `useBlockSearch`), it is a `findBlocks` job instead (`jobs/handlers/find-blocks.mjs`
over `world/find-blocks.mjs`): the same positions in the same order, read from the store on a worker in 0.1–0.3 ms,
where mineflayer spends 15–40 ms on the main thread (it builds a `Block` for every block of every section whose palette
it cannot rule out, all-air sections included). A search the store cannot answer for that bot (no dimension yet, its
own column not in the store, the job failed or 5 s late) runs on the bot. `findBlock` stays synchronous on the bot's
own world (a script gets the `Block` at once). With either key off (the defaults), every search is `bot.findBlocks`.

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

## Orders bound to items — the helpers and the four stock commands (docs/29 §5.4 items 5, 7–8)

**Any item carries any order** (Paul, 2026-10-31, after the first build). The item and the trigger say only *where* the
player points; every command reads that the same way, whatever the item or the trigger kind, and from `/bots order`
with no trigger: `pointedTarget` below. The shield/sword/arrow/bow names in docs/29 §5.4 are examples, not a mapping: a
stick can carry `tir`, a bow can carry `mur-de-boucliers` (the wall forms where the arrow lands).

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
  `[x, y, z]`, a block, a snapshot ref). Squad's own aim since docs/37 P3 (`aim/`; hawkEye is gone):
  - **The arrow** (`aim/arrow.mjs`), read from the 1.21.1 server: from the eyes − 0.1; a full bow 3 blocks per tick plus
    the shooter's last move (y dropped on the ground), a crossbow 3.15 and no shooter move; per tick the segment is
    checked (blocks, then hitboxes grown by 0.3), then move, × 0.99 (0.6 in water), y − 0.05.
  - **The solver** (`aim/solve.mjs`, the same code as the `aim` job of the reader workers or inline on the main thread):
    leads an entity's centre to where it will be at the release plus the flight; the pitch is a root of the vertical
    miss, in closed form, warm-started from the draw's last answer; then one checked flight tick by tick: an
    Amanatides–Woo voxel walk against each state's collision boxes and slab tests against every creature of the
    entity snapshot. The first thing hit decides: the target or another enemy is a hit, a friend (the order's isFriend
    players, the bots of the same owners) or a block blocks; unknown blocks count as air. The low arc first, the high
    arc when a wall blocks it (over a friend too with `aim.overFriends`, on by default, docs/37 D6). A position is not led: the low arc through it (`bowAim`'s, which stays
    exported), reached when the arrow comes down within 1.5 blocks of it.
  - **The draw** (`aim/draw.ts`): update 0 before the draw (a wall on both arcs: « no clear line of fire » at once,
    nothing drawn; a friend in the line: drawn anyway), then the draw (`use_item`); updates on the ticks of `aim.schedule` (`[0, 10, 11, 12, 13, 14, 20, 21, 22,
    23]`), each asked two ticks ahead when it is a job; every tick the look is interpolated to the newest answer,
    arriving on the next update's tick; the release (`block_dig` 5) on tick `aim.drawTicks` (24), after the packet that
    carried the last look. A late answer keeps the last aim. A blocked line at the release is held up to 20 ticks,
    asked again every tick, then the bow is put down unfired (a hotbar switch away and back) and the shot refused.
    A target that dies mid-draw is shot at the last aim. auto-eat is paused for the draw, and `shoot` lets a meal
    finish before it takes the hand.
  - The target's velocity is a least-squares slope over its last positions (the server sends a player's every 2 ticks
    and a mob's every 3, so a one-tick velocity reads 0, 0, 3v). `aimStats()` counts draws, refusals, holds, solves
    and the lead's error (`bench:fight` prints them).
- `entityOf(bot, ref)`: by `id` in `bot.entities`, else a player by `username`, else the nearest entity of that `name`
  within 4 blocks of the ref's position, the last only for a ref without an id: the id is the same for every client,
  so a ref whose id the bot lacks is dead or out of its sight, and another zombie next to where it stood is not it.
- `isFriend` accepts a snapshot entity too (it reads `type` and `username`).
- `pointedTarget(bot, at, { near = 4, filter } = {}) → { position, entity, pending }`: where the commander points.
  - `position`: an `arrow-hit`'s `trigger.hit.position`; else the crosshair entity's position (`lookEntity`); else
    the top centre of `lookBlock` (x + 0.5, y + 1, z + 0.5); else null (the sky).
  - `entity`: the hit or crosshair entity (through `entityOf`) when it qualifies; else the qualifying entity nearest
    `position` within `near` blocks, as this bot sees it (`nearestEntity` from the point); else null. `near: 0` takes
    only the exact one.
  - Qualifying: a living thing by minecraft-data's entity `type` (1.21.1: `player`, `mob`, `hostile`, `animal`,
    `passive`, `ambient`, `water_creature`; the registry's type wins over `entity.type`), so not an item, an XP orb,
    an arrow or other projectile, a vehicle, a frame, a display or the armor stand (type `living`); valid; not of the
    order's team (the order's `friends`, read through the guarded bot, as `isFriend`); not a spectator (game mode 3);
    and `filter(e)` when given.
  - `pending`: true for an `arrow-release` (its hit follows; until then position and entity are the look's).
  - Pointing at a friend gives the qualifying entity nearest them, else no entity and the friend's position: a
    command decides what that means (`tir` refuses, `epee` defends the commander).

**What the four commands share** (`src/stock/mur-de-boucliers.mjs`, `epee.mjs`, `ligne-archers.mjs`, `tir.mjs`):
- `ctx.commander.on('trigger', …)` is their first statement, so every later click is delivered (re-aim), never a restart.
- One state object with a version number. A click recomputes it; every bot's loop looks again every 100–200 ms and
  never awaits a long goal. Walking is a pathfinder goal set directly and kept while it is the same spot (`GoalBlock`
  on a ground slot; `GoalNear` range 2 after 10 s without reaching it, or for a slot off known ground). In
  `mur-de-boucliers` and `ligne-archers` the 10 s count from each walk to the slot: a bot that had reached it and walks
  back (from a fight, pushed off) starts again with the exact goal (`heading.reached`; found live, docs/29 §16). A
  fight ends at once on a new version (`attack`'s `until`).
- The point of the two lines: `pointedTarget(…).position` (an arrow's hit, else the crosshair's creature, else the top
  of the block) through `groundAt` when within `distance` horizontally, else the commander's position +
  `lookDir(yaw)` × 5 (`mur-de-boucliers`) or × 10 (`ligne-archers`) through `groundAt`; the raw point when no bot
  knows that chunk. `groundAt` runs with whichever bot knows it. An `arrow-release` does not re-form a running line
  (its hit does); as the order's first snapshot it is used, provisionally.
- `epee` and `tir` aim with `pointedTarget(…, { near })` (param `near`, default 4, 0–16), asked of each bot in turn
  until one sees a qualifying entity.
- One loop per bot, started again for a bot that comes back from another order (`squad.on('joined')`). A token per bot
  ends a stale loop: a returning bot gets the same guard object, so the old loop's calls would pass again.
- A line keeps a bot's slot while it is away (reclaimed); a click, or a bot without a slot joining, re-forms it. The
  slots go to the bots by their position along the line (the front-most to the front rank), so no two paths cross.

| Command | Example item | Roles | Params | As built |
|---|---|---|---|---|
| `mur-de-boucliers` | shield | `guards` (`hasItem: 'shield'`, min 1, reclaim) | `distance` 24, `spacing` 1 (1–3), `reach` 4; until stopped | `lineSlots(point, yaw, n, { spacing })` through `groundAt`, at the point above. Shield down to walk; on the slot `faceYaw(yaw)` and `raiseShield`, re-asserted every look. A hostile, or a non-friend player who is not a spectator, within `reach` of the slot: shield down, `attack` leashed to the slot (radius `reach` + 1), then back to the slot. « Mur de boucliers rompu. » |
| `epee` | sword | `archers` (bow, reclaim), `melee` (no bow, reclaim) | `radius` 16, `seconds` 60, `near` 4; until stopped | `pointedTarget`'s entity (the one pointed at, or the nearest within `near` of the point) is the target, tracked by its id from then on: archers shoot it, at most 2 guards fight it, the other guards fight threats within `radius` of it (leashed to it), a bot that does not see it holds near the commander. Dead or gone (« Cible abattue (zombie). » when it was last within 20 blocks of a bot, else « Cible perdue de vue (…) : je reviens te défendre. ») or `seconds` (« Cible toujours debout après … ») → defend the commander. A point and no entity: defend that point (threats within `radius` of it, guards on a ring of 3, archers of 6 around it, by goals; fights leashed to it). The sky, or a friend with nobody near them: defend the commander as `defend` does (rings via `follow` with `offset`). A release without an entity changes nothing (its hit decides). Guards at most 2 per threat, archers prefer an untaken one and step 1–2 blocks aside after "no clear line of fire" |
| `ligne-archers` | arrow (right-click) | `archers` (bow, min 1, reclaim) | `distance` 24, `spacing` 2, `back` 4, `range` 24; until stopped | Centre = point − `lookDir(yaw)` × `back`, through `groundAt`; two ranks (depth 2) past 8 archers. On its slot an archer faces the view and shoots threats within `range` of the centre: in front of the line (dot with `lookDir` > 0) and untaken first, then in front, then untaken. After "no clear line of fire": 1–2 blocks aside, shooting from there for 3 s, then back to the slot |
| `tir` | bow | `archers` (bow, min 1, reclaim) | `volley` 3 (1–16), `spread` 3, `seconds` 8, `near` 4 (0–16); bounded, `maxMinutes` 1 | The target, from `pointedTarget`: an entity (pointed at, or the nearest within `near` of the point) → shoot it; else the point → a volley there; else « Aucune cible. ». The same from a stick's right-click, a bow's arrow or `/bots order tir`. A release with an entity starts on it; without, `ctx.commander.next(4000)`, then the release's look. A friend pointed at with nobody within `near` of them → « X est des nôtres : je ne tire pas dessus. » (never a volley onto a friend's position); an entity no archer sees → « Cible hors de vue des archers. ». Archers never move. An entity: every archer shoots it until dead or gone, or `seconds`. The ground: `volley` arrows per archer at points uniform over a disc of radius `spread`, y from `groundAt`. A later click retargets (a release waits for its hit, the next click). « Volée tirée : 9 flèches. », « Cible abattue (zombie) : 5 flèches. ». Archers reclaimed from a `ligne-archers` return to their slots there |

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
- **A bot given back runs its loop again** (fixed 2026-10-31, passed live the same day). `squad.parallel` over the
  order's own live array (`squad.bots`, `squad.roles.x`) also runs `fn` for a bot that joins it while the call runs (a
  bot reclaimed by another order and given back, §6.3). It does not resolve while a reclaimed bot can still come back
  (`Order.suspended()`, looked at again every second, since a death clears the lease stack silently). Before,
  `defend`, `raid` and `follow` left such a bot idle: `defend`'s guards stood still after a shield wall borrowed them,
  and a `defend` whose bots were all borrowed ended. `parallel` over a copy or a single bot is unchanged; the four
  item commands use `parallel(bot, …)` per bot with their own `squad.on('joined')` (`tests/orders.test.ts`). Live:
  guards a wall reclaimed from `defend` follow the captain about 14 blocks once the wall stops.

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
| `SquadSpawn`, `SquadSpawnPlan` | `/bots squad spawn KIT [n] [owner] [others…]` / `squad despawn [KIT] [owner]` (admin): `n` bots named after the kit, on a ring around the owner at the owner's height (`standNear`: a floor within 6 blocks, never the roof), kit and tag on arrival like `raid`; despawn by owner and kit tag. The plan (arguments, names, ring) is Minecraft-free, JUnit |
| `Squad` | Lifecycle, the SSE loop and the cache, notices (kept for offline players), whitelist, join gate (a bot name from a non-loopback address is kicked), arrival teleport (to the admin, or to a given spot with a callback), `hasPlayed` (spawn refuses names with a `playerdata` file), `equip` |
| `SquadKits` | Kits for archer, guard, miner and farmer (Minecraft-free); `equip` wears armor, holds weapons and puts the shield in the off-hand |
| `SquadAuthoring` | One `squad-author` turn: reserve the slot, open, run the agent, close, announce « Commande X prête » |
| `SquadClient`, `SquadArgs`, `SquadNotice`, `CommanderSnap`, `SquadConfig` | HTTP/1.1 client and SSE framing; argument tokenizing; lines with clicks; exact position and look target (`lookEntity` with its network `id`, only what a crosshair can target: `canHit()`); `squad.properties` |

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
  JSON in `SquadTriggerJson`). `lookEntity` is what a crosshair could target, as in vanilla: not a spectator, and
  `Entity.canHit()`, which is true for living entities and false for arrows, items and XP orbs (a projectile only
  when it can be deflected, like a fireball). Without that filter a bound bow's `arrow-release` snapshot, taken as
  the arrow enters the world in front of the eyes, named that arrow (found live, docs/29 §16).
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

## Bound items on the dev server (live, 2026-10-31)

`live-tests/items.ts` (the Live bullet under Tests) passed on the dev server once the faults it found were fixed
(docs/29 §16): two in the first run, one more after the any-item change. What it showed, with the evidence it checks:
- **The mod:** the mixin applies at startup. `/bots orders bind mur-de-boucliers` puts `custom_data.squad`, the
  lore line « Ordre : mur-de-boucliers » and `enchantment_glint_override` on the held shield (RCON `SelectedItem`);
  `/bots orders bound` lists « Bow : tir »; `unbind` removes all three. A right-click is a `use` trigger: the
  snapshot's yaw is the player's (90) and its `lookBlock` the block looked at. A second click is delivered to the
  same order, and sneak + right-click stops it (« [Bots] « mur-de-boucliers » arrêté. »). A real bow shot gives
  `arrow-release` (`ENTITY_LOAD`), which starts `tir`, then `arrow-hit`. That hit comes from `onBlockHit` at the point
  the arrow struck, a few blocks short of where the player looked, or from `onEntityHit` with the husk.
- **`mur-de-boucliers`:** the guards stand on the slots (RCON `Pos` within 0.2), `Rotation` 90.0 for yaw 90 and 0.0
  after the re-aim, shields up as another client sees them (flags 3). So the off-hand `use_item` raises a real
  shield and `faceYaw` sets the exact yaw. A guard whose shield starts in its inventory gets it into the off-hand
  (`raiseShield`'s equip into slot 45). A husk 2 blocks in front of the line, 11 s after the guards reached it, is
  killed, and each guard is back within 0.8 of its slot. Leaving the order lowers the shields.
- **`tir`:** a volley of exactly 3 arrows per archer; 7 arrows (the captain's and the six) lie within 6 blocks of the
  hit. At a husk: « Cible abattue (husk) : 6 flèches. ».
- **`epee`:** a NoAI husk looked at (`lookEntity` with its id, resolved by `entityOf`) is killed with at most 2 guards
  within 3 blocks of it at once. Then the ground: every bot within 1.8 of its own ring slot (seen: 0.3–1.5).
- **Any item carries any order** (`pointedTarget`, after `2023e12`):
  - `tir` bound to a stick: a right-click on the floor 3 blocks from a NoAI husk names no entity (the crosshair meets
    the floor first), yet the archers kill the husk (the nearest within `near` 4). On empty ground, nothing within 4
    blocks, it fires a volley of 3 per archer, all 6 arrows within 3 blocks of the point.
  - A bow bound to `mur-de-boucliers`, shot from 10 east of the middle 2° down: the release looks at nothing within
    24 blocks, and its arrow lands about 20 blocks ahead. The wall forms on the line through the hit (the guards
    within 0.4 of it, `Rotation` 90), not 5 blocks ahead, where the release alone would put it. Drawing the bow while
    sneaking stops it, and the arrow shot while sneaking starts nothing.
  - `epee` bound to a stick: beside a husk the bots kill it (at most 2 guards on it); then on empty ground they hold
    it, each bot within 1.5 of its ring slot.
- **`ligne-archers`:** the archers walk about 13 blocks to the line 4 blocks short of the point, 2 apart, `Rotation` 0.
- **A bot given back works again:** guards a wall reclaimed from `defend` are back in it once the wall stops, and
  follow the captain about 14 blocks to a new spot (the `squad.parallel` live-array fix).

## Tests

- **`squad/`:** `npm run check` = lint + tsc + 258 `node:test` tests on fakes (compile, leases, guard, orders and
  reclaim, check/typecheck of the stock commands, HTTP + the real MCP client, supervisor wedge, protocol hardening,
  helpers, agent config drift, `follow`, the `gather` freeze, the `findBlocks` job against mineflayer's own search on
  real chunk data and `mineBlock` with and without it (`find-blocks.test.ts`), one test per dependency patch, the vitals,
  A* on the reader workers (`pathworkers.test.ts`: the same path as the main thread on a synthetic world, partial paths,
  cancellation, a timeout, a worker dying mid-search, every fallback, world changes, the budget shared and its waits
  not counted, a silent worker, the plugin's hook, a clean stop, the store's blocks and raycasts, the config; the job
  pool's progress channel and elastic types, `jobs-long.test.ts`);
  `defend`: commander-relative threats, the leash, two guards per target, distinct slots, quick shots, the slot
  fallback; the aim (`aim.test.ts`: the arrow against hand-computed ticks and hawkEye's equations, a still and a
  moving target, the shooter's own movement, the high arc over a wall and over a friend, friends and enemies in the
  line, unknown blocks, the warm start, the schedule's ticks, the turn, the release on tick 24, a late answer, the
  hold and the put-down, a dead target, auto-eat, the inline path over a bot's own world, the `aim` job on a real
  reader worker and on the pool's inline fallback, the config); friends (`raid.test.ts`: the team only, kept up to date; a guard attacks another
  owner's bot) and `raid` (the march formation, two guards per enemy, archers' fire, the hunt and the end); ladders on a synthetic world: each pathfinder patch, the reader workers' same paths;
  bound items (`triggers.test.ts`: delivery without restart, the slot, restart, start, stop, starts in flight, the
  report's cap, a throwing listener, `ctx.run`, the reference typecheck, the check route, the snapshot sanitizer); the
  formation helpers (`helpers.test.ts`: `lookDir`/`lineSlots` at yaw 0/90/180/−90 and ranks, `groundAt` on a synthetic
  column, `faceYaw` against mineflayer's conversions, `raiseShield`, `shoot` (the release, « no arrow left the bow », a
  position on `bowAim`'s arc checked by an independent flight), `bowAim`, `entityOf`); the four item commands
  (`item-orders.test.ts`: the wall along z facing west, shields raised on arrival, a click re-forming it, a guard
  fighting at its slot, a guard pushed off its slot long after the wall formed going back to the exact slot; `epee`'s
  target with two guards on it and the anchor rings; the archer line `back` blocks short, front threats first, two
  ranks; `tir`'s volley count and spread, release then hit, the 4 s wait, a friend refused, and
  archers taken from a line returning to their own slots; any item: `tir` and `epee` on the zombie nearest the block
  pointed at, the volley or the held point beyond `near`, a wall formed at an arrow's hit and not moved by a release);
  `pointedTarget` (`helpers.test.ts`: the point and the target by trigger, `near`, pending, and what does not qualify)).
- **Mod:** 54 JUnit tests in `src/test/java/com/paul/brawl/squad/` (incl. `SquadStatusFormatTest`, `SquadFriendsTest`,
  `SquadRaidPlanTest`; for bound items `SquadBindingTest`: the bind line, order names, the lore line and its removal,
  the custom-data round trip on a real `NbtCompound`; `SquadTriggerLimiterTest`: the burst, the refill, per-player
  buckets, the bound map, one release per shot, the repeated answer; `SquadArrowsTest`; `SquadTriggerJsonTest`: the
  trigger, hit and entity JSON and the request body). The stack edits themselves (`ItemStack` needs a bootstrap), the
  hooks and the mixin are checked only in game.
- **Live:** `npm run live-test`, using RCON against the dev server (`dev/`, `./gradlew runDevServer`; the default) or
  production (`SERVER_PROPERTIES=../run/server.properties`; the world is never changed there). `LIVE_WORKERS=N` runs it with N reader workers and the shared world (A*, gather's block search and the aim there; `LIVE_JOBS` and `LIVE_PATH_WORKERS` are older names; `LIVE_WORLD=1` turns the shared world on alone; `LIVE_WORLD_SHARED=1` makes the bots read it, docs/37 P5).
  `LIVE_ONLY=core|items` runs one group; the test's runtime listens on `LIVE_RUNTIME_PORT` (default any free port).
  - **Core** (`live-tests/run.ts`): connect, `gather`, `come`, reclaim per role, despawn. On the dev world the bots
    start from a camp the test lays (grass and two oaks at 1100,100,1000, cleared inventories), and a ladder built high
    over the world checks that a bot follows a climbing bot up it with `follow`, then with `defend`.
  - **Bound items** (`live-tests/items.ts`, dev world only, a stone arena at 1200,100,1000). A captain, `LiveCaptain`,
    is a plain mineflayer client outside the roster. Its offline UUID owns three guards (sword, off-hand shield) and two
    archers. The runtime alone (`/api/orders/trigger` with written snapshots): `mur-de-boucliers` (wall, re-aim, a husk
    fought at the line, stop), `epee` (a NoAI husk, then the ground), `ligne-archers`, and a guard reclaimed from
    `defend` by a wall that goes back and follows again. Through the mod, with the captain's real clicks and arrows:
    `/bots orders bind|bound|unbind`, `mur-de-boucliers` started, re-aimed and stopped (sneak), and `tir` at the ground
    and at a husk. Any item, any order: `tir` and `epee` bound to a stick (beside a husk, then empty ground), a bow
    bound to `mur-de-boucliers` (the wall at the arrow's hit). Each scenario starts with the bots at the same spots and
    ends by stopping the captain's orders and killing its husks, failed or not, so a failure does not spill into the
    next. The mod scenarios need `dev/squad.properties` pointing the dev mod at the test's runtime
    (`url=http://127.0.0.1:8779`, `token=live-test-token`) and `LIVE_RUNTIME_PORT=8779`; otherwise they are skipped
    ([squad/README.md](../../../squad/README.md)). Ground truth: RCON `Pos`, `Rotation`, `SelectedItem`, arrow counts,
    entities; a raised shield is the living-entity flags (metadata 8: 0x01 hand active, 0x02 off-hand) as the
    captain's client sees the guard.
- **Load:** `npm run bench:load` and the other `bench:*` tools ([squad/bench/README.md](../../../squad/bench/README.md)).

## State on the production server (`server/`, as of 2026-10-29)

> **Since 2026-10-31 production is `run/`** (`./gradlew runServer`, port 25565: Paul's world, production's mods and
> settings), with `squad/squad.json` on port 25565 and `run/squad.properties` holding the runtime's token and the
> absolute `claudeDir`. Dev tests run in `dev/` (`./gradlew runDevServer`, dev/README.md). The notes below describe
> the earlier setups.

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
- **The reworked `defend` and the friendly-fire hook** (2026-10-31) have not been in a real fight on a server, nor
  has the aim of docs/37 P3 beyond `bench:fight` and the live items tests. Live so far: guards holding their ring around the commander (the
  bound-item scenarios), and one archer shooting a husk (the core reclaim scenario).
- **The formation helpers and the four item commands** passed live on the dev server (above). Still not verified
  live: a shield held up for minutes through mob noise (the live walls held for seconds), `groundAt` on anything but a flat floor (slabs, snow layers, water), and fights against mobs that move
  (every live husk had NoAI). The any-item reading passed live too (above); not live: a crossbow, `ligne-archers` from a
  bow, a friend pointed at.
- **The mod side of bound items** passed live on the dev server (above). Still not run on a server: multishot (a
  crossbow), a held right-click against the limiter, the lore and glint as a real client renders them (only the
  stack's data was read), a rebind, and a bound item given to another player.
- **`raid` and `/bots raid`** (2026-10-31) ran only on fakes and JUnit: never on a server (the surface, the
  arrival teleport and kit, the start as `Envahisseur`, a real 20-vs-20 fight, 40 bots on one runtime). A raider that
  dies respawns idle (it leaves its order, docs/29 §4) and does not rejoin the raid; one that arrives after the
  timeout is equipped but stays idle.
- **The reader workers (docs/37 P2, P3, P4, P6):** off by default. A* on them ran on fakes (`tests/pathworkers.test.ts`),
  the dev server's `bench:load` and the live core tests (docs/37 §12); the `findBlocks` job on fakes over real chunk data
  (`tests/find-blocks.test.ts`), in `bench:load` gather (docs/37 §10.4) and the live core test (7/7); the `aim` job in
  `bench:fight` and the live items tests (docs/37 §11). Never on production.
- **`world.shared` (docs/37 P5):** off by default. Ran on fakes over real chunk data against mineflayer's own world
  (`tests/shared-bots.test.ts`), the live core and items tests (with and without `LIVE_WORKERS=4`), `bench:load` and
  `bench:fight` (docs/37 §13). Never on production.
- **`/bots status` in game:** only its JUnit test ran. The A* offload's counters are in `/api/metrics` (`paths`), not
  in the vitals journal.
- **Known, not fixed (docs/31 §11.9):** mineflayer-collectblock adds two listeners per cancelled stalled `mineBlock`
  (`MaxListenersExceededWarning` on sites with many stalls); unreachable logs are searched again by every bot and every
  `mineBlock` call (remembering them per order is recommended, not done).
