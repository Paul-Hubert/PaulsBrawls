// The ONE AST transform Eden keeps (owner #5, D-08). NOT a sandbox, NOT a typecheck:
//   1. parse with acorn (ecmaVersion 2022) — syntax errors return inline to the author (write_skill);
//   2. inject a loop-budget call into every loop body — the only in-process answer to a SYNCHRONOUS
//      `while(true){}` that would freeze the whole host (D-01); reset on every real `await`;
//   3. install the D-08 syscall shim as PROVIDED SCOPE GLOBALS (not a banned-identifier scan):
//      `process`/`require('process')` are shadowed by a safe object whose four host-killers throw
//      SkillForbiddenError. The denylist is FROZEN at four (R45) — determined escapes
//      (globalThis.process, the Function ctor) remain reachable BY DESIGN; the only security
//      boundary is the tier gate (R25), not this.
//
// Layer 2 (skills/): imports only types/journal-free deps + acorn. The engine (engine.ts) compiles
// once per version and calls the factory per run with a fresh shim.

import * as acorn from 'acorn';
import { simple as walkSimple } from 'acorn-walk';

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

/** Result of {@link parse} — never throws; a syntax error returns inline for write_skill feedback. */
export type ParseResult = { ok: true; program: acorn.Program } | { ok: false; error: string };

/** Parse skill source (ecmaVersion 2022). Full power — no banned identifiers, no import scan (P3). */
export function parse(code: string): ParseResult {
  try {
    const program = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
    return { ok: true, program };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `parse error: ${message}` };
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
 * Inject `__loopBudget()` at the top of every loop body and wrap every `await EXPR` as
 * `await __aw(EXPR)` (the await resets the budget — a real yield is not a sync spin). String-splice
 * by AST offsets, applied right-to-left so earlier offsets stay valid.
 */
export function instrument(code: string): InstrumentResult {
  const parsed = parse(code);
  if (!parsed.ok) return parsed;

  const edits: Edit[] = [];
  const injectLoopBody = (node: unknown): void => {
    const body = (node as LoopNode).body;
    if (body.type === 'BlockStatement') {
      edits.push({ pos: body.start + 1, text: '__loopBudget();', order: 0 });
    } else {
      // Bare-statement body (`while(x) stmt;`) — brace it so the budget call is legal.
      edits.push({ pos: body.start, text: '{__loopBudget();', order: 0 });
      edits.push({ pos: body.end, text: '}', order: 1 });
    }
  };
  walkSimple(parsed.program, {
    WhileStatement: injectLoopBody,
    DoWhileStatement: injectLoopBody,
    ForStatement: injectLoopBody,
    ForInStatement: injectLoopBody,
    ForOfStatement: injectLoopBody,
    AwaitExpression: (node: unknown): void => {
      const arg = (node as AwaitNode).argument;
      edits.push({ pos: arg.start, text: '__aw(', order: 0 });
      edits.push({ pos: arg.end, text: ')', order: 1 });
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
      `"use strict";\nconst { process, require, sleep, __loopBudget, __aw } = __shim;\nreturn (${inst.source});`,
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
}

/** Create a loop budget — `__loopBudget` ticks (throws past `max`), `__aw` resets it on every await. */
export function createLoopBudget(max: number = DEFAULT_LOOP_BUDGET): LoopBudget {
  let count = 0;
  return {
    __loopBudget: (): void => {
      if (++count > max) throw new SkillStalledError(LOOP_BUDGET_MESSAGE);
    },
    // A real await is a yield, not a sync spin — reset the budget when one is reached.
    __aw: <T>(p: T): T => {
      count = 0;
      return p;
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
  };
}
