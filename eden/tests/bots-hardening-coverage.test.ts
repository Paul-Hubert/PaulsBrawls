// Coverage for bots/hardening.ts branches not reached by bots-hardening.test.ts:
//   • waitForInventoryQuiescence HARD-TIMEOUT valve (R39) — packets never settle
//   • abortActiveTasks continues when pvp.stop() rejects (R5)
//   • craftQuiescence restores mutators in the finally path when fn() throws (R3)

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeBot } from './fakes/fake-bot';
import { abortActiveTasks, craftQuiescence, waitForInventoryQuiescence } from '../src/bots/hardening';

// ── waitForInventoryQuiescence hard-timeout valve (R39) ─────────────────────

test('waitForInventoryQuiescence resolves via hard-timeout when packets never stop (R39)', async () => {
  const bot = new FakeBot();
  // Keep emitting packets at 20 ms intervals — the quiet timer can never settle.
  // The hard timeout (50 ms) must fire and resolve instead.
  const interval = setInterval(() => bot.packetSetSlot(0, 0, null), 20);
  const started = Date.now();
  // quietMs=200 (never reached); timeoutMs=50 (fires first — the R39 safety valve).
  await waitForInventoryQuiescence(bot, { quietMs: 200, timeoutMs: 50 });
  clearInterval(interval);
  const elapsed = Date.now() - started;
  // Resolved via hard timeout: elapsed ≥ timeoutMs and well below quietMs.
  assert.ok(elapsed >= 45, `hard-timeout fired too early (${elapsed} ms)`);
  assert.ok(elapsed < 180, `hard-timeout fired way too late (${elapsed} ms) — was it the quiet timer?`);
});

// ── abortActiveTasks continues past a rejecting pvp.stop() (R5) ─────────────

test('abortActiveTasks continues the abort sequence when pvp.stop() rejects (R5)', async () => {
  const bot = new FakeBot();
  // Replace pvp with a version that rejects on stop — the catch in abortActiveTasks must
  // swallow this and continue with pathfinder.stop() → setGoal(null) (R4/R5).
  (bot as any).pvp = {
    stop: async (): Promise<void> => {
      bot.calls.push('pvp.stop');
      throw new Error('pvp stop failed');
    },
  };

  // The abort must not reject even though pvp.stop() does (R5).
  await assert.doesNotReject(abortActiveTasks(bot));

  // pvp.stop was called (the call was attempted).
  assert.ok(bot.calls.includes('pvp.stop'), 'pvp.stop was invoked');
  // The remaining abort steps must have run despite the pvp rejection (R4/R5).
  assert.ok(bot.calls.includes('pathfinder.stop'), 'pathfinder.stop ran after pvp rejection');
  assert.ok(bot.calls.includes('pathfinder.setGoal(null)'), 'pathfinder.setGoal(null) ran after pvp rejection');
});

// ── craftQuiescence finally path when fn() throws (R3) ───────────────────────

test('craftQuiescence restores auto-eat and armor-manager in the finally path when fn() throws (R3)', async () => {
  const bot = new FakeBot();

  let mutatorsPausedWhenFnThrew = false;
  const boom = new Error('craft fn exploded');

  await assert.rejects(
    () =>
      craftQuiescence(
        bot,
        async () => {
          // During fn(): mutators must be paused (R3).
          mutatorsPausedWhenFnThrew = bot.autoEat.enabled === false && bot.armorManager.paused === true;
          throw boom;
        },
        { quietMs: 30, timeoutMs: 500 },
      ),
    (err: unknown) => err === boom,
    'the original error propagates',
  );

  assert.equal(mutatorsPausedWhenFnThrew, true, 'mutators were paused during fn() (R3)');
  // Despite the throw, the finally block must have restored both mutators.
  assert.equal(bot.autoEat.enabled, true, 'auto-eat restored after fn() threw (R3)');
  assert.equal(bot.armorManager.paused, false, 'armor-manager resumed after fn() threw (R3)');
});
