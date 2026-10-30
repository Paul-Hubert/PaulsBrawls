// check_script (docs/29 §8.3): everything that can be known about a command before it runs.
//   1. parse + compile (syntax, the ESM surface, import whitelist), size cap;
//   2. run the module body with a dry scope and validate the `manifest` export (and that a default function exists);
//   3. typecheck with TypeScript's checkJs against reference/squad.d.ts + mineflayer's own types. The default export
//      and the manifest get a JSDoc type in a copy of the source (same lines), so `squad`, `args`, `ctx` and every
//      `bot` are typed. A misspelt mineflayer method (`bot.digBlock`) or an unknown name is caught here, before the
//      live run that used to find it ("bot.X is not a function").
// Only a definite mistake blocks a submission (unknown name or property, wrong argument count, syntax); every
// other diagnostic is a warning the author reads (mineflayer's types are not perfect).

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Worker } from 'node:worker_threads';
import type * as acorn from 'acorn';

import { compile, CompileError, parseModule, SCOPE_NAMES } from './compile';
import { validateManifest, type Manifest } from './manifest';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SQUAD_ROOT = resolve(HERE, '..', '..');
export const REFERENCE_FILE = join(SQUAD_ROOT, 'reference', 'squad.d.ts');

export interface Diagnostic {
  severity: 'error' | 'warning';
  line?: number;
  column?: number;
  code?: number;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  manifest?: Manifest;
  diagnostics: Diagnostic[];
}

/** TypeScript codes that are a definite mistake in a command (everything else is advisory). */
export const BLOCKING_CODES = new Set([
  2304, // Cannot find name 'x'.
  2552, // Cannot find name 'x'. Did you mean 'y'?
  2339, // Property 'x' does not exist on type 'Y'.
  2551, // Property 'x' does not exist on type 'Y'. Did you mean 'z'?
  2554, // Expected N arguments, but got M.
  2555, // Expected at least N arguments, but got M.
  2349, // This expression is not callable.
  2351, // This expression is not constructable.
]);

export function referenceText(): string {
  return readFileSync(REFERENCE_FILE, 'utf8');
}

/** Run every check. `maxLines` caps the source (Eden's maxSkillLines). */
export async function checkScript(source: string, opts: { maxLines?: number; typecheck?: boolean } = {}): Promise<CheckResult> {
  const diagnostics: Diagnostic[] = [];
  const lines = source.split('\n').length;
  if (opts.maxLines && lines > opts.maxLines) {
    diagnostics.push({ severity: 'error', message: `the command is ${lines} lines; the limit is ${opts.maxLines}. Compose smaller commands with ctx.run.` });
  }
  let program: acorn.Program;
  let factory;
  try {
    program = parseModule(source);
    factory = compile(source, 'squad:check/draft.mjs');
  } catch (e) {
    const err = e as CompileError;
    diagnostics.push({ severity: 'error', message: err.message, ...(err.line ? { line: err.line } : {}), ...(err.column !== undefined ? { column: err.column } : {}) });
    return { ok: false, diagnostics };
  }

  // The module body runs with an inert scope: top-level code should only declare things.
  let manifest: Manifest | undefined;
  try {
    const exports = await withTimeout(factory(dryScope()), 2_000, 'the module top level did not finish within 2 s (do the work inside the default function)');
    manifest = validateManifest(exports.manifest);
    if (typeof exports.default !== 'function') {
      diagnostics.push({ severity: 'error', message: 'missing `export default async function (squad, args, ctx) { … }`' });
    }
  } catch (e) {
    diagnostics.push({ severity: 'error', message: (e as Error).message });
  }

  if (opts.typecheck !== false) diagnostics.push(...(await typecheck(source, program)));
  const ok = !diagnostics.some((d) => d.severity === 'error');
  return { ok, ...(manifest ? { manifest } : {}), diagnostics };
}

function dryScope(): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  const inert = (name: string) => () => {
    throw new Error(`${name}() was called at the module top level; call it inside the default function`);
  };
  for (const n of SCOPE_NAMES) scope[n] = inert(n);
  scope.__loopBudget = () => undefined;
  scope.__aw = <T>(p: T) => p;
  scope.__fence = () => undefined;
  scope.__awr = <T>(v: T) => v;
  scope.__import = () => new Proxy({}, { get: () => undefined });
  scope.require = scope.__import;
  scope.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  for (const n of ['Vec3', 'goals', 'Movements', 'BotLeftError', 'OrderStoppedError']) scope[n] = class {};
  return scope;
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error(message)), ms)))]);
  } finally {
    if (t) clearTimeout(t);
  }
}

// -- the typecheck (in a worker thread: see typecheck-worker.mjs) ------------------------------------------------

/** Insert JSDoc types on the default export and the manifest (same line count). */
export function typedCopy(source: string, program: acorn.Program): string {
  type N = acorn.Node & Record<string, unknown>;
  const edits: Array<{ at: number; text: string }> = [];
  for (const node of program.body as N[]) {
    if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration as N;
      if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(d.type)) {
        edits.push({ at: d.start, text: '/** @type {SquadCommand} */ (' }, { at: d.end, text: ')' });
      }
    }
    if (node.type === 'ExportNamedDeclaration' && (node.declaration as N | null)?.type === 'VariableDeclaration') {
      for (const decl of (node.declaration as N).declarations as N[]) {
        const id = decl.id as N & { name?: string };
        const init = decl.init as N | null;
        if (id.name === 'manifest' && init) edits.push({ at: init.start, text: '/** @satisfies {SquadManifest} */ (' }, { at: init.end, text: ')' });
      }
    }
  }
  edits.sort((a, b) => b.at - a.at);
  let out = source;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}

interface RawDiagnostic {
  code: number;
  error: boolean;
  message: string;
  line?: number;
  column?: number;
}

const TYPECHECK_TIMEOUT_MS = 60_000;
let worker: Worker | undefined;
let seq = 0;
const waiting = new Map<number, { resolve: (d: RawDiagnostic[]) => void; reject: (e: Error) => void }>();

function typecheckWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./typecheck-worker.mjs', import.meta.url), { workerData: { root: SQUAD_ROOT, reference: REFERENCE_FILE } });
  w.unref(); // an idle checker never keeps the process alive
  w.on('message', (m: { id: number; diagnostics?: RawDiagnostic[]; error?: string }) => {
    const p = waiting.get(m.id);
    if (!p) return;
    waiting.delete(m.id);
    if (waiting.size === 0) w.unref();
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.diagnostics ?? []);
  });
  const fail = (e: Error): void => {
    if (worker === w) worker = undefined;
    for (const p of waiting.values()) p.reject(e);
    waiting.clear();
  };
  w.on('error', fail);
  w.on('exit', (code) => fail(new Error(`typecheck worker exited (${code})`)));
  worker = w;
  return w;
}

export async function typecheck(source: string, program: acorn.Program): Promise<Diagnostic[]> {
  const text = typedCopy(source, program);
  let raw: RawDiagnostic[];
  try {
    raw = await new Promise<RawDiagnostic[]>((resolve, reject) => {
      const w = typecheckWorker();
      const id = ++seq;
      const t = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('typecheck timed out'));
      }, TYPECHECK_TIMEOUT_MS);
      waiting.set(id, {
        resolve: (d) => {
          clearTimeout(t);
          resolve(d);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      w.ref(); // while a check is pending
      w.postMessage({ id, text });
    });
  } catch (e) {
    return [{ severity: 'warning', message: `typecheck unavailable: ${(e as Error).message.split('\n')[0]}` }];
  }
  return raw.map((d) => ({
    severity: d.error && (BLOCKING_CODES.has(d.code) || d.code < 2000) ? 'error' : 'warning',
    code: d.code,
    message: `TS${d.code}: ${d.message}`,
    ...(d.line ? { line: d.line } : {}),
    ...(d.column ? { column: d.column } : {}),
  }));
}

/** Stop the checker (tests, shutdown). */
export async function stopTypecheck(): Promise<void> {
  const w = worker;
  worker = undefined;
  if (w) await w.terminate();
}

/** Diagnostics as the author agent reads them. */
export function formatDiagnostics(r: CheckResult): string {
  if (r.diagnostics.length === 0) return 'OK: no problems found.';
  const rows = r.diagnostics.map((d) => `${d.severity.toUpperCase()}${d.line ? ` line ${d.line}${d.column ? `:${d.column}` : ''}` : ''}: ${d.message}`);
  return `${r.ok ? 'OK (warnings only)' : 'NOT OK'}: ${r.diagnostics.filter((d) => d.severity === 'error').length} error(s), ${r.diagnostics.filter((d) => d.severity === 'warning').length} warning(s)\n${rows.join('\n')}`;
}
