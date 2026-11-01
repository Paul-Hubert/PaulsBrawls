// docs/37 P1 + P2 together: the job pool's reader workers open the real shared world (src/world/reader.mjs) from the
// descriptor SharedWorld gives each of them, read it inside the batch's enter()/leave(), and a restarted worker gets
// a fresh reader. The tests of each side use stubs of the other (tests/world.test.ts, tests/jobs.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JobPool } from '../src/jobs/pool';
import { SharedWorld } from '../src/world/shared-world';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest(60_000);

const HANDLER = new URL('./fixtures/jobs/world-probe.mjs', import.meta.url);
const READER = new URL('../src/world/reader.mjs', import.meta.url);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
type Probe = { state: number; states: number; stoneSolid: boolean; worker: number };

async function run(jobs: JobPool, input: unknown): Promise<Probe> {
  const p = jobs.submit<Probe>({ type: 'world-probe', input });
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 400 && !done; i++) {
    await jobs.tick();
    await sleep(3);
  }
  return p;
}

for (const workers of [1, 0]) {
  test(`${workers ? 'a reader worker' : 'the inline fallback'} reads the shared world and its state tables`, async () => {
    const world = new SharedWorld({ version: '1.21.1', cacheSeconds: 60, cacheColumns: 100, maxReaders: 8 });
    const jobs = new JobPool({ workers, handlers: [HANDLER], ticks: 'manual', version: '1.21.1', world, worldModule: READER });
    try {
      await jobs.ready();
      const r = await run(jobs, { dim: 'overworld', x: 0, y: 64, z: 0 });
      assert.equal(r.state, -1, 'no column held: unknown');
      assert.ok(r.states > 26_000, `state tables cross the thread boundary (${r.states} states)`);
      assert.equal(r.stoneSolid, true);
      assert.equal(r.worker, workers ? 0 : -1);
    } finally {
      await jobs.stop();
      await world.stop();
    }
  });
}

test('a worker killed and restarted reads the shared world again', async () => {
  const world = new SharedWorld({ version: '1.21.1', cacheSeconds: 60, cacheColumns: 100, maxReaders: 8 });
  const jobs = new JobPool({ workers: 1, handlers: [HANDLER], ticks: 'manual', version: '1.21.1', world, worldModule: READER });
  try {
    await jobs.ready();
    assert.equal((await run(jobs, { dim: 'overworld', x: 0, y: 64, z: 0 })).state, -1);
    jobs.killWorker(0);
    for (let i = 0; i < 200 && jobs.stats().alive < 1; i++) await sleep(10);
    await jobs.ready();
    const r = await run(jobs, { dim: 'overworld', x: 5, y: 70, z: 5 });
    assert.equal(r.state, -1);
    assert.equal(r.worker, 0, 'answered by the restarted worker, not inline');
  } finally {
    await jobs.stop();
    await world.stop();
  }
});
