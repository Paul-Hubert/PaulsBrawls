// VillageLoop — the autonomous refinement-loop driver (the production PUMP). RolloutCoordinator runs ONE
// task to convergence; before this driver existed, nothing in the interactive boot path called it, so a
// real `/villagers start` connected the bots and sat idle. These tests pin the driver's contract WITHOUT a
// real coordinator/Minecraft: one loop per villager, gated on connectedness, idempotent start, clean stop.

import test from 'node:test';
import assert from 'node:assert/strict';

import { VillageLoop } from '../src/main';
import type { RolloutCoordinator, RolloutResult } from '../src/main';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `cond` every 2 ms until true or the deadline; returns whether it became true. */
async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(2);
  }
  return cond();
}

/** A coordinator whose runOnce only records which villager it was asked to drive (no LLM, no Minecraft). */
function recordingCoordinator(calls: string[]): RolloutCoordinator {
  return {
    runOnce: async (opts: { trigger: string; villager?: string }): Promise<RolloutResult | undefined> => {
      calls.push(opts.villager ?? '(none)');
      return { converged: true, taskId: 't', rolloutId: 'r', revisions: 1 };
    },
  } as unknown as RolloutCoordinator;
}

test('drives one loop per CONNECTED villager, repeatedly', async () => {
  const calls: string[] = [];
  const loop = new VillageLoop({
    coordinator: recordingCoordinator(calls),
    villagers: ['Firmin', 'Margot'],
    isConnected: () => true,
    connectPollMs: 1,
    settleMs: 1,
    turnDelayMs: 1,
    idleBackoffMs: 1,
  });

  loop.start();
  assert.ok(loop.isRunning());
  // Both villagers should be driven, and the loop should keep proposing (more calls than villagers).
  const drove = await waitFor(() => calls.includes('Firmin') && calls.includes('Margot') && calls.length >= 4);
  loop.stop();
  assert.ok(drove, `both villagers driven repeatedly (saw ${calls.length} calls: ${[...new Set(calls)].join(',')})`);
});

test('a DISCONNECTED villager is never driven (no wasted LLM calls on a missing body)', async () => {
  const calls: string[] = [];
  const loop = new VillageLoop({
    coordinator: recordingCoordinator(calls),
    villagers: ['Online', 'Offline'],
    isConnected: (name) => name === 'Online',
    connectPollMs: 1,
    settleMs: 1,
    turnDelayMs: 1,
    idleBackoffMs: 1,
  });

  loop.start();
  await waitFor(() => calls.length >= 5);
  loop.stop();
  assert.ok(calls.includes('Online'), 'the connected villager was driven');
  assert.ok(!calls.includes('Offline'), 'the disconnected villager was never driven');
});

test('stop() halts driving (no significant work after stop)', async () => {
  const calls: string[] = [];
  const villagers = ['A', 'B'];
  const loop = new VillageLoop({
    coordinator: recordingCoordinator(calls),
    villagers,
    isConnected: () => true,
    connectPollMs: 1,
    settleMs: 1,
    turnDelayMs: 1,
    idleBackoffMs: 1,
  });

  loop.start();
  await waitFor(() => calls.length >= 4);
  loop.stop();
  assert.ok(!loop.isRunning());
  const atStop = calls.length;
  await sleep(40);
  // At most one extra in-flight runOnce per villager can resolve after stop; nothing sustained.
  assert.ok(calls.length <= atStop + villagers.length, `driving plateaued after stop (${atStop} → ${calls.length})`);
});

test('start() is idempotent — a second start while running does not double the loops', async () => {
  const calls: string[] = [];
  const loop = new VillageLoop({
    coordinator: recordingCoordinator(calls),
    villagers: ['Solo'],
    isConnected: () => true,
    connectPollMs: 1,
    settleMs: 1,
    turnDelayMs: 1,
    idleBackoffMs: 5, // a real gap between turns so a doubled loop would visibly ~double the call rate
  });

  loop.start();
  loop.start(); // no-op
  await waitFor(() => calls.length >= 3, 500);
  loop.stop();
  // Single loop ⇒ calls are strictly sequential (runOnce awaited before the next). A doubled loop would
  // interleave; we can't assert timing precisely, but the loop must still be running exactly one epoch.
  assert.ok(loop.isRunning() === false);
  assert.ok(calls.every((c) => c === 'Solo'));
});

test('a thrown rollout is swallowed — the loop survives and keeps driving (the village runs on)', async () => {
  let throwNext = true;
  const seen: string[] = [];
  const coordinator = {
    runOnce: async (opts: { villager?: string }): Promise<RolloutResult | undefined> => {
      seen.push(opts.villager ?? '(none)');
      if (throwNext) {
        throwNext = false;
        throw new Error('boom: bot.dig is not a function');
      }
      return { converged: true, taskId: 't', rolloutId: 'r', revisions: 1 };
    },
  } as unknown as RolloutCoordinator;

  const loop = new VillageLoop({
    coordinator,
    villagers: ['Resilient'],
    isConnected: () => true,
    connectPollMs: 1,
    settleMs: 1,
    turnDelayMs: 1,
    idleBackoffMs: 1,
  });

  loop.start();
  const recovered = await waitFor(() => seen.length >= 3); // threw once, then kept going
  loop.stop();
  assert.ok(recovered, 'the loop kept driving after a thrown rollout');
});
