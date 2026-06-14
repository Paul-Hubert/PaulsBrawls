# 13 — Open design questions (co-design before M3)

The specs 00–10 describe Eden as if it were fully designed. A hostile review
(June 2026) found that seven mechanisms were **narrated in the indicative mood
without actually being designed** — the hard part was named, not solved. This doc
collects them. Each is flagged inline in its home spec with a `⚠ OPEN DESIGN
QUESTION` marker.

> **✅ ALL SEVEN RESOLVED (owner co-design session, June 2026).** Each became a
> `D-` record in its home doc (D-07…D-13) and, where it surfaced a new landmine, an
> `R-` rule (R44…R49). The per-OQ sections below summarize the chosen approach and
> link the record; the inline `⚠ OPEN DESIGN QUESTION` markers in the specs are
> replaced with "Resolved: see D-NN." Order resolved: OQ-6 (D-07) → OQ-3 (D-08) →
> OQ-4 (D-09) → OQ-1 (D-10) → OQ-5 (D-11) → OQ-2 (D-12) → OQ-7 (D-13).

These *were* the genuinely open mechanisms — the implementing agent must NOT build
past an OQ with an invented design (see [09 §Step 2](09-agent-kickoff-prompt.md)),
which is why they were **co-designed with the owner** first; each resolution became
the next `D-` decision record in its home doc (doc-drift law,
[S8](08-extension-recipes.md)) and this entry is marked RESOLVED.

Three of them — **OQ-1, OQ-2, OQ-5** — gated M3, the refinement-loop milestone the
build order calls the heart; they were designed together (run → dense revision →
guarded judgment) as the kickoff required.

| OQ | Mechanism | Gates | Cost to design | Home doc |
|---|---|---|---|---|
| OQ-1 | Stall-detector pulse semantics ✅ **RESOLVED → D-10** | **M3** | medium | [02 §Validation](02-skill-system.md#validation--runtime-supervision) |
| OQ-2 | Wrong-critic backstop ✅ **RESOLVED → D-12** | **M3** | medium | [03 §Critic](03-god.md#the-critic-desk) |
| OQ-3 | Single-process blast radius ✅ **RESOLVED → D-08** | M1 | low | [01 D-01](01-architecture.md#decision-d-01-one-process) |
| OQ-4 | Crash-only rollout resume ✅ **RESOLVED → D-09** | M3/M4 | low | [01 §Startup](01-architecture.md#startup-sequence) |
| OQ-5 | Density vs token budget ✅ **RESOLVED → D-11** | **M3** | low | [03 §Refinement loop](03-god.md#the-refinement-loop) |
| OQ-6 | Journal/event-loop backpressure ✅ **RESOLVED → D-07** | M0/M1 | low | [05 §Journal](05-observability.md#the-journal) |
| OQ-7 | Cost & latency budget ✅ **RESOLVED → D-13** | M4 | low (arithmetic) | [03 §Cost control](03-god.md#cost-control) |

---

## OQ-1 — What is a stall-detector "pulse"? ✅ RESOLVED

**Resolved (owner, June 2026): see [D-10](02-skill-system.md#decision-d-10-a-pulse-is-a-discrete-progress-event-pathfinder-liveness-is-a-built-in-pulse-source).**

Chosen: **hybrid — engine event-pulses (incl. pathfinder liveness) + skill contract;
uniform `stallSeconds = 20`.** A pulse is a **discrete progress *event*, not a
continuous "in-progress" state** (else a wedged `bot.dig` looks alive forever). Two
sources: engine built-ins subscribed on run start (position delta, inventory change,
window open/close, dig/place start+complete, and pathfinder liveness via the public
`path_update`/`path_reset`/`goal_*`/`path_stop` events), and the skill contract
(`ctx.log`, the provided `sleep(ms)`, stock primitives pulsing in their poll loops).
The pathfinder subscription is the precise R26 reconciliation — a 14–60 s `goTo`
emits those events while the bot stands still, so it's genuinely alive, not excused.

Verified during design: mineflayer-pathfinder emits exactly those events publicly
(incl. `path_reset('stuck')`) — option 2 is feasible and not "internal coupling."
Rejected: pure-skill-contract (a raw `bot.pathfinder.goto` stands still during churn
and trips unless the author hand-pulses movement — fragile) and whitelist-suppression
(a per-op special-case list, less precise — a hang inside a whitelisted op waits the
full `timeoutMs`). No per-op mode switch; `timeoutMs` is the separate ceiling and an
all-`sleep` spin reaches the critic as futility (R34), not the detector (R39).
Async-hangs-only; sync `while(true)` stays the loop budget's job. New pitfall: R46.

**Deliverable test** (FakeBot, no server): (i) `while(true)` → loop budget, not the
stall detector; (ii) FakeBot emitting `path_update` every ~1 s for 45 s with position
constant → not aborted; (iii) `bot.dig` returning a never-resolving promise with one
start-pulse → `SkillStalledError('no progress')` at ~`stallSeconds`.

---

## OQ-2 — What backstops a *wrong* critic verdict? ✅ RESOLVED

**Resolved (owner, June 2026): see [D-12](03-god.md#decision-d-12-three-deterministic-rails-around-the-single-verdict).**

Chosen: **three deterministic rails around the single verdict** (critic and global
library both kept — owners #1/#2):
1. **`check`-veto (one-directional)** — a failed `check: {item,count}` forces
   `success:false`/no-admit regardless of the verdict; a *passing* check still needs
   the verdict (preserves "evidence FOR the critic, not a bypass").
2. **Probation before composition** — an LLM-admitted version enters `active-probation`:
   globally runnable + retrievable (no re-siloing — owner #2 intact) but **not
   composable** by other skills until `probationRuns` (default 3) clean re-judged runs;
   stock/exemplar skills skip it.
3. **Self-healing quarantine** — a quarantined skill that succeeds on a forced re-trial
   re-enters `active-probation` (not straight to `active`), R37 applied to the library.

Rejected: keeping the check purely advisory (discards the cheap false-admission catch)
and two-vote admission (doubles critic cost, redundant with probation — *deferred* as
the escalation if false admissions measure frequent). The hallucinated-critique mode
needs no rail: bounded by `maxRetries` + curriculum frontier-learning. New status
`active-probation` + composition gate (02 §Library), config key `skills.probationRuns`,
pitfall R48. Deliverable test (ScriptedLLM): a wrongly-admitted no-op on a check task is
vetoed to `success:false`; a wrongly-quarantined skill re-trialed to `active-probation`;
a probationary skill refused as a composition callee but runnable, graduating after 3
clean runs.

---

## OQ-3 — What does one `process.exit()` cost under one process? ✅ RESOLVED

**Resolved (owner, June 2026): see [D-08](01-architecture.md#decision-d-08-neuter-host-killing-syscalls-supervise-crash-only).**

Chosen: **neuter the footgun + supervise.** A scope shim binds `process` (and
`require`/dynamic `import` of `'process'`) to a safe-allowlist object whose
`exit`/`reallyExit`/`abort`/`kill` throw `SkillForbiddenError` — installed as a
*provided scope global* in the existing acorn compile step, **not** the
banned-identifier scan owner decision #5 dropped (the code parses and runs; only the
*call* throws → `RunReport` → critic, exactly P3's crash-escalation). The host runs
under **pm2** (Windows — *not* systemd) with crash-only respawn and staggered
relogin (R13).

Two findings from the design pass corrected the OQ's own premises:
- **Workers DO isolate `process.exit()`** — verified empirically: `process.exit()`
  in a worker thread kills only that worker, not the host. So the worker escape hatch
  genuinely contains the footgun (to one bot) if ever needed — it is the deferred
  last resort, not built in v0 (08 §Scaling).
- **D-07 already closed the "lost in-flight journal writes / P4 violation" worry** —
  synchronous WAL writes mean there is no async buffer to lose on a crash.

Rejected: keeping P3 literal (leaves an unbounded-blast-radius accident armed), and
building worker-per-bot containment in v0 (premature — cross-thread coordination
cost, nothing has measured the need). The shim is footgun removal, **not** a sandbox
or security boundary (tier is — R25); determined escapes remain by design and the
denylist must not grow ([R45](07-hard-won-lessons.md#sandbox-boundary)).

---

## OQ-4 — How does an open rollout survive `kill -9`? ✅ RESOLVED

**Resolved (owner, June 2026): see [D-09](01-architecture.md#decision-d-09-abandon-and-re-assign-interrupted-rollouts-no-resume).**

Chosen: **abandon and re-assign — no resume.** A rollout's durable artifacts are
already persisted (task in `ledger.open`; draft code on disk as `status: draft`, never
retrieved by P2; full history in the journal under `refs.rolloutId`, P4). The only
volatile state is the in-memory conversation, which crash-only already accepts losing.
On boot (startup step 7), every open task whose `Task.currentRolloutId` is still set has
its rollout journaled `god.rollout-abandoned{reason:'crash-recovery'}`, its pointer
cleared, and the task re-enters normal assignment with fresh `maxRetries`; orphan drafts
stay harmless `draft` versions.

Corrections from the design pass: crashes are now *rare* (D-08), so we design recovery
for an infrequent event (S3/S4); and "resume" turned out to collapse into the hybrid
(the crash may hit mid-trial before any `RunReport`), so it is more code than the OQ
implied. Honest limit: a non-idempotent task partially executed before the crash can
waste resources on re-attempt — mitigated (not eliminated) by the `check` gate and
generic-by-doctrine skills. Promote to resume only if re-proposal churn measures costly.

Adds one journal kind (`god.rollout-abandoned`) and one `Task` field
(`currentRolloutId?`).

---

## OQ-5 — What happens when a density message exceeds the token budget? ✅ RESOLVED

**Resolved (owner, June 2026): see [D-11](03-god.md#decision-d-11-never-trim-the-current-density-payload-bound-skill-size-at-the-source-per-tier-input-budget).**

Chosen: **never trim the current density payload; bound skill size at the source;
per-tier input budget.** Each revision = a fresh frame (identity, snapshot, exemplars,
retrieved, tools) + rollout history. The current density payload (current draft +
latest RunReport + latest critique), built fresh from persisted artifacts, rides in
the frame and is **never trimmed**; only *prior* revision turns trim, oldest-first, as
whole tool-call/result pairs (R20). The "message larger than the budget" case is made
impossible by construction: `write_skill` hard-caps code at `skills.maxSkillLines`
(default 400, decompose-or-reject — never prompt-time code truncation), sized so the
payload always fits the smallest tier. Per-tier input ceiling (not a target):
`strong 48k / fast 16k`, all owner-overridable; the hard floor is the reserve
invariant `inputTokenBudget ≥ frame + max-draft + RunReport + critique + headroom`.

Rejected: soft rule-of-thumb only (leaves the overflow gap) and prompt-time code
truncation (breaks density). New pitfall: R47. Deliverable test: exemplars + a
maxSkillLines-sized skill + a rendered snapshot + a critique fit `strong` with headroom
for ≥1 prior revision; trimming drops whole oldest pairs, never the current payload.

---

## OQ-6 — Where is the backpressure? ✅ RESOLVED

**Resolved (owner, June 2026): see [D-07](05-observability.md#decision-d-07-synchronous-journal-in-memory-pulses-lag-monitor-as-the-canary).**

Chosen posture: **instrument and wait.** The journal writes synchronously through
`better-sqlite3` in WAL mode (`PRAGMA synchronous=NORMAL`) on the shared event loop,
made safe by three rails: (1) **pulses are in-memory counters, never a `JournalKind`**
— the 20 Hz × 11-bot liveness stream never reaches the journal (also captured as
[R44](07-hard-won-lessons.md#journal-volume)); (2) `RunReport` payloads stay small
(Voyager-rendered snapshots); (3) v1's event-loop lag monitor is ported verbatim as
the backpressure *signal*, journaling a `system.loop-lag` event on a `max ≥ 1000 ms`
spike. `vitalsIntervalSeconds = 10`.

Rejected: an async batched write queue from day one (strains S5, trades P4 — buffered
events are lost at `kill -9`), and isolating the journal writer in its own
worker/process (pre-commits OQ-3's journal-isolation facet, adds per-append RPC — the
deferred escape hatch). Both solve a problem the lag monitor hasn't yet reported; they
are the pre-decided next steps *if and when* it does.

This also settles the one point where OQ-6 and OQ-3 touch: **the journal writer stays
in-process for v0**, which OQ-3 inherits.

---

## OQ-7 — What is the actual cost and latency budget? ✅ RESOLVED

**Resolved (owner, June 2026): see [D-13](03-god.md#decision-d-13-throughput-limited-budget-caps-are-a-safety-valve)** (one-page budget table lives there).

Chosen: **throughput-limited; caps are a safety valve.** Computed from the decided
mechanisms: ~10 calls/rollout (1 curriculum + 1 orchestrator + 2×~2.5 iterations + ~3
probation re-reviews on admit), ~15–25k input tokens/call, a **throughput ceiling of
~3 000 calls/day** at `maxConcurrent: 3` (the binding, wallet-independent limiter) ⇒
~300 rollouts/day ≈ ~30 attempts/villager/day, ~10–15 min/novel-skill convergence
(accepted — the slow-living posture), ~60M tokens/day at full tilt.

Per-desk daily token caps default **null** (the throughput ceiling bounds the worst
case); the real cost controls are structural — the **strong/fast tier split** (strong
for novelty; fast for dispatch/reactive/social/description/QA) and **zero-token
`subscription → skill` reactivity**. `god.budget` becomes a per-desk map +
`degradeOnBreach`, with a commented worked example for metered-API users
(`dailyTokens ≈ targetSpend ÷ pricePerToken`). Rejected: hard caps from day one
(throttles learning — R49) and raising concurrency for liveliness (a later tuning
lever, not v0). New pitfall: R49.

---

## How to use this doc

A ready-to-run co-design kickoff prompt lives in
[14-codesign-prompt.md](14-codesign-prompt.md). It drives the questions one at a time,
in the order **OQ-6 → OQ-3 → OQ-4 → OQ-1 → OQ-5 → OQ-2 → OQ-7** (cheap-and-foundational
first, then the M3 blockers, then the budget that depends on the rest), and turns each
decision into a `D-` record under the doc-drift law.
