// Coverage for bots/helpers.ts branches not reached by bots-helpers.test.ts:
//   • goToHops throws a precise S10 error when the bot has no pathfinder plugin (R16)
//   • goToHops throws a precise S10 error when the bot has no entity body (disconnected/dead)
//   • collectTrunk stops at the maxHeight cap even if the column continues (R10)
//   • useChest throws a precise S10 error when there is no block at the chest position (R8)

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeBot } from './fakes/fake-bot';
import { goToHops, collectTrunk, useChest } from '../src/bots/helpers';

// ── goToHops error paths (S10) ───────────────────────────────────────────────

test('goToHops throws when the bot has no pathfinder plugin (S10/R16)', async () => {
  const bot = new FakeBot();
  // Simulate a failed pathfinder load — plugin is absent (R16).
  (bot as any).pathfinder = undefined;

  await assert.rejects(
    () => goToHops(bot, { x: 10, y: 64, z: 10 }),
    (err: unknown) => err instanceof Error && /pathfinder/.test(err.message),
    'should throw with "pathfinder" in the message (S10)',
  );
});

test('goToHops throws when the bot has no entity (disconnected/dead) (S10)', async () => {
  const bot = new FakeBot();
  // Simulate a dead/disconnected bot — no entity (body).
  (bot as any).entity = undefined;

  await assert.rejects(
    () => goToHops(bot, { x: 10, y: 64, z: 10 }),
    (err: unknown) => err instanceof Error && /no body/.test(err.message),
    'should throw with "no body" in the message (S10)',
  );
});

// ── collectTrunk maxHeight cap (R10) ─────────────────────────────────────────

test('collectTrunk stops at maxHeight even when the column continues above it (R10)', async () => {
  const bot = new FakeBot({ position: { x: 0, y: 64, z: 0 } });
  // Plant a trunk 10 blocks tall; set maxHeight to 4.
  bot.plantTree({ x: 0, y: 64, z: 0 }, 10);

  const dug = await collectTrunk(bot, { x: 0, y: 64, z: 0 }, { maxHeight: 4 });

  assert.equal(dug, 4, 'exactly maxHeight blocks dug');
  // Blocks within the cap are removed.
  for (let dy = 0; dy < 4; dy++) {
    assert.equal(bot.blockAt({ x: 0, y: 64 + dy, z: 0 }), null, `dy=${dy} was dug`);
  }
  // Blocks above the cap are untouched.
  assert.equal(bot.blockAt({ x: 0, y: 68, z: 0 })?.name, 'oak_log', 'dy=4 untouched by maxHeight cap');
});

// ── useChest error when no block at position (S10/R8) ────────────────────────

test('useChest throws a clear S10 error when the block at chestPos is null (R8)', async () => {
  const bot = new FakeBot({ position: { x: 0, y: 64, z: 0 } });
  // No block set at (5, 64, 5) — chunk unloaded or chest was removed.
  const chestPos = { x: 5, y: 64, z: 5 };

  await assert.rejects(
    () => useChest(bot, chestPos, async () => 'unused'),
    (err: unknown) => err instanceof Error && /no block/.test(err.message),
    'should throw with "no block" when the chest position is empty (S10/R8)',
  );
});
