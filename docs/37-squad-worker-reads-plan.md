# 37 — Squad: read-only work on worker threads, one shared copy of the world (plan)

> Plan, 2026-11-01. It follows the measurements of [docs/36](36-squad-fight-performance.md) and Paul's decisions of
> the same day. Every expected number is an estimate from docs/36's profiles and is re-measured after each phase with
> `bench:fight` and `bench:load`. **Built so far: P2** (the job queue, dispatcher and reader workers, off by default;
> as built in §8). The rest is a plan.

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
| **P0** | S | **Fix the hawkEye leak now** (`freshHawkEye`: take the new module out of its parent's `children`). Merge `squad-fight-bench` (bench, stagger, kits) once the docs/35 session has landed | `bench/repro-hawkeye-leak.ts` prints 0/20; RSS flat across `bench:fight` rounds |
| **P1** | L | The shared world: pages, sections, index, epochs, cache, per-state tables, the writer thread, fed from the bots' packets beside today's worlds (nothing reads it yet) | Unit tests on fakes (publish, tombstone, epoch reuse, cache states, dedup). A live parity probe: for every block of every column held, the store's state id = `bot.world.getBlockStateId` |
| **P2** ✅ | M | The job queue, dispatcher and reader workers (budget, priorities, deadlines, carry-over, affinity, fallbacks, metrics), with a test job type | **Done 2026-11-01** (§8): `tests/jobs.test.ts` (budget respected, priorities, `late`, a worker killed mid-batch, …); `/api/metrics` shows `jobs`. Off by default (`workers.count` 0) until P3 |
| **P3** | M | Raycast (blocks + hitboxes), LOS and the aim solver as jobs; `shoot` on the schedule with turning; hawkEye removed | `bench:fight`: full-strength ELU ≤ 0.35 (from 0.60–0.66); arrow kills per shot ≥ 3.2 %; failed shots ≤ 5 %; friendly hits 0. Live items tests (`tir`, `ligne-archers`, `defend`) pass |
| **P4** | M | A* on the reader workers over the shared world (Movements reads per-state tables); the old per-worker mirror retired | `bench:load` walk / gather at 10 and 30 bots: legs and logs per minute ≥ docs/31 §11; live core tests pass; process memory flat with the worker count |
| **P5** | L | The bots read the one copy: a patched mineflayer blocks plugin sends chunks to the writer; `bot.world` is a shared store-backed world (prismarine-world's sync API, `blockUpdate`/`chunkColumnLoad`/`chunkColumnUnload` per bot, block entities on the main thread). Behind `world.shared` (default off until it passes) | `bench:fight` and `bench:load`: ~30–40 MB less per bot; 40 logins with no stall over 250 ms; every live test passes with `world.shared: true` |
| **P6** | S | `findBlocks` as a job (gather's search) | `bench:load` gather unchanged or better, no main-thread freeze in the docs/31 §2.6 case |

**Order:** P0 → P1 → P2 → P3 (the 45 %) → P4 → P5 → P6.
- **P1 and P2 are new files,** clear of the docs/35 session's edits.
- **P3 changes `shoot`** (`squad/src/api/helpers.ts`), so it starts after docs/35 has merged.

## 5. Configuration (`squad.json`)

```json
"workers": { "count": 4, "tickBudgetMs": 40 },
"world":   { "shared": false, "cacheSeconds": 60, "cacheColumns": 2000 },
"aim":     { "schedule": [0, 10, 11, 12, 13, 14, 20, 21, 22, 23] }
```

- `workers.count`: default cores − 2.
- `pathfinding.workers` remains an alias of `workers.count`.
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
  (P4 merges them); until then each pool caps itself at cores − 1 on its own.
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

