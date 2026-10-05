---
id: eden.skills.engine
title: Eden skill engine — compile, supervise, compose, report
system: eden
summary: Exactly how Eden executes a skill: parse/instrument/compile, loop budget and macrotask canary, the process shim, the full ctx surface, composition rules, timeouts, stall pulses, abort, tiers and RunReport.
tags: [eden, skills, engine, instrumentation, acorn, loop-budget, stall, timeout, abort, composition, ctx, runreport, tier]
sources: [eden/src/skills/engine.ts, eden/src/skills/instrument.ts, eden/src/skills/library.ts, eden/src/bots/hardening.ts, eden/src/types/skill.ts, eden/src/types/bot.ts, eden/src/types/enums.ts, eden/src/render/run-report.ts, eden/src/villagers/tools.ts, eden/src/config.ts, eden/src/main.ts, eden/tests/skills-engine.test.ts, eden/tests/skills-instrument.test.ts, docs/02-skill-system.md, docs/07-hard-won-lessons.md]
verified_at: 4a8081f
---

# Eden skill engine — compile, supervise, compose, report

**TL;DR.** `SkillEngine` (`eden/src/skills/engine.ts`) is the only executor of skill code. A skill is the
source of **one JS function expression** `async (bot, args, ctx)`; it is acorn-parsed, every loop body gets
`__loopBudget();` and every `await X` becomes `await __aw(X)`, then it is wrapped in `new Function` with a
shimmed scope (`process`, `require`, `sleep`, `Vec3`, `GoalNear`). Each run is serialized per bot,
supervised by a wall clock (default 120 s, max 2 h), a 20 s no-pulse stall detector and an 8 s
macrotask-starvation canary, and always ends in a `RunReport` journaled as `skill.run`.

## Compilation pipeline

`eden/src/skills/instrument.ts`. Compiled once per `name@version` and cached forever in
`SkillEngine.factories` (`eden/src/skills/engine.ts:219-227`).

| Step | Function | Exact behaviour |
|---|---|---|
| 1. Parse | `parse(code)` (`eden/src/skills/instrument.ts:83-98`) | `acorn.parse(code, {ecmaVersion: 2022, sourceType: 'script'})`. On failure retries as `(` + code + `)` (so anonymous `async function(){}` / arrows parse), recording `offset = 1`. If both fail, returns `{ok:false, error: 'parse error: <direct error message>'}` — never throws. No banned identifiers, no import scan (D-04/P3). |
| 2. Instrument | `instrument(code)` (`eden/src/skills/instrument.ts:127-164`) | Walks the AST (`acorn-walk` simple). For every `WhileStatement`, `DoWhileStatement`, `ForStatement`, `ForInStatement`, `ForOfStatement` (incl. `for await`): if the body is a block, inserts `__loopBudget();` right after `{`; otherwise wraps the statement as `{__loopBudget();<stmt>}`. For every `AwaitExpression`: rewrites `await X` → `await __aw(X)`. Edits are string splices applied right-to-left by offset (minus the wrap offset). |
| 3. Compile | `compile(code)` (`eden/src/skills/instrument.ts:200-214`) | `new Function('__shim', '"use strict";\nconst { process, require, sleep, __loopBudget, __aw, Vec3, GoalNear } = __shim;\nreturn (' + instrumented + ');')`. A `SyntaxError` here returns `{ok:false, error:'compile error: …'}`. |
| 4. Bind | `factory(makeShim(runtime, sharedBudget))` (`eden/src/skills/instrument.ts:273-285`) | Fresh shim per call frame; returns the skill function. |

Because the source is spliced into `return ( … );`, **the code must be exactly one function expression**:
a named `async function f(bot,args,ctx){…}`, an anonymous function, or an arrow. Two top-level
declarations, a leading `const`, or a trailing `;` parse fine in step 1 but fail in step 3 with
`compile error: …`. Helpers must be declared *inside* the function body (this is why the stock skills
inline `itemId`/`safeCloseStray` text — `eden/src/skills/exemplars/index.ts:36-71`).
`write_skill` runs `compile` up front so these errors return to the author immediately
(`eden/src/villagers/tools.ts:233-234`). Strict mode applies to the skill body.

## Scope globals (the shim)

What a skill body sees besides normal JS globals (`setTimeout`, `Promise`, `Math`, `globalThis`, …):

| Name | Value | Source |
|---|---|---|
| `process` | frozen safe object: `exit`, `reallyExit`, `abort`, `kill` throw `SkillForbiddenError("process.<m>() is forbidden in skill code (D-08) — let the run end and report failure instead")`; plus `platform`, `version` copied from the host | `eden/src/skills/instrument.ts:216-230` |
| `require` | `require('process')` / `require('node:process')` → the safe process; **any other specifier → `undefined`** | `eden/src/skills/instrument.ts:232-239` |
| `sleep(ms)` | engine-provided delay that **pulses** the stall detector (see below) | `eden/src/skills/engine.ts:302-312` |
| `Vec3` | the real `vec3` constructor (same instance as `ctx.Vec3`) | `eden/src/skills/instrument.ts:17, 282` |
| `GoalNear` | `mineflayer-pathfinder` `goals.GoalNear` (same as `ctx.goals.GoalNear`) | `eden/src/skills/instrument.ts:18-27, 283` |
| `__loopBudget`, `__aw` | instrumentation hooks (do not call directly) | `eden/src/skills/instrument.ts:253-267` |

`DENIED_PROCESS_METHODS = ['exit','reallyExit','abort','kill']` is frozen at four (R45). This is
footgun removal, **not a sandbox**: `globalThis.process`, the `Function` constructor, etc. stay reachable by
design (`eden/src/skills/instrument.ts:5-9`). The real security boundary is the tier gate (R25).

## Loop budget and the macrotask-starvation canary

**Loop budget** (`createLoopBudget`, `eden/src/skills/instrument.ts:253-267`): a counter incremented by every
`__loopBudget()` call and reset to 0 by every `__aw(...)` (i.e. each time an `await` is reached).
Above `DEFAULT_LOOP_BUDGET = 1_000_000` it throws `SkillStalledError('loop budget')`. The engine never
overrides the max (`createLoopBudget(undefined, …)`, `eden/src/skills/engine.ts:282`). One budget object is shared by the
whole call tree (every frame's shim gets the same `budget`, `eden/src/skills/engine.ts:344, 362`).

A budget trip is an ordinary throw: outcome `{ok:false, error:'loop budget', errorKind:'SkillStalledError'}`,
`aborted` undefined, and the abort protocol does **not** run (`eden/src/skills/engine.ts:375-378`; test
`eden/tests/skills-engine.test.ts:100`).

**Macrotask canary (gap W)** (`eden/src/skills/engine.ts:41-48, 276-287`): a loop that awaits already-resolved promises
resets the budget each iteration but never yields to the macrotask queue, so every timer (wall clock,
stall detector) is starved. The engine therefore:

- runs a `setInterval` heartbeat every `max(10, min(100, floor(macrotaskStallMs/4)))` ms (= **100 ms** in
  production) that sets `lastTick = now()`;
- passes a synchronous `checkProgress` into the loop budget; on every loop tick, if
  `now() - lastTick > macrotaskStallMs` (**8000 ms** default, `DEFAULT_MACROTASK_STALL_MS`; option
  `macrotaskStallMs` is test-only) it calls `triggerAbort('stalled')` and throws `EngineAbort('stalled')`
  from inside the loop.

Result: `aborted: 'stalled'`, abort protocol runs (test `eden/tests/skills-engine.test.ts:110`). A loop awaiting a real
`setTimeout` is never canary-aborted (`:122`). The canary only lives inside instrumented **loops** —
microtask spinning via async recursion (no loop) is not covered.

## The `ctx` surface (complete)

`SkillContext` (`eden/src/skills/engine.ts:427-456`), built per frame by `makeCtx(depth)` (`eden/src/skills/engine.ts:314-333`):

| Property | Type | Semantics |
|---|---|---|
| `ctx.skills.run(name, args)` | `<T>(string, object) => Promise<T>` | Compose another skill (rules below). Resolves to the callee's return value; throws on any gate/validation error or callee throw. |
| `ctx.log(message)` | `(string) => void` | **Pulses** the stall detector and journals `skill.log {skill: <ROOT skill name>, message}` with refs `{runId, rolloutId, skill}`; actor `god:body` (divine runner) or `villager:<name>`. Never use `console`. |
| `ctx.signal` | `AbortSignal` | Aborted when the tree is aborted (timeout / stall / preempt / canary). The engine does not kill running code — long loops should check `ctx.signal.aborted`. |
| `ctx.runner` | `{name, role, tier}` (`RunnerRef`) | Who is running the tree (villager = `mortal`, avatar = `divine`). |
| `ctx.depth` | number | 0 for the root, +1 per composition level. |
| `ctx.Vec3` | `vec3` constructor | Use for `bot.blockAt` / `placeBlock` / `creative.flyTo` — real mineflayer calls `.floored()` and rejects plain `{x,y,z}` (Blocker Z). |
| `ctx.goals` | `mineflayer-pathfinder` `goals` module | `new ctx.goals.GoalNear(x,y,z,range)` (also `GoalBlock`, etc.). A plain object goal makes pathfinder throw asynchronously from the physics tick (host-crashing). |
| `ctx.mcData` | `bot.registry` (`ItemRegistry`) or `undefined` | prismarine-registry: `itemsByName[...]`, `blocksByName[...]` (Blocker D1 / R62). Undefined only on a not-yet-spawned bot. |

There is **no `ctx.sleep`** — `sleep` is a scope global. `bot` is the raw mineflayer bot (no wrapper,
owner #11). `args` is the validated args object.

## `engine.run` — entry and pre-execution gates

`SkillEngine.run(name, args, runner, opts)` (`eden/src/skills/engine.ts:171-185`). `RunOptions` (`eden/src/skills/engine.ts:106-113`):
`version?` (explicit version, used for draft trials), `timeoutMs?`, `rolloutId?`, `interrupt?`,
`validateReturn?`.

Checks, in order — each **throws** (no RunReport, nothing journaled; the tool layer turns it into an
`Erreur run_skill "<n>": …` string, `eden/src/villagers/tools.ts:265-267`):

| # | Check | Error |
|---|---|---|
| 1 | resolve: `opts.version` given → `library.read(name, version)` (**any status**); else `library.readRunnable(name)` (live version) | `SkillNotFoundError`: `skill "<n>" not found (no active/active-probation version)` |
| 2 | tier: skill `divine` and runner `mortal` | `TierGateError`: `skill "<n>" is divine — a mortal runner cannot run or compose it (R25)` |
| 3 | `grants.canRun(runner.name, name)` | `GrantError`: `grant denied: <villager> may not run "<n>"` |
| 4 | `validateArgs(args, manifest.params, name)` | `ArgValidationError` (messages below) |
| 5 | `resolveBot(runner.name)` (main wires `pool.bot(name)`, `eden/src/main.ts:528`) | `Error: run "<n>": no bot for runner <r> (disconnected/dead?)` |

Then the tree is enqueued on the runner's `BotRunQueue`.

## Serialized execution per bot (D-05) and preemption

`BotRunQueue` (`eden/src/skills/engine.ts:459-482`), one per runner name: runs are chained on a promise tail, so **one
skill tree per bot at a time**; a queued run waits for the previous one regardless of its outcome.
`opts.interrupt === true` calls the *current* tree's abort with cause `preempted` before queueing (R9) —
already-queued runs are not cancelled. The engine also tracks root skill names per runner
(`runningSkills(runner)`, `eden/src/skills/engine.ts:201-217`) for the `notWhileRunning` subscription filter and the
context pack (`eden/src/main.ts:653, 682`).

## `executeTree` — the run sequence

`eden/src/skills/engine.ts:229-423`:

1. `runId = ulid()`, `startedAt`, `worldBefore = captureSnapshot(bot)`.
2. Create the tree `AbortController`; `triggerAbort(cause)` records the **first** cause only and aborts
   `ctx.signal`. A preempt signal from the queue maps to `preempted`.
3. Start the **StallDetector** (`stallSeconds*1000`), subscribe built-in pulse sources, start the
   **wall-clock** timer, the canary heartbeat and the shared loop budget.
4. If runner is `divine` **and** root skill is `mortal`, install the chat interceptor (R25, see Tiers).
5. Push the root name onto `running`; compile + bind the root; `Promise.race([fn(bot,args,ctx0), abortPromise])`.
6. Success → optional `validateReturn` (draft trials only) → `outcome = {ok:true, value}`.
7. Catch: `EngineAbort` → `await abortActiveTasks(bot)` then `{ok:false, error: abortMessage(cause), errorKind: cause}`;
   any other throw → `{ok:false, error: err.message, errorKind: err.name}`.
8. Finally: clear timers/heartbeat, disarm detector, remove pulse listeners, remove interceptor, pop `running`.
9. `worldAfter = captureSnapshot(bot)`; build the `RunReport`; journal `skill.run` (refs `runId,
   rolloutId, skill, skillVersion`).
10. Tripwire `recordRun(root, ok)` → `onTripwire` (unwired in main).
11. If the root version's status was `active-probation`: `library.recordProbationRun(name, ok)` (R57).

## Supervisors

| Supervisor | Value | Fires as | Code |
|---|---|---|---|
| Wall clock | `min(max(opts.timeoutMs ?? runDefaultTimeoutMs, 1), 7_200_000)`; default `120000` ms (`eden/src/config.ts:120`); `run_skill` exposes `timeoutMs` | `aborted:'timeout'`, error `wall-clock timeout (run exceeded its time budget)` | `eden/src/skills/engine.ts:40, 266-268` |
| Stall detector | no pulse for `stallSeconds` (default **20**, `eden/src/config.ts:121`); restarted by every pulse | `aborted:'stalled'`, error `no progress (stall detector: no pulse within stallSeconds)` | `eden/src/skills/engine.ts:485-512` |
| Macrotask canary | `> 8000` ms without a macrotask heartbeat, checked inside loop bodies | `aborted:'stalled'` | `eden/src/skills/engine.ts:276-287` |
| Loop budget | `> 1_000_000` loop ticks without an `await` | plain throw `SkillStalledError: loop budget` | `eden/src/skills/instrument.ts:253-267` |
| Preemption | `interrupt:true` on a later run | `aborted:'preempted'`, error `preempted (an interrupt directive took the bot — benign, R9)` | `eden/src/skills/engine.ts:463-481, 609-618` |

All timers are `unref`'d.

### Pulse sources (D-10 / R26 / R46)

A pulse is a discrete event that restarts the stall timer and increments `RunReport.pulses`.

| Source | Detail | Code |
|---|---|---|
| Bot events | `path_update`, `path_reset`, `goal_reached`, `goal_updated`, `path_stop`, `diggingStarted`, `diggingCompleted`, `windowOpen`, `windowClose` | `eden/src/skills/engine.ts:534-544` |
| Position sampler | every `max(50, min(500, floor(stallMs/2)))` ms (= 500 ms at 20 s): pulse if `"x,y,z"` string of `bot.entity.position` changed | `eden/src/skills/engine.ts:553-567` |
| Inventory sampler | same interval: pulse if the **sum of item counts** changed | `eden/src/skills/engine.ts:562-566, 579-585` |
| `ctx.log(...)` | each call | `eden/src/skills/engine.ts:316-317` |
| `sleep(ms)` | one pulse at start, then every `max(50, min(stallMs/2, ms))` ms until done | `eden/src/skills/engine.ts:302-312` |

There is no block-place event source (docs/02 lists "dig/place"). A raw `await new Promise(r => setTimeout(r, n))`
does **not** pulse; use `sleep` or `ctx.log` in long polls.

## Abort protocol

On every `EngineAbort` exit (timeout, stall, canary, preempt) the engine awaits
`abortActiveTasks(bot)` (`eden/src/bots/hardening.ts:33-58`) — R4/R5, each step independently try/caught:

1. `bot.collectBlock.cancelTask?.()`; empty `bot.collectBlock.targets`.
2. `await bot.pvp.stop()`.
3. `bot.pathfinder.stop()` **then** `bot.pathfinder.setGoal(null)` (order matters, R4).
4. `bot.closeWindow(bot.currentWindow)` if one is open.
5. `await setImmediate` — one macrotask so plugin handlers settle.

It does **not** run for ordinary throws or a loop-budget trip.

## Composition — `ctx.skills.run`

`composerRun(calleeName, calleeArgs, depth)` (`eden/src/skills/engine.ts:335-357`), checks in order:

| # | Rule | Error |
|---|---|---|
| 1 | `depth > maxCallDepth` (default **8**; root is depth 0, first callee depth 1) | `composition depth cap 8 exceeded calling "<n>"` |
| 2 | callee name already on the current call chain | `composition cycle: a → b → a` |
| 3 | callee has a live version (`readRunnable`) | `SkillNotFoundError` |
| 4 | divine callee with mortal runner | `TierGateError` |
| 5 | `grants.canRun` | `GrantError` |
| 6 | callee live version is `active-probation` | `ProbationError: skill "<n>" is in probation — runnable directly, but not composable until it graduates (D-12)` |
| 7 | `validateArgs(calleeArgs, callee.params)` | `ArgValidationError` |

Then the callee is compiled/bound with the **same** loop budget and `sleep`, run with `makeCtx(depth)`,
and a `CallFrame {skill, version, ok, ms}` is pushed to `callTree` when the frame finishes
(`eden/src/skills/engine.ts:353-356`) — so `callTree` is in **completion order** and never contains the root.
`deepestDepth` tracks the maximum callee depth. These errors throw *inside* the caller's code, which can
catch them. Callees always resolve their **live** version (never a draft), and `validateReturn` is not
applied to callees.

## Argument / return validation (D-04)

`validateArgs` (`eden/src/skills/engine.ts:656-675`) — shallow, top-level only:

- Skipped entirely unless `params.type === 'object'`.
- args must be a non-null, non-array object → `<skill>: args must be an object`.
- every `required` key must be present (`in`) → `<skill>: missing required arg "<k>"`.
- for each declared property **present** in args with a string `type`: `number` (not NaN), `integer`,
  `string`, `boolean`, `array`, `object` (non-array) → `<skill>: <k>: expected <type>, got <typeof|null>`.
  Unknown/absent types pass. A key present with value `undefined` fails a typed property.

`validateReturn` (`eden/src/skills/engine.ts:678-683`): only when `opts.validateReturn` (draft trials via `run_skill`);
checks the top-level `returns.type` → `<skill>: return: expected <t>, got <…>`; failure becomes an
`ok:false` outcome with `errorKind:'ArgValidationError'`.

## Tier enforcement (owner #13, R25)

- **Engine gate (hard):** a `mortal` runner can neither run (`eden/src/skills/engine.ts:174`) nor compose (`:340`) a
  `divine` skill. Divine runners may run/compose both tiers. The pool makes villagers `mortal` and only the
  avatar `divine` (see [bots-and-hardening.md](bots-and-hardening.md)).
- **Retrieval:** divine skills are invisible to mortal searches ([skills-library.md](skills-library.md#retrieval-skillretrieversearch)).
- **Chat interceptor (second layer):** when a `divine` runner runs a `mortal` **root** skill, `bot.chat` is
  replaced for the run with a version that silently drops any message matching `/^\s*\//`
  (`eden/src/bots/hardening.ts:135-144`, installed at `eden/src/skills/engine.ts:292-293`, removed in `finally`).
- Villager `write_skill` cannot set `tier`, so authored skills are always mortal.

## `RunReport`

`eden/src/types/skill.ts:85-101`, built at `eden/src/skills/engine.ts:389-405`:

| Field | Value |
|---|---|
| `runId` | ulid |
| `rolloutId?` | `opts.rolloutId` |
| `skill`, `version` | root skill name + version that ran |
| `villager` | `runner.name` (also for the avatar) |
| `args` | root args |
| `outcome` | `{ok:true, value?}` or `{ok:false, error, errorKind?}` — `errorKind` = abort cause (`stalled`/`timeout`/`preempted`) or the thrown error's `name` (`Error`, `TypeError`, `SkillStalledError`, `SkillForbiddenError`, `ArgValidationError`, `ProbationError`, …) |
| `aborted?` | `'preempted' \| 'stalled' \| 'timeout'` or undefined (`eden/src/types/enums.ts:22-23`) |
| `startedAt`, `durationMs` | ms |
| `pulses` | total pulses observed |
| `deepestDepth` | max composition depth reached (0 = no composition) |
| `callTree` | `CallFrame[]` of callees, completion order |
| `worldBefore`, `worldAfter` | `Snapshot` from `captureSnapshot` |

`captureSnapshot` (`eden/src/skills/engine.ts:587-607`) fills only `position` (raw floats; `[0,0,0]` without an entity),
`health` (`bot.health ?? 20`), `hunger` (`bot.food ?? 20`) and `inventory`; `biome` is always `'unknown'`,
`time` `0`, and `equipment`/`nearbyEntities`/`nearbyBlocks`/`knownChests` are always empty.
The critic sees it through `renderRunReport` (see [bots-and-hardening.md](bots-and-hardening.md#render-layer)).

**Outcome semantics:** `ok:true` means "the function resolved", not "the goal was achieved". A skill that
returns `{ok:false, error}` is still an `ok:true` run whose `value` carries the failure (R64 doctrine asks
authors to verify world effects; judging is the critic's job).

## Gotchas & known issues

- **Aborted code keeps running.** `Promise.race` returns as soon as the abort fires, the abort protocol stops
  the plugins, and the next queued tree may start — but the skill's own async code is not cancelled. Unless
  it checks `ctx.signal`, it can keep issuing bot calls concurrently with the next run (D-05 is only
  enforced at the queue level).
- **Callee frames are not raced** against the abort promise; only the root is.
- **`ctx.log` always attributes to the root skill**, even when called from a composed callee.
- **The chat interceptor follows the root tier**: an avatar running a mortal root that composes a divine
  callee (allowed — divine runner) will have that callee's `/tp`, `/summon`… silently dropped.
- **Pre-execution errors are invisible to the journal** (no `skill.run`); only the tool result shows them.
- **`opts.version` bypasses status**: `engine.run(name, args, runner, {version})` executes drafts,
  quarantined or archived versions; the "drafts only in their own rollout" rule lives in `run_skill`
  (`eden/src/villagers/tools.ts:253`), not the engine.
- **Snapshots are thin** (see above) — the critic's world delta is limited to position/health/food/inventory.
- **Compile cache is never evicted** (`factories` keyed `name@version`).
- **Single function expression only** (see Compilation pipeline); a trailing `;` is a compile error.
- Inventory pulse uses total item count, so a craft that consumes and produces the same total, or an equip
  swap, does not pulse.
- `onTripwire` is not passed by `eden/src/main.ts` — the `autoQuarantineAfter` streak has no runtime effect.
- Arg validation is shallow: nested objects/array items are not checked.

## Related

- [skills-library.md](skills-library.md) — versions, statuses, retrieval, `write_skill`
- [stock-skills.md](stock-skills.md) — the bundled skills written against this ctx
- [bots-and-hardening.md](bots-and-hardening.md) — abort sequence, chat interceptor, plugins, render
- [god.md](god.md) — the critic that reads `RunReport`s
- [villager-runtime.md](villager-runtime.md) — `run_skill` and subscription-fired runs
- [journal-and-views.md](journal-and-views.md) — `skill.run` / `skill.log` and stat folds
