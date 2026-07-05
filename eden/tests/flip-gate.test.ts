// B3a (docs/26): the D-16 flip gate's truth table — EVERY row of docs/22 §3.5 — plus the O-4
// 'return' oracle class, the event-trace ring (bound + grace + attribution filters), the
// Provenance.source discriminator on skill.admit, and the R80 readComposable pin. All on
// RecordingBot + MemoryJournal + a temp-dir library: no server, no LLM, mechanical end to end.
// (The name `gate.test.ts` was taken by the M3-GATE convergence proof — P-11; that file is
// rewired by B3b, not here.)

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { RunnerRef, Task } from '../src/types/index';
import { SkillEngine, ProbationError } from '../src/skills/engine';
import { AllGranted, SkillLibrary, type DraftInput } from '../src/skills/library';
import { FlipGate, checkSatisfied, computeDelta } from '../src/skills/flip-gate';
import { isKnownKind } from '../src/journal/kinds';
import { MemoryJournal } from './fakes/memory-journal';
import { RecordingBot } from './fakes/recording-bot';

const MORTAL: RunnerRef = { name: 'Firmin', role: 'farmer', tier: 'mortal' };

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function harness(opts: { traceGraceMs?: number } = {}): {
  engine: SkillEngine;
  library: SkillLibrary;
  journal: MemoryJournal;
  bot: RecordingBot;
  gate: FlipGate;
} {
  const dir = mkdtempSync(join(tmpdir(), 'eden-flipgate-'));
  dirs.push(dir);
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  const bot = new RecordingBot({ username: 'Firmin' });
  const engine = new SkillEngine({
    library,
    journal,
    grants: new AllGranted(),
    resolveBot: () => bot,
    runDefaultTimeoutMs: 120_000,
    stallSeconds: 20,
    maxCallDepth: 8,
    autoQuarantineAfter: 5,
    traceGraceMs: opts.traceGraceMs ?? 0,
  });
  const gate = new FlipGate({ engine, library, journal });
  return { engine, library, journal, bot, gate };
}

const draft = (library: SkillLibrary, over: Partial<DraftInput> & { name: string; code: string }) =>
  library.upsertDraft({
    summary: over.name,
    params: over.params ?? { type: 'object', properties: {} },
    returns: over.returns ?? {},
    author: { kind: 'villager', name: 'Firmin' },
    ...over,
  });

/** Draft the standard wheat pair: S gains wheat (or not), T = countItem('wheat') >= 3. */
function wheatPair(h: ReturnType<typeof harness>, skillCode: string, testOpts: Partial<DraftInput> = {}): number {
  const s = draft(h.library, { name: 'harvest-wheat', code: skillCode });
  draft(h.library, {
    name: 'wheat-harvested',
    test: true,
    validates: 'harvest-wheat',
    code: `async function t(bot, args, ctx) {
      const ripe = bot.countItem('seed_marker') > 0; // "ripe wheat present" stand-in the tests seed
      const have = bot.countItem('wheat');
      if (have >= 3) return { verdict: 'worked', evidence: 'wheat>=3' };
      if (!ripe) return { verdict: 'nothing-to-do', evidence: 'no ripe wheat anywhere' };
      return { verdict: 'failed', evidence: 'ripe wheat present, wheat<3' };
    }`,
    ...testOpts,
  });
  return s.version;
}

// ── §3.5 row 2: ADMIT — genuine flip + attributable delta (+ provenance.source on skill.admit) ──
test('ADMIT: failed → (Sδ non-empty) → worked; library.admit stamps source self-verdict', async () => {
  const h = harness();
  h.bot.give('seed_marker', 1); // precondition: ripe wheat exists
  const version = wheatPair(h, `async function s(bot, args, ctx) { bot.give('wheat', 3); return { gained: 3 }; }`);
  const out = await h.gate.run({ skill: 'harvest-wheat', version, args: {}, runner: MORTAL });

  assert.equal(out.decision, 'admit');
  assert.equal(out.preVerdict, 'failed');
  assert.equal(out.postVerdict, 'worked');
  assert.equal(out.deltaEmpty, false);
  assert.equal(out.admitted?.status, 'active-probation', 'D-12: admit → active-probation');
  assert.equal(out.admitted?.provenance?.source, 'self-verdict');
  assert.equal(out.admitted?.provenance?.selfVerdictId, out.selfVerdictId);

  const sv = h.journal.query({ kinds: ['skill.self-verdict'] });
  assert.equal(sv.length, 1);
  assert.equal((sv[0]!.payload as { decision: string }).decision, 'admit');
  const admits = h.journal.query({ kinds: ['skill.admit'] });
  assert.equal(admits.length, 1);
  assert.equal(admits[0]!.actor, 'flip-gate');
  const prov = (admits[0]!.payload as { provenance: { source: string } }).provenance;
  assert.equal(prov.source, 'self-verdict', 'the Milestone-A / CI oracle field (P-9)');
});

// ── row 1: REJECT-TEST — precondition already true / constant test (short-circuits before S) ──
test('REJECT-TEST: T(pre) already worked — constant test / D2 fraud killed in one rule; S never runs', async () => {
  const h = harness();
  h.bot.give('seed_marker', 1);
  h.bot.give('wheat', 5); // villager already holds the target
  const version = wheatPair(h, `async function s(bot, args, ctx) { bot.give('wheat', 3); return {}; }`);
  const out = await h.gate.run({ skill: 'harvest-wheat', version, args: {}, runner: MORTAL });
  assert.equal(out.decision, 'reject-test');
  assert.match(out.evidence, /R78/);
  assert.equal(out.reports.skill, undefined, 'the subject skill must NOT have run');
  assert.equal(out.postVerdict, 'not-run');
  assert.equal(h.journal.query({ kinds: ['skill.admit'] }).length, 0);
});

// ── row 3: REJECT — test claims success but the engine saw zero delta (test lies) ──
test('REJECT: fraud variant — S no-ops ok:true, T(post) somehow worked, Sδ empty', async () => {
  const h = harness();
  h.bot.give('seed_marker', 1);
  const s = draft(h.library, { name: 'harvest-wheat', code: `async function s(bot, args, ctx) { return { ok: true }; }` });
  // A lying test: returns 'failed' pre, 'worked' post via a toggle it keeps in bot state it never
  // touches — simplest honest simulation: key off an arg the gate passes identically... instead we
  // model the LIE directly: first call failed, second call worked (call-order state on the bot).
  draft(h.library, {
    name: 'wheat-harvested',
    test: true,
    validates: 'harvest-wheat',
    code: `async function t(bot, args, ctx) {
      bot.__calls = (bot.__calls ?? 0) + 1;
      return bot.__calls === 1 ? { verdict: 'failed', evidence: 'pre' } : { verdict: 'worked', evidence: 'post (lying)' };
    }`,
  });
  const out = await h.gate.run({ skill: 'harvest-wheat', version: s.version, args: {}, runner: MORTAL });
  assert.equal(out.decision, 'reject');
  assert.equal(out.deltaEmpty, true);
  assert.match(out.evidence, /zero mutable-world delta/);
  assert.equal(h.journal.query({ kinds: ['skill.admit'] }).length, 0);
});

// ── row 4: REVISE — real defect; evidence carries the test's assertion failure ──
test('REVISE: failed → failed; the gate hands back the concrete assertion failure as fuel', async () => {
  const h = harness();
  h.bot.give('seed_marker', 1);
  const version = wheatPair(h, `async function s(bot, args, ctx) { bot.give('wheat', 1); return {}; }`); // gains 1, needs 3
  const out = await h.gate.run({ skill: 'harvest-wheat', version, args: {}, runner: MORTAL });
  assert.equal(out.decision, 'revise');
  assert.match(out.evidence, /ripe wheat present, wheat<3/, 'the test evidence is the revision fuel');
  assert.equal(h.journal.query({ kinds: ['skill.admit'] }).length, 0);
});

// ── row 5: PASS, no churn — correct no-op (R72 made first-class + mechanical; NOT an admit) ──
test('NOTHING-TO-DO: no resource anywhere, zero delta — pass without admission', async () => {
  const h = harness(); // no seed_marker: nothing to harvest
  const version = wheatPair(h, `async function s(bot, args, ctx) { return { nothing: true }; }`);
  const out = await h.gate.run({ skill: 'harvest-wheat', version, args: {}, runner: MORTAL });
  assert.equal(out.decision, 'nothing-to-do');
  assert.equal(h.journal.query({ kinds: ['skill.admit'] }).length, 0, 'nothing-to-do never substitutes for the worked flip');
});

// ── row 6: SUSPECT-TEST — claimed nothing-to-do but the skill mutated the world ──
test('SUSPECT-TEST: lazy test says nothing-to-do while S mutates inventory — caught by the delta', async () => {
  const h = harness(); // no seed_marker → T says nothing-to-do both times
  const version = wheatPair(h, `async function s(bot, args, ctx) { bot.give('stone', 9); return {}; }`);
  const out = await h.gate.run({ skill: 'harvest-wheat', version, args: {}, runner: MORTAL });
  assert.equal(out.decision, 'suspect-test');
  assert.match(out.evidence, /mutated the world/);
});

// ── row 7: test throws (pre or post) → failed, never admit (conservative) ──
test('FAILED: a throwing test is test infrastructure broken — never an admission', async () => {
  const h = harness();
  const s = draft(h.library, { name: 'x', code: `async function s(bot, args, ctx) { bot.give('wheat', 3); return {}; }` });
  draft(h.library, { name: 'x-test', test: true, validates: 'x', code: `async function t(bot, args, ctx) { throw new Error('test blew up'); }` });
  const out = await h.gate.run({ skill: 'x', version: s.version, args: {}, runner: MORTAL });
  assert.equal(out.decision, 'failed');
  assert.match(out.evidence, /test blew up/);
  assert.equal(h.journal.query({ kinds: ['skill.admit'] }).length, 0);
});

test('FAILED: a test returning a non-verdict shape is treated as threw (row 7)', async () => {
  const h = harness();
  const s = draft(h.library, { name: 'x', code: `async function s(bot, args, ctx) { return {}; }` });
  draft(h.library, { name: 'x-test', test: true, validates: 'x', code: `async function t(bot, args, ctx) { return { happy: true }; }` });
  const out = await h.gate.run({ skill: 'x', version: s.version, args: {}, runner: MORTAL });
  assert.equal(out.decision, 'failed');
  assert.match(out.evidence, /not a \{verdict/);
});

// ── the task.check mission anchor (lifted checkSatisfied) ──
test('task.check unsatisfied vetoes an otherwise-admit into REVISE (R34)', async () => {
  const h = harness();
  h.bot.give('seed_marker', 1);
  const version = wheatPair(h, `async function s(bot, args, ctx) { bot.give('wheat', 3); return {}; }`);
  const task = { id: 't1', goal: 'stock bread', successCriteria: '', check: { item: 'bread', count: 2 }, context: '', maxRetries: 2 } as Task;
  const out = await h.gate.run({ skill: 'harvest-wheat', version, args: {}, runner: MORTAL, task });
  assert.equal(out.decision, 'revise');
  assert.equal(out.checkOk, false);
  assert.match(out.evidence, /2× bread/);
  assert.equal(h.journal.query({ kinds: ['skill.admit'] }).length, 0);
});

test('checkSatisfied (lifted): counts across stacks, null-after is false', () => {
  assert.equal(checkSatisfied(null, { item: 'bread', count: 1 }), false);
  const snap = { biome: 'x', time: 0, position: [0, 0, 0], health: 20, hunger: 20, equipment: [], inventory: [{ name: 'bread', count: 1 }, { name: 'bread', count: 2 }], nearbyEntities: [], nearbyBlocks: [], knownChests: [] } as never;
  assert.equal(checkSatisfied(snap, { item: 'bread', count: 3 }), true);
  assert.equal(checkSatisfied(snap, { item: 'bread', count: 4 }), false);
});

// ── O-4: the 'return' oracle class — observers are exempt from the Sδ≠∅ floor ──
test(`'return' oracle: an observer skill with zero delta still admits on a genuine flip (O-4)`, async () => {
  const h = harness();
  const s = draft(h.library, { name: 'find-spot', code: `async function s(bot, args, ctx) { bot.__spot = { x: 3, y: 64, z: 3 }; return bot.__spot; }` });
  draft(h.library, {
    name: 'spot-found',
    test: true,
    validates: 'find-spot',
    oracle: 'return',
    code: `async function t(bot, args, ctx) {
      return bot.__spot ? { verdict: 'worked', evidence: 'returned coordinate verified' } : { verdict: 'failed', evidence: 'no spot returned' };
    }`,
  });
  const out = await h.gate.run({ skill: 'find-spot', version: s.version, args: {}, runner: MORTAL });
  assert.equal(out.decision, 'admit', `zero-delta REJECT is waived for 'return'-class pairs`);
  assert.equal(out.deltaEmpty, true);
  assert.match(out.evidence, /'return'-class/);
});

// ── the P-32 viewpoint caveat: a moved bot's nearbyBlocks-only delta never convicts a no-op ──
test('Sδ caveats: nearbyBlocks-only delta + bot moved → not suspect; nearbyEntities excluded entirely', () => {
  const mkSnap = (pos: [number, number, number], counts: Record<string, number>, entities: Array<{ name: string; distance: number }> = []) =>
    ({ biome: 'x', time: 0, position: pos, health: 20, hunger: 20, equipment: [], inventory: [], nearbyEntities: entities, nearbyBlocks: Object.keys(counts), nearbyBlockCounts: counts, knownChests: [] }) as never;
  const report = (before: unknown, after: unknown) =>
    ({ runId: 'r', skill: 's', version: 1, villager: 'v', args: {}, outcome: { ok: true }, startedAt: 0, durationMs: 1, pulses: 0, deepestDepth: 0, callTree: [], logs: [], worldBefore: before, worldAfter: after, events: [] }) as never;

  // Bot moved; block counts differ (viewpoint) — corroborating, never sole-sufficient (P-32).
  const moved = computeDelta(report(mkSnap([0, 64, 0], { grass_block: 9 }), mkSnap([20, 64, 20], { sand: 9 })));
  assert.equal(moved.admitNonEmpty, true, 'counts toward the ADMIT floor');
  assert.equal(moved.suspectNonEmpty, false, 'never convicts a nothing-to-do run when the bot moved');

  // Bot did NOT move; farmland count 1→2 — the O-4 name-COUNTS catch (a name set would miss it).
  const till = computeDelta(report(mkSnap([0, 64, 0], { farmland: 1, dirt: 8 }), mkSnap([0, 64, 0], { farmland: 2, dirt: 7 })));
  assert.equal(till.blockCountsChanged, true, 'the 2nd farmland is visible to counts (O-4)');
  assert.equal(till.suspectNonEmpty, true);

  // nearbyEntities changes alone are NO delta (another body near the runner can't forge one).
  const ent = computeDelta(report(mkSnap([0, 64, 0], { dirt: 4 }, []), mkSnap([0, 64, 0], { dirt: 4 }, [{ name: 'zombie', distance: 3 }])));
  assert.equal(ent.admitNonEmpty, false);
  assert.equal(ent.suspectNonEmpty, false);
});

// ── §3.4: the event-trace ring — bound + dropped-count, grace, attribution filters, ctx.events ──
test('event-trace: ring caps at 64 with a dropped-count; newest entries kept', async () => {
  const h = harness();
  const s = draft(h.library, {
    name: 'fight',
    code: `async function s(bot, args, ctx) { for (let i = 0; i < 70; i++) bot.emit('entityDead', { name: 'z' + i, id: i }); return {}; }`,
  });
  const report = await h.engine.run('fight', {}, MORTAL, { version: s.version });
  assert.equal(report.events?.length, 64);
  assert.equal(report.eventsDropped, 6);
  assert.equal(report.events?.[63]?.name, 'z69', 'newest kept');
  assert.equal(report.events?.[0]?.name, 'z6', 'oldest six dropped');
});

test('event-trace: playerCollect is filtered to the RUNNER; entityDead records the subject identity', async () => {
  const h = harness();
  const s = draft(h.library, {
    name: 'pickup',
    code: `async function s(bot, args, ctx) {
      bot.emit('playerCollect', { username: 'SomeoneElse' }, { name: 'stolen_item' });
      bot.emit('playerCollect', { username: 'Firmin' }, { name: 'wheat_item', id: 42 });
      bot.emit('entityDead', { username: 'PlayerMob', id: 7 });
      return {};
    }`,
  });
  const report = await h.engine.run('pickup', {}, MORTAL, { version: s.version });
  const kinds = (report.events ?? []).map((e) => `${e.kind}:${e.name ?? '?'}`);
  assert.deepEqual(kinds, ['playerCollect:wheat_item', 'entityDead:PlayerMob'], 'another body’s pickup is not this run’s effect');
});

test('event-trace grace: a death landing AFTER the body resolves is still captured (P-5)', async () => {
  const h = harness({ traceGraceMs: 250 });
  const s = draft(h.library, { name: 'kill', code: `async function s(bot, args, ctx) { return 'returned-on-isValid-flip'; }` });
  const p = h.engine.run('kill', {}, MORTAL, { version: s.version });
  await new Promise((r) => setTimeout(r, 80)); // body has resolved; the grace window is open
  h.bot.emit('entityDead', { name: 'zombie', id: 1 });
  const report = await p;
  assert.equal(report.events?.some((e) => e.kind === 'entityDead' && e.name === 'zombie'), true);
});

test('ctx.events: a T(post) run reads the SUBJECT’s frozen trace, not its own live events (§3.4)', async () => {
  const h = harness();
  const s = draft(h.library, {
    name: 'kill-mob',
    code: `async function s(bot, args, ctx) { bot.emit('entityDead', { name: 'zombie' }); return {}; }`,
  });
  draft(h.library, {
    name: 'mob-killed',
    test: true,
    validates: 'kill-mob',
    oracle: 'events',
    code: `async function t(bot, args, ctx) {
      const dead = ctx.events.some((e) => e.kind === 'entityDead' && e.name === 'zombie');
      bot.__ranOnce = (bot.__ranOnce ?? 0) + 1;
      if (bot.__ranOnce === 1) return { verdict: 'failed', evidence: 'no kill yet (pre: injected trace empty=' + (ctx.events.length === 0) + ')' };
      return dead ? { verdict: 'worked', evidence: 'entityDead(zombie) in the subject trace' } : { verdict: 'failed', evidence: 'no entityDead in trace' };
    }`,
  });
  const out = await h.gate.run({ skill: 'kill-mob', version: s.version, args: {}, runner: MORTAL });
  assert.equal(out.decision, 'admit', 'the ephemeral oracle admits via the injected trace + the entityDead delta');
  assert.match(out.evidence, /delta/);
});

// ── no paired test → a structural error the caller must surface (submit_skill tool error) ──
test('a skill without a paired test cannot enter the gate (named error)', async () => {
  const h = harness();
  const s = draft(h.library, { name: 'lonely', code: `async function s() { return {}; }` });
  await assert.rejects(h.gate.run({ skill: 'lonely', version: s.version, args: {}, runner: MORTAL }), /has no paired test/);
});

// ── R80: readComposable + the composer path ──
test('R80: a composer keeps using active v(k) while v(k+1) is on probation; first admission still ProbationError', async () => {
  const h = harness();
  // v1 active (graduated), returning 1.
  h.library.seedStock({ name: 'callee', summary: 'callee', params: { type: 'object', properties: {} }, returns: {}, author: { kind: 'stock' }, code: `async function c() { return 'v1'; }` }, 'active');
  // v2 admitted → active-probation, returning 2.
  const v2 = draft(h.library, { name: 'callee', code: `async function c() { return 'v2'; }` });
  h.library.admit('callee', v2.version, { rolloutId: 'r', source: 'self-verdict', selfVerdictId: 'sv' });
  assert.equal(h.library.readRunnable('callee')?.version.version, v2.version, 'direct run_skill resolves highest LIVE (v2)');
  assert.equal(h.library.readComposable('callee')?.version.version, 1, 'composition resolves highest ACTIVE (v1)');

  h.library.seedStock({ name: 'composer', summary: 'composer', params: { type: 'object', properties: {} }, returns: {}, author: { kind: 'stock' }, code: `async function comp(bot, args, ctx) { return await ctx.skills.run('callee', {}); }` }, 'active');
  const report = await h.engine.run('composer', {}, MORTAL);
  assert.equal(report.outcome.ok, true, 'the composer is NOT blocked by v2 probation (the R80 cliff, fixed)');
  assert.equal(report.outcome.ok ? report.outcome.value : null, 'v1', 'it composed the graduated v1');

  // First admission (no graduated version at all) → ProbationError preserved (D-12 rail).
  const first = draft(h.library, { name: 'fresh', code: `async function f() { return 1; }` });
  h.library.admit('fresh', first.version, { rolloutId: 'r', source: 'self-verdict', selfVerdictId: 'sv2' });
  h.library.seedStock({ name: 'composer2', summary: 'c2', params: { type: 'object', properties: {} }, returns: {}, author: { kind: 'stock' }, code: `async function comp2(bot, args, ctx) { return await ctx.skills.run('fresh', {}); }` }, 'active');
  const r2 = await h.engine.run('composer2', {}, MORTAL);
  assert.equal(r2.outcome.ok, false);
  assert.equal(r2.outcome.ok ? '' : r2.outcome.errorKind, new ProbationError('fresh').name);
});

test('D-16: paired tests are never composable and invisible to exemplars', async () => {
  const h = harness();
  h.library.seedStock({ name: 'a-test', summary: 't', params: { type: 'object', properties: {} }, returns: {}, author: { kind: 'stock' }, test: true, validates: 'a', exemplar: true, code: `async function t() { return { verdict: 'worked' }; }` }, 'active');
  h.library.seedStock({ name: 'caller', summary: 'c', params: { type: 'object', properties: {} }, returns: {}, author: { kind: 'stock' }, code: `async function c(bot, args, ctx) { return await ctx.skills.run('a-test', {}); }` }, 'active');
  const report = await h.engine.run('caller', {}, MORTAL);
  assert.equal(report.outcome.ok, false);
  assert.match(report.outcome.ok ? '' : report.outcome.error, /never composable/);
  assert.equal(h.library.exemplars('mortal').length, 0, 'a test never rides the exemplar set');
});

// ── the journal kind is registered (S1 registry row; rebuild reads it like any other kind) ──
test('skill.self-verdict is a registered kind and its refs tie it to rollout/run/skill', async () => {
  assert.equal(isKnownKind('skill.self-verdict'), true);
  const h = harness();
  h.bot.give('seed_marker', 1);
  const version = wheatPair(h, `async function s(bot, args, ctx) { bot.give('wheat', 3); return {}; }`);
  await h.gate.run({ skill: 'harvest-wheat', version, args: {}, runner: MORTAL, rolloutId: 'ro-1' });
  const sv = h.journal.query({ kinds: ['skill.self-verdict'] });
  assert.equal(sv.length, 1);
  assert.equal(sv[0]!.refs.rolloutId, 'ro-1');
  assert.equal(sv[0]!.refs.skill, 'harvest-wheat');
  assert.ok(sv[0]!.refs.runId, 'ties to the subject run');
  const payload = sv[0]!.payload as { testDeltaEmpty?: boolean; testPostDeltaEmpty?: boolean };
  assert.equal(payload.testDeltaEmpty, true, 'the §3.3 Tδ purity audit rides the row');
  assert.equal(payload.testPostDeltaEmpty, true);
});
