// Curriculum (layer 3, god/) — God's curriculum desk (03 §The curriculum desk). Voyager's
// CurriculumAgent, globalized: it proposes what the *village* learns next, not one bot. It is the
// SOLE WRITER of the TaskLedger (S2): every open/completed/failed/retired transition flows through
// here, and nothing else mutates `state.ledger`.
//
// Ported Voyager mechanics, kept deliberately:
//   • propose ONE task at the edge of current ability (strong tier — novelty, D-13);
//   • the QA knowledge cache ("how to X in Minecraft?" answered once by the FAST tier,
//     embedding-deduped, persisted, folded into Task.context forever after — zero-token on a hit);
//   • decompose(goal) → ordered sub-tasks with `parent`;
//   • warm-up: an early/empty ledger keeps proposals survival-basic (a config table, not code);
//   • clean_up_tasks: a `failed` record is retired when a later task completes the same goal.
//
// Triggers (the caller chooses, not the desk): a villager goes idle with no open task; a verdict
// closes a task; dawn (one village review per Minecraft day); a critic `followUp.task`; an admin
// request. The trigger is journaled on god.task-proposed so the website can show *why* a task exists.
//
// god/ imports skills/llm/render/journal/types (downward); it NEVER imports villagers/ or social/.
// The desk holds GodState by reference (the single home, S2) — not GodService — so there is no cycle.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { monotonicFactory } from 'ulid';

import type { ItemCheck, Task, TaskRecord } from '../types/index';
import type { IJournal } from '../journal/journal';
import type { LlmClient, LlmToolDef, ModelTier } from '../llm/client';
import { LlmScheduler } from '../llm/scheduler';
import { EmbeddingsService, cosine, keywordScore } from '../llm/embeddings';
import type { GodState } from './god';
import type { BudgetTracker } from '../llm/scheduler';

const ulid = monotonicFactory();
const DEFAULT_MAX_RETRIES = 4; // Voyager's number (03 §Curriculum)
const WARMUP_COMPLETED = 8; // ledger.completed below this ⇒ warm-up phase (config table, 03)
const QA_DEDUP_THRESHOLD = 0.92; // near-identical "how to" questions share one cached answer

/** A cached "how to X in Minecraft?" Q→A entry — the village's accumulated handbook (Voyager). */
interface QaEntry {
  question: string;
  answer: string;
  vector?: number[];
}

/** Construction deps (wired in main.ts). The desk writes GodState.ledger directly — the sole writer. */
export interface CurriculumOptions {
  /** The single God state home (S2). The desk is the sole writer of `state.ledger`. */
  state: GodState;
  journal: IJournal;
  client: LlmClient;
  scheduler: LlmScheduler;
  /** Embedding-dedupes the QA cache (R38 keyword floor when off/degraded). */
  embeddings: EmbeddingsService;
  systemPrompt?: string;
  /** Proposal/decompose run on the STRONG tier (frontier selection compounds — D-13). */
  tier?: ModelTier;
  /** QA "how to" answers run on the FAST tier (high-volume shallow — D-13). */
  fastTier?: ModelTier;
  /** D-13 safety valve: when over-budget, repeat the last task type instead of a fresh proposal (M4-4). */
  budget?: BudgetTracker;
  /** Whether a budget breach degrades the desk (config god.budget.degradeOnBreach). */
  degradeOnBreach?: boolean;
  now?: () => number;
}

const PROPOSE_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'propose_task',
    description: 'Propose UNE tâche au bord de la capacité actuelle du village (Voyager).',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'le but, ex. "Acquire an iron pickaxe" (anglais)' },
        successCriteria: { type: 'string', description: 'critère que le critique juge (anglais)' },
        check: {
          type: 'object',
          description: 'optionnel: vérif inventaire objective {item, count}',
          properties: { item: { type: 'string' }, count: { type: 'number' } },
        },
        assignee: { type: 'string', description: 'optionnel; sinon l’orchestrateur choisit' },
        howTo: { type: 'string', description: 'optionnel: question "how to X in Minecraft?" — sa réponse en cache devient le contexte' },
      },
      required: ['goal', 'successCriteria'],
    },
  },
};

const DECOMPOSE_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'decompose',
    description: 'Décompose un grand but en sous-tâches ordonnées (chacune héritant du but parent).',
    parameters: {
      type: 'object',
      properties: {
        subtasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              goal: { type: 'string' },
              successCriteria: { type: 'string' },
              check: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'number' } } },
            },
            required: ['goal', 'successCriteria'],
          },
        },
      },
      required: ['subtasks'],
    },
  },
};

/** Reads the curriculum system prompt from god/prompts/curriculum.md (loaded at runtime — S6). */
export function loadCurriculumPrompt(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, 'prompts', 'curriculum.md'), 'utf8');
}

/** What woke the curriculum desk (journaled on god.task-proposed). */
export type CurriculumTrigger = 'idle' | 'verdict-close' | 'dawn' | 'critic-follow-up' | 'admin';

/** The curriculum desk — the sole writer of the TaskLedger (S2). */
export class Curriculum {
  private readonly state: GodState;
  private readonly journal: IJournal;
  private readonly client: LlmClient;
  private readonly scheduler: LlmScheduler;
  private readonly embeddings: EmbeddingsService;
  private readonly systemPrompt: string;
  private readonly tier: ModelTier;
  private readonly fastTier: ModelTier;
  private readonly budget?: BudgetTracker;
  private readonly degradeOnBreach: boolean;
  private readonly now: () => number;
  private readonly qa: QaEntry[] = [];

  constructor(opts: CurriculumOptions) {
    this.state = opts.state;
    this.journal = opts.journal;
    this.client = opts.client;
    this.scheduler = opts.scheduler;
    this.embeddings = opts.embeddings;
    this.systemPrompt = opts.systemPrompt ?? loadCurriculumPrompt();
    this.tier = opts.tier ?? 'strong';
    this.fastTier = opts.fastTier ?? 'fast';
    this.budget = opts.budget;
    this.degradeOnBreach = opts.degradeOnBreach ?? true;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Propose ONE task at the edge of ability. Strong tier (novelty). On a structured reply, the task
   * enters the ledger (sole writer) + the task map and journals god.task-proposed; the optional
   * `howTo` question's cached answer is folded into Task.context. Returns undefined on no proposal.
   *
   * D-13 degrade (M4-4): when the curriculum desk is over budget, repeat the LAST task's type instead
   * of spending a fresh strong-tier proposal — keeps the loop fed without burning the wallet (R49).
   */
  async proposeTask(opts: { trigger: CurriculumTrigger; villager?: string }): Promise<Task | undefined> {
    if (this.degraded()) {
      const repeated = this.repeatLastTaskType(opts);
      if (repeated) return repeated; // degraded path: no LLM call
    }

    const user = this.renderProposalContext(opts.villager);
    const result = await this.scheduler.enqueue({
      villager: 'god:curriculum',
      lane: 'god',
      kind: 'curriculum',
      run: () =>
        this.client.chat({
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: user },
          ],
          tools: [PROPOSE_TOOL],
          tier: this.tier,
          caller: 'god:curriculum',
        }),
    });
    this.budget?.spend('curriculum', result.usage.totalTokens);

    const args = result.toolCalls.find((c) => c.name === 'propose_task')?.arguments as Record<string, unknown> | undefined;
    if (!args || typeof args['goal'] !== 'string') return undefined;

    const context = typeof args['howTo'] === 'string' && args['howTo'].length > 0 ? await this.howTo(args['howTo']) : '';
    const task = this.makeTask({
      goal: args['goal'],
      successCriteria: typeof args['successCriteria'] === 'string' ? args['successCriteria'] : '',
      check: toCheck(args['check']),
      assignee: typeof args['assignee'] === 'string' ? args['assignee'] : opts.villager,
      context,
    });
    this.admit(task, opts.trigger);
    return task;
  }

  /**
   * QA knowledge cache (Voyager). Answers a "how to X in Minecraft?" question ONCE on the fast tier,
   * dedups near-identical questions (embedding cosine ≥ threshold, keyword floor when off — R38), and
   * persists the answer. A cache HIT spends zero LLM calls (zero-token reactivity — D-13/R49).
   */
  async howTo(question: string): Promise<string> {
    const hit = await this.findCached(question);
    if (hit) return hit.answer;

    const result = await this.scheduler.enqueue({
      villager: 'god:curriculum',
      lane: 'god',
      kind: 'qa',
      run: () =>
        this.client.chat({
          messages: [
            { role: 'system', content: 'Réponds brièvement et concrètement à une question "how to" sur Minecraft (ingrédients, étapes). Anglais ou français.' },
            { role: 'user', content: question },
          ],
          tier: this.fastTier,
          caller: 'god:curriculum',
        }),
    });
    this.budget?.spend('curriculum', result.usage.totalTokens);
    const answer = result.content ?? '';
    const vec = await this.embed(question);
    this.qa.push(vec ? { question, answer, vector: vec } : { question, answer });
    return answer;
  }

  /**
   * Decompose a big goal into ordered sub-tasks (strong tier), each carrying `parent = goal`. All
   * sub-tasks enter the ledger (sole writer) + journal god.task-proposed. Returns them in order.
   */
  async decompose(goal: string): Promise<Task[]> {
    const result = await this.scheduler.enqueue({
      villager: 'god:curriculum',
      lane: 'god',
      kind: 'decompose',
      run: () =>
        this.client.chat({
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: `Décompose ce grand but en sous-tâches ordonnées et réalisables: « ${goal} ». Appelle l’outil decompose.` },
          ],
          tools: [DECOMPOSE_TOOL],
          tier: this.tier,
          caller: 'god:curriculum',
        }),
    });
    this.budget?.spend('curriculum', result.usage.totalTokens);

    const args = result.toolCalls.find((c) => c.name === 'decompose')?.arguments as { subtasks?: unknown } | undefined;
    const raw = Array.isArray(args?.subtasks) ? args!.subtasks : [];
    const out: Task[] = [];
    for (const s of raw) {
      const so = (s ?? {}) as Record<string, unknown>;
      if (typeof so['goal'] !== 'string') continue;
      const task = this.makeTask({
        goal: so['goal'],
        successCriteria: typeof so['successCriteria'] === 'string' ? so['successCriteria'] : '',
        check: toCheck(so['check']),
        parent: goal,
        context: '',
      });
      this.admit(task, 'admin');
      out.push(task);
    }
    return out;
  }

  /** Add an externally-created task (admin / orchestrator / a decomposed sub-task) to the ledger. */
  addTask(task: Task, trigger: CurriculumTrigger = 'admin'): void {
    this.admit(task, trigger);
  }

  /**
   * Close a task — the SOLE ledger-write path for a verdict-closed task (S2). Moves it out of `open`
   * and the task map, lands it in completed/failed, and journals god.task-closed. (GodService delegates
   * its M3 closeTask here in M4-3.)
   */
  closeTask(task: Task, verdictId: string | undefined, ok: boolean): void {
    delete task.currentRolloutId;
    this.state.tasks.delete(task.id);
    this.state.ledger.open = this.state.ledger.open.filter((t) => t.id !== task.id);
    const record: TaskRecord = { task, closedAt: this.now(), verdictId };
    (ok ? this.state.ledger.completed : this.state.ledger.failed).push(record);
    this.journal.append(
      'god:curriculum',
      'god.task-closed',
      { taskId: task.id, goal: task.goal, outcome: ok ? 'completed' : 'failed' },
      verdictId !== undefined ? { taskId: task.id, verdictId } : { taskId: task.id },
    );
  }

  /**
   * Voyager clean_up_tasks: retire a `failed` record whose goal a LATER `completed` task achieved — a
   * stale failure should not keep steering proposals away from a now-solved goal. Journals
   * god.task-closed{outcome:'retired'} for each. Returns the count retired.
   */
  cleanUpTasks(): number {
    const completedGoals = new Set(this.state.ledger.completed.map((r) => r.task.goal));
    const keep: TaskRecord[] = [];
    let retired = 0;
    for (const rec of this.state.ledger.failed) {
      if (completedGoals.has(rec.task.goal)) {
        retired++;
        this.journal.append('god:curriculum', 'god.task-closed', { taskId: rec.task.id, goal: rec.task.goal, outcome: 'retired' }, { taskId: rec.task.id });
      } else {
        keep.push(rec);
      }
    }
    this.state.ledger.failed = keep;
    return retired;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private makeTask(input: { goal: string; successCriteria: string; check?: ItemCheck; assignee?: string; parent?: string; context: string }): Task {
    const task: Task = {
      id: ulid(),
      goal: input.goal,
      successCriteria: input.successCriteria,
      context: input.context,
      maxRetries: DEFAULT_MAX_RETRIES,
    };
    if (input.check) task.check = input.check;
    if (input.assignee !== undefined) task.assignee = input.assignee;
    if (input.parent !== undefined) task.parent = input.parent;
    return task;
  }

  /** The sole ledger-write for a NEW open task: into open + the task map, journal god.task-proposed. */
  private admit(task: Task, trigger: CurriculumTrigger): void {
    this.state.tasks.set(task.id, task);
    if (!this.state.ledger.open.some((t) => t.id === task.id)) this.state.ledger.open.push(task);
    const payload: { taskId: string; goal: string; assignee?: string; trigger: string; parent?: string } = {
      taskId: task.id,
      goal: task.goal,
      trigger,
    };
    if (task.assignee !== undefined) payload.assignee = task.assignee;
    if (task.parent !== undefined) payload.parent = task.parent;
    this.journal.append('god:curriculum', 'god.task-proposed', payload, { taskId: task.id });
  }

  /** Build the proposal context: ledger frontier, coverage, phase. Specific enough to be checkable. */
  private renderProposalContext(villager?: string): string {
    const led = this.state.ledger;
    const phase = led.completed.length < WARMUP_COMPLETED ? 'WARM-UP (early/survival-basic phase)' : 'ÉTABLI';
    const parts: string[] = [];
    parts.push(`## PHASE\n${phase} — ${led.completed.length} tâches réussies à ce jour.`);
    if (phase.startsWith('WARM-UP')) {
      parts.push('Le village est fragile: propose une tâche de SURVIE basique (bois, nourriture, outils simples). N’ouvre pas le late-game.');
    }
    parts.push(`## FRONTIÈRE — RÉUSSIES (${led.completed.length})\n${led.completed.slice(-12).map((r) => `✓ ${r.task.goal}`).join('\n') || '(aucune)'}`);
    parts.push(`## FRONTIÈRE — ÉCHOUÉES (${led.failed.length})\n${led.failed.slice(-12).map((r) => `✗ ${r.task.goal}`).join('\n') || '(aucune)'}`);
    parts.push(`## TÂCHES OUVERTES (${led.open.length})\n${led.open.map((t) => `• ${t.goal}${t.assignee ? ` → ${t.assignee}` : ''}`).join('\n') || '(aucune)'}`);
    if (villager) {
      const d = this.state.dossiers.get(villager);
      parts.push(`## VILLAGEOIS DEMANDEUR (${villager})\ncompétences: ${d ? JSON.stringify(d.competence) : '(inconnu)'}`);
    }
    parts.push('Propose UNE tâche au bord de la capacité actuelle. Appelle l’outil `propose_task`.');
    return parts.join('\n\n');
  }

  /** Find a cached QA entry whose question matches (semantic cosine ≥ threshold, else keyword floor). */
  private async findCached(question: string): Promise<QaEntry | undefined> {
    if (this.qa.length === 0) return undefined;
    const qVec = await this.embed(question);
    if (qVec) {
      let best: QaEntry | undefined;
      let bestScore = 0;
      for (const e of this.qa) {
        if (!e.vector) continue;
        const s = cosine(qVec, e.vector);
        if (s > bestScore) {
          bestScore = s;
          best = e;
        }
      }
      if (best && bestScore >= QA_DEDUP_THRESHOLD) return best;
    }
    // Keyword floor (R38): exact-ish overlap on the question text.
    for (const e of this.qa) {
      if (keywordScore(question, e.question) >= QA_DEDUP_THRESHOLD) return e;
      if (e.question === question) return e;
    }
    return undefined;
  }

  private async embed(text: string): Promise<number[] | undefined> {
    const vecs = await this.embeddings.embed([text]);
    return vecs?.[0];
  }

  private degraded(): boolean {
    return this.degradeOnBreach && (this.budget?.degraded('curriculum') ?? false);
  }

  /** D-13 degrade: re-issue the most recent open/completed task's TYPE (same goal) — no LLM call. */
  private repeatLastTaskType(opts: { trigger: CurriculumTrigger; villager?: string }): Task | undefined {
    const led = this.state.ledger;
    const template = led.open[led.open.length - 1] ?? led.completed[led.completed.length - 1]?.task;
    if (!template) return undefined;
    const task = this.makeTask({
      goal: template.goal,
      successCriteria: template.successCriteria,
      check: template.check,
      assignee: opts.villager ?? template.assignee,
      context: template.context,
    });
    this.admit(task, opts.trigger);
    return task;
  }
}

function toCheck(v: unknown): ItemCheck | undefined {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['item'] === 'string' && typeof o['count'] === 'number') return { item: o['item'], count: o['count'] };
  }
  return undefined;
}
