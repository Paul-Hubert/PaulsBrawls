// Pins the RecordingBot's SEAMS (docs/26 B2): the recorder arrays, the fault-injection knobs, the
// live-mutable state stubs, and — crucially — the INERTNESS of the world-model surface (findBlock/
// findBlocks/openContainer/activateBlock must never simulate the world again; that job moved to the
// skill tier on a real server). Replaces the surviving halves of fakes.test.ts when FakeBot's
// world-model half dies in B7.

import assert from 'node:assert/strict';
import test from 'node:test';

import { RecordingBot } from './fakes/recording-bot';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('emits path_update on a timer without moving (D-10 fault seam)', async () => {
  const bot = new RecordingBot({ position: { x: 1, y: 64, z: 1 } });
  const updates: unknown[] = [];
  bot.on('path_update', (u) => updates.push(u));
  const stop = bot.startPathUpdates(10);
  // Deadline-based, not sleep-based — a loaded suite runner can starve a 10ms timer (timing flake).
  const t0 = Date.now();
  while (updates.length < 3 && Date.now() - t0 < 2000) await sleep(10);
  stop();
  assert.ok(updates.length >= 3, `expected ≥3 path_updates within 2s, got ${updates.length}`);
  assert.deepEqual(bot.entity.position, { x: 1, y: 64, z: 1 }, 'position must NOT move');
});

test('dig: never-resolving mode emits exactly one start pulse; resolve mode clears the SEEDED block (D-10)', async () => {
  const bot = new RecordingBot();
  const pos = { x: 0, y: 63, z: 0 };
  bot.setBlock(pos, 'stone');
  const starts: unknown[] = [];
  bot.on('diggingStarted', (b) => starts.push(b));

  bot.setDigMode('never');
  let settled = false;
  void bot.dig(bot.blockAt(pos)!).then(() => (settled = true));
  await sleep(30);
  assert.equal(settled, false, 'never-mode dig must not resolve');
  assert.equal(starts.length, 1, 'exactly one start pulse');
  assert.ok(bot.blockAt(pos), 'never-mode leaves the seeded block in place');

  bot.setDigMode('resolve');
  await bot.dig(bot.blockAt(pos)!);
  assert.equal(bot.blockAt(pos), null, 'resolve-mode removes the seeded block (live-mutable map)');

  bot.setDigMode('reject');
  bot.setBlock(pos, 'stone');
  await assert.rejects(bot.dig(bot.blockAt(pos)!), /dig FAILED/);
});

test('routes clicks to the OPEN window regardless of intent (R1 recorder seam)', () => {
  const bot = new RecordingBot();
  bot.openWindow({ id: 7, type: 'minecraft:chest' });
  void bot.clickWindow(3, 0, 0);
  assert.deepEqual(bot.clicks[0], { slot: 3, mouseButton: 0, mode: 0, routedTo: 7 });
  bot.closeWindow();
  void bot.clickWindow(4, 0, 0);
  assert.equal(bot.clicks[1]!.routedTo, null, 'no open window → routedTo null');
});

test('packet seams fire on _client (R2 quiescence signals)', () => {
  const bot = new RecordingBot();
  const seen: string[] = [];
  bot._client.on('set_slot', () => seen.push('set_slot'));
  bot._client.on('window_items', () => seen.push('window_items'));
  bot.packetSetSlot(0, 0, { name: 'bread', count: 1 });
  bot.packetWindowItems(0, []);
  assert.deepEqual(seen, ['set_slot', 'window_items']);
});

test('inventory is LIVE state: give → items()/countItem reflect it both ways (P-8)', () => {
  const bot = new RecordingBot({ inventory: [{ name: 'wheat', count: 2 }] });
  bot.give('wheat', 3);
  assert.equal(bot.countItem('wheat'), 5);
  bot.setInventory([]);
  assert.equal(bot.countItem('wheat'), 0);
  assert.deepEqual(bot.inventory.items(), []);
});

test('registry resolves stable ids; setUnknownItems makes a name miss like real mineflayer (D1)', () => {
  const bot = new RecordingBot();
  const id1 = bot.registry.itemsByName['bread']!.id;
  assert.equal(bot.registry.itemsByName['bread']!.id, id1, 'stable id');
  bot.setUnknownItems(['not_a_thing']);
  assert.equal(bot.registry.itemsByName['not_a_thing'], undefined);
  assert.equal(bot.registry.blocksByName!['not_a_thing'], undefined);
});

test('dropLoadBearingPlugin removes the plugin property (R16/FIX-4 seam)', () => {
  const bot = new RecordingBot();
  assert.ok(bot.pvp);
  bot.dropLoadBearingPlugin('pvp');
  assert.equal((bot as { pvp?: unknown }).pvp, undefined);
});

test('the abort-order recorder: calls[] preserves sequence across plugin seams (R4)', async () => {
  const bot = new RecordingBot();
  bot.collectBlock.cancelTask();
  await bot.pvp.stop();
  bot.pathfinder.stop();
  bot.pathfinder.setGoal(null);
  bot.closeWindow();
  assert.deepEqual(bot.calls, ['collectBlock.cancelTask', 'pvp.stop', 'pathfinder.stop', 'pathfinder.setGoal(null)', 'closeWindow']);
});

test('quit emits end (the pool onEnd path); chat is recorded (R25)', () => {
  const bot = new RecordingBot();
  let ended = false;
  bot.on('end', () => (ended = true));
  bot.chat('bonjour');
  bot.quit();
  assert.ok(ended);
  assert.deepEqual(bot.sentChat, ['bonjour']);
  assert.ok(bot.calls.includes('quit'));
});

test('entities seeded via setEntities default isValid:true; pvp.attack flips it (kill-loop terminator)', async () => {
  const bot = new RecordingBot();
  bot.setEntities({ '1': { name: 'zombie', id: 1 } });
  const z = bot.entities['1']!;
  assert.equal(z.isValid, true);
  await bot.pvp.attack(z);
  assert.equal(z.isValid, false);
});

test('INERT: findBlocks/findBlock return empty/null even over seeded blocks — never simulate the palette (R76 → skill tier)', () => {
  const bot = new RecordingBot();
  bot.setBlock({ x: 1, y: 64, z: 1 }, 'wheat');
  assert.deepEqual(bot.findBlocks({ matching: () => true, maxDistance: 64, count: 8 }), []);
  assert.equal(bot.findBlock({ matching: (b) => b.name === 'wheat' }), null);
  assert.ok(bot.blockAt({ x: 1, y: 64, z: 1 }), 'but blockAt still reads the seeded map (live-mutable)');
});

test('INERT: openContainer refuses with a NAMED error (containers are skill-tier now, S10)', async () => {
  const bot = new RecordingBot();
  await assert.rejects(bot.openContainer({ name: 'chest', position: { x: 0, y: 64, z: 0 } }), /containers are INERT/);
});

test('INERT: activateBlock records and resolves but flips NO block; the R55 delay KNOB survives', async () => {
  const bot = new RecordingBot();
  const pos = { x: 2, y: 63, z: 2 };
  bot.setBlock(pos, 'dirt');
  await bot.equip({ name: 'iron_hoe' });
  assert.deepEqual(bot.heldItem, { name: 'iron_hoe' });
  await bot.activateBlock(bot.blockAt(pos)!);
  await sleep(60); // past FakeBot's old default flip delay — nothing may happen
  assert.equal(bot.blockAt(pos)!.name, 'dirt', 'no farm model: the block must NOT flip');
  assert.ok(bot.calls.includes('activateBlock'));
  bot.setActivateDelayMs(500);
  assert.equal(bot.activateDelay(), 500, 'the R55 fault seam (the knob) survives the split');
});

test('craft records routing + pause state and confirms via the packet seam (R1–R3 recorder)', async () => {
  const bot = new RecordingBot();
  const packets: unknown[] = [];
  bot._client.on('set_slot', (p) => packets.push(p));
  bot.openWindow({ id: 2, type: 'minecraft:crafting' });
  bot.autoEat.disableAuto();
  bot.armorManager.pause();
  const [recipe] = bot.recipesFor('stick');
  await bot.craft(recipe!, 4);
  assert.deepEqual(bot.crafted[0], { recipe: 'stick', count: 4, routedWindow: 2, autoEatEnabledAtCraft: false, armorPausedAtCraft: true });
  assert.equal(bot.countItem('stick'), 4);
  assert.equal(packets.length, 1);
});
