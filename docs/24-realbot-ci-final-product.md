# 24 — Real-mineflayer CI: the final product & full changelist

**What this doc is.** A **specification of the end state** — what the finished system *is* and the
complete list of what changes to get there — with **no implementation detail** (no build steps, no code,
no file-by-file how-to). Its purpose is to give a **fresh session the full context to write the
implementation plan.** The reviewed build analysis + rationale live in
[23-real-mineflayer-ci-plan](23-real-mineflayer-ci-plan.md) (5-subagent panel, owner decisions Q1/Q6);
this doc is the clean contract distilled from it.

**How to read it:** §1 is the context a newcomer needs; §2–§5 describe the finished product; §6 is the
exhaustive changelist (created / changed / deleted / prerequisite); §7 is the acceptance criteria that
define "done"; §8–§10 scope, dependencies, and the questions the implementation plan must answer.

---

## 1. Context (self-contained)

**Eden** is the AI-village brain: ten LLM-driven villager bots + one God, acting through **one shared,
success-gated library of skills** — typed `async (bot, args, ctx)` functions written against the *full,
unwrapped* mineflayer API. It runs as one Node process; the Java Fabric mod provides server-authority
(trade settlement on `:8767`, the `coin` item, op-on-join).

Three facts this spec builds on:

1. **D-16 — the paired-test gate ([22](22-godfree-skill-loop.md)).** Every skill `S` ships a second
   **test** skill `T` of shape `async (bot, args, ctx) → { verdict: 'worked' | 'nothing-to-do' | 'failed',
   evidence }`. A mechanical, LLM-free gate admits `S` by a **pre→skill→post flip** corroborated by the
   engine's own before/after world snapshots (`Sδ`) plus the task's objective `check`. The verdict enum
   is the crux: **`worked`** = goal predicate holds, **`nothing-to-do`** = preconditions to act are
   absent (a correct no-op, not a defect), **`failed`** = preconditions present but goal unmet. *(D-16 is
   a prerequisite of this work — see §9.)*

2. **FakeBot** — today a no-Minecraft stand-in for a mineflayer bot backs ~20 test files. It is the
   source of a recurring, expensive false-confidence class (the **Z/C/D1/D2/E** findings): a skill green
   against the fake but broken on the real API (`bot.X is not a function`, `Vec3.distanceTo` on a
   plain-object position, the `findBlock` palette pre-check, `activateBlock` timing). The fake is written
   by the same person who is wrong about the API, so it structurally cannot catch these.

3. **The live harness + the `run/` server.** `eden/live-tests/` already drives real bots against a real
   server (RCON builds a deterministic arena → boots a real Eden host → asserts via RCON world facts +
   journal folds). The **`run/` dev server** (`./gradlew runServer`) is the Fabric **mod's own dev
   server** — so it already carries the settlement listener (`:8767`), `coin`, and op-on-join, and runs
   on the dev port in `run/server.properties` (never the production `PaulsBrawlsVanilla` server).

---

## 2. The final product (end state)

> **CI auto-opens the `run/` Minecraft server, spawns a real mineflayer bot, and drives — with CI code,
> no LLM — every skill and every paired test through the real mineflayer API, confirming each works both
> WITH the resources it needs and WITHOUT them. Green means the entire skill library and its paired-test
> oracles are proven correct against a real server. A separate, unchanged, no-server tier proves the pure
> logic in seconds.**

Concretely, when this is done:

- A push runs a **fast, no-server logic gate** (seconds) — unchanged pure-logic unit tests plus the
  order/fault-injection asserts that only a recorder can express.
- A merge (or a labelled/scheduled run) **auto-starts the `run/` dev server**, waits until it is genuinely
  ready, **spawns one real mineflayer bot**, and **CI code enumerates the library and executes every
  skill + its paired test** against the live world — no villager LLM anywhere. Each skill is exercised in
  **two worlds: resourced and unresourced** (§3). The server is reset to a clean, deterministic state
  before the run and torn down after.
- **No model, no GPU, no API key** is needed for CI. The only heavy dependency is the JVM/`run/` server,
  which the CI host already runs. The real-LLM authoring loop is validated separately, on demand, and is
  **not** a CI gate.
- The result the team relies on: **"the library works on real mineflayer" and "the paired tests are
  honest oracles" are continuously, deterministically proven** — the two things FakeBot could never prove
  and the D-16 gate depends on.

---

## 3. The testing model — "with or without resources" (the core idea)

Because every skill ships a paired test (D-16), CI does not need an LLM to know whether a skill worked —
it sets up the world, runs `S`, runs `T`, and reads the flip. The finished product tests **each skill in
two worlds**, which map exactly onto the D-16 verdict enum:

| World | Setup (via RCON) | Expected `T(pre)` | Run `S` | Expected `T(post)` | What it proves |
|---|---|---|---|---|---|
| **Resourced** | preconditions present (items given, target blocks placed, mobs summoned) | `failed` (goal not yet met) | acts; world changes (`Sδ` non-empty) | **`worked`** | the skill *can do its job* on the real API — **capability** |
| **Unresourced** | preconditions absent (inventory cleared, no targets) | `nothing-to-do` | correctly no-ops (`Sδ` empty, **no throw, no false success**) | **`nothing-to-do`** | the skill *doesn't crash or lie* when it can't act — **robustness / anti-fraud** (R72 blocked-on-resource + the D2 "success from a precondition already true" fraud, made mechanical) |

On top of those two worlds, CI confirms the **paired test itself is honest** (the D-16 truth table),
independent of any LLM:

- A test that reports `worked` **before** `S` ran (precondition already true / constant test) is
  **rejected** — the CI case fails, flagging a bad test.
- A test that reports `worked` while the engine saw **zero `Sδ`** is **rejected** (the test lies).
- A `nothing-to-do` contradicted by a **non-empty `Sδ`** is **rejected** (the lazy-test escape).
- A skill that **throws** on the real API in either world fails the case (the Z/C/D1/D2/E catch).

This dual matrix is the whole point: it validates **both the skills and their tests**, in both the
have-resources and no-resources conditions, deterministically, without a model.

---

## 4. The two-tier CI estate (end state)

| Tier | Contents | Server? | LLM? | Cadence |
|---|---|---|---|---|
| **Logic tier** | the ~46 pure-logic unit tests (scheduler, context-pack, memory, journal, views, config, desks-with-scripted-LLM, retrieval, vectors, admin, social) **plus** the order/fault-injection asserts on the recorder (§5) **plus** a scripted convergence proof (keeps the M3/M4 gate deterministic) | none | none / scripted stub | every push |
| **Skill tier (real mineflayer)** | for **every library skill**: the resourced + unresourced paired-test matrix (§3) **plus** the ~8 ex-FakeBot files that exercise a real mineflayer API surface (engine, stock skills, hardening/helpers/anchors, avatar) | the auto-opened `run/` dev server | **none** | merge / labelled / scheduled |

Retained but **outside CI:** the real-LLM authoring/scenario suite (`npm run live-test`) — a manual
capability tool, run on demand, never a gate.

---

## 5. The FakeBot split (what survives, what goes)

FakeBot is **split, not wholesale-deleted**, because ~8 assertions are structurally unreproducible on a
real server and would be silently lost:

- **Kept — a slim `RecordingBot`** (a lightweight recorder, part of the logic tier, no server): carries
  the assertions a real bot cannot express or force —
  - the **abort sequence-order** (R4: `collectBlock.cancelTask → pvp.stop → pathfinder.stop → setGoal(null)
    → closeWindow` — a real bot only shows end-state, which passes even if the order is wrong);
  - the **duplicate-login kick-storm identity** guard (R66 — a dead session can't be re-fired on a real
    server);
  - the **deterministic fault-injections**: a dig that hangs forever (the stall detector's core case), the
    macrotask-starvation canary (W / CRIT-1), the read-after-write race (R55), and the unknown-item
    registry miss (D1).
  It also carries the compile-time proof that the recorder conforms to the `Bot` seam.
- **Deleted — FakeBot's world-model half**: the synthetic `blockAt`/`findBlocks`/`activateBlock`
  flip rules, palette pre-check, and container store — everything the **real bot replaces** in the skill
  tier.

The `Bot` interface seam itself is untouched (a real mineflayer bot satisfies it; nothing in `src/`
imports the fake).

---

## 6. The full changelist (deliverables)

### Created
- **`RecordingBot`** — the slim recorder/fault-injection stand-in extracted from FakeBot (§5), carrying
  the R4/R66/stall/W-CRIT-1/R55/D1 assertions as fast logic-tier tests + the `Bot`-seam conformance proof.
- **The skill-tier harness** — CI code that boots against the auto-opened `run/` server, spawns one real
  mineflayer bot (through the existing bot-pool path, not a bespoke connector), and drives skills through
  the real engine with scripted args — **no LLM.** It has its **own catalogue** (distinct from the
  LLM-scenario harness, which is task/God-shaped).
- **A per-skill case set** — for every library skill, the **resourced + unresourced** paired-test matrix
  (§3), including the RCON world-setup for each condition and the honesty checks. Every stock skill has a
  case; the design intent is that a **new stock skill without a case is a CI failure** (completeness).
- **A deterministic CI server profile** — the `run/` server configured for reproducibility for a CI run:
  flat, fixed world seed, RCON enabled, peaceful + frozen-tick gamerules, dedicated CI world name.
- **A server lifecycle for CI** — auto-open the `run/` server, **wait until it is genuinely ready** (not
  merely "port open"), reset the world + Eden data to a clean state before the run, and tear everything
  down + reap orphans after. *(What it must accomplish is specified here; how is the implementation plan's
  job.)*
- **Two CI jobs** — a per-push logic job (no server) and a merge/labelled/scheduled skill job (real
  server, no LLM), replacing the current single fakes-only job.

### Changed
- **The test estate is re-tiered:** the ~8 real-API files move to the skill tier; the ~12 event-bus /
  object-lifecycle / mock-LLM files stay in the logic tier (two of them — the convergence proofs —
  re-pointed to the recorder + a scripted-LLM stub so the M3/M4 gate stays deterministic).
- **The CI workflow** gains the skill job and the server lifecycle; the logic job stays fast/no-server.
- **Assertions become split-severity:** a hard oracle (RCON world fact / the paired-test flip) fails the
  gate; an incidental non-fatal error is a warning, not a fail (only fatal events — assignee death, host
  crash, unhandled rejection — fail).
- **The CI host is fixed as the `run/` dev server** (the mod's own server), so settlement/`coin`/op-on-join
  are present with no separate jar handling, and the production server is never touched.

### Deleted
- **FakeBot's world-model half** + the test that tests the fake (`fakes.test.ts`).
- No pure-logic coverage is dropped (Q1 = split, not wholesale delete).

### Prerequisite (must land first — see §9)
- **The D-16 mechanical gate** (`submit_skill` / `reflect` / the highest-active composition resolver / the
  self-verdict journal record) and **paired tests shipped for the stock skills** — the skill tier asserts
  the D-16 flip oracle, so it cannot precede D-16.

### Explicitly not delivered here
- No change to the real-LLM authoring loop's *behavior*; it is only **de-scoped from CI**.
- No new test framework, no second bot-connection path, no GPU/model/API-key dependency in CI.

---

## 7. Acceptance criteria (definition of "done")

The finished product is achieved when **all** hold:

1. **A push** runs the logic tier with no server and no LLM, in seconds, and it is green.
2. **A merge/labelled/scheduled run** auto-opens the `run/` server, reaches a verified-ready state, spawns
   one real bot, and runs the skill tier to green — **with no LLM in the loop.**
3. **Every library skill** is exercised in **both** the resourced world (paired test flips to `worked`,
   `Sδ` non-empty) **and** the unresourced world (paired test stays `nothing-to-do`, `Sδ` empty, no throw,
   no false success).
4. **Every paired test is confirmed honest** against the D-16 truth table (no already-true `worked`, no
   zero-delta `worked`, no non-empty-delta `nothing-to-do`).
5. **No skill throws** on the real mineflayer API in either world (the Z/C/D1/D2/E class is caught).
6. **The recorder-backed asserts survive** (R4 order, R66 identity, stall/W-CRIT-1, R55, D1) as fast logic
   tests — no coverage lost to the FakeBot split.
7. **A new stock skill with no CI case fails CI** (completeness is enforced, not aspirational).
8. **Runs are reproducible** — the same commit against the same clean server yields the same pass/fail
   (guaranteed by: no model in the loop + a reset, fixed-seed, frozen-tick world).
9. **The server lifecycle is self-healing** — a prior crashed run cannot poison the next (orphans reaped,
   world + Eden data reset, ports freed).
10. **No FakeBot world-model code remains**, and no `src/` or test imports it.

---

## 8. Scope — retained vs. out

- **Retained, unchanged:** the ~46 pure-logic unit tests; the entire real-LLM authoring/scenario suite as
  a manual tool; the in-world God (persona, avatar, divine skills); the `Bot` interface seam; the
  mortal/divine tier boundary and its enforcement.
- **Out of scope:** any LLM in CI; any GPU/model/API-key dependency; changing skill *behavior*; the v1
  village and the Java AI-God; the production `PaulsBrawlsVanilla` server.

---

## 9. Dependencies & ordering constraints

- **D-16 must land first.** The skill tier is *defined* by the paired-test flip; it asserts the mechanical
  gate oracle, not the retired God verdict. So the D-16 gate + stock-skill paired tests are a hard
  prerequisite. The implementation plan sequences D-16 (or its gate portion) ahead of the skill-tier
  catalogue.
- **The `run/` server carries the mod.** Because CI opens the mod's own dev server, settlement/`coin`/
  op-on-join are available with no jar build/copy — this both satisfies trade-dependent skills and avoids
  the production-jar hazard entirely.
- **The recorder split precedes deleting the world-model half** (so the order/fault asserts never lapse).
- **The logic tier never regresses** — it is the always-on gate throughout.

---

## 10. Questions the implementation plan must resolve

These are deliberately left open here (they are *how*, not *what*):

- **Server readiness & reset:** what "genuinely ready" means operationally, and how the world + Eden data
  are reset to a clean, deterministic state each run (the current harness assumes a running server and
  only waits for a bot to connect).
- **Per-skill world setup:** how each skill's resourced/unresourced preconditions are expressed (the
  arena/args can't be inferred from the manifest) and how the "every stock skill has a case" completeness
  check is enforced.
- **Skill enumeration:** whether the catalogue is generated from the live library or hand-authored per
  skill (the panel leaned hand-authored, with a completeness gate).
- **Cadence & host:** exact trigger for the skill job (merge vs. label vs. schedule) and the self-hosted
  runner arrangement for the `run/` server (a `concurrency` guard so two runs never share the one server).
- **Ephemeral/ephemeral-effect skills:** how skills whose effect is a transient event (a kill, a pickup)
  are asserted (the D-16 event-trace), versus state-based skills read from snapshots.
- **Determinism knobs for the manual LLM suite only** (temperature/seed wiring) — irrelevant to the CI
  gate, noted so it isn't confused as a CI dependency.

---

## 11. Cross-references
- [22-godfree-skill-loop](22-godfree-skill-loop.md) — D-16, the paired-test gate + truth table (the
  mechanism this CI exercises).
- [23-real-mineflayer-ci-plan](23-real-mineflayer-ci-plan.md) — the 5-subagent panel review, the risk
  register, and the reviewed build DAG (the *why/how-analysis* behind this spec).
- [19-live-test-suite](19-live-test-suite.md) / [20-live-test-process](20-live-test-process.md) — the
  existing real-server harness this reuses.
- [07-hard-won-lessons](07-hard-won-lessons.md) — R1–R81, the assertions the recorder must keep alive.
