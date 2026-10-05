---
id: eden.villagers.runtime
title: Eden villager runtime — events, subscriptions, brain, tools, context pack, inbox
system: eden
summary: How an Eden villager reacts and thinks — the closed event set, hysteresis, subscription filters/outcomes, roles.json, drives, the brain loop, its 11 LLM tools, the 8-section context pack, and the inbox.
tags: [eden, villagers, events, subscriptions, roles, reactivity, brain, tools, context-pack, inbox, drives, hysteresis, R36, R20, R60, D-11, D-15]
sources: [eden/src/villagers/events.ts, eden/src/villagers/subscriptions.ts, eden/src/villagers/role-defaults.ts, eden/roles.json, eden/src/villagers/reactivity.ts, eden/src/villagers/drives.ts, eden/src/villagers/brain.ts, eden/src/villagers/tools.ts, eden/src/villagers/context-pack.ts, eden/src/villagers/inbox.ts, eden/src/bots/signals.ts, eden/src/main.ts, eden/src/types/events.ts, eden/src/types/inbox.ts, eden/src/llm/scheduler.ts, eden/src/render/tokens.ts, eden/src/journal/kinds.ts, eden/src/config.ts, eden/src/god/god.ts, eden/src/god/orchestrator.ts, eden/src/admin/server.ts, eden/tests/villagers-events.test.ts, eden/tests/villagers-routing.test.ts, eden/tests/villagers-subscriptions.test.ts, eden/tests/villagers-role-defaults.test.ts, eden/tests/villagers-host-reactivity.test.ts, eden/tests/villagers-brain.test.ts, eden/tests/villagers-tools.test.ts, eden/tests/villagers-context-pack.test.ts, eden/tests/villagers-drives.test.ts, docs/04-villager-runtime.md]
verified_at: 4a8081f
---

# Eden villager runtime — events, subscriptions, brain, tools, context pack, inbox

**TL;DR.** A villager reacts through a pipeline: mineflayer signals → per-bot signal adapter (`bots/signals.ts`) →
`EventRouter` (normalizes into the closed `EdenEvent` union, hysteresis in the emitter) → `SubscriptionRouter`
(declarative AND-filters; outcome = zero-token **skill** run or ONE coalesced **deliberate** wake-up, R36).
A deliberation is one `Brain.deliberate` call: an 8-section context pack + up to 16 LLM tool turns over **11 tools**
(skill tools, memory, subscriptions, `report_to_god`, `done`) — there are **no direct micro-action tools**.
God talks to a villager only through its `Inbox`. **In a live boot only `hurt`, `health-low`, `died` and `tick-30s`
actually fire** (see Gotchas) — most role defaults are inert today.

## Component map

| Piece | File | Role | Instances |
|---|---|---|---|
| Signal adapter | `eden/src/bots/signals.ts:56` | mineflayer `health`/`death` → synthetic `entityHurt`/`health`/`death` on a fresh bus | one per (re)spawned bot |
| `EventRouter` | `eden/src/villagers/events.ts:79` | raw signal → `Envelope{at, villager, event}`; emitter registry + hysteresis latches | one per villager bot |
| `SubscriptionRouter` | `eden/src/villagers/events.ts:299` | match → suppress → route (skill run / coalesced wake-up) | one per villager bot |
| `SubscriptionStore` | `eden/src/villagers/subscriptions.ts:55` | sole writer of subscription state (S2), persistence, cooldown clock | ONE shared per host |
| `FilterEvaluator` | `eden/src/villagers/subscriptions.ts:218` | clause registry, AND-composition | per router |
| `loadRoles`/`seedRoleDefaults` | `eden/src/villagers/role-defaults.ts:46`, `:72` | first-boot seeding from `eden/roles.json` | boot |
| `VillagerReactivity` | `eden/src/villagers/reactivity.ts:46` | assembles adapter + both routers per villager, reconnect-safe | ONE per host (only with a live pool) |
| `DriveTracker` | `eden/src/villagers/drives.ts:52` | optional rest/social decay → `tired`/`lonely` wake-ups | **not instantiated by main.ts** |
| `Brain` | `eden/src/villagers/brain.ts:73` | one deliberation = one scheduler slot, multi-turn tool loop | ONE per host (stateless) |
| `ToolRegistry` | `eden/src/villagers/tools.ts:76` | the 11 villager tools; `dispatch` never throws | ONE shared per host |
| `ContextPackBuilder` | `eden/src/villagers/context-pack.ts:133` | 8 sections, ceilings, density payload, journals `brain.wakeup` | ONE per host |
| `VillagerInbox` | `eden/src/villagers/inbox.ts:13` | concrete `Inbox`; deliver journals first | one per villager |

Wiring lives entirely in `eden/src/main.ts` `wireGod` (`eden/src/main.ts:486-697`); the pool's spawn hook calls
`reactivityRef.current?.attach(name, bot)` on every (re)spawn (`eden/src/main.ts:206`), and a 30 s `setInterval` (unref'd)
pumps `reactivity.tick()` (`eden/src/main.ts:221`).

## Event normalization (`villagers/events.ts`)

### The closed event set

The union is fixed in `eden/src/types/events.ts:8-22`. The `EventRouter` registry (`eden/src/villagers/events.ts:138-226`) maps a raw
signal name to a pure mapper. "Live source" = does anything in a real boot emit that raw signal?

| `EdenEvent.type` | Payload (exact fields) | Raw signal (registry row) | Mapper notes | Live source today |
|---|---|---|---|---|
| `hurt` | `damage: number`, `byEntity?: string` | `entityHurt(self, {damage, byEntity})` | `damage` defaults 0 (`eden/src/villagers/events.ts:142-148`) | **yes** — adapter synthesizes it from a health decrease; `byEntity` = nearest hostile's bare name (`eden/src/bots/signals.ts:61-71`) |
| `player-chat` | `player: string`, `text: string` | `chat(from, text, meta)` with `meta.isVillager` falsy | `eden/src/villagers/events.ts:151-157` | no |
| `villager-chat` | `villager: string`, `text: string` | `chat(from, text, {isVillager:true})` | same row | no |
| `entity-spotted` | `entity: string` (`name:id` or `name`), `distance: number` | `entitySpotted(entity)` | `refOf()` `eden/src/villagers/events.ts:241`; distance default 0 | no |
| `entity-lost` | `entity: string` | `entityGone(entity)` | `eden/src/villagers/events.ts:166-169` | no |
| `item-received` | `item: string`, `count: number` | `itemReceived(item)` | count default 1 | no |
| `block-broken-nearby` | `block: string` | `blockBrokenNearby(block)` | `eden/src/villagers/events.ts:177-180` | no |
| `died` | `byEntity?: string` (never set by the mapper) | `death` | `eden/src/villagers/events.ts:181-184` | **yes** (`eden/src/bots/signals.ts:72`) |
| `run-finished` | `skill: string`, `ok: boolean` | `runFinished(report)` | `ok = report.ok === true` | no |
| `inbox` | none | `inbox` | `eden/src/villagers/events.ts:192-195` | no (nothing emits it; see Inbox) |
| `health-low` | `health: number` | `health` (reads `bot.health`) | hysteresis edge | **yes** (`eden/src/bots/signals.ts:70`) |
| `night-falls` | none | `time` (reads `bot.time.timeOfDay`) | hysteresis edge | no |
| `new-day` | `day: number` | `time` | edge; `day = floor(timeOfDay/24000)` | no |
| `tick-30s` | none | not a signal — `EventRouter.tick()` | `eden/src/villagers/events.ts:124-126` | **yes** — host `setInterval(30_000)` |

Every emitted event is wrapped `{ at: now(), villager, event }` (`eden/src/villagers/events.ts:129-131`). The router journals nothing
(R44 — normalization is pulse-adjacent); journaling is the `SubscriptionRouter`'s job.

### Hysteresis (edge events)

| Edge | Constant | Fires when | Re-arms when | Code |
|---|---|---|---|---|
| `health-low` | `DEFAULT_HEALTH_LOW = 6` (override `healthLowThreshold`; host never overrides) | `bot.health < 6` and latch armed (missing health reads as 20) | a `health` signal with `health >= 6` | `eden/src/villagers/events.ts:60`, `:200-211` |
| `night-falls` | night = `13000 <= t < 23000` on the 0..24000 clock (`NIGHT_FROM`/`NIGHT_TO`) | phase day→night | n/a (phase tracking) | `eden/src/villagers/events.ts:58-59`, `:215-224`, `:230-233` |
| `new-day` | same band | phase night→day | n/a | same |

The first `time` observation only records the phase (no boot edge). Starting already low fires `health-low` once,
not repeatedly (`eden/tests/villagers-events.test.ts:110`).

### Signal adapter (`bots/signals.ts`)

Why it exists: mineflayer's native `entityHurt(entity)` fires for every entity with no damage/attacker; the router
would emit spurious damage-0 `hurt`s. So the router attaches to a fresh `EventEmitter` bus instead of the bot
(`eden/src/bots/signals.ts:8-12`). Scope is explicitly limited to `hurt` + `health` + `death` (`eden/src/bots/signals.ts:14-18`). The first
`health` observation sets the baseline (no hurt at spawn); food-only `health` ticks forward `health` but no
`entityHurt`. Its hostile table (`eden/src/bots/signals.ts:28-33`, 27 names) is broader than the `FilterEvaluator`'s (19 names).

## Subscriptions (`villagers/subscriptions.ts`)

A `Subscription` (`eden/src/types/events.ts:66-75`) is data: `{ id (ulid), villager, on: EventType, filter?, handler,
cooldownMs?, source: 'role-default'|'self'|'god'|'admin', enabled }`. No predicate code (P5).

### Store

| Method | Behaviour | Journal |
|---|---|---|
| `add(spec)` (`:72`) | assigns monotonic ulid, `enabled` default true, persists | `subscription.created {id, villager, on, handler: kind, source}` |
| `remove(id)` (`:96`) | deletes + clears cooldown, persists | `subscription.removed {id, villager}` |
| `setEnabled(id, b)` (`:107`) | toggles + persists | none |
| `list(villager)` / `get(id)` | reads | — |
| `markFired(id)` / `inCooldown(id)` (`:125-136`) | in-memory last-fired clock; no `cooldownMs` → never in cooldown | — |

Persistence: `<dataDir>/subscriptions/<villager>.json` (a JSON array of `Subscription`), i.e.
`.eden-data/subscriptions/<name>.json` (`:139-147`). Load scans every `*.json` there at construction; a corrupt file is
skipped. **Cooldowns are not persisted** (restart clears them).

### Filter clauses (AND-composed)

`FilterEvaluator.matches` iterates only the keys present; absent/undefined filter = always matches; unknown keys are
ignored (`:220-228`). Registry `CLAUSES` at `:191-215`:

| Clause | Type | Semantics |
|---|---|---|
| `within` | number | distance ≤ value. **Only `entity-spotted` carries a distance**; for every other event the clause passes (`:192-196`, `:306-309`) |
| `entityKind` | string | classify the event's entity name into `villager` (`villager`, `wandering_trader`) / `hostile` / `animal` / else **`player`**. Non-entity events → **false** (`:197-201`, `:268-282`) |
| `nameMatches` | string | case-insensitive substring of a per-event haystack: entity ref, item, block, `"<player> <text>"`, `"<villager> <text>"`, skill name; other events `''` (`:202-206`, `:285-303`) |
| `timeOfDay` | `'day'\|'night'\|'dawn'\|'dusk'` | phase of `ctx.timeOfDay`: dawn `t>=23000 \|\| t<1000`; dusk `11500<=t<13000`; night `13000<=t<23000`; else day (`:312-318`) — the night band is identical to the emitter's (`13000<=t<23000`); dawn and dusk are carved out of what the emitter calls day |
| `healthBelow` | number | `ctx.health < value` |
| `foodBelow` | number | `ctx.food < value` |
| `notWhileRunning` | string[] | passes iff none of the named skills is in `ctx.runningSkills` — treated as a **suppression**, not a match clause (below) |

`FilterContext` (`:174-182`) = `{ selfPos, timeOfDay, health, food, runningSkills }`, supplied live by main.ts's
`vitalsFor` (`eden/src/main.ts:674-684`; defaults when the bot is absent: pos `[0,64,0]`, time 1200, health 20, food 20;
`runningSkills = engine.runningSkills(villager)`).

### Arg templates

`substituteArgs` (`:238-244`): a skill handler arg whose value is a string starting `$event.` is replaced by that
dotted path into the event (e.g. `"$event.byEntity"`); unresolved → `undefined`, never throws. Other values pass through.

### Routing algorithm (`SubscriptionRouter.route`, `eden/src/villagers/events.ts:308-347`)

For each subscription of this villager whose `on === event.type`:

1. **Applies?** — evaluate the filter **minus** `notWhileRunning`. Miss → silent skip (no journal).
2. **Suppressed?** — first matching reason: `disabled` → `cooldown` → `not-while-running`. Journals
   `subscription.suppressed {id, villager, on, reason}` and skips (`:379-387`).
3. **Route** — `markFired(id)` (starts cooldown) and journal `subscription.fired {id, villager, on, outcome, target}`
   (`target` = skill name or hint). Then:
   - `kind:'skill'` → `engine.run(name, substituteArgs(args), runner)` — **zero tokens**. A failed run still files a
     RunReport via the engine; a pre-execution throw (not found / tier / grant) journals `system.error` with
     `subscription <id> skill "<name>" could not run: …` (`:363-376`).
   - `kind:'deliberate'` → collected.
4. All skill runs are awaited in parallel, then **at most ONE** coalesced wake-up (R36) is sent:
   `WakeupRequest { villager, triggers: ["évènement <type>: <json>"], hints: [all hints], lane, event }` where `lane` is
   the highest among matched subs (`:350-360`, `:413-415`).

Priority → scheduler lane (`eden/src/villagers/events.ts:291-295`): `interrupt → combat`, `normal`/omitted `→ conversation`,
`background → idle`. Lane rank `god < player < combat < conversation < directive < job < idle` (lower = higher
priority; `eden/src/llm/scheduler.ts:15-16`).

Routing is fire-and-forget at the emit site; a rejected `route()` is only `logger.warn`ed (`eden/src/villagers/reactivity.ts:81-86`).

### The reactive wake-up (main.ts `wakeup`, `eden/src/main.ts:633-671`)

Builds a **fast-tier** context pack and calls `brain.deliberate(input, { lane: req.lane, kind: 'reactive' })`:
query = `triggers + hints`; `retrievedSkills = retriever.search(query, {tier:'mortal', k: 8})`; §6 =
`memory.retrieve(query, 5)`; `hint = hints.join(' / ')`; `includeExemplarCode: false`; `recentEvents: []`;
`directive/openTask: null`; **`inbox: []` (does not drain the inbox)**; `inputTokenBudget =
config.llm.providers.fast.inputTokenBudget`. Errors are swallowed to `logger.warn`.

## Role defaults (`eden/roles.json` + `role-defaults.ts`)

### Schema

JSONC (comments + trailing commas tolerated via `strip-json-comments`). Top level is an object: `everyone` plus any
role names, each an array of `RoleDefaultSpec { on: EventType, handler: SubscriptionHandler, filter?, cooldownMs? }`
(`eden/src/villagers/role-defaults.ts:25-36`). An entry is kept iff `on` is a non-empty string and `handler.kind` is `skill` or
`deliberate` (`:99-107`) — `on` is **not** checked against the event union. Missing/corrupt file → `{ everyone: [] }`
(never throws). Path: `DEFAULT_ROLES_PATH` = `eden/roles.json` resolved from the module (`:39`).

### Seeding rules (`seedRoleDefaults`, `:72-96`)

- **First boot only**: a villager holding ANY subscription is skipped (returns 0). To re-adopt defaults delete
  `.eden-data/subscriptions/<name>.json`.
- **D-15 per-event override**: every `everyone` spec whose `on` appears in the role block is dropped; the role spec wins.
- All seeded subs get `source: 'role-default'`. Unknown role → `everyone` only.
- Only seeded when a live bot pool exists (`eden/src/main.ts:620-626`); logs `M5: seeded N role-default reflex(es)…`.

### Every shipped default (`eden/roles.json`)

| Block | `on` | Filter | Handler | Cooldown | Line |
|---|---|---|---|---|---|
| everyone | `hurt` | `notWhileRunning: ["flee-to-safety"]` | skill `flee-to-safety` `{}` | 3000 | 16 |
| everyone | `health-low` | — | deliberate, `interrupt`: « ta santé est basse — décide quoi faire (manger, fuir, demander de l'aide) » | — | 18 |
| everyone | `player-chat` | `within: 8` | deliberate, `normal`: « un joueur te parle — réponds en français » | 2000 | 20 |
| everyone | `inbox` | — | deliberate, `normal`: « tu as reçu un message de Dieu — lis-le et agis » | — | 22 |
| everyone | `night-falls` | — | skill `go-home` `{}` | — | 24 |
| guard | `hurt` (overrides everyone's) | `notWhileRunning: ["defend-self"]` | skill `defend-self` `{}` | 1000 | 33 |
| guard | `entity-spotted` | `entityKind: "hostile", within: 16` | deliberate, `interrupt`: « un ennemi est repéré — décide d'attaquer, d'alerter ou de te replier » | 5000 | 35 |
| farmer | `new-day` | — | skill `harvest-field` `{}` | — | 40 |
| miner | `new-day` | — | deliberate, `background`: « nouveau jour — planifie ta session de minage » | — | 45 |

All four named skills exist as stock skills (`eden/src/skills/exemplars/index.ts:719` flee-to-safety, `:739`
defend-self, `:767` go-home, `:790` harvest-field). Scenario roles `crafter` and `merchant` (in `eden/scenarios/*.json`)
have no block → `everyone` only. Seeded count per villager: 5 (everyone), guard 6 (4 everyone + 2), farmer 6, miner 6.

## Drives (`villagers/drives.ts`) — optional, NOT wired

`DriveTracker` decays `rest` and `social` from `FULL = 100` by 1 per `tick()` (defaults `restDecayPerTick`,
`socialDecayPerTick` = 1), firing `wakeup('tired'|'lonely', villager)` ONCE when a level drops below 25
(`tiredBelow`/`lonelyBelow`), re-arming on recovery ≥ threshold; `rest(to=100)` / `socialize(to=100)` restore;
`snapshot()` returns `{rest, social}`. Inert when `enabled:false`. It deliberately does not add events to the
`EdenEvent` union (`eden/src/villagers/drives.ts:7-14`).

Config gate `behavior.drives` exists (`eden/src/config.ts:65`, default `false` at `:110`), but **nothing in
`main.ts` constructs a `DriveTracker` or reads `config.behavior`** — the header claim "main.ts ticks one tracker per
villager" (`eden/src/villagers/drives.ts:13-14`) is false at this commit. With 30 s ticks, a drive would take 76 ticks (~38 min) to fire.

## Reactivity assembly (`villagers/reactivity.ts`)

`attach(villager, bot)` (`:60-90`): ignores names not in the villager roster (the avatar), detaches any stale router
(reconnect-safe), builds the signal adapter, a `SubscriptionRouter` with runner `{name, role, tier:'mortal'}`, and an
`EventRouter` bound to the adapter bus. `tick()` pumps `tick-30s` on every attached router; `subscriptionCount(v)`
feeds admin; `detach()` on host stop.

## The brain (`villagers/brain.ts`)

### Lifecycle of one deliberation

1. `deliberate(input, {rolloutId?, lane?, kind?})` enqueues ONE scheduler job — lane defaults `directive` inside a
   rollout else `idle`; `kind` (coalescing key) defaults `deliberate` (`:96-107`). A `rolloutId` grants scheduler
   immunity (see `llm-and-scheduling.md`). The whole multi-turn conversation runs inside that one slot.
2. `ContextPackBuilder.build` → frame messages; journals `brain.wakeup` (`:110`).
3. Loop `turn < maxToolTurns` (default **16**, `:67`): `client.chat({messages, tools, tier, caller:
   'villager:<name>', refs})`.
   - No tool calls → implicit done with `summary = content` (`:144-148`).
   - Else dispatch **every** call in order, append one `tool` message per call (R20 adjacency), journal
     `brain.tool-call {villager, tool, ok}` per call (`ok = outcome.ok ?? true`). Track `authored` (updates
     `ctx.draft`), `ran` (last RunReport), `reportedToGod`, `done`. `completeDanglingPairs` backfills any unanswered call
     with `Erreur: outil "<name>" non répondu (R20 garde).` (`:207-227`). Break after the turn if `done` was seen.
   - **R60 search breaker**: after 3 `search_skills` calls (`SEARCH_CALL_CAP`, `:70`) the tool is removed from the
     tool list and a user message is injected: « Assez de recherches — search_skills est désormais désactivé pour ce
     réveil. … AGIS maintenant … » (`:174-183`).
4. Cap reached without done → `summary = '(plafond de tours d’outils atteint)'`. Journal `brain.done {villager,
   summary, mood, toolCalls}` (`:186-187`).

Returns `DeliberationResult { villager, toolCalls, authoredDraft?, draft?, lastRunReport?, reportsToGod[], done,
messages }` (`:39-54`). `ctx.draft` is seeded from `input.density.draft` so `run_skill` of the draft-under-revision
trials that version (P2).

### Every villager tool (`eden/src/villagers/tools.ts:80-155`)

Exactly 11 (golden test `eden/tests/villagers-tools.test.ts:47`). Descriptions are French. `dispatch` never throws
(`:159-192`); usage errors return `ok:false`; an executed-but-failed run is `ok:true` (the brain got a RunReport).

| Tool | Params (required*) | Semantics / result |
|---|---|---|
| `search_skills` | `query*` | `retriever.search(query, {tier: runner.tier, villager})` → lines `name — signature — summary`; none → « Aucun skill pertinent trouvé. » Withdrawn after 3 calls (R60). |
| `read_skill` | `name*`, `version?` | full code + manifest + stats (`runs/successes/failures`, last 3 outcomes) folded from `skill.run` journal events (`:339-352`). Not found → `ok:false`. |
| `write_skill` | `name*`, `summary*`, `params*` (JSON Schema), `returns*`, `code*` | No `tier` field (villager skills are always mortal). Rejects `> maxSkillLines` lines (R47, never truncates), compile/parse errors inline; else `library.upsertDraft({…, author:{kind:'villager', name}})` → « Brouillon "<n>" v<k> créé (statut: draft). » and `authored`. |
| `run_skill` | `name*`, `args*`, `timeoutMs?` | `engine.run(name, args, runner, {rolloutId, timeoutMs})`; if `name === ctx.draft.name` adds `{version: draft.version, validateReturn: true}`. Content « Succès. Valeur: … » / « Échec (<errorKind>): … »; pre-execution throw → `ok:false`. |
| `report_to_god` | `text*` | returns « Transmis à Dieu. » and `reportedToGod` (collected into `DeliberationResult.reportsToGod`). |
| `done` | `summary*`, `mood?` | ends the deliberation. |
| `remember` | `text*`, `tags?` | `memoryFor(villager).remember({kind:'thought', text, tags})`. |
| `recall` | `query*` | `memory.retrieve(query, 5)` → lines `(<kind>) <text>`. |
| `subscribe` | `on*`, `handler*`, `filter?`, `cooldownMs?` | validates only non-empty `on` and `handler.kind ∈ {skill, deliberate}`; `store.add({…, source:'self'})`. |
| `unsubscribe` | `id*` | only the caller's own subscription. |
| `list_subscriptions` | — | lines `<id> — quand "<on>" [filtre: …] → <handler> (désactivé)`. |

**No direct micro-action tools** (`go_to`, `dig`, `say`, …) exist — every world effect is a `run_skill` of a library
skill (`eden/src/villagers/tools.ts:1-4`). There are also **no social tools** (`say`, `tell`, `start_conversation`, `leave_conversation`,
trade tools) despite `docs/04` listing them. Memory/subscription tools degrade to honest stubs (`(mémoire non câblée…)`,
`(réactivité non câblée…)`) when unwired. Memory is resolved per `ctx.villager` from the shared registry. **In the live host the
subscription tools are always stubs**: `main.ts` builds the `ToolRegistry` without a `subscriptions` store
(`eden/src/main.ts:550`; the `SubscriptionStore` is only created later at `:618`), so `subscribe`/`unsubscribe`/
`list_subscriptions` return `(réactivité non câblée…)` (`eden/src/villagers/tools.ts:293-336`).

## The context pack (`villagers/context-pack.ts`)

Deterministic: same input → byte-identical frame (`eden/tests/villagers-context-pack.test.ts:93`). Output messages:
`[system frame, …kept history turns, density user message?]`.

### The 8 sections (fixed order, `:104-125`; ceilings `:93-102`)

| # | Key / header | Ceiling (tokens) | Content |
|---|---|---|---|
| 1 | `identity` / IDENTITÉ | 512 | persona, `Rôle: <role>.`, optional `Humeur:`, `Consignes permanentes de Dieu:` |
| 2 | `trigger` / DÉCLENCHEUR | 1024 | trigger lines (or « (réveil sans déclencheur explicite) ») + `Indice: <hint>` |
| 3 | `situation` / SITUATION | 1024 | `renderSnapshot(snapshot)` — the renderer shared with God's critic |
| 4 | `activity` / ACTIVITÉ | 512 | running skill or « Aucun skill en cours (au repos). », active directive + reason, open task |
| 5 | `recentPast` / MÉMOIRE RÉCENTE | 1536 | `recentEvents` lines or « (rien de récent) » |
| 6 | `retrievedPast` / MÉMOIRE PERTINENTE | 1536 | memory lines or « (aucun souvenir pertinent) » |
| 7 | `capabilities` / CAPACITÉS | 16000 | tool names; R60 method line; retrieved skill one-liners; on authoring packs: primitive palette (deduped vs retrieved + exemplars), composition doctrine (`ctx.skills.run('go-to', …)`), D2 "VÉRIFIE avant de réussir" doctrine, exemplar full code |
| 8 | `inbox` / BOÎTE DE RÉCEPTION | 2048 | `[<kind> de <from>] <json payload>` per message, or « (vide) » |

Truncation rule `cap()` (`:307-311`): over-ceiling text keeps the first `ceiling*4 - 16` chars + `\n…(tronqué)`.
Tokens are estimated as `ceil(chars/4)` (`eden/src/render/tokens.ts`); `messageTokens` adds tool-call JSON, name,
id and +4 overhead (`:314-320`).

### Density payload and budget (D-11)

`DensityPayload { draft?: {name, version, code}, runReport?, critique? }` renders as a final user message
« ## TRAVAIL EN COURS (à réviser maintenant) » — **never trimmed** (`:297-304`). Frame + density are fixed cost;
`history: RevisionTurn[]` (assistant + its tool results, kept whole) is kept newest-first while it fits
`inputTokenBudget`, dropping oldest-first (`:151-164`).

Journals `brain.wakeup {villager, triggers, sections: {8 keys → tokens}, totalTokens, trimmedPairs, tier}` with the
rollout refs (`:174-186`).

### Who fills which section (actual host behaviour)

| Field | Reactive wake-up (`eden/src/main.ts:645-664`) | Rollout revision (`eden/src/main.ts:945-958`) |
|---|---|---|
| tier / budget | `fast` / fast `inputTokenBudget` | `strong` / strong `inputTokenBudget` (fallback 48000) |
| persona | `Tu es <name>, <role> du village. Tu parles français.` (roster, `eden/src/main.ts:579`) | same |
| mood, standingOrders | never set | never set |
| triggers / hint | `évènement <type>: <json>` / joined hints | `directive de Dieu: <goal>` / literal `authoring` |
| snapshot | live position/health/food/inventory over `DEFAULT_SNAPSHOT` | same |
| directive / openTask | null | from drained directive message, else task |
| recentEvents (§5) | `[]` | `[]` |
| memories (§6) | `retrieve(query, 5)` | `retrieve(task.goal, 6)`, once per task |
| retrieved skills | k=8 | k=10 minus exemplars, once per task |
| exemplar code / primitives | off | on |
| inbox (§8) | `[]` | `inboxes.get(v).drain()` each revision |
| density / history | none | draft + last RunReport + last critique after the 1st revision / always `[]` |

## The inbox (`villagers/inbox.ts`, `types/inbox.ts`)

`InboxMessage { from: 'god'|'villager', kind: 'directive'|'critique'|'tell', payload: object, at }`. `VillagerInbox`
journals `inbox.delivered {to, from, kind}` (actor `engine`) **before** queuing (`eden/src/villagers/inbox.ts:22-25`); `drain()` returns
and clears (FIFO); `depth()` is a non-destructive peek used by admin `/villagers`.

| Sender | from / kind | Payload | Code |
|---|---|---|---|
| Orchestrator directive | `god` / `directive` | `{directiveId, goal, reason, priority}` | `eden/src/god/orchestrator.ts:221` |
| `GodService.routeVerdict` | `god` / `critique` | `{critique, success, praise}` | `eden/src/god/god.ts:186-191` |
| Admin `POST /villagers/:name/prompt` | `villager` / `tell` | `{text, from}` | `eden/src/main.ts:393-401`, `eden/src/admin/server.ts:248-261` |

The **only consumer** is the `RolloutCoordinator`, which drains at the start of each revision iteration
(`eden/src/main.ts:941`). Nothing emits the `inbox` event, so the `everyone` inbox→deliberate reflex never fires.

## Gotchas & known issues

- **Most events have no live emitter.** `bots/signals.ts` forwards only `health`/`death` (+ synthetic `entityHurt`).
  `player-chat`, `villager-chat`, `entity-spotted/-lost`, `item-received`, `block-broken-nearby`, `run-finished`,
  `inbox`, `night-falls`, `new-day` never fire in a real boot → the `player-chat`, `inbox`, `night-falls → go-home`,
  guard `entity-spotted`, farmer/miner `new-day` defaults are inert. Live reflexes: `hurt` (flee / guard defend),
  `health-low`, `died`, `tick-30s`.
- **`within` doesn't gate chat.** Only `entity-spotted` carries a distance, so `player-chat` `within: 8` passes for
  any distance (would matter once chat is emitted).
- **`new-day.day` is always 0**: `dayOf` divides `bot.time.timeOfDay` (0..24000) by 24000 (`eden/src/villagers/events.ts:236-238`).
- **`entityKind` defaults unknown names to `player`**, and the clause returns false for non-entity events.
- **Admin "tell" never wakes a villager**: it sits in the inbox until the next rollout revision drains it; it is
  tagged `from:'villager'` even though a player/admin sent it.
- **Critique duplication**: `routeVerdict` delivers the critique to the inbox, and the next revision drains it into §8
  *and* carries it in the density payload.
- **`report_to_god` goes nowhere in the host**: `reportsToGod` is never read outside `brain.ts`.
- **§5 recent past is always empty**: both host paths pass `recentEvents: []`; `VillagerMemory.recent()` is unused.
  Mood and standing orders (§1) are also never supplied; `config.villagers[].persona` is parsed
  (`eden/src/config.ts:229`) but the roster ignores it.
- **`history` is always `[]`** in production, so `trimmedPairs` is always 0; prior revisions ride only via density.
- **`brain.tool-call.ok` is true for a failed run** (only usage errors are `ok:false`), contrary to the comment in
  `eden/src/journal/kinds.ts:133-135` ("ok false when … a run failure surfaced to the LLM").
- **`subscribe` accepts any `on` string and any filter shape** (once wired); a typo'd event type silently never fires.
- **Villager-authored subscriptions are impossible in the host**: the `ToolRegistry` gets no `subscriptions` store
  (`eden/src/main.ts:550`), so the only subscriptions that exist are the seeded role defaults.
- **`setEnabled` has no caller** — the documented "auto-disable on God's quarantine of the underlying skill" is not
  wired; a quarantined skill's subscription keeps firing and erroring (`system.error`).
- **Drives are dead code in the host** (no `DriveTracker` constructed; `behavior.drives` unused).
- Comment drift: `eden/roles.json:9-10` still says a duplicate role spec is *skipped*; the code (D-15) makes the role spec
  *replace* everyone's spec on that event.
- Reactivity (routers, seeding) exists only when a bot pool exists; CI/no-bot boots have none.

## Related

- [villager-memory.md](villager-memory.md) — memory window/archive/retrieval, R32 quarantine
- [types-and-contracts.md](types-and-contracts.md) — `EdenEvent`, `Subscription`, `Inbox`, dependency law
- [skills-engine.md](skills-engine.md) — `engine.run`, D-05 serialization, `runningSkills`
- [skills-library.md](skills-library.md) — drafts, `upsertDraft`, retrieval
- [stock-skills.md](stock-skills.md) — `flee-to-safety`, `defend-self`, `go-home`, `harvest-field`
- [god.md](god.md) — RolloutCoordinator, orchestrator directives, critic verdicts
- [llm-and-scheduling.md](llm-and-scheduling.md) — lanes, coalescing, rollout immunity
- [bots-and-hardening.md](bots-and-hardening.md) — pool, spawn hook, signal adapter context
- [journal-and-views.md](journal-and-views.md) — `brain.*`, `subscription.*`, `inbox.delivered` kinds
- [admin-api.md](admin-api.md) — `/villagers`, `/villagers/:name/prompt`
