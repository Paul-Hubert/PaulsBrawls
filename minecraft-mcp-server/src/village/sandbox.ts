import * as acorn from 'acorn';
import { fullAncestor } from 'acorn-walk';
import { generate } from 'astring';

/**
 * The villager-script sandbox, v1 (VILLAGE_PLAN §D4).
 *
 * Threat model: ACCIDENTS, not malice — the code author is our own LLM on a
 * private server. The two failure classes that matter and their mitigations:
 *
 *  - infinite loops freezing the (shared) event loop → an AST pass injects a
 *    `__budget()` cycle check into every loop body; the engine resets the
 *    counter per invocation and the check throws past the limit;
 *  - reaching host facilities (fs, net, process) → script-mode parse (no
 *    imports), a banned-identifier scan, and `new Function` compilation whose
 *    parameter list shadows nothing dangerous. This is NOT a security
 *    boundary; if that's ever needed, swap this module for a QuickJS host —
 *    the VillagerAPI surface is the portability seam.
 */

const BANNED_IDENTIFIERS = new Set([
  'require', 'process', 'globalThis', 'eval', 'Function',
  'fetch', 'XMLHttpRequest', 'WebSocket',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
  'Buffer', 'module', 'exports', '__dirname', '__filename',
]);

export const DEFAULT_LOOP_BUDGET = 100_000;
export const DEFAULT_INVOCATION_TIMEOUT_MS = 20_000;

export class CycleBudget {
  private count = 0;
  constructor(private readonly limit: number = DEFAULT_LOOP_BUDGET) {}

  tick = (): void => {
    if (++this.count > this.limit) {
      throw new Error(`script exceeded loop budget (${this.limit} iterations) — likely an infinite loop`);
    }
  };

  reset(): void {
    this.count = 0;
  }
}

interface AstNode {
  type: string;
  name?: string;
  body?: AstNode | AstNode[];
  [key: string]: unknown;
}

function budgetCallStatement(): AstNode {
  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: '__budget' },
      arguments: [],
      optional: false,
    },
  };
}

/**
 * Parse, validate, and instrument a villager script.
 * Returns the instrumented source, or a list of human-readable errors.
 */
export function prepareScript(code: string): { ok: true; instrumented: string } | { ok: false; errors: string[] } {
  let ast: acorn.Program;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      locations: true,
    });
  } catch (err) {
    return { ok: false, errors: [`parse error: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const errors: string[] = [];
  const loops: AstNode[] = [];

  fullAncestor(ast, (node, _state, ancestors) => {
    const n = node as unknown as AstNode;
    if (n.type === 'Identifier' && n.name && BANNED_IDENTIFIERS.has(n.name)) {
      // Allow `obj.process`-style member *properties*; ban free identifiers and
      // member *objects* (`process.exit`). The parent decides which this is.
      const parent = ancestors[ancestors.length - 2] as unknown as AstNode | undefined;
      const isPropertyPosition =
        parent !== undefined &&
        ((parent.type === 'MemberExpression' && parent.property === node && parent.computed !== true) ||
         (parent.type === 'Property' && parent.key === node && parent.computed !== true));
      if (!isPropertyPosition) {
        const loc = (node as { loc?: { start?: { line?: number } } }).loc;
        errors.push(`forbidden identifier '${n.name}'${loc?.start?.line ? ` (line ${loc.start.line})` : ''}`);
      }
    }
    if (n.type === 'ImportExpression' || n.type === 'ImportDeclaration') {
      errors.push('imports are not allowed in villager scripts');
    }
    if (
      n.type === 'WhileStatement' || n.type === 'DoWhileStatement' ||
      n.type === 'ForStatement' || n.type === 'ForInStatement' || n.type === 'ForOfStatement'
    ) {
      loops.push(n);
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors: Array.from(new Set(errors)) };
  }

  // Inject `__budget();` as the first statement of every loop body.
  for (const loop of loops) {
    const body = loop.body as AstNode;
    if (body.type === 'BlockStatement') {
      (body.body as AstNode[]).unshift(budgetCallStatement());
    } else {
      loop.body = { type: 'BlockStatement', body: [budgetCallStatement(), body] };
    }
  }

  let instrumented: string;
  try {
    instrumented = generate(ast as unknown as Parameters<typeof generate>[0]);
  } catch (err) {
    return { ok: false, errors: [`instrumentation failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return { ok: true, instrumented };
}

export interface ScriptGlobals {
  bot: unknown;
  sleep: (ms: number) => Promise<void>;
  console: { log: (...args: unknown[]) => void };
}

export type CompiledScript = (globals: ScriptGlobals, budget: CycleBudget) => Promise<void>;

/**
 * Compile an instrumented script into a callable. The Function parameter list
 * shadows the API names so scripts resolve them to our implementations, not
 * any ambient global.
 */
export function compileScript(instrumented: string): CompiledScript {
  const factory = new Function(
    'bot', 'sleep', 'console', '__budget',
    `'use strict';\nreturn (async () => {\n${instrumented}\n})();`
  ) as (bot: unknown, sleep: ScriptGlobals['sleep'], console: ScriptGlobals['console'], budget: () => void) => Promise<void>;

  return (globals, budget) => factory(globals.bot, globals.sleep, globals.console, budget.tick);
}

/**
 * Errors caused by DELIBERATE preemption — another reflex calling
 * stopMoving() to free the action chain (the anti-priority-inversion
 * mechanism), or a routine being cancelled. These must not strike the skill
 * that was interrupted; it did nothing wrong.
 */
export function isBenignPreemption(message: string): boolean {
  return /path was stopped|goal was changed|routine cancelled/i.test(message);
}

/** Wall-clock guard around one script/handler invocation. */
export async function runWithTimeout(run: () => Promise<void>, timeoutMs = DEFAULT_INVOCATION_TIMEOUT_MS, label = 'script'): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
