// The gather freeze (docs/31 §2.6): a `gather` where every batch fails used to run all its batches in microtasks
// only, so no timer, packet or supervisor heartbeat got a turn until the last one failed. `squad.tasks` now yields a
// macrotask between items, and the stock `gather` stops starting batches once one finds nothing left.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { Vec3 } from 'vec3';

import { loadStock } from '../src/stock';
import type { Order } from '../src/orders/order';
import { harness, PAUL } from './fakes/harness';
import type { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

const stock = await loadStock();

/** Synchronous work standing in for a real 48-block scan (bench/repro-tasks-spin.ts, FIND_MS). */
function busy(ms: number): void {
  const t = performance.now();
  while (performance.now() - t < ms) {
    /* scanning */
  }
}

/** The longest gap between two firings of a 100 ms timer while `run` runs (the gap after the last one included). */
async function worstTimerGap(run: () => Promise<void>): Promise<{ gap: number; ticks: number; wall: number }> {
  let last = performance.now();
  let gap = 0;
  let ticks = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
    ticks++;
  }, 100);
  const t0 = performance.now();
  try {
    await run();
  } finally {
    clearInterval(beat);
  }
  gap = Math.max(gap, performance.now() - last);
  return { gap, ticks, wall: performance.now() - t0 };
}

function logBots(h: ReturnType<typeof harness>, n: number): FakeBot[] {
  const bots: FakeBot[] = [];
  for (let i = 0; i < n; i++) {
    const b = h.bot(`Bot${i}`, [PAUL]);
    b.registry.blocksByName.oak_log = { id: 1, name: 'oak_log' };
    bots.push(b);
  }
  return bots;
}

test('gather of many failing batches: a 100 ms timer keeps firing, and the gather ends', { timeout: 10_000 }, async () => {
  const h = harness({ stock });
  // A log is always found but never reachable: every batch fails with "no path", not with "none found", so the
  // early stop does not apply and all of them run (the cut-down forest of docs/31 §2.6, where the scan still sees
  // logs out of reach). Each findBlocks costs 3 ms of synchronous work; 100 batches × 2 attempts × 2 scans ≈ 1.2 s.
  let scans = 0;
  for (const b of logBots(h, 2)) {
    b.findBlocks = () => {
      scans++;
      busy(3);
      return [new Vec3(10, 64, 10)];
    };
    (b as unknown as { blockAt: (p: Vec3) => unknown }).blockAt = (p) => ({ type: 1, name: 'oak_log', position: p });
    b.collectBlock.collect = () => Promise.reject(new Error('No path to the goal!'));
  }
  let order: Order | undefined;
  const { gap, ticks, wall } = await worstTimerGap(async () => {
    const r = await h.order(PAUL, 'gather', ['oak_log', '400']);
    assert.ok(r.ok, r.text);
    order = h.runner.get(r.orderId) as Order;
    await order.waitEnded();
  });
  assert.equal(order?.report.status, 'failed', 'nothing could be mined');
  assert.ok(scans >= 300, `every batch ran (${scans} scans)`);
  assert.ok(gap < 400, `the timer fired at least every 400 ms (longest gap ${Math.round(gap)} ms over ${Math.round(wall)} ms, ${ticks} ticks)`);
});

test('gather stops starting batches once one finds nothing left', { timeout: 10_000 }, async () => {
  const h = harness({ stock });
  let scans = 0;
  const bots = logBots(h, 3);
  for (const b of bots) {
    b.findBlocks = () => {
      scans++;
      busy(2);
      return [];
    };
  }
  const r = await h.order(PAUL, 'gather', ['oak_log', '1024']);
  assert.ok(r.ok, r.text);
  const order = h.runner.get(r.orderId) as Order;
  await order.waitEnded();
  assert.equal(order.report.status, 'failed');
  // The first batch of each bot scans (they all start before any has failed); every batch after that is skipped.
  assert.ok(scans <= bots.length, `${scans} scans for 256 batches`);
  assert.ok(order.report.logs.some((l) => /stopped early: .*none found/.test(l)), order.report.logs.join('\n'));
});
