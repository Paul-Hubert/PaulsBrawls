import test from 'ava';
import { CycleBudget, compileScript, isBenignPreemption, prepareScript, runWithTimeout } from '../src/village/sandbox.js';
import { ScriptGlobals } from '../src/village/sandbox.js';

function globalsWith(bot: unknown): ScriptGlobals {
  return {
    bot,
    sleep: async () => { /* immediate in tests */ },
    console: { log: () => { /* silent */ } },
  };
}

test('rejects banned identifiers in free/object position', (t) => {
  for (const code of ['process.exit(1);', 'require("fs");', 'eval("1");', 'fetch("http://x");', 'globalThis.x = 1;']) {
    const result = prepareScript(code);
    t.false(result.ok, `should reject: ${code}`);
  }
});

test('allows banned names as member properties and object keys', (t) => {
  const result = prepareScript('const a = { process: 1, fetch: 2 }; const b = a.process + a.fetch;');
  t.true(result.ok, result.ok ? '' : result.errors.join('; '));
});

test('rejects imports', (t) => {
  t.false(prepareScript('import("fs");').ok);
});

test('loop budget halts an infinite while loop', async (t) => {
  const prepared = prepareScript('while (true) { }');
  t.true(prepared.ok);
  if (!prepared.ok) return;
  const budget = new CycleBudget(5_000);
  const run = compileScript(prepared.instrumented);
  await t.throwsAsync(() => run(globalsWith({}), budget), { message: /loop budget/ });
});

test('instruments single-statement loop bodies too', async (t) => {
  const prepared = prepareScript('let i = 0; while (true) i++;');
  t.true(prepared.ok);
  if (!prepared.ok) return;
  const budget = new CycleBudget(1_000);
  const run = compileScript(prepared.instrumented);
  await t.throwsAsync(() => run(globalsWith({}), budget), { message: /loop budget/ });
});

test('scripts can use the injected bot api and finish normally', async (t) => {
  const calls: string[] = [];
  const bot = {
    say: (msg: string) => calls.push(`say:${msg}`),
    on: (event: string) => calls.push(`on:${event}`),
  };
  const prepared = prepareScript("bot.on('hurt'); for (let i = 0; i < 3; i++) { bot.say('x' + i); }");
  t.true(prepared.ok);
  if (!prepared.ok) return;
  await compileScript(prepared.instrumented)(globalsWith(bot), new CycleBudget());
  t.deepEqual(calls, ['on:hurt', 'say:x0', 'say:x1', 'say:x2']);
});

test('benign preemption is recognized; real failures are not', (t) => {
  // The exact messages observed live when stopMoving() preempts a walk.
  t.true(isBenignPreemption('Path was stopped before it could be completed! Thus, the desired goal was not reached.'));
  t.true(isBenignPreemption('GoalChanged: The goal was changed before it could be completed!'));
  t.true(isBenignPreemption('routine cancelled'));
  t.false(isBenignPreemption('reflex self-defense timed out after 20000ms'));
  t.false(isBenignPreemption('no carrot in inventory'));
  t.false(isBenignPreemption('script exceeded loop budget (100000 iterations)'));
});

test('runWithTimeout rejects slow handlers', async (t) => {
  await t.throwsAsync(
    () => runWithTimeout(() => new Promise<void>(() => { /* never resolves */ }), 50, 'test handler'),
    { message: /timed out/ }
  );
});

test('budget resets allow long-lived cooperative loops', async (t) => {
  const budget = new CycleBudget(100);
  const prepared = prepareScript('for (let i = 0; i < 500; i++) { await sleep(0); }');
  t.true(prepared.ok);
  if (!prepared.ok) return;
  const globals: ScriptGlobals = {
    bot: {},
    sleep: async () => { budget.reset(); }, // mirrors the real api's refund-on-sleep
    console: { log: () => {} },
  };
  await t.notThrowsAsync(() => compileScript(prepared.instrumented)(globals, budget));
});
