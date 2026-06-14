import test from 'node:test';
import assert from 'node:assert/strict';

import { LlmScheduler, BudgetTracker, RateCappedError } from '../src/llm/scheduler';

/** A controllable async task: resolves only when release() is called. */
function gate(): { run: () => Promise<string>; release: (v?: string) => void; started: () => boolean } {
  let started = false;
  let resolveFn: (v: string) => void;
  const p = new Promise<string>((res) => (resolveFn = res));
  return {
    run: () => {
      started = true;
      return p;
    },
    release: (v = 'ok') => resolveFn(v),
    started: () => started,
  };
}

test('M2-L3: respects the global concurrency cap', async () => {
  const sched = new LlmScheduler({ maxConcurrent: 2, perVillagerCooldownMs: 0 });
  const gates = [gate(), gate(), gate(), gate()];
  gates.forEach((g, i) => void sched.enqueue({ villager: `v${i}`, lane: 'job', kind: 'k', run: g.run }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(gates.filter((g) => g.started()).length, 2, 'only maxConcurrent run at once');
  gates[0]!.release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(gates.filter((g) => g.started()).length, 3, 'a freed slot starts the next');
  gates.forEach((g) => g.release());
});

test('M7: pause halts LLM scheduling; resume drains the held queue', async () => {
  const sched = new LlmScheduler({ maxConcurrent: 2, perVillagerCooldownMs: 0 });
  assert.equal(sched.isPaused(), false);
  sched.pause();
  assert.equal(sched.isPaused(), true);
  const gates = [gate(), gate()];
  gates.forEach((g, i) => void sched.enqueue({ villager: `v${i}`, lane: 'job', kind: 'k', run: g.run }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(gates.filter((g) => g.started()).length, 0, 'nothing runs while paused');
  assert.equal(sched.pending(), 2, 'work is held in the queue, not dropped');
  sched.resume();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(gates.filter((g) => g.started()).length, 2, 'resume drains the held queue');
  gates.forEach((g) => g.release());
});

test('M7: pause also holds god/rollout (LLM scheduling is fully gated)', async () => {
  const sched = new LlmScheduler({ maxConcurrent: 2, perVillagerCooldownMs: 0 });
  sched.pause();
  const g = gate();
  void sched.enqueue({ villager: 'god:critic', lane: 'god', kind: 'verdict', run: g.run, rolloutId: 'R1' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.started(), false, 'even bypass work is held — pause gates ALL LLM scheduling');
  sched.resume();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.started(), true);
  g.release();
});

test('M2-L3: drains higher-priority lanes first (player > job > idle)', async () => {
  const sched = new LlmScheduler({ maxConcurrent: 1, perVillagerCooldownMs: 0 });
  const order: string[] = [];
  const make = (label: string): (() => Promise<void>) => () => {
    order.push(label);
    return Promise.resolve();
  };
  // Enqueue lowest-priority FIRST; ordering must be by lane, not arrival.
  const p1 = sched.enqueue({ villager: 'a', lane: 'idle', kind: 'k', run: make('idle') });
  const p2 = sched.enqueue({ villager: 'b', lane: 'job', kind: 'k', run: make('job') });
  const p3 = sched.enqueue({ villager: 'c', lane: 'player', kind: 'k', run: make('player') });
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ['player', 'job', 'idle']);
});

test('M2-L3: God desk calls preempt villager lanes (03 §Cost control)', async () => {
  const sched = new LlmScheduler({ maxConcurrent: 1, perVillagerCooldownMs: 0 });
  const order: string[] = [];
  const make = (label: string): (() => Promise<void>) => () => {
    order.push(label);
    return Promise.resolve();
  };
  const a = sched.enqueue({ villager: 'Firmin', lane: 'player', kind: 'k', run: make('villager-player') });
  const b = sched.enqueue({ villager: 'god:critic', lane: 'god', kind: 'verdict', run: make('god') });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['god', 'villager-player'], 'god outranks even the player lane');
});

test('M2-L3: coalesces same-(villager,kind) wake-ups into one run', async () => {
  const sched = new LlmScheduler({ maxConcurrent: 1, perVillagerCooldownMs: 0 });
  let runs = 0;
  const g = gate();
  const slow = (): Promise<string> => {
    runs++;
    return g.run();
  };
  const first = sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'heartbeat', run: slow });
  // A second identical-kind wake-up arrives while the first is queued → coalesced.
  const second = sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'heartbeat', run: () => Promise.resolve('other') });
  g.release('shared');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(runs, 1, 'the duplicate wake-up did not run a second time');
  assert.equal(a, 'shared');
  assert.equal(b, 'shared', 'the coalesced caller gets the same result');
});

test('M2-L3: rollout immunity bypasses coalescing (the density invariant)', async () => {
  const sched = new LlmScheduler({ maxConcurrent: 2, perVillagerCooldownMs: 0 });
  let runs = 0;
  const count = (): Promise<number> => Promise.resolve(++runs);
  const a = sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'revise', run: count, rolloutId: 'r1' });
  const b = sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'revise', run: count, rolloutId: 'r1' });
  await Promise.all([a, b]);
  assert.equal(runs, 2, 'rollout turns never coalesce — every revision runs');
});

test('M2-L3: per-villager cooldown spaces out a villager’s runs', async () => {
  const sched = new LlmScheduler({ maxConcurrent: 4, perVillagerCooldownMs: 60 });
  const t: number[] = [];
  const stamp = (): Promise<void> => {
    t.push(Date.now());
    return Promise.resolve();
  };
  // Two different kinds (so no coalescing) for the SAME villager → the cooldown serializes them.
  await sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'k1', run: stamp });
  await sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'k2', run: stamp });
  assert.equal(t.length, 2);
  assert.ok(t[1]! - t[0]! >= 50, `second run waited the cooldown (got ${t[1]! - t[0]!}ms)`);
});

test('R36: the per-minute rate cap throttles a burst but resets every minute (release valve)', async () => {
  let clock = 1_000_000;
  const sched = new LlmScheduler({ maxConcurrent: 4, perVillagerCooldownMs: 0, rateCapPerMinute: 2, now: () => clock });
  const ok = (): Promise<string> => Promise.resolve('ran');
  await sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'a', run: ok });
  await sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'b', run: ok });
  // Third wake-up this minute → suppressed (the dumb circuit breaker).
  await assert.rejects(
    sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'c', run: ok }),
    (e: unknown) => e instanceof RateCappedError,
  );
  // A different villager is unaffected (the cap is per-villager).
  assert.equal(await sched.enqueue({ villager: 'Colette', lane: 'job', kind: 'a', run: ok }), 'ran');
  // Next minute → the valve resets (R36: never a permanent gag).
  clock += 60_000;
  assert.equal(await sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'd', run: ok }), 'ran');
});

test('R36: God + rollout-immune calls bypass the rate cap entirely', async () => {
  const clock = 1_000_000;
  const sched = new LlmScheduler({ maxConcurrent: 4, perVillagerCooldownMs: 0, rateCapPerMinute: 1, now: () => clock });
  const ok = (): Promise<string> => Promise.resolve('ran');
  await sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'a', run: ok });
  // Over the cap, but rollout-immune → runs anyway (density invariant).
  assert.equal(await sched.enqueue({ villager: 'Firmin', lane: 'job', kind: 'b', run: ok, rolloutId: 'r1' }), 'ran');
  // God desk likewise bypasses.
  assert.equal(await sched.enqueue({ villager: 'god:critic', lane: 'god', kind: 'v', run: ok }), 'ran');
});

// ── BudgetTracker skeleton (caps consumed in M4-4 / D-13) ────────────────────
test('M2-L3: BudgetTracker tracks per-desk spend; null = uncapped (R49/D-13)', () => {
  const b = new BudgetTracker({ critic: { dailyTokens: 100 }, curriculum: { dailyTokens: null }, orchestrator: { dailyTokens: null } });
  assert.equal(b.degraded('critic'), false);
  b.spend('critic', 60);
  assert.equal(b.degraded('critic'), false);
  b.spend('critic', 60); // 120 > 100
  assert.equal(b.degraded('critic'), true, 'over the daily cap → degraded mode');
  // A null cap never degrades (the throughput ceiling is the real limiter — R49).
  b.spend('curriculum', 10_000_000);
  assert.equal(b.degraded('curriculum'), false);
  // A new day resets the accumulator.
  b.resetDay();
  assert.equal(b.degraded('critic'), false);
});
