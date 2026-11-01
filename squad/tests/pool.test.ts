// The login stagger (I1, docs/36 §6): logins at least staggerMs apart, counted from the last connect whatever drain
// made it. A spawn that arrived after the queue had emptied used to connect at once, so a squad or a raid, spawned
// one bot per request, logged in all together.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BotPool } from '../src/bots/pool';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { until } from './fakes/harness';

holdEventLoopPerTest();

const STAGGER = 80;
/** setTimeout may fire a millisecond early on some platforms. */
const SLACK = 5;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pool(connects: Array<{ name: string; at: number }>): BotPool {
  return new BotPool({
    host: 'x',
    port: 1,
    staggerMs: STAGGER,
    setup: () => undefined,
    createBot: (req) => {
      connects.push({ name: req.username, at: Date.now() });
      const b = new FakeBot(req.username);
      setTimeout(() => b.emit('spawn'), 1);
      return b as never;
    },
  });
}

function gaps(connects: Array<{ at: number }>): number[] {
  return connects.slice(1).map((c, i) => c.at - (connects[i] as { at: number }).at);
}

test('bots added one at a time, each after the previous login started, still log in staggerMs apart', async () => {
  const connects: Array<{ name: string; at: number }> = [];
  const p = pool(connects);
  for (const name of ['Garde01', 'Garde02', 'Garde03', 'Garde04']) {
    p.add(name);
    // What /api/bots/spawn does: one request per bot, the next after the answer (the queue is empty again).
    await sleep(5);
  }
  await until(() => connects.length === 4, 2_000, 'four logins');
  assert.deepEqual(connects.map((c) => c.name), ['Garde01', 'Garde02', 'Garde03', 'Garde04']);
  for (const g of gaps(connects)) assert.ok(g >= STAGGER - SLACK, `logins ${g} ms apart, want ≥ ${STAGGER}: ${gaps(connects).join(', ')}`);
  p.stop();
});

test('bots queued together log in staggerMs apart, the first at once', async () => {
  const connects: Array<{ name: string; at: number }> = [];
  const p = pool(connects);
  const t0 = Date.now();
  for (const name of ['A', 'B', 'C']) p.add(name);
  await until(() => connects.length === 3, 2_000, 'three logins');
  assert.ok((connects[0] as { at: number }).at - t0 < STAGGER / 2, 'the first login waits for nothing');
  for (const g of gaps(connects)) assert.ok(g >= STAGGER - SLACK, `logins ${g} ms apart, want ≥ ${STAGGER}`);
  p.stop();
});

test('a bot added long after the last login connects at once', async () => {
  const connects: Array<{ name: string; at: number }> = [];
  const p = pool(connects);
  p.add('First');
  await until(() => connects.length === 1, 1_000, 'first login');
  await sleep(STAGGER + 20);
  const t = Date.now();
  p.add('Later');
  await until(() => connects.length === 2, 1_000, 'second login');
  assert.ok((connects[1] as { at: number }).at - t < STAGGER / 2, 'no wait when the stagger has already passed');
  p.stop();
});
