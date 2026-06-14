# 18 — Real villager test suite — agent kickoff prompt

> Hand this whole file to an agent. It builds a **live** scenario-test harness for Eden
> villagers (real Minecraft server + real LLM) and the first three scenarios: **crafting
> wood tools**, **cooperative defense against mobs**, **farming wheat**. These are distinct
> from the mock-LLM `eden/eval/` CI suite — they exercise the *actual* villager cognition and
> *real* mineflayer surfaces. They are the regression net that drives the next round of
> "smoke-time" hardening (the loop's M0–M7 smoke already fixed P1/P2/Z; crafting / pvp /
> farming surfaces are still unvalidated against real mineflayer — these tests will surface
> the next gaps the way the smoke surfaced the last ones).

---

## Your task

1. Build a **reusable live-scenario harness** under a TRACKED path in `eden/` (suggest
   `eden/live-tests/`) — a parameterized runner that: applies a deterministic RCON arena,
   boots the real Eden host against the dev server, injects a task, runs the loop, and
   **asserts on the journal**. Add an `npm run live-test [scenario]` script.
2. Implement the **first three scenarios** (specified below).
3. For each scenario, **document the real-mineflayer surface it exercises** and file any NEW
   gap it surfaces as a follow-up (the smoke filed P1/P2/Z this way — see
   `eden/.smoke/DIAGNOSTIC.md`).

**Hard rule:** `cd eden ; npm run check` MUST stay GREEN (currently 389 tests). The harness TS
must be typed + lint-clean, but the live scenarios are **NOT** part of `npm run check` — they
need a running server and a paid API key, and they are non-deterministic. Keep them in a
separate script/dir excluded from the CI test glob (mirror how `eden/eval/` is separate).
Work ONLY under `eden/` and `docs/`. Never touch `minecraft-mcp-server/` or the repo-root `src/`.

---

## What to build on (read these first — don't reinvent)

The proven pattern is the **smoke harness** in `eden/.smoke/` (gitignored throwaway, but the
operative reference — read it):
- `smoke-run.ts` — boots the host via `start(config, { spawnBots:true, enableGod:true, installProcessGuards:true })`, waits for a bot to connect (polls `journal.query({kinds:['system.bot-connected']})`), tp's + clears the bot via RCON, then `host.god.addTask(task)` + `host.coordinator.assignAndRun(task, {trigger:'admin'})`, then reads the journal and stops.
- `build-sandbox.mjs` — an RCON arena fixture (peaceful, lit box, oak, `setworldspawn`).
- `rcon.mjs` — a minimal Minecraft RCON client (`node rcon.mjs <host> <port> <pass> <cmd...>`).
- `analyze.mjs` — a journal post-mortem (kind histogram, timeline, skill-run outcomes, verdicts).

Other anchors:
- `eden/eval/` — the mock-LLM CI scenario harness; copy its scenario/assertion *shape*, not its mock.
- `eden/src/main.ts` — `start()` → `EdenHost { adminPort, config, journal, god, coordinator, stop }`; `installProcessGuards`; `RolloutCoordinator.assignAndRun`.
- `eden/src/journal/kinds.ts` — the journal vocabulary you assert on.
- `eden/src/types/task.ts` — `Task { id, goal, assignee, successCriteria, check?:{item,count}, context, maxRetries }`.
- `run/server.properties` — RCON creds (read, don't hardcode: `rcon.port`, `rcon.password`) and `server-port` (R28).

---

## Invariants the smoke paid for — BAKE THESE IN

- **Auth:** a real provider needs `process.env.OPENAI_API_KEY` (the LLM client sends `Authorization: Bearer` only to non-local `baseUrl`s). NEVER put the key in `eden.json` or the journal. Models that worked: strong `gpt-4o`, fast `gpt-4o-mini`.
- **`installProcessGuards: true`** on every live boot — a rogue skill's *async* pathfinder throw (physics tick) escapes per-run try/catch and would otherwise crash the host.
- **`setworldspawn` does NOT relocate a bot with saved playerdata** → **tp the bot AFTER it connects** (RCON `/tp <name> <x> <y> <z>`). Don't rely on worldspawn.
- **Clear the bot's inventory before the run** (`/clear <name>`): `keepInventory` persists items across reconnect, and a **pre-satisfied objective `check` force-vetoes admission (D-12)** — the bot must EARN the items. (In the smoke, `clear` removed 3 carried-over oak that would have vetoed the next admit.)
- **Resource abundance:** each rollout *revision* consumes resources; provide **≥ `maxRetries` × required** (e.g. oak for 5+ harvests), or later revisions fail on depletion and never reach `admit`.
- **Authoring vs composition:** with stock skills seeded, a trivial task gets **composed** (`run_skill`), not **authored** (`write_skill`) — so `draft→verdict→admit` won't fire and the rollout won't close. If a scenario must exercise the *authoring* chain, phrase the task to demand a NEW skill (French: *"Écris (write_skill) une NOUVELLE compétence … puis exécute-la"*). If it only cares about task success, assert the objective `check` + `skill.run`, not `admit`.
- **Peaceful vs hostile:** `difficulty peaceful` + `gamerule doMobSpawning false` for non-combat scenarios (run-1 of the smoke died to zombies); for the defense scenario, deliberately enable hostiles / `/summon` them and arm the bots.
- **The dev world spawn is underground (y≈-60, dark)** — never assume a surface. Build the arena at a known y and tp into it.
- **The villagers speak FRENCH** (personas) — task `goal`/`successCriteria`/`context` land best in French.
- **Clean shutdown:** `await host.stop()` then RCON `stop`; tee MC + host stdout to timestamped files; `journal.debugPrompts:true` dumps transcripts to `.eden-data/llm/<id>.json`.

---

## Harness shape (proposed — adapt as needed)

```ts
interface Scenario {
  name: string;
  /** roster + providers, as a scenario eden.json path OR an EdenConfig override merged onto a base. */
  config: string | Partial<EdenConfig>;
  /** RCON commands building the deterministic arena (run BEFORE Eden boots). */
  arena: string[];
  /** RCON commands run AFTER the assignee(s) connect — tp / clear / give / summon. */
  prepare?: (connectedBots: string[]) => string[];
  /** Injected via host.god.addTask + host.coordinator.assignAndRun (one or more). */
  tasks: Task[];
  /** Journal-based pass/fail. Receives the live host so it can also RCON the world (e.g. inventory). */
  assert: (host: EdenHost, rcon: (cmd: string) => Promise<string>) => Promise<{ pass: boolean; report: string }>;
  timeoutMs: number;
}
```

Runner: assume a running dev server (read RCON from `run/server.properties`) → apply `arena`
→ `start(config, {spawnBots:true, enableGod:true, installProcessGuards:true})` → for each task:
wait for assignee `system.bot-connected` → run `prepare` (tp/clear/give) → `host.god.addTask` +
`host.coordinator.assignAndRun` → collect journal → run `assert` → print `PASS/FAIL` + evidence →
`host.stop()`. Preserve each run's `.eden-data` + teed logs. (You may keep the dev server up across
scenarios — only Eden restarts.)

### Assertion vocabulary (journal queries via `host.journal.query`)
- **objective success:** the task's `check{item,count}` is met — verify via RCON
  `data get entity <bot> Inventory` AND `god.verdict{success:true}` + `skill.admit`.
- **chain reached:** `skill.draft{author.kind:'villager'}` → `skill.run{outcome.ok:true}` →
  `god.ticket` → `god.verdict` → `skill.admit`.
- **resilience:** zero `system.error` (uncaughtException survived); zero villager `world.death`
  in non-combat scenarios; the driver process exits 0 (no crash).
- **cooperation:** ≥2 distinct villagers produced `skill.run`/`brain.done` for the task (and,
  optionally, `conversation.*`).

---

## Scenario 1 — `craft_wooden_tools` (stresses bot.craft + crafting-table windows)

- **Roster:** one villager `Firmin`, role `crafter`.
- **Arena (peaceful, lit box at 0,198..204,0):** `difficulty peaceful`, `time set day`,
  `gamerule doDaylightCycle false`, `gamerule doMobSpawning false`, `gamerule keepInventory true`;
  hollow stone box + glass ceiling + glowstone; **abundant oak** `fill 1 199 1 4 199 4 minecraft:oak_log`
  (16 logs — ≥ maxRetries harvests); a **crafting table** `setblock 5 199 0 minecraft:crafting_table`
  (a wooden_pickaxe is a 3×3 recipe — it NEEDS a table in reach); `setworldspawn 0 199 0`.
- **prepare:** `tp Firmin 0 199 0` ; `clear Firmin`.
- **Task** (authoring-demanding): goal *"Fabrique une pioche en bois (wooden_pickaxe): récolte du chêne, fabrique des planches puis des bâtons, et assemble la pioche sur l'établi."* · successCriteria *"Firmin possède une wooden_pickaxe, obtenue par une compétence qu'il a écrite."* · `check:{item:'wooden_pickaxe', count:1}` · `context:"Du chêne et un établi sont à portée. Écris ta propre compétence (write_skill) qui enchaîne récolte → planches → bâtons → pioche."` · `maxRetries:6`.
- **Assert:** PASS iff the bot ends holding a `wooden_pickaxe` (RCON inventory) AND a `skill.run` for the crafting step exists AND no `system.error`. Bonus (stronger): a `god.verdict{success:true}` + `skill.admit`.
- **Watch for:** the stock `craft-item` uses `bot.recipesFor`/`bot.craft`/`bot._client` window quiescence — UNVALIDATED on real mineflayer. v1 hit the "open window hijacks every clickWindow" class of bug here (R1–R3). This scenario will likely surface the **next real-mineflayer gap** — capture it as the smoke captured P1/P2/Z.

## Scenario 2 — `cooperative_mob_defense` (stresses bot.pvp + reactivity + multi-villager)

- **Roster:** two villagers `Firmin` and `Alban`, role `guard`.
- **Arena (hostile, walled flat at y=200):** build a 15×15 walled stone platform (open or high-walled top) so mobs can't escape; `difficulty hard`; `gamerule doMobSpawning false` (control spawns yourself); `gamerule keepInventory true`; light it. `setworldspawn 0 201 0`.
- **prepare:** `tp Firmin -2 201 0` ; `tp Alban 2 201 0` ; `clear` both ; arm them — `give Firmin iron_sword` (+`Alban`), and equip armor via `item replace entity Firmin armor.chest with iron_chestplate` (and helmet/legs/boots) ; then summon hostiles: `summon zombie 0 201 6` ×3 (spread them).
- **Task(s) (cooperative — design the dispatch):** the goal is *"Défendez l'arène: éliminez tous les zombies, restez en vie et en équipe."* Decide how to make BOTH villagers act — options: inject one task per villager, OR an orchestrator directive `to:'all'`, OR seed a reactivity subscription (`on:'hurt'` / a proximity event → a combat skill/deliberation, M5). Document your choice. `check` is omitted (combat isn't inventory); success is journal+world based.
- **Assert:** PASS iff all zombies are dead (RCON `execute if entity @e[type=zombie] run …` → none remain) AND neither villager has a `world.death` AND **≥2 villagers** produced a combat `skill.run` (kill-mob/attack-entity) AND no host crash.
- **Watch for:** the stock `kill-mob` uses `bot.pvp.attack` — UNVALIDATED real pvp. Also exercises the reactivity layer (M5 subscriptions) and multi-villager scheduling. Expect new gaps in pvp targeting / the combat tick / armor equip.

## Scenario 3 — `farm_wheat` (baseline: crop block-breaking + drop pickup)

- **Roster:** one villager `Firmin`, role `farmer`.
- **Arena (peaceful, lit box):** as scenario 1 (peaceful/day/no-mobs/keepInventory, lit). Lay a small farm: `fill 1 198 1 3 198 3 minecraft:farmland` then **mature wheat** on top `fill 1 199 1 3 199 3 minecraft:wheat[age=7]` (9 ready crops — ≥ maxRetries harvests). `setworldspawn 0 199 0`. (Stretch goal — full cycle: instead give `wheat_seeds` + farmland + a water block, task plant→`bonemeal`→harvest, to exercise placing/using items.)
- **prepare:** `tp Firmin 0 199 0` ; `clear Firmin`.
- **Task** (authoring-demanding to exercise the full chain, OR composition if you only want task success): goal *"Récolte du blé: casse le blé mûr à proximité jusqu'à avoir 3 wheat en inventaire."* · successCriteria *"Firmin possède au moins 3 wheat."* · `check:{item:'wheat', count:3}` · `maxRetries:5`.
- **Assert:** PASS iff `check{wheat:3}` met (RCON inventory) AND a harvesting `skill.run{ok}` exists AND no `system.error`. Bonus: `skill.admit`.
- **Watch for:** lower real-mineflayer risk (breaking crop blocks ≈ `mine-block`) — a good baseline that should pass once P1/P2/Z hold. If it doesn't, the gap is in drop-pickup or crop block handling.

---

## Deliverables

1. The harness (`eden/live-tests/`, tracked) + the three scenarios, runnable as `npm run live-test [name]`.
2. A short `README` for the suite: prereqs (dev server on the `run/server.properties` port, `OPENAI_API_KEY` in env, stop `./gradlew runServer` is NOT needed — but :8767 trade tests would need it freed, R29), how to run one or all, where evidence lands.
3. For each scenario: a PASS/FAIL report + a note on the real-mineflayer surface exercised and any NEW gap found (propose it as the next fix, with evidence — a journal line + a minimal repro — like `DIAGNOSTIC.md` did for P1/P2/Z).
4. `cd eden ; npm run check` stays GREEN (harness typed + lint-clean; live scenarios excluded from CI).

### Suggested order
Start with **`farm_wheat`** (lowest real-mineflayer risk — proves the harness end-to-end and should reach a clean `admit`), then **`craft_wooden_tools`** (will likely surface the crafting-window gap), then **`cooperative_mob_defense`** (pvp + reactivity + multi-villager — the richest, save for last).
