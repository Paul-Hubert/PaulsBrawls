# 27 — Kickoff prompt: BUILD the real-mineflayer CI (implements docs/26)

**What this doc is.** The copy-paste prompt that starts (or resumes) a session implementing
[26-realbot-ci-implementation-plan](26-realbot-ci-implementation-plan.md) rev 2. Doc 25 seeded the
*planning* session; this seeds the *build* sessions. The plan is multi-session — the same prompt
works every time because §0 tells the session to locate the current build state first.

---

You are working inside Eden, the AI-village brain (Node/TypeScript, `eden/`). Your task this session
is to **implement the next step(s) of docs/26 — the real-mineflayer, no-LLM, no-God CI** (rev 2,
panel-reviewed, all findings folded). This is a build session: code + tests + docs land together
(S8). The plan is normative; do not re-plan it.

## 0. Read first, then locate the build state

1. **[docs/26](26-realbot-ci-implementation-plan.md) — THE PLAN.** §2 the DAG, §3 the steps (files +
   DoD per step are normative — meet them literally, including the drills), §5 the test inventory,
   §6 the decisions, §9 the panel-finding ledger (context for *why* each detail is there).
2. **[docs/24](24-realbot-ci-final-product.md)** — the spec + acceptance criteria (as amended by
   docs/26 D-19/O-2/O-4: criterion 3 scopes to mortal stock skills; §3's "no throw" is amended).
3. **[docs/22](22-godfree-skill-loop.md)** — D-16: the flip gate you build in B3 (§3 gate, §3.4
   event-trace, §3.5 truth table, §7 migration). **You will amend §3.5/§6 in the B3a commit** (O-4:
   the `oracle:'return'` class + Sδ `nearbyBlocks` name-counts).
4. **[docs/07](07-hard-won-lessons.md)** — R1–R81 (R4/R55/R66/R76/W especially). New pitfalls you
   hit are filed as **R82+**, same commit as the fix (S8).
5. **[eden/CLAUDE.md](../eden/CLAUDE.md)** — ground rules. Background only if needed: docs/23
   (panel analysis), docs/19/20 (the live harness you extend).

Then read **[docs/PROGRESS.md](PROGRESS.md)** (newest-first) to find which B-steps are already
landed, and **verify before building**: the plan's counts/line-refs are point-in-time (2026-07-03)
— re-derive anything you rely on (grep `fakes/fake-bot` by *import path*; re-check
`run/server.properties`; re-check the stock-skill list). If the tree has drifted from docs/26 §1,
note it in PROGRESS.md and adjust.

## 1. Decisions locked — do NOT relitigate (inputs, not questions)

- **Q1** RecordingBot split (live-mutable vs inert stubs per 26 §1.1/B2 — the inventory array and
  seeded block map are *real state*; `findBlocks`/containers/`activateBlock` behavior are not).
- **Q2** the auto-opened `run/` dev server is the CI host. **Q6** no LLM in CI (assert
  `llm.call = 0` from the run's journal).
- **D-17** the CI server profile is a stamped full-file overlay of the *working-tree*
  `run/server.properties` + a disposable flat fixed-seed `eden-ci` world wiped per run. **Never
  hand-edit `run/server.properties` — only the lifecycle touches it**, and it must restore it on
  teardown.
- **D-18** the catalogue is a hand-authored `SkillCase` registry with a per-push completeness gate
  (mortal stock skills 1:1; `notApplicable` reasons and the divine exclusion list printed).
- **D-19** the CI is **God-free end to end**: one mortal runner, no avatar bot, no divine cases,
  and **CI never ops any bot**. The runtime in-world God is untouched.
- **O-2 resolved**: `unresourcedExpect: 'no-op' | 'named-error'`, default `named-error`.
- **O-4 resolved**: `oracle:'return'` for observer/movement skills (exempt from Sδ≠∅) + Sδ
  `nearbyBlocks` name-**counts**; amend docs/22 in the B3a commit.
- **O-1 open** → ship the skill job `workflow_dispatch`/label/nightly-only; `npm run skill-test` is
  the manual merge ritual. Do not register a runner yourself; the B7 promotion policy (5 clean
  consecutive full-suite greens before merge-blocking) stands either way.
- **O-3 open** → leave the D-16 labels as they are; when citing, disambiguate in words ("D-16, the
  god-free gate" vs "the embed-at-write decision").

## 2. Build order and what "done" means

```
B1 lifecycle ∥ B2 RecordingBot ∥ B3a flip-gate   →   B3b loop rewiring ∥ B3c paired tests
        → B4 harness + pilots → B5 catalogue (per family) → B6 re-tier → B7 jobs + deletion + docs
```

- Do the **earliest incomplete step**; B1/B2/B3a are mutually parallel-safe (disjoint areas). A good
  first session lands B1 + B2; B3a next; B3b and B3c can interleave; B3c/B5 are multi-session by
  design — land them **family by family**, each family green before the next starts.
- A step is done **only** when its docs/26 §3 DoD is met literally — including the drills: B1's
  lifecycle-smoke double-run + poisoned-state run, B4's mutation drill (a constant-`worked` test
  must fail with REJECT-TEST) and the mortal-runs-divine `TierGateError` case, B5's per-family
  green gates and the flake bar.
- **`npm run check` stays green after every step** — the logic tier is the always-on gate; never
  leave it red between sessions.
- Two hard ordering constraints (violating either is a stop-the-line error): the D-16 gate core +
  paired tests (B3a+B3c) land **before** any per-skill catalogue case asserts an oracle; the
  RecordingBot split (B2) lands **before** any FakeBot world-model code is deleted (B7).

## 3. Ground rules

- Work only under `eden/` and `docs/`, plus exactly three sanctioned exceptions: (a)
  `.github/workflows/eden-ci.yml` at B7; (b) `run/server.properties` **through the lifecycle's
  stamped overlay only**; (c) the one additive `src/` change — avatar-optional `BotPool`
  (`eden/src/bots/pool.ts`), B4. Never touch `minecraft-mcp-server/` or the Java mod. Never touch
  the production server (port 25565 — the reaper must *refuse* it).
- Dependency law (imports strictly downward; `flip-gate` is layer 2; the journal kind is a registry
  row in kinds.ts + KindPayloads + KIND_REGISTRY). depcruise doesn't graph tests — the discipline
  substitute is 26's rules: shared bootstrap under `live-tests/`/`tests/` only; the harness takes
  its engine from the shared `makeEngine` factory; **the flip-gate module is the sole caller of
  `library.admit` on the self-verdict path** (S2).
- `node:test` via tsx (never another framework); no `console.*` outside logger.ts (R23); errors
  name subject + args (S10); `import type` for type-only imports; named imports for the mineflayer
  plugin trio (R15).
- **Behavior + docs in the same commit** (S8): B3a carries the docs/22 amendment; B7 carries the
  16/19/20/CLAUDE sweep; every session appends a dated PROGRESS.md section (what landed, DoD
  evidence, surprises, next). New pitfall → **R82+**; new decision → **D-20+**.
- Commit per step (or per family in B3c/B5), on the current branch; don't push or open PRs unless
  asked.

## 4. Landmines already mapped — build against them, don't rediscover them

(Full context in 26 §9; the fixes are already in the step specs.)

- **B1:** the overlay is a full-file rewrite of the *working-tree* file (MC rewrites
  server.properties on boot; the dev copy is locally dirty); `level-type=minecraft\:flat` with
  Properties colon-escaping — a bad value **silently regenerates a normal world**, so the ready-gate
  includes a flat-block readback; `RconClient.connect()` is one-shot — readiness needs a new
  connect-with-backoff wrapper; teardown kills by **port owner of 25599** (loom forks the server JVM
  via the shared gradle daemon — never kill the daemon, never kill by process name); the pre-boot
  world delete waits for 25599 to be free (Windows file locks); heal a stale stamped `.ci-backup`
  *first*; `:8767` is the mod's unconditional liveness signal (no `/village on` exists over RCON);
  `run/mods/` is pinned (currently worldedit).
- **B2:** gate/loop convergence tests need `give` → snapshot → check-veto to work in **both**
  directions (live inventory); the skills-engine stall test digs a *seeded* block; reactivity tests
  assert *routing* only — `findBlock` must return null without throwing.
- **B3:** the new judge is **`flip-gate`** (`gate.test.ts` is the existing M3-GATE proof — B3b
  *rewires* its admission path, never shadow it); `Provenance` gains `source:
  'critic'|'self-verdict'` or the zero-critic-admissions oracle is unassertable; `RolloutsView`
  must fold `skill.self-verdict`/`skill.admit{source}` (today it only reads `god.verdict` — and
  rebuild==live can't catch the miss because both folds would be wrong identically: the parity test
  must exercise a **gate-admitted** rollout); the event-trace closes after a ~500 ms grace and
  filters `entityDead` by subject / `playerCollect` by runner; `place-item` gets the R55 poll it
  lacks; S6 golden prompts are *inline structural asserts*, not `.snap` files.
- **B4/B5:** the per-case reset resets the **bot** (clear/tp/gamemode/effect + per-case surface
  blocks), not just the arena; honesty rows are *constructed* per case, not observed; crops are
  fixtures (`setblock …wheat[age=7]` — `randomTickSpeed 0` means nothing grows); per-case wall
  240 s default; one boot + one bot-connect per suite run (cases share the connection); a
  `T(pre) ≠ nothing-to-do` in the unresourced phase is an arena/reset defect (one journaled infra
  retry), not a skill REJECT.
- **B7:** the skill job's trigger paths must include `src/**`, `build.gradle`, `gradle.properties`
  (the mod is compiled by `runServer` — an `eden/**`-only filter would never fire on the Java break
  it exists to catch); `concurrency` group with `cancel-in-progress: false`; "twice green" is a
  smoke signal — merge-blocking waits for the flake bar.

## 5. Session deliverables

Every build session ends with: the step's DoD evidence (test output, lifecycle-smoke/evidence-dir
paths, the drills' results), `npm run check` green, the dated PROGRESS.md section, and any R#/D#
filed. If a DoD cannot be met, stop, file the finding (it is probably the next R#), and record the
blocked state in PROGRESS.md rather than weakening the DoD.

---

*(This prompt is doc 27; the plan it implements is doc 26 rev 2. Supporting context: 24 spec ·
22 D-16 · 23 panel analysis · 19/20 harness · 07 lessons.)*
