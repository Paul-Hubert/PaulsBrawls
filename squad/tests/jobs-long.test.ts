// docs/37 P4: what the job pool gives long jobs (A*). The progress channel: a long job answers { continue: state,
// progress } on each slice; the submitter's onProgress gets each progress at the next tick's apply step, in order, on
// a worker and inline. A callback that cancels the job stops it there; one that throws is logged and the job goes on;
// a progress that cannot be copied off its worker is dropped, not the job. Elastic types: packed by their declared
// smallest run, each run takes its share of what is left of the budget. And the workers' heap limits (resourceLimits).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JobPool } from '../src/jobs/pool';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest(60_000);

const PROGRESS = new URL('./fixtures/jobs/progress.mjs', import.meta.url);
const SLICES = new URL('./fixtures/jobs/slices.mjs', import.meta.url);
const ELASTIC = new URL('./fixtures/jobs/elastic.mjs', import.meta.url);
const HEAP_LIMIT = new URL('./fixtures/jobs/heap-limit.mjs', import.meta.url);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pump(jobs: JobPool, p: Promise<unknown>, maxTicks = 200): Promise<void> {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < maxTicks && !done; i++) {
    await jobs.tick();
    await sleep(3);
  }
  assert.ok(done, 'the job settled');
}

for (const workers of [1, 0]) {
  test(`progress: each slice's progress reaches onProgress in order, then the answer (${workers ? 'a worker' : 'inline'})`, async () => {
    const jobs = new JobPool({ workers, handlers: [PROGRESS, SLICES], ticks: 'manual' });
    try {
      await jobs.ready();
      const seen: unknown[] = [];
      const p = jobs.submit<{ done: number; worker: number }>({ type: 'progress', input: { slices: 5 }, onProgress: (v) => seen.push(v) });
      await pump(jobs, p);
      assert.deepEqual(await p, { done: 5, worker: workers ? 0 : -1 });
      assert.deepEqual(seen, [1, 2, 3, 4]);
      // A long job without progress never calls back.
      let calls = 0;
      const q = jobs.submit({ type: 'slices', input: { slices: 3 }, onProgress: () => calls++ });
      await pump(jobs, q);
      assert.equal(calls, 0);
    } finally {
      await jobs.stop();
    }
  });
}

test('progress: a callback that cancels its job stops it there; one that throws does not stop it', async () => {
  const jobs = new JobPool({ workers: 1, handlers: [PROGRESS], ticks: 'manual' });
  try {
    await jobs.ready();
    const ac = new AbortController();
    const seen: unknown[] = [];
    const p = jobs.submit({
      type: 'progress',
      input: { slices: 50 },
      signal: ac.signal,
      onProgress: (v) => {
        seen.push(v);
        if (v === 2) ac.abort(new Error('enough'));
      },
    });
    await pump(jobs, p);
    await assert.rejects(p, /enough/);
    for (let i = 0; i < 5; i++) {
      await jobs.tick();
      await sleep(3);
    }
    assert.deepEqual(seen, [1, 2], 'nothing after the cancel');
    const s = jobs.stats();
    assert.equal(s.queue + s.inFlight, 0, 'not queued again');
    assert.equal(s.types.progress?.cancelled, 1);

    const r = jobs.submit<{ done: number }>({
      type: 'progress',
      input: { slices: 4 },
      onProgress: () => {
        throw new Error('a bad callback');
      },
    });
    await pump(jobs, r);
    assert.equal((await r).done, 4);
  } finally {
    await jobs.stop();
  }
});

test('progress: one that cannot be copied off its worker is dropped, and the job goes on', async () => {
  const jobs = new JobPool({ workers: 1, handlers: [PROGRESS], ticks: 'manual' });
  try {
    await jobs.ready();
    const seen: unknown[] = [];
    const p = jobs.submit<{ done: number }>({ type: 'progress', input: { slices: 4, uncloneable: true }, onProgress: (v) => seen.push(v) });
    await pump(jobs, p);
    assert.equal((await p).done, 4);
    assert.deepEqual(seen, [1, 3], 'the second one dropped');
  } finally {
    await jobs.stop();
  }
});

test('elastic: a job alone on a worker gets the whole budget; four at once share it, packed by elasticMinMs', async () => {
  const BUDGET = 20;
  const jobs = new JobPool({ workers: 1, handlers: [ELASTIC], ticks: 'manual', tickBudgetMs: BUDGET });
  try {
    await jobs.ready();
    const one = jobs.submit<{ shares: number[] }>({ type: 'elastic', input: { slices: 3 } });
    await pump(jobs, one);
    for (const share of (await one).shares) assert.ok(share > BUDGET * 0.8 && share <= BUDGET, `alone: ${share} ms of ${BUDGET}`);
    // Measured at ~20 ms a run, but packed by its 2 ms: four go out together and split each tick's budget.
    const four = [0, 1, 2, 3].map(() => jobs.submit<{ shares: number[] }>({ type: 'elastic', input: { slices: 3 } }));
    await pump(jobs, Promise.all(four));
    for (const p of four) {
      for (const share of (await p).shares) assert.ok(share > BUDGET / 4 - 2 && share < BUDGET / 4 + 2, `one of four: ${share} ms`);
    }
    const s = jobs.stats();
    assert.ok(s.perWorker[0]!.budgetMs.max <= BUDGET + 3, `within the budget (${s.perWorker[0]!.budgetMs.max} ms)`);
  } finally {
    await jobs.stop();
  }
});

test('elastic: long jobs started one at a time spread over the workers (each goes where the fewest are held)', async () => {
  const jobs = new JobPool({ workers: 4, handlers: [ELASTIC], ticks: 'manual', tickBudgetMs: 4 });
  try {
    await jobs.ready();
    // One new search a tick, each lasting many ticks (its state stays on the worker it starts on).
    const ps: Array<Promise<{ worker: number }>> = [];
    for (let i = 0; i < 4; i++) {
      ps.push(jobs.submit<{ worker: number }>({ type: 'elastic', input: { slices: 30 } }));
      await jobs.tick();
      await sleep(12);
    }
    await pump(jobs, Promise.all(ps), 400);
    const workers = (await Promise.all(ps)).map((r) => r.worker).sort();
    assert.deepEqual(workers, [0, 1, 2, 3], 'one on each worker');
  } finally {
    await jobs.stop();
  }
});

test('elastic: a new job does not join a worker whose job has answered but is not applied yet (it looks idle)', async () => {
  const jobs = new JobPool({ workers: 2, handlers: [ELASTIC], ticks: 'manual', tickBudgetMs: 4 });
  try {
    await jobs.ready();
    const a = jobs.submit<{ worker: number }>({ type: 'elastic', input: { slices: 20 } });
    await jobs.tick(); // a's first slice goes out
    const end = Date.now() + 5_000;
    while (jobs.stats().answered === 0 && Date.now() < end) await sleep(1);
    assert.equal(jobs.stats().answered, 1, "a's slice is back, not applied: its worker is idle and holds nothing queued");
    const b = jobs.submit<{ worker: number }>({ type: 'elastic', input: { slices: 20 } });
    // A dispatch before the next apply (a worker's message can land between a tick's apply and its dispatch).
    await (jobs as unknown as { dispatch(): Promise<void> }).dispatch();
    await pump(jobs, Promise.all([a, b]), 400);
    assert.notEqual((await a).worker, (await b).worker, 'b went to the other worker');
  } finally {
    await jobs.stop();
  }
});

test('elastic: inline (no worker), the same shares of the inline budget', async () => {
  const jobs = new JobPool({ workers: 0, handlers: [ELASTIC], ticks: 'manual', inlineBudgetMs: 8 });
  try {
    await jobs.ready();
    const two = [0, 1].map(() => jobs.submit<{ shares: number[]; worker: number }>({ type: 'elastic', input: { slices: 2 } }));
    await pump(jobs, Promise.all(two));
    for (const p of two) {
      const r = await p;
      assert.equal(r.worker, -1);
      for (const share of r.shares) assert.ok(share > 2 && share < 6, `one of two inline: ${share} ms of 8`);
    }
  } finally {
    await jobs.stop();
  }
});

test('resourceLimits: the workers get the heap they are given (main.ts sizes it for A*, docs/37 §10)', async () => {
  const jobs = new JobPool({ workers: 1, handlers: [HEAP_LIMIT], ticks: 'manual', resourceLimits: { maxYoungGenerationSizeMb: 16, maxOldGenerationSizeMb: 128 } });
  try {
    await jobs.ready();
    const p = jobs.submit<number>({ type: 'heap-limit', input: null });
    await pump(jobs, p);
    const mb = await p;
    assert.ok(mb >= 128 && mb < 256, `a heap of about 128 + 16 MB (${mb} MB), not V8's default of several GB`);
  } finally {
    await jobs.stop();
  }
});
