// GodService + GodState (layer 3, god/) — the minimal God state and the rollout/verdict plumbing the
// M3 loop needs (03 §State). The critic desk (critic.ts) produces verdicts; this service OWNS the
// state they mutate: the task ledger, per-villager dossiers, the critic queue, and the live rollouts.
//
// routeVerdict is the deterministic side of D-12: it executes the verdict's libraryAction against the
// shared library (the SOLE writer of skill state is the library itself — S2), delivers the critique to
// the authoring villager's inbox (the ONLY God→villager channel — never importing villagers/), updates
// the ledger + dossier, and closes or keeps the rollout. Un-quarantine→active-probation (R37/D-12(ii))
// is applied here: an `admit` on a currently-quarantined version self-heals to active-probation, never
// straight to active.
//
// M3 seeds tasks by injection (addTask) — curriculum/orchestrator are M4. D-09 boot-abandon is M3-6.

import { monotonicFactory } from 'ulid';

import type { CriticTicket, Directive, Dossier, Inbox, Rollout, RunReport, Task, TaskLedger, Verdict } from '../types/index';
import type { IJournal } from '../journal/journal';
import { SkillLibrary } from '../skills/library';
import { DescriptionPass } from '../skills/describe';

const ulid = monotonicFactory();
const MAX_RECENT_VERDICTS = 20;

/** God's runtime state — the single home (S2). One writer per slice: the ledger is written ONLY by the
 *  Curriculum desk (M4), directivesOpen ONLY by the Orchestrator desk (M4); GodService owns rollouts +
 *  the critic queue; the library (not GodState) is the sole writer of skill state. */
export interface GodState {
  ledger: TaskLedger;
  dossiers: Map<string, Dossier>;
  criticQueue: CriticTicket[];
  rollouts: Map<string, Rollout>;
  /** Open tasks by id (the assignment pool — Curriculum writes it in M4). */
  tasks: Map<string, Task>;
  /** Open directives — written ONLY by the Orchestrator desk (S2). Optional so M3 state need not set it. */
  directivesOpen?: Directive[];
}

/** The result of routing a verdict — what the rollout loop needs to decide revise-or-stop. */
export interface RouteOutcome {
  verdictId: string;
  admitted: boolean;
  rolloutClosed: boolean;
}

/**
 * The TaskLedger-write surface (S2: the Curriculum desk is the SOLE WRITER). GodService delegates its
 * ledger mutations here when a writer is wired (M4-3); the Curriculum class satisfies it structurally,
 * so god.ts need not import curriculum.ts (no cycle). When omitted (M3 standalone), GodService falls
 * back to writing GodState.ledger directly — keeping the M3 tests green.
 */
export interface LedgerWriter {
  addTask(task: Task): void;
  closeTask(task: Task, verdictId: string | undefined, ok: boolean): void;
}

/** Construction deps (wired in main.ts). */
export interface GodServiceOptions {
  journal: IJournal;
  library: SkillLibrary;
  /** One inbox per villager (the God→villager channel; keeps god/ from importing villagers/). */
  inboxes: Map<string, Inbox>;
  /** Optional: runs the DescriptionPass at admission (M2-5). Omitted → keep the author's summary. */
  describer?: DescriptionPass;
  /** Optional (M4-3): the Curriculum desk — the sole writer of the ledger (S2). Falls back to direct
   *  GodState.ledger writes when omitted (M3 standalone). */
  ledger?: LedgerWriter;
  now?: () => number;
}

/** The God service. Owns rollout lifecycle + verdict routing over the minimal {@link GodState}. */
export class GodService {
  readonly state: GodState = {
    ledger: { completed: [], failed: [], open: [] },
    dossiers: new Map(),
    criticQueue: [],
    rollouts: new Map(),
    tasks: new Map(),
    directivesOpen: [],
  };
  private readonly journal: IJournal;
  private readonly library: SkillLibrary;
  private readonly inboxes: Map<string, Inbox>;
  private readonly describer?: DescriptionPass;
  private readonly ledger?: LedgerWriter;
  private readonly now: () => number;

  constructor(opts: GodServiceOptions) {
    this.journal = opts.journal;
    this.library = opts.library;
    this.inboxes = opts.inboxes;
    this.describer = opts.describer;
    this.ledger = opts.ledger;
    this.now = opts.now ?? Date.now;
  }

  /** Inject an open task. Routes through the ledger writer (Curriculum, S2) when wired; else direct. */
  addTask(task: Task): void {
    if (this.ledger) {
      this.ledger.addTask(task);
      return;
    }
    this.state.tasks.set(task.id, task);
    if (!this.state.ledger.open.some((t) => t.id === task.id)) this.state.ledger.open.push(task);
  }

  /** Open a rollout for a task: one live rollout per task (D-09), pointer set on the task. */
  openRollout(taskId: string): Rollout {
    const task = this.state.tasks.get(taskId);
    if (!task) throw new Error(`openRollout: no open task "${taskId}" in the ledger`);
    const prior = [...this.state.rollouts.values()].filter((r) => r.taskId === taskId);
    const rollout: Rollout = {
      id: ulid(),
      taskId,
      villager: task.assignee ?? '(unassigned)',
      attempt: prior.length + 1,
      draftVersions: [],
      critiqueChain: [],
      open: true,
    };
    task.currentRolloutId = rollout.id; // D-09: enforces one live rollout; cleared on boot abandon (M3-6)
    this.state.rollouts.set(rollout.id, rollout);
    return rollout;
  }

  /** File a critic ticket for a run (always on rollout completion; also tripwire/plea/second-opinion). */
  fileTicket(opts: { rolloutId: string; report: RunReport; source: CriticTicket['source'] }): CriticTicket {
    const rollout = this.state.rollouts.get(opts.rolloutId);
    const ticket: CriticTicket = {
      id: ulid(),
      source: opts.source,
      runReportRef: opts.report.runId,
      taskRef: rollout?.taskId,
      filedAt: this.now(),
    };
    this.state.criticQueue.push(ticket);
    this.journal.append('god:critic', 'god.ticket', { source: opts.source, skill: opts.report.skill, version: opts.report.version }, {
      rolloutId: opts.rolloutId,
      runId: opts.report.runId,
      taskId: ticket.taskRef,
      skill: opts.report.skill,
      skillVersion: opts.report.version,
    });
    return ticket;
  }

  /**
   * Execute a verdict: library action (admit/keep-draft/quarantine/archive/none), deliver the critique
   * to the assignee's inbox, update ledger + dossier, journal god.verdict, close or keep the rollout.
   */
  async routeVerdict(verdict: Verdict, opts: { rolloutId: string; draft: { name: string; version: number }; task: Task }): Promise<RouteOutcome> {
    const verdictId = ulid();
    const rollout = this.state.rollouts.get(opts.rolloutId);
    const { name, version } = opts.draft;

    this.journal.append('god:critic', 'god.verdict', {
      ticketId: verdict.ticketId,
      success: verdict.success,
      libraryAction: verdict.libraryAction,
      score: verdict.score,
      critique: verdict.critique,
    }, { rolloutId: opts.rolloutId, taskId: opts.task.id, skill: name, skillVersion: version, verdictId });

    // ── Library action (the library is the sole writer of skill state — S2). ──
    let admitted = false;
    const current = this.library.getVersion(name, version);
    if (verdict.libraryAction === 'admit') {
      if (current?.status === 'quarantined') {
        // R37/D-12(ii): a quarantined skill that succeeds self-heals to active-probation, NOT active.
        this.library.unquarantine(name, version);
        admitted = true;
      } else if (current?.status === 'draft') {
        this.library.admit(name, version, { rolloutId: opts.rolloutId, verdictId });
        admitted = true;
        await this.runDescriptionPass(name, version);
      }
      // already active/active-probation → no-op admit
    } else if (verdict.libraryAction === 'quarantine') {
      this.library.quarantine(name, verdict.critique, version);
    } else if (verdict.libraryAction === 'archive') {
      this.library.archive(name, version);
    }

    // ── Critique → the authoring villager's inbox (high-priority next-revision context). ──
    const assignee = opts.task.assignee ?? rollout?.villager;
    if (assignee) {
      this.inboxes.get(assignee)?.deliver({
        from: 'god',
        kind: 'critique',
        payload: { critique: verdict.critique, success: verdict.success, praise: verdict.praise },
        at: this.now(),
      });
      this.updateDossier(assignee, name, version, verdict.success, verdictId);
    }

    // ── Rollout + ledger. ──
    let rolloutClosed = false;
    if (rollout) {
      rollout.critiqueChain.push(verdict.critique);
      if (!rollout.draftVersions.includes(version)) rollout.draftVersions.push(version);
      if (admitted && verdict.success) {
        rollout.open = false;
        rolloutClosed = true;
        this.closeTask(opts.task, verdictId, true);
      }
    }

    return { verdictId, admitted, rolloutClosed };
  }

  /**
   * B3.3 — execute a critic verdict on a FailureTripwire ticket (`autoQuarantineAfter` consecutive failures of
   * one skill, outside any rollout). Journals `god.verdict` and applies ONLY a quarantine: a tripwire ticket can
   * pull a failing skill, never admit/archive one (no rollout, no task, no assignee — nothing else to route).
   */
  routeTripwireVerdict(verdict: Verdict, opts: { skill: string; version: number }): { verdictId: string; quarantined: boolean } {
    const verdictId = ulid();
    this.journal.append('god:critic', 'god.verdict', {
      ticketId: verdict.ticketId,
      success: verdict.success,
      libraryAction: verdict.libraryAction,
      score: verdict.score,
      critique: verdict.critique,
    }, { skill: opts.skill, skillVersion: opts.version, verdictId });
    let quarantined = false;
    if (verdict.libraryAction === 'quarantine') {
      quarantined = this.library.quarantine(opts.skill, `tripwire: ${verdict.critique}`, opts.version, 'god:critic') !== undefined;
    }
    return { verdictId, quarantined };
  }

  /**
   * D-09 boot-abandon (startup step 7). Every open task whose `currentRolloutId` is still set lost its
   * in-flight rollout to the crash (the in-memory conversation is the only volatile state crash-only
   * already accepts losing). For each: journal god.rollout-abandoned{reason:'crash-recovery'}, close the
   * orphan rollout, clear the pointer, and re-enqueue the task with FRESH maxRetries (the lost attempt
   * never counts against retries). Orphan draft versions stay harmless `draft`s — never retrieved (P2),
   * so they are left untouched in the library. Returns the count abandoned.
   */
  recoverRollouts(): number {
    let abandoned = 0;
    for (const task of [...this.state.tasks.values()]) {
      const rid = task.currentRolloutId;
      if (rid === undefined) continue;
      this.journal.append('god', 'god.rollout-abandoned', { reason: 'crash-recovery', taskId: task.id }, { rolloutId: rid, taskId: task.id });
      const rollout = this.state.rollouts.get(rid);
      if (rollout) rollout.open = false;
      delete task.currentRolloutId; // clear the pointer (D-09)
      // Re-enter normal assignment (D-09). Route through the ledger writer (Curriculum, S2) when wired
      // — addTask is idempotent on the open list; in M4-3 the task then flows through the real
      // orchestrator→inbox path, not the M3 injection harness. Direct fallback for M3 standalone.
      if (this.ledger) this.ledger.addTask(task);
      else if (!this.state.ledger.open.some((t) => t.id === task.id)) this.state.ledger.open.push(task);
      abandoned++;
    }
    return abandoned;
  }

  /** A villager's running file (created lazily). */
  dossierFor(villager: string): Dossier {
    let d = this.state.dossiers.get(villager);
    if (!d) {
      d = { villager, competence: {}, recentVerdicts: [], notes: [] };
      this.state.dossiers.set(villager, d);
    }
    return d;
  }

  private updateDossier(villager: string, skill: string, version: number, success: boolean, verdictId: string): void {
    const d = this.dossierFor(villager);
    const tags = this.library.read(skill, version)?.manifest.tags ?? [];
    for (const tag of tags) {
      const c = d.competence[tag] ?? { runs: 0, successes: 0 };
      c.runs += 1;
      if (success) c.successes += 1;
      d.competence[tag] = c;
    }
    d.recentVerdicts.push({ verdictId, at: this.now(), success });
    if (d.recentVerdicts.length > MAX_RECENT_VERDICTS) d.recentVerdicts.splice(0, d.recentVerdicts.length - MAX_RECENT_VERDICTS);
  }

  private closeTask(task: Task, verdictId: string, ok: boolean): void {
    if (this.ledger) {
      // The Curriculum desk is the sole ledger writer (S2) — it journals god.task-closed.
      this.ledger.closeTask(task, verdictId, ok);
      return;
    }
    delete task.currentRolloutId;
    this.state.tasks.delete(task.id);
    this.state.ledger.open = this.state.ledger.open.filter((t) => t.id !== task.id);
    const record = { task, closedAt: this.now(), verdictId };
    (ok ? this.state.ledger.completed : this.state.ledger.failed).push(record);
  }

  private async runDescriptionPass(name: string, version: number): Promise<void> {
    if (!this.describer) return;
    const code = this.library.read(name, version)?.code;
    if (!code) return;
    const patch = await this.describer.derive(name, code);
    this.library.applyDescription(name, version, patch);
  }
}
