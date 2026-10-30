# Prompt: review the performance of Squad, multithreading included

> Paste everything below the line into a Claude Code session started at the repo root on Paul's Windows machine
> (`claude` in `PaulsBrawls`, PowerShell). It is a **review**: measure, explain, recommend. It may write benchmark
> scripts and throwaway prototypes, but it changes no behaviour in `squad/` or the mod without Paul's go-ahead.

---

You are reviewing the performance of **Squad**, the player-owned Mineflayer bot system of this repo. Paul wants to
know how many bots and orders it can run smoothly on this PC, where the time goes, and which optimisations are worth
making: cheap settings first, then structural ones, **multithreading in particular**. Measure everything you claim.
An option without a number behind it is a guess, and must be labelled one.

## Read first

1. `docs/system/squad/overview.md`: the as-built reference. It is the source of truth for the "Processes and
   threads" table and the list of what is not verified.
2. `docs/29-squad-design.md`: the design, its owner decisions (§1, O1–O7, never relitigate) and §16 (what the
   live runs found).
3. `squad/README.md` and `CLAUDE.md` (the Squad sections, the port map, the gotchas).
4. The code, in this order: `squad/src/main.ts`, `bots/pool.ts`, `bots/hardening.ts`, `bots/protocol.ts`,
   `orders/runner.ts`, `orders/order.ts`, `orders/guard.ts`, `api/squad.ts`, `api/helpers.ts`, `script/compile.ts`,
   `script/check.ts`, `journal/journal.ts`.

## What is known

- **One thread does everything.** One Node process on one event loop runs:
  - every bot: protocol decoding, 20 Hz physics, pathfinder A*, and the pvp, collectblock, auto-eat, armor-manager,
    tool and hawkEye plugins;
  - every order's script;
  - the leases, the HTTP/SSE/MCP server and the synchronous SQLite journal.

  Only the TypeScript typecheck has its own worker thread. A supervisor process restarts the runtime when its
  heartbeat stops for 10 s.
- **The pathfinder is the first suspect.** Its settings (`hardening.ts`) are thinkTimeout 5 s, searchRadius 64 and
  **tickTimeout 10 ms**, which is the planning time each bot may spend per 50 ms game tick. Five bots planning at
  once can therefore fill a whole tick. Verify this; don't assume it.
- **Nothing measures the event loop.** There is no lag monitor (Eden's `lag-monitor.ts` was not copied) and no
  metrics endpoint.
- **Production evidence (2026-10-27):**
  - The Minecraft server logged "Can't keep up! … 2–6 s behind" while bots joined.
  - Paths of 4–14 blocks failed with "Took to long to decide path" under the old 2 s limit.
  - That PC also runs the Minecraft client.
- **Production use so far:** about 5 bots and at most one 5-bot order at a time. The design's target is 30 bots
  per process (docs/29 §15, unmeasured).
- **Each bot is a full player.** It has its own connection and its own copy of the chunks and entities it sees, and
  the server sends chunks to it, tracks entities for it, and simulates around it.

## Constraints

- **Where to work:** in `squad/` and `src/main/java/com/paul/brawl/squad/` only. **Eden is dead code**: don't touch
  it, though you may read it for ideas (its `journal/lag-monitor.ts` is worth copying).
- **The production server (`server/`) runs only when Paul says so.** Never start, stop or restart it, and never
  run a load test on it. Load tests use the dev server:
  - `./gradlew runServer` in `run/`, on port 25599 with RCON 25575 (read `run/server.properties`, R28);
  - set `JAVA_HOME=C:/Users/Paul/AppData/Roaming/PrismLauncher/java/java-runtime-delta` (there is no JDK on PATH);
  - the dev and production servers both use RCON port 25575, so they can't run with RCON at the same time.
- **Owner decisions shape the options. Say plainly when an option breaks one.**
  - No sandbox (O1).
  - A command is one program that controls all its bots and gets the **real mineflayer bot object** (O2, §5.1).
  - Co-owners reclaim bots between orders, and reclaimed bots return (O4).

  Together these mean the bots and the scripts driving them share one JS realm. Moving bots into workers breaks
  that, unless scripts reach their bots through a cross-thread proxy (and that is no longer "the real bot") or bots
  move between workers (and that means reconnecting).
- **Keep the lessons:** the login stagger (I1), `viewDistance: 'short'` (R8: 'tiny' broke block searches), the
  bounded pathfinder (R6), the abort sequence (R4/R5), the protocol hardening (§16).
- Don't commit unless Paul asks. If you prototype in code, do it on a branch or behind a flag, and keep
  `npm run check` green.

## What to do

### 1. A reproducible benchmark (first)

Write `squad/bench/` (Node, `tsx`), reusing the runtime the way `live-tests/run.ts` does (in process, RCON for the
world):
- **Load:** N bots on the dev server, N = 1, 5, 10, 20, 30, logged in with the stagger. Four phases per N, each held
  for about 60 s: idle, all following a point (`follow`), all walking to random points 20–60 blocks away (`goTo`
  in a loop), all mining (`gather`).
- **Measure per phase:**
  - event-loop delay p50/p99/max (`perf_hooks.monitorEventLoopDelay`, armed before the phase);
  - process CPU %, heap and RSS, and bot RSS per bot;
  - pathfinder outcomes: time to plan, "Took to long" and "No path" counts;
  - deaf-watchdog trips, and the protocol packets skipped;
  - the Minecraft server's tick time (`tick query` over RCON) and its "Can't keep up" lines.
- **Profile:** at least one `node --cpu-prof` per phase at N = 10 and 30. Summarise the top self-time functions,
  grouped by package (minecraft-protocol/protodef, prismarine-physics, mineflayer-pathfinder, plugins, squad code).
- **Our own overhead:** measure it in isolation with micro-benchmarks:
  - the lease-guarded Proxy per call (`orders/guard.ts`);
  - the loop-budget instrumentation (`script/compile.ts`);
  - `squad.tasks`;
  - the journal's synchronous writes;
  - the SSE broadcast.

Record the PC (CPU, cores, RAM) and what else ran: the dev server, and the client if open. Repeat each measurement
at least twice and report the spread.

### 2. Where the time goes

From the numbers, say what saturates first (the event loop, one CPU core, memory, the Minecraft server's tick, or
the network) and at which N, for each phase. Separate the bots' cost (mineflayer and its plugins), the scripts' cost,
and Squad's own cost.

### 3. The options

Evaluate each option below, plus any you find, with: the expected gain (measured, or estimated and marked as such),
the cost to build, the risk, and which owner decision or R-lesson it touches.

- **Settings:**
  - pathfinder tickTimeout/thinkTimeout/searchRadius, and Movements costs;
  - physics and plugin intervals: the auto-eat and armor-manager polling; tool and hawkEye loaded only on bots
    that need them;
  - view distance (and why R8 rules out 'tiny');
  - login stagger;
  - limiting concurrent pathfinding: a token bucket across bots, so N bots don't all plan in the same tick;
  - server-side `view-distance` and `simulation-distance`.
- **Multithreading:**
  1. **Bot groups in `worker_threads`.** Each worker owns some bots and runs the orders that use only them. How do
     orders spanning workers and reclaims across workers work: a cross-thread RPC proxy, or bot migration by
     reconnect? What does it do to the dialect (O2), and to latency for per-tick control (`setControlState`)?
  2. **Pathfinding in a worker.** Plan from a snapshot or a shared copy of the world (`SharedArrayBuffer` chunk
     storage?) and execute on the main thread. How feasible is it with mineflayer-pathfinder's design? What does a
     world snapshot cost per plan?
  3. **Processes instead of threads** (several runtimes, bots sharded by owner or by load): crash isolation versus
     the same realm problem, and what the mod and the leases would need.
  4. **Moving decoding or physics off the main thread:** what mineflayer allows without a fork.
- **Algorithmic, inside one process:**
  - share chunk/world data between bots in the same area (each connection still receives and decodes its own
    packets: say whether decoding or storage dominates);
  - cheaper `findBlocks` (searched once and shared by a `squad.tasks` batch);
  - fewer `entities` scans in `nearestEntity` for many bots.
- **Server side:** what the Minecraft server spends per bot-player, and what the mod could do about it (nothing
  hacky: the bots must stay real players).
- **Observability:**
  - copy Eden's lag monitor;
  - a `/api/metrics` route (loop delay, CPU, per-bot pathfinding stats, skipped packets) the mod could show in
    `/bots status`;
  - journaling a vitals summary (never the hot stream, R44).

### 4. A recommendation

A ranked plan:
- what to do now (cheap, measured gain);
- what to do when Paul needs more bots, with the N where it becomes necessary;
- what not to do, and why.

Answer the multithreading question directly: is it needed for the realistic load (10–30 bots, a few concurrent
orders), and if so, which variant, at what cost to O2 and O4?

## Deliverables

- `squad/bench/`, the benchmark scripts, runnable with one command each, with a short README.
- `docs/31-squad-performance-review.md`:
  - the setup;
  - tables of the measurements per N and phase;
  - the profile summaries;
  - "where the time goes";
  - an options table: option, gain, cost, risk, decisions touched, verdict;
  - the recommendation;
  - a section "not measured" for everything you could not test.
- If you prototyped something, say where and how to remove it. Leave the runtime's default behaviour unchanged.

When you are done, give Paul a short summary of the findings and the recommended first step, with its expected
gain in numbers.
