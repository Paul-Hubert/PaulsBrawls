# 36 — Squad in a fight: 10 guards + 10 archers against the same army, where the time goes (measured)

> Measured 2026-11-01 with the new fight benchmark, `npm run bench:fight` ([squad/bench/README.md](../squad/bench/README.md),
> "The fight benchmark"). The code measured is `rework` at `7a5f956`, from a separate worktree, with a dev server of
> its own (ports 25601 / RCON 25578 / runtime 8780) so as not to collide with the docs/35 session working in the main
> tree. Runs: `10v10` (3 rounds, the first profiled) and `hawk4` (the same with an experiment, §7). Earlier reviews:
> [docs/31](31-squad-performance-review.md) (walking, gathering, following; §11 after the fixes).
> Every number is measured unless marked "est.".

## 0. Summary

- **The fight.** Blue (10 `Garde` + 10 `Archer`, the kits of `/bots squad spawn`) runs `defend radius=24`. Red is the
  exact same army (same kits, same counts, the mirrored formation 40 blocks away) and runs `raid radius=24` on blue,
  as `/bots raid` does. **Red won all 3 rounds** in 66–82 s, with 7–9 survivors. Blue's archers fired 236–254 arrows a
  round and red's 365–428. A raid's archers engage within 24 blocks of their *leader*, at the front, while a defending
  archer engages within 24 blocks of *itself*, a few rows back. So red shoots first and more often.
- **The load.** Standing, 40 bots cost 4.6 % of the main thread (ELU 0.046). In the first ~20 s of a fight (more than
  30 bots alive) the main thread is busy **60–66 % of the time, peaking at 85 %**. That is a round mean of 0.36–0.41
  ELU, every bot at 20 physics ticks/s and loop p99 14–26 ms. The server ran at 7.6–8 ms per tick (p95 12–13 ms), with
  no "Can't keep up!". **On this desktop (Ryzen 9 9950X3D) a 20 v 20 fight fits.** On the docs/31 laptop (i7-1255U,
  about half the speed per core) the same fight would need about 1.2–1.3 cores (est.), i.e. saturation.
- **What takes the longest (CPU, main thread, % of busy time, profiled round 1):**

  | # | Cost | % of busy | Where |
  |---|---|---|---|
  | 1 | **hawkEye's aim, recomputed every physics tick of every drawing archer** | **44–45** | `getGrades` → `getMasterGrade` → `tryGrade` (minecrafthawkeye) |
  | 1a | ↳ its line-of-fire raycasts, one per step of 23 trajectories per tick | **31** | `intercept.check` → `world.raycast` → `getBlock` → `fromStateId` / `new Block` |
  | 1b | ↳ its sweep of 179 launch angles (no raycast) | 12 | `getFirstGradeAproax` |
  | 2 | Packet handling (decode, inflate, mineflayer's handlers) | 26 | 592 packets/s per bot: every bot receives every other bot's moves |
  | 3 | The bots' own physics | 9 | `simulatePlayer`, `updatePosition`, `blockAt` |
  | 4 | Pathfinding (A* in `planPath`, path execution) | 6–7 | mineflayer-pathfinder `monitorMovement` |
  | 5 | Garbage collection | 5 | |
  | 6 | **Squad's own code** (runtime, helpers, the commands) | **2.5** | `defend`'s loop + `pick` 0.8 %, `nearestEntity` 0.5 %, the protocol hardening's frame |

- **What takes the longest in game time** (the helpers as the commands call them, §4):
  - `shoot`: 1.33 s median (the bow's draw). The p95 of 3.0–3.4 s is the 4–5 % of shots hawkEye cannot place
    (« no arrow left the bow »), which wait out its 1.45 s and then fall back to a hand-aimed shot.
  - `attack`: 8.5–9 s median per melee fight, up to 17 s.
  - `follow`: 200 ms per call, by design.
  - All helpers together block the loop for under 0.4 s of a 66–82 s round.
- **Bugs found on the way:**
  1. **Every `Bot` object ever created stays in memory** (§5). `freshHawkEye` drops hawkEye from the require cache, but
     each fresh copy stays in the loading module's `module.children`, and each copy keeps its bot (`loadBot.bot`)
     with its whole world. RSS grew 1.1 GB per round; the repro keeps 20/20 bots. This hits production on every
     reconnect, despawn + spawn and future D2 respawn.
  2. **The login stagger does not apply to `/api/bots/spawn`** (§6). 40 bots logged in within 6 s, not 4 s apart,
     and the runtime's monitor saw loop stalls of 0.8–1.1 s. Any `/bots squad spawn … 10` or `/bots raid` logs in its
     bots at once.
  3. **auto-eat leaks two listeners every time an eat times out** (§5.2). That happens in fights, where a sword or
     bow switch interrupts the meal.
- **Measured fix direction (§7):** hawkEye aiming on one tick in four cut the full-strength ELU by 35 % (0.60–0.66 →
  0.37–0.42) and hawkEye's own time by 68 %. The outcome was the same and failed shots did not increase, but arrow
  kills per shot fell by about a quarter (3 rounds: indicative). The raycast fixes of §8 should get most of that
  saving without touching the aim.

## 1. Setup

| | |
|---|---|
| PC | AMD Ryzen 9 9950X3D (16 cores / 32 threads), Windows 11 Pro 10.0.26200 (the machine of docs/31 §11, not the docs/31 laptop) |
| Node | v24.15.0, the runtime in process under tsx (as `npm start` runs it). mineflayer 4.39, minecrafthawkeye 1.3.9, the docs/32 patches applied |
| Code | `rework` at `7a5f956`, in a worktree (`../pauls-brawls-fight`, branch `squad-fight-bench`) plus the bench files of this doc; `node_modules` is the main tree's (a junction) |
| Server | `./gradlew runDevServer` from the worktree: a fresh dev world (seed −7631148978891210040), port 25601, RCON 25578, `max-players=48`, view distance 20, simulation distance 10, compression 256, `online-mode=false`; `squad.properties` points the mod at the bench runtime (`:8780`), so **the friendly-fire rule is on** (0 friendly kills in every round) |
| World | Day, no mobs, no weather, `keepInventory`, immediate respawn, difficulty hard (production's). Arena: a 97 × 49 stone floor at y 100 around (1400, 1000), barrier walls |
| Armies | Blue `BleuGarde01–10`, `BleuArcher01–10` (owner `BenchBleu`); red `RougeGarde01–10`, `RougeArcher01–10` (owner `BenchRouge`). Kits = `SquadKits.java` item for item; role tags. Rows of 5, 2 blocks apart, guards in front, front rows 40 blocks apart, facing each other |
| Orders | Blue `defend radius=24` (no commander online: each bot defends where it stands). Red `raid radius=24 x=1380 y=101 z=1000` (blue's front) |
| Deaths | A bot that dies is despawned at once (docs/35 D2, being built: « a bot that dies disconnects »), and spawned back between rounds. Before the despawn lands, mineflayer has already respawned it at the world spawn and started loading chunks there; that is the 3.3 % `map_chunk` in §3.4 |
| Runs | `10v10`: idle 20 s, then 3 rounds (round 1 profiled at 1 ms sampling). `hawk4`: the same with `--hawkeye-every 4` (§7). No other Minecraft server ran on the PC (two Gradle daemons did; the docs/35 session may have run unit tests) |

## 2. The fight

| phase | s | ended | survivors B / R | deaths (melee / arrow) | ELU | ELU, >30 alive | loop p50 / p99 / max ms | CPU % | ticks/s min / mean | server tick mean / p95 ms | heap MB | RSS MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| idle (40 bots) | 20 | | | | 0.046 | | 0.8 / 2.4 / 7.5 | 6.4 | 20 / 20.5 | 3.5 / 4.9 | 490 | 1 731 |
| round 1 (profiled) | 68 | blue wiped | 0 / 7 | 33 (10 / 23) | 0.411 | 0.656 | 0.7 / 13.8 / 48.7 | 48.8 | 19.9 / 20 | 8.0 / 12.8 | 672 | 2 118 |
| round 2 | 82 | blue wiped | 0 / 8 | 32 (10 / 22) | 0.355 | 0.596 | 5.8 / 25.6 / 163 | 40.4 | 19.9 / 20 | 7.6 / 12.2 | 979 | 3 193 |
| round 3 | 66 | blue wiped | 0 / 9 | 31 (8 / 23) | 0.411 | 0.610 | 5.8 / 25.7 / 165 | 50.3 | 19.9 / 20 | 7.6 / 12.1 | 1 187 | 4 389 |

- **The shape of a round:**
  - **0–12 s, the approach.** ELU 0.6–0.85: the raid marches, every archer draws as soon as it has a target.
  - **13–25 s, the clash.** The first deaths come, about half the bots die within 10 s, and the load falls with
    them.
  - **After that, the mop-up:** a few archers duelling, ELU 0.1–0.3.
- **Per round:**
  - **Shots:** 600–680; « no arrow left the bow » (no clear line of fire) 4.0–5.3 % of them.
  - **Path searches:** 735–888, all ok, no timeouts. Planning p50 1 ms, p95 54 ms. 430–490 `goal_moved` resets: the
    raid's formation follows a moving leader.
  - **Kills:** arrows 22–23, melee 8–10, friendly 0.
  - **Network:** 512–597 packets/s and 11–14 KB/s per bot.
- **The loop p50 of 5.8 ms in rounds 2–3** is Windows' 15.6 ms timer quantum (docs/31 §1). The profiler's 1 ms
  sampling raises the system timer resolution, so round 1 shows 0.7 ms. Compare p99, max and ELU, not p50.
- **The 163–165 ms worst seconds** fell at the first deaths of rounds 2–3 (14 s in round 3). That is when the despawns
  start, with a heap that the leak of §5 had grown past 1 GB. They are not attributed further.

## 3. Where the CPU goes (the profile of round 1)

`bench/.runs/<run>/summary.md` has the full tables; `npm run bench:callees -- <profile> fn …` (new) splits a function's
time by its callees (EventEmitter's `emit` see-through), `npm run bench:callers` by its callers.

### 3.1 By cause (inclusive: the first cause found on the stack)

| cause | ms (of 23 s busy in 68 s) | % of busy |
|---|---|---|
| plugins: hawkEye 45, pvp, auto-eat, armor | 10 711 | 46.5 |
| packet handling (decode, inflate, mineflayer handlers) | 5 926 | 25.7 |
| own physics | 2 021 | 8.8 |
| pathfinder: A* | 1 438 | 6.2 |
| garbage collector | 1 161 | 5.0 |
| Squad (runtime, helpers, commands) | 573 | 2.5 |
| V8 / native outside JS | 507 | 2.2 |
| other (timers, keepalive) | 355 | 1.5 |
| pathfinder: look-ahead and path execution | 273 | 1.2 |

### 3.2 One physics tick, all bots: 65 % of the busy time

mineflayer runs each bot's `physicsTick` listeners after its own physics (`tickPhysics`, 14.9 s):

| listener / part | ms | % of busy |
|---|---|---|
| **hawkEye `getGrades`** (the aim of a drawing archer, every tick) | **10 398** | **45.2** |
| pathfinder `monitorMovement` (of which `planPath` A* 5.1 %) | 1 689 | 7.3 |
| the bot's own simulation (`simulatePlayer`) | 860 | 3.7 |
| `updatePosition` (the position packet) | 677 | 2.9 |
| `blockAt` (the block under the bot) | 650 | 2.8 |
| hawkEye `autoCalc` (look, release) | 153 | 0.7 |
| pvp, auto-eat, time | 60 | 0.3 |

### 3.3 Inside hawkEye's aim

`getMasterGrade` does, **every tick, for every archer drawing a bow**:
- **The base trajectory, twice** (before and after leading the target): a sweep of the 179 whole angles from −89° to
  89°, each a full flight simulation (`getFirstGradeAproax`). Then 1–2 more flights with a block check
  (`geBaseCalculation`).
- **The precision search** (`getPrecisionShot`): 21 more flights 0.1° apart, **every one with a block check**,
  although only the best one is kept.

A block check is a raycast between every two consecutive points of the flight, and every voxel it crosses is a
`world.getBlock`: a new prismarine `Block`, with its `Biome` and a block-entity lookup.

| part | ms | % of busy |
|---|---|---|
| `tryGrade` (all flights) | 10 155 | 44.1 |
| ↳ **line-of-fire raycasts** (`intercept.check` → `world.raycast`) | **7 231** | **31.4** |
| ↳ flight arithmetic (`tryGrade` itself, `getVoy`, `getVox`, `applyGravityToVoy`) | 2 864 | 12.4 |
| by caller: `getPrecisionShot` (21 raycast flights) | 6 724 | 29.2 |
| by caller: `getFirstGradeAproax` (179 flights, no raycast) | 2 779 | 12.1 |
| by caller: `geBaseCalculation`'s own checked flights | 770 | 3.3 |

- **`Block` construction** (`fromStateId`) has 2 463 ms of self time, the single hottest function. **80 % of it comes
  from hawkEye's raycasts**; the pathfinder and the bots' physics make the rest. It is the hot spot docs/31 §4 found
  in A*, and docs/32 patched there with a block cache. hawkEye's raycasts go around that cache.
- **Per shot:** about 627 shots × ~26 drawn ticks ≈ 16 000 aim computations, at **≈ 0.64 ms each** (profiled). With
  20 archers drawing, that is ≈ 260 ms of aiming per second, a quarter of a core here (est.).

### 3.4 Packets: 26 %

| | ms | % of busy |
|---|---|---|
| decode + inflate (instrumented: `parsePacketBuffer`, `unzipSync`) | | 1.3–1.7 % of **wall** time |
| `map_chunk` (chunks: the dead respawning at the world spawn before the despawn, a bench artifact, §1) | 750 | 3.3 |
| `multi_block_change` | 210 | 0.9 |
| entity moves, equipment, metadata, velocity, spawns (one handler each) | 110–200 each, ≈ 700 together | ≈ 3 |
| the stream layers above them (framing, decompression transform, Squad's protocol hardening frame) | | the rest |

Every bot tracks the other 39 players plus every arrow, up to 120–190 entities per bot, and gets 512–597 packets/s,
so this grows as N² (docs/31 §2.3). It is spread thin: no single handler is above 1 %.

### 3.5 Squad's own code: 2.5 %

By total time:
- **The protocol hardening's `_transform`, 18 % inclusive:** every packet goes through it, but its own time is 33 ms.
- **`defend`'s loop:** 195 ms, of which `pick` is 159 ms.
- **`nearestEntity`:** 118 ms, plus 94 ms for `nearestHostile`.
- **The pool's handlers:** 143 ms.
- **The despawns:** roster `save`, 41 ms.
- **`raid`:** `engage`, `pick`, `nearestFoe`, 35–55 ms each.

The guard proxy's `get` is 43 ms. **Nothing in Squad is worth optimizing for fights.**

### 3.6 Standing (idle, 40 bots): 2.9 % busy

Own physics is half of it (`blockAt` 21 %, `simulatePlayer` 19 % of 0.6 s) and packets the rest. The docs/32
patches keep standing bots cheap.

## 4. Where the wall time goes: the helpers as the commands call them

`lib/helper-timing.ts` wraps every entry of `HELPERS` before the orders start. A row is one helper, all bots, in one
round:
- **wall** is call → settle (game time, mostly waiting);
- **sync** is call → first return: the part that blocks the event loop.

| helper | calls / round | ended | wall p50 / p95 / max | wall total | sync total | sync mean |
|---|---|---|---|---|---|---|
| `shoot` | 601–682 | ok 92–94 %; « no arrow left the bow » 4–5 %; `BotLeftError` 1–2 % | 1.33 s / 3.0–3.4 s / 3.5 s | 873–993 s | 19–23 ms | 31–37 µs |
| `follow` | 3 891–5 177 | ok | 201–204 ms / 204–216 ms / 256 ms | 796–1 063 s | 18–23 ms | 4–6 µs |
| `attack` | 47–49 | ok 96–100 % | 8.5–9.1 s / 15.2–15.8 s / 17 s | 379–390 s | 2–2.5 ms | 34–52 µs |
| `nearestHostile` | 8 804–11 586 | ok | < 0.1 ms | 0.1–0.2 s | 99–163 ms | 11–17 µs |
| `nearestEntity` | 8 805–11 587 | ok | < 0.1 ms | 0.1 s | 88–112 ms | 10 µs |
| `goTo` | 9–10 | `BotLeftError` (the leader died) | < 1 ms | 0 | 1 ms | 70–130 µs |

- **`shoot`'s p95 is the fallback.** When hawkEye finds no trajectory it keeps the bow drawn and fires nothing; `shoot`
  waits `SHOT_WAIT_MS` (1.45 s), aims by hand and stops it. A shot that still does not leave throws « no clear line
  of fire », and the command sidesteps. Those 4–5 % of shots cost 3 s each instead of 1.3 s. Why hawkEye finds no
  trajectory on an open arena was not determined. Its line-of-fire check sees blocks only, never entities, so a
  friend standing in the line is not what stops it. Nothing stops an archer from shooting through its own guards
  either: the mod cancels the damage, and the arrow is wasted.
- **`attack`** lasts until the target dies or `timeoutMs` (15 s); the max of 17 s is the timeout plus the last
  `pvp.stop`.
- **The scans are cheap but many:** 9–11 k calls a round, 10–17 µs each, as entities grow with the arrows (docs/31
  §2.4: 12–15 µs at 400 entities).

## 5. Memory: a leak, and a smaller one

### 5.1 Every bot that ever loaded hawkEye stays in memory

- **Measured:** heap 490 → 672 → 979 → 1 187 MB and RSS 1.7 → 2.1 → 3.2 → 4.4 GB over the idle phase and three
  rounds. 31–33 bots were despawned and spawned back per round, so ≈ 35 MB per bot (its world of 313 chunk columns,
  docs/31 §2.3). The `hawk4` run grew the same way.
- **Cause,** `src/bots/plugins.ts` (`freshHawkEye`):
  - It loads minecrafthawkeye again for every bot, through a `createRequire` require, and deletes the files from the
    require cache.
  - Node also pushes each new module onto the loading module's `module.children`, which nothing clears.
  - Each copy's `loadBot.js` holds `exports.bot`, the bot it was injected into. So the old `Bot`, its world and its
    listeners stay reachable.
- **Repro, no server:** `node --expose-gc --import tsx bench/repro-hawkeye-leak.ts` (new) prints:

  ```
  20/20 bots still reachable after GC; the loading module holds 20 children; arrayBuffers 322 MB (320 MB if all are kept)
  after clearing module.children: 2/20 reachable, arrayBuffers 34 MB
  ```

- **Production:** a new `Bot` is made at every login: the first spawn, every reconnect (kick, deaf watchdog, server
  restart, backoff), every `/bots despawn` + `/bots spawn`, every `/bots squad despawn|spawn`, and D2's respawn once
  it lands. Each one leaks its predecessor. A long-running runtime grows by ~35 MB per login.
- **Fix (not made here: `pool.ts`/`plugins.ts` are being edited by the docs/35 session):** after loading, take the new
  module out of its parent's `children` (`module.children.splice`, or load it with a throwaway parent each time).
  Check it with the repro: 0/20 reachable.

### 5.2 auto-eat leaks two listeners when an eat times out

`mineflayer-auto-eat` `buildEatingListener` (`dist/new.js:110-136`) adds an `entity_status` listener on the client and
an `updateSlot` listener on the inventory, and its timeout rejects without removing them. Seen in the 2 v 2 smoke run:
`MaxListenersExceededWarning: 11 entity_status listeners added to [Client]`. Bots eat when health drops below 14
(`minHealth`), so this happens in fights, where `shoot` and `attack` re-equip the weapon over the food. The cost per
listener is small: one closure call per `entity_status` packet. **Fix:** a patch-package patch removing both
listeners in the timeout. It is also worth asking whether a bot should start eating in the middle of a melee.

## 6. The login stagger is skipped for spawns

| when | logins | worst loop stall (the runtime's vitals monitor) |
|---|---|---|
| 40 bots spawned at the start | 40 in 6 s (10–300 ms apart, not 4 s) | ELU 0.91, p99 821 ms, max 948 ms, a bot at 10 ticks/s |
| 33 bots spawned back after round 1 | 33 in ~1 s | ELU 0.73, p99 657 ms, max 1 082 ms |
| after round 2 (before the respawns) | none | ELU 0.49, max 812 ms (unattributed; a 1.1 GB heap) |

- **The cause is in `BotPool.drain()`** (`src/bots/pool.ts:219-232`):
  - `first = true` is reset on every call, so the first login of a drain never waits.
  - The loop ends as soon as the queue is empty.
  - So a spawn that comes after the previous login started opens a new drain and connects at once.
- **Result:** the 4 s stagger (I1) only holds for names queued together, at boot. Every `/api/bots/spawn` (one per
  bot: `/bots spawn`, `/bots squad spawn guard 10`, `/bots raid`'s spawns) connects immediately, and N bots receive
  their 313 chunk columns at the same moment.
- **Fixed (2026-11-01, Paul's decision):**
  - `drain()` now waits `staggerMs − (now − lastConnect)` before each connect, whatever drain it is in
    (`tests/pool.test.ts`). The old code also connected bots queued together at once, so I1 never held at all.
  - The default `loginStaggerMs` is now 100 ms instead of 4 s.
  - The mod gives kits the same way: one at a time, `kitStaggerMs` (default 100) apart (`SquadPacer`). A raid or a
    squad counts a bot as arrived once its kit is on.
- **Measured after the change:**
  - `live-tests/probe-stagger.ts`, `/bots squad spawn guard 10` + `archer 10`: 20 logins in 2.8 s and 20 kits in
    2.8 s, both a median 108–109 ms apart, the two commands interleaved.
  - A 40-bot `bench:fight` (`stagger100`): 40 logins in 6.5 s, but the runtime's monitor still saw ELU 0.92, loop
    p99 925 ms and max 1.6 s during them. Each login decodes ~0.4 s of chunks, so 10 logins a second are still more
    than the loop can take.
  - Logins without a stall would need ~0.4–0.5 s between them on this machine (est.), or the chunk decoding off the
    main thread.

## 7. Experiment: hawkEye aims one tick in four

`--hawkeye-every 4` (bench-only) wraps the `getGrades` physicsTick listener hawkEye registers for a shot, so it runs
on the first tick and then one in four. `autoCalc` still turns the bow every tick, to the last aim, and the release
time is unchanged. Same three rounds.

| | baseline (`10v10`) | 1 tick in 4 (`hawk4`) |
|---|---|---|
| round ELU (rounds 1 / 2 / 3) | 0.411 / 0.355 / 0.411 | 0.253 / 0.226 / 0.229 |
| **ELU with > 30 bots alive** | **0.656 / 0.596 / 0.610** | **0.421 / 0.371 / 0.386** (−35 %) |
| CPU % with > 30 bots alive | 86 / 70 / 78 | 62 / 47 / 52 |
| hawkEye `getGrades` (profiled round 1) | 10 398 ms, 45 % of busy | 3 317 ms, 22 % of busy (−68 %) |
| loop p99 / max (rounds 2–3) | 26 / 165 ms | 18–20 / 53–56 ms |
| round length | 66–82 s | 76–91 s |
| shots; failed | 601–682; 4.0–5.3 % | 681–871; 3.6–5.4 % |
| arrow kills per shot | 3.2–3.8 % | 2.6–2.8 % |
| outcome | red, 7–9 survivors | red, 7–9 survivors |

- **The saving is real and large.** Throttling also left the loop calmer (p99 and max lower).
- **Accuracy:** the arrows hit about a quarter less often per shot. A target that moves between aims is led less
  well, and the rounds lasted ~10 s longer.
- **A better throttle** would aim every tick for the last few ticks before the release and coarsely before (est.:
  most of the saving, the same accuracy).

## 8. What to do, ranked (estimates from §3 and §7)

| # | Change | Where | Expected | Risk |
|---|---|---|---|---|
| 1 | **Fix the bot leak** (§5.1) | `src/bots/plugins.ts` `freshHawkEye` | −35 MB per login, forever. Not a CPU change, but a long-running production runtime grows without bound | none; the repro checks it |
| 2 | **Raycast only the best of the 21 precision flights** (and the next one if it is blocked) | patch minecrafthawkeye `getPrecisionShot` | −25 to −28 % of busy in a fight (29 % → 1–3 %) | low: the chosen grade is the same unless the best flight is blocked |
| 3 | **A cheap block lookup for the raycast**: state id → shapes from the registry, no `new Block`, or the docs/32 per-tick block cache | patch prismarine-world `raycast` or minecrafthawkeye `intercept.check` | most of the rest of 31 % (raycasts); also helps `bot.world.raycast` callers | medium: the matcher API gets a Block today |
| 4 | **Warm-start the angle sweep** from the last tick's grade (±10° instead of all 179) | patch minecrafthawkeye `getFirstGradeAproax` | −10 % of busy | low |
| 5 | **Aim every tick only near the release** (§7) | patch minecrafthawkeye `getGrades`/`autoCalc` (or our wrapper) | measured −35 % ELU at 1 in 4 everywhere; less with 2–4 if they land | accuracy: measure with `bench:fight` |
| 6 | ~~**Stagger every login** (§6)~~ done: 100 ms, kits 100 ms | `src/bots/pool.ts` `drain`, `SquadPacer` | fewer bots logging in at the same instant | none |
| 7 | **auto-eat's listener leak** (§5.2) | patch-package on mineflayer-auto-eat | small | none |

- **Doing 2–4 together should take a fight from ~0.6 to ~0.3 ELU at full strength** on this desktop (est.). That
  would make a 20 v 20 fight fit on the docs/31 laptop.
- **Squad's own code** (2.5 %) and the packet layer (26 %, spread over many handlers) are not where a fight's time
  goes.
- **A gameplay note, not a performance one:** `defend` loses to `raid` 3/3 with identical armies, because its archers
  engage from their own position rather than the line's front (§0).

## 9. Caveats

- **The profiled round is slower** (1 ms sampling). §3's percentages come from it; the timings to compare are rounds
  2–3.
- **The arena is open and flat.** In a forest or a village, the raycasts cross more blocks and more shots fall back
  to the slow path, so hawkEye's share would be larger (est.).
- **One run per configuration, three rounds each:** enough for 35 % or 68 %, not for 5 %. The accuracy difference
  of §7 is indicative.
- **Despawning the dead models D2 as decided.** Today's runtime lets them respawn at the world spawn and keep their
  chunks loaded: in production that adds the chunk decoding `--dead respawn` would show. The bench's despawn races
  the respawn, so a few columns are decoded anyway (§3.4).
- **This machine is not the docs/31 laptop.** The laptop figures in §0 and §8 are estimates (×2 per core).

## 10. Reproduce

```powershell
# the dev server with max-players=48 and dev/squad.properties → enabled=true, url=http\://127.0.0.1\:8779,
# token=live-test-token (put both back afterwards); JAVA_HOME: Prism's java-runtime-delta
./gradlew runDevServer
cd squad
npm run bench:fight -- --rounds 3 --label baseline              # idle 20 s, then 3 rounds (round 1 profiled)
npm run bench:fight -- --rounds 3 --hawkeye-every 4 --label hawk4
npm run bench:profiles -- bench/.runs/<run>/profiles            # self time, total time, Squad's frames
npm run bench:callees -- bench/.runs/<run>/profiles/fight-r1.cpuprofile tickPhysics getMasterGrade tryGrade raycast
npm run bench:callers -- bench/.runs/<run>/profiles/fight-r1.cpuprofile fromStateId
node --expose-gc --import tsx bench/repro-hawkeye-leak.ts       # §5.1
```

The two runs of this doc are in the worktree: `squad/bench/.runs/2026-11-01T07-35-49-957Z-10v10/` and
`…T07-46-08-985Z-hawk4/` (gitignored): `results.json` (the timeline, every death, every helper row), `summary.md`,
`profiles/*.cpuprofile`.
