# Prompt: implement the Squad performance fixes of docs/31, on a more powerful computer

> Paste everything below the line into a Claude Code session started at the repo root (branch `rework`) on the new
> machine. It implements and verifies what [docs/31](31-squad-performance-review.md) recommends. Paul asked for all of
> it, done by sub-agents. The measurements of docs/31 were made on a laptop (i7-1255U), so this machine's numbers will
> differ: it measures its own before/after.

---

You are implementing the performance fixes that the Squad review recommends: [docs/31](31-squad-performance-review.md)
§8 "Now", plus the optional A* budget and the pathfinding worker pool. Squad is the player-owned Mineflayer bot system
in `squad/` (one Node process) with a thin front in the Fabric mod (`src/main/java/com/paul/brawl/squad/`).

## Read first

1. **`docs/31-squad-performance-review.md`, the whole document.** In particular:
   - §0, the summary;
   - §2.6, the `gather` freeze;
   - §3.3, the four hot spots;
   - §4, every experiment and its numbers;
   - §5.2–5.5, the fixes;
   - §6.2, the worker pool design;
   - §8, the plan.
2. **`squad/bench/README.md` and `squad/bench/lib/instrument.ts`.** Every fix below exists there as a bench-only
   prototype behind a flag, measured. Port the logic; don't reinvent it.
3. **The rest of the background:**
   - `docs/system/squad/overview.md` (as built);
   - `docs/29-squad-design.md` §1 (owner decisions O1–O7, never relitigate) and §16;
   - `squad/README.md`;
   - the Squad sections of `CLAUDE.md`.

## Already done (commit `ab027f8`)

- The benchmark (`squad/bench/`) and the review.
- **The `gather` freeze, first half:**
  - `Squad.tasks` (`squad/src/api/squad.ts`) yields a macrotask (`setImmediate`) between items.
  - The stock `gather` (`squad/src/stock/gather.mjs`) stops starting batches once one finds nothing left.
  - Both pass `npm run check`, but **no test pins them yet**.

## Setup on this machine

- **Software:**
  - Node ≥ 22; then `cd squad && npm install`.
  - A JDK 21 for the mod. Set `JAVA_HOME`; there may be none on PATH.
- **The dev server:** `./gradlew runServer` at the repo root, which runs in `run/`.
  - Read the ports from `run/server.properties` (25599, RCON 25575, R28).
  - The first start generates `run/world/` (gitignored).
  - Start it **detached** (`Start-Process` on Windows, `nohup … &` elsewhere), not as a tool's background task: those are
    killed after 2 hours.
  - Stop it with `stop` over RCON (see `squad/live-tests/rcon.ts`).
- **For the bench,** raise `max-players` in `run/server.properties` to at least the largest N you run. Put it back to 20
  afterwards (`git checkout -- run/server.properties`).
- **Never start, stop or load-test the production server (`server/`)**, even if it exists here.
- **Keep the machine on AC power and awake, and don't let it lock.** Locking Paul's laptop put it into modern standby,
  which froze the runtime and the server and cost several runs. After every bench run, check that no phase overlapped
  a sleep (Windows: System log, Kernel-Power 506/507).
- **Line endings:**
  - Some tools on Windows write CRLF, and `core.autocrlf` may be off.
  - Before committing, make sure the files you changed have LF (`git diff --ignore-cr-at-eol --stat` against
    `git diff --stat`), except `*.bat`.

## Plan

Use sub-agents, one per workstream, each with explicit file ownership:
- **A and B** run in parallel; their files are disjoint.
- **C** runs after A and B; **D** runs after C.
- **After each agent:** run `npm run check` (and `./gradlew test` when Java changed) yourself, and read the diff before
  starting the next one.

### 0. Before anything changes: the baseline on this machine

Run the bench on the current code:
```
cd squad
npm run bench:load -- --ns 5,10 --stagger 1500 --phases idle,follow,walk,gather --center X,Z --label control-before
```
- `--center` must be a fresh forest: gather cuts the trees, so give each comparison its own site (§1 of docs/31).
  Find one over RCON: `execute positioned 2000 80 2000 run locate biome minecraft:forest`.
- Pre-generate it on the first run: leave out `--no-pregen`.
- Optionally also run `--ns 0,1,5,10,20,30` for this machine's capacity curve (docs/31 §2.1).
- Keep the run directories: the "after" runs are compared with them (`npm run bench:compare`, `bench:report`).

### A. Squad-side fixes

Files: `squad/src/api/squad.ts`, `src/api/helpers.ts`, `src/stock/gather.mjs`, `src/orders/guard.ts`,
`reference/squad.d.ts` (doc comments only), and tests.

1. **A test for the `gather` freeze fix:**
   - on the fakes (`tests/fakes/harness.ts`; see `bench/repro-tasks-spin.ts` for the setup);
   - prove that a 100 ms timer keeps firing while a gather of many failing batches runs, and that the gather ends;
   - plus a test that `gather` stops starting batches once nothing is left;
   - keep each test under about 2 s.
2. **`follow` keeps its goal** (docs/31 §5.3):
   - if the pathfinder's goal is a `GoalFollow` on the same entity at the same range, don't `setGoal` again;
   - at the end of a call, clear the goal after about 300 ms only if no later call kept it, and only if the goal is still
     that same object, so a timer can never clear another order's goal;
   - the R4/R5 abort sequence still clears goals at leave or end (don't change `bots/hardening.ts`);
   - mind the lease-guarded proxy: a deferred clear must not throw `BotLeftError` into nowhere;
   - tests on the FakeBot;
   - document it in `reference/squad.d.ts` if the documented behaviour changes, and keep `tests/agent.test.ts` green.
3. **The guard proxy** (docs/31 §2.4):
   - cache the namespace wrappers per namespace, property and function, and cache the `isClass` results (a `WeakMap`);
   - the semantics stay identical;
   - report the `guard:` rows of `npm run bench:micro` before and after.

### B. Dependency patches (`patch-package`)

Files: `squad/package.json`, `package-lock.json`, `squad/patches/`, `node_modules/` (through patch-package),
`tests/patches.test.ts`, `src/config.ts`, `squad.example.json`, one line in `src/main.ts`, one line in
`bench/README.md`, a note in `squad/README.md`.

- **Install the tool:** add `patch-package` (an exact version) and `"postinstall": "patch-package"`. Check that a
  reinstall applies the patches, and that a patch that no longer applies fails loudly.
- **The patches.** Keep each one minimal and upstreamable, in the package's own style.
  1. **prismarine-physics `index.js`, `PlayerState`:** hoist `require('minecraft-data')` and `require('prismarine-nbt')`
     to the module top, and keep the minecraft-data result per version. Measured: −53% idle.
  2. **minecraft-protocol `src/transforms/framing.js`, `Splitter._transform`:**
     - don't call `readVarInt` unless a complete varint is present (scan up to 5 bytes for one without the 0x80 bit);
     - no `PartialReadError` per TCP chunk;
     - the legacy-ping branch and the too-long varint error stay unchanged.
     Measured: −18% idle.
  3. **mineflayer-pathfinder:**
     - **(a) `lib/physics.js`:** the look-ahead decisions (`canStraightLine`, `canSprintJump`, `canWalkJump`) are reused
       for the same `path[0]` object and argument for 4 ticks, and the simulation's `world.getBlock` is cached for the
       tick. Measured: −73% look-ahead with both.
     - **(b) `lib/movements.js` `getBlock`:** cached per absolute position for the tick. Don't cache the unloaded
       placeholder: its `height` is relative. Measured: −17% A* per search, hit rate 77–85%.
     - **(c) The tick counter for (a) and (b):** one `physicsTick` listener per bot, through a module-level `WeakMap`.
       Never one per instance: pvp and scripts create their own `Movements`.
     - **(d) `index.js`:** "stuck" is 70 physics ticks instead of 3 500 ms of wall time. Measured inside the full set;
       alone it was mixed (docs/31 §4).
     - **(e) `lib/astar.js`:** an optional process-wide hard budget, `AStar.setBudget(ms)`, off by default.
       - All searches together spend at most `ms` per 50 ms window.
       - A search that finds the window spent returns its best partial path, and its waiting does not count against its
         timeout.
       - Each slice is also cut to a fair share.
       - See the bench's hard-cap version.
- **Config:** `pathfinding: { astarBudgetMs: 0 }`, validated, applied once at start in `main.ts`.
- **Tests:** `tests/patches.test.ts`, one test per patch, Minecraft-free.
- **The bench:**
  - the prototypes it made redundant can stay, but its `--physics-hoist` and `--stuck-ticks` source edits will now
    refuse (the code changed): say so in `bench/README.md`;
  - map the bench's `--astar-budget` to the real config;
  - add `--workers N` once D exists.

### C. Observability

Files: new `squad/src/` modules, `src/bots/pool.ts`, `src/main.ts`, `src/http/server.ts`, `src/service.ts`,
`src/journal/journal.ts`, tests; the mod's `SquadCommand`/`SquadClient` plus a Minecraft-free formatter with a JUnit
test.

1. **A lag monitor,** copied from `eden/src/journal/lag-monitor.ts` and owned in `squad/` from then on (O7):
   - `monitorEventLoopDelay` plus ELU, sampled every 10 s;
   - one `logger.warn` line when p99 > 250 ms or ELU > 0.9, at most one per minute.
2. **Per-bot counters in the pool:** physics ticks/s, path searches by outcome (`path_update`), "stuck" resets
   (`path_reset`), deaf trips, and skipped packets (process-wide).
3. **`POST /api/metrics`:**
   - `{ ok, text, loop: { p50, p99, max }, elu, cpuPct, rssMb, heapMb, skippedPackets, bots: [...] }`;
   - `text` is the French line the mod shows.
4. **One vitals row per minute in the journal** (a new `vitals` table, pruned after 7 days), never the hot stream (R44).
5. **`/bots status`** in the mod (perm 0): ELU, loop p99, the slowest bot's ticks/s.
   - Verify with `./gradlew test`, **never `./gradlew build`**: its finalizers copy the jar into the mods folders that
     `gradle.properties` names, which may be Paul's real installs.

### D. The pathfinding worker pool (docs/31 §6.2)

Behind `pathfinding.workers` (default 0 = off, today's behaviour). Files: new `squad/src/bots/pathworkers/…` (or
similar), `src/config.ts`, `src/bots/pool.ts` (feeding packets), tests. The patched `lib/astar.js` gets the hook it
needs, as a patch-package update.

- **What stays where:** the bots, their physics, the look-ahead and the scripts stay on the main thread. That keeps O2
  (the real bot) and O4 (instant reclaim).
- **The mirror:**
  - Forward each bot's `map_chunk`, `unload_chunk`, `block_change`, `multi_block_change` (and the 1.21.1 equivalents)
    to the workers.
  - Each worker keeps one prismarine-world per dimension, shared by all bots and deduplicated by chunk.
  - No copy per search.
- **The search in the worker:**
  - mineflayer-pathfinder's own `AStar` and `Movements`, over a stand-in bot that serves `blockAt` from the mirror;
  - the stand-in also serves `inventory.items()`, `registry`, `pathfinder.bestHarvestTool`, `game.minY`, `entity` and
    `entity.effects`, and `entities`, from a snapshot sent with each search request;
  - the movement settings (`canDig`, `allowParkour`, scaffolding, the blocks to avoid or not break, exclusion areas,
    `maxDropDown`…) are copied onto the worker's `Movements`.
- **On the main thread:**
  - `compute()` returns "partial" (an empty path) until the worker answers, then the worker's result;
  - known goal classes are serialized; `GoalFollow` becomes a position snapshot, and the main thread keeps
    `hasChanged`;
  - fall back to the main-thread search for unknown goals, a synchronous `getPathTo`, a dead worker, or a timeout.
- **Tests on the fakes:**
  - the worker finds the same path as the main thread on a small synthetic world;
  - every fallback;
  - a clean shutdown.

### E. Verify, document, commit

1. **Checks:** `npm run check`, `./gradlew test`, and `npm run live-test` on the dev server.
2. **Re-run the bench** against step 0, each comparison on a fresh forest with its own control in the same period:
   - **the defaults:** label `after`;
   - **with the A\* budget:** `pathfinding.astarBudgetMs` 20;
   - **with the worker pool:** `pathfinding.workers` = cores − 2.
   - Ramp to N = 20 and 30 when the machine holds them; it is more powerful than the laptop.
   - Compare with `bench:compare` / `bench:report`.
   - Decide the defaults from the numbers. Turn the worker pool on by default only if it is measured better and passes
     the live test.
3. **Docs (S8: behaviour and docs together):**
   - add a §11 "Implemented" to docs/31: what landed, this machine's numbers, the defaults;
   - update `docs/system/squad/overview.md` (the threads table, observability, not verified) and rebuild its index with
     `node docs/system/build-index.mjs`;
   - docs/29 §16;
   - the Squad sections of `CLAUDE.md` (a lag monitor and a metrics route now exist; the patches; the new config keys);
   - `squad/README.md`.
4. **Commit and push:**
   - one commit per workstream, in the repo's style (conventional subject, a body that says what and why);
   - LF line endings;
   - push to `rework`.

## Constraints

- **Owner decisions (docs/29 §1):** O1 no sandbox; O2 scripts get the real mineflayer bot; O4 per-role reclaim and
  return. Say plainly if anything would bend one.
- **Eden is dead code:** read it, copy from it, never build in it.
- **Keep the lessons:**
  - the login stagger (I1, 4 s);
  - `viewDistance: 'short'` (R8);
  - the bounded pathfinder (R6) and `tickTimeout` 10 (40 measured 4× worse);
  - the abort sequence (R4/R5);
  - the protocol hardening (docs/29 §16).
- **Code style:**
  - TypeScript strict with `verbatimModuleSyntax`;
  - `console.*` only in `src/logger.ts`;
  - comments explain why, in plain English;
  - player-facing strings in French, errors for the model in English.

When you are done, give Paul a short summary:
- what landed and what is behind a flag;
- this machine's before/after numbers (ELU, loop delay, physics ticks/s, legs and logs per minute, at N = 5 and 10 and
  higher if measured);
- the capacity: how many bots can move at once, with and without the worker pool;
- anything left undone.
