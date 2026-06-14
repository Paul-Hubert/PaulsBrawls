# Eden — design documentation

**Eden** (working title) is the from-scratch rewrite of the AI Village. The current
implementation under [minecraft-mcp-server/src/village/](../minecraft-mcp-server/src/village/)
(design log: [VILLAGE_PLAN.md](../VILLAGE_PLAN.md)) is **v1 / legacy**: it works, but it grew
organically, its per-villager skill silos cap what the village can learn, and repeated
agent-driven coding runs against it have failed — it is too entangled to evolve safely.
Eden restarts the design around one organizing idea:

> **One God closes every loop.** A single LLM entity judges skill runs, sets the
> curriculum, and orchestrates the villagers — in the world, through the avatar body
> it already has. Skills are typed, composable functions in one God-owned library,
> written against the full mineflayer API, admitted only after verified success.

These documents are the contract for the rewrite. They are written to be executable
by AI coding agents: every module has a stated responsibility, every cross-module
interaction has a typed interface, and every non-obvious choice has a decision record.

## Reading order

| Doc | Contents |
|---|---|
| [00-vision.md](00-vision.md) | Why rewrite, design principles, glossary |
| [01-architecture.md](01-architecture.md) | Process topology, modules, data layout, config, build order |
| [02-skill-system.md](02-skill-system.md) | Skill anatomy, the library, validation & watchdogs, composition, retrieval, prompting |
| [03-god.md](03-god.md) | The God service: critic desk, curriculum desk, orchestrator desk, the body, the refinement loop |
| [04-villager-runtime.md](04-villager-runtime.md) | Villager lifecycle, event subscriptions & filters, deliberation, action engine, memory |
| [05-observability.md](05-observability.md) | The journal, admin API, live-stream contract for the future website |
| [06-future-extensions.md](06-future-extensions.md) | Skill economy, proficiency, multi-village, website — seams reserved now, built later |
| [07-hard-won-lessons.md](07-hard-won-lessons.md) | Mineflayer/runtime landmines from v1 that the rewrite MUST NOT re-discover (R1–R49, acceptance criteria) |
| [08-extension-recipes.md](08-extension-recipes.md) | The dependency law, anti-blow-up rules (S1–S10), step-by-step recipes for safe additions, scaling escape hatches |
| [09-agent-kickoff-prompt.md](09-agent-kickoff-prompt.md) | Copy-paste kickoff prompt for the implementing agent (reading order, ground rules, milestone DoD) |
| [10-architecture-summary.md](10-architecture-summary.md) | Executive summary: every architectural choice (chosen + rejected + why), part by part — the ten-minute orientation read |
| [11-class-model.md](11-class-model.md) | UML class model of the whole framework — static structure: every class, package, and extension seam (companion view of 01–08) |
| [12-architecture-views.md](12-architecture-views.md) | Architecture views — dynamic side: deployment/ports, startup, refinement-loop/event/skill-run/trade sequences, lifecycles, data schema, LLM scheduling |
| [13-open-questions.md](13-open-questions.md) | Open design questions (OQ-1…OQ-7) surfaced in review — unresolved, to be co-designed before they're implemented |
| [14-codesign-prompt.md](14-codesign-prompt.md) | Copy-paste kickoff prompt for the OQ-1…OQ-7 co-design session (resolutions become D-records) |
| [15-m0-as-built.md](15-m0-as-built.md) | M0 spine **as built** — package/layer, class, boot, and runtime-path diagrams of the code that exists today |
| [16-m0-reference.md](16-m0-reference.md) | M0 **reference** — module-by-module prose guide to the shipped spine: public surface, invariants, error modes, recipes, the test that pins each behavior |
| [17-parity-signoff.md](17-parity-signoff.md) | M7 **parity sign-off + v1 decommission checklist** — what "Eden reaches parity" means, the identity/port coexistence law (R12/R24), world-stamp (R32), the smoke procedure, and the cut-over steps |
| [18-real-villager-tests-prompt.md](18-real-villager-tests-prompt.md) | Agent **kickoff prompt** for the live (real-server + real-LLM) villager test suite |
| [19-live-test-suite.md](19-live-test-suite.md) | The **live test suite** reference — harness architecture, assertion vocabulary, the three scenarios (farm/craft/defense), the real-mineflayer surface each exercises, and the findings log |
| [20-live-test-process.md](20-live-test-process.md) | The **live-testing process** — the run→diagnose→fix→re-run loop, the diagnostic playbook (reading the journal, RCON ground truth, symptom→cause patterns), and the worked example that drove five fixes (W/C/D1/D2/E) |

Docs 11–12 render on GitHub, or locally without it: open the matching `.html`
(same folder), regenerated via `node docs/render-docs.mjs`.

## Requirements traceability

The rewrite decisions, as fixed by the project owner (June 2026), and where each is
specified:

| # | Decision | Where |
|---|---|---|
| 1 | Skills are **criticized by God** — a single LLM that judges runs and returns constructive critique; library admission is success-gated | [02 §Admission](02-skill-system.md#admission-pipeline), [03 §Critic](03-god.md#the-critic-desk) |
| 2 | The **library is per-God (global)**, not per-villager | [02 §Library](02-skill-system.md#the-library) |
| 3 | Skill **sharing/economy** (buying, working in exchange) is future work; architecture must make the transition easy | [02 §Grants](02-skill-system.md#access-control-the-economy-seam), [06 §Economy](06-future-extensions.md#the-skill-economy) |
| 4 | The **refinement loop** is God-driven: God criticizes and orchestrates ("organizes the troops"), in person via its avatar or from its inbox | [03 §Refinement loop](03-god.md#the-refinement-loop) |
| 5 | **No static typecheck.** Validation = syntax parse only; runtime = hang/stall detection ("it's not supposed to pause") and crash escalation to the LLM | [02 §Validation](02-skill-system.md#validation--runtime-supervision) |
| 6 | **Curriculum is God's job** — one prompt or several ("desks"), configurable | [03 §Curriculum](03-god.md#the-curriculum-desk), [03 §Desks](03-god.md#one-god-three-desks) |
| 7 | Skills **call other skills**, with **typed parameters and typed returns**; plus **subscribable, filterable events** (proximity, type, …) that are either auto-handled by a skill or escalate into an LLM call with full context | [02 §Composition](02-skill-system.md#composition), [04 §Events](04-villager-runtime.md#the-event-system) |
| 8 | **Retrieval by English description**, not code; a `read_skill` tool exposes full code on demand; `write_skill` is one upsert tool (create = update) | [02 §Retrieval](02-skill-system.md#retrieval--prompting) |
| 9 | **Everything logged and visible** — a real-time website will eventually show villagers, skills, and activity; the journal is designed for it now | [05-observability.md](05-observability.md) |
| 10 | **Prompting like Voyager**: rich observation rendering + worked code examples always in context | [02 §Prompting](02-skill-system.md#retrieval--prompting), [04 §Context pack](04-villager-runtime.md#the-context-pack) |
| 11 | **Full mineflayer API** — generated code runs against the entire bot surface, no closed wrapper API | [02 §Power ceiling](02-skill-system.md#the-power-ceiling-full-mineflayer) |
| 12 | Voyager's harness conveniences (world rollback, env resets) are explicitly **out of scope** | [00 §Dropped](00-vision.md#what-is-deliberately-dropped) |
| 13 | **God uses skills too, with elevated permissions** (fly, spawn, server commands) — the mortal/divine tier system; God's interventions are journaled skill runs | [02 §Tiers](02-skill-system.md#tiers-mortal-and-divine), [03 §Body](03-god.md#the-body) |

## Status

Design phase. No Eden code exists yet. v1 stays runnable throughout
(`npm run village`) until Eden reaches parity; the two must never share bot usernames
([07 §Identity](07-hard-won-lessons.md#identity--protocol)). The seven hard mechanisms
that were genuinely open are now **all resolved** (owner co-design session, June 2026):
D-07…D-13 in their home docs, with R44…R49 capturing the new landmines —
see [13-open-questions.md](13-open-questions.md). M3 is unblocked.
