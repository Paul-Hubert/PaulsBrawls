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

import type { ItemCheck, Snapshot, Task, TaskRecord, TaskSuggestion } from '../types/index';
import type { IJournal } from '../journal/journal';
import type { LlmClient, LlmToolDef, ModelTier } from '../llm/client';
import { LlmScheduler } from '../llm/scheduler';
import { EmbeddingsService, cosine, keywordScore } from '../llm/embeddings';
import { SkillLibrary } from '../skills/library';
import type { GodState } from './god';
import type { BudgetTracker } from '../llm/scheduler';

const ulid = monotonicFactory();
const DEFAULT_MAX_RETRIES = 4; // Voyager's number (03 §Curriculum)
// R65 convergence breaker: a rollout that EXHAUSTS its maxRetries without converging is one failed
// attempt at the task; after this many exhausted rollouts the curriculum STOPS re-attempting the
// identical task and closes it `failed` (a blocked-task signal), so the loop moves on instead of grinding
// the same wall forever (the D3 incident: 13 attempts / 21 min / 0 progress). Small on purpose — an
// over-bundled or precondition-gated task that code-revision can't satisfy is detected fast (R33–R37:
// repeated failure must become a signal that changes the task, not silent grinding).
const MAX_ROLLOUT_ATTEMPTS = 2;
const WARMUP_COMPLETED = 8; // ledger.completed below this ⇒ warm-up phase (config table, 03)
const QA_DEDUP_THRESHOLD = 0.92; // near-identical "how to" questions share one cached answer

/** A cached "how to X in Minecraft?" Q→A entry — the village's accumulated handbook (Voyager). */
export interface QaEntry {
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
  /** The shared skill library — renders "existing reusable skills" into the proposal context so God
   *  proposes COMPOSING what the village already has (not re-acquiring it). Optional: omitted in unit
   *  harnesses (coverage section simply absent). god/ → skills/ is a downward import (dependency law). */
  library?: SkillLibrary;
  /** True when a scenario `godPrompt` mission is appended to this desk's system prompt (set in main.ts).
   *  Flips the warm-up nudge: instead of the generic "gather wood/food/tools" survival default, warm-up
   *  serves the mission with the villager's CURRENT inventory + skills (so a scenario that says "the hoe
   *  is provided" doesn't get a wood-gathering task proposed at it forever). */
  hasMissionDirective?: boolean;
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
  private readonly library?: SkillLibrary;
  private readonly hasMission: boolean;
  private readonly systemPrompt: string;
  private readonly tier: ModelTier;
  private readonly fastTier: ModelTier;
  private readonly budget?: BudgetTracker;
  private readonly degradeOnBreach: boolean;
  private readonly now: () => number;
  private readonly qa: QaEntry[] = [];
  /** R65 convergence breaker: per-task count of EXHAUSTED rollouts (a rollout that ran its full
   *  maxRetries without converging). Curriculum-owned (sole ledger writer — S2); the entry is dropped
   *  when the task closes. Used only to decide WHEN to give up re-attempting an unconvergeable task. */
  private readonly exhaustedRollouts = new Map<string, number>();

  constructor(opts: CurriculumOptions) {
    this.state = opts.state;
    this.journal = opts.journal;
    this.client = opts.client;
    this.scheduler = opts.scheduler;
    this.embeddings = opts.embeddings;
    this.library = opts.library;
    this.hasMission = opts.hasMissionDirective ?? false;
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
  async proposeTask(opts: { trigger: CurriculumTrigger; villager?: string; snapshot?: Snapshot }): Promise<Task | undefined> {
    if (this.degraded()) {
      const repeated = this.repeatLastTaskType(opts);
      if (repeated) return repeated; // degraded path: no LLM call
    }

    const user = this.renderProposalContext(opts);
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
          // R68: FORCE the single tool (as the critic does, R52). With `tool_choice:'auto'` gpt-4o
          // intermittently narrates the propose_task JSON inside a ```json``` block in the text content
          // instead of emitting a real tool call (finish_reason='stop', toolCalls empty) → proposeTask
          // returns undefined → the VillageLoop idles 5 s and retries the IDENTICAL context, getting the
          // same narration. Live (2026-06-16): 54% of strong-tier curriculum calls were wasted this way.
          // The desk has exactly ONE job and ONE tool — there is never a legitimate text-only turn.
          toolChoice: { type: 'function', function: { name: 'propose_task' } },
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
          // R68: force the single tool (same reasoning as proposeTask above — a decompose turn must emit a
          // real tool call, never narrate the subtasks JSON as text).
          toolChoice: { type: 'function', function: { name: 'decompose' } },
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

  /** B3.9 — the curriculum's own working state (QA cache + R65 exhausted counts) for the God snapshot. */
  exportState(): { qa: QaEntry[]; exhausted: Array<[string, number]> } {
    return { qa: this.qa.map((e) => ({ ...e })), exhausted: [...this.exhaustedRollouts.entries()] };
  }

  /** B3.9 — restore what {@link exportState} saved (boot; replaces the in-memory copies). */
  importState(s: { qa?: QaEntry[]; exhausted?: Array<[string, number]> }): void {
    this.qa.splice(0, this.qa.length, ...(s.qa ?? []));
    this.exhaustedRollouts.clear();
    for (const [k, v] of s.exhausted ?? []) this.exhaustedRollouts.set(k, v);
  }

  /** Add an externally-created task (admin / orchestrator / a decomposed sub-task) to the ledger. */
  addTask(task: Task, trigger: CurriculumTrigger = 'admin'): void {
    this.admit(task, trigger);
  }

  /**
   * R72 — enqueue the critic's follow-up ACQUIRE-task that unblocks a blocked task (e.g. a blocked
   * sow-task's "harvest mature wheat to obtain wheat_seeds"). The sole ledger writer (S2) creates it.
   * Anti-loop: a blocked→acquire chain can circle back (sow→harvest→sow), so a follow-up whose goal is
   * already OPEN or was RECENTLY FAILED is dropped — the pivot never spawns a duplicate or an endless
   * chain of the same goal. Returns the created task, or undefined when there is no goal or it deduped.
   */
  addFollowUp(suggestion: TaskSuggestion, assignee?: string): Task | undefined {
    const goal = suggestion.goal?.trim();
    if (!goal) return undefined;
    const n = normGoal(goal);
    if (this.state.ledger.open.some((t) => normGoal(t.goal) === n)) return undefined;
    if (this.state.ledger.failed.slice(-12).some((r) => normGoal(r.task.goal) === n)) return undefined;
    const task = this.makeTask({
      goal,
      successCriteria: suggestion.successCriteria ?? '',
      check: suggestion.check,
      assignee: suggestion.assignee ?? assignee,
      context: '',
    });
    this.admit(task, 'critic-follow-up');
    return task;
  }

  /**
   * Close a task — the SOLE ledger-write path for a verdict-closed task (S2). Moves it out of `open`
   * and the task map, lands it in completed/failed, and journals god.task-closed. (GodService delegates
   * its M3 closeTask here in M4-3.) `reason` (optional) carries WHY for a non-verdict close — the
   * convergence breaker (noteExhausted) passes the give-up reason naming the task + attempt count (S10).
   */
  closeTask(task: Task, verdictId: string | undefined, ok: boolean, reason?: string): void {
    delete task.currentRolloutId;
    this.state.tasks.delete(task.id);
    this.exhaustedRollouts.delete(task.id); // R65: counter dies with the task
    this.state.ledger.open = this.state.ledger.open.filter((t) => t.id !== task.id);
    const record: TaskRecord = { task, closedAt: this.now(), verdictId };
    if (reason !== undefined) record.reason = reason; // persist WHY for the failed-frontier memory (R70)
    (ok ? this.state.ledger.completed : this.state.ledger.failed).push(record);
    const payload: { taskId: string; goal: string; outcome: 'completed' | 'failed' | 'retired'; reason?: string } = {
      taskId: task.id,
      goal: task.goal,
      outcome: ok ? 'completed' : 'failed',
    };
    if (reason !== undefined) payload.reason = reason;
    this.journal.append(
      'god:curriculum',
      'god.task-closed',
      payload,
      verdictId !== undefined ? { taskId: task.id, verdictId } : { taskId: task.id },
    );
  }

  /**
   * R65 convergence breaker — the SOLE writer's record of a non-converging rollout (S2). Called by the
   * RolloutCoordinator when a rollout returns `converged:false` after exhausting its maxRetries. Counts
   * the task's exhausted rollouts; once it reaches {@link MAX_ROLLOUT_ATTEMPTS}, the task is CLOSED `failed`
   * with a blocked-task reason (so the curriculum stops re-proposing/re-attempting the identical
   * unconvergeable task and the village moves on). Below the threshold the task stays OPEN to retry — the
   * legitimate path is unchanged. Returns true iff the breaker fired (the task was given up). A task that
   * is not open (already closed by a success verdict) is a no-op.
   *
   * Per R33–R37: repeated failure becomes a ledger/dossier SIGNAL that changes the task — not an engine
   * that silently re-proposes the same wall forever. (Future hook: a blocked over-bundled task is a natural
   * `decompose()` candidate — left to the curriculum's existing decomposition entrypoint, not done here.)
   */
  noteExhausted(task: Task, lastCritique?: string): boolean {
    if (!this.state.tasks.has(task.id)) return false; // already closed (e.g. a converged success)
    const attempts = (this.exhaustedRollouts.get(task.id) ?? 0) + 1;
    if (attempts < MAX_ROLLOUT_ATTEMPTS) {
      this.exhaustedRollouts.set(task.id, attempts);
      return false; // still within budget — leave it open to retry (unchanged path)
    }
    // R70: carry the last critique into the close reason so the failed-frontier remembers the OBSTACLE, not
    // just the goal — the curriculum's only cross-deliberation memory is the ledger, so a future proposal
    // can see why « goal » failed and decompose it / pick something else instead of re-proposing the wall.
    const why = lastCritique && lastCritique.length > 0 ? ` — dernier obstacle: ${truncate(lastCritique, 240)}` : '';
    const reason = `blocked: « ${task.goal} » not converged after ${attempts} exhausted rollout(s) (R65 breaker — stop grinding, move on)${why}`;
    this.closeTask(task, undefined, false, reason);
    return true;
  }

  /**
   * R70 — the oldest OPEN task assigned to `villager` (or unassigned) with no live rollout: the resumable
   * backlog item the autonomous loop re-runs BEFORE proposing a fresh task. Without this the VillageLoop
   * always proposes a NEW task id every idle turn, so no task is ever re-attempted — the R65 breaker (keyed
   * per task id) never accrues its second exhausted rollout, nothing closes `failed`, and the open list
   * fills with near-duplicate unconvergeable goals (the live "bake bread ×9" grind). Resuming the same id
   * lets the breaker fire as designed. `ledger.open` is push-ordered, so the first match is the oldest (FIFO
   * drain). Read-only — assignment/claim is the caller's (S2: the desk only WRITES the ledger here).
   */
  nextOpenTaskFor(villager: string): Task | undefined {
    return this.state.ledger.open.find(
      (t) => t.currentRolloutId === undefined && (t.assignee === villager || t.assignee === undefined),
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

  /** Build the proposal context: phase, the requesting villager's live inventory, the existing reusable
   *  skills, the ledger frontier, and the dossier. Inventory + skills are decision-critical: without them
   *  God proposes acquiring prerequisites the villager already holds (the "find wood for a hoe it already
   *  has" failure) and can't see what to COMPOSE. Specific enough to be checkable. */
  private renderProposalContext(opts: { villager?: string; snapshot?: Snapshot }): string {
    const { villager, snapshot } = opts;
    const led = this.state.ledger;
    const phase = led.completed.length < WARMUP_COMPLETED ? 'WARM-UP (early/survival-basic phase)' : 'ÉTABLI';
    const parts: string[] = [];
    parts.push(`## PHASE\n${phase} — ${led.completed.length} tâches réussies à ce jour.`);
    if (phase.startsWith('WARM-UP')) {
      // When a scenario mission is set, the generic "gather wood/food/tools" survival default actively
      // fights it (and never lifts, since a non-converging task closes `failed`, not `completed`). Serve
      // the mission with what the villager ALREADY has instead of defaulting to resource acquisition.
      parts.push(this.hasMission
        ? 'Début de partie: garde la PREMIÈRE tâche petite et réalisable AVEC L’INVENTAIRE ET LES COMPÉTENCES ACTUELS, au service de la mission (voir les instructions de scénario). N’envoie PAS le villageois acquérir un objet/outil qu’il possède déjà — vérifie l’inventaire ci-dessous. N’improvise pas une tâche de survie générique qui contredit la mission.'
        : 'Le village est fragile: propose une tâche de SURVIE basique (bois, nourriture, outils simples). N’ouvre pas le late-game.');
    }
    if (villager) {
      const inv = snapshot
        ? snapshot.inventory.length
          ? snapshot.inventory.map((i) => `${i.name} ×${i.count}`).join(', ')
          : '(vide)'
        : '(inconnu — pas de snapshot)';
      parts.push(`## INVENTAIRE ACTUEL (${villager})\n${inv}\nNE propose PAS d’acquérir un objet déjà présent ci-dessus (ex: ne pas chercher du bois pour fabriquer une houe déjà en main).`);
    }
    const skills = this.renderLibraryCoverage();
    if (skills) parts.push(skills);
    parts.push(`## FRONTIÈRE — RÉUSSIES (${led.completed.length})\n${led.completed.slice(-12).map((r) => `✓ ${r.task.goal}`).join('\n') || '(aucune)'}`);
    // R70: render the failed goals WITH their blocked reason (the last obstacle) — this is the curriculum's
    // memory of past deliberations. Do NOT re-propose a goal listed here without changing the approach.
    const failedLines = led.failed.slice(-8).map((r) => `✗ ${r.task.goal}${r.reason ? `\n   ↳ ${truncate(r.reason, 240)}` : ''}`).join('\n');
    parts.push(`## FRONTIÈRE — ÉCHOUÉES (${led.failed.length})\n${failedLines || '(aucune)'}\nNE re-propose PAS un but déjà échoué ci-dessus à l’identique: décompose-le (outil non dispo ici → propose un sous-pas plus simple) ou choisis autre chose.`);
    parts.push(`## TÂCHES OUVERTES (${led.open.length})\n${led.open.map((t) => `• ${t.goal}${t.assignee ? ` → ${t.assignee}` : ''}`).join('\n') || '(aucune)'}`);
    if (villager) {
      const d = this.state.dossiers.get(villager);
      parts.push(`## VILLAGEOIS DEMANDEUR (${villager})\ncompétences: ${d ? JSON.stringify(d.competence) : '(inconnu)'}`);
    }
    parts.push('Propose UNE tâche au bord de la capacité actuelle. Appelle l’outil `propose_task`.');
    return parts.join('\n\n');
  }

  /** The village's existing reusable skills (mortal tier only — divine skills aren't villager work) as
   *  `name — summary` one-liners, so God proposes a task that COMPOSES them plus one new step rather than
   *  re-deriving capabilities it already has. Empty string when no library is wired or none are live. */
  private renderLibraryCoverage(): string {
    if (!this.library) return '';
    const live = this.library.liveSkills().filter((s) => s.manifest.tier !== 'divine');
    if (live.length === 0) return '';
    const lines = live.slice(0, 40).map((s) => `• ${s.manifest.name} — ${s.manifest.summary}`).join('\n');
    return `## COMPÉTENCES EXISTANTES (réutilisables, ${live.length})\n${lines}\nUne bonne tâche COMPOSE celles-ci plus UN seul nouveau pas.`;
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

/** Bound a critique/reason rendered into a prompt so the failed-frontier memory stays cheap (R70). */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Normalise a goal string for the follow-up anti-loop dedup (R72) — case/whitespace-insensitive. */
function normGoal(goal: string): string {
  return goal.toLowerCase().replace(/\s+/g, ' ').trim();
}

function toCheck(v: unknown): ItemCheck | undefined {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['item'] === 'string' && typeof o['count'] === 'number') return { item: o['item'], count: o['count'] };
  }
  return undefined;
}
