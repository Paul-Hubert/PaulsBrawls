import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeBot } from './fakes/fake-bot';
import { goToHops, collectTrunk, deposit, withdraw, MAX_HOP_BLOCKS } from '../src/bots/helpers';

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

test('goToHops walks a far goal in legs of ≤40 blocks (R7)', async () => {
  const bot = new FakeBot({ position: { x: 0, y: 64, z: 0 } });
  const target = { x: 200, y: 64, z: 0 };
  await goToHops(bot, target, 1);

  // Every consecutive leg (start → wp1 → wp2 → … → target) must be ≤ the hop cap.
  const legs = [{ x: 0, y: 64, z: 0 }, ...bot.pathfinder.gotoGoals];
  for (let i = 1; i < legs.length; i++) {
    assert.ok(
      dist(legs[i - 1]!, legs[i]!) <= MAX_HOP_BLOCKS + 1e-6,
      `leg ${i} is ${dist(legs[i - 1]!, legs[i]!).toFixed(1)} blocks — exceeds the ${MAX_HOP_BLOCKS} cap`,
    );
  }
  // The final goal is the target itself.
  const last = bot.pathfinder.gotoGoals.at(-1)!;
  assert.ok(dist(last, target) <= 1, 'final hop lands on the target');
});

test('goToHops a near goal is a single hop (no needless legs)', async () => {
  const bot = new FakeBot({ position: { x: 0, y: 64, z: 0 } });
  await goToHops(bot, { x: 10, y: 64, z: 5 }, 1);
  assert.equal(bot.pathfinder.gotoGoals.length, 1, 'one goto for an already-close target');
});

test('collectTrunk digs the grounded column only, skipping floating logs (R10)', async () => {
  const bot = new FakeBot({ position: { x: 0, y: 64, z: 0 } });
  const base = { x: 0, y: 64, z: 0 };
  bot.plantTree(base, 4, [
    { x: 3, y: 70, z: 3 }, // floating leaf-log, NOT column-connected
    { x: 0, y: 80, z: 0 }, // a log far above a gap — also not contiguous
  ]);
  const dug = await collectTrunk(bot, base);
  assert.equal(dug, 4, 'all four trunk blocks dug');
  for (let dy = 0; dy < 4; dy++) {
    assert.equal(bot.blockAt({ x: 0, y: 64 + dy, z: 0 }), null, `trunk block dy=${dy} removed`);
  }
  assert.equal(bot.blockAt({ x: 3, y: 70, z: 3 })?.name, 'oak_log', 'floating leaf-log untouched (R10)');
  assert.equal(bot.blockAt({ x: 0, y: 80, z: 0 })?.name, 'oak_log', 'log above the gap untouched (R10)');
});

test('collectTrunk skips a failed dig and keeps going (skip-on-failure, R10)', async () => {
  const bot = new FakeBot({ position: { x: 0, y: 64, z: 0 } });
  bot.plantTree({ x: 0, y: 64, z: 0 }, 3);
  bot.setDigMode('reject'); // every dig rejects
  const dug = await collectTrunk(bot, { x: 0, y: 64, z: 0 });
  assert.equal(dug, 0, 'no successful digs, but the call resolves (did not throw)');
});

test('deposit moves items from inventory into the chest (via useChest)', async () => {
  const bot = new FakeBot({ position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'oak_log', count: 10 }] });
  const chestPos = { x: 2, y: 64, z: 0 };
  bot.setBlock(chestPos, 'chest');
  await deposit(bot, chestPos, [{ name: 'oak_log', count: 6 }]);
  assert.equal(bot.countItem('oak_log'), 4, 'inventory reduced');
  assert.equal(bot.chestContents(chestPos).find((i) => i.name === 'oak_log')?.count, 6, 'chest gained the items');
  assert.equal(bot.currentWindow, null, 'chest window closed after the op');
});

test('withdraw moves items from the chest into inventory (via useChest)', async () => {
  const bot = new FakeBot({ position: { x: 0, y: 64, z: 0 } });
  const chestPos = { x: 2, y: 64, z: 0 };
  bot.setBlock(chestPos, 'chest');
  bot.setChestContents(chestPos, [{ name: 'wheat', count: 8 }]);
  await withdraw(bot, chestPos, [{ name: 'wheat', count: 5 }]);
  assert.equal(bot.countItem('wheat'), 5, 'inventory gained the items');
  assert.equal(bot.chestContents(chestPos).find((i) => i.name === 'wheat')?.count, 3, 'chest reduced');
});
