# 25 — Kickoff prompt: write the real-mineflayer CI implementation plan

Copy-paste the block below to start a fresh session whose sole job is to turn the **final-product spec**
([24](24-realbot-ci-final-product.md)) into an **ordered, step-by-step implementation plan**. It is a
planning session — it produces a plan doc, not production code.

---

You are working inside **Eden**, the AI-village brain (Node/TypeScript, `eden/`). Your task this session
is to **write an implementation plan, divided into ordered steps**, for replacing FakeBot with a
real-mineflayer, no-LLM CI that validates every skill and its paired test against the auto-opened `run/`
Minecraft server. This is a **planning + docs session** — produce the plan document; do **not** write
production code unless explicitly asked.

## 0. Read these first (in order), then verify against current code

The design is settled; your job is the *how*, sequenced. Read:

- **[docs/24-realbot-ci-final-product.md](24-realbot-ci-final-product.md)** — THE SPEC. The final product,
  the with-and-without-resources testing model, the full changelist (created/changed/deleted/prereq), and
  the acceptance criteria. Your plan must deliver exactly this. §10 lists the *how* questions you must
  resolve.
- **[docs/22-godfree-skill-loop.md](22-godfree-skill-loop.md)** — D-16, the paired-test flip gate + truth
  table. This is the **hard prerequisite**: the skill tier asserts the mechanical flip oracle, so the
  D-16 gate (`submit_skill` / `reflect` / the highest-active composition resolver / the `skill.self-verdict`
  record) + stock-skill paired tests must land before the per-skill catalogue.
- **[docs/23-real-mineflayer-ci-plan.md](23-real-mineflayer-ci-plan.md)** — the 5-subagent panel review,
  the risk register, and a reviewed CI-0…CI-6 DAG. Mine it for the concrete pitfalls (server readiness,
  world reset, split-assert severity, the gradle production-jar hazard, temp/seed being unwired, the
  dependency-law scoping fact). Your plan supersedes its DAG with a finalized one.
- **[docs/19-live-test-suite.md](19-live-test-suite.md)** + **[docs/20-live-test-process.md](20-live-test-process.md)**
  — the existing real-server harness (`eden/live-tests/`) you extend, and its historical flake classes.
- **[docs/07-hard-won-lessons.md](07-hard-won-lessons.md)** — R1–R81; especially the asserts the
  `RecordingBot` must keep alive (R4 abort order, R66 identity, the stall/W-CRIT-1/R55/D1 fault-injections)
  and the server/port lessons (R28 read `run/server.properties`, R29 `runServer` binds `:8767`).
- **[eden/CLAUDE.md](../eden/CLAUDE.md)** + **[docs/16-m0-reference.md](16-m0-reference.md)** — ground
  rules and the shipped module surface.

**Docs are point-in-time. Before you rely on any file:line or count, verify it against current code** —
in particular re-derive the FakeBot importer list and the ~8-port / ~12-stay / ~46-logic split yourself
(grep `fakes/fake-bot`), and confirm the live-harness + `run/server.properties` shape. Note drift in the
plan.

## 1. Decisions already made — do NOT relitigate (they are inputs)

- **Q1 = RecordingBot split.** Keep a slim recorder (calls/fault-injection seams + the `Bot`-seam proof)
  as fast no-server tests; delete only FakeBot's world-model half.
- **Q2 = the auto-opened `run/` dev server** (`./gradlew runServer`) is the CI host — it *is* the Fabric
  mod's own server, so settlement `:8767` / `coin` / op-on-join are present with **no jar build/copy**
  (do not reintroduce the `copyToMods` production-jar path); dev port, never production; no GPU.
- **Q6 = no LLM in CI.** CI runs every skill + its paired test with CI code, no villager model. The
  real-LLM authoring suite (`npm run live-test`) is retained but **out of CI**.
- Two tiers: a **logic tier** (per-push, no server) and a **skill tier** (real `run/` server, no LLM).

## 2. What the plan must contain

An ordered sequence of **independently verifiable steps** (mark ⛔ where a step must not be parallelized
past). For **each step** give: its **goal**, the **files/areas touched**, the **test or check that pins
it**, and its **definition of done**. The sequence must honor the one hard ordering constraint — **the
D-16 gate + stock paired tests land before the per-skill skill-tier catalogue** — and must cover, at
minimum, every item in [24 §6](24-realbot-ci-final-product.md#6-the-full-changelist-deliverables):

1. The **CI server lifecycle**: auto-open the `run/` server, a real **readiness gate** (verified ready,
   not just port-open), a **clean-state reset** each run (Minecraft world + Eden data), orphan/port
   reaping, and teardown. Resolve what "ready" and "reset" mean operationally.
2. The **RecordingBot split** (before deleting FakeBot's world-model half) so the R4/R66/stall/R55/D1
   asserts never lapse.
3. The **skill-tier harness**: its own catalogue (not the LLM `Scenario` shape), spawning a real bot via
   the existing bot-pool path (no bespoke connector), no LLM.
4. Landing the **D-16 gate + stock paired tests** (prerequisite for step 5).
5. The **per-skill catalogue**: the **resourced + unresourced** matrix ([24 §3](24-realbot-ci-final-product.md#3-the-testing-model--with-or-without-resources-the-core-idea))
   per skill, plus the truth-table **honesty checks**, plus a **completeness gate** (a new stock skill
   with no case fails CI). Resolve how per-skill preconditions are expressed and how skills are enumerated.
6. **Re-tiering** the current tests: port the ~8 real-API files to the skill tier; keep the ~12
   event-bus/lifecycle files in the logic tier; keep the M3/M4 convergence proof deterministic (recorder +
   scripted-LLM stub).
7. **Wiring the two CI jobs** (logic per-push, skill merge/labelled/scheduled with a `concurrency` guard)
   and **deleting** FakeBot's world-model half + `fakes.test.ts`; updating the docs that reference the
   fake (S8).

For each open question in [24 §10](24-realbot-ci-final-product.md#10-questions-the-implementation-plan-must-resolve),
either resolve it in the plan or flag it as an explicit owner decision with options.

## 3. Ground rules

- Work only under **`eden/`** and **`docs/`**. Respect the **dependency law** (CI-enforced on `src/`;
  note tests are not graphed) and **S1–S10** — additions are registry rows not branches (the skill
  catalogue and journal kinds especially), one writer per state, no banned machinery (no second test
  framework, no bespoke bot connector), and **behavior + docs change in the same commit (S8)**.
- The plan is **testable**: every step names the check that proves it. Prefer outcome-based (RCON world /
  paired-test flip) assertions; keep the logic tier fast and deterministic.
- Keep the plan **honest about risk** (carry [23 §9](23-real-mineflayer-ci-plan.md)'s register forward,
  minus the LLM risks Q6 dissolved) and about anything the docs got wrong vs. current code.

## 4. Deliverable

- A new plan doc at the next free number (**`docs/26-…`**): the ordered steps with per-step DoD + a DAG,
  a test inventory (what moves to the skill tier, what stays logic, what the recorder keeps, what's
  deleted), the resolved/flagged open questions, and the migration/cleanup sequence.
- Record any new decision as the next **D-#** and any new pitfall as the next **R-#** (per S8), and add a
  dated section to **[docs/PROGRESS.md](PROGRESS.md)** + a pointer from **[docs/README.md](README.md)** and
  **[eden/CLAUDE.md](../eden/CLAUDE.md)**.
- Do not change behavior this session — docs lead; code follows in the build session.

Start by reading §0, then produce a one-screen "prerequisite + step DAG" outline and confirm the ordering
(D-16 gate before the skill catalogue; RecordingBot before deleting the world-model half) before
expanding each step.

---

*(This prompt is doc 25; the plan it produces is doc 26. Supporting context: 24 spec · 22 D-16 · 23
review · 19/20 harness · 07 lessons.)*
