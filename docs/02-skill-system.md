# 02 — The skill system

The skill system is Eden's core asset. Everything else (God, events, villagers)
exists to grow it and to spend it.

## Skill anatomy

A **skill** is a versioned async JavaScript function plus a typed manifest. The code
shape is Voyager's, extended with typed parameters and returns:

```js
// .eden-data/library/harvest-field/v3.js
async function harvestField(bot, { center, radius = 8, replant = true }, ctx) {
  // Full mineflayer API: bot.findBlocks, bot.dig, bot.equip, bot.pathfinder, …
  // Helpers are skills too: compose, don't copy.
  const mature = bot.findBlocks({
    matching: (b) => b.name === 'wheat' && b.getProperties().age === 7,
    maxDistance: radius, count: 64,
  });
  let harvested = 0, replanted = 0;
  for (const pos of mature) {
    await ctx.skills.run('go-to', { x: pos.x, y: pos.y, z: pos.z, range: 2 });
    await bot.dig(bot.blockAt(pos));
    harvested++;
    if (replant) replanted += await ctx.skills.run('plant-seed', { at: pos, seed: 'wheat_seeds' });
  }
  return { harvested, replanted };
}
```

```ts
interface SkillManifest {
  name: string;                 // kebab-case, unique in the library
  summary: string;              // ONE English line — what prompts show (see Retrieval)
  description: string;          // 3–6 English sentences, LLM-generated FROM the code
  params: JsonSchema;           // object schema for the args bag
  returns: JsonSchema;          // schema for the resolved value
  signature: string;            // rendered TS-style line for prompts, derived from schemas:
                                //   harvestField({center: Vec3, radius?: number, replant?: boolean})
                                //     → {harvested: number, replanted: number}
  tags: string[];               // 'farming', 'movement', 'combat', …
  tier: 'mortal' | 'divine';    // divine = needs the op'd avatar (fly, /summon, /tp, …) — see §Tiers
  exemplar: boolean;            // member of the always-in-prompt teaching set
}

interface SkillVersion {
  name: string;
  version: number;              // monotonically increasing, never reused
  codePath: string;             // .eden-data/library/<name>/v<k>.js
  codeHash: string;
  status: 'draft' | 'active-probation' | 'active' | 'quarantined' | 'archived';
                                // active-probation (D-12): globally runnable + retrievable
                                //   but NOT composable until probationRuns clean re-judged runs
  probationRunsLeft?: number;   // counts down during active-probation; 0 ⇒ graduate to active
  author: { kind: 'god' | 'villager' | 'stock'; name?: string };
  provenance?: { rolloutId: string; verdictId: string };  // the run that admitted it
  createdAt: number;
}

interface SkillStats {           // aggregated from journal events, cached per (name)
  runs: number; successes: number; failures: number; stalls: number;
  avgMs: number; lastError?: string; lastRunAt?: number;
}
```

Rules of the shape:

- **`(bot, args, ctx)` exactly.** `bot` is the raw mineflayer bot. `args` is one
  object validated against `params` at call time. `ctx` is the engine's surface:

  ```ts
  interface SkillContext {
    skills: { run<T>(name: string, args: object): Promise<T> };  // composition
    log(message: string): void;          // → journal (skill.log), NOT console
    signal: AbortSignal;                 // honored by helpers; checked by the engine
    runner: { name: string; role: string; tier: 'mortal' | 'divine' };  // villager bots run
                                         //   mortal; the avatar is the only divine runner
    depth: number;                       // current call-graph depth
  }
  ```

- **Return structured data.** The return value is the skill's *measurable outcome*;
  the critic reads it, callers branch on it. `return { harvested: 12 }`, never
  `bot.chat("done!")` as the only signal.
- **No event registration inside skills.** Skills are pure capabilities. Reactivity
  lives in subscriptions ([04 §Events](04-villager-runtime.md#the-event-system)).
  This replaces v1's reflex/routine split: there is ONE kind of skill; "reflex" is
  now *subscription → skill binding* and "routine" is *a long-running skill run*.
- **Generic by doctrine** (Voyager rule 3, kept verbatim in the authoring prompt):
  no assumptions about inventory; check prerequisites and acquire them by composing
  other skills; parameterize anything a caller might vary.

### Decision D-04: typed via schemas + runtime validation, not a compiler

**Chosen:** `params`/`returns` are JSON Schemas in the manifest. The engine
validates `args` on every call and (in `draft` trials only) validates the return
value. The `signature` string is *rendered from* the schemas for prompts.

**Rejected:** v1's `tsc`-against-`.d.ts` pre-run gate (explicit owner decision);
TypeScript source for skills.

**Why:** the owner's call — the full-API decision makes a meaningful static check
impossible anyway (the bot surface is huge and dynamic), and v1 showed the
typechecker mostly fought the model. Runtime schema validation still delivers the
two things types were buying: **call-site errors are caught at the boundary with a
readable message** ("`radius`: expected number, got string"), and **composition is
self-documenting** (the signature line in prompts is generated, so it can't lie).

## The library

**One library. It belongs to God.** (Owner decision #2.)

- All villagers draw from the same pool. A skill Firmin's rollout proved is
  instantly available to Colette. Learning compounds village-wide.
- Versioning is **append-only**: a rewrite of `harvest-field` creates `v4`; `v3`'s
  file stays on disk forever (Voyager overwrites skills in place and orphans a renamed
  copy; Eden retains every version deliberately).
  `archived` versions are invisible to retrieval but fully visible to the admin API,
  the website, and `read_skill` with an explicit version arg.
- **Status transitions** (only the engine and God may move these):

  ```
  draft ──(verdict: success, check not-failed)──► active-probation   (D-12)
  draft ──(verdict: fail, retries left)─────────► stays draft (new version supersedes)
  active-probation ──(N=probationRuns clean re-judged runs)──► active
  active/active-probation ─(stats decay / God review)─► quarantined
  quarantined ──(forced re-trial succeeds)──► active-probation        (self-healing, R37)
  any ───(God or admin)─────────────────────► archived
  ```

  **The `check`-veto (D-12)** sits in front of admission: a task's `check: {item,
  count}` failing post-run forces `success: false` regardless of the verdict (the
  passing direction is *not* an auto-admit — "evidence FOR the critic, not a bypass").
  **Probation gates composition, not access:** `active-probation` versions are
  retrievable and directly runnable by every villager (owner #2 — no re-siloing), but
  `ctx.skills.run` of one *from another skill* is refused until it graduates. Stock/
  exemplar skills enter `active` directly (curated review *is* their probation).

  `quarantined` replaces v1's 3-strike auto-disable: repeated runtime failures of an
  *active* skill enqueue a critic review with the failure evidence; **God decides**
  to quarantine, not a counter. (A counter still exists as a tripwire — `autoQuarantineAfter:
  5` consecutive failures — so a broken skill can't rampage while God's queue is
  long. The tripwire files a critic ticket either way.)
- **No skill count cap.** The library is meant to grow for months. Retrieval quality,
  not storage, is the scaling concern — see Retrieval below.
- Every mutation journals: `skill.draft`, `skill.admit`, `skill.quarantine`,
  `skill.archive`, with author, diff stats, and provenance. The website's "skill
  page" is a rendering of this stream plus stats.

### Access control: the economy seam

```ts
interface GrantPolicy {
  /** May this villager SEE the skill in retrieval/prompts? */
  canRetrieve(villager: string, skill: string): boolean;
  /** May this villager EXECUTE the skill? */
  canRun(villager: string, skill: string): boolean;
}
```

v0 ships exactly one implementation: `AllGranted` (constant `true`). Every
retrieval and every `skills.run` already passes through it. When the economy
arrives ([06 §Economy](06-future-extensions.md#the-skill-economy)), a `LedgerGrants`
implementation swaps in behind the same two calls — **no engine changes**. This is
the entire cost of "support the transition easily" and it is paid now.

## Validation & runtime supervision

(Owner decision #5: no type checking; detect hangs; crashes rise to the LLM.)

The pipeline a draft passes before it can run:

1. **Parse** (acorn, `ecmaVersion: 2022`). Syntax errors return to the author as
   tool-result feedback, exactly like v1. Nothing else is rejected — no banned
   identifiers, no import scanning. Full power (P3).
2. **Instrument** — the one AST transform we keep: inject a cycle-counter call into
   every loop body. This is **not** a sandbox and **not** a typecheck; it is the only
   possible in-process answer to a *synchronous* `while (true) {}`, which would
   freeze the entire host (all ten villagers + God) and which no timer-based
   watchdog can catch. Budget default 1e6 iterations, reset on every `await` that
   actually yields. Exceeding it throws `SkillStalledError('loop budget')`.
3. **Manifest sanity** — params/returns schemas compile; signature renders; name free
   or versioning an existing skill.

At runtime, every `skills.run` gets three supervisors:

- **Wall-clock cap** — per-call `timeoutMs` (default 120 s, callers may raise for
  long jobs up to a hard 2 h ceiling, v1's routine cap).
- **Stall detector** — "it's not supposed to pause." A **pulse is a discrete
  progress *event*, never a continuous "in-progress" state** (D-10) — else a wedged
  `bot.dig` holding `targetDigBlock` would look alive forever. Two sources feed it:
  *engine built-ins* subscribed on run start (sampled position delta, inventory
  change, window open/close, dig/place start+complete, and **pathfinder liveness**:
  the public `path_update`/`path_reset`/`goal_reached`/`goal_updated`/`path_stop`
  events — the precise R26 reconciliation, since a 14–60 s `goTo` emits these *while
  the bot stands still*); and the *skill contract* (`ctx.log(...)`, the provided
  `sleep(ms)` global which pulses each wait tick, and stock primitives that pulse in
  their poll loops — so a ~10 s/item smelt and a "wait for crops" both survive). No
  pulse for `stallSeconds` (default 20, uniform — no per-op mode switch) → abort +
  `SkillStalledError('no progress')`. These pulses are the in-memory counters of
  D-07/R44 (RAM the detector reads, never journaled); the per-call wall-clock
  `timeoutMs` is the separate ceiling. Detects **async hangs only** — a synchronous
  `while(true)` is the loop-budget instrument's job. See D-10.

  > **Resolved: see D-10.** (Was OQ-1 — stall-detector pulse semantics.)

### Decision D-10: a pulse is a discrete progress event; pathfinder liveness is a built-in pulse source

**Chosen:** the stall detector treats a **pulse as a discrete progress *event*, never
a continuous "in-progress" state** (else a wedged `bot.dig` that holds
`targetDigBlock` looks alive forever). Two sources feed it:
- **Engine built-ins**, subscribed on run start: sampled position delta, inventory
  change, window open/close, dig/place start+complete, and **pathfinder liveness** —
  the public events `path_update` / `path_reset` / `goal_reached` / `goal_updated` /
  `path_stop`. This is the precise R26 reconciliation: a `goTo` burning 14–60 s emits
  these *while the bot stands still*, so it is genuinely alive, not specially excused.
- **Skill contract:** `ctx.log(...)` pulses; the provided `sleep(ms)` global pulses
  each wait tick; stock primitives (`go-to`, `craft-item`, `smelt-item`) pulse inside
  their poll loops (a ~10 s/item smelt survives because its poll loop sleeps; a
  crop-wait survives because it *is* `sleep`). A hand-rolled wait that forgets to
  pulse is a bug the critic teaches (Voyager-honest).

`stallSeconds = 20`, **uniform** — no per-op mode switch, because the liveness pulses
keep long ops alive. The per-call wall-clock `timeoutMs` (default 120 s, ≤2 h) is the
separate ultimate ceiling. Pulses are the in-memory counters of D-07/R44 — RAM the
detector reads, never journaled. The detector governs **async hangs only**; a
synchronous `while(true)` is the loop-budget instrument's job.

**Rejected:**
- *Pure skill contract (no pathfinder coupling).* Cleanest contract, but a raw
  `bot.pathfinder.goto` in a skill body is stationary during the R26 churn and trips
  the detector unless the author hand-pulses movement — fragile discipline pushed
  onto every author.
- *Whitelist-suppress recognized long ops, fall back to the wall-clock.* Avoids event
  coupling but reintroduces a per-op special-case list (the patch-accretion S9 warns
  against) and is less precise: a hang *inside* a whitelisted op waits the full
  `timeoutMs`, not `stallSeconds`.

**Why:** only the hybrid reconciles with R26 *precisely* — the churning pathfinder is
genuinely alive (it emits real recompute events), not excused — while keeping one
uniform threshold and zero author burden for physical progress. The coupling is to
pathfinder's documented public event API (verified present in the pin), so the cost
is mild and a future rename is a one-line hardening fix.

**Consequence:** `skills/engine.ts` installs the built-in pulse subscriptions on run
start and tears them down on every exit path (alongside the abort protocol). An
all-`sleep` spin (`while(true){await sleep(100)}`) pulses forever, so it is bounded
by `timeoutMs` and surfaces to the critic as futility (R34/R35), *not* by the stall
detector — correct layering (R39). New pitfall captured as **R46**. Deliverable test
(FakeBot, no server): (i) `while(true)` → caught by the loop budget, not the stall
detector; (ii) FakeBot emitting `path_update` every ~1 s for 45 s with position
constant → not aborted; (iii) `bot.dig` returning a never-resolving promise with one
start-pulse → `SkillStalledError('no progress')` at ~`stallSeconds`.

- **Abort protocol** — on timeout, stall, or external cancellation (directive
  preemption, shutdown), the engine runs the hardened abort sequence from v1
  ([07 §Abort](07-hard-won-lessons.md#the-abort-protocol)) so the *next* action
  doesn't fight zombie pathfinder/pvp/collect tasks.

**Crash escalation, not crash suppression.** Any throw produces a `RunReport` and a
journal `skill.run` event; the report is routed to **God's critic queue** (and, when
the run belonged to a villager's own activity, to that villager's next context
pack). Nothing auto-disables, nothing is silently retried, no suppression memos:
the LLM loop is the error handler. The v1 lesson about *benign preemption* carries
over as data on the report (`aborted: 'preempted' | 'stalled' | 'timeout' | null`)
so the critic can tell "interrupted on purpose" from "broken".

```ts
interface RunReport {
  runId: string; rolloutId?: string;
  skill: string; version: number;
  villager: string;
  args: object;
  outcome: { ok: true; value: unknown } | { ok: false; error: string; stack?: string };
  aborted: 'preempted' | 'stalled' | 'timeout' | null;
  startedAt: number; durationMs: number;
  pulses: number; deepestDepth: number;
  callTree: Array<{ skill: string; version: number; ok: boolean; ms: number }>;
  worldBefore: Snapshot; worldAfter: Snapshot;   // see Observation rendering
}
```

## Composition

(Owner decision #7: skills call skills; everything typed.)

- `await ctx.skills.run('name', args)` — args validated against the callee's
  `params`, resolved value is the callee's `returns`. The tier gate is checked
  first (mortal never calls divine — §Tiers), then the grant policy (v0: always
  yes).
- **Depth cap 8, cycle detection** on the (name) chain — `a→b→a` throws immediately
  with the cycle printed. v1's cap of 2 made skills macros; 8 makes them a real
  call stack while still bounding runaway recursion.
- **One budget, one signal, one report.** The whole tree shares the caller's loop
  budget, abort signal, and stall detector; the `RunReport.callTree` records every
  frame. To the critic, a composed run is one story.
- Stock primitives (`go-to`, `mine-block`, `craft-item`, `smelt-item`,
  `place-item`, `kill-mob`, `explore-until`, `use-chest`, `deposit`, `withdraw`) are
  ordinary library skills with `author: 'stock'` (a curated ~6 of them also flagged
  `exemplar: true` — the always-in-prompt teaching set) — Voyager's control
  primitives, reimplemented on the v1 hardening corpus. They are the vocabulary every
  generated skill composes from day one.

### Decision D-05: serialized execution per bot

A bot runs **one skill tree at a time** (v1's `runExclusive`, kept). Concurrent
requests queue; a directive with `priority: 'interrupt'` aborts the running tree
(reported as `aborted: 'preempted'`) before starting. Mineflayer cannot
multiplex a body, and v1's worst bugs were two controllers fighting one bot.

## Retrieval & prompting

(Owner decisions #8 and #10: descriptions in prompts, code on demand; Voyager-style
rich context.)

What an authoring/deliberation prompt contains about skills:

1. **The exemplar set, full code, always.** The always-in-prompt set is a small
   hand-curated subset (~6, tier-filtered) flagged `exemplar: true` — the Voyager
   `control_primitives_context` move: the model learns the dialect by reading working
   code every single time. The broader stock-primitive library (the 10 in Composition
   plus the divine stock skills) is `author: 'stock'` but retrieved like any other
   skill, NOT all carried as full code every call. Carrying full code costs tokens,
   which is why the always-in-prompt set is kept to ~6. Curated and annotated by hand;
   changing an exemplar is a reviewed event, not an LLM write.
2. **Retrieved relevant skills as one-liners:** `signature — summary` only.
   Retrieval = embedding similarity (reuse v1's multilingual embedding stack —
   skills are described in English but queried from French contexts, which is
   exactly what multilingual MiniLM handles) over `summary + description + tags`,
   with keyword overlap as the cold-start/embeddings-off fallback. Top-k default 8.
   Both the exemplar set and retrieval are **tier-filtered**: villager prompts
   never contain divine skills (§Tiers); God's desks see both tiers.
3. **Never non-exemplar full code in passive context.** Code enters the window only
   through the `read_skill` tool, on the model's explicit request.

The tools (shared by villager brains and God desks):

| Tool | Contract |
|---|---|
| `search_skills(query)` | ranked `name — signature — summary — stats` lines |
| `read_skill(name, version?)` | full code + manifest + stats + last 3 run outcomes; default = newest non-archived version |
| `write_skill(name, summary, params, returns, code)` | **upsert** — same tool creates and updates (owner decision #8). Creates a `draft` version; returns parse/instrumentation errors inline for immediate retry |
| `run_skill(name, args, timeoutMs?)` | execute now on my bot; returns the resolved value or the error verbatim |

**Description-from-code:** on every admission, a `fast`-tier LLM pass writes
`description` (and proposes `summary` + `tags`) *from the final code* — Voyager's
`generate_skill_description`, kept because self-descriptions drift aspirational.
The author's own summary is used for drafts; the derived one replaces it at
admission.

**Observation rendering ("just do it like Voyager"):** every prompt that asks for
code or judgment carries a rendered world snapshot in Voyager's flat format —
biome, time, nearby blocks, nearby entities (nearest-first), health, hunger,
position, equipment, inventory with slot count, known chests — plus Eden additions
(active directive, running skill, recent journal slice). One renderer
(`Snapshot → string`) shared by villager context packs and God desks:
[04 §Context pack](04-villager-runtime.md#the-context-pack).

## The power ceiling: full mineflayer

(Owner decision #11.)

Skill code receives the **actual bot object** — pathfinder, pvp, collectblock,
auto-eat, windows, `bot._client` if it dares. No wrapper API, no `.d.ts` contract.

What replaces the wrapper's lost services:

| v1 wrapper service | Eden replacement |
|---|---|
| Discoverability of allowed calls | Exemplar code + mineflayer cheat-sheet doc in the authoring prompt (curated excerpt, not the full typings) |
| Arg/arity safety | Runtime schema validation at skill boundaries; inside the body, crash escalation is the teacher |
| Serialized world access | Engine-level (D-05), not API-level |
| Anti-footgun hardening | The helpers/exemplar skills bake in the v1 corpus (abort order, craft quiescence, hop navigation); the authoring prompt says "compose `go-to`/`craft-item`, do not hand-roll pathfinding/crafting" — Voyager's exact rule-2 move |
| French player-facing speech | Prompt requirement, unchanged |

Accepted risks, eyes open: a skill can deadlock a window, spam the server, or call
`process.exit`. Mitigations are the supervisors, the journal, God's critique, and
the admin kill switch — watchfulness, not gates (P3). If this ever proves wrong in
practice, the documented escape hatch is running villager skill trees in
`worker_threads` (one bot per worker), which the one-process decision (D-01)
deliberately does not preclude.

## Tiers: mortal and divine

(Owner decision #13: God uses skills too, with elevated permissions — fly, spawn, ….)

Skills and runners both carry a **tier**. Villager bots run `mortal` — never op'd.
The avatar — op'd by the Java mod (R14), creative when configured — is the
village's only `divine` runner.

- **`tier: 'divine'` in the manifest** marks skills that need elevation: flight
  (`bot.creative`), server commands (`/summon`, `/tp`, `/weather`, `/give`,
  `/effect`, `/time`), teleporting entities, terrain edits. Everything else is
  `mortal`.
- **The engine hard-gates tiers.** `skills.run` of a divine skill by a mortal
  runner throws immediately, before any code executes. This check is an engine
  invariant, deliberately NOT part of `GrantPolicy` — grants are mutable economy
  policy; tier is a security boundary. Grants apply within the mortal tier only.
- **Mortal never calls divine** in composition — no privilege escalation through
  the call graph. Divine freely composes mortal (a `summon-creature` may call
  `go-to`).
- **Retrieval is tier-filtered.** Villager prompts, `search_skills`, and
  `read_skill` never surface divine skills — they are invisible, not forbidden
  temptations. God's desks see both tiers.
- **Authoring:** `write_skill` with `tier: 'divine'` is accepted only from God's
  desks or the admin API. The villager-facing tool schema does not expose the
  field; villager-authored skills are always mortal.
- **Cross-tier execution safety:** when the avatar runs a *mortal* skill —
  demonstrating or trialing villager-authored code — the engine installs a chat
  interceptor on the avatar that drops `/`-prefixed messages for the duration of
  the run. Only divine-tier code may speak commands on an op'd bot
  ([07 R25](07-hard-won-lessons.md#privilege) — the generalization of v1's bridge
  rule). Villager bots need no interceptor: they are never op'd, so the server
  refuses commands anyway — defense at both layers.
- **Divine stock skills** (God-prompt-only): `appear-near`, `vanish`, `gesture`,
  `fly-to`, `summon-creature`, `smite`, `teleport-entity`, `give-items`,
  `set-weather`. `author: 'stock'`, surfaced only in God's desks (tier-filtered out of
  every villager prompt), not the always-in-prompt mortal exemplar set.
  The first three ARE the body primitives ([03 §Body](03-god.md#the-body)) —
  God's theatrics are journaled skill runs like every other world effect (P4).

## Admission pipeline

The skill lifecycle, end to end (the loop itself is specced in
[03 §Refinement loop](03-god.md#the-refinement-loop)):

```
write_skill (villager or God authors)            … draft vN
  └─ parse + instrument + manifest sanity        … errors → author, retry inline
trial run(s) on a real task                      … RunReport(s), rolloutId attached
  └─ God critic verdict
       success → admit: status=active,
                 description pass runs,
                 journal skill.admit {provenance}
       failure → critique → author revises       … draft vN+1, retry (curriculum caps retries)
```

Trial venue follows tier: mortal drafts trial on the assignee villager's bot
(even when God authored them); divine drafts trial on the avatar.

Invariant (P2): **retrieval and `run_skill` for normal work only ever see `active`
and `active-probation` versions** — both are *proven* (a real run succeeded and God
said so); `active-probation` merely additionally cannot be *composed* by other skills
until it graduates (D-12). Draft versions are runnable solely inside their own
rollout's trials. A villager cannot "use" an unproven skill by accident; God cannot be
bypassed.
