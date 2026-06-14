# 10 — Architectural choices, part by part (executive summary)

A condensed map of every architectural choice in Eden and why it was made — one
section per part of the system, with what was **rejected** alongside what was
**chosen**. This is the orientation doc: read it first if you want the shape of
the whole design in ten minutes, then drill into the linked specs. Nothing here
is normative on its own — the linked docs are the spec ([README.md](README.md)
has the full reading order and the 13 owner decisions).

## The organizing idea

One sentence governs everything: **one God closes every loop.** A single LLM
entity judges skill runs (critic), sets the curriculum, and orchestrates the
villagers — and skills are typed, composable JS functions in **one God-owned
library**, admitted only after a verified successful run.

This directly attacks v1's four caps ([00 §Why a rewrite](00-vision.md#why-a-rewrite)):

1. per-villager skill silos (learning never compounded),
2. a closed 27-verb API (novel skills impossible by construction),
3. no success judge (skills entered the library when they *compiled*, not when
   they *worked*),
4. a feedback loop shredded by anti-spam scheduling (coalescing/cooldowns gagged
   the dense repetition debugging needs).

## Process topology ([01-architecture.md](01-architecture.md))

| Choice | Decision | Rejected | Why |
|---|---|---|---|
| **One Node process** — bots, God brain, avatar, skill engine, journal, admin server | D-01 | v1's three-process split (unified god-body + village + Java-resident brain) | The refinement loop is chatty: a verdict touches library, journal, inbox, and avatar within milliseconds. Cross-process hops bought only failure modes (silent 404s, port collisions, double logins). Worker threads stay available as the escape hatch. |
| **Java mod keeps only server-authority duties** | D-02 | — | Atomic trade settlement (:8767), Gibber coins, op-on-join for the avatar, admin command. Zero new LLM code in Java. |
| **SQLite as the spine** (`better-sqlite3`, WAL) | D-03 | v1's constellation of dirty-flag JSON files; log-file-as-database | Journal + library index + stats + ledger + directives + subscriptions in one DB. The website requirement makes "query everything, stream everything" first-class. Skill *code* stays as plain `.js` files (greppable, diffable); per-bot memory stays JSON (human-editable). |
| **Crash-only design** | [01 §Startup](01-architecture.md#startup-sequence) | graceful-shutdown bookkeeping | State persists when it changes; `kill -9` loses at most in-flight LLM calls and current actions. |
| **New admin port 8770** | [01 §Config](01-architecture.md#configuration-sketch-edenjson) | reusing v1's 876x | v1 (8765/8766/8767) must run side-by-side during transition; 8767 (Java settlement) is shared, stateless per request. |

## Skill system ([02-skill-system.md](02-skill-system.md)) — the core asset

- **Shape:** every skill is `async (bot, args, ctx)` with a manifest carrying
  JSON-Schema `params`/`returns`, a one-line English summary, tags, and a tier.
  Skills return structured data (the critic reads it) — never `bot.chat` as the
  only signal. No event registration inside skills: skills are pure
  capabilities; reactivity lives in subscriptions.
- **D-04 — Typed via schemas + runtime validation, not a compiler.** Rejected:
  v1's `tsc`-against-`.d.ts` gate (owner decision — full-API access makes static
  checking meaningless, and the typechecker mostly fought the model). Runtime
  validation keeps the two real benefits types were buying: readable boundary
  errors and prompt signatures that can't lie (rendered *from* the schemas).
- **One global, God-owned library** (owner decision #2) with **append-only
  versioning** — `v4` supersedes `v3`, files stay on disk forever. Status
  machine: `draft → active-probation → active`; a wrong verdict is contained by
  three deterministic rails (D-12/R48): a one-directional **`check`-veto** (a failed
  inventory check can't admit), **probation-before-composition** (a fresh admission
  is globally runnable but not a composition dependency until 3 clean runs — v1's
  containment without re-siloing), and **self-healing quarantine** (a re-trial
  success re-enters probation). `quarantined` replaces v1's 3-strike auto-disable
  (God decides; a dumb 5-consecutive-failure tripwire backstops a long critic queue
  and files a ticket either way). No skill-count cap — retrieval quality, not
  storage, is the scaling concern.
- **Validation = watchfulness, not gates** (P3): syntax parse only — no sandbox,
  no banned identifiers, no import scanning. The ONE kept AST pass is the acorn
  loop-budget injection: the only in-process answer to a synchronous
  `while (true)` that would freeze the whole host. Runtime supervision: per-call
  wall-clock cap (default 120 s, hard 2 h ceiling), a **stall detector** ("it's
  not supposed to pause" — a pulse is a discrete progress *event*: position/
  inventory/window/dig/place plus **pathfinder liveness events** (the R26 fix) and
  the `ctx.log`/`sleep` skill contract; `stallSeconds` = 20 uniform without one
  aborts — D-10/R46), and the hardened v1 abort
  protocol on every exit path. **Crashes escalate to the LLM loop** (critic
  queue + author's next context pack), never suppressed. The one footgun with
  unbounded blast radius — `process.exit`/`reallyExit`/`abort`/`kill` — is neutered
  by a scope shim (D-08): a provided binding, not a banned-identifier scan, so it
  catches the accident without becoming the sandbox P3 rejected (R45). The host runs
  supervised (pm2) with crash-only respawn.
- **Composition** (owner decision #7): `ctx.skills.run(name, args)` — args
  validated against the callee's schema; depth cap 8 (v1's 2 made skills mere
  macros) with cycle detection; one shared budget/signal/report per call tree.
- **D-05 — Serialized execution per bot:** one skill tree at a time, queued or
  preempted. Mineflayer can't multiplex a body; v1's worst bugs were two
  controllers fighting one bot.
- **Tiers — mortal vs divine** (owner decision #13): an **engine-enforced
  security boundary**, deliberately NOT part of the mutable `GrantPolicy`.
  Villagers are never op'd; the avatar is the only divine runner. Mortal never
  calls divine (no escalation through the call graph); divine skills are
  invisible in villager retrieval; when the avatar runs a *mortal* skill
  (demonstrations), a chat interceptor drops `/`-prefixed messages (R25).
- **Retrieval & prompting** (owner decisions #8, #10 — Voyager-style): ~6
  exemplar skills always in prompts as **full code** (the model learns the
  dialect every time); everything else as `signature — summary` one-liners via
  multilingual-embedding retrieval with keyword fallback; full code only through
  the `read_skill` tool on explicit request. `write_skill` is one upsert tool
  (create = update). Descriptions are LLM-generated *from the final code* at
  admission — self-descriptions drift aspirational.
- **The power ceiling — full mineflayer** (owner decision #11): skill code gets
  the actual bot object, no wrapper API. The wrapper's lost services are
  replaced by exemplar code + a curated cheat-sheet (discoverability), runtime
  schema validation (arg safety), engine-level serialization (D-05), and the
  hardening corpus baked into helpers/exemplars (anti-footgun).
- **The economy seam** (owner decision #3): every retrieval and every run
  already passes through a two-method `GrantPolicy`; v0 ships only `AllGranted`.
  That interface is the entire price paid now for the future skill market.
- **Admission invariant** (P2): retrieval and `run_skill` for normal work only
  ever see `active` versions; drafts are runnable solely inside their own
  rollout's trials. God cannot be bypassed.

## God ([03-god.md](03-god.md))

- **Three desks, one persona:** critic / curriculum / orchestrator —
  independently promptable and model-tierable (critic and curriculum on
  `strong`, orchestrator on `fast`), with a `combineDesks` cheap mode behind a
  config flag (the owner left one-vs-many prompts open).
- **D-06 — Desks share one state, never one context window.** Shared ledger,
  dossiers, QA-cache; each LLM call gets a desk-shaped context. Avoids v1's
  god-prompt sprawl where critique evidence, curriculum history, and dispatch
  chatter crowded each other out of the window. Shared memory, separated
  attention.
- **Critic desk** (owner decision #1): judges `RunReport`s — full code (the one
  consumer for whom code is never elided), world before/after snapshots, call
  tree, abort cause — and returns a structured `Verdict`: success flag,
  **constructive critique as the product**, and a library action. Tone is fixed
  in the persona prompt as a feature: demanding but constructive, names the ONE
  most instructive next change.
- **Curriculum desk** (owner decision #6): Voyager's CurriculumAgent
  globalized — "what next for the *village*," one task at the edge of current
  ability. Ported Voyager mechanics kept deliberately: the QA knowledge cache
  (answered once, embedding-deduped, attached as task context forever),
  decomposition, warm-up gating, `maxRetries: 4`. Dropped: environment
  manipulation/resets (live shared world, owner decision #12).
- **Orchestrator desk** (owner decision #4): emits **directives — data, not
  code** (goal + reason + priority + expiry), with engine-enforced anti-thrash
  rules (max 1 open non-standing directive per villager; no repeat `interrupt`
  within 5 min; conflicts auto-supersede oldest-first). Villagers can push back —
  refusal is information, journaled. Direct in-world intervention via divine
  skills is allowed but doctrine-bound: **interventions set stages and teach,
  never do a villager's task** — the critic voids any task completed by divine
  action.
- **The body:** avatar `Dieu` is bot #11 in the same pool, the only divine
  runner. **God acts through journaled skill runs like everyone else** —
  `appear-near`, `vanish`, `gesture`, `smite`, `summon-creature` are stock
  divine skills (P4: as inspectable as any villager's work). Theatrics with
  teeth, never a dependency: every directive/critique reaches its villager
  through the inbox regardless; a disconnected avatar degrades nothing
  functional.
- **The refinement loop** (the heart): task → directive → villager plans (reuse
  or `write_skill`) → trial run → verdict → critique-driven revision. The key
  invariant distilled from v1's pain — **density**: the revision prompt carries
  full draft code + verbatim error + rendered world state + God's critique in
  ONE message, and no coalescing/cooldown/suppression applies *inside* an open
  rollout. The current density payload is **never trimmed**; prior revisions trim
  oldest-first as R20 pairs, and `write_skill` hard-caps skill size
  (`maxSkillLines`) so the payload always fits the per-tier input budget (strong
  48k / fast 16k) — D-11/R47. Authoring is per-task configurable (default villager;
  `"god"` mode for bootstrapping).
- **Cost control** (D-13/R49): **throughput-limited** — at `maxConcurrent: 3` the
  ~3 000 calls/day ceiling (not the wallet) is the binding limiter, so per-desk daily
  token caps default null and act as a safety valve (`degradeOnBreach` → critic
  falls back to the inventory check + templated critique). The real levers are the
  strong/fast tier split and zero-token `subscription → skill` reactivity. Budget
  model: ~10 calls/rollout, ~300 rollouts/day, ~10–15 min/novel-skill. God preempts
  villager lanes in the scheduler — it is the bottleneck resource, not the spam
  risk.

## Villager runtime ([04-villager-runtime.md](04-villager-runtime.md))

- **Event system** (owner decision #7): raw mineflayer signals normalize into a
  small, closed, growable set of typed events; edge-style events (`health-low`,
  `night-falls`) carry hysteresis **in the emitter** so subscribers never need
  debounce logic.
- **Subscriptions — filters as data** (P5): declarative AND-composed clauses
  (proximity, entity kind, name, time-of-day, `notWhileRunning`), no predicate
  code. Two handler outcomes: **`skill`** (free, zero tokens — v1's "reflex"
  rebuilt as a data binding to a *proven library skill*) or **`deliberate`**
  (LLM escalation with a hint). This replaces v1's reflex/routine two-engine
  split with one skill kind plus a subscription layer. Role defaults are config
  data, not code.
- **The brain:** one deliberation = one LLM conversation (context pack → tool
  calls → `done`). Crucially, **direct micro-action tools do not exist** — all
  world effects go through `run_skill` on library skills, forcing the library to
  stay the single vocabulary of action (P2) and making every effect a journaled,
  criticizable run.
- **The context pack** (owner decisions #7, #10): deterministic assembly in
  eight ordered sections (identity/persona, trigger, Voyager-rendered snapshot,
  current activity, recent past, retrieved memories, capabilities, inbox), each
  with a token ceiling and truncation rule; section sizes journal with the
  wake-up so prompt bloat is measurable, not vibes.
- **Memory:** v1's proven design ported (window ~200 → archive 2000 +
  summarization with keyword/importance/lesson enrichment; retrieval =
  `0.5·relevance + 0.25·recency + 0.25·importance` with multilingual embeddings
  and keyword fallback) with two simplifications: `refuteBlockedBeliefs` moves
  to the critic's verdict delivery, and mood/drives become optional config.
  Relations and the trade ledger become journal-derived views.
- **Scheduling:** v1's vocabulary survives (global concurrency cap, priority
  lanes, per-villager cooldown, coalescing) with three amendments: **God
  preempts**; **rollout immunity** (revision turns bypass all suppression — the
  density invariant); and the "identical error → exponential suppression" memo
  is **deleted** — repeated failure becomes ledger/dossier signal that makes God
  change the task or quarantine the skill, instead of an engine silently
  swallowing wake-ups. Only a dumb per-minute rate cap remains as a circuit
  breaker.

## Observability ([05-observability.md](05-observability.md))

- **The journal is the source of truth** (P4: *if it didn't journal, it didn't
  happen*). Append-only SQLite table; every event carries `actor` and a `refs`
  causality column — the future website's rollout-replay view is literally
  `SELECT * WHERE refs.rolloutId = ? ORDER BY at`. Adding a kind = one registry
  row in `journal/kinds.ts`.
- **Backpressure: instrument and wait** (D-07). Synchronous WAL writes
  (`synchronous=NORMAL`) on the shared loop, made safe by keeping the hot stream
  out of the journal — **pulses are in-memory counters, never journaled** (R44),
  `RunReport` payloads stay small — with v1's event-loop lag monitor ported as the
  backpressure signal (`system.loop-lag` on a `max ≥ 1000 ms` spike). Async write
  queue and writer isolation are the pre-decided escape hatches, built only on the
  monitor's evidence. `vitalsIntervalSeconds = 10`.
- **Derived state, not duplicate state:** skill stats, dossier competence,
  relations, the trade ledger, "who is doing what" — all folds over journal
  events, cached and rebuildable by replay (`eden rebuild-stats`) (derived views
  only; live state is never event-sourced — consistent with S5). Writers
  append facts; readers fold facts into views. Kills v1's two-sources-of-truth
  failure mode.
- **Admin API now, website later** (owner decision #9): localhost HTTP +
  WebSocket journal stream ship with v0; the future website must be a **pure
  consumer** of exactly these routes — views via GET/WS, controls (prompt a
  villager, pause, quarantine) via the POST verbs, every mutating verb
  journaled before it acts. A needed feature is an API gap to fix
  here, not website code. LLM prompt bodies stay out of the journal (size,
  secrets-adjacent); `debugPrompts: true` writes per-call files referenced from
  the `llm.call` event.
- **Logging conventions:** human logs keep v1's act-label-and-duration habits
  (the debugging playbook depends on them); `console.*` is banned outside the
  logger; log tags name the true actor (R41).

## Hard-won lessons as acceptance criteria ([07-hard-won-lessons.md](07-hard-won-lessons.md))

Not architecture per se, but **requirements** — R1–R49 (R44–R49 added by the OQ
co-design), each encoding a real v1 debugging session (or a co-design landmine) the
rewrite must not re-discover. The headline clusters:

- **Crafting** (R1–R3): close stray windows first (window hijack), trust
  inventory diffs only after packet quiescence, pause auto-eat/armor-manager
  around multi-click sequences.
- **Abort** (R4–R5): aborting is a *sequence* — collectblock targets → pvp stop
  → pathfinder `stop()` THEN `setGoal(null)` → close window → macrotask settle.
- **Movement** (R6–R10, R26): bound the pathfinder at spawn (upstream default is
  UNBOUNDED), hop far goals in ≤40-block legs, `viewDistance: 'short'`, benign
  preemption ≠ failure, trunk-logs-only collection.
- **Identity & protocol** (R11–R14): 1.21.1 pin everywhere, username uniqueness
  across ALL processes, staggered logins, op only the avatar.
- **LLM plumbing** (R19–R22): token-budget memory, tool-call/result adjacency is
  sacred, timeouts ≠ retriable resets, config warns on unknown keys.
- **Cognition economics** (R33–R37): recover mechanically recoverable errors in
  the tool; completion ≠ progress but quiet ≠ futile (why "did it work?" needs a
  judge, not a counter); one incident = one wake-up; every suppressor needs a
  release valve; contradiction retires belief.
- **Operations** (R28–R32, R38–R43): two servers/two cwds, port 8767 theft by
  the dev server, world-regen poisons *beliefs* not just coordinates (stamp data
  dirs with a world id), event-loop lag monitoring, eval-harness sharp edges, no
  nested git.
- **OQ co-design landmines** (R44–R49): never journal a per-tick stream (pulses
  stay in RAM); the syscall shim is footgun-removal, not a sandbox (don't grow the
  denylist); a stall pulse is a discrete *event* and pathfinder liveness is a pulse
  source (the R26 fix); never trim the current density payload — source-cap skill
  size instead; contain a wrong verdict with one-directional rails, not silos; at
  low concurrency the limiter is throughput, not the wallet (don't cap-throttle the
  loop).

## Keeping it simple ([08-extension-recipes.md](08-extension-recipes.md))

v1 didn't blow up from one bad decision — it blew up from fifty reasonable
patches with nowhere clean to land. Eden's defense is structural:

- **The dependency law**, CI-enforced with `dependency-cruiser`: strict downward
  imports (actors → engines → substrate → types); layer-3 modules
  (god/villagers/social) never import each other — they communicate through
  layer-1/2 objects wired at composition time; `main.ts` is the only composition
  root; nothing imports `admin/` (a pure consumer, deletable).
- **Ten simplicity rules (S1–S10)** — the load-bearing ones: additions are
  **registry rows, never branches** (S1); **one writer per state** (S2); no
  abstraction before the second consumer (S3, `GrantPolicy` the one deliberate
  exception); a **banned-machinery list** — DI containers, plugin loaders,
  event-sourcing for live state, in-process message queues, ORMs (S5); prompts
  in dedicated files with golden snapshot tests (S6); **doc-drift law** —
  behavior and docs change in the same commit (S8); **special cases feed the
  judge** — code captures the signal, God's critic applies the policy (S9);
  errors carry evidence (S10).
- **Extension recipes:** mechanical procedures (exact files touched) for every
  common addition — event type, journal kind, villager tool, exemplar skill,
  divine power, filter clause, desk behavior, config key, admin route, derived
  table. Stepping outside a recipe's file list means the change is fighting the
  architecture (S4).
- **Scaling escape hatches, pre-decided:** worker threads for melting skill
  trees; token auth + process split for a non-local website; monthly SQLite
  files for journal growth; model tiers + budget caps for cost spikes.
  Process-per-bot is the explicit LAST resort (it reintroduces failure mode #5).

## Future seams ([06-future-extensions.md](06-future-extensions.md))

v0 pays for **interfaces, not features** (P7):

| Future feature | Seam that exists in v0 |
|---|---|
| Skill economy (buy/sell/work-for-skill) | `GrantPolicy` on every retrieval and run; authorship + provenance already tracked; Gibber `coin` + settlement listener as payment rails; one new `OfferSide` variant |
| Per-villager proficiency | Dossier `competence` map already accumulates villager × tag success rates; the modifier is one engine function |
| Multi-village / multi-God | Library keyed by God; a second village = a second Eden process sharing only the MC server + settlement listener |
| The website | Consumer of the admin REST + WS routes, controls included — the villager prompt box is `POST /villagers/:name/prompt` → `inbox` event ([05](05-observability.md)) |
| `/pray` integration | Retire the Java ChatBot God; forward prayers to Eden's orchestrator desk as player-sourced tickets |
| Voice (SVC) | One new event emitter (`player-voice`) + TTS effector on `say`; context packs unchanged |

## Status & build order

Design phase — **no Eden code exists yet**. v1 stays runnable
(`npm run village`) until parity; the two must never share bot usernames (R12).
Implementation follows [01 §Build order](01-architecture.md#build-order-for-the-implementing-agents)
M0→M7, with **M3 — the refinement loop — as the explicit
do-not-parallelize-past-it heart**: one villager must converge reliably on
trivial tasks through the full task → draft → run → verdict → revise → admit
cycle before anything is built in parallel to it. The kickoff prompt for the
implementing agent is [09-agent-kickoff-prompt.md](09-agent-kickoff-prompt.md).

## Open design questions — all resolved (June 2026)

Seven mechanisms were surfaced as genuinely unresolved and co-designed with the owner;
each became a `D-` record (D-07…D-13) in its home doc, with new landmines captured as
R44…R49. Collected in [13-open-questions.md](13-open-questions.md). M3 is unblocked:

- ~~**OQ-1** — stall-detector pulse semantics (vs R26's legitimate long pathfinder
  burns)~~ → **RESOLVED, D-10** (pulse = discrete event + pathfinder liveness; stallSeconds 20)
- ~~**OQ-2** — what backstops a *wrong* critic verdict, given the global library's
  blast radius~~ → **RESOLVED, D-12** (check-veto + probation-before-composition + self-healing quarantine)
- ~~**OQ-3** — single-process blast radius: cost of one `process.exit()` under D-01
  + P3~~ → **RESOLVED, D-08** (neuter host-killing syscalls + pm2 crash-only)
- ~~**OQ-4** — crash-only resume of an open rollout chain~~ → **RESOLVED, D-09**
  (abandon & re-assign the still-open task; no resume)
- ~~**OQ-5** — the density invariant vs the rollout token budget~~ → **RESOLVED, D-11**
  (never trim current payload; source-cap skill size; strong 48k / fast 16k)
- ~~**OQ-6** — journal/event-loop backpressure (synchronous SQLite, 11 bots)~~
  → **RESOLVED, D-07** (instrument-and-wait: synchronous WAL, in-memory pulses, lag monitor)
- ~~**OQ-7** — concrete cost & latency budget (calls/day, tokens/day, wall-clock per
  rollout)~~ → **RESOLVED, D-13** (throughput-limited ~3000 calls/day; caps as safety valve; tier split)
