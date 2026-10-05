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
/** Gap W — the macrotask-starvation canary. A `setInterval` is a MACROTASK; a loop that only awaits
 *  immediately-resolved promises starves the macrotask queue, so this interval FREEZES while `now()`
 *  keeps advancing. The synchronous loop-budget guard reads `now() - lastTick`; once it exceeds the
 *  stall window the run aborts from INSIDE the loop (the only path a timer-starved supervisor can't take).
 *  The window is well below Minecraft's ~30 s keep-alive timeout (so the bot survives) and well above any
 *  legitimate per-iteration synchronous burst (so a real skill is never false-aborted). */
const MACROTASK_HEARTBEAT_MS = 100;
const DEFAULT_MACROTASK_STALL_MS = 8_000;
const DEFAULT_ABORT_SETTLE_MS = 1_000;

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
  /** Bug #13 / D-05: after an abort, how long the engine waits for the fenced skill code to settle before it
   *  releases the bot to the next tree. Default 1000 ms. Code still awaiting a bot promise past this (a dig the
   *  abort protocol could not cancel) is reported in the outcome; it can no longer await, loop or compose. */
  abortSettleMs?: number;
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
  private readonly abortSettleMs: number;
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
    this.abortSettleMs = opts.abortSettleMs ?? DEFAULT_ABORT_SETTLE_MS;
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

    const wallMs = Math.min(Math.max(opts.timeoutMs ?? this.runDefaultTimeoutMs, 1), HARD_CEILING_MS);
    const wallTimer = setTimeout(() => triggerAbort('timeout'), wallMs);
    unref(wallTimer);

    // Gap W: the macrotask-starvation canary + the synchronous loop-budget guard that reads it. `lastTick`
    // is refreshed by a MACROTASK interval; a loop that only awaits immediately-resolved promises starves
    // that interval (it never runs) while `this.now()` advances — so the guard, which runs synchronously
    // inside every loop body, sees the gap grow and aborts the run as a stall. `ctx.log`/sleep pulses can't
    // mask it (this measures the macrotask queue itself, not progress pulses), and `wallTimer`/StallDetector
    // remain the bounds for loops that DO yield to macrotasks.
    let lastTick = this.now();
    // The heartbeat must fire several times INSIDE the stall window or a legit (macrotask-yielding) loop
    // would trip before the first refresh — so cap it at a quarter of the window (≤ MACROTASK_HEARTBEAT_MS).
    const heartbeatMs = Math.max(10, Math.min(MACROTASK_HEARTBEAT_MS, Math.floor(this.macrotaskStallMs / 4)));
    const heartbeat = setInterval(() => { lastTick = this.now(); }, heartbeatMs);
    unref(heartbeat);
    // Bug #13 (D-05): Promise.race only stops WAITING for an aborted tree, it does not stop the code. The
    // fence makes the aborted code's next loop iteration, await or composition throw, so it cannot keep
    // driving the body while the next tree runs. A loop's guard sits outside any try in its body, so code
    // that catches the abort still cannot iterate again.
    const fence = (): void => {
      if (abortCause !== undefined) throw new EngineAbort(abortCause);
    };
    const budget = createLoopBudget(
      undefined,
      () => {
        fence();
        if (this.now() - lastTick > this.macrotaskStallMs) {
          triggerAbort('stalled');
          throw new EngineAbort('stalled');
        }
      },
      fence,
    );

    // R25: when the op'd avatar (divine runner) runs a MORTAL skill — a demo or a trial of
    // villager-authored code — intercept its chat and drop `/`-commands for the run's duration
    // (only divine code may speak commands on an op'd bot). Scenario villagers ARE op'd on join (Eden needs
    // /spreadplayers, /clear, /give) — the tier boundary is enforced here in the engine, not by server permissions.
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
      log: (msg: string): void => {
        pulse();
        this.journal.append(actorOf(runner), 'skill.log', { skill: root.version.name, message: msg }, {
          runId,
          rolloutId,
          skill: root.version.name,
        });
      },
      signal: ctrl.signal,
      runner,
      depth,
      Vec3,
      goals,
      // Blocker D1: real mineflayer's `bot.registry` IS the prismarine-registry / minecraft-data instance
      // (it has `itemsByName`/`blocksByName`/…). The LLM writes the idiomatic `ctx.mcData.itemsByName[x].id`,
      // so a ctx WITHOUT this handle dereferences `undefined` ("Cannot read properties of undefined").
      mcData: bot.registry,
    });

    const composerRun = async (calleeName: string, calleeArgs: object, depth: number): Promise<unknown> => {
      fence(); // an aborted tree never starts a callee (bug #13)
      if (depth > this.maxCallDepth) throw new Error(`composition depth cap ${this.maxCallDepth} exceeded calling "${calleeName}"`);
      if (chain.includes(calleeName)) throw new Error(`composition cycle: ${[...chain, calleeName].join(' → ')}`);
      const callee = this.library.readRunnable(calleeName);
      if (!callee) throw new SkillNotFoundError(calleeName);
      if (callee.manifest.tier === 'divine' && runner.tier === 'mortal') throw new TierGateError(calleeName);
      if (!this.grants.canRun(runner.name, calleeName)) throw new GrantError(calleeName, runner.name);
      if (callee.version.status === 'active-probation') throw new ProbationError(calleeName); // D-12 gate
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
    let tree: Promise<unknown> | undefined;
    this.pushRunning(runner.name, root.version.name); // live `notWhileRunning` + vitals source
    try {
      const fn = this.compileFor(root)(makeShim({ sleep }, budget));
      chain.push(root.version.name);
      tree = Promise.resolve().then(() => fn(bot, args, makeCtx(0)));
      const value = await Promise.race([tree, abortPromise]);
      chain.pop();
      if (opts.validateReturn) validateReturn(value, root.manifest.returns, root.version.name);
      outcome = { ok: true, value };
    } catch (e) {
      if (e instanceof EngineAbort) {
        await abortActiveTasks(bot); // R4/R5 — the next action must not fight a zombie task
        // D-05: hold the bot (this tree's queue slot) until the fenced code has actually settled, bounded so a
        // promise the abort protocol could not cancel cannot wedge the bot's queue forever.
        const settled = tree ? await settleWithin(tree, this.abortSettleMs) : true;
        const note = settled ? '' : ` — the aborted code had not settled after ${this.abortSettleMs}ms (fenced: it can no longer await, loop or compose)`;
        outcome = { ok: false, error: abortMessage(e.abortCause) + note, errorKind: e.abortCause };
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
      worldBefore,
      worldAfter,
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
    // re-authoring wrappers around it until the tool-turn ceiling. NOTE: this counts clean runs but does
    // NOT re-judge them with the critic (the "auto-ticket for re-review" of 03-god.md §Probation is still
    // unbuilt) — graduation is run-counting, matching the 02 state machine + the engine pinning test.
    if (root.version.status === 'active-probation') this.library.recordProbationRun(root.version.name, outcome.ok);
    return report;
  }
}

/** The injected engine surface a skill body receives as `ctx` (02 §Skill anatomy). */
export interface SkillContext {
  skills: { run<T>(name: string, args: object): Promise<T> };
  log(message: string): void;
  signal: AbortSignal;
  runner: RunnerRef;
  depth: number;
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
  private currentAbort?: (cause: AbortCause) => void;

  run<T>(treeFn: (preemptSignal: AbortSignal) => Promise<T>, interrupt: boolean): Promise<T> {
    if (interrupt) this.currentAbort?.('preempted');
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

function captureSnapshot(bot: Bot): Snapshot {
  const p: Vec3Like = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  let inventory: Array<{ name: string; count: number }> = [];
  try {
    inventory = bot.inventory.items().map((i) => ({ name: i.name, count: i.count }));
  } catch {
    inventory = [];
  }
  return {
    biome: 'unknown',
    time: 0,
    position: [p.x, p.y, p.z],
    health: bot.health ?? 20,
    hunger: bot.food ?? 20,
    equipment: [],
    inventory,
    nearbyEntities: [],
    nearbyBlocks: [],
    knownChests: [],
  };
}

/** True once `p` settles (either way), false if `ms` elapse first. Never rejects. */
function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    unref(t);
    p.then(
      () => { clearTimeout(t); resolve(true); },
      () => { clearTimeout(t); resolve(true); },
    );
  });
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

/** Validate an args bag against an object schema's properties + required (D-04). Throws on mismatch. */
export function validateArgs(args: object, schema: JsonSchema, skillName: string): void {
  if (schemaType(schema) !== 'object') return;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ArgValidationError(`${skillName}: args must be an object`);
  }
  const a = args as Record<string, unknown>;
  const s = schema as Record<string, unknown>;
  const props = s['properties'] && typeof s['properties'] === 'object' ? (s['properties'] as Record<string, unknown>) : {};
  const required = Array.isArray(s['required']) ? (s['required'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  for (const r of required) {
    if (!(r in a)) throw new ArgValidationError(`${skillName}: missing required arg "${r}"`);
  }
  for (const [k, sub] of Object.entries(props)) {
    if (!(k in a)) continue;
    const t = schemaType(sub);
    if (t && !matchesType(a[k], t)) {
      throw new ArgValidationError(`${skillName}: ${k}: expected ${t}, got ${a[k] === null ? 'null' : typeof a[k]}`);
    }
  }
}

/** Validate a skill's resolved value against the manifest returns schema (draft trials only). */
export function validateReturn(value: unknown, schema: JsonSchema, skillName: string): void {
  const t = schemaType(schema);
  if (t && !matchesType(value, t)) {
    throw new ArgValidationError(`${skillName}: return: expected ${t}, got ${value === null ? 'null' : typeof value}`);
  }
}
