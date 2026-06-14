import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Journal } from '../src/journal/journal';
import type { JournalKind, PayloadOf } from '../src/journal/kinds';

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

test('full query is chronological; a limit returns the most recent N in order', (t) => {
  const j = tmpJournal(t);
  for (let i = 0; i < 5; i++) j.append('engine', 'system.error', { message: `e${i}` });
  const all = j.query();
  assert.deepEqual(all.map((e) => (e.payload as { message: string }).message), ['e0', 'e1', 'e2', 'e3', 'e4']);
  const tail = j.query({ limit: 2 });
  assert.deepEqual(tail.map((e) => (e.payload as { message: string }).message), ['e3', 'e4']);
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
