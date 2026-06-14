// Coverage for journal/journal.ts and fakes/memory-journal.ts branches not reached
// by the existing journal.test.ts:
//   • Journal.fan() crash-isolation: a throwing listener must not break subsequent
//     listeners or the write path (P4)
//   • Journal.query({ until }) excludes events after the cutoff
//   • MemoryJournal.query({ until }) — same semantics as the real Journal
//   • MemoryJournal fan-out crash-isolation

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Journal } from '../src/journal/journal';
import { MemoryJournal } from './fakes/memory-journal';

function tmpJournal(t: TestContext): Journal {
  const dir = mkdtempSync(join(tmpdir(), 'eden-jrnl-cov-'));
  const j = new Journal(join(dir, 'eden.db'));
  t.after(() => { j.close(); rmSync(dir, { recursive: true, force: true }); });
  return j;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Journal fan-out crash-isolation (P4) ────────────────────────────────────

test('Journal: a throwing subscriber does not break subsequent subscribers or the write path (P4)', (t) => {
  const j = tmpJournal(t);
  const seen: string[] = [];

  j.subscribe(() => { throw new Error('bad consumer'); }); // throws on every event
  j.subscribe((e) => seen.push(e.kind));               // must still receive events

  j.append('engine', 'system.error', { message: 'a' });
  j.append('engine', 'system.error', { message: 'b' });

  // The write path must have succeeded (the rows are in the DB).
  assert.equal(j.count(), 2, 'rows persisted despite throwing first subscriber (P4)');
  // The second subscriber must have received both events (fan-out continues past the crash).
  assert.deepEqual(seen, ['system.error', 'system.error'], 'second subscriber unaffected by first throw (P4)');
});

// ── Journal.query({ until }) ─────────────────────────────────────────────────

test('Journal.query({ until }) excludes events after the cutoff', async (t) => {
  const j = tmpJournal(t);
  j.append('engine', 'system.error', { message: 'early' });
  await delay(5);
  const cutoff = Date.now();
  await delay(5);
  j.append('engine', 'system.error', { message: 'late' });

  const results = j.query({ until: cutoff });
  assert.equal(results.length, 1, 'only the event before the cutoff');
  assert.equal((results[0]?.payload as { message: string }).message, 'early');
});

// ── MemoryJournal fan-out crash-isolation ────────────────────────────────────

test('MemoryJournal: a throwing subscriber does not break subsequent subscribers or the write path', () => {
  const j = new MemoryJournal();
  const seen: string[] = [];

  j.subscribe(() => { throw new Error('bad consumer'); });
  j.subscribe((e) => seen.push(e.kind));

  j.append('engine', 'system.error', { message: 'a' });
  j.append('engine', 'system.error', { message: 'b' });

  assert.equal(j.events.length, 2, 'events stored despite throwing first subscriber');
  assert.deepEqual(seen, ['system.error', 'system.error'], 'second subscriber unaffected');
});

// ── MemoryJournal.query({ until }) ───────────────────────────────────────────

test('MemoryJournal.query({ until }) excludes events after the cutoff (same semantics as Journal)', async () => {
  let tick = 1_000;
  const j = new MemoryJournal(() => tick);

  tick = 1_000; j.append('engine', 'system.error', { message: 'early' });
  tick = 2_000; j.append('engine', 'system.error', { message: 'mid' });
  tick = 3_000; j.append('engine', 'system.error', { message: 'late' });

  const before2500 = j.query({ until: 2_500 });
  assert.equal(before2500.length, 2, 'two events at or before cutoff 2500');
  assert.ok(before2500.every((e) => ['early', 'mid'].includes((e.payload as { message: string }).message)));
});
