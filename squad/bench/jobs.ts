// The job pool's own overhead (docs/37 P2), no Minecraft server: real reader workers running the trivial `echo` job.
//
//  - latency: submit → resolve of one echo job at a time, with the pool's own 50 ms ticks (what a caller waits), and
//    the round trip when ticks come as fast as possible (dispatch → the worker → applied);
//  - the dispatcher's main-thread time per tick with 0, 100 and 1000 jobs queued (the dispatch tick) and as many
//    answers to apply (the next tick);
//  - the entity snapshot's write: 40 bots each knowing 100 entities, 80 of them shared.
//
//   cd squad && npm run bench:jobs            (results also in bench/.runs/<ts>-jobs/jobs.json)

import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as immediate } from 'node:timers/promises';
import { cpus } from 'node:os';

import { JobPool } from '../src/jobs/pool';
import { STOCK_HANDLERS } from '../src/jobs/handlers/index';
import { EntitySnapshot, type EntitySourceBot } from '../src/jobs/snapshot';

const here = dirname(fileURLToPath(import.meta.url));
const WORKERS = Number(process.env.JOBS_WORKERS ?? 4);
const out: Record<string, unknown> = { cpu: cpus()[0]?.model, workers: WORKERS };

function stats(xs: number[]): { p50: number; p95: number; mean: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return { p50: r(at(0.5)), p95: r(at(0.95)), mean: r(s.reduce((a, b) => a + b, 0) / s.length), max: r(s[s.length - 1]!) };
}

async function latency(): Promise<void> {
  // With the pool's own ticks (the self-correcting timer, as with a bot's physics ticks).
  for (const workers of [WORKERS, 0]) {
    const jobs = new JobPool({ workers, handlers: STOCK_HANDLERS });
    await jobs.ready();
    for (let i = 0; i < 20; i++) await jobs.submit({ type: 'echo', input: i }); // warm-up
    const xs: number[] = [];
    for (let i = 0; i < 200; i++) {
      // Submit at a random point of the tick, as a bot's own physics tick would.
      await new Promise((r) => setTimeout(r, Math.random() * 50));
      const t0 = performance.now();
      await jobs.submit({ type: 'echo', input: { i } });
      xs.push(performance.now() - t0);
    }
    out[`latency, timer ticks, ${workers} workers (ms)`] = stats(xs);
    await jobs.stop();
  }
  // The round trip: tick as fast as possible after a submit.
  const jobs = new JobPool({ workers: WORKERS, handlers: STOCK_HANDLERS, ticks: 'manual' });
  await jobs.ready();
  const xs: number[] = [];
  for (let i = 0; i < 300; i++) {
    let done = false;
    const t0 = performance.now();
    const p = jobs.submit({ type: 'echo', input: i }).then(() => (done = true));
    while (!done) {
      await jobs.tick();
      if (!done) await immediate();
    }
    await p;
    if (i >= 50) xs.push(performance.now() - t0);
  }
  out['round trip, ticking as fast as possible (ms)'] = stats(xs);
  await jobs.stop();
}

async function dispatchCost(): Promise<void> {
  const jobs = new JobPool({ workers: WORKERS, handlers: STOCK_HANDLERS, ticks: 'manual' });
  await jobs.ready();
  for (const n of [0, 100, 1000]) {
    const dispatch: number[] = [];
    const apply: number[] = [];
    for (let round = 0; round < 25; round++) {
      const ps = Array.from({ length: n }, (_, i) => jobs.submit({ type: 'echo', input: { i, round } }));
      jobs.stats(true);
      await jobs.tick(); // publish + dispatch the n queued jobs
      if (round >= 5) dispatch.push(jobs.stats(true).dispatchMs.max);
      // Wait for every answer to be back on this thread, then one tick applies them all.
      const deadline = performance.now() + 2_000;
      for (;;) {
        const st = jobs.stats();
        if ((st.inFlight === 0 && st.queue === 0) || performance.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 1));
      }
      jobs.stats(true);
      await jobs.tick();
      if (round >= 5) apply.push(jobs.stats(true).dispatchMs.max);
      await Promise.all(ps);
    }
    out[`dispatch tick, ${n} queued (ms)`] = stats(dispatch);
    out[`apply tick, ${n} answers (ms)`] = stats(apply);
  }
  // An idle pool: the timer's tick with nothing to do.
  const idle = new JobPool({ workers: WORKERS, handlers: STOCK_HANDLERS });
  await idle.ready();
  idle.stats(true);
  await new Promise((r) => setTimeout(r, 1_000));
  const s = idle.stats(true);
  out['idle tick (ms)'] = { mean: s.dispatchMs.mean, max: s.dispatchMs.max, ticks: s.ticks };
  await idle.stop();
  await jobs.stop();
}

function snapshotCost(): void {
  const shared = Array.from({ length: 80 }, (_, i) => ({ id: 1000 + i, type: i % 2 ? 'player' : 'hostile', username: `P${i}`, entityType: 1, position: { x: i, y: 64, z: 0 }, width: 0.6, height: 1.8 }));
  const bots: EntitySourceBot[] = Array.from({ length: 40 }, (_, b) => {
    const entities: Record<string, unknown> = {};
    for (const e of shared) entities[e.id] = e;
    for (let k = 0; k < 20; k++) {
      const id = 5000 + b * 20 + k;
      entities[id] = { id, type: 'object', position: { x: b, y: 64, z: k }, width: 0.25, height: 0.25 };
    }
    return { entities: entities as never };
  });
  const snap = new EntitySnapshot({ readers: WORKERS + 1 });
  const source = { bots: () => bots, teamOf: (u: string) => (u.length % 3) };
  const xs: number[] = [];
  for (let t = 1; t <= 600; t++) {
    for (const e of shared) e.position = { x: e.position.x + 0.1, y: 64, z: 0 };
    const t0 = performance.now();
    snap.write(t, source);
    if (t > 100) xs.push(performance.now() - t0);
  }
  out[`entity snapshot write, 40 bots × 100 entities (${snap.stats().count} rows) (ms)`] = stats(xs);
}

// The pool's timer and workers are unref'd (the bots and the HTTP server keep a real runtime alive): hold the loop.
const keepAlive = setInterval(() => undefined, 1_000);
await latency();
await dispatchCost();
snapshotCost();
clearInterval(keepAlive);
for (const [k, v] of Object.entries(out)) process.stdout.write(`${k}: ${JSON.stringify(v)}\n`);
const dir = join(here, '.runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-jobs`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'jobs.json'), JSON.stringify(out, null, 2));
process.stdout.write(`→ ${join(dir, 'jobs.json')}\n`);
