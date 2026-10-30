# 31 — Squad performance review: where the time goes, and what to do about it (measured)

> Measured 2026-10-29/30 on Paul's laptop against the dev server (`run/`), with the benchmark in
> [squad/bench/](../squad/bench/README.md). The brief is [docs/30](30-squad-performance-review-prompt.md).
> - **Scope set by Paul:** the second baseline run, the profiles and every experiment use at most 10 bots. The first
>   baseline went to 30 bots and was run once.
> - **Nothing in `squad/src/` changed** during the review. Every fix below was measured as a bench-only patch behind a
>   flag (§9).
> - **Since implemented (2026-10-30, docs/32):** the fixes, the observability and an optional pathfinding worker pool
>   landed in `squad/`, measured on a desktop up to 30 bots. See **§11**; §0–§10 are the review as it was.
> - **As built:** [docs/system/squad/overview.md](system/squad/overview.md). **Design:** [docs/29](29-squad-design.md).

## 0. Summary

> **What was built from this, and the numbers after it: §11.** On the desktop of §11, 30 bots walking or gathering run at
> 20 ticks/s with the defaults now in the runtime (the patches + an A* budget of 20 ms per 50 ms window).

- **Capacity today (this laptop, one runtime process):**
  - **About 5 bots moving at once** (walking, gathering) run smoothly.
  - **At 10 moving bots the event loop is saturated:** busy 100% of the time, median delay 230–440 ms, bots simulating
    8–16 of their 20 physics ticks per second.
  - **Standing bots cost about 2% of the loop each:** 30 bots doing nothing take 62% of it.
  - **Past saturation, more bots do less work:** 10, 20 and 30 walking bots all complete 12–21 legs per minute. Gather
    peaked at 5 bots (57 logs per minute) and fell to 16 at 30.
- **What saturates first is the event loop, on one core, in every moving phase.**
  - Not memory: 1.4–1.5 GB at 30 bots, about 30–40 MB per bot.
  - Not the Minecraft server: 8–14 ms per tick, 26 ms with 30 bots following each other, never "Can't keep up!" except
    when bots logged into ungenerated terrain or the PC slept.
  - Not the network: ≤ 115 KB/s per bot.
- **Where the time goes: the bots' pathfinding.**
  - **Walking or gathering at N = 10:** A* is 73–77% of the main thread's busy time and the look-ahead 7–11%.
  - **Inside A\*, about half is building a new prismarine `Block`** (with its `Biome` and block-entity lookup) for every
    neighbour check.
  - **Following:** look-ahead 34% and packet handling 32%. Every bot receives every other bot's movement, so it grows as
    N².
  - **Standing:** dominated by two library hot spots. prismarine-physics' `PlayerState` re-parses minecraft-data's
    version, and calls `require` through tsx's hook, on every tick of every bot (about 37% of the idle CPU). protodef
    throws an `Error` at the end of every TCP chunk (16%).
  - **Squad's own code:** under 0.5% of the busy time; a guarded call costs 0.2–0.7 µs.
- **Overload feeds itself.** The pathfinder's two timeouts count wall-clock time: "Took to long" after 5 s, and "stuck"
  after 3.5 s without reaching the next node. Slow-motion bots fail and re-plan more (stuck resets: 0 per minute at 1
  bot, 261 at 30), which adds A* to a full loop.
- **A bug found on the way:** `gather` in an area without reachable logs blocks the event loop until all 256 batches have
  failed (§2.6). Live it was 3 minutes, and every bot was dropped by the server. In production the supervisor would
  restart the runtime.
- **The fixes, measured at N = 10:**
  - **First step, the `PlayerState` patch (about 10 lines): standing bots cost half as much** (ELU 0.20 → 0.096).
  - **With the look-ahead memo and block cache, the cheap varint and an A\* block cache** (plus "stuck" in ticks), 10
    walking bots are no longer saturated: loop median 230 → 14 ms, every bot at 20 ticks/s, 30 legs instead of 14–21,
    no search timeouts. 10 gathering bots mined 40 logs instead of 6–27.
- **Multithreading:**
  - **Not needed for the realistic load once the in-process fixes are in,** as long as no more than about 10 bots walk or
    mine at the same moment.
  - **Beyond that, use a pathfinding worker pool:** A* moves to worker threads, while the bots and the scripts stay
    where they are. It is the only variant that keeps O2 (the real bot) and O4 (instant reclaim).
  - **Bot groups in workers and sharded processes** break O2 or O4 and are not recommended.

## 1. Setup

| | |
|---|---|
| PC | Laptop, Intel Core i7-1255U: 2 performance cores (4 threads) + 8 efficiency cores, 12 logical CPUs, 1.7 GHz base. 16 GB RAM |
| OS, power | Windows 11 Home 10.0.26200, power plan "Utilisation normale" (balanced). **The load runs were on AC power**: the first attempt was on battery at 7%, and the runs waited for the charger. The micro-benchmarks ran on battery |
| Node | v24.18.0. The runtime runs under `tsx`, as `npm start` does (the supervisor forks it with `--import tsx`) |
| Libraries | mineflayer 4.39.0, mineflayer-pathfinder 2.4.5, minecraft-protocol 1.68.0, protodef 1.19.0, prismarine-physics 1.11.1, prismarine-chunk 1.41.0 |
| Server | The dev server: `./gradlew runServer` in `run/`, port 25599, RCON 25575. Minecraft 1.21.1, Fabric Loader 0.17.3, the mod from source. Microsoft OpenJDK 21.0.7 (Prism's `java-runtime-delta`) |
| `server.properties` | `view-distance=20`, `simulation-distance=10`, `network-compression-threshold=256` (the same three values as production `server/`), `online-mode=false`. `max-players` raised from 20 to 40 for the runs and **put back to 20** afterwards |
| World | Seed −8087864064106702819, generated for these runs. Site: the nearest forest to spawn, centre (−336, 128), a 5×5 grid around it pre-generated. Daytime, no mob spawning, no weather, difficulty easy. A second forest, (1328, 1104), was prepared for the last runs, which the standby then cut |
| Also running | The dev server JVM and this Claude Code session. **No Minecraft client** (production runs the client on the same PC: §10) |
| Interruptions | The laptop was locked, and locking a modern-standby laptop puts it to sleep: it slept at 23:42–00:14, and again at 00:38–00:45, when the power source also switched about ten times. The runs and phases these cut into are marked or dropped (§4). Everything before 23:42 and between 00:14 and 00:35 ran undisturbed |
| Bots | `Bench00`–`Bench29`, spawned through `/api/bots/spawn`, each with an iron axe, an iron pickaxe and bread. View distance `short` (8 chunks), the runtime's plugins and pathfinder settings (`hardening.ts`: tickTimeout 10 ms, thinkTimeout 5 s, searchRadius 64) |

**The benchmark** (`npm run bench:load`, [README](../squad/bench/README.md)):
- **Runtime:** in process, the way `live-tests/run.ts` runs it. The pool, leases, orders, guard proxy and helpers are all the real ones.
- **Ramp:** N = 0 → 1 → 5 → 10 (→ 20 → 30), adding bots at each step. Logins use the runtime's 4 s stagger, and each step's logins are measured as a `login` phase.
- **Phases,** 60 s each, with the bots put back on the ground at the centre before each one:
  - `idle`: no order;
  - `follow`: `Bench00` walks 8–16-block legs and the others run the stock `follow` with it as their commander;
  - `walk`: every bot `goTo`s random points 20–60 blocks away (`bench/commands/bench-walk.mjs`);
  - `gather`: the stock `gather _log 1024`.
- **Repeats:** the ramp ran twice to N = 10 (`baseline-1`, `baseline-2`) and once to 30 (`baseline-1`).
- **Profiles:** CPU profiles of every phase at N = 1 and 10 (`profiled`).
- **Experiments:** each at N = 10 with a 1.5 s stagger, compared against four control runs with default settings (`control-a`…`control-d`) spread through the sequence.

**Two caveats on the numbers:**
- **Gather can't be compared across runs.** Every gather phase cut the same forest, so later runs find fewer logs near the centre, walk farther and plan more. 5 bots mined 57 logs in the first run and 15 in the second. Gather is only compared with the control runs of the same period.
- **The `loop` delay** is the lateness of a 10 ms timer (`monitorEventLoopDelay`). Windows' timer quantum (15.6 ms) puts the floor of an idle process at about 5.6 ms, so only p99 and max are meaningful at low load. The saturation measure is **ELU** (event-loop utilisation, the share of time the main thread is busy): at 1.0 nothing more fits.

## 2. Measurements

### 2.1 Per N and phase (the two baselines merged; mean, with the min–max of the runs when there are two)

- **"ticks/s":** the physics ticks per second of the slowest bot (20 = smooth). Mineflayer runs at most 4 catch-up ticks
  per timer call, so a late loop makes every bot move in slow motion.
- **"A\*", "physics + look-ahead", "decode + inflate":** % of wall time, all bots together. Run 1 counted the
  pathfinder's look-ahead inside physics; run 2 measures it separately, so the table shows the two together.
- **"path timeouts":** searches that hit `thinkTimeout`, i.e. "Took to long to decide path".

| N | phase | runs | ELU | loop p99 / max ms | CPU % | ticks/s (min bot) | A* % | physics + look-ahead % | decode + inflate % | path timeouts | server tick ms (p95) | JVM CPU % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | idle | 2 | 0.01 | 7.9 (7–8.7) / 19.8 (18.7–20.9) | 2 (1.1–2.9) | | 0 | 0 | 0 | | 0.5 (0.8) | 2.2 |
| 1 | login | 2 | 0.2 | 40.7 (29.1–52.3) / 340 (337–343) | 24.5 (23–26) | 18.8 | 0 | 0.6 | 2.5 | 0 | 8.3 (13.1) | 151 (122–181) |
| 1 | idle | 2 | 0.04 | 12.7 / 17.8 | 4.1 (3.5–4.7) | 20 | 0 | 0.3 | 0.1 | 0 | 7.9 (11) | 19.9 |
| 1 | follow | 2 | 0.1 | 24.7 / 41 (37.3–44.6) | 15 (14.5–15.4) | 20 | 3.5 | 2.1 | 0.5 | 1 | 7.6 (11.2) | 25.1 |
| 1 | walk | 2 | 0.1 | 17.3 / 48 (38.4–57.6) | 11.1 (9.6–12.6) | 20 | 0.9 | 2.1 | 0.5 | 0 | 8.2 (11.8) | 24.7 |
| 1 | gather | 2 | 0.2 | 31.9 / 116 (45–186) | 19.5 (18.8–20.2) | 20 | 10.5 | 2.6 | 0.2 | 4.5 (4–5) | 7.8 (11) | 20.1 |
| 5 | login | 2 | 0.4 | 36.4 / 92.9 (78–108) | 52.4 (46.2–58.6) | 19.7 | 0 | 1.5 | 6.7 | 0 | 9.9 (14.8) | 76.1 |
| 5 | idle | 2 | 0.13 | 17 / 38 (28.6–47.3) | 13.7 (13.1–14.3) | 20 | 0 | 1.3 | 0.2 | 0 | 9.7 (13.4) | 23.2 |
| 5 | follow | 2 | 0.35 (0.30–0.35) | 40.3 / 102 (96–108) | 36.5 (33.8–39.2) | 20 | 3 (1.9–4.1) | 9.2 (7.7–10.6) | 1.7 | 0.5 | 9.1 (13.1) | 32.9 |
| 5 | walk | 2 | **0.65 (0.64–0.67)** | 75 (58.7–91.3) / 178 (153–203) | 70.8 (69.5–72) | 20 | **36.1 (32.6–39.6)** | 12.1 (8.8–15.4) | 1.2 | 4.5 (4–5) | 9.1 (14.1) | 53.8 |
| 5 | gather | 2 | **0.83 (0.72–0.94)** | 251 (235–267) / 484 (431–536) | 83.8 (72.4–95.2) | 19.6 | **55.9 (41.5–70.2)** | 13.8 | 0.5 | 13.5 (8–19) | 6.6 (10.1) | 23.1 |
| 10 | login | 2 | 0.45 | 55.2 / 134 (121–148) | 56 (52.6–59.3) | 19.5 | 0 | 1.6 | 7.6 | 0 | 8.6 (12.8) | 65.5 |
| 10 | idle | 2 | 0.21 (0.20–0.21) | 18.2 / 35 (26.7–43.3) | 21.8 (20.5–23.1) | 20 | 0 | 2 | 0.3 | 0 | 10.7 (14.1) | 32 |
| 10 | follow | 2 | 0.63 (0.61–0.65) | 74.2 / 257 (251–263) | 69.4 (67.1–71.8) | 20 | 8 (7.2–8.7) | 16.4 (14.6–18.1) | 3.4 | 1 | 12.4 (17) | 65.1 |
| 10 | walk | 2 | **1.0** | **429 (412–446) / 604 (515–693)** | 103 | **15.3 (14.5–16.1)** | **74.7 (73.6–75.7)** | 9.2 | 1.3 | 5.5 | 9 (13.4) | 36 |
| 10 | gather | 2 | **1.0** | **756 (590–922) / 1023 (660–1386)** | 94.6 | **8.8 (8.4–9.1)** | **69.2 (61.5–76.9)** | 14.9 | 0.7 | 35 (23–47) | 9.7 (15.4) | 33.6 |
| 20 | login | 1 | 0.88 | 832 / 1530 | 81.5 | 10.5 | 9.4 | 3.5 | 15.2 | 1 | 15.5 (29.6) | 87.5 |
| 20 | idle | 1 | 0.41 | 23 / 59.3 | 42 | 20 | 0 | 4 | 0.4 | 0 | 12.1 (16.8) | 43.6 |
| 20 | follow | 1 | 0.96 | 352 / 534 | 105 | 20 | 12.1 | 20.5 | 6.7 | 1 | 18.4 (28.9) | 133 |
| 20 | walk | 1 | 1.0 | 877 / 953 | 103 | 6.4 | 74.8 | 7.7 | 1.5 | 8 | 9.9 (14.4) | 43.6 |
| 20 | gather | 1 | 1.0 | 1121 / 1137 | 101 | 5.5 | 65.7 | 13.7 | 1.3 | 41 | 9.8 (14) | 43.5 |
| 30 | login | 1 | 0.88 | 298 / 754 | 98.3 | 13.9 | 1.1 | 6.4 | 10 | 0 | 13.8 (20.6) | 112 |
| 30 | idle | 1 | **0.62** | 34.4 / 221 | 58.3 | 20 | 0 | 6.3 | 0.7 | 0 | 13.9 (19.1) | 56.2 |
| 30 | follow | 1 | 1.0 | 1390 / 1412 | 96.5 | 7.3 | 18.2 | 18.2 | 8 | 0 | **25.9 (42.4)** | **170** |
| 30 | walk | 1 | 1.0 | 1508 / 1711 | 103 | **3.8** | 68 | 9.4 | 2.2 | 3 | 14.6 (23.2) | 71.5 |
| 30 | gather | 1 | 1.0 | 1314 / 1414 | 103 | **3.8** | 64.5 | 7 | 2.1 | 54 | 12.9 (18.4) | 67.8 |

- **Deaf-watchdog trips:** 0 in every baseline and experiment phase (they appeared only after the PC's standby).
- **Undecodable packets skipped:** 0 (the dev server sends no modded items).
- **Deaths:** 0.
- **"Can't keep up!":** none in any of these runs. The server printed it once, 2.4 s behind, when bots logged into the
  second, never-generated site (§10).
- **"moved too quickly!" lines:** every burst falls in the second the bench teleported moving bots back to the centre
  (deltas of 19–70 blocks). An artifact of the bench's RCON `tp`, not of the bots.

### 2.2 Work done per minute

| N | walk: legs per min (all bots) | per bot | leg p50 (s) | gather: logs per min (run 1 / run 2) | follow: leader's legs per min | "stuck" path resets per min (walk) | "Took to long" per min (walk + gather) |
|---|---|---|---|---|---|---|---|
| 1 | 4.5 (4–5) | 4.5 | 13.5 | 18 / 2 | 20.5 | 0 | 4.5 |
| 5 | 10.5 (9–12) | 2.1 | 14.3 | 57 / 15 | 18 (14–22) | 19 (17–21) | 18 |
| 10 | 18 (16–20) | 1.8 | 21.2 | 28 / 5 | 21 | 66.5 | 40.5 |
| 20 | 12 | 0.6 | 22.8 | 18 | 21 | 161 | 49 |
| 30 | 14 | 0.5 | 45.5 | 16 | 8 | 261 | 57 |

**Past about 10 moving bots, adding bots adds no work.** Walk legs per minute peak at 18 with 10 bots, then fall to 12–14
with 20–30. Gather (run 1, before the forest thinned) peaks at 5 bots: 57 logs, then 28, 18, 16. Per bot, a walking bot
does half as much at N = 5 as alone, and a tenth as much at N = 30.

### 2.3 Logins, memory, network, the server

| N | idle RSS MB | idle heap MB | login: worst loop stall ms | login: decode + inflate % | KB/s per bot while logging in | idle server tick ms | server RSS MB |
|---|---|---|---|---|---|---|---|
| 0 | 264 | 38 | | | | 0.5 | 1775 |
| 1 | 341 | 67 | 340 (first login of the process: 1 913 ms in the smoke run) | 2.5 | 114 | 7.9 | 1926 |
| 5 | 457 | 103 | 93 | 6.7 | 95 | 9.7 | 1910 |
| 10 | 847 | 183 | 134 | 7.6 | 60 | 10.7 | 1916 |
| 20 | 1082 | 266 | 1530 | 15.2 | 31 | 12.1 | 2028 |
| 30 | 1406 | 366 | 754 | 10 | 29 | 13.9 | 2033 |

- **Memory:**
  - **Per bot:** about 30–40 MB of RSS and 9–13 MB of heap. The rest is off-heap chunk storage: every bot keeps its own
    copy of **313 chunk columns** (view distance 8 plus the border), so 30 bots standing together hold 30 copies of the
    same chunks.
  - **The process with no bot is 264 MB:** Node, tsx, minecraft-data and the TypeScript typecheck worker.
  - **30 bots: 1.4–1.5 GB.** Memory is not what limits the runtime on a 16 GB PC.
- **Network:**
  - **Logging in:** a bot receives about 115 KB/s for its first ~10 s, the chunks.
  - **Afterwards:** 0.5–2 KB/s standing still, 8–33 KB/s moving.
  - **Packets:** they grow with the bots around each bot. A bot in a group of 20–30 moving bots receives 770 packets/s
    (60 when alone), because every bot's movement is sent to every other bot. Decoding is at most 8% even then.
- **Logins:** at the runtime's 4 s stagger, a login costs the loop about 0.4 s of decoding over its first seconds. The
  worst stall during the logins was 1.5 s, adding the 11th–20th bots while 10 stood. The first login of a process
  costs about 1.9 s (cold JIT, registry, first chunks).
- **The server:**
  - **Tick time** grows by about 0.2–0.45 ms per bot when the bots stand together (7.9 ms with one bot, 13.9 ms with 30).
  - **The worst case is 30 bots following each other:** 25.9 ms mean, 42 ms p95, against the 50 ms budget, with the JVM at
    170% CPU. That is the N² entity tracking.
  - **The first player in an empty world costs about 7 ms per tick:** the area around them starts ticking
    (`simulation-distance=10`, a forest).
  - **The server never came close to "Can't keep up!"** while Node was saturated.

### 2.4 Squad's own overhead (micro-benchmarks, `npm run bench:micro`)

These run on the real `Order`, guard, compiler, `squad.tasks`, `Journal` and `SquadHttp`, with the test fakes. The
values are the medians of two runs, each of 7 rounds. **Both runs were on battery** (the charger was unplugged for the
second), so these are slow-clock numbers. Their conclusion doesn't depend on a factor-2 clock difference.

| Case | Cost | Raw / plain | When it matters |
|---|---|---|---|
| guarded method call (`bot.blockAt(p)`: lease check, unwrap args, settle) | 0.18–0.70 µs | 1 ns | 10 000 calls/s from a script = 0.2–0.7% of the loop |
| guarded property read (`bot.entity`) | 60–150 ns | 1–3 ns | – |
| guarded plugin call (`bot.pathfinder.isMoving()`) | **1.7–1.9 µs** | 1 ns | 2–10× a bot-level call: `guardNamespace` builds a new wrapper and runs `isClass` (`Function.prototype.toString`) on every access (`guard.ts`). Cheap to cache, like the bot-level `methodCache` |
| loop budget, per loop iteration | 13 ns | 1.4 ns | +11 ns per iteration: a script looping 1 M times pays 11 ms |
| instrumented `await` (fences + canary) | 108–128 ns | 94–122 ns | +6–14 ns per await |
| `squad.tasks`, per item (30 bots, 20 000 trivial items, order start and end included) | 56–62 µs | 0.4 µs | mostly `Array.shift` on a long queue. A `gather` has at most 256 items, and each item takes seconds |
| journal `save()` (WAL, `synchronous=NORMAL`): 3 KB / 94 KB report | 0.29–0.35 ms / 2.5–3.3 ms | | twice per order |
| journal `lastReport()` (`/bots fix`) | 0.45–0.55 ms | | once per fix |
| SSE `notice()` to one connected mod | 2.7–4.8 µs | | per notice |
| `nearestEntity`, one scan of 20 / 100 / 400 entities | 0.8–1 / 2.7–3.3 / 12–15 µs | | a defend loop: a few scans per second per bot |

**Squad's own machinery costs microseconds, where a bot's pathfinding costs hundreds of milliseconds.** The profiles
agree (§3.2).

### 2.5 CPU profiles (N = 1 and 10, every phase)

- **How:** `bench:load --profile 1,10` runs an in-process inspector session per phase (1 ms sampling). It produces the
  same `.cpuprofile` as `node --cpu-prof`, cut per phase. `npm run bench:profiles` summarises them and
  `npm run bench:callers` shows who calls a function. The profiled run's own numbers are not used elsewhere: the
  profiler slows it down.
- **Main thread busy:**
  - N = 1: idle 2.7%, follow 14%, walk 7%, gather 42%. One bot gathering in a thinned forest keeps the loop 40% busy, on
    A*.
  - N = 10: idle 20%, follow 67%, walk 100%, gather 100%.

| N = 10 | Top packages (self time, % of busy) | Top functions (self time, % of busy) |
|---|---|---|
| idle | minecraft-data 25.8, protodef 18.2, (program) 7.3, mineflayer 6.5, `node:modules` 6.5 + tsx 3.4 + `node:url` 1.6, prismarine-physics 4.5, prismarine-block 4.4 | minecraft-data `Version` 20.8 and `toMajor` 3.2 (both from `PlayerState`); protodef `ExtendableError` 16.4 (the `PartialReadError` of the framing); `Block.fromStateId` 3.2; mineflayer `tickPhysics` 2.6 |
| follow | minecraft-data 13.8, prismarine-block 12.1, (native) 10.9, prismarine-chunk 9.6, mineflayer-pathfinder 7.9, protodef 7.4, prismarine-physics 6.3 | `Version` 11.1; `Block.fromStateId`, `getBlockEntity`, chunk loading (`BitArray`, `readBuffer`) |
| walk | mineflayer-pathfinder 34.9, prismarine-block 25.5, prismarine-chunk 12.7, minecraft-data 5.3, prismarine-world 5.2, prismarine-physics 2.0 | `Block.fromStateId` 17.2, `Movements.getBlock` 10.1, the `Block` constructor 7.9, `getMoveDiagonal` 6.5, `getBlockEntity` 6.2, `Version` 3.8, `getLoadedColumn` 3.1, `getNumEntitiesAt` 3.0, `PaletteContainer.get` 2.5 |
| gather | mineflayer-pathfinder 39.3, prismarine-block 25.2, prismarine-chunk 11.8, prismarine-world 5.3, minecraft-data 4.2 | the same as walk |

The by-cause view of the same profiles is §3.2.

### 2.6 A freeze the benchmark found: `gather` where no log is left

When a site runs out of reachable logs, **`gather` blocks the event loop until every batch has failed**. This is
reproduced on the fakes by `npm run bench:repro-tasks-spin`.
- **What happens:**
  1. `mineBlock` calls `bot.findBlocks` (a synchronous 48-block scan).
  2. It finds nothing free and throws before its first real `await`.
  3. `squad.tasks` retries the item or takes the next one in microtasks only (`api/squad.ts`, `work()`), so the loop
     never gets a turn. 256 batches × 2 attempts × the scan time pass in one go.
- **Live (control-d and the hard-cap run, at the first site once it was cut down):** the loop was blocked for about 3
  minutes. The server timed out every bot after
  20 s (`lost connection: Timed out`).
- **On the fakes,** with a 20 ms `findBlocks`: 11.5 s with no timer firing.
- **In production the supervisor kills the runtime after 10 s without a heartbeat,** so a `gather` with nothing to gather
  restarts the runtime and interrupts every order.
- This is the same family as the microtask loop docs/29 §16 fixed in `squad.tasks`. Fixes in §5.3.

## 3. Where the time goes

### 3.1 What saturates first

| Phase | First limit | Where (this PC) | Next limit |
|---|---|---|---|
| idle | the event loop, at about 2% per bot (ELU 0.21 at 10 bots, 0.62 at 30) | about 45 bots, extrapolated | memory, far later (30–40 MB per bot) |
| follow | the event loop: look-ahead, packet handling (N² entity updates), own physics | 15–20 bots (ELU 0.63 at 10, 0.96 at 20) | the server's tick: 26 ms mean, 42 ms p95 with 30 bots following each other |
| walk | the event loop: A* | **6–8 bots moving** (ELU 0.65 at 5, 1.0 at 10) | – |
| gather | the event loop: A* | **5–6 bots** (ELU 0.72–0.94 at 5) | – |

**One core is the limit, and the core is the event loop.** At saturation the process uses 100–106% CPU: one core plus
GC and the threadpool. The other 11 logical CPUs are idle as far as Squad is concerned. Memory, the network and the
Minecraft server have headroom at every N measured, except the server when 30 bots follow each other in one spot.

**Overload does not degrade gently, for three reasons:**
1. **Every bot slows down at once.** Mineflayer runs a bot's physics from a 50 ms timer, catching up at most 4 ticks per
   call. When the loop is 0.4–1 s late, every bot simulates 4–9 ticks per second instead of 20: it walks in slow motion.
   This includes the bots of other orders standing guard.
2. **The pathfinder's wall-clock timers amplify it.**
   - **Each search has `thinkTimeout` (5 s of wall time) but gets only 10 ms of A* per tick.** A late loop gives it fewer
     ticks, so it fails with "Took to long to decide path": 4.5 per minute with 1 bot, 57 with 30 (walk + gather, §2.2).
   - **A bot that has not reached its next path node for 3.5 s of wall time is "stuck"** (`index.js:632`) and its path
     is thrown away. Slow-motion bots are "stuck" all the time: 0 resets per minute at 1 bot walking, 19 at 5, 67 at 10,
     161 at 20, 261 at 30.
   - **Each failure starts a new search**, which adds A* to a loop already full of it.
3. **After a slowdown, bots run fast.** The physics backlog is not dropped: when the load falls, each timer call runs 4
   ticks until it is caught up. Freshly logged-in bots ran 24–37 ticks/s for a while.

### 3.2 Bots, scripts and Squad (by cause, N = 10 profiles)

Each sample is charged to the first of these found on its stack (the profile summary's "by cause" table): A* →
look-ahead and path execution → plugins → packet handling → Squad → own physics.

| N = 10 | main thread busy | A* search | look-ahead + path execution | own physics | packet handling | plugins | Squad (runtime, helpers, commands) | GC + V8 + other |
|---|---|---|---|---|---|---|---|---|
| idle | 20% | – | 0.4% | **62%** | **27%** | 0.3% | 0.0% | 11% |
| follow | 67% | 10% | **34%** | 18% | **32%** | 0.1% | 0.3% | 6% |
| walk | 100% | **73%** | 11% | 8% | 7% | 0.0% | 0.0% | 2% |
| gather | 100% | **77%** | 7% | 6% | 5% | 0.0% | 3.6% (mineflayer `findBlocks`/`blockAt` called by `mineBlock`) | 2% |

- **The bots' cost (mineflayer and its plugins) is practically all of it.** The plugins themselves (pvp, collectblock's
  own code, tool, auto-eat, armor-manager, hawkEye) are under 0.5%.
- **The scripts' cost** is the work they ask mineflayer for: pathfinding when they walk, world lookups in `mineBlock`.
  The stock commands' own JavaScript does not register.
- **Squad's own cost** (the guard proxy, the loop budget, `squad.tasks`, leases, journal, HTTP) is under 0.5% of the
  busy time in every profile. The micro-benchmarks (§2.4) agree.

### 3.3 Inside the hot spots

The profiles point at four specific pieces of library code. All four are fixable without a fork (§4, §5.2):

1. **A\*'s block lookups (about half of A\*).** Every neighbour check of the search (`Movements.getBlock`,
   `movements.js:218`) calls `bot.blockAt`, which builds a new prismarine `Block` with its `Biome` and a block-entity
   lookup. In the N = 10 walk profile:
   - `Block.fromStateId` is 17% of the busy time, the `Block` constructor 8% and `getBlockEntity` 6%;
   - `getLoadedColumn`, the palette, `BitArray` and `Biome` add another 8%;
   - the search's own logic (neighbour generation, the heap) is the remaining 30%.

   The same few thousand positions are looked up again and again by neighbouring nodes.
2. **`PlayerState` (prismarine-physics `index.js:805`), built on every physics tick of every bot and on every look-ahead
   simulation.**
   - It calls `require('minecraft-data')(bot.version)`, which re-parses the version string (`toMajor` → `new Version`):
     38 µs per call.
   - It also calls `require('prismarine-nbt')`.
   - **Under tsx, even a cached `require` goes through tsx's resolve hook** (`pathToFileURL`, about 13% of the idle busy
     time). Plain Node does a cached `require` in 0.5 µs.
   - `Version` alone is 21% of the busy time of 10 idle bots and 11% when they follow.
3. **minecraft-protocol's packet framing** (`framing.js:34`) reads the next packet's length with protodef's `readVarInt`
   after every complete packet. At the end of each TCP chunk that read fails, and protodef throws a new
   `PartialReadError`, capturing a stack trace (14.7 µs). That is one exception per chunk received: **16% of the busy
   time of 10 idle bots.**
4. **The look-ahead** (`lib/physics.js`). Every tick, a moving bot re-decides sprint/jump by simulating up to 8–16 short
   futures. Each one builds a `PlayerState` (point 2) and reads blocks through `bot.blockAt` (point 1). The 200-tick
   horizon is not the cost: capping it at 20 changed nothing (§4).

## 4. Experiments (N = 10, each against the controls)

- **Setup:** every experiment ran 10 bots with a 1.5 s stagger, at the first site. The four control runs (`control-a`…`d`,
  default settings) were spread through the sequence. The table shows their range: an effect has to leave it.
- **Raw rows:** `npm run bench:compare -- bench/.runs`.
- **Walk legs per minute are noisy** (the controls range from 14 to 21). The slowest bot's ticks/s, ELU and the loop
  median are the robust measures.

| Phase (controls) | ELU | loop p50 / p99 ms | slowest bot ticks/s | A* % | look-ahead % | work |
|---|---|---|---|---|---|---|
| idle (control-d, baseline-2) | 0.20–0.21 | 5.6–5.9 / 18–20 | 20 | – | – | – |
| follow (a–d) | 0.58–0.62 | 6.3–6.7 / 54–80 | 20 | 6.9–7.9 | 13.0–14.2 | leader 20–21 legs |
| walk (a–d) | 1.0 | 218–261 / 353–456 | 14.5–16.9 | 74–77 | 7.5–9.2 | 14–21 legs, 3–7 timeouts |
| gather (a–c) | 1.0 | 132–446 / 515–580 | 8.6–16.9 | 69–80 | 6.3–8.2 | 6–27 logs (thinning forest), 31–53 timeouts |

| Experiment (bench flag) | Result against the controls | Verdict |
|---|---|---|
| `--tick-timeout 40` (upstream) | walk: p50 746 ms, 5.2 ticks/s, 6 legs; gather: 2.5 ticks/s, 2 logs | **much worse**: keep 10 |
| `--astar-budget 20` (first version: slices cut finer, no cap) | walk: 233 ms, 15.9 ticks/s, 20 legs | no effect |
| `--astar-budget 20` hard cap + `--think-on-compute --think-timeout 1000` | walk: **ELU 0.81, p50 8.8 ms, p99 94 ms, 19.6 ticks/s, A* held at 33%, 43 legs, 0 timeouts**; gather: froze (§2.6, the control of that period froze too) | **best walk result**; gather untested |
| `--stuck-ticks` (stuck = 70 ticks) | walk: p50 50 ms, **20 ticks/s**, A* 64%, 26 legs; gather: look-ahead **38%**, 13 logs | mixed: helps walking, blocked bots then burn look-ahead |
| `--stuck-ticks --think-on-compute --think-timeout 1000` | walk: like the controls; gather: 0 logs | worse |
| `--movements canDig=false` | walk: 13.1 ticks/s, 15 legs; gather: 13 logs | no gain |
| `--movements allowSprinting=false` | walk: 14.9 ticks/s, 14 legs; follow: look-ahead 19% | no gain |
| `--plugins none` | idle ELU 0.20; follow 0.60; walk like the controls | no gain: plugins cost nothing |
| `--view 6` | 201 chunk columns per bot instead of 313; idle ELU 0.198; gather 5 logs, 8.1 ticks/s | memory only |
| `--lookahead-cap 20` | follow: look-ahead 14.4% | no effect |
| `--lookahead-memo 4` | follow: look-ahead **6.6%**, ELU 0.54; walk: look-ahead 4.3%, 17.6 ticks/s, 24 legs | **−53% look-ahead** |
| `--lookahead-blockcache` | follow: look-ahead 9.4%, p99 45 ms | −30% look-ahead |
| all three look-ahead flags | follow: look-ahead **3.8%**, ELU 0.54, p99 48 ms; walk: look-ahead 1.8% (A* still saturates) | **−73% look-ahead** |
| `--mcdata-memo` | idle: **ELU 0.152**, CPU 13.9%; follow ELU 0.53 | −25% idle |
| `--physics-hoist` (includes the memo) | idle: **ELU 0.096**, CPU 13.2%; follow ELU 0.55 | **−53% idle** |
| `--cheap-varint` | idle: ELU 0.168, CPU 17.1% | −18% idle |
| `--astar-blockcache` (per tick; its gather phase hit the PC's standby) | walk: A* 64%, **−17% A* time per finished search**, 14.5 ticks/s, 20 legs | helps, but not enough alone |
| library fixes together (memo, hoist, varint, A* cache; idle phase lost to the standby, the rest ran after the wake) | follow: ELU 0.43, look-ahead 10%; walk: **20 ticks/s, p50 140 ms, 29 legs, 0 timeouts**; gather: 6 logs | walk smooth, loop still full |
| **everything** (library fixes + look-ahead + `--stuck-ticks` + `--think-on-compute 1000`) | idle: **ELU 0.085**; follow: **ELU 0.34**, look-ahead 1.1%, p99 27 ms; walk: **ELU 0.93, p50 14 ms, 20 ticks/s, 30 legs, 0 timeouts**; gather: **ELU 0.87, p50 9 ms, 19.6 ticks/s, 40 logs, 12 timeouts**. A* cache hit rate 77–85% | **10 moving bots stop saturating the loop** |

**Lost to the laptop's sleep** (§1):
- the A* cache kept until the block changes (`--astar-blockcache-world`);
- the best set of fixes at N = 5 and 10 against a control at a fresh forest.

The data cut by a standby is not used.

## 5. The options

### 5.1 Settings

- **Pathfinder `tickTimeout`:**
  - **Keep 10 ms.** Upstream's 40 ms (measured) makes the walk phase at N = 10 four times worse: 6 legs instead of
    14–21, the slowest bot at 5 ticks/s, the median loop delay at 746 ms.
  - A smaller value (5 ms) was not measured. It would not reduce the total A* work under saturation, only cut it finer.
- **`thinkTimeout` (5 s of wall time):** counting it on compute time (1 s of compute) did not help (measured). Under
  saturation it gives a search *more* work than 5 s of wall time does, so gather got worse. The real fix is cheaper A*
  (§5.2), not another timeout.
- **`searchRadius` 64:** not changed, not measured. R6 makes it bounded; it caps what a failing search can cost.
- **Movements costs:** turning digging off (`canDig=false`) and turning sprinting off (`allowSprinting=false`) gained
  nothing (measured: 14–15 legs against 14–21 for the controls, and the same A* share). Digging is not what makes A*
  expensive in a forest; the block lookups are.
- **Plugin intervals:**
  - Loading no plugin at all changed nothing (measured): idle ELU 0.20 against 0.20–0.21, the same follow and walk.
  - auto-eat's and armor-manager's polling, and hawkEye and tool on every bot, cost nothing worth saving.
  - The profiles agree: the plugins are under 0.5% of the busy time.
- **View distance:**
  - `6` instead of `short` (8) holds 201 chunk columns per bot instead of 313 (−36%). That is about 8 MB less RSS per bot
    and about 30% less traffic while logging in, with the same CPU (measured, idle and gather).
  - **R8's "tiny" is not what it was:** in mineflayer 4.39, `'tiny'` is 6 chunks (96 blocks), not 2, and a 48-block
    `findBlock` stays inside it.
  - Worth considering only if memory becomes a limit, which it is not.
- **Login stagger:**
  - **Keep 4 s (I1).** At 4 s the worst stall while 10 bots log in is 134 ms. At 1.5 s (the experiments' setting) it was
    1.1–1.8 s (measured).
  - A login costs about 0.4 s of decoding spread over a few seconds.
- **Limiting concurrent pathfinding (a token bucket):**
  - The first prototype only cut slices finer (no effect, measured). The hard cap's result is in §4.
  - Either way it is a fairness tool: it keeps physics smooth for everyone. It does not make more A* fit.
- **Server-side `view-distance`, `simulation-distance`:**
  - The bots ask for 8 chunks, so the server's 20 only matters for the real players.
  - `simulation-distance=10` sets how much ticks around each player. It matters only when bots spread out, and lowering
    it affects everyone.
  - Not changed, not measured.

### 5.2 The library hot spots, in-process (§3.3)

Each fix is a small, local change to a dependency. Squad already patches protodef at runtime (`bots/protocol.ts`), and
these can be done the same way, or with `patch-package`, and sent upstream:

| Fix | What changes | Measured (N = 10, against the controls) |
|---|---|---|
| **`PlayerState` hoist** (prismarine-physics) | `require('minecraft-data')(version)` and `require('prismarine-nbt')` move to the module's top level, and the minecraft-data result is kept per version | **idle ELU 0.20 → 0.096 (−53%)**, CPU 20–23% → 13%. The minecraft-data memo alone: 0.15 (−25%) |
| **Cheap partial varint** (minecraft-protocol's framing / protodef) | check that the length prefix is complete before calling `readVarInt`; no new `Error` per TCP chunk | idle ELU 0.20 → 0.168 (−18%), CPU 20–23% → 17% |
| **Look-ahead decision memo** (mineflayer-pathfinder `lib/physics.js`) | reuse a sprint/jump decision for the same next node for 4 ticks | look-ahead 13–14% → 6.6% of wall time (follow) |
| **Look-ahead block cache** | the blocks a look-ahead reads, cached for the rest of the tick | look-ahead 13–14% → 9.4% (follow) |
| Look-ahead horizon cap (200 → 20 ticks) | | no effect |
| **A\* block cache** (`Movements.getBlock`) | neighbour lookups cached per tick (hit rate 77–85%), or until the block changes | per tick: A* 74–77% → 64% of wall time, −17% A* per finished search. Until the block changes: not measured (§10) |
| "Stuck" on ticks (`index.js:632`) | 70 physics ticks instead of 3 500 ms | walk: slowest bot 14.5–16.6 → 20 ticks/s, median loop delay 230 → 50 ms, legs 14–21 → 26. gather: the look-ahead grew to 38% (blocked bots stay on their path longer). Mixed |

A further option, not measured: **run compiled JavaScript instead of tsx** in production. tsx's hooks are 1–3% of the
busy time after the hoist, so it's small.

### 5.3 Algorithmic, inside one process

- **Share chunk storage between bots in the same area:**
  - Each bot keeps its own 313 columns: 30 bots standing together hold 30 copies.
  - Each connection still receives and decodes its own packets; only the storage and mineflayer's chunk parsing could be
    shared.
  - Gain: most of the 30–40 MB of RSS per bot when bots stand together; CPU only at logins and chunk borders (packet
    handling is 5–7% of busy time when walking).
  - Cost: high. Mineflayer's world, its block events and `bot.blockAt` assume one world per bot.
  - **Not worth it: memory is not the limit.**
- **One `findBlocks` per `squad.tasks` batch:** world lookups made by the helpers are 3.6% of the busy time in gather, so
  that is the most it could save. Not worth it.
- **Fewer `entities` scans in `nearestEntity`:** 15 µs per scan of 400 entities (micro). A defend loop scans a few times
  per second per bot. Negligible.
- **The `gather` freeze (§2.6, a Squad change, cheap, and the most urgent item of this review):**
  - `squad.tasks` should yield a macrotask (`setImmediate`) after an item fails, before it takes the next one.
  - `gather` should stop early when every batch fails with "none found" instead of working through all 256.
  - The loop budget and the starvation canary only cover the script's own loops, not the runtime code a script calls.
  - Gain: the runtime survives a `gather` in a cut-down forest. Today the supervisor restarts it.
- **`follow` restarts its search every second (a Squad change, cheap):**
  - The stock `follow` (and `defend`) call `follow(bot, entity, range, { untilMs: 1000 })` in a loop.
  - The helper sets a new `GoalFollow` each time, which resets the path and releases the controls, then clears the
    goal in its `finally`.
  - Result: every follower stops and re-plans once a second (408 "goal_updated" resets per minute with 10 bots).
  - Fix: keep the goal when the next call follows the same entity at the same range, and clear it only when no call
    follows within ~300 ms.
  - Gain (estimated): most of A*'s 8–10% and some of the look-ahead in follow, and smoother following.

### 5.4 The server side

- **What it spends per bot-player:** about 0.2–0.45 ms per tick per bot when bots stand together. It ticks the
  simulation area around each player, and that area grows when bots spread out.
- **Entity tracking is the N² part:** 30 bots following each other cost 26 ms mean and 42 ms p95 per tick. That is the
  only place the server approached its 50 ms budget.
- **What the mod could do without breaking "the bots stay real players":**
  - turn off compression for loopback connections (a mixin on the connection's compression threshold). That saves the
    server's deflate and the bots' inflate (0.2–5% on the bot side). It was not measured and is not worth a mixin now;
  - nothing else is needed at ≤ 30 bots.
- **Not recommended:** lowering `simulation-distance` or `entity-broadcast-range-percentage`. They change the game for
  the real players too.

### 5.5 Observability

None of the numbers above can be seen in production today.
- **Eden's lag monitor, copied:** `monitorEventLoopDelay` plus ELU, sampled every 10 s. A warning line when p99 > 250 ms
  or ELU > 0.9. Eden's 1 s threshold is too late: bots are in slow motion well before that.
- **A `POST /api/metrics` route:**
  - loop p50/p99/max and ELU;
  - CPU and RSS/heap;
  - per bot: physics ticks/s, path searches by outcome, "stuck" resets, skipped packets, deaf trips.

  These are cheap counters, the same the bench reads. `/bots status` in the mod can show ELU and the slowest bot's
  ticks/s.
- **One vitals summary per minute in the journal**, never the hot stream (R44).

## 6. Multithreading

The constraint (docs/30): **O1, O2 and O4 put the bots and the scripts driving them in one JS realm.**
- A command gets the real mineflayer `bot` and reads it synchronously (`bot.entity.position`, `bot.inventory.items()`).
- A co-owner's order reclaims a bot from another order at any time, and the bot returns afterwards.

### 6.1 Bot groups in `worker_threads`: not recommended

Each worker would run its bots' event loop (decode, physics, pathfinding), so the whole cost would scale across cores.
An order runs where its bots are, and an order's bots are whichever bots its roles grant, reclaimed or not. Two ways to
make that work, both bad:
- **Migration by reconnect.**
  - A bot granted to an order in another worker logs out and in again there. That costs:
    - the 4 s login stagger;
    - about 0.4 s of decoding and its chunks resent by the server (§2.3);
    - a "joined/left" on the server.
  - A reclaim, today instant, would take seconds, and so would the return (O4 in spirit).
  - `squad.tasks`, roles and `joined/left` would see bots vanish for seconds.
  - Worst of all: an order whose roles span bots in several workers has to wait for all of them.
- **A cross-thread proxy.**
  - The script stays on the main thread and drives bots in other workers over RPC.
  - Every read becomes a message, or a mirror that is a tick stale, so it is no longer "the real bot" (O2): `bot.entity`
    can't be read synchronously.
  - Per-tick control (`setControlState`, `lookAt`) adds a thread hop (tens of µs, which is fine), but a script that polls
    state every tick sees a stale copy.
  - Listeners (`bot.on`) would need event forwarding.

It would also not solve a single busy group: 10 moving bots in one worker saturate that worker exactly as they saturate
the main thread today.

### 6.2 Pathfinding in a worker pool: the variant that keeps O2 and O4

The search moves; the bots, their physics and the scripts stay where they are. Paul's suggestion (a read-only copy of the
terrain per worker) is this variant.
- **How it plugs in, without forking mineflayer-pathfinder:**
  - The plugin already calls `astarContext.compute()` once per tick while a search is unfinished.
  - A replacement `compute()` posts the job to a worker, returns "still searching" until the answer arrives, then returns
    the worker's path.
- **What the worker needs:**
  - **`Movements`.** It only reads `bot.blockAt`, `inventory.items()`, `registry`, `pathfinder.bestHarvestTool`,
    `game.minY`, `entity`, `entity.effects` and `entities` (`movements.js`), so a stand-in "bot" in the worker can serve
    them from a copy of the world.
  - **The A\* class**, unchanged.
- **A heightmap is not enough.** In a forest the top block of a column is leaves; under trees, in caves and in buildings
  the walkable space is below the top. The costs also need each block's type: solid, liquid, climbable, a slab, diggable
  and how fast.
- **A copy per search, or a mirror?**
  - **A copy per search** (estimated, not measured):
    - The palettized section arrays of the columns a search can reach, about 81 columns × the 4–6 sections around the
      bot, are 1–2 MB.
    - Cloning them costs 1–3 ms on the main thread.
    - That is cheap next to a search (100–1 700 ms of wall time today, §2.2), but it is paid on every search, and
      searches restart often (resets).
  - **A mirror:** forward each bot's `map_chunk`, `block_change` and `multi_block_change` packets to the workers and keep
    one world per worker, shared by every bot in the same dimension. That costs no copy per search, but each worker
    parses every chunk again, and a second world implementation must stay in step with mineflayer's.
- **Gain (estimated):** A* is 70–77% of the main thread at N = 10 walking or gathering. With it gone, the main thread
  keeps own physics, look-ahead and packets, about 20–25% of today's busy time at N = 10. Searches run at full speed on
  worker cores instead of 10 ms per 50 ms, so "Took to long" stops being a load effect. Planning throughput becomes
  "workers × one core".
- **Costs and risks:**
  - The first answer arrives after the search time. Today the bot already walks the best partial path meanwhile.
  - Plans are made on a world 0–1 s old. The plugin already re-plans when a block on the path changes.
  - Startup costs about 50 MB per worker (its own minecraft-data).
  - A second world model to keep correct.
  - **Size: a few days of work, plus live tests.**

### 6.3 Processes instead of threads (sharding): not now

Several runtimes, bots sharded by owner. It gives crash isolation: a wedged script freezes one shard. But it has the
same realm problem as §6.1.
- **The shard has to be the connected component of the co-ownership graph.** Bots that share any owner must live
  together, because any co-owner may reclaim them.
- **On the production server today, one player owns all five bots:** one component, nothing to shard.
- **What it would take:**
  - the mod routes `/bots` calls by bot to N runtimes;
  - the claims registry (`squad.claim` is a synchronous boolean shared across orders) needs a cross-process home or
    becomes per-shard;
  - `/bots orders`, notices and the SSE stream are merged.

It is worth it only for isolation, with many independent owners. Not for performance.

### 6.4 Decoding or physics off the main thread: not worth it

- **Decoding and inflating** are 0.3–3.4% of wall time at N ≤ 10 (7.6% while logging in, 8% with 30 bots following).
- **Mineflayer's handlers must run where the world lives.** They are the larger part of "packet handling" (chunk
  loading, entity updates).
- **Without a fork, mineflayer allows only one thing here:** making `zlib.unzipSync` asynchronous, which moves inflate to
  the libuv threadpool. That is at most 0.5–5% of wall time.
- **Own physics must stay synchronous with the bot.** After the `PlayerState` fix it is small.

The cheap varint fix (§5.2) recovers more of the packet cost, for far less work.

### 6.5 The answer

**Is multithreading needed for the realistic load (10–30 bots, a few concurrent orders)?**

- **Today: yes, as soon as more than about 6–8 bots walk or mine at the same moment** (§3.1). With fewer, a moving bot
  still costs a lot: 5 walking bots keep the loop 65% busy.
- **After the in-process fixes (§5.2, §8): not for loads where at most about 10 bots move at once** and the others stand,
  guard or follow.
  - **Measured at N = 10 with every fix:** walking ELU 0.93 at 20 ticks/s, gathering 0.87, following 0.34, idle 0.085.
  - **Per-bot costs (estimated, linear from N = 10; not measured at 20–30):** about 0.9% of the loop per standing bot,
    3.4% per follower, 9% per walking or mining bot.
  - **Example:** 30 bots with 5 moving, 10 following and 15 standing come to about 45 + 34 + 13 ≈ 92%. That is near
    the limit, and an estimate.
- **When Paul needs more than about 10 bots moving at once: the pathfinding worker pool (§6.2).**
  - It is the one variant that keeps O1, O2 and O4 as they are.
  - **Cost:** days.
  - **Gain (estimated):** A* is 70–78% of the busy time of moving bots, so roughly 3–4 times as many moving bots per
    process, up to the worker cores.
- **Not bot groups in workers (§6.1), and not sharded processes (§6.3).**
  - They break O2 (a proxy instead of the real bot) or O4 (reclaims that reconnect bots).
  - A busy group would still saturate its own thread.
  - Sharding gives nothing while one player owns all the bots.
- **Before any of it, the hard A\* cap (§4) makes overload graceful.** It does not add capacity: planning slows down, but
  bots keep moving and the other orders keep reacting. At N = 10 walking it gave 43 legs, 19.6 ticks/s and a loop p99
  of 94 ms.

## 7. Options table

"Measured" means at N = 10 against the controls (§4); "est." is an estimate.

| Option | Gain | Cost | Risk | Decisions / lessons touched | Verdict |
|---|---|---|---|---|---|
| Fix the `gather` freeze: `squad.tasks` yields after a failed item; `gather` stops on "none found" | the runtime survives a `gather` with nothing left (today: blocked 3 min live, 11.5 s on the fakes, a supervisor restart in production) | hours | low | the W / microtask-loop family | **now (a bug)** |
| `PlayerState`: hoist its two requires, keep the minecraft-data result | **idle −53%** (ELU 0.20 → 0.096), measured; also cheaper look-ahead | hours (a runtime patch like `protocol.ts`, or `patch-package`; PR upstream) | low | – | **now: the first step** |
| Look-ahead: decision memo (4 ticks) + block cache | **look-ahead −73% when following** (13–14% → 3.8%), measured | hours | low: a decision up to 4 ticks stale after a knock-back | – | **now** |
| Cheap partial varint in the framing | idle −18%, measured | an hour | low | the §16 protocol hardening (same area) | **now** |
| A* block cache, per tick | −17% A* per finished search, hit rate 77–85%, measured | hours | low | R6 unchanged | **now**; then measure the cache kept until the block changes |
| `follow` keeps its goal between calls | est. most of A*'s 8–10% when following, and steadier following | hours | low | O2 unchanged (same helper, same arguments) | **now** |
| Lag monitor, `/api/metrics`, `/bots status`, a vitals line per minute | visibility | a day | none | R44 (summaries only) | **now** |
| "Stuck" counted in ticks | walk 20 ticks/s, 26 legs; alone, gather's look-ahead grew to 38%; good inside "everything" | hours | medium | – | with the look-ahead fixes only |
| `thinkTimeout` on compute time | none or worse, measured | – | – | – | no |
| Hard A* budget (20 ms per 50 ms window) | walk 43 legs, 19.6 ticks/s, p99 94 ms, measured; gather not tested | a day | medium: slower planning under load | R6 | after the fixes, as the overload guard |
| `tickTimeout` 40 (upstream) | 4× worse, measured | – | – | R6 | no: keep 10 |
| No digging / no sprinting in Movements | none, measured | – | – | O5 (grief on) | no |
| Fewer plugins, or plugins per role | none (< 0.5%), measured | – | – | R15–R17 | no |
| View distance 6 | −36% chunk columns, ~8 MB per bot, same CPU, measured | minutes | low, but re-check R8 ('tiny' is 6 chunks in mineflayer 4.39) | R8 | only if memory becomes a limit |
| Shorter login stagger | worse: 1.1–1.8 s stalls at 1.5 s, measured | – | – | I1 | no: keep 4 s |
| Server `view-distance` / `simulation-distance` | not measured; changes the game for players | – | – | – | no |
| No compression on loopback (a mod mixin) | est. ≤ 5% bot-side, plus the server's deflate | a day | low–medium (a mixin) | the bots stay real players | not now |
| Compiled JS instead of tsx in production | est. 1–3% after the hoist | a day (a build step) | low | – | later, maybe |
| Shared chunk storage between bots | est. most of 30–40 MB per bot; little CPU | weeks | high | – | no |
| One `findBlocks` per `squad.tasks` batch | ≤ 3.6% in gather | days | medium | – | no |
| Cheaper `nearestEntity` | negligible (12–15 µs per scan of 400) | – | – | – | no |
| **Pathfinding worker pool** (§6.2) | est. 3–4× moving bots per process | days + live tests | medium (a second world model) | keeps O1, O2, O4 | **when more than ~10 bots move at once** |
| Bot groups in `worker_threads` (§6.1) | scales everything, but a busy group still saturates its thread | weeks | high | **breaks O2** (proxy) or **O4** (reconnecting reclaims) | no |
| Runtimes sharded by owner (§6.3) | crash isolation; nothing while one player owns every bot | weeks | high | O4 across shards; the mod routes by bot | no (not for performance) |
| Decoding or physics off the main thread (§6.4) | ≤ 1–8% | days | medium | – | no |

## 8. Recommendation

**Now** (cheap, measured; each is a small change, all of them together a few days):
1. **Fix the `gather` freeze** (§2.6, §5.3). This is a bug, not an optimisation: it can make the supervisor restart the
   runtime.
2. **The first optimisation: patch prismarine-physics' `PlayerState`.**
   - **What:** hoist `require('minecraft-data')` and `require('prismarine-nbt')` to the module's top, and keep the
     minecraft-data result per version. About 10 lines, applied at runtime next to `bots/protocol.ts`, or with
     `patch-package`, and sent upstream.
   - **Measured gain:** **10 idle bots cost half as much: ELU 0.20 → 0.096, CPU 20–23% → 13%.** It also makes every
     look-ahead decision cheaper.
3. **The look-ahead decision memo and block cache** (mineflayer-pathfinder `lib/physics.js`): −73% look-ahead when
   following.
4. **The cheap partial varint** in minecraft-protocol's framing: −18% idle.
5. **The A\* block cache** (`Movements.getBlock`, per tick): −17% A* per search. Then measure the cache kept until the
   block changes, which this review lost to the PC's sleep.
6. **`follow` keeps its goal** between calls.
7. **Observability:** Eden's lag monitor (warn at p99 > 250 ms or ELU > 0.9), `/api/metrics`, ELU and the slowest bot's
   ticks/s in `/bots status`, and one vitals summary per minute in the journal.
8. **Measure "stuck" counted in ticks together with 2–5.** Inside the "everything" run it helped; alone, it made blocked
   bots burn look-ahead.

**What 2–5 together bought (measured, N = 10, with "stuck" on ticks and thinkTimeout on compute time):**
- **Walking:** loop median 218–261 → 14 ms, the slowest bot 14.5–16.9 → 20 ticks/s, 14–21 → 30 legs, timeouts
  3–7 → 0. ELU drops from 1.0 to 0.93: no longer saturated.
- **Gathering:** ELU 0.87, loop median 9 ms, 19.6 ticks/s, 40 logs against 6–27.
- **Following:** ELU 0.6 → 0.34. **Idle:** 0.20 → 0.085.

**When Paul needs more bots:**
- **More than about 10 moving at once** (the measured edge after the fixes): build the pathfinding worker pool (§6.2).
  Put the hard A* budget in first, so that overload slows planning instead of every bot.
- **30 bots that mostly stand, guard or follow:** after the fixes, one thread is estimated to carry them (§6.5).
- **Verify on this PC with the Minecraft client running.** That was not measured, and the client competes for the same
  two performance cores.

**What not to do:**
- **Don't go back to upstream `tickTimeout` 40** (4× worse) or shorten the login stagger (1–2 s stalls).
- **Don't count `thinkTimeout` on compute time** (it gives searches more work under load), don't turn off digging or
  sprinting, and don't trim plugins (no gain).
- **Don't put bot groups in worker threads or shard into processes for performance.** They break O2 or O4, and a busy
  group saturates its own thread anyway.
- **Don't move decoding or physics off the main thread** (≤ 8% to win), and don't share chunk storage (memory is not the
  limit).

## 9. Prototypes and how to remove them

> **No longer true since docs/32 (§11):** the fixes are now in `squad/patches/` and `squad/src/`. On the patched code
> `--physics-hoist` and `--stuck-ticks` refuse to start, `--astar-budget` sets the runtime's
> `pathfinding.astarBudgetMs`, and `--workers N` sets `pathfinding.workers`. The current flags are in
> [squad/bench/README.md](../squad/bench/README.md). The text below is the state at the end of the review.

**The runtime's default behaviour is unchanged:** nothing under `squad/src/` was edited. Everything measured lives in
`squad/bench/` and acts only inside a `bench:load` process, behind a flag:

| Where | What | Flag |
|---|---|---|
| `bench/lib/instrument.ts` | timing wrappers on protodef's parser, `zlib.unzipSync`, `simulatePlayer`, the look-ahead and `AStar.compute` | always on in the bench (never in the runtime) |
| | thinkTimeout on compute time; a hard A* budget per 50 ms window | `--think-on-compute`, `--astar-budget` |
| | the look-ahead: horizon cap, decision memo, block cache | `--lookahead-cap`, `--lookahead-memo`, `--lookahead-blockcache` |
| | a block cache for A*'s neighbour checks, per tick or until the block changes | `--astar-blockcache`, `--astar-blockcache-world` |
| | minecraft-data memo; `PlayerState`'s requires hoisted; the cheap partial varint; "stuck" on ticks. Source edits of `prismarine-physics` and `mineflayer-pathfinder` made as they load, in that process only | `--mcdata-memo`, `--physics-hoist`, `--cheap-varint`, `--stuck-ticks` |
| `bench/load.ts` | Movements overrides, plugin set, view distance, pathfinder settings | `--movements`, `--plugins`, `--view`, `--tick-timeout`, `--think-timeout`, `--search-radius` |
| `bench/repro-tasks-spin.ts` | the `gather` freeze of §2.6, reproduced on the fakes | – |

The tools: `npm run bench:load`, `bench:micro`, `bench:profiles`, `bench:callers`, `bench:compare`, `bench:report` and
`bench:repro-tasks-spin`. They are described in [squad/bench/README.md](../squad/bench/README.md).

**To remove the bench entirely:**
- delete `squad/bench/`;
- delete the `bench:*` scripts in `squad/package.json`;
- delete `"bench"` from `squad/tsconfig.json`'s `include`;
- delete the `bench/**` entries in `squad/eslint.config.js`;
- delete `bench/.runs/` in `squad/.gitignore`.

**The dev server** was stopped cleanly (`stop` over RCON), and `run/server.properties` was restored (`max-players=20`).
The `run/squad.properties` the mod generated when it started was deleted. The world in `run/world/` was generated for
these runs and stays: delete it for a fresh one.

## 10. Not measured

> **Since (§11):** the fixes were measured at N = 10–30 and the worker pool was built and measured, on a desktop
> without a Minecraft client. §11.10 lists what is still open.

- **The production PC as it runs.** Paul plays on the same machine, so the Minecraft client competes for the same 2
  performance cores. All runs here had no client.
- **The production "Can't keep up! 2–6 s behind" while bots joined** was reproduced only once: 2.4 s behind, when 5 bots
  logged into a forest 1 700 blocks from spawn that had never been generated. Logins into generated terrain never made
  the server fall behind. The likely cause in production is bots joining into terrain the server has to generate or
  load, plus the client competing for cores. Not verified on production.
- **More than 10 bots, repeated.** N = 20 and 30 were measured once (Paul's limit). Their spread is unknown.
- **The fixes at N = 20–30, and how many bots they allow.** The experiments ran at N = 10 only. The capacity figures in
  §8 for more bots are extrapolations from ELU.
- **Other machines.** On this hybrid CPU, Windows may run the Node main thread on an efficiency core. Thread placement
  was not controlled or recorded. A desktop CPU would move every "N where it saturates" up.
- **The server's per-bot cost in detail.** No JVM profile was taken; only its tick (`tick query`), CPU and RSS.
- **Compression off for loopback connections** (§5.5), and the server-side `view-distance` / `simulation-distance`:
  changing them needs a server restart with other settings, which was not done.
- **The pathfinding worker pool (§6.2):** only designed, not prototyped. Its gains are estimates.
- **Lost to the PC's standby:**
  - the A* block cache kept until the block changes;
  - the best set of fixes at N = 5 and 10 against a control at a fresh forest;
  - the hard A* budget with gather;
  - the minecraft-data memo + varint + A* cache run's idle phase.
  The flags are in the bench, so each is one `bench:load` command away.
- **The other phases' code paths:** combat (`attack`, `shoot`, hawkEye), chests, crafting and smelting. They were not
  loaded, so their costs are unknown (pvp and hawkEye run a per-tick listener only while fighting).
- **Squad's HTTP API under load:** the SSE broadcast was measured in isolation (§2.4), not with a busy mod.
- **The supervisor itself.** The bench runs the runtime without it. No load phase delayed the loop beyond 1.7 s, except
  the `gather` freeze (§2.6), which would trip its 10 s heartbeat.

## 11. Implemented (docs/32, 2026-10-30)

The fixes of §8, the observability and the pathfinding worker pool (§6.2) were built from the brief in
[docs/32](32-squad-performance-fixes-prompt.md), on a second, faster machine, and measured there. **Its numbers are
not comparable one-to-one with §1–§10's laptop numbers.** Every number below is measured unless marked "est.".

### 11.1 What landed

| Commit | Workstream | What |
|---|---|---|
| `6e3f245` | A | `follow` keeps its `GoalFollow` between calls (no reset once a second). The guard proxy caches its plugin method wrappers and `isClass` results; the lease is still checked on every call. Tests for the `gather` freeze of §2.6 (fixed in `ab027f8`) |
| `6fa8df0` | B | `patch-package` patches (`squad/patches/`): `PlayerState`'s requires hoisted (prismarine-physics); the cheap partial varint (minecraft-protocol framing); in mineflayer-pathfinder one tick clock per bot, the look-ahead memo + block cache, the A* block cache, "stuck" after 70 physics ticks, and `AStar.setBudget(ms)`. Config `pathfinding.astarBudgetMs` |
| `19b05a0` | C | A lag monitor (copied from Eden, owned in `squad/`), per-bot counters in the pool, `POST /api/metrics`, one vitals row per minute in a new journal table (kept 7 days), `/bots status` in the mod |
| `8eca4bb` | D | The pathfinding worker pool behind `pathfinding.workers` (default 0 = off): A* runs in worker threads over a shared mirror of the world; the bots, physics, look-ahead and scripts stay on the main thread (O2 and O4 hold) |
| `a0bf481` | test | The live test's shot check counts arrows just before the husk (an archer's arrows pile up between runs); `LIVE_PATH_WORKERS=N` runs the live test with the worker pool |
| `d137955` | default | `pathfinding.astarBudgetMs` defaults to 20 (§11.5) |
| `32e086a` | fix | The A* block cache let `getMoveJumpUp` raise a cached block (§11.9) |

### 11.2 This machine

| | |
|---|---|
| PC | Desktop, AMD Ryzen 9 9950X3D, 16 cores / 32 threads, 61.5 GB RAM, on AC. No sleep or standby during any run (System log events 506/507/42/107 checked) |
| OS, Node, Java | Windows 11 Pro 10.0.26200; Node v24.15.0; JDK 21 |
| Server | The dev server in `run/` (port 25599, RCON 25575). `max-players` raised to 32 for the runs and put back afterwards |
| Also running | **No Minecraft client** (as in §1) |
| Runs | The N ramp with the runtime's 4 s login stagger (the old-code control at (2000, 2000) used 1.5 s); 60 s phases `idle`, `follow`, `walk`, `gather` as in §1 |

**Sites.** Gather cuts the forest it runs in (§1), so every comparison names its site:
- **Same-site pairs:** the control ran first on a fresh forest, the experiment second on the same site. The second run's
  gather sees a thinner forest, which favours the control.
- **Cross-site comparisons** (each run on its own forest) are rough, and are marked as such.

### 11.3 Squad's own overhead (`npm run bench:micro`, workstream A)

| Guarded call | Before (ns per op) | After |
|---|---|---|
| `bot.blockAt` | 96.6 | 71.2 |
| `bot.entity` | 37.7 | 34.1 |
| `bot.pathfinder.isMoving()` | 567 | 96.4 (5.9×) |

### 11.4 Capacity before and after the patches (cross-site, rough)

The old code (a worktree at `18cfa5e`) at (−2000, 2000) against the patched code with **no A\* budget** (`19b05a0`,
budget 0) at (5840, 6256). Cells: ELU · loop p50/p99 ms · slowest bot's ticks/s · legs or logs in the 60 s phase (all
bots).

| N | Phase | Old code | Patches, budget 0 |
|---|---|---|---|
| 10 | idle | ELU 0.045 | 0.013 |
| 30 | idle | 0.09 | 0.095 |
| 10 | follow | 0.16 | 0.086 |
| 30 | follow | 0.376, look-ahead 7.7% | 0.254, look-ahead 1.6% |
| 10 | walk | 0.736 · 7.1/216 · 20 · 38 legs | 0.334 · 5.8/119 · 19.6 · 21 legs |
| 20 | walk | 0.906 · 12.8/296 · 19.9 · 90 legs | 0.74 · 7.8/206 · 19.6 · 52 legs |
| 30 | walk | 0.963 · 15.7/518 · 13.8 · 100 legs | 0.778 · 7.6/260 · 19.6 · 61 legs |
| 10 | gather | 0.998 · 171/355 · 17.9 · 54 logs | 0.846 · 9.4/241 · 20 · 35 logs |
| 20 | gather | 0.981 · 21/484 · 13.2 · 111 logs | 1.0 · 512/757 · 8.2 · 6 logs |
| 30 | gather | 1.0 · 764/955 · 5.3 · 20 logs | 1.0 · 631/1026 · 6.4 · 13 logs |

- **The (5840, 6256) site is harsh terrain**, so its legs and logs are low. A same-site check of the old code there
  (N = 1 and 5, follow and walk) gave the same low legs and the same no-path results, and the new code did better on it:
  - follow, N = 5: ELU 0.151 → 0.062, look-ahead 2.9% → 0.5%;
  - walk, N = 5: ELU 0.297 → 0.229, look-ahead 1.3% → 0.1%.
- **This machine is not saturated by 10 bots of the old code** on an easier site: at (2000, 2000), 1.5 s stagger, walk
  ELU 0.378, gather ELU 0.336 (19 logs), 20 ticks/s.
- **Without a budget, gather at 20–30 bots still saturates the loop** (ELU 1.0, 6.4–8.2 ticks/s). The budget fixes that
  (§11.5).

### 11.5 The A\* budget (same site, (0, −4000))

Budget 0 (the control, first) against budget 20 ms per 50 ms window (second, on the thinner forest). Logs and legs in
the 60 s phase.

| N | Phase | Budget 0 | Budget 20 |
|---|---|---|---|
| 10 | walk | ELU 0.253, p99 31 ms, 45 legs | 0.192, p99 27, 56 legs |
| 10 | gather | 0.885, p99 243, 20 t/s, 80 logs, 11 timeouts | 0.426, p99 29, 20 t/s, 102 logs, 24 timeouts |
| 20 | walk | 0.343, 105 legs | 0.306, 117 legs |
| 20 | gather | 1.0, p50 493 / p99 597, 8.2 t/s, 40 logs | 0.486, p50 6.2 / p99 29, 20 t/s, 95 logs |
| 30 | walk | 0.669, p99 65, 153 legs | 0.425, p99 29, 169 legs |
| 30 | gather | 1.0, p50 751 / p99 1018, 5.7 t/s, 23 logs | 0.582, p50 6.6 / p99 34, 20 t/s, 137 logs |
| 30 | follow | 0.178 | 0.206 |

- **Better in every moving phase**, most in gather: at 30 bots 23 → 137 logs and the slowest bot 5.7 → 20 ticks/s, on a
  forest the control had already cut.
- **Not better everywhere:** search timeouts at N = 10 gather rose 11 → 24, and following at N = 30 cost a little more
  (ELU 0.178 → 0.206).

### 11.6 The worker pool

**First pass, same site ((−4000, 0)), before the block-cache fix of §11.9.** Workers 0 with budget 0 (the control)
against 14 workers. "CPU" is the whole process, in % of one core.

| N | Phase | Workers 0, budget 0 | Workers 14 |
|---|---|---|---|
| 10 | walk | ELU 0.272, 39 legs | 0.059, 38 legs |
| 10 | gather | 0.951, 18.1 t/s, 52 logs, noPath 0, timeouts 17 | 0.094, 20 t/s, 39 logs, noPath 95, timeouts 0, CPU 420% |
| 20 | walk | 0.816, p99 246, 53 legs | 0.121, p99 13, 68 legs |
| 20 | gather | 1.0, 11.8 t/s, 30 logs | 0.339, 20 t/s, 27 logs, noPath 179, CPU 1460% |
| 30 | walk | 0.902, p99 302, 80 legs | 0.207, p99 14, 122 legs |
| 30 | gather | 1.0, 6.9 t/s, 19 logs | 0.632, 19.6 t/s, 14 logs, noPath 96, CPU 1681% |

**The extra "noPath" is not a worker error.**
- The same requests, run uncapped on the main thread, gave identical answers: 25 of 25, with the same visited-node counts.
- They are `GoalLookAtBlock` searches for logs nobody can reach (left floating after cutting). Each is exhaustive:
  13 000–20 000 nodes within the 64-block radius.
- The loaded main thread timed them out (`thinkTimeout`); the workers finish them. Both outcomes make `mineBlock` skip
  the log.
- **The CPU is wasted:** every bot, and every `mineBlock` call, searches the same unreachable logs again, because the
  set of failed targets lives for one call.

**Final, cross-site:** the defaults (budget 20, workers 0) at (64, 4064) against 14 workers + budget 20 at
(−1840, −1872), each on its own fresh forest.

| N | Phase | Defaults | Workers 14 |
|---|---|---|---|
| 10 | idle | ELU 0.034 | 0.027 |
| 10 | follow | 0.231, p99 27 | 0.053, p99 12 |
| 10 | walk | 0.293, p99 28, 20 t/s, 52 legs | 0.068, p99 13, 20 t/s, 49 legs |
| 10 | gather | 0.409, p99 29, 20 t/s, 119 logs | 0.075, p99 14, 20 t/s, 70 logs, noPath 44, CPU 229% |
| 20 | follow | 0.399 | 0.113 |
| 20 | walk | 0.422, p99 28, 103 legs | 0.142, p99 15, 97 legs |
| 20 | gather | 0.5, p99 33, 20 t/s, 121 logs | 0.29, p99 22, 20 t/s, 87 logs, noPath 97, CPU 1128% |
| 30 | idle | 0.046 | 0.038 |
| 30 | follow | 0.443, p99 28 | 0.215, p99 19 |
| 30 | walk | 0.584, p99 29, 20 t/s, 143 legs | 0.199, p99 15, 20 t/s, 146 legs |
| 30 | gather | 0.624, p99 37, 20 t/s, 173 logs, RSS 2.7 GB | 0.342, p99 20, 20 t/s, 85 logs, noPath 104, CPU 1210%, RSS 9.2 GB |

- **Memory:** with workers, RSS went from 2.2 GB (N = 10 idle) to 7.9 GB (N = 20 gather) and 9.2 GB (N = 30 gather);
  with the defaults, 0.8 → 2.7 GB. The worker heaps are not capped, and the mirror and each search's state grow with
  exhaustive searches.
- **Health:** 14 of 14 workers alive at the end; 5 497 searches offloaded, 4 791 answered, 0 fallbacks to the main
  thread, 0 restarts.

### 11.7 Capacity on this machine

- **Old code:** walking saturates at about 20 bots (ELU 0.91; at 30, 0.96 and 13.8 ticks/s). Gathering saturates at
  about 10 (ELU 1.0, 17.9 ticks/s; at 30, 5.3 ticks/s and 20 logs).
- **Defaults now (patches + budget 20):** 30 bots walking at ELU 0.58, gathering at 0.62, every bot at 20 ticks/s, loop
  p99 ≤ 37 ms.
  - 30 is the most measured (max-players and the ramp).
  - **Est.:** extrapolated from ELU, the main thread would reach about 0.9 around 45–50 moving bots.
- **With 14 workers:** 30 moving bots at a main-thread ELU of 0.2–0.34. The limit then is memory (9 GB at 30
  gathering) and the workers' CPU, not the event loop.

### 11.8 The defaults, and why

- **`pathfinding.astarBudgetMs` = 20 (on).** Measured better than no budget in every moving phase at 10–30 bots, on the
  same site (§11.5). Without a cap, many searches together fill the loop, every bot moves in slow motion, and searches
  time out more. A lone search still gets its 10 ms `tickTimeout`, so light loads are unchanged. `0` turns it off;
  at most 50.
- **`pathfinding.workers` = 0 (off).**
  - With the budget on, the main thread is no longer saturated at 30 moving bots on this machine (§11.7).
  - The workers' gather did less work in both comparisons. They finish exhaustive no-path searches that the main
    thread would time out, at 11–12 cores of CPU (§11.6).
  - Memory grows to about 9 GB at 30 gathering bots.
  - **When to turn it on:** when the main thread is the limit: a slower PC (the laptop of §1), or more bots. It cuts
    the main thread's ELU 2–4×. It passed the live test (§11.9). It is capped at the cores minus one.

### 11.9 Live tests, a bug, and other findings

**Live tests** (`npm run live-test`, dev server):
- Defaults: 5/5, with budget 0 at the time and again with budget 20 as the default.
- `LIVE_PATH_WORKERS=4`: 5/5. `LIVE_PATH_WORKERS=14` (final): 5/5.
- Two failures on the test's side:
  - the arrow check assumed a fresh inventory (fixed in `a0bf481`);
  - the spawn site near (−348, −146) had been stripped of reachable logs by repeated runs (the old code fails there the
    same way). 2-block oak stumps were placed over RCON on the dev world.

**A bug in the A\* block cache (patch B), fixed in `32e086a`.**
- `getMoveJumpUp` did `blockC.height += 1` on the block `Movements.getBlock` returned. With the cache, that block is
  shared, so every re-expansion raised the column until the jump looked too high. A bot carrying scaffolding lost its
  jump-up-and-place moves.
- On the main thread the cache clears every tick, which mostly hid it; in a path worker it lasted the whole search.
- Fix: a local height in `movements.js`, and each worker search starts with an empty block cache.

**Other findings (not fixed):**
- **mineflayer-collectblock's listener pile-up:** `cancelTask` adds a `once(bot, 'collectBlock_finished')` and an
  `'error'` listener each time a stalled `mineBlock` is cancelled. On a site with many stalls they pass 10
  (`MaxListenersExceededWarning`, seen at N = 10 gather on the harsh site). Upstream behaviour, not from these changes.
- **Unreachable logs are searched again and again** (§11.6). Recommendation (not done): remember unreachable targets
  per order for about 2 minutes.
- **The bench replaces the pool's skipped-packet reporter** with its own, so `/api/metrics` `skippedPackets` stays 0
  under the bench.

### 11.10 Not measured or not done

- **`/bots status` in game:** only its JUnit test (`SquadStatusFormatTest`) ran.
- **The worker pool's stats in the vitals:** `PathWorkerPool.stats()` exists, but no `/api/metrics` or vitals field
  shows it yet.
- **The collectblock listener pile-up** and **the unreachable-target memory** (§11.9).
- **More than 30 bots.** The capacity above 30 is an estimate.
- **The laptop with the Minecraft client running** (§10): still the production case, still not measured. The laptop is
  where the worker pool may matter.
- **Repeats:** each comparison ran once; the spread is unknown.
