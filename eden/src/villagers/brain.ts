// Brain (layer 3, villagers/) — one deliberation = one LLM conversation: context pack → assistant
// turns with tool calls → done (04 §The brain). The shape is v1's agent-runtime with the skill tools
// (search/read/write/run) replacing bespoke action tools, so every world effect is a journaled,
// criticizable run (P2). There are NO direct micro-action tools.
//
// Two invariants live here:
//   • R20 — tool-call/result adjacency is sacred. Every assistant turn that issues tool calls is
//     immediately followed by exactly one tool result per call, in order, BEFORE the next provider
//     call. Even if `done` is one of several calls in a turn, every sibling call is answered first
//     (breaking on `done` mid-batch would leave a dangling call → provider 400). A defensive guard
//     fills any unanswered call with an error result (complete the pair, never leave it dangling).
//   • Density invariant (D-11) — the context pack carries the current draft + latest RunReport +
//     latest critique fresh each revision; prior revision turns ride as whole pairs and trim oldest-
//     first (the ContextPackBuilder owns this). The brain just persists the rollout pointer so a
//     run_skill of the draft-under-revision trials the draft version (P2).
//
// The WHOLE deliberation is ONE scheduler unit (one concurrency slot for its lifetime); the multi-turn
// conversation runs inside that slot — it does not re-enqueue per turn. A rolloutId grants immunity
// (bypasses coalescing/cooldown/rate-cap — the density invariant, 04 §Scheduling).

import type { JournalAppender } from '../journal/journal';
import type { LlmClient, LlmMessage } from '../llm/client';
import type { Lane, LlmScheduler } from '../llm/scheduler';
import type { Refs, RunReport } from '../types/index';
import { ContextPackBuilder, type ContextPackInput } from './context-pack';
import { ToolRegistry, type ToolContext } from './tools';

/** Per-deliberation routing options. */
export interface DeliberateOptions {
  /** Set inside a rollout — tags every event + grants scheduler immunity (D-11). */
  rolloutId?: string;
  /** Priority lane; defaults to 'directive' for rollout work, 'idle' otherwise. */
  lane?: Lane;
  /** Coalescing key; defaults to 'deliberate'. */
  kind?: string;
}

/** What one deliberation produced — the rollout coordinator (God side) reads this. */
export interface DeliberationResult {
  villager: string;
  toolCalls: number;
  /** The draft authored in THIS deliberation, if any (write_skill). */
  authoredDraft?: { name: string; version: number };
  /** The final draft pointer after the deliberation (authored this turn, or the one passed in). */
  draft?: { name: string; version: number };
  /** The most recent RunReport a run_skill produced (the rollout files a critic ticket on it). */
  lastRunReport?: RunReport;
  /** report_to_god texts (pleas/objections). */
  reportsToGod: string[];
  /** How the deliberation ended (done tool, or an implicit stop). */
  done: { summary: string; mood?: string };
  /** The full assembled conversation — exposed so callers/tests can assert R20 adjacency. */
  messages: LlmMessage[];
}

/** Construction deps (wired in main.ts; no singletons). */
export interface BrainOptions {
  builder: ContextPackBuilder;
  tools: ToolRegistry;
  scheduler: LlmScheduler;
  client: LlmClient;
  journal: JournalAppender;
  /** Safety cap on tool turns in one deliberation (S7 hardcoded default). */
  maxToolTurns?: number;
}

const DEFAULT_MAX_TURNS = 16;

/** Runs villager deliberations. One per host; stateless across deliberations (state lives in inputs). */
export class Brain {
  private readonly builder: ContextPackBuilder;
  private readonly tools: ToolRegistry;
  private readonly scheduler: LlmScheduler;
  private readonly client: LlmClient;
  private readonly journal: JournalAppender;
  private readonly maxToolTurns: number;

  constructor(opts: BrainOptions) {
    this.builder = opts.builder;
    this.tools = opts.tools;
    this.scheduler = opts.scheduler;
    this.client = opts.client;
    this.journal = opts.journal;
    this.maxToolTurns = opts.maxToolTurns ?? DEFAULT_MAX_TURNS;
  }

  /** The villager's tool names (for the context-pack capabilities section) — the registry is the source. */
  toolNames(): string[] {
    return this.tools.definitions().map((d) => d.function.name);
  }

  /** Run one deliberation. The whole conversation runs inside a single scheduler slot. */
  deliberate(input: ContextPackInput, opts: DeliberateOptions = {}): Promise<DeliberationResult> {
    const refs: Refs = opts.rolloutId !== undefined ? { rolloutId: opts.rolloutId } : {};
    const lane: Lane = opts.lane ?? (opts.rolloutId !== undefined ? 'directive' : 'idle');
    const kind = opts.kind ?? 'deliberate';
    return this.scheduler.enqueue({
      villager: input.villager,
      lane,
      kind,
      rolloutId: opts.rolloutId,
      run: () => this.converse(input, refs),
    });
  }

  private async converse(input: ContextPackInput, refs: Refs): Promise<DeliberationResult> {
    const pack = this.builder.build(input, { refs }); // journals brain.wakeup with section sizes
    const messages: LlmMessage[] = [...pack.messages];
    const toolDefs = this.tools.definitions();
    const ctx: ToolContext = {
      villager: input.villager,
      runner: input.runner,
      rolloutId: refs.rolloutId,
      // Seed the rollout draft pointer from the density payload (the draft under revision), so a
      // run_skill of that name trials the draft version (P2) even before this deliberation re-authors.
      draft: input.density?.draft ? { name: input.density.draft.name, version: input.density.draft.version } : undefined,
    };
    const caller = `villager:${input.villager}`;

    let toolCalls = 0;
    let authoredDraft: { name: string; version: number } | undefined;
    let lastRunReport: RunReport | undefined;
    const reportsToGod: string[] = [];
    let done: { summary: string; mood?: string } | undefined;

    for (let turn = 0; turn < this.maxToolTurns && !done; turn++) {
      const result = await this.client.chat({ messages, tools: toolDefs, tier: input.tier, caller, refs });
      messages.push({
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      });

      if (result.toolCalls.length === 0) {
        // The model stopped issuing calls — treat its content as an implicit done (clean close).
        done = { summary: result.content ?? '' };
        break;
      }

      // Dispatch EVERY call in the turn and append a result for EACH — R20: complete the pair before
      // the next provider call, even when `done` is one of several calls.
      let sawDone = false;
      for (const call of result.toolCalls) {
        const outcome = await this.tools.dispatch(call, ctx);
        toolCalls++;
        this.journal.append(caller, 'brain.tool-call', { villager: input.villager, tool: call.name, ok: outcome.ok ?? true }, refs);
        messages.push({ role: 'tool', content: outcome.content, toolCallId: call.id, name: call.name });
        if (outcome.authored) {
          authoredDraft = outcome.authored;
          ctx.draft = outcome.authored; // subsequent run_skill of this name trials the new draft (P2)
        }
        if (outcome.ran) lastRunReport = outcome.ran;
        if (outcome.reportedToGod !== undefined) reportsToGod.push(outcome.reportedToGod);
        if (outcome.done) {
          done = outcome.done;
          sawDone = true;
        }
      }
      // Defensive R20 guard: ensure no tool call in this turn was left unanswered.
      completeDanglingPairs(messages);
      if (sawDone) break;
    }

    if (!done) done = { summary: '(plafond de tours d’outils atteint)' };
    this.journal.append(caller, 'brain.done', { villager: input.villager, summary: done.summary, mood: done.mood, toolCalls }, refs);

    return {
      villager: input.villager,
      toolCalls,
      authoredDraft,
      draft: ctx.draft,
      lastRunReport,
      reportsToGod,
      done,
      messages,
    };
  }
}

/**
 * R20 safety net: after dispatching a turn, every tool call in the last assistant turn must have an
 * adjacent tool result. If any is missing (it never should be — dispatch is total), append a synthetic
 * error result so the pair is complete rather than dangling (which would 400 the next provider call).
 */
function completeDanglingPairs(messages: LlmMessage[]): void {
  // Find the last assistant turn with tool calls.
  let ai = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant' && (messages[i]!.toolCalls?.length ?? 0) > 0) {
      ai = i;
      break;
    }
    if (messages[i]!.role === 'assistant') return; // a plain assistant turn — nothing to complete
  }
  if (ai < 0) return;
  const answered = new Set<string>();
  for (let i = ai + 1; i < messages.length; i++) {
    if (messages[i]!.role === 'tool' && messages[i]!.toolCallId) answered.add(messages[i]!.toolCallId!);
  }
  for (const call of messages[ai]!.toolCalls!) {
    if (!answered.has(call.id)) {
      messages.push({ role: 'tool', content: `Erreur: outil "${call.name}" non répondu (R20 garde).`, toolCallId: call.id, name: call.name });
    }
  }
}
