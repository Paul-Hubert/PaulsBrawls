// CriticDesk (layer 3, god/) — God's judgment desk (03 §The critic desk). It reads ONE skill run's
// complete evidence and renders a Verdict: success?, a constructive critique, and what becomes of the
// skill version in the shared library. Judgment quality is the product (D-06: desks share one state,
// never one context window — the critic builds its own pack).
//
// D-12 rails are deterministic and one-directional (R48): the LLM verdict is the centre, but
//   • a FAILED `check` forces success:false / no-admit regardless of the verdict (a passing check is
//     NOT an auto-admit — evidence FOR the critic, never a bypass);
//   • a success achieved by divine intervention is VOIDED (voidDivineOverreach — the orchestrator sets
//     `divineAssisted` in M4; the rail is here from M3).
// It judges WORLD DELTA, not a clean exit (R34/R35): the verdict reads the before/after snapshots; the
// check is the objective backstop. un-quarantine→active-probation (R37) is the library's job, driven by
// routeVerdict in god.ts.
//
// god/ imports skills/llm/render/journal/types (downward); it NEVER imports villagers/ — it reaches a
// villager only through the injected Inbox (the dependency law).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { CriticTicket, Dossier, ItemCheck, RunReport, SkillStats, Snapshot, Task, Verdict } from '../types/index';
import type { LlmClient, LlmToolDef, ModelTier } from '../llm/client';
import { LlmScheduler } from '../llm/scheduler';
import type { BudgetTracker } from '../llm/scheduler';
import { renderRunReport } from '../render/run-report';

/** Everything the critic needs to judge one run (03 §The critic's context pack). */
export interface CriticContext {
  ticket: CriticTicket;
  task: Task;
  /** The RunReport, complete (args, outcome, error verbatim, call tree, before/after snapshots). */
  report: RunReport;
  /** The skill version's full code — the critic is the one reader for whom code is never elided. */
  code: string;
  dossier?: Dossier;
  stats?: SkillStats;
  /** The last critique in this rollout chain, so critiques build instead of repeating. */
  lastCritique?: string;
  /** Set by the orchestrator (M4) when divine intervention achieved the delta — voids a success. */
  divineAssisted?: boolean;
}

/** Construction deps. */
export interface CriticDeskOptions {
  client: LlmClient;
  scheduler: LlmScheduler;
  /** Accepted for symmetry/wiring; the critic journals via the client (llm.call) + routeVerdict (god.verdict). */
  journal?: unknown;
  /** Defaults to {@link loadCriticPrompt}. */
  systemPrompt?: string;
  /** Default 'strong' — judgment is novelty, not dispatch (D-13). */
  tier?: ModelTier;
  /** D-13 safety valve: when over budget, degrade to the `check` + a templated critique (no LLM call). */
  budget?: BudgetTracker;
  /** Whether a budget breach degrades the critic (config god.budget.degradeOnBreach). Default true. */
  degradeOnBreach?: boolean;
  /** Verdict batching: max tickets fanned into one critic call when the queue backs up (D-13). Default 3. */
  batchMax?: number;
}

const LIBRARY_ACTIONS = ['admit', 'keep-draft', 'quarantine', 'archive', 'none'] as const;
type LibraryAction = (typeof LIBRARY_ACTIONS)[number];

const VERDICT_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'verdict',
    description: 'Rends ton jugement sur ce run (une seule fois).',
    parameters: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        score: { type: 'number', description: '0–10, optionnel' },
        critique: { type: 'string', description: 'le changement le plus instructif à faire (anglais)' },
        libraryAction: { type: 'string', enum: [...LIBRARY_ACTIONS] },
        praise: { type: 'string', description: 'optionnel, en français' },
      },
      required: ['success', 'critique', 'libraryAction'],
    },
  },
};

/** Reads the critic system prompt from god/prompts/critic.md (loaded at runtime, not bundled — S6). */
export function loadCriticPrompt(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, 'prompts', 'critic.md'), 'utf8');
}

/** God's critic desk. judge() returns the FINAL verdict (rails applied); routeVerdict (god.ts) executes it. */
export class CriticDesk {
  private readonly client: LlmClient;
  private readonly scheduler: LlmScheduler;
  private readonly systemPrompt: string;
  private readonly tier: ModelTier;
  private readonly budget?: BudgetTracker;
  private readonly degradeOnBreach: boolean;
  private readonly batchMax: number;

  constructor(opts: CriticDeskOptions) {
    this.client = opts.client;
    this.scheduler = opts.scheduler;
    this.systemPrompt = opts.systemPrompt ?? loadCriticPrompt();
    this.tier = opts.tier ?? 'strong';
    this.budget = opts.budget;
    this.degradeOnBreach = opts.degradeOnBreach ?? true;
    this.batchMax = opts.batchMax ?? 3;
  }

  /** Judge one ticket. The LLM verdict is centred; the deterministic D-12 rails are then applied. */
  async judge(ctx: CriticContext): Promise<Verdict> {
    // D-13 degrade: over budget → fall back to the `check` + a templated critique, NO LLM call. The
    // failing-check rail still holds; a degraded critic never auto-admits (it made no real judgment).
    if (this.degraded()) return this.templatedVerdict(ctx);

    const user = this.renderContext(ctx);
    const result = await this.scheduler.enqueue({
      villager: 'god:critic',
      lane: 'god', // God preempts villager lanes (03 §Cost control)
      kind: 'critic',
      run: () =>
        this.client.chat({
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: user },
          ],
          tools: [VERDICT_TOOL],
          tier: this.tier,
          caller: 'god:critic',
          refs: { rolloutId: ctx.report.rolloutId, runId: ctx.report.runId, skill: ctx.report.skill, skillVersion: ctx.report.version },
        }),
    });
    this.budget?.spend('critic', result.usage.totalTokens);

    const verdict = this.parseVerdict(result.toolCalls.find((c) => c.name === 'verdict')?.arguments, result.content, ctx.ticket.id);
    return this.applyRails(verdict, ctx);
  }

  /**
   * Verdict batching (D-13): fan up to {@link batchMax} (default 3) tickets into ONE critic call when
   * the queue backs up. Each verdict tool call carries its `ticketId`; the result is mapped back to the
   * matching context and the D-12 rails applied per ticket. Tickets beyond the cap are NOT judged here
   * (the caller re-batches the rest). When degraded, every ticket falls back to its templated verdict.
   */
  async judgeBatch(contexts: CriticContext[]): Promise<Verdict[]> {
    const batch = contexts.slice(0, this.batchMax);
    if (batch.length === 0) return [];
    if (batch.length === 1) return [await this.judge(batch[0]!)];
    if (this.degraded()) return batch.map((c) => this.templatedVerdict(c));

    const user = batch.map((c, i) => `### TICKET ${i + 1} (ticketId: ${c.ticket.id})\n${this.renderContext(c)}`).join('\n\n');
    const result = await this.scheduler.enqueue({
      villager: 'god:critic',
      lane: 'god',
      kind: 'critic',
      run: () =>
        this.client.chat({
          messages: [
            { role: 'system', content: `${this.systemPrompt}\n\nTu juges ${batch.length} tickets d'un coup: appelle l'outil \`verdict\` UNE FOIS PAR TICKET, en renseignant \`ticketId\`.` },
            { role: 'user', content: user },
          ],
          tools: [VERDICT_TOOL],
          tier: this.tier,
          caller: 'god:critic',
        }),
    });
    this.budget?.spend('critic', result.usage.totalTokens);

    const calls = result.toolCalls.filter((c) => c.name === 'verdict');
    return batch.map((ctx, i) => {
      // Match by ticketId when present, else fall back to positional order.
      const args = calls.find((c) => (c.arguments as Record<string, unknown>)['ticketId'] === ctx.ticket.id)?.arguments
        ?? calls[i]?.arguments;
      const verdict = this.parseVerdict(args, result.content, ctx.ticket.id);
      return this.applyRails(verdict, ctx);
    });
  }

  private degraded(): boolean {
    return this.degradeOnBreach && (this.budget?.degraded('critic') ?? false);
  }

  /**
   * The degraded verdict (D-13): judged from the objective inventory `check` alone (R34/R35: world
   * delta, not a clean exit) plus a templated critique. A degraded critic never auto-admits — it lacks
   * a real judgment, so even a satisfied check yields `keep-draft` (the failing-check rail still vetoes).
   */
  private templatedVerdict(ctx: CriticContext): Verdict {
    const checkOk = ctx.task.check ? checkSatisfied(ctx.report.worldAfter, ctx.task.check) : ctx.report.outcome.ok;
    const critique = checkOk
      ? '[critique templatée — budget du critique dépassé (D-13): le check objectif est satisfait, mais aucune admission sans jugement réel. Réessaie quand le budget se réinitialise.]'
      : `[critique templatée — budget du critique dépassé (D-13): le check objectif n'est PAS satisfait${ctx.task.check ? ` (il faut ${ctx.task.check.count}× ${ctx.task.check.item})` : ''} (R34).]`;
    return { ticketId: ctx.ticket.id, success: checkOk, critique, libraryAction: 'keep-draft' };
  }

  private renderContext(ctx: CriticContext): string {
    const parts: string[] = [];
    parts.push(`## TÂCHE\nbut: ${ctx.task.goal}\ncritères: ${ctx.task.successCriteria}` + (ctx.task.check ? `\ncheck objectif: ${ctx.task.check.count}× ${ctx.task.check.item}` : ''));
    parts.push(`## RUN REPORT\n${renderRunReport(ctx.report)}`);
    parts.push(`## CODE DU SKILL (v${ctx.report.version})\n${ctx.code}`);
    if (ctx.dossier) parts.push(`## DOSSIER (${ctx.dossier.villager})\ncompétences: ${JSON.stringify(ctx.dossier.competence)}\nnotes: ${ctx.dossier.notes.join('; ') || '(aucune)'}`);
    if (ctx.stats) parts.push(`## STATS\nruns=${ctx.stats.runs} successes=${ctx.stats.successes} failures=${ctx.stats.failures}`);
    if (ctx.lastCritique) parts.push(`## DERNIÈRE CRITIQUE (chaîne)\n${ctx.lastCritique}`);
    parts.push('Appelle l’outil `verdict` avec ton jugement.');
    return parts.join('\n\n');
  }

  private parseVerdict(args: object | undefined, content: string | null, ticketId: string): Verdict {
    const raw = (args as Record<string, unknown> | undefined) ?? parseContentJson(content);
    if (!raw) {
      // No structured reply — degrade to a safe, non-admitting verdict (never throw into the loop).
      return { ticketId, success: false, critique: '(critique indisponible — réponse non structurée)', libraryAction: 'keep-draft' };
    }
    const libraryAction = toAction(raw['libraryAction']);
    const verdict: Verdict = {
      ticketId,
      success: raw['success'] === true,
      critique: typeof raw['critique'] === 'string' ? raw['critique'] : '(aucune critique fournie)',
      libraryAction,
    };
    if (typeof raw['score'] === 'number') verdict.score = raw['score'];
    if (typeof raw['praise'] === 'string') verdict.praise = raw['praise'];
    return verdict;
  }

  /** The deterministic D-12 rails (one-directional, R48). */
  private applyRails(verdict: Verdict, ctx: CriticContext): Verdict {
    let { success, libraryAction, critique } = verdict;

    // check-veto: a FAILED check forces success:false / no-admit, regardless of the verdict.
    if (ctx.task.check && !checkSatisfied(ctx.report.worldAfter, ctx.task.check)) {
      if (success || libraryAction === 'admit') {
        critique = `${critique} [check non satisfait: il faut ${ctx.task.check.count}× ${ctx.task.check.item} (R34: une sortie propre n'est pas un progrès).]`;
      }
      success = false;
      if (libraryAction === 'admit') libraryAction = 'keep-draft';
    }

    // voidDivineOverreach: a success achieved by divine intervention can never inflate the ledger.
    if (ctx.divineAssisted && success) {
      success = false;
      if (libraryAction === 'admit') libraryAction = 'keep-draft';
      critique = `${critique} [succès voidé: l'objectif a été atteint par intervention divine, pas par le skill du villageois (overreach).]`;
    }

    return { ...verdict, success, libraryAction, critique };
  }
}

function toAction(v: unknown): LibraryAction {
  return typeof v === 'string' && (LIBRARY_ACTIONS as readonly string[]).includes(v) ? (v as LibraryAction) : 'keep-draft';
}

function parseContentJson(content: string | null): Record<string, unknown> | undefined {
  if (!content) return undefined;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    const obj: unknown = JSON.parse(content.slice(start, end + 1));
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether worldAfter holds at least `check.count` of `check.item` (the objective task criterion). */
function checkSatisfied(after: Snapshot | null, check: ItemCheck): boolean {
  if (!after) return false;
  const have = after.inventory.filter((i) => i.name === check.item).reduce((s, i) => s + i.count, 0);
  return have >= check.count;
}
