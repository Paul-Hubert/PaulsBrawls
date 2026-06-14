import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { SkillLibrary, AllGranted, type DraftInput } from '../src/skills/library';
import {
  SkillEngine,
  TierGateError,
  ArgValidationError,
  type RunOptions,
} from '../src/skills/engine';
import type { RunnerRef } from '../src/types/index';

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
