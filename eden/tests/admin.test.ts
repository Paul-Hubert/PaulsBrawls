import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import { AdminServer, JOURNAL_DEFAULT_LIMIT, JOURNAL_MAX_LIMIT } from '../src/admin/server';
import { MemoryJournal } from './fakes/memory-journal';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  return res.json();
}

test('GET /status returns uptime, bot count, and queue depths', async (t) => {
  const journal = new MemoryJournal();
  const admin = new AdminServer({
    port: 0,
    journal,
    getStatus: () => ({ bots: 0, runs: 0, queues: { llm: 0 } }),
  });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const status = await getJson(`http://127.0.0.1:${port}/status`);
  assert.equal(typeof status.uptimeMs, 'number');
  // A finite, non-negative number — `>= 0` alone is vacuous for an uptime; this also rejects NaN/Infinity
  // (which a broken `Date.now() - startedAt` could produce) (audit 2026-06-14).
  assert.ok(Number.isFinite(status.uptimeMs) && status.uptimeMs >= 0, `uptimeMs is finite & ≥0 (got ${status.uptimeMs})`);
  assert.equal(status.bots, 0);
  assert.deepEqual(status.queues, { llm: 0 });
});

test('GET /journal filters by kind/actor/ref/limit', async (t) => {
  const journal = new MemoryJournal();
  const admin = new AdminServer({ port: 0, journal });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  journal.append('engine', 'system.error', { message: 'a' });
  journal.append('villager:Firmin', 'system.bot-connected', { name: 'Firmin' }, { rolloutId: 'R1' });
  journal.append('engine', 'system.error', { message: 'b' });

  const all = await getJson(`http://127.0.0.1:${port}/journal`);
  assert.equal(all.events.length, 3);

  const errs = await getJson(`http://127.0.0.1:${port}/journal?kinds=system.error`);
  assert.equal(errs.events.length, 2);

  const byActor = await getJson(`http://127.0.0.1:${port}/journal?actor=villager:Firmin`);
  assert.equal(byActor.events.length, 1);

  const byRef = await getJson(`http://127.0.0.1:${port}/journal?ref=R1`);
  assert.equal(byRef.events[0].actor, 'villager:Firmin');

  const limited = await getJson(`http://127.0.0.1:${port}/journal?limit=1`);
  assert.equal(limited.events.length, 1);
  assert.equal(limited.events[0].payload.message, 'b'); // most recent
});

// Bug #17: GET /journal without a limit used to read + serialize the WHOLE table in one request.
test('GET /journal is capped: default JOURNAL_DEFAULT_LIMIT most-recent events, explicit limits clamped to the max', async (t) => {
  const journal = new MemoryJournal();
  const admin = new AdminServer({ port: 0, journal });
  const { port } = await admin.start();
  t.after(() => admin.stop());
  for (let i = 0; i < JOURNAL_DEFAULT_LIMIT + 5; i++) journal.append('engine', 'system.error', { message: `m${i}` });

  const dflt = await getJson(`http://127.0.0.1:${port}/journal`);
  assert.equal(dflt.events.length, JOURNAL_DEFAULT_LIMIT);
  assert.equal(dflt.events[0].payload.message, 'm5', 'the cap keeps the most recent events, still chronological');
  const huge = await getJson(`http://127.0.0.1:${port}/journal?limit=999999999`);
  assert.equal(huge.events.length, JOURNAL_DEFAULT_LIMIT + 5, 'below the max cap, an explicit limit is honoured');
  for (let i = JOURNAL_DEFAULT_LIMIT + 5; i < JOURNAL_MAX_LIMIT + 5; i++) journal.append('engine', 'system.error', { message: `m${i}` });
  const clamped = await getJson(`http://127.0.0.1:${port}/journal?limit=999999999`);
  assert.equal(clamped.events.length, JOURNAL_MAX_LIMIT, 'an explicit limit above the max is clamped');
  const junk = await getJson(`http://127.0.0.1:${port}/journal?limit=abc`);
  assert.equal(junk.events.length, JOURNAL_DEFAULT_LIMIT, 'a junk limit falls back to the default');
});

test('GET /journal?order=desc returns newest-first — the dashboard live-feed order', async (t) => {
  const journal = new MemoryJournal();
  const admin = new AdminServer({ port: 0, journal });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  journal.append('engine', 'system.error', { message: 'a' });
  journal.append('engine', 'system.error', { message: 'b' });
  journal.append('engine', 'system.error', { message: 'c' });

  const desc = await getJson(`http://127.0.0.1:${port}/journal?order=desc`);
  assert.deepEqual(desc.events.map((e: any) => e.payload.message), ['c', 'b', 'a']);

  const top2 = await getJson(`http://127.0.0.1:${port}/journal?order=desc&limit=2`);
  assert.deepEqual(top2.events.map((e: any) => e.payload.message), ['c', 'b'], 'the 2 newest, newest-first');

  const asc = await getJson(`http://127.0.0.1:${port}/journal`);
  assert.deepEqual(asc.events.map((e: any) => e.payload.message), ['a', 'b', 'c'], 'default stays chronological');
});

test('GET /kinds exposes the registry so the website can render unknown kinds', async (t) => {
  const journal = new MemoryJournal();
  const admin = new AdminServer({ port: 0, journal });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const kinds = await getJson(`http://127.0.0.1:${port}/kinds`);
  assert.ok(Array.isArray(kinds.kinds));
  assert.ok(kinds.kinds.some((k: { kind: string }) => k.kind === 'system.loop-lag'));
});

test('WS /journal/stream fans out appended events live, with optional ?kinds filter', async (t) => {
  const journal = new MemoryJournal();
  const admin = new AdminServer({ port: 0, journal });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const ws = new WebSocket(`ws://127.0.0.1:${port}/journal/stream?kinds=system.error`);
  await once(ws, 'open');
  const received: any[] = [];
  ws.on('message', (data) => received.push(JSON.parse(String(data))));

  journal.append('engine', 'system.bot-connected', { name: 'X' }); // filtered out
  journal.append('engine', 'system.error', { message: 'live' }); // delivered
  await delay(60);

  assert.equal(received.length, 1);
  assert.equal(received[0].payload.message, 'live');
  ws.close();
});
