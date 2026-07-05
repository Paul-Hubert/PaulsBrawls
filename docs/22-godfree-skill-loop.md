# 22 — The god-free, self-refining skill loop (paired-test admission)

**Status:** design, converged (owner co-design session, 2026-06-30/07-01). No code yet —
docs lead; a later implementation session pairs docs + code (S8). This doc is the contract
for that work. It records **D-16** (the doctrine reversal) and **R78–R81** (new landmines),
and cross-links the existing spec it amends: [02-skill-system](02-skill-system.md),
[03-god](03-god.md), [04-villager-runtime](04-villager-runtime.md),
[07-hard-won-lessons](07-hard-won-lessons.md), [13-open-questions](13-open-questions.md).

> Seed: the memory note `eden-godfree-refinement-direction` (2026-06-24). This doc supersedes
> it — the note is analysis; this is the resolved design.

---

## 0. Why

The God refinement loop ([03 §Refinement loop](03-god.md#the-refinement-loop)) spends **≈2
STRONG calls per revision** on a converging task — one STRONG villager author
([main.ts:1139](../eden/src/main.ts) `tier:'strong'`) **plus** one STRONG critic
([critic.ts:118](../eden/src/god/critic.ts)) — routed through an Inbox round-trip, with the
critic on `lane:'god'` preempting every villager (D-13, the binding throughput constraint).
Two structural costs fall out of that:

1. **The author's live context is thrown away each revision.** It just ran `run_skill` and saw
   the `RunReport` in its own `messages[]` ([brain.ts:169](../eden/src/villagers/brain.ts)); that
   context is re-serialized cold into a critic prompt, then again into the next density payload.
2. **The judge is context-poorer than the author** (D-06: desks share state, not a context
   window) so it diagnoses subtle bugs blind. Evidence of the resulting churn: **R73** (47
   runs / 0 verdicts / 25 min), **R76** (22 versions on one `findBlock` bug).

The fix removes the **critic** from the skill-admission path and replaces its verdict with a
**mechanical, LLM-free paired-test flip gate** the villager drives inside one continuing
deliberation. Correctness stops depending on a fallible judge; it depends on the engine's own
before/after snapshots, which the villager cannot forge.

---

## 1. Decision D-16 — the doctrine reversal (god-free skill admission)

> **D-16 — God's *critic* leaves the skill-admission loop; admission is decided by a mechanical
> paired-test flip gate. God's *curriculum* is kept.**
>
> This reverses owner decision #1 ("skills are criticized by God") and D-06's "one God closes
> every loop" **for the skill library only.** Precisely:
>
> - **Removed from the skill path:** `critic.judge` + `routeVerdict`'s per-revision role
>   ([critic.ts](../eden/src/god/critic.ts), [god.ts:150](../eden/src/god/god.ts)).
> - **Kept:** the **curriculum** desk (task proposal, decomposition, warm-up, the R65 give-up
>   breaker, the R72 blocked-pivot — including one small STRONG call to synthesize a blocked
>   task's follow-up, §5.3), the **orchestrator** desk (directives), and the whole in-world God
>   — persona, avatar `Dieu`, divine skills, `appear/vanish/smite`. **None of the in-world God
>   is touched.**
>
> "God-free" therefore means **critic-free admission**, not God-absent. The library's
> success-gate moves from an LLM verdict to a deterministic gate; God still decides *what the
> village works on*.

Rationale: the mechanical gate is **strictly safer** than the LLM critic (a plausible
`RunReport` could fool the critic; it cannot fool the engine's snapshots), while removing the
strong-lane bottleneck. The author was already STRONG, so **the only strong calls that vanish
are the per-revision critic calls** — roughly halving the strong load on the converging path,
freeing the exact lane D-13 identified as binding.

---

## 2. The loop

One deliberation = one LLM conversation ([04 §The brain](04-villager-runtime.md#the-brain))
that now runs the whole refine cycle in-context, on the **STRONG** tier:

```
context pack (density payload + §6 recalled lessons)
  → write_skill  (author draft S + paired test T)
  → run_skill    (trial S; engine snapshots worldBefore_S / worldAfter_S)
  → reflect      (villager distils a lesson when it forms a diagnosis)
  → write_skill  (revise S or T)
  → run_skill    (re-trial)
  → submit_skill (drive the flip gate; ADMIT / REVISE / nothing-to-do)
  → done
```

`submit_skill` runs the **flip gate** (§3) — a mechanical, zero-token judgment. On a REVISE
result the deliberation *continues* with the gate's `evidence` (a concrete assertion failure,
richer than a generic critique) as the next revision's fuel. There is **no Inbox round-trip and
no critic**.

**Bounded sessions, chained by continuity (§4).** One deliberation is capped at
`maxToolTurns=16` (≈4 revisions once `write_skill`/`run_skill`/`reflect` are counted). When one
session isn't enough, the coordinator re-deliberates carrying the never-trimmed density payload
`{last draft, last RunReport, last self-critique}` + the recalled `lesson` memories. The give-up
breaker (§5) is the kept R65 machinery, now fed by the gate outcome instead of a verdict.

### 2.1 The scheduler interaction (R81)

The gate's runs are **bot-bound, not LLM-bound** — pure mineflayer work under D-05. To stop a
deliberation from holding an LLM concurrency permit through minutes of gate execution (a
pre-existing waste that `run_skill` already incurs, which the gate amplifies), the deliberation
**releases its scheduler permit during bot work and re-acquires it for the next LLM turn.** This
touches the "one deliberation = one scheduler unit" invariant ([brain.ts:17](../eden/src/villagers/brain.ts)),
so the re-acquire **must be rollout-immune / front-of-lane** (R81) — else a villager mid-self-debug
is queued behind peers and loses the density-invariant continuity (rollout immunity,
[04 §Scheduling](04-villager-runtime.md#scheduling)). This is the subtlest build item in the design.

---

## 3. The paired-test flip gate

Every skill `S` ships a second **test** skill `T`, an ordinary library skill of shape
`async (bot, args, ctx) → { verdict: 'worked' | 'nothing-to-do' | 'failed', evidence }`. `T` is
the **semantic oracle**; it is made fraud-proof **mechanically** (no LLM) because the engine
already captures its own `worldBefore`/`worldAfter` snapshots around every run
([engine.ts:241,410](../eden/src/skills/engine.ts) `captureSnapshot`) — the villager cannot forge
them.

### 3.1 The composed oracle (three signals)

The test does **not** carry the whole load. The gate composes three signals, each covering the
others' blind spot:

| Signal | Source | Covers |
|---|---|---|
| **Engine `Sδ`** | `worldBefore_S` vs `worldAfter_S`, bracketed **strictly around S** | anti-fraud floor; attribution is free (it is *this run's* delta) |
| **Paired test `postV`** | `T` run after `S`, reading effects the snapshot can't see (chest contents, farmland transform, mob death via the event-trace §3.4) | goal shape |
| **`task.check`** | the objective `ItemCheck{item,count}` on the task, via the existing [`checkSatisfied`](../eden/src/god/critic.ts) lifted out of the critic into the gate | mission anchor |

**Admission rule:**

```
ADMIT  iff   validTest(T)            // T returns the enum AND preV ≠ 'worked'
       &&    Sδ ≠ ∅                  // the skill changed the mutable world
       &&    postV == 'worked'       // the goal predicate now holds
       &&    (task.check ? checkSatisfied(worldAfter_S) : true)
```

The engine delta is the fraud-proof spine; the test is the goal-shape oracle; `task.check` is the
mission anchor. **Neither the test nor the snapshot alone suffices — that is the who-tests-the-test
answer.** A weak test can pass a wrong skill only if it agrees with the skill *and* the engine saw a
non-empty delta *and* (when present) the objective check holds.

### 3.2 The gate procedure (per admission attempt)

`submit_skill` requires a paired test to exist, then runs three serialized runs on the one body
(D-05):

1. **T(pre)** → `preV`. (Also captures T's own delta `Tδ` — see §3.3.)
2. **S** → engine snapshots `worldBefore_S` / `worldAfter_S`; records the event-trace (§3.4).
3. **T(post)** → `postV`; T reads the **subject skill's** event-trace as `ctx.events` (§3.4).

Then apply the truth table (§3.5). Full flip runs at **admission and on trial re-runs only**;
ordinary production runs still graduate a probationary skill on engine `outcome.ok`
([library.ts:176](../eden/src/skills/library.ts) unchanged) — **real work carries no test tax.**

### 3.3 Test purity — convention, not enforced

A valid test is **read-only by convention**, not by mechanical gate. Dropping enforcement is safe
for the anti-fraud floor *because `Sδ` is bracketed around `S` alone*: an impure `T(pre)` that does
the skill's job leaves `Sδ` empty → rejected anyway. The **one residual leak** — an impure `T(post)`
that itself satisfies `task.check`, crediting the test for the skill's goal — has no rational
incentive (self-defeating) and is caught in review; stock tests ship as reviewed templates.

Per S9 ("capture the signal, don't gate"): the engine snapshots every run, so **`Tδ` is measured
for free — journal it on the `skill.self-verdict` event for audit, but do not gate on it.** This
keeps "convention" auditable and leaves the enforcement seam open (tightening to enforced later is
one line).

### 3.4 Events — the ephemeral oracle

State-based effects (gather, craft, deposit, till) are read from the before/after snapshots.
**Ephemeral** effects (a mob's death, a drop pickup, a dig completion) are not reliably a snapshot
delta, so the RunReport gains a **bounded event-trace ring buffer** (`ctx.events`), fed by
subscribing to a small set of *effect* events during the run.

> **Note (corrects the seed):** `entityDead`/`playerCollect` are **not** in
> [`STALL_EVENTS`](../eden/src/skills/engine.ts) today (only `diggingCompleted` overlaps). The
> event-trace requires **new subscriptions**, not just exposing existing pulse counters.

Precise wiring: during a **test(post)** run, `ctx.events` exposes the **preceding skill run's**
trace (the gate injects `skillReport.events`), *not* the test's own live events — so the assertion
is race-free (it reads a frozen trace). Ring size is bounded (§6 config) with a dropped-count so a
long fight never bloats the RunReport (D-07/R44).

### 3.5 Truth table

`preV`/`postV` = test verdict pre/post · `Sδ` = skill's engine mutable delta.

| `preV` | `Sδ` | `postV` | Decision |
|---|---|---|---|
| `worked` | — | — | **REJECT TEST** — precondition already true / constant test (kills trivial-test + the D2 "deposit items I already had" fraud in one rule) |
| `failed` | non-empty | `worked` | **ADMIT** — genuine flip + attributable delta (and `task.check` if present) |
| `failed` | **empty** | `worked` | **REJECT** — test claims success but the engine saw zero delta (test lies) |
| `failed` | any | `failed` | **REVISE** — real defect; `evidence` is a concrete assertion failure (richer fuel than a God critique) |
| `nothing-to-do` | empty | `nothing-to-do` | **PASS, no churn** — correct no-op; R72 made first-class + mechanical (not an admit) |
| `nothing-to-do` | **non-empty** | any | **SUSPECT TEST** — claimed nothing-to-do but the skill mutated the world (the lazy-test escape, caught for free by the same delta) |
| test aborts/throws (pre or post) | — | — | treat as `failed` → never admit (conservative) |

`nothing-to-do` **never substitutes** for the ≥1 genuine `worked` flip that proves capability — a
skill that only ever sees `nothing-to-do` never admits (correctly: it was never exercised).

> **Amendment (2026-07-05, O-4 — docs/26; built in B3a).** Two changes to the table's `Sδ` column:
>
> 1. **A third oracle class `oracle:'return'`** (declared on the test's manifest) for
>    observer/movement skills (`go-to`, `find-*`, `find-high-spot`, `explore-until`) — they mutate
>    nothing *by contract*, so the `Sδ ≠ ∅` requirement made them permanently inadmissible. A
>    `'return'`-class pair is **exempt from the Sδ≠∅ floor**: row 2's ADMIT drops the non-empty
>    condition and row 3's zero-delta REJECT is waived. The fraud surface ("returned a
>    coordinate/fact that isn't real") is covered by the paired test asserting the **return value
>    against a world read** instead. `'state'` (default) and `'events'` classes keep the floor.
> 2. **`nearbyBlocks` compares name-COUNTS, not the name set** — a set makes the 2nd till/sow into a
>    field already showing `farmland`/`wheat` invisible. The snapshot carries
>    `nearbyBlockCounts` (same bounded scan); the gate falls back to the set when absent.
>
> Two pinned caveats ride the comparator (docs/26 B3a — do not "improve" either): `Sδ` deliberately
> **excludes `nearbyEntities`** (another body near the runner could forge a delta), and
> `nearbyBlocks` is **viewpoint-sensitive** for movement-composing skills (the two snapshots are
> taken from different positions) — a nearbyBlocks-only delta counts toward the ADMIT floor but
> never convicts a `nothing-to-do` run of mutation (SUSPECT-TEST) when the bot moved.

### 3.6 Worked trace — `harvest-wheat`

Test `wheat-harvested`: `worked` = inventory wheat rose to target; `failed` = ripe wheat present,
target unmet; `nothing-to-do` = no ripe wheat anywhere.

- **Field has ripe wheat, villager holds 0:** `preV=failed` → run S → inventory +3 wheat, `Sδ`
  non-empty (inventory gains wheat, `nearbyBlocks` loses "wheat"), `postV=worked`, `check{wheat,1}`
  satisfied → **ADMIT**.
- **Fraud variant (S no-ops, returns `ok:true`):** `preV=failed`, `Sδ` **empty** → **REJECT** on
  rule 2, no LLM.
- **Villager already holds the target wheat:** `preV=worked` → **REJECT TEST** — see R78; use a
  **relative** bar (gate-computed `worldAfter_S.inv(X) > worldBefore_S.inv(X)`) or a
  precondition-framed predicate rather than an absolute one.

### 3.7 Worked trace — `kill-mob` (ephemeral)

Test `mob-killed` asserts over the subject run's event-trace: `worked` = a hostile `entityDead`
appeared during the run. `preV=failed` (hostile alive & near) → run S → post reads `ctx.events`
(the *skill's* trace) → sees `entityDead` → `worked`; `Sδ` corroborates (nearbyEntities lost the
mob) → **ADMIT**.

---

## 4. Continuity — Reflexion across bounded sessions

The self-debug loop persists across session boundaries via two existing carriers plus one new tool:

- **The never-trimmed density payload** `{last draft, last RunReport, last self-critique}` — the
  frame + payload are never trimmed; only prior revision turns trim oldest-first as whole R20 pairs
  ([context-pack.ts:36,148](../eden/src/villagers/context-pack.ts), D-11). This is the mechanical
  state that resumes a debug.
- **Distilled `lesson` memories** — importance 9, survive eviction ([memory.ts:36,344](../eden/src/villagers/memory.ts)),
  recalled into context-pack **§6 MÉMOIRE PERTINENTE** (already pre-loaded per task,
  [main.ts:1110](../eden/src/main.ts)). This is the *insight* that resumes a debug.
- **The new `reflect` tool** — writes a `lesson` on demand (discretionary; the summarizer's
  eviction-time lessons are unchanged). Two hygiene rules bake into the spec (S3-safe, not forks):
  **cap `reflect` at ≤2 lessons/session**, and **tag each lesson with the skill name** so recall
  *relevance* (not just importance 9) carries it to the right future task.

**Reflect timing is load-bearing.** With discretionary-only capture, an insight reasoned but never
`reflect`ed before a session ends is lost (only the density payload survives). The self-debug prompt
must push the model to `reflect` **when it forms a diagnosis, especially before the session ends.**
STRONG self-debug (§5) makes that reflection trustworthy.

### 4.1 Worked trace — a failure that self-debugs across two sessions (R76 class)

**Session 1 (STRONG):** `write` v1 (R76 palette bug: matcher reads `b.position`) → `run` → `Sδ=∅`,
gate REVISE with evidence *"finder returned nothing; 0 wheat gained."* Villager tweaks radius → v2 →
∅ → v3 → ∅. Hits `maxToolTurns`. Density payload persists `{v3, RunReport}`. If a diagnosis was
reached, `reflect` persisted it.

**Session 2 (STRONG):** resumes from the density payload + revision history; recognizes the R76
signature (a `findBlock` matcher must read only `block.name` — it runs on synthetic palette blocks
with no position, R76) → writes v4 (name-only matcher) → `run` → wheat gained, `Sδ` non-empty,
`postV=worked`, `check` satisfied → **gate ADMIT**. `reflect` writes the lesson *"a findBlock matcher
must read only block.name — palette pre-check (R76)"* → rides §6 for **every villager's** future
`findBlock` skill; the churn does not recur village-wide.

---

## 5. The four failure modes, and how the design answers each

### 5.1 Stalling (host stability under the extra runs)

- Gate runs are **bot-bound and per-villager** — D-05 serializes each bot's own tree, so a
  villager's three admission runs contend *only its own body*; they parallelize across the 10 bots.
  No cross-villager contention is introduced. The one shared bottleneck (the strong LLM lane) is
  *relieved* by removing the critic.
- **Trial-only flip** means production runs carry no test tax.
- **Test supervision reuses the skill defaults** (120 s wall / 20 s stall / macrotask canary) — no
  dedicated test budget. This is safe *only because the R55 settle lives inside the skill*: a skill
  that polls-until-confirmed before returning leaves `worldAfter_S` settled, so `T(post)` reads
  settled state too, and a gate-level settle would be redundant (R79). Stock **tests** must ship the
  same poll-until-confirmed discipline as the template.
- The macrotask canary (W/CRIT-1/R75) and abort protocol cover tests unchanged (tests are compiled +
  instrumented like any skill — no new hole).
- **Permit released during bot work, re-acquired rollout-immune** (§2.1 / R81) keeps the strong lane
  from idling behind gate runs at 10 villagers.

### 5.2 Learning difficulties (convergence)

The gate makes diagnosis quality a **speed** question, not a **safety** one — the author cannot mark
itself successful; the gate disposes. So:

- **Self-debug runs on STRONG** (best per-session diagnosis, fewest revisions; no FAST tier / no
  escalation ladder — one fewer knob). The throughput win comes entirely from deleting the critic.
- The gate's `evidence` (a concrete assertion failure) is **richer fuel** than the generic God
  critique — it names *what* the test asserted and *why* it failed.
- **Distilled lessons** (§4) stop a diagnosed root cause from being re-derived, village-wide.
- Give-up is the kept **R65** convergence breaker (§5, below), fed by the gate.

### 5.3 Getting stuck on technicalities (fake-vs-real drift)

Tests **read more world** than skills (open chests, scan for ripe crops, walk to observe), so the
FakeBot surface **grows** — every read the fake doesn't model is a live-only failure (the Z/C/D1/D2/E
class). Container tests inherit R1–R3's window-hijack hazards and run **twice** per admission. Two
guardrails: (a) stock tests ship the SAFE-OPEN/pause-mutators discipline (R1–R3/R63) and R55
poll-until-confirmed as templates; (b) the fake must model whatever a stock test reads, or CI is
blind to it (the exact lesson of the Z/C/E live findings).

**Blocked follow-up (R72, kept):** a `nothing-to-do` test names the missing resource in its
structured `evidence`; the **curriculum** synthesizes the acquire-task via **one small STRONG call**
on the (rare) blocked path — the curriculum is already STRONG and kept. Falls back to a mechanical
"`task.check` item absent → acquire it" when evidence is unstructured.

### 5.4 Scaling with small composable skills

The **dependents problem**: an append-only `v(k+1)` of a composed callee that admits but is subtly
worse can break every composer.

- **Composition resolves to the highest *ACTIVE* (graduated) version** (R80) — a new `readComposable`
  resolver distinct from `readRunnable` (which stays highest-live for direct `run_skill`). Composers
  keep using the stable `v_k` while `v_(k+1)` proves itself via direct runs; on graduation they move
  up. This **fixes a current cliff**: today [`composerRun`](../eden/src/skills/engine.ts) resolves the
  highest live version and throws `ProbationError` if it is on probation, so re-authoring an
  already-composed skill blocks *all* its composers until graduation. `ProbationError` stays for a
  *first* admission (no active version to fall back to — D-12 intent preserved).
- **Regression protection is passive** — pin-to-active *is* the protection. A composer that a newly
  graduated version breaks fails its **own** paired test at its next run → REVISE. No dependency
  graph, no proactive regression runs. Residual (accepted): lazy detection — the break lurks until the
  composer next runs.
- **Bloat/dedup** stays a retrieval-quality concern, not storage (owner: no skill-count cap). Stock
  re-seeds remain idempotent by `codeHash` ([library.ts:141](../eden/src/skills/library.ts)); the
  173→27 runtime dedup was stock churn, already fixed there.

---

## 6. The tuned configuration

Existing knobs (unchanged unless noted) + new knobs introduced by this design.

| Knob | Value | Guards | Symptom if too low / too high |
|---|---|---|---|
| `maxToolTurns` | **16** (unchanged) | one deliberation ≈4 revisions | low: sessions too short, more chaining / high: a wedged deliberation burns budget before the boundary |
| `SEARCH_CALL_CAP` | **3** (unchanged, R60) | search-loop breaker | low: can't discover / high: burns the wake-up searching |
| self-debug tier | **STRONG** | diagnosis quality | fast: churn on subtle bugs / (n/a — strong chosen) |
| gate LLM cost | **0 tokens** | the gate is mechanical | — |
| `runDefaultTimeoutMs` | **120 s** (also used for tests) | wall cap | low: kills long-but-valid gathers / high: a hung test lingers |
| `stallSeconds` | **20** (also used for tests, D-10) | stall detector | low: false-aborts a slow observe / high: a stuck run lingers |
| `macrotaskStallMs` | **8 s** (unchanged, W/CRIT-1) | microtask-starvation canary | — |
| test settle | **none** (relies on R55 in the skill) | R79 | — see §5.1 |
| event-trace ring size | **new: 64 entries** + dropped-count | ephemeral oracle without RunReport bloat (D-07/R44) | low: drops a kill in a big fight / high: bloats the row |
| event-trace close grace | **new: 500 ms** after the body resolves (`traceGraceMs`; tests set 0) | a death landing one tick after `isValid` flips is not lost (docs/26 P-5) | low: loses trailing entityDead / high: pads every root run |
| `Sδ` "non-empty" | **new: ≥1 mutable-field change** (inventory count Δ, `nearbyBlocks` name-**count** Δ *(O-4 amendment — was name-set)*, or an `entityDead` in the trace); `'return'`-class pairs exempt (O-4) | anti-zero-delta fraud | — presence/absence, no numeric threshold |
| `reflect` cap | **new: ≤2 lessons/session**, tagged with the skill name | §6 recall precision | low: insight lost / high: §6 spam, lesson-9 dominates recall |
| `probationRuns` | **3** (unchanged; graduate on `outcome.ok`) | D-12 graduation | — |
| flip scope | **new: admission + trial re-runs only** | keeps real work one run | broader: a test tax on every production use |
| `maxCallDepth` | **8** (unchanged) | composition depth | — |
| `autoQuarantineAfter` | **5** (unchanged, R36) | tripwire; **now wakes self-debug**, not a critic ticket | — |
| `maxSkillLines` | **400** (unchanged, R47) | decompose-or-reject | — |
| `MAX_ROLLOUT_ATTEMPTS` / `DEFAULT_MAX_RETRIES` | **2 / 4** (unchanged) | R65 give-up breaker (now fed by the gate) | low: gives up too soon / high: grinds an unconvergeable task |
| memory window / archive | **200 / 2000** (unchanged) | — | — |
| recency half-life · k · blend | **2 h · 5 · 0.5/0.25/0.25** (unchanged) | §6 recall | note: lesson importance 9 → watch recall dominance (tag-scope mitigates) |
| per-tier input budget | **strong 48k / fast 16k** (unchanged, D-11) | density fits | — |

---

## 7. Migration from the God loop (deleted / kept / rewired)

| Component | Fate |
|---|---|
| `CriticDesk.judge` / `judgeBatch` ([critic.ts](../eden/src/god/critic.ts)) | **Deleted from the skill path.** (The `checkSatisfied` + `applyRails` logic is *relocated* — the objective check into the gate; the rest retired.) |
| `god.routeVerdict` admit branch ([god.ts:150](../eden/src/god/god.ts)) | **Rewired.** Admission moves to `submit_skill` → gate → `library.admit(...)`. `routeVerdict` keeps critique-delivery only if any non-skill path still needs it; the skill admit branch is removed. |
| `RolloutCoordinator.assignAndRun` critic block ([main.ts:1162-1196](../eden/src/main.ts)) | **Rewired.** The per-revision `fileTicket → judge → routeVerdict` is replaced by the in-deliberation `submit_skill` gate; the coordinator drives session-chaining + the R65 breaker off the gate outcome. |
| `onTripwire` ([engine.ts:435](../eden/src/skills/engine.ts)) | **Rewired.** Wakes a self-debug deliberation instead of filing a critic ticket. |
| `recordProbationRun` trigger ([engine.ts:446](../eden/src/skills/engine.ts)) | **Kept** (graduate on `outcome.ok`), per the trial-only-flip decision. |
| Curriculum (proposal/decompose/warm-up/R65/R72) | **Kept, STRONG.** Now fed by the gate outcome; keeps one small STRONG call for a blocked task's follow-up. |
| Orchestrator (directives) | **Kept.** |
| In-world God (persona/avatar/divine skills) | **Untouched.** |
| **New: `submit_skill` tool** | requires a paired test; drives the pre→S→post gate; calls `library.admit`. |
| **New: `reflect` tool** | writes a `lesson` (≤2/session, skill-tagged) + journals. |
| **New: the flip-gate judge** (layer-2 module) | computes pre/post + `Sδ` attribution + `task.check`; the truth table (§3.5). |
| **New: manifest `validates?: string` + a `test` flag** | pairs S↔T; hides tests from retrieval/composition (one S1 registry-style change). |
| **New: `ctx.events` event-trace** on `RunReport` + `skill.self-verdict` journal kind | one [kinds.ts](../eden/src/journal/kinds.ts) row (S1). |
| **New: `readComposable`** ([library.ts](../eden/src/skills/library.ts)) | highest-active resolver; `composerRun` switches to it (R80). |
| **Stock skills ship paired tests** ([exemplars/index.ts](../eden/src/skills/exemplars/index.ts)) | the template every villager learns from. |

Dependency law: all changes are under `eden/` and downward. The flip-gate judge is **layer 2**
(skills/), the tools are **layer 3** (villagers/), the journal kind is **layer 1**. No layer-3 peer
imports (S/god still reaches villagers only via the Inbox). `main.ts` stays the composition root.

---

## 8. The self-sufficiency milestone

North star: **society simulation**; current focus: villagers **self-sufficient** through
resource gathering, management, trading, cooperation, and sharing. Three nested, journal/RCON-testable
milestones; **Milestone A is the first target** (M3-gate spirit: the smallest end-to-end that
exercises author→test→flip-gate→probation→graduation on real gathering + the D2-proof chest test).

### 8.1 Milestone A — Solo self-sufficiency (the first target)

One villager, empty inventory at spawn, **zero God intervention**, sustains hunger/health and stocks
a chest.

| Skill (mortal) | Paired test | Oracle |
|---|---|---|
| `collect-wood` (stock) | `has-logs` | inventory Δ ≥ N logs |
| `craft-tool` axe/hoe (stock `craft-item`) | `has-tool` | inventory has axe/hoe |
| `find-tillable` (stock, R76) → `till-block` + `sow-seed` (stock, R55) | `farmland-created` | `nearbyBlocks` gains `farmland` (name-only, R76) |
| `harvest-wheat` | `wheat-harvested` | inventory wheat gained (relative bar, R78) |
| `craft-bread` (stock `craft-item`) | `has-bread` | inventory has ≥ N bread |
| `eat-food` | `hunger-restored` | `food` rose across the run |
| `deposit-to-chest` | `chest-delta` | **open chest pre/post, count Δ ≥ N — the D2-proof oracle** |

**PASS:** from an empty start, `food ≥ F` for `T` minutes (no starvation) **and** a chest holds
`≥ N` bread **and** **zero critic-driven admissions** (every `skill.admit` carries a
`self-verdict` provenance, none a `god.verdict`) — the doctrine reversal, proven from the journal.

### 8.2 Trajectory

- **Milestone B — Two-role trade:** farmer + toolsmith; the toolsmith has *no* farming skills and
  sustains hunger by trading tools→bread over the `:8767` settlement. Adds a `surplus→trade`
  subscription + role specialization. PASS: toolsmith never starves with zero harvest runs · ≥K
  settlements on `:8767` · farmer's chest net-positive.
- **Milestone C — Sustained society (north star):** N villagers, day/night, mob-defense reflexes,
  indefinite. PASS: X-hour run · 0 hunger deaths · chests net-positive · ≥K trades · **0 God on the
  skill path.**

---

## 9. Cross-references

- Amends: [02 §Admission](02-skill-system.md#admission-pipeline) (the gate replaces the critic
  verdict), [02 §Composition](02-skill-system.md#composition) (R80 pin-to-active),
  [03 §Critic](03-god.md#the-critic-desk) + [03 §Refinement loop](03-god.md#the-refinement-loop)
  (critic leaves; curriculum/orchestrator stay), [04 §Memory](04-villager-runtime.md#memory)
  (`reflect` → lesson), [04 §The brain](04-villager-runtime.md#the-brain) (in-context self-debug),
  [04 §Scheduling](04-villager-runtime.md#scheduling) (R81 permit release).
- Decisions: **D-16** (this doc, §1); builds on D-04, D-05, D-11, D-12, D-13; reverses owner #1 /
  D-06 for the library only.
- Lessons: **R78–R81** (new, [07](07-hard-won-lessons.md)); leans on R1–R3, R47, R55, R60, R63, R72,
  R75, R76.
- Live-test process to validate: [20-live-test-process](20-live-test-process.md); the gate's runs
  and the D2-proof chest test are exactly the surface the live suite exercises.
