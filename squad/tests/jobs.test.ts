// docs/37 P2: the job pool, its reader workers and the entity snapshot. Real worker threads run the test handlers of
// tests/fixtures/jobs/ (with a stub of P1's world module); the dispatcher ticks by hand (`ticks: 'manual'`) except in
// the tick-source tests, so only the budget tests depend on wall-clock time, with generous margins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobFailedError, JobLateError, JobPool, type JobPoolOptions } from '../src/jobs/pool';
import { EntitySnapshot, RESCAN_WRITES, type EntitySourceBot } from '../src/jobs/snapshot';
import { openEntities } from '../src/jobs/entities.mjs';
import { TeamIds } from '../src/jobs/teams';
import { LeaderTicks } from '../src/jobs/ticks';
import { STOCK_HANDLERS } from '../src/jobs/handlers/index';
import { Vitals, type LoopSource } from '../src/vitals/metrics';
import { ConfigError, jobWorkerCount, parseConfig } from '../src/config';
import { start } from '../src/main';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { until } from './fakes/harness';

holdEventLoopPerTest(60_000);

const fx = (name: string): URL => new URL(`./fixtures/jobs/${name}.mjs`, import.meta.url);
const HANDLERS = [...STOCK_HANDLERS, ...['probe', 'burn', 'slices', 'throws', 'crash', 'entity'].map(fx)];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pool(opts: Partial<JobPoolOptions> = {}): JobPool {
  return new JobPool({ workers: 1, handlers: HANDLERS, ticks: 'manual', ...opts });
}

/** Tick (with a little wall time between ticks for the workers) until every promise has settled. */
async function pump(jobs: JobPool, ps: Array<Promise<unknown>>, maxTicks = 400, gapMs = 3): Promise<void> {
  let left = ps.length;
  for (const p of ps) p.then(() => left--, () => left--);
  for (let i = 0; i < maxTicks && left > 0; i++) {
    await jobs.tick();
    await sleep(gapMs);
  }
  assert.equal(left, 0, `${left} job(s) still pending after ${maxTicks} ticks`);
}

async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

/** A stub of P1's SharedWorld: counts descriptor() and release() calls; the stub reader counts enter/leave. */
function stubWorld(): {
  world: { descriptor(): unknown; release(d: unknown): void };
  counters: Int32Array;
  descriptors: () => number;
  released: unknown[];
} {
  const sab = new SharedArrayBuffer(12);
  let n = 0;
  const released: unknown[] = [];
  return {
    world: {
      descriptor: () => ({ sab, n: ++n }),
      release: (d) => released.push(d),
    },
    counters: new Int32Array(sab),
    descriptors: () => n,
    released,
  };
}

test('jobs: an echo job runs on a worker and resolves at the start of a later tick', async () => {
  const jobs = pool();
  try {
    await jobs.ready();
    const p = jobs.submit<{ a: number }>({ type: 'echo', input: { a: 1 } });
    await pump(jobs, [p]);
    assert.deepEqual(await p, { a: 1 });
    const s = jobs.stats();
    assert.equal(s.types.echo!.submitted, 1);
    assert.equal(s.types.echo!.done, 1);
    assert.equal(s.types.echo!.inline, 0);
    assert.equal(s.queue, 0);
    assert.equal(s.inFlight, 0);
    assert.equal(s.alive, 1);
    assert.equal(s.tickSource, 'manual');
  } finally {
    await jobs.stop();
  }
});

test('jobs: higher priority first, then the earlier deadline, then the earlier submit', async () => {
  const jobs = pool();
  try {
    await jobs.ready();
    const sub = (input: string, priority?: number, deadlineTick?: number) =>
      jobs.submit<{ input: string; n: number }>({ type: 'probe', input, priority, deadlineTick });
    const ps = [sub('p1', 1), sub('p5a', 5), sub('none'), sub('p3', 3), sub('p5b', 5), sub('p5-deadline', 5, 1_000)];
    await pump(jobs, ps);
    const runs = await Promise.all(ps);
    const order = [...runs].sort((a, b) => a.n - b.n).map((r) => r.input);
    assert.deepEqual(order, ['p5-deadline', 'p5a', 'p5b', 'p3', 'p1', 'none']);
  } finally {
    await jobs.stop();
  }
});

test('jobs: a worker stops its batch at its budget; the jobs it did not start come back next tick', async () => {
  const BUDGET = 20;
  const JOB_MS = 6;
  const jobs = pool({ tickBudgetMs: BUDGET });
  try {
    await jobs.ready();
    const ps = Array.from({ length: 12 }, (_, i) => jobs.submit<{ id: number; tick: number }>({ type: 'burn', input: { id: i, ms: JOB_MS } }));
    await pump(jobs, ps, 400, 5);
    const done = await Promise.all(ps);
    assert.deepEqual(done.map((d) => d.id), [...Array(12).keys()]);
    const s = jobs.stats();
    const w = s.perWorker[0]!;
    assert.ok(w.batches >= 4, `12 × ${JOB_MS} ms in ${BUDGET} ms batches needs at least 4 batches, got ${w.batches}`);
    // Never more than the budget plus one job's overrun (the estimate decides before each job), with slack for Windows.
    assert.ok(w.budgetMs.max <= BUDGET + JOB_MS + 8, `longest batch ${w.budgetMs.max} ms for a ${BUDGET} ms budget`);
    assert.ok(s.types.burn!.carried > 0, 'some jobs were carried to a later tick');
    assert.equal(s.types.burn!.done, 12);
    // The jobs ran across several ticks, in submit order.
    const ticks = done.map((d) => d.tick);
    assert.ok(new Set(ticks).size >= 4, `ran over ${new Set(ticks).size} ticks`);
    for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i]! >= ticks[i - 1]!, 'carried jobs keep their place');
    // The main thread learned the type's cost.
    assert.ok((s.types.burn!.costMs ?? 0) >= JOB_MS * 0.8, `cost estimate ${s.types.burn!.costMs}`);
  } finally {
    await jobs.stop();
  }
});

test('jobs: a long job continues on the same worker with its state; affinity keys pin jobs to one worker', async () => {
  const jobs = pool({ workers: 2 });
  try {
    await jobs.ready();
    const long = jobs.submit<{ workers: number[]; ticks: number[] }>({ type: 'slices', input: { slices: 5 } });
    const a = Array.from({ length: 6 }, (_, i) => jobs.submit<{ worker: number }>({ type: 'probe', input: `a${i}`, affinity: 'A' }));
    const b = Array.from({ length: 6 }, (_, i) => jobs.submit<{ worker: number }>({ type: 'probe', input: `b${i}`, affinity: 'B' }));
    await pump(jobs, [long, ...a, ...b]);
    const r = await long;
    assert.equal(r.workers.length, 5);
    assert.equal(new Set(r.workers).size, 1, `every slice on one worker: ${r.workers}`);
    for (let i = 1; i < r.ticks.length; i++) assert.ok(r.ticks[i]! > r.ticks[i - 1]!, 'one slice per tick');
    assert.equal(jobs.stats().types.slices!.continued, 4);
    assert.equal(new Set((await Promise.all(a)).map((x) => x.worker)).size, 1);
    assert.equal(new Set((await Promise.all(b)).map((x) => x.worker)).size, 1);
  } finally {
    await jobs.stop();
  }
});

test('jobs: past its deadlineTick a job rejects with JobLateError, queued or answered too late', async () => {
  const jobs = pool();
  try {
    await jobs.ready();
    // Queued: a worker's answer is applied at the next tick, so a job due by the dispatch tick cannot make it.
    const t = jobs.currentTick;
    const queued = settled(jobs.submit({ type: 'echo', input: 1, deadlineTick: t + 1 }));
    await jobs.tick();
    const q = await queued;
    assert.ok(!q.ok && q.error instanceof JobLateError, 'queued past its deadline');
    assert.equal((q.error as JobLateError).deadlineTick, t + 1);
    assert.equal((q.error as JobLateError).type, 'echo');

    // Answered too late: dispatched at t2 + 1 (due t2 + 2), but the worker is still burning at tick t2 + 2.
    const t2 = jobs.currentTick;
    const slow = settled(jobs.submit({ type: 'burn', input: { id: 0, ms: 40 }, deadlineTick: t2 + 2 }));
    await jobs.tick(); // t2 + 1: dispatched
    await jobs.tick(); // t2 + 2: nothing back yet
    await sleep(120);
    await jobs.tick(); // t2 + 3: the answer, one tick late
    const s = await slow;
    assert.ok(!s.ok && s.error instanceof JobLateError, 'answered after its deadline');
    assert.equal(jobs.stats().types.burn!.late, 1);
    assert.equal(jobs.stats().types.echo!.late, 1);
  } finally {
    await jobs.stop();
  }
});

test('jobs: a handler that throws rejects with JobFailedError carrying its message and stack', async () => {
  const jobs = pool();
  try {
    await jobs.ready();
    const p = settled(jobs.submit({ type: 'throws', input: 'x' }));
    await pump(jobs, [p]);
    const r = await p;
    assert.ok(!r.ok && r.error instanceof JobFailedError);
    const e = r.error as JobFailedError;
    assert.equal(e.message, 'boom x');
    assert.equal(e.reason, 'threw');
    assert.equal(e.remoteName, 'TypeError');
    assert.match(e.remoteStack ?? '', /throws\.mjs/);
    assert.match(e.stack ?? '', /in the job handler/);
    assert.equal(jobs.stats().types.throws!.failed, 1);

    // An unknown type: refused at submit once a worker has said which types it has.
    const u = await settled(jobs.submit({ type: 'nope', input: null }));
    assert.ok(!u.ok && u.error instanceof JobFailedError && u.error.reason === 'unknownType');
  } finally {
    await jobs.stop();
  }
});

test('jobs: a worker killed mid-batch is restarted, its jobs are queued again once, then fail', async () => {
  const w = stubWorld();
  const bots: EntitySourceBot[] = [{ entities: { 3: ent(3, 'hostile', 1) } }];
  const jobs = pool({
    world: w.world,
    worldModule: fx('stub-world'),
    maxCrashesPerMinute: 10,
    tickBudgetMs: 200,
    entities: { bots: () => bots, teamOf: () => 0 },
  });
  try {
    await jobs.ready();
    assert.equal(w.descriptors(), 1);
    const ps = [0, 1, 2].map((id) => jobs.submit<{ id: number }>({ type: 'burn', input: { id, ms: 30 } }));
    await jobs.tick();
    await sleep(10); // inside the batch
    await jobs.killWorker(0);
    await until(() => jobs.stats().alive === 1 && jobs.stats().perWorker[0]!.ready, 5_000, 'restarted');
    assert.equal(w.descriptors(), 2, 'the restarted worker opened the world again');
    await pump(jobs, ps);
    assert.deepEqual((await Promise.all(ps)).map((r) => r.id), [0, 1, 2]);
    let s = jobs.stats();
    assert.equal(s.restarts, 1);
    assert.equal(s.types.burn!.retried, 3);

    // A job that kills every worker it runs on: queued again once, then failed.
    const c = settled(jobs.submit({ type: 'crash', input: null }));
    await pump(jobs, [c], 400, 10);
    const r = await c;
    assert.ok(!r.ok && r.error instanceof JobFailedError && r.error.reason === 'workerDied', String(!r.ok && r.error));
    s = jobs.stats();
    assert.equal(s.restarts, 3);
    assert.equal(s.types.crash!.retried, 1);
    assert.equal(s.types.crash!.failed, 1);
    // Every batch was bracketed by enter/leave, never nested; only the three cut short by a death never left, and
    // each dead worker's reader was released (its epoch would otherwise hold back memory reuse).
    assert.equal(w.counters[0]! - w.counters[1]!, 3);
    assert.equal(w.counters[2], 0);
    assert.deepEqual(w.released.map((d) => (d as { n: number }).n), [1, 2, 3]);
    // The dead workers' entity holds were cleared too: the snapshot keeps publishing (for jobs that read it).
    const before = jobs.stats().entities;
    for (let i = 0; i < 3; i++) {
      const e = jobs.submit({ type: 'entity', input: { id: 3 } });
      await pump(jobs, [e]);
      await e;
    }
    const after = jobs.stats().entities;
    assert.equal(after.skipped, before.skipped);
    assert.ok(after.published >= before.published + 3);
  } finally {
    await jobs.stop();
  }
});

test('jobs: after too many crashes the slot is disabled and jobs run inline on the main thread', async () => {
  const jobs = pool({ maxCrashesPerMinute: 2 });
  try {
    await jobs.ready();
    const c = settled(jobs.submit({ type: 'crash', input: null }));
    await pump(jobs, [c], 400, 10);
    const r = await c;
    assert.ok(!r.ok && r.error instanceof JobFailedError && r.error.reason === 'workerDied');
    await until(() => jobs.stats().perWorker[0]!.disabled, 5_000, 'disabled');
    const p = jobs.submit<{ inline: boolean; worker: number }>({ type: 'probe', input: 'after' });
    await pump(jobs, [p]);
    const v = await p;
    assert.equal(v.inline, true);
    assert.equal(v.worker, -1);
    const s = jobs.stats();
    assert.equal(s.alive, 0);
    assert.equal(s.types.probe!.inline, 1);
    assert.equal(s.inline.loaded, true);
  } finally {
    await jobs.stop();
  }
});

test('jobs: a continue answered by a worker that then died (and was disabled) starts again inline', async () => {
  const jobs = pool({ maxCrashesPerMinute: 1 });
  try {
    await jobs.ready();
    const long = jobs.submit<{ workers: number[] }>({ type: 'slices', input: { slices: 3 } });
    await jobs.tick();
    await until(() => jobs.stats().answered === 1, 2_000, 'the first slice answered');
    await jobs.killWorker(0); // its state goes with it, before the answer is applied
    await until(() => jobs.stats().perWorker[0]!.disabled, 2_000, 'disabled');
    await pump(jobs, [long]);
    assert.deepEqual((await long).workers, [-1, -1, -1], 'from scratch, on the main thread');
    assert.equal(jobs.stats().types.slices!.retried, 1);
  } finally {
    await jobs.stop();
  }
});

test('jobs: with 0 workers every job runs inline, continues included, with the stub world entered', async () => {
  const w = stubWorld();
  const jobs = pool({ workers: 0, world: w.world, worldModule: fx('stub-world') });
  try {
    await jobs.ready();
    const e = jobs.submit({ type: 'echo', input: 'x' });
    const probe = jobs.submit<{ inline: boolean; worldDepth: number }>({ type: 'probe', input: 'y' });
    const long = jobs.submit<{ workers: number[] }>({ type: 'slices', input: { slices: 3 } });
    await pump(jobs, [e, probe, long]);
    assert.equal(await e, 'x');
    assert.deepEqual({ inline: (await probe).inline, depth: (await probe).worldDepth }, { inline: true, depth: 1 });
    assert.deepEqual((await long).workers, [-1, -1, -1]);
    const s = jobs.stats();
    assert.equal(s.workers, 0);
    assert.equal(s.types.echo!.inline, 1);
    assert.equal(s.types.slices!.inline, 3);
    assert.equal(s.types.slices!.continued, 2);
    assert.equal(w.descriptors(), 1);
    assert.equal(w.counters[0], w.counters[1]);
    assert.equal(w.counters[2], 0);
  } finally {
    await jobs.stop();
  }
});

test('jobs: the stub world is entered around every worker batch and handlers see it entered', async () => {
  const w = stubWorld();
  const jobs = pool({ workers: 2, world: w.world, worldModule: fx('stub-world') });
  try {
    await jobs.ready();
    assert.equal(w.descriptors(), 2, 'one descriptor per worker');
    const ps = Array.from({ length: 8 }, (_, i) => jobs.submit<{ worldDepth: number }>({ type: 'probe', input: i }));
    await pump(jobs, ps);
    for (const r of await Promise.all(ps)) assert.equal(r.worldDepth, 1);
    const batches = jobs.stats().perWorker.reduce((n, x) => n + x.batches, 0);
    assert.equal(w.counters[0], batches);
    assert.equal(w.counters[1], batches);
    assert.equal(w.counters[2], 0);
  } finally {
    await jobs.stop();
  }
});

test('jobs: a transferred input moves to the worker, waits there when carried, and comes back in the answer', async () => {
  const jobs = pool({ tickBudgetMs: 20 });
  try {
    await jobs.ready();
    const bufs = [0, 1, 2, 3].map((i) => new Uint8Array([i, 42]).buffer);
    const ps = bufs.map((buf, id) => jobs.submit<{ id: number }>({ type: 'burn', input: { id, ms: 12, buf }, transfer: [buf] }));
    const e = jobs.submit<{ buf: ArrayBuffer }>({ type: 'echo', input: { buf: new Uint8Array([7]).buffer } });
    await jobs.tick();
    assert.ok(bufs.every((b) => b.byteLength === 0), 'moved, not copied');
    await pump(jobs, [...ps, e]);
    assert.deepEqual((await Promise.all(ps)).map((r) => r.id), [0, 1, 2, 3]);
    assert.equal(new Uint8Array((await e).buf)[0], 7);
    assert.ok(jobs.stats().types.burn!.carried > 0, 'carried while their inputs stayed on the worker');
  } finally {
    await jobs.stop();
  }
});

test('jobs: an aborted job rejects with the signal reason and never runs', async () => {
  const jobs = pool();
  try {
    await jobs.ready();
    const ac = new AbortController();
    const p = settled(jobs.submit({ type: 'probe', input: 'cancelled', signal: ac.signal }));
    ac.abort();
    const r = await p;
    assert.ok(!r.ok && (r.error as Error).name === 'AbortError');
    const ok = jobs.submit<{ n: number }>({ type: 'probe', input: 'next' });
    await pump(jobs, [ok]);
    assert.equal((await ok).n, 1, 'the cancelled job never ran');
    assert.equal(jobs.stats().types.probe!.cancelled, 1);
  } finally {
    await jobs.stop();
  }
});

test('jobs: stats count the window and reset it', async () => {
  const jobs = pool({ workers: 2 });
  try {
    await jobs.ready();
    const ps = Array.from({ length: 50 }, (_, i) => jobs.submit({ type: 'echo', input: i }));
    await pump(jobs, ps);
    const s = jobs.stats(true);
    const e = s.types.echo!;
    assert.deepEqual([e.submitted, e.done, e.late, e.failed, e.inline], [50, 50, 0, 0, 0]);
    assert.ok(e.latencyMs.p50 !== null && e.latencyMs.p95 !== null && e.latencyMs.p95 >= e.latencyMs.p50);
    assert.ok(s.ticks >= 2);
    assert.ok(s.perWorker.reduce((n, x) => n + x.jobs, 0) === 50);
    assert.ok(s.perWorker.every((x) => x.budgetMs.max >= 0 && x.budgetMs.mean <= x.budgetMs.max));
    assert.ok(s.dispatchMs.max >= s.dispatchMs.mean);
    assert.ok(s.queueMax >= 1);
    const z = jobs.stats();
    assert.deepEqual([z.types.echo!.submitted, z.types.echo!.done, z.ticks], [0, 0, 0]);
    assert.equal(z.types.echo!.latencyMs.p50, null);
  } finally {
    await jobs.stop();
  }
});

test('jobs: stop rejects what is pending', async () => {
  const jobs = pool();
  await jobs.ready();
  const p = settled(jobs.submit({ type: 'echo', input: 1 }));
  await jobs.stop();
  const r = await p;
  assert.ok(!r.ok && r.error instanceof JobFailedError && r.error.reason === 'stopped');
  const after = await settled(jobs.submit({ type: 'echo', input: 2 }));
  assert.ok(!after.ok && after.error instanceof JobFailedError && after.error.reason === 'stopped');
});

// -- the entity snapshot ---------------------------------------------------------------------------------------------

interface FakeEnt {
  id: number;
  type: string;
  username?: string;
  entityType?: number;
  position: { x: number; y: number; z: number };
  width: number;
  height: number;
}

function ent(id: number, type: string, x: number, extra: Partial<FakeEnt> = {}): FakeEnt {
  return { id, type, position: { x, y: 64, z: 0 }, width: 0.6, height: 1.8, ...extra };
}

test('entities: one row per entity id across bots, velocity from the last two snapshots, team ids', () => {
  const zombieA = ent(10, 'hostile', 5, { entityType: 145 });
  const zombieB = ent(10, 'hostile', 5.05, { entityType: 145 }); // bot B's slightly older copy of the same zombie
  const a1 = ent(1, 'player', 0, { username: 'A1' });
  const b1 = ent(2, 'player', 1, { username: 'B1' });
  const bob = ent(5, 'player', 2, { username: 'Bob' });
  const arrow = ent(20, 'projectile', 3, { width: 0.5, height: 0.5 });
  const botA: EntitySourceBot = { entity: a1, entities: { 1: a1, 2: b1, 10: zombieA, 5: bob } };
  const botB: EntitySourceBot = { entity: b1, entities: { 2: b1, 1: a1, 10: zombieB, 20: arrow } };
  const teams: Record<string, number> = { A1: 7, B1: 7 };
  const source = { bots: () => [botA, null, botB], teamOf: (u: string) => teams[u] ?? 0 };
  const snap = new EntitySnapshot({ readers: 2, capacity: 16 });
  const reader = openEntities(snap.handles, 0);

  assert.equal(snap.write(1, source), true);
  reader.pin();
  assert.equal(reader.count, 5);
  assert.equal(reader.tick, 1);
  assert.equal(reader.epoch, 1);
  const ids: number[] = [];
  reader.each((r) => {
    ids.push(r.id);
  });
  assert.deepEqual(ids, [1, 2, 5, 10, 20]);
  const z = reader.get(10)!;
  assert.equal(z.x, 5, 'the first bot that knows it gives the row');
  assert.deepEqual([z.type, z.kind, z.vx, z.vy, z.vz, z.team], [145, 2, 0, 0, 0, 0]);
  assert.deepEqual([reader.get(1)!.team, reader.get(2)!.team, reader.get(5)!.team, reader.get(20)!.team], [7, 7, 0, 0]);
  assert.equal(reader.get(1)!.kind, 1);
  assert.equal(reader.get(20)!.width, 0.5);
  assert.equal(reader.get(99), null);
  reader.unpin();

  // Tick 2: the zombie moved 0.2 east, 0.1 north.
  zombieA.position = { x: 5.2, y: 64, z: -0.1 };
  snap.write(2, source);
  reader.pin();
  const z2 = reader.get(10)!;
  assert.ok(Math.abs(z2.vx - 0.2) < 1e-9 && Math.abs(z2.vz + 0.1) < 1e-9 && z2.vy === 0, JSON.stringify(z2));
  reader.unpin();

  // Tick 4 (tick 3 skipped): 0.4 more over two ticks is still 0.2 a tick. The arrow is gone from every bot.
  zombieA.position = { x: 5.6, y: 64, z: -0.1 };
  delete botB.entities![20];
  snap.write(4, source);
  reader.pin();
  assert.ok(Math.abs(reader.get(10)!.vx - 0.2) < 1e-9);
  assert.equal(reader.get(20), null);
  assert.equal(reader.count, 4);
  reader.unpin();

  // Seen again after more than 4 ticks: velocity 0 again.
  zombieA.position = { x: 9, y: 64, z: -0.1 };
  snap.write(20, source);
  reader.pin();
  assert.equal(reader.get(10)!.vx, 0);
  reader.unpin();
});

test('entities: a held buffer is never rewritten; the writer skips a publish instead', () => {
  const e = ent(1, 'hostile', 0);
  const source = { bots: () => [{ entities: { 1: e } }], teamOf: () => 0 };
  const snap = new EntitySnapshot({ readers: 2 });
  const r0 = openEntities(snap.handles, 0);
  const r1 = openEntities(snap.handles, 1);
  snap.write(1, source);
  r0.pin(); // r0 reads snapshot 1 (buffer X)
  e.position = { x: 1, y: 64, z: 0 };
  assert.equal(snap.write(2, source), true); // goes to buffer Y
  assert.equal(r0.get(1)!.x, 0, 'r0 still sees its snapshot');
  r1.pin(); // r1 takes snapshot 2 (buffer Y)
  assert.equal(r1.get(1)!.x, 1);
  e.position = { x: 2, y: 64, z: 0 };
  assert.equal(snap.write(3, source), false, 'X is held by r0, Y is published: skipped');
  assert.equal(r0.get(1)!.x, 0);
  assert.equal(snap.stats().skipped, 1);
  r0.unpin();
  assert.equal(r0.count, 0, 'an unpinned reader reads nothing');
  assert.equal(snap.write(4, source), true);
  r0.pin();
  assert.equal(r0.get(1)!.x, 2);
  assert.equal(r0.tick, 4);
  assert.equal(r1.get(1)!.x, 1, 'r1 kept snapshot 2');
  r0.unpin();
  r1.unpin();
});

test('entities: a worker reads the snapshot published on the tick its job was dispatched', async () => {
  const zombie = ent(10, 'hostile', 3, { entityType: 145 });
  const bots: EntitySourceBot[] = [{ entity: ent(1, 'player', 0, { username: 'A1' }), entities: { 10: zombie } }];
  const jobs = pool({ entities: { bots: () => bots, teamOf: (u) => (u === 'A1' ? 4 : 0) } });
  try {
    await jobs.ready();
    const p = jobs.submit<{ row: { x: number; team: number } | null; count: number; tick: number; ids: number[] }>({ type: 'entity', input: { id: 10 } });
    await pump(jobs, [p]);
    const r = await p;
    assert.equal(r.row?.x, 3);
    assert.equal(r.count, 2);
    assert.deepEqual(r.ids, [1, 10]);
    assert.ok(r.tick >= 1);
    assert.ok(jobs.stats().entities.published >= 1);
  } finally {
    await jobs.stop();
  }
});

test('entities: the snapshot is published only for jobs whose type reads it (needsEntities), not for the others', async () => {
  let walks = 0;
  const zombie = ent(10, 'hostile', 3);
  // Counts the writer's reads of the bot's entities.
  const bot = { get entities() {
    walks++;
    return { 10: zombie };
  } } as EntitySourceBot;
  const jobs = pool({ entities: { bots: () => [bot], teamOf: () => 0 } });
  try {
    await jobs.ready();
    // Echo and burn read no entity (like path and findBlocks): nothing is written, however many ticks they run.
    const quiet = [...[1, 2, 3].map((a) => jobs.submit({ type: 'echo', input: { a } })), jobs.submit({ type: 'burn', input: { id: 0, ms: 1 } })];
    await pump(jobs, quiet);
    for (let i = 0; i < 5; i++) await jobs.tick();
    assert.equal(jobs.stats().entities.published, 0, 'no snapshot for jobs that read none');
    assert.equal(walks, 0, "the bots' entities were not even read");
    // A job that reads entities (the aim's kind): published for its dispatch.
    const p = jobs.submit<{ row: { x: number } | null }>({ type: 'entity', input: { id: 10 } });
    await pump(jobs, [p]);
    assert.equal((await p).row?.x, 3);
    const published = jobs.stats().entities.published;
    assert.ok(published >= 1);
    // Then nothing again, with only echo jobs about.
    const more = [4, 5].map((a) => jobs.submit({ type: 'echo', input: { a } }));
    await pump(jobs, more);
    assert.equal(jobs.stats().entities.published, published);
    // The stock aim handler declares it; the other stock types do not.
    const { STOCK_HANDLERS: stock } = await import('../src/jobs/handlers/index');
    const flags: Record<string, boolean> = {};
    for (const u of stock) {
      const m = (await import(u.href)) as { type: string; needsEntities?: boolean };
      flags[m.type] = m.needsEntities === true;
    }
    assert.deepEqual(flags, { echo: false, findBlocks: false, aim: true, path: false });
  } finally {
    await jobs.stop();
  }
});

/** A bot as the incremental writer follows it: entities, and mineflayer's entitySpawn / entityGone / end events. */
class EmitterBot extends EventEmitter {
  entity: FakeEnt | null = null;
  entities: Record<string, FakeEnt> = {};
  spawn(e: FakeEnt): void {
    this.entities[e.id] = e;
    this.emit('entitySpawn', e);
  }
  gone(id: number): void {
    const e = this.entities[id];
    if (!e) return;
    this.emit('entityGone', e);
    (e as FakeEnt & { isValid?: boolean }).isValid = false;
    delete this.entities[id];
  }
}

/** Every row of the snapshot a reader sees now, as plain values. */
function rows(snap: EntitySnapshot): Array<Record<string, number>> {
  const r = openEntities(snap.handles, 0);
  r.pin();
  const out: Array<Record<string, number>> = [];
  r.each((row) => {
    out.push({ ...row });
  });
  r.unpin();
  return out;
}

test('entities: the incremental writer (bots followed by their events) writes the rows of the walking one', () => {
  // A seeded random walk of what a fight does to the bots' entities: spawns (each bot its own copy, at its own
  // slightly different position), moves, deaths, arrows that come and go, a bot that leaves and one that joins, a
  // login that empties a bot's entities without an event, an entity made without a spawn event.
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const teams: Record<string, number> = { B0: 1, B1: 1, B2: 2, B3: 2 };
  let bots: EmitterBot[] = [];
  const source = { bots: () => bots as unknown as EntitySourceBot[], teamOf: (u: string) => teams[u] ?? 0 };
  const inc = new EntitySnapshot({ readers: 1, capacity: 512 });
  const walked = new EntitySnapshot({ readers: 1, capacity: 512, incremental: false });
  let nextId = 100;
  /** The world: every entity, by id, with where it is. */
  const world = new Map<number, { type: string; x: number; z: number; username?: string }>();
  const copy = (b: EmitterBot, id: number): FakeEnt => {
    const w = world.get(id)!;
    return ent(id, w.type, w.x + bots.indexOf(b) * 0.01, { username: w.username, ...(w.type === 'projectile' ? { width: 0.5, height: 0.5 } : {}) });
  };
  const join = (name: string): EmitterBot => {
    const b = new EmitterBot();
    const id = nextId++;
    world.set(id, { type: 'player', x: rnd() * 40, z: 0, username: name });
    bots = [...bots, b];
    b.entity = copy(b, id);
    b.entities[id] = b.entity;
    for (const o of bots) {
      if (o === b) continue;
      o.spawn(copy(o, id)); // the others see it
      const theirs = o.entity!.id;
      b.entities[theirs] = copy(b, theirs); // it sees them (from its login's packets: no event, the walk at first sight)
    }
    for (const [wid] of world) if (!b.entities[wid] && wid !== id && world.get(wid)!.type !== 'player') b.entities[wid] = copy(b, wid);
    return b;
  };
  for (const n of ['B0', 'B1', 'B2', 'B3']) join(n);
  let ghost = -1;
  let ghostRows = 0;
  for (let tick = 1; tick <= 400; tick++) {
    const r = rnd();
    if (tick === 60) {
      // A bot leaves (end, then out of the source).
      const b = bots[1]!;
      bots = bots.filter((x) => x !== b);
      b.emit('end');
      for (const o of bots) o.gone(b.entity!.id);
      world.delete(b.entity!.id);
    } else if (tick === 90) {
      join('B4');
    } else if (tick === 120) {
      // A login: mineflayer empties the bot's entities, no event; the others come again with their spawn packets.
      const b = bots[0]!;
      b.entities = { [b.entity!.id]: b.entity! };
      for (const id of world.keys()) if (id !== b.entity!.id && rnd() < 0.5) b.spawn(copy(b, id));
    } else if (tick === 150) {
      // An entity mineflayer made from a packet about an id it had not seen (no spawn event).
      ghost = nextId++;
      world.set(ghost, { type: 'object', x: 5, z: 0 });
      bots[2]!.entities[ghost] = copy(bots[2]!, ghost);
    } else if (r < 0.25) {
      // An arrow or a zombie appears: every bot spawns its copy.
      const id = nextId++;
      world.set(id, { type: rnd() < 0.7 ? 'projectile' : 'hostile', x: rnd() * 40, z: 0 });
      for (const b of bots) b.spawn(copy(b, id));
    } else if (r < 0.45) {
      // One goes: every bot, or (out of range) only some.
      const ids = [...world.keys()].filter((id) => world.get(id)!.type !== 'player');
      const id = ids[Math.floor(rnd() * ids.length)];
      if (id !== undefined) {
        const all = rnd() < 0.7;
        for (const b of bots) if (all || rnd() < 0.5) b.gone(id);
        if (bots.every((b) => !b.entities[id])) world.delete(id);
      }
    }
    // Everything moves a little (each bot's own copy).
    for (const b of bots) for (const k in b.entities) b.entities[k]!.position = { x: b.entities[k]!.position.x + (rnd() - 0.5) * 0.3, y: 64, z: tick * 0.01 };
    if (tick % 3 === 0) continue; // some ticks write nothing (no aim job queued)
    inc.write(tick, source);
    walked.write(tick, source);
    const a = rows(inc);
    const b = rows(walked);
    if (ghost >= 0 && ghostRows < 2) {
      // The entity made without an event: the walking writer has it at once, the incremental one from its next rescan
      // (first seen there: velocity 0 for that write).
      if (a.some((x) => x.id === ghost)) ghostRows++;
      else assert.ok(tick < 150 + (RESCAN_WRITES * 3) / 2 + 2, `tick ${tick}: still no row for the entity made without an event`);
      const strip = (xs: typeof a): typeof a => xs.filter((x) => x.id !== ghost);
      assert.deepEqual(strip(a), strip(b), `tick ${tick}`);
      continue;
    }
    assert.deepEqual(a, b, `tick ${tick}`);
  }
  assert.equal(ghostRows, 2, 'the entity made without an event came in at a rescan');
  assert.equal(inc.stats().followed, bots.length, 'one follow per online bot (the one that left was dropped)');
  assert.equal(bots[0]!.listenerCount('entitySpawn'), 1);
  inc.close();
  assert.equal(bots[0]!.listenerCount('entitySpawn'), 0, 'close removes the listeners');
});

test('teams: bots sharing an owner (and their owners) share a team; everyone else is 0', () => {
  const P1 = { uuid: 'u1', name: 'P1' };
  const P2 = { uuid: 'u2', name: 'P2' };
  const P3 = { uuid: 'u3', name: 'P3' };
  let roster = [
    { name: 'A', owners: [P1], tags: [], createdAt: 0, createdBy: '' },
    { name: 'B', owners: [P2, P1], tags: [], createdAt: 0, createdBy: '' },
    { name: 'C', owners: [P3], tags: [], createdAt: 0, createdBy: '' },
  ];
  let now = 0;
  const t = new TeamIds(() => roster, 1_000, () => now);
  const ab = t.teamOf('A');
  assert.ok(ab > 0);
  assert.equal(t.teamOf('B'), ab);
  assert.equal(t.teamOf('P1'), ab);
  assert.equal(t.teamOf('P2'), ab);
  const c = t.teamOf('C');
  assert.ok(c > 0 && c !== ab);
  assert.equal(t.teamOf('P3'), c);
  assert.equal(t.teamOf('Zombie'), 0);
  // The roster changes: read again after maxAgeMs; ids stay for groups that did not change.
  roster = [...roster, { name: 'D', owners: [P3], tags: [], createdAt: 0, createdBy: '' }];
  assert.equal(t.teamOf('D'), 0, 'cached');
  now = 2_000;
  assert.equal(t.teamOf('D'), c);
  assert.equal(t.teamOf('A'), ab);
});

// -- ticks -----------------------------------------------------------------------------------------------------------

test('ticks: the self-correcting timer ticks by itself; a bot tick source takes over and gives back', async () => {
  const jobs = new JobPool({ workers: 0, handlers: HANDLERS });
  try {
    await jobs.ready();
    const v = await jobs.submit({ type: 'echo', input: 'timer' });
    assert.equal(v, 'timer');
    const t0 = jobs.currentTick;
    await sleep(520);
    const perSec = ((jobs.currentTick - t0) / 0.52);
    assert.ok(perSec >= 14 && perSec <= 24, `timer at ${perSec.toFixed(1)} ticks/s`);
    assert.equal(jobs.stats().tickSource, 'timer');

    const bot = new EventEmitter();
    jobs.useTickSource(bot as never);
    const t1 = jobs.currentTick;
    for (let i = 0; i < 6; i++) {
      bot.emit('physicsTick');
      await sleep(20);
    }
    assert.equal(jobs.stats().tickSource, 'bot');
    // 6 bot ticks in ~120 ms; the timer stood aside (it would add about 2).
    assert.ok(jobs.currentTick - t1 >= 6 && jobs.currentTick - t1 <= 7, `ticks ${jobs.currentTick - t1}`);
    const p = jobs.submit({ type: 'echo', input: 'bot' });
    bot.emit('physicsTick');
    await sleep(5);
    bot.emit('physicsTick');
    assert.equal(await p, 'bot');

    jobs.useTickSource(null);
    const t2 = jobs.currentTick;
    await sleep(300);
    assert.ok(jobs.currentTick - t2 >= 3, 'the timer is back');
    assert.equal(jobs.stats().tickSource, 'timer');
  } finally {
    await jobs.stop();
  }
});

test('ticks: the dispatcher follows the first online bot, then the next one when it goes', () => {
  const pool = new EventEmitter() as EventEmitter & { names(): string[]; bot(n: string): unknown };
  const online = new Map<string, EventEmitter>();
  pool.names = () => ['A', 'B', 'C'];
  pool.bot = (n) => online.get(n);
  const used: unknown[] = [];
  const leader = new LeaderTicks(pool as never, { useTickSource: (s) => used.push(s) });
  assert.equal(leader.current, null);
  const a = new EventEmitter();
  const b = new EventEmitter();
  online.set('B', b);
  pool.emit('online', 'B', b);
  assert.equal(leader.current, 'B');
  online.set('A', a);
  pool.emit('online', 'A', a);
  assert.equal(leader.current, 'B', 'a leader stays while online');
  online.delete('B');
  pool.emit('status', 'B', 'offline');
  assert.equal(leader.current, 'A');
  online.delete('A');
  pool.emit('status', 'A', 'connecting');
  assert.equal(leader.current, null);
  assert.deepEqual(used, [null, b, a, null]);
});

// -- vitals ----------------------------------------------------------------------------------------------------------

test('vitals: /api/metrics carries the jobs window and the French line a summary of it', async () => {
  const jobs = pool();
  try {
    await jobs.ready();
    const ps = [jobs.submit({ type: 'echo', input: 1 }), settled(jobs.submit({ type: 'echo', input: 2, deadlineTick: jobs.currentTick + 1 }))];
    await pump(jobs, ps);
    const loop: LoopSource = { read: () => ({ seconds: 10, p50: 1, p99: 2, max: 3, elu: 0.1, cpuPct: 5, rssMb: 100, heapMb: 50 }), stop: () => undefined };
    const vitals = new Vitals({ pool: { readMeters: () => [] }, loop, jobs });
    const m = vitals.sample();
    assert.ok(m.jobs);
    assert.equal(m.jobs.types.echo!.submitted, 2);
    assert.equal(m.jobs.types.echo!.late, 1);
    assert.match(m.text, /calculs : 1\/1 worker, file 0, p95 \d+ ms, 1 en retard/);
    assert.equal(jobs.stats().types.echo!.submitted, 0, 'the sample reset the window');
  } finally {
    await jobs.stop();
  }
});

// -- config and the composition root ---------------------------------------------------------------------------------

test('config: workers defaults to 32 workers and 40 ms, is validated, and is capped at the hardware threads', () => {
  const env = { PAULSBRAWLS_SQUAD_TOKEN: 't' };
  assert.deepEqual(parseConfig({}, env).workers, { count: 32, tickBudgetMs: 40 });
  assert.deepEqual(parseConfig({ workers: { count: 3, tickBudgetMs: 25 } }, env).workers, { count: 3, tickBudgetMs: 25 });
  for (const bad of [-1, 1.5, 33, 'x']) assert.throws(() => parseConfig({ workers: { count: bad } }, env), ConfigError, `count ${String(bad)}`);
  for (const bad of [0, 51, -2]) assert.throws(() => parseConfig({ workers: { tickBudgetMs: bad } }, env), ConfigError, `budget ${String(bad)}`);
  assert.equal(jobWorkerCount({ count: 8, tickBudgetMs: 40 }, 4), 4);
  assert.equal(jobWorkerCount({ count: 32, tickBudgetMs: 40 }, 32), 32);
  assert.equal(jobWorkerCount({ count: 2, tickBudgetMs: 40 }, 32), 2);
  assert.equal(jobWorkerCount({ count: 2, tickBudgetMs: 40 }, 1), 1);
});

test('boot: workers.count > 0 starts the job pool, ticking on an online bot, and /api/metrics shows it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'squad-jobs-'));
  const TOKEN = 'jobs-token';
  const off = await start(parseConfig({ port: 0, dataDir: dir, loginStaggerMs: 1, workers: { count: 0 } }, { PAULSBRAWLS_SQUAD_TOKEN: TOKEN }), { connectBots: false });
  assert.equal(off.jobs, undefined, 'off with workers.count 0');
  await off.stop();
  const cfg = parseConfig({ port: 0, dataDir: dir, loginStaggerMs: 1, workers: { count: 1 } }, { PAULSBRAWLS_SQUAD_TOKEN: TOKEN });
  const rt = await start(cfg, {
    connectBots: true,
    pool: {
      createBot: (req) => {
        const b = new FakeBot(req.username);
        setTimeout(() => b.emit('spawn'), 1);
        return b as never;
      },
      setup: () => undefined,
    },
  });
  try {
    const jobs = rt.jobs!;
    assert.ok(jobs);
    await jobs.ready();
    const api = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await fetch(`http://127.0.0.1:${rt.port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await res.json()) as Record<string, unknown>;
    };
    const PAUL = { uuid: 'uuid-paul', name: 'Paul' };
    await api('/api/bots/spawn', { by: PAUL, admin: true, name: 'Garde1', owners: [PAUL] });
    await until(() => rt.service.deps.pool.status('Garde1') === 'online', 2_000, 'online');
    const bot = rt.service.deps.pool.bot('Garde1') as unknown as FakeBot;
    const p = jobs.submit({ type: 'echo', input: 'via the bot' });
    const ticker = setInterval(() => bot.emit('physicsTick'), 10);
    try {
      assert.equal(await p, 'via the bot');
      assert.equal(jobs.stats().tickSource, 'bot');
    } finally {
      clearInterval(ticker);
    }
    rt.service.deps.vitals!.sample();
    const m = (await api('/api/metrics', {})) as { jobs?: { workers: number; types: Record<string, { done: number }> }; text: string };
    assert.equal(m.jobs?.workers, 1);
    assert.equal(m.jobs?.types.echo?.done, 1);
    assert.match(m.text, /calculs : 1\/1 worker/);
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
