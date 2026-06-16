// The journal kind registry (S1). Adding a kind = one row here + its payload type;
// the ONE writer module emits it (S2). Each milestone registers only its own kinds —
// M0 has just the System domain. JournalEvent.kind is `string` in types/ (the law);
// this is where the canonical union + per-kind payloads live, enforced by `satisfies`.

import type { Author, Provenance, RunReport, TradeItem } from '../types/index';

/** The canonical, exhaustive list of journal kinds — the `as const` source of {@link JournalKind}. */
export const JOURNAL_KINDS = [
  // System domain (M0).
  'system.boot',
  'system.config-warning',
  'system.bot-connected',
  'system.bot-disconnected',
  'system.error',
  'system.loop-lag',
  // World domain (M1).
  'vitals',
  'world.death',
  // Skills domain (M2).
  'skill.draft',
  'skill.admit',
  'skill.quarantine',
  'skill.archive',
  'skill.run',
  'skill.log',
  // LLM domain (M2).
  'llm.call',
  // Brain domain (M3) — one villager deliberation, start to finish.
  'brain.wakeup',
  'brain.tool-call',
  'brain.done',
  // God domain (M3) — the critic desk's ticket + verdict (curriculum/orchestrator kinds are M4).
  'god.ticket',
  'god.verdict',
  'god.appearance',
  'god.rollout-abandoned',
  // God domain (M4) — curriculum (task-proposed/-closed) + orchestrator (directive/-closed).
  'god.task-proposed',
  'god.task-closed',
  'god.directive',
  'god.directive-closed',
  // Social domain (M3) — only inbox.delivered (chat/conversation/trade land in M6).
  'inbox.delivered',
  // Social domain (M6) — bot↔bot speech (chat), conversations (start/turn/end), and trade
  // (proposed/settled/failed). inbox.delivered was already M3 — NOT re-added here.
  'chat.said',
  'chat.heard',
  'conversation.started',
  'conversation.turn',
  'conversation.ended',
  'trade.proposed',
  'trade.settled',
  'trade.failed',
  // Reactivity domain (M5) — the subscription lifecycle + each firing/suppression. subscription.fired
  // is one of the two windowed high-volume kinds (Retention, 05); it is the windowed SUMMARY of a
  // matched-and-routed event, NEVER a per-tick stream (R44/D-07 — the emitter pulses stay in RAM).
  'subscription.created',
  'subscription.removed',
  'subscription.fired',
  'subscription.suppressed',
  // Scenario domain — in-game /villagers command loaded/stopped/reset a scenario roster.
  'scenario.start',
  'scenario.stop',
  'scenario.restart',
] as const;

/** The closed union of registered journal kinds. The writer's `append<K>` binds to this. */
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/**
 * Per-kind payload shape. `PayloadOf<K>` indexes this, so a kind missing here is a
 * compile error — that is the contract that keeps the union and the payloads in lockstep
 * (the v1 failure mode #2 fix: one source of truth, compiler-enforced).
 */
export interface KindPayloads {
  'system.boot': { config: object };
  'system.config-warning': { message: string };
  'system.bot-connected': { name: string };
  'system.bot-disconnected': { name: string; reason?: string };
  'system.error': { message: string; stack?: string };
  // D-07: event-loop stall spike, at most once per 60 s reset window.
  'system.loop-lag': { p99: number; max: number };
  // M1 World domain. Per-bot snapshot every vitalsIntervalSeconds (R44/D-07: a SUMMARY of
  // the in-memory pulse stream, never the per-tick stream itself). pos/hp/food/held/current run.
  vitals: {
    name: string;
    health: number;
    food: number;
    position: [number, number, number];
    held: string | null;
    currentRun: string | null;
  };
  // M1 G2 (owner call pending on name/shape — see PROGRESS.md). The authoritative cause of a
  // bot death is the death_combat_event packet (R27), not inference from entity state.
  'world.death': { name: string; cause?: string };
  // ── Skills domain (M2). Every library mutation + every run journals (P4); the website's
  // "skill page" is a rendering of this stream plus folded stats. ──
  'skill.draft': { name: string; version: number; author: Author; tier: string; lines: number };
  'skill.admit': { name: string; version: number; provenance?: Provenance };
  'skill.quarantine': { name: string; version: number; reason: string };
  'skill.archive': { name: string; version: number };
  // The full RunReport — Voyager-rendered snapshots keep this a SMALL row (D-07/R44).
  'skill.run': RunReport;
  // An in-run ctx.log line (refs.runId/rolloutId tie it to its run).
  'skill.log': { skill: string; message: string };
  // ── LLM domain (M2). desk/villager, model, latency, tokens, finish reason — NEVER raw prompt
  // bodies (those go to .eden-data/llm/<id>.json when debugPrompts). refs.llmCallId. ──
  'llm.call': {
    caller: string;
    model: string;
    tier: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    finishReason: string;
    retries: number;
  };
  // ── Brain domain (M3). The context-pack journals its own composition (05/D-11): the triggers
  // that woke the villager + per-section token sizes, so prompt bloat is measurable, not vibes.
  // refs.rolloutId ties a revision wake-up to its rollout. ──
  'brain.wakeup': {
    villager: string;
    triggers: string[];
    /** Per-section token sizes (identity/trigger/snapshot/…); the keys are the 8 sections. */
    sections: Record<string, number>;
    /** Total input tokens of the assembled pack (≤ the tier's inputTokenBudget by construction). */
    totalTokens: number;
    /** Whole tool-call/result pairs dropped oldest-first to fit the budget (R20/D-11). */
    trimmedPairs: number;
    tier: string;
  };
  // One tool the brain dispatched in a deliberation. `ok` is false when the tool returned an error
  // string (e.g. a parse error, a run failure surfaced to the LLM). Args are NOT logged (size/noise).
  'brain.tool-call': { villager: string; tool: string; ok: boolean };
  // A deliberation ended (the `done` tool, or the model stopped issuing calls). Carries the summary,
  // optional mood (side-output, M6), and how many tool calls the deliberation made.
  'brain.done': { villager: string; summary: string; mood?: string; toolCalls: number };
  // ── God domain (M3). The critic desk files + answers tickets; refs carry rollout/run/skill/verdict. ──
  // A run was queued for judgment (filed by a rollout, a tripwire, a plea, or a second-opinion request).
  'god.ticket': { source: 'rollout' | 'tripwire' | 'plea' | 'second-opinion'; skill?: string; version?: number };
  // The critic's judgment: success + the action taken on the library + the constructive critique.
  'god.verdict': { ticketId: string; success: boolean; libraryAction: string; score?: number; critique: string };
  // Body theatrics — God's avatar manifested/gestured/delivered a verdict in person. The underlying
  // divine skill ALSO journals skill.run; this is the semantic "God appeared" event. `ok` is false when
  // the avatar is down (theatrics are never a dependency — the loop closes regardless).
  'god.appearance': { villager: string; action: string; ok: boolean };
  // D-09 crash recovery: an open task's live rollout was abandoned at boot (the in-memory conversation
  // is the only volatile state crash-only already accepts losing). The task re-enters assignment with
  // fresh maxRetries; the orphan draft stays a harmless `draft`. refs.rolloutId/taskId tie it back.
  'god.rollout-abandoned': { reason: 'crash-recovery'; taskId: string };
  // ── God domain (M4). The curriculum desk proposes/closes tasks; the orchestrator opens/closes
  // directives. The TaskLedger is written ONLY by curriculum, directivesOpen ONLY by orchestrator (S2). ──
  // A curriculum proposal entered the ledger (propose_task). `trigger` is what woke the desk
  // (idle/verdict-close/dawn/critic-follow-up/admin); `parent` ties a decomposed sub-task to its goal.
  'god.task-proposed': { taskId: string; goal: string; assignee?: string; trigger: string; parent?: string };
  // A task left the open ledger: completed/failed (a verdict closed it), or retired (clean_up_tasks
  // dropped a stale `failed` when a later task completed the same goal). refs.taskId/verdictId tie it back.
  // `reason` (optional) carries WHY for a non-verdict close — the convergence breaker (R65) names the task
  // + the exhausted-rollout count when it gives up on an unconvergeable task (S10).
  'god.task-closed': { taskId: string; goal: string; outcome: 'completed' | 'failed' | 'retired'; reason?: string };
  // The orchestrator opened a directive and delivered it to a villager's inbox (the SOLE writer of
  // directivesOpen). `superseded` lists directive ids this one displaced (anti-thrash, journaled).
  'god.directive': { directiveId: string; to: string; goal: string; priority: string; superseded?: string[] };
  // A directive left directivesOpen — completed (the villager's rollout closed its task), expired,
  // or superseded by a newer one (anti-thrash). refs.directiveId/taskId tie it back.
  'god.directive-closed': { directiveId: string; to: string; reason: 'completed' | 'expired' | 'superseded' };
  // ── Social domain (M3) — only inbox.delivered (chat/conversation/trade are M6). ──
  // A message landed in a villager's inbox (God→villager critique/directive/tell). Journaled by the
  // inbox impl BEFORE the villager reads it (05) — the "talk to a villager" audit trail.
  'inbox.delivered': { to: string; from: string; kind: string };
  // ── Social domain (M6). Bot↔bot speech + conversations + trade (04 §Conversations/§Trade).
  // refs carry conversationId / tradeId so the website's conversation/trade views are one query. ──
  // A villager spoke a line (in a conversation or a free `say`/`tell`). refs.conversationId ties it
  // to its conversation when one is open. `to` is the addressee (a villager, 'all', or a player).
  'chat.said': { from: string; to: string; text: string };
  // A villager HEARD speech (the addressee or an eavesdropper in earshot — eavesdroppers get a free
  // memory entry, 04). `eavesdrop` is true when the hearer was not the addressee.
  'chat.heard': { hearer: string; from: string; text: string; eavesdrop: boolean };
  // A conversation opened between two villagers (in-process inboxes route the turns). refs.conversationId.
  'conversation.started': { id: string; initiator: string; partner: string; topic?: string };
  // One turn of a conversation (a speaker handed the floor to the other). refs.conversationId.
  'conversation.turn': { id: string; speaker: string; turn: number };
  // A conversation closed (leave_conversation, turn cap, or a per-turn deadline). `reason` names which;
  // `opinion`/`headline` are the structured leave payload that moved relations + seeded memory (04).
  'conversation.ended': {
    id: string;
    by: string;
    reason: 'left' | 'turn-cap' | 'deadline' | 'partner-gone';
    opinion?: number;
    headline?: string;
  };
  // ── Trade (M6). Typed offers negotiated inside a conversation; settled via the mod (settlement.url).
  // coin → paulsbrawls:coin (Gibber is the village currency for free). refs.tradeId/conversationId. ──
  // A typed offer was proposed (give X for Y). The negotiation lives in a conversation; this is the
  // moment a concrete offer object was put on the table.
  'trade.proposed': { id: string; from: string; to: string; give: TradeItem[]; want: TradeItem[] };
  // The mod settled the trade atomically (inventories swapped on the main thread). The happy path.
  'trade.settled': { id: string; from: string; to: string; give: TradeItem[]; want: TradeItem[] };
  // Settlement FAILED (non-2xx from the mod, a network error, or a re-validation reject). Inventories
  // are UNTOUCHED (the mod swaps atomically or not at all). `reason` carries the cause (S10).
  'trade.failed': { id: string; from: string; to: string; reason: string };
  // ── Reactivity domain (M5). The subscription store is the SOLE WRITER (S2); the event router fires.
  // A subscription's "when X (filtered), do Y" is policy as DATA (P5) — these rows make that legible. ──
  // A subscription was created (a role-default seed at first boot, a `subscribe` tool call, God wiring a
  // reflex, or an admin). `handler` is 'skill' | 'deliberate' so the website can colour the two outcomes.
  'subscription.created': {
    id: string;
    villager: string;
    on: string;
    handler: 'skill' | 'deliberate';
    source: string;
  };
  // A subscription was removed (an `unsubscribe` tool call or an admin). refs carry nothing extra.
  'subscription.removed': { id: string; villager: string };
  // A subscription matched an event (filter passed) and ROUTED. `outcome` is 'skill' (a zero-token
  // SkillEngine.run) or 'deliberate' (a brain wake-up). One of the two windowed high-volume kinds
  // (Retention, 05) — the windowed SUMMARY of a routed event, never a per-tick stream (R44).
  'subscription.fired': {
    id: string;
    villager: string;
    on: string;
    outcome: 'skill' | 'deliberate';
    /** The skill name (skill outcome) or the deliberation hint (deliberate outcome). */
    target: string;
  };
  // A matched subscription did NOT route: it was inside its per-subscription cooldown, disabled, or
  // suppressed by `notWhileRunning`. `reason` names which (cooldown/disabled/not-while-running) so the
  // legible reflex story stays complete — a suppressed event is information, not silence (R36 spirit).
  'subscription.suppressed': { id: string; villager: string; on: string; reason: string };
  // Scenario domain — /villagers command loaded/stopped/reset a scenario.
  'scenario.start': { name: string; cx: number; cz: number };
  'scenario.stop': Record<string, never>;
  'scenario.restart': { name: string; cx: number; cz: number };
}

/** The payload type for a given kind — indexes {@link KindPayloads}, so a missing kind won't compile. */
export type PayloadOf<K extends JournalKind> = KindPayloads[K];

interface KindDoc {
  doc: string;
}

/** One human-readable doc per kind; `satisfies Record<JournalKind, KindDoc>` enforces completeness. */
export const KIND_REGISTRY = {
  'system.boot': { doc: 'host start; config snapshot with secrets redacted' },
  'system.config-warning': { doc: 'an unknown/aliased config key was adopted or ignored (R22)' },
  'system.bot-connected': { doc: 'a bot finished spawning' },
  'system.bot-disconnected': { doc: 'a bot dropped; reason if known' },
  'system.error': { doc: 'an unhandled/host-level error' },
  'system.loop-lag': { doc: 'event-loop stall spike {p99,max} ms — the backpressure canary (D-07)' },
  vitals: { doc: 'per-bot snapshot (pos/hp/food/held/run) every vitalsIntervalSeconds — the journalled summary of in-memory pulses (R44)' },
  'world.death': { doc: 'a bot died; cause from the death_combat_event packet (R27) — G2 owner call on name/shape pending' },
  'skill.draft': { doc: 'a new draft version was authored (write_skill) — name/version/author/tier/lines' },
  'skill.admit': { doc: 'a draft was admitted to active-probation (D-12) with its provenance' },
  'skill.quarantine': { doc: 'an active version was quarantined (God/admin/tripwire/boot hash-mismatch) with reason' },
  'skill.archive': { doc: 'a version was archived (invisible to retrieval, visible to admin)' },
  'skill.run': { doc: 'the full RunReport of one skill tree run (P4) — the critic reads it; stats fold from it' },
  'skill.log': { doc: 'an in-run ctx.log line — NOT console (R23); refs.runId ties it to its run' },
  'llm.call': { doc: 'one LLM call: caller/model/tier/latency/tokens/finish — NEVER prompt bodies (debugPrompts→file)' },
  'brain.wakeup': { doc: 'a villager deliberation began: triggers + context-pack section token sizes (D-11) — prompt bloat is measurable' },
  'brain.tool-call': { doc: 'a tool the brain dispatched in a deliberation (name + ok) — args are not logged' },
  'brain.done': { doc: 'a villager deliberation ended (done tool / no more calls): summary + mood + tool-call count' },
  'god.ticket': { doc: 'a run was queued for the critic desk (source: rollout/tripwire/plea/second-opinion)' },
  'god.verdict': { doc: 'the critic desk judged a ticket: success + libraryAction + critique (refs ticket/rollout/skill)' },
  'god.appearance': { doc: 'body theatrics: the avatar manifested/gestured/delivered a verdict (ok:false if avatar down) — never a dependency' },
  'god.rollout-abandoned': { doc: 'D-09 boot recovery: an open task’s live rollout was abandoned + re-enqueued with fresh maxRetries' },
  'god.task-proposed': { doc: 'the curriculum desk proposed a task into the ledger (propose_task) — goal/assignee/trigger/parent (M4)' },
  'god.task-closed': { doc: 'a task left the open ledger: completed/failed (verdict) or retired (clean_up_tasks dropped a stale failed) (M4)' },
  'god.directive': { doc: 'the orchestrator opened a directive + delivered it to an inbox (sole writer of directivesOpen); superseded ids if any (M4)' },
  'god.directive-closed': { doc: 'a directive left directivesOpen: completed/expired/superseded (anti-thrash) (M4)' },
  'inbox.delivered': { doc: 'a message landed in a villager inbox (God→villager critique/directive/tell) — journaled before delivery' },
  'chat.said': { doc: 'a villager spoke a line (conversation turn or free say/tell); refs.conversationId when in one (M6)' },
  'chat.heard': { doc: 'a villager heard speech (addressee or eavesdropper in earshot — eavesdroppers get a free memory entry) (M6)' },
  'conversation.started': { doc: 'a bot↔bot conversation opened (in-process inboxes route turns); refs.conversationId (M6)' },
  'conversation.turn': { doc: 'one conversation turn (the floor passed to the other speaker); refs.conversationId (M6)' },
  'conversation.ended': { doc: 'a conversation closed: left/turn-cap/deadline/partner-gone; leave opinion+headline moved relations + seeded memory (M6)' },
  'trade.proposed': { doc: 'a typed offer (give X for Y) was put on the table inside a conversation; refs.tradeId (M6)' },
  'trade.settled': { doc: 'the mod settled a trade atomically (inventories swapped); coin→paulsbrawls:coin; the happy path (M6)' },
  'trade.failed': { doc: 'settlement failed (non-2xx / network / re-validation reject); inventories UNTOUCHED; reason carries the cause (S10) (M6)' },
  'subscription.created': { doc: 'a subscription was created (role-default/self/god/admin) — the "when X, do Y" reflex as data (P5) (M5)' },
  'subscription.removed': { doc: 'a subscription was removed (unsubscribe/admin) (M5)' },
  'subscription.fired': { doc: 'a subscription matched + routed: outcome skill (zero-token run) or deliberate (wake-up) — windowed high-volume kind (Retention) (M5)' },
  'subscription.suppressed': { doc: 'a matched subscription did NOT route: cooldown/disabled/not-while-running — suppression is information, not silence (R36) (M5)' },
  'scenario.start': { doc: 'in-game /villagers start loaded a scenario and connected its bots (journaled before acting, 05)' },
  'scenario.stop': { doc: 'in-game /villagers stop disconnected scenario bots (keeps state, journaled before acting, 05)' },
  'scenario.restart': { doc: 'in-game /villagers restart cleared state + reconnected scenario bots (journaled before acting, 05)' },
} satisfies Record<JournalKind, KindDoc>;

const KNOWN: ReadonlySet<string> = new Set(JOURNAL_KINDS);

/** Runtime type guard — narrows an open `string` to {@link JournalKind}; backs the writer's S1 check. */
export function isKnownKind(kind: string): kind is JournalKind {
  return KNOWN.has(kind);
}

/** The admin API exposes this so the website can render kinds it doesn't hardcode. */
export function describeKinds(): Array<{ kind: JournalKind; doc: string }> {
  return JOURNAL_KINDS.map((kind) => ({ kind, doc: KIND_REGISTRY[kind].doc }));
}
