# 20 — The live-testing process (run → diagnose → fix → re-run)

How to *operate* the live villager suite as a hardening engine. [docs/19](19-live-test-suite.md) is the
reference (what the suite is, how it's built, the assertion vocabulary, the findings log);
[`eden/live-tests/README.md`](../eden/live-tests/README.md) is the operational quick-start. **This** doc is
the methodology — the repeatable loop, the diagnostic playbook for reading a failure, and the worked
example from the first live session (2026-06-14) that drove five fixes.

The suite is a regression net, not a one-shot. You run it, it surfaces a real-mineflayer / loop gap, you
diagnose from the journal + the live world, you fix the one spot, you re-run. Each turn of that loop is one
finding filed (the smoke filed P1/P2/Z the same way). The point is not "does it pass" — it's "what does the
next failure teach," repeated until green.

## The loop

```
            ┌─────────────────────────────────────────────────────────┐
            ▼                                                         │
  Prepare → Run → Assert ──PASS──▶ done                              (fix the one spot,
   (server   (npm   (RCON world   │                                  keep `npm run check`
    + key)   run)   + journal)    └──FAIL──▶ Diagnose ──▶ Fix ──▶ Re-run  green, file in docs/19)
```

### 1. Prepare
- **Dev server up** on the `run/server.properties` port (R28), RCON enabled. `./gradlew runServer` from the
  repo root. Confirm: `node eden/.smoke/rcon.mjs 127.0.0.1 25575 <pass> list` returns players.
- **`OPENAI_API_KEY` exported AND funded.** The suite's very first LLM call is the orchestrator dispatch — a
  `HTTP 429 "exceeded your current quota"` halts a scenario in ~7 s with `assignAndRun THREW`. A 429-quota
  is persistent (billing), not a transient rate-limit; don't retry, top up. (This is exactly how the craft
  validation run died on 2026-06-14.)
- The harness applies the deterministic RCON arena itself (peaceful/lit box, combat arena) — no manual setup.

### 2. Run
- `npm run live-test [name]` (omit name for all three, in order). **Process-isolated**: each scenario runs
  in a killable child; the parent hard-kills a wedge from its own healthy event loop, so the code-under-test
  can never hang the runner. Run ONE scenario when iterating on a fix (saves API budget).
- Evidence lands under `eden/live-tests/.runs/<scenario>-<timestamp>/` (gitignored).

### 3. Assert
Each scenario's verdict combines two independent sources of truth:
- **World (RCON ground truth)** — `inventoryCount` (`clear <bot> <item> 0` counts without removing),
  `entitiesRemain` (`execute if entity <box-scoped selector>`).
- **Journal (what the loop actually did)** — the `skill.draft → skill.run → god.ticket → god.verdict →
  skill.admit` chain (filtered by `refs.rolloutId`), `world.death`, `system.error`.

A `✓/✗` report prints and is written to `result.json`.

### 4. Diagnose
The failure tells you where the gap is. See the playbook below.

### 5. Fix + re-run
- The fix lives in exactly one of three places: the **engine** (`src/skills/`), a **stock skill**
  (`src/skills/exemplars/`), or the **arena/scenario** (`live-tests/`). Keep `npm run check` green
  (the stock skills are pinned by the real typecheck+sandbox pipeline + FakeBot exemplar runs).
- File the finding in [docs/19](19-live-test-suite.md)'s findings log: journal line + minimal repro +
  one-spot fix + status. A new pitfall becomes the next `R#` in [07-hard-won-lessons.md](07-hard-won-lessons.md) (S8).
- Re-run only the affected scenario.

## The diagnostic playbook

### Evidence map
| File (under the run dir) | What it tells you |
|---|---|
| stdout / the tee'd log | the live timeline: boot, connect, prepare, the 20 s journal-histogram ticks, the `✓/✗` report |
| `.eden-data/eden.db` | the SQLite journal — the durable record; query it (below) |
| `.eden-data/llm/*.json` | full LLM transcripts (`journal.debugPrompts: true`) — what the model actually saw/said |
| `journal-report.txt` | a kind histogram + key-event timeline, written at scenario end |
| `result.json` | the PASS/FAIL verdict + per-check report |
| `.eden-data/library/<skill>/v*.js` | **the villager's authored skill code** — read the latest `vN.js` to see what it actually wrote |

### Reading the journal
A read-only SQLite query is the fastest way in (works while the run is live — WAL allows concurrent reads):
```js
// node --input-type=module -e " … "   (db = '<runDir>/.eden-data/eden.db', readonly:true)
// pull: skill.run outcomes (ok + value/error), god.verdict (success/action/critique),
//       world.death (name + cause), system.error, brain.tool-call ok=false, skill.admit
```
The four questions almost every diagnosis asks:
1. **Did skills run, and did they succeed?** `skill.run` rows: `outcome.ok` + the value or error string.
2. **What did the critic say?** `god.verdict`: `success` / `libraryAction` / `critique` (why it kept-draft).
3. **Did anything die or crash?** `world.death` (decode the cause — below), `system.error` (should be empty).
4. **What did the villager actually write?** the latest `library/<skill>/vN.js`.

### RCON ground truth
- **Inventory (no NBT parsing):** `clear <bot> minecraft:<item> 0` → `Found N matching items` (maxCount 0
  counts without removing). NOTE: only works while the bot is ONLINE — a kicked bot reads as 0.
- **Mobs:** `execute if entity @e[type=minecraft:zombie,<box volume>]` → "Test passed" (≥1) / "Test failed"
  (0). Always scope to the arena box so stray underground mobs don't count.
- **Death cause:** the `world.death.cause` is the raw R27 death-message NBT. Regex it for the signal:
  `death\.[a-z._]+` (e.g. `death.fell.accident.generic`, `death.attack.mob`) and `entity\.minecraft\.\w+`
  (the killer). The bare `cause` string buries this in a nested compound.

### Symptom → root-cause patterns (the gold)
| Symptom | Almost always means |
|---|---|
| Simultaneous bot disconnects (`lost connection: Timed out`) **+ the journal/log freezes** | the **Node event loop is blocked** (a sync spin or microtask-starving loop), NOT a network bug. The bots can't answer keep-alives. → finding **W**. |
| `skill.run ok=false "bot.X is not a function"` / `"… is not a function"` | a **real-mineflayer API mismatch** the fakes didn't model (Vec3/Goal = Z; `recipesFor(name)` = C; `bot.entities.filter` — it's an object). |
| `no recipe for <item>` on *every* craft | `bot.recipesFor` was given the item NAME (needs a numeric id) ± no crafting-table block. → **C**. |
| `skill.run ok=true` but the objective is unmet, value is `{status:'…échec…'}` | the authored skill **swallowed failure** (returned a status object instead of throwing). Read the `vN.js` + the critic verdict; it's a loop/authoring issue, not an engine bug. |
| A villager `world.death` in a *peaceful* arena | peaceful stops MOBS + hunger only — this is fall / suffocation / void / lava. Decode the `translate` key. → **D2** (fall). |
| 3 summoned mobs become 11 | **hard-difficulty reinforcements** (`doMobSpawning false` does NOT stop them). → **D1**. Use `difficulty easy`. |
| Scenario fails in ~7 s, `assignAndRun THREW … HTTP 429` | OpenAI **quota exhausted** — top up credits; not a code issue. |

## Worked example — the first live session (2026-06-14)

Five findings in four runs, each diagnosed from the journal, fixed in one spot, re-run. Detail per finding
is in [docs/19](19-live-test-suite.md); this is the process narrative.

| Run | Trigger | What the journal showed | Diagnosis | Fix |
|---|---|---|---|---|
| **A** (full) | farm-wheat froze 23 min; bots kicked `Timed out` | log frozen mid-rollout; `skill.log` "Déplacement…" ~30×/s; no `system.error` | symptom pattern → event-loop wedge. Read `vN.js`: `while(true){ await noop() }` resets the loop budget every iteration (`__aw`) and starves macrotasks → all timer watchdogs defeated. | **W** — engine macrotask-starvation canary (synchronous guard in the loop budget) + harness process isolation |
| **B** (full) | after W | farm `harvest_wheat ok=true` → `skill.admit` ✓; craft `craft-item ok=false "no recipe for oak_planks"`; defense 3 `death.attack.mob`, 3→11 zombies | farm CONVERGED (W fixed). craft: `recipesFor(name)` signature bug. defense: hard-difficulty reinforcement swarm. | **C** (craft-item: numeric id + table), **D1** (`difficulty easy`), **D2** (shorter box) |
| **C** (full) | after C/D1/D2 | farm PASS; defense PASS (0 deaths); craft `craft_wooden_pickaxe ok=true` but 0 pickaxe, value `{status:"…pas dans l'inventaire"}` | C/D1/D2 confirmed. craft: logs dug but not picked up → no ingredients. | **E** — `collect-blocks` walks onto the trunk base to gather drops; arena oak as 3-tall columns + `maxRetries 8` |
| **D** (craft only) | after E | `assignAndRun THREW … HTTP 429 quota` in 7 s | OpenAI credits exhausted by the prior runs — external, not the fix. | (none — top up to validate E) |

Outcome: **farm-wheat and cooperative-mob-defense green** end-to-end against a real server + real LLM
(farm reaching `skill.admit` — the first clean convergence the project has captured); W/C/D1/D2 fixed and
verified; E fixed and CI-green, pending a funded re-run. `npm run check` stayed green (399 tests) throughout.

## Continuing the loop
- **Validate E (craft):** once the OpenAI account has credits, `npm run live-test craft-wooden-tools`. Watch
  for `collect-blocks` putting logs in inventory, then `craft-item` producing `wooden_pickaxe`.
- **Add a scenario:** new file in `live-tests/scenarios/`, export it, add to
  [`catalogue.ts`](../eden/live-tests/catalogue.ts). The CI test
  [`live-tests-catalogue.test.ts`](../eden/tests/live-tests-catalogue.test.ts) pins its structure (unique
  name, rostered assignees, idempotent arena, valid config) with no Minecraft.
- **The invariants** the runs paid for (process isolation, `installProcessGuards`, tp-after-connect,
  clear-before-run, abundance ≥ `maxRetries` × required, authoring-demanding French phrasing, peaceful vs
  hostile) are listed in the [README](../eden/live-tests/README.md#invariants-baked-in-the-smoke-paid-for-these).
