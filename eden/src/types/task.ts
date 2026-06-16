import type { Priority } from './enums';

/** D-12: a satisfied check force-vetoes admission (one-directional). */
export interface ItemCheck {
  item: string;
  count: number;
}

/** A unit of work God assigns to a villager — the input to a rollout. */
export interface Task {
  id: string;
  goal: string;
  assignee?: string;
  successCriteria: string;
  check?: ItemCheck;
  /** QA-cache answer folded in at proposal time. */
  context: string;
  maxRetries: number;
  parent?: string;
  /** D-09: the live rollout; set at assignment, cleared on boot abandon. */
  currentRolloutId?: string;
}

/** A closed task plus when and how (verdict) it closed. */
export interface TaskRecord {
  task: Task;
  closedAt: number;
  verdictId?: string;
  /** Why it closed this way — set for a non-verdict close (the R65 breaker's blocked reason, carrying the
   *  last critique). Folded into the curriculum's failed-frontier so a future proposal sees WHY a goal
   *  failed, not just that it did (the curriculum's only memory of past deliberations is the ledger). */
  reason?: string;
}

/** The curriculum's view of all tasks: completed, failed, and still-open. */
export interface TaskLedger {
  completed: TaskRecord[];
  failed: TaskRecord[];
  open: Task[];
}

/** A verdict's proposed follow-up directive (orchestration), pre-creation. */
export interface DirectiveSuggestion {
  to: string | string[] | 'all';
  goal: string;
  reason: string;
  priority?: Priority;
}

/** A verdict's proposed follow-up task (curriculum), pre-creation. */
export interface TaskSuggestion {
  goal: string;
  successCriteria?: string;
  assignee?: string;
  parent?: string;
  /** Optional objective check for the follow-up — e.g. a blocked sow-task's acquire-task carries
   *  `{item:'wheat_seeds', count:1}` so the critic judges the pivot objectively (R72). */
  check?: ItemCheck;
}

/** A standing or one-shot order God sends a villager via its inbox. */
export interface Directive {
  id: string;
  to: string | string[] | 'all';
  goal: string;
  reason: string;
  priority: Priority;
  taskRef?: string;
  expiresAt?: number;
  standing?: boolean;
}

/** A request for the critic desk to judge a run — filed by a rollout, tripwire, plea, or second-opinion. */
export interface CriticTicket {
  id: string;
  source: 'rollout' | 'tripwire' | 'plea' | 'second-opinion';
  runReportRef: string;
  taskRef?: string;
  filedAt: number;
}

/** The critic desk's judgment of a ticket: success + critique + what to do with the library. */
export interface Verdict {
  ticketId: string;
  success: boolean;
  score?: number;
  /** The product of a verdict — the critique text. */
  critique: string;
  libraryAction: 'admit' | 'keep-draft' | 'quarantine' | 'archive' | 'none';
  followUp?: DirectiveSuggestion | TaskSuggestion;
  praise?: string;
  /** R72 — the skill ran cleanly but made NO progress SOLELY because a required input resource is absent
   *  (and can't be obtained within one run). NOT a code defect: revising is futile. The rollout stops
   *  revising, closes the task as blocked, and (via `followUp`) the curriculum pivots to ACQUIRING the
   *  resource. Implies success:false; the skill is not penalised (libraryAction:'none'). */
  blocked?: boolean;
}

/** One attempt at a task: the draft→run→verdict→revise cycle, possibly spanning several drafts. */
export interface Rollout {
  id: string;
  taskId: string;
  villager: string;
  attempt: number;
  draftVersions: number[];
  critiqueChain: string[];
  open: boolean;
}

/** A lightweight back-reference to a verdict, kept in a villager's dossier. */
export interface VerdictRef {
  verdictId: string;
  at: number;
  success: boolean;
}

/** Per-tag success rates folded from the journal. */
export type Competence = Record<string, { runs: number; successes: number }>;

/** God's running file on a villager: per-tag competence, recent verdicts, notes, standing orders. */
export interface Dossier {
  villager: string;
  competence: Competence;
  recentVerdicts: VerdictRef[];
  notes: string[];
  standingOrders?: string;
}
