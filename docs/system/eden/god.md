---
id: eden.god
title: Eden God — critic, curriculum, orchestrator desks, divine body and the refinement loop
system: eden
summary: How Eden's God works in code — the three desks (inputs, tools, exact Verdict/Task/Directive shapes), rails, budget degrade, the body, and the RolloutCoordinator loop.
tags: [eden, god, critic, curriculum, orchestrator, verdict, directive, task-ledger, rollout, refinement-loop, density-invariant, budget, divine, avatar, Dieu]
sources: [eden/src/god/god.ts, eden/src/god/critic.ts, eden/src/god/curriculum.ts, eden/src/god/orchestrator.ts, eden/src/god/body.ts, eden/src/god/prompts/critic.md, eden/src/god/prompts/curriculum.md, eden/src/god/prompts/orchestrator.md, eden/src/main.ts, eden/src/config.ts, eden/src/types/task.ts, eden/src/types/inbox.ts, eden/src/llm/scheduler.ts, eden/src/villagers/brain.ts, eden/src/villagers/context-pack.ts, eden/src/villagers/inbox.ts, eden/src/villagers/tools.ts, eden/src/skills/engine.ts, eden/src/skills/exemplars/index.ts, eden/src/journal/kinds.ts, eden/eden.example.json, eden/tests/god-critic.test.ts, eden/tests/god-curriculum.test.ts, eden/tests/god-orchestrator.test.ts, eden/tests/god-budget.test.ts, eden/tests/god-body.test.ts, eden/tests/god-recovery.test.ts, eden/tests/god-service.test.ts, eden/tests/loop-integration.test.ts, eden/tests/village-loop.test.ts]
verified_at: 4a8081f
---

# Eden God — desks, body and the refinement loop

**TL;DR.** Eden's village God is three LLM "desks" over one shared in-memory `GodState`: the **critic** (judges one skill run → `Verdict`, strong tier, forced `verdict` tool), the **curriculum** (proposes tasks, sole writer of the task ledger, strong tier + fast-tier QA cache), and the **orchestrator** (turns tasks into `Directive`s delivered to villager inboxes, fast tier). `GodService` owns rollouts, the critic queue and verdict routing into the skill library. The `RolloutCoordinator` in `main.ts` drives task → directive → villager deliberation → critic → route → revise/close. Several documented features (`combineDesks`, embodied verdicts, divine intervention, verdict batching, dawn trigger, daily budget reset, plea tickets) exist as code or config but are **not wired in production** (tripwire tickets are, since B3.3) — see Gotchas.

## Where things live

| Concern | File | Key symbol |
|---|---|---|
| Shared state, rollouts, verdict routing, boot recovery | `eden/src/god/god.ts` | `GodState` (`:27`), `GodService` (`:71`) |
| Critic desk | `eden/src/god/critic.ts` | `CriticDesk` (`:105`), `VERDICT_TOOL` (`:65`) |
| Curriculum desk (ledger writer, QA cache) | `eden/src/god/curriculum.ts` | `Curriculum` (`:144`) |
| Orchestrator desk (directives, anti-thrash) | `eden/src/god/orchestrator.ts` | `Orchestrator` (`:97`) |
| Avatar sugar over divine skills | `eden/src/god/body.ts` | `GodBody` |
| System prompts (loaded at runtime via `readFileSync`) | `eden/src/god/prompts/{critic,curriculum,orchestrator}.md` | `load*Prompt()` |
| Wiring + refinement loop + autonomous pump | `eden/src/main.ts` | `wireGod` (`:486`), `RolloutCoordinator` (`:866`), `VillageLoop` (`:1061`) |
| Shapes | `eden/src/types/task.ts`, `eden/src/types/inbox.ts` | `Task`, `Verdict`, `Directive`, `Rollout`, `Dossier`, `Inbox` |

Dependency law: `god/` imports `skills/`, `llm/`, `render/`, `journal/`, `types/` only; it reaches villagers through the injected `Inbox` interface (`eden/src/types/inbox.ts:13`) and never imports `villagers/` or `social/` (`eden/src/god/orchestrator.ts:18-20`). The coordinator touches both sides, so it lives in `main.ts`.

## God state (single home)

`GodState` (`eden/src/god/god.ts:27-36`), held by `GodService.state` and shared **by reference** with the curriculum and orchestrator (`eden/src/main.ts:563,566`). It is **in-memory only** — nothing in `god/` persists it (crash recovery re-derives only rollout pointers of tasks still in memory; see Recovery).

| Field | Type | Sole writer |
|---|---|---|
| `ledger` | `TaskLedger {completed: TaskRecord[], failed: TaskRecord[], open: Task[]}` | Curriculum (`GodService` delegates via `LedgerWriter`, `eden/src/god/god.ts:51-54`; wired by a cast at `eden/src/main.ts:565`) |
| `tasks` | `Map<taskId, Task>` — open-task pool | Curriculum (`admit`/`closeTask`) |
| `dossiers` | `Map<villager, Dossier>` | `GodService.updateDossier` (competence/verdicts) + `Orchestrator.reportToGod` (notes) |
| `criticQueue` | `CriticTicket[]` | `GodService.fileTicket` (append only — never drained by anything) |
| `rollouts` | `Map<rolloutId, Rollout>` | `GodService` (+ the coordinator sets `rollout.open=false` directly, `eden/src/main.ts:991,1010`) |
| `directivesOpen` | `Directive[]` | Orchestrator |

### Exact shapes (`eden/src/types/task.ts`)

```ts
interface ItemCheck { item: string; count: number }                        // :4
interface Task {                                                             // :10
  id: string; goal: string; assignee?: string; successCriteria: string;
  check?: ItemCheck; context: string;      // QA-cache answer folded in
  maxRetries: number;                      // set to 4 by Curriculum.makeTask
  parent?: string; currentRolloutId?: string;   // D-09 live-rollout pointer
}
interface TaskRecord { task: Task; closedAt: number; verdictId?: string; reason?: string } // :25
interface Verdict {                                                          // :83
  ticketId: string; success: boolean; score?: number; critique: string;
  libraryAction: 'admit' | 'keep-draft' | 'quarantine' | 'archive' | 'none';
  followUp?: DirectiveSuggestion | TaskSuggestion; praise?: string; blocked?: boolean;
}
interface TaskSuggestion { goal: string; successCriteria?: string; assignee?: string; parent?: string; check?: ItemCheck } // :51
interface DirectiveSuggestion { to: string | string[] | 'all'; goal: string; reason: string; priority?: Priority }      // :43
interface Directive {                                                        // :62
  id: string; to: string | string[] | 'all'; goal: string; reason: string;
  priority: Priority;   // 'background' | 'normal' | 'interrupt'
  taskRef?: string; expiresAt?: number; standing?: boolean;
}
interface CriticTicket { id: string; source: 'rollout'|'tripwire'|'plea'|'second-opinion'; runReportRef: string; taskRef?: string; filedAt: number } // :74
interface Rollout { id: string; taskId: string; villager: string; attempt: number; draftVersions: number[]; critiqueChain: string[]; open: boolean } // :100
interface Dossier { villager: string; competence: Record<tag,{runs,successes}>; recentVerdicts: {verdictId,at,success}[]; notes: string[]; standingOrders?: string } // :121
interface InboxMessage { from: 'god'|'villager'; kind: 'directive'|'critique'|'tell'; payload: object; at: number } // eden/src/types/inbox.ts:2
```

## Desk configuration

Config keys (`eden/src/config.ts:51-64`, defaults `:90-109`, parsing `:240-277`):

| Key | Default | Effect in code |
|---|---|---|
| `god.name` | `"Dieu"` | Avatar username; must differ from every villager (fatal `assertIdentity`, `eden/src/config.ts:379-388`); `"LLMBot"` only warns (`:365-367`) |
| `god.desks.critic.model` | `"strong"` | `CriticDesk.tier` (`eden/src/main.ts:567`). Any value other than `"fast"` → `strong` (`eden/src/config.ts:251`) |
| `god.desks.curriculum.model` | `"strong"` | proposal/decompose tier (`eden/src/main.ts:563`); QA answers are hard-wired `fastTier:'fast'` |
| `god.desks.orchestrator.model` | `"fast"` | dispatch tier (`eden/src/main.ts:566`) |
| `god.budget.perDesk.<critic\|curriculum\|orchestrator>.dailyTokens` | `null` | `BudgetTracker` cap; non-number → `null` (uncapped) (`eden/src/config.ts:255-259`) |
| `god.budget.degradeOnBreach` | `true` | passed to all three desks |
| `god.combineDesks` | `false` | **parsed but never read** — no combined mode exists |
| `god.embodiedVerdicts` | `true` | passed to a `GodBody` that is constructed and discarded (`eden/src/main.ts:570`) — no effect |
| `god.authoring` | `"villager"` | parsed (`eden/src/config.ts:260`), never read by `src/` |
| `god.gamemode` | `"creative"` | not read by `god/` (see bots docs) |
| `god.godPrompt` (scenario) | unset | appended to **every** desk's system prompt as `\n\n## Scenario instructions\n<gp>` (`eden/src/main.ts:558-561`); also flips the curriculum's warm-up text (`hasMissionDirective`) |

Every desk call goes through `LlmScheduler.enqueue` with `lane: 'god'` and a `villager` key of `god:critic` / `god:curriculum` / `god:orchestrator` (so it bypasses rate cap, coalescing and cooldown — see [llm-and-scheduling.md](llm-and-scheduling.md)). There is **no** intra-God priority (critic vs curriculum vs orchestrator are FIFO within the `god` lane, `eden/src/llm/scheduler.ts:196-201`).

## The critic desk (`eden/src/god/critic.ts`)

**Input — `CriticContext`** (`:29-42`): `ticket`, `task`, full `RunReport` (`report`), the skill version's full `code`, optional `dossier`, `stats`, `lastCritique`, `divineAssisted`. The coordinator passes ticket/task/report/code/dossier/lastCritique/divineAssisted — **not `stats`** (`eden/src/main.ts:968-976`).

**User message** (`renderContext`, `:212-222`, French headings): `## TÂCHE` (goal, criteria, optional `check objectif: N× item`), `## RUN REPORT` (`renderRunReport`), `## CODE DU SKILL (vN)`, optional `## DOSSIER`, `## STATS`, `## DERNIÈRE CRITIQUE (chaîne)`, then "Appelle l’outil `verdict` avec ton jugement."

**LLM call** (`:131-147`): system = critic prompt; tools = `[VERDICT_TOOL]`; **`toolChoice` forced** to `{type:'function', function:{name:'verdict'}}` (R52); `tier` (default `strong`); `caller:'god:critic'`; refs `{rolloutId, runId, skill, skillVersion}`. Tokens spent are charged to desk `critic`.

**`verdict` tool schema** (`:65-96`): required `success:boolean`, `critique:string`, `libraryAction ∈ {admit, keep-draft, quarantine, archive, none}`; optional `score:number` (0–10), `praise:string` (French), `blocked:boolean`, `followUp:{goal (required), successCriteria?, check?:{item,count}}`.

**Parsing** (`parseVerdict`, `:224-243`): tool-call args, else the first `{…}` JSON in the text content. No structured reply → safe verdict `{success:false, critique:'(critique indisponible — réponse non structurée)', libraryAction:'keep-draft'}`. Unknown `libraryAction` → `keep-draft` (`:277-279`). `success` is true only if strictly `=== true`.

**Deterministic rails** (`applyRails`, `:246-274`), applied after the LLM, one-directional:

| Rail | Condition | Effect |
|---|---|---|
| check-veto (D-12 i / R34) | `task.check` set and `worldAfter` inventory holds `< check.count` of `check.item` (`checkSatisfied`, `:311-315`; `worldAfter:null` = fail) | `success=false`; `admit→keep-draft`; appends `[check non satisfait: il faut N× item (R34: une sortie propre n'est pas un progrès).]` if the LLM had claimed success/admit |
| voidDivineOverreach | `ctx.divineAssisted && success` | `success=false`; `admit→keep-draft`; appends `[succès voidé: l'objectif a été atteint par intervention divine, pas par le skill du villageois (overreach).]` |
| blocked-on-resource (R72) | `verdict.blocked === true` | `success=false`; `admit`/`quarantine` → `none` |

A satisfied check is **not** an auto-admit — the LLM verdict stands.

**Degraded mode (D-13)** (`templatedVerdict`, `:204-210`): if `degradeOnBreach && budget.degraded('critic')`, no LLM call. `success = checkSatisfied(...)` if the task has a check, else `report.outcome.ok`; `libraryAction` is always `keep-draft` (never admits); critique is a French template naming the budget breach.

**Batching** (`judgeBatch`, `:160-193`, `batchMax` default 3, wired as 3 at `eden/src/main.ts:567`): one call for ≤3 tickets, verdicts matched by a `ticketId` arg (positional fallback). **Not called anywhere in production** — the coordinator calls `judge` one ticket at a time.

### Critic prompt (`prompts/critic.md`, 53 lines)
Judge **world delta, not a clean exit** (R34) but "quiet is not futile" (R35); prefer generic/parameterized skills; prefer composition — name the existing skill to call via `ctx.skills.run`; name the ONE most instructive next change; "blocked on a missing resource is NOT a code defect" → `blocked:true`, `libraryAction:'none'`, provide `followUp`; describes each `libraryAction`; `critique` in English, `praise` in French; a satisfied `check` is evidence, never a bypass.

## The curriculum desk (`eden/src/god/curriculum.ts`)

Sole writer of `state.ledger` and `state.tasks`.

| Constant | Value | Line |
|---|---|---|
| `DEFAULT_MAX_RETRIES` (per task) | `4` | `:37` |
| `MAX_ROLLOUT_ATTEMPTS` (R65 breaker) | `2` exhausted rollouts | `:44` |
| `WARMUP_COMPLETED` | `8` completed tasks | `:45` |
| `QA_DEDUP_THRESHOLD` | `0.92` (cosine or keyword score) | `:46` |
| Proposal context: completed shown | last 12 | `:488` |
| Proposal context: failed shown | last 8 (reason truncated 240 chars) | `:491` |
| Library coverage shown | first 40 live **mortal** skills | `:505-511` |
| Follow-up dedup window | open goals + last 12 failed | `:324-325` |

Triggers (`CurriculumTrigger`, `:141`): `idle | verdict-close | dawn | critic-follow-up | admin`. In production only `idle` is used (by `VillageLoop`, `eden/src/main.ts:1127`); `critic-follow-up` by `addFollowUp`; `admin` by `addTask`/`decompose`.

### `proposeTask({trigger, villager?, snapshot?})` (`:188-232`)
1. If degraded (`budget.degraded('curriculum')`): `repeatLastTaskType` (`:548-561`) clones the newest open task (else newest completed) with a fresh id — no LLM call. Returns `undefined` only if there is no template, in which case it falls through to the LLM.
2. Else builds `renderProposalContext` (`:464-500`): `## PHASE` (`WARM-UP …` when `completed.length < 8`, else `ÉTABLI`) plus a warm-up nudge (mission-aware if `godPrompt` set, else "SURVIE basique"); `## INVENTAIRE ACTUEL (<villager>)` with a no-re-acquire guard; `## COMPÉTENCES EXISTANTES`; `## FRONTIÈRE — RÉUSSIES`; `## FRONTIÈRE — ÉCHOUÉES` (with `↳ reason`); `## TÂCHES OUVERTES`; `## VILLAGEOIS DEMANDEUR` (dossier competence).
3. Calls the strong tier with `PROPOSE_TOOL` **forced** (`toolChoice` `propose_task`, R68, `:212`), `kind:'curriculum'`.
4. `propose_task` args (`:85-106`): required `goal`, `successCriteria`; optional `check{item,count}`, `assignee`, `howTo`. If `howTo` is non-empty, `howTo(question)` folds the answer into `Task.context`. `assignee` defaults to the requesting villager.
5. `admit` (`:447-458`) → `state.tasks`, `ledger.open`, journals `god.task-proposed {taskId, goal, trigger, assignee?, parent?}`.

### QA knowledge cache (`howTo`, `:239-262`; `findCached`, `:514-536`)
- Lookup: embed the question; best cosine over cached vectors `≥ 0.92` → hit; else keyword floor `keywordScore ≥ 0.92` or exact string match. A hit costs zero LLM calls.
- Miss: fast-tier free-text call (no tools, no tool_choice), system prompt "Réponds brièvement et concrètement à une question "how to" sur Minecraft…", `kind:'qa'`, spend charged to `curriculum`. Answer + vector appended to `this.qa`.
- **Storage is a private in-memory array** — not persisted to disk/SQLite, lost on restart.

### `decompose(goal)` (`:268-306`)
Strong tier, forced `decompose` tool (`subtasks[]` of `{goal, successCriteria, check?}`); each becomes a Task with `parent = goal`, admitted with trigger `admin`. **No production caller.**

### Ledger transitions
| Method | Effect | Journal |
|---|---|---|
| `addTask(task, trigger='admin')` (`:309`) | admit | `god.task-proposed` |
| `addFollowUp(suggestion, assignee?)` (`:320-335`) | R72 acquire-task; dropped if same normalized goal is open or among last 12 failed | `god.task-proposed` (`trigger:'critic-follow-up'`) |
| `closeTask(task, verdictId?, ok, reason?)` (`:343-363`) | remove from open/tasks, clear pointer + breaker counter, push to completed/failed | `god.task-closed {taskId, goal, outcome, reason?}` |
| `noteExhausted(task, lastCritique?)` (`:378-392`) | R65: 1st exhausted rollout → stays open; 2nd → `closeTask(...,false, "blocked: « goal » not converged after 2 exhausted rollout(s) (R65 breaker — stop grinding, move on) — dernier obstacle: <critique≤240>")` | via closeTask |
| `nextOpenTaskFor(villager)` (`:403-407`) | R70: oldest open task with no live rollout assigned to villager or unassigned (read-only) | — |
| `cleanUpTasks()` (`:414-428`) | Voyager clean-up: drop failed records whose goal later completed | `god.task-closed {outcome:'retired'}` — **no production caller** |

### Curriculum prompt (`prompts/curriculum.md`, 56 lines)
One task at the edge of ability (Voyager); read inventory before proposing acquisition; the mission (scenario instructions) outranks defaults; warm-up survival-basic without a mission; specific and checkable (`check{item,count}`); don't repeat the frontier; decompose big goals, except a deliberate composing skill over existing blocks; tool list `propose_task`/`decompose`; `goal/successCriteria/context` in English. Note: the prompt promises "QA-cache entries" and "village stock levels"-style inputs; the code renders neither cache entries nor stock levels into the proposal context.

## The orchestrator desk (`eden/src/god/orchestrator.ts`)

Sole writer of `state.directivesOpen`.

### `dispatch({task?, event?, trigger})` (`:134-177`)
- Context (`renderDispatchContext`, `:320-329`): `## DÉCLENCHEUR`, `## TÂCHE` (goal/criteria/assignee), `## ÉVÉNEMENT`, `## DIRECTIVES OUVERTES`, instruction "Délègue par défaut; n’interromps qu’en urgence." (no dossiers or current runs, despite the prompt claiming them).
- Fast tier (default), `DIRECTIVE_TOOL`, **`tool_choice` NOT forced** (defaults to `'auto'`), `kind:'orchestrator'`.
- `directive` args (`:67-85`): required `to`, `goal`, `reason`, `priority ∈ {background,normal,interrupt}`; optional `standing:boolean`, `taskRef`. Calls missing `to`/`goal` are skipped; an invalid priority → `normal`. There is **no expiry parameter** — LLM-opened directives never expire.
- Degraded: only `interrupt` directives survive (`:162`).
- `taskRef` is bound to the dispatched `task.id` (authoritative), not the LLM echo (`:165`).
- `DispatchTrigger` (`:94`): `new-task | closed-task | verdict-follow-up | event | idle-sweep | admin`; the coordinator maps curriculum triggers via `dispatchTriggerFor` (`eden/src/main.ts:852-860`: idle→idle-sweep, verdict-close→closed-task, critic-follow-up→verdict-follow-up, dawn→new-task, else admin).

### `openDirective(spec)` — anti-thrash, engine-enforced (`:184-232`)
1. **Interrupt cooldown**: an `interrupt` to the same villager within `interruptCooldownMs` (default `5*60_000`, `:36`) is **downgraded to `normal`** (not dropped). Only a non-downgraded interrupt refreshes the timestamp.
2. **Max 1 open non-standing directive per villager**: every open non-standing directive with the same `to` is removed and journaled `god.directive-closed {reason:'superseded'}`. Standing directives are never superseded and coexist.
3. Push, deliver to `inboxes.get(to)` as `{from:'god', kind:'directive', payload:{directiveId, goal, reason, priority}}`, journal `god.directive {directiveId, to, goal, priority, superseded?}`. Unknown `to` (no inbox) → silently not delivered but still opened.

### Other methods
| Method | Behaviour | Production caller |
|---|---|---|
| `closeDirectivesForTask(taskId, reason)` (`:272`) | close all with matching `taskRef`; journal `god.directive-closed` | coordinator (`completed` / `expired`) |
| `expireStale()` (`:282`) | close directives with `expiresAt <= now` | none |
| `intervene({villager, taskId?, action, args?}, body: DivineActor)` (`:240-250`) | run `body.runAction`, soft-fail, add `taskId` to `divineAssistedTasks`, journal `god.appearance` | none |
| `wasDivinelyAssisted(taskId)` / `clearDivineAssist(taskId)` (`:253-260`) | flag read by the critic / cleared on close | coordinator |
| `reportToGod({villager, text})` (`:263-269`) | append `objection (<ISO>): text` to dossier notes (cap 40) — no journal event | none (the brain collects `reportsToGod` but the coordinator ignores them) |

### Orchestrator prompt (`prompts/orchestrator.md`, 36 lines)
Directives are data ("what and why"; brain decides how); call `directive` once per tasked villager; reserve `interrupt` for emergencies; `standing` for persistent rules; anti-thrash rules described; **"interventions set stages and teach; they NEVER do a villager's task"** — a task met by divine action is voided by the critic.

## "Interventions teach" — what code enforces

- Enforced: the critic's `voidDivineOverreach` rail (`eden/src/god/critic.ts:259-263`) whenever `divineAssisted` is true; the coordinator passes `orchestrator.wasDivinelyAssisted(task.id)` (`eden/src/main.ts:975`) and clears it on every rollout exit.
- Not reachable in production: the flag is only set by `Orchestrator.intervene`, which nothing calls, and `GodBody` does not implement the `DivineActor.runAction` method `intervene` requires. So the rail is tested (`tests/god-critic.test.ts`, `tests/god-orchestrator.test.ts`) but dormant live.
- Note the rail voids **any** success on a flagged task, not only successes "achieved by" the intervention.

## The divine body (`eden/src/god/body.ts`)

- Runner identity: `{name: <god.name>, role:'god', tier:'divine'}` (`eden/src/god/body.ts:38`). Methods `appearNear(villager)`, `vanish()`, `gesture(type)` run the divine stock skills `appear-near`, `vanish`, `gesture` through `SkillEngine.run` (each a journaled `skill.run`), returning `report.outcome.ok`; any throw → `false` (never throws, `:75-83`).
- `deliverVerdict({villager, verdict, rolloutId?})` (`:61-72`): no-op returning `false` if `embodiedVerdicts` is false; else appear-near then gesture `nod` (success) / `swing` (failure); journals `god.appearance {villager, action:'verdict', ok}` (actor `god:body`).
- **Wiring:** `void new GodBody({...})` (`eden/src/main.ts:570`) — the instance is discarded; `deliverVerdict` is never called in production.

Divine stock skills (`eden/src/skills/exemplars/index.ts:821-839`), all implemented as `bot.chat('/…')` commands (need op) except `gesture`/`fly-to`:

| Skill | Args | Implementation |
|---|---|---|
| `appear-near` | `{villager}` | `/tp <self> <villager>` |
| `vanish` | `{x=0,y=200,z=0}` | `/tp <self> x y z` |
| `gesture` | `{type}` | `swing` → `swingArm()`; `jump` → 200 ms jump; **`nod`/`sneak` do nothing** |
| `fly-to` | `{x,y,z}` | `bot.creative.flyTo` |
| `summon-creature` | `{entity,x,y,z,count=1}` | `/summon` ×count |
| `smite` | `{x,y,z}` | `/summon lightning_bolt` |
| `teleport-entity` | `{target,x,y,z}` | `/tp target x y z` |
| `give-items` | `{target,item,count=1}` | `/give` |
| `set-weather` | `{weather}` | `/weather` |

The curriculum hides divine skills from its coverage list (`eden/src/god/curriculum.ts:507`); `VillageLoop` never drives the avatar (`eden/src/main.ts:1039`).

## GodService — verdict routing (`eden/src/god/god.ts`)

`routeVerdict(verdict, {rolloutId, draft:{name,version}, task})` (`:150-208`):
1. Journal `god.verdict {ticketId, success, libraryAction, score, critique}` with refs `{rolloutId, taskId, skill, skillVersion, verdictId}` (actor `god:critic`).
2. Library action on the **current status** of `name@version`:
   - `admit` + `quarantined` → `library.unquarantine` (R37 → active-probation), `admitted=true`.
   - `admit` + `draft` → `library.admit(...,{rolloutId, verdictId})`, `admitted=true`, then optional DescriptionPass (**no `describer` is wired in `eden/src/main.ts:555`, so admission keeps the author's summary**).
   - `admit` on an already active/active-probation version → no-op, `admitted=false`.
   - `quarantine` → `library.quarantine(name, critique, version)`; `archive` → `library.archive`; `keep-draft`/`none` → nothing.
3. Deliver `{from:'god', kind:'critique', payload:{critique, success, praise}}` to the assignee's inbox and update the dossier (per manifest tag `runs/successes`; `recentVerdicts` capped at 20).
4. Push critique to `rollout.critiqueChain`; record the draft version; **close the rollout and the task (completed) only if `admitted && verdict.success`**.

`fileTicket` (`:126-144`) appends to `criticQueue` and journals `god.ticket {source, skill, version}`. `openRollout(taskId)` (`:107-123`) throws if the task is not in `state.tasks`; sets `task.currentRolloutId`; `attempt = prior rollouts for task + 1`.

## Refinement loop (`RolloutCoordinator`, `eden/src/main.ts:866-1025`)

```mermaid
sequenceDiagram
  participant VL as VillageLoop (per villager)
  participant RC as RolloutCoordinator
  participant CU as Curriculum
  participant OR as Orchestrator
  participant IN as Villager Inbox
  participant BR as Brain (villager)
  participant GS as GodService
  participant CR as CriticDesk
  VL->>RC: runOnce({trigger:'idle', villager})
  RC->>CU: nextOpenTaskFor(villager)  (R70 resume)
  alt no resumable task
    RC->>CU: proposeTask({trigger, villager, snapshot})  [strong, forced propose_task]
  end
  RC->>OR: dispatch({task, trigger})  [fast, auto tool_choice]
  OR->>IN: deliver directive (anti-thrash applied)
  RC->>GS: openRollout(task.id)
  RC->>RC: retriever.search(goal,k=10) + memory.retrieve(goal,6)  (once per task)
  loop i < task.maxRetries (4)
    RC->>IN: drain()
    RC->>BR: deliberate(pack{tier:'strong', density}, {rolloutId})  [rollout-immune]
    alt no draft or no RunReport
      Note over RC: continue (attempt consumed)
    else
      RC->>GS: fileTicket(source:'rollout')
      RC->>CR: judge(ctx)  [strong, forced verdict] + rails
      RC->>GS: routeVerdict(verdict) → library action, critique→inbox, dossier
      alt admitted && success
        RC->>OR: closeDirectivesForTask('completed'); clearDivineAssist
        RC-->>VL: {converged:true}
      else verdict.blocked
        RC->>OR: closeDirectivesForTask('expired')
        RC->>CU: closeTask(failed, "blocked-on-resource: ...") + addFollowUp(followUp)
        RC-->>VL: {converged:false, blocked:true}
      else
        Note over RC: keep draft code + RunReport + critique for next density payload
      end
    end
  end
  RC->>OR: closeDirectivesForTask('expired'); clearDivineAssist
  RC->>CU: noteExhausted(task, lastCritique)  (R65: 2nd exhaustion closes failed)
  RC-->>VL: {converged:false}
```

Key facts:
- The villager processed is `task.assignee ?? '(unassigned)'`; the orchestrator LLM's `to` can differ (then the directive lands in another inbox, and the coordinator falls back to `task.goal`/`task.successCriteria` for the pack's directive section, `eden/src/main.ts:950`).
- An iteration where the brain produced no draft **or** no run consumes a retry with no ticket (`:962-965`). A villager that completes the task only by running an existing (non-draft) skill is never judged.
- A `success:true` verdict with any action other than an effective draft admission (e.g. `none`, `keep-draft`, or `admit` of an already-active version) does **not** close the rollout; the loop keeps revising until retries run out.
- Revision deliberations run on the **strong** tier with `inputTokenBudget = strongInputTokenBudget ?? 48000` (from `providers.json`/config, `eden/src/main.ts:611,958`); `hint:'authoring'`, `includeExemplarCode:true`, `history: []`.
- `VillageLoop` pacing (`eden/src/main.ts:1074-1077`): connect poll 2000 ms, settle 3000 ms after first connect, 1000 ms between producing turns, 5000 ms back-off after a no-proposal turn or a thrown rollout. Started on `/villagers start|restart` (admin `onScenarioStart`, `eden/src/main.ts:406-420`), never on `autoSpawn`.

### Density invariant and per-tier budgets (D-11)

- Payload: from the 2nd iteration on, `density = {draft:{name, version, code}, runReport: lastRunReport, critique: lastCritique}` (`eden/src/main.ts:954-956`), rendered by `renderDensity` as a final user message `## TRAVAIL EN COURS (à réviser maintenant)` (`eden/src/villagers/context-pack.ts:297-304`).
- `fitBudget` (`eden/src/villagers/context-pack.ts:150-164`) always keeps the frame (8 sections each capped by `CEILINGS`, `:93-102`) and the density message; only `history` turns are trimmed oldest-first as whole pairs. The coordinator always passes `history: []`, so **prior revision turns are never carried** — each revision sees only the latest draft/report/critique.
- Budget numbers verified: default `strong.inputTokenBudget = 48000`, `fast = 16000` (`eden/src/config.ts:113-114`; `eden/src/providers.ts:25-27`; `providers.example.json` openai/deepseek presets 48000/16000, `local` strong 32000 / fast 16000). Boot warns if `strong.inputTokenBudget < 2*(maxSkillLines*12) + 8000` (= 17 600 at 400 lines) (`eden/src/config.ts:351-361`).
- The budget bounds only the **initial** pack; the brain's multi-turn conversation (up to 16 tool turns, `eden/src/villagers/brain.ts:67`) grows unchecked, and the critic's own prompt is not budgeted.
- Scheduler immunity: `Brain.deliberate` passes `rolloutId` → bypasses rate cap, coalescing and cooldown (`eden/src/villagers/brain.ts:96-107`; lane defaults to `directive`).

### Recovery (D-09)

`GodService.recoverRollouts()` (`eden/src/god/god.ts:218-235`), called at boot when God is wired (`eden/src/main.ts:228-231`): for each task in `state.tasks` with `currentRolloutId`, journal `god.rollout-abandoned {reason:'crash-recovery', taskId}`, close the rollout, delete the pointer, re-add through the ledger writer. Because `GodState` is never persisted and the call runs on a freshly constructed state, **after a real process restart there is nothing to recover** — the ledger, tasks, dossiers and QA cache start empty (journal history remains but is not replayed into God).

### Budget degrade summary (D-13)

`BudgetTracker` (`eden/src/llm/scheduler.ts:227-258`) is shared by the three desks; `spend(desk, totalTokens)` after each call; `degraded(desk)` is `spent > dailyTokens` (strict), never for `null`. `resetDay()` exists but **no production code calls it**, so a cap is effectively per-process-lifetime. On breach with `degradeOnBreach:true`: critic → templated keep-draft verdict; curriculum → repeat last task type; orchestrator → interrupt-only. No journal/warning event is emitted on breach.

## Journal events emitted by God

| Kind | Actor | Emitted by |
|---|---|---|
| `god.ticket` | `god:critic` | `GodService.fileTicket` |
| `god.verdict` | `god:critic` | `GodService.routeVerdict` |
| `god.task-proposed` / `god.task-closed` | `god:curriculum` | `Curriculum.admit` / `closeTask` / `cleanUpTasks` |
| `god.directive` / `god.directive-closed` | `god:orchestrator` | `Orchestrator.openDirective` / close paths |
| `god.appearance` | `god:body` / `god:orchestrator` | `GodBody.deliverVerdict` / `Orchestrator.intervene` |
| `god.rollout-abandoned` | `god` | `GodService.recoverRollouts` |
| `inbox.delivered {to, from, kind}` | `engine` | `VillagerInbox.deliver` (`eden/src/villagers/inbox.ts:22-25`), empty refs |
| `llm.call` | `god:critic` / `god:curriculum` / `god:orchestrator` | `LlmClient` |

Payload types: `eden/src/journal/kinds.ts:141-167`.

## How to extend

- **New desk tool / field:** edit the `*_TOOL` schema and the parse function in the desk file, update the prompt `.md` (golden tests in `tests/god-*.test.ts` read them).
- **New verdict rail:** add it in `CriticDesk.applyRails`; keep it one-directional (can only lower `success`/demote `admit`).
- **New curriculum trigger:** extend `CurriculumTrigger` and `dispatchTriggerFor` (`eden/src/main.ts:852`); nothing branches on the trigger except journaling and the dispatch prompt.
- **Wiring a dormant feature** (body theatrics, intervene, batching, tripwire tickets, dawn reset): all hooks must be added in `wireGod`/`RolloutCoordinator` in `main.ts` — `god/` cannot import peers.

## Gotchas & known issues

- `god.combineDesks` and `god.authoring` are parsed config keys with **no code consumer**.
- `GodBody` is built and discarded (`eden/src/main.ts:570`): `embodiedVerdicts` has no effect; `deliverVerdict`'s `nod` gesture is a no-op skill anyway.
- `Orchestrator.intervene` needs a `DivineActor {runAction}`; `GodBody` has no `runAction` and nothing calls `intervene` — the divine-overreach rail is dormant live.
- `CriticDesk.judgeBatch`, `Curriculum.decompose`, `cleanUpTasks`, `Orchestrator.expireStale`, `reportToGod` have no production callers; `criticQueue` grows forever (never drained).
- ~~No `tripwire` ticket is ever filed~~ **Wired (B3.3):** `main.ts` passes `onTripwire` → `makeTripwireHandler` (B3.3): it files a `tripwire` critic ticket, the critic judges the last failing run against a synthetic "is this skill broken?" task, and `GodService.routeTripwireVerdict` journals `god.verdict` and applies only a `quarantine` (reason `tripwire: <critique>`, actor `god:critic`) — never admit/archive. No `plea`/`second-opinion` tickets yet.
- Brain `report_to_god` texts are returned in `DeliberationResult.reportsToGod` and ignored by the coordinator.
- `BudgetTracker.resetDay()` is never called — "daily" caps never reset.
- QA cache is in-memory only (the code comment and spec say "persisted").
- `GodState` is never persisted; boot recovery is a no-op after a real restart.
- Rollout closes only on `admitted && success`; success with `none`/`keep-draft`, or a success running an already-active skill, keeps revising until `maxRetries`.
- A deliberation with no draft/RunReport silently burns one of the 4 retries.
- Orchestrator dispatch does not force its tool; if the model emits no `directive` call the task still runs (the pack falls back to `task.goal`).
- Directive `priority:'interrupt'` does not preempt a running skill on the coordinator path (no `interrupt` flag reaches `SkillEngine.run`).
- The voidDivineOverreach rail voids every success on a flagged task, not just intervention-caused ones.
- The critic's `## STATS` section is never populated (coordinator doesn't pass `stats`).

## Related

- [llm-and-scheduling.md](llm-and-scheduling.md) — client, scheduler lanes/immunity, budgets, embeddings
- [social-and-trade.md](social-and-trade.md)
- [villager-runtime.md](villager-runtime.md) — brain, context pack, tools
- [skills-library.md](skills-library.md) — admit/quarantine/probation state machine
- [skills-engine.md](skills-engine.md) — `SkillEngine.run`, tripwire, tiers
- [stock-skills.md](stock-skills.md) — divine and mortal stock skills
- [journal-and-views.md](journal-and-views.md) — `god.*` events, RolloutsView
- [process-config-and-boot.md](process-config-and-boot.md) — `eden.json`, scenarios, boot steps
- [admin-api.md](admin-api.md) — `/tasks`, `/verdicts`, `/directives`, pause/resume
