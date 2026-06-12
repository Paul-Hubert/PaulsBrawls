# PROMPT — Build the automated villager eval harness

> Copy everything below this line into a fresh Claude Code session in
> `C:\Users\Paul\Desktop\pauls-brawls`, or run it via a spawned task. It is
> self-contained.

---

Build an **automated evaluation harness** for the AI village in this repo: it
must spin up scripted scenarios against a real Minecraft server and grade the
ten villager bots on **reactions** (combat reflexes, guard alerts, night
shelter), **survival** (staying alive, auto-eating), and **trading** (bartering
goods for food and `coin`s, settled atomically), then emit a pass/fail report
suitable for repeated unattended runs.

## Context — what already exists (read these first)

- [VILLAGE_PLAN.md](VILLAGE_PLAN.md) — design + status. The village is fully
  implemented: ten Mineflayer bots run in ONE Node process
  (`npm run village` inside [minecraft-mcp-server/](minecraft-mcp-server/)),
  each with a three-layer brain: **reflexes** (bot-authored JS handlers, no
  LLM), **routines** (job scripts), **deliberation** (LLM via an
  OpenAI-compatible client). Key modules, all under
  `minecraft-mcp-server/src/village/`: `bot-host.ts` (bodies + event wiring),
  `scheduler.ts` (global LLM budget), `agent-runtime.ts` + `llm-client.ts`
  (the brain), `conversation.ts` (turn-based bot↔bot talk), `trade.ts`
  (typed offers), `stock-skills.ts` (seeded reflexes/routines, incl.
  `self-defense` and `guard-respond`), `admin-server.ts` (HTTP admin),
  `villager-api.ts` (the `API_DTS` contract).
- Admin API (default `http://127.0.0.1:8766`): `GET /village/status`
  (per-bot connection state, jobs, scheduler stats incl. `completed` LLM-call
  counter), `GET /village/bot/<name>` (live observation: position, health,
  food, inventory, nearby entities + skills + memories), `GET /village/ledger`
  (every settled trade), `POST /village/pause|resume`.
- Trade settlement: the Fabric mod hosts `POST 127.0.0.1:8767/trade/execute`
  ([VillageHttpListener.java](src/main/java/com/paul/brawl/VillageHttpListener.java));
  `coin` resolves to `paulsbrawls:coin` (the Gibber currency).
- Roster format: [minecraft-mcp-server/village.example.json](minecraft-mcp-server/village.example.json).
  Per-bot state persists as JSON under the roster's `dataDir`
  (default `.village-data/` — delete it for a clean-slate run).
- Existing verification: `npm test` (ava; includes `tests/village-*.test.ts`
  unit suites), `npx tsc --noEmit`, `npm run lint` — keep all three green.
- Platform: Windows 11, PowerShell. Minecraft/protocol pinned to **1.21.1**
  everywhere (server, mod, mineflayer).

## Hard design decisions (do not relitigate)

1. **Two LLM modes.** `--llm mock` (default) runs a tiny local HTTP server
   speaking `/v1/chat/completions` with **scripted, deterministic responses**
   per scenario — this tests the plumbing (scheduler, reflexes, conversations,
   settlement) repeatably and free. `--llm real` uses the roster's configured
   provider for occasional end-to-end quality runs; real-mode assertions must
   be outcome-based and tolerant (did A trade happen?), never word-based.
   Reflex scenarios must pass with the mock LLM returning **only errors** —
   that is the degradation guarantee.
2. **World control via RCON, not an op'd bot.** Enable RCON in the test
   server; use the `rcon-client` npm package for all setup/trigger/teardown:
   `summon`, `give`, `clear`, `setblock`, `fill`, `time set`, `tp`, `kill`,
   `effect`, `data get entity <name> Inventory` (authoritative inventory
   asserts). No new Java code should be needed; if you add test hooks to the
   Node admin API (e.g. `POST /village/test/think {bot, reason}` to trigger a
   deliberation deterministically), gate them behind a `--test-hooks` flag
   that the normal `npm run village` never enables.
3. **Deterministic world fixture, built by commands.** No world zips. A
   `world-setup` step runs an idempotent RCON command list that builds the
   test village at fixed coordinates on a superflat world: farm plot with
   crops at max age (`setblock ... minecraft:wheat[age=7]`), chests, beds,
   crafting table, torches. The eval roster `eval/village.test.json` uses
   those exact coordinates. Re-running setup must be safe (fill/clear first).
4. **Assertions poll, with generous timeouts.** Pathfinding is slow and ticks
   are 50 ms; poll the admin API / RCON every 1–2 s with per-scenario
   timeouts (20–120 s) rather than sleeping fixed amounts. One retry per
   scenario before marking it failed.
5. **Layout:** everything under `minecraft-mcp-server/eval/` —
   `orchestrator.ts` (CLI: `--suite`, `--llm`, `--server-dir`, `--keep-up`),
   `mock-llm.ts`, `rcon.ts`, `world-setup.ts`, `scenarios/*.ts` (one file per
   scenario, shared `Scenario` interface: `setup/trigger/assert/teardown`),
   `village.test.json`, `README.md` (incl. one-time test-server setup:
   Fabric 1.21.1 + the mod jar + `online-mode=false` + `enable-rcon=true`).
   Add npm script `"eval": "tsx eval/orchestrator.ts"`. The orchestrator
   boots the village process itself (child process, fresh `dataDir` per run)
   and tears it down; `--keep-up` leaves everything running for debugging.

## Scenario suite (minimum)

| id | name | trigger | pass criteria |
|---|---|---|---|
| S1 | reflex-survive | `summon zombie` 3 blocks from a farmer | within 30 s: farmer alive AND (≥8 blocks from spawn point OR zombie dead); scheduler `completed` grew by ≤1 (reflex, not brain) |
| S2 | guard-alert-chain | 2 zombies at the farmer, guard ~30 blocks away | within 90 s: zombies dead, farmer alive; guard came within 6 blocks of the farmer (the tell→respond chain fired) |
| S3 | night-shelter | `time set 13000` | within 90 s: every non-guard villager within 4 blocks of its roster `home` |
| S4 | auto-eat | give farmer 8 bread, `effect give ... minecraft:hunger 30 4` | food drops, then recovers to ≥15 within 120 s without any LLM call |
| S5 | barter-goods (mock) | seed: farmer 32 carrots, crafter 8 oak_planks; test-hook think both; mock LLM scripts `start_conversation` → `propose_trade` → `accept_trade` | within 120 s: `/village/ledger` has the trade; RCON `data get` shows both inventories actually swapped |
| S6 | buy-food-with-coins (mock) | seed: fisher 10 `coin` + hunger effect, shopkeeper 16 bread; scripted negotiation | ledger entry coins↔bread; fisher's food recovers afterwards |
| S7 | skill-self-healing (mock) | pre-seed a deliberately broken reflex into the fisher's `.village-data` state file; hurt the fisher 3× (zombie or `/damage`) | skill becomes `disabled` (admin API); mock LLM receives the fix request and answers with `write_skill`; skill returns `active` at v2 |
| S8 | llm-down-degradation | mock LLM returns HTTP 500 for everything; rerun S1's trigger | reflex outcome still holds; village process stays up; no scenario crash |

Each scenario must clean up after itself (kill leftover mobs, `clear`
inventories, `time set 1000`) so the suite is order-independent.

## Report

`eval/report.json` + a console summary table: per scenario pass/fail, elapsed
time, LLM calls consumed (delta of scheduler `completed`), and failure detail
(last polled state). Non-zero exit code if any scenario fails, so this can run
unattended (Task Scheduler / CI later).

## Constraints

- Do NOT touch the God stack (`src/unified/`, `src/bridge/`, MCP tool
  modules, Java `ChatBot*`/`God*`/`MCP*` classes). Java changes should be
  unnecessary; if something truly needs one, stop and say why first.
- Eval bot usernames must not collide with `LLMBot` or Paul's player name.
  Ports: 8765 unified (unused here), 8766 village admin, 8767 settlement,
  25575 RCON (test server).
- Keep `npx tsc --noEmit`, `npm run lint`, `npm test` green; add unit tests
  for the mock LLM scripting and the scenario assertion helpers where they're
  pure logic.

## Definition of done

1. `npm run eval -- --suite reflex --llm mock` runs S1–S4 + S8 against a
   local test server and passes.
2. `npm run eval -- --suite trade --llm mock` runs S5–S7 and passes.
3. `npm run eval` runs everything; report written; exit code reflects result.
4. `eval/README.md` documents the one-time server setup, both LLM modes, and
   how to add a scenario.
5. Demonstrate the full mock-mode run in your session (paste the summary
   table) — if no test server exists yet, set one up per your own README
   first and include that in the session log.
