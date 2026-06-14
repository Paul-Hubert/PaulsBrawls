# IMPLEMENTATION-PLAN — Eden, built milestone by milestone

This is the executable build plan for Eden. It does **not** re-design anything: it
fuses the frozen design (`docs/00`–`14`, the 13 owner decisions, D-01…D-13,
R1–R49, S1–S10) into one ordered, testable sequence. The normative specs win on
any conflict (S8); where this plan resolves something the prose left implicit, it
cites the doc that already answered it (almost always `08` dependency law or `11`
class model). Where the docs genuinely disagree or leave a behavioral gap, it
**stops and flags** rather than inventing — see §3.

Each task is shippable and verifiable on its own (the `01` §Build-order invariant);
the order respects the real import DAG (§1), not the milestone numbering; CI runs
on the fakes only — no Minecraft server (`09` DoD).

---

## §1 — The spine: module dependency DAG, critical path, parallel branches

### 1.1 Module dependency DAG (derived from `08` dependency law + `11` class relationships)

Imports run **strictly downward**. `dependency-cruiser` enforces this in CI from M0
(`08`, `09` Step 2); an upward import fails the build with no exception short of a
new decision record.

```
layer 0   types/                                  (interfaces + enums ONLY, zero logic, imports nothing)
            ▲ everything imports types/

layer 1   journal/kinds.ts ─► journal/journal.ts        config.ts         logger.ts
  substrate   (S1 kind registry)   (SQLite WAL, sole        (validate,        (only module
                                    journal writer S2)       warn, alias)      allowed console.*)
                                          ▲
                                    views/  (derived folds: SkillStats, Competence,
                                             Relations, TradeLedger — read journal only)
                                          ▲
                          bots/hardening.ts ─► bots/helpers.ts ─► bots/pool.ts ─► bots/anchors.ts
                            (R1–R10, abort)     (goToHops, chest)   (11 bots,        (R18 self-heal)
                                                                     R13/R27)

layer 2   ── LLM branch (needs only L0/L1) ──        ── skill-engine branch (needs L0/L1) ──
  engines   llm/client.ts  ─► llm/scheduler.ts        skills/instrument.ts  (acorn + D-08 shim)
            llm/embeddings.ts   (+ BudgetTracker)      skills/library.ts (+GrantPolicy/AllGranted)
                  ▲                                    skills/retrieve.ts ─► (embeddings)
                  └──────────────┐                     skills/describe.ts ─► (llm/client)
                                 └───────────────────► skills/engine.ts  (supervisors, StallDetector,
                                                        tier gate, SkillComposer D-12 gate)
                                                       skills/exemplars/*.js  (stock skills, R1–R10)

layer 3   god/{god,critic,curriculum,        villagers/{villager,events,subscriptions,      social/
  actors    orchestrator,body,prompts}         brain,tools,context-pack,memory}            {conversation,trade}
           ───────────────  layer-3 peers NEVER import each other (08); they meet only through  ───────────────
                            layer-1/2 objects (Inbox, library, journal, scheduler) injected by main.ts

root      main.ts            (the ONLY composition root — imports everything, wires via ctor args; no singletons)
consumer  admin/server.ts    (imports anything; NOTHING imports it; deletable — 08, 11 §8)
```

Load-bearing edges (and the rule each obeys):

- `journal/` imports nothing but `types/` (`08`). If the journal ever needs to know
  about skills, the design is wrong.
- `views/` (derived folds) sits at **layer 1**: it imports `journal/` + `types/`
  only, and is read *upward* by `skills/library` (stats in `read_skill`), `god/`
  (dossier competence), and `admin/`. Placing it lower than `skills/` is what keeps
  those reads legal.
- Layer-3 actors reach each other only via injected layer-1/2 objects. **God never
  holds a `Villager`** — it delivers through an `Inbox` whose *type* lives in
  `types/` and whose concrete instance `main.ts` wires (`11` §7 note). This is the
  one subtlety that keeps `god/` from importing `villagers/`.
- `admin/` is a pure consumer (reads journal + derived views; mutates only via the
  sanctioned POST verbs, each journaled). Deleting it must break nothing.

### 1.2 Critical path (the spine) and the M3 gate

```
M0 ──► M1 ──► M2 ──► ★M3 (GATE)★ ──► ┌─ M4  curriculum + orchestrator ─┐
spine  bodies engine  the loop        ├─ M5  events                     ├──► M7  parity+
                                       └─ M6  society                    ┘
```

- The spine is **M0 → M1 → M2 → M3**. M3 is the heart and the **do-not-parallelize-past
  gate**: nothing in M4/M5/M6/M7 is "ready" in this plan until **task `M3-GATE`
  (one villager converges on a trivial task through the full
  task→draft→run→verdict→revise→admit cycle)** is listed as its prerequisite
  (`09` Step 3, `01` Build order).
- Once M3 converges, **M4, M5, M6 are three independent branches**. They parallelize
  precisely because they are layer-3 actors + social, and the dependency law forbids
  them to import each other — they share only the M0–M3 substrate. M7 converges them.

### 1.3 Within-spine parallelism (the one branch worth running concurrently)

The **LLM branch** (`llm/client`, `llm/embeddings`, `llm/scheduler`+`BudgetTracker`)
depends only on layer 0/1, exactly like the **skill-engine branch** (`skills/*`).
Both are layer-2 and both gate M3. So during M2 they can be built **concurrently**
by two workers:

- skill-engine branch closes M2's stated DoD (library + instrumented execution +
  watchdogs + call graph + run reports; the D-08 and D-10 deliverable tests).
- LLM branch is nominally "M3 prerequisite" but has no earlier dependency — start it
  the moment M0 lands. Its `scheduler` rollout-immunity / preempt logic is first
  *exercised* in M3, so it must be done before `M3-GATE`.

Smaller intra-milestone parallelism is noted per task via `prereq` ids.

### 1.4 Cross-cutting threads (introduced once, honored by every later step)

Each is wired at its first appearance and is an invariant thereafter — not a task
that recurs:

| Thread | Introduced | Invariant honored after |
|---|---|---|
| **Journal-kind registry (S1)** | M0 (`journal/kinds.ts`) | every emitter adds a *row*, never a branch; each milestone registers only its own kinds |
| **Config keys (S7)** | M0 (`config.ts`) | every key in the `01` sketch has exactly one consumer; no orphan keys; unknown→warn, aliases adopted (R22) |
| **Derived-state discipline (P4/S2)** | M0 (append-only journal, one writer) | writers append facts; readers fold; live state never event-sourced; views rebuildable by `eden rebuild-stats` |
| **Logger / stdout purity (R23/R41)** | M0 (`logger.ts`) | `console.*` banned outside `logger.ts` (eslint rule); human log lines inherit journal `actor` |
| **Identity + port registry (R11/R12/R24)** | M0 (config validate) | no roster name == avatar; 1.21.1 pin; 8770 admin documented; never reuse 876x while v1 runs |
| **In-memory pulse rule (D-07/R44)** | M0 (journal) → M2 (sources) | no per-tick stream is ever a `JournalKind`; the stall detector reads RAM |
| **Abort protocol (R4–R5/R9)** | M1 (`bots/hardening.abortActiveTasks`) | every timeout/stall/preempt path runs the ordered sequence; `aborted:'preempted'` is benign |
| **Tier gate (R25)** | M2 (engine invariant, separate from `GrantPolicy`) | mortal never runs or calls divine; checked before any code; chat-interceptor on avatar running mortal skills |
| **Syscall shim (D-08/R45)** | M2 (`instrument.ts` provided global) | the 4 host-killers throw; the denylist is **never grown** (rebuilding the banned-scan is the anti-goal) |
| **GrantPolicy seam (owner #3)** | M2 (`AllGranted`, both call sites) | every retrieval + every `skills.run` passes through it; never bypassed |
| **Density invariant (D-11/R19/R20/R47)** | M3 (`context-pack` + `write_skill` cap) | current payload never trimmed; history trims oldest-first as whole tool-call/result pairs |
| **Critic rails (D-12/R48)** | M3 (critic + library + composer) | `check`-veto one-directional; probation gates composition not access; un-quarantine→`active-probation` |
| **Crash-only + world-stamp (D-08/D-09/R32)** | M1 (pm2, world-id stamp) → M3/M4 (rollout recovery) | `kill -9` loses only in-flight calls; mismatched world-id quarantines memories behind an admin decision |

---

## §2 — Acceptance-test inventory (every test the plan must produce)

### 2.1 The fakes (built first, M0; extended per milestone)

| Fake | Built | Must be able to drive | Cite |
|---|---|---|---|
| **In-memory journal** | M0 | append/query/subscribe without SQLite; inject a synthetic synchronous block | D-07, D-09 harness |
| **ScriptedLLM** | M0 | own port, deterministic canned tool-call sequences; scripted verdicts | R42; D-12, D-13 |
| **FakeBot** (baseline, then grown) | M0→M1→M2 | M0: position, inventory, event emit. **For D-10**: emit `path_update` on a timer with position constant; return a never-resolving `dig` promise with one start-pulse. **For R1–R3**: `currentWindow`, `clickWindow` routing, `_client` `set_slot`/`window_items` packets, auto-eat/armor-manager hooks. **For R10**: a block field with floating-leaf logs | D-10; R1–R3; R10 |

FakeBot grows, but its **seams are fixed in M0** so M2's tests can drive it without a
rewrite. The seam list above is the M0 acceptance criterion for FakeBot.

### 2.2 D-record deliverable tests → owning task

| D | Test (verbatim from the record) | Milestone · task | Fake |
|---|---|---|---|
| **D-07** | inject 1.2 s sync block → exactly one `system.loop-lag` (`max≥1000`); driving the pulse path emits **zero** journal events | M0 · `M0-4` | in-mem journal |
| **D-08** | a skill whose body calls `process.exit(0)` → `outcome.ok=false` with a `SkillForbiddenError` report; host process stays alive | M2 · `M2-1` | FakeBot |
| **D-10** | (i) `while(true)` → loop budget, **not** the stall detector; (ii) `path_update` every ~1 s for 45 s, position constant → **not** aborted; (iii) `bot.dig` never-resolving with one start-pulse → `SkillStalledError('no progress')` at ~`stallSeconds` | M2 · `M2-3` | FakeBot |
| **D-12** | (i) critic wrongly admits a no-op on a `check`-carrying task → vetoed to `success:false`, stays `draft`; (ii) wrongly-quarantined skill succeeds on re-trial → `active-probation` (not `active`); (iii) probationary skill refused as composition callee but runnable directly, graduates after 3 clean runs | M2 (iii: composer gate) + M3 (i,ii: critic) · `M2-3`,`M3-4` | ScriptedLLM |
| **D-11** | exemplars + a `maxSkillLines`-sized skill + a rendered snapshot + a critique fit `strong.inputTokenBudget` with headroom for ≥1 prior revision; trimming drops whole oldest tool-call/result pairs, never the current payload, never mid-pair | M3 · `M3-1` | token estimator |
| **D-09** | seed an open task with `currentRolloutId` set + a `draft` version + rollout journal events; run boot recovery → assert `god.rollout-abandoned`, cleared pointer + task re-enqueued, orphan draft still `draft` (not `active`, not retrievable) | M3 (fields/abandon) · `M3-6`; re-enqueue via real assignment retested M4 · `M4-3` | in-mem journal + FakeBot |
| **D-13** | budget breach → graceful degradation (critic→`check`+template, curriculum→repeat, orchestrator→urgent-only); `dailyTokens:null` = uncapped; verdict batching ≤3 tickets/call | M4 · `M4-4` | ScriptedLLM |

### 2.3 R-rule assertions → owning task (hardening corpus + exemplars)

| R | Asserted in | R | Asserted in |
|---|---|---|---|
| R1–R3 craft window/quiescence | M2 `M2-6` (craft-item exemplar) + M1 `M1-1` craftQuiescence | R23 one stdout | M0 `M0-1` eslint rule |
| R4–R5 abort sequence order | M1 `M1-1` (asserted order) | R24 port registry | M0 `M0-1`/`M0-3` (`eden.example.json`) |
| R6 bound pathfinder | M1 `M1-1` (2 s/10 ms/64) | R25 no `/` on op'd mortal run | M2 `M2-3` chat interceptor |
| R7 hop navigation ≤40 | M1 `M1-2` goToHops | R26 long-`goTo` legit | folded into D-10 (ii) `M2-3` |
| R8 viewDistance short | M1 `M1-3` | R27 death_combat_event | M1 `M1-3` (needs kind — **gap G2**) |
| R9 benign preemption | M2 `M2-3` + M3 `M3-4` critic no-fault | R28–R31 env/ops | smoke discipline; `eden/CLAUDE.md` |
| R10 collect trunk-only | M1 `M1-2` + M2 `M2-6` collect-blocks | R32 world-stamp beliefs | M1 `M1-3` stamp + M6 `M6-1` quarantine |
| R11 protocol pin | M0 `M0-3` | R33 recover-in-tool | M6 `M6-3` (walk-then-talk) |
| R12 username uniqueness | M0 `M0-3` (assert) | R34/R35 completion≠progress | M3 `M3-4` (critic world-delta) |
| R13 stagger/keepalive | M1 `M1-3` (smoke) | R36 one wake-up + release valve | M5 `M5-3` + scheduler rate-cap `M2-L3` |
| R14 op only avatar | M1 `M1-3` (read-contract) | R37 contradiction retires belief | M3 `M3-4` (un-quarantine) + M6 `M6-1` |
| R15 named plugin imports | M1 `M1-1` | R38 multilingual embeddings | M2 `M2-L2` |
| R16 plugin load fallible | M1 `M1-1` | R39 timeouts are valves | layering asserted in D-10 `M2-3` |
| R17 auto-eat config | M1 `M1-1` | R40 loop-lag monitor | M0 `M0-4` (D-07) |
| R18 anchors as hints | M1 `M1-4` | R41 log tags = true actor | M0 `M0-4` (actor on event) |
| R19 token-budget memory | M3 `M3-1` (D-11) | R42 eval harness patterns | M7 `M7-2` |
| R20 tool-call/result adjacency | M3 `M3-1` (trim) + `M3-3` (dangling guard) | R43 no nested git | M0 `M0-1` (plain dir) |
| R21 timeouts≠retries | M2 `M2-L1` | R44 never journal per-tick | M0 `M0-4` (D-07) |
| R22 config warn/alias | M0 `M0-3` | R45 shim not a sandbox | M2 `M2-1` (denylist frozen) |
| | | R46 pulse is discrete | M2 `M2-3` (D-10) |
| | | R47 never trim payload | M3 `M3-1` (D-11) |
| | | R48 rails not silos | M3 `M3-4` (D-12) |
| | | R49 throughput not wallet | M4 `M4-4` (caps null) |

---

## §3 — Design-readiness check (fail loudly; do not paper over)

Ran the four `09` Step-3 consistency checks. Result: the design is **plan-ready**.
Two genuine behavioral gaps and one trivial numeric conflict are surfaced below for
the owner (they touch a config key, a journal kind, and a constant — S8 doc-drift
territory, an owner/agent call, **not** mine to invent). A handful of structural
seams the `01` layout left implicit are **answered by `08`/`11`** — the plan adopts
those answers and lists the files the `01` layout should gain (also S8).

### 3.1 Genuine gaps — STOP, owner decides (also in the risk register §5)

- **G1 — retention window has no config key.** `05` §Retention says the `vitals` /
  `subscription.fired` rolling window is "configurable (default 7 days)", but the
  `01` `eden.json` sketch has **no** such key. Either add `journal.retentionDays`
  (add-a-config-key recipe, `08`) or downgrade "configurable" to a hardcoded default
  like the lag threshold. Until decided, the plan treats 7 days as a **hardcoded
  default** (the conservative reading) and flags the key as TODO in `M0-3`. *Owner call.*
- **G2 — R27 death journaling has no registry kind.** R27 requires the bot pool to
  journal the authoritative `death_combat_event` on every death, but `05`'s kind
  registry has no `world.death` (its World domain holds only `vitals`). The
  add-a-journal-kind recipe (`08`) needs a registry row. The plan provisionally adds
  `world.death` in `M1-3` under S8 (new behavior + docs same commit) — but flags it
  because a *new kind* is a registry decision the owner may want to name/shape
  (e.g. fold into `system.bot-disconnected{cause}` instead). *Owner call on the name/shape.*

### 3.2 Trivial conflict — resolve to the normative doc

- **I1 — login stagger 4 s vs 2 s.** `01` §Startup says "~4 s apart (v1's
  `LOGIN_STAGGER_MS`)"; `11` §3 BotPool says "~2 s". `01` is normative and matches the
  v1 constant → **use ~4 s** (`M1-3`). Not a config key (hardcoded constant).

### 3.3 Implicit seams the plan makes explicit (answered by `08`/`11`; not contradictions)

These are exactly the "seams left implicit across the prose" the plan is meant to
surface. Each is resolved by a companion doc; the implementing agent should add the
file to the `01` layout under S8:

- **`types/` is layer 0.** `08`/`11` §2 require a top-level `types/` holding all
  shared domain interfaces+enums; the `01` layout only shows `skills/types.ts`. Resolution:
  create `eden/src/types/` (the dependency law is normative); `skills/types.ts` keeps
  only skill-engine-internal schema helpers, or folds in.
- **`llm/embeddings.ts`** is in `11` §5 but absent from the `01` `llm/` file list →
  create it (`M2-L2`).
- **`views/` + `eden rebuild-stats`** are in `11` §8 / `05` §Derived-state but absent
  from the `01` layout → create a layer-1 `views/` module + the CLI (`M7-1`, folds
  consumed earlier).
- **`roles.json`** (role-default subscriptions, `04`) is not in the `01` layout/sketch
  → a separate config file created in `M5-3`.
- **`Inbox` type in `types/`, concrete instance wired in `main.ts`** (`11` §7 note) →
  the mechanism that keeps `god/` from importing `villagers/`.

### 3.4 The three positive checks (passed)

- **Config keys → home in the sketch:** every key referenced in prose maps to the
  `01` sketch (god/llm/skills/journal/admin/settlement/behavior/minecraft/villagers),
  with the lone exception G1.
- **Constants a D-record fixed → wired:** `stallSeconds=20`, `maxSkillLines=400`,
  `inputTokenBudget 48k/16k`, `probationRuns=3`, `autoQuarantineAfter=5`,
  `vitalsIntervalSeconds=10`, `dailyTokens:null`+`degradeOnBreach`, `maxCallDepth=8`,
  `runDefaultTimeoutMs=120000` — all present. The 1e6 loop budget, the 2 h ceiling,
  the 1000 ms lag threshold, and `maxRetries=4` are deliberately **hardcoded** (S7 —
  nothing else reads them).
- **Every deliverable test has a no-server fake:** confirmed in §2.1–§2.2; the only
  non-trivial demand is FakeBot's seams (D-10, R1–R3), fixed in M0.

---

## §4 — Per-milestone breakdown (M0 → M7)

**Global Definition of Done (`09` Step 3), applies to every task unless noted:**
`npm run lint && npx tsc --noEmit && npm test` green on the fakes (no Minecraft in
CI); every new behavior visible via `GET /journal` (P4); the dependency-cruiser
check green (no upward imports, `08`); docs touched in the same commit (S8) and a
`docs/PROGRESS.md` section written. Tasks that involve bots/skills add a **smoke**
on the dev server (port **25599**, read `run/server.properties`, never assume — R28);
anything needing settlement stops `./gradlew runServer` first (it steals 8767 — R29).

Task fields: **id · goal · files · prereq · proof (test + D/R cite) · DoD-extra**.

### M0 — spine (CI: lint + tsc + dependency-cruiser + unit; no Minecraft)

> Creates the substrate every later milestone imports. Clean cut: needs nothing later.

- **M0-1 · scaffold + dependency law + bootstrap.**
  Files: `eden/package.json` (type:module, Node 22, tsx), `eden/tsconfig.json`
  (strict), `eden/.dependency-cruiser.cjs`, eslint config (ban `console.*` outside
  `logger.ts`, R23), `eden/eden.example.json` (skeleton listing **all** `01` keys +
  comments + the port registry R24), `eden/CLAUDE.md`, `docs/PROGRESS.md` (see §6).
  `eden/` is a **plain dir** in the parent repo — no inner `.git` (R43).
  Prereq: —. Proof: `npm run lint && npx tsc --noEmit` green on the empty scaffold; a
  deliberately-planted upward import **fails** the dependency-cruiser CI step.
  DoD-extra: CI workflow added.
- **M0-2 · `types/` layer 0.** Files: `eden/src/types/*.ts` — every domain interface +
  enum from `11` §2 (`SkillManifest`, `SkillVersion`, `RunReport`, `Snapshot`, `Task`,
  `TaskLedger`, `Directive`, `CriticTicket`, `Verdict`, `Rollout`, `Dossier`,
  `EdenEvent`+`Envelope`, `Subscription`+`Filter`+handlers, `JournalEvent`+`Refs`,
  `InboxMessage`, `MemoryEntry`, `RunnerRef`, enums `Tier`/`SkillStatus`/`AbortCause`/
  `Priority`, the `Inbox` type per §3.3). Prereq: M0-1. Proof: tsc compiles; dep-cruiser
  asserts `types/` imports nothing.
- **M0-3 · `config.ts` + `logger.ts`.** Files: `eden/src/config.ts`, `eden/src/logger.ts`,
  finalize `eden.example.json`. Load/validate; warn on unknown keys + adopt aliases
  (R22); assert no roster name == `god.name` (R12) and version pin 1.21.1 (R11);
  document 8770 (R24). The D-11 **reserve-invariant** validator is declared here but
  activates when `inputTokenBudget` gets its consumer (M3). G1 retention left as a
  TODO comment. Prereq: M0-2. Proof: config test — unknown key warns, alias adopted,
  `name==avatar` rejected; golden of a validated config object.
- **M0-4 · journal (kinds + writer + lag monitor).** Files: `eden/src/journal/kinds.ts`
  (S1 registry — M0 kinds: `system.boot`, `system.config-warning`,
  `system.bot-connected/-disconnected`, `system.error`, `system.loop-lag`), 
  `eden/src/journal/journal.ts` (SQLite WAL, `synchronous=NORMAL`, append/query/
  subscribe, **sole writer** S2), lag monitor in `main.ts` skeleton
  (`monitorEventLoopDelay({resolution:20})`, warn `max≥1000`, hardcoded threshold).
  Prereq: M0-2. Proof: **D-07** — inject a 1.2 s sync block → exactly one
  `system.loop-lag` (`max≥1000`); a driven pulse path emits **zero** journal events
  (R44); per-kind payload schema round-trip. DoD-extra: `actor` on every event (R41).
- **M0-5 · the fakes.** Files: `eden/tests/fakes/{fake-bot,scripted-llm,memory-journal}.ts`.
  FakeBot ships the M0 seams **plus** the D-10 seams (timer-driven `path_update`,
  controllable `dig` promise, position control) and the R1–R3 seams (`currentWindow`,
  `clickWindow` routing, `_client` packet emit). ScriptedLLM: own port, deterministic
  (R42). Prereq: M0-2 (types), M0-4 (journal iface). Proof: fakes self-test — FakeBot
  emits `path_update` and returns a controllable never-resolving `dig` promise.
- **M0-6 · admin skeleton.** Files: `eden/src/admin/server.ts` — `GET /status`,
  `GET /journal?...`, `WS /journal/stream` (pub/sub fan-out). Port 8770. Prereq: M0-4.
  Proof: `/status` returns uptime+bots(0)+queue depths; `/journal` filters by
  `kinds/actor/ref/since/limit`; WS receives appended events live.

### M1 — bodies (smoke vs dev server 25599)

> Bot pool + the v1 hardening corpus (R1–R10). Clean cut: needs journal/config/types only.

- **M1-1 · `bots/hardening.ts` (R1–R10 corpus).** `boundPathfinder` (R6: 2 s/10 ms/64),
  `abortActiveTasks` (R4–R5 ordered: collect targets → pvp stop → pathfinder stop
  **then** setGoal(null) → close window → settle macrotask), `craftQuiescence`
  (R1–R3: close stray window, pause auto-eat + armor-manager, packet quiescence),
  `installChatInterceptor` (R25), plugin loads (named imports R15, individually
  fallible R16, auto-eat config verbatim R17). Files: `eden/src/bots/hardening.ts`.
  Prereq: M0-5 (FakeBot). Proof: hardening unit tests — abort **sequence order**
  asserted; pathfinder bounds asserted; interceptor drops `/`-chat (R25).
- **M1-2 · `bots/helpers.ts`.** `goToHops` (≤40-block legs R7), `useChest`/`deposit`/
  `withdraw`, `collectTrunk` (column-to-ground, one block/call, skip-on-failure,
  re-assert Movements after R10). Files: `eden/src/bots/helpers.ts`. Prereq: M1-1.
  Proof: hop legs ≤40; collect skips floating-leaf logs (R10).
- **M1-3 · `bots/pool.ts`.** Spawn 11 staggered (~4 s, avatar last — R13/I1),
  `viewDistance:'short'` (R8), reconnect backoff, journal `system.bot-connected/
  -disconnected` + **`world.death`** from `death_combat_event` (R27 — see G2), op only
  the avatar (read-contract, R14), stamp `.eden-data/` with a world id (R32). Files:
  `eden/src/bots/pool.ts`, kind row in `journal/kinds.ts`. Prereq: M1-1, M0-4. Proof:
  unit (staggered timing, avatar last); **smoke 25599** — 10 villagers + avatar stand
  with no disconnect storm (R13); death journaled with packet cause.
- **M1-4 · `bots/anchors.ts` (AnchorService, R18).** Boot heal: home snaps to standable
  ground, missing chest re-discovered (nearest chest/trapped_chest/barrel), overrides
  persist + win over config, one loud warn on unrecoverable. Files: `eden/src/bots/anchors.ts`.
  Prereq: M1-3. Proof: anchor-heal test on a FakeBot world fixture (snap + re-discover +
  single warn).
- **M1-5 · vitals journaling.** Per-bot snapshot every `vitalsIntervalSeconds` (D-07).
  Files: `eden/src/bots/pool.ts` (+ `vitals` kind). Prereq: M1-3, M0-4. Proof: cadence
  ~1.1 ev/s @11 bots; payload schema; **zero** pulse events (R44 still holds).

### M2 — skill engine (FakeBot; the LLM branch runs concurrently)

> The core asset. Clean cut: needs bots(M1)+journal(M0); LLM plumbing is a peer branch.

**LLM branch (start at M0 completion; must finish before `M3-GATE`):**

- **M2-L1 · `llm/client.ts` + ProviderRegistry.** Provider-agnostic
  `/v1/chat/completions`, tool calling, timeout 180 s (R21), auto-retry on
  connection-reset only (R21), journal `llm.call` (latency+tokens, **never** prompt
  bodies; `debugPrompts`→`.eden-data/llm/<id>.json`). Files: `eden/src/llm/client.ts`.
  Prereq: M0-4. Proof: ScriptedLLM round-trip; timeout vs retriable-reset distinguished
  (R21); `llm.call` carries no body.
- **M2-L2 · `llm/embeddings.ts`.** Multilingual MiniLM in-process, lazy batched off the
  hot path, 3 failures → keyword-only for the run (R38). Files: `eden/src/llm/embeddings.ts`
  (new per §3.3). Prereq: M0-2. Proof: embed+cosine; 3-failure degrade.
- **M2-L3 · `llm/scheduler.ts` + `BudgetTracker`.** Global concurrency cap
  (`maxConcurrent`), priority lanes, same-kind coalescing, per-villager cooldown, **God
  preempt**, **rollout immunity** (bypass coalescing/cooldown/suppression), dumb
  per-minute rate cap (R36 release valve). `BudgetTracker` skeleton (caps consumed in
  M4). Files: `eden/src/llm/scheduler.ts`. Prereq: M2-L1. Proof: lane ordering; God
  preempts villager lanes; **rollout immunity bypasses coalescing**; rate cap resets
  each minute.

**Skill-engine branch:**

- **M2-1 · `skills/instrument.ts` (acorn + D-08 shim).** Parse (ecmaVersion 2022,
  syntax errors returned inline), loop-budget injection (1e6, reset on real `await`),
  **syscall shim** (provided scope global; safe allowlist; `exit`/`reallyExit`/`abort`/
  `kill` throw `SkillForbiddenError`; plain object, no Proxy S5; denylist **frozen** at
  4 — R45). Files: `eden/src/skills/instrument.ts`. Prereq: M0-5. Proof: **D-08**
  (`process.exit(0)` → `ok:false`+`SkillForbiddenError`, host alive); `while(true)` →
  `SkillStalledError('loop budget')`; parse error returned to author inline.
- **M2-2 · `skills/library.ts` (+ `GrantPolicy`/`AllGranted`).** Append-only versioning;
  status machine incl. `active-probation` (D-12: `upsertDraft`, `admit`→active-probation,
  `recordProbationRun`, `quarantine`, `unquarantine`→active-probation, `archive`);
  codePath+hash, `verifyHashes` at boot (quarantine mismatches); journal `skill.draft/
  admit/quarantine/archive`. `GrantPolicy` interface + `AllGranted` (constant true, both
  call sites stubbed). Files: `eden/src/skills/library.ts`, kinds rows. Prereq: M0-4.
  Proof: CRUD + version-monotonic; boot hash-mismatch → quarantine; full status-transition
  table (incl. self-healing un-quarantine → active-probation).
- **M2-3 · `skills/engine.ts` (executor + supervision).** `run()` with **tier gate**
  (mortal never runs/calls divine; engine invariant, separate from `GrantPolicy` — R25),
  `validateArgs`/`validateReturn` (draft trials), `BotRunQueue` (D-05 one tree/bot,
  `preempt`), `RunSupervisor` (wall-clock 120 s/2 h), **`StallDetector`** (D-10: discrete
  pulses; built-in sources incl. pathfinder `path_update/path_reset/goal_*/path_stop`;
  uniform `stallSeconds=20`; in-memory R44), abort protocol on every exit path
  (R4–R5; `aborted:'preempted'` R9), `SkillContext`+`SkillComposer` (depth 8, cycle
  detect, **probation gate D-12**, grant gate, tier gate), `FailureTripwire`
  (`autoQuarantineAfter:5` → critic ticket), `RunReport` → journal `skill.run` + critic
  queue. Files: `eden/src/skills/engine.ts`. Prereq: M2-1, M2-2, M1-1 (abort). Proof:
  **D-10 (i/ii/iii)**; composition depth-cap + cycle-throw; tier-gate throws before
  any code; preempt → `aborted:'preempted'`; **D-12(iii)** probationary skill refused
  as composition callee but runnable directly + graduates after 3 clean runs.
- **M2-4 · `skills/retrieve.ts` (SkillRetriever).** Embedding cosine + keyword fallback,
  **tier-filtered**, top-k 8, surfaces only `active` + `active-probation` (P2). Files:
  `eden/src/skills/retrieve.ts`. Prereq: M2-2, M2-L2. Proof: ranking; divine hidden from
  mortal view; draft never surfaced for normal work.
- **M2-5 · `skills/describe.ts` (DescriptionPass).** Fast-tier LLM derives
  `description`+proposes `summary`/`tags` from final code at admission. Files:
  `eden/src/skills/describe.ts`. Prereq: M2-2, M2-L1. Proof: ScriptedLLM derive; admission
  triggers it.
- **M2-6 · `skills/exemplars/*.js` (+ manifests).** Mortal stock primitives (`go-to`,
  `mine-block`, `craft-item` [R1–R3], `smelt-item`, `place-item`, `kill-mob`,
  `explore-until`, `use-chest`, `deposit`, `withdraw`, `collect-blocks` [R10]); ~6 flagged
  `exemplar:true`; divine stock (`appear-near`, `vanish`, `gesture`, `fly-to`,
  `summon-creature`, `smite`, `teleport-entity`, `give-items`, `set-weather`). All enter
  `active` directly (curated review = their probation). Files: `eden/src/skills/exemplars/`.
  Prereq: M2-3, M1-2. Proof: each exemplar runs on FakeBot; **craft-item asserts R1–R3**;
  collect-blocks asserts R10; exemplars ≤~60 lines (S4).

### ★ M3 — the loop (THE GATE) ★ (FakeBot+ScriptedLLM; smoke 25599)

> The heart. Clean cut: needs skills(M2)+llm(M2-L*); task seeding by **injection**, not
> curriculum/orchestrator (those are M4). Critic desk IS required here.

- **M3-1 · `villagers/context-pack.ts`.** Deterministic 8-section assembly; the **one**
  Voyager `Snapshot→string` renderer (shared with God); per-section token ceilings;
  **D-11 `fitBudget`** (never trim current density payload; history oldest-first as whole
  R20 pairs; per-tier `inputTokenBudget`); `brain.wakeup` reports section sizes. Memory §6
  uses a minimal window stub (full port M6). Files: `eden/src/villagers/context-pack.ts`,
  a token estimator util. Prereq: M2-4, M2-L1. Proof: **D-11** (fit + whole-pair trim +
  current-payload never trimmed); golden snapshot (S6).
- **M3-2 · `villagers/tools.ts` (ToolRegistry, S1).** `search_skills`/`read_skill`/
  `write_skill` (caps `maxSkillLines` D-11)/`run_skill`; `report_to_god`; `done`;
  `remember`/`recall` (stub→M6); `subscribe`/`list_subscriptions` (stub→M5); **tier-filtered
  villager view** (no divine field exposed). Social tools stubbed. Files:
  `eden/src/villagers/tools.ts`. Prereq: M2-3, M2-2. Proof: dispatcher test (ScriptedLLM
  calls each); `write_skill` rejects oversize (R47); golden tool schemas.
- **M3-3 · `villagers/brain.ts`.** One deliberation = context-pack → tool turns → `done`;
  `activeRollout` revision context persists (density invariant); **R20 adjacency** on
  every error/abort path (complete the pair or wipe). Files: `eden/src/villagers/brain.ts`.
  Prereq: M3-1, M3-2, M2-L3. Proof: brain drives scripted author→run→done; dangling
  tool-call/result guard (R20).
- **M3-4 · `god/god.ts` (GodState minimal) + `god/critic.ts` (CriticDesk).** `judge(ticket)`
  sees full code + RunReport + before/after snapshots + dossier + last critique in chain;
  **`check`-veto (D-12, one-directional)**; `routeVerdict` (libraryAction→library,
  critique→inbox high-priority, ledger/dossier update); `voidDivineOverreach`; judges
  **world delta** not clean exit (R34/R35); un-quarantine → `active-probation` (R37); 
  `god/prompts/critic.md` (S6, golden). Files: `eden/src/god/{god,critic}.ts`,
  `eden/src/god/prompts/critic.md`. Prereq: M2-2, M2-3, M3-3. Proof: **D-12(i)** check-veto
  to `success:false`/stays draft; **D-12(ii)** wrongly-quarantined → active-probation;
  R34/R35 critic scenario; verdict routing; golden prompt.
- **M3-5 · `god/body.ts` + divine body wiring.** `appear-near`/`vanish`/`gesture` run via
  the avatar; `deliverVerdict` when `embodiedVerdicts`; journaled `god.appearance` like any
  skill run (P4). **Gated so the loop converges without it** (theatrics-never-a-dependency):
  avatar-down → divine run fails, loop still closes. Files: `eden/src/god/body.ts`. Prereq:
  M3-4, M2-6 (divine exemplars). Proof: `deliverVerdict` runs a divine skill journaled
  `god.appearance`; with avatar disconnected the loop still closes.
- **M3-6 · D-09 rollout fields + boot-abandon.** `Task.currentRolloutId` set at assignment
  (enforces one-live-rollout), the `Rollout` object, boot-abandon path (journal
  `god.rollout-abandoned`, clear pointer, re-enqueue). **Tasks seeded by admin inject /
  test harness**, not curriculum. Files: `eden/src/god/god.ts`, kinds row, startup step 7
  hook in `main.ts`. Prereq: M3-4. Proof: **D-09** (seed open task+draft+journal → boot →
  abandoned + cleared + re-enqueued + orphan draft still `draft`).
- **★ M3-GATE · convergence (the milestone's reason to exist).** End-to-end on **one**
  villager + trivial task ("collect 3 oak logs", "craft 4 planks"):
  task → draft → run → verdict → revise → admit. Prereq: M3-1…M3-6, **all M2 + M2-L***.
  Proof: integration test — ScriptedLLM scripted to fail-once-then-fix → converges to
  `active-probation`; **smoke 25599** with a real provider converges; the
  `refs.rolloutId` journal view shows the complete cycle. **This task id is a
  prerequisite of every task in M4, M5, M6, M7.**

### M4 — curriculum + orchestrator (branch off M3-GATE; ∥ M5, M6)

- **M4-1 · `god/curriculum.ts`.** `TaskLedger` (**sole writer** S2); `proposeTask`
  (one task at the edge of ability); `QaCache` (`howTo`, fast tier, embedding-deduped,
  persisted as `Task.context`); `decompose`; warmup gate (config table); `clean_up_tasks`
  (failed→retired on later completion). Triggers: idle, verdict-close, dawn, critic
  `followUp.task`, admin. `god/prompts/curriculum.md`. Files: `eden/src/god/curriculum.ts`,
  prompt. Prereq: **M3-GATE**. Proof: `propose_task` routing; QA-cache dedup+persist;
  ledger transitions; golden prompt.
- **M4-2 · `god/orchestrator.ts`.** `dispatch`→`Directive` (**sole writer**); anti-thrash
  (max 1 open non-standing/villager; no repeat `interrupt` within 5 min; conflict
  supersede oldest-first, journaled); `intervene` (divine stage-setting — never does the
  task; critic voids overreach); `report_to_god` objections journaled+dossier-noted.
  `god/prompts/orchestrator.md`. Files: `eden/src/god/orchestrator.ts`, prompt. Prereq:
  **M3-GATE**. Proof: directive routing; anti-thrash assertions; intervention journaled;
  golden prompt.
- **M4-3 · full loop via curriculum→orchestrator→inbox + multi-villager.** Replace M3's
  injection with the real assignment path; D-09 re-enqueue now flows through it. Files:
  `eden/src/god/god.ts`, `main.ts` wiring. Prereq: M4-1, M4-2, M3-6. Proof: 3+ villagers
  run unattended; **D-09 re-enqueue lands in real assignment** (extends the M3-6 test).
- **M4-4 · D-13 budget + tier split.** `BudgetTracker` per-desk daily caps (default
  **null**), `degradeOnBreach` (critic→`check`+template / curriculum→repeat /
  orchestrator→urgent-only); strong/fast tier split wired (strong=novelty, fast=dispatch/
  reactive/QA); verdict batching ≤3 tickets/call. Files: `eden/src/llm/scheduler.ts`
  (BudgetTracker), `eden/src/god/*`. Prereq: M4-1, M4-2, M2-L3. Proof: **D-13** —
  breach→degraded path; `null`=uncapped; batching; throughput-accounting sanity (R49).

### M5 — events (branch off M3-GATE; ∥ M4, M6)

- **M5-1 · `villagers/events.ts` (EventRouter).** Normalize raw mineflayer/world signals →
  `EdenEvent` envelopes; **emitter registry** (S1); hysteresis **in the emitter**
  (`health-low`, `night-falls`); `tick-30s` clock. Files: `eden/src/villagers/events.ts`.
  Prereq: **M3-GATE**. Proof: emitter unit tests per event (FakeBot); hysteresis edge test.
- **M5-2 · `villagers/subscriptions.ts` (SubscriptionStore + FilterEvaluator).** **Sole
  writer**; declarative filters AND-composed (within/entityKind/nameMatches/timeOfDay/
  health/food/notWhileRunning — **clause registry**, no predicate code, P5); `ArgTemplate`
  `$event.*` substitution; `cooldownMs`; persistence; `subscribe`/`unsubscribe`/
  `list_subscriptions` tools. Files: `eden/src/villagers/subscriptions.ts`. Prereq:
  **M3-GATE**. Proof: filter matching matrix; ArgTemplate substitution; persistence
  round-trip.
- **M5-3 · routing outcomes + role defaults.** `kind:'skill'` (zero-token engine run;
  failing handler → normal tripwire, never silent) + `kind:'deliberate'` (wake-up →
  context-pack → brain); priority lanes; **one-incident-one-wake-up** (the owner of the
  failure escalates; everyone else only journals — R36). `roles.json` default
  subscriptions seeded at first boot. Files: `eden/src/villagers/events.ts`,
  `eden/roles.json`. Prereq: M5-1, M5-2. Proof: skill handler fires zero-token + journaled;
  deliberate escalates; role defaults seeded; **R36** single escalation.

### M6 — society (branch off M3-GATE; ∥ M4, M5)

- **M6-1 · `villagers/memory.ts` (full port).** Window ~200 → archive 2000 + rolling life
  summary (fast LLM: keywords + importance bumps + ≤2 lessons); `MemoryEntry` kinds;
  `MemoryRetriever` (0.5·rel + 0.25·rec + 0.25·imp; rel=max(embedding cosine, keyword
  overlap)); lazy embeddings; **drop** `refuteBlockedBeliefs` (critic owns R37);
  **world-mismatch memory quarantine** behind an admin decision (R32). Files:
  `eden/src/villagers/memory.ts`. Prereq: **M3-GATE**, M2-L2. Proof: eviction → archive +
  summary; retrieval ranking; R32 quarantine-behind-admin.
- **M6-2 · `social/conversation.ts`.** In-process inboxes; turn caps + per-turn deadlines;
  mirror to game chat **only with a player in earshot**, rate-limited; `leave_conversation
  {opinion,note,headline}` → relations + memory; eavesdroppers get free memory entries.
  Files: `eden/src/social/conversation.ts`. Prereq: **M3-GATE**. Proof: turn cap/deadline;
  mirror gate; `leave` feeds relations.
- **M6-3 · `social/trade.ts` + `SettlementClient`.** Typed offers; settle via
  `POST 127.0.0.1:8767/trade/execute`; `coin`→`paulsbrawls:coin`; `trade.proposed/settled/
  failed`. **R33 walk-then-talk recovery** inside `start_conversation`/trade tools. Files:
  `eden/src/social/trade.ts`. Prereq: **M3-GATE**. Proof: trade settle **integration**
  (8767 against PaulsBrawlsVanilla; stop dev server first — R29); R33 tool-level recovery.
- **M6-4 · drives (optional, `behavior.drives`).** Rest/social decay → `tired`/`lonely`
  wake-ups (hysteresis), mood string side-output of `done`. Files:
  `eden/src/villagers/memory.ts` (+ event rows in M5's emitter registry). Prereq: M6-1,
  M5-1. Proof: with `drives:true` decay → wake-up; `false` → no effect (architecture
  unchanged).

### M7 — parity+ (converges all branches)

- **M7-1 · admin API complete + derived views.** All `05` routes (`/villagers[/:name]`,
  `/skills[/:name]?version=&code=`, `/tasks`, `/verdicts`, `/directives`, `/journal`,
  `/journal/stream` WS, `POST /pause`,`/resume`,`/skills/:name/quarantine`,
  `/villagers/:name/prompt`→`inbox` tell); `views/` derived folds (SkillStats, Competence,
  Relations, TradeLedger) + `eden rebuild-stats` (§3.3). Files: `eden/src/admin/server.ts`,
  `eden/src/views/*.ts`, `eden/src/cli/rebuild-stats.ts`. Prereq: M4, M5, M6. Proof: each
  route returns derived/journal data; `prompt`→`inbox` event journaled **before** delivery;
  `pause` gates LLM but skills/subscriptions keep running; **rebuild-by-replay == live**
  view (replay test).
- **M7-2 · eval harness port (R42).** Scripted mock LLM (own port), RCON-idempotent world
  fixtures, ambient-suppression eval roster (big heartbeats, embeddings off), wiped data
  dir at run start, reserved username prefix (no collision with production — R12),
  **per-bot exclusive** scenario seeds. Files: `eden/eval/*`. Prereq: M4, M5, M6. Proof:
  eval scenarios green vs PaulsBrawlsVanilla (ports per R28/R29); roster-collision guard
  rejects a duplicate seed.
- **M7-3 · v1 decommission checklist + parity sign-off.** Identity coexistence (R12), port
  map (R24), world-stamp (R32), final `docs/PROGRESS.md`. Files: `docs/` + checklist.
  Prereq: M7-1, M7-2. Proof: v1 (`npm run village`) and Eden run side-by-side with no
  username/port collision; the parity criteria are met and recorded.

---

## §5 — Risk register

The honest limits the D-records already name, each with the **trigger** that fires the
**pre-decided escape hatch** (`08` §Scaling). Plus the genuine doc gaps from §3.

| # | Risk / limit | Source | Trigger to watch | Pre-decided escape |
|---|---|---|---|---|
| RK-1 | **Non-idempotent task wastes resources on re-attempt** (half-built structure, burned fuel re-done after a crash) | D-09 | re-proposal churn measures costly | promote abandon→**resume** (the hybrid); mitigated meanwhile by `check`-gate + generic-by-doctrine skills (R34/R35) |
| RK-2 | **Determined sandbox escape stays reachable** (`globalThis.process`, `Function` ctor, `worker_threads`) | D-08/R45 | an *accident* escapes the 4-killer shim | `worker_threads` per bot (`08` #1/#5) contains a stray `exit` to one bot. **Do NOT grow the denylist** (R45) — that rebuilds the banned-scan the rewrite dropped |
| RK-3 | **Convergence is throughput-bound** (~10–15 min/novel skill; ~3000 calls/day ceiling at `maxConcurrent:3`) | D-13/R49 | liveliness/throughput insufficient | raise `maxConcurrent` / cheaper tiers (`08` #4) — re-derive the throughput math; **do not** cap-throttle the loop |
| RK-4 | **Synchronous journal on the shared loop** could stall on a WAL checkpoint or a big row | D-07 | sustained `system.loop-lag` spikes traceable to journal writes | async write queue, then writer isolation (`08` #3) — built on the lag monitor's evidence, not anticipation |
| RK-5 | **Single-process blast radius** — a skill tree melts the event loop | D-01/D-08 | one bot's run starves the others | `worker_threads` per bot (`08` #1); bounded change to `bots/pool` + `skills/engine` |
| RK-6 | **Hallucinated critique** admits a wrong draft / files a wrong quarantine | D-12 | false admissions measure frequent | two-vote admission for high-blast-radius (divine/widely-composed) skills (D-12 rejected-but-deferred). Bounded meanwhile by `check`-veto + probation + `maxRetries:4` |
| RK-7 | **Serialized per-bot execution** (D-05) caps a single bot's concurrency | D-05 | a bot genuinely needs two trees | none planned — accepted; mineflayer can't multiplex a body |
| **G1** | **Retention window has no config key** (`05` says configurable, sketch omits it) | §3.1 | — | **owner decision**: add `journal.retentionDays` or hardcode 7 d. Plan ships hardcoded-7 d + TODO until decided |
| **G2** | **R27 death journaling has no registry kind** | §3.1 | — | **owner decision** on name/shape: plan provisionally adds `world.death` (S8); owner may prefer `system.bot-disconnected{cause}` |
| I1 | login stagger 4 s vs 2 s | §3.2 | — | resolved to 4 s (`01` normative); not a config key |

Process risks worth stating once: **M3 must converge before any parallel work
starts** — if it doesn't, nothing after it matters (`09` Step 3); and **doc-drift
(S8)** is a standing risk the PR checklist (two boxes: next R-number, next D-number)
must enforce on every commit.

---

## §6 — The M0 bootstrap (first-commit content, per `09` Step 2)

The first M0 commit creates these two files. Drafts below (the implementing agent
commits them; this plan does not create `eden/` source).

### `eden/CLAUDE.md` (≤40 lines)

```markdown
# Eden — agent orientation

Eden is the from-scratch rewrite of this repo's AI Village: ten villager bots + one
God (LLM: critic / curriculum / orchestrator desks + an avatar) acting through ONE
shared, God-owned library of typed, composable skills, admitted only after God judges
a real run a success. One Node process (D-01). The Java mod keeps only server-authority
duties (trade settlement :8767, Gibber coins, op-on-join).

## The spec is docs/, not this file
- docs/README.md — the 13 owner decisions (never relitigate) + reading order.
- docs/01..08 — architecture, skill system, God, villager runtime, observability,
  hard-won lessons (R1–R49 = acceptance criteria), dependency law + S1–S10 recipes.
- docs/11 (class model) + docs/12 (views) — static structure + dynamic behavior.
- docs/13 — D-07…D-13 (the seven resolved hard mechanisms) + deliverable tests.
- docs/IMPLEMENTATION-PLAN.md — the ordered, testable build plan (this is your map).
- docs/PROGRESS.md — append one dated section per session.

## Ground rules
- Work ONLY under eden/ and docs/. Never touch minecraft-mcp-server/ or src/ (v1/Java).
- Dependency law is CI-enforced (dependency-cruiser): imports go strictly downward
  (types → substrate → engines → actors → admin). No upward imports.
- TypeScript strict, Node 22 (tsx). Named imports for the mineflayer plugin trio (R15).
- No console.* outside logger.ts (R23). Every error names its subject + args (S10).
- Behavior + docs change in the same commit (S8): new pitfall → next R#; new choice → next D#.

## Build / test / run
- npm run lint && npx tsc --noEmit && npm test   # CI — fakes only, NO Minecraft
- Smoke against the dev server on port 25599 (read run/server.properties — R28).
- Settlement needs :8767 — stop ./gradlew runServer first (it steals it — R29).
- Host runs supervised under pm2 (crash-only respawn — D-08); ecosystem.config.cjs
  lives beside eden.json.

## M3 is the gate
One villager must converge on a trivial task through the full
task→draft→run→verdict→revise→admit cycle before ANYTHING parallel to it is built.
```

### `docs/PROGRESS.md` (seed)

```markdown
# Eden — implementation progress

One dated section per session: what was done, decisions taken, what's next,
surprises. Newest first.

## 2026-06-13 — planning
- Produced docs/IMPLEMENTATION-PLAN.md (dependency DAG, M0–M7 task breakdown,
  acceptance-test inventory, risk register). No eden/ source yet.
- Design-readiness check (plan §3): two gaps surfaced for the owner —
  G1 retention config key (05 says configurable, 01 sketch omits it) and
  G2 R27 death journaling has no registry kind. Trivial: login stagger 4 s (01) vs
  2 s (11) → use 4 s. Structural seams answered by 08/11: create types/ (layer 0),
  llm/embeddings.ts, views/ + eden rebuild-stats, roles.json, Inbox type in types/.
- Next: M0. Start with M0-1 (scaffold + dependency-cruiser + bootstrap),
  M0-2 (types/), M0-4 (journal + D-07 loop-lag test). Build the LLM branch (M2-L*)
  concurrently with the skill engine once M0 lands.

## Template
## YYYY-MM-DD — <milestone/topic>
- Done:
- Decisions (D#/R# if any):
- Next:
- Surprises:
```

---

## §7 — The first three tasks (and the exact test that closes each)

1. **`M0-1` — scaffold `eden/` + wire the dependency law + commit the bootstrap.**
   Files: `eden/package.json`, `tsconfig.json`, `.dependency-cruiser.cjs`, eslint
   (R23), `eden.example.json` (all `01` keys + port registry R24), `eden/CLAUDE.md`,
   `docs/PROGRESS.md`. **Closing test:** `npm run lint && npx tsc --noEmit` green on the
   scaffold **and** a deliberately-planted upward import **fails** the dependency-cruiser
   CI step (proves the `08` law is enforced from commit one).

2. **`M0-2` — the `types/` layer-0 module.** Every domain interface + enum from `11`
   §2 (incl. the `Inbox` type per §3.3). **Closing test:** `npx tsc --noEmit` compiles,
   and the dependency-cruiser rule **`types/` imports nothing** passes (proves layer 0
   is pure).

3. **`M0-4` — the journal (kinds registry + synchronous WAL writer + lag monitor).**
   `journal/kinds.ts` (S1) + `journal/journal.ts` (sole writer, WAL,
   `synchronous=NORMAL`) + the `main.ts` lag monitor. **Closing test — the D-07
   deliverable test:** inject a 1.2 s synchronous block → assert exactly one
   `system.loop-lag` event with `max ≥ 1000`; assert that driving the stall-detector
   pulse path emits **zero** journal events (R44). This is the first cross-cutting
   invariant (in-memory pulses, never journaled) locked in by a test.

> `M0-3` (config) and `M0-5` (fakes) follow immediately and unblock M1/M2; the **LLM
> branch (`M2-L1..L3`) can start the moment M0 lands** and runs concurrently with the
> skill engine, since both depend only on layers 0–1 and both gate `M3-GATE`.
