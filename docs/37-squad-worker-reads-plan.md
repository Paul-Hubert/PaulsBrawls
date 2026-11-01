# 37 — Squad: read-only work on worker threads, one shared copy of the world (plan)

> Plan, 2026-11-01. **P1 is built** (the shared world, off by default; as built: §8). The rest is a plan. It follows
> the measurements of [docs/36](36-squad-fight-performance.md) and Paul's decisions of the same day. Every expected number is an estimate from docs/36's profiles and is
> re-measured after each phase with `bench:fight` and `bench:load`.

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
| **P1** ✅ | L | The shared world: pages, sections, index, epochs, cache, per-state tables, the writer thread, fed from the bots' packets beside today's worlds (nothing reads it yet) | **Done 2026-11-01** (§8): 19 tests on fakes (`tests/world.test.ts`); the live probe (`live-tests/probe-world.ts`), three runs, each comparing 184.6 M blocks of 1 878 held columns twice: 0 mismatches |
| **P2** | M | The job queue, dispatcher and reader workers (budget, priorities, deadlines, carry-over, affinity, fallbacks, metrics), with a test job type | Unit tests (budget respected, priorities, `late`, a worker killed mid-batch); `/api/metrics` shows the queue |
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
"world":   { "enabled": false, "cacheSeconds": 60, "cacheColumns": 2000, "verify": false, "shared": false },
"aim":     { "schedule": [0, 10, 11, 12, 13, 14, 20, 21, 22, 23] }
```

- `world.enabled`, `cacheSeconds`, `cacheColumns` and `verify` exist since P1 (§8): `world.enabled` builds the store
  (P2/P3 turn it on), `verify` is the debug comparison of §6.

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

## 8. P1 as built (2026-11-01)

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
