// Orchestrator (layer 3, god/) — God's orchestrator desk (03 §The orchestrator desk). It turns tasks
// and world events into DIRECTIVES — data, not code — and delivers each to a villager's inbox. It is
// the SOLE WRITER of GodState.directivesOpen (S2).
//
// The anti-thrash rules are ENGINE-ENFORCED, not prompt-hoped (03 §Anti-thrash):
//   • max 1 open NON-standing directive per villager — a new one supersedes the oldest (journaled);
//   • an `interrupt` cannot fire at the same villager twice within interruptCooldownMs (default 5 min)
//     — a too-soon interrupt is DOWNGRADED to `normal` rather than dropped (the order still lands);
//   • standing directives coexist (one persistent rule + one ordinary directive).
//
// Direct intervention (`intervene`) is divine STAGE-SETTING via the avatar's divine skills: it sets a
// stage (spawn training mobs, clear rain, deliver starter tools) but NEVER does the villager's task.
// It flags `divineAssisted` for the task so the critic VOIDS a success the intervention achieved
// (voidDivineOverreach, D-12) — the orchestrator records the flag; the critic reads it (wired in M4-3).
//
// report_to_god surfaces a villager objection — journaled + noted in the dossier (refusal is info).
//
// god/ imports skills/llm/render/journal/types (downward); it NEVER imports villagers/ or social/. It
// reaches villagers only through the injected Inbox, and the avatar only through a structural
// DivineActor (GodBody satisfies it) — no peer import.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { monotonicFactory } from 'ulid';

import type { Directive, Dossier, Inbox, Priority, Task } from '../types/index';
import type { IJournal } from '../journal/journal';
import type { LlmClient, LlmToolDef, ModelTier } from '../llm/client';
import { LlmScheduler } from '../llm/scheduler';
import type { BudgetTracker } from '../llm/scheduler';
import type { GodState } from './god';

const ulid = monotonicFactory();
const DEFAULT_INTERRUPT_COOLDOWN_MS = 5 * 60_000; // 03 §Anti-thrash — no repeat interrupt within 5 min
const MAX_DOSSIER_NOTES = 40;

/** The avatar surface the orchestrator drives for stage-setting — GodBody satisfies it structurally. */
export interface DivineActor {
  /** Run a divine skill on the avatar; resolves true on success, false on failure (never throws). */
  runAction(action: string, args: object): Promise<boolean>;
}

/** Construction deps (wired in main.ts). The desk is the sole writer of state.directivesOpen (S2). */
export interface OrchestratorOptions {
  /** The single God state home (S2). The desk owns `state.directivesOpen`. */
  state: GodState;
  journal: IJournal;
  client: LlmClient;
  scheduler: LlmScheduler;
  /** One inbox per villager — the God→villager channel (keeps god/ from importing villagers/). */
  inboxes: Map<string, Inbox>;
  systemPrompt?: string;
  /** Dispatch runs on the FAST tier — frequent + shallow (D-13). */
  tier?: ModelTier;
  /** No repeat interrupt to the same villager within this window (default 5 min). */
  interruptCooldownMs?: number;
  /** D-13 safety valve: when over-budget, dispatch only `interrupt`-priority directives (M4-4). */
  budget?: BudgetTracker;
  degradeOnBreach?: boolean;
  now?: () => number;
}

const PRIORITIES: readonly Priority[] = ['background', 'normal', 'interrupt'];

const DIRECTIVE_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'directive',
    description: 'Émets une directive (donnée, pas du code) vers un villageois — une par villageois taské.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'le villageois ciblé' },
        goal: { type: 'string', description: 'but concret et actionnable' },
        reason: { type: 'string', description: 'montré au villageois — Dieu s’explique' },
        priority: { type: 'string', enum: ['background', 'normal', 'interrupt'] },
        standing: { type: 'boolean', description: 'optionnel: règle permanente (survit à la complétion)' },
        taskRef: { type: 'string', description: 'optionnel: l’id de la tâche' },
      },
      required: ['to', 'goal', 'reason', 'priority'],
    },
  },
};

/** Reads the orchestrator system prompt from god/prompts/orchestrator.md (loaded at runtime — S6). */
export function loadOrchestratorPrompt(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, 'prompts', 'orchestrator.md'), 'utf8');
}

/** What triggered a dispatch (rendered into the prompt; the engine doesn't branch on it). */
export type DispatchTrigger = 'new-task' | 'closed-task' | 'verdict-follow-up' | 'event' | 'idle-sweep' | 'admin';

/** The orchestrator desk — the sole writer of directivesOpen (S2). */
export class Orchestrator {
  private readonly state: GodState;
  private readonly journal: IJournal;
  private readonly client: LlmClient;
  private readonly scheduler: LlmScheduler;
  private readonly inboxes: Map<string, Inbox>;
  private readonly systemPrompt: string;
  private readonly tier: ModelTier;
  private readonly interruptCooldownMs: number;
  private readonly budget?: BudgetTracker;
  private readonly degradeOnBreach: boolean;
  private readonly now: () => number;
  /** Per-villager timestamp of the last interrupt fired (anti-thrash). */
  private readonly lastInterruptAt = new Map<string, number>();
  /** Task ids for which a divine intervention staged the world (the critic reads this — D-12). */
  private readonly divineAssistedTasks = new Set<string>();

  constructor(opts: OrchestratorOptions) {
    this.state = opts.state;
    this.state.directivesOpen ??= [];
    this.journal = opts.journal;
    this.client = opts.client;
    this.scheduler = opts.scheduler;
    this.inboxes = opts.inboxes;
    this.systemPrompt = opts.systemPrompt ?? loadOrchestratorPrompt();
    this.tier = opts.tier ?? 'fast';
    this.interruptCooldownMs = opts.interruptCooldownMs ?? DEFAULT_INTERRUPT_COOLDOWN_MS;
    this.budget = opts.budget;
    this.degradeOnBreach = opts.degradeOnBreach ?? true;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Dispatch: turn a task/event into directive(s). Fast tier → `directive` tool calls; each call goes
   * through the anti-thrash rules and `openDirective` (the sole writer). Returns the opened directives
   * (the post-anti-thrash priority is what landed). Never throws into the loop.
   */
  async dispatch(opts: { task?: Task; event?: string; trigger: DispatchTrigger }): Promise<Directive[]> {
    const user = this.renderDispatchContext(opts);
    const result = await this.scheduler.enqueue({
      villager: 'god:orchestrator',
      lane: 'god',
      kind: 'orchestrator',
      run: () =>
        this.client.chat({
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: user },
          ],
          tools: [DIRECTIVE_TOOL],
          tier: this.tier,
          caller: 'god:orchestrator',
        }),
    });
    this.budget?.spend('orchestrator', result.usage.totalTokens);

    const out: Directive[] = [];
    for (const call of result.toolCalls) {
      if (call.name !== 'directive') continue;
      const a = call.arguments as Record<string, unknown>;
      const to = typeof a['to'] === 'string' ? a['to'] : undefined;
      const goal = typeof a['goal'] === 'string' ? a['goal'] : undefined;
      if (!to || !goal) continue;
      const priority: Priority = (PRIORITIES as readonly string[]).includes(String(a['priority'])) ? (a['priority'] as Priority) : 'normal';
      // D-13 degrade: when over budget, only urgent (interrupt) dispatch survives — drop the rest.
      if (this.degraded() && priority !== 'interrupt') continue;
      // The orchestrator binds the directive to the DISPATCHED task (authoritative), not the LLM's echo
      // of `taskRef` — so closeDirectivesForTask can find it by the real id when the task closes.
      const taskRef = opts.task?.id ?? (typeof a['taskRef'] === 'string' ? a['taskRef'] : undefined);
      const directive = this.openDirective({
        to,
        goal,
        reason: typeof a['reason'] === 'string' ? a['reason'] : '',
        priority,
        standing: a['standing'] === true,
        ...(taskRef !== undefined ? { taskRef } : {}),
      });
      out.push(directive);
    }
    return out;
  }

  /**
   * Open a directive deterministically (no LLM) — the shared sole-writer primitive both the LLM
   * dispatch and the real assignment loop (M4-3) use. Applies anti-thrash, writes directivesOpen,
   * delivers to the inbox, journals god.directive.
   */
  openDirective(spec: { to: string; goal: string; reason: string; priority: Priority; standing?: boolean; taskRef?: string; expiresAt?: number }): Directive {
    let priority = spec.priority;
    // Anti-thrash #2: no repeat interrupt within the cooldown — downgrade to normal (the order lands).
    if (priority === 'interrupt') {
      const last = this.lastInterruptAt.get(spec.to);
      if (last !== undefined && this.now() - last < this.interruptCooldownMs) {
        priority = 'normal';
      } else {
        this.lastInterruptAt.set(spec.to, this.now());
      }
    }

    // Anti-thrash #1: max 1 open NON-standing directive per villager — supersede the oldest.
    const superseded: string[] = [];
    if (!spec.standing) {
      const open = this.directives();
      const conflicts = open.filter((d) => d.to === spec.to && !d.standing);
      for (const c of conflicts) {
        this.removeDirective(c.id);
        this.journal.append('god:orchestrator', 'god.directive-closed', { directiveId: c.id, to: toName(c.to), reason: 'superseded' }, c.taskRef !== undefined ? { directiveId: c.id, taskId: c.taskRef } : { directiveId: c.id });
        superseded.push(c.id);
      }
    }

    const directive: Directive = {
      id: ulid(),
      to: spec.to,
      goal: spec.goal,
      reason: spec.reason,
      priority,
    };
    if (spec.standing) directive.standing = true;
    if (spec.taskRef !== undefined) directive.taskRef = spec.taskRef;
    if (spec.expiresAt !== undefined) directive.expiresAt = spec.expiresAt;
    this.directives().push(directive);

    // Deliver to the inbox (journals inbox.delivered first — 05).
    this.inboxes.get(spec.to)?.deliver({ from: 'god', kind: 'directive', payload: { directiveId: directive.id, goal: directive.goal, reason: directive.reason, priority: directive.priority }, at: this.now() });

    const payload: { directiveId: string; to: string; goal: string; priority: string; superseded?: string[] } = {
      directiveId: directive.id,
      to: spec.to,
      goal: directive.goal,
      priority: directive.priority,
    };
    if (superseded.length > 0) payload.superseded = superseded;
    this.journal.append('god:orchestrator', 'god.directive', payload, spec.taskRef !== undefined ? { directiveId: directive.id, taskId: spec.taskRef } : { directiveId: directive.id });
    return directive;
  }

  /**
   * Direct intervention — divine stage-setting via the avatar. Runs a divine skill (spawn mobs, clear
   * rain, deliver tools), journals god.appearance, and FLAGS divineAssisted for the task so the critic
   * voids any success the intervention itself achieved (D-12 voidDivineOverreach). Never does the
   * villager's task. Returns whether the action succeeded (false if the avatar is down — best-effort).
   */
  async intervene(opts: { villager: string; taskId?: string; action: string; args?: object }, body: DivineActor): Promise<boolean> {
    let ok = false;
    try {
      ok = await body.runAction(opts.action, opts.args ?? {});
    } catch {
      ok = false; // theatrics fail softly — the loop never depends on the body
    }
    if (opts.taskId !== undefined) this.divineAssistedTasks.add(opts.taskId);
    this.journal.append('god:orchestrator', 'god.appearance', { villager: opts.villager, action: opts.action, ok }, opts.taskId !== undefined ? { taskId: opts.taskId } : {});
    return ok;
  }

  /** Whether a divine intervention staged the world for this task — the critic reads it (D-12). */
  wasDivinelyAssisted(taskId: string): boolean {
    return this.divineAssistedTasks.has(taskId);
  }

  /** Clear the divine-assist flag (after a verdict consumed it). */
  clearDivineAssist(taskId: string): void {
    this.divineAssistedTasks.delete(taskId);
  }

  /** A villager objection/plea — journaled (report_to_god) + noted in the dossier (refusal is info). */
  reportToGod(opts: { villager: string; text: string }): void {
    const d = this.ensureDossier(opts.villager);
    d.notes.push(`objection (${new Date(this.now()).toISOString()}): ${opts.text}`);
    if (d.notes.length > MAX_DOSSIER_NOTES) d.notes.splice(0, d.notes.length - MAX_DOSSIER_NOTES);
    // No dedicated kind in M4 scope; report_to_god rides on brain.tool-call at the brain, and the
    // dossier note is the durable record. Journal the objection via inbox-style provenance is M5.
  }

  /** Close every open directive for a task — called when a verdict closes the task (M4-3). */
  closeDirectivesForTask(taskId: string, reason: 'completed' | 'expired' | 'superseded'): void {
    for (const d of [...this.directives()]) {
      if (d.taskRef === taskId) {
        this.removeDirective(d.id);
        this.journal.append('god:orchestrator', 'god.directive-closed', { directiveId: d.id, to: toName(d.to), reason }, { directiveId: d.id, taskId });
      }
    }
  }

  /** Expire directives past their expiresAt (an idle-sweep helper). Returns the count expired. */
  expireStale(): number {
    let n = 0;
    const now = this.now();
    for (const d of [...this.directives()]) {
      if (d.expiresAt !== undefined && d.expiresAt <= now) {
        this.removeDirective(d.id);
        this.journal.append('god:orchestrator', 'god.directive-closed', { directiveId: d.id, to: toName(d.to), reason: 'expired' }, d.taskRef !== undefined ? { directiveId: d.id, taskId: d.taskRef } : { directiveId: d.id });
        n++;
      }
    }
    return n;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private directives(): Directive[] {
    return (this.state.directivesOpen ??= []);
  }

  private removeDirective(id: string): void {
    const list = this.directives();
    const i = list.findIndex((d) => d.id === id);
    if (i >= 0) list.splice(i, 1);
  }

  private ensureDossier(villager: string): Dossier {
    let d = this.state.dossiers.get(villager);
    if (!d) {
      d = { villager, competence: {}, recentVerdicts: [], notes: [] };
      this.state.dossiers.set(villager, d);
    }
    return d;
  }

  private degraded(): boolean {
    return this.degradeOnBreach && (this.budget?.degraded('orchestrator') ?? false);
  }

  private renderDispatchContext(opts: { task?: Task; event?: string; trigger: DispatchTrigger }): string {
    const parts: string[] = [];
    parts.push(`## DÉCLENCHEUR\n${opts.trigger}`);
    if (opts.task) parts.push(`## TÂCHE\nbut: ${opts.task.goal}\ncritères: ${opts.task.successCriteria}${opts.task.assignee ? `\nassigné: ${opts.task.assignee}` : ''}`);
    if (opts.event) parts.push(`## ÉVÉNEMENT\n${opts.event}`);
    const open = this.directives();
    parts.push(`## DIRECTIVES OUVERTES (${open.length})\n${open.map((d) => `→ ${d.to}: ${d.goal} [${d.priority}${d.standing ? ', permanente' : ''}]`).join('\n') || '(aucune)'}`);
    parts.push('Émets une ou plusieurs `directive`. Délègue par défaut; n’interromps qu’en urgence.');
    return parts.join('\n\n');
  }
}

/** Render a directive recipient as one name string (orchestrator-opened directives are single-recipient). */
function toName(to: string | string[] | 'all'): string {
  return Array.isArray(to) ? to.join(',') : to;
}
