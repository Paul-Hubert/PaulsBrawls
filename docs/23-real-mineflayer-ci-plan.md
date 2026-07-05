# 23 — Implementation plan: split FakeBot, move CI to real-mineflayer (no-LLM skill gate)

**Status:** plan, reviewed (5-subagent panel, §11) + owner-decided (Q1/Q6, 2026-07-01). Goal: **replace
FakeBot with real mineflayer tests on a live server**, using the D-16 paired tests to run **every skill +
its test without any villager LLM** as a deterministic CI gate. The literal kickoff ("with LLM calls")
was refined by the owner to **no LLM in CI** (the real-LLM authoring suite stays a manual tool) after the
panel showed a real-LLM-in-loop gate can't be reliable. This doc is the build plan.

Cross-links: [19-live-test-suite](19-live-test-suite.md), [20-live-test-process](20-live-test-process.md)
(the seed harness), [22-godfree-skill-loop](22-godfree-skill-loop.md) (the paired-test gate this
unblocks), [07 R1–R81](07-hard-won-lessons.md), [eden-ci.yml](../.github/workflows/eden-ci.yml).

---

## 1. The honest scope: "FakeBot" ≠ "all fast tests"

Ground truth from the current tree (verified 2026-07-01):

- **67 test files** under `eden/tests/`. **Only ~21 import FakeBot** (the body-dependent ones); the
  other **~46 are pure logic** — scheduler lanes, context-pack token budgeting, memory blend, journal
  folds, D-12 critic rails, R20 adjacency, config parsing, derived views, retrieval math, vectors,
  admin routes, the god desks (mock LLM), social. **These never touch a bot.**
- CI today ([eden-ci.yml](../.github/workflows/eden-ci.yml)) = `lint + typecheck + depcruise + npm test`
  on ubuntu, **no Minecraft, no key**, seconds to run.
- A **mature live suite already exists** ([live-tests/](../eden/live-tests/)): RCON builds a
  deterministic arena → boots a **real Eden host** (real bots, real LLM, real refinement loop) →
  asserts via **RCON world checks + journal folds** → preserves evidence. It **assumes a running dev
  server**, selects the LLM by name from `providers.json` (a keyless **`local`** preset already
  exists), and is **excluded from `npm run check`**.

So the literal ask — kill FakeBot, test against real mineflayer — is right and valuable (FakeBot is the
source of the Z/C/D1/D2/E *false-confidence* class: code green against the fake, broken on the real
API). But **forcing the ~46 pure-logic tests through a Minecraft server would only make them slower and
flakier for zero coverage gain.** This plan therefore:

> **Owner-resolved (2026-07-01):** **splits FakeBot** (keeps a slim RecordingBot for the asserts a real
> server can't reproduce; deletes its world-model half), runs **every skill + its paired test on a real
> server with NO villager LLM** as the mineflayer gate, keeps the ~46 pure-logic unit tests as the fast
> per-push gate, and **de-scopes the real-LLM authoring suite from CI** to a manual tool. The result is a
> two-tier CI (T1 no-server logic + T2 no-LLM real-server skills), not "everything is a live LLM test."

---

## 2. Target: a NO-LLM CI (owner-decided, 2026-07-01)

> **Owner decisions (resolved):** **Q1 = RecordingBot split** (§3); **Q6 = no LLM in CI at all.** CI
> exercises **every skill and its paired test** against a real server **without a villager LLM**, plus a
> no-server pure-logic tier. The real-LLM authoring/scenario suite stays a **manual/dev tool
> (`npm run live-test`), NOT a CI gate.** This removes every LLM-reliability risk the panel raised
> (local-model capability, forced tool-calling, temp-0 determinism, 32k-vs-48k token budget) from the
> critical path — CI validates the **library** (do the skills work on real mineflayer?), not the
> **cognition** (can the model author them?).

| Tier | What | Runner | LLM | Server | Blocks? |
|---|---|---|---|---|---|
| **T1 — pure logic** | the ~46 non-bot tests + the RecordingBot order/fault asserts (§3) + a **scripted-LLM convergence test** (keeps the M3/M4 gate deterministic) | `node:test` (as today) | none / **scripted stub** | **none** | **per-push** (GitHub-hosted, seconds) |
| **T2 — skill + paired-test CI** | for **every library skill** (stock + admitted): RCON builds its precondition arena → run the skill (engine, **no villager LLM**) → run its **paired test** → assert (a) the skill doesn't throw on real mineflayer (the Z/C/D1/D2/E catch), (b) the D-16 **flip** holds (`pre≠worked → post=worked`, non-empty `Sδ`, `check`), (c) the paired test is honest (truth-table rows). Plus the ~8 ex-FakeBot API-surface files. | `node:test` + real bot via `BotPool` | **none** (fully deterministic) | 1 shared MC 1.21.1 (flat, fixed seed, RCON, wiped per run) | **merge-gated** (self-hosted; §5) |
| **~~T3~~ — LLM scenarios** | the existing live suite (`farm-wheat`, authoring, Milestone A *authoring*) — real villager LLM authoring skills from scratch | live harness | local/remote | MC server | **NOT a CI gate** — manual `npm run live-test`, run on demand / as capability telemetry |

FakeBot is *split* (§3), not wholesale-deleted, once T2 exists. T1 is untouched. The LLM scenario suite
is retained but **de-scoped from CI**. **T2 is the reliable real-mineflayer gate — fully deterministic
because no model is in the loop.**

### 2.1 Why the D-16 paired test makes this work
Every skill ships a paired test that validates its world-effect *mechanically* ([22 §3](22-godfree-skill-loop.md)).
So CI doesn't need an LLM to know a skill worked — it runs `S` (scripted args from a `T2Case`), runs `T`,
and reads the flip. This turns the whole library into a **deterministic real-mineflayer regression net**
and **validates the D-16 gate itself for every stock skill** — the single highest-leverage thing this
plan buys, and it's only possible *because* of D-16.

---

## 3. Test-estate triage (the eradication map)

The 21 FakeBot-dependent files, with a disposition each. (Representative — the build step confirms
each file's tests as it ports them.)

| File | What it pins | Disposition |
|---|---|---|
| `skills-engine.test.ts` | run pipeline, snapshots, stall/abort, tier gate, composition, probation | **→ T2** (real bot; the highest-value port — this is where FakeBot most diverges from real mineflayer) |
| `skills-exemplars.test.ts` | stock skills (go-to/mine/collect/craft/kill/till/sow/harvest/…) | **→ T2** (each stock skill run against the real API — eliminates the Z/C/D1/D2/E class at the source) |
| `bots-hardening.test.ts` / `-coverage` | R1–R5 window/abort sequence | **→ T2** (real window ops; some sequence-order asserts may stay unit with a thin real-bot recorder) |
| `bots-helpers.test.ts` / `-coverage` | helper corpus (safe-open, pause-mutators, Vec3/goals) | **→ T2** |
| `bots-pool.test.ts` / `-coverage` | pool lifecycle, connect/disconnect, kick handling (R66) | **→ T2** (spawn/despawn real bots) |
| `bots-signals.test.ts` | signal adapter (hurt/health-delta, entity-spotted) | **→ T2** (drive real damage via RCON) |
| `bots-anchors.test.ts` / `-coverage` | anchor self-heal (R18) | **→ T2** (real ground snapping) |
| `villagers-events.test.ts`, `villagers-host-reactivity.test.ts`, `villagers-routing.test.ts` | event router + subscription firing | **→ T2** (real events) + some **stay T1** (pure filter/data logic with no bot) |
| `villagers-tools.test.ts` | run_skill/write_skill dispatch | **split**: dispatch logic **T1** (mock engine); real run_skill path **T3** |
| `villagers-brain.test.ts` | deliberation loop, R20 adjacency | **stay T1** (mock LLM client; R20 is pure message-shape logic — no bot needed) |
| `loop-integration.test.ts` | task→draft→run→verdict→admit | **→ T3** (this *is* an e2e scenario — becomes Milestone A) |
| `gate.test.ts` | the M3 convergence gate | **→ T3** (Milestone A) + the **D-16 flip gate** rides here |
| `god-body.test.ts` | avatar divine skills | **→ T2/T3** (real avatar bot) |
| `village-launch.test.ts` | launch wiring | **split**: wiring **T1** (no bot); connect path **T2** |
| `fakes.test.ts` | tests OF the fakes | **DELETE** (the thing it tests is gone) |

### 3.1 The RecordingBot split (Q1 resolved)
FakeBot is **split, not wholesale-deleted** — the panel showed ~8 asserts are structurally
unreproducible on a real server:
- **KEEP as a slim `RecordingBot` (fast T1, no server):** the `calls[]`/`clicks[]`/`crafted[]`/`sentChat[]`
  recorders + the fault-injection setters (`setDigMode('never')`, `setActivateDelayMs`, `setUnknownItems`,
  `dropLoadBearingPlugin`). These back the assertions a real bot cannot express or force: the **R4 abort
  sequence-order** ([bots-hardening.test.ts:24-41](../eden/tests/bots-hardening.test.ts)), the **R66
  kick-storm identity** guard, the **stall / W-CRIT-1 canary**, the **R55 read-after-write** race, and the
  **D1 registry-miss** named error. The `types/bot.ts` compile-time conformance proof moves onto RecordingBot
  so the seam stays honest.
- **DELETE the world-model half:** `blockAt`/`findBlocks`/`activateBlock` flip rules, the palette pre-check,
  the container store — everything the **real bot replaces** in T2.

**The src seam stays regardless.** [`types/bot.ts`](../eden/src/types/bot.ts) (the narrowed `Bot`
interface, D-14) is the real contract; `src/` has **zero runtime imports** of the fake (only comments +
the `CreateBot` seam type — confirmed by the panel), so removing the world-model half touches only tests.
Non-bot fakes (`fake-settlement`, `memory-journal`, `vector-store`) **stay** — they back T1 and are not
FakeBot.

### 3.2 The real count (panel correction)
**20 files import `fakes/fake-bot`, not 21** — `village-launch.test.ts` has its *own* local FakeBot (false
positive) and stays T1. Of the 20: **~8 → T2** (real API surface: `skills-engine`, `skills-exemplars`,
`bots-hardening/helpers/anchors ±cov`, `god-body`); **~12 stay T1** (event-bus / lifecycle / mock-LLM:
`bots-signals`, `villagers-events/routing/host-reactivity/brain/tools`, `bots-pool ±cov`, `loop-integration`,
`gate` — the last two re-pointed to the RecordingBot + scripted-LLM stub so the M3/M4 convergence proof
stays deterministic).

---

## 4. Infra: the CI environment

The blocker is that T2/T3 need a **Minecraft 1.21.1 server + a local LLM + resources** that GitHub-hosted
runners (2-core/7 GB, no GPU) can't reliably provide. The realistic model:

### 4.1 A self-hosted runner (recommended)
A **self-hosted GitHub Actions runner** on a machine that already has the MC server + a local model
(Paul's Windows box is the obvious first host — it runs the dev server on `:25599` and can run LM Studio).
- Pros: free (no cloud GPU), the model + server are already installed, matches the dev loop 1:1.
- Cons: not ephemeral (state hygiene between runs matters), single point of failure, Windows-specific
  paths (the harness already handles Windows `taskkill`, [run.ts:45](../eden/live-tests/run.ts)).
- **Owner decision Q2 (§12):** self-hosted Windows runner vs. a Linux box vs. GitHub-hosted + a hosted
  local-model endpoint.

### 4.2 The Minecraft server lifecycle (NEW — the harness assumes one is up)
Today the harness reads `run/server.properties` and connects; nothing starts the server. CI needs a
**server bring-up + teardown** step:
- A pinned **Fabric 1.21.1** server, **flat world**, **fixed `level-seed`**, `enable-rcon=true`, a fixed
  RCON password, `online-mode=false` (bots log in offline), `spawn-protection=0`, `force-gamemode=false`
  (the arena pins gamemode per-bot, [farm-wheat.ts:28](../eden/live-tests/scenarios/farm-wheat.ts)).
- **Milestone A needs no Java mod** (solo, no trade). **B/C need the `paulsbrawls` Fabric mod** for the
  `:8767` settlement + `coin` — build it with `./gradlew build` and drop the jar in `mods/`. Stage the
  mod in only when we reach B (§8).
- A CI action wraps: start server → wait for RCON ready → run T2 (once) then T3 scenarios → stop server.
  The dev-server `./gradlew runServer` steals `:8767` (R29) — the mod-in-server model avoids that clash
  for B/C.
- **World reset between runs:** re-seed or wipe the world each CI run so a prior run's blocks/inventory
  can't poison determinism (R32 world-stamp already quarantines cross-world memory; CI should start clean).

### 4.3 The local model
- `providers.json` already has a keyless **`local`** preset (`http://127.0.0.1:1234/v1`, 32k/16k,
  [providers.example.json:12](../eden/providers.example.json)). CI fills in the served model name.
- **LM Studio or Ollama**, OpenAI-compatible **chat-completions with tool/function calling** — the brain
  and desks depend on `tools` + `toolChoice` forcing ([critic.ts:142](../eden/src/god/critic.ts),
  R52/R68). **The model MUST support forced tool calls** or the loop stalls. **Owner decision Q3 (§12):**
  which model (must be tool-calling-capable and strong enough to author — see §5.4 risk).
- **Determinism:** set `temperature: 0` (and `seed` if the endpoint honors it). Verify `llm/client.ts`
  passes these through; add them if not (a small client change).

### 4.4 Embeddings
- Memory retrieval degrades to the **keyword floor (R38)** when embeddings are absent — so CI can run
  **without an embedding model** (`vectorStore` off / no embeddings provider). Recall precision drops but
  the loop works. **Recommended for CI reliability.** Alternatively serve a local embedding model
  (`@xenova/transformers` runs locally/free — already a dependency). **Owner decision Q4 (§12):** keyword
  floor vs. local embeddings in CI.

---

## 5. Determinism & reliability — solved by removing the model (Q6)

**The master lever is Q6: no LLM in the loop.** With the villager model out of CI, T2 is deterministic —
the only inputs are the RCON arena and scripted skill args; the only oracle is the RCON world + the
paired-test flip. The panel's whole "temp-0 isn't determinism / local-model can't author" risk class
**does not apply to the CI gate** (it only applied to the now-de-scoped LLM scenarios). What remains is
*mineflayer + server* determinism:

### 5.1 Outcome-based assertions (kept)
Assert **objective world facts** (RCON `inventoryCount ≥ N`, the paired-test verdict) + **journal folds**
(a `skill.run{ok}` exists), never exact code. **Split the assert:** a *hard oracle* (RCON world / flip)
fails the gate; a *soft signal* (incidental `system.error` count) is a warning, **not** a fail — the
current `errs.length === 0` clause ([farm-wheat.ts:57](../eden/live-tests/scenarios/farm-wheat.ts)) is a
flake amplifier (a met objective can red on one benign error). Only *fatal* events (assignee `world.death`,
host crash, unhandled reject) fail.

### 5.2 Deterministic arena + world (the panel's missing levers)
Fixed `level-seed`, flat world, RCON arena applied before each case, **`gamerule randomTickSpeed 0`**
(+ `doFireTick false`, `doInsomnia false`, `mobGriefing false`, `doTraderSpawning false`) on top of the
existing `PEACEFUL_RULES`, per-bot gamemode pinned, and a **world wipe + `kill @e[type=item]` + fresh
`.eden-data` between cases** (R32 is a no-op in CI — the harness already uses a fresh data dir per run;
the real need is wiping the *Minecraft* world). A **pre-case arena health check** (RCON-assert the
expected blocks exist) fails fast + legibly if the world is corrupt.

### 5.3 Timing under CI load (the historical flake class)
`docs/20` documents pathfinder/`activateBlock`(R55)/drop-pickup timing as the flake source; under a busy
self-hosted runner these *stretch*. **Replace fixed sleeps with poll-until-confirmed on RCON/journal
ground truth** (the R55 pattern — extend it), and **isolate the server from any co-located inference**
(if a model is ever on the same box for the manual suite, pin CPU affinity) so load can't starve the
physics/keepalive path (a starved loop reads as the finding-W wedge).

### 5.4 Flake policy
- **T1:** no retries — a red is a red.
- **T2 (blocking, no LLM):** retry **only** on a *classified-transient infra fault* (bot-connect timeout,
  RCON refused, chunk-not-loaded), detected by error class, and **journal the retry** (visible, R36).
  **Never** retry an *outcome* miss (wrong world state) — that's the signal. Target **<1% flake**; above
  that is a P1 test bug, not something to retry-launder.
- **The de-scoped LLM suite:** no gate, so no flake policy — it's run on demand and read as telemetry.
- Distinguish *infra timeout* (runner overloaded → retry/skip-with-warning) from *scenario timeout*
  (genuine non-convergence → fail); today [run.ts](../eden/live-tests/run.ts) collapses both to FAIL.

---

## 6. Interaction with D-16 (the paired-test gate) — now tightly coupled

D-16's paired tests **read more world than skills** (open chests, scan crops, event-traces) — *exactly
what FakeBot could not model* ([22 §5.3](22-godfree-skill-loop.md)). Under the no-LLM CI (Q6), the coupling
becomes direct and load-bearing:

- **T2 *is* the D-16 gate, run without the authoring model.** For each skill CI executes the same
  `submit_skill` flip (`T(pre) → S → T(post)` + `Sδ` + `check`) — just with **scripted args instead of an
  LLM-authored draft**. So T2 validates the D-16 gate mechanism *and* every stock skill's paired test in one
  pass. This is the plan's highest-leverage outcome and it exists **only because** of D-16.
- **Land the D-16 gate at CI-4, before the T2 skill cases are written** (panel F5), so they assert the
  **mechanical flip oracle**, never the retired `god.verdict`. [22 §7](22-godfree-skill-loop.md)'s
  `submit_skill`/`reflect`/`readComposable`/`skill.self-verdict` are prerequisites of the T2 catalogue.
- **Milestone A splits:** its *skills + paired tests* are validated deterministically in T2 (no LLM); its
  *authoring* (villager writes them from scratch) lives in the de-scoped `npm run live-test` suite, run on
  demand — never a CI gate.
- D-16's tests are **born real** — do not hand-write RecordingBot world-model tests for them; the
  world-effect asserts run against a real bot in T2.

---

## 7. Dependency-law & simplicity fit

- T2's real-bot harness lives under `eden/tests/` (or a new `eden/tests/live/`), imports `src/` downward
  only — no layer violation ([.dependency-cruiser.cjs](../eden/.dependency-cruiser.cjs) rules T1 already
  satisfies). The bot is created via the same `BotPool` path the host uses, not a bespoke connector (S3).
- Adding a scenario stays a **registry row** ([catalogue.ts](../eden/live-tests/catalogue.ts), S1).
- Behavior + docs in the same commit (S8): deleting FakeBot updates [16-m0-reference](16-m0-reference.md)
  and every doc that says "validated against FakeBot" in the same PR.

---

## 8. Build sequence — FINAL (Q1 + Q6 resolved; supersedes §11.2)

Each step is independently verifiable; ⛔ = do-not-parallelize-past-it. **No LLM anywhere in this DAG.**

- **CI-0 — Server-in-CI lifecycle.** A CI action: reap orphan `java`/`node` + free ports 8770/8767 →
  **wipe the MC world** (dedicated `level-name=ci_world`, flat, fixed `level-seed`) + fresh `.eden-data`
  → start Fabric 1.21.1 (RCON on) → **poll RCON `list` until a valid reply** → the `randomTickSpeed 0`
  + peaceful gamerule baseline. Verify: `npm run live-test -- farm-wheat` green against the CI-started
  server. ⛔ (everything needs a server that exists and is *ready*).
- **CI-1 — RecordingBot split.** Extract `RecordingBot` (recorders + fault-injection setters) from FakeBot;
  keep the R4-order / R66-identity / stall / R55 / D1 asserts as fast **T1** tests on it; move the
  `types/bot.ts` conformance proof onto it. Verify: those asserts pass with no server. ⛔ (before deleting
  FakeBot's world-model half).
- **CI-2 — T2 harness.** Its **own** `T2Case[]` catalogue (NOT the `Scenario` interface — no `tasks`/god);
  spawn a real bot via **`BotPool`** (single-member roster, no bespoke connector — S3); no LLM. Port
  `skills-engine` + `skills-exemplars` first (the highest FakeBot-divergence surface). ⛔ (the FakeBot
  replacement).
- **CI-3 — Land the D-16 gate** (`submit_skill`/`reflect`/`readComposable` + `skill.self-verdict`, from
  [22 §7](22-godfree-skill-loop.md)) so the skill cases assert the **mechanical flip oracle**, not
  `god.verdict` (panel F5). Reconcile the CI profile's token budget (the 48k/32k issue is moot for the
  no-LLM gate, but keep the reserve invariant honest). ⛔.
- **CI-4 — The skill + paired-test catalogue (the core deliverable).** One `T2Case` per library skill:
  RCON precondition arena + scripted args → run `S` → run `T` → assert (a) no real-mineflayer throw, (b)
  the flip holds, (c) the test is honest (truth-table rows). Covers every stock skill. Verify: green +
  reproducible across two runs.
- **CI-5 — Port the rest + split back.** The remaining ~6 API-surface files → T2; the ~12 pure-logic
  files → **stay T1** (re-point `gate`/`loop-integration` to RecordingBot + a scripted-LLM stub so the
  **M3/M4 convergence proof stays deterministic** — panel F2). Verify: no test imports the old FakeBot.
- **CI-6 — Wire the CI jobs + delete the world-model half.** **T1 blocks per-push** (GitHub-hosted,
  seconds); **T2 is merge-gated** (self-hosted, `concurrency` group, world reaper). Delete FakeBot's
  world-model code + `fakes.test.ts`; for the B/C settlement mod, build with **`-Pmods_folder=<ci-server>/mods`**
  (never the hardcoded production path — panel F5). Update docs (16/19/20/CLAUDE.md). ⛔ (after CI-5).

The **LLM authoring/scenario suite** (`npm run live-test`) is retained but **out of CI** — run on demand.
T1 is untouched throughout (the fast per-push gate never regresses).

---

## 9. What could go wrong (risk register)

**Q6 (no LLM in CI) dissolves the whole LLM-reliability risk class** — ~~RK1 (local-model capability)~~,
~~RK5 (forced tool-calling)~~, and the temp-0 / 32k-token risks are **moot on the CI critical path** (they
survive only for the manual `npm run live-test` suite). What remains is server + mineflayer + coverage:

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| RK2 | **CI runtime** — even no-LLM, a real skill case is seconds–minutes ×N skills | Med (was High) | no LLM ≫ faster; T2 merge-gated not per-push; parallelize independent skills across bots; per-case wall |
| RK3 | **Self-hosted runner state bleed** (orphan java/node, held ports, dirty world) | **High** | CI-0 reaper + world-wipe + fresh `.eden-data` per run + RCON-ready poll; `concurrency` group so runs never share the server |
| RK4 | **Coverage loss** from FakeBot — the ~8 order/fault asserts | Med | **resolved by Q1** (RecordingBot keeps them as fast T1 tests); coverage report gate before/after |
| RK6 | **Mineflayer timing** (chunk load, pathfinder, R55) stretches under runner load | Med | poll-until-confirmed on RCON/journal (not fixed sleeps); classified-transient retry only |
| RK7 | **Windows-runner specifics** (paths, taskkill, gradle copy) | Med | harness Windows-aware; **`-Pmods_folder` override** so the gradle copy never hits production (F5); or containerize the server on Linux |
| RK8 | **Java-mod coupling for B/C** (`:8767`) adds a JVM build | Med | Milestone A needs no mod; stage it only at B with the `-Pmods_folder` override + `~/.gradle` cache |
| RK10 | **Skill-case completeness** — a new stock skill ships with no T2 case → silent coverage gap | Med | CI check: every stock skill MUST have a `T2Case` (S1 completeness gate, Q7) |

---

## 10. Deliverables when built
- `eden-ci.yml`: **T1 per-push** (GitHub-hosted) + a **T2 merge-gated** job (self-hosted server, no LLM)
  with the CI-0 lifecycle (reaper + world-wipe + RCON-ready).
- A **`RecordingBot`** (split from FakeBot) carrying the R4-order / R66-identity / stall / R55 / D1 asserts
  as fast T1 tests + the `types/bot.ts` conformance proof.
- A **T2 real-bot harness** with its own `T2Case[]` catalogue (reuses `BotPool`) and **a case per stock
  skill** running the D-16 `S→T` flip, no LLM; the ~8 API-surface files ported.
- FakeBot's **world-model half + `fakes.test.ts` deleted**; the ~12 pure-logic files kept in T1
  (gate/loop re-pointed to RecordingBot + a scripted-LLM stub); docs updated (S8: 16/19/20/CLAUDE.md).
- The de-scoped **`npm run live-test`** LLM suite retained as a manual capability tool.
- This doc + [22](22-godfree-skill-loop.md) cross-referenced (T2 = the D-16 gate exercised without the
  authoring model).

---

## 11. Review panel (subagents, different angles)
Before committing, the plan is reviewed by independent subagents:
1. **CI/infra feasibility** — is a self-hosted server + local model actually reliable/reproducible?
2. **Coverage & test-value** — does deleting FakeBot lose real coverage; is the T1/T2 split right?
3. **Determinism/flakiness** — will T2/T3 be a *reliable gate* or a red-herring generator?
4. **Local-model capability** — can a free local model pass T3a (and ever T3b)?
5. **Architecture/D-16 fit** — dependency law, simplicity rules, and the D-16 sequencing.

Their findings append to §11.1 and revise the plan.

### 11.1 Panel findings (5 reviewers, 2026-07-01)

**Strong consensus — the plan needs three reshapes:**

1. **Take the LLM out of the blocking gate.** Determinism, local-model, and infra reviewers all
   independently concluded: a real-LLM-in-loop scenario cannot be a reliable *per-push* pass/fail gate.
   The **reliable blocking gate is T2 — a real mineflayer bot driven by *scripted* inputs, no LLM** —
   which still kills the Z/C/D1/D2/E class *and* can hit <1% flake. **All LLM-in-loop scenarios (T3a
   *and* T3b) → a nightly pass-rate SLO** (≥80% over N runs), never single-run pass/fail. My T3a
   "blocking" call was wrong.
2. **`temperature:0` is not determinism — and isn't even wired.** `llm/client.ts` (lines 237-246) sends
   only model/messages/tools/tool_choice; there is **no `temperature`/`seed`** in the client, request
   type, or provider config. Local stacks aren't run-to-run deterministic even at temp 0 (batching,
   non-associative GPU reductions, KV-cache reuse). **Reliability must come from the outcome oracle
   (RCON world facts), not the sampler.** Wire `temperature:0` anyway (lowers variance) as a real build
   task, not a "verify."
3. **Don't eradicate FakeBot *wholesale* — split it.** The real importer count is **20, not 21**
   (`village-launch.test.ts` has its own local FakeBot — false positive). Of those, **only ~8 exercise a
   real mineflayer API** worth a live port (`skills-engine`, `skills-exemplars`, `bots-hardening/helpers/
   anchors ±cov`, `god-body`). The other **~12** are event-bus / object-lifecycle / mock-LLM tests that
   should **stay T1**. Three coverage classes are **structurally unreproducible on a real server** and
   would be silently lost: the **R4 abort sequence-order** assert, the **R66 kick-storm identity** test,
   and the **deterministic fault-injections** (`setDigMode('never')` stall, the W/CRIT-1 canary, the R55
   `setActivateDelayMs` race, the D1 `setUnknownItems` miss). The panel's fix: keep a **`RecordingBot`**
   (the `calls[]`/`clicks[]`/fault-injection seams as *fast* unit tests) and delete only FakeBot's
   *world-model* half. → **Owner decision, §12 Q1, sharpened below.**

**High-value distinct catches:**
- **Server lifecycle is ~80% of the real work and does not exist.** The harness only polls
  `system.bot-connected` (no RCON-ready gate); `run/server.properties` is `level-type=normal` + **empty
  seed** with a **persistent `run/world/`** (my "flat/fixed-seed" claim was aspirational, not current).
  Real CI-0 = kill orphans → **wipe the MC world + fresh `.eden-data`** → start → **poll RCON `list`
  until a valid reply** → run. R32's world-stamp is a **no-op in CI** (the harness already uses a fresh
  `.eden-data` per run) — *not* a safety net; the real need is wiping the Minecraft world for determinism.
- **CI wall-clock is not viable per-push.** One scenario worst-case ~8-9 min (`timeoutMs 300k` +
  `KILL_GRACE 200k`); T2+T3a ≈ **35-50 min single-threaded on one box.** → only **T1 blocks per-push;
  T2 (+ any gated LLM tier) is merge-gated / PR / label-triggered**, with a workflow `concurrency` group
  so runs never share the one server.
- **Gradle hazard:** `copyToMods` in `gradle.properties` is **hardcoded to the production
  `PaulsBrawlsVanilla/mods`** — a naive `./gradlew build` on the runner (for the B/C settlement mod)
  would **hot-swap the live server's jar**. Must build with `-Pmods_folder=<ci-server>/mods`.
- **`gate.test.ts` + `loop-integration.test.ts` are the *deterministic* M3/M4 convergence proofs**
  (ScriptedLlm + `bot.give`), not thin body tests. Moving them to a live-LLM tier downgrades the
  load-bearing "M3 is the gate" guarantee to a flaky nightly. **Keep a scripted-LLM convergence test in
  T1.**
- **D-16 sequencing inversion:** Milestone A is *defined by* [22 §8.1](22-godfree-skill-loop.md) as a
  D-16 acceptance test (PASS requires **zero `god.verdict`**), yet the DAG put Milestone A at CI-4 and
  D-16 at CI-6 — so you'd encode the *critic* oracle then rip it out. **Land the D-16 mechanical gate at
  CI-4, before the flagship;** move FakeBot deletion to last (pure cleanup — `src/` has **zero runtime
  imports** of the fake, only comments + the `CreateBot` seam type, so "delete fake, keep seam" is
  confirmed coherent).
- **Local model reality:** a free local model reliably driving the loop needs a **32B-class tool-tuned
  model** (Qwen2.5-Coder-32B / Llama-3.3-70B) + a **grammar-constrained runtime** (vLLM guided-json or
  llama.cpp/LM Studio GBNF; Ollama is weakest at *forced* `tool_choice`) + a **~24 GB-VRAM GPU floor**.
  "Free" = already-owned GPU + self-hosted, *not* "runs on the GitHub runner." Upgrade **RK5 (tool-JSON-
  as-text, R52/R68) Med→High** and make the CI-1 forced-tool probe a **blocking** pre-flight (the client
  has no repair path — a narrated call → empty `toolCalls` → `brain.ts:150` closes as implicit `done`).
- **Token-budget bug:** the `local` preset is **32k**, but [22](22-godfree-skill-loop.md)'s density
  reserve is **48k** and the payload is never-trimmed + the client only *observes* budget → a long
  self-debug session **400s on `context_length_exceeded`.** Reconcile (local strong ≥48k, or shrink
  `maxSkillLines`/capabilities ceiling for the CI profile).
- **Factual corrections:** default live provider is **`deepseek` (paid)**, not `local` — CI must set
  `--provider local` explicitly; the providers file is **`eden/providers.json`** (loaded by
  `config.ts:44`), not `live-tests/providers.json`; **T2 does not fit the `Scenario` interface** (no
  `tasks`/god `assert`) → it needs its **own tiny `T2Case[]` catalogue**, and must reuse **`BotPool`**
  (single-member roster), never a bespoke `createOneRealBot()` (S3/S5); §7's dependency-law reassurance
  is **false** — `depcruise` only scopes `src/`, so `tests/` is never graphed (the true rule: shared
  real-bot bootstrap must live under `tests/`/`live-tests/`, never `src/`).

### 11.2 Corrected build DAG (panel-revised)
```
CI-0  Server-in-CI: kill orphans → wipe MC world → fresh .eden-data → start →       ⛔
        poll RCON `list` until valid → run.  (flat, fixed level-seed, RCON, reaper)
CI-0.5 Wire temperature:0(/seed) through ProviderConfig→LlmRequest→wireBody (+test).
CI-1  Local model + BLOCKING forced-tool-call probe; set provider=local explicitly    ⛔
        (not the deepseek default); reconcile 32k vs 48k context.
CI-2  T2 real-bot harness — OWN catalogue, reuse BotPool, NO LLM. Port                 ⛔
        skills-engine + skills-exemplars first (the divergence catch).
CI-3  Port remaining API-surface files to T2; split ~12 pure-logic files back to T1;
        KEEP a scripted-LLM convergence test in T1 (gate/loop determinism stays fast).
CI-4  Land the D-16 mechanical gate in the loop (submit_skill/reflect/self-verdict)    ⛔
        BEFORE the flagship, so Milestone A asserts the gate oracle, not god.verdict.
CI-5  Promote to CI: T1 blocks per-push; T2 (+scripted convergence) merge-gated;
        T3a/T3b LLM scenarios → nightly pass-rate SLO. Milestone A = flagship.
CI-6  Resolve FakeBot per Q1 (split→RecordingBot, or wholesale delete); grep clean;    ⛔
        docs (16/19/20/CLAUDE.md). Pure cleanup — src has no runtime import of it.
T1 (~46 pure-logic tests) untouched throughout — the fast gate never regresses.
```

### 11.3 Owner decisions — RESOLVED (2026-07-01)
- **Q1 = RecordingBot split** (§3.1): delete FakeBot's world-model half, keep a slim RecordingBot for the
  ~8 unreproducible order/fault asserts, port the ~8 API-surface files to T2.
- **Q6 = no LLM in CI** (§2): CI runs **every skill + its paired test without a villager LLM** on a real
  server (T2) + a no-server pure-logic tier (T1). The real-LLM authoring suite is **de-scoped from CI** to
  a manual/on-demand tool. This **dissolves the panel's entire LLM-reliability risk class** (RK1 local-model
  capability, RK5 forced-tool-calling, temp-0 determinism, 32k-vs-48k token budget) — none are on the CI
  critical path anymore.

The panel's non-LLM fixes are folded into the final plan (§2, §3.1, §5, §6, §8): CI-0 server lifecycle
+ reaper + world-wipe + RCON-ready, `randomTickSpeed 0` baseline, split-assert (hard oracle vs soft
error), gradle `-Pmods_folder`, T2's own `T2Case[]` catalogue reusing `BotPool`, the D-16-gate-before-
skill-cases reorder, keeping the scripted-LLM convergence proof in T1, and the dependency-law correction
(depcruise scopes `src/` only).

---

## 12. Owner decisions
- ✅ **Q1 — RESOLVED = RecordingBot split** (§3.1).
- ✅ **Q6 — RESOLVED = no LLM in CI** (§2); this also resolves **Q5** (blocking policy: T1 per-push +
  T2 merge-gated; no LLM tier gates), and makes **Q3** (which local model) + **Q4** (embeddings) **moot
  for CI** — they matter only for the de-scoped manual `npm run live-test` suite.
- ✅ **Q2 — RESOLVED = the auto-opened `run/` dev server.** CI opens `./gradlew runServer` (the Fabric
  **mod's own** dev server in `run/`), spawns a real mineflayer bot, and drives every skill + paired test
  with CI code — no LLM, no GPU. Because it's the mod's server, settlement (`:8767`) / `coin` / op-on-join
  are present with **no jar build/copy** (the F5 production-jar hazard is avoided entirely), and it's the
  dev port, never production. The clean end-state spec is **[24-realbot-ci-final-product](24-realbot-ci-final-product.md)**.
- **Q7 — new, small:** does the T2 skill catalogue enumerate skills **from the live library at runtime**
  (every stock + admitted skill gets a case automatically) or from a **hand-maintained `T2Case[]`** (each
  skill's precondition arena + args are non-trivial, so some hand authoring is unavoidable)? Recommended:
  hand-authored `T2Case` per skill (the arena/args can't be inferred), with a CI check that **every stock
  skill has a case** (S1 completeness — a new stock skill without a T2 case fails the check).
