# 01 — System architecture

## Topology

One Node process — the **Eden host** — owns everything cognitive. The Java Fabric
mod stays, reduced to what genuinely needs server authority. LLM providers are
external HTTP services.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Eden host (Node, one process)                                       │
│                                                                     │
│  ┌────────────┐   ┌──────────────┐   ┌───────────────────────────┐  │
│  │ Bot pool   │   │ Skill engine │   │ God service               │  │
│  │ 10 villager│◄──┤ run/watchdog │◄──┤  critic desk              │  │
│  │ bots +     │   │ library      │   │  curriculum desk          │  │
│  │ god avatar │   │ call graph   │   │  orchestrator desk        │  │
│  └─────┬──────┘   └──────┬───────┘   └─────────────┬─────────────┘  │
│        │                 │                         │                │
│  ┌─────▼─────────────────▼─────────────────────────▼─────────────┐  │
│  │ Event router  (world events → subscriptions → skill | brain)  │  │
│  └─────┬─────────────────────────────────────────────────────────┘  │
│        │                                                            │
│  ┌─────▼──────┐  ┌───────────┐  ┌────────────┐  ┌────────────────┐  │
│  │ Villager   │  │ Memory    │  │ Scheduler  │  │ LLM client     │  │
│  │ brains     │  │ stores    │  │ (LLM budget│  │ (providers,    │  │
│  │ (deliber.) │  │ per bot   │  │  + queues) │  │  tiers)        │  │
│  └────────────┘  └───────────┘  └────────────┘  └────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────┐  ┌─────────────────────────────┐  │
│  │ Journal (SQLite, append-only)│  │ Admin server (HTTP + WS)    │  │
│  └──────────────────────────────┘  └─────────────────────────────┘  │
└──────────────┬──────────────────────────────────────┬───────────────┘
               │ Minecraft protocol (mineflayer)      │ HTTP (localhost)
┌──────────────▼──────────────────┐    ┌──────────────▼───────────────┐
│ Minecraft dedicated server      │    │ Java mod (pauls-brawls)      │
│ (Fabric, 1.21.1)                │◄───┤  trade settlement :8767      │
│                                 │    │  Gibber coins, op-on-join    │
└─────────────────────────────────┘    └──────────────────────────────┘
```

### Decision D-01: one process

**Chosen:** villager bots, the God brain, the God avatar bot, the skill engine, the
journal, and the admin server all live in a single Node process.

**Rejected:** v1's split (unified god-body process + separate village process +
Java-resident god brain).

**Why:** the refinement loop is chatty — a verdict touches the library, the journal,
a villager's inbox, and possibly the avatar within milliseconds. Cross-process
choreography (v1's bridge HTTP hops) added failure modes (silent 404s, port
collisions, double logins). A split does buy one genuine thing — **fault
isolation**: a bot that crashes its process can't take down God or the journal
writer. Eden's counter is that on a private server with one operator there is one
debugger and one lifecycle to reason about, and the cross-process choreography cost
is real and recurring while the isolation it buys is rarely exercised — but that
isolation is not free, and giving it up is a deliberate trade, not a freebie. Worker
threads remain available later if a single event loop ever saturates (it didn't in
v1 with 10 bots).

> **Resolved: see D-08.** (Was OQ-3 — single-process blast radius.)

### Decision D-08: neuter host-killing syscalls; supervise; crash-only

**Chosen:** skill scope gets a shim binding for `process` (and `require` / dynamic
`import` of `'process'` / `'node:process'`) that exposes a curated safe read-only
allowlist and throws `SkillForbiddenError` from the host-killing surface — `exit`,
`reallyExit`, `abort`, `kill`. It is installed as a **provided scope global** in the
same acorn compile step as the loop-budget instrument
([02 §Validation](02-skill-system.md#validation--runtime-supervision)) — **not** a
banned-identifier scan (the code still parses and runs, full P3 power; only the
*call* throws, producing a `RunReport` routed to the critic — exactly P3's
crash-escalation). The host runs under a **supervisor (pm2** on Windows; *not*
systemd, which doesn't exist there) with crash-only respawn → staggered relogin
(R13). No worker isolation and no journal-writer isolation in v0.

**Rejected:**
- *Keep P3 literal (no shim).* Honest to the principle's letter, but leaves the one
  unbounded-blast-radius accident armed: an accidental `process.exit()` becomes a
  full 11-bot reconnect storm + orphaned rollouts every time. Recoverable, but
  needlessly.
- *Build worker-per-bot containment in v0.* **Verified:** `process.exit()` inside a
  worker thread kills only that worker, not the host — so worker-per-bot *would*
  contain any exit to one bot. But it builds the deferred escape hatch
  ([08 §Scaling](08-extension-recipes.md#scaling-escape-hatches--pre-decided-so-nobody-panics-later))
  prematurely: cross-thread coordination for composition/logging/shared-budget, a
  strained complexity budget, and nothing has measured the need.

**Why:** neutering the host-killers costs **zero capability** (no legitimate skill
exits the host) and removes the only accident with unbounded blast radius, while pm2
respawn + D-07 (synchronous journal — no buffered events to lose) + crash-only
rollout handling (OQ-4, next) already turn a *genuine* crash into a planned,
low-loss event. So we get containment without the worker machinery or an armed nuke.
P3's spirit (power over protection, watchfulness not gates, accidents not
adversaries) is honored; only its one literal example — "a skill may call
`process.exit()`" — is amended, surfaced to and approved by the owner.

**Consequence:** the shim is a plain object (no Proxy — S5), exposing a safe
allowlist (`env`, `platform`, `arch`, `version`/`versions`, `hrtime`, `nextTick`,
`cwd`) and throwing from the four host-killers; everything else is `undefined`. It
catches the *lexical* accident (`process.exit()`, `require('process').exit()`),
**not** a determined escape (`globalThis.process`, the `Function` constructor
reaching globals) — that gap is accepted under P3's threat model and must **not** be
"fixed" by growing the denylist into the sandbox P3 rejected (**R45**). The shim is
not a security boundary — **tier is** (R25); a mortal skill is contained by never
being op'd, not by this shim. pm2 (or a Windows-service wrapper) owns respawn; its
`ecosystem.config.cjs` lives beside `eden.json`. Testable on the FakeBot harness: a
skill whose body calls `process.exit(0)` resolves to `outcome.ok = false` with a
`SkillForbiddenError` report and the host process stays alive.

**Consequence:** the existing Java-side God (`ChatBot.java`, `/pray`) and the unified
Node entrypoint are a *separate, coexisting system* during transition. Eden's avatar
must use a different bot username than `BridgeConfig.botUsername`
([07 §Identity](07-hard-won-lessons.md#identity--protocol)). Long-term, `/pray` can
be re-pointed at Eden's God ([06 §Player-facing](06-future-extensions.md)).

### Decision D-02: the Java mod keeps only server-authority duties

The mod retains: atomic trade settlement (`/trade/execute`), the Gibber `coin`
economy, op-on-join for the avatar, and the `/village`-style admin command (renamed
or extended for Eden). Everything cognitive leaves Java. The mod gains **zero** new
LLM code.

## Modules

Eden lives in a new top-level package: `eden/` (sibling of `minecraft-mcp-server/`,
which remains untouched as v1 until parity). Proposed layout — one module, one
responsibility, no cycles (enforce with a lint rule):

```
eden/
  package.json            # type: module, Node 22, TypeScript via tsx
  eden.example.json       # config template (copy → eden.json, gitignored)
  src/
    main.ts               # composition root: config → journal → bots → services
    config.ts             # load/validate eden.json; warn on unknown keys
    journal/
      journal.ts          # append + query; SQLite (better-sqlite3); pub/sub fanout
      kinds.ts            # the JournalKind enum + payload types (the schema)
    bots/
      pool.ts             # spawn/reconnect/own N villager bots + avatar
      hardening.ts        # pathfinder bounds, abort protocol, craft quiescence
      helpers.ts          # goTo hops, chest ops, collect, craft — plain functions (bot, ...)
    skills/
      types.ts            # SkillManifest, SkillVersion, RunReport, schemas
      library.ts          # storage, versioning, status transitions, grants stub
      engine.ts           # run(skill, bot, args): validation, watchdogs, call graph
      instrument.ts       # acorn loop-budget injection (hang prevention, NOT sandbox)
      describe.ts         # LLM description-from-code pass
      exemplars/          # curated seed skills shown in authoring prompts (full code)
    god/
      god.ts              # the service: desks, queues, state
      critic.ts           # verdicts on rollouts/run-reports
      curriculum.ts       # ledger, task proposal, decomposition, QA cache
      orchestrator.ts     # directives, troop organization, conflict resolution
      body.ts             # typed sugar over divine skill runs (appear/say/gesture theatrics)
      prompts/            # one file per desk prompt; no inline prompt strings
    villagers/
      villager.ts         # identity, lifecycle, inbox, anchors
      events.ts           # event router: normalize world events, match subscriptions
      subscriptions.ts    # subscription model, filters, persistence
      brain.ts            # deliberation loop: context pack → LLM → tools
      tools.ts            # tool schemas + dispatcher (run_skill, write_skill, read_skill, …)
      context-pack.ts     # assemble the escalation prompt payload
      memory.ts           # window + archive + summarize + retrieval (ported design)
    social/
      conversation.ts     # bot↔bot turns, in-process inboxes, chat mirroring
      trade.ts            # typed offers; settlement via Java listener; give()
    llm/
      client.ts           # provider-agnostic /v1/chat/completions; tool calling
      scheduler.ts        # global concurrency, priorities, coalescing, God preemption
    admin/
      server.ts           # HTTP read API + WebSocket journal stream + pause/resume
  tests/
    fakes/                # FakeBot, ScriptedLLM, in-memory journal
    *.test.ts
  .eden-data/             # runtime state (gitignored)
    eden.db               # journal + library index + ledger (SQLite)
    library/<skill>/v<k>.js
    bots/<name>/memory.json …
```

### Decision D-03: SQLite as the spine

**Chosen:** one SQLite file (`better-sqlite3`, WAL mode) holds the journal, the
library index, skill stats, the curriculum ledger, directives, and subscriptions.
Skill *code* lives as plain `.js` files on disk (greppable, diffable, git-friendly);
the DB stores paths + hashes. Per-bot memory stays in JSON files (ported v1 format,
cheap and human-readable).

**Rejected:** (a) keeping v1's JSON-file persistence as-is — it worked, but gives no
indexed history or live streaming, which the website requirement (#9) needs; (b)
embedded Postgres — heavier dependency and operational surface, overkill at 11 bots
on a private box.

**Why:** the website requirement (#9) makes "query everything, stream everything"
a first-class need. SQLite gives indexed history queries for free and is one
dependency — lighter than Postgres for a single-box deployment. JSON files stay
where humans edit or eyeball them (config, memories, skill code).

## Startup sequence

1. Load `eden.json`; validate; warn on unknown keys (v1 lesson — silent config typos
   cost days).
2. Open `eden.db`; run migrations; replay nothing (journal is append-only history,
   not an event-sourcing store — current state lives in its own tables).
3. Load the skill library index; verify code file hashes; quarantine mismatches.
4. Spawn the bot pool (staggered logins, ~4 s apart (v1's value — `LOGIN_STAGGER_MS`):
   burst logins trip throttles). Avatar last.
5. Anchor validation per villager (port of v1's self-healing anchors: home snaps to
   standable ground, chest re-discovered if missing — see
   [07 §Anchors](07-hard-won-lessons.md#world-state)).
6. Install subscriptions from persisted state; default role subscriptions for new
   villagers.
7. Start the God service: load ledger + dossiers; **recover crashed rollouts** (D-09:
   any open task whose `currentRolloutId` is still set is journaled
   `god.rollout-abandoned`, its pointer cleared, the task re-enqueued for assignment);
   enqueue a `boot-survey` curriculum tick.
8. Start the admin server. Journal `system.boot` with config snapshot (secrets
   redacted).

Crash-only design: there is no graceful-shutdown bookkeeping that matters. Any state
worth keeping was persisted when it changed; a `kill -9` at any moment must lose at
most in-flight LLM calls and the current actions.

> **Resolved: see D-09.** (Was OQ-4 — crash-only rollout resume.)

### Decision D-09: abandon-and-re-assign interrupted rollouts (no resume)

**Chosen:** an open rollout's durable artifacts are *already* persisted — the task
(`TaskLedger.open`, curriculum-owned), the draft code (`.eden-data/library/<name>/v<k>.js`,
`status: draft`, never retrieved/run for normal work by P2), and the full step history
(journal, `refs.rolloutId`, P4). The **only** volatile state is the in-memory
conversation, which crash-only already declares acceptable to lose. So Eden does **not**
resume rollouts. The ledger's `Task` carries a `currentRolloutId?` pointer (set at
assignment — it *also* enforces "one live rollout per task" at runtime). On boot
(startup step 7), every open task with that pointer still set has its rollout journaled
`god.rollout-abandoned{ reason: 'crash-recovery' }`, the pointer cleared, and the task
re-enters the normal assignment path with fresh `maxRetries`. Orphan drafts are left as
harmless `draft` versions (P2); the version history honestly shows the interrupted
attempt.

**Rejected:**
- *Persist & resume exactly* — reconstruct the live rollout + retry count from the
  journal, re-derive the density prompt from persisted artifacts, re-enter where it
  left off. Re-spends nothing, but adds boot reconstruction and (because the crash may
  hit mid-trial, before any `RunReport`, or mid-deliberation) collapses into the hybrid.
- *Hybrid* (resume mid-trial, abandon mid-deliberation) — most precise, most code: both
  paths plus the detection logic.

**Why:** D-08 makes crashes rare, and P2/P4 already persist everything that matters. A
mid-rollout crash therefore loses only the in-memory conversation — exactly what
crash-only accepts — so the still-open task simply re-enters the assignment path it
would have taken anyway. Resume machinery is real, recurring complexity bought for a
rare event whose recovery is already near-idempotent (S3/S4).

**Consequence:** one new journal kind (`god.rollout-abandoned`) and one `Task` field
(`currentRolloutId?`). Honest limit: a *non-idempotent* task partially executed before
the crash (a half-built structure, fuel already burned) can waste resources on
re-attempt — *mitigated, not eliminated* by the `check: {item,count}` gate (an
already-satisfied task passes fast) and generic-by-doctrine skills that check
prerequisites (Voyager rule 3, R34/R35 territory). Promote to resume only if
re-proposal churn ever measures costly. Testable on the in-memory-journal + FakeBot
harness: seed an open task with `currentRolloutId` set, a `draft` version, and rollout
journal events; run boot recovery; assert a `god.rollout-abandoned` event, a cleared
pointer with the task re-enqueued, and the orphan draft still `draft` (not `active`,
not retrievable).

## Configuration sketch (`eden.json`)

```jsonc
{
  "minecraft": { "host": "127.0.0.1", "port": 25599, "version": "1.21.1" },
  "villagers": [
    { "name": "Firmin", "role": "farmer",  "home": [120, 64, -40], "chest": [122, 64, -40] }
    // … coordinates are HINTS, self-healing at boot (v1 lesson)
  ],
  "god": {
    "name": "Dieu",                       // avatar username — MUST differ from v1's LLMBot
    "gamemode": "creative",               // the avatar is the only divine-tier runner
                                          //   (op'd via the Java mod; flight, /summon, …)
    "authoring": "villager",              // | "god" — who writes drafts (per-task overridable)
    "desks": {
      "critic":      { "model": "strong" },
      "curriculum":  { "model": "strong" },
      "orchestrator":{ "model": "fast"   }
    },
    "budget": {                            // D-13: throughput-limited; caps are a safety valve.
      "perDesk": {                         //   null = uncapped (the maxConcurrent ceiling bounds it)
        "critic":       { "dailyTokens": null },   // metered-API example: size as
        "curriculum":   { "dailyTokens": null },   //   dailyTokens ≈ targetSpend ÷ pricePerToken
        "orchestrator": { "dailyTokens": null }
      },
      "degradeOnBreach": true              // critic→check+template, curriculum→repeat, orchestrator→urgent-only
    },
    "embodiedVerdicts": true               // avatar shows up to deliver critiques
  },
  "behavior": { "drives": false },         // optional rest/social drives that generate wake-ups (04 §Memory)
  "llm": {
    "providers": { "strong": { "baseUrl": "…", "model": "…", "inputTokenBudget": 48000 },
                   "fast":   { "baseUrl": "…", "model": "…", "inputTokenBudget": 16000 } },
                                          // inputTokenBudget = per-call INPUT ceiling (D-11):
                                          //   current density payload never trimmed, history
                                          //   trimmed oldest-first. Lower for small-context models.
    "maxConcurrent": 3,
    "perVillagerCooldownSeconds": 15      // v1's value (botCooldownMs)
  },
  "skills": {
    "runDefaultTimeoutMs": 120000,        // per-call wall-clock ceiling (caller may raise ≤2h)
    "stallSeconds": 20,                   // async no-pulse abort; uniform, no per-op mode switch.
                                          //   pulse = a discrete progress EVENT (incl. pathfinder
                                          //   liveness events); in-memory, never journaled (D-10)
    "maxCallDepth": 8,
    "maxSkillLines": 400,                 // hard cap at write_skill (decompose-or-reject) so the
                                          //   density payload always fits the budget (D-11)
    "probationRuns": 3,                   // clean re-judged runs before an admitted skill becomes
                                          //   composable by other skills (D-12)
    "autoQuarantineAfter": 5              // consecutive-failure tripwire that files a critic ticket
  },
  "settlement": { "url": "http://127.0.0.1:8767/trade/execute" },
  "admin": { "port": 8770 },
  "journal": {
    "vitalsIntervalSeconds": 10,          // per-bot snapshot cadence (1.1 ev/s @ 11 bots);
                                          //   pulses are in-memory, never journaled (D-07)
    // WAL + synchronous=NORMAL writes on the shared loop; lag-monitor threshold (1000ms)
    //   is hardcoded, not a key (D-07). No async queue / writer isolation in v0.
    "debugPrompts": false                 // true = write full LLM transcripts to .eden-data/llm/<id>.json
  }
}
```

Ports: Eden admin gets a **new** port (8770) so v1 (8765/8766/8767) can run
side-by-side during transition. 8767 (Java settlement) is shared — it is stateless
per request and serves either system.

## Build order (for the implementing agents)

Each milestone is shippable and testable without the next one.

1. **M0 — spine.** Config, journal (+kinds), admin `/status`, fake-bot test harness.
   CI: lint + typecheck + unit tests, no Minecraft.
2. **M1 — bodies.** Bot pool with hardening port (abort protocol, bounded pathfinder,
   staggered spawn), helpers module, vitals journaling. Manual smoke: 10 bots stand
   in the world without disconnect storms.
3. **M2 — skill engine.** Library CRUD + versioning, instrumented execution,
   watchdogs (stall + wall-clock), call graph, run reports. Seed exemplar skills.
   Tests: scripted skills against FakeBot; a deliberate `while(true)` is caught.
4. **M3 — the loop.** God critic desk + villager brain v0 (write_skill/read_skill/
   run_skill tools) + the refinement loop end-to-end on ONE villager and trivial
   tasks ("collect 3 logs"). This is the heart — do not parallelize past it until
   it converges reliably.
5. **M4 — curriculum + orchestrator.** Ledger, task proposal, directives, multi-
   villager assignment. The village now runs unattended.
6. **M5 — events.** Router, subscriptions with filters, auto-handlers, escalation
   context packs. Default role subscriptions.
7. **M6 — society.** Conversations, trades (settlement integration), memory port,
   social drives if wanted.
8. **M7 — parity+.** Admin API complete, WS stream, pause/resume, eval harness
   ported, v1 decommission checklist.
