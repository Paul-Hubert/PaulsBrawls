import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parse,
  instrument,
  compile,
  makeShim,
  createLoopBudget,
  SkillForbiddenError,
  SkillStalledError,
  DENIED_PROCESS_METHODS,
  LOOP_BUDGET_MESSAGE,
} from '../src/skills/instrument';

const noopRuntime = { sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)) };

// Compile + invoke a skill body in one go (the engine does this around RunReport; here we
// drive the raw mechanism so D-08 / loop-budget are testable at the instrument layer).
async function run(
  code: string,
  args: object = {},
  runtime: { sleep: (ms: number) => Promise<void>; loopBudget?: number } = noopRuntime,
): Promise<unknown> {
  const c = compile(code);
  assert.ok(c.ok, c.ok ? '' : `compile failed: ${c.error}`);
  const fn = c.factory(makeShim(runtime));
  return fn({}, args, {});
}

test('parse returns syntax errors inline, never throws (02 §Validation)', () => {
  const ok = parse('async function f(bot, a, c) { return 1; }');
  assert.equal(ok.ok, true);
  const bad = parse('async function f(bot, a, c) { return ; ) }');
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /parse error/i);
});

test('compile exposes Vec3 + GoalNear as authored-scope globals (the universal mineflayer idiom)', async () => {
  // `new Vec3(...)` is what an LLM writes; before this it ReferenceError'd (only ctx.Vec3 existed).
  const v = await run('async function f(bot, a, ctx) { const p = new Vec3(1, 2, 3); return { x: p.x, y: p.y, z: p.z }; }');
  assert.deepEqual(v, { x: 1, y: 2, z: 3 });
  const g = await run('async function f(bot, a, ctx) { return new GoalNear(4, 5, 6, 1) != null; }');
  assert.equal(g, true);
});

test('instrument injects a loop-budget call into every loop body', () => {
  const out = instrument('async function f(b, a, c) { while (a.go) { b.dig(); } }');
  assert.ok(out.ok);
  assert.match(out.source, /__loopBudget\(\)/);
});

test('instrument wraps non-block loop bodies too (while(x) stmt)', () => {
  const out = instrument('async function f(b, a, c) { for (;;) b.tick(); }');
  assert.ok(out.ok);
  // Body was a bare ExpressionStatement; it must be braced AND budgeted.
  assert.match(out.source, /\{__loopBudget\(\);b\.tick\(\);\}/);
});

test('CRIT-1/R75: instrument injects a function-entry canary (__fnTick) at every function body', () => {
  // A non-loop runaway (async recursion / .then trampoline) has NO loop node — the function-body canary
  // is the only synchronous guard it hits. Named decl, expression-bodied arrow, and .then callbacks must
  // all get one, and the whole thing must still compile (the comma-wrap can't produce invalid syntax).
  const decl = instrument('async function f(b, a, c) { function rec(n) { return rec(n + 1); } return rec(0); }');
  assert.ok(decl.ok);
  assert.match(decl.ok ? decl.source : '', /function rec\(n\) \{__fnTick\(\);/);
  // expression-bodied arrow → comma-operator wrap, value preserved (no `return`, safe for object literals).
  const arrow = instrument('async function f(b, a, c) { return [1].map((x) => x + 1); }');
  assert.match(arrow.ok ? arrow.source : '', /\(__fnTick\(\),x \+ 1\)/);
  // a .then callback IS a function node → instrumented (this is what closes the microtask-trampoline vector).
  const thenCb = instrument('async function f(b, a, c) { return Promise.resolve().then((v) => v); }');
  assert.match(thenCb.ok ? thenCb.source : '', /then\(\(v\) => \(__fnTick\(\),v\)\)/);
  assert.ok(compile('async function f(b, a, c) { const g = () => ({ ok: true }); return g(); }').ok, 'object-literal arrow still compiles');
});

test('CRIT-1/R75: __fnTick runs the progress guard WITHOUT touching the loop count (no false-abort of deep recursion)', () => {
  let ticks = 0;
  const budget = createLoopBudget(3, () => {
    ticks++;
  });
  // 1000 function-entry ticks: the guard runs each time, but the COUNT is untouched (else this would
  // throw 'loop budget' past 3) — a deep but finite call tree can never false-trip the 1e6 loop budget.
  for (let i = 0; i < 1000; i++) budget.__fnTick();
  assert.equal(ticks, 1000, 'the guard ran on every function entry');
  // the loop count is still pristine: __loopBudget ticks 1,2,3 (ok), the 4th (>3) throws.
  budget.__loopBudget();
  budget.__loopBudget();
  budget.__loopBudget();
  assert.throws(() => budget.__loopBudget(), (e: unknown) => e instanceof SkillStalledError);
});

// ── D-08: the syscall shim (the deliverable test) ────────────────────────────
test('D-08: process.exit(0) throws SkillForbiddenError and the host stays alive', async () => {
  await assert.rejects(
    run('async function f(bot, a, c) { process.exit(0); return 1; }'),
    (e: unknown) => e instanceof SkillForbiddenError && /process\.exit/.test((e as Error).message),
  );
  // If the shim had not shadowed process, the test runner would already be dead — reaching
  // here is the "host process stays alive" half of D-08.
  assert.ok(true);
});

test('D-08: all four host-killers throw, and the denylist is frozen at exactly four (R45)', async () => {
  for (const m of DENIED_PROCESS_METHODS) {
    await assert.rejects(
      run(`async function f(bot, a, c) { process.${m}(); }`),
      (e: unknown) => e instanceof SkillForbiddenError,
      `process.${m} must be neutered`,
    );
  }
  assert.equal(DENIED_PROCESS_METHODS.length, 4, 'the shim is footgun removal, not a sandbox — never grow it (R45)');
  assert.deepEqual([...DENIED_PROCESS_METHODS], ['exit', 'reallyExit', 'abort', 'kill']);
  assert.throws(() => {
    (DENIED_PROCESS_METHODS as unknown as string[]).push('chdir');
  }, 'denylist is frozen');
});

test('require("process") is also neutered (D-08), other specifiers are inert', async () => {
  await assert.rejects(
    run('async function f(bot, a, c) { const p = require("process"); p.exit(0); }'),
    (e: unknown) => e instanceof SkillForbiddenError,
  );
});

// ── D-10 (i) at the instrument layer: synchronous while(true) is the loop budget's job ──
test('D-10(i): a synchronous while(true) is caught by the loop budget, not a timer', async () => {
  await assert.rejects(
    run('async function f(bot, a, c) { while (true) {} }', {}, { ...noopRuntime, loopBudget: 1000 }),
    (e: unknown) => e instanceof SkillStalledError && (e as Error).message === LOOP_BUDGET_MESSAGE,
  );
});

test('the loop budget resets on every real await — an all-sleep spin never trips it', async () => {
  // sleep is called each iteration; after 10 it throws 'stop'. With loopBudget=5 and a working
  // reset-on-await, the budget never reaches 5 (each await zeroes it), so 'stop' wins over
  // 'loop budget' — proving the reset (else this spin is the futility case bounded by wall-clock).
  let calls = 0;
  const sleep = (): Promise<void> => {
    if (++calls > 10) throw new Error('stop');
    return Promise.resolve();
  };
  await assert.rejects(
    run('async function f(bot, a, c) { while (true) { await sleep(0); } }', {}, { sleep, loopBudget: 5 }),
    (e: unknown) => (e as Error).message === 'stop',
  );
});

test('gap W: the loop budget runs the engine-injected synchronous progress guard on every tick', () => {
  // The seam the engine uses to defeat macrotask starvation (gap W): `checkProgress` runs inside
  // `__loopBudget` each tick and may throw to abort. The reset-on-await above can zero `count` forever,
  // so this injected guard is the ONLY thing that can stop an await-of-a-microtask loop.
  let ticks = 0;
  const budget = createLoopBudget(1_000_000, () => {
    if (++ticks >= 3) throw new SkillStalledError('macrotask starvation');
  });
  budget.__loopBudget();
  budget.__loopBudget();
  assert.equal(ticks, 2, 'the guard ran on every tick');
  assert.throws(() => budget.__loopBudget(), (e: unknown) => e instanceof SkillStalledError, 'a throwing guard aborts the loop');
  // An await still resets the iteration counter — the guard, not the counter, is what stops a microtask spin.
  assert.equal(budget.__aw(7), 7, '__aw passes the awaited value through');
});

test('a clean skill returns its structured value through the shim', async () => {
  const value = await run('async function f(bot, a, c) { let n = 0; for (let i = 0; i < a.times; i++) n++; return { n }; }', {
    times: 3,
  });
  assert.deepEqual(value, { n: 3 });
});

test('compile surfaces parse errors as inline feedback (write_skill retry path)', () => {
  const c = compile('async function f(bot, a, c) { this is not js }');
  assert.equal(c.ok, false);
  assert.match(c.ok ? '' : c.error, /parse error|compile error/i);
});

// ── P1: the parser accepts a named function, an arrow, AND an anonymous function expression ──
// The model followed the (old) doc's anonymous shape and failed 8/8 — robustness: a valid-but-unnamed
// function must not be punished. The wrapped-expression fallback shifts node offsets, so each of these
// must still produce CORRECTLY-instrumented, runnable code (the offset bookkeeping is the hazard).
test('P1: named, arrow, and anonymous function bodies all compile()', () => {
  const named = compile('async function nom(bot, a, c) { return a.n + 1; }');
  const arrow = compile('async (bot, a, c) => { return a.n + 1; }');
  const anon = compile('async function(bot, a, c) { return a.n + 1; }');
  assert.ok(named.ok, named.ok ? '' : `named failed: ${named.error}`);
  assert.ok(arrow.ok, arrow.ok ? '' : `arrow failed: ${arrow.error}`);
  assert.ok(anon.ok, anon.ok ? '' : `anonymous failed: ${anon.error}`);
});

test('P1: an anonymous function body runs and returns its structured value (offset bookkeeping)', async () => {
  const value = await run('async function(bot, a, c) { let n = 0; for (let i = 0; i < a.times; i++) n++; return { n }; }', {
    times: 4,
  });
  assert.deepEqual(value, { n: 4 });
});

test('P1: an arrow body runs and returns its structured value (offset bookkeeping)', async () => {
  const value = await run('async (bot, a, c) => { let n = 0; for (let i = 0; i < a.times; i++) n++; return { n }; }', {
    times: 5,
  });
  assert.deepEqual(value, { n: 5 });
});

test('P1: the loop budget IS injected through the wrapped-expression path (anonymous while(true))', async () => {
  // If the offset were wrong, __loopBudget() would land mid-token and the body would never trip —
  // this proves the budget call landed at the right byte even after the wrapper shift.
  await assert.rejects(
    run('async function(bot, a, c) { while (true) {} }', {}, { ...noopRuntime, loopBudget: 1000 }),
    (e: unknown) => e instanceof SkillStalledError && (e as Error).message === LOOP_BUDGET_MESSAGE,
  );
});

test('P1: __aw wraps awaits correctly through the wrapped path (anonymous all-sleep spin resets budget)', async () => {
  let calls = 0;
  const sleep = (): Promise<void> => {
    if (++calls > 8) throw new Error('stop');
    return Promise.resolve();
  };
  await assert.rejects(
    run('async function(bot, a, c) { while (true) { await sleep(0); } }', {}, { sleep, loopBudget: 5 }),
    (e: unknown) => (e as Error).message === 'stop',
  );
});
