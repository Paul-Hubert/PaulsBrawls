import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compile, CompileError, createLoopBudget, SCOPE_NAMES, StalledError, transform } from '../src/script/compile';

function scope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  for (const n of SCOPE_NAMES) s[n] = undefined;
  Object.assign(s, createLoopBudget(() => undefined, 1000));
  s.__import = (spec: string) => ({ vec3: { Vec3: 'V', default: 'v3' }, squad: { goTo: 'g' } } as Record<string, unknown>)[spec];
  return Object.assign(s, extra);
}

test('transform keeps the line count and rewrites the ESM surface', () => {
  const src = [
    "import { Vec3 } from 'vec3';",
    'export const manifest = { summary: "x" };',
    'export default async function (squad, args, ctx) {',
    '  while (true) { await squad.sleep(1); break; }',
    '}',
  ].join('\n');
  const out = transform(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.match(out, /const \{ Vec3 \} = __import\("vec3"\);/);
  assert.match(out, /__exports\.manifest = manifest;/);
  assert.match(out, /__exports\.default = async function/);
  assert.match(out, /while \(true\) \{__loopBudget\(\);/);
  assert.match(out, /__awr\(await __aw\(\(__fence\(\), squad\.sleep\(1\)\)\)\)/);
});

test('a compiled module exports its manifest and default function', async () => {
  const f = compile(
    "import vec, { Vec3 } from 'vec3';\nexport const manifest = { summary: 'ok' };\nexport default async function run() { return Vec3 + vec; }",
    'squad:t/a@v1.mjs',
  );
  const ex = await f(scope());
  assert.deepEqual(ex.manifest, { summary: 'ok' });
  assert.equal(await (ex.default as () => Promise<string>)(), 'Vv3');
});

test('user code may declare names that the scope also provides', async () => {
  const f = compile('const sleep = () => 42;\nfunction goTo() { return 1; }\nexport default () => sleep() + goTo();', 'squad:t/b@v1.mjs');
  const ex = await f(scope({ sleep: () => 0 }));
  assert.equal((ex.default as () => number)(), 43);
});

test('importing anything else is a compile error naming the allowed modules', () => {
  assert.throws(() => transform("import fs from 'fs';"), (e: unknown) => e instanceof CompileError && /only squad, vec3/.test(e.message));
});

test('a syntax error carries its line', () => {
  assert.throws(() => compile('export default function () {\n  let x = ;\n}', 'squad:t/c@v1.mjs'), (e: unknown) => e instanceof CompileError && e.line === 2);
});

test('runtime errors point at the submitted line', async () => {
  const f = compile('export const manifest = {};\n\nexport default function () {\n  null.boom();\n}', 'squad:t/d@v1.mjs');
  const ex = await f(scope());
  try {
    (ex.default as () => void)();
    assert.fail('should throw');
  } catch (e) {
    assert.match((e as Error).stack ?? '', /squad:t\/d@v1\.mjs:4:/);
  }
});

test('the loop budget stops an endless synchronous loop', async () => {
  const f = compile('export default function () { let i = 0; while (true) { i++; } }', 'squad:t/e@v1.mjs');
  const ex = await f(scope());
  assert.throws(() => (ex.default as () => void)(), StalledError);
});

test('an await resets the budget, and the fence stops a stopped order at its next await', async () => {
  let stopped = false;
  const s = scope();
  Object.assign(s, createLoopBudget(() => {
    if (stopped) throw new Error('stopped!');
  }, 5));
  const f = compile('export default async function () { for (let i = 0; i < 20; i++) { await null; } return "done"; }', 'squad:t/f@v1.mjs');
  const ex = await f(s);
  assert.equal(await (ex.default as () => Promise<string>)(), 'done');
  stopped = true;
  await assert.rejects((ex.default as () => Promise<string>)(), /stopped!/);
});

test('export { a as b } and export function', async () => {
  const f = compile('const a = 1;\nexport { a as b };\nexport function c() { return 2; }', 'squad:t/g@v1.mjs');
  const ex = await f(scope());
  assert.equal(ex.b, 1);
  assert.equal((ex.c as () => number)(), 2);
});
