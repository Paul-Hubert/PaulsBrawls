// The D-16 flip gate (layer 2, docs/22 §3 / docs/26 B3a) — the mechanical, LLM-free judge that
// replaced the critic on the skill-admission path. One admission attempt = three serialized runs on
// the one body (D-05): T(pre) → S → T(post); then the §3.5 truth table over {preV, Sδ, postV,
// task.check}. The engine's own before/after snapshots are the fraud-proof spine (the villager
// cannot forge them); the paired test is the goal-shape oracle; task.check is the mission anchor.
//
// S2 invariant (docs/26 P-17): THIS MODULE is the sole caller of `library.admit` on the
// `source:'self-verdict'` path. `submit_skill` (B3b) and the CI skill-tier harness (B4) both invoke
// `FlipGate.run(...)`, which performs the admission — neither re-implements truth-table→admit, so
// the villager-facing gate and the CI oracle cannot drift.
//
// Two pinned Sδ caveats (docs/26 B3a — do not "improve" either):
//   • Sδ deliberately EXCLUDES `nearbyEntities` — another body wandering near the runner could
//     otherwise forge a delta.
//   • `nearbyBlocks` is VIEWPOINT-SENSITIVE for movement-composing skills (the two snapshots are
//     taken from different positions), so a nearbyBlocks-only delta is corroborating, never
//     sole-sufficient (P-32): it counts toward the ADMIT floor (a till-block changes no inventory),
//     but it never convicts a `nothing-to-do` run of mutation (SUSPECT-TEST) when the bot moved.

import type { ItemCheck, Provenance, RunnerRef, RunReport, SkillVersion, Snapshot, Task, TraceEvent } from '../types/index';
import type { JournalAppender } from '../journal/journal';
import type { SkillEngine } from './engine';
import type { ResolvedSkill, SkillLibrary } from './library';

/** The closed verdict enum a paired test returns (docs/22 §3). */
export type TestVerdict = 'worked' | 'nothing-to-do' | 'failed';

/** The §3.5 truth-table outcome (plus 'failed' — test infrastructure threw, never admit). */
export type GateDecision = 'admit' | 'reject-test' | 'reject' | 'revise' | 'nothing-to-do' | 'suspect-test' | 'failed';

/** What one gate run produced — the villager's revision fuel + the coordinator's outcome signal. */
export interface GateOutcome {
  decision: GateDecision;
  /** Concrete, evidence-carrying explanation (S10) — a REVISE's assertion failure is revision fuel. */
  evidence: string;
  preVerdict: TestVerdict | 'threw';
  postVerdict: TestVerdict | 'threw' | 'not-run';
  /** The subject skill's Sδ was empty (admit-floor sense — see the module header caveats). */
  deltaEmpty: boolean;
  /** task.check evaluation over worldAfter_S (undefined when the task carries no check). */
  checkOk?: boolean;
  /** The journal id of the skill.self-verdict row this outcome wrote. */
  selfVerdictId: string;
  /** Set on ADMIT: the version the gate admitted (now active-probation, D-12). */
  admitted?: SkillVersion;
  /** The three run reports, for the deliberation to render (post/skill absent on short-circuits). */
  reports: { pre: RunReport; skill?: RunReport; post?: RunReport };
}

/** Everything one gate attempt needs. `rolloutId` defaults to the subject run's runId (traceable). */
export interface GateRequest {
  skill: string;
  /** The draft version under trial (explicit — the gate never guesses which version it judges). */
  version: number;
  args: object;
  runner: RunnerRef;
  task?: Task;
  rolloutId?: string;
}

export interface FlipGateOptions {
  engine: SkillEngine;
  library: SkillLibrary;
  journal: JournalAppender;
}

/**
 * Whether worldAfter holds at least `check.count` of `check.item` — the objective task criterion,
 * LIFTED out of the critic (docs/22 §3.1: task.check is the gate's mission anchor; the critic's
 * copy is retired with its admission role in B3b).
 */
export function checkSatisfied(after: Snapshot | null, check: ItemCheck): boolean {
  if (!after) return false;
  const have = after.inventory.filter((i) => i.name === check.item).reduce((s, i) => s + i.count, 0);
  return have >= check.count;
}

/** The subject skill's engine delta, decomposed so the two pinned caveats are encodable. */
export interface SDelta {
  inventoryChanged: boolean;
  blockCountsChanged: boolean;
  entityDeadInTrace: boolean;
  botMoved: boolean;
  /** The ADMIT floor: inventory Δ OR an entityDead OR a nearbyBlocks name-count Δ. */
  admitNonEmpty: boolean;
  /** The SUSPECT-TEST trigger: as above, but a nearbyBlocks-only Δ does not convict a moved bot (P-32). */
  suspectNonEmpty: boolean;
  summary: string;
}

function invMap(s: Snapshot | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of s?.inventory ?? []) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
  return m;
}

function mapsDiffer(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return true;
  for (const [k, v] of a) if (b.get(k) !== v) return true;
  return false;
}

/** Per-name block counts of a snapshot — O-4 counts when present, else the deduped set (fallback). */
function blockCounts(s: Snapshot | null): Map<string, number> {
  if (s?.nearbyBlockCounts) return new Map(Object.entries(s.nearbyBlockCounts));
  const m = new Map<string, number>();
  for (const n of s?.nearbyBlocks ?? []) m.set(n, 1);
  return m;
}

/** Compute the subject run's Sδ (docs/22 §3.1 / §6 "Sδ non-empty" + the O-4 name-counts amendment). */
export function computeDelta(report: RunReport): SDelta {
  const before = report.worldBefore;
  const after = report.worldAfter;
  const inventoryChanged = mapsDiffer(invMap(before), invMap(after));
  const blockCountsChanged = mapsDiffer(blockCounts(before), blockCounts(after));
  const entityDeadInTrace = (report.events ?? []).some((e: TraceEvent) => e.kind === 'entityDead');
  const [bx, by, bz] = before?.position ?? [0, 0, 0];
  const [ax, ay, az] = after?.position ?? [0, 0, 0];
  const botMoved = Math.hypot(ax - bx, ay - by, az - bz) > 0.5;
  const admitNonEmpty = inventoryChanged || entityDeadInTrace || blockCountsChanged;
  const suspectNonEmpty = inventoryChanged || entityDeadInTrace || (blockCountsChanged && !botMoved);
  const parts: string[] = [];
  if (inventoryChanged) parts.push('inventory changed');
  if (blockCountsChanged) parts.push(`nearby block counts changed${botMoved ? ' (bot moved — viewpoint-sensitive, corroborating only)' : ''}`);
  if (entityDeadInTrace) parts.push('entityDead in the event-trace');
  return {
    inventoryChanged,
    blockCountsChanged,
    entityDeadInTrace,
    botMoved,
    admitNonEmpty,
    suspectNonEmpty,
    summary: parts.length > 0 ? parts.join('; ') : 'no mutable-world delta',
  };
}

/** A test run's parsed result: the verdict enum + optional evidence, or 'threw' (row 7, conservative). */
function parseTestResult(report: RunReport): { verdict: TestVerdict | 'threw'; evidence: string } {
  if (!report.outcome.ok) {
    return { verdict: 'threw', evidence: `test ${report.skill} v${report.version} threw: ${report.outcome.error}` };
  }
  const v = report.outcome.value as { verdict?: unknown; evidence?: unknown } | undefined;
  const verdict = v && typeof v === 'object' ? v.verdict : undefined;
  if (verdict === 'worked' || verdict === 'nothing-to-do' || verdict === 'failed') {
    const evidence = typeof v?.evidence === 'string' ? v.evidence : '';
    return { verdict, evidence };
  }
  return {
    verdict: 'threw',
    evidence: `test ${report.skill} v${report.version} returned ${JSON.stringify(report.outcome.value)} — not a {verdict:'worked'|'nothing-to-do'|'failed'} shape`,
  };
}

/** The mechanical judge. One instance per host; stateless between calls. */
export class FlipGate {
  private readonly engine: SkillEngine;
  private readonly library: SkillLibrary;
  private readonly journal: JournalAppender;

  constructor(opts: FlipGateOptions) {
    this.engine = opts.engine;
    this.library = opts.library;
    this.journal = opts.journal;
  }

  /**
   * One admission attempt: T(pre) → S → T(post) → truth table → (on ADMIT) `library.admit` with
   * `source:'self-verdict'`. Throws only on structural problems the caller must fix (no paired test,
   * unknown skill/version, the SUBJECT's pre-execution errors); a test that throws is a conservative
   * 'failed' decision, never an exception (§3.5 row 7). Every outcome journals `skill.self-verdict`.
   */
  async run(req: GateRequest): Promise<GateOutcome> {
    const subject = this.library.read(req.skill, req.version);
    if (!subject) throw new Error(`flip-gate: skill "${req.skill}" v${req.version} not found in the library`);
    const test = this.library.pairedTestFor(req.skill);
    if (!test) {
      throw new Error(`flip-gate: skill "${req.skill}" has no paired test (a test manifest with validates:"${req.skill}") — write one before submit (D-16)`);
    }
    const oracle = test.manifest.oracle ?? 'state';

    // 1. T(pre) — the same args as S, so the test knows the subject's targets.
    const preReport = await this.runTest(test, req);
    const pre = parseTestResult(preReport);
    if (pre.verdict === 'threw') {
      return this.conclude(req, test, {
        decision: 'failed',
        evidence: `T(pre) broke: ${pre.evidence}`,
        preVerdict: 'threw',
        postVerdict: 'not-run',
        deltaEmpty: true,
        reports: { pre: preReport },
      });
    }
    if (pre.verdict === 'worked') {
      // Row 1 — precondition already true / constant test. Running S would be pointless (and can
      // mask a D2 "deposit items I already had" fraud); short-circuit.
      return this.conclude(req, test, {
        decision: 'reject-test',
        evidence: `T(pre) already returned 'worked' before the skill ran — the test's precondition is already true (or the test is constant). Use a RELATIVE bar (R78) or set up the missing precondition. ${pre.evidence}`.trim(),
        preVerdict: 'worked',
        postVerdict: 'not-run',
        deltaEmpty: true,
        reports: { pre: preReport },
      });
    }

    // 2. S — the trial run. Pre-execution errors (tier/grant/args) propagate: the gate never ran.
    const skillReport = await this.engine.run(req.skill, req.args, req.runner, {
      version: req.version,
      rolloutId: req.rolloutId,
    });
    const delta = computeDelta(skillReport);

    // 3. T(post) — reads the SUBJECT's frozen event-trace as ctx.events (§3.4, race-free).
    const postReport = await this.runTest(test, req, skillReport.events ?? []);
    const post = parseTestResult(postReport);
    if (post.verdict === 'threw') {
      return this.conclude(req, test, {
        decision: 'failed',
        evidence: `T(post) broke: ${post.evidence}`,
        preVerdict: pre.verdict,
        postVerdict: 'threw',
        deltaEmpty: !delta.admitNonEmpty,
        reports: { pre: preReport, skill: skillReport, post: postReport },
      });
    }

    const checkOk = req.task?.check ? checkSatisfied(skillReport.worldAfter, req.task.check) : undefined;
    const base = {
      preVerdict: pre.verdict,
      postVerdict: post.verdict,
      deltaEmpty: !delta.admitNonEmpty,
      ...(checkOk !== undefined ? { checkOk } : {}),
      reports: { pre: preReport, skill: skillReport, post: postReport },
    };

    // ── The §3.5 truth table (preV ∈ {failed, nothing-to-do} from here) ──
    if (pre.verdict === 'nothing-to-do') {
      if (delta.suspectNonEmpty) {
        return this.conclude(req, test, {
          ...base,
          decision: 'suspect-test',
          evidence: `test claimed 'nothing-to-do' but the skill mutated the world (${delta.summary}) — the lazy-test escape, caught by the engine delta`,
        });
      }
      if (post.verdict === 'nothing-to-do') {
        return this.conclude(req, test, {
          ...base,
          decision: 'nothing-to-do',
          evidence: `correct no-op: nothing to do before or after, zero delta (R72 made mechanical). ${post.evidence}`.trim(),
        });
      }
      // Unlisted row (nothing-to-do → worked/failed with an empty delta): the test contradicts
      // itself across two reads of an unchanged world — its verdict is not trustworthy.
      return this.conclude(req, test, {
        ...base,
        decision: 'suspect-test',
        evidence: `test flipped '${pre.verdict}' → '${post.verdict}' though the skill produced no delta — the test is not reading a stable predicate`,
      });
    }

    // preV === 'failed':
    if (post.verdict === 'worked') {
      if (!delta.admitNonEmpty && oracle !== 'return') {
        return this.conclude(req, test, {
          ...base,
          decision: 'reject',
          evidence: `test claims success but the engine saw zero mutable-world delta (${delta.summary}) — the test lies or reads state the run never changed`,
        });
      }
      if (checkOk === false) {
        const check = req.task!.check!;
        return this.conclude(req, test, {
          ...base,
          decision: 'revise',
          evidence: `test passed but the task's objective check is NOT satisfied: need ${check.count}× ${check.item} in inventory (R34: a clean exit is not progress)`,
        });
      }
      return this.admit(req, test, subject, base, delta, oracle);
    }
    // post 'failed' (real defect) or 'nothing-to-do' (the test lost its target mid-flight —
    // resources consumed without the goal predicate holding; not an §3.5 row, conservative REVISE).
    return this.conclude(req, test, {
      ...base,
      decision: 'revise',
      evidence:
        post.verdict === 'failed'
          ? `T(post) still 'failed' after the run: ${post.evidence || '(the test carried no evidence — make it name what it asserted)'} [engine delta: ${delta.summary}]`
          : `T flipped 'failed' → 'nothing-to-do': the run consumed the test's target without satisfying it. [engine delta: ${delta.summary}]`,
    });
  }

  // ── internals ────────────────────────────────────────────────────────────
  private async runTest(test: ResolvedSkill, req: GateRequest, injectEvents?: TraceEvent[]): Promise<RunReport> {
    try {
      return await this.engine.run(test.manifest.name, req.args, req.runner, {
        version: test.version.version,
        rolloutId: req.rolloutId,
        ...(injectEvents !== undefined ? { injectEvents } : {}),
      });
    } catch (err) {
      // A PRE-EXECUTION failure of the test (arg validation, tier, grant) is test infrastructure
      // breaking, not the skill failing — synthesize a threw-shaped report so row 7 applies.
      const message = err instanceof Error ? err.message : String(err);
      return {
        runId: `gate-preexec-${Date.now().toString(36)}`,
        skill: test.manifest.name,
        version: test.version.version,
        villager: req.runner.name,
        args: req.args,
        outcome: { ok: false, error: `pre-execution: ${message}` },
        startedAt: 0,
        durationMs: 0,
        pulses: 0,
        deepestDepth: 0,
        callTree: [],
        logs: [],
        worldBefore: null,
        worldAfter: null,
      };
    }
  }

  private admit(
    req: GateRequest,
    test: ResolvedSkill,
    subject: ResolvedSkill,
    base: Omit<GateOutcome, 'decision' | 'evidence' | 'selfVerdictId' | 'admitted'>,
    delta: SDelta,
    oracle: 'state' | 'events' | 'return',
  ): GateOutcome {
    const evidence =
      oracle === 'return'
        ? `genuine flip 'failed' → 'worked' ('return'-class oracle: the test asserted the subject's return against a world read; Sδ floor exempt, O-4)`
        : `genuine flip 'failed' → 'worked' with an attributable delta (${delta.summary})${base.checkOk === true ? ' and the task check satisfied' : ''}`;
    const outcome = this.conclude(req, test, { ...base, decision: 'admit', evidence });
    const provenance: Provenance = {
      rolloutId: req.rolloutId ?? base.reports.skill?.runId ?? 'flip-gate',
      source: 'self-verdict',
      selfVerdictId: outcome.selfVerdictId,
    };
    outcome.admitted = this.library.admit(subject.manifest.name, req.version, provenance);
    return outcome;
  }

  /** Journal the skill.self-verdict row (EVERY gate outcome, P4) and finalize the GateOutcome. */
  private conclude(
    req: GateRequest,
    test: ResolvedSkill,
    partial: Omit<GateOutcome, 'selfVerdictId' | 'admitted'>,
  ): GateOutcome {
    const preDelta = partial.reports.pre ? computeDelta(partial.reports.pre) : undefined;
    const postDelta = partial.reports.post ? computeDelta(partial.reports.post) : undefined;
    const selfVerdictId = this.journal.append(
      'flip-gate',
      'skill.self-verdict',
      {
        skill: req.skill,
        version: req.version,
        decision: partial.decision,
        preVerdict: partial.preVerdict,
        postVerdict: partial.postVerdict,
        deltaEmpty: partial.deltaEmpty,
        ...(partial.checkOk !== undefined ? { checkOk: partial.checkOk } : {}),
        evidence: partial.evidence,
        testSkill: test.manifest.name,
        testVersion: test.version.version,
        // §3.3 Tδ purity AUDIT — measured for free, journaled, never gated on.
        ...(preDelta !== undefined ? { testDeltaEmpty: !preDelta.suspectNonEmpty } : {}),
        ...(postDelta !== undefined ? { testPostDeltaEmpty: !postDelta.suspectNonEmpty } : {}),
      },
      {
        skill: req.skill,
        skillVersion: req.version,
        ...(req.rolloutId !== undefined ? { rolloutId: req.rolloutId } : {}),
        ...(partial.reports.skill !== undefined ? { runId: partial.reports.skill.runId } : {}),
      },
    );
    return { ...partial, selfVerdictId };
  }
}
