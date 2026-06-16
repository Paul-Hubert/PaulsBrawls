# 19 — Live villager test suite (real server + real LLM)

The reusable, parameterized successor to the one-off [`.smoke/`](../eden/.smoke/) run. It boots a **real**
Eden host against the dev server with a **real** LLM and asserts on the journal + the live world. It is the
regression net that drives the next round of *smoke-time* hardening: the M0–M7 smoke fixed the loop
blockers (P1 `write_skill` dialect, P2 blind/example-less context, Z stock-skills-vs-real-mineflayer); this
suite exercises the **crafting / pvp / farming** surfaces that were still unvalidated against real
mineflayer and turns the next gaps into filed findings.

- **Code:** [`eden/live-tests/`](../eden/live-tests/) (tracked). **How to run:** [its README](../eden/live-tests/README.md).
- **Process / playbook:** [docs/20](20-live-test-process.md) — the run→diagnose→fix→re-run loop, how to read a failure, and the worked example.
- **Kickoff prompt:** [docs/18](18-real-villager-tests-prompt.md).
- **Distinct from** [`eden/eval/`](../eden/eval/) (mock-LLM CI scenarios) and the smoke (throwaway): same
  *shape* as eval, but a real provider + real mineflayer, kept out of `npm run check` (server + paid key,
  non-deterministic) exactly as eval's bot run is.

## What's in CI vs not

| Layer | In `npm run check`? |
|---|---|
| Harness TS (typed + lint-clean) | yes — `tsc` includes `live-tests/`, `eslint .` lints it |
| Catalogue structure ([`tests/live-tests-catalogue.test.ts`](../eden/tests/live-tests-catalogue.test.ts)) | yes — names/assignees/idempotent arenas/valid rosters, no Minecraft |
| The live scenario runs (boot + LLM + bots) | **no** — `npm run live-test`, needs a server + `OPENAI_API_KEY` |

## Harness architecture

`runScenario(scenario)` ([harness.ts](../eden/live-tests/harness.ts)) is the pipeline, one fresh host per
scenario (the dev server stays up across scenarios):

1. **read** `run/server.properties` → mc port + RCON creds (R28).
2. **assemble** config = `baseConfig(props, roster)` + the scenario's optional `configure`, written to
   `live-tests/.runs/<name>-<ts>/eden.json` (no secret — key is env-only). `dataDir` = that run dir.
3. **arena** — apply the scenario's RCON commands (peaceful/lit box etc.) **before** boot.
4. **boot** — `start(configPath, { dataDir, spawnBots:true, enableGod:true, installProcessGuards:true })`.
5. **connect** — poll the journal for `system.bot-connected` until every assignee is up (120 s cap).
6. **prepare** — post-connect RCON (tp into the arena, clear inventory, give/equip, summon).
7. **run** — for each task: `host.god.addTask(task)` then `host.coordinator.assignAndRun(task,{trigger:'admin'})`,
   raced against `timeoutMs`. Multiple tasks run **concurrently** (cooperative scenarios).
8. **assert** — the scenario's journal+world checks → `{pass, report}`.
9. **evidence** — `journal-report.txt` + `result.json` written to the run dir; `host.stop()`.

Supporting modules: [rcon.ts](../eden/live-tests/rcon.ts) (typed, multi-packet-safe RCON — the smoke's
`.mjs` read only the first packet and could truncate a long `data get`), [arenas.ts](../eden/live-tests/arenas.ts)
(`litBox` / `combatArena`), [checks.ts](../eden/live-tests/checks.ts) (assertion helpers),
[config.ts](../eden/live-tests/config.ts), [catalogue.ts](../eden/live-tests/catalogue.ts).

## Assertion vocabulary

**World (RCON) — ground truth the journal can't see:**
- `inventoryCount(rcon, bot, item)` — `clear <bot> minecraft:<item> 0`; maxCount 0 COUNTS without removing
  (non-destructive, no NBT parsing) → `Found N matching items`.
- `entitiesRemain(rcon, selector)` — `execute if entity <selector>` → "Test passed" (≥1) / "Test failed"
  (0). The defense scenario passes an **arena-box-scoped** selector so stray underground mobs don't count.

**Journal (`host.journal.query`) — what the loop actually did:**
- objective: the task's `check{item,count}` met in-world **and** `god.verdict{success:true}` + `skill.admit`.
- chain (`chainStatus(host, rolloutId)`): `skill.draft{author.kind:'villager'}` → `skill.run{outcome.ok:true}`
  → `god.ticket` → `god.verdict` → `skill.admit`, all filtered by `refs.rolloutId`.
- resilience: zero `system.error` (the uncaughtException guard survived), zero villager `world.death` in
  non-combat scenarios.
- cooperation: `combatRunners(host)` = distinct villagers whose successful `skill.run` touched a combat
  skill (kill-mob / authored fight skill).

## The three scenarios

### `farm-wheat` (baseline — run first)
- **Roster:** `Firmin` (farmer). **Arena:** peaceful lit box; `farmland` bed + 9 mature `wheat[age=7]`.
- **Task (authoring-demanding):** write + run a skill that breaks the wheat until ≥3 `wheat`; `check{wheat:3}`,
  `maxRetries 5`.
- **Asserts:** `wheat ≥ 3` ∧ a harvesting `skill.run{ok}` ∧ no `system.error`/death. Bonus: `skill.admit`.
- **Surface:** breaking crop blocks (`bot.dig` on a `Vec3`) + drop pickup — ≈ `mine-block`, the lowest
  real-mineflayer risk. **Should reach a clean `admit`** once P1/P2/Z hold; the end-to-end prover.

### `craft-wooden-tools` (run second)
- **Roster:** `Firmin` (crafter). **Arena:** peaceful lit box; 16 `oak_log` + a `crafting_table` at (5,199,0).
- **Task:** write + run a skill that harvests oak → planks → sticks → `wooden_pickaxe` on the table;
  `check{wooden_pickaxe:1}`, `maxRetries 6`.
- **Asserts:** holds a `wooden_pickaxe` ∧ a crafting `skill.run{ok}` ∧ no error. Bonus: `god.verdict{success}`
  + `skill.admit`.
- **Surface:** `bot.recipesFor` / `bot.craft` + crafting-table windows. The stock `craft-item` closes stray
  windows, pauses auto-eat/armor-manager, and waits on packet-level `set_slot`/`window_items` quiescence
  (R1–R3) — **UNVALIDATED on real mineflayer**. v1 hit the "an open window hijacks every `clickWindow`"
  class here. **Most likely to surface the next gap.**

### `cooperative-mob-defense` (run last — the richest)
- **Roster:** `Firmin` + `Alban` (guards). **Arena:** covered, lit 15×15 stone box at y=200; `difficulty
  hard`; `doMobSpawning false`. Covered + lit on purpose — open daylight would burn the summoned zombies
  ("die to the sun, not the villagers"), and `doMobSpawning false` means the only mobs are the summoned 3.
- **Prepare:** both guards → survival, tp in, clear, `give iron_sword`, equip full iron armor (`item
  replace entity … armor.*`); then `summon` 3 persistent zombies, spread.
- **Task:** one **per guard**, run concurrently — write + run a skill that attacks the nearest zombie until
  none remain (may compose stock `kill-mob`); `maxRetries 4`, no objective `check` (combat isn't inventory).
- **Asserts:** all arena zombies dead ∧ neither guard `world.death` ∧ **≥2 villagers** ran a combat
  `skill.run` ∧ no `system.error`.
- **Surface:** `bot.pvp.attack` (the `kill-mob` tick loop), armor-manager auto-equip, multi-villager
  scheduling under the LLM concurrency cap — **UNVALIDATED real pvp**. Expect gaps in pvp targeting / the
  combat tick / armor equip.

### Cooperation dispatch — decision

Three ways to make BOTH villagers act were available: **(a)** one task per villager, **(b)** an orchestrator
directive `to:'all'`, **(c)** a seeded `on:'hurt'` reactivity subscription (M5). The suite still injects
**(a)** for the authoring signal (it deterministically produces "≥2 distinct villagers ran a combat skill"),
but as of finding **G** (2026-06-15) **(c) is now WIRED and active too**: the live host assembles
per-villager reactivity, so each guard's seeded `hurt → defend-self` reflex fires zero-token within a tick
of the first hit — ahead of the (a) deliberation it used to lose the race to. The two compose: the reflex
keeps the guard alive in the first seconds; the deliberation authors + admits the durable combat skill.
(b) remains a natural follow-up.

## Findings log

Format mirrors [`.smoke/DIAGNOSTIC.md`](../eden/.smoke/DIAGNOSTIC.md): each finding = a journal line + a
minimal repro + a proposed one-spot fix, classified by severity, and (when fixed) the commit + the green
`npm run check`. New gaps become the next `R#` in [07-hard-won-lessons.md](07-hard-won-lessons.md) (S8).

| # | Date | Scenario | Severity | Finding | Status |
|---|---|---|---|---|---|
| **W** | 2026-06-14 | farm-wheat (1st live run) | **CRITICAL** | A villager-authored loop that `await`s an immediately-resolved promise starves the macrotask queue and defeats EVERY watchdog → the whole host wedges; bots kicked `Timed out`. | **FIXED** (engine + harness) |
| **C** | 2026-06-14 | craft-wooden-tools | **HIGH** | Stock `craft-item` calls `bot.recipesFor(item)` with the item NAME (needs a numeric id) and never passes the crafting-table block → every craft returns `no recipe for <item>`. Crafting is wholly broken on real mineflayer. | **FIXED** (verified: `craft-item` runs `ok=true`) |
| D1 | 2026-06-14 | cooperative-mob-defense | LOW (tuning) | `difficulty hard` triggers zombie REINFORCEMENTS (`doMobSpawning false` doesn't stop them) — 3 summoned became 11; guards cleared them all but died to the swarm. pvp + cooperation themselves WORK. | **FIXED** (`difficulty easy` → 0 deaths) |
| D2 | 2026-06-14 | craft-wooden-tools | LOW | Firmin died once to `death.fell.accident.generic` — peaceful does NOT prevent fall damage; pathfinder jitter in the box chipped it. | **FIXED** (shorter litBox → 0 deaths) |
| **E** | 2026-06-14 | craft-wooden-tools | MEDIUM | Stock `collect-blocks` (`bot.dig`) breaks the log but does NOT reliably pick up the drop — the bot digs from up to reach distance, so the item lands out of the ~1-block auto-collect range. Journal: `"Les bûches collectées ne sont pas dans l'inventaire"` → `pas de recette pour oak_planks` (no ingredients). Plus the LLM authored skills returning `{status:'…échec…'}` while `ok=true` and didn't converge in 6 retries. | **FIX IN PLACE** — live validation pending (the validation re-run hit OpenAI **HTTP 429 quota-exceeded**: the account's API credits were exhausted by the prior runs). `collect-blocks` now walks onto the trunk base to gather drops; craft arena uses 3-tall oak columns + `maxRetries 8`. |
| **G** | 2026-06-15 | cooperative-mob-defense | **HIGH** | The whole M5 reactivity system (EventRouter / SubscriptionRouter / store / role-defaults) was **built + unit-tested but never assembled in `main.ts`**, so a hit waited ~16 s for the LLM to author combat: Alban **died at +11.7 s** while his first combat `skill.run` was at **+16.9 s**. Time-to-first-defensive-action > survival-time. | **FIXED + VALIDATED PASS** — wired per-villager reactivity (signal adapter → EventRouter → SubscriptionRouter), seeded role-defaults at boot, added the reflex stock skills, and gave guards `hurt → defend-self` (D-15). Re-run: **PASS** (98 s, 0 deaths). See below. |

### Re-run results (2026-06-15, after G fixed — `cooperative-mob-defense`)

| Scenario | Result | Evidence |
|---|---|---|
| cooperative-mob-defense | **PASS** ✓ | All 4 checks green: zombies all dead ✓, **0 deaths** (was a death at +11.7 s) ✓, ≥2 combat runners (Alban, Firmin) ✓, 0 `system.error` ✓. Run dir `cooperative-mob-defense-2026-06-15T14-17-32`. |

**The reflex-before-LLM proof (journal-report timeline).** Both guards fire the zero-token reflex the
instant the first hit lands, and `defend-self` runs to a clean RunReport BEFORE the first `brain.wakeup`:

```
+9.2s  | villager:Alban  | subscription.fired      | {on:hurt, outcome:skill, target:defend-self}
+9.2s  | villager:Firmin | subscription.fired      | {on:hurt, outcome:skill, target:defend-self}
+10.2s | villager:Alban  | subscription.suppressed | {on:hurt, reason:not-while-running}   ← no pile-up
+12.0s | villager:Alban  | skill.run               | {skill:defend-self, ok:true}
+12.0s | villager:Firmin | skill.run               | {skill:defend-self, ok:true}
+13.1s | villager:Alban  | brain.wakeup            | (the FIRST deliberation — AFTER the reflex defended)
```

Net: the reflex collapses time-to-first-defensive-action from +16.9 s (LLM-authored) to +9.2 s
(zero-token), eliminating the death. The LLM-authored combat skills (`attack-zombies`,
`attaquer_zombie_plus_proche`) still run later and finish the clear — reflex + deliberation compose.

### Re-run results (2026-06-14, after W fixed; process-isolated)

| Scenario | Result | Evidence |
|---|---|---|
| farm-wheat | **PASS** ✓ | 10 wheat held; authored `harvestWheat` ran `ok=true`; **`skill.admit` captured** — the FIRST clean end-to-end convergence (the smoke never reached admit); 0 error, 0 death |
| craft-wooden-tools | **FAIL** ✗ | 0 pickaxe; every `craft-item`/authored craft returned `no recipe for …` (gap C); 1 fall death (D2); 0 `system.error` |
| cooperative-mob-defense | **FAIL** ✗ | zombies all dead ✓; **≥2 villagers ran a combat skill** (`attack_nearest_zombie_until_cleared`, `attackZombiesImproved` → `ok=true`) ✓; 0 `system.error` ✓ — failed ONLY on the zero-death criterion (D1 swarm) |

Net: the engine fix W is validated (no wedge, suite completed, 0 `system.error` across all three). The crop-break and **pvp** surfaces work; **crafting** is the next real surface to harden (gap C).

### C — stock `craft-item` is broken on real mineflayer

**Symptom.** Every craft fails: `skill.run craft-item ok=false "no recipe for oak_planks"` (also `stick`, `crafting_table`,
`wooden_pickaxe`). The villager collected oak and looped revisions, but never crafted anything → 0 `wooden_pickaxe`.

**Root cause.** [`stock-skills.ts`](../eden/src/skills/exemplars/index.ts) `craft-item` does
`const recipe = bot.recipesFor(item)[0];` — `item` is the NAME string, but mineflayer's
`bot.recipesFor(itemType, metadata, minResultCount, craftingTable)` wants a **numeric item id** and, for 3×3 recipes,
the **crafting-table block**. `recipesFor('oak_planks')` returns `[]` → "no recipe". This is the crafting-surface analog
of Blocker Z (Vec3/Goal): code validated against FakeBot, wrong real-mineflayer signature.

**Proposed fix (one spot, `craft-item`).**
```js
const id = bot.registry.itemsByName[item]?.id;
if (id === undefined) throw new Error('unknown item ' + item);
const table = bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 4 }); // 3×3 recipes need it
const recipe = bot.recipesFor(id, null, 1, table ?? undefined)[0];
if (!recipe) throw new Error('no recipe for ' + item + (table ? '' : ' (no crafting table in reach)'));
await bot.craft(recipe, count, table ?? undefined);
```
(The villager must also walk to the table first — compose `go-to`. Re-run craft-wooden-tools to confirm.)

### W — macrotask starvation defeats every watchdog (host wedge)

**Symptom.** The first live `farm-wheat` ran the full loop healthily (authored `harvest_wheat`, ran it
`ok=true`, **collected 9 wheat on v1**, critic judged + revised), then on its 5th revision **the whole
process froze for 23 min** — the journal stopped, the 3 supervisors never fired, and the server kicked both
bots: `Firmin lost connection: Timed out`. Only farm-wheat ran; craft + defense never started.

**Repro (the authored v5, verbatim shape).**
```js
async function harvest_wheat(bot, args, ctx) {
  async function moveToWheatArea() { ctx.log('Déplacement…'); }   // no-op async stub — resolves instantly
  while (true) {
    const wheatBlocks = bot.findBlocks(/* mature wheat */);        // [] — v1 already harvested the field
    if (wheatBlocks.length === 0) { await moveToWheatArea(); continue; }   // await of a MICROTASK
    if (bot.inventory.count(/* wheat */) >= 3) break;              // never reached
  }
}
```
The persisted `skill.log` proves the spin: `harvest_wheat → "Déplacement vers un champ de blé potentiel…"`
repeating ~30×/s for 23 minutes.

**Root cause.** Two layers fail together:
1. `instrument.ts` `__aw()` **resets the loop budget on every `await`** ("a real await is a yield, not a
   sync spin"). An `await` of an immediately-resolved promise resets `count` every iteration → the
   1 000 000-iteration budget **never trips**.
2. The await yields only to the **microtask** queue, which never drains, so the **macrotask** queue is
   starved. The engine's three supervisors — `StallDetector`, the 120 s `wallTimer`, the builtins sampler —
   and the harness's per-task `setTimeout` deadline are **all macrotasks → none can fire**. `ctx.log`
   pulses the stall detector too, so even a pulse-based guard would be masked. The host wedges indefinitely;
   `installProcessGuards` (Blocker Z) only catches async *throws*, not this.

This is more serious than P1/P2/Z: any villager can author a skill that **freezes the entire village**.

**Fix (landed, `npm run check` green @ 399).**
- *Engine* ([`skills/engine.ts`](../eden/src/skills/engine.ts) + [`skills/instrument.ts`](../eden/src/skills/instrument.ts)):
  a **macrotask-starvation canary**. A `setInterval` (a macrotask) refreshes `lastTick`; a synchronous guard
  injected into the loop budget (`createLoopBudget(max, checkProgress)`) throws `EngineAbort('stalled')` when
  `now() − lastTick` exceeds `macrotaskStallMs` (8 s default, below the ~30 s keep-alive kick, above any
  legit per-iteration sync burst). Because the canary runs *synchronously inside the loop body* it fires even
  when every timer is starved. Loops that DO yield to macrotasks keep refreshing `lastTick`, so they're never
  false-aborted (pinned by two tests in [`skills-engine.test.ts`](../eden/tests/skills-engine.test.ts) +
  the seam test in [`skills-instrument.test.ts`](../eden/tests/skills-instrument.test.ts)).
- *Harness* ([`live-tests/run.ts`](../eden/live-tests/run.ts) + [run-one.ts](../eden/live-tests/run-one.ts)):
  **process isolation**. Each scenario runs in its own child; the parent enforces a hard wall-clock SIGKILL
  from its own healthy event loop, so a wedge the engine guard can't see (e.g. sync recursion) can never hang
  the suite — the parent records a timeout FAIL and continues.

**What also worked (not a gap).** The crop-break surface is healthy: real `bot.dig`/`Vec3` collected 9 wheat
(`harvest_wheat` v1 `ok=true`), zero `system.error`, zero `world.death`, full `task→draft→run→ticket→verdict
→revise` chain. The strict critic + field depletion (v1 took all 9 → v2–v4 collected 0) kept it short of
`admit` — known tuning (the smoke's RUN 4 finding), not a defect.

### Re-run results (2026-06-14, after C + D1 + D2; process-isolated) — **2/3 PASS**

| Scenario | Result | Evidence |
|---|---|---|
| farm-wheat | **PASS** ✓ | 6 wheat; `harvest_wheat` `ok=true`; `skill.admit` captured; 0 death |
| craft-wooden-tools | **FAIL** ✗ | gap C **fixed** — `craft_wooden_pickaxe` now runs `ok=true` (no more "no recipe"); 0 death (D2 fixed); but 0 pickaxe held → blocked by **gap E** below |
| cooperative-mob-defense | **PASS** ✓ | zombies dead; **both guards survived (0 deaths — D1 fixed)**; both ran combat skills; 0 error |

### E — collection drop-pickup is unreliable (the remaining craft blocker)

**Symptom.** `craft_wooden_pickaxe` runs but returns `{status:"Les bûches collectées ne sont pas dans
l'inventaire"}` / `{status:"Pas de bûches collectées…"}`, and the subsequent `craft-item('oak_planks')`
fails `pas de recette pour oak_planks` — the bot has **no oak_log in inventory** to craft from. (Crafting
itself works now; there's just nothing to craft.)

**Root cause.** Stock `collect-blocks` does `bot.dig(block)` only. `bot.dig` BREAKS the block but leaves the
drop on the ground; mineflayer auto-collects an item only within ~1 block. The bot digs from up to its reach
(~4–5 blocks), so the log item lands out of pickup range and is never collected. (farm-wheat works because
wheat breaks at the bot's feet.) Secondary: the villager authored skills that **return `{status:'…échec…'}`
with `ok=true`** instead of throwing, so the run looks successful, and the loop didn't converge in 6 retries.

**Proposed fix.** After each successful `bot.dig`, walk onto the drop so it's collected — e.g.
`await bot.pathfinder.goto(new ctx.goals.GoalNear(x, y, z, 1)).catch(() => {})` (or compose
`mineflayer-collectblock`'s `bot.collectBlock.collect`). Pair with more oak + a higher `maxRetries`, and
consider an exemplar that shows verifying inventory after collection. Then re-run craft-wooden-tools.

**Predicted-but-unconfirmed** (still pending a clean live run, now that W is fixed):
- `craft-item` on real mineflayer: window-quiescence + `bot.craft` against a real crafting-table window
  (R1–R3) — confirm the inventory diff reflects crafted items.
- `kill-mob` on real mineflayer: `bot.pvp.attack` target selection + `entity.isValid` loop termination.
- armor-manager: confirm `item replace entity … armor.*` gear is actually worn (auto-equip fires on
  `playerCollect`, not on an admin `item replace`).
