# 05 — Observability

(Owner decision #9: "everything has to be logged and visible, because at some point
there should be a website that shows everything about the villagers, their skills,
what they're doing, in real time. But that's for later.")

The website is later. The **data feed for it is now**, because retrofitting
observability is the one thing you can't do to a running history. Eden's rule (P4):
*if it didn't journal, it didn't happen.*

## The journal

Append-only table in `eden.db` (SQLite, WAL). Every subsystem writes through one
function; an in-process pub/sub fans every appended event out to live consumers
(admin WebSocket, stat aggregators).

```ts
interface JournalEvent {
  id: string;            // ulid — sortable, unique
  at: number;            // epoch ms
  actor: string;         // 'villager:Firmin' | 'god:critic' | 'god:orchestrator'
                         // | 'engine' | 'admin' | 'player:<name>'
  kind: JournalKind;
  payload: object;       // JSON, schema per kind (journal/kinds.ts is the registry)
  refs: Partial<{        // causality — what this event belongs to
    runId: string; rolloutId: string; taskId: string; verdictId: string;
    directiveId: string; skill: string; skillVersion: number;
    conversationId: string; tradeId: string; llmCallId: string;
  }>;
}
```

`refs` is the load-bearing column: the website's "rollout view" is
`SELECT * WHERE refs.rolloutId = ? ORDER BY at` — no joins to invent later.
Indexes: `(at)`, `(actor, at)`, `(kind, at)`, plus expression indexes on the hot
refs (`runId`, `rolloutId`, `skill`).

### Kind registry (initial)

| Domain | Kinds |
|---|---|
| System | `system.boot`, `system.config-warning`, `system.bot-connected`, `system.bot-disconnected`, `system.error`, `system.loop-lag` (event-loop stall spike: `{ p99, max }` — D-07) |
| Skills | `skill.draft`, `skill.admit`, `skill.quarantine`, `skill.archive`, `skill.run` (the full `RunReport`), `skill.log` (in-run `ctx.log` lines) |
| God | `god.ticket`, `god.verdict`, `god.task-proposed`, `god.task-closed`, `god.directive`, `god.directive-closed`, `god.appearance` (body theatrics), `god.rollout-abandoned` (crash recovery — D-09) |
| Brain | `brain.wakeup` (trigger + context-pack section sizes), `brain.tool-call`, `brain.done` |
| LLM | `llm.call` (desk/villager, model, latency, prompt/completion tokens, finish reason — **never raw prompt bodies**; those go to per-call debug files when `debugPrompts: true`) |
| Social | `chat.said`, `chat.heard`, `conversation.started/turn/ended`, `trade.proposed/settled/failed`, `inbox.delivered` |
| World | `vitals` (per-bot snapshot every `vitalsIntervalSeconds`: pos, hp, food, held, current run); `world.death` (a bot died; `{ name, cause? }` from the `death_combat_event` packet — R27, **G2** owner call on name/shape pending) |
| Reactivity | `subscription.created/removed/fired/suppressed` |

Adding a kind = one entry in `kinds.ts` with a payload type + doc line. The admin
API exposes the registry so the website can render unknown kinds generically.

> **G2 (owner call, pending) — `world.death` name/shape.** R27 requires the bot pool to
> journal the authoritative cause of every death from the `death_combat_event` packet, but the
> initial kind registry had no row for it. M1 provisionally added **`world.death` `{ name, cause? }`**
> (built + tested in `bots/pool.ts`) under S8, flagged here because a *new kind* is a registry
> decision the owner may want to name/shape differently (e.g. fold into
> `system.bot-disconnected{cause}` instead). The behavior is live; only the name/shape is open.

> **As-built (M3).** The Brain, God (critic), and Social-`inbox.delivered` kinds named above are now
> implemented, each as one row in [`journal/kinds.ts`](../eden/src/journal/kinds.ts) with a payload type
> + doc line + the pinning test (S1) — no new kinds beyond the frozen design (no doc-drift). Payloads:
> `brain.wakeup {villager, triggers, sections, totalTokens, trimmedPairs, tier}` (D-11 section sizes),
> `brain.tool-call {villager, tool, ok}`, `brain.done {villager, summary, mood?, toolCalls}`;
> `god.ticket {source, skill?, version?}`, `god.verdict {ticketId, success, libraryAction, score?, critique}`,
> `god.appearance {villager, action, ok}` (a body action also journals a `skill.run`; `ok:false` when the
> avatar is down — theatrics are never a dependency), `god.rollout-abandoned {reason:'crash-recovery', taskId}`
> (D-09); `inbox.delivered {to, from, kind}` (journaled *before* the villager reads it). The remaining
> God rows (`god.task-*`/`god.directive-*`), Reactivity, and the rest of Social land in M4/M5/M6.

> **As-built (M4).** The four remaining God rows are now implemented (curriculum + orchestrator desks),
> each one row in [`journal/kinds.ts`](../eden/src/journal/kinds.ts) + payload type + doc line + the
> pinning test (S1) — all already named in the table above, so **no doc-drift**. Payloads:
> `god.task-proposed {taskId, goal, assignee?, trigger, parent?}` (the Curriculum desk — the SOLE WRITER
> of the ledger, S2 — proposes a task; `trigger` is idle/verdict-close/dawn/critic-follow-up/admin,
> `parent` ties a decomposed sub-task to its goal); `god.task-closed {taskId, goal, outcome}` where
> `outcome` ∈ completed/failed (a verdict closed it) / retired (Voyager clean_up_tasks dropped a stale
> `failed` once a later task completed the same goal); `god.directive {directiveId, to, goal, priority,
> superseded?}` (the Orchestrator desk — the SOLE WRITER of directivesOpen, S2 — opened a directive +
> delivered it to the inbox; `superseded` lists anti-thrash-displaced directive ids); `god.directive-closed
> {directiveId, to, reason}` where `reason` ∈ completed/expired/superseded. Reactivity and the rest of
> Social land in M5/M6.

> **As-built (M5).** The four Reactivity rows are now implemented (the event router + subscription store),
> each one row in [`journal/kinds.ts`](../eden/src/journal/kinds.ts) + payload type + doc line + the
> pinning test (S1) — all already named in the table above, so **no doc-drift**. The SubscriptionStore is
> the SOLE WRITER of subscription state (S2). Payloads: `subscription.created {id, villager, on, handler,
> source}` (`handler` ∈ skill/deliberate, `source` ∈ role-default/self/god/admin — a "when X, do Y" reflex
> as DATA, P5); `subscription.removed {id, villager}`; `subscription.fired {id, villager, on, outcome,
> target}` where `outcome` ∈ skill (a zero-token `SkillEngine.run`) / deliberate (a brain wake-up) and
> `target` is the skill name or the deliberation hint — **one of the two windowed high-volume kinds**
> (Retention, below); `subscription.suppressed {id, villager, on, reason}` where `reason` ∈
> cooldown/disabled/not-while-running (a matched-but-throttled event — suppression is information, not
> silence, R36). A normalized event matching N deliberate subscriptions escalates EXACTLY ONE coalesced
> wake-up (R36: one incident → one wake-up; the router owns the escalation, every match still journals
> `subscription.fired`). The router journals nothing per raw signal — normalization is pulse-adjacent
> (R44); only the routed SUMMARY (`subscription.fired`) reaches the journal. Conversation/trade Social rows
> land in M6.

> **As-built (M6).** The eight remaining Social rows are now implemented (memory + conversation + trade),
> each one row in [`journal/kinds.ts`](../eden/src/journal/kinds.ts) + payload type + doc line + the
> pinning test (S1) — all already named in the Social table row above, so **no doc-drift**.
> `inbox.delivered` was already M3 and is NOT re-added. Payloads:
> `chat.said {from, to, text}` (a villager spoke a line; `refs.conversationId` when in a conversation);
> `chat.heard {hearer, from, text, eavesdrop}` (the addressee OR an eavesdropper in earshot heard it —
> eavesdroppers get a free memory entry, 04, `eavesdrop:true`); `conversation.started {id, initiator,
> partner, topic?}`; `conversation.turn {id, speaker, turn}`; `conversation.ended {id, by, reason, opinion?,
> headline?}` where `reason` ∈ left/turn-cap/deadline/partner-gone (the structured `leave_conversation`
> opinion+headline ride along, having moved relations + seeded a high-importance memory for BOTH parties).
> Trade (typed offer objects, settled via the mod at `settlement.url`; `coin` → `paulsbrawls:coin`):
> `trade.proposed {id, from, to, give, want}` (an offer was put on the table), `trade.settled {…}` (the
> mod swapped inventories atomically — the 2xx happy path), `trade.failed {id, from, to, reason}` (non-2xx /
> network / re-validation reject — inventories UNTOUCHED; the cause named, S10). **VillagerMemory is the
> SOLE WRITER of one villager's memory state** (window/archive/relations/rolling life summary, persisted
> under `.eden-data/bots/<name>.json`'s `memory` key, S2); **R32** is honored there — a persisted store
> whose world-id differs from the current world is QUARANTINED behind an admin decision (wipe | migrate),
> not silently used and not silently dropped (the quarantine journals a `system.config-warning`). The
> **MemorySummarizer** runs ONE fast-tier `llm.call` on eviction (D-13), off the hot path. **R37 is dropped
> here** — the critic owns belief retirement at verdict delivery (no `refuteBlockedBeliefs` in memory).
> Optional M6-4 drives (`behavior.drives`) generate `tired`/`lonely` wake-ups via an injected callback
> (no new journal kind, no per-tick stream — R44), so they add no Social row.

> **As-built (M7).** The complete admin surface + the derived views + the `eden rebuild-stats` CLI are now
> implemented — **and M7 added NO new journal kind** (S1: it READS + FOLDS existing ones; the registry is
> unchanged from M6). The derived `views/` ([`eden/src/views/index.ts`](../eden/src/views/index.ts)) are
> LAYER-1 folds (a new `views-only-journal-types` dependency-cruiser rule pins them to journal/ + types/
> only): `SkillStatsView` (from `skill.run`), `CompetenceView` (per-villager × skill from `skill.run` —
> the journal-pure variant; God's dossier still folds *tag* competence from the live library, since tags
> aren't in the journal), `RelationsView` (from `conversation.started`/`conversation.ended` leave
> opinions), `TradeLedgerView` (from `trade.proposed/settled/failed`). Each subclasses a `DerivedView`
> with `fold(event)` + `rebuildByReplay(journal)`; **rebuild-by-replay == the live fold** is the M7
> deliverable (P4/S2 derived-state), proven in `tests/views.test.ts` + `tests/rebuild-stats.test.ts`. The
> `AdminServer` now serves EVERY route in the table below — `/villagers[/:name]`, `/skills[/:name]?version=
> &code=`, `/tasks`, `/verdicts`, `/directives` (GET) and `/pause`, `/resume`, `/skills/:name/quarantine`,
> `/villagers/:name/prompt` (POST) — over narrow accessor functions main.ts wires (the admin holds no
> concrete subsystem; it stays deletable). **Every mutating verb journals what it did
> (`actor:'admin'` | `player:<from>`) BEFORE acting**: `pause`/`resume` journal a `system.config-warning`
> then gate the LLM scheduler (skills/subscriptions keep running — the scheduler pause holds only LLM
> wake-ups); `quarantine` journals `skill.quarantine{actor:'admin'}` then calls the library; `prompt`
> journals `inbox.delivered{kind:'tell'}` (actor `player:<from>`) BEFORE the inbox delivers — zero engine
> machinery, the "talk to a villager" box. An unknown subject 404s WITHOUT a stray journal entry; an
> unwired control reports 503. The eval-harness port (R42) lives under [`eden/eval/`](../eden/eval/) (own
> scripted mock LLM, RCON-idempotent fixtures, ambient-suppression `EvalBot`-prefixed roster, per-bot
> EXCLUSIVE seed collision guard); the v1 decommission + parity sign-off is
> [17-parity-signoff.md](17-parity-signoff.md).

> **As-built (post-M7 — website API gaps).** Designing the future website surfaced three command-bar/
> dashboard needs the M7 routes couldn't serve. Resolution kept the pure-consumer posture (reads fold the
> journal; add surface only where existing routes can't express it): (1) **`RolloutsView`** — a FIFTH
> derived view in [`views/index.ts`](../eden/src/views/index.ts) (now in `ALL_VIEWS`, so the rebuild==live
> law + `eden rebuild-stats` cover it), folding the `refs.rolloutId`-tagged stream into a per-rollout index
> with status `open|admitted|exhausted|abandoned` (`admitted` from a `success` verdict, `abandoned` from
> `god.rollout-abandoned`, `exhausted` from `god.task-closed{outcome:'failed'}` since retries-exhausted has
> no per-rollout terminal event) — surfaced as **`GET /rollouts`**; the replay stays `GET /journal?ref=`.
> (2) **`GET /journal?id=<ulid>`** — a one-event resolver for the command bar (`JournalQuery.id`); no new
> `/resolve` route (names resolve client-side against `/villagers`+`/skills`, ulids via `?ref=`/`?id=`).
> (3) **Budget history** is NOT an API gap — it folds `llm.call` (token-bearing, retained forever) on the
> client; `/status` keeps the live spend. NO new journal kind (S1 — reads + folds existing ones).

### Retention

The journal is the history product, so default is **keep everything**;
`vitals` and `subscription.fired` (the two high-volume kinds) get a configurable
rolling window (default 7 days) with downsampled aggregates kept forever.
SQLite handles this comfortably, but the write path is not free: `better-sqlite3`
is synchronous and shares the one event loop with all 11 bots' packet processing.
The backpressure posture for that shared loop is settled — see **D-07** below.

> **Resolved: see D-07.** (Was OQ-6 — journal/event-loop backpressure.)

### Decision D-07: synchronous journal, in-memory pulses, lag monitor as the canary

**Chosen:** the journal writes **synchronously** through `better-sqlite3` in WAL
mode with `PRAGMA synchronous=NORMAL`, on the shared event loop. Three rails keep
that cheap and safe:
1. **Pulses are in-memory counters, never a `JournalKind`.** The stall detector
   reads pulse state from RAM, so the 20 Hz × 11-bot liveness stream (position
   delta, pathfinder liveness, dig/place) never reaches the journal. This removes
   the single highest-frequency stream from journal volume by construction.
2. **`RunReport` payloads stay small** — Voyager-rendered before/after snapshots,
   not raw world dumps — so the one INSERT per skill run is a small row.
3. **The event-loop lag monitor is the backpressure *signal*** (R40), ported
   verbatim from v1's `monitorEventLoopDelay({ resolution: 20 })`
   ([main.ts:146](../minecraft-mcp-server/src/village/main.ts)): warn at
   `max ≥ 1000 ms`, debug at `p99 ≥ 100 ms`, reset every 60 s. On a warn it
   appends a `system.loop-lag` event (`actor: 'engine'`, payload `{ p99, max }`).

`vitalsIntervalSeconds = 10` (1.1 events/s across 11 bots). No write-rate cap, no
pulse-volume bound, no async write queue, no writer isolation in v0.

**Rejected:**
- *Async batched write queue from day one* — buys throughput margin nobody has
  measured a need for, strains S5 (an in-process queue between modules), and trades
  P4: any event still in the buffer at `kill -9` is lost ("it happened, it didn't
  journal").
- *Isolating the journal writer in its own worker/process* (an append queue feeds
  it) — survives a host crash and never blocks the bot loop, but pre-commits OQ-3's
  journal-isolation facet, adds cross-boundary RPC on every append, and is the
  deferred escape hatch ([08 §Scaling](08-extension-recipes.md#scaling-escape-hatches--pre-decided-so-nobody-panics-later) #3), not a v0 need.

**Why:** making pulses in-memory removes the highest-frequency stream from the
journal entirely; what remains is **~3–10 events/s averaged** — `vitals` is 1.1/s,
`brain.*`/`skill.run`/social events are gated by `maxConcurrent: 3` and the 15 s
per-villager cooldown, and the two genuinely high-volume kinds (`vitals`,
`subscription.fired`) are already windowed by Retention. A small-row WAL INSERT at
`synchronous=NORMAL` costs **low tens of microseconds** (fsync deferred to
checkpoint), so even hundreds/sec is single-digit-% loop time. The simple,
S5-clean, P4-honest path is therefore also the correct one. The real risk is a
*burst* — a large payload row or a WAL checkpoint stall — and the lag monitor is
exactly the instrument that catches it: the same monitor v1 wrote after the
keepalive cascade taught it that a frozen host blames the network (R40). Instrument
first; build the escape hatch on evidence, not anticipation (the spirit of S9).

**Consequence:** `journal/journal.ts` opens the DB with
`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL`, and is the sole writer (S2).
The lag monitor lives in `main.ts` (the one composition root allowed to import
everything) and journals `system.loop-lag` on a spike — at most once per 60 s reset
window, so negligible self-induced volume. The lag threshold is **hardcoded to
v1's value (1000 ms), not a config key** — nothing else reads it, so per S7 it
stays out of `eden.json`. If the monitor ever reports sustained spikes traceable to
journal writes, the pre-decided next step is the async queue, then writer isolation
([08 §Scaling](08-extension-recipes.md#scaling-escape-hatches--pre-decided-so-nobody-panics-later)) — both contained changes. The new invariant
("never journal a per-tick stream") is captured as **R44**. Testable on the M0
in-memory-journal harness: inject a synthetic 1.2 s synchronous block, assert one
`system.loop-lag` event with `max ≥ 1000`; assert that driving the stall detector's
pulse path emits **zero** journal events.

## Derived state, not duplicate state

Skill stats, dossier competence rates, relation scores, the trade ledger, "what is
everyone doing right now" — all are **aggregations over journal events**, cached in
their own tables and rebuildable by replay (`eden rebuild-stats`) — **derived views
only; live state is never event-sourced** (see
[01 §Startup](01-architecture.md#startup-sequence): 'replay nothing'), which is what
keeps this consistent with S5's ban on event-sourcing for live state. The discipline:
writers append facts; readers fold facts into views. This is what makes the future
website trustworthy — it renders the same facts the system acted on.

## Admin API (v0, ships with M0–M7)

Localhost HTTP on `admin.port` (default 8770), no auth (same posture as v1; a token
gate is a config flag away when the website goes non-local). **As of M7 every route
below is implemented** (the M0 skeleton served `/status` `/journal` `/kinds` + the WS;
M7 added the rest) — see the "As-built (M7)" note above for the wiring.

| Route | Returns |
|---|---|
| `GET /status` | uptime, bots connected, current runs, queue depths, budget spend |
| `GET /villagers` / `GET /villagers/:name` | identity, vitals, subscriptions, inbox depth, current run, dossier summary |
| `GET /skills` / `GET /skills/:name` | manifests + stats; `?version=` for history; `?code=1` includes source |
| `GET /tasks` / `GET /verdicts` / `GET /directives` | ledger views with refs |
| `GET /rollouts` | the rollout index (RolloutsView fold): `{rolloutId, taskId?, villager?, skill?, status, trials, startedAt, endedAt}` per rollout — the navigation entry point for the replay view (the replay itself is `GET /journal?ref=<rolloutId>`) |
| `GET /journal?kinds=&actor=&id=&ref=&since=&limit=` | filtered event page (the universal debugger); `id=` resolves one event by ulid (the command bar's id-resolution path) |
| `GET /journal/stream` (WebSocket) | live fan-out of every appended event, same JSON as rows; optional `?kinds=` filter |
| `POST /pause` `POST /resume` | gate LLM scheduling (skills/subscriptions keep running — v1 semantics) |
| `POST /skills/:name/quarantine` | admin kill switch, journaled as `actor: 'admin'` |
| `POST /villagers/:name/prompt` | inject `{ text, from? }` as an `inbox` event (`kind: 'tell'`) — the villager hears it like any tell and deliberates. The website's "talk to a villager" box; zero engine machinery, journaled before delivery |

The future website is **a pure consumer of exactly these routes** — snapshot via
REST, live via the WebSocket stream, and (it is *not* read-only) interaction via
the POST verbs: the same rule that ships the data feed in v0 ships the control
rail in v0. A website control that needs a verb this table doesn't have is an API
gap to fix here, not website code. Every mutating verb journals what it did
(`actor: 'admin'` or `player:<name>`) before doing it, so the dashboard's own
pokes show up in the history it renders.

## Logging conventions

- Human logs (`logs/eden-*.log`) remain for operators: one line per significant
  journal event, v1's format habits kept (per-villager debug streams, `act … ok in
  Nms` timings — the [debugging playbook](07-hard-won-lessons.md#reading-failures)
  depends on them).
- `console.*` is banned outside `logger.ts` (v1's stdout-purity lesson — even
  without an MCP stdio transport, mineflayer deps are chatty and log hygiene
  saved hours).
- LLM prompt/completion bodies: not in the journal (size, secrets-adjacent). When
  `debugPrompts: true`, full transcripts write to
  `.eden-data/llm/<llmCallId>.json`, referenced from the `llm.call` event — the
  eval harness and post-mortems read them by ref.
