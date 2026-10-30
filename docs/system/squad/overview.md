---
id: squad.overview
title: Squad — player-owned Mineflayer bots ordered by LLM-written commands (as built)
system: squad
summary: What runs today for /bots — the Node runtime in squad/ (processes, threads, bots, leases, orders, the command dialect, authoring over MCP, storage, HTTP API) and the mod's thin front in com.paul.brawl.squad — with the live results on the production server, the protocol hardening, and what is still unverified.
tags: [squad, bots, mineflayer, orders, leases, reclaim, authoring, mcp, squad-author, claude-code, kits, 8772, production]
sources:
  - docs/29-squad-design.md
  - squad/src/main.ts
  - squad/src/supervisor.ts
  - squad/src/bots/pool.ts
  - squad/src/bots/protocol.ts
  - squad/src/bots/hardening.ts
  - squad/src/leases.ts
  - squad/src/orders/runner.ts
  - squad/src/orders/order.ts
  - squad/src/orders/guard.ts
  - squad/src/api/squad.ts
  - squad/src/api/helpers.ts
  - squad/src/script/compile.ts
  - squad/src/script/check.ts
  - squad/src/script/typecheck-worker.mjs
  - squad/src/authoring.ts
  - squad/src/http/server.ts
  - squad/src/http/mcp.ts
  - squad/src/journal/journal.ts
  - squad/reference/squad.d.ts
  - squad/agent/prompts/squad-author.md
  - src/main/java/com/paul/brawl/squad/
verified_at: 2026-10-29 (working tree on branch rework, uncommitted)
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

## Processes and threads

| What | Where | Notes |
|---|---|---|
| Supervisor | `squad/src/supervisor.ts` | The parent process (`npm start`). It forks the runtime with `--import tsx`, expects an IPC heartbeat every second, kills the runtime after 10 s of silence (`HEARTBEAT_TIMEOUT_MS`, :15) and restarts it with backoff 1/2/5/10/30 s |
| Runtime, main thread | `squad/src/main.ts` `start()` :30 | **Everything else**: every mineflayer bot (protocol decoding, physics ticks, pathfinder A*, plugins), every order's script, the leases, the HTTP + SSE + MCP server, the synchronous SQLite journal |
| Typecheck worker | `squad/src/script/typecheck-worker.mjs`, started by `check.ts` `typecheckWorker()` :156 | TypeScript `checkJs` for `check_script`/`submit_command`. First check about 5 s (it parses the library types), later ones 0.1–0.3 s; warmed 2 s after boot. Unref'd when idle |
| The mod | `com.paul.brawl.squad` in the server JVM | `/bots` commands and the commander snapshot on the server thread; HTTP to the runtime is async; the SSE reader is a virtual thread (`squad-events`); authoring turns are virtual threads running `claude -p` (`ClaudeCodeClient`) |

There is no other parallelism. All bots share one event loop: a heavy pathfind, a script's synchronous loop, or a
big decode delays the physics of every bot. The loop budget and the starvation canary
(`compile.ts` `createLoopBudget` :252, `STARVATION_MS` 3 s) stop a runaway script, and the supervisor's heartbeat is
the backstop. **There is no event-loop lag monitor** (Eden's `lag-monitor.ts` was not copied).

## The runtime (`squad/src/`)

| Area | Files | What it does |
|---|---|---|
| Bots | `bots/pool.ts`, `plugins.ts`, `hardening.ts`, `protocol.ts` | Dynamic pool, logins 4 s apart, reconnect with backoff, version pinned to 1.21.1, `viewDistance: 'short'`. Plugins: pathfinder, pvp, armor-manager, tool, collectblock, hawkEye, auto-eat. Pathfinder bounded (searchRadius 64, thinkTimeout 5 s, `hardening.ts`). Protocol hardening, below |
| Roster | `roster.ts` | Bots, owners, tags in `.squad-data/roster.json`; the runtime is its only writer |
| Leases | `leases.ts` | A lease stack per bot (depth 4). `plan` :84 grants idle bots first, then busy ones for `take: 'reclaim'` roles, all or nothing. `apply` :106 runs the old order's cleanup before reuse. `release` :130 hands a bot back to the live order below |
| Orders | `orders/runner.ts`, `order.ts`, `guard.ts`, `claims.ts` | `start` :121 resolves, compiles (once per version) and runs. Each script gets a **lease-guarded Proxy** of each bot (`guardBot` :81): calls check the lease, listeners and timers are tracked, chat is rate-limited, `quit` is refused. Every leave and every end runs the R4/R5 abort sequence. Claims are shared across orders |
| Dialect | `api/squad.ts`, `api/helpers.ts`, `api/scope.ts`, `reference/squad.d.ts` | `squad.parallel`, `squad.tasks` (work queue, re-queues the work of a leaving bot), claims, acquire/release, `ctx.commander`, `ctx.run`. Voyager-named helpers (`mineBlock`, `craftItem`, `goTo`, `shoot`…) |
| Scripts | `script/compile.ts`, `manifest.ts`, `check.ts` | ESM rewritten in place, keeping lines (`vm.Script` filename `squad:<author>/<name>@vN.mjs`); loop budget + fences; manifest and args (French errors for players); `check_script` = compile + dry module run + typecheck (`BLOCKING_CODES` :40) |
| Authoring | `authoring.ts`, `http/mcp.ts`, `agent/` | `cmd-…` tickets (30 min; manual 2 h). Seven MCP tools (`get_api_reference`, `get_context`, `list_commands`, `read_command`, `check_script`, `trial_run` ≤ 60 s on idle bots, `submit_command`). Claude Code config in `agent/claude-code/`, opencode config in `agent/opencode.json` |
| Storage | `store/commands.ts`, `journal/journal.ts` | `.squad-data/commands/<uuid>/<name>/meta.json` + `vN.mjs` (append-only, shares, revert); SQLite `squad.db` (WAL, `synchronous=NORMAL`), one row per order with its full report |
| HTTP | `http/server.ts` | 18 `POST /api/...` routes, `GET /events` (SSE: `hello`, `notice`, `state`; notices buffered while no mod listens), `POST /mcp/squad`; bearer `PAULSBRAWLS_SQUAD_TOKEN` |
| Stock | `src/stock/*.mjs` | `come`, `follow`, `defend`, `gather`, `deposit`, `attack`, `bring`. Usable by everyone, and the agent's examples |

## Protocol hardening (found live, docs/29 §16)

Mineflayer's 1.21.1 data cannot decode some items. When protodef's `FullPacketParser` gets a non-partial decode
error it fails its stream, and **the bot goes deaf while staying connected**: no inventory, block or entity updates.
On production this came from Universal Shops' Polymer Trade Shop item in the login recipe list (the mod was removed).
Three layers now:
1. `declare_recipes` is read as raw bytes (`RECIPES_AS_BYTES`, passed as `customPackets`, `pool.ts` :267).
2. `keepDecodersAlive` (`protocol.ts`) drops any undecodable packet, reported once a minute per kind.
3. A deaf-bot watchdog (`DEAF_MS` 20 s, `pool.ts` :20) reconnects a bot that has received nothing for 20 s.

## The mod (`src/main/java/com/paul/brawl/squad/`)

| Class | Role |
|---|---|
| `SquadCommand` | `/bots …` (Brigadier), permissions, tab completion from the cache, async calls |
| `Squad` | Lifecycle, the SSE loop and the cache, notices (kept for offline players), whitelist, join gate (a bot name from a non-loopback address is kicked), arrival teleport, `hasPlayed` (spawn refuses names with a `playerdata` file), `equip` |
| `SquadKits` | Kits for archer, guard, miner and farmer (Minecraft-free); `equip` wears armor, holds weapons and puts the shield in the off-hand |
| `SquadAuthoring` | One `squad-author` turn: reserve the slot, open, run the agent, close, announce « Commande X prête » |
| `SquadClient`, `SquadArgs`, `SquadNotice`, `CommanderSnap`, `SquadConfig` | HTTP/1.1 client and SSE framing; argument tokenizing; lines with clicks; exact position and look target; `squad.properties` |

## Tests

- **`squad/`:** `npm run check` = lint + tsc + 61 `node:test` tests on fakes (compile, leases, guard, orders and
  reclaim, check/typecheck of the stock commands, HTTP + the real MCP client, supervisor wedge, protocol hardening,
  helpers, agent config drift).
- **Mod:** 15 JUnit tests in `src/test/java/com/paul/brawl/squad/`.
- **Live:** `npm run live-test`, using RCON against the dev server (`run/`) or production
  (`SERVER_PROPERTIES=../server/server.properties`).

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
- **Capacity: measured in [docs/31](../../31-squad-performance-review.md)** (on Paul's laptop, dev server).
  - **Limits:** about 5 bots moving at once run smoothly; the event loop saturates at 6–8 moving bots (A* is 70–77% of
    it); 30 standing bots take 62% of the loop.
  - **Squad's own code** (the guard proxy, journal, loop budget) is under 0.5% of the busy time.
  - **Found there:** a `gather` with no reachable logs blocks the event loop until every batch has failed (docs/31 §2.6).
    That is longer than the supervisor's 10 s heartbeat.
- **Not built:** Eden's lag monitor; a metrics endpoint.
