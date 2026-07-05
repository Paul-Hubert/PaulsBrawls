// The skill engine (layer 2) — the ONLY executor of skill code. It wires together everything the
// design demands around a single run (02 §Validation, §Composition, §Tiers; D-05, D-10, D-12):
//   • Tier gate (R25) — a mortal runner never runs OR composes a divine skill; checked before code.
//   • One tree per bot (D-05) via BotRunQueue; an `interrupt` preempts the running tree (aborted:'preempted', R9).
//   • RunSupervisor wall-clock cap (default 120 s, hard 2 h) + StallDetector (D-10: discrete pulses,
//     incl. pathfinder liveness; uniform stallSeconds; in-memory only — R44).
//   • The hardened abort protocol (R4/R5) on every timeout/stall/preempt exit, via bots/hardening.
//   • SkillComposer (ctx.skills.run): depth cap 8, cycle detection, tier gate, grant gate, and the
//     D-12 probation gate (active-probation is runnable + retrievable but NOT composable).
//   • Crash escalation, never suppression (P3): every throw becomes a RunReport → journal skill.run.
//   • FailureTripwire (autoQuarantineAfter) files one critic ticket on a failure streak (R36 valve).

import { monotonicFactory } from 'ulid';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';

import type {
  AbortCause,
  Bot,
  CallFrame,
  ItemRegistry,
  JsonSchema,
  RunnerRef,
  RunOutcome,
  RunReport,
  Snapshot,
  TraceEvent,
  Vec3Like,
} from '../types/index';
import type { JournalAppender } from '../journal/journal';
import { abortActiveTasks, installChatInterceptor } from '../bots/hardening';
import { SkillLibrary, type GrantPolicy, type ResolvedSkill } from './library';
import {
  compile,
  makeShim,
  createLoopBudget,
  type SkillFactory,
} from './instrument';

const ulid = monotonicFactory();
const HARD_CEILING_MS = 2 * 60 * 60 * 1000; // v1's routine cap — the ultimate wall-clock ceiling.
/** Gap W / CRIT-1 — the macrotask-starvation canary. A `setInterval` is a MACROTASK; a runaway that only
 *  awaits immediately-resolved promises (a loop OR async recursion / a microtask trampoline) starves the
 *  macrotask queue, so this interval FREEZES while `now()` keeps advancing. The synchronous guard reads
 *  `now() - lastTick`; once it exceeds the stall window the run aborts from INSIDE a loop body OR a function
 *  body (R75 — the only paths a timer-starved supervisor can't take; instrument.ts injects both). The window
 *  is well below Minecraft's ~30 s keep-alive timeout (so the bot survives) and well above any legitimate
 *  per-iteration / per-call synchronous burst (so a real skill is never false-aborted). */
const MACROTASK_HEARTBEAT_MS = 100;
const DEFAULT_MACROTASK_STALL_MS = 8_000;
/** D-16 §3.4: the bounded event-trace ring — 64 entries + a dropped-count (D-07/R44, RK13). */
const TRACE_RING_SIZE = 64;
/** D-16 (docs/26 P-5): ms of grace after the body resolves before the trace closes — a death landing
 *  one tick after `isValid` flips (kill-mob returns on the flag, the entityDead packet trails it) is
 *  not lost. Paid once per ROOT run; tests set 0 for speed, the grace-specific tests set it small. */
const DEFAULT_TRACE_GRACE_MS = 500;

// Blocker Z: real mineflayer rejects plain {x,y,z} bags — `bot.blockAt` calls `.floored()` on its
// arg, and `mineflayer-pathfinder` calls `.isValid()` on its goal (the latter throws ASYNCHRONOUSLY
// from the physics tick, escaping every try/catch and crashing the host). The skill scope is only
// (bot, args, ctx) and the D-08 require-shim returns undefined, so a skill cannot `require('vec3')`.
// We therefore inject the REAL constructors into ctx. Both expose `.x/.y/.z`, so the FakeBot seam
// (which keys positions/goals on `.x/.y/.z`) keeps passing untouched. `goals` is destructured the
// same flagless-CJS way bots/helpers.ts does (R15). Direct npm imports in skills/ are legal: the
// dependency law (depcruise) only forbids UPWARD local imports, not external deps.
const { goals } = pathfinderPkg;

// ── Pre-execution errors (the brain catches these as tool-result strings; never a RunReport) ──
/** The named skill has no runnable version (P2: drafts run only inside their own rollout trial). */
export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`skill "${name}" not found (no active/active-probation version)`);
    this.name = 'SkillNotFoundError';
  }
}
/** R25: a mortal runner tried to run/compose a divine skill — refused before any code executes. */
export class TierGateError extends Error {
  constructor(name: string) {
    super(`skill "${name}" is divine — a mortal runner cannot run or compose it (R25)`);
    this.name = 'TierGateError';
  }
}
/** The GrantPolicy denied execution (v0 AllGranted never throws this; the seam exists for the economy). */
export class GrantError extends Error {
  constructor(name: string, villager: string) {
    super(`grant denied: ${villager} may not run "${name}"`);
    this.name = 'GrantError';
  }
}
/** Args failed manifest validation at the call boundary (D-04: readable, generated-from-schema). */
export class ArgValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgValidationError';
  }
}
/** D-12: an active-probation skill was used as a composition callee — refused until it graduates. */
export class ProbationError extends Error {
  constructor(name: string) {
    super(`skill "${name}" is in probation — runnable directly, but not composable until it graduates (D-12)`);
    this.name = 'ProbationError';
  }
}

/** Internal: a tree was aborted by a supervisor (stall/timeout) or a preempt — carries the cause. */
class EngineAbort extends Error {
  constructor(readonly abortCause: AbortCause) {
    super(`run aborted: ${abortCause}`);
    this.name = 'EngineAbort';
  }
}

/** Per-call options. A draft trial passes an explicit `version`; an `interrupt` preempts the bot. */
export interface RunOptions {
  version?: number;
  timeoutMs?: number;
  rolloutId?: string;
  interrupt?: boolean;
  /** Validate the resolved value against the manifest (draft trials only). */
  validateReturn?: boolean;
  /**
   * D-16 §3.4: a FROZEN event-trace injected as `ctx.events` — the flip gate passes the subject
   * skill's trace into its T(post) run so the test's assertion is race-free (it reads the preceding
   * run's recorded events, never its own live ones). Default: an empty trace.
   */
  injectEvents?: TraceEvent[];
}

/** Construction options for {@link SkillEngine}. */
export interface SkillEngineOptions {
  library: SkillLibrary;
  journal: JournalAppender;
  grants: GrantPolicy;
  /** Resolve the live bot for a runner (the BotPool implements this). */
  resolveBot: (runnerName: string) => Bot | undefined;
  runDefaultTimeoutMs: number;
  stallSeconds: number;
  maxCallDepth: number;
  autoQuarantineAfter: number;
  /** Called when a skill's consecutive-failure streak trips the tripwire (M3 files a critic ticket). */
  onTripwire?: (skill: string, report: RunReport) => void;
  now?: () => number;
  /** Gap W: ms of macrotask starvation before a run is aborted from inside its loop. Default 8 s; tests
   *  lower it to assert the canary deterministically. Production never sets it. */
  macrotaskStallMs?: number;
  /** D-16: ms the event-trace stays open after the body resolves (P-5 grace). Default 500; tests set 0. */
  traceGraceMs?: number;
}

/** The executor. One per host; owns a per-bot run queue and the compile cache. */
export class SkillEngine {
  private readonly library: SkillLibrary;
  private readonly journal: JournalAppender;
  private readonly grants: GrantPolicy;
  private readonly resolveBot: (runnerName: string) => Bot | undefined;
  private readonly runDefaultTimeoutMs: number;
  private readonly stallSeconds: number;
  private readonly maxCallDepth: number;
  private readonly onTripwire?: (skill: string, report: RunReport) => void;
  private readonly now: () => number;
  private readonly macrotaskStallMs: number;
  private readonly traceGraceMs: number;
  private readonly tripwire: FailureTripwire;
  private readonly queues = new Map<string, BotRunQueue>();
  private readonly factories = new Map<string, SkillFactory>();
  /** Per-runner stack of currently-executing ROOT skill names — backs `notWhileRunning` (04) + vitals. */
  private readonly running = new Map<string, string[]>();

  constructor(opts: SkillEngineOptions) {
    this.library = opts.library;
    this.journal = opts.journal;
    this.grants = opts.grants;
    this.resolveBot = opts.resolveBot;
    this.runDefaultTimeoutMs = opts.runDefaultTimeoutMs;
    this.stallSeconds = opts.stallSeconds;
    this.maxCallDepth = opts.maxCallDepth;
    this.onTripwire = opts.onTripwire;
    this.now = opts.now ?? Date.now;
    this.macrotaskStallMs = opts.macrotaskStallMs ?? DEFAULT_MACROTASK_STALL_MS;
    this.traceGraceMs = opts.traceGraceMs ?? DEFAULT_TRACE_GRACE_MS;
    this.tripwire = new FailureTripwire(opts.autoQuarantineAfter);
  }

  /**
   * Run a skill tree on the runner's bot. Pre-execution problems (not found / tier / grant / args)
   * THROW for the caller to surface as a tool error; everything that executes returns a RunReport,
   * even failures and aborts (P3: crash escalation, never suppression).
   */
  async run(name: string, args: object, runner: RunnerRef, opts: RunOptions = {}): Promise<RunReport> {
    const resolved = opts.version !== undefined ? this.library.read(name, opts.version) : this.library.readRunnable(name);
    if (!resolved) throw new SkillNotFoundError(name);
    if (resolved.manifest.tier === 'divine' && runner.tier === 'mortal') throw new TierGateError(name);
    if (!this.grants.canRun(runner.name, name)) throw new GrantError(name, runner.name);
    validateArgs(args, resolved.manifest.params, name);
    const bot = this.resolveBot(runner.name);
    if (!bot) throw new Error(`run "${name}": no bot for runner ${runner.name} (disconnected/dead?)`);

    const queue = this.queueFor(runner.name);
    return queue.run(
      (preemptSignal) => this.executeTree(resolved, args, runner, bot, opts, preemptSignal),
      opts.interrupt ?? false,
    );
  }

  private queueFor(botName: string): BotRunQueue {
    let q = this.queues.get(botName);
    if (!q) {
      q = new BotRunQueue();
      this.queues.set(botName, q);
    }
    return q;
  }

  /**
   * The ROOT skills currently executing on this runner's bot — the live source for the reactivity
   * `notWhileRunning` clause (so a guard mid-fight isn't re-triggered every hit, 04) and the vitals
   * `currentRun` field. Only root runs are tracked (one tree per bot, D-05); composed callees aren't.
   */
  runningSkills(runnerName: string): string[] {
    return [...(this.running.get(runnerName) ?? [])];
  }

  private pushRunning(runnerName: string, skill: string): void {
    const stack = this.running.get(runnerName);
    if (stack) stack.push(skill);
    else this.running.set(runnerName, [skill]);
  }

  private popRunning(runnerName: string, skill: string): void {
    const stack = this.running.get(runnerName);
    if (!stack) return;
    const i = stack.lastIndexOf(skill);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0) this.running.delete(runnerName);
  }

  private compileFor(resolved: ResolvedSkill): SkillFactory {
    const key = `${resolved.version.name}@${resolved.version.version}`;
    const cached = this.factories.get(key);
    if (cached) return cached;
    const result = compile(resolved.code);
    if (!result.ok) throw new Error(`skill "${resolved.version.name}" v${resolved.version.version} ${result.error}`);
    this.factories.set(key, result.factory);
    return result.factory;
  }

  private async executeTree(
    root: ResolvedSkill,
    args: object,
    runner: RunnerRef,
    bot: Bot,
    opts: RunOptions,
    preemptSignal: AbortSignal,
  ): Promise<RunReport> {
    const runId = ulid();
    const rolloutId = opts.rolloutId;
    const startedAt = this.now();
    const worldBefore = captureSnapshot(bot);
    const callTree: CallFrame[] = [];
    const chain: string[] = [];
    const logs: Array<{ level: 'info' | 'warn' | 'error'; message: string; ms: number }> = [];
    let pulses = 0;
    let deepestDepth = 0;

    const ctrl = new AbortController();
    let abortCause: AbortCause | undefined;
    const triggerAbort = (cause: AbortCause): void => {
      if (abortCause === undefined) {
        abortCause = cause;
        if (!ctrl.signal.aborted) ctrl.abort();
      }
    };
    if (preemptSignal.aborted) triggerAbort('preempted');
    else preemptSignal.addEventListener('abort', () => triggerAbort('preempted'));

    const stallMs = this.stallSeconds * 1000;
    const detector = new StallDetector(stallMs, () => triggerAbort('stalled'));
    const pulse = (): void => {
      pulses++;
      detector.pulse();
    };
    const cleanupBuiltins = subscribeBuiltins(bot, pulse, stallMs);
    detector.arm();

    // D-16 §3.4 — the event-trace: NEW engine subscriptions (entityDead/playerCollect were never in
    // STALL_EVENTS) into a bounded ring. `playerCollect` is filtered to the RUNNER's own pickups
    // (attribution, P-5); `entityDead` records the subject entity's identity so a paired test can
    // filter to ITS mob. Closed after a bounded grace (below) so a death landing one tick after the
    // body resolves is not lost.
    const trace: TraceEvent[] = [];
    let eventsDropped = 0;
    const pushTrace = (e: TraceEvent): void => {
      if (trace.length >= TRACE_RING_SIZE) {
        trace.shift();
        eventsDropped++;
      }
      trace.push(e);
    };
    const entityLabel = (e: unknown): { name?: string; id?: number } => {
      if (!e || typeof e !== 'object') return {};
      const o = e as { name?: unknown; username?: unknown; type?: unknown; id?: unknown };
      const name = [o.name, o.username, o.type].find((x): x is string => typeof x === 'string');
      return { ...(name !== undefined ? { name } : {}), ...(typeof o.id === 'number' ? { id: o.id } : {}) };
    };
    const onEntityDead = (...args: unknown[]): void => {
      pushTrace({ kind: 'entityDead', ...entityLabel(args[0]), at: this.now() - startedAt });
    };
    const onPlayerCollect = (...args: unknown[]): void => {
      const collector = args[0] as { username?: string } | undefined;
      if (collector?.username !== bot.username) return; // another body's pickup is not this run's effect
      pushTrace({ kind: 'playerCollect', ...entityLabel(args[1]), at: this.now() - startedAt });
    };
    const onDigComplete = (...args: unknown[]): void => {
      pushTrace({ kind: 'diggingCompleted', ...entityLabel(args[0]), at: this.now() - startedAt });
    };
    bot.on('entityDead', onEntityDead);
    bot.on('playerCollect', onPlayerCollect);
    bot.on('diggingCompleted', onDigComplete);
    const closeTrace = (): void => {
      bot.removeListener('entityDead', onEntityDead);
      bot.removeListener('playerCollect', onPlayerCollect);
      bot.removeListener('diggingCompleted', onDigComplete);
    };

    const wallMs = Math.min(Math.max(opts.timeoutMs ?? this.runDefaultTimeoutMs, 1), HARD_CEILING_MS);
    const wallTimer = setTimeout(() => triggerAbort('timeout'), wallMs);
    unref(wallTimer);

    // Gap W / CRIT-1: the macrotask-starvation canary + the synchronous guard that reads it. `lastTick`
    // is refreshed by a MACROTASK interval; a runaway that only awaits immediately-resolved promises (a
    // loop, OR async recursion / a microtask trampoline with no loop node) starves that interval (it never
    // runs) while `this.now()` advances — so the guard, which runs synchronously inside every loop body
    // (`__loopBudget`) AND every function body (`__fnTick`, R75), sees the gap grow and aborts the run as a
    // stall. `ctx.log`/sleep pulses can't mask it (this measures the macrotask queue itself, not progress
    // pulses), and `wallTimer`/StallDetector remain the bounds for runaways that DO yield to macrotasks.
    let lastTick = this.now();
    // The heartbeat must fire several times INSIDE the stall window or a legit (macrotask-yielding) loop
    // would trip before the first refresh — so cap it at a quarter of the window (≤ MACROTASK_HEARTBEAT_MS).
    const heartbeatMs = Math.max(10, Math.min(MACROTASK_HEARTBEAT_MS, Math.floor(this.macrotaskStallMs / 4)));
    const heartbeat = setInterval(() => { lastTick = this.now(); }, heartbeatMs);
    unref(heartbeat);
    const budget = createLoopBudget(undefined, () => {
      if (this.now() - lastTick > this.macrotaskStallMs) {
        triggerAbort('stalled');
        throw new EngineAbort('stalled');
      }
    });

    // R25: when the op'd avatar (divine runner) runs a MORTAL skill — a demo or a trial of
    // villager-authored code — intercept its chat and drop `/`-commands for the run's duration
    // (only divine code may speak commands on an op'd bot). Villagers are never op'd (first layer).
    const removeInterceptor =
      runner.tier === 'divine' && root.manifest.tier === 'mortal' ? installChatInterceptor(bot) : undefined;

    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(new EngineAbort(abortCause ?? 'preempted'));
      if (ctrl.signal.aborted) onAbort();
      else ctrl.signal.addEventListener('abort', onAbort);
    });

    // The provided sleep pulses each wait tick (D-10) so a long, legitimate wait never false-stalls.
    const sleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        pulse();
        const tick = setInterval(pulse, Math.max(50, Math.min(stallMs / 2, ms)));
        unref(tick);
        const done = setTimeout(() => {
          clearInterval(tick);
          resolve();
        }, ms);
        unref(done);
      });

    const makeCtx = (depth: number): SkillContext => ({
      skills: { run: <T>(n: string, a: object): Promise<T> => composerRun(n, a, depth + 1) as Promise<T> },
      // Runtime tolerance for the `log(level, message)` → public type, but persisted plain-JS skills
      // were authored against an OLD single-arg `log(message)` form: a legacy call binds level='the text',
      // message=undefined, corrupting the LEVEL the critic reads as load-bearing (warn=blocked, error=defect).
      // Normalize so the kinds.ts `'info'|'warn'|'error'` union is honest at runtime. The public
      // SkillContext.log type stays strict (compile-time guidance for authored TS); this signature is loose
      // ONLY because plain-JS skills are compiled from strings and never type-checked.
      log: (levelOrMsg: string, maybeMsg?: string): void => {
        pulse();
        const VALID = ['info', 'warn', 'error'] as const;
        let level: 'info' | 'warn' | 'error';
        let message: string;
        if (maybeMsg === undefined || !(VALID as readonly string[]).includes(levelOrMsg)) {
          // legacy single-arg `log('text')` OR a bogus level string → treat arg1 as the message, default info
          level = 'info';
          message = levelOrMsg;
        } else {
          level = levelOrMsg as 'info' | 'warn' | 'error';
          message = maybeMsg;
        }
        const ms = this.now() - startedAt;
        logs.push({ level, message, ms });
        this.journal.append(actorOf(runner), 'skill.log', { skill: root.version.name, level, message }, {
          runId,
          rolloutId,
          skill: root.version.name,
        });
      },
      signal: ctrl.signal,
      runner,
      depth,
      // D-16 §3.4: the FROZEN injected trace (a T(post) run reads the subject skill's events), never
      // this run's live ring — the assertion is race-free by construction.
      events: opts.injectEvents ?? [],
      Vec3,
      goals,
      // Blocker D1: real mineflayer's `bot.registry` IS the prismarine-registry / minecraft-data instance
      // (it has `itemsByName`/`blocksByName`/…). The LLM writes the idiomatic `ctx.mcData.itemsByName[x].id`,
      // so a ctx WITHOUT this handle dereferences `undefined` ("Cannot read properties of undefined").
      mcData: bot.registry,
    });

    const composerRun = async (calleeName: string, calleeArgs: object, depth: number): Promise<unknown> => {
      if (depth > this.maxCallDepth) throw new Error(`composition depth cap ${this.maxCallDepth} exceeded calling "${calleeName}"`);
      if (chain.includes(calleeName)) throw new Error(`composition cycle: ${[...chain, calleeName].join(' → ')}`);
      // R80: composition resolves the highest ACTIVE (graduated) version — a re-authored v(k+1) on
      // probation no longer blocks every composer of v(k). ProbationError survives ONLY for a first
      // admission (live probationary version, nothing graduated to fall back to — D-12 intent).
      const callee = this.library.readComposable(calleeName);
      if (!callee) {
        if (this.library.readRunnable(calleeName)) throw new ProbationError(calleeName);
        throw new SkillNotFoundError(calleeName);
      }
      if (callee.manifest.test === true) {
        throw new Error(`skill "${calleeName}" is a paired TEST — tests are never composable (D-16, docs/22 §3)`);
      }
      if (callee.manifest.tier === 'divine' && runner.tier === 'mortal') throw new TierGateError(calleeName);
      if (!this.grants.canRun(runner.name, calleeName)) throw new GrantError(calleeName, runner.name);
      validateArgs(calleeArgs, callee.manifest.params, calleeName);
      const fn = this.compileFor(callee)(makeShim({ sleep }, budget));
      chain.push(calleeName);
      deepestDepth = Math.max(deepestDepth, depth);
      const frameStart = this.now();
      let ok = false;
      try {
        const value = await fn(bot, calleeArgs, makeCtx(depth));
        ok = true;
        return value;
      } finally {
        chain.pop();
        callTree.push({ skill: calleeName, version: callee.version.version, ok, ms: this.now() - frameStart });
      }
    };

    let outcome: RunOutcome;
    this.pushRunning(runner.name, root.version.name); // live `notWhileRunning` + vitals source
    try {
      const fn = this.compileFor(root)(makeShim({ sleep }, budget));
      chain.push(root.version.name);
      const value = await Promise.race([
        Promise.resolve().then(() => fn(bot, args, makeCtx(0))),
        abortPromise,
      ]);
      chain.pop();
      if (opts.validateReturn) validateReturn(value, root.manifest.returns, root.version.name);
      outcome = { ok: true, value };
    } catch (e) {
      if (e instanceof EngineAbort) {
        await abortActiveTasks(bot); // R4/R5 — the next action must not fight a zombie task
        outcome = { ok: false, error: abortMessage(e.abortCause), errorKind: e.abortCause };
      } else {
        const err = e instanceof Error ? e : new Error(String(e));
        outcome = { ok: false, error: err.message, errorKind: err.name };
      }
    } finally {
      clearTimeout(wallTimer);
      clearInterval(heartbeat);
      detector.disarm();
      cleanupBuiltins();
      removeInterceptor?.();
      this.popRunning(runner.name, root.version.name);
    }

    // D-16 (P-5): hold the trace open for a bounded grace after the body settles — a kill-mob loop
    // returns when `isValid` flips, but the entityDead packet can land a tick later. worldAfter is
    // captured AFTER the grace for the same reason (a trailing server-confirmed block/inventory
    // update lands inside it). Skills still own their own settling (R55/R79) — this is only the
    // engine-side tail for effects that arrive between "body resolved" and "packets quiesced".
    if (this.traceGraceMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.traceGraceMs);
        unref(t);
      });
    }
    closeTrace();

    const worldAfter = captureSnapshot(bot);
    const report: RunReport = {
      runId,
      rolloutId,
      skill: root.version.name,
      version: root.version.version,
      villager: runner.name,
      args,
      outcome,
      aborted: abortCause,
      startedAt,
      durationMs: this.now() - startedAt,
      pulses,
      deepestDepth,
      callTree,
      logs,
      worldBefore,
      worldAfter,
      events: trace,
      eventsDropped,
    };
    this.journal.append(actorOf(runner), 'skill.run', report, {
      runId,
      rolloutId,
      skill: root.version.name,
      skillVersion: root.version.version,
    });
    if (this.tripwire.recordRun(root.version.name, outcome.ok)) this.onTripwire?.(root.version.name, report);
    // D-12 graduation (R57): a clean ROOT production run of an admitted (active-probation) skill advances
    // it toward `active`. Gated on the version that ACTUALLY ran being the probationary one, so a draft
    // trial of a newer version never advances an older live-probation version, and `active` skills are
    // untouched. Without this call recordProbationRun has no runtime caller — every admitted skill stays
    // active-probation forever, so it is never composable (engine.ts §ProbationError) and villagers churn
    // re-authoring wrappers around it until the tool-turn ceiling. NOTE: graduation counts CLEAN RUNS
    // (the engine's didn't-throw `outcome.ok` flag), NOT critic-re-judged runs — the "auto-ticket for
    // re-review" rail of 03-god.md §Probation is still UNBUILT (DEFERRED). So three clean exits advance a
    // probationary skill to `active` without a fresh verdict; this is run-counting, matching the 02 state
    // machine + the engine pinning test.
    if (root.version.status === 'active-probation') this.library.recordProbationRun(root.version.name, outcome.ok);
    return report;
  }
}

/** The injected engine surface a skill body receives as `ctx` (02 §Skill anatomy). */
export interface SkillContext {
  skills: { run<T>(name: string, args: object): Promise<T> };
  log(level: 'info' | 'warn' | 'error', message: string): void;
  signal: AbortSignal;
  runner: RunnerRef;
  depth: number;
  /**
   * D-16 §3.4: the FROZEN event-trace of the SUBJECT skill's run, injected by the flip gate into a
   * T(post) run (`RunOptions.injectEvents`). Empty on ordinary runs. A test asserts over this — e.g.
   * `ctx.events.some(e => e.kind === 'entityDead')` — never over its own live events (race-free).
   */
  events: readonly TraceEvent[];
  /**
   * Blocker Z: the REAL `vec3` Vec3 constructor. A skill builds positions with `new ctx.Vec3(x,y,z)`
   * for `bot.blockAt`/`bot.placeBlock`/`bot.creative.flyTo` — real mineflayer calls `.floored()` on a
   * plain `{x,y,z}` and throws. Typed loosely (skills are runtime strings; this type is for the engine).
   */
  Vec3: new (x: number, y: number, z: number) => { x: number; y: number; z: number };
  /**
   * Blocker Z: mineflayer-pathfinder's `goals` module. A skill targets `bot.pathfinder.goto` with
   * `new ctx.goals.GoalNear(x,y,z,range)` — a plain `{x,y,z,range}` makes pathfinder throw
   * `stateGoal.isValid is not a function` ASYNCHRONOUSLY from the physics tick (host-crashing).
   */
  goals: {
    GoalNear: new (x: number, y: number, z: number, range: number) => unknown;
    GoalBlock?: new (x: number, y: number, z: number) => unknown;
  };
  /**
   * Blocker D1: the mineflayer registry (`bot.registry` — prismarine-registry / minecraft-data). The LLM
   * writes the idiomatic `ctx.mcData.itemsByName[name].id` / `ctx.mcData.blocksByName[name].id`; without
   * this handle the ctx exposes no `mcData` and the skill dereferences `undefined` ("Cannot read properties
   * of undefined (reading 'itemsByName')"). It is the same `ItemRegistry` shape as `bot.registry` (so the
   * FakeBot seam keeps the engine tests typechecking); may be `undefined` only on a not-yet-spawned bot.
   */
  mcData: ItemRegistry | undefined;
}

/** D-05: one skill tree per bot. Concurrent runs queue; an `interrupt` preempts the running tree. */
class BotRunQueue {
  private tail: Promise<unknown> = Promise.resolve();
  // The cause is always 'preempted' (the only thing that aborts a queued tree from here), so the
  // abort callback takes no argument — executeTree maps the AbortController to 'preempted' itself.
  private currentAbort?: () => void;

  run<T>(treeFn: (preemptSignal: AbortSignal) => Promise<T>, interrupt: boolean): Promise<T> {
    if (interrupt) this.currentAbort?.();
    const prev = this.tail;
    const exec = (async (): Promise<T> => {
      await prev.catch(() => undefined); // wait my turn regardless of the prior tree's outcome
      const ctrl = new AbortController();
      const myAbort = (): void => {
        if (!ctrl.signal.aborted) ctrl.abort();
      };
      this.currentAbort = myAbort;
      try {
        return await treeFn(ctrl.signal);
      } finally {
        if (this.currentAbort === myAbort) this.currentAbort = undefined;
      }
    })();
    this.tail = exec;
    return exec;
  }
}

/** D-10: a stall is "no discrete progress pulse for stallSeconds." A pulse is an EVENT, never a state. */
class StallDetector {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private armed = false;

  constructor(
    private readonly stallMs: number,
    private readonly onStall: () => void,
  ) {}

  arm(): void {
    this.armed = true;
    this.restart();
  }
  pulse(): void {
    if (this.armed) this.restart();
  }
  disarm(): void {
    this.armed = false;
    if (this.timer) clearTimeout(this.timer);
  }
  private restart(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.armed) this.onStall();
    }, this.stallMs);
    unref(this.timer);
  }
}

/** autoQuarantineAfter consecutive failures of one skill → fire once (R36: resets, never a permanent gag). */
class FailureTripwire {
  private readonly consecutive = new Map<string, number>();
  constructor(private readonly threshold: number) {}
  recordRun(skill: string, ok: boolean): boolean {
    if (ok) {
      this.consecutive.set(skill, 0);
      return false;
    }
    const n = (this.consecutive.get(skill) ?? 0) + 1;
    if (n >= this.threshold) {
      this.consecutive.set(skill, 0); // re-arm so it files once per streak, not every run past the threshold
      return true;
    }
    this.consecutive.set(skill, n);
    return false;
  }
}

// ── D-10 built-in pulse sources: pathfinder liveness (R26) + dig/window + sampled pos/inventory ──
const STALL_EVENTS = [
  'path_update',
  'path_reset',
  'goal_reached',
  'goal_updated',
  'path_stop',
  'diggingStarted',
  'diggingCompleted',
  'windowOpen',
  'windowClose',
] as const;

function subscribeBuiltins(bot: Bot, pulse: () => void, stallMs: number): () => void {
  const handlers: Array<[string, () => void]> = [];
  for (const ev of STALL_EVENTS) {
    const h = (): void => pulse();
    bot.on(ev, h);
    handlers.push([ev, h]);
  }
  let lastPos = posKey(bot);
  let lastInv = invCount(bot);
  const sampleMs = Math.max(50, Math.min(500, Math.floor(stallMs / 2)));
  const sampler = setInterval(() => {
    const p = posKey(bot);
    if (p !== lastPos) {
      lastPos = p;
      pulse();
    }
    const inv = invCount(bot);
    if (inv !== lastInv) {
      lastInv = inv;
      pulse();
    }
  }, sampleMs);
  unref(sampler);
  return (): void => {
    for (const [ev, h] of handlers) bot.removeListener(ev, h);
    clearInterval(sampler);
  };
}

function posKey(bot: Bot): string {
  const p = bot.entity?.position;
  return p ? `${p.x},${p.y},${p.z}` : 'none';
}
function invCount(bot: Bot): number {
  try {
    return bot.inventory.items().reduce((s, i) => s + i.count, 0);
  } catch {
    return 0;
  }
}

// HIGH-1 snapshot bounds — keep the world delta SMALL so it never bloats a prompt (it renders into
// every critic/villager context). Entities capped to the nearest N within a small radius; the block
// scan is a single bounded findBlocks (nearest-first), reduced to DISTINCT names.
const SNAPSHOT_ENTITY_RADIUS = 24;
const SNAPSHOT_ENTITY_CAP = 16;
const SNAPSHOT_BLOCK_RADIUS = 8;
const SNAPSHOT_BLOCK_SCAN_CAP = 96; // positions to scan
const SNAPSHOT_BLOCK_NAME_CAP = 24; // distinct names kept

/**
 * Capture the world delta the critic judges (HIGH-1: this WAS stubbed — biome/time/equipment/entities/
 * blocks hardcoded empty, so the critic judged a dead scene for every non-inventory task). Each read is
 * defended (try/catch → safe default) so a not-yet-spawned/minimal bot never throws here — the snapshot
 * degrades field-by-field instead of failing the whole run. biome stays 'unknown' (no cheap live source
 * via the narrowed seam); knownChests stays [] (chest anchors live in villager memory, not on the bot).
 */
function captureSnapshot(bot: Bot): Snapshot {
  const p: Vec3Like = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  const blocks = readNearbyBlocks(bot, p);
  return {
    biome: 'unknown',
    time: readTime(bot),
    position: [p.x, p.y, p.z],
    health: bot.health ?? 20,
    hunger: bot.food ?? 20,
    equipment: readEquipment(bot),
    inventory: readInventory(bot),
    nearbyEntities: readNearbyEntities(bot, p),
    nearbyBlocks: blocks.names,
    nearbyBlockCounts: blocks.counts,
    knownChests: [],
  };
}

function readTime(bot: Bot): number {
  try {
    return bot.time?.timeOfDay ?? 0;
  } catch {
    return 0;
  }
}

function readInventory(bot: Bot): Array<{ name: string; count: number }> {
  try {
    return bot.inventory.items().map((i) => ({ name: i.name, count: i.count }));
  } catch {
    return [];
  }
}

/** Held item + worn armor (mineflayer keeps armor in `inventory.slots[5..8]`), names only, deduped. */
function readEquipment(bot: Bot): string[] {
  const out: string[] = [];
  try {
    if (bot.heldItem?.name) out.push(bot.heldItem.name);
    const slots = bot.inventory.slots;
    if (Array.isArray(slots)) {
      for (let i = 5; i <= 8; i++) {
        const it = slots[i];
        if (it?.name) out.push(it.name);
      }
    }
  } catch {
    return out;
  }
  return [...new Set(out)];
}

/** The nearest entities within a small radius (name + distance), nearest-first, capped (HIGH-1). */
function readNearbyEntities(bot: Bot, p: Vec3Like): Array<{ name: string; distance: number }> {
  try {
    const ents = bot.entities;
    if (!ents) return [];
    const out: Array<{ name: string; distance: number }> = [];
    for (const e of Object.values(ents)) {
      // FIX (critic snapshot): real mineflayer PLAYER entities expose `username` (and `type`), NOT `name`,
      // so a `!e.name` guard silently dropped every player/villager from the critic's scene. Fall back
      // through username/type (mirrors bots/signals.ts:171 `e.name ?? e.username`); skip only when no label.
      if (!e || !e.position) continue;
      const label = e.name ?? e.username ?? e.type;
      if (!label) continue;
      const d = Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z);
      if (d > SNAPSHOT_ENTITY_RADIUS) continue;
      out.push({ name: label, distance: d });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, SNAPSHOT_ENTITY_CAP);
  } catch {
    return [];
  }
}

/**
 * Distinct nearby non-air block names + PER-NAME COUNTS within a small radius via ONE bounded
 * findBlocks (HIGH-1, R76; counts added by O-4 — the flip gate's Sδ compares counts, because a
 * deduped name set misses the 2nd farmland/wheat of a till/sow into a field already showing one).
 */
function readNearbyBlocks(bot: Bot, p: Vec3Like): { names: string[]; counts: Record<string, number> } {
  try {
    if (typeof bot.findBlocks !== 'function') return { names: [], counts: {} };
    // R76: a function matcher must read ONLY block.name (it runs against synthetic palette blocks with
    // no position/neighbours), so this name-only "anything but air" matcher survives the palette pre-check.
    const positions = bot.findBlocks({
      matching: (b) => !!b && b.name !== 'air',
      maxDistance: SNAPSHOT_BLOCK_RADIUS,
      count: SNAPSHOT_BLOCK_SCAN_CAP,
      point: p,
    });
    const counts: Record<string, number> = {};
    for (const pos of positions) {
      const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
      if (!block?.name || block.name === 'air') continue;
      if (counts[block.name] === undefined && Object.keys(counts).length >= SNAPSHOT_BLOCK_NAME_CAP) continue;
      counts[block.name] = (counts[block.name] ?? 0) + 1;
    }
    return { names: Object.keys(counts), counts };
  } catch {
    return { names: [], counts: {} };
  }
}

function abortMessage(cause: AbortCause): string {
  switch (cause) {
    case 'stalled':
      return 'no progress (stall detector: no pulse within stallSeconds)';
    case 'timeout':
      return 'wall-clock timeout (run exceeded its time budget)';
    case 'preempted':
      return 'preempted (an interrupt directive took the bot — benign, R9)';
  }
}

function actorOf(runner: RunnerRef): string {
  return runner.tier === 'divine' ? 'god:body' : `villager:${runner.name}`;
}

function unref(handle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof handle === 'object' && handle && 'unref' in handle) {
    (handle as { unref: () => void }).unref();
  }
}

// ── arg / return validation (D-04 boundary checks; readable, schema-derived) ──
function schemaType(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const t = (schema as Record<string, unknown>)['type'];
  return typeof t === 'string' ? t : undefined;
}
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true; // unknown/absent type → don't second-guess (full power, P3)
  }
}

/** The JSON value of a schema's `enum`, or undefined if absent/not an array. */
function schemaEnum(schema: unknown): unknown[] | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const e = (schema as Record<string, unknown>)['enum'];
  return Array.isArray(e) ? e : undefined;
}

/**
 * Recursively validate a value against a schema (D-04 boundary check). Walks nested object
 * `properties` + `required`, array `items`, and `enum` membership, raising a PATH-QUALIFIED
 * {@link ArgValidationError} on the first mismatch (e.g. `field.sub: expected number`). An absent
 * `type` is NOT second-guessed (full power, P3) — only the constraints the schema actually states
 * are enforced. `path` is the dotted/indexed location for the message; `subject` names the skill +
 * which side (args/return) so the error carries its subject (S10).
 */
function validateValue(value: unknown, schema: JsonSchema, subject: string, path: string): void {
  const where = path === '' ? subject : `${subject}: ${path}`;
  const en = schemaEnum(schema);
  if (en && !en.some((v) => v === value)) {
    throw new ArgValidationError(`${where}: expected one of ${JSON.stringify(en)}, got ${JSON.stringify(value)}`);
  }
  const t = schemaType(schema);
  if (t && !matchesType(value, t)) {
    throw new ArgValidationError(`${where}: expected ${t}, got ${value === null ? 'null' : typeof value}`);
  }
  if (t === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const s = schema as Record<string, unknown>;
    const props = s['properties'] && typeof s['properties'] === 'object' ? (s['properties'] as Record<string, JsonSchema>) : {};
    const required = Array.isArray(s['required']) ? (s['required'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    for (const r of required) {
      if (!(r in v)) throw new ArgValidationError(`${where}: missing required field "${r}"`);
    }
    for (const [k, sub] of Object.entries(props)) {
      if (!(k in v)) continue;
      validateValue(v[k], sub, subject, path === '' ? k : `${path}.${k}`);
    }
  } else if (t === 'array' && Array.isArray(value)) {
    const items = (schema as Record<string, unknown>)['items'];
    if (items && typeof items === 'object') {
      value.forEach((el, i) => validateValue(el, items as JsonSchema, subject, `${path}[${i}]`));
    }
  }
}

/** Validate an args bag against an object schema (D-04). Throws a path-qualified error on mismatch. */
export function validateArgs(args: object, schema: JsonSchema, skillName: string): void {
  if (schemaType(schema) !== 'object') return;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ArgValidationError(`${skillName}: args must be an object`);
  }
  validateValue(args, schema, skillName, '');
}

/** Validate a skill's resolved value against the manifest returns schema (draft trials only). */
export function validateReturn(value: unknown, schema: JsonSchema, skillName: string): void {
  if (schemaType(schema) === undefined && schemaEnum(schema) === undefined) return; // absent type → don't second-guess
  validateValue(value, schema, `${skillName}: return`, '');
}
