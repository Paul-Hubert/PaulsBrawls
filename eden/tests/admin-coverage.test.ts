// Coverage for admin/server.ts branches not reached by admin.test.ts:
//   • GET unknown route → 404 { error: "no route <path>" }
//   • GET /status when getStatus() throws → 500 { error: "<message>" }
//   • GET /journal with ?until=<ms> excludes events after the cutoff

import test from 'node:test';
import assert from 'node:assert/strict';

import { AdminServer } from '../src/admin/server';
import { MemoryJournal } from './fakes/memory-journal';

async function getResponse(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

// ── 404 for unknown routes ────────────────────────────────────────────────────

test('GET unknown route → 404 { error: "no route <path>" }', async (t) => {
  const admin = new AdminServer({ port: 0, journal: new MemoryJournal() });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const { status, body } = await getResponse(`http://127.0.0.1:${port}/nonexistent`);
  assert.equal(status, 404);
  assert.match((body as { error: string }).error, /no route/i);
});

// ── 500 when a handler throws ─────────────────────────────────────────────────

test('GET /status when getStatus() throws → 500 { error: "<message>" }', async (t) => {
  const admin = new AdminServer({
    port: 0,
    journal: new MemoryJournal(),
    getStatus: () => { throw new Error('status exploded'); },
  });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const { status, body } = await getResponse(`http://127.0.0.1:${port}/status`);
  assert.equal(status, 500);
  assert.match((body as { error: string }).error, /status exploded/i);
});

// ── GET /journal ?until filter ────────────────────────────────────────────────

test('GET /journal ?until=<ms> excludes events after the cutoff', async (t) => {
  // Use a controlled clock so the until boundary is precise.
  let tick = 1_000_000;
  const journal = new MemoryJournal(() => tick);
  const admin = new AdminServer({ port: 0, journal });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  tick = 1_000_000; journal.append('engine', 'system.error', { message: 'early' });
  tick = 2_000_000; journal.append('engine', 'system.error', { message: 'mid' });
  tick = 3_000_000; journal.append('engine', 'system.error', { message: 'late' });

  // ?until=2_000_000 returns the first two events (at t0 and t1) but excludes t2.
  const res = await fetch(`http://127.0.0.1:${port}/journal?until=2000000`);
  const { events } = await res.json() as { events: Array<{ payload: { message: string } }> };
  assert.equal(events.length, 2, 'two events at or before the cutoff');
  assert.ok(events.every((e) => ['early', 'mid'].includes(e.payload.message)), 'late event excluded');
});
