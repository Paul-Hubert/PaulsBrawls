# 26 — Implementation plan: real-mineflayer, no-LLM CI (the ordered build)

**Status:** plan, finalized **rev 2** (2026-07-03). Rev 1 was reviewed the same day by a 5-subagent
panel (§9); rev 2 folds every finding into the step bodies and records the owner's same-day directive:
**the CI is God-free end to end** (no avatar bot, no divine cases, no op'd bot — **D-19**, §6). This is
the *how, sequenced* for the end state specified in [24-realbot-ci-final-product](24-realbot-ci-final-product.md).
It supersedes the DAG in [23 §8/§11.2](23-real-mineflayer-ci-plan.md) (the panel review + risk register
there remain the analysis of record). Kickoff prompt: [25](25-realbot-ci-implementation-prompt.md).
**Docs lead; code follows in the build session(s)** — nothing in this doc changes behavior.

**Locked inputs (do not relitigate):** Q1 = RecordingBot split · Q2 = the auto-opened `run/` dev server
is the CI host (the mod's own server: settlement `:8767` / `coin` present, no jar build/copy, dev port,
no GPU) · Q6 = no LLM in CI · **D-19 = no God in CI** (owner, 2026-07-03): the skill tier spawns one
mortal runner only — no avatar, no divine skill cases, and **CI never ops any bot** · two tiers (logic
per-push, skill tier on the real server) · hard ordering: **the D-16 gate + stock paired tests land
before the per-skill catalogue**, and **the RecordingBot split lands before deleting FakeBot's
world-model half**.

---

## 1. Verified ground truth & drift (2026-07-03, against `eden-m0-m7`)

Everything below was re-derived from the tree (rev 1 + the panel's re-verification). Where it
contradicts docs 22–24, this section wins.

### 1.1 The FakeBot estate (re-derived)

- **20 test files import `fakes/fake-bot`** (grep the *import path* `fakes/fake-bot`, not the
  identifier `FakeBot` — `village-launch.test.ts` has an unrelated local class the identifier-grep
  trips on). **66 test files total → 46 never touch FakeBot** (rev 1 said 67/47 — wrong; the old docs'
  "~46" was right).
- The clean "~8 port / ~12 stay" split is really **6 port + 2 SPLIT + 10 stay + 1 delete**, because two
  files carry *both* halves: `skills-engine.test.ts` (fault-injection supervision asserts **and**
  world-model run semantics) and `bots-hardening.test.ts` ±cov (the R4 `calls[]` order assert **and**
  real window ops). Full dispositions in §5.
- FakeBot ([tests/fakes/fake-bot.ts](../eden/tests/fakes/fake-bot.ts)) is **540 lines, ~50% world
  model**. The recorder/fault seams that must survive: `calls[]` / `sentChat[]` / `clicks[]` /
  `crafted[]` / `loadedPlugins[]`, `setDigMode`, `setActivateDelayMs` (R55), `setUnknownItems` (D1),
  `dropLoadBearingPlugin`, the packet seams (`packetSetSlot`/`packetWindowItems`, R2), and the native
  `emit()` event sourcing (`setEntities`/`setVitals`/`setTime`) the signals/events/reactivity tests
  live on. The world model to delete: the `findBlocks` palette simulation logic (R76), `activateBlock`
  flip rules, the container store, `plantTree`, dig-drop and craft-window semantics.
- **Load-bearing subtlety:** the `Bot`-seam compile proof (`const _assert: Bot = new FakeBot()`,
  fake-bot.ts:539) means the recorder must still *carry the full seam*. The split is **behavioral** —
  but not uniformly inert (panel P-8). Two stub classes:
  - **live-mutable state stubs** — a plain inventory array (`give`/`countItem`/`inventory.items()`),
    a seeded block map (`setBlock`/`blockAt` returning what was seeded), the `entities` map: the
    engine's `captureSnapshot` and the gate/loop convergence tests (`bot.give` → snapshot →
    check-veto, both directions) depend on these being *real state*, and the skills-engine stall test
    digs a *seeded* block forever;
  - **inert stubs** — `findBlocks`/`findBlock` (null/empty, never simulate the palette), containers,
    `activateBlock` behavior (only the R55 *delay fault seam* survives), `plantTree`.
  "Delete the model, keep the seam — and keep the state the snapshots read."
- `eden/src/` has **zero imports of the fake** (runtime or type) — deletion touches only `tests/`.

### 1.2 The server (re-derived)

- [run/server.properties](../../run/server.properties) is **git-tracked and locally modified on the
  dev box** (the overlay must back up the *working-tree* file, not assume HEAD): `level-name=world`
  (persistent `run/world/`), **empty `level-seed`**, `level-type=minecraft\:normal` (note the
  Properties **colon-escaping** — an unrecognized level-type silently regenerates a *normal* world,
  defeating determinism with no error), port **25599**, RCON **25575**, `online-mode=false`,
  `spawn-protection=0`, `max-tick-time=60000` (the vanilla watchdog — itself a useful canary).
  Minecraft **rewrites the whole file on boot** (re-serialized, reordered), so the overlay must be a
  full-file rewrite and the restore a full-file replace.
- `build.gradle` has **no custom loom run configs** — `runServer` is the default task, `runDir` =
  `run/`. Loom **forks the server JVM via the (shared, persistent) gradle daemon**: teardown must kill
  by *port ownership* (the PID listening on 25599), never "the gradle process tree", and never the
  daemon (it is RK11's warm-start mitigation). RCON `stop` is a valid graceful path in modern MC.
- The `:8767` settlement listener starts **unconditionally** at `SERVER_STARTED`
  (`VillageConfig.enabled=true` default; there is no RCON-reachable `/village on`); its port comes
  from the JVM-cwd `run/village_config.properties` (absent → 8767), independent of the world overlay.
- `run/mods/` currently ships `worldedit-mod-7.3.8.jar` — an input to reproducibility the lifecycle
  must pin or assert (§B1).
- R29 inverts under Q2: `./gradlew runServer` *owning* `:8767` was a hazard for the v1 eval; for this
  CI it is **the feature** — the dev server IS the settlement listener.
- Nothing anywhere starts the server today; the live harness only reads the properties file and polls
  `system.bot-connected`. Its `RconClient.connect()` is **one-shot** (rejects on the first
  ECONNREFUSED, no retry) — fine for commands against an up server, unusable as a readiness poll.

### 1.3 Eden surfaces (re-derived)

- **`EdenHost` (main.ts `start()`) does not expose the engine or the pool** (returns `{adminPort,
  config, journal, coordinator?, god?, stop}`). The skill-tier harness therefore **composes its own
  minimal stack** (journal + library + engine + `BotPool`) — see B4 for the drift guardrail (a shared
  engine factory, P-18).
- `BotPool` has **no single-bot API** and today *requires* `avatarName` (the avatar is appended to the
  roster and spawned by `start()`). Under **D-19** the harness spawns **one mortal runner only**, which
  needs a small additive `src/` change: make the avatar member optional (`avatarName?` or
  `spawnAvatar:false`) — `main.ts` unaffected. This *is* still the "existing bot-pool path, no bespoke
  connector" (S3/S5).
- **`npm test` globs `tests/**/*.test.ts`** — the skill tier must live **outside that glob**
  (`eden/live-tests/skill-tier/`, own runner) or it would run per-push.
- Engine: `captureSnapshot` exists (engine.ts ~630; inventory/position/health/food/equipment/
  nearbyEntities≤16@24 m/nearbyBlocks-names@8 m); `worldBefore`/`worldAfter` bracket the run (~241/410).
  **`STALL_EVENTS` has no `entityDead`/`playerCollect`** — the D-16 event-trace is *new subscriptions*,
  exactly as [22 §3.4](22-godfree-skill-loop.md) warns. No `ctx.events`, no `readComposable`, no
  manifest `validates`/`test` fields, no `skill.self-verdict` kind — **D-16 is entirely unbuilt.**
  Two admission-provenance gaps the panel found (P-9/P-10): `Provenance` *requires* a `verdictId`
  (types/skill.ts) so a gate admission is unexpressible, and `RolloutsView` derives `admitted`
  **exclusively** from `god.verdict` — both must change in B3.
- Stock library: **~31 mortal skills (7 exemplars) + ~9 divine** (the completeness gate in B5 owns the
  exact mortal count mechanically). Under D-19 the divine set is **out of CI entirely**. Seeding is
  idempotent by `codeHash` (library.ts ~141).
- `llm/client.ts` still passes no `temperature`/`seed` — irrelevant to the CI gate (Q6), noted so
  nobody re-adds it to the critical path.
- Eden's S6 "golden prompt" mechanism is **inline structural asserts** (`villagers-context-pack.test.ts`,
  `villagers-tools.test.ts`), not `.snap` files — B3's tool-list changes edit those asserts.

### 1.4 Spec frictions (flagged in rev 1; two now resolved)

- **F-1 — "no throw" when unresourced vs. S10 — RESOLVED (O-2, §6):** the case declares
  `unresourcedExpect: 'no-op' | 'named-error'` (default **`named-error`** — today's stock skills
  throw evidence-carrying errors on absent preconditions, which is S10/R72 behavior worth keeping);
  both satisfy "no crash, no lie"; a `TypeError` / `bot.X is not a function` fails either way. The
  literal "no throw" in 24 §3 is amended by this resolution.
- **F-2 — D-16 is double-booked** (docs/04/05/07 use "D-16" for embed-at-write sqlite-vec; docs/22
  reuses it for the god-free loop) — **still owner-open (O-3)**. New decisions here number D-17+.
- **F-3 — depcruise scopes `src/` only**; tests are never graphed. The real rule: shared
  harness/bootstrap code lives under `live-tests/`/`tests/`, never `src/`; nothing under `src/` may
  import from either. The B4 engine-factory guardrail (P-18) exists *because* this can't be
  machine-enforced.
- **F-4 (new, panel P-4) — D-16's Sδ≠∅ rule is unsatisfiable for observer/movement skills —
  RESOLVED (O-4, §6):** `go-to`, `find-*`, `find-high-spot`, `explore-until` mutate nothing by
  contract, so they could never ADMIT; and `nearbyBlocks` as a name-*set* makes the 2nd till/sow into
  a field already showing `farmland`/`wheat` invisible. Resolution: a third oracle class
  **`oracle:'return'`** (the paired test asserts the return value + a world *read* via RCON; exempt
  from Sδ≠∅ — the fraud surface is "returned a coordinate/fact that isn't real", checked against the
  world), and the Sδ `nearbyBlocks` comparison becomes name-**counts**. This amends
  [22 §3.5/§6](22-godfree-skill-loop.md); the docs/22 amendment ships in the same commit as B3a (S8).

---

## 2. The step DAG (one screen)

```
B1  CI server lifecycle (open run/ server, ready-gate, reset, reap, teardown)   ⛔
B2  RecordingBot split (recorders+faults+event-sourcing; FakeBot stays for now)
B3  D-16: gate core (a) ⛔ → loop rewiring (b) ∥ stock paired tests (c) ⛔
B4  Skill-tier harness + pilot cases        (needs B1 + B3a + first B3c pairs)  ⛔
B5  Per-skill catalogue: resourced+unresourced matrix + honesty + completeness
                                            (needs B3 complete + B4)
B6  Re-tier the remaining files             (needs B2 + B4)
B7  Wire the two CI jobs; DELETE FakeBot's world-model half + fakes.test.ts;
    docs sweep (S8)                         (needs B2 + B5 + B6; B3b landed)    ⛔ last
```

Parallelism: **B1 ∥ B2 ∥ B3a** can all start together (disjoint areas: `live-tests/server/`,
`tests/fakes/`, `src/skills/`). B3b runs parallel to B4/B5 but must land before B7. The two hard
ordering constraints are honored by construction: **B3(a+c) strictly precedes B5** (the catalogue
asserts the mechanical flip oracle, never `god.verdict`), and **B2 strictly precedes the B7 deletion**
(the R4/R66/stall/R55/D1 asserts never lapse). The logic tier (`npm run check`) stays green after
every step — it is the always-on gate throughout.

Old-DAG mapping: B1≈CI-0 · B2≈CI-1 · B3≈CI-3 (moved *before* the harness's oracle work, per panel F5) ·
B4≈CI-2 · B5≈CI-4 · B6≈CI-5 · B7≈CI-6. CI-0.5/CI-1 of §11.2 (temperature wiring, local-model probe)
are **de-scoped** — Q6 removed them from the critical path (§7, non-goals).

Coarse effort (P-35): B1, B2, B4, B6, B7 ≈ one focused session each (B1 maybe two — it is the most
new-ground); B3a ≈ one–two; B3b ≈ two (R81 is the subtlest item); **B3c and B5 are the bulk** —
multi-session, amortized family-by-family with per-family green gates.

---

## 3. The steps

### B1 — The CI server lifecycle ⛔

**Goal.** CI code opens the `run/` dev server itself, knows when it is *genuinely* ready, starts every
run from a clean deterministic state, and cannot be poisoned by a previous crash. Under **D-19** the
lifecycle **never ops any bot** — there is no avatar and no divine case; CI runs entirely unprivileged.

**The one total order** (P-12/P-15 — reaping must precede the world delete, which must wait on the old
JVM's file locks):

1. **Heal**: if a leftover `.ci-backup` of `run/server.properties` exists (a crashed prior run),
   restore it first. The backup is **stamped** (a marker header) so a foreign file is never blindly
   restored.
2. **Reap**: resolve owners of the CI ports (25599 dev MC, 25575 RCON, 8767, 8770) via
   `netstat -ano`; dedupe PIDs (25599+8767 are the same server JVM; 8770 is node; an absent listener
   is success, not error); `taskkill /T /F` the owners. **Never** kill by process name, never the
   gradle daemon, and **refuse** to touch a listener on 25565 (production guard).
3. **Wait-free**: poll until 25599 is unbound (the old JVM has exited and released `run/eden-ci/`
   file handles — Windows `EBUSY` otherwise).
4. **Delete** `run/eden-ci/` (a flat world regenerates in seconds, deterministically by seed), with a
   bounded retry on file-lock errors. The dev `run/world/` is never touched.
5. **Overlay**: back up the *working-tree* `run/server.properties` (it is tracked AND locally
   modified — restore-to-backup, never restore-to-HEAD), then write a **full-file rewrite** (MC
   re-serializes the whole file on boot; a line-patch races that): `level-name=eden-ci`,
   `level-type=minecraft\:flat` (Properties colon-escaping — a malformed value silently falls back to
   a *normal* world), a fixed `level-seed`, RCON on; everything else carried over. LF-normalized.
6. **Spawn** `./gradlew runServer --console=plain` from the repo root as a supervised child, stdout
   tee'd into the run's evidence dir.
7. **Ready-gate** (all mandatory, in order; 10-min wall — first gradle run compiles/remaps the mod —
   with the elapsed *phase* in the failure message, S10):
   1. **RCON answers**: a new connect-with-backoff wrapper (`readiness.ts`) polls until
      `RconClient` connects + auths and `list` returns a parseable player-count reply (the existing
      `rcon.ts` is one-shot — it is reused for *commands*, not the wait-for-up loop).
   2. **The mod answers**: a TCP probe on `:8767` accepts — the settlement listener starts
      unconditionally at `SERVER_STARTED`, so this is the mod's liveness signal (its port comes from
      `run/village_config.properties`, absent → 8767).
   3. **The world is actually flat + the baseline sticks**: apply the determinism gamerules
      (`randomTickSpeed 0`, `doDaylightCycle false`, `doWeatherCycle false`, `doMobSpawning false`,
      `doFireTick false`, `mobGriefing false`, `doInsomnia false`, `doTraderSpawning false`, on top of
      peaceful) and **read one back**; probe one known flat-profile block (`execute if block` at a
      fixed y) so an unrecognized level-type that silently regenerated a normal world fails loudly
      here, not as downstream flake.
8. **Teardown**: RCON `stop` → wait for 25599 to free (grace) → hard-kill the *port-owning PID* if
   still alive → restore `server.properties` from the stamped backup.

**Environment pins.** The self-hosted runner is a **dedicated box role**: no manual `npm run
live-test` or dev `runServer` while the skill job can fire (the reaper would kill them — it reaps by
port, loudly logging what it kills). `run/mods/` is an input to reproducibility: the lifecycle asserts
its contents against a pinned manifest (currently `worldedit-mod-7.3.8.jar` — keep or remove, but
pinned either way).

**Files.** `eden/live-tests/server/` (`lifecycle.ts`, `properties-overlay.ts`, `reaper.ts`,
`readiness.ts`); `eden/package.json` (`skill-test` script stub). No gradle/Java changes.

**Check / DoD.**
- Logic-tier unit tests (pure, per-push): the overlay writer (full-file rewrite, colon-escaping,
  stamp, backup/restore, leftover-backup healing), the reaper's port-resolution + PID-dedupe logic.
- A `lifecycle-smoke` script (no LLM, no key): open → ready-gate passes (incl. the flat-block probe)
  → spawn one bot via `BotPool` → RCON `list` shows it → teardown → **immediately repeat** — the
  second run must come up clean (proves reset + wait-free + reaping). Run once more from a
  deliberately poisoned state (orphan server left running, stale `.ci-backup` present).
- The existing `npm run live-test` still works against a manually-started dev server (unchanged).

### B2 — The RecordingBot split (create; delete comes in B7)

**Goal.** A slim `RecordingBot` carries everything the logic tier needs from FakeBot, so the
world-model half can die later without any assert lapsing.

**What it keeps** (refined by the panel's seam audit — §1.1): (a) the recorder arrays; (b) the
fault-injection seams — `setDigMode('never')` (stall), the macrotask-canary triggers (W/CRIT-1), the
`setActivateDelayMs` **delay fault seam** (R55 — the seam, not the farm model), `setUnknownItems`
(D1), `dropLoadBearingPlugin`, the packet seams (R2); (c) **event sourcing** — native `emit()`, the
`entities` map, `setVitals`/`setTime`; (d) **live-mutable state stubs** — the inventory array
(`give`/`countItem`/`inventory.items()` must be *real state*: the gate/loop convergence tests depend
on `give` → snapshot → check-veto in **both** directions), a seeded block map (`setBlock`/`blockAt` —
the skills-engine stall test digs a seeded block; the FIX-2 snapshot test labels a seeded entity);
(e) **inert stubs** — `findBlocks`/`findBlock` return null/empty (never simulate the palette),
containers/`plantTree`/`activateBlock` behavior gone; (f) the `Bot`-seam compile proof, moved onto
RecordingBot.

**Notes pinned in code comments (panel P-31):** the kept reactivity tests
(`villagers-host-reactivity` etc.) assert *routing* — that a `skill.run` was journaled — which
survives inert stubs only because the reflex skills no-op cleanly on an empty world (`findBlock`→null
must not throw; `pathfinder.goto` must resolve). They must never be tightened to world-delta asserts
without moving tiers.

**Files.** `eden/tests/fakes/recording-bot.ts` (new); re-point the 10 stay-files + the logic halves of
the 2 split-files (§5) from `fake-bot` to `recording-bot`; a small `recording-bot.test.ts` pinning the
fault seams (replaces the surviving halves of `fakes.test.ts`). FakeBot itself is untouched in this
step.

**Check / DoD.** `npm run check` green; `gate.test.ts` + `loop-integration.test.ts` pass on
RecordingBot **unchanged**; the R4-order, R66-identity, stall, W-canary, R55 *fault-seam* and D1
asserts run serverless (the R55 *flip-behavior* asserts — grass→farmland timing — move to the skill
tier in B6, where the real server provides the round-trip); grep (`fakes/fake-bot`, import path) shows
the re-pointed files clean; the seam proof compiles. Coverage: **byte-identical** logic-tier coverage
before/after (nothing moves tiers in B2, so this one is exact — the B6/B7 coverage rule is different,
see B6).

### B3 — Land D-16: gate core ⛔, loop rewiring, stock paired tests ⛔

The hard prerequisite ([24 §9](24-realbot-ci-final-product.md)). **"D-16 landed" for the spec
prerequisite = B3a AND B3b complete** — B7 may not claim it on B3a alone (P-25). B3a and B3c block B5;
B3b blocks only B7. Each sub-step has its own DoD.

**B3a — the mechanical gate core** (layer-2, no LLM anywhere in it). *Naming:* the module and tests
are **`flip-gate`** (`src/skills/flip-gate.ts`, `tests/flip-gate.test.ts`) — the name `gate.test.ts`
is already taken by the M3-GATE convergence proof (P-11).

- The flip-gate judge: the [22 §3.5](22-godfree-skill-loop.md) truth table over
  `{preV, Sδ, postV, task.check}`; `checkSatisfied` lifted out of the critic (`ItemCheck`/`Task` live
  in `types/` layer 0 — the import is legally downward, verified).
- The `Sδ` comparator: inventory count Δ, `nearbyBlocks` **name-counts** Δ (O-4 — a set misses the
  2nd farmland/wheat), or an `entityDead` in the trace. Two pinned caveats: Sδ deliberately
  **excludes `nearbyEntities`** (so another body near the runner can never forge a delta — do not
  "improve" this), and `nearbyBlocks` is **viewpoint-sensitive** for movement-composing skills (the
  two snapshots are taken from different positions) — a `nearbyBlocks`-only delta is corroborating,
  never sole-sufficient (P-32).
- The **`'return'` oracle class** (O-4): observer/movement skills are exempt from Sδ≠∅; their paired
  test asserts the return value against a world *read*. The docs/22 §3.5/§6 amendment ships in this
  commit (S8).
- The **event-trace**: new engine subscriptions (`entityDead`, `playerCollect`, + existing
  `diggingCompleted`) into a bounded 64-entry ring + dropped-count on `RunReport`. **Trace close has a
  bounded grace** (~500 ms / a macrotask settle after the body resolves) so a death landing one tick
  after `isValid` flips is not lost (P-5); `entityDead` filters by subject, `playerCollect` by the
  runner's username. `ctx.events` injects the *subject skill's frozen* trace into a test(post) run
  (race-free, 22 §3.4). The grace knob joins the config table.
- **Admission provenance** (P-9): extend `Provenance` with `source: 'critic' | 'self-verdict'`
  (`verdictId` optional / `selfVerdictId` added), threaded through `library.admit` and the
  `skill.admit` payload — this is the data path for the Milestone-A oracle ("zero critic-driven
  admissions") and the CI assert.
- Manifest pairing: `validates?: string` + `test: boolean`; tests hidden from retrieval and
  composition (S1 registry-style change).
- `skill.self-verdict` journal kind (kinds.ts registry row + payload map + KIND_REGISTRY — S1).
- `readComposable` (highest-ACTIVE resolver, R80) + `composerRun` switched to it; `ProbationError`
  kept for first admissions.
- **The S2 invariant, stated now and enforced forever** (P-17): the flip-gate module is the **sole**
  caller of `library.admit` on the self-verdict path. `submit_skill` (B3b) and the CI harness (B4)
  both invoke `flipGate.run(...)`, which performs the admission — **neither re-implements
  truth-table→admit**, so the villager-facing gate and the CI oracle cannot drift.
- **B3a is inert wiring** (P-34): nothing calls the gate until B3b/B4, so the critic remains the only
  admission path through B3a — no dual-admission window. The one live B3a effect is `readComposable`
  (composer resolution), independent of admission.

*Files:* `src/skills/flip-gate.ts`, `src/skills/engine.ts` (trace), `src/skills/library.ts`,
`src/types/skill.ts` (Provenance), `src/journal/kinds.ts`, matching logic-tier tests.
*DoD (B3a):* truth-table unit tests cover **every** row (ADMIT, both REJECTs, REVISE, both
nothing-to-do rows, test-throws→failed); trace ring bound + grace + filter tests on RecordingBot;
`skill.admit` carries `source`; kinds row round-trips `rebuild-stats`; `readComposable` pins R80
(composer keeps `v_k` while `v_{k+1}` probates). `npm run check` green.

**B3b — the loop rewiring** ([22 §7](22-godfree-skill-loop.md)): `submit_skill` + `reflect` villager
tools (invoking the shared flip-gate); `RolloutCoordinator` drives session-chaining + the R65 breaker
off the gate outcome; the critic leaves the skill-admission path; `onTripwire` wakes self-debug; the
R81 rollout-immune permit release. Plus two consequences the panel caught:

- **The derived views must fold the new admission signal** (P-10): `RolloutsView` today derives
  `admitted` *exclusively* from `god.verdict` — a gate-admitted rollout would read `open` forever, and
  rebuild==live can't catch it (both folds wrong identically). Update `RolloutsView` (and audit
  `SkillStatsView`) to fold `skill.self-verdict`/`skill.admit{source}`; the parity test must exercise
  a **gate-admitted** rollout, not just a critic one.
- **The existing `gate.test.ts` (M3-GATE) is rewired, not left alone** (P-11): it currently asserts
  critic-driven admission — B3b re-points its admission path to the flip gate (on RecordingBot +
  ScriptedLlm, still fully deterministic), keeping the M3/M4 convergence proof per-push.

*Files:* `src/villagers/tools.ts`, `src/main.ts`, `src/god/god.ts`/`critic.ts` (admit branch removed),
`src/views/index.ts`, `tests/gate.test.ts`, `tests/villagers-context-pack.test.ts` +
`tests/villagers-tools.test.ts` (the **inline structural tool-list asserts** — Eden's S6 mechanism is
not `.snap` files, P-33).
*DoD (B3b):* a `submit_skill` round-trip admits through the gate on RecordingBot; the rewired M3-GATE
convergence proof green; rebuild==live parity green **on a gate-admitted rollout**; zero remaining
critic-admission paths (grep `routeVerdict` admit branch gone). `npm run check` green.

**B3c — stock paired tests, MORTAL scope** (D-19): one test skill per **mortal** stock skill (~31),
authored family-by-family (movement/observation → mining/collection → farming → crafting/smelting →
chest → combat), as reviewed templates carrying the SAFE-OPEN/pause-mutators (R1–R3/R63) and R55
poll-until-confirmed discipline. Relative bars, never absolute (R78). Combat tests assert over
`ctx.events` (22 §3.7); observer/movement tests are `'return'`-class (O-4). **Divine stock skills are
exempt**: they are seeded `active`, never pass through the gate, and are out of CI (D-19) — the
completeness check lists them as excluded, loudly. One stock-skill fix rides along (P-23):
**`place-item` gets the R55 poll-until-confirmed tail it currently lacks** — "test settle = none"
(22 §5.1) holds *only* for skills that ship the poll.
*DoD (B3c):* per-family batches land green (`npm run check`); the per-push completeness half-gate —
every mortal stock non-test skill has a paired test — green after the last family.

### B4 — The skill-tier harness + pilot ⛔

**Goal.** The runner that drives a real bot through `T(pre) → S → T(post)` against the B1 server,
with its own catalogue shape — no LLM, no God (D-19), no `Scenario` reuse.

**Design.**
- Lives in `eden/live-tests/skill-tier/` (outside the `npm test` glob — §1.3): `run.ts`
  (process-level runner reusing the live suite's child-isolation + Windows kill pattern),
  `harness.ts`, `severity.ts`, `cases/` (B5), `types.ts`.
- **Composes its own minimal stack** (journal on the run's data dir + library seeded from stock +
  engine + `BotPool` with a **single-member roster**: one mortal `CiRunner`, username namespaced per
  R12; the avatar-optional BotPool change from §1.3). The stack takes its `SkillEngine` from a
  **shared factory** (`makeEngine(opts)`) that `main.ts` also calls, so stall/canary/tier/probation/
  trace policy is single-sourced — the mini-root wires *composition*, never engine *policy* (P-18;
  the honest guardrail for a second root depcruise can't graph, F-3).
- The `SkillCase` shape (the catalogue is a registry — S1):
  ```ts
  interface SkillCase {
    skill: string;                       // library name; 1:1 with a MORTAL stock skill
    args: object | ((arena: ArenaCtx) => object);
    resourced:  WorldSetup;              // rcon: string[] (+ give/tp), idempotent
    unresourced: WorldSetup | { notApplicable: string };  // reason mandatory; printed (no silent caps)
    unresourcedExpect?: 'no-op' | 'named-error';          // O-2 resolved; default 'named-error'
    unresourcedErrorMatch?: RegExp;      // optional: pin the S10 message (P-7)
    expectCallTree?: string[];           // optional: composition oracle (P-7)
    oracle: 'state' | 'events' | 'return';                // O-4: observers are 'return'-class
    timeoutMs?: number;                  // per-case wall; default 240 s (< 3×runDefaultTimeoutMs)
  }
  ```
  `unresourcedExpect` is a **closed 2-value enum** and `notApplicable` a single escape hatch — a
  third variant means the policy belongs in the case body (S9), not a new protocol branch (P-27's
  tripwire).
- **The per-case reset resets the BOT, not just the arena** (P-2 — the owner's "reset bot for CI"):
  rebuild the arena + `kill @e[type=item]` + **`clear <runner>` + `tp <runner> <arena spawn>` +
  `gamemode survival <runner>` + `effect clear`** + re-set the case's *surface content* (dirt vs
  farmland vs crop is case state, not arena state — the shared (0,0) footprint must not leak the
  previous case's blocks). RK3 applies per-**case**, not just per-run. A `T(pre) ≠ nothing-to-do` in
  the unresourced phase is an **arena/reset defect** (retried once as infra, journaled), not a skill
  REJECT (P-6-adjacent).
- **Per-case protocol:** apply unresourced (after a full reset) → `T(pre)` must be `nothing-to-do` →
  run `S` → no crash + `Sδ` empty + no false success (per `unresourcedExpect`) → `T(post)` still
  `nothing-to-do` → full reset → apply resourced → `T(pre)` must be `failed` → run `S` → `T(post)`
  must be `worked` + `Sδ` non-empty (`'return'`-class: return-vs-world instead) + the case's RCON
  world assert where cheap. **Honesty is *constructed*, not observed** (P-16): rows 1 (pre-already-
  worked), 2 (zero-delta worked) and 6 (non-empty-delta nothing-to-do) are asserted on **every case**
  by the protocol itself; row 7 (test throws → failed, never admit) is pinned by a flip-gate logic
  test; and a suite-level **mutation drill** (deliberately constant-`worked` test → the case must
  fail with the REJECT-TEST reason) proves the enforcement end-to-end.
- **Admission goes through the gate** (P-17): the harness invokes `flipGate.run(...)` — it never
  re-implements truth-table→admit.
- **Split-severity** lives in `severity.ts` with its own per-push unit test (P-26): hard oracle
  (flip / RCON fact / a skill throw) fails; incidental non-fatal `system.error` warns; only fatal
  events (runner-bot death, host crash, unhandled rejection) fail. Classified-transient infra retry
  only (bot-connect timeout, RCON refused, chunk-not-loaded), **capped at 2 and journaled** (R36); an
  outcome miss never retries. The logic tier's assert semantics are unchanged — split-severity is a
  skill-tier concept.
- **One boot, one bot-connect per suite run** — cases share the connection (the 120 s connect
  allowance is amortized, not per-case). Default per-case wall 240 s; the movement family may need a
  longer `stallSeconds` under CI load (chunk loads can look like a 20 s stall) — tune from recorded
  timings, journal the override.
- The per-run journal is authoritative *for that run* (P4 — the `llm.call = 0` and honesty oracles
  read it); disposing it between runs is the existing per-run-data-dir discipline, not a P4 violation
  (P-34). Evidence per run: `live-tests/.runs/skill-tier-<ts>/` (eden.db, per-case verdicts + timing,
  server log tail, `result.json`).
- **The tier boundary is pinned in CI without an avatar** (P-19 under D-19): one negative case — the
  mortal `CiRunner` attempting a divine stock skill must get `TierGateError`. CI never ops anyone;
  villagers are never op'd (owner #13), and now neither is anything else.

**Pilot.** Three cases triangulating the three oracle classes: `mine-block` (`state`), `kill-mob`
(`events`), `go-to` (`return` — O-4's first consumer).

**Files.** `eden/live-tests/skill-tier/*`, `eden/src/bots/pool.ts` (avatar-optional — the one small
`src/` change), `eden/package.json` (`skill-test` = lifecycle + runner), a logic-tier structure test
for the case registry (mirrors `live-tests-catalogue.test.ts`) + the `severity.ts` unit test.

**Check / DoD.** `npm run skill-test -- mine-block kill-mob go-to` green twice consecutively on a
lifecycle-opened server; **zero LLM calls** (`llm.call` count = 0 in the journal — mechanical);
**zero op'd bots** (no `op` in the lifecycle's RCON log); the mutation drill fails with REJECT-TEST;
the TierGateError negative case green; per-case walls respected.

### B5 — The per-skill catalogue (the core deliverable)

**Goal.** A `SkillCase` for **every mortal stock skill**, plus the completeness gate that makes
coverage enforced, not aspirational.

**Resolved questions.**
- **Enumeration (24 §10 / Q7):** hand-authored cases, enforced complete by a **logic-tier per-push
  test** (D-18): every mortal stock non-test skill ↔ exactly one case; every case names an existing
  skill; arenas idempotent; every `notApplicable` unresourced condition **printed with its reason**;
  the **divine stock set printed as excluded-by-D-19** (no silent caps). A new mortal stock skill
  without a case fails `npm run check` — before any server is involved.
- **Scope, stated loudly (P-4 of the spec review):** "every library skill" (24 §7.3) = **the mortal
  stock seed**. CI starts from a fresh `.eden-data`, so the library *is* the stock library; divine
  skills are out of CI (D-19; they are covered by the manual live suite only); villager-admitted
  runtime skills are covered at admission time by the live D-16 gate itself. CI proves the gate + the
  mortal stock corpus; it cannot see a runtime library and does not pretend to.
- **Ephemeral skills:** `oracle:'events'` (kill-mob, shoot-mob, defend-self); pickup-drops stays
  state-based (inventory Δ). **Observers/movement:** `oracle:'return'` (O-4).
- **Farming under `randomTickSpeed 0`** (P-23): crop maturity is a **fixture** — resourced arenas
  `setblock …[age=7]`, never grow-and-wait; the per-case setup must not clobber the B1 gamerule
  baseline (the old scenario arenas re-apply their own ruleset — audit them).

**Order of authoring:** same families as B3c, **with a per-family checkpoint DoD** (P-25): each
family's cases green on a lifecycle-opened server before the next family starts — a systemic
oracle/severity problem surfaces at family 1, not case 35. O-2 and O-4 are resolved (§6), so nothing
blocks the start.

**Files.** `eden/live-tests/skill-tier/cases/<skill>.ts` + `cases/index.ts` (the registry);
`eden/tests/skill-cases-completeness.test.ts` (logic tier).

**Check / DoD.** Full catalogue green on a fresh lifecycle-opened server, then the **flake bar**
(P-6): the suite runs nightly/dispatch until it records **5 consecutive full-suite greens with zero
infra-retries fired** — only then is the gate eligible to become merge-blocking (B7). "Twice green"
is a smoke signal, not the bar (~62 case-conditions make per-case flake ≥0.1% a suite-level coin
flip). Per-case p95 wall-clock recorded and folded into RK2 (§7); Σ per-case walls ≤ the job wall
with retry headroom. Acceptance criteria 3, 4, 5, 7, 8 of [24 §7](24-realbot-ci-final-product.md)
(criterion 3 as scoped above).

### B6 — Re-tier the remaining files

**Goal.** Finish the estate move so nothing but `fakes.test.ts` still imports FakeBot.

- **→ skill tier:** `bots-helpers` ±cov (R7 hops, R10 trunks as arena cases), `bots-anchors` ±cov
  (real ground snapping, R18), the world-model halves of `skills-engine` and `bots-hardening` ±cov
  (real window ops R1–R3; real snapshot semantics; the R55 flip-behavior asserts from B2).
- **`skills-exemplars.test.ts` is NOT wholesale-subsumed** (P-7): its ~15 negative-message asserts
  (buried till-block, no-table make-bread, no-bow shoot-mob, …) and composition call-tree asserts
  (deposit→use-chest→go-to; tend-bread-farm composing every pair) move to **focused skill-tier
  tests** (they are real arenas) or into per-case `unresourcedErrorMatch`/`expectCallTree` fields —
  only the happy-path halves are subsumed by the B5 matrix. Delete the file only when every assert
  has a named new home.
- **`god-body.test.ts` under D-19** (P-30): the three *embodied* asserts (avatar runs divine skills
  in-world) have **no CI home** — they move to the manual live suite, out of CI. The down-avatar
  soft-fail assert (theatrics-never-a-dependency) is a pure logic concern (`resolveBot` → undefined,
  no bot at all) — it stays logic-tier.
- **stay logic tier on RecordingBot** (done in B2, verified here): `bots-pool` ±cov, `bots-signals`,
  `villagers-events`/`-routing`/`-host-reactivity`/`-brain`/`-tools`, `loop-integration`,
  `gate` (the M3-GATE proof, rewired by B3b). `ScriptedLlm` untouched.
- Non-bot fakes (`fake-settlement`, `memory-journal`, `vector-store`) stay — they are not FakeBot.

**Check / DoD.** `grep -r "fakes/fake-bot" eden/tests` → only `fakes.test.ts` (import-path grep,
P-28); `npm run check` green; the skill tier green. Coverage (P-21): the "no delta" rule cannot hold
when whole files move tiers — instead, list exactly which `src/` files leave the logic-tier coverage
denominator (`skills/exemplars/*`, `bots/anchors`, `bots/helpers`, `god/body` partially) and state
they are now proven by **execution on the real bot** (a stronger signal than FakeBot lines); the
remaining logic-tier surface stays ≥ baseline.

### B7 — Wire the two CI jobs, delete the world-model half, docs sweep ⛔ (last)

**Goal.** The two-job estate is live; FakeBot's world model is gone; every doc that said "validated
against FakeBot" says the truth (S8).

- **eden-ci.yml:** the existing job becomes the **logic job** (unchanged content: `npm run check`,
  ubuntu, per-push). Add the **skill job**: `runs-on: [self-hosted, windows, eden-mc]`;
  **trigger paths include `src/**`, `build.gradle`, `gradle.properties` in addition to `eden/**`**
  (P-3 — `runServer` compiles the mod; a Java break must fail THIS job, and today's `eden/**` filter
  would never fire it); triggers = push to `master` + PR label `skill-tier` + nightly `schedule` +
  `workflow_dispatch`; `concurrency: { group: eden-skill-tier, cancel-in-progress: false }` (one
  `run/` server, never shared — and never cancel mid-teardown); `timeout-minutes` set from B5's
  recorded p95 (Σ case walls + readiness + headroom); steps = checkout (full repo — gradle needs it),
  `npm ci`, `npm run skill-test`; upload the evidence dir as an artifact on failure.
- **Promotion policy** (P-6, composes with O-1): the skill job ships label/dispatch/nightly-only and
  becomes **merge-blocking only after the B5 flake bar** (5 consecutive clean full-suite greens) is
  met on the actual runner. If O-1 defers the runner, `npm run skill-test` is the merge ritual until
  it exists.
- **Delete** FakeBot's world-model half (the simulation logic; the file may shrink into an alias of
  RecordingBot or die entirely if B2/B6 left zero importers) + `fakes.test.ts`. Grep-clean
  (import-path).
- **Docs sweep (same commit):** 16-m0-reference (fakes section), 19/20 (harness now has a server
  lifecycle; the LLM suite explicitly out of CI), eden/CLAUDE.md (test-tier table, "fakes only"
  phrasing), docs/22 (the O-4 amendment if not already landed with B3a; the D-19 note that divine
  skills are CI-exempt), 07 (file build-session findings as R82+), README.md + PROGRESS.md rows, this
  doc's status line, [17-parity-signoff](17-parity-signoff.md) if the sign-off leans on the new gate.

**Check / DoD.** Acceptance criteria **1, 2, 6, 9, 10** of 24 §7 (3/4/5/7/8 were B5's): a push runs
the logic job in seconds; a labelled run opens the server, reaches ready, runs the skill tier green
with zero `llm.call` and zero op'd bots; the recorder asserts still pass; a deliberately-crashed
skill run does not poison the next (re-run the B1 poison drill through the CI entry point); a
`src/**`-only Java change fires the skill job; no FakeBot world-model code remains.

---

## 4. What CI proves when this lands (tie-back to 24 §7)

| Acceptance criterion (24 §7) | Proven by |
|---|---|
| 1 logic tier: no server, seconds, green | B7 (job unchanged from today) |
| 2 skill tier: auto-open, verified-ready, real bot, no LLM | B1 + B4 + B7 (`llm.call = 0` asserted; **no God, no op'd bot** — D-19) |
| 3 every skill × {resourced, unresourced} | B5 — scoped: **every MORTAL stock skill**; divine = out of CI (D-19, printed), runtime-admitted = covered live by the gate |
| 4 every paired test honest (truth table) | B4 protocol — rows *constructed* per case + the mutation drill (P-16) |
| 5 no skill throws on the real API | B4 protocol (hard-oracle severity; O-2's `named-error` is a declared expectation, not a crash) |
| 6 recorder asserts survive | B2 (+ byte-identical coverage check) |
| 7 new stock skill without a case fails CI | B5 completeness gate (logic tier, per-push) |
| 8 reproducible runs | B1 reset + fixed-seed flat CI world + Q6 (no model) + D-19 (no second body) + the B5 flake bar |
| 9 self-healing lifecycle | B1 poison drill, re-verified in B7 |
| 10 no FakeBot world model remains | B7 grep-clean |

---

## 5. Test inventory (the 20 FakeBot files + the new estate)

| File | Disposition |
|---|---|
| `skills-engine.test.ts` | **SPLIT** — supervision/fault/tier/composition asserts → logic (RecordingBot; the stall test digs a *seeded* block, the FIX-2 snapshot test reads the *entities map* — both live-mutable stubs); run-semantics half → skill tier (B6) |
| `bots-hardening.test.ts` / `-coverage` | **SPLIT** — R4 order / canary / packet-seam asserts → logic; real window ops → skill tier |
| `skills-exemplars.test.ts` | **SPLIT** (P-7) — happy paths subsumed by the B5 catalogue; the negative-message + call-tree asserts move to focused skill-tier tests / case fields; delete only when every assert has a named home |
| `bots-helpers.test.ts` / `-coverage` | **→ skill tier** (R7 hops, R10 trunks as arena cases) |
| `bots-anchors.test.ts` / `-coverage` | **→ skill tier** (real ground snapping, R18) |
| `god-body.test.ts` | **SPLIT under D-19** (P-30) — embodied asserts → the manual live suite (no CI home); the down-avatar soft-fail assert stays logic-tier (no bot needed) |
| `bots-pool.test.ts` / `-coverage` | **stay logic** on RecordingBot (lifecycle/recording, incl. R66) |
| `bots-signals.test.ts` | **stay logic** (event-sourcing seams) |
| `villagers-events` / `-routing` / `-host-reactivity` / `-brain` / `-tools` | **stay logic** (routing asserts — see the B2 note) |
| `loop-integration.test.ts` | **stay logic** — RecordingBot + ScriptedLlm |
| `gate.test.ts` | **stay logic, REWIRED by B3b** — the M3-GATE convergence proof's admission path moves from the critic to the flip gate; still RecordingBot + ScriptedLlm, still deterministic |
| `fakes.test.ts` | **DELETE** (B7); surviving seam asserts move to `recording-bot.test.ts` (B2) |
| 46 non-FakeBot files | **untouched** (the logic tier never regresses) |

New: `recording-bot.ts` + its test (B2) · `flip-gate.ts` + trace/kinds/provenance/readComposable
tests (B3a) · views-fold + rewired M3-GATE (B3b) · ~31 mortal paired test skills (B3c) ·
`skill-tier/` harness + `severity.ts` + ~31 `SkillCase` files + completeness test (B4/B5) ·
`server/` lifecycle + overlay/reaper/readiness tests (B1) · the avatar-optional `BotPool` change (B4).

---

## 6. Decisions recorded & owner flags

- **D-17 — the CI server profile is a swap-in overlay + a disposable world.** The lifecycle
  full-file-rewrites the git-tracked (and working-tree-dirty) `run/server.properties` behind a
  stamped backup (restore-to-backup, crash-healing) to a dedicated flat, fixed-seed `eden-ci` world
  wiped every run after a wait-for-port-free; the dev `run/world/` is never touched; `run/mods/` is
  pinned. Rejected: a second loom run config (`runDir 'run-ci'`) — crosses into `build.gradle` for no
  capability the overlay lacks; revisit only if property-swapping proves racy.
- **D-18 — the skill catalogue is a hand-authored registry with a mechanical completeness gate**
  (resolves Q7 / 24 §10#2–3): one `SkillCase` row per mortal stock skill; a per-push logic test
  enforces 1:1 coverage, prints every `notApplicable` reason and the divine exclusion list.
  `unresourcedExpect` is a closed 2-value enum; a third variant means the policy belongs in the case
  body (S9). Rejected: enumeration from the live library (arenas/args are not inferable; a generated
  case that asserts nothing is worse than a loud gap).
- **D-19 — the CI is God-free end to end** (owner, 2026-07-03; supersedes the panel's avatar-parking
  fix for P-1): the skill tier spawns **one mortal runner only** — no avatar bot, no divine skill
  cases, **no op'd bot anywhere in CI**. Divine stock skills are exempt from paired-test/case
  completeness (seeded `active`, never gate-admitted) and are covered by the manual live suite only.
  Consequences: the avatar-optional `BotPool` change (B4); god-body's embodied asserts leave CI (B6);
  the lifecycle has no `op` step (B1); determinism improves (no second body to steal drops or pollute
  snapshots — P-1 dissolved rather than mitigated).
- **O-2 — RESOLVED** (owner delegation, 2026-07-03): the unresourced-world contract is per-case
  `unresourcedExpect: 'no-op' | 'named-error'`, default `named-error` — a clean S10 error is a
  declared correct outcome, preserving the R72 blocked-signal; 24 §3's literal "no throw" is amended.
- **O-4 — RESOLVED** (owner delegation, 2026-07-03; new — from panel P-4): observer/movement skills
  get the `oracle:'return'` class exempt from Sδ≠∅, and Sδ's `nearbyBlocks` comparison becomes
  name-**counts**. Amends docs/22 §3.5/§6 — the amendment ships with B3a (S8).
- **O-1 (owner, open):** register the self-hosted Windows runner now, or ship the skill job
  dispatch/label/nightly-only with `npm run skill-test` as the manual merge ritual until then. The
  B7 promotion policy (merge-blocking only after the flake bar) holds either way.
- **O-3 (owner, open):** the D-16 label collision (§1.4 F-2) — recommend relabeling the
  embed-at-write memory-vectors decision inside docs/04/05/07 and keeping "D-16" for the god-free
  loop.

---

## 7. Risks (23 §9 carried forward; bookkeeping corrected per P-24) & non-goals

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| RK2 | skill-tier wall-clock (~31 mortal skills × 2 conditions; one boot + one bot-connect per suite, cases share the connection) | Med | per-case wall 240 s default; per-case p95 recorded in B5 and the job `timeout-minutes` derived from it; family checkpoints catch systemic slowness early; parallelism deliberately NOT in v1 (a second bot would reintroduce the P-1 pollution D-19 just removed) |
| RK3 | runner state bleed — per-run (orphans, ports, dirty world) AND per-case (bot inventory/position/blocks) | High→Low | B1 reaper + disposable world + stamped restore + poison drill; B4 full per-case bot reset (P-2) |
| RK4 | coverage loss from the FakeBot split | Med, carried | **mitigated, not dissolved**: B2 byte-identical check; B6 names every `src/` file leaving the logic-tier denominator and its real-bot replacement proof |
| RK6 | mineflayer timing stretch under load (R55 class; event-trace close) | Med | poll-until-confirmed lives *inside* skills/tests (R79; `place-item` gains its missing poll, P-23); the B3a trace-close grace window; capped journaled infra-retries only |
| RK7 | Windows lifecycle specifics (file locks, taskkill, gradle daemon) | Med | port-ownership kills that never touch the daemon; wait-for-port-free before the world delete; reuse the live suite's proven Windows kill path; lifecycle-smoke drill |
| RK10 | catalogue completeness | resolved | D-18 gate, per-push, prints exclusions |
| RK11 | `runServer` recompiles the mod: a Java compile break fails the skill job; first-boot gradle cost | Low/Med | acceptable coupling (the mod IS a dependency); **the skill job's trigger paths include `src/**`** (P-3) so the break is visible; 10-min readiness wall names the phase; warm gradle daemon (protected by the port-owned teardown) |
| RK12 | ~31 hand-authored paired tests + ~31 cases is the bulk of the work | Med | family-by-family with per-family green gates (B3c/B5); reviewed templates; the pilot triangulates all three oracle classes first |
| RK13 | event-trace subscriptions leak/bloat | Low | bounded 64-ring + dropped-count, close-grace then unsubscribe, pinned by B3a tests |
| RK14 | flake at the suite level (~62 case-conditions) | Med | the B5 flake bar (5 clean consecutive greens, zero infra retries) gates promotion to merge-blocking (P-6); rolling flake-rate tracked from evidence dirs |
| ~~RK1/RK5~~ + temp/token risks | LLM reliability class | — | genuinely dissolved by Q6 (RK8 was NOT dissolved — it is RK11 renamed) |

**Non-goals (explicitly not in this plan):** temperature/seed wiring and any manual-LLM-suite
determinism knobs (24 §10#6 — optional follow-up, never a CI dependency); any change to the live LLM
suite's behavior beyond receiving god-body's embodied asserts (B6); any change to Eden's **in-world
God at runtime** — D-19 removes God from *CI*, not from the village (docs/22's "the in-world God is
untouched" still stands; an Eden-wide God removal would be its own design doc); any
`minecraft-mcp-server/` or Java change (the lifecycle only *invokes* gradle; the one `src/` change is
the avatar-optional BotPool option); GPU/model/key anywhere in CI.

---

## 8. Cross-references

[24](24-realbot-ci-final-product.md) the spec this delivers (criterion 3 and the "no throw" clause as
amended by D-19/O-2 above) · [23](23-real-mineflayer-ci-plan.md) the panel analysis + superseded DAG ·
[22](22-godfree-skill-loop.md) D-16 (B3 builds its gate; O-4 amends §3.5/§6) ·
[19](19-live-test-suite.md)/[20](20-live-test-process.md) the harness this extends ·
[07](07-hard-won-lessons.md) R1–R81 (R82+ reserved for build-session findings) ·
[25](25-realbot-ci-implementation-prompt.md) the kickoff that produced this doc.

---

## 9. Review panel record (5 Opus subagents, 2026-07-03) — ALL FINDINGS FOLDED (rev 2)

Five independent reviewers (infra/lifecycle · test estate · determinism/flake · architecture/D-16 ·
spec compliance) critiqued rev 1 against the actual tree. All five validated the DAG and the two hard
orderings; no step was reordered. Every finding is folded into the body above; this section is the
disposition ledger.

| # | Finding (one line) | Disposition |
|---|---|---|
| P-1 | avatar in-world pollutes every case (drop theft, entity snapshots, combat attribution) | **superseded by D-19** (owner): no avatar in CI at all — dissolved, not mitigated |
| P-2 | per-case reset never reset the bot (inventory/position/gamemode/blocks leak) | folded → B4 full bot reset (owner: "reset bot for CI") |
| P-3 | skill job never triggers on `src/**` Java changes | folded → B7 trigger paths |
| P-4 | Sδ≠∅ unsatisfiable for observer/movement skills; name-set misses 2nd till/sow | **O-4 resolved** → `oracle:'return'` + name-counts (B3a; amends docs/22) |
| P-5 | event-trace close races `entityDead`; `playerCollect` unattributed | folded → B3a grace window + filters |
| P-6 | "twice green" statistically weak for ~62 case-conditions | folded → B5 flake bar + B7 promotion policy |
| P-7 | skills-exemplars NOT subsumed (negative-message + call-tree asserts) | folded → B6 split + `unresourcedErrorMatch`/`expectCallTree` |
| P-8 | "inert stubs" contradiction — gate/loop need a live inventory; stall test needs seeded blocks | folded → §1.1/B2 live-mutable vs inert split |
| P-9 | `Provenance` can't express a gate admission | folded → B3a `source` discriminator |
| P-10 | `RolloutsView` folds admission from `god.verdict` only; parity blind spot | folded → B3b views + gate-admitted parity test |
| P-11 | `gate.test.ts` name collision; M3-GATE asserts critic admission | folded → `flip-gate` naming (B3a) + M3-GATE rewired (B3b) |
| P-12 | counts: 66 files / 46 non-FakeBot (rev 1's 67/47 wrong) | folded → §1.1/§5 |
| P-13 | `/village on` fallback fictional; :8767 unconditional; port source | folded → B1 ready-gate 2 / §1.2 |
| P-14 | `RconClient.connect()` one-shot — readiness needs a backoff wrapper | folded → B1 `readiness.ts` |
| P-15 | teardown by port-ownership, never the gradle tree/daemon; world delete waits port-free | folded → B1 total order |
| P-16 | honesty must be *constructed* per case, all rows | folded → B4 protocol + mutation drill |
| P-17 | S2: the flip gate is the sole `library.admit` caller on the self-verdict path | folded → B3a invariant + B4 DoD |
| P-18 | mini composition root drifts from main.ts engine policy | folded → B4 shared `makeEngine` factory |
| P-19 | divine wiring / tier-boundary hazard | under D-19: divine cases gone; the `TierGateError` negative case kept (B4) |
| P-20 | overlay = full-file rewrite of the *working-tree* file, stamped; no `git clean run/`; `minecraft\:flat` escaping + flat readback | folded → B1 steps 1/5/7.3 |
| P-21 | "no coverage delta" unachievable across tier moves | folded → B2 byte-identical + B6 named-denominator rule |
| P-22 | wall-clock understated; per-case wall + job timeout coherence | folded → B4/B5/B7 + RK2 |
| P-23 | crops are fixtures under `randomTickSpeed 0`; `place-item` lacks the R55 poll | folded → B5 + B3c |
| P-24 | RK bookkeeping (RK8=RK11 renamed; RK4 carried, not dissolved) | folded → §7 |
| P-25 | B3/B5 need per-sub-step / per-family DoDs; "D-16 landed" = a AND b; O-2 before B5 | folded → B3/B5 (O-2 now resolved) |
| P-26 | severity classifier needs a home + per-push unit test | folded → B4 `severity.ts` |
| P-27 | dedicated runner box; `run/mods/` pinned; closed-enum tripwire | folded → B1 / D-18 |
| P-28 | grep = import path `fakes/fake-bot`, not the identifier | folded → §1.1 / B6/B7 DoD |
| P-29 | R55 fault-seam vs flip-behavior DoD wording | folded → B2 DoD |
| P-30 | god-body down-avatar assert is pure logic; embodied asserts split | folded → B6/§5 (embodied → live suite under D-19) |
| P-31 | reactivity tests assert routing; must not be tightened on inert stubs | folded → B2 note |
| P-32 | `nearbyBlocks` Sδ viewpoint-sensitive for movement-composers | folded → B3a caveat |
| P-33 | S6 mechanism is inline asserts, not `.snap` files | folded → B3b files/DoD |
| P-34 | B3a is inert (no dual-admission window); throwaway journal satisfies P4 | folded → B3a/B4 notes |
| P-35 | per-step effort estimates | folded → §2 |
