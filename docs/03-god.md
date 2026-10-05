# 03 — God

One LLM entity. Three jobs. A body. God is Eden's answer to the question v1 never
asked: *who decides what good looks like?*

## One God, three desks

God's roles are separable **desks** — independent prompt templates, queues, and
(optionally) model tiers — under one persona and one shared state. The owner left
"multiple prompts vs. one that does everything" open; the build answers it with three
desks (D-19 below removed the never-implemented `combineDesks` flag):

```jsonc
"god": {
  "desks": {
    "critic":       { "model": "strong" },   // judgment quality is the product
    "curriculum":   { "model": "strong" },   // frontier selection compounds
    "orchestrator": { "model": "fast" }      // dispatch is cheap and frequent
  }
}
```

### Decision D-19: no combined-desk "cheap mode" (the `combineDesks` key is removed)

`combineDesks: true` ("one combined prompt handles all queued work per tick") was parsed from config but no
code ever read it — a setting that silently does nothing. It is removed (docs/22 B3.8): `god.combineDesks` is now
an unknown key (the R22 warning), and scenarios no longer carry it. *Chosen over* implementing it because the
cost lever it promised is already provided by the strong/fast tier split and the per-desk budget valve (D-13),
the throughput ceiling (not tokens) is what binds (R49), and a merged prompt would reintroduce exactly the
mega-context D-06 forbids. If a combined mode is ever wanted, it is a new decision with its own wiring.

### Decision D-06: desks share one state, never one context window

The three desks read and write the **same persistent state**
(ledger, dossiers, library view, knowledge cache) but each LLM call gets a
desk-shaped context. The failure mode this avoids is v1's god-prompt sprawl: one
mega-context where critique evidence, curriculum history, and dispatch chatter
crowd each other out of the window. Shared memory, separated attention.

```ts
interface GodState {
  ledger: TaskLedger;                  // curriculum desk owns writes
  dossiers: Map<string, Dossier>;      // per-villager: competence estimates, recent verdicts, notes
  knowledge: QaCache;                  // "how to X in Minecraft" Q→A store
  directivesOpen: Directive[];         // orchestrator desk owns
  criticQueue: CriticTicket[];
  budget: { callsToday: number; tokensToday: number; caps: {...} };
}

interface Dossier {
  villager: string;
  competence: Record<string, number>;  // tag → rolling success rate ('farming': 0.82)
  recentVerdicts: VerdictRef[];
  notes: string[];                     // God's own free-text observations
  standingOrders?: string;             // persistent guidance ("stop mining at night")
}
```

## The critic desk

(Owner decision #1: skills are judged by God, who guides through constructive
criticism.)

**Input — a `CriticTicket`,** filed by: rollout completion (always), an active
skill's failure tripwire, a villager's explicit plea (`ask_god` tool), or the
orchestrator wanting a second opinion.

The critic's context pack:
- the task (goal, success criteria as stated by curriculum) and the rollout's
  intent;
- the `RunReport` **complete**: args, outcome, error verbatim, call tree, durations,
  abort cause;
- the **code** of the skill version(s) involved — the critic always sees full code
  (this is the one consumer for whom code is never elided);
- world snapshots before/after, Voyager-rendered;
- the villager's dossier and the skill's stats;
- the last critique in this rollout chain, if any (so critiques build instead of
  repeating).

**Output — a `Verdict`,** structured tool call:

```ts
interface Verdict {
  ticketId: string;
  success: boolean;
  score?: number;                 // 0–10, optional nuance for the ledger
  critique: string;               // constructive, specific, actionable — the product.
                                  // "The dig loop never re-equips after the pickaxe
                                  //  breaks; check bot.heldItem each iteration."
  libraryAction: 'admit' | 'keep-draft' | 'quarantine' | 'archive' | 'none';
  followUp?:                      // optional, routed to the orchestrator desk
    | { kind: 'directive'; to: string; goal: string }
    | { kind: 'task'; suggestion: string };   // → curriculum inbox
  praise?: string;                // delivered in-world when embodiedVerdicts (flavor + reinforcement)
}
```

Routing: `libraryAction` executes against the library; `critique` lands in the
authoring villager's inbox (high-priority wake-up, becomes part of the next
revision's context); the verdict journals (`god.verdict`) with refs to ticket,
rollout, and skill version. The ledger and dossier update.

> **Resolved: see D-12.** (Was OQ-2 — wrong-critic backstop.)

### Decision D-12: three deterministic rails around the single verdict

**Chosen:** the critic stays the single judge (owner #1) and the library stays global
(owner #2); three engine-enforced rails contain a *wrong* verdict without relitigating
either:
1. **`check`-veto (one-directional).** A task's `check: {item, count}` failing
   post-run forces `success: false` / no admit regardless of the verdict — the task's
   own stated criterion was objectively unmet. A *passing* check still requires the
   verdict (it is not an auto-admit), so "evidence FOR the critic, not a bypass" is
   preserved in the passing direction and sharpened in the failing one. The critic
   still runs, critiques, and scores.
2. **Probation before composition.** An LLM-admitted version enters `active-probation`
   ([02 §Library](02-skill-system.md#the-library)): globally retrievable and runnable
   (owner #2 intact — no re-siloing), but **not composable** by other skills, and its
   first `skills.probationRuns` (default 3) production runs are auto-ticketed for
   re-review. After 3 clean re-judged runs it graduates to `active`. A fresh skill
   can't become a *dependency* until it survives real use — recovering v1's
   containment in the composition dimension that actually multiplies damage. Stock/
   exemplar skills skip probation (hand-review *is* their probation).
3. **Self-healing quarantine.** A quarantined skill that later succeeds on a forced
   re-trial re-enters `active-probation` (not straight to `active`) — R37
   (contradiction retires belief) applied to the library, so a wrongful quarantine
   heals without a second correct verdict, but a fluke success doesn't instantly
   restore it as a dependency.

**Rejected:**
- *Keep the `check` purely advisory* (no engine veto) — closest to the original
  wording, but discards the cheap deterministic catch of the most common false
  admission, relying on the same oracle that erred to heed its own failed check.
- *Two-vote admission for high-blast-radius skills* — stronger against false admission
  of divine/widely-composed skills, but doubles critic cost on them (OQ-7) and is
  largely redundant with probation-before-composition. **Deferred** as the escalation
  if false admissions ever measure frequent.

**Why:** probation contains the global library's blast radius in the composition+time
dimension (without re-siloing, so owner #2 stands) while the `check`-veto
deterministically catches the most common false admission — all without removing the
critic: God still judges everything; the rails only refuse to *act* on a verdict the
task's own check contradicts, and delay a fresh skill from becoming a dependency until
proven.

**Consequence:** the **hallucinated-critique** failure mode needs no new machinery —
it corrupts nothing (a wrong draft never admits if it keeps failing), is bounded by
`maxRetries: 4`, and self-corrects via the curriculum (a never-converging task becomes
a `failed` ledger entry → easier re-proposal). Adds a `active-probation` status + the
composition gate (D-12 in [02 §Library](02-skill-system.md#the-library)), one config
key (`skills.probationRuns`), and one pitfall (**R48**). Probation costs ≤3 re-review
tickets per admission (batchable via the critic's 3-per-call fan-in — feeds OQ-7).
Deliverable test (ScriptedLLM): (i) a critic wrongly admitting a no-op on a
check-carrying task → vetoed to `success:false`, skill stays `draft`; (ii) a
wrongly-quarantined skill succeeding on re-trial → `active-probation`, not `active`;
(iii) a probationary skill refused as a composition callee but runnable directly,
graduating after 3 clean runs.

**Tone is a product feature.** The persona prompt fixes it: God is demanding but
constructive, judges the work not the villager, always names the ONE most
instructive next change. Player-visible lines are French; internal critique fields
are English (they feed prompts).

## The curriculum desk

(Owner decision #6.)

Voyager's `CurriculumAgent`, globalized: it doesn't just answer "what next for this
bot," but "what next for the *village*."

```ts
interface TaskLedger {
  completed: TaskRecord[];          // deduped, with rolloutRef + score
  failed: TaskRecord[];             // retired when later completed (Voyager clean_up_tasks)
  open: Task[];
}

interface Task {
  id: string;
  goal: string;                                   // "Acquire an iron pickaxe"
  assignee?: string;                              // villager, or unset = orchestrator picks
  successCriteria: string;                        // prose the critic judges against…
  check?: { item: string; count: number };        // …plus optional exact inventory check
                                                  //    (v1's unfakeable verdict, kept as
                                                  //    evidence FOR the critic, not a bypass)
  context: string;                                // QA-cache "how to" answer, Voyager-style
  maxRetries: number;                             // default 4 (Voyager's number)
  parent?: string;                                // decomposition tree
  currentRolloutId?: string;                      // the live rollout, if any: enforces "one
                                                  //   rollout per task" and drives crash
                                                  //   recovery (D-09) — set null on boot abandon
}
```

Triggers for a curriculum tick: a villager goes idle with no open task; a verdict
closes a task; dawn (one village-wide review per Minecraft day, inheriting v1's
day rhythm); a `followUp.task` suggestion from the critic; admin request.

The proposal prompt receives: the ledger (completed/failed lists — the frontier),
the requesting villager's dossier and snapshot, library coverage by tag ("you have
no cooking skills at all"), village stock levels, and the relevant QA-cache
entries. It must propose **one task at the edge of current ability** — exactly
Voyager's instruction — and emit it as a `propose_task` tool call.

Ported Voyager mechanics, kept deliberately:
- **QA knowledge cache:** "How to smelt iron in Minecraft?" answered once by the
  `fast` tier, embedding-deduped, persisted, attached as `Task.context` forever
  after. The village's accumulated Minecraft handbook.
- **Decomposition:** a `decompose(goal) → Task[]` prompt for big goals (used by
  the orchestrator for village projects, and by `/pray`-style player wishes later).
- **Warm-up:** early ledger small → proposals stay survival-basic; context fields
  unlock as `completed.length` grows. (A config table, not code.)

Dropped: Voyager's environment manipulation (difficulty stepping, resets) — live
shared world, out of scope by owner decision #12.

## The orchestrator desk

(Owner decision #4: God "gives orders around and organizes the troops from the
skies".)

The orchestrator turns tasks and events into **directives** — data, not code:

```ts
interface Directive {
  id: string;
  to: string | string[] | 'all';
  goal: string;                        // "Escort Colette to the mine entrance"
  reason: string;                      // shown to the villager — God explains itself
  priority: 'background' | 'normal' | 'interrupt';   // interrupt = abort current skill tree
  taskRef?: string;
  expiresAt?: number;
  standing?: boolean;                  // survives completion; lives in the dossier
}
```

Delivery: directive → villager inbox → schedules a deliberation (or, for
`interrupt`, aborts the current run first — reported as `aborted: 'preempted'`,
which the critic knows is benign). The villager's brain decides *how*; the
directive says *what and why*. Villagers can push back (`report_to_god` tool with
an objection) — refusal is information, journaled, dossier-noted.

Orchestrator triggers: new/closed tasks, verdict `followUp`s, world events routed
to God (raid sighted, villager death, night with stragglers outdoors), idleness
sweeps, player commands. The prompt sees: open directives, who is doing what
(current runs), dossiers, the event, and answers with directive tool calls —
typically the `fast` tier; dispatch is frequent and shallow.

Anti-thrash rules (engine-enforced, not prompt-hoped): max 1 open non-standing
directive per villager; an `interrupt` cannot fire at the same villager twice
within 5 minutes; conflicting directives auto-supersede oldest-first, journaled.

**Direct intervention.** Delegation is the default, but the orchestrator (and the
critic, when staging a re-test) may act in the world itself via `run_skill` on the
avatar — divine stage-setting ([02 §Tiers](02-skill-system.md#tiers-mortal-and-divine)):
spawn three zombies at the training ground for a combat task, clear the rain
before a harvest push, deliver starter tools to a new villager, fly overhead to
survey terrain before assigning builders. Doctrine, fixed in the prompt and
auditable in the journal: **interventions set stages and teach; they never do a
villager's task for it.** A task whose success criteria were met by divine action
is voided by the critic (`success: false`, critique names the overreach), so
intervention can never inflate the ledger.

## The body

(Owner: God orchestrates "from the skies, basically, or with its own Mineflayer
body that it already has.")

Eden hosts the avatar as bot #11 in its own pool (D-01) — username `Dieu`,
**never** v1's `LLMBot` ([07 §Identity](07-hard-won-lessons.md#identity--protocol)).
The avatar is op'd (R14) and runs creative when configured: it is the village's
only **divine-tier runner** ([02 §Tiers](02-skill-system.md#tiers-mortal-and-divine)).

**God acts through skills, like everyone else.** The body primitives —
`appear-near`, `vanish`, `gesture` — are stock *divine* skills, and every God desk
carries a `run_skill` tool bound to the avatar
(`ctx.runner = { name: 'Dieu', role: 'god', tier: 'divine' }`). A manifestation, a
smite, a summoned training mob, a flight over the village: each is a journaled
`skill.run` like any villager's work — God's interventions are exactly as
inspectable, criticizable, and website-renderable as everything else (P4).
`god/body.ts` reduces to typed sugar over `skills.run` for the deterministic
theatrics (verdict delivery), so non-LLM code paths don't hand-roll tool calls.

**The body is theatrics with teeth, never a dependency.** Every directive and
critique reaches its villager through the inbox regardless; when
`embodiedVerdicts: true`, God *additionally* manifests to deliver notable verdicts
in person (admissions, harsh failures, village-wide orders). If the avatar bot is
disconnected, divine skill runs fail like any disconnected runner's and nothing
functional degrades.

**Demonstration teaching is supported now** (no longer future work): God runs a
*mortal* skill on the avatar in front of its author to show corrected behavior —
the cross-tier chat interceptor guards the op'd bot during such runs
([02 §Tiers](02-skill-system.md#tiers-mortal-and-divine)).

## The refinement loop

The heart of Eden — Voyager's rollout loop with the roles redistributed
(owner decision #4: generation stays close to the actor; criticism and
orchestration are God's).

```
            CURRICULUM DESK                      (1) Task{goal, criteria, context, maxRetries}
                  │ propose
                  ▼
            ORCHESTRATOR DESK                    (2) assigns → Directive{to: villager, taskRef}
                  │ dispatch
                  ▼
   ┌─────── VILLAGER BRAIN ────────┐             (3) plan: search_skills / read_skill;
   │  reuse active skill?          │                 reuse if one fits…
   │  else write_skill (draft vN)  │             (4) …else author. Parse errors retry inline.
   └──────────────┬────────────────┘
                  ▼
            SKILL ENGINE                         (5) trial run on the real world
                  │ RunReport (+ world before/after)
                  ▼
            CRITIC DESK ──────────────────────►  (6) Verdict
                  │                                   success → admit (active) → ledger ✓
                  │ critique                          → orchestrator: next assignment
                  ▼
            VILLAGER BRAIN                       (7) failure → critique + report + OWN CODE
                  │ revise (draft vN+1)               back in ONE context — the Voyager
                  └────────────► engine (5)           density requirement — retry ≤ maxRetries
                                                 (8) retries exhausted → ledger ✗ (failed),
                                                     draft archived, curriculum learns the
                                                     frontier; God may file an easier task
```

**Density requirement (the v1 lesson, now an invariant):** step (7)'s revision
prompt must contain, in one message: the full draft code, the verbatim error/outcome,
the rendered world state, and God's critique. No scheduler coalescing, no
suppression memo, no cooldown applies *inside* an open rollout — the rollout chain
is one conversation with persistent context, capped only by `maxRetries` and a
token budget. Suppression heuristics apply *between* rollouts, never within.

> **Resolved: see D-11.** (Was OQ-5 — density vs token budget.)

### Decision D-11: never trim the current density payload; bound skill size at the source; per-tier input budget

**Chosen:** each revision deliberation = a **fresh frame** (identity, situation
snapshot, exemplars, retrieved one-liners, tools — rebuilt every call, never stored)
+ the **rollout conversation history** (prior revision turns). The *current density
payload* — current draft code + latest `RunReport` (verbatim error + before/after
snapshots) + latest critique — is built fresh from persisted artifacts and rides in
the frame, so it is **never trimmed**. Only the *earlier* revisions trim, **oldest
first, as whole tool-call/result units** (R20); each revision supersedes the prior,
so this is near-lossless (R19: token-budget, not message-count).

The "single revision message larger than the budget" case is made **impossible by
construction**: `write_skill` enforces a hard size cap (`skills.maxSkillLines`,
default 400 — a decompose-or-reject error, never prompt-time truncation of code,
which would blind the critic). The cap is sized so `frame + maxDraft + RunReport +
critique + headroom` always fits the smallest configured tier — and it reinforces
composition (S4 / Voyager rule 2) instead of hoping for it.

Per-tier **input** budget (a ceiling, not a target — calls use only what they need):
`llm.providers.strong.inputTokenBudget = 48000`, `fast = 16000`. Derivation: frame
≈ 10k (exemplars ~5k + system/tools ~3k + snapshot ~2k) + current payload ≈ 6.5k
(400-line draft ~4k + RunReport ~2k + critique ~0.5k) ⇒ reserve ≈ 16k; the remainder
holds a full `maxRetries: 4` rollout un-trimmed on `strong` with output headroom.
v1's God ran a 16k *total* window (`ChatBot MAX_MEMORY_TOKENS`); Eden needs more
because the density payload (full code + exemplars + before/after snapshots) is
heavier than v1's chat turns. **All numbers are owner-overridable defaults** — lower
them for small-context local models; the reserve invariant (below) is the only hard
floor.

**Rejected:**
- *Soft rule-of-thumb only* (S4 ~300 lines as guidance, no enforcement) — leaves
  exactly the gap OQ-5 named: a pathologically large skill could overflow the current
  payload with no defined branch.
- *Prompt-time code truncation* — preserves the budget but breaks density (the critic
  needs full code, [03 §Critic](03-god.md#the-critic-desk)).

**Why:** bounding the payload at the *source* (write_skill) is the only option that
keeps the density invariant a guarantee rather than a hope, and it pushes toward
composition — the behavior we want anyway. Trimming history oldest-first is
near-lossless because revisions supersede.

**Consequence:** the **reserve invariant** any tier used for a rollout role
(authoring villager brain + critic) must satisfy: `inputTokenBudget ≥ frame +
(maxSkillLines-sized draft) + RunReport + critique + headroom`. Config validation
warns if a configured budget violates it. Adds two config keys
(`skills.maxSkillLines`, `llm.providers.<tier>.inputTokenBudget`) and one pitfall
(**R47**). Deliverable test: assert the exemplar set + a `maxSkillLines`-sized skill
+ a rendered snapshot + a critique fit within `strong.inputTokenBudget` with headroom
for ≥1 prior revision; and that trimming drops whole oldest tool-call/result pairs,
never the current payload, never mid-pair.

**Who writes code** is per-task configurable, default villager:

```jsonc
"authoring": "villager"   // | "god" — God writes the draft itself, villager only executes
```

The villager default keeps generation where the local context is (its memory, its
position, its inventory) and makes the future economy meaningful (villagers as
authors with reputations — [06](06-future-extensions.md)). `"god"` mode exists for
bootstrapping (seeding the library fast) and as an A/B lever.

## Cost control

God is one entity but many calls. Budgets are engine-enforced:

> **Resolved: see D-13.** (Was OQ-7 — cost & latency budget.)

### Decision D-13: throughput-limited budget; caps are a safety valve

**The budget, computed from the decided mechanisms** (maxRetries 4, maxConcurrent 3,
D-11 budgets, D-12 probation re-reviews):

| Quantity | Value |
|---|---|
| Calls / rollout | **~10 avg** = 1 curriculum + 1 orchestrator + 2 × ~2.5 iterations + ~3 probation re-reviews on admit. Range 4 → ~13. |
| Tokens / call | ~15–25k input + ~1–4k output; critic (full code + snapshots) and late revisions (density + grown history) heaviest. |
| **Throughput ceiling** | 3 slots × 86 400 s ÷ ~75 s/call ≈ **~3 000–3 500 calls/day** — wallet-independent; the real v0 limiter. |
| Rollouts / day | ~300 across ten villagers ≈ **~30 skill attempts/villager/day**. |
| Convergence / novel skill | 4 × (~60 s deliberate + ~45 s run + ~60 s critic) ≈ **~11 min unqueued**; more under contention. |
| Tokens / day | ~60M at full tilt. |
| $ / day | 60M × *provider $/token*. **Local ≈ $0**; frontier API ≈ tens-to-low-hundreds. |

**Chosen:** at maxConcurrent 3 the **throughput ceiling (~3 000 calls/day) is the
binding constraint, not dollars** — ten bots can't physically exceed it through three
slots. So per-desk daily token caps default **`null` (uncapped)**; the primary cost
controls are structural and cheaper:
- **Tier split:** `strong` for novelty (authoring/revision, critic, curriculum);
  **`fast`** for high-volume shallow work (orchestrator dispatch, reactive/social
  deliberation, description-from-code, QA-cache).
- **Zero-token triggers:** `subscription → skill` handlers, QA-cache hits, `tick-30s`
  polls resolving to skill handlers. Role defaults prefer skill handlers wherever a
  proven skill exists, so LLM spend lands only on novelty.
- **Caps as a safety valve:** `god.budget.perDesk.<desk>.dailyTokens` (default null),
  with `degradeOnBreach` wired to the graceful-degradation already specced (critic →
  `check` + templated critique; curriculum → repeat last task type; orchestrator →
  urgent-only). A worked example set ships commented in the sketch for metered-API
  users; size it `dailyTokens ≈ targetSpend ÷ pricePerToken`.

Convergence at **~10–15 min per novel skill is accepted** — the "slow-living village"
posture ([00](00-vision.md)); lively second-to-second reactivity comes free from
skill-handler subscriptions, no LLM latency.

**Rejected:**
- *Concrete hard per-desk caps from day one* — predictable ceiling, but throttles
  *learning* when breached (re-creating v1's suppression pathology in budget form) and
  needs a provider price to size. Available by setting the keys; just not the default.
- *Raise concurrency / cheaper tiers for liveliness* — pushes past ~300 rollouts/day
  but at higher spend / more local horsepower; revisit the throughput math then. A
  later tuning lever ([08 §Scaling](08-extension-recipes.md#scaling-escape-hatches--pre-decided-so-nobody-panics-later) #4), not v0.

**Why:** the structural levers (tier split + zero-token reactivity) cut real spend far
more than a hard cap would, without gagging the refinement loop; and the throughput
ceiling already bounds the worst case wallet-independently, so a daily cap is a valve
to set per-provider, not a primary control.

**Consequence:** config `god.budget` becomes a per-desk map + `degradeOnBreach`; new
pitfall **R49**. The probation re-reviews (D-12) and density growth (D-11) are folded
into the ~10 calls/rollout above — this table is the live cost model; update it if any
of those constants move.

- Per-desk daily call/token caps; breach → desk degrades gracefully (critic
  falls back to the inventory `check` alone + a templated critique; curriculum
  re-issues the last task type; orchestrator stops non-urgent dispatch) and an
  admin warning journals.
- The scheduler treats God desks as one client class with priority
  `critic > orchestrator(interrupt) > curriculum > orchestrator(rest)`; villager
  brains keep v1's per-bot cooldowns, God has none (it is the bottleneck resource,
  not the spam risk).
- Verdict batching: the critic may receive up to 3 tickets in one call when the
  queue backs up (one verdict tool call each, same context fan-in).
