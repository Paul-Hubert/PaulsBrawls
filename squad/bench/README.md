# Squad benchmarks

The measurements behind [docs/31-squad-performance-review.md](../../docs/31-squad-performance-review.md). Nothing here
changes the runtime's default behaviour: the load benchmark builds its bots with the runtime's own `createBot`/`setup`
and only overrides a setting when an experiment flag asks for it.

| Command | What | Needs |
|---|---|---|
| `npm run bench:load -- --label baseline` | N = 0, 1, 5, 10, 20, 30 real bots; phases idle, follow, walk, gather (60 s each) | the **dev** server (`run/`), RCON, `max-players` ≥ the largest N |
| `npm run bench:fight -- --label baseline` | 10 guards + 10 archers (`defend`) against the exact same army (`raid`) on an arena; per round: the fight, a CPU profile, helper timings, a per-second timeline | the **dev** server with `max-players` ≥ 40 and `dev/squad.properties` pointing the mod at the bench runtime (friendly fire) |
| `npm run bench:micro` | Squad's own overhead: guard proxy, loop budget, `squad.tasks`, journal writes, SSE, `nearestEntity` | nothing |
| `npm run bench:jobs` | The job pool's own overhead (docs/37 P2): submit → resolve latency of a trivial job, the dispatcher's main-thread time per tick with 0/100/1000 jobs queued and answered, the entity snapshot's write at 40 bots × 100 entities (`JOBS_WORKERS`, default 4) | nothing |
| `npm run bench:find-blocks` | Block searches (docs/37 P6) on real chunk data (the tests' forest columns, 9 × 9): mineflayer's `bot.findBlocks` against the shared world's search, both on the main thread, for gather's query and others; the store's walk per search (sections walked, read); the time per section read; a `findBlocks` job through the pool (4 workers): submit → positions | nothing |
| `npm run bench:profiles -- <run>/profiles` | from the `.cpuprofile` files: time by cause (what is on the stack: A*, look-ahead, packets, own physics, Squad…), self time by package, the top functions by self time and by total time (itself + what it calls), and Squad's own frames by total time | a run with `--profile` |
| `npm run bench:callers -- <file.cpuprofile> fn …` | who calls a hot function (5 levels of callers, by self time) | a profile |
| `npm run bench:callees -- <file.cpuprofile> fn …` | where a function's time goes: its total time split by its direct callees (`emit` is see-through, so `tickPhysics` shows the physicsTick listeners, `emitPacket` the packet handlers) | a profile |
| `npm run bench:report -- <run1> <run2> …` | repeated runs merged: mean and spread per (N, phase) | two or more runs |
| `npm run bench:compare -- bench/.runs` | every `exp-*` and `control-*` run at N = 10, side by side per phase | experiment runs |
| `node --expose-gc --import tsx bench/repro-hawkeye-leak.ts` | docs/36 §5.1: every bot hawkEye was loaded on stays reachable after GC (exit 1 while the leak is there) | nothing |
| `npm run bench:repro-tasks-spin` | the `gather` freeze of docs/31 §2.6 on the fakes (`FIND_MS=20` by default) | nothing |

Results go to `bench/.runs/<timestamp>-<label>/` (gitignored): `results.json`, `summary.md`, `profiles/`.

## The load benchmark

```powershell
# 1. the dev server (run/, port 25599, RCON 25575; JAVA_HOME: there is no JDK on PATH)
$env:JAVA_HOME = 'C:/Users/Paul/AppData/Roaming/PrismLauncher/java/java-runtime-delta'
./gradlew runServer
# 2. the benchmark (the production server is refused: it is never load-tested)
cd squad
npm run bench:load -- --label baseline
npm run bench:load -- --ns 10,30 --profile 10,30 --label profiled
```

- **The runtime runs in process**, as in `live-tests/run.ts`: the real pool, leases, orders, guard and helpers.
- **The bots** are `Bench00`…`Bench29`, owned by a bench player, and spawned through `/api/bots/spawn` with the
  runtime's login stagger (4 s; `--stagger`). The logins of each step of N are measured as a `login` phase. Each bot
  gets an iron axe, an iron pickaxe and bread.
- **The site** is the nearest forest to spawn (`locate biome`; `--center x,z`). This means a canopy, like the
  production spawn, and logs for `gather`. The first run pre-generates a 5×5 grid of stops 80 blocks apart
  (`--no-pregen` skips it). Before each phase, the bots are put back on a ring on the ground at the centre.
- **The phases** (`--phases`, `--seconds`):
  - `idle`: no order.
  - `follow`: `Bench00` walks 8–16-block legs, and the others run the stock `follow` with it as their commander.
  - `walk`: `bench/commands/bench-walk.mjs` makes every bot walk to random points 20–60 blocks away with the real
    `goTo`, until stopped.
  - `gather`: the stock `gather _log 1024`, stopped when the phase ends.
- **The world:** daytime, no mob spawning, no weather cycle, difficulty easy (set over RCON on the dev world only).

### What it measures, per phase

| | How |
|---|---|
| event-loop delay p50 / p99 / max | `monitorEventLoopDelay` (10 ms resolution) armed at the phase start, reported as lateness beyond 10 ms. On Windows the timer quantum is 15.6 ms, so an idle process already shows about 5 ms. The orders start 30 ms after it is armed: it records nothing before its first tick, so a block in the macrotask that started them went unseen before 2026-11-01 (docs/37 §10.4) |
| event-loop utilization | `performance.eventLoopUtilization()`: the share of time the main thread was busy. **This is the saturation measure: at 1.0 nothing more fits** |
| CPU %, RSS, heap | `process.cpuUsage()` (all threads, % of one core), `process.memoryUsage()` every second |
| time in decode / inflate / physics / A* | `lib/instrument.ts` wraps protodef's `parsePacketBuffer`, `zlib.unzipSync` (minecraft-protocol inflates on the main thread), prismarine-physics' `simulatePlayer` and the pathfinder's `AStar.compute`: % of wall time, all bots together |
| physics ticks/s per bot | `physicsTick` events. 20 means smooth. Mineflayer runs at most 4 catch-up ticks per timer call, so a late loop loses ticks |
| packets, KB/s per bot | the client's `packet` events and `socket.bytesRead` |
| path searches | `path_update` final results (success / noPath / timeout = "Took to long") and their planning time; `path_reset` reasons |
| walk legs, logs mined | bench-walk's counters (`globalThis.__squadBench`), and inventory diffs plus the gather order's report |
| deaf-watchdog trips, skipped packets | the pool's `deaf:` warnings and the protocol hardening's skip reporter |
| server tick | `tick query` over RCON every 5 s (the mean and percentiles of the last 100 ticks); "Can't keep up!" lines in `run/logs/latest.log`; the JVM's CPU (`Get-Process`) |
| CPU profile | `--profile 10,30`: an in-process inspector session (`Profiler.start/stop`, 1 ms sampling) per phase at those N. This is the same `.cpuprofile` format as `node --cpu-prof`, cut per phase. Profiled runs are slower, so their other numbers are not used |

### Experiments (bench-only flags; the runtime's defaults stay as they are)

| Flag | What it changes |
|---|---|
| `--tick-timeout 40`, `--think-timeout 2000`, `--search-radius 128` | the pathfinder settings of `hardening.ts` (10 ms, 5 s, 64) |
| `--plugins none` / `--plugins -autoEat,-hawkEye` | load no plugin, or skip some (a no-op plugin in their place) |
| `--view normal` | the bots' view distance (`short` = 8 chunks; R8 rules out `tiny`) |
| `--movements canDig=false,allowSprinting=false` | overrides on the runtime's Movements object (it is restored after every order, so they hold) |
| `--astar-budget 0` / `--astar-budget 10` | the runtime's own A* budget (`pathfinding.astarBudgetMs`, the patched `AStar.setBudget`; it was a prototype here; without the flag the runtime's default, 20 ms, applies, so `0` is the no-budget control of docs/31): all bots together get at most that many ms of A* per 50 ms window; a search that finds the window spent waits (its waiting does not count against `thinkTimeout`) |
| `--workers 4` | the runtime's pathfinding worker pool (`pathfinding.workers`, docs/32 D): the bots' A* searches run on 4 worker threads over a mirror of the world; capped at the cores but one. After each phase the log line `path workers:` gives the searches offloaded, answered and the fallbacks to the main thread (cumulative), also in `results.json` |
| `--jobs 4 --world` | the reader workers (`workers.count`, docs/37) and the shared world (`world.enabled`). With both, `mineBlock`'s search is a `findBlocks` job on the workers (P6). After each phase the log lines `jobs:` (findBlocks done, continued, late, latency, cost) and `block searches:` (by job, and on the bot by why) give where the searches ran, also in `results.json` (`jobs`, `blockSearch`, `world`) |
| `--think-on-compute` | prototype: `thinkTimeout` counts compute time, not wall time |
| `--lookahead-cap 20`, `--lookahead-memo 4`, `--lookahead-blockcache` | the pathfinder's look-ahead (`lib/physics.js`): a horizon cap; the same sprint/jump decision for the same next node for 4 ticks; its block reads cached for the tick |
| `--astar-blockcache`, `--astar-blockcache-world` | A*'s neighbour lookups (`Movements.getBlock`) cached for the tick, or until the block changes (`blockUpdate`, chunk events) |
| `--mcdata-memo`, `--physics-hoist` | prismarine-physics' `PlayerState`: minecraft-data's loader memoized; its two `require` calls hoisted to the top of the module (a source edit made as the module loads) |
| `--cheap-varint` | the packet framing's `readVarInt` checks for a whole varint first, and throws one shared error instead of a new one per TCP chunk |
| `--stuck-ticks` | mineflayer-pathfinder's "stuck" timer counts 70 physics ticks instead of 3 500 ms (a source edit made as it loads) |

The source edits apply only inside the `bench:load` process that was given the flag, and they fail loudly if the
dependency's code changed. `npm run bench:compare` lines the experiments up against the `control-*` runs.

**Since the patches (docs/32 B, [patches/](../patches/)) the defaults include the library fixes**, so a plain run is
the new control, and an "after" run needs no flag. `--physics-hoist` and `--stuck-ticks` now refuse to start (the
code they edit has changed). `--mcdata-memo`, `--cheap-varint`, `--lookahead-*` and `--astar-blockcache(-world)` still
load, but each stacks a second memo or cache on the patched one, so they measure nothing new. `--astar-budget` sets
the runtime's config. `--workers N` sets `pathfinding.workers`, the pathfinding worker pool.

**Run it on AC power, with the PC unlocked and awake.** Locking a modern-standby laptop puts it to sleep, whatever
`SetThreadExecutionState` asks. A standby freezes both the runtime and the server, and the phase it cuts is lost.

## The fight benchmark

```powershell
# 1. the dev server, with max-players=48 in dev/server.properties and dev/squad.properties set to
#    enabled=true, url=http\://127.0.0.1\:8779, token=live-test-token (put both back afterwards)
$env:JAVA_HOME = 'C:/Users/Paul/AppData/Roaming/PrismLauncher/java/java-runtime-delta'
./gradlew runDevServer
# 2. the fight (two rounds: the first profiled, the second for clean timings)
cd squad
npm run bench:fight -- --label baseline
npm run bench:fight -- --rounds 3 --profile-rounds 0 --label repeat      # timings only
npm run bench:fight -- --blue "raid radius=24" --label mirror            # both armies raid each other
```

- **The armies.** Blue: `BleuGarde01..10` and `BleuArcher01..10`, owned by `BenchBleu`, run `defend radius=24` (Paul's
  squad standing its ground). Red: `RougeGarde01..10` and `RougeArcher01..10`, owned by `BenchRouge`, run `raid
  radius=24` on blue's front (what `/bots raid` starts). Both get the kits of `/bots squad spawn guard|archer`
  (`SquadKits.java`, item for item, over RCON) and the role tags; `--guards`, `--archers` change the counts.
- **Every round starts the same:** the arena (a stone floor at y 100, x 1400 ± 48, z 1000 ± 24, barrier walls,
  `--arena x,z`) cleared of arrows and items, every bot back on its slot (rows of 5, 2 blocks apart, guards in front,
  the two front rows `--gap 40` blocks apart, facing each other), kits and health restored. The world: day, no mobs,
  no weather, `keepInventory` (docs/35 D2: the dead drop nothing), immediate respawn, difficulty hard (production's).
- **A round ends** when one army has no bot left, when both orders ended, or after `--seconds 240`. A bot that dies
  is despawned (docs/35 D2: the dead disconnect) and spawned back between rounds; `--dead respawn` keeps today's
  runtime instead (it respawns at the world spawn, far from the arena, and reloads its chunks during the fight).
- **The friendly-fire rule** (an archer's arrow or a guard's sweep never hurts its own army) is the mod's, from the
  runtime's roster: the bench waits for the dev mod's event stream and refuses to start without it (`--no-mod` runs
  anyway, friendly fire on, which is not a real fight). The runtime listens on `--port 8779`, the token is
  `live-test-token`.
- **Measured per round,** plus `--idle 20` seconds of the 40 bots standing first:
  - everything of the load benchmark's phases (ELU, loop delay, CPU, memory, decode / inflate / physics / look-ahead /
    A* time, ticks/s, packets, path searches, the server's tick and "Can't keep up!");
  - **the helpers as the commands call them** (`lib/helper-timing.ts` wraps every entry of `HELPERS` before the
    orders start): calls, how they ended (ok, `no clear line of fire`, `BotLeftError`…), wall time p50 / p95 / max /
    total (a shot or a melee fight in game time), and the synchronous part that blocks the loop;
  - **a CPU profile** of the first `--profile-rounds 1` rounds and of the idle phase (`--sampling-us 1000`),
    summarised in `summary.md` by `profile-summary.ts`: by cause, by package, the top functions by self and by total
    time, and Squad's frames (runtime, helpers, the commands' own functions such as `pick` and `nearestFoe`);
  - **a timeline**, one row per second: bots alive and their health per army, ELU, the worst loop delay, CPU, ms of
    A* / physics / look-ahead / decode, helper calls, ticks/s and entities per bot;
  - **the fight:** who died when, killed by whom and how (the server log's death messages), friendly kills (0 with
    the mod), the orders' results and their most frequent log lines.
- **Experiment** (bench-only): `--hawkeye-every 4` runs hawkEye's aim (`getGrades`, a trajectory search with
  raycasts on every physics tick of a drawing archer) on one tick in four; the bow still turns every tick to the last
  aim (docs/36 §7).
- Results go to `bench/.runs/<timestamp>-<label>/`: `results.json`, `summary.md`, `profiles/*.cpuprofile`. A profiled
  round is slower (the profiler's sampling), so compare timings between unprofiled rounds. The analysis of the first
  runs: [docs/36](../../docs/36-squad-fight-performance.md).

## Micro-benchmarks

`npm run bench:micro` uses the real `Order`, guard, compiler, `squad.tasks`, `Journal` (a file in the run directory)
and `SquadHttp` (one real SSE client), on the test fakes. Each case runs 2 warm-up rounds and 7 timed rounds, and
reports the median per operation with the fastest and slowest round.
