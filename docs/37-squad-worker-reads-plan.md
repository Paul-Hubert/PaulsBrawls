# 37 — Squad: read-only work on worker threads, one shared copy of the world (plan)

> Plan, 2026-11-01. It follows the measurements of [docs/36](36-squad-fight-performance.md) and Paul's decisions of
> the same day. Every expected number is an estimate from docs/36's profiles and is re-measured after each phase with
> `bench:fight` and `bench:load`. **Built so far: P0** (the hawkEye leak), **P1** (the shared world, off by default; as
> built in §9), **P2** (the job queue, dispatcher and reader workers, off by default; as built in §8), **P3** (Squad's
> own aim, hawkEye removed; as built in §11), **P4** (A* on the reader workers over the shared world, the old per-worker
> mirror retired; as built in §12) and **P6** (gather's block search as a `findBlocks` job, off by default; as built in
> §10). The rest is a plan.

## 0. Owner decisions (Paul, 2026-11-01)

- **D1.** Every read-only calculation runs on worker threads: raycasts, aiming, pathfinding, block searches. It runs
  **in batches**, with a **per-worker budget of 40 ms per 50 ms tick**, through a queue that hands batches to the
  workers.
- **D2.** Writes to the world (decoding chunk packets, applying block changes, dropping unloaded chunks) run on **one
  dedicated writer thread**, at the same time as the readers.
- **D3.** **One copy of the chunks** for everyone: a hash map keyed by chunk (dimension, x, z), shared by every thread,
  with automatic removal (a chunk goes when no bot holds it) and caching. In the last phase the bots themselves (their
  world, physics, `blockAt` in scripts) read it too, instead of each keeping ~313 columns of its own.
- **D4.** **Plain worker threads** (`node:worker_threads`, `SharedArrayBuffer`, `Atomics`), no native addon.
- **D5.** Archers use **our own aim solver** in the workers, not hawkEye. It aims **10 times per draw**: once at the
  start, once 500 ms in, the middle 4 ticks and the 4 ticks before the release. In between, the bow **turns smoothly**
  to arrive at each new aim exactly on its tick. Its line of fire is checked against blocks **and every player's
  hitbox**.
- **D6** (Paul, after P3's measurements, §11.6). **Archers lob over a friend in the line:** `aim.overFriends` is on by
  default, so the high arc goes over a friend as over a wall. Measured: refused shots 4.5–9 % instead of 19–32 %, at
  fewer kills per arrow (3.2–4.0 % instead of 3.5–5.2 %) and about +0.1 ELU, from more arrows in the air on 4–5 s lobs.

## 1. Where we start (docs/36)

At full strength, a 20 v 20 fight keeps the main thread busy 60–66 % of the time (on the Ryzen 9 9950X3D).

| Cost | % of main-thread busy | Read or write | Phase |
|---|---|---|---|
| hawkEye's aim, every tick of every drawing archer | 45 | read | P3 |
| ↳ its block raycasts (a new prismarine `Block` per voxel) | 31 | read | P3 |
| packets: decode + mineflayer handlers | 26 | write (bot state); chunk parsing moves to the writer in P5 | P5 (chunks) |
| own physics | 9 | write (moves the bot) | stays; cheaper reads in P5 |
| A* (`planPath`) | 6 | read | P4 |
| GC | 5 | | falls with fewer `Block`s |
| Squad's own code | 2.5 | | stays |

Also measured:
- **Memory:** every bot holds its own parsed world, ~35 MB per bot.
- **The pathfinding workers** (docs/32 D) share the raw chunk bytes, but each worker parses them into its own world:
  14 workers grew the process to ~9 GB. So today there is one copy per bot plus one per worker.
- **Logins:** each one decodes ~0.4 s of chunks on the main thread, so 40 logins stall it up to 1.6 s.

## 2. Architecture

```
 main thread (the bots: sockets, packets, physics, controls, scripts, orders)
   │  raw chunk payloads, block changes (deduplicated)        ▲ "published" events (chunkColumnLoad…)
   ▼                                                           │
 writer thread ──writes──►  SHARED WORLD (SharedArrayBuffers)  ◄──reads── reader workers ×N
                            • column index: hash map (dim,x,z)            (aim, raycast, A*, findBlocks)
                            • sections: 16³ state ids (uint16)                  ▲          │
                            • per-state tables (boxes, flags)                   │ batches  │ results
                            • epochs (safe reuse)                               │          ▼
 main thread ──writes──►    ENTITY SNAPSHOT (per tick)  ◄──reads── readers   dispatcher (main thread):
                                                                              queue, priorities, deadlines,
                                                                              40 ms/worker/tick, callbacks
```

### 2.1 The shared world (D3)

- **Sections.** A section is a 16 × 16 × 16 array of block state ids, `Uint16` (1.21.1's highest state id is 26 683),
  8 KB. Sections live in large `SharedArrayBuffer` pages (e.g. 1 024 sections = 8 MB a page); a new page is announced
  to every thread once. An all-air section is not stored (index 0 = air).
- **Columns.** A column is a slot with its `minY`, `height`, the page/offset of each of its sections, a version, and a
  state: `live`, or `cached` (held by no bot, §2.3).
- **The index.** A hash map in a `SharedArrayBuffer`, open addressing, keyed by (dimension, chunk x, chunk z):
  - Only the writer changes it.
  - **Publishing:** the writer fills the column's slot, then stores its key with `Atomics.store`. A reader that
    finds the key (`Atomics.load`) sees a complete column.
  - **Removal:** a tombstone.
  - **Lookups:** any thread, no lock, no message.
- **Safe reuse (epochs).**
  - Every reader (each worker; the main thread in P5) publishes the epoch of the batch it is reading in.
  - Memory freed at epoch *e* is reused only once every reader is past *e*.
  - A batch lasts at most one tick (40 ms), so memory is reused about two ticks after it is freed.
- **Per-state tables,** built once from the registry and shared read-only:
  - each state's collision boxes (a packed `Float32Array` with offsets);
  - its flags (empty, solid, liquid, climbable, water-logged…).

  Every reader uses these instead of building a prismarine `Block`, which is today's hottest function
  (`fromStateId`).
- **Not in the store:**
  - **Biomes and light:** nothing Squad reads needs them.
  - **Block entities:** they stay on the main thread, per column (P5).

### 2.2 The writer thread (D2)

- **It receives from the main thread,** batched per macrotask like today's mirror:
  - each bot's chunk payloads (`map_chunk`, the raw `Buffer`, transferred, not copied);
  - its `unload_chunk`s;
  - block changes, deduplicated across bots (N bots hearing one change send it once, as `pathworkers/client.ts`
    already does).
- **It decodes** a column's paletted sections (prismarine-chunk's format) straight into `Uint16` sections, applies
  changes, and keeps the reference counts by bot. It frees a column when the last bot lets it go (§2.3), and answers
  "published (dim, x, z)" so the main thread can emit `chunkColumnLoad` for the bots (P5).
- **A chunk already held by another bot is not decoded again:** its block changes keep it current. A re-send to the
  same bot replaces it.
- **Only this thread writes the store.** The main thread writes nothing there; it posts.

### 2.3 Removal and caching

- **Automatic removal:** a column whose last holder unloads it, changes dimension or disconnects leaves the index.
- **The cache:**
  - Such a column stays as `cached` for `world.cacheSeconds` (60), up to `world.cacheColumns` (2 000), oldest first.
  - Readers treat a `cached` column as unknown, because no bot receives its block changes, so it may be stale.
  - When a bot receives it again, the writer compares a hash of the payload, and if it is identical, publishes it
    `live` without decoding. This saves the decode on respawns and on walking back.
- **Per-state templates** (P5): `blockAt` returns a prismarine `Block` built once per state id and specialised by
  position (`Object.create(template)` + position). This replaces `fromStateId` + `new Block` + `Biome` +
  block-entity lookup per call.

### 2.4 The entity snapshot

- **Every tick, the main thread writes** one row per entity any bot knows into a double-buffered `SharedArrayBuffer`:
  - entity id (they are the server's, the same for every bot);
  - type;
  - position;
  - velocity, from the last two positions;
  - width, height;
  - an army/owner id (friends = bots sharing an owner, as `isFriend`).
- **Readers use it** for the aim's lead and for the hitbox raycasts.
- **A batch names the snapshot epoch it was planned on.**

### 2.5 The job queue and the workers (D1)

- **Submitting:** `jobs.submit({ type, priority, deadlineTick, input })` returns a promise; resolving it is the
  callback.
  - **Types:** `aim`, `raycast` (blocks and/or hitboxes), `los` (can A see B), `path` (A*), `findBlocks`.
  - **Priorities:** aim updates near the release first, then raycasts and LOS, then paths and block searches.
- **The dispatcher,** on the main thread, once per tick, aligned on the bots' physics tick (Windows' 15.6 ms timer
  makes a free-running 50 ms interval drift). It:
  1. publishes the entity snapshot;
  2. hands each worker a batch, chosen by priority and deadline, sized by a running estimate of each job type's cost
     so a batch fits the budget;
  3. resolves the answers that came back since the last tick, at the start of the tick (the main thread's "apply"
     step: look, release, set a path).
- **A worker** runs its batch in priority order until its **40 ms** for this tick (`workers.tickBudgetMs`) are spent:
  - **Long jobs** (A*) run in slices, with the patched `AStar.computeSlice`, and continue on the same worker next
    tick (affinity: the search state stays there).
  - **A job not started** goes back to the queue.
  - **A job past its deadline** is answered `late`: an aim then keeps its last solution.
- **Fallbacks:**
  - **No worker alive:** aim and raycast run on the main thread with the same code (one shared module), A* as today.
  - **A dead worker is restarted** and needs no resync, since the world is shared.
- **Counts:** `workers.count` (default: cores − 2, at least 1) replaces `pathfinding.workers`, which stays as an
  alias.
- **Metrics:** per job type, `/api/metrics` and the vitals journal get:
  - submitted, done, carried over, late;
  - wall latency p50 / p95;
  - each worker's use of its budget;
  - queue depth.

### 2.6 What stays on the main thread, and why

| Stays | Why |
|---|---|
| The bots' sockets, packet decode, mineflayer's handlers | each bot is the real mineflayer bot (O2) and is reclaimed at once (O4); docs/31 §6 ruled out bots in workers |
| Physics | it moves the bot (a write), every tick |
| The pathfinder's per-tick look-ahead | it needs the answer within the same tick; cheap since docs/32 |
| Scripts' synchronous reads (`bot.blockAt`, `nearestEntity`, `bot.entities`) | the command API is synchronous; a scan costs 10–16 µs, far less than a round trip to a worker. In P5 they read the shared copy |
| Look, release, controls, chat, windows | writes to the bot |

## 3. The aim solver (D5)

- **The arrow,** as Minecraft 1.21 flies it, per tick:
  - position += velocity, then velocity × 0.99 (0.6 in water), then velocity.y − 0.05;
  - full-draw bow speed 3.0, crossbow 3.15;
  - the shooter's own velocity added as the game does.
- **A solve:** the target leads along its snapshot velocity.
  - The pitch is a one-dimensional root search (secant / bisection) on the miss at the target, warm-started from
    the previous update: about 5–10 flights of 20–40 ticks, against hawkEye's 380+ per tick today.
  - The low arc first; the high arc if the low one is blocked.
- **One checked flight:**
  - Each tick's segment is walked voxel by voxel (Amanatides–Woo) through the store, against each state's boxes.
  - Slab tests against every hitbox of the snapshot (grown by the arrow's half-width).
  - The first thing hit decides:
    - the target, or another enemy: shoot;
    - a friend: blocked, so `shoot` throws « no clear line of fire » and the command steps aside, as today;
    - a block: try the high arc, then blocked.
- **The schedule** (bow: a full draw is 24 ticks, 1.2 s), `aim.schedule` = `[0, 10, 11, 12, 13, 14, 20, 21, 22, 23]`:
  - tick 0;
  - tick 10 (500 ms);
  - the middle four (11–14);
  - the four before the release (20–23);
  - the release at 24.

  Each update is submitted the tick before its own, so its answer is there on time. *Check this reading of "the
  middle 4 frames" with Paul; it is one config line.*
- **Turning:** every tick between two updates, the main thread sets the look by interpolating yaw and pitch from the
  current one to the newest solution, timed to arrive exactly on the next update's tick.
- **`shoot` keeps its contract:**
  - it resolves when the arrow has left;
  - « no clear line of fire » when blocked;
  - `BotLeftError` as today.

  hawkEye leaves the plugin set, and with it the per-bot copies and their memory leak (docs/36 §5.1). Volleys at a
  point keep `bowAim`.
- **Expected:**
  - the aim's main-thread cost goes from 45 % of busy to the dispatch and the turning, about 1 %;
  - the workers' cost per draw drops from ~26 × 0.64 ms to ~10 × 0.05 ms.

## 4. Phases

Each phase is shippable on its own, measured before and after, with the docs changed in the same commit (S8).

| Phase | Size | What | Done when |
|---|---|---|---|
| **P0** | S | ~~**Fix the hawkEye leak now**~~ done (docs/36 §5.1: `freshHawkEye` loads each copy through a throwaway parent, and a primed copy with no bot is the shared modules' first parent). Merge `squad-fight-bench` (bench, stagger, kits) once the docs/35 session has landed | `bench/repro-hawkeye-leak.ts` prints 0/20 (done; `tests/plugins.test.ts` checks it in `npm test`); RSS flat across `bench:fight` rounds (not measured yet) |
| **P1** ✅ | L | The shared world: pages, sections, index, epochs, cache, per-state tables, the writer thread, fed from the bots' packets beside today's worlds (nothing reads it yet) | **Done 2026-11-01** (§9): 19 tests on fakes (`tests/world.test.ts`); the live probe (`live-tests/probe-world.ts`), three runs, each comparing 184.6 M blocks of 1 878 held columns twice: 0 mismatches |
| **P2** ✅ | M | The job queue, dispatcher and reader workers (budget, priorities, deadlines, carry-over, affinity, fallbacks, metrics), with a test job type | **Done 2026-11-01** (§8): `tests/jobs.test.ts` (budget respected, priorities, `late`, a worker killed mid-batch, …); `/api/metrics` shows `jobs`. Off by default (`workers.count` 0) until P3 |
| **P3** ✅ | M | Raycast (blocks + hitboxes), LOS and the aim solver as jobs; `shoot` on the schedule with turning; hawkEye removed | **Done 2026-11-01** (§11): the aim from 42 % of the main thread to 1–2 %; full-strength ELU 0.34–0.36 inline (today's baseline 0.65–0.70); kills per shot 3.5–5.2 %; friendly 0; failed shots 19–32 % (not met: friends in the line, D5's check, §11.7); live items tests pass. The `raycast`/`los` job types are not built (nothing calls them) |
| **P4** ✅ | M | A* on the reader workers over the shared world (Movements reads per-state Block templates); the old per-worker mirror retired | `bench:load` walk / gather at 10 and 30 bots: legs and logs per minute ≥ docs/31 §11; live core tests pass; process memory flat with the worker count. **Built 2026-11-01** (§12): walk, the live core tests and memory (~60 MB a worker) met; gather not shown to match (§12.1), so the default stays off |
| **P5** | L | The bots read the one copy: a patched mineflayer blocks plugin sends chunks to the writer; `bot.world` is a shared store-backed world (prismarine-world's sync API, `blockUpdate`/`chunkColumnLoad`/`chunkColumnUnload` per bot, block entities on the main thread). Behind `world.shared` (default off until it passes) | `bench:fight` and `bench:load`: ~30–40 MB less per bot; 40 logins with no stall over 250 ms; every live test passes with `world.shared: true` |
| **P6** ✅ | S | `findBlocks` as a job (gather's search) | **Done 2026-11-01** (§10), off by default (it needs `workers.count` > 0 and `world.enabled`): mineflayer's answer, position for position, on real chunk data (`tests/find-blocks.test.ts`); 0.1 ms on the store against 15 ms in mineflayer. `bench:load` gather at N = 10: logs unchanged within two sites' noise (96 off / 100 on, first runs), block searches on the main thread 0.65–1.0 s a minute → 0; the §2.6 case (no reachable log): the main thread blocked 1 225–1 340 ms at the order's start (ten searches back to back) → 15–65 ms at most, no search on the main thread |

**Order:** P0 → P1 → P2 → P3 (the 45 %) → P4 → P5 → P6.
- **P1 and P2 are new files,** clear of the docs/35 session's edits.
- **P3 changes `shoot`** (`squad/src/api/helpers.ts`), so it starts after docs/35 has merged.

## 5. Configuration (`squad.json`)

```json
"workers": { "count": 4, "tickBudgetMs": 40 },
"world":   { "enabled": false, "cacheSeconds": 60, "cacheColumns": 2000, "verify": false, "shared": false },
"aim":     { "schedule": [0, 10, 11, 12, 13, 14, 20, 21, 22, 23] }
```

- `world.enabled`, `cacheSeconds`, `cacheColumns` and `verify` exist since P1 (§9): `world.enabled` builds the store
  (P2/P3 turn it on), `verify` is the debug comparison of §6.

- `workers.count`: default cores − 2 in the plan; **0 (off) as built** (§8.5), until the final measurements.
- `pathfinding.workers` remains an alias of `workers.count` (since P4): read when `workers.count` is not set; when both
  are set, `workers.count` wins.
- `world.enabled` defaults to `workers.count` > 0 (since P4): the workers read the store. An explicit `false` with
  workers on keeps A* on the main thread (`main.ts` warns).
- `world.shared` turns P5 on.

## 6. Risks

| Risk | What we do |
|---|---|
| Concurrency bugs in shared memory (torn reads, reuse after free) | One writer only; publish-by-key with `Atomics`; epochs before reuse. Unit tests, plus a `world.verify` debug mode that compares a sample of store reads with the bots' own worlds every second (P1–P4, while both exist) |
| Worker answers arrive a tick later | The aim submits one tick ahead; A* and searches already wait; the look-ahead stays on the main thread |
| The own solver aims worse than hawkEye | `bench:fight` measures kills per shot and failed shots against docs/36 before P3 lands |
| P5 breaks mineflayer or a plugin that expects prismarine-world's internals (pathfinder, collectblock) | `world.shared` off by default, all live tests with it on before switching |
| 40 ms per worker per tick leaves little CPU when the Minecraft server and client run on the same PC (the laptop has 12 threads) | `workers.tickBudgetMs` and `workers.count` are config. The budget is a ceiling: an idle worker uses nothing |
| A chunk visible a few ms after its packet (decoded on the writer) | mineflayer already waits for `chunkColumnLoad` at spawn; the event is emitted on publish |

## 7. Expected result (estimates)

- **A 20 v 20 fight at full strength:** main thread ~0.6 → ~0.25 ELU. P3 removes the 45 %, P4 the 6 %, and P5 cuts
  physics' block lookups and GC.
- **Memory at 40 bots:** ~1.7 GB → under 0.8 GB (P5, plus the P0 leak fix).
- **40 logins:** the stall falls from up to 1.6 s to under 250 ms, because each column is decoded once, on the writer
  (P5).
- **The workers' memory** no longer grows with their count (P4).

## 8. P2 as built (2026-11-01)

The framework only: no real job type yet (the stock `echo` and the tests' handlers), and **off by default**
(`workers.count` 0: `main.ts` builds no pool, so production is unchanged). P3, P4 and P6 add their handler modules to
`squad/src/jobs/handlers/index.ts` (`STOCK_HANDLERS`).

### 8.1 Files (`squad/src/jobs/`)

| File | What |
|---|---|
| `pool.ts` | `JobPool`, main thread: queue, the tick (apply → publish → dispatch), slots, crash policy, inline fallback, stats |
| `worker.mjs` | The reader worker entry (plain JS, no loader) |
| `batch.mjs` (+ `.d.mts`) | `runBatch` (the budget loop, `continue`, errors) and `loadHandlers`, shared by the worker and the inline fallback |
| `entities.mjs` (+ `.d.mts`) | The entity snapshot's shared-memory layout and protocol: buffers, holds, publish, the reader |
| `snapshot.ts` | `EntitySnapshot`, the main-thread writer (dedup across bots, velocity, teams) |
| `teams.ts` | `TeamIds`: team numbers from the roster's owner groups |
| `ticks.ts` | `LeaderTicks`: the dispatcher follows one online bot's `physicsTick` |
| `errors.ts` | `JobLateError`, `JobFailedError` |
| `handlers/echo.mjs`, `handlers/index.ts` | The trivial job type; the list `main.ts` loads |

Tests: `squad/tests/jobs.test.ts` (24 tests) with the handlers and a stub world module in `squad/tests/fixtures/jobs/`.
Overhead: `npm run bench:jobs` (`squad/bench/jobs.ts`).

### 8.2 The API

```ts
new JobPool({ workers, handlers: URL[], tickBudgetMs? = 40, inlineBudgetMs? = 10, version?,
              world?: { descriptor(): unknown; release?(d: unknown): void }, worldModule?: URL,
              entities?: { bots(): Iterable<{ entity?, entities? }>; teamOf(username): number },
              entityCapacity? = 4096, ticks?: 'auto' | 'manual', maxCrashesPerMinute? = 3 })
jobs.submit<T>({ type, input, priority? = 0, deadlineTick?, affinity?, transfer?: ArrayBuffer[], signal?: AbortSignal }): Promise<T>
jobs.tick(): Promise<void>            // one tick by hand (ticks: 'manual'); resolves after its dispatch
jobs.useTickSource(bot | null)        // follow a bot's physicsTick (LeaderTicks does it in main.ts)
jobs.currentTick, jobs.ready(), jobs.stats(reset?), jobs.stop(), jobs.killWorker(i) (tests)
```

- **Order:** higher `priority` first, then the earlier `deadlineTick`, then the earlier submit.
- **`deadlineTick`** is the last tick at whose apply step the answer is still wanted. A worker's answer is applied at
  the tick after its dispatch, so a queued job whose deadline is ≤ the dispatch tick is late at once, and an answer that
  comes back after its deadline is late too: the promise rejects with `JobLateError { type, deadlineTick, tick }`.
- **`JobFailedError { type, reason, message, remoteStack?, remoteName? }`**, `reason` one of `threw` (the handler's
  message and stack), `workerDied` (its worker died twice under it), `lostInput` (a transferred input died with its
  worker), `unknownType`, `clone`, `unavailable` (no worker and the inline fallback cannot load), `stopped`.
- **A handler module:** `export const type = '…'; export function run(input, ctx) { … }`, optionally
  `export function init({ version, world, inline, worker })` (once per thread). `run` returns the answer, or
  `{ continue: state }` to be resumed next tick on the same worker with `ctx.state` (so an answer cannot be an object
  with a `continue` key).
- **`ctx`** = `{ world, entities, tick, deadlineTick, state, version, worker (slot index, -1 inline), inline,
  budgetLeftMs() }`. `world` is `openWorld(descriptor)` of `worldModule` (P1's reader; null without one); every batch
  is bracketed by `world.enter()` / `world.leave()` and pins the entity snapshot.
- **The budget** is wall time from the batch's start. Before each job but the first, the worker stops if the budget is
  spent or the job's estimated cost would overrun it; the jobs not started go back to the queue in their place
  (`carried`). The estimate is an EWMA of each type's run time (α 0.2), kept by the main thread (it sizes the batches)
  and by each worker. A handler that runs long checks `ctx.budgetLeftMs()`; nothing preempts it.
- **Async handlers** are allowed, not advised: the batch awaits them, their wait counts against the budget, and no
  answer of that batch goes back until they settle.
- **Affinity:** jobs with the same `affinity` key go to the same worker while one of them is queued or running; a
  continued job is pinned to the worker that holds its state.
- **`transfer`:** the buffers move to the worker. A job carried over keeps its input on that worker (it is pinned
  there); if that worker dies, the job fails (`lostInput`) instead of being queued again.
- **Entity snapshot reader** (`ctx.entities`, any thread): `count`, `tick`, `epoch`, `writtenAt`, `get(id)` (binary
  search, sorted by id), `each(fn)` (return false to stop), `data` (the raw `Float64Array` for hot loops:
  `data[HEADER_LENGTH + i * STRIDE + COL.X]`). A row: `{ id, type (registry entity id, -1), kind (KINDS index of
  mineflayer's entity.type: 1 player, 2 hostile, 9 projectile…), x, y, z, vx, vy, vz (blocks per tick), width, height,
  team }`.

### 8.3 The tick source

The dispatcher ticks on **one online bot's `physicsTick`** (`LeaderTicks`: the first bot online; the next one when it
goes). mineflayer's physics keeps 20 ticks a second with its own catch-up, so the job ticks are the bots' ticks and
do not drift. Each bot runs its own physics timer, so the bots are not in phase with each other; following one keeps
the rate, not a common phase. When no bot ticks for 75 ms (`SOURCE_GRACE_MS`), a **self-correcting timer** takes over:
each tick aims at start + n × 50 ms, so Windows' 15.6 ms timer quantum makes single ticks late but never drifts
(catch-up at most 4 ticks, then it re-anchors, like mineflayer). Ticks within one macrotask (mineflayer's catch-up
bursts) share one dispatch. The publish and dispatch run on `setImmediate` after the apply step, so a job submitted
by an answer's callback makes the same tick.

### 8.4 Measured (`npm run bench:jobs`, Ryzen 9 9950X3D, 4 workers)

| | p50 | p95 |
|---|---|---|
| Submit → resolve of a trivial job, the pool's own 50 ms ticks, submitted at a random point of the tick | 63–77 ms | 93 ms |
| The same, no worker (inline: the answer is applied at its dispatch) | 16 ms | 47 ms |
| Round trip when ticking as fast as possible (dispatch → worker → applied) | 0.026 ms | 0.075 ms |
| Dispatcher main-thread time, a tick with 0 / 100 / 1 000 jobs queued (dispatch) | 0.001 / 0.12 / 0.58 ms | 0.002 / 0.18 / 0.73 ms |
| The next tick, applying 0 / 100 / 1 000 answers | 0.001 / 0.04 / 0.23 ms | 0.001 / 0.07 / 0.34 ms |
| An idle pool's tick | 0.004 ms (mean) | |
| Entity snapshot write, 40 bots × 100 entities (880 rows) | 0.28 ms | 0.40 ms |

So a job submitted between ticks waits for the next dispatch (0–50 ms) and its answer for the tick after (50 ms): an
answer is there **two ticks** after a submit at the latest, one tick after a submit made in the leader's tick before
its dispatch. P3's aim schedule must submit two ticks ahead (or P3 changes the apply point).

### 8.5 Where it differs from §2.4–2.5

- **`workers.count` defaults to 0** (off), not cores − 2: no job type needs it yet. `pathfinding.workers` is untouched
  (P4 merges them); until then each pool caps itself at cores − 1 on its own. (Since P4: one pool, `pathfinding.workers`
  an alias, §12.)
- **Teams:** a row's `team` is the owner group (bots joined through any shared owner, a superset of every order's
  `isFriend`), and **owner players carry their team's number too**, since `isFriend` counts them as friends; other
  players and mobs are 0. A `kind` column was added (projectiles and items must not block a raycast).
- **Velocity** is the move between the last two snapshots the entity was in, per tick (0 when first seen or after a
  gap of more than 4 ticks). It inherits the packets' jitter against the tick; P3 should check whether its lead needs
  smoothing.
- **The snapshot is published only while jobs are about** (a submit within the last 20 ticks), so an idle pool costs
  nothing. When both buffers are held (a reader still on the previous one), the writer skips that tick's publish
  instead of waiting (`entities.skipped`).
- **The inline fallback runs every job type**, not only aim and raycast, with its own budget (`inlineBudgetMs` 10 ms:
  the main thread also runs the bots), and its answers are applied at once.
- **Added:** cancellation (`signal`), `transfer` (and `lostInput`), `answered` in the stats, the jobs' minute in the
  vitals journal (`data.jobs`).
- **A dead worker's shared memory:** a worker killed inside a batch never calls `world.leave()` or unpins the entity
  snapshot. The pool clears its entity hold itself, and calls `world.release(descriptor)` when P1's `SharedWorld` has
  it. **P1 needs that (or an equivalent):** otherwise a dead reader's epoch holds back the reuse of freed memory for
  good.
- **`/bots status`:** the runtime's `text` gets « calculs : 3/4 workers, file 12, p95 75 ms, 2 en retard, … » when the
  pool is on; the mod's own short line (`SquadStatusFormat`) is unchanged.

### 8.6 Added in P4 (the A* job needed them)

All backward compatible: a handler that uses none of them runs exactly as before.
- **Progress:** `JobSpec.onProgress?(progress)`. A handler that answers `{ continue: state, progress }` hands `progress`
  (structured-cloned) to it at the next tick's apply step, after the job is queued again, so a callback that cancels the
  job finds it queued and its state is dropped. Never called once the job is settled; a callback that throws is
  logged. A progress the worker cannot copy is dropped, not the job. The `continue` `WireResult` carries `progress?`.
- **Elastic types:** a handler module may `export const elasticMinMs = 2`. The pool packs it into batches by that, not
  by its measured cost (the EWMA, still kept for the stats), and `ctx.shareMs()` (in every job's `ctx`) gives a run its
  fair share: what is left of the batch's budget, split evenly with the jobs after it. A search alone on a worker
  computes up to the whole 40 ms; ten share it. A worker lists its elastic types in its `ready` message
  (`elastic: { type: ms }`); the inline fallback reads them from its own handlers.
- **`jobs.workersAlive()`:** a cheap count of the live workers (`stats()` sorts latencies).
- **`resourceLimits`** (`JobPoolOptions`): each worker's V8 heap limits, passed to `new Worker`. `main.ts` gives the
  reader workers a young generation of 16 MB and an old one of 512 MB (`READER_HEAP`, §12.1: without it each
  isolate let A*'s garbage pile up against V8's default limit of several GB).

## 9. P1 as built (2026-11-01)

**Files** (`squad/src/world/`; the `.mjs` run in any thread without a loader, each with a `.d.mts`, which TypeScript
needs for an `.mjs` import; a `.d.ts` is not found):

| File | What |
|---|---|
| `layout.mjs` | The memory map, shared by reader and writer; `allocateWorld()` |
| `tables.mjs` | The per-state tables from the registry (`buildStateTables`) and the decoder's settings |
| `decode.mjs` | A chunk payload into state ids, prismarine-chunk's 1.18+ format, no palette objects |
| `reader.mjs` | `openWorld(descriptor)`: `WorldReader`, `StateTables`, the `F_*` flag bits. Any thread |
| `store.mjs` | `WorldStore`: the writer's logic (load, release, set, expire, epochs, reset), synchronous |
| `writer.mjs` | The writer thread: the message loop around `WorldStore` |
| `follow.ts` | A bot's world packets, with the same rules as the path workers' mirror |
| `shared-world.ts` | `SharedWorld`, main thread: holders, routing, the writer's lifecycle, `verify` |

Wiring: `config.ts` `world` (`WorldConfig`, `DEFAULT_WORLD`); `main.ts` builds `SharedWorld` when `world.enabled`
(`maxReaders` 64, `WORLD_MAX_READERS`) and returns it as `Started.world`; `pool.ts` calls `world.attach(bot)` right after
`createBot`, beside `pathWorkers.attach` (`BotPoolOptions.world`).

**The API** (as asked, plus the extras marked +):

```ts
// reader.mjs: any thread
openWorld(descriptor: WorldDescriptor): WorldReader
WorldReader: stateId(dim, x, y, z) · hasColumn(dim, cx, cz) · bounds(dim) · enter() · leave() · states
  + stateIdIn(dimIndex, x, y, z) · dimIndex(dim) · columnVersion(dim, cx, cz) · version()
StateTables: boxes(s) · isEmpty · isLiquid · isClimbable · isSolid · name · blockId
  + count · boxStart(s) · boxCount(s) · boxData · flags(s) · isWater(s);   + F_EMPTY … F_BB_BLOCK
// shared-world.ts: main thread; events 'published' (dim, x, z), 'unloaded' (dim, x, z)
new SharedWorld({ version, cacheSeconds, cacheColumns, maxReaders, verify? })
attach(bot) · descriptor() · reader · stats() · stop()
  + release(descriptor) · settle() · verifyRound(samples?) · killWriter() (tests)
```

Semantics a caller needs:
- **Reads need a bracket.** `stateId`, `stateIdIn`, `hasColumn` and `columnVersion` throw outside `enter()`/`leave()`;
  a second `enter()` throws. `bounds`, `dimIndex`, `version` and `states` read any time.
- **-1** means no LIVE column: never received, unloaded, or cached. Inside a live column, above or below the
  dimension's height reads 0 (air), as prismarine-world does. Coordinates are floored.
- **Columns change while you read.** A block change or a re-sent chunk applied while a batch runs may show in some of
  its reads and not others; each read is one `Uint16`, never torn. Within a bracket, a column found keeps meaning that
  chunk, even if it is dropped meanwhile; it then reads -1.
- **`boxes(s)`** is one shared view per shape. Never write into it.
- **Flags are per state.** `isEmpty` means no collision box in this state (an open fence gate, a one-layer snow), from
  the shapes. minecraft-data's per-block `boundingBox`, which mineflayer-pathfinder and prismarine-physics read, is
  `F_BB_BLOCK`. `isSolid` is exactly the full cube. `isLiquid` is water or lava. `isWater` is physics' water (with
  seagrass, kelp, bubble columns and waterlogged states). `isClimbable` is 1.21.1's `#minecraft:climbable` tag; the
  bots' physics climbs only ladder, vine and scaffolding.
- **Reader slots.** `descriptor()` hands out the next epoch slot (slot 0 is the main thread's `reader`). Each one
  carries a `readerToken`, and **`release(descriptor)`** frees it. It is meant for a reader that will never read
  again, such as a dead worker. A reader killed inside `enter()` keeps its old epoch, and no memory freed since can be
  reused until it is released. `release` is idempotent: it does nothing once the slot has gone to a new reader. Call
  it only once the thread is gone.
- **`stats()`** returns `{ columnsLive, columnsCached, sections, bytes, decoded, decodeMs: { p50, max } }`, plus
  `sectionCapacity`, `retiredBatches`, `skipped`, `failed`, `rejected`, `held`, `dropped`, `resyncs`, `restarts`,
  `writer` and `verify`.

**Layout:**
- Five SharedArrayBuffers: control, index, columns, sections, dims. Sections and columns are growable buffers that
  reserve their maximum, 4 GB = 524 288 sections and 65 536 columns, and grow by 8 MB and 160 KB pages.
- Readers use **fixed views per page**: in V8 24, a length-tracking view is 15–20 times slower to read. The growth
  happens before the publish, so **no message announces a page**.
- **Section refs:** 0 = all air, `-state` = one state fills the section (an ocean's water), else 1 + the section's
  index. On the live world, 9 sections a column were stored, out of 24.
- **Columns:** at most 32 sections (512 blocks tall). **Dimensions:** at most 32, names ≤ 64 bytes.
- **Index:** 131 072 entries of `[tag, x, z, slot]`, tag = dimension + 1. A tombstone is reused once every reader is
  past it.
- **Epochs:** the writer retires freed slots, sections and tombstones at the current epoch, moves the epoch, and
  reclaims a batch when every reader has left or entered after it. It reclaims at the start of each batch, at its end,
  and every second.

**Deviations from §2:**
1. **Refcounts live on the main thread**, in `SharedWorld`, not in the writer. The main thread needs the holders anyway:
   to route block changes, to pick the bot to re-send from, and for P5's per-bot events. It then forwards a payload
   only for a column new to every bot, a re-send, or a resync. The writer gets `load` / `release` / `set`.
2. **The payload is copied once, not transferred.** mineflayer parses the same `Buffer` after our listener, so it is
   copied into an `ArrayBuffer` that is transferred. In P5 nothing else parses it, and it can be transferred.
3. **Dedup = the primary holder**, not per-batch value dedup. Only the column's first holder forwards its block
   changes, so the store replays one bot's ordered stream: interleaving several bots' streams can apply an older value
   last. When the primary lets go while others hold the column, and a change was heard there in the last 5 s
   (`RESYNC_WINDOW_MS`), the next holder's own column is re-sent (`getColumn().dump()`). Otherwise a change only that
   holder had heard would be lost.
   - A re-send to a holder makes it the primary.
   - **For P5:** the resync and the writer restart both re-send from the bots' own worlds, which P5 removes. P5 needs
     another source, for example a per-column change sequence, or rebuilding the writer's state from the store, which
     survives the writer.
4. **The cache's "same payload" test also needs a clean column.** A column that had a block change since its last
   payload is decoded again even if the payload is byte-identical: the server may have put the block back while no bot
   held it.
5. **A dead writer** is restarted over the same buffers, so descriptors stay valid. It drops every column (readers read
   -1) and retires all memory; `SharedWorld` re-sends what the bots hold. After 3 deaths in a minute the writer is
   disabled: the main thread clears the store once, and every read is -1.

**Measured** (`live-tests/probe-world.ts`, three runs on the dev server; the Ryzen 9 9950X3D was shared with other
sessions, so indicative):
- **Probe:** 6 bots in two areas 3 000 blocks apart, plus one overlapping the first; 313 columns each, 1 878 held,
  825–876 unique.
- **Parity:** 184.6 M blocks compared each time, before and after the RCON changes: 0 mismatches. Also 0 columns held
  but missing, 0 live but held by no bot, and `verify` 0 mismatches over 2 000–4 600 samples per run.
- **Decode, on the writer:** p50 0.08–0.12 ms a column, max 1.2–2.3 ms (the first ones, before the JIT). On one thread
  over 200 payloads: ours 0.09–0.16 ms, prismarine-chunk's `load` 0.12–0.14 ms, so about the same. The point is where
  it runs (off the main thread) and how often (once per column, not once per bot).
- **RCON changes reached the store** within 0–68 ms of the RCON reply (≤ 1.4 ticks): setblock, a 125-block fill,
  break, fill with air.
- **Memory:** the store committed 67–75 MB (62–65 MB of sections) for 825–871 columns. The bots' own worlds held 121 MB
  of typed arrays for their 1 878 columns, 20 MB a bot. A column costs about the same in both; the store holds it once.
- **Cache:** every column went cached when the bots left. A bot back within `cacheSeconds` got 306–311 of its 313
  columns without a decode; the decoded ones had block changes. Everything expired 14.3 s after the last bot left
  (`cacheSeconds` 15).
- **Fresh terrain** gave a different picture: 113 852 dropped non-primary changes (post-generation updates) and 269 of
  313 columns dirty, all decoded again, as they must be. On generated terrain, the drops fell to 400–450.

**Not done in P1:**
- the store in `/api/metrics` and the vitals (P2 adds the metrics);
- `world.shared` (P5);
- nothing reads the store but `verify` and the tests.

## 10. P6 as built (2026-11-01)

Gather's block search (`mineBlock`'s) is a `findBlocks` job on the reader workers, over the shared world. It is **off by
default**: it needs both `workers.count` > 0 and `world.enabled`, and with either off nothing changes (every search is
`bot.findBlocks` on the main thread, as before).

### 10.1 Files

| File | What |
|---|---|
| `squad/src/world/find-blocks.mjs` (+ `.d.mts`) | mineflayer's `findBlocks` over the store: the section walk, the match tables, a resumable search. Any thread |
| `squad/src/jobs/handlers/find-blocks.mjs` | The `findBlocks` job type (added to `STOCK_HANDLERS`), with the match tables cached per thread |
| `squad/src/api/block-search.ts` | Main thread: `findBlockPositions` (the job, or the bot), `useBlockSearch`, `blockSearchStats` |
| `squad/src/api/helpers.ts` | `mineBlock` awaits `findBlockPositions` instead of calling `bot.findBlocks` |
| `squad/src/main.ts` | `useBlockSearch({ jobs, world })` when both exist; undone in `stop()` |
| `squad/src/world/shared-world.ts` | + `dimensionOf(bot)`: the store's name of the bot's dimension |
| `squad/tests/find-blocks.test.ts`, `tests/fakes/terrain.ts` | 11 tests, on real prismarine-chunk columns through mineflayer's own blocks plugin |
| `squad/bench/find-blocks.ts` (`npm run bench:find-blocks`) | mineflayer's search against the store's, and the job's latency, no server |
| `squad/bench/load.ts`, `profile-summary.ts` | `--jobs N --world`; per phase `block searches: …` and `jobs (last 10 s): …`; a profile cause `block searches (mineflayer findBlocks)` |
| `squad/live-tests/run.ts` | `LIVE_JOBS=N LIVE_WORLD=1`; the gather scenario reports where its searches ran |

### 10.2 The job type

```ts
jobs.submit({ type: 'findBlocks', input: { dim, x, y, z, maxDistance? = 16, count? = 1, blocks?, names?, states? } })
  // → { positions: [x0, y0, z0, x1, …], hits, sections, scanned, unknown, slices }
```

- **`dim`** is the store's name of the dimension (`SharedWorld.dimensionOf(bot)`, e.g. `minecraft:overworld`: the
  login's world name, where mineflayer's `bot.game.dimension` is the type, `overworld`). `x, y, z` is the point, floored.
- **Matching** is data only: block ids (the registry's), block names (with or without `minecraft:`), state ids, any mix.
  Each query becomes a match table, a byte per state id (64 KB, all of Uint16), built in 0.1 ms and kept per thread
  (32 queries). A matcher function cannot cross to a worker, so R76 (a matcher run on palette blocks whose position is
  null) does not arise.
- **The answer is mineflayer's**, position for position and in its order (`blocks.js` `findBlocks`), quirks included:
  - sections in prismarine-world's `OctahedronIterator` order around the point's section, out to
    `ceil((maxDistance + 8) / 16)` (the iterator is copied on integers; a test checks it point for point);
  - in a section, blocks in x, y, z order; a block counts when it matches and is within `maxDistance` of the point;
  - the walk stops after the first section of the layer after the one where it reached `count`, then sorts by
    distance (stable) and keeps `count`. So "nearest first" is mineflayer's, by whole layers of sections.
  - On a live server the store can trail a bot's own world by a few ms (the writer decodes, only a column's primary
    holder forwards its changes, §9), so an answer may name a block just cut: `mineBlock` checks each one with
    `bot.blockAt` before mining it, as it always did.
- **Skipping:** a section entirely farther than `maxDistance` is not read; an all-air section (ref 0) or a one-state
  section (ref `-state`) is decided once from its state; a stored section is read as 4 096 `Uint16`s against the match
  table (3.3 µs). mineflayer skips a section only when its palette has no match, and a one-state section has no
  `palette` in prismarine-chunk 1.18+ (`SingleValueContainer`), so it builds a `Block` for every block of every all-air
  section in range. **No per-section summary:** a whole 48-block walk with no hit reads 69 sections, 0.26 ms; a summary
  could save at most that, against a writer change for every block change.
- **Unknown columns** (never received, unloaded, or cached: no bot holds them) have no blocks, as an unloaded column has
  none for mineflayer; another dimension has none.
- **Budget:** the search walks sections until `ctx.budgetLeftMs()` falls under 0.05 ms (at least one section per step),
  then answers `{ continue }` and goes on next tick from the same place. A 48-block search takes 0.1–0.3 ms, so only
  far larger ones continue.

### 10.3 What uses it, and when

- **`mineBlock` only** (async; so `gather`), through `findBlockPositions(bot, ids, maxDistance, count)`. With a
  backend (`main.ts`: a job pool and a shared world) it submits a job at priority 0 (the pool's default; §2.5 puts
  aim and raycasts above block searches) with a deadline of 100 ticks (5 s). The helper's contract and its errors are
  unchanged.
- **It falls back to `bot.findBlocks`, for that call,** when the store cannot answer for the bot: no dimension (not
  attached, not logged in), the bot's own column not live in the store (just logged in or teleported, before the writer
  published it; the writer disabled after crashes), the job failed (no worker and no inline fallback, the pool stopping)
  or was late. A failure is logged at most once a minute. `blockSearchStats()` counts the jobs, the fallbacks by why,
  and the jobs' submit → positions latency.
- **`findBlock` stays synchronous on the bot's own world.** The script API returns a `Block` at once, and a worker's
  answer comes one or two ticks later (§8.4).

### 10.4 Measured

**`npm run bench:find-blocks`** (no server; 9 × 9 forest columns of real chunk data; both on the main thread, so they
compare; the Ryzen 9 9950X3D shared with other sessions):

| Search | mineflayer `findBlocks` p50 / p95 | the store's p50 / p95 | sections walked / read |
|---|---|---|---|
| gather's: every `_log` within 48, count 64 | 15.3 / 16.4 ms | 0.10 / 0.13 ms | 26 / 17 |
| `oak_log` within 32, count 1 | 0.75 / 5.3 ms | 0.005 / 0.033 ms | 1 / 1 |
| `iron_ore` within 16, count 8 | 10.9 / 12.1 ms | 0.042 / 0.064 ms | 26 / 8 |
| nothing there, within 48 (the whole walk) | 36.8 / 38.9 ms | 0.26 / 0.30 ms | 129 / 69 |

As a job (4 workers, the pool's own 50 ms ticks): submit → positions p50 62 ms, p95 93 ms; 0.19 ms of worker time.

**`bench:load` gather, N = 10, 60 s, dev server** (off = the defaults; on = `--jobs 4 --world`). Each pair ran on one
site, so its second run cut a forest the first had thinned: site A off first, site B on first. All four were profiled
(1 ms sampling). "Longest stall" is the longest stretch of the main thread without an idle sample, from the profile:
the bench's loop histogram, in these runs, missed the first one, which came in the macrotask that started the order,
before the histogram's first tick (fixed since, below).

| | A off (1st) | A on (2nd) | B on (1st) | B off (2nd) |
|---|---|---|---|---|
| logs in 60 s | 96 | 55 | 100 | 97 |
| ELU | 0.50 | 0.506 | 0.586 | 0.523 |
| loop p99 / max (ms) | 12.4 / 81 | 10.4 / 29.9 | 15.3 / 31.4 | 11.2 / 127 |
| longest stalls (ms) | 314 (the start), 85, 85 | 67, 65, 55 | 85, 76, 65 | 402 (the start), 140, 139 |
| main-thread busy | 27.4 s | 27.3 s | 32.7 s | 28.8 s |
| block searches on the main thread | 654 ms (28 searches, 23 ms each) | 0 | 0 | 1 022 ms (25, 41 ms each) |
| added by the job path: the pool's tick (dispatch, entity snapshot) / the shared world's feed | — | 140 / ~95 ms | 220 / ~120 ms | — |
| searches by job; job latency p50 / p95 | — | 20 | 27; 67 / 105 ms | — |

- **Gather is unchanged** within what two sites can show: the first run on each site mined 96 (off) and 100 (on) logs,
  the second 55 (on, site A) and 97 (off, site B). Site A's second run met a thinned forest (99 paths found, against
  134). ELU and busy time are A* (61–71 % of busy) and the look-ahead (20 % in B's first run, on a fresh forest), not
  the search.
- **The search leaves the main thread:** 0.65–1.0 s of main thread a minute at N = 10 (2.4–3.5 % of busy) goes to 0,
  and so do its stalls. One mineflayer search is 23–41 ms of synchronous work, and the order's start runs the ten
  bots' first searches back to back (314–402 ms).
- **What the job path costs the main thread:** the pool's tick, mostly the entity snapshot (published while jobs are
  about, §8.5: 71–138 ms a minute, and `findBlocks` reads no entity), and P1's feed of the shared world (follow, copy,
  flush). Net, about 0.4–0.7 s a minute less.

**The docs/31 §2.6 case: logs in sight, none reachable** (N = 10 on a desert under 12 oak logs set floating at y 90 over
RCON, 60 s, profiled). Every `mineBlock` sees the logs and fails them one by one on "no path" (73–74 path timeouts a
minute in both runs; 0 logs). Off, the order's start blocked the main thread for **1 340 ms** (10 searches of
~120 ms: with only 12 logs, `count` 64 is never reached, so each walks every section in range); on, the longest stall
was **65 ms** and no search ran on the main thread (10 jobs, p50 54 ms). ELU 0.525 off, 0.513 on: A* (69–73 % of busy).
**No log at all** (a desert, 30 s, profiled): each bot's first batch finds nothing and `gather` stops (`stopped early: …
none found`). Off, **1 225 ms** blocked at the start (10 searches, 1 113 ms of `findBlocks`: 111 ms each, a full walk
over a desert's sections); on, **15 ms** at most (10 jobs, p50 54 ms). The bench's loop max read 2.9 and 3.0 ms: the
stall was in its blind spot. With that fixed (`runPhase` now lets the histogram tick before it starts the orders), the
same pair, unprofiled, 20 s: loop max **1 122 ms** off, **13.9 ms** on (jobs p50 70 ms).

**The freeze itself** (minutes, the event loop blocked until every batch had failed) no longer reproduces with either
setting. Since `ab027f8` `squad.tasks` yields a macrotask between items (`tests/gather.test.ts`); `npm run
bench:repro-tasks-spin` now ends after 210 ms, with a longest gap of 204 ms: each of the 10 bots' first search in one
macrotask, on the fakes' 20 ms search. With the job on, no search runs on the main thread, and each one is a real wait
of a tick or two, so even a microtask loop around `mineBlock` could not freeze it.

**Tests.** `npm run check`: 230 tests, 11 of them P6's (`tests/find-blocks.test.ts`): the walk against prismarine-world's
iterator; 135 searches (7 queries, 5 points, 4 maxDistance/count pairs, an unknown column beside the bot) answered as
mineflayer's `findBlocks` answers on the same real columns; `maxDistance` at its edge; unknown, bot-only and cached
columns; block changes, names and state ids; a search over many ticks by `continue` (a worker and the inline fallback,
the same answer); `mineBlock` without the pool, with it (the same logs, no `bot.findBlocks`), its two fallbacks, and its
unchanged error. **Live core tests** (`LIVE_ONLY=core`, dev server): 7/7 with the defaults, 7/7 with `LIVE_JOBS=4
LIVE_WORLD=1` (gather's search by job, no fallback).

### 10.5 Where it differs from the plan

- **`findBlock` is not a job** (it stays synchronous on the bot, §10.3); only `mineBlock` uses the job.
- **No per-section summary in the store** (§10.2: not worth a writer change).
- **`SharedWorld.dimensionOf(bot)`** was added to P1's file: a job for a bot needs the store's name of its dimension.
- **Fallbacks to the bot** (§10.3) where the plan had none: the store may not hold the bot's column yet.
- **The entity snapshot** is published while any job is about, `findBlocks` included, though it reads no entity. A
  per-type flag in the pool ("needs entities") would save its 70–140 ms a minute here; not done (the pool is P2's).

### 10.6 Not done

- The defaults stay off (`workers.count` 0, `world.enabled` false); the orchestrator flips them after the final
  measurements.
- `blockSearchStats` is not in `/api/metrics` or the vitals (the pool's per-type `findBlocks` counts are, §8.5).
- Unreachable logs are still searched again by every bot and every `mineBlock` call (docs/31 §11.9): cheaper now, but
  each one still costs an A* search to find out.
- Measured at N = 10 only, one pair per site.

## 11. P3 as built (2026-11-01)

Squad aims its archers itself; hawkEye left the plugin set. **The defaults are unchanged** (`workers.count` 0,
`world.enabled` false): every aim is then solved on the main thread over the bot's own world. With both on, each update
is an `aim` job on the reader workers.

### 11.1 Files

| File | What |
|---|---|
| `squad/src/aim/arrow.mjs` (+ `.d.mts`) | The 1.21.1 arrow: constants, the launch with the shooter's movement, the flight in closed form (`heightAt`) |
| `squad/src/aim/solve.mjs` (+ `.d.mts`) | The solver: the lead, the pitch, the checked flight, what is hit first. Plain JS: the workers and the main thread run the same file |
| `squad/src/jobs/handlers/aim.mjs` | The `aim` job type (one line pushed onto `STOCK_HANDLERS` in `handlers/index.ts`) |
| `squad/src/aim/inline.ts` | The main thread's reader over one bot's own world (prismarine-world's `getColumn` + the shared world's per-state tables, built once per version), and its `entities` in the snapshot's row layout |
| `squad/src/aim/draw.ts` | One draw on the schedule: the clock, the requests (jobs or inline), the turn, the hold, the target's velocity, `aimStats()` |
| `squad/src/api/helpers.ts` `shoot` | Checks, lets a meal finish, equips, `drawShot`, the errors (the contract is unchanged) |
| `config.ts` `aim`, `main.ts` | `aim.schedule`, `aim.drawTicks`; `configureAim` with the pool and the world when both exist |
| removed | hawkEye from `bots/plugins.ts` (`freshHawkEye`), the guard's plugin namespaces, the abort sequence and `reference/squad.d.ts`; `bench/repro-hawkeye-leak.ts` and `tests/plugins.test.ts` (P0's leak: nothing loads hawkEye any more); `bench:fight --hawkeye-every` refuses |

Small changes elsewhere: `SharedWorld.dimensionOf(bot)` (the store's dimension name for a bot, P1's file);
`reader.d.mts` declares the `StateTables` class `reader.mjs` exports (types only); `bench/profile-summary.ts` has an
"aim" cause first; `bench:fight` has `--jobs N --world` and a Shots and an Aim section; `FakeBot.archer()` (physics
ticks, a bow that fires). **No change to the job pool.** `minecrafthawkeye` stays in `package.json`: removing it needs
an `npm install`, which this worktree must not run (`tests/aim.test.ts` compares the pitch with its equations while it
is installed, and skips that test when it is not).

### 11.2 The arrow (read from the 1.21.1 server: javap of Loom's yarn-mapped jar)

- **Start:** the eyes − 0.1 (`PersistentProjectileEntity(type, owner, …)`: `owner.getEyeY() - 0.1F`).
- **Bow:** `BowItem.shoot` → `ProjectileEntity.setVelocity(shooter, pitch, yaw, 0, pull × 3.0F, 1.0F)`: the unit view
  vector × 3 at full draw, plus `shooter.getMovement()`, its y dropped on the ground. For a player that is
  `ServerPlayerEntity.movement`, the position delta of its last move packet (`ServerPlayNetworkHandler.onPlayerMove`):
  0 for a bot that stands and turns, its per-tick move when it walks. The solver is given the bot's last tick's move.
- **Crossbow:** `CrossbowItem.shoot` → `setVelocity(x, y, z, 3.15F, 1.0F)` along the view: no shooter movement.
- **Spread:** both add `triangle(0, 0.0172275)` per component before the speed (about ±0.5°): nothing can aim for it.
- **Per tick** (`PersistentProjectileEntity.tick`): the segment p → p + v is checked, blocks first (`World.raycast`
  against collision shapes, only the voxels the segment visits), then entities up to the block hit
  (`ProjectileUtil.getEntityCollision`: each hitbox grown by 0.3F, the nearest entry wins; a box the segment starts in
  is not hit); then p += v, v × 0.99F (0.6F touching water), v.y − 0.05.
- **Release:** the bow's release (`block_dig` 5) carries no rotation, so the server uses the last look packet. In 1.21.1
  `use_item` carries one: the crossbow's fire takes it from the packet.

### 11.3 The solver (`aim/solve.mjs`)

- **The lead:** the aim point is the target's centre where it will be when the arrow gets there: `lead` (ticks from the
  sample to the release, plus one for the server) plus the flight, by fixed-point iteration (2–3 rounds, each
  warm-started). Horizontal only (a jump would be led into the sky). A point (a volley) is not led.
- **The pitch:** the root of the vertical miss at the aim point's distance. A flight is the closed form of the game's
  per-tick motion (`heightAt`: the positions after whole ticks, linear within a tick; equal to stepping tick by tick to
  1e-9). Warm start: secant steps from the draw's last answer, on that arc's side of the peak (1–3 flights). Cold: up
  from the straight line, the bracket doubling until the arrow passes above, then regula falsi (Illinois). The
  shooter's drift is cancelled across the line and added along it (`launch`).
- **One checked flight,** tick by tick: each segment walked voxel by voxel (Amanatides–Woo) against each state's boxes
  (`boxStart` / `boxCount` / `boxData`), then slab tests against the snapshot's creatures near the flight (kinds 1–8:
  players, mobs, the armor stand; items, orbs and arrows are not in the way) and the target's box at its led position.
  The first thing hit: the target, or another enemy (a player of another team, any mob), is a hit; a friend (the input's
  `friends`, the order's isFriend players, or the shooter's team in the snapshot's `team` column), a block, or an armor
  stand blocks. Unknown blocks (-1) count as air, and are counted (`unknown`).
- **Arcs:** the low arc first; the high arc when a block (or an armor stand) stops the low one. A friend in the low
  arc's line blocks (§3), unless `aim.overFriends` (on by default since D6) lets the high arc go over it. Both blocked: the low arc's
  answer, not clear, with `other` saying what the high arc met.
- **Cost:** about 6 flights per answer in the fights (most warm-started; 17–19 with `overFriends`, whose high arcs are
  searched cold), 50–65 µs p50 inline through prismarine-world and 36 µs on a worker over the shared world, against
  hawkEye's 380+ flights and ~640 µs on every tick of every drawing archer (docs/36 §3.3).

### 11.4 The job API

- `jobs.submit({ type: 'aim', input: AimInput, priority: 100 + k, deadlineTick: jobs.currentTick + 2 })`, k being the
  update's draw tick: later updates first, all above the default priority 0 of the paths and searches to come. The
  answer is an `AimSolution`. Types in `aim/solve.d.mts`.
- **`AimInput`:** `dim` (the store's name, `SharedWorld.dimensionOf`), `speed`, `from` (the arrow's start at the release),
  `vel` (the shooter's movement the launch adds), `shooter` (its id, never hit), `team` (0: read from the shooter's
  snapshot row), `friends` (entity ids), `target` (`{ id, x, y, z, vx, vz, width, height }`, or a point without id),
  `lead`, `warm` (`{ pitch, arc, ticks }` of the last answer), `overFriends`, `mobs` (`'neutral'` makes mobs obstacles; `shoot` never
  sets it).
- **`AimSolution`:** `yaw`, `pitch` (mineflayer's radians, for `bot.look`), `arc`, `ticks` (to what is hit), `hit`
  (`target` / `enemy` / `friend` / `block` / `entity` / `none`), `clear`, `at`, `entity`, `block`, `aim` (the led point),
  `unknown`, `flights`, `outOfRange`, `other` (what the other arc met, when both were flown).

### 11.5 `shoot` on the schedule (`aim/draw.ts`)

- **The clock** is the bot's own `physicsTick` (a 50 ms fallback when it stops). The loop runs after the tick's position
  packet, so a look set at tick t goes out with tick t + 1's packet.
- **Update 0 before the draw** (a job: submitted at once, waited for up to 4 ticks, else solved inline). A wall on both
  arcs: « no clear line of fire » at once, nothing drawn. A friend in the line: drawn anyway (friends move).
- **Tick 0:** `use_item`. auto-eat is paused until the release (a meal would take the hand and drop the draw), and
  `shoot` lets a meal in progress finish (≤ 3.5 s) before it takes the hand back.
- **Updates** on the ticks of `aim.schedule` (`[0, 10, 11, 12, 13, 14, 20, 21, 22, 23]`): a job is submitted two ticks
  before its tick (an answer comes at most two pool ticks after its submit, §8.4) and taken on its tick (an early one
  waits); inline, an update is solved on its tick. An answer that misses its window (up to the next update's tick), or
  is `late`, keeps the last aim.
- **Turning:** every tick the look is interpolated (the yaw the short way) from where it was when the newest answer was
  taken to that answer, arriving exactly on the next update's tick (the release after update 23). `bot.look(…, true)`:
  the packet carries the yaw exactly, with no per-tick turn limit.
- **The release** on tick `aim.drawTicks` (24), after the packet that carried update 23's look. A blocked answer then is
  held, asked again every tick, up to `HOLD_TICKS` (20): released one tick after a clear answer is taken, else put down
  unfired (a hotbar switch away and back makes the server drop the use: no arrow) with « no clear line of fire: a
  friend is in the way (…), … (put down unfired) ». A target that dies mid-draw is shot at the last aim.
- **The contract is unchanged:** `{ shot: true }` when the arrow count drops; « no clear line of fire » when blocked (the
  commands step aside); `BotLeftError` / `OrderStoppedError` pass through (the guarded bot's calls throw them); volleys
  at a point keep `bowAim`'s low arc (the solver's point mode is the same root, tested equal). New messages: « the
  target is gone … put down unfired » (it died with the line blocked), « the draw was interrupted (… in hand) ».
- **The target's velocity:** a least-squares slope over its positions of the last 800 ms (up to 16, one per tick), kept
  per entity object across shots, capped at 0.6 blocks a tick, reset by a jump over 4 blocks. Not the snapshot's
  one-tick velocity: the server sends a player's position every 2 ticks and a mob's every 3, so a one-tick velocity
  reads 0, 0, 3v. Other entities are tested where the snapshot has them, not led.
- **Crossbow:** charged for 27 ticks (25 + 2), released (loaded), fired on tick 29 by `use_item` at the final look; the
  late updates move with the fire tick. A crossbow loaded by a draw that did not fire fires on the next draw's
  schedule. Not run live (no kit or stock command uses one).

### 11.6 Measured

`bench:fight --port 8793 --rounds 3` (10 guards + 10 archers a side, blue `defend`, red `raid`; round 1 profiled, so
slower), on this branch's dev server (port 25621), the same machine state within an hour; the Ryzen 9 9950X3D was
shared with other agents' servers and builds, so compare these runs with each other, not with docs/36. The baseline is
this branch before P3 (hawkEye), run first. Runs in `squad/bench/.runs/` (gitignored): `…-base-hawkeye`,
`…-p3-final-inline` (a), `…-p3-final-jobs4-world` (b, `--jobs 4 --world`).

| rounds 1 / 2 / 3 | baseline (hawkEye) | (a) workers off: inline | (b) 4 workers + shared world: jobs |
|---|---|---|---|
| **full-strength ELU** (seconds with > 30 alive) | 0.70 / 0.69 / 0.65 | **0.36 / 0.34 / 0.35** | **0.36 / 0.41 / 0.35** |
| round ELU | 0.42 / 0.47 / 0.43 | 0.19 / 0.26 / 0.24 | 0.22 / 0.23 / 0.23 |
| shots (`shoot` calls) | 690 / 624 / 662 | 552 / 365 / 488 | 451 / 449 / 409 |
| **arrow kills per shot** | 3.2 / 3.7 / 3.3 % | **4.0 / 5.2 / 3.5 %** | **5.1 / 3.8 / 4.6 %** |
| arrow kills per arrow released | 3.4 / 3.9 / 3.5 % | 5.2 / 6.7 / 5.1 % | 6.8 / 5.2 / 6.1 % |
| **failed shots** (any HelperError) | 3.9 / 3.5 / 4.2 % | **21.6 / 19.2 / 31.8 %** | **27.7 / 26.3 / 22 %** |
| ↳ a friend in the way after the hold | — (shot into the friend) | 13 / 13 / 24 % | 16 / 16 / 12 % |
| ↳ the target gone (blocked last aim, or before the draw) | | 5 / 5 / 4 % | 6 / 7 / 7 % |
| ↳ no arrow left the bow (the server fired nothing) | 3.9 / 3.5 / 4.2 % | 1.6 / 0.5 / 1.8 % | 4 / 1.8 / 1.2 % |
| ↳ a meal took the hand | | 1.4 / 0.8 / 1.6 % | 1.6 / 1.8 / 1 % |
| **friendly kills** | 0 | **0** | **0** |
| winner | red ×3 | red ×3 | red ×3 |
| **the aim's share of busy** (round 1's profile, cause "aim") | **42.2 %** | **1.9 %** | **1.1 %**, plus the job pool's dispatch 4.4 % (of which the entity snapshot's write 3.5 %) |
| entities per bot / packets per second per bot (> 30 alive) | 122 / 1 150 | 59 / 600 | 58 / 570 |

- **The aim went from 42 % of the main thread to 1–2 %.** An inline answer costs 50–65 µs p50 (110–135 µs p95), about
  6 flights; a job 28–54 µs on a worker, the four workers using 0.01–0.03 ms of their 40 ms per tick. Jobs: latency
  p50 62–77 ms, p95 90–104 ms (submit → applied); 2–11 % of the job answers were late (the last aim kept; more in
  round 3), and 16–38 first answers per round fell back to an inline solve.
- **(b) is not cheaper than (a) at this scale:** the aim leaves the main thread, but the job pool publishes the entity
  snapshot every tick, merging every bot's entities (40 bots × ~60, up to ~120 with many arrows): 3.5 % of busy, more
  than the inline aim's 1.9 %. Before the defaults flip, the snapshot wants a cheaper writer (incremental, or the rows
  near the shooters only); P4/P6's jobs pay it anyway.
- **What is left is packets.** At full strength packet handling is 45–60 % of busy; it grows with the arrows in the air
  (each bot tracks each arrow): the same aim with `aim.overFriends` (more arrows, on 4–5 s lobs) ran at 0.41–0.45.
- **Accuracy:** more kills per shot and per arrow than hawkEye. The failed shots are mostly refusals: a friend (most
  often another archer: `raid`'s second row of archers stands behind the first, `defend`'s archers on a ring) stays in
  the line after the 1 s hold; hawkEye fired those arrows into the friend (wasted: the mod cancels the damage). The
  docs/36 "failed" (no arrow left the bow) is down from 3.5–4.2 % to 0.5–4 %.
- **The lead** (blocks, p50 / p95: where the target was when the arrow got there, against each estimate at the release):
  least-squares 0.63–0.92 / 2.4–3.3; one-tick (the snapshot's) 0.58–1.1 / 3.0–4.1; no lead 0.44–0.98 / 2.2–3.4. The
  smoothing beats the one-tick velocity in the tails; in these fights (players fighting, turning often) no lead is as
  good. Steady walkers (a marching raid, mobs) are what the lead is for; it is kept.

Variants (inline unless said), for the choices of §11.7:

| rounds 1 / 2 / 3 | full-strength ELU | failed shots | arrow kills per shot | high-arc shots |
|---|---|---|---|---|
| `p3-inline` (first build: a friend refused at once, no meal pause) | 0.39 / 0.33 / 0.30 | 81 / 75 / 76 % | 0.9 / 2.0 / 1.5 % | 0 |
| `p3-inline-2` (a friend held then refused, no meal pause) | 0.36 / 0.32 / 0.31 | 32 / 36 / 35 % | 5.2 / 3.7 / 4.0 % | 0 |
| `p3-inline-3` (the high arc over friends, meal pause: `aim.overFriends`) | 0.45 / 0.41 / 0.43 | 7 / 9 / 4.5 % | 3.4 / 3.2 / 4.0 % | 310 / 353 / 169 |
| `p3-jobs4-world` (jobs, over friends; round 1 only: round 2 hit a Windows `EPERM` renaming the roster file) | 0.49 | 14 % | 3.3 % | 291 |

### 11.7 Deviations from §3, and what is not done

1. **A friend in the line is not refused at once.** §3 has a friend block the shot (« no clear line of fire », the
   command steps aside), and so it does, but after the draw: a friend-blocked first answer is drawn anyway, and a line
   still blocked at the release is held up to 20 ticks (asked again every tick) before the bow is put down unfired.
   Friends move: in the fights 40–60 % of the held draws found a clear line and were released. The stock formations put
   archers behind archers (`raid`'s two rows of archers, `defend`'s ring of 6), and in the fights the friend in the
   way was mostly another archer: 12–24 % of the shots end refused that way (§11.6). `aim.overFriends` (on by default since D6) lobs over
   the friend on the high arc instead, as over a wall: measured, about half the shots then go high, failed shots fall
   to 4.5–9 %, but the kills per arrow fall (3.3–4.1 % against 5.1–6.8 %) and the arrows in the air (4–5 s each) raise
   the packet load (full-strength ELU +0.1). Fixing the formations (staggered rows, a 1-block sidestep for a friend)
   is the commands' side, not done here.
2. **The release can be later than tick 24:** only while held (above), or by a burst of catch-up ticks.
3. **A target that dies mid-draw is shot at the last aim** (as hawkEye's `stop()` did), rather than put down: the
   arrow can still find someone in the crowd, and the shot is not a failure. With a blocked last aim, it is put down.
4. **auto-eat** is paused for the draw (`disableAuto` / `enableAuto`, R3's rule for multi-step sequences), and `shoot`
   lets a meal finish before it takes the hand (≤ 3.5 s). Found in the first run: 30 % of the draws were dropped by a
   meal starting mid-draw. auto-eat 5 also leaves `isEating` stuck at true after a failed equip (`eat()` throws
   without resetting it), so only a change of the held item counts as an interruption.
5. **The target's velocity is smoothed on the main thread** (least squares, per entity, across shots), not taken from
   the snapshot. Measured at the release against where the target really was when the arrow arrived (§11.6): the
   one-tick velocity was the worst at p95; in these fights (players fighting, turning often) the smoothed lead and
   no lead at all were about even. Other entities are not led.
6. **The aim runs as jobs only with both `workers.count` > 0 and `world.enabled`:** without the shared world a worker
   sees no block, so the aim is solved inline over the bot's own world instead.
7. **Not built:** the `raycast` and `los` job types of §2.5 (nothing calls them yet; `solve.mjs`'s `walk`/`entry` are the
   pieces); water drag in the pitch search (only the checked flight applies it); Quick Charge on crossbows.
8. **"Done when"** (§4), against today's baseline on the same machine (full-strength ELU 0.65–0.70; docs/36 had
   0.60–0.66):
   - full-strength ELU ≤ 0.35: (a) 0.36 / 0.34 / 0.35 (round 1 profiled), (b) 0.36 / 0.41 / 0.35: about met, from
     0.65–0.70. What is left is packet handling, which grows with the arrows in the air;
   - arrow kills per shot ≥ 3.2 %: met, 3.5–5.2 %;
   - failed shots ≤ 5 %: **not met**, 19–32 %: mostly D5's own check (a friend in the line, after the 1 s hold) and
     targets that died with a blocked line. With `aim.overFriends` 4.5–9 %, at fewer kills per arrow and +0.1 ELU;
   - friendly kills 0: met.
9. **Live:** `LIVE_ONLY=items` on this branch's dev server, through the mod (`LIVE_RUNTIME_PORT=8793`, and the new
   `LIVE_MOD_PORT=8793`: `items.ts` had the mod's port fixed at 8779, so the mod scenarios were skipped on any other
   port): 11/11 passed, among them `tir`'s volley of 3 each on the ground and the husk the captain shot (« Cible
   abattue (husk) : 6 flèches. »), `ligne-archers`, and `epee` with archers.
10. **The tests:** `tests/aim.test.ts` (19), the shoot tests of `helpers.test.ts` and `defend.test.ts` rewritten for
   the real draw (FakeBot's `archer()`), the stock commands' tests record their targets through `tests/fakes/shots.ts`
   (the real `shoot` still runs). Two stock-test layouts were moved (`item-orders.test.ts`): archers standing one
   behind the other in the line of fire now stop each other's arrows, as they should.

## 12. P4 as built (2026-11-01)

A* runs on the reader workers, over the shared world. docs/32 D's pathfinding worker pool (`bots/pathworkers/client.ts`,
`worker.mjs`: one parsed mirror of every chunk in each worker) is gone. **Off by default** (`workers.count` 0): every
search stays on the main thread, as before; the orchestrator turns it on after the final measurements.

**Files:**

| File | What |
|---|---|
| `squad/src/jobs/handlers/path.mjs` | The `path` job type: the patched mineflayer-pathfinder's `AStar`, `Movements` and goals over a stand-in bot that reads the store; the slices, the progress, the timeout's discount |
| `squad/src/world/blocks.mjs` (+ `.d.mts`) | `BlockTemplates` (one prismarine `Block` per state id, specialised by position) and `StoreWorld` (prismarine-world's sync `getBlock`/`raycast` over the store). P5's `blockAt` can use them |
| `squad/src/bots/pathworkers/offload.ts` | `PathOffload` (main thread): the `searchOffload` hook, the submit, the cancels, the fallbacks, `stats()`; `OffloadedSearch`, the AStar context the plugin sees |
| `squad/src/bots/pathworkers/serialize.ts` | Kept from docs/32 D: goals, Movements settings and paths across threads |
| `squad/src/world/shared-world.ts` | + `applied()`, `dimensionOf(bot)`, `isLive(dim, x, z)`, `writerState` |
| `squad/src/jobs/pool.ts`, `batch.mjs`, `worker.mjs` | + the progress channel, elastic types, `workersAlive()` (§8.6) |
| `squad/src/config.ts`, `main.ts`, `bots/pool.ts` | One pool (`workers.count`; `pathfinding.workers` its alias), the world on with the workers; the job pool built before the bot pool; the workers' heaps sized (`READER_HEAP`); the bot pool's seam is `pathSearch.install(bot)` at spawn (the shared world's own `attach` follows the packets) |
| `squad/src/vitals/metrics.ts` | `/api/metrics` `paths`: the offload's counters |

Tests: `tests/pathworkers.test.ts` (18, rewritten for the new path), `tests/ladders.test.ts` (its worker case ported),
`tests/jobs-long.test.ts` (7: the progress channel, elastic types, `resourceLimits`), on a shared rig (`tests/fakes/path-rig.ts`: the
real shared world, job pool and `path` handler).

**A search, end to end:**
1. The plugin plans (its own `planPath`, never a caller's `getPathTo`) and calls `searchOffload`. `PathOffload` checks
   what can cross (or falls back, below) and cancels the bot's previous search. Then **the probe**: the plugin's own
   A* runs here for at most 3 ms (`DEFAULT_PROBE_MS`; all probes together at most 10 ms per 50 ms window,
   `PROBE_BUDGET_MS`, outside the A* budget). Done, the answer is returned at once
   (`ProbedSearch`), as without workers. Not done, it returns an `OffloadedSearch`, whose `compute()` answers
   `partial` with the probe's best path until the worker reports (the start node alone if the probe found none: never
   an empty path, which `goto()` would take for "arrived").
2. Once `SharedWorld.applied()` resolves (the writer has applied every batch sent so far, so a block change heard just
   before is in the store), it submits `{ type: 'path', input, signal, onProgress }`: priority 0 (below P3's aim), no
   deadline.
3. On a worker, the first slice builds the search: a `StoreWorld` for the bot's dimension; a stand-in bot (blocks from
   the store, the request's inventory and effects, `index.js`'s `bestHarvestTool`); a `Movements` made with
   `Object.create(Movements.prototype)` and the settings (its constructor walks the registry, ~1 ms, and the settings
   carry every field it sets, or serialize.ts refuses them); the goal rebuilt by class; `new AStar(…)`.
4. Each slice runs `computeSlice` for its share (`ctx.shareMs()`, at least 0.5 ms; a quarter of it once the search
   has computed 50 ms and others follow it in the batch; the batch's last slice leaves up to 5 ms unused), after
   emptying `Movements`' block cache if the store's version moved (`blockUpdate` on the stand-in, `lib/tick.js`). Still partial, it answers `{ continue, progress }`:
   the chunks entered since the last slice, and the best path on the first slice, then when it changed, at most every
   250 ms. Done, the answer.
5. On the main thread, `onProgress` adds the chunks to `visitedChunks` (the plugin re-plans when one next to them
   loads) and rebuilds the partial path as `Move`s once; `compute()` returns it until the next one. The answer is
   rebuilt the same way.

**Decisions:**
- **The probe.** Without it, gather on the workers mined a fraction of the logs of the main thread (run d1 below, 1
  worker: 28 logs at 30 bots against 167). A worker's first answer comes 1–3 ticks after the search, and meanwhile the
  plugin resets the search on every block change next to the bot (`block_updated`: 547 in that phase). In gather
  those come all the time (logs cut, leaves decaying, the neighbours chopping), so searches were cancelled again and
  again before they answered (497 of 784). Most of gather's searches are short (0.7–1 ms at the median on the main
  thread), so they are answered by the probe at once, as before, and only the long ones (walking, exhaustive
  searches for unreachable logs) move to the workers. The probes have their own budget (10 ms per 50 ms window):
  under the A* budget, each got its fair share of 20 ms, ~0.7 ms at 30 bots, and only 22 % of gather's searches ended
  there (run c2).
- **Scheduling on a worker.** Searches share the batch's budget evenly (an elastic type), with two corrections. A
  search that has computed 50 ms keeps a quarter of its share when others follow it (least attained service: gather's
  exhaustive searches for unreachable logs, 13 000–20 000 nodes, no longer slow down the short ones). And the batch's
  last slice leaves up to 5 ms of the budget unused: a batch that ran the full 40 ms was often still out at the next
  dispatch (the bot ticks the dispatcher follows are 31–62 ms apart on Windows), and every worker then ran a batch
  every other tick, 20.0 ms a tick on average instead of 40 (run c3).
- **Elastic slices, not the bot's `tickTimeout`.** A first version sliced at the bot's `tickTimeout` (10 ms, as on the
  main thread). One bot walking on the dev world then planned in 1.1 s p50 (the main thread: 1.6 s), its worker busy
  2.6 ms a tick out of 40. With the worker's share instead: 87 ms p50. `tickTimeout` keeps a search from holding up
  the bots' event loop; a worker has no bots.
- **`thinkTimeout`** is wall time from the first slice, as on the main thread, minus the ticks the search got no slice
  because its worker's budget went to other jobs (counted in ticks, capped by the wall time, since the ticks of one
  catch-up burst share one dispatch). The main-thread A* budget's waits do not count either. The queue's wait before
  the first slice does not count (the AStar starts on the worker).
- **Cancellation:** the plugin's `path_reset`, `goal_updated`, `path_stop`, the bot's `end` and a newer search for
  the same bot abort the job's signal. The pool takes it off the queue or, if it is out, drops its state on the worker
  when the slice comes back. A dropped search never runs on the main thread.
- **Fallbacks** to the main-thread search, counted by reason (`PathOffload.stats()`): `goal`, `movements` (cannot
  cross, serialize.ts); `noDimension`; `noColumn` (the bot's own column not live in the store yet); `noWorld` (the
  writer disabled); `noWorker` (no live worker: the pool's inline fallback would run it on the main thread anyway, so
  the plugin's own search does, under the A* budget); the job's failure (`threw`, `workerDied` when its worker died
  twice under it, `lostInput`, `clone`, `unknownType`, `unavailable`, `stopped`, `late`); `deadline` (no progress
  for `thinkTimeout` + 2 s: a wedged worker, which the pool itself cannot see). A worker that dies once mid-search:
  the pool queues the job again from the start, on the restarted worker, which needs no resync.
- **Blocks:** one template per state id (`Block.fromStateId`, kept), specialised with `Object.create(template)` and an
  own `position`; what Movements and raycasts write lands on that object. On one thread: 35–56 ns a lookup over 20–200
  distinct states, against 140–240 ns for `fromStateId` (at 2 000 distinct states the prototypes go megamorphic and it
  is slower, 790 against 360 ns; a search touches tens to hundreds). `Movements`' own `getBlock` (a string key and a
  Map per lookup) now dominates a node: a whole search costs 37 µs a node over the store against 40 µs over
  prismarine-world (the same answers in 90 of 90 searches on a synthetic forest). The gain is where A* runs.
- **Config:** one pool. `pathfinding.workers` is read when `workers.count` is not set; `workers.count` wins when both
  are. `world.enabled` defaults to `workers.count` > 0, because A* (and P3's aim) need the store; an explicit `false`
  with workers on keeps every search on the main thread and says so at start.
- **Memory: each worker's heap is sized** (`main.ts` `READER_HEAP`: a young generation of 16 MB, an old one of
  512 MB, through the pool's new `resourceLimits`). The first live runs grew ~240 MB of RSS per worker (§12.1). It
  was not state kept without a bound: after a forced GC every worker held 26 MB (its registry, Block templates and
  code; templates are bounded by the 26 684 states, a `Movements` is made per search and dropped with it), 31–35 MB
  while 7 047 searches were cancelled in a minute (a cancelled search's state is dropped on its worker), at most 125 MB
  live with 30 searches on one worker, and RSS was flat over time. It was garbage: A* allocates per node (a `Move`, a
  `PathNode`, a hash string, keys and blocks), and against V8's default limit (4.3 GB on this 64 GB machine) each
  isolate let 150–320 MB of it pile up before collecting (335–442 MB committed per worker). Sized to its job, each
  collects early. A worker that outgrows 512 MB (4× the worst live set measured) dies and is restarted like any dead
  one. Two allocations per block lookup were also cut (the `Vec3` Movements passes becomes the block's position;
  `getNumEntitiesAt` answers 0 without building its key when no entity is in the way): 17 % more searches in the same
  time on the synthetic load below, the same RSS.

**Measured:** §12.1 (below).

**Not done, known:**
- A worker wedged inside a batch (a handler that never returns) is not detected by the pool (P2): the offload's
  `deadline` gives up on its searches, but the slot stays busy. A* slices are bounded by their own clock.
- `Movements`' per-node cost (its string-keyed block cache) is unchanged: the next gain for A* is there, not in block
  lookups.
- Unreachable logs are still searched again by every `mineBlock` call (docs/31 §11.9).
- Gather with the workers (§12.1): a pending search is cancelled by every `block_updated` reset and restarts.
- The bots keep their own worlds (P5).

### 12.1 Measured (2026-11-01)

The Ryzen 9 9950X3D of docs/31 §11.2, shared with other sessions' servers and benches all along: the numbers are
indicative. `bench:load` on the dev server (port 25631), the runtime's 4 s login stagger, 60 s phases, N = 10 then 30.
Each run on its own forest (`--center`) unless marked "after": gather cuts the reachable logs first, so a second run
on a site gets those nobody can reach (c2 and c3 below: their gather measures the site, not the code).

**Memory, a steady synthetic load** (offline: 30 searches kept in flight over a 17 × 17-column synthetic forest, a
third of them unreachable, the pool's own 50 ms ticks, 60 s):

| Workers | RSS growth, V8's default heap | with `READER_HEAP` (16 MB young, 512 MB old) | searches done |
|---|---|---|---|
| 1 | +612 MB | +227 MB | 599 |
| 4 | +1 521 to +1 683 MB | +497 MB | 1 110 |
| 8 | +2 676 MB | +707 MB | 1 678 |

- Over time, 8 workers, sized heaps, 180 s: 1 181 MB at 10 s, 1 370 MB at 70 s, then 1 351–1 384 MB to the end.
- Per worker: 26 MB after a forced GC; before it 156–324 MB used (335–442 MB committed) with V8's default limit
  (4.3 GB here), 95–128 MB committed with `READER_HEAP`. Idle: 35 MB for a bare reader worker, 58 MB with the `path`
  handler (its registry).

**Live** (legs and logs in the 60 s phase; the main thread's ELU; loop p99; path timeouts and RSS in the N = 30
gather phase). Every bot ran at 20 ticks/s in every phase (the slowest 19.6–20).

| Run | Site | A* | Walk legs N = 10 / 30 | Gather logs N = 10 / 30 | ELU walk / gather (N = 30) | p99 ms | Timeouts | RSS MB |
|---|---|---|---|---|---|---|---|---|
| docs/31 §11 | (64, 4064) | main thread | 52 / 143 | 119 / 173 | 0.584 / 0.624 | 37 | | 2 700 |
| a | (−2968, −64) | main thread | 46 / 143 | 81 / 167 | 0.615 / 0.664 | 57 | 30 | 2 498 |
| a3 | (2840, −3160) | main thread | 57 / 160 | 109 / 199 | 0.548 / 0.651 | 53 | 46 | 2 604 |
| a4 | (−5840, −128) | main thread | 36 / 132 | 44 / 30 | 0.542 / 0.666 | 176 | 18 | 2 704 |
| b | (2904, 2840) | old pool, 4 workers | 24 / 92 | 59 / 65 | 0.269 / 0.322 | 17 | 70 | 4 029 |
| f | (−192, −480) | old pool, 8 workers | 38 / 124 | 65 / 89 | 0.240 / 0.387 | 22 | 21 | 6 652 |
| d1 | (3320, 352) | P4, first version, 1 worker | 32 / 83 | 25 / 28 | 0.242 / 0.328 | 19 | 87 | 2 207 |
| e1 | (384, −2776) | P4, first version, 8 workers | 14 / 42 | 33 / 34 | 0.221 / 0.348 | 17 | 25 | 3 870 |
| d2 | (−1152, 2200) | P4 + probe + `READER_HEAP`, 1 worker | 42 / 161 | 77 / 70 | 0.294 / 0.395 | 24 | 70 | 2 019 |
| c2 | (−2968, −64), after a | the same, 4 workers | 34 / 116 | 30 / 86 | 0.283 / 0.414 | 24 | 74 | 2 208 |
| e2 | (−4024, −3064) | the same, 8 workers | 41 / 137 | 65 / 89 | 0.305 / 0.435 | 22 | 79 | 2 450 |
| c3 | (2840, −3160), after a3 | + scheduling, 4 workers | 49 / 132 | 19 / 22 | 0.269 / 0.380 | 21 | 183 | 2 045 |
| **c4** | (6128, 256) | **as built**, 4 workers | **63 / 185** | **46 / 50** | **0.245 / 0.346** | **20** | 135 | **2 266** |

"First version": elastic slices, no probe, V8's default heap. "Probe": the probe under the A* budget (as built, it has
its own). "Scheduling": least attained service and the probes' own budget; the
batch's tail headroom came after c3. A first run of c (4 workers, at (2840, −3160)) ended 50 s in, during the logins,
with exit code 0 and nothing logged (no crash in the Windows event log). The five later runs with workers on, under an
exit hook, all ended normally; it was not reproduced and its cause is unknown.

What this shows:
- **Memory is nearly flat with the worker count:** about 60 MB a worker live (2.0 / 2.2 / 2.45 GB at 1 / 4 / 8
  workers, N = 30 gather), against ~240 MB a worker before the heaps were sized (2.2 → 3.9 GB at 1 → 8) and ~660 MB
  for the old pool (4.0 → 6.65 GB at 4 → 8). With workers on, the process is smaller than with them off (2.5–2.7 GB):
  the main thread no longer keeps the searches' garbage.
- **Walking is at or above the main thread:** as built, 63 / 185 legs against 36–57 / 132–160 on three fresh forests
  (docs/31 §11: 52 / 143), with the main thread's ELU at 0.25 instead of 0.54–0.62 and its loop p99 at 17–20 ms.
- **Gathering is not shown to be as good, and is probably worse at 30 bots.** The site dominates: with workers off
  the three fresh forests gave 44–109 logs at N = 10 and 30–199 at N = 30. With workers on (d2, e2, c4): 46–77 and
  50–89, the medians 65 and 70 against the controls' 81 and 167. The searches that go to a worker in gather mostly
  do not end well: at N = 30 in c4, 663 offloaded, 469 cancelled (447 `block_updated` resets), 194 answered of which
  135 timed out; the probe answered 124. A search pending on a worker is reset by every block change next to the bot
  and starts again from nothing, so gather's longer searches rarely finish. Not done: carry a pending search over a
  `block_updated` reset when the goal is the same (the block change is in the store by its next slice), or let the
  probe run longer.
- **The live core tests pass:** `LIVE_ONLY=core npm run live-test` 7/7 with workers off and 7/7 with `LIVE_WORKERS=4`
  (18 searches answered by the probe, 11 offloaded, 10 answered, 1 cancelled, no fallback).

**Against "done when":** walk ≥ docs/31 §11, yes; gather ≥ docs/31 §11, not shown (above); the live core tests,
yes; memory flat with the worker count, yes (~60 MB a worker). `workers.count` stays 0.
