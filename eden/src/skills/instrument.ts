// The ONE AST transform Eden keeps (owner #5, D-08). NOT a sandbox, NOT a typecheck:
//   1. parse with acorn (ecmaVersion 2022) — syntax errors return inline to the author (write_skill);
//   2. inject a loop-budget call into every loop body, AND a macrotask-starvation canary (`__fnTick`)
//      at every function-body top (CRIT-1/R75) — the only in-process answer to a runaway that would
//      freeze the whole host (D-01): a SYNCHRONOUS `while(true){}`, or a NON-loop spinner (async
//      recursion / `.then`-chain / microtask trampoline) that has no loop node to instrument. The loop
//      counter resets on every real `await`; the canary is count-free so legitimate deep recursion is
//      never false-aborted (the count would; the canary won't — it fires only on real starvation);
//   3. install the D-08 syscall shim as PROVIDED SCOPE GLOBALS (not a banned-identifier scan):
//      `process`/`require('process')` are shadowed by a safe object whose four host-killers throw
//      SkillForbiddenError. The denylist is FROZEN at four (R45) — determined escapes
//      (globalThis.process, the Function ctor) remain reachable BY DESIGN; the only security
//      boundary is the tier gate (R25), not this.
//
// Layer 2 (skills/): imports acorn + the journal-free vec3/pathfinder value-constructors it re-exposes as
// authored globals (legal external deps — depcruise forbids UPWARD local imports only). The engine
// (engine.ts) compiles once per version and calls the factory per run with a fresh shim.

import * as acorn from 'acorn';
import { simple as walkSimple } from 'acorn-walk';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';

// Convenience value-constructors exposed to authored skills as GLOBALS — distinct from the D-08 safety
// shim below. LLMs reach for the universal mineflayer idioms `new Vec3(x,y,z)` / `new GoalNear(x,y,z,r)`,
// and a bare `ReferenceError: Vec3 is not defined` costs a whole revision (seen live: craft-wooden-tools
// v3). These are the SAME module instances the engine puts on `ctx` (vec3 + mineflayer-pathfinder are
// singletons), so `new Vec3()` and `new ctx.Vec3()` are identical and the FakeBot `.x/.y/.z` seam is
// untouched. Pure value ctors (no capability, no I/O) — they do NOT widen the boundary (still the tier
// gate, R25). R15: pathfinder is flagless-CJS, default-import then destructure.
const { goals } = pathfinderPkg;

/** A skill called a forbidden host-killer (process.exit/reallyExit/abort/kill) — D-08. */
export class SkillForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillForbiddenError';
  }
}

/** A skill made no progress: the loop budget tripped (sync spin) or the stall detector fired. */
export class SkillStalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillStalledError';
  }
}

/** Loop iterations allowed between real awaits before a sync spin is declared stalled. Hardcoded (S7). */
export const DEFAULT_LOOP_BUDGET = 1_000_000;
/** The message a loop-budget trip carries (vs the stall detector's 'no progress'). */
export const LOOP_BUDGET_MESSAGE = 'loop budget';

/**
 * D-08 / R45: the shim neuters EXACTLY these four `process` methods and is FROZEN. Growing it
 * rebuilds v1's banned-identifier scan the rewrite deliberately dropped — the shim is footgun
 * removal, not a sandbox. They are the host-killers with no legitimate skill use and an unbounded
 * blast radius; everything else on `process` is simply absent from the safe object.
 */
export const DENIED_PROCESS_METHODS = Object.freeze(['exit', 'reallyExit', 'abort', 'kill'] as const);

/**
 * Result of {@link parse} — never throws; a syntax error returns inline for write_skill feedback.
 * `offset` is how many chars the program's node positions are shifted relative to the ORIGINAL
 * `code` string (0 for a direct parse; >0 when we fell back to a wrapped-expression parse — see
 * below). Callers that splice by AST offsets MUST subtract it before indexing into `code`.
 */
export type ParseResult =
  | { ok: true; program: acorn.Program; offset: number }
  | { ok: false; error: string };

/** The single-char prefix the expression-wrapper fallback adds — every node shifts right by this. */
const WRAP_PREFIX = '(';
const WRAP_OFFSET = WRAP_PREFIX.length;

/**
 * Parse skill source (ecmaVersion 2022). Full power — no banned identifiers, no import scan (P3).
 *
 * A NAMED top-level `async function name(){}` parses directly as a FunctionDeclaration. An anonymous
 * `async function(){}` or an arrow `async (a)=>{}` is NOT a legal statement in script mode (acorn
 * rejects `Unexpected token`), but both are valid function EXPRESSIONS. So on a script-mode failure we
 * retry by wrapping the code as `(code)` — a parenthesized expression. The wrapper shifts every node
 * offset right by {@link WRAP_OFFSET}; the returned `offset` records that so {@link instrument} can
 * subtract it before splicing into the original (unwrapped) string. Robustness: the author shouldn't
 * be punished for a valid-but-unnamed function (P1).
 */
export function parse(code: string): ParseResult {
  try {
    const program = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
    return { ok: true, program, offset: 0 };
  } catch (directError) {
    // Fallback: maybe it's a bare function/arrow EXPRESSION, illegal only as a statement. Wrap + retry.
    try {
      const program = acorn.parse(`${WRAP_PREFIX}${code})`, { ecmaVersion: 2022, sourceType: 'script' });
      return { ok: true, program, offset: WRAP_OFFSET };
    } catch {
      // The wrapped parse failed too — report the ORIGINAL (direct) error, the one the author can act on.
      const message = directError instanceof Error ? directError.message : String(directError);
      return { ok: false, error: `parse error: ${message}` };
    }
  }
}

/** Result of {@link instrument} — instrumented source string, or an inline parse error. */
export type InstrumentResult = { ok: true; source: string } | { ok: false; error: string };

interface BodyNode {
  type: string;
  start: number;
  end: number;
}
interface LoopNode {
  body: BodyNode;
}
interface AwaitNode {
  argument: BodyNode;
}

interface Edit {
  pos: number;
  text: string;
  /** Lower order is applied LAST at the same position, so it lands leftmost in the output. */
  order: number;
}

/**
 * Inject `__loopBudget()` at the top of every loop body, a count-free macrotask-starvation canary
 * (`__fnTick()`) at the top of every FUNCTION body (CRIT-1/R75 — so a runaway with no loop node, e.g.
 * async recursion or a `.then`/microtask trampoline, still hits the canary), and wrap every `await EXPR`
 * as `await __aw(EXPR)` (the await resets the LOOP budget — a real yield is not a sync spin). String-splice
 * by AST offsets, applied right-to-left so earlier offsets stay valid.
 */
export function instrument(code: string): InstrumentResult {
  const parsed = parse(code);
  if (!parsed.ok) return parsed;

  // Node offsets are relative to whatever parse() actually parsed; if it fell back to the wrapped
  // form (`(code)`), every position is shifted right by `parsed.offset`. We splice into the ORIGINAL
  // `code`, so subtract the wrapper prefix before recording each edit position (P1 — anonymous/arrow).
  const off = parsed.offset;
  const edits: Edit[] = [];
  const injectLoopBody = (node: unknown): void => {
    const body = (node as LoopNode).body;
    if (body.type === 'BlockStatement') {
      edits.push({ pos: body.start - off + 1, text: '__loopBudget();', order: 0 });
    } else {
      // Bare-statement body (`while(x) stmt;`) — brace it so the budget call is legal.
      edits.push({ pos: body.start - off, text: '{__loopBudget();', order: 0 });
      edits.push({ pos: body.end - off, text: '}', order: 1 });
    }
  };
  // CRIT-1/R75: the canary at every function-body top is the ONLY in-process guard a non-loop runaway
  // hits (async recursion, `.then`/queueMicrotask/nextTick trampolines — all function nodes, no loop
  // node). It calls `__fnTick` (the macrotask-starvation canary WITHOUT the loop count), so a deep but
  // finite synchronous call tree can never trip the 1e6 loop budget — only real starvation aborts it.
  const injectFnBody = (node: unknown): void => {
    const body = (node as LoopNode).body;
    if (body.type === 'BlockStatement') {
      edits.push({ pos: body.start - off + 1, text: '__fnTick();', order: 0 });
    } else {
      // Expression-bodied arrow (`x => EXPR`): comma-operator wrap — keeps the value, robust for object
      // literals (`() => ({a:1})` → `() => ((__fnTick(),{a:1}))`), and never needs a `return`.
      edits.push({ pos: body.start - off, text: '(__fnTick(),', order: 0 });
      edits.push({ pos: body.end - off, text: ')', order: 1 });
    }
  };
  walkSimple(parsed.program, {
    WhileStatement: injectLoopBody,
    DoWhileStatement: injectLoopBody,
    ForStatement: injectLoopBody,
    ForInStatement: injectLoopBody,
    ForOfStatement: injectLoopBody,
    FunctionDeclaration: injectFnBody,
    FunctionExpression: injectFnBody,
    ArrowFunctionExpression: injectFnBody,
    AwaitExpression: (node: unknown): void => {
      const arg = (node as AwaitNode).argument;
      edits.push({ pos: arg.start - off, text: '__aw(', order: 0 });
      edits.push({ pos: arg.end - off, text: ')', order: 1 });
    },
  });

  // Apply right-to-left; ties resolved so opening text lands left of closing text at the same pos.
  edits.sort((a, b) => b.pos - a.pos || b.order - a.order);
  let out = code;
  for (const e of edits) out = out.slice(0, e.pos) + e.text + out.slice(e.pos);
  return { ok: true, source: out };
}

/** The per-run dynamic scope the engine supplies: a pulsing `sleep` and an optional budget override. */
export interface SkillRuntime {
  /** Pulses the stall detector each wait tick (engine-provided); here just a delay. */
  sleep(ms: number): Promise<void>;
  /** Override the loop budget (tests lower it); defaults to {@link DEFAULT_LOOP_BUDGET}. */
  loopBudget?: number;
}

/** The opaque scope-globals bag handed to a compiled skill factory. */
export interface Shim {
  process: object;
  require: (id: string) => unknown;
  sleep: (ms: number) => Promise<void>;
  __loopBudget: () => void;
  __aw: <T>(p: T) => T;
  /** CRIT-1/R75: the function-body macrotask-starvation canary (count-free `__loopBudget`). */
  __fnTick: () => void;
  /** Authored-scope global value-constructors (see the import-site note): the same module instances on
   *  `ctx`, so `new Vec3()` ≡ `new ctx.Vec3()` and `new GoalNear()` ≡ `new ctx.goals.GoalNear()`. */
  Vec3: new (x: number, y: number, z: number) => { x: number; y: number; z: number };
  GoalNear: new (x: number, y: number, z: number, range: number) => unknown;
}

/** A compiled skill: call with (bot, args, ctx) to run it. */
export type SkillFn = (bot: unknown, args: unknown, ctx: unknown) => Promise<unknown>;
/** Binds a fresh {@link Shim} into the compiled closure, returning the runnable skill function. */
export type SkillFactory = (shim: Shim) => SkillFn;

/** Result of {@link compile} — a reusable factory, or an inline parse/compile error for the author. */
export type CompileResult = { ok: true; factory: SkillFactory } | { ok: false; error: string };

/**
 * Parse + instrument + wrap the skill source into a factory (one `new Function` per version). The
 * inner skill closes over the destructured shim names, so `process`/`sleep`/`__loopBudget`/`__aw`
 * are the SHADOWED provided globals — the D-08 mechanism. Errors return inline (write_skill retry).
 */
export function compile(code: string): CompileResult {
  const inst = instrument(code);
  if (!inst.ok) return inst;
  try {
    // D-08: provided-scope globals ARE the shim — `new Function` is the design, not a footgun here.
    const factory = new Function(
      '__shim',
      `"use strict";\nconst { process, require, sleep, __loopBudget, __aw, __fnTick, Vec3, GoalNear } = __shim;\nreturn (${inst.source});`,
    ) as SkillFactory;
    return { ok: true, factory };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `compile error: ${message}` };
  }
}

function createSafeProcess(): object {
  const killer =
    (name: string) =>
    (): never => {
      throw new SkillForbiddenError(
        `process.${name}() is forbidden in skill code (D-08) — let the run end and report failure instead`,
      );
    };
  const safe: Record<string, unknown> = {};
  for (const m of DENIED_PROCESS_METHODS) safe[m] = killer(m);
  // A couple of harmless reads a skill might legitimately want; everything dangerous is absent.
  safe['platform'] = process.platform;
  safe['version'] = process.version;
  return Object.freeze(safe);
}

function createSafeRequire(safeProcess: object): (id: string) => unknown {
  return (id: string): unknown => {
    if (id === 'process' || id === 'node:process') return safeProcess;
    // Only require('process') is neutered (D-08). Other specifiers aren't resolvable in skill
    // scope anyway; returning undefined keeps the forbidden denylist frozen at four (R45).
    return undefined;
  };
}

/** The loop-budget counter, shared across a composed call tree (02 §Composition: one budget). */
export interface LoopBudget {
  __loopBudget: () => void;
  __aw: <T>(p: T) => T;
  /** CRIT-1/R75: run the progress canary WITHOUT touching the loop count — injected at function-body tops. */
  __fnTick: () => void;
}

/** Create a loop budget — `__loopBudget` ticks (throws past `max`), `__aw` resets it on every await.
 *  `checkProgress` is an OPTIONAL engine-injected SYNCHRONOUS guard run on every loop tick AND every
 *  function entry (gap W / CRIT-1). The count-reset-on-await assumption breaks when a loop `await`s an
 *  immediately-resolved promise (it resets `count` every iteration yet never drains the macrotask queue,
 *  starving every timer-based supervisor), and breaks WORSE for a runaway with no loop node at all (async
 *  recursion / `.then` trampoline) — there `__loopBudget` is never even called. `checkProgress` runs from
 *  both `__loopBudget` (loop bodies) and `__fnTick` (function bodies) — the only unstarvable paths — so the
 *  engine can abort either. `__fnTick` deliberately does NOT touch `count`: a deep but finite synchronous
 *  call tree (recursive flood-fill, build-plan walk, A*) can exceed 1e6 function entries between awaits and
 *  must not false-trip the loop budget — only genuine macrotask starvation (the time-based canary) aborts it. */
export function createLoopBudget(max: number = DEFAULT_LOOP_BUDGET, checkProgress?: () => void): LoopBudget {
  let count = 0;
  return {
    __loopBudget: (): void => {
      if (++count > max) throw new SkillStalledError(LOOP_BUDGET_MESSAGE);
      checkProgress?.();
    },
    // A real await is a yield, not a sync spin — reset the budget when one is reached. (A microtask-only
    // await still resets here, which is why `checkProgress` above is the load-bearing guard for gap W.)
    __aw: <T>(p: T): T => {
      count = 0;
      return p;
    },
    // CRIT-1/R75: function-entry canary. Runs the macrotask-starvation guard with NO count increment, so
    // it catches a non-loop runaway (recursion / microtask trampoline) without false-aborting deep recursion.
    __fnTick: (): void => {
      checkProgress?.();
    },
  };
}

/**
 * Build a fresh per-run shim: the D-08 safe globals + a loop budget. Pass `shared` so every skill in
 * a composed tree ticks ONE budget (02 §Composition); omit it for a standalone run.
 */
export function makeShim(runtime: SkillRuntime, shared?: LoopBudget): Shim {
  const budget = shared ?? createLoopBudget(runtime.loopBudget);
  const safeProcess = createSafeProcess();
  return {
    process: safeProcess,
    require: createSafeRequire(safeProcess),
    sleep: runtime.sleep,
    __loopBudget: budget.__loopBudget,
    __aw: budget.__aw,
    __fnTick: budget.__fnTick,
    Vec3: Vec3 as unknown as Shim['Vec3'],
    GoalNear: goals.GoalNear as unknown as Shim['GoalNear'],
  };
}
