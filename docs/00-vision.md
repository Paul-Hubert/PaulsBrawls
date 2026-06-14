# 00 — Vision and design principles

## What Eden is

Ten villager bots live in a Minecraft world under the eye of one God. The God is a
single LLM entity with three jobs — **critic**, **curriculum**, **orchestrator** — and
a physical avatar it can move through the world. Villagers — and God itself — act
through **skills**: typed, composable async JavaScript functions written against
the **full mineflayer API**, stored in **one shared library that belongs to the
God**. God's own skills run **divine**: elevated powers (flight, spawning, server
commands) that villagers can never see or call. New skills are
drafted by villagers (or by God), tried in the world, and **admitted to the library
only when God judges the run a success**. Failures come back as constructive
critique, Voyager-style, and the loop repeats.

Between LLM calls, villagers are not idle scripts: they have an **event system** —
subscriptions with declarative filters (proximity, entity kind, time of day, …) that
either fire a library skill automatically (free, no tokens) or escalate into an LLM
deliberation carrying exactly the context that matters (the triggering event, recent
happenings, retrieved memories, the active directive from God).

Everything that happens — every skill run, every verdict, every directive, every LLM
call, every chat line — is appended to a single **journal**. The journal is the
system's source of truth and the future data feed for a real-time website showing
the village live.

## Why a rewrite

v1 ([VILLAGE_PLAN.md](../VILLAGE_PLAN.md)) proved the concept and accumulated
hard-won operational knowledge (preserved in [07-hard-won-lessons.md](07-hard-won-lessons.md)).
But four structural choices now cap it:

1. **Per-villager skill silos.** Ten bots each re-learn farming from their own seed.
   Nothing one villager learns ever benefits another. The library should compound;
   in v1 it fragments.
2. **A closed 27-verb API.** Villager code can only do what `VillagerAPI` anticipated.
   The ceiling on emergent behavior is the API surface, and every new ability is a
   developer PR. Voyager's headline result — genuinely novel skills — is impossible
   by construction.
3. **No judge.** Skills enter the library when they *compile*, not when they *work*.
   The only quality signal is "didn't throw three times." Semantically broken skills
   live forever; nothing in the system ever says "that was good, do more of that."
4. **A loop torn into scheduling confetti.** Failure feedback arrives deliberations
   later, gated by coalescing, cooldowns and suppression memos. Voyager retries up to
   four dense rounds in one tight loop before re-querying its curriculum; v1 spreads
   failure feedback across hours of scheduler-gated wake-ups, with the anti-spam
   machinery actively gagging the very repetition that debugging needs.

There is also a meta-reason: **v1 has become hostile to agent-driven development.**
Multiple automated coding runs (Fable 5 sessions) against the v1 codebase failed to
land changes. The cognition pipeline (reflex sandbox + typechecker + scheduler +
day-planner + memory) is so interlocked that a change anywhere needs context from
everywhere. Eden is explicitly designed to be built and maintained *by agents*:
small modules, contract-first interfaces, fake-bot test seams, and these documents.

## Design principles

**P1 — One God closes every loop.** Task proposal, success judgment, and
inter-villager coordination all converge on a single entity with global state (the
ledger, the library, the dossiers). No distributed consensus, no per-villager
curricula drifting apart. If two subsystems disagree, God's verdict wins.

**P2 — The library only contains proven code.** A skill version becomes `active`
when a real run succeeded and God said so. Drafts and failures are kept (visible,
versioned, criticized) but never retrieved as capabilities. This is Voyager's central
idea and Eden's most load-bearing invariant.

**P3 — Power over protection.** Skill code gets the entire mineflayer bot object.
There is no sandbox API, no static typechecker, no banned-identifier list. The threat
model is *accidents on a private server*, and the mitigations are **watchfulness,
not gates**: stall detection (a skill is never supposed to pause), wall-clock caps,
a hardened abort protocol, and crash reports that escalate to the LLM loop instead
of being suppressed. We accept that a villager *could* call `process.exit()`; we bet
that with full API power plus God's critique, it learns faster than it breaks.

> **Resolved: see [D-08](01-architecture.md#decision-d-08-neuter-host-killing-syscalls-supervise-crash-only).**
> The host-killing syscalls (`process.exit`/`reallyExit`/`abort`/`kill`) are neutered
> in skill scope (a footgun-removal shim, not a sandbox); the host runs supervised
> (pm2) with crash-only respawn. P3's letter is amended on this one example; its
> spirit stands. The threat model below remains *accidents, not adversaries* — see
> R45 ([07](07-hard-won-lessons.md#sandbox-boundary)).

**P4 — Everything is a journal event.** Logging is not a debugging afterthought; the
journal IS the system's memory of itself. Skill stats are aggregations over journal
events. The website is a journal consumer (even its interactive controls journal what
they did before acting). Post-mortems are journal queries. If an
action didn't produce a journal event, architecturally it didn't happen.

**P5 — Policy as data, capability as code.** Skills (code) say *how* to do things.
Subscriptions, directives, day plans, grants (data) say *when, who, and whether*.
Data policies are inspectable, journalable, website-renderable, and editable by
tools without touching code. v1 blurred this (reflexes were code that embedded
policy); Eden separates it strictly.

**P6 — Built for agents.** Every module has one responsibility and a typed surface.
Anything LLM-facing (prompts, tool schemas, context packs) lives in dedicated files,
not inline strings. The engine is testable with a fake bot and a scripted LLM —
no Minecraft server needed for CI. Documentation (this folder) is updated in the
same commit as behavior changes; the docs are the spec, not commentary.

**P7 — Reserve the seams, skip the features.** The skill economy (villagers buying,
selling, working for skills), per-villager proficiency, multi-village federation,
and the website are all *future*. Eden v0 ships none of them but every interface
they need exists as a stub with one obvious extension point
([06-future-extensions.md](06-future-extensions.md)).

## What carries over from v1

Not code — knowledge. Specifically:

- The **mineflayer hardening corpus**: crafting window hijack, pathfinder abort
  order, bounded search, hop-wise navigation, plugin import traps. Now requirements
  in [07-hard-won-lessons.md](07-hard-won-lessons.md).
- The **memory design** (window + archive + summarization + importance + optional
  embeddings) — proven, kept with simplifications ([04 §Memory](04-villager-runtime.md#memory)).
- The **conversation + typed-trade machinery** and the Java-side **atomic settlement
  listener** (`127.0.0.1:8767/trade/execute`) — kept as-is conceptually; Gibber
  `coin` remains the currency.
- The **scheduler vocabulary** (priorities, coalescing, concurrency caps) — kept,
  but God gains preemption rights.
- The **loop-budget instrumentation trick** (acorn pass injecting a cycle counter) —
  kept *not* as a sandbox but as the only way to detect a synchronous infinite loop
  in-process ([02 §Validation](02-skill-system.md#validation--runtime-supervision)).

## What is deliberately dropped

- The TypeScript typechecker gate (`skill-typecheck.ts`) and the published
  `API_DTS` contract — replaced by runtime arg validation + God critique.
- The closed `VillagerAPI` wrapper — replaced by the raw bot + a helpers module.
- The reflex/routine **kind split as two engines** — replaced by one skill kind and
  a separate subscription layer ([04 §Events](04-villager-runtime.md#the-event-system)).
- Per-villager skill storage, the 24-skill cap, in-place version overwrites.
- The banned-identifier scan and `register`/`live` mode switch.
- Voyager's env-reset/world-rollback conveniences — meaningless in a live shared
  world; explicitly out of scope.

## Glossary

| Term | Meaning |
|---|---|
| **God** | The single LLM entity owning judgment, curriculum, and orchestration. Has an avatar bot. In-world name: `Dieu`. |
| **Desk** | One of God's three roles (critic / curriculum / orchestrator), independently promptable and model-tierable. |
| **Skill** | A versioned async JS function `(bot, args, ctx)` with a typed manifest, stored in the library. |
| **Tier** | Execution privilege of a skill and a runner: `mortal` (villager bots, never op'd) or `divine` (the op'd avatar — flight, spawning, server commands). Engine-enforced boundary, not policy. |
| **Library** | The single God-owned store of skill versions + manifests + stats. |
| **Admission** | The act of marking a skill version `active` after a God-verified successful run. |
| **Rollout** | One attempt at a task: assignment → execution → report. The unit the critic judges. |
| **Verdict** | God's judgment of a rollout: success flag + critique + library action. |
| **Directive** | A God-issued order to a villager (goal + context + priority + expiry). Data, not code. |
| **Subscription** | A villager's declarative event binding: filter + handler (skill call or LLM escalation). |
| **Context pack** | The assembled prompt payload for one LLM escalation: event, situation, memories, directive, relevant skills. |
| **Journal** | The append-only event log that everything writes to; source of truth for stats, debugging, and the future website. |
| **Ledger** | God's curriculum state: completed/failed tasks per villager and village-wide. |
| **Grant** | (Future) a villager's access right to a skill — the economy seam. v0: everyone has everything. |
