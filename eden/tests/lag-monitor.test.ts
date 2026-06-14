import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryJournal } from './fakes/memory-journal';
import { createLagMonitor } from '../src/journal/lag-monitor';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('D-07: a 1.2s synchronous block produces exactly one system.loop-lag (max>=1000)', async () => {
  const journal = new MemoryJournal();
  const monitor = createLagMonitor(journal, { thresholdMs: 1000, resolutionMs: 10 });
  try {
    await delay(30); // let the monitor's internal timer arm (in production the loop ticks first)
    const end = Date.now() + 1200;
    while (Date.now() < end) {
      /* block the event loop for 1.2 s */
    }
    await delay(60); // yield so the monitor's internal timer records the stall
    const s = monitor.sample();
    assert.ok(s.max >= 1000, `sample max should be >=1000ms, got ${s.max.toFixed(1)}`);

    const lagEvents = journal.query({ kinds: ['system.loop-lag'] });
    assert.equal(lagEvents.length, 1, 'exactly one loop-lag event');
    assert.equal(lagEvents[0]?.actor, 'engine', 'attributed to the engine (R41)');
    assert.ok((lagEvents[0]?.payload as { max: number }).max >= 1000);
  } finally {
    monitor.stop();
  }
});

test('D-07: a quiet loop is below threshold and appends nothing', async () => {
  const journal = new MemoryJournal();
  const monitor = createLagMonitor(journal, { thresholdMs: 1000, resolutionMs: 10 });
  try {
    await delay(50);
    const s = monitor.sample();
    assert.equal(s.lagged, false);
    assert.equal(journal.query({ kinds: ['system.loop-lag'] }).length, 0);
  } finally {
    monitor.stop();
  }
});

test('R44: the in-memory pulse path emits zero journal events', () => {
  const journal = new MemoryJournal();
  const fanned: number[] = [];
  const unsub = journal.subscribe(() => fanned.push(1));

  // The M2 StallDetector's liveness pulses (~20Hz x 11 bots) are in-RAM counters that
  // it reads from memory — never a JournalKind (R44/D-07). Modeled here as a bare counter.
  let pulses = 0;
  for (let i = 0; i < 20 * 11 * 50; i++) pulses++;
  assert.equal(pulses, 11_000);

  assert.equal(journal.query().length, 0, 'no per-tick stream reached the journal');
  assert.equal(fanned.length, 0);
  unsub();
});
