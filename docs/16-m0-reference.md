# 16 — M0 reference (the spine, module by module)

The **prose developer reference** for the M0 spine that exists today under
[eden/src/](../eden/src). Its companions are visual: [15-m0-as-built.md](15-m0-as-built.md)
draws the package/layer, class, boot, and runtime diagrams; [11-class-model.md](11-class-model.md)
and [12-architecture-views.md](12-architecture-views.md) hold the M0–M7 *target* model and
the design intent. This doc does the thing those don't — walk every shipped module, its
public surface, its non-obvious rules, the errors it throws, and the test that pins it. Read
15 for the picture; read this to change the code safely.

Everything here was read out of the code and is cited as `path:line`. If a behavior isn't in
the code, it isn't in this doc — layers 2–3 (skills, llm, god, villagers) do **not** exist
yet (see §7).

---

## 1. Overview & how to run

**What M0 is.** The spine: `config → journal → lag-monitor → admin`, wired by one
composition root ([main.ts:28](../eden/src/main.ts:28)), which journals a `system.boot`
event and returns an `EdenHost` handle. No bots, no skill engine, no LLM, no God — those
attach to the same root as their milestones land. The whole of Eden is **one Node process**
(decision D-01); M0 is that process with only its substrate brought up.

**The one-process model.** `start(configPath)` opens a single SQLite journal, arms the
event-loop lag canary, and starts one HTTP+WebSocket admin server. There are no
subprocesses, no message queues, no singletons — dependencies are plain constructor
arguments threaded through `main.ts` (the only file allowed to import everything; docs/08
dependency law).

**Commands** (run from `eden/`):

```powershell
npm run check     # lint + typecheck + dependency-cruiser + tests — the full CI gate
npm test          # node:test via tsx, on the fakes only (NO Minecraft)
npx tsx src/main.ts eden.json   # boot the real spine against a config file
```

`npm run check` is four steps chained in [package.json:15](../eden/package.json:15):
`eslint .` → `tsc --noEmit` → `depcruise src` → `node --import tsx --test "tests/**/*.test.ts"`.
The test corpus uses only the fakes (§5); it never connects to Minecraft or a real LLM, so it
runs anywhere.

**Running the host directly.** `src/main.ts` is both a library (`export async function start`)
and an entrypoint. The `import.meta.url === pathToFileURL(process.argv[1]).href` guard at
[main.ts:86](../eden/src/main.ts:86) means it only self-boots when invoked as a script; the
config path defaults to `eden.json` ([main.ts:89](../eden/src/main.ts:89)). Copy
[eden.example.json](../eden/eden.example.json) to `eden.json` (gitignored by convention) and
edit it first.

**The data dir.** Defaults to `.eden-data` ([main.ts:29](../eden/src/main.ts:29), overridable
via `EdenHostOptions.dataDir`). `start` does `mkdirSync(dataDir, { recursive: true })`
([main.ts:36](../eden/src/main.ts:36)) and opens the journal at `<dataDir>/eden.db`
([main.ts:37](../eden/src/main.ts:37)). WAL mode means you will also see `eden.db-wal` and
`eden.db-shm` beside it.

**Ports** (the registry lives in [eden.example.json:5-10](../eden/eden.example.json:5), R24):

| Port | Owner | Notes |
|---|---|---|
| 8770 | Eden admin HTTP + WS | this process — `admin.port`; M0's only listener |
| 8767 | Java trade settlement | `settlement.url`; shared, unused in M0 |
| 25599 | Minecraft dev server | `minecraft.port`; unused in M0 (no bot yet) |
| 8765 / 8766 | **reserved by v1** | never reuse while `npm run unified` / `village` runs |

In tests the admin port is `0` (ephemeral) so suites never collide
([admin.test.ts:18](../eden/tests/admin.test.ts:18)).

---

## 2. The dependency law in practice

Eden's defense against v1's "fifty reasonable patches" rot is structural: imports run
**strictly downward** through layers — `types (0) → {journal, config, bots} (1) →
{skills, llm} (2) → {god, villagers, social} (3)` — with `admin/` a pure consumer that may
import anything and that nothing but `main.ts` may import. The picture is
[15 §1 diagram 1](15-m0-as-built.md#1-package--layer-diagram--the-dependency-law-as-built-for-m0);
the law is encoded as nine `forbidden` rules in
[.dependency-cruiser.cjs](../eden/.dependency-cruiser.cjs) and run as `depcruise src` inside
`npm run check`. An upward import fails the build with no exception short of a new decision
record. "Adding code in the wrong layer" looks like the planted-import test
[dependency-law.test.ts:22](../eden/tests/dependency-law.test.ts:22): it writes
`src/types/__planted_violation__.ts` importing `../journal/journal`, cruises the tree, asserts
a `types-imports-nothing` violation, then deletes the file — so the law's enforcement is
itself tested, not just trusted.

---

## 3. Module reference

Layer order, leaves first. Each subsection: purpose + layer + state written (S2); public
surface; non-obvious semantics; invariants by number; error modes (S10); a usage example; the
pinning test(s).

### 3.1 `types/` — layer 0, the shared vocabulary

**Purpose & layer.** Layer 0. Shared interfaces + enums only, **zero logic, imports nothing
outside `types/`** ([types/index.ts:1-2](../eden/src/types/index.ts:1)). Everything imports
`types/`; `types/` imports nothing. **Writes no state.** The barrel
[types/index.ts](../eden/src/types/index.ts) re-exports the seven submodules.

Almost every interface here is **defined in M0 but first consumed in M1+** — the M0 *runtime*
only reads the journal trio (`JournalEvent`, `Refs`, `JournalQuery`). The rest are the fixed
vocabulary M1–M7 will build against (15 §2 marks them «defined, used from M1+»).

**Public surface — `enums.ts` (runtime `as const` registries + derived unions):**

| Symbol | Value / signature | Meaning |
|---|---|---|
| `TIERS` / `Tier` | `['mortal','divine']` | the permission tier a runner has (divine = avatar) |
| `SKILL_STATUSES` / `SkillStatus` | `['draft','active-probation','active','quarantined','archived']` | the D-12 skill lifecycle states |
| `ABORT_CAUSES` / `AbortCause` | `['preempted','stalled','timeout']` | why a run was aborted |
| `PRIORITIES` / `Priority` | `['background','normal','interrupt']` | directive / handler priority |

These are `as const` arrays so members exist at runtime (admin can describe them) and the
union type derives from one source ([enums.ts:1-2](../eden/src/types/enums.ts:1)).

**Public surface — the rest (interfaces only; see files for full fields):**

- `skill.ts`: `JsonSchema`, `Author`, `Provenance`, `SkillManifest`, `SkillVersion`,
  `SkillStats`, `Snapshot`, `CallFrame`, `RunOutcome`, `RunReport`, `RunnerRef`.
  `RunReport` ([skill.ts:80](../eden/src/types/skill.ts:80)) is the run-evidence record the
  critic will read; `Snapshot` ([skill.ts:56](../eden/src/types/skill.ts:56)) is the small
  Voyager world view (D-07: no raw world dumps).
- `task.ts`: `ItemCheck`, `Task`, `TaskRecord`, `TaskLedger`, `DirectiveSuggestion`,
  `TaskSuggestion`, `Directive`, `CriticTicket`, `Verdict`, `Rollout`, `VerdictRef`,
  `Competence`, `Dossier`. `Verdict.libraryAction`
  ([task.ts:74](../eden/src/types/task.ts:74)) is the admit/quarantine/archive decision.
- `events.ts`: `EdenEvent` (closed discriminated union of 14 variants),
  `EventType`, `Envelope`, `Filter` (declarative only, P5 — no predicate code),
  `ArgTemplate`, `SkillHandler`, `DeliberateHandler`, `SubscriptionHandler`, `Subscription`.
- `journal.ts`: `Refs` (the causality column), `JournalEvent`, `JournalQuery` — **the trio
  with live M0 consumers.**
- `inbox.ts`: `InboxMessage`, `Inbox` — the only God→villager channel, an interface so
  `god/` never imports `villagers/` (the law).
- `memory.ts`: `MemoryEntry`.

**Behavior & semantics.** The load-bearing decision is that `JournalEvent.kind` is typed
**`string`**, not the `JournalKind` union ([journal.ts:18-34](../eden/src/types/journal.ts:18)).
`types/` imports nothing, so it cannot hold the canonical union — that lives one layer up in
`journal/kinds.ts` (§3.4). The event stays open; the *writer's* generic `append<K>` signature
is what enforces the union (§3.5). Readers (admin) treat `kind` as the open string it is.

**Invariants.** Dependency rules `types-imports-nothing` and `no-circular`
([.dependency-cruiser.cjs:17,11](../eden/.dependency-cruiser.cjs:17)). Inside `types/`,
submodules may import `enums` (e.g. `events.ts` imports `Priority`,
[events.ts:1](../eden/src/types/events.ts:1)) — the law forbids only `types/ → non-types`.

**Error modes.** None — pure type/data definitions.

**Usage example:**

```typescript
import { TIERS, type Task, type Verdict } from './types/index';
const t: Task = { id: 't1', goal: 'collect 3 oak logs',
  successCriteria: 'three oak_log in inventory', context: '', maxRetries: 4 };
```

**Pinned by.** [types.test.ts](../eden/tests/types.test.ts): `Tier registry has exactly
mortal + divine`, `SkillStatus registry matches the D-12 status machine`,
`AbortCause registry is preempted/stalled/timeout`,
`Priority registry is background/normal/interrupt`,
`domain interfaces are constructible as plain data`,
`Inbox is a behavior-free channel interface`,
`Subscription and RunReport shapes compile`.

### 3.2 `config.ts` — layer 1, load + validate `eden.json`

**Purpose & layer.** Layer 1 substrate. Parses, validates, and normalizes the config.
**Imports only `types/`** — the law forbids it importing `logger`, which is *why* it returns
warnings instead of printing them ([config.ts:1-3](../eden/src/config.ts:1)). **Writes no
state** (returns a value).

**Public surface:**

| Symbol | Signature | Meaning |
|---|---|---|
| `DeskConfig`, `ProviderConfig`, `VillagerConfig`, `EdenConfig` | interfaces | the validated config shape ([config.ts:11,14,19,25](../eden/src/config.ts:11)) |
| `DEFAULT_CONFIG` | `Omit<EdenConfig, 'villagers'>` | the defaulted skeleton; villagers come from the user ([config.ts:60](../eden/src/config.ts:60)) |
| `parseConfig(input: unknown)` | `{ config: EdenConfig; warnings: string[] }` | **pure** — validate + normalize an already-parsed object; never prints ([config.ts:154](../eden/src/config.ts:154)) |
| `loadConfig(path, onWarn?)` | `EdenConfig` | read a JSONC file, parse, forward each warning to `onWarn`, return the config ([config.ts:315](../eden/src/config.ts:315)) |

**Behavior & semantics.**
- **Pure, never prints.** `parseConfig` collects warnings into an array and returns them; the
  caller (`main.ts`) logs and journals them. This is the dependency law made visible: no
  `logger` import is possible here.
- **JSONC tolerated.** `loadConfig` runs the file through `stripJsonComments(..., { trailingCommas: true })`
  ([config.ts:317](../eden/src/config.ts:317)) so `eden.example.json`'s comments parse.
- **Defaults by deep-merge.** Every section falls back to `DEFAULT_CONFIG` field by field via
  the `num`/`bool`/`str` helpers ([config.ts:140-151](../eden/src/config.ts:140)); a missing
  or wrong-typed key silently takes the default.
- **Aliases (R22).** Per-section deprecated→canonical map `ALIASES`
  ([config.ts:110](../eden/src/config.ts:110)): `llm.maxConcurrency→maxConcurrent`,
  `llm.perVillagerCooldownSec→perVillagerCooldownSeconds`,
  `journal.vitalsIntervalSec→vitalsIntervalSeconds`. Adopting one emits a warning and deletes
  the old key ([applyAliases:118](../eden/src/config.ts:118)).
- **Unknown keys warn, don't throw.** `warnUnknown` ([config.ts:132](../eden/src/config.ts:132))
  emits `unknown key <section>.<k> ignored (R22)` for any key outside the known set.
- **`retentionDays` is hardcoded (G1).** It is always `DEFAULT_CONFIG.journal.retentionDays`
  = `7` ([config.ts:104,293](../eden/src/config.ts:104)); there is **no config key for it
  yet** — `journal` is validated against `['vitalsIntervalSeconds','debugPrompts']` only
  ([config.ts:286](../eden/src/config.ts:286)). See §7 (G1).

**Invariants enforced.**
- **R11 (version pin).** `minecraft.version !== '1.21.1'` warns
  ([config.ts:174](../eden/src/config.ts:174)).
- **R12 (identity law) — fatal.** Duplicate villager names throw
  ([config.ts:301](../eden/src/config.ts:301)); `god.name` colliding with a villager throws
  ([config.ts:304](../eden/src/config.ts:304)).
- **v1 coexistence.** `god.name === 'LLMBot'` (v1's reserved avatar) warns
  ([config.ts:307](../eden/src/config.ts:307)).
- A `vitalsIntervalSeconds < 5` warns ("floods the journal",
  [config.ts:287](../eden/src/config.ts:287)).

**Error modes (S10).** Two fatal throws, both naming the offending name:
`config: duplicate villager name "<name>" — usernames must be unique (R12)` and
`config: god.name "<name>" collides with a villager username (R12)`. Everything else is a
warning string, never a throw.

**Usage example:**

```typescript
const warnings: string[] = [];
const config = loadConfig('eden.json', (w) => warnings.push(w));
// or, for an in-memory object:
const { config, warnings } = parseConfig(JSON.parse(text));
```

**Pinned by.** [config.test.ts](../eden/tests/config.test.ts): `parses a minimal config and
fills defaults`, `warns on an unknown key (R22) but does not throw`, `adopts a known alias and
warns (R22)`, `rejects god.name colliding with a villager name (R12)`,
`rejects duplicate villager names (R12)`,
`warns on a Minecraft version other than the 1.21.1 pin (R11)`,
`warns if the avatar reuses v1 reserved username LLMBot`,
`the shipped eden.example.json validates with zero warnings`,
`golden: a fully-defaulted validated config object`.

### 3.3 `logger.ts` — layer 1, the one stdout seam

**Purpose & layer.** Layer 1. The **only module allowed to touch stdout** (R23 / docs/05
stdout-purity lesson). ESLint bans `console.*` everywhere else and re-enables it for this one
file ([eslint.config.js:13,24](../eden/eslint.config.js:13)). **Writes to stdout/stderr.**

**Public surface:**

| Symbol | Signature | Meaning |
|---|---|---|
| `Logger` | interface | `line(actor,msg,ms?)`, `info(actor,msg)`, `warn(actor,msg)`, `error(actor,msg)` ([logger.ts:12](../eden/src/logger.ts:12)) |
| `logger` | `Logger` | the singleton implementation ([logger.ts:24](../eden/src/logger.ts:24)) |

**Behavior & semantics.** Every line carries the journal `actor` (R41) so a log tag never
lies about who acted ([logger.ts:2-4](../eden/src/logger.ts:2)). Format is
`[HH:MM:SS.mmm] <actor>  <msg>(<ms>ms)?` via `emit`
([logger.ts:19-22](../eden/src/logger.ts:19)); `warn`/`error` prefix the message with
`WARN `/`ERROR ` and route to `console.warn`/`console.error`. `line` is the timed variant
(optional trailing `(<ms>ms)`).

**Invariants enforced.** R23 (console purity) — enforced by ESLint, not at runtime.

**Error modes.** None.

**Usage example:**

```typescript
import { logger } from './logger';
logger.info('engine', 'Eden host up — admin on http://127.0.0.1:8770');
logger.warn('config', 'unknown key skills.wat ignored (R22)');
```

**Pinned by.** No direct unit test — its correctness is the R23 ESLint rule plus the fact
that `main.ts` uses it on the boot path exercised by `main.test.ts`.

### 3.4 `journal/kinds.ts` — layer 1, the S1 kind registry

**Purpose & layer.** Layer 1, inside `journal/`. The journal **kind registry (S1)**: the
canonical `JournalKind` union, the per-kind payload types, and the human docs. Imports
nothing ([15 §1](15-m0-as-built.md)). **Writes no state.** M0 registers only the `system.*`
domain — each milestone registers its own kinds.

**Public surface:**

| Symbol | Signature | Meaning |
|---|---|---|
| `JOURNAL_KINDS` | `readonly [...6 strings]` | the `as const` source of the union ([kinds.ts:6](../eden/src/journal/kinds.ts:6)) |
| `JournalKind` | `(typeof JOURNAL_KINDS)[number]` | the union type ([kinds.ts:15](../eden/src/journal/kinds.ts:15)) |
| `KindPayloads` | interface | per-kind payload shape; one row per kind ([kinds.ts:22](../eden/src/journal/kinds.ts:22)) |
| `PayloadOf<K>` | `KindPayloads[K]` | indexes the payload for a kind ([kinds.ts:32](../eden/src/journal/kinds.ts:32)) |
| `KIND_REGISTRY` | `satisfies Record<JournalKind, KindDoc>` | one human doc per kind ([kinds.ts:38](../eden/src/journal/kinds.ts:38)) |
| `isKnownKind(kind)` | `kind is JournalKind` | precise runtime type guard ([kinds.ts:49](../eden/src/journal/kinds.ts:49)) |
| `describeKinds()` | `Array<{kind, doc}>` | what the admin `/kinds` route serves ([kinds.ts:54](../eden/src/journal/kinds.ts:54)) |

The six M0 kinds: `system.boot`, `system.config-warning`, `system.bot-connected`,
`system.bot-disconnected`, `system.error`, `system.loop-lag`.

**Behavior & semantics.** Two lockstep contracts the compiler enforces (the v1 failure-mode-#2
fix — one source of truth):
- A kind missing from `KindPayloads` is a compile error, because `PayloadOf<K>` indexes it
  ([kinds.ts:17-32](../eden/src/journal/kinds.ts:17)).
- A kind missing a doc is a compile error, because `KIND_REGISTRY` is pinned with
  `satisfies Record<JournalKind, KindDoc>` ([kinds.ts:45](../eden/src/journal/kinds.ts:45)).

So the union, the payloads, and the docs cannot drift apart. `isKnownKind` backs the runtime
guard in the writer (§3.5) and `describeKinds()` lets the future website render kinds it
doesn't hardcode (decision 9).

**Invariants enforced.** S1 (additions are registry rows), and R44/D-07: **no per-tick /
pulse stream is ever a kind** — pinned by a test that regex-rejects any kind matching
`pulse|tick|position|pathfinder|physic`.

**Error modes.** None here; the guard's throw lives in the writer.

**Usage example:**

```typescript
import { isKnownKind, describeKinds } from './journal/kinds';
if (isKnownKind(maybe)) { /* maybe: JournalKind */ }
const catalogue = describeKinds(); // [{ kind: 'system.boot', doc: '...' }, ...]
```

**Pinned by.** [journal-kinds.test.ts](../eden/tests/journal-kinds.test.ts):
`M0 registers only its own system kinds (one row per kind)`,
`every kind has a registry doc row (S1 exhaustiveness)`,
`isKnownKind is a precise type guard`,
`R44: no per-tick / pulse stream is ever a JournalKind`.

### 3.5 `journal/journal.ts` — layer 1, the sole writer

**Purpose & layer.** Layer 1. The **single append-only history table** (P4: if it didn't
journal, it didn't happen) and the **sole writer of `eden.db`** (S2). better-sqlite3, WAL,
`synchronous=NORMAL` on the shared event loop (D-07). Imports only `types/` + `journal/kinds`
([journal.ts:9-10](../eden/src/journal/journal.ts:9)). **Writes:** the `journal` table.

**Public surface:**

| Symbol | Signature | Meaning |
|---|---|---|
| `IJournal` | interface | `append<K>` / `query` / `subscribe` — the surface both real + fake implement ([journal.ts:18](../eden/src/journal/journal.ts:18)) |
| `JournalAppender` | `Pick<IJournal,'append'>` | the write side only — what the lag monitor depends on ([journal.ts:25](../eden/src/journal/journal.ts:25)) |
| `JournalListener` / `Unsubscribe` | `(e)=>void` / `()=>void` | pub/sub types ([journal.ts:14-15](../eden/src/journal/journal.ts:14)) |
| `Journal` | class | the SQLite implementation ([journal.ts:38](../eden/src/journal/journal.ts:38)) |
| `Journal#append<K>(actor, kind, payload, refs?)` | `string` (the ulid id) | insert + fan-out ([journal.ts:68](../eden/src/journal/journal.ts:68)) |
| `Journal#query(q?)` | `JournalEvent[]` | filtered read ([journal.ts:81](../eden/src/journal/journal.ts:81)) |
| `Journal#subscribe(listener)` | `Unsubscribe` | live fan-out ([journal.ts:114](../eden/src/journal/journal.ts:114)) |
| `Journal#count()` | `number` | row count ([journal.ts:119](../eden/src/journal/journal.ts:119)) |
| `Journal#close()` | `void` | close the DB ([journal.ts:124](../eden/src/journal/journal.ts:124)) |

**Behavior & semantics.**
- **`append<K>` enforces the kind/payload union.** The generic binds `K extends JournalKind`
  and forces `payload: PayloadOf<K>` ([journal.ts:68](../eden/src/journal/journal.ts:68)) — so
  `append('engine', 'system.loop-lag', { p99, max })` type-checks but a wrong payload doesn't.
  A runtime `isKnownKind` guard backstops a bad *dynamic* kind
  ([journal.ts:70](../eden/src/journal/journal.ts:70)). The id is a monotonic `ulid`
  (sortable + unique, [journal.ts:36,73](../eden/src/journal/journal.ts:36)); `at` is
  `Date.now()`.
- **Query ordering + limit = most-recent-N.** Without a limit, `query` returns full history
  **ascending** (`ORDER BY at ASC, id ASC`). With a positive `limit`, it selects the most
  recent N (`ORDER BY at DESC` + `LIMIT`) then `.reverse()`s them back into chronological
  order ([journal.ts:105-111](../eden/src/journal/journal.ts:105)). So `limit: 2` over five
  events `e0..e4` returns `[e3, e4]`.
- **`ref` matches any ref field.** `query({ ref })` matches an event whose `refs` JSON
  contains that value in *any* field, via `json_each`
  ([journal.ts:100-103](../eden/src/journal/journal.ts:100)).
- **Schema + indexes.** `CREATE TABLE IF NOT EXISTS journal` plus indexes on `at`,
  `(actor,at)`, `(kind,at)`, and `json_extract` of `refs.runId` / `refs.rolloutId` /
  `refs.skill` ([journal.ts:47-62](../eden/src/journal/journal.ts:47)) — the website's
  causality queries are first-class from M0.
- **Fan-out is crash-isolated.** `fan` wraps each listener in `try/catch`
  ([journal.ts:128-136](../eden/src/journal/journal.ts:128)): a bad consumer never breaks the
  write path (P4) or other consumers.

**Invariants enforced.** S2 (one writer), P4 (journal-or-it-didn't-happen), D-07 (WAL +
NORMAL on the shared loop; the lag monitor is the canary that proves this stays safe).

**Error modes (S10).** `journal.append: unregistered kind "<kind>" — add a row to
journal/kinds.ts (S1)` ([journal.ts:71](../eden/src/journal/journal.ts:71)).

**Usage example:**

```typescript
const journal = new Journal(join(dataDir, 'eden.db'));
const id = journal.append('engine', 'system.boot', { config: redacted });
const recent = journal.query({ kinds: ['system.error'], limit: 20 }); // most-recent 20, chronological
const off = journal.subscribe((e) => ws.send(JSON.stringify(e)));
```

**Pinned by.** [journal.test.ts](../eden/tests/journal.test.ts): `append returns a sortable id
and the payload round-trips through query`, `each registered kind round-trips its payload
schema`, `query filters by kind, actor, ref, and since`, `full query is chronological; a
limit returns the most recent N in order`, `subscribe fans out appended events; unsubscribe
stops it`, `appending an unregistered kind throws (S1 guard)`.

### 3.6 `journal/lag-monitor.ts` — layer 1, the backpressure canary (D-07)

**Purpose & layer.** Layer 1. D-07's backpressure **canary** (R40), ported from v1's
`monitorEventLoopDelay({ resolution: 20 })`. On a stall spike it appends one
`system.loop-lag` event. Imports only the narrow `JournalAppender` (write side), not the whole
`Journal` ([lag-monitor.ts:8](../eden/src/journal/lag-monitor.ts:8)). **Writes:** via the
injected appender only.

**Public surface:**

| Symbol | Signature | Meaning |
|---|---|---|
| `LagMonitorOptions` | `{ resolutionMs?, thresholdMs?, resetMs? }` | factory tuning ([lag-monitor.ts:10](../eden/src/journal/lag-monitor.ts:10)) |
| `LagSample` | `{ lagged, p99, max }` | one read of the histogram ([lag-monitor.ts:16](../eden/src/journal/lag-monitor.ts:16)) |
| `LagMonitor` | `{ sample(), start(), stop(), thresholdMs }` | the handle ([lag-monitor.ts:22](../eden/src/journal/lag-monitor.ts:22)) |
| `createLagMonitor(appender, opts?)` | `LagMonitor` | factory ([lag-monitor.ts:32](../eden/src/journal/lag-monitor.ts:32)) |

**Behavior & semantics.**
- **Defaults.** `resolution = 20ms`, `thresholdMs = 1000`, `resetMs = 60_000`
  ([lag-monitor.ts:33-35](../eden/src/journal/lag-monitor.ts:33)). The **1000ms threshold is
  HARDCODED, not a config key** (D-07/S7) — nothing else reads it, and `EdenConfig.journal`
  exposes no field for it.
- **The histogram must be armed before a sync block or it reads ~0.** `createLagMonitor` calls
  `histogram.enable()` immediately ([lag-monitor.ts:36-37](../eden/src/journal/lag-monitor.ts:36)),
  but the histogram only records once the event loop has ticked at least once after arming.
  This is why the D-07 test does `await delay(30)` *before* the 1.2s block and `await delay(60)`
  *after* it ([lag-monitor.test.ts:14-19](../eden/tests/lag-monitor.test.ts:14)) — in
  production the loop ticks first naturally.
- **`sample()`** reads `histogram.max` and `percentile(99)`, converts ns→ms, appends
  `system.loop-lag` with `{p99, max}` rounded *only if* `max >= thresholdMs`, then
  `histogram.reset()` ([lag-monitor.ts:40-49](../eden/src/journal/lag-monitor.ts:40)). Reset
  means **at most one loop-lag event per reset window**.
- **`start()`** arms a `setInterval(sample, resetMs)` and `.unref()`s the timer so it never
  keeps the process alive ([lag-monitor.ts:51-56](../eden/src/journal/lag-monitor.ts:51)).
  `stop()` clears the timer and `histogram.disable()`s.
- The appended event is attributed to actor `'engine'`.

**Invariants enforced.** D-07 (the journal is safe on the shared loop *because* the
high-frequency pulse signal never journals — the lag monitor is the canary that catches it if
that premise breaks). R40/R44.

**Error modes.** None — best-effort sampling.

**Usage example:**

```typescript
const lag = createLagMonitor(journal);
lag.start();
// ... later: lag.sample() forces a read; lag.stop() on shutdown.
```

**Pinned by.** [lag-monitor.test.ts](../eden/tests/lag-monitor.test.ts): `D-07: a 1.2s
synchronous block produces exactly one system.loop-lag (max>=1000)`, `D-07: a quiet loop is
below threshold and appends nothing`, `R44: the in-memory pulse path emits zero journal
events`.

### 3.7 `admin/server.ts` — the pure consumer (read API + WS)

**Purpose & layer.** A **pure consumer** (docs/08): imports anything, nothing imports it
(except `main.ts`), deletable without breaking the spine. M0's read surface: `GET /status`,
`GET /journal`, `GET /kinds`, and a `WS /journal/stream` live fan-out. Mutating verbs land
with their owning subsystems in later milestones. **Writes no state.**

**Public surface:**

| Symbol | Signature | Meaning |
|---|---|---|
| `AdminServerOptions` | `{ port, journal, getStatus?, startedAt? }` | constructor input; `journal` is `Pick<IJournal,'query'|'subscribe'>` ([server.ts:14](../eden/src/admin/server.ts:14)) |
| `AdminServer` | class | the HTTP+WS server ([server.ts:22](../eden/src/admin/server.ts:22)) |
| `AdminServer#start()` | `Promise<{port}>` | listen on `127.0.0.1`; resolves with the actual port ([server.ts:61](../eden/src/admin/server.ts:61)) |
| `AdminServer#stop()` | `Promise<void>` | terminate WS clients, close servers ([server.ts:70](../eden/src/admin/server.ts:70)) |
| `AdminServer#port` | `number` (getter) | the bound port ([server.ts:77](../eden/src/admin/server.ts:77)) |

**Behavior & semantics.**
- **Localhost only.** `http.listen(port, '127.0.0.1', …)` ([server.ts:63](../eden/src/admin/server.ts:63));
  pass `port: 0` for an ephemeral port (tests do).
- **Routing** is a `switch` on `url.pathname` ([server.ts:84-92](../eden/src/admin/server.ts:84));
  unknown paths 404 with `{ error: "no route <path>" }`; a thrown handler 500s with the error
  message ([server.ts:94-96](../eden/src/admin/server.ts:94)).
- **`/status`** merges `{ uptimeMs: Date.now()-startedAt, ...getStatus() }`
  ([server.ts:86](../eden/src/admin/server.ts:86)). `getStatus` defaults to `() => ({})`; in
  the real host it returns `{ bots: 0, runs: 0, queues: {} }`
  ([main.ts:53](../eden/src/main.ts:53)).
- **`/journal`** parses the query string into a `JournalQuery` (`kinds` is comma-split;
  `since`/`until`/`limit` are `Number(...)`) via `parseJournalQuery`
  ([server.ts:111](../eden/src/admin/server.ts:111)) and returns `{ events: journal.query(q) }`
  — so `?limit=1` yields the single most-recent event (§3.5 ordering).
- **`/kinds`** returns `{ kinds: describeKinds() }`.
- **`WS /journal/stream`** is the only upgrade path accepted; any other upgrade
  `socket.destroy()`s ([server.ts:37-44](../eden/src/admin/server.ts:37)). Each connection
  subscribes to the journal and, if `?kinds=a,b` is present, only forwards events whose `kind`
  is listed ([server.ts:45-58](../eden/src/admin/server.ts:45)). A failed `ws.send` is
  swallowed so a dropped client never breaks the writer; `close` unsubscribes.

**Invariants enforced.** `no-import-admin` (only `main.ts` imports it,
[.dependency-cruiser.cjs:70](../eden/.dependency-cruiser.cjs:70)). The route handler reads
journal/derived views only — it never mutates (docs/08 admin-route recipe).

**Error modes (S10).** No throws escape `route`; failures become `500 { error }`. Bad routes
are `404 { error: "no route <path>" }`.

**Usage example:**

```typescript
const admin = new AdminServer({ port: config.admin.port, journal, startedAt,
  getStatus: () => ({ bots: 0, runs: 0, queues: {} }) });
const { port } = await admin.start();
```

**Pinned by.** [admin.test.ts](../eden/tests/admin.test.ts): `GET /status returns uptime, bot
count, and queue depths`, `GET /journal filters by kind/actor/ref/limit`, `GET /kinds exposes
the registry so the website can render unknown kinds`, `WS /journal/stream fans out appended
events live, with optional ?kinds filter`.

### 3.8 `main.ts` — the composition root

**Purpose & layer.** The **only composition root** (docs/08). Imports everything, wires it
with plain constructor arguments (no singletons, no DI container), brings up the spine and
journals `system.boot`. **Writes no state** itself — it owns the lifecycle of the things that
do.

**Public surface:**

| Symbol | Signature | Meaning |
|---|---|---|
| `EdenHostOptions` | `{ dataDir? }` | where the journal + per-bot state live (default `.eden-data`) ([main.ts:16](../eden/src/main.ts:16)) |
| `EdenHost` | `{ adminPort, config, journal, stop() }` | the running-host handle ([main.ts:21](../eden/src/main.ts:21)) |
| `start(configPath, opts?)` | `Promise<EdenHost>` | boot the spine ([main.ts:28](../eden/src/main.ts:28)) |

**Behavior & semantics.** Boot order is load-bearing (traced exactly in
[15 §3](15-m0-as-built.md#3-sequence--boot-mainstartconfigpath)):
1. `loadConfig(path, w => warnings.push(w))` — warnings **collected, not printed** (config
   can't import logger).
2. `mkdirSync(dataDir)` then `new Journal(<dataDir>/eden.db)` — the journal opens **before**
   warnings are emitted, because they need a writer.
3. Each warning is replayed in one loop as both `logger.warn('config', w)` **and**
   `journal.append('engine', 'system.config-warning', { message: w })`
   ([main.ts:38-41](../eden/src/main.ts:38)).
4. `createLagMonitor(journal); lag.start()` — the canary arms **before** admin, so it is live
   the instant the server can lag.
5. `new AdminServer({...}); await admin.start()`.
6. `journal.append('engine', 'system.boot', { config: redactSecrets(config) })` — the
   **last** append, so its presence means a complete boot ([main.ts:57](../eden/src/main.ts:57)).
- **`redactSecrets`** walks the config and masks any key matching `/key|secret|token|password/i`
  with `'***'` before the snapshot enters the journal
  ([main.ts:73-83](../eden/src/main.ts:73)).
- **`stop()`** reverses boot: `lag.stop()` → `await admin.stop()` → `journal.close()`
  ([main.ts:64-68](../eden/src/main.ts:64)).
- **Direct-run guard** only self-boots when invoked as a script
  ([main.ts:86-94](../eden/src/main.ts:86)); a boot failure logs the stack via
  `logger.error('engine', ...)` and sets `process.exitCode = 1` (no `throw` past the top).

**Invariants enforced.** Composition-root rule (only `main.ts` imports `admin/` and the full
tree). The "system.boot is last" and "lag arms before admin" ordering.

**Error modes (S10).** `start` propagates a fatal config throw (R12) to its caller; the
direct-run path catches it and logs `boot FAILED: <stack>`.

**Usage example:**

```typescript
import { start } from './main';
const host = await start('eden.json', { dataDir: '.eden-data' });
// host.adminPort, host.journal.query(...), await host.stop()
```

**Pinned by.** [main.test.ts](../eden/tests/main.test.ts): `the assembled M0 spine boots,
serves /status + /journal, and journals system.boot` — boots a temp config with an unknown
`skills.wat` key and asserts both the `system.boot` event and the `system.config-warning`
mentioning `wat`.

---

## 4. Reference tables

### 4.1 Config keys

Every key, from [config.ts](../eden/src/config.ts) + [eden.example.json](../eden/eden.example.json).
The "one consumer" column names the module that will read it (M0 reads only `admin.port`,
`journal.*`, and indirectly `minecraft`/villager identity at validation time; the rest are
validated now, consumed M1+).

| Key | Type | Default | Consumer | Notes |
|---|---|---|---|---|
| `minecraft.host` | string | `127.0.0.1` | bots/ (M1) | |
| `minecraft.port` | number | `25599` | bots/ (M1) | dev server |
| `minecraft.version` | string | `1.21.1` | validation | R11 — warns if not the pin |
| `villagers[]` | `{name,role,home,chest}[]` | `[]` (warns) | bots/ (M1) | coords are hints; R12 names unique |
| `god.name` | string | `Dieu` | god/ (M3) | R12 — must differ from villagers + not `LLMBot` |
| `god.gamemode` | string | `creative` | god/ (M3) | |
| `god.authoring` | `villager`\|`god` | `villager` | god/ (M3) | who writes drafts |
| `god.desks.{critic,curriculum,orchestrator}.model` | `strong`\|`fast` | strong/strong/fast | god/ (M3) | |
| `god.budget.perDesk.<desk>.dailyTokens` | number\|null | `null` | god/ (M3) | null = uncapped (D-13) |
| `god.budget.degradeOnBreach` | boolean | `true` | god/ (M3) | |
| ~~`god.combineDesks`~~ | — | — | removed (D-19) | now an unknown key (R22 warning) |
| `god.embodiedVerdicts` | boolean | `true` | god/ (M3) | |
| `behavior.drives` | boolean | `false` | villagers/ (M4+) | |
| `llm.providers.{strong,fast}.baseUrl` | string | `''` | llm/ (M2) | |
| `llm.providers.{strong,fast}.model` | string | `''` | llm/ (M2) | |
| `llm.providers.{strong,fast}.inputTokenBudget` | number | 48000 / 16000 | llm/ (M2) | D-11 per-call input ceiling |
| `llm.maxConcurrent` | number | `3` | llm/ (M2) | **alias:** `maxConcurrency` (R22) |
| `llm.perVillagerCooldownSeconds` | number | `15` | llm/ (M2) | **alias:** `perVillagerCooldownSec` (R22) |
| `skills.runDefaultTimeoutMs` | number | `120000` | skills/ (M2) | |
| `skills.stallSeconds` | number | `20` | skills/ (M2) | D-10 no-pulse abort |
| `skills.maxCallDepth` | number | `8` | skills/ (M2) | |
| `skills.maxSkillLines` | number | `400` | skills/ (M2) | D-11 |
| `skills.probationRuns` | number | `3` | skills/ (M2) | D-12 |
| `skills.autoQuarantineAfter` | number | `5` | skills/ (M2) | |
| `settlement.url` | string | `http://127.0.0.1:8767/trade/execute` | social/ (M5+) | |
| `admin.port` | number | `8770` | **admin/ (M0)** | |
| `journal.vitalsIntervalSeconds` | number | `10` | journal/ (M1) | **alias:** `vitalsIntervalSec`; `<5` warns |
| `journal.debugPrompts` | boolean | `false` | llm/ (M2) | full transcripts to `.eden-data/llm/` |
| `journal.retentionDays` | number | `7` (**hardcoded**) | journal/ (M1) | **G1** — no config key yet; see §7 |

### 4.2 Journal kinds (from `KIND_REGISTRY`)

| Kind | Payload | Emitted by (M0) | Doc |
|---|---|---|---|
| `system.boot` | `{ config: object }` | `main.ts` (engine) | host start; config snapshot, secrets redacted |
| `system.config-warning` | `{ message: string }` | `main.ts` (engine) | an unknown/aliased key was adopted or ignored (R22) |
| `system.bot-connected` | `{ name: string }` | — (M1) | a bot finished spawning |
| `system.bot-disconnected` | `{ name: string; reason? }` | — (M1) | a bot dropped; reason if known |
| `system.error` | `{ message: string; stack? }` | — (host-level) | an unhandled/host-level error |
| `system.loop-lag` | `{ p99: number; max: number }` | `lag-monitor.ts` (engine) | event-loop stall spike — the D-07 canary |

`bot-connected`/`bot-disconnected` are defined now (the registry is complete) but have no M0
emitter — the bot pool that fires them is M1.

### 4.3 Admin routes (from `admin/server.ts`)

| Method | Path | Query params | Response shape |
|---|---|---|---|
| GET | `/status` | — | `{ uptimeMs, ...getStatus() }` (M0: `bots`, `runs`, `queues`) |
| GET | `/kinds` | — | `{ kinds: Array<{ kind, doc }> }` |
| GET | `/journal` | `kinds` (csv), `actor`, `ref`, `since`, `until`, `limit` | `{ events: JournalEvent[] }` |
| WS | `/journal/stream` | `kinds` (csv, optional filter) | one JSON `JournalEvent` per message, live |
| any | other | — | `404 { error: "no route <path>" }`; handler throw → `500 { error }` |

---

## 5. Test fakes

Test-only stand-ins under [eden/tests/fakes/](../eden/tests/fakes) — **never shipped**
(ESLint exempts `tests/**` from console + `any` rules, [eslint.config.js:28-34](../eden/eslint.config.js:28)).
They exist so the CI corpus runs with no Minecraft and no real LLM (D-10, R42). Their seams
are deliberately fixed in M0 so the M1/M2 tests can drive them without a rewrite.

**`MemoryJournal`** ([memory-journal.ts:8](../eden/tests/fakes/memory-journal.ts:8)) — an
in-memory `IJournal` with the same `append`/`query`/`subscribe` surface as the real `Journal`,
events kept in an array. Same query semantics, including the `ref`-matches-any-field rule and
the `limit` = most-recent-N slice ([memory-journal.ts:29-40](../eden/tests/fakes/memory-journal.ts:29)).
**Seam:** lets the D-07 and admin tests run without SQLite; both real and fake realize
`IJournal`, so consumers never know which they hold (S2).

**`FakeBot`** ([fake-bot.ts:48](../eden/tests/fakes/fake-bot.ts:48)) — a no-Minecraft
mineflayer stand-in. Seams it exposes:
- **M0 baseline:** `username`, `entity.position`, `inventory.items()`, an `EventEmitter`.
- **D-10 liveness:** `startPathUpdates(ms)` emits `path_update` on a timer *without moving*
  (the "long legit goTo" case); `setDigMode('never')` returns a never-resolving `dig` promise
  that still emits exactly one start pulse ([fake-bot.ts:97-126](../eden/tests/fakes/fake-bot.ts:97)).
- **R1–R3 (craft desync):** `currentWindow` + `clickWindow` route every click to the open
  window regardless of intent ([fake-bot.ts:138-142](../eden/tests/fakes/fake-bot.ts:138));
  `_client` emits `set_slot`/`window_items` packet seams (the genuine quiescence signal); and
  `autoEat`/`armorManager` hooks model the plugins the craft path pauses.
- **R10 (trunk vs floating leaves):** `plantTree(base, height, floating[])` builds a grounded
  trunk plus disconnected floating logs — the column-connectivity trap
  ([fake-bot.ts:159-165](../eden/tests/fakes/fake-bot.ts:159)).

**`ScriptedLlm`** ([scripted-llm.ts:20](../eden/tests/fakes/scripted-llm.ts:20)) — a
deterministic OpenAI-compatible endpoint (R42) on its own ephemeral port. Serves
`/v1/chat/completions` (canned tool-call / content turns dequeued in order, default-stop when
empty) and `/v1/embeddings` (a stable hash vector so cosine is reproducible). Records every
request in `.requests` for assertions. **Seam:** drives the M2 LLM client + embedding tests
with zero network nondeterminism.

**Pinned by.** [fakes.test.ts](../eden/tests/fakes.test.ts) (FakeBot path/dig/window/tree/
plugin seams + ScriptedLlm chat/embeddings) and, transitively, every suite that consumes them.

---

## 6. Extending M0

The recipes that apply *now*, against the files that exist. These mirror docs/08 — see it for
the full recipe set and the don'ts.

**Add a journal kind** (docs/08 "Add a journal kind"):
1. [journal/kinds.ts](../eden/src/journal/kinds.ts) — add the literal to `JOURNAL_KINDS`, a
   row to `KindPayloads` (else `PayloadOf` won't compile), and a row to `KIND_REGISTRY` (else
   `satisfies` won't compile).
2. The **one** writer module emits it via `append('<actor>', '<kind>', payload)` (S2).
3. Test: payload round-trip in the style of `journal.test.ts`'s
   `each registered kind round-trips its payload schema`.
4. Docs: §4.2 here + the kind table in docs/05.
   **Don't** add a "subtype" field to an existing kind — that's a branch in disguise.

**Add a config key** (docs/08 "Add a config key"):
1. [config.ts](../eden/src/config.ts) — add the field to the relevant `*Config` interface, a
   default in `DEFAULT_CONFIG`, the key to that section's `warnUnknown` list, and parse it with
   `num`/`bool`/`str` (or a typed helper). If it deprecates an old name, add an `ALIASES` row.
2. [eden.example.json](../eden/eden.example.json) — the key + a comment.
3. Exactly **one** consumer reads it via the typed config object.
4. Docs: §4.1 here + the config sketch in docs/01 if load-bearing.
   (This is the path that resolves **G1** — add `journal.retentionDays` to the interface,
   default, and `warnUnknown` list, then stop hardcoding it at [config.ts:293](../eden/src/config.ts:293).)

**Add an admin route** (docs/08 "Add an admin route"):
1. [admin/server.ts](../eden/src/admin/server.ts) — add a `case` to the `route` switch reading
   journal/derived views only; add a parse helper if it takes query params.
2. Test: a `getJson(...)` assertion in the style of `admin.test.ts`.
3. Docs: §4.3 here + the route table in docs/05.
   **Don't** mutate state from a route — M0's surface is read-only; sanctioned mutating verbs
   arrive with their owning subsystems and journal as `actor: 'admin'`.

---

## 7. Known gaps / deferred

- **G1 — retention key (open).** "Configurable 7-day retention" has **no config key**;
  `journal.retentionDays` is hardcoded to `7` ([config.ts:104,293](../eden/src/config.ts:104))
  and `journal`'s `warnUnknown` list omits it ([config.ts:286](../eden/src/config.ts:286)). An
  owner call is pending: add the key or keep 7d hardcoded. The "add a config key" recipe (§6)
  is the fix. Tracked in [eden.example.json:67-69](../eden/eden.example.json:67) and the
  implementation plan.
- **G2 — death journal kind (M1).** The R27 death-journal kind is not registered yet — it is
  M1 work, not an M0 gap.
- **Layers 2–3 not built.** No `bots/`, `skills/`, `llm/`, `god/`, `villagers/`, `social/`
  modules exist. The dependency-cruiser rules for them
  ([.dependency-cruiser.cjs:38-69](../eden/.dependency-cruiser.cjs:38)) are in place so they
  pass vacuously until those layers land.
- **No real bot yet.** The only bot is `FakeBot` (test-only). `system.bot-connected` /
  `system.bot-disconnected` are defined but have no emitter; `getStatus()` reports `bots: 0`.
  The bot pool, anchors, vitals, and the R1–R10 hardening corpus are M1.

The ordered build plan is [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) (M3 is the gate —
one villager must converge end-to-end before anything parallel is built). Session-by-session
status is [PROGRESS.md](PROGRESS.md).
