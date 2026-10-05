import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { SkillLibrary, AllGranted, type DraftInput } from '../src/skills/library';
import { seedStockSkills } from '../src/skills/exemplars/index';
import {
  SkillEngine,
  TierGateError,
  ArgValidationError,
  type RunOptions,
} from '../src/skills/engine';
import type { RunnerRef } from '../src/types/index';
import { holdEventLoopPerTest } from './fakes/keep-alive';

// R73: several tests await promises that only unref'd timers resolve — keep the loop alive per test.
holdEventLoopPerTest();

const MORTAL: RunnerRef = { name: 'Firmin', role: 'farmer', tier: 'mortal' };

interface Harness {
  engine: SkillEngine;
  library: SkillLibrary;
  journal: MemoryJournal;
  bot: FakeBot;
  tripwired: string[];
}

function harness(opts: { stallSeconds?: number; bot?: FakeBot; macrotaskStallMs?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'eden-engine-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  const bot = opts.bot ?? new FakeBot({ username: 'Firmin' });
  const tripwired: string[] = [];
  const engine = new SkillEngine({
    library,
    journal,
    grants: new AllGranted(),
    resolveBot: () => bot,
    runDefaultTimeoutMs: 120_000,
    stallSeconds: opts.stallSeconds ?? 20,
    maxCallDepth: 8,
    autoQuarantineAfter: 5,
    onTripwire: (skill) => tripwired.push(skill),
    // Bug #13: keep the post-abort settle wait short here so a never-settling fake dig (D-10(iii)) still
    // reports near stallSeconds; the production default (1 s) is exercised by the dedicated test below.
    abortSettleMs: 100,
    ...(opts.macrotaskStallMs !== undefined ? { macrotaskStallMs: opts.macrotaskStallMs } : {}),
  });
  return { engine, library, journal, bot, tripwired };
}

const seed = (library: SkillLibrary, over: Partial<DraftInput> & { name: string; code: string }, status: 'active' | 'active-probation' = 'active') =>
  library.seedStock(
    {
      summary: over.name,
      params: over.params ?? { type: 'object', properties: {} },
      returns: over.returns ?? { type: 'object', properties: {} },
      author: { kind: 'stock' },
      tier: over.tier ?? 'mortal',
      ...over,
    },
    status,
  );

test('M2-3: a clean run returns its value, journals skill.run, and folds no abort', async () => {
  const h = harness();
  seed(h.library, { name: 'add', code: 'async function add(bot, a, c) { return { sum: a.x + a.y }; }', params: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } });
  const report = await h.engine.run('add', { x: 2, y: 3 }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.deepEqual(report.outcome.ok ? report.outcome.value : null, { sum: 5 });
  assert.equal(report.aborted, undefined);
  assert.equal(h.journal.query({ kinds: ['skill.run'] }).length, 1);
});

test('R25: the tier gate throws BEFORE any code runs (mortal cannot run divine)', async () => {
  const h = harness();
  seed(h.library, { name: 'fly-to', code: 'async function flyTo(bot, a, c) { return { flew: true }; }', tier: 'divine' });
  await assert.rejects(h.engine.run('fly-to', {}, MORTAL), (e: unknown) => e instanceof TierGateError);
  assert.equal(h.journal.query({ kinds: ['skill.run'] }).length, 0, 'no run journaled — it never executed');
});

test('M2-3: validateArgs rejects a bad arg at the boundary with a readable message (D-04)', async () => {
  const h = harness();
  seed(h.library, { name: 'go', code: 'async function go(bot, a, c) { return 1; }', params: { type: 'object', properties: { range: { type: 'number' } }, required: ['range'] } });
  await assert.rejects(
    h.engine.run('go', { range: 'far' }, MORTAL),
    (e: unknown) => e instanceof ArgValidationError && /range/.test((e as Error).message),
  );
});

test('M2-3: ctx.log lands as skill.log, not console (R23)', async () => {
  const h = harness();
  seed(h.library, { name: 'chatty', code: "async function chatty(bot, a, c) { c.log('working'); return 1; }" });
  const report = await h.engine.run('chatty', {}, MORTAL);
  const logs = h.journal.query({ kinds: ['skill.log'] });
  assert.equal(logs.length, 1);
  assert.equal((logs[0]!.payload as Record<string, unknown>)['message'], 'working');
  assert.equal(logs[0]!.refs.runId, report.runId);
});

// ── D-10: the stall detector (the deliverable test) ──────────────────────────
test('D-10(i): a synchronous while(true) ends as a loop-budget error, NOT a stall abort', async () => {
  const h = harness({ stallSeconds: 0.15 });
  seed(h.library, { name: 'spin', code: 'async function spin(bot, a, c) { while (true) {} }' });
  const report = await h.engine.run('spin', {}, MORTAL);
  assert.equal(report.outcome.ok, false);
  assert.match(report.outcome.ok ? '' : report.outcome.error, /loop budget/);
  assert.equal(report.aborted, undefined, 'the loop budget is not an external abort');
});

// ── Gap W: macrotask-starvation canary (live-test finding 2026-06-14) ─────────
test('gap W: a loop that only awaits an immediately-resolved promise aborts as a stall', async () => {
  const h = harness({ macrotaskStallMs: 50 });
  // `await Promise.resolve()` each iteration RESETS the loop budget (a microtask yield), so the budget
  // counter can NEVER trip — yet it never drains the macrotask queue, so wallTimer + StallDetector (both
  // timers) are starved. Only the synchronous canary guard can stop it. Without the fix this never returns
  // (the host wedges and the bots are kicked — the exact farm-wheat wedge the live suite surfaced).
  seed(h.library, { name: 'wedge', code: 'async function wedge(bot, a, c) { while (true) { await Promise.resolve(); } }' });
  const report = await h.engine.run('wedge', {}, MORTAL);
  assert.equal(report.outcome.ok, false);
  assert.equal(report.aborted, 'stalled', 'the macrotask-starvation canary aborts the run as a stall');
});

test('gap W: a loop that awaits a REAL macrotask (setTimeout) is NOT false-aborted by the canary', async () => {
  // The canary must only fire on MICROTASK starvation. A loop awaiting a real timer drains the macrotask
  // queue (the heartbeat keeps refreshing), so the canary never trips — the run ends on its own terms.
  const h = harness({ macrotaskStallMs: 50 });
  seed(h.library, {
    name: 'paced',
    code: 'async function paced(bot, a, c) { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 20)); } return { done: true }; }',
  });
  const report = await h.engine.run('paced', {}, MORTAL);
  assert.equal(report.outcome.ok, true, 'a macrotask-yielding loop is never starvation-aborted');
  assert.equal(report.aborted, undefined);
});

test('D-10(ii): pathfinder path_update pulses keep a long, stationary goTo alive (R26)', async () => {
  const bot = new FakeBot({ username: 'Firmin' });
  const h = harness({ stallSeconds: 0.15, bot });
  seed(h.library, { name: 'walk', code: 'async function walk(bot, a, c) { await new Promise((r) => setTimeout(r, a.ms)); return { arrived: true }; }', params: { type: 'object', properties: { ms: { type: 'number' } } } });
  const stop = bot.startPathUpdates(40); // a churning A* emits path_update while the bot stands still
  const report = await h.engine.run('walk', { ms: 400 }, MORTAL); // 400ms ≫ 150ms stall, but pulses arrive
  stop();
  assert.equal(report.outcome.ok, true, 'pathfinder liveness pulses prevented a false stall (R26/D-10)');
  assert.equal(report.aborted, undefined);
});

test('D-10(iii): a never-resolving dig with one start pulse stalls at ~stallSeconds', async () => {
  const bot = new FakeBot({ username: 'Firmin' });
  bot.setBlock({ x: 1, y: 64, z: 0 }, 'stone');
  bot.setDigMode('never');
  const h = harness({ stallSeconds: 0.2, bot });
  seed(h.library, { name: 'mine', code: 'async function mine(bot, a, c) { await bot.dig(bot.blockAt({ x: 1, y: 64, z: 0 })); return 1; }' });
  const started = Date.now();
  const report = await h.engine.run('mine', {}, MORTAL);
  const elapsed = Date.now() - started;
  assert.equal(report.aborted, 'stalled');
  assert.match(report.outcome.ok ? '' : report.outcome.error, /no progress/);
  assert.ok(elapsed >= 180 && elapsed < 1500, `stalled near stallSeconds (got ${elapsed}ms)`);
  // The abort protocol ran so the next action does not fight a zombie task (R4/R5).
  assert.ok(bot.calls.includes('pathfinder.stop'));
});

test('R25: when the avatar (divine runner) runs a MORTAL skill, its /-chat is intercepted', async () => {
  const bot = new FakeBot({ username: 'Dieu' });
  const h = harness({ bot });
  seed(h.library, { name: 'demo', code: "async function demo(bot, a, c) { bot.chat('coucou'); bot.chat('/op @s'); return 1; }" });
  const avatar: RunnerRef = { name: 'Dieu', role: 'god', tier: 'divine' };
  const report = await h.engine.run('demo', {}, avatar);
  assert.equal(report.outcome.ok, true);
  assert.deepEqual(bot.sentChat, ['coucou'], 'the /-command was dropped while the avatar ran mortal code (R25)');
});

// ── Composition (depth cap, cycle, tier gate, probation D-12(iii)) ───────────
test('M2-3: composition runs callees and records the call tree', async () => {
  const h = harness();
  seed(h.library, { name: 'leaf', code: 'async function leaf(bot, a, c) { return { v: 7 }; }' });
  seed(h.library, { name: 'root', code: "async function root(bot, a, c) { const r = await c.skills.run('leaf', {}); return { got: r.v }; }" });
  const report = await h.engine.run('root', {}, MORTAL);
  assert.deepEqual(report.outcome.ok ? report.outcome.value : null, { got: 7 });
  assert.ok(report.callTree.some((f) => f.skill === 'leaf' && f.ok));
});

test('M2-3: a composition cycle throws immediately with the chain printed', async () => {
  const h = harness();
  seed(h.library, { name: 'a', code: "async function a(bot, ar, c) { return c.skills.run('b', {}); }" });
  seed(h.library, { name: 'b', code: "async function b(bot, ar, c) { return c.skills.run('a', {}); }" });
  const report = await h.engine.run('a', {}, MORTAL);
  assert.equal(report.outcome.ok, false);
  assert.match(report.outcome.ok ? '' : report.outcome.error, /cycle/i);
});

test('M2-3: composition depth is capped (no infinite descent)', async () => {
  const h = harness();
  // self-call under DIFFERENT names would dodge the cycle guard; instead force depth via a chain length.
  seed(h.library, { name: 'deep', code: "async function deep(bot, a, c) { return c.skills.run('deep2', {}); }" });
  seed(h.library, { name: 'deep2', code: "async function deep2(bot, a, c) { return c.skills.run('deep', {}); }" });
  // deep→deep2→deep is a cycle; assert the guard (cycle OR depth) fires, never runs away.
  const report = await h.engine.run('deep', {}, MORTAL);
  assert.equal(report.outcome.ok, false);
  assert.match(report.outcome.ok ? '' : report.outcome.error, /cycle|depth/i);
});

test('R25: mortal cannot reach divine through composition either', async () => {
  const h = harness();
  seed(h.library, { name: 'smite', code: 'async function smite(bot, a, c) { return 1; }', tier: 'divine' });
  seed(h.library, { name: 'sneaky', code: "async function sneaky(bot, a, c) { return c.skills.run('smite', {}); }" });
  const report = await h.engine.run('sneaky', {}, MORTAL);
  assert.equal(report.outcome.ok, false);
  assert.match(report.outcome.ok ? '' : report.outcome.error, /tier|divine/i);
});

test('D-12(iii): a probationary skill is refused as a composition callee but runnable directly, then graduates', async () => {
  const h = harness();
  seed(h.library, { name: 'helper', code: 'async function helper(bot, a, c) { return { ok: 1 }; }' }, 'active-probation');
  seed(h.library, { name: 'user', code: "async function user(bot, a, c) { return c.skills.run('helper', {}); }" });

  // Composed: refused while in probation (D-12 — gates composition, not access).
  const composed = await h.engine.run('user', {}, MORTAL);
  assert.equal(composed.outcome.ok, false);
  assert.match(composed.outcome.ok ? '' : composed.outcome.error, /probation/i);

  // Direct: a villager CAN run it directly (no re-siloing — owner #2).
  const direct = await h.engine.run('helper', {}, MORTAL);
  assert.equal(direct.outcome.ok, true);

  // After 3 clean re-judged runs it graduates → now composable.
  h.library.recordProbationRun('helper', true);
  h.library.recordProbationRun('helper', true);
  h.library.recordProbationRun('helper', true);
  assert.equal(h.library.activeVersion('helper')?.status, 'active');
  const graduated = await h.engine.run('user', {}, MORTAL);
  assert.equal(graduated.outcome.ok, true, 'graduated skill is now composable');
});

test('R57: clean ROOT runs through engine.run graduate a probation skill (recordProbationRun is wired)', async () => {
  // Regression for the wiring gap: recordProbationRun existed but had no runtime caller, so admitted
  // skills stayed active-probation forever → never composable → villagers churned re-authoring wrappers.
  // This drives graduation through engine.run (the real path), NOT by calling recordProbationRun directly.
  const h = harness();
  seed(h.library, { name: 'helper', code: 'async function helper(bot, a, c) { return { ok: 1 }; }' }, 'active-probation');
  seed(h.library, { name: 'user', code: "async function user(bot, a, c) { return c.skills.run('helper', {}); }" });

  // A failed root run must NOT advance graduation (only clean runs count — D-12).
  seed(h.library, { name: 'boom', code: 'async function boom(bot, a, c) { throw new Error("nope"); }' }, 'active-probation');
  for (let i = 0; i < 5; i++) await h.engine.run('boom', {}, MORTAL);
  assert.equal(h.library.activeVersion('boom')?.status, 'active-probation', 'failed runs never graduate');

  // Three clean direct runs (probationRuns = 3) graduate helper → it becomes composable.
  for (let i = 0; i < 3; i++) {
    const r = await h.engine.run('helper', {}, MORTAL);
    assert.equal(r.outcome.ok, true);
  }
  assert.equal(h.library.activeVersion('helper')?.status, 'active', 'graduated after 3 clean root runs');
  const composed = await h.engine.run('user', {}, MORTAL);
  assert.equal(composed.outcome.ok, true, 'a graduated skill is now composable');
});

// ── Preemption (D-05 + R9) ───────────────────────────────────────────────────
test('R9: an interrupt preempts the running tree, reported as aborted:"preempted" (benign)', async () => {
  const h = harness();
  seed(h.library, { name: 'long', code: 'async function long(bot, a, c) { await new Promise((r) => setTimeout(r, 600)); return 1; }' });
  seed(h.library, { name: 'quick', code: 'async function quick(bot, a, c) { return { done: true }; }' });
  const longRun = h.engine.run('long', {}, MORTAL);
  await new Promise((r) => setTimeout(r, 30)); // let 'long' take the bot's single tree slot
  const quickRun = h.engine.run('quick', {}, MORTAL, { interrupt: true } as RunOptions);
  const [longReport, quickReport] = await Promise.all([longRun, quickRun]);
  assert.equal(longReport.aborted, 'preempted');
  assert.equal(longReport.outcome.ok, false);
  assert.equal(quickReport.outcome.ok, true, 'the interrupting run proceeds');
});

// ── FailureTripwire (autoQuarantineAfter: 5) ─────────────────────────────────
test('M2-3: the failure tripwire fires after autoQuarantineAfter consecutive failures', async () => {
  const h = harness();
  seed(h.library, { name: 'broken', code: "async function broken(bot, a, c) { throw new Error('always'); }" });
  for (let i = 0; i < 4; i++) await h.engine.run('broken', {}, MORTAL);
  assert.deepEqual(h.tripwired, [], 'not yet at the threshold');
  await h.engine.run('broken', {}, MORTAL); // 5th consecutive failure
  assert.deepEqual(h.tripwired, ['broken'], 'tripwire filed once at the threshold (files a critic ticket either way)');
});

test('M2-3: a success resets the tripwire counter (R36 — every suppressor has a release valve)', async () => {
  const h = harness();
  seed(h.library, { name: 'flappy', code: 'async function flappy(bot, a, c) { if (a.fail) throw new Error("no"); return 1; }', params: { type: 'object', properties: { fail: { type: 'boolean' } } } });
  for (let i = 0; i < 4; i++) await h.engine.run('flappy', { fail: true }, MORTAL);
  await h.engine.run('flappy', { fail: false }, MORTAL); // success resets
  await h.engine.run('flappy', { fail: true }, MORTAL); // only 1 consecutive failure now
  assert.deepEqual(h.tripwired, [], 'the streak reset on success');
});

// ── D1: ctx.mcData = bot.registry (live-test finding 2026-06-16) ──────────────
test('D1: ctx.mcData exposes the bot registry so a skill reads itemsByName[...].id (no undefined deref)', async () => {
  const h = harness();
  // The LLM writes the mineflayer-idiomatic `ctx.mcData.itemsByName[name]?.id`. Before the fix the ctx
  // had no mcData handle, so this dereferenced `undefined` ("Cannot read properties of undefined").
  seed(h.library, {
    name: 'lookup',
    code: "async function lookup(bot, a, c) { return { id: c.mcData.itemsByName['oak_log'] && c.mcData.itemsByName['oak_log'].id, blockId: c.mcData.blocksByName['stone'] && c.mcData.blocksByName['stone'].id }; }",
  });
  const report = await h.engine.run('lookup', {}, MORTAL);
  assert.equal(report.outcome.ok, true, report.outcome.ok ? '' : report.outcome.error);
  const value = report.outcome.ok ? (report.outcome.value as { id: unknown; blockId: unknown }) : { id: null, blockId: null };
  assert.equal(typeof value.id, 'number', 'ctx.mcData.itemsByName resolved a real numeric id');
  assert.equal(typeof value.blockId, 'number', 'ctx.mcData.blocksByName resolved a real numeric id');
});

test('D1: a stock registry lookup of an unknown item fails with a NAMED error, not a raw undefined deref', async () => {
  // place-item resolves the held item via the inlined itemId() guard. An unknown name must surface the
  // named "unknown item ..." message (S10) — never the cryptic "Cannot read properties of undefined".
  const bot = new FakeBot({ username: 'Firmin' });
  bot.setUnknownItems(['__nope__']); // model a real mineflayer registry miss
  const h = harness({ bot });
  seedStockSkills(h.library);
  const report = await h.engine.run(
    'place-item',
    { item: '__nope__', x: 1, y: 64, z: 0 },
    MORTAL,
  );
  assert.equal(report.outcome.ok, false);
  const err = report.outcome.ok ? '' : report.outcome.error;
  assert.match(err, /unknown item "__nope__"/, 'the error names the offending item');
  assert.match(err, /itemsByName/, 'the error names the lookup path (D1)');
  assert.doesNotMatch(err, /Cannot read properties of undefined/, 'no cryptic undefined deref');
});

// ── Bug #13 (D-05): an aborted tree must STOP, and the next tree must not start on a body it still drives ──
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('bug #13: a timed-out loop stops acting on the bot (its next await/iteration throws)', async () => {
  const h = harness();
  seed(h.library, {
    name: 'chatter',
    code: "async function chatter(bot, a, c) { for (;;) { bot.chat('tick'); await new Promise((r) => setTimeout(r, 10)); } }",
  });
  const report = await h.engine.run('chatter', {}, MORTAL, { timeoutMs: 80 });
  assert.equal(report.aborted, 'timeout');
  const atReport = h.bot.sentChat.length;
  await wait(150);
  assert.equal(h.bot.sentChat.length, atReport, 'no bot action after the run reported its abort');
});

test('bug #13: aborted code that SWALLOWS the abort is still fenced (cannot keep driving the body)', async () => {
  const h = harness();
  seed(h.library, {
    name: 'stubborn',
    code: "async function stubborn(bot, a, c) { for (;;) { try { bot.chat('tick'); await new Promise((r) => setTimeout(r, 10)); } catch (e) { bot.chat('caught'); } } }",
  });
  const report = await h.engine.run('stubborn', {}, MORTAL, { timeoutMs: 80 });
  assert.equal(report.aborted, 'timeout');
  const atReport = h.bot.sentChat.length;
  await wait(150);
  assert.equal(h.bot.sentChat.length, atReport, 'the loop guard throws outside the try — the zombie ends');
});

test('bug #13 (D-05): a preempted tree has settled before the interrupting tree runs', async () => {
  const h = harness();
  seed(h.library, {
    name: 'slow',
    code: "async function slow(bot, a, c) { for (;;) { await new Promise((r) => setTimeout(r, 10)); bot.chat('slow'); } }",
  });
  seed(h.library, { name: 'quick', code: "async function quick(bot, a, c) { bot.chat('quick'); return 1; }" });
  const first = h.engine.run('slow', {}, MORTAL);
  await wait(40);
  const second = await h.engine.run('quick', {}, MORTAL, { interrupt: true });
  assert.equal((await first).aborted, 'preempted');
  assert.equal(second.outcome.ok, true);
  await wait(60);
  const i = h.bot.sentChat.indexOf('quick');
  assert.ok(i >= 0);
  assert.deepEqual(h.bot.sentChat.slice(i + 1), [], 'the preempted tree said nothing after the new tree started');
});

test('bug #13: composing after an abort throws instead of starting a callee', async () => {
  const h = harness();
  seed(h.library, { name: 'leaf', code: "async function leaf(bot, a, c) { bot.chat('leaf'); return 1; }" });
  seed(h.library, {
    name: 'composer',
    code: "async function composer(bot, a, c) { try { await new Promise((r) => setTimeout(r, 120)); } catch (e) {} return c.skills.run('leaf', {}); }",
  });
  const report = await h.engine.run('composer', {}, MORTAL, { timeoutMs: 40 });
  assert.equal(report.aborted, 'timeout');
  await wait(150);
  assert.deepEqual(h.bot.sentChat, [], 'the callee never ran on the aborted tree');
});

test('bug #13: an aborted tree stuck on an uncancellable bot promise is reported, and releases the bot', async () => {
  const bot = new FakeBot({ username: 'Firmin' });
  bot.setBlock({ x: 1, y: 64, z: 0 }, 'stone');
  bot.setDigMode('never'); // the abort protocol cannot cancel this promise
  const h = harness({ stallSeconds: 0.1, bot });
  seed(h.library, { name: 'mine', code: 'async function mine(bot, a, c) { await bot.dig(bot.blockAt({ x: 1, y: 64, z: 0 })); bot.chat("after"); return 1; }' });
  seed(h.library, { name: 'next', code: "async function next(bot, a, c) { bot.chat('next'); return 1; }" });
  const report = await h.engine.run('mine', {}, MORTAL);
  assert.equal(report.aborted, 'stalled');
  assert.match(report.outcome.ok ? '' : report.outcome.error, /had not settled after 100ms \(fenced/);
  const next = await h.engine.run('next', {}, MORTAL);
  assert.equal(next.outcome.ok, true, 'the bounded settle wait released the bot to the next tree');
});

// Review of bug #13: the fence ran only AFTER an await's operand was evaluated, so aborted code waking from a sleep
// issued its next awaited bot call before throwing; and the abort protocol ran BEFORE the settle wait, so a goal set
// in that window outlived the abort.
test('bug #13 review: aborted code waking from an await cannot issue its next awaited bot call', async () => {
  const h = harness();
  seed(h.library, {
    name: 'napper',
    code: "async function napper(bot, a, c) { await new Promise((r) => setTimeout(r, 60)); await bot.chat('OPERAND'); return 1; }",
  });
  const report = await h.engine.run('napper', {}, MORTAL, { timeoutMs: 20 });
  assert.equal(report.aborted, 'timeout');
  await wait(120);
  assert.deepEqual(h.bot.sentChat, [], 'the operand of the next await is never evaluated on an aborted tree');
});

test('bug #13 review: a goal set by aborted code during the settle window is cleared before the bot is released', async () => {
  const h = harness();
  seed(h.library, {
    name: 'walker',
    code: 'async function walker(bot, a, c) { try { await new Promise((r) => setTimeout(r, 40)); } catch (e) {} bot.pathfinder.setGoal(new c.Vec3(5, 64, 5)); return 1; }',
  });
  const report = await h.engine.run('walker', {}, MORTAL, { timeoutMs: 10 });
  assert.equal(report.aborted, 'timeout');
  const calls = h.bot.calls;
  const lastSet = calls.lastIndexOf('pathfinder.setGoal');
  assert.ok(lastSet >= 0, 'the zombie did set a goal (sync, after swallowing the fence)');
  assert.ok(calls.lastIndexOf('pathfinder.setGoal(null)') > lastSet, 'the abort protocol ran again after the settle wait');
});
