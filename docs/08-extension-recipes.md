# 08 — Keeping Eden simple: the dependency law, anti-blow-up rules, extension recipes

This doc exists because v1 didn't blow up from one bad decision — it blew up from
fifty reasonable patches with nowhere clean to land. Eden's defense is structural:
a dependency law that CI enforces, ten simplicity rules every change must satisfy,
and **recipes** that make the common additions mechanical (a registry row and a
handler, never a new branch in a god-class).

## Why v1 became unmaintainable — the named failure modes

Design against these specifically; when reviewing a Eden PR, check it against this
list:

1. **Policy woven through code paths.** "When does a bot think?" was answered
   partly in the reflex engine, partly in the scheduler, partly in the day
   planner, partly in bot-host. No single place to read or change the policy.
   *Eden answer: policy is data (subscriptions, directives, tasks); the engine
   only executes it (P5).*
2. **Implicit lockstep contracts.** `API_DTS` (the published types) and
   `buildScriptGlobals` (the runtime object) had to be updated in tandem or the
   typechecker blessed code that exploded. *Eden answer: one source of truth per
   contract — signatures render FROM schemas; registries generate both the
   runtime dispatch and the docs.*
3. **Patch accretion instead of judgment.** Every behavioral bug grew a bespoke
   mechanism: suppression memos, benign-preemption regexes, `refuteBlockedBeliefs`,
   futility tallies. Each one correct; together, an unauditable thicket of
   special cases. *Eden answer: code captures the SIGNAL (RunReport fields),
   God's critic applies the POLICY. See S9.*
4. **Two sources of truth.** Cached MCP tool catalogues vs. live ones;
   `markManifested` vs. actual avatar state. Every divergence was a debugging
   session. *Eden answer: journal facts + derived views, rebuildable by replay
   ([05](05-observability.md#derived-state-not-duplicate-state)).*
5. **Cross-process choreography.** Bridge HTTP hops, port collisions, silent
   404s, double logins. *Eden answer: D-01, one process.*
6. **Unvalidated config.** Silent typos cost days (R22). *Eden answer:
   validate, warn, alias.*

## The dependency law

Modules import strictly downward; CI enforces it with `dependency-cruiser`
(violations fail the build, no exceptions without a decision record):

```
            ┌────────────────────────────────────────────┐
            │  admin/   (imports anything, never imported)│
            └────────────────────────────────────────────┘
   ┌─────────────┐   ┌─────────────┐   ┌──────────────┐
   │ god/        │   │ villagers/  │   │ social/      │     layer 3: actors
   └──────┬──────┘   └──────┬──────┘   └──────┬───────┘
          ▼                 ▼                 ▼
   ┌─────────────────────────────────────────────────┐
   │ skills/          llm/                           │     layer 2: engines
   └──────┬──────────────────────────────────────────┘
          ▼
   ┌─────────────────────────────────────────────────┐
   │ bots/            journal/         config.ts     │     layer 1: substrate
   └─────────────────────────────────────────────────┘
          ▼
   ┌─────────────────────────────────────────────────┐
   │ types/  (shared interfaces only — zero logic)   │     layer 0
   └─────────────────────────────────────────────────┘
```

- **`journal/` imports nothing but `types/`.** Everything else may import journal.
  If the journal ever needs to know about skills, the design is wrong.
- **Layer 3 modules never import each other.** God doesn't import villagers;
  villagers don't import god. They communicate through layer-1/2 objects
  (inboxes, the library, the journal, the scheduler) passed in at composition
  time (`main.ts` wires everything — the only file allowed to import everything).
- **No module imports `admin/`.** The admin server is a pure consumer; deleting
  it must not break anything.
- **`main.ts` is the only composition root.** No singletons, no module-level
  mutable state, no `import { theScheduler }` — dependencies arrive as
  constructor args. (Not a DI framework — see S5 — just functions taking
  arguments.)

## The simplicity rules (S1–S10)

**S1 — Additions are registry rows, not branches.** Event types, journal kinds,
tools, exemplar skills, config keys, admin routes: each lives in exactly one
registry (a typed map/enum + handler), and adding one never edits a dispatch
`switch` by hand — exhaustiveness checks (`satisfies Record<Kind, Handler>`)
make the compiler enforce completeness. If your change adds an `if` to an
existing function instead of a row to a registry, stop.

**S2 — One writer per state.** Every table/file/in-memory store has exactly one
module that writes it (documented in the module header). Everyone else reads or
sends a message to the writer. (Curriculum writes the ledger; the engine writes
run reports; the library writes skill state.)

**S3 — Rule of two.** No abstraction until the second concrete consumer exists.
The first implementation is allowed to be plain and a little repetitive; the
second earns the helper. Speculative interfaces ("we might want pluggable X")
are the seed of v1's thicket — `GrantPolicy` is the *deliberate* exception, paid
for by an owner decision.

**S4 — Complexity budget.** A module stays under ~300 lines as a rule of thumb
(not a hard gate) or splits along a noun. A PR touching more than 3 modules means
the change is fighting the architecture: stop, re-read [01](01-architecture.md),
and either reshape the change or write a decision record for the reshape of the
architecture.

**S5 — Banned machinery.** DI containers, plugin/loader systems, event-sourcing
replay for live state (rebuilding *derived* views by replay is fine and expected —
see [05](05-observability.md#derived-state-not-duplicate-state); the ban is on
sourcing *live* state from the event log), dynamic `import()` of behavior,
Proxy/metaprogramming,
message queues between in-process modules, ORMs. Each is a complexity loan Eden
never needs at 11 bots. (Worker threads are the one sanctioned escape hatch,
pre-approved in [02 §Power ceiling](02-skill-system.md#the-power-ceiling-full-mineflayer).)

**S6 — LLM-facing text lives in dedicated files.** Prompts in `god/prompts/` and
villager prompt builders; tool schemas in the tool registries; NEVER inline
strings in logic. Every prompt builder gets a **golden snapshot test** (fixed
fake inputs → committed expected output) so prompt drift shows up in diffs, not
in production behavior.

**S7 — Config is validated, warned, and aliased.** Unknown keys warn loudly
(R22); common aliases are adopted; every key appears in `eden.example.json` with
a comment. A config key that nothing reads is deleted, not kept "for later."

**S8 — The doc-drift law.** Behavior changes and `docs/` changes land in the same
commit. New pitfall → next R-number in [07](07-hard-won-lessons.md). New settled
choice → next D-number in the relevant doc. The PR checklist has exactly these
two boxes.

**S9 — Special cases feed the judge.** When a behavioral bug tempts you toward a
bespoke heuristic (a counter, a suppression memo, a regex on error text), first
ask: *can this be a field on RunReport / the journal that God's critic or
curriculum reads?* Code the **signal**; let the LLM apply the **policy**. Only
when the cost of waiting for a verdict is unacceptable (a tight loop melting the
server) does a dumb engine tripwire get added — and it files a critic ticket
anyway ([02 §Library](02-skill-system.md#the-library) shows the pattern).

**S10 — Errors carry evidence.** Every thrown error and every log line names its
subject and parameters (`deposit(oak_log x12) FAILED after 4ms: no chest at
(122,64,-40)`). v1's act-label-and-duration discipline made the debugging
playbook possible (07 §Reading failures); Eden keeps it everywhere.

## Extension recipes

The mechanical procedures for the additions Eden will actually see. Each lists
the exact files touched — if you find yourself outside the list, see S4.

### Add a normalized event type
1. `types/` — add the variant to `EdenEvent`.
2. `villagers/events.ts` — add the emitter (one function, hysteresis inside if
   edge-style).
3. `journal/kinds.ts` — nothing (events journal via `subscription.fired`).
4. Tests: emitter unit test with FakeBot; one subscription-matching test.
5. Docs: the event table in [04 §Events](04-villager-runtime.md#the-event-system).
**Don't:** add per-event logic anywhere else — subscriptions decide what happens.

### Add a journal kind
1. `journal/kinds.ts` — kind + payload type (the registry row).
2. The ONE writer module emits it (S2).
3. Tests: payload schema round-trip.
4. Docs: the kind table in [05](05-observability.md#kind-registry-initial).
**Don't:** reuse an existing kind with a "subtype" field — that's a branch in
disguise.

### Add a villager tool
1. `villagers/tools.ts` — schema + handler in the registry.
2. `villagers/context-pack.ts` — only if the tool needs new context (rare).
3. Tests: dispatcher test (ScriptedLLM calls it); golden prompt snapshot updates.
4. Docs: toolset table in [04 §Brain](04-villager-runtime.md#the-brain).
**Don't:** add a tool that duplicates what a library skill should be — tools are
for *cognition* (read, write, search, subscribe, report); world effects go
through `run_skill`.

### Add an exemplar (stock) skill
1. `skills/exemplars/<name>.js` + manifest. Mortal unless divine is justified.
2. Must compose existing exemplars where possible; must satisfy the relevant
   R-rules (R1–R10) — this is reviewed line-by-line, exemplars teach by example.
3. Tests: FakeBot run test; if it touches crafting/pathfinding, the relevant
   hardening assertions.
4. Docs: exemplar list in [02](02-skill-system.md) (+ divine list if divine).
**Don't:** exceed ~60 lines as a rule of thumb — exemplars are teaching material first.

### Add a divine power
1. New divine exemplar (recipe above, `tier: 'divine'`).
2. Confirm the engine tier gate covers the new surface (it should already — the
   gate is on the runner, not the power).
3. Docs: divine exemplar list in [02 §Tiers](02-skill-system.md#tiers-mortal-and-divine);
   intervention doctrine in [03](03-god.md#the-orchestrator-desk) if God's
   prompts should know about it.
**Don't:** add engine special-cases per power; "divine" is one boundary, not N.

### Add a subscription filter clause
1. `types/` — extend `Filter`.
2. `villagers/subscriptions.ts` — one evaluator function in the clause registry.
3. Tests: matching matrix test.
4. Docs: filter type in [04 §Events](04-villager-runtime.md#the-event-system).
**Don't:** accept code/predicates in filters — declarative only (P5).

### Change God desk behavior
1. `god/prompts/<desk>.md` — the prompt is the behavior; edit it there.
2. `god/<desk>.ts` only if the *contract* changes (new tool, new ticket field) —
   then also `types/` + journal kind if the output shape changed.
3. Tests: golden prompt snapshot; ScriptedLLM verdict-routing test.
4. Docs: the desk's section in [03](03-god.md).
**Don't:** encode judgment policy in TypeScript (S9) — thresholds and tone live
in the prompt; the code routes structured outputs.

### Add a config key
1. `config.ts` — schema + default + validation.
2. `eden.example.json` — key + comment.
3. Exactly one consumer reads it via the typed config object.
4. Docs: config sketch in [01](01-architecture.md#configuration-sketch-edenjson)
   if it's load-bearing.

### Add an admin route
1. `admin/server.ts` — route in the route table, reading journal/derived views
   only.
2. Docs: route table in [05](05-observability.md#admin-api-v0-ships-with-m0m7).
**Don't:** let a route mutate anything except the sanctioned verbs
(pause/resume/quarantine/wipe/prompt — the last injects an `inbox` event rather
than touching state), each journaled as `actor: 'admin'`.

### Add a persistence table (derived view)
1. Define the fold: which journal kinds produce it.
2. Implement in the owning module + register in `eden rebuild-stats`.
3. Tests: replay test — journal fixture in, table out.
**Don't:** write to a derived table from anywhere but its fold (S2); don't store
facts there that aren't in the journal (P4).

## Scaling escape hatches — pre-decided, so nobody panics later

In order of likely need; each is a contained change because of the law above:

1. **A skill tree melts the event loop** → move villager skill execution into
   `worker_threads` (one bot per worker). Bounded change: `bots/pool.ts` +
   `skills/engine.ts`; the journal/library/God are unaffected.
2. **The website outgrows localhost** → token auth flag + split `admin/` into
   its own process consuming the WS stream (it imports nothing upward, so it
   detaches cleanly).
3. **Journal grows huge** → monthly SQLite files + an attach-and-union query
   helper; derived views already rebuild by replay.
4. **LLM costs spike** → desk/villager model tiers are already config; the
   scheduler's budget caps are already enforced ([03 §Cost control](03-god.md#cost-control)).
5. **An 11th+ bot strains one process** → workers first (1), process-per-bot
   only if the mindcraft-style isolation is ever truly needed — that is the LAST
   resort, it reintroduces failure mode #5.
