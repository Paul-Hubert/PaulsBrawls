# 04 — The villager runtime

A villager is: a mineflayer **bot** (body), a set of **subscriptions** (reactivity),
a **brain** (deliberation), a **memory**, and an **inbox**. Skills give it hands;
God gives it purpose.

```ts
interface Villager {
  name: string;                 // also the Minecraft username
  role: string;                 // 'farmer' | 'miner' | … flavor + default subscriptions
  bot(): Bot | null;            // null while disconnected; pool handles reconnect
  inbox: InboxMessage[];        // directives, critiques, tells — drained into context packs
  subscriptions: Subscription[];
  memory: VillagerMemory;
  anchors: { home: Vec3; chest: Vec3 };   // hints, self-healed (07 §World state)
  currentRun?: { runId: string; skill: string; startedAt: number };
}
```

## The event system

(Owner decision #7: subscribable, filterable events; auto-handled or escalated to
an LLM call with exactly the right context.)

### Normalization

`villagers/events.ts` listens to raw mineflayer/world signals and emits a closed
set of **normalized events**, each a typed object with a common envelope:

```ts
type EdenEvent =
  | { type: 'hurt';            attacker?: EntityRef; damage: number }
  | { type: 'entity-spotted';  entity: EntityRef }                    // enters perception radius
  | { type: 'entity-lost';     entity: EntityRef }
  | { type: 'player-chat';     from: string; text: string }
  | { type: 'villager-chat';   from: string; text: string }           // overheard bot speech
  | { type: 'inbox';           from: 'god' | string; kind: 'directive' | 'critique' | 'tell' }
  | { type: 'item-received';   item: string; count: number }
  | { type: 'health-low';      health: number }                       // hysteresis-edged
  | { type: 'night-falls' } | { type: 'new-day' } | { type: 'died' }
  | { type: 'run-finished';    report: RunReportRef }                 // own skill run ended
  | { type: 'block-broken-nearby'; block: string; by?: EntityRef }
  | { type: 'tick-30s' };                                             // coarse clock for polling subs

interface Envelope { at: number; villager: string; event: EdenEvent }
```

The set is intentionally small and growable; adding an event type is a normal PR
(types + emitter + docs), not an architecture change. Edge-style events
(`health-low`, `night-falls`) carry hysteresis in the *emitter* so subscribers
never need debounce logic.

### Subscriptions: filters as data

```ts
interface Subscription {
  id: string;
  villager: string;
  on: EdenEvent['type'];
  filter?: Filter;              // declarative — see below
  handler:
    | { kind: 'skill'; name: string; args: object | ArgTemplate }   // free, no tokens
    | { kind: 'deliberate'; hint: string; priority?: Priority };    // LLM escalation
  cooldownMs?: number;          // per-subscription refractory period
  source: 'role-default' | 'self' | 'god' | 'admin';
  enabled: boolean;
}

type Filter = {
  within?: number;                       // distance from self (entity/block events)
  entityKind?: ('hostile'|'player'|'villager'|'animal')[];
  nameMatches?: string;                  // substring/regex-lite on entity/item/block/text
  timeOfDay?: { from: number; to: number };
  healthBelow?: number; foodBelow?: number;
  notWhileRunning?: string[];            // suppress while these skills run (e.g. don't
                                         //   flee-interrupt the 'flee' skill itself)
};
```

Filters are **data, evaluated by the engine** — proximity, kind, name, time-of-day
clauses AND-composed. No predicate code in subscriptions (P5): they journal
legibly, render on the website, and can be written safely by LLM tool calls
(`subscribe` / `unsubscribe` / `list_subscriptions` in the brain's toolset) and by
God (`source: 'god'` — God wiring a reflex into a villager *is* an orchestration
move).

`ArgTemplate` lets a skill handler reference event fields without code:
`{ "target": "$event.entity.id" }` — the engine substitutes `$event.*` paths.

### Two outcomes

- **`kind: 'skill'`** — the engine calls `skills.run(name, args)` on the
  villager's bot, subject to the same serialization/supervision as any run.
  This is v1's "reflex," rebuilt: the *binding* is data, the *behavior* is a
  proven library skill. Zero tokens. A failing handler files a normal `RunReport`
  → critic tripwire; the subscription auto-disables only on God's quarantine of
  the underlying skill.
- **`kind: 'deliberate'`** — the event becomes a brain wake-up carrying a **context
  pack** (below). The `hint` seeds the prompt ("a player is talking to you about
  trade"). Priority maps to the v1 scheduler's lanes
  (`player > combat > conversation > directive > job > idle`), which carry over.

Role defaults seed each villager at first boot (guard: hostile-spotted →
`deliberate` high; farmer: new-day → skill `harvest-field` with home-field args;
everyone: hurt → skill `flee-to-safety`, player-chat within 8 → deliberate, inbox →
deliberate). Defaults are config data (`roles.json`), not code.

### Decision D-15: a role reflex OVERRIDES the everyone reflex on the same event

`everyone` says "hurt → flee-to-safety," but a **guard** must FIGHT when hit, not
flee — and the zero-token reflex path is exactly where that decision must live
(deferring to an LLM costs ~16 s, longer than a guard survives under fire; see
[R50](07-hard-won-lessons.md#reactivity)). So `seedRoleDefaults` treats a role
block as the **more specific policy**: a role spec on event *E* REPLACES every
`everyone` spec on *E* rather than stacking on top of it. The guard's
`hurt → defend-self` (a stock skill that finds the nearest hostile and composes
`kill-mob`, robust to a missing `$event.byEntity`) thus wins over the everyone flee,
and a guard never both flees and fights the same hit.

Two alternatives were rejected: making the guard reflex `kind:'deliberate'` (a
different handler kind, so the old same-kind dedup wouldn't drop it) reintroduces
the LLM latency the reflex exists to avoid; and keeping the old "skip the role spec
that duplicates an everyone spec" dedup is simply backwards for an override (it kept
the *general* rule and discarded the *specific* one). Per-event override is the
least-surprising semantics and needs no new mechanism — just the right dedup key
(`on`, not `on`+`handler.kind`). Re-entry is still bounded the normal way: the guard
reflex carries `notWhileRunning: ['defend-self']` (so a hit mid-fight doesn't restart
it) plus a short `cooldownMs` backstop.

## The brain

One deliberation = one LLM conversation: context pack → assistant turns with tool
calls → `done`. The shape is v1's agent-runtime, with the skill tools replacing
bespoke action tools.

**Toolset:**

| Group | Tools |
|---|---|
| Skills | `search_skills`, `read_skill`, `write_skill`, `run_skill` ([02 §Retrieval](02-skill-system.md#retrieval--prompting)) — mortal tier only: divine skills are invisible and unrunnable for villagers ([02 §Tiers](02-skill-system.md#tiers-mortal-and-divine)) |
| Reactivity | `subscribe`, `unsubscribe`, `list_subscriptions` |
| Social | `say` (French), `tell`, `start_conversation`, `leave_conversation` *(not built yet)*; trade: `propose_trade {to, give, want}`, `answer_trade {id, accept}`, `list_trades` (typed offers, consent per D-16; settlement unchanged from v1) |
| Memory | `remember`, `recall` |
| God | `report_to_god(text)` — progress, objections, pleas; lands in the critic/orchestrator queues |
| Control | `done(summary, mood?)` |

Direct micro-action tools (`go_to`, `dig`, …) **do not exist** — movement and work
happen through `run_skill` on library skills. This forces the library to stay the
single vocabulary of action (P2) and makes every world effect a journaled,
criticizable run.

### Decision D-16: a trade moves nothing until the partner accepts

`propose_trade` only puts a typed offer on the table (`TradeBook`, social/trade.ts): it journals
`trade.proposed` and wakes the partner on the conversation lane. The **partner's** `answer_trade {accept:true}`
is what settles it (R33 walk to the proposer, then the `:8767` POST). The proposer may withdraw; nobody else can
answer. Offers expire after 5 minutes; a proposer has at most 3 open; only roster villagers can be parties.

*Chosen over* letting `propose_trade` settle at once: the mod swaps two inventories atomically on request, so a
one-sided tool would let any villager take another's items. *Chosen over* negotiating inside a `Conversation`:
conversations aren't wired yet, and the offer object already carries everything settlement needs; a refusal plus
a new offer is the counter-offer. Declines, withdrawals and expiries close the ledger entry as `trade.failed`
with the reason (inventories untouched — the existing kind's meaning), so no new journal kind (S1).
The villager reaches the book through the `TradeDesk` seam in `types/social.ts` (villagers/ never imports social/).

**Conversations** keep v1's design wholesale (it worked): in-process inboxes,
turn-taking with deadlines and caps, chat mirrored to the game only when a player
is in earshot, structured `leave_conversation{opinion, note, headline}` feeding
relations and memory.

## The context pack

(Owner decision #7: "...propagates into an LLM call with a prompt, the memory
specific to what is happening, the context and everything it needs to know and the
past and the recent memory." Decision #10: render rich, like Voyager.)

`context-pack.ts` assembles every escalation deterministically — same inputs, same
prompt. Sections, in order:

1. **Identity & persona** — name, role, mood, standing orders from God's dossier.
   French-speaking persona rules.
2. **Trigger** — the event(s) that caused this wake-up, verbatim envelopes, plus
   the subscription `hint`. Coalesced wake-ups list all triggers.
3. **Situation snapshot** — the shared Voyager-style renderer
   ([02 §Retrieval](02-skill-system.md#retrieval--prompting)): biome, time, position,
   health/hunger, equipment, inventory, nearby entities nearest-first, nearby
   notable blocks, known chest contents.
4. **Current activity** — running skill run (or idle), active directive with God's
   `reason`, open task if any.
5. **Recent past** — the villager's last ~15 journal events (own runs, overheard
   chat, trades) — the "recent memory."
6. **Retrieved past** — memory retrieval (below) seeded by the trigger text +
   hint: relevant episodic memories, relations with involved parties, trade-ledger
   lines — the "memory specific to what is happening."
7. **Capabilities** — exemplar skills (full code) only when the wake-up plausibly
   involves authoring (directive/critique/task triggers); otherwise just retrieved
   skill one-liners. Tool list always.
8. **Pending inbox** — undelivered critiques/directives/tells, oldest first.

Budgeted assembly: each section has a token ceiling and a truncation rule; the pack
reports its own composition to the journal (`brain.wakeup` event includes section
sizes) so prompt bloat is measurable, not vibes.

## The action engine

- **One skill tree per bot** (D-05). The brain's `run_skill` waits or returns
  "busy" depending on a `wait: boolean` arg; directives with `interrupt` preempt.
- All supervision (stall, timeout, abort protocol) lives in the engine
  ([02 §Validation](02-skill-system.md#validation--runtime-supervision)); the brain
  never needs try/catch choreography — failures come back as tool-result error
  strings (immediate, Voyager-dense) *and* journal into the critic pipeline when
  they merit it.
- The hardening corpus ([07](07-hard-won-lessons.md)) is implemented once, in
  `bots/hardening.ts` + the exemplar skills, not re-derived per skill.

## Memory

Port v1's proven design with two simplifications; full spec stays
[VILLAGE_PLAN.md](../VILLAGE_PLAN.md)-adjacent, summarized here as the contract:

- **Episodic window** (~200 entries) → evicted batches fold into a persisted
  archive (cap 2000) + rolling life summary via one `fast` LLM call that also
  returns keyword enrichment, importance bumps, and up to two "lesson" insights.
- **Entries**: `{kind: event|social|trade|thought|system, text, tags, importance 0-10, at}`.
- **Retrieval** (feeds context-pack §6): `0.5·relevance + 0.25·recency + 0.25·importance`,
  relevance = max(multilingual-embedding cosine, keyword overlap); embeddings
  lazily batched off the hot path; three consecutive failures fall back to keywords-only.
- **Simplification 1:** drop v1's `refuteBlockedBeliefs` special-case — God's
  critique loop now owns belief correction (a verdict contradicting a stored
  "impossible" memory triggers a `remember` correction in the critique delivery).
- **Simplification 2:** mood/needs (rest/social drives) become optional config
  (`drives: true`) rather than core — they generate wake-ups, not architecture.

Relations (per-other-villager score + note) and the trade ledger carry over
unchanged; both are journal-derived views in Eden rather than separate stores.

## Scheduling

v1's scheduler survives with its vocabulary (global LLM concurrency cap, priority
lanes, per-villager cooldown, coalescing of same-kind wake-ups) and three Eden
amendments:

1. **God preempts** — desk calls outrank villager lanes
   ([03 §Cost control](03-god.md#cost-control)).
2. **Rollout immunity** — inside an open rollout, revision turns bypass coalescing,
   cooldown, and suppression entirely (the density invariant,
   [03 §Refinement loop](03-god.md#the-refinement-loop)) (see OQ-5 in
   [03 §Refinement loop](03-god.md#the-refinement-loop)).
3. **Suppression is curriculum's job** — the v1 "identical error → exponential
   suppression" memo is deleted. Repeated failure now surfaces as ledger/dossier
   signal that makes God *change the task or quarantine the skill*, instead of an
   engine silently swallowing wake-ups. The engine keeps only a dumb rate cap
   (max N wake-ups per villager per minute) as a circuit breaker. That cap honors
   R36's "every suppressor needs a release valve" by construction: it resets every
   minute, so it can throttle a burst but never become a permanent gag.
