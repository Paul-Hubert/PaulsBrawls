// Compile a squad command (one ESM file, docs/29 §5.1) into a factory the runtime calls once per order with that
// order's scope. Not a sandbox (O1): the point is robustness and a pleasant dialect for the model.
//   • The ESM surface is rewritten in place: `import … from 'vec3' | 'mineflayer-pathfinder' | 'squad' |
//     'minecraft-data'` becomes a lookup in the scope (an import is never needed, but both habits work); `export
//     default` / `export const` land in an exports object. Line numbers are preserved, so a stack trace points at
//     the submitted source (vm.Script filename `squad:<author>/<name>@v<N>.mjs`).
//   • Eden's one AST transform (copied): a loop-budget call at the top of every loop body (a synchronous
//     `while (true) {}` would freeze every bot's physics) and every `await E` wrapped as
//     `__awr(await __aw((__fence(), E)))`: the budget resets on a real yield, and the fences stop a stopped order
//     before its next awaited call and as soon as an await resumes.
//   • The starvation canary (Eden's finding W): a loop that only awaits resolved promises resets the budget every
//     turn yet never lets a timer run. A heartbeat timestamp is checked from inside loops and awaits.
//   • The user code runs in an inner function, so it may declare its own `sleep` or `goTo` without clashing with
//     the scope's names.

import vm from 'node:vm';

import * as acorn from 'acorn';
import { simple as walkSimple } from 'acorn-walk';

export class CompileError extends Error {
  override name = 'CompileError';
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
  }
}

/** A script made no progress: the loop budget tripped or it starved the event loop. */
export class StalledError extends Error {
  override name = 'StalledError';
}

export const DEFAULT_LOOP_BUDGET = 1_000_000;
/** How long the event loop may go without running a timer while a script is iterating. */
export const STARVATION_MS = 3_000;

/** Modules a command may import (they resolve to the same instances as the scope globals). */
export const IMPORTABLE = ['squad', 'vec3', 'mineflayer-pathfinder', 'minecraft-data'] as const;

/** What a compiled command produces when its factory runs. */
export interface CommandExports {
  default?: unknown;
  manifest?: unknown;
  [name: string]: unknown;
}

/** Runs the module body with an order's scope; resolves to its exports. */
export type CommandFactory = (scope: Record<string, unknown>) => Promise<CommandExports>;

interface Edit {
  start: number;
  end: number;
  text: string;
  /** At the same position, lower order lands leftmost. */
  order: number;
}

type AnyNode = acorn.Node & Record<string, unknown>;

/** Parse as an ES module (2024). A syntax error carries its line and column. */
export function parseModule(source: string): acorn.Program {
  try {
    return acorn.parse(source, { ecmaVersion: 2024, sourceType: 'module', locations: true, allowAwaitOutsideFunction: true });
  } catch (e) {
    const err = e as Error & { loc?: { line: number; column: number } };
    throw new CompileError(`syntax error: ${err.message}`, err.loc?.line, err.loc?.column);
  }
}

/** Rewrite module syntax + instrument loops and awaits. The result has the same line count as the input. */
export function transform(source: string): string {
  const program = parseModule(source);
  const edits: Edit[] = [];
  const keepLines = (start: number, end: number): string => '\n'.repeat((source.slice(start, end).match(/\n/g) ?? []).length);

  for (const node of program.body as AnyNode[]) {
    switch (node.type) {
      case 'ImportDeclaration': {
        const spec = (node.source as { value: string }).value;
        if (!(IMPORTABLE as readonly string[]).includes(spec)) {
          throw new CompileError(
            `cannot import "${spec}": only ${IMPORTABLE.join(', ')} can be imported (and none is needed: every helper is a global)`,
            node.loc?.start.line,
          );
        }
        const parts: string[] = [];
        const named: string[] = [];
        for (const s of node.specifiers as AnyNode[]) {
          const local = (s.local as { name: string }).name;
          if (s.type === 'ImportDefaultSpecifier') parts.push(`const ${local} = __import(${JSON.stringify(spec)}).default;`);
          else if (s.type === 'ImportNamespaceSpecifier') parts.push(`const ${local} = __import(${JSON.stringify(spec)});`);
          else {
            const imported = s.imported as { name?: string; value?: string };
            const name = imported.name ?? imported.value ?? local;
            named.push(name === local ? local : `${JSON.stringify(name)}: ${local}`);
          }
        }
        if (named.length > 0) parts.push(`const { ${named.join(', ')} } = __import(${JSON.stringify(spec)});`);
        edits.push({ start: node.start, end: node.end, text: parts.join(' ') + keepLines(node.start, node.end), order: 0 });
        break;
      }
      case 'ExportDefaultDeclaration': {
        const decl = node.declaration as AnyNode;
        edits.push({ start: node.start, end: decl.start, text: '__exports.default = ', order: 0 });
        if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
          edits.push({ start: node.end, end: node.end, text: ';', order: 1 });
        }
        break;
      }
      case 'ExportNamedDeclaration': {
        const decl = node.declaration as AnyNode | null;
        if (node.source) throw new CompileError('re-exports (`export … from`) are not supported', node.loc?.start.line);
        if (decl) {
          edits.push({ start: node.start, end: decl.start, text: '', order: 0 });
          const names = declaredNames(decl);
          edits.push({ start: node.end, end: node.end, text: ' ' + names.map((n) => `__exports.${n} = ${n};`).join(' '), order: 1 });
        } else {
          const assigns = (node.specifiers as AnyNode[]).map((s) => {
            const local = (s.local as { name: string }).name;
            const exported = s.exported as { name?: string; value?: string };
            return `__exports[${JSON.stringify(exported.name ?? exported.value ?? local)}] = ${local};`;
          });
          edits.push({ start: node.start, end: node.end, text: assigns.join(' ') + keepLines(node.start, node.end), order: 0 });
        }
        break;
      }
      case 'ExportAllDeclaration':
        throw new CompileError('`export * from` is not supported', node.loc?.start.line);
      default:
        break;
    }
  }

  const injectLoopBody = (node: unknown): void => {
    const body = (node as { body: AnyNode }).body;
    if (body.type === 'BlockStatement') {
      edits.push({ start: body.start + 1, end: body.start + 1, text: '__loopBudget();', order: 0 });
    } else {
      edits.push({ start: body.start, end: body.start, text: '{__loopBudget();', order: 0 });
      edits.push({ start: body.end, end: body.end, text: '}', order: 1 });
    }
  };
  walkSimple(program, {
    WhileStatement: injectLoopBody,
    DoWhileStatement: injectLoopBody,
    ForStatement: injectLoopBody,
    ForInStatement: injectLoopBody,
    ForOfStatement: injectLoopBody,
    AwaitExpression: (node: unknown): void => {
      const n = node as AnyNode;
      const arg = n.argument as AnyNode;
      edits.push({ start: n.start, end: n.start, text: '__awr(', order: 0 });
      edits.push({ start: arg.start, end: arg.start, text: '__aw((__fence(), ', order: 0 });
      edits.push({ start: arg.end, end: arg.end, text: '))', order: 1 });
      edits.push({ start: n.end, end: n.end, text: ')', order: 1 });
    },
  });

  // Right to left; at one position, closing text (higher order) is applied first so opening text lands left.
  edits.sort((a, b) => b.start - a.start || b.order - a.order);
  let out = source;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function declaredNames(decl: AnyNode): string[] {
  if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') return [(decl.id as { name: string }).name];
  if (decl.type === 'VariableDeclaration') {
    const out: string[] = [];
    for (const d of decl.declarations as AnyNode[]) {
      const id = d.id as AnyNode;
      if (id.type !== 'Identifier') throw new CompileError('export a plain name (`export const manifest = …`), not a destructuring pattern', decl.loc?.start.line);
      out.push((id as unknown as { name: string }).name);
    }
    return out;
  }
  throw new CompileError(`unsupported export: ${decl.type}`, decl.loc?.start.line);
}

/**
 * The scope names the wrapper hands in. Kept in one list so the wrapper, the runtime scope builder and the
 * typecheck's globals stay in step (tests compare them).
 */
export const SCOPE_NAMES = [
  // instrumentation
  '__loopBudget', '__aw', '__fence', '__awr', '__import',
  // values and classes
  'Vec3', 'goals', 'Movements', 'BotLeftError', 'OrderStoppedError', 'console', 'require',
  // tracked timers
  'sleep', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  // helpers (Voyager names first)
  'mineBlock', 'craftItem', 'smeltItem', 'placeItem', 'killMob', 'exploreUntil', 'getItemFromChest',
  'depositItemIntoChest', 'checkItemInsideChest', 'goTo', 'follow', 'attack', 'shoot', 'equip', 'eat',
  'pickupDrops', 'findBlock', 'nearestEntity', 'nearestHostile', 'isFriend', 'blockKey',
] as const;

/** Compile a command's source once per version. `filename` shows in stack traces. */
export function compile(source: string, filename: string): CommandFactory {
  const body = transform(source);
  // Line 1 carries the whole prelude, so line N of the submitted source is line N of the script.
  const wrapped =
    `(function (__scope) { const { ${SCOPE_NAMES.join(', ')} } = __scope; ` +
    `return (async function () { const __exports = {}; ${body}\n;return __exports; })(); })`;
  let fn: unknown;
  try {
    fn = new vm.Script(wrapped, { filename }).runInThisContext();
  } catch (e) {
    const err = e as Error;
    throw new CompileError(`compile error: ${err.message}`, lineOf(err, filename));
  }
  return fn as CommandFactory;
}

/** The line of the first stack frame in `filename`, if any. */
export function lineOf(err: unknown, filename: string): number | undefined {
  const stack = err instanceof Error ? err.stack ?? '' : '';
  const i = stack.indexOf(filename + ':');
  if (i < 0) return undefined;
  const m = /^:(\d+)/.exec(stack.slice(i + filename.length));
  return m ? Number(m[1]) : undefined;
}

// -- the loop budget and the starvation canary ----------------------------------------------------------------

let lastTick = Date.now();
let heartbeat: ReturnType<typeof setInterval> | undefined;

function ensureHeartbeat(): void {
  if (heartbeat) return;
  lastTick = Date.now();
  heartbeat = setInterval(() => {
    lastTick = Date.now();
  }, 100);
  heartbeat.unref();
}

export interface LoopBudget {
  __loopBudget: () => void;
  __aw: <T>(p: T) => T;
  __fence: () => void;
  __awr: <T>(v: T) => T;
}

/**
 * One budget per order (every async chain of the order shares it: a synchronous spin is one chain anyway).
 * `fence` throws when the order is stopped.
 */
export function createLoopBudget(fence: () => void, max = DEFAULT_LOOP_BUDGET): LoopBudget {
  ensureHeartbeat();
  let count = 0;
  let ticks = 0;
  const canary = (): void => {
    if ((++ticks & 255) !== 0) return;
    const quiet = Date.now() - lastTick;
    if (quiet > STARVATION_MS) {
      throw new StalledError(
        `the script kept the event loop busy for ${Math.round(quiet / 1000)} s without letting any timer run ` +
          '(a loop that only awaits already-resolved promises, or a very long computation); every bot froze meanwhile',
      );
    }
  };
  return {
    __loopBudget: (): void => {
      if (++count > max) throw new StalledError(`loop budget: ${max} loop iterations without a single await (an endless synchronous loop?)`);
      canary();
    },
    __aw: <T>(p: T): T => {
      fence();
      canary();
      count = 0;
      return p;
    },
    __fence: (): void => fence(),
    __awr: <T>(v: T): T => {
      fence();
      return v;
    },
  };
}
