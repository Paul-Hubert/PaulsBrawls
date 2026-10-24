import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Journal } from '../src/journal/journal';
import type { JournalKind, PayloadOf } from '../src/journal/kinds';
import { SkillStatsView } from '../src/views/index';

function tmpJournal(t: TestContext): Journal {
  const dir = mkdtempSync(join(tmpdir(), 'eden-jrnl-'));
  const j = new Journal(join(dir, 'eden.db'));
  t.after(() => {
    j.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return j;
}

test('append returns a sortable id and the payload round-trips through query', (t) => {
  const j = tmpJournal(t);
  const id = j.append('engine', 'system.loop-lag', { p99: 12, max: 1500 });
  assert.equal(typeof id, 'string');
  assert.equal(j.count(), 1);
  const [ev] = j.query({ kinds: ['system.loop-lag'] });
  assert.deepEqual(ev?.payload, { p99: 12, max: 1500 });
  assert.equal(ev?.actor, 'engine');
  assert.equal(ev?.kind, 'system.loop-lag');
});

test('each registered kind round-trips its payload schema', (t) => {
  const j = tmpJournal(t);
  j.append('engine', 'system.boot', { config: { admin: { port: 8770 } } });
  j.append('engine', 'system.config-warning', { message: 'unknown key skills.wat' });
  j.append('villager:Firmin', 'system.bot-connected', { name: 'Firmin' });
  j.append('villager:Firmin', 'system.bot-disconnected', { name: 'Firmin', reason: 'kicked' });
  j.append('engine', 'system.error', { message: 'boom', stack: 'at x' });
  const all = j.query();
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((e) => e.kind), [
    'system.boot',
    'system.config-warning',
    'system.bot-connected',
    'system.bot-disconnected',
    'system.error',
  ]);
  assert.deepEqual(all[2]?.payload, { name: 'Firmin' });
  assert.deepEqual(all[3]?.payload, { name: 'Firmin', reason: 'kicked' });
});

test('query filters by kind, actor, ref, and since', async (t) => {
  const j = tmpJournal(t);
  j.append('engine', 'system.boot', { config: {} });
  j.append('villager:Firmin', 'system.bot-connected', { name: 'Firmin' }, { skill: 'collect-blocks' });
  j.append('villager:Remy', 'system.bot-connected', { name: 'Remy' }, { rolloutId: 'R7' });
  await new Promise((r) => setTimeout(r, 5)); // advance the wall clock past the first three appends
  const sinceMark = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  j.append('engine', 'system.error', { message: 'late' });

  assert.equal(j.query({ actor: 'villager:Firmin' }).length, 1);
  assert.equal(j.query({ kinds: ['system.bot-connected'] }).length, 2);
  assert.equal(j.query({ ref: 'R7' })[0]?.actor, 'villager:Remy');
  assert.equal(j.query({ ref: 'collect-blocks' })[0]?.actor, 'villager:Firmin');
  const recent = j.query({ since: sinceMark });
  assert.deepEqual(recent.map((e) => e.kind), ['system.error']);
});

test('LOW-1: a ref match hits the indexed typed paths (rolloutId/runId/skill), not every ref value', (t) => {
  const j = tmpJournal(t);
  j.append('villager:Remy', 'system.bot-connected', { name: 'Remy' }, { rolloutId: 'R9' });
  j.append('villager:Firmin', 'system.bot-connected', { name: 'Firmin' }, { runId: 'run-1', skill: 'mine' });
  // A ref carried ONLY on a non-indexed path (taskId) is intentionally NOT matched — the query rides the
  // three json_extract expression indexes (rollout/run/skill), which is what every caller queries by.
  j.append('engine', 'god.task-proposed', { taskId: 'T42', goal: 'g', trigger: 'idle' }, { taskId: 'T42' });

  assert.equal(j.query({ ref: 'R9' }).length, 1, 'rolloutId matches');
  assert.equal(j.query({ ref: 'run-1' }).length, 1, 'runId matches');
  assert.equal(j.query({ ref: 'mine' }).length, 1, 'skill matches');
  assert.equal(j.query({ ref: 'T42' }).length, 0, 'a taskId-only ref is not matched (non-indexed path)');
});

test('full query is chronological; a limit returns the most recent N in order', (t) => {
  const j = tmpJournal(t);
  for (let i = 0; i < 5; i++) j.append('engine', 'system.error', { message: `e${i}` });
  const all = j.query();
  assert.deepEqual(all.map((e) => (e.payload as { message: string }).message), ['e0', 'e1', 'e2', 'e3', 'e4']);
  const tail = j.query({ limit: 2 });
  assert.deepEqual(tail.map((e) => (e.payload as { message: string }).message), ['e3', 'e4']);
});

test('order desc returns newest-first; with a limit, the N newest in desc order; asc is the default', (t) => {
  const j = tmpJournal(t);
  for (let i = 0; i < 5; i++) j.append('engine', 'system.error', { message: `e${i}` });
  const msg = (e: { payload: object }): string => (e.payload as { message: string }).message;

  const desc = j.query({ order: 'desc' });
  assert.deepEqual(desc.map(msg), ['e4', 'e3', 'e2', 'e1', 'e0']);

  const tailDesc = j.query({ order: 'desc', limit: 2 });
  assert.deepEqual(tailDesc.map(msg), ['e4', 'e3'], 'the 2 newest, newest-first');

  const tailAsc = j.query({ order: 'asc', limit: 2 });
  assert.deepEqual(tailAsc.map(msg), ['e3', 'e4'], 'the 2 newest, oldest-first');

  assert.deepEqual(j.query().map(msg), ['e0', 'e1', 'e2', 'e3', 'e4'], 'default order is chronological');
});

test('subscribe fans out appended events; unsubscribe stops it', (t) => {
  const j = tmpJournal(t);
  const seen: string[] = [];
  const unsub = j.subscribe((e) => seen.push(e.kind));
  j.append('engine', 'system.error', { message: 'one' });
  unsub();
  j.append('engine', 'system.error', { message: 'two' });
  assert.deepEqual(seen, ['system.error']);
});

test('appending an unregistered kind throws (S1 guard)', (t) => {
  const j = tmpJournal(t);
  assert.throws(
    () => j.append('engine', 'made.up.kind' as JournalKind, {} as PayloadOf<'system.boot'>),
    /unregistered kind/,
  );
});

// FIX 3 (journal grew unbounded): retentionDays was parsed but never consumed. prune() now bounds the
// journal by deleting old OBSERVABILITY rows (vitals + system.loop-lag) — and ONLY those, so no view fold
// over a durable kind is affected (the rebuild==live invariant). `now` is injectable to control the clock.
test('prune deletes old prunable rows, keeps durable + recent rows, and leaves a view fold unchanged', (t) => {
  const j = tmpJournal(t);
  // Durable rows a view folds (SkillStatsView reads skill.run) — these must SURVIVE prune.
  const run = (skill: string): PayloadOf<'skill.run'> => ({
    runId: 'r-' + skill, skill, version: 1, villager: 'Firmin', args: {}, outcome: { ok: true },
    startedAt: 1, durationMs: 10, pulses: 1, deepestDepth: 0, callTree: [], logs: [],
    worldBefore: null, worldAfter: null,
  });
  j.append('engine', 'skill.run', run('mine'));
  j.append('engine', 'skill.run', run('craft'));
  // High-volume observability rows (prunable) — vitals + loop-lag.
  j.append('bot:Firmin', 'vitals', { name: 'Firmin', health: 20, food: 20, position: [0, 64, 0], held: null, currentRun: null });
  j.append('engine', 'system.loop-lag', { p99: 12, max: 1500 });

  // The live fold BEFORE prune (what a view holds at runtime).
  const before = new SkillStatsView();
  for (const e of j.query()) before.fold(e);

  // Prune with a far-future `now` so the just-appended rows count as "older than the retention horizon".
  const FAR_FUTURE = Date.now() + 30 * 24 * 60 * 60 * 1000; // +30 days
  const deleted = j.prune(7, FAR_FUTURE);
  assert.equal(deleted, 2, 'exactly the two prunable rows (vitals + loop-lag) were deleted');
  assert.equal(j.query({ kinds: ['vitals'] }).length, 0, 'vitals pruned');
  assert.equal(j.query({ kinds: ['system.loop-lag'] }).length, 0, 'loop-lag pruned');
  assert.equal(j.query({ kinds: ['skill.run'] }).length, 2, 'durable skill.run rows untouched');

  // A fresh fold over the pruned journal equals the pre-prune fold — the rebuild==live invariant holds,
  // because no view ever folded the pruned kinds.
  const after = new SkillStatsView();
  for (const e of j.query()) after.fold(e);
  assert.deepEqual(after.value(), before.value(), 'the SkillStatsView fold is identical post-prune');

  // A recent prunable row (within the horizon) is NOT pruned.
  j.append('engine', 'system.loop-lag', { p99: 1, max: 9 });
  assert.equal(j.prune(7, Date.now()), 0, 'a fresh prunable row is inside the retention horizon');
  assert.equal(j.query({ kinds: ['system.loop-lag'] }).length, 1, 'the recent loop-lag row survives');

  // retentionDays <= 0 disables pruning entirely (keep everything).
  assert.equal(j.prune(0, FAR_FUTURE), 0, 'retention disabled when retentionDays is 0');
  assert.equal(j.query({ kinds: ['system.loop-lag'] }).length, 1, 'nothing deleted with retention disabled');
});
