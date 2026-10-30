// Repro of a freeze the load benchmark found (docs/31 §2.6): `gather` where no reachable log is left. `mineBlock`
// throws before its first real await (findBlocks finds nothing free), so `squad.tasks` retries and moves to the next
// item in microtasks only: the event loop gets no turn until every batch has failed. On the fakes, with a findBlocks
// that costs FIND_MS of synchronous work (a 48-block scan on a real world), the loop is blocked for about
// batches × (1 + retries) × FIND_MS: 256 × 2 × 20 ms ≈ 10 s, and the bots' keepalives and the supervisor's
// heartbeat with it.
//
//   cd squad && npm run bench:repro-tasks-spin

import { performance } from 'node:perf_hooks';

import { loadStock } from '../src/stock';
import type { Order } from '../src/orders/order';
import { harness, PAUL } from '../tests/fakes/harness';

const FIND_MS = Number(process.env.FIND_MS ?? 20);
const BOTS = 10;
const COUNT = 1024; // gather's maximum: 256 batches of 4

async function main(): Promise<void> {
  const h = harness({ stock: await loadStock() });
  for (let i = 0; i < BOTS; i++) {
    const bot = h.bot(`Bot${i}`, [PAUL]) as unknown as { registry: { blocksByName: Record<string, unknown> }; findBlocks: () => unknown[] };
    bot.registry.blocksByName.oak_log = { id: 1, name: 'oak_log' };
    bot.findBlocks = () => {
      const t = performance.now();
      while (performance.now() - t < FIND_MS) {
        /* a real 48-block scan */
      }
      return [];
    };
  }
  // The longest gap between two firings of a 100 ms timer (a monitorEventLoopDelay histogram cannot sample while
  // the loop is blocked either).
  let ticks = 0;
  let last = performance.now();
  let worstGap = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
    ticks++;
  }, 100);
  const t0 = performance.now();
  const r = await h.order(PAUL, 'gather', ['oak_log', String(COUNT)]);
  if (!r.ok) throw new Error(r.text);
  const order = h.runner.get(r.orderId) as Order;
  await order.waitEnded();
  const wall = performance.now() - t0;
  clearInterval(beat);
  worstGap = Math.max(worstGap, performance.now() - last);
  process.stdout.write(
    `gather ${COUNT} on ${BOTS} bots, findBlocks ${FIND_MS} ms: ended "${order.report.status}" after ${Math.round(wall)} ms; ` +
      `a 100 ms timer fired ${ticks} times (expected ${Math.round(wall / 100)}), longest gap ${Math.round(worstGap)} ms; ` +
      `failures recorded ${order.report.failures.length}\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`repro crashed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(2);
});
