# Eden live-scenario test suite

A **live** regression net for villager cognition: a real Minecraft dev server + a real LLM + real
mineflayer. These are distinct from the mock-LLM CI suite in [`eden/eval/`](../eval/) — they exercise the
*actual* cognition and the *real* mineflayer surfaces (crafting windows, pvp, block-breaking) the way the
[`.smoke/`](../.smoke/) run did, but as a reusable, parameterized harness. They are the net that drives the
next round of "smoke-time" hardening (the loop's M0–M7 smoke fixed P1/P2/Z; crafting / pvp / farming
surfaces are validated here).

> **Not part of CI.** `npm run check` never runs these — they need a server + a paid key and are
> non-deterministic. Only the harness *logic* is CI-checked: it's typed + lint-clean, and
> [`tests/live-tests-catalogue.test.ts`](../tests/live-tests-catalogue.test.ts) validates the catalogue
> structure (names, assignees, idempotent arenas, valid rosters) with no Minecraft.

## Prerequisites

1. **A running dev server.** The harness reads `run/server.properties` (R28 — never hardcode): it uses
   `server-port` for the bot connection and `rcon.port` / `rcon.password` for the arena (RCON must be
   enabled). Start it however you normally do (e.g. `./gradlew runServer` from the repo root).
   - The non-combat scenarios do **not** need the Java settlement listener (:8767). Only the trade
     scenarios in `eden/eval/` do — if you ever add one here, free :8767 first (R29).
2. **`OPENAI_API_KEY` in the environment.** The LLM client sends `Authorization: Bearer` only to the
   non-local OpenAI `baseUrl`. The key is **never** written into a config file or the journal — export it:
   `export OPENAI_API_KEY=sk-…` (PowerShell: `$env:OPENAI_API_KEY = 'sk-…'`). Models used: strong
   `gpt-4o`, fast `gpt-4o-mini`.

## Running

```bash
cd eden
npm run live-test                       # all scenarios, in the suggested order
npm run live-test farm-wheat            # just one
npm run live-test craft-wooden-tools
npm run live-test cooperative-mob-defense
npm run live-test -- --help             # list scenario names
```

The process exit code is the number of **failed** scenarios (0 = all passed), so it doubles as a CI/cron
gate once you have a server you can point it at. Suggested order (lowest real-mineflayer risk first):
`farm-wheat` → `craft-wooden-tools` → `cooperative-mob-defense`.

## Where the evidence lands

Each run gets its own gitignored dir under `eden/live-tests/.runs/<scenario>-<timestamp>/`:

| File | What |
|---|---|
| `eden.json` | the exact config booted (no secrets — key is env-only) |
| `.eden-data/eden.db` | the SQLite journal — the durable record; read it with `node ../.smoke/analyze.mjs` (point it at this db) |
| `.eden-data/llm/*.json` | full LLM transcripts (`journal.debugPrompts: true`) |
| `journal-report.txt` | a kind histogram + key-event timeline (draft→run→ticket→verdict→admit, deaths, errors) |
| `result.json` | the PASS/FAIL verdict + the per-check report |

The PASS/FAIL report also prints to stdout. To tee the full host + driver output to a file, redirect:
`npm run live-test farm-wheat > .runs/farm.log 2>&1`.

## Invariants baked in (the smoke paid for these)

- **`installProcessGuards: true`** on every boot — a rogue skill's *async* pathfinder throw (physics tick)
  escapes per-run try/catch and would otherwise crash the host; the guard journals `system.error` and
  survives.
- **tp the bot AFTER it connects** — `setworldspawn` does *not* relocate a bot with saved playerdata, so
  every arena builds a box at a known `y` and `prepare` tp's the assignee in.
- **`clear` the inventory before the run** — `keepInventory` persists items across reconnect, and a
  pre-satisfied objective `check` force-vetoes admission (D-12). The bot must EARN the items.
- **Resource abundance ≥ `maxRetries` × required** — each rollout *revision* consumes resources; arenas
  stock enough oak/wheat that later revisions can re-succeed.
- **Authoring vs composition** — with stock skills seeded, a trivial task gets *composed* (`run_skill`),
  not *authored*, so `draft→verdict→admit` won't fire. Each scenario's task is phrased in French to
  *demand a new skill* (`write_skill`) so the authoring chain is exercised; the objective `check` is the
  hard pass signal regardless.
- **Peaceful vs hostile** — non-combat arenas set `difficulty peaceful` + `doMobSpawning false`; the
  defense arena is `difficulty hard`, covered + lit (so summoned zombies don't burn in daylight) with the
  mobs `/summon`ed deterministically.

## What each scenario exercises (and the gap to watch)

| Scenario | Real-mineflayer surface | Watch for |
|---|---|---|
| `farm-wheat` | breaking crop blocks (`bot.dig` on a `Vec3`) + drop pickup | lowest risk — the end-to-end prover; a clean `skill.admit` should be reachable. A failure points at crop-block handling or drop-pickup. |
| `craft-wooden-tools` | `bot.recipesFor` / `bot.craft` + crafting-table windows (the stock `craft-item`'s window-quiescence dance, R1–R3) | UNVALIDATED on real mineflayer; v1 hit the "open window hijacks every clickWindow" class here. Likely the next gap. |
| `cooperative-mob-defense` | `bot.pvp.attack` (the `kill-mob` tick loop), armor-manager auto-equip, multi-villager scheduling | UNVALIDATED real pvp targeting/range/swing; expect gaps in pvp or the combat tick. Cooperation is dispatched as **one task per guard, run concurrently** (see the file header for why over `to:'all'` / `on:'hurt'`). |

When a scenario surfaces a NEW gap, capture it the way [`.smoke/DIAGNOSTIC.md`](../.smoke/DIAGNOSTIC.md)
captured P1/P2/Z: a journal line + a minimal repro + a proposed one-spot fix. See
[`docs/19-live-test-suite.md`](../../docs/19-live-test-suite.md) for the surface map and the running
findings log, and [`docs/20-live-test-process.md`](../../docs/20-live-test-process.md) for the
run→diagnose→fix→re-run **process + the diagnostic playbook** (reading the journal, RCON ground truth, and
the symptom→cause patterns).

## Layout

```
live-tests/
  run.ts          CLI entrypoint (npm run live-test [name])
  catalogue.ts    the scenario list (CI-validated)
  harness.ts      runScenario(): arena → boot → connect → prepare → tasks → assert → evidence
  config.ts       base config (from run/server.properties) + temp-file writer
  rcon.ts         typed async RCON client (multi-packet safe)
  arenas.ts       litBox() / combatArena() RCON fixtures
  checks.ts       assertion helpers (inventory count, mob presence, journal chain, deaths, errors)
  scenarios/      farm-wheat · craft-wooden-tools · cooperative-mob-defense
```
