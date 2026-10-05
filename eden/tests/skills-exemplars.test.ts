import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { SkillLibrary, AllGranted } from '../src/skills/library';
import { SkillEngine } from '../src/skills/engine';
import { compile } from '../src/skills/instrument';
import { STOCK_SKILLS, seedStockSkills } from '../src/skills/exemplars/index';
import type { RunnerRef } from '../src/types/index';
import { holdEventLoopPerTest } from './fakes/keep-alive';

// R73: several tests await promises that only unref'd timers resolve — keep the loop alive per test.
holdEventLoopPerTest();

const MORTAL: RunnerRef = { name: 'Firmin', role: 'farmer', tier: 'mortal' };

function harness(bot: FakeBot): { engine: SkillEngine; library: SkillLibrary } {
  const dir = mkdtempSync(join(tmpdir(), 'eden-exemplars-'));
  const library = new SkillLibrary({ dataDir: dir, journal: new MemoryJournal(), probationRuns: 3 });
  seedStockSkills(library);
  const engine = new SkillEngine({
    library,
    journal: new MemoryJournal(),
    grants: new AllGranted(),
    resolveBot: () => bot,
    runDefaultTimeoutMs: 120_000,
    stallSeconds: 20,
    maxCallDepth: 8,
    autoQuarantineAfter: 5,
  });
  return { engine, library };
}

test('M2-6: every stock skill compiles (parse + instrument + factory)', () => {
  for (const s of STOCK_SKILLS) {
    const c = compile(s.code);
    assert.ok(c.ok, `stock skill ${s.name} failed to compile: ${c.ok ? '' : c.error}`);
  }
});

test('M2-6: the curated exemplar set is ~6 mortal teaching skills, each ≤60 lines (S4)', () => {
  const exemplars = STOCK_SKILLS.filter((s) => s.exemplar);
  assert.ok(exemplars.length >= 5 && exemplars.length <= 7, `~6 exemplars (got ${exemplars.length})`);
  for (const s of exemplars) {
    assert.equal(s.tier, 'mortal', 'exemplars are the villager teaching set — never divine');
    assert.ok(s.code.split('\n').length <= 60, `${s.name} should be ≤60 lines`);
  }
});

test('M2-6: divine stock is tier-divine and invisible to mortal retrieval (seeded active)', () => {
  const bot = new FakeBot({ username: 'Firmin' });
  const { library } = harness(bot);
  const flyTo = library.activeVersion('fly-to');
  assert.equal(flyTo?.status, 'active', 'divine stock enters active directly (curated review = probation)');
  const manifest = library.read('fly-to')?.manifest;
  assert.equal(manifest?.tier, 'divine');
});

test('M2-6: go-to walks the bot to the target (and hops far goals — R7)', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  const { engine } = harness(bot);
  const report = await engine.run('go-to', { x: 100, y: 64, z: 0, range: 1 }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.equal(bot.entity.position.x, 100, 'arrived at the far target');
  assert.ok(bot.pathfinder.gotoGoals.length > 1, 'far goal was walked in multiple hops (R7)');
});

test('M2-6: mine-block digs the block at a position', async () => {
  const bot = new FakeBot({ username: 'Firmin' });
  bot.setBlock({ x: 1, y: 64, z: 0 }, 'stone');
  const { engine } = harness(bot);
  const report = await engine.run('mine-block', { x: 1, y: 64, z: 0 }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.equal(bot.blockAt({ x: 1, y: 64, z: 0 }), null, 'block was dug');
});

test('M2-6: find-block returns the NEAREST matching block by name (the locate primitive)', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 3, y: 64, z: 1 }, 'oak_log'); // farther
  bot.setBlock({ x: 1, y: 64, z: 0 }, 'oak_log'); // nearer — must win
  const { engine } = harness(bot);
  const report = await engine.run('find-block', { name: 'oak_log', maxDistance: 16 }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.deepEqual(report.outcome.ok ? report.outcome.value : null, { x: 1, y: 64, z: 0, name: 'oak_log' });
});

test('M2-6: find-block throws a named error when nothing matches in range (write_skill feedback)', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 1, y: 64, z: 0 }, 'stone');
  const { engine } = harness(bot);
  const report = await engine.run('find-block', { name: 'oak_log', maxDistance: 8 }, MORTAL);
  assert.equal(report.outcome.ok, false);
  assert.match(report.outcome.ok ? '' : report.outcome.error, /oak_log/);
});

test('M2-6 (R10): collect-blocks takes the grounded trunk only, never floating leaf-logs', async () => {
  const bot = new FakeBot({ username: 'Firmin' });
  bot.plantTree({ x: 5, y: 64, z: 5 }, 3, [{ x: 5, y: 69, z: 5 }]); // trunk 64-66, a disconnected log at 69
  const { engine } = harness(bot);
  const report = await engine.run('collect-blocks', { x: 5, y: 64, z: 5 }, MORTAL);
  assert.equal(report.outcome.ok ? (report.outcome.value as { collected: number }).collected : -1, 3, 'only the 3 trunk logs');
  assert.equal(bot.blockAt({ x: 5, y: 64, z: 5 }), null, 'trunk base dug');
  assert.ok(bot.blockAt({ x: 5, y: 69, z: 5 }), 'the floating log was never touched (R10)');
});

test('M2-6 (R1–R3): craft-item closes the stray window, pauses mutators, trusts packet quiescence', async () => {
  const bot = new FakeBot({ username: 'Firmin' });
  bot.openWindow({ id: 9, type: 'minecraft:chest' }); // R1: a stray window would hijack clicks
  const { engine } = harness(bot);
  const report = await engine.run('craft-item', { item: 'oak_planks', count: 4 }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.deepEqual(report.outcome.ok ? report.outcome.value : null, { crafted: 4 });
  // R1: the craft did not route through the stray window — it was closed first.
  assert.equal(bot.crafted[0]?.routedWindow, null);
  assert.equal(bot.currentWindow, null);
  // R3: both autonomous mutators were paused AT craft time, and restored after.
  assert.equal(bot.crafted[0]?.autoEatEnabledAtCraft, false);
  assert.equal(bot.crafted[0]?.armorPausedAtCraft, true);
  assert.equal(bot.autoEat.enabled, true, 'auto-eat restored');
  assert.equal(bot.armorManager.paused, false, 'armor-manager resumed');
});

test('M2-6: use-chest composes go-to then deposits (chest contents change)', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'chest');
  bot.give('oak_log', 10);
  const { engine } = harness(bot);
  const report = await engine.run('use-chest', { x: 2, y: 64, z: 0, deposit: [{ name: 'oak_log', count: 6 }] }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.equal(bot.chestContents({ x: 2, y: 64, z: 0 }).find((i) => i.name === 'oak_log')?.count, 6);
  assert.equal(bot.countItem('oak_log'), 4, 'deposited 6 of 10');
});

test('M2-6 (D4/R1): use-chest CLOSES a stray window before opening the container', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'chest');
  bot.give('oak_log', 10);
  bot.openWindow({ id: 9, type: 'minecraft:chest' }); // a stray window left open — would hijack/hang the next open
  const { engine } = harness(bot);
  const report = await engine.run('use-chest', { x: 2, y: 64, z: 0, deposit: [{ name: 'oak_log', count: 6 }] }, MORTAL);
  assert.equal(report.outcome.ok, true);
  // R1: safeCloseStray ran BEFORE the autonomous mutators were paused (which is just before openContainer).
  const firstClose = bot.calls.indexOf('closeWindow');
  const firstPause = bot.calls.indexOf('autoEat.disableAuto');
  assert.ok(firstClose >= 0, 'the stray window was closed');
  assert.ok(firstClose < firstPause, 'the stray close happened before the container open (R1/D4)');
  // The deposit still landed, and no window leaks open at the end (chest closed in finally — R4–R5).
  assert.equal(bot.chestContents({ x: 2, y: 64, z: 0 }).find((i) => i.name === 'oak_log')?.count, 6);
  assert.equal(bot.currentWindow, null, 'no window left open on exit');
});

test('M2-6 (D4/R3): use-chest pause/resume is GUARDED — no throw when auto-eat/armor are absent', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'chest');
  bot.give('oak_log', 4);
  // The plugin trio attaches POST-spawn on a real bot; a fake/early bot has them absent. The safe helpers
  // must `?.`-guard so a missing API is a no-op, never a TypeError that fails the whole window sequence.
  (bot as unknown as { autoEat?: unknown }).autoEat = undefined;
  (bot as unknown as { armorManager?: unknown }).armorManager = undefined;
  const { engine } = harness(bot);
  const report = await engine.run('use-chest', { x: 2, y: 64, z: 0, deposit: [{ name: 'oak_log', count: 4 }] }, MORTAL);
  assert.equal(report.outcome.ok, true, 'window work succeeds even with the autonomous mutators absent');
  assert.equal(bot.chestContents({ x: 2, y: 64, z: 0 }).find((i) => i.name === 'oak_log')?.count, 4);
});

test('M2-6: deposit composes use-chest (a 3-level mortal call tree, depth-cap safe)', async () => {
  const bot = new FakeBot({ username: 'Firmin' });
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'chest');
  bot.give('wheat', 5);
  const { engine } = harness(bot);
  const report = await engine.run('deposit', { x: 2, y: 64, z: 0, items: [{ name: 'wheat', count: 5 }] }, MORTAL);
  assert.equal(report.outcome.ok, true);
  // The call tree records the composition (deposit → use-chest → go-to).
  assert.ok(report.callTree.some((f) => f.skill === 'use-chest'));
  assert.equal(bot.chestContents({ x: 2, y: 64, z: 0 }).find((i) => i.name === 'wheat')?.count, 5);
});

test('M2-6 (R55): the activateBlock seam does NOT flip the block synchronously (the read-after-write race)', async () => {
  const bot = new FakeBot({ username: 'Firmin' });
  bot.setBlock({ x: 1, y: 64, z: 0 }, 'grass_block'); // air above (unset = open)
  bot.give('iron_hoe', 1);
  bot.setActivateDelayMs(50);
  await bot.equip(bot.inventory.items().find((i) => i.name === 'iron_hoe') as { name: string }, 'hand');
  await bot.activateBlock({ name: 'grass_block', position: { x: 1, y: 64, z: 0 } });
  // The naive bug: reading immediately still sees grass_block — exactly the false "pas devenu farmland".
  assert.equal(bot.blockAt({ x: 1, y: 64, z: 0 })?.name, 'grass_block');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(bot.blockAt({ x: 1, y: 64, z: 0 })?.name, 'farmland', 'flips only after the server round-trip');
});

test('M2-6 (R55): till-block tills grass_block→farmland, WAITING out a long server confirmation', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: -60, z: 0 } });
  bot.setBlock({ x: 1, y: -61, z: 0 }, 'grass_block'); // surface block, air above
  bot.give('iron_hoe', 1);
  bot.setActivateDelayMs(250); // far longer than a synchronous read — only a waiting skill survives it
  const { engine } = harness(bot);
  const report = await engine.run('till-block', { x: 1, y: -61, z: 0 }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.deepEqual(report.outcome.ok ? report.outcome.value : null, { tilled: true, x: 1, y: -61, z: 0 });
  assert.equal(bot.blockAt({ x: 1, y: -61, z: 0 })?.name, 'farmland');
  assert.equal(bot.heldItem?.name, 'iron_hoe', 'the hoe was equipped before tilling');
});

test('M2-6 (R55): till-block refuses a buried block (no air above) with a clear error', async () => {
  const bot = new FakeBot({ username: 'Firmin' });
  bot.setBlock({ x: 1, y: -62, z: 0 }, 'dirt'); // the target...
  bot.setBlock({ x: 1, y: -61, z: 0 }, 'grass_block'); // ...is covered by the surface block above it
  bot.give('iron_hoe', 1);
  const { engine } = harness(bot);
  const report = await engine.run('till-block', { x: 1, y: -62, z: 0 }, MORTAL);
  assert.equal(report.outcome.ok, false);
  assert.match(report.outcome.ok ? '' : report.outcome.error, /au-dessus|SURFACE/);
});

test('M2-6 (R55): sow-seed plants on farmland and confirms the crop grew above it', async () => {
  const bot = new FakeBot({ username: 'Margot', position: { x: 0, y: -60, z: 0 } });
  bot.setBlock({ x: 1, y: -61, z: 0 }, 'farmland');
  bot.give('wheat_seeds', 16);
  const { engine } = harness(bot);
  const report = await engine.run('sow-seed', { x: 1, y: -61, z: 0, seed: 'wheat_seeds' }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.equal(report.outcome.ok ? (report.outcome.value as { crop: string }).crop : null, 'wheat');
  assert.equal(bot.blockAt({ x: 1, y: -60, z: 0 })?.name, 'wheat');
});

test('M2-6 (R55): sow-seed refuses untilled ground (points back at till-block)', async () => {
  const bot = new FakeBot({ username: 'Margot' });
  bot.setBlock({ x: 1, y: 64, z: 0 }, 'grass_block'); // not farmland
  bot.give('wheat_seeds', 16);
  const { engine } = harness(bot);
  const report = await engine.run('sow-seed', { x: 1, y: 64, z: 0, seed: 'wheat_seeds' }, MORTAL);
  assert.equal(report.outcome.ok, false);
  assert.match(report.outcome.ok ? '' : report.outcome.error, /labour|till-block|farmland/);
});

// ── The bread economy: one canonical skill per action, composed into find→act pairs, then one loop. ──

test('bread: find-till-spot returns dirt near water (bank block, air above) — nearest-first', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 5, y: 64, z: 5 }, 'water');
  bot.setBlock({ x: 7, y: 64, z: 5 }, 'dirt'); // Chebyshev 2 from water
  bot.setBlock({ x: 6, y: 64, z: 5 }, 'grass_block'); // Chebyshev 1 — must win, air above (unset)
  const { engine } = harness(bot);
  const report = await engine.run('find-till-spot', { maxDistance: 32 }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.deepEqual(report.outcome.ok ? report.outcome.value : null, { found: true, x: 6, y: 64, z: 5 });
});

test('bread: find-till-spot returns {found:false} (never throws) when no water is in range', async () => {
  const bot = new FakeBot({ username: 'Firmin' });
  bot.setBlock({ x: 1, y: 64, z: 0 }, 'dirt'); // dirt but no water nearby
  const { engine } = harness(bot);
  const report = await engine.run('find-till-spot', { maxDistance: 8 }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.equal(report.outcome.ok ? (report.outcome.value as { found: boolean }).found : true, false);
});

test('bread: till-spot-near-water composes find-till-spot → till-block (dirt becomes farmland)', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 5, y: 64, z: 5 }, 'water');
  bot.setBlock({ x: 6, y: 64, z: 5 }, 'grass_block'); // air above (unset)
  bot.give('iron_hoe', 1);
  bot.setActivateDelayMs(60);
  const { engine } = harness(bot);
  const report = await engine.run('till-spot-near-water', { maxDistance: 32 }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.deepEqual(report.outcome.ok ? report.outcome.value : null, { tilled: true, x: 6, y: 64, z: 5 });
  assert.equal(bot.blockAt({ x: 6, y: 64, z: 5 })?.name, 'farmland', 'the found spot was tilled');
  assert.ok(report.callTree.some((f) => f.skill === 'find-till-spot'));
  assert.ok(report.callTree.some((f) => f.skill === 'till-block'));
});

test('bread: find-harvestable-plant locates a mature crop; {found:false} when the field is empty', async () => {
  const bot = new FakeBot({ username: 'Margot', position: { x: 0, y: 64, z: 0 } });
  const { engine } = harness(bot);
  let report = await engine.run('find-harvestable-plant', { maxDistance: 16 }, MORTAL);
  assert.equal(report.outcome.ok ? (report.outcome.value as { found: boolean }).found : true, false, 'empty field → not found');
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'wheat'); // fake has no metadata → treated as grown
  report = await engine.run('find-harvestable-plant', { maxDistance: 16 }, MORTAL);
  assert.deepEqual(report.outcome.ok ? report.outcome.value : null, { found: true, x: 2, y: 64, z: 0, crop: 'wheat' });
});

test('bread: harvest-plant breaks a mature crop and refuses a non-crop block', async () => {
  const bot = new FakeBot({ username: 'Margot', position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 1, y: 64, z: 0 }, 'wheat');
  bot.setBlock({ x: 1, y: 64, z: 2 }, 'stone');
  const { engine } = harness(bot);
  const ok = await engine.run('harvest-plant', { x: 1, y: 64, z: 0 }, MORTAL);
  assert.equal(ok.outcome.ok, true);
  assert.equal(bot.blockAt({ x: 1, y: 64, z: 0 }), null, 'the crop was harvested');
  const bad = await engine.run('harvest-plant', { x: 1, y: 64, z: 2 }, MORTAL);
  assert.equal(bad.outcome.ok, false);
  assert.match(bad.outcome.ok ? '' : bad.outcome.error, /non récoltable|stone/);
});

test('bread: pickup-drops walks onto each nearby item entity (and is empty-safe)', async () => {
  const bot = new FakeBot({ username: 'Margot', position: { x: 0, y: 64, z: 0 } });
  const { engine } = harness(bot);
  let report = await engine.run('pickup-drops', { radius: 8 }, MORTAL); // no entities
  assert.equal(report.outcome.ok ? (report.outcome.value as { picked: number }).picked : -1, 0);
  bot.setEntities({ 1: { name: 'item', position: { x: 3, y: 64, z: 0 } }, 2: { name: 'item', position: { x: 50, y: 64, z: 0 } } });
  report = await engine.run('pickup-drops', { radius: 8 }, MORTAL);
  assert.equal(report.outcome.ok ? (report.outcome.value as { picked: number }).picked : -1, 1, 'only the in-radius drop');
});

test('bread: make-bread composes find-crafting-table → craft-item; errors with no table', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  const { engine } = harness(bot);
  // No table yet → a clear, actionable error:
  let report = await engine.run('make-bread', { count: 2 }, MORTAL);
  assert.equal(report.outcome.ok, false);
  assert.match(report.outcome.ok ? '' : report.outcome.error, /établi|crafting_table/);
  // With a table in reach, the loaves are crafted:
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'crafting_table');
  report = await engine.run('make-bread', { count: 2 }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.deepEqual(report.outcome.ok ? report.outcome.value : null, { crafted: 2 });
  assert.ok(report.callTree.some((f) => f.skill === 'find-crafting-table'));
  assert.ok(report.callTree.some((f) => f.skill === 'craft-item'));
});

test('bread: store-in-chest finds the nearest chest and deposits (composes deposit → use-chest)', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'chest');
  bot.give('bread', 5);
  const { engine } = harness(bot);
  const report = await engine.run('store-in-chest', { items: [{ name: 'bread', count: 3 }] }, MORTAL);
  assert.equal(report.outcome.ok, true);
  assert.equal(report.outcome.ok ? (report.outcome.value as { stored: number }).stored : -1, 3);
  assert.equal(bot.chestContents({ x: 2, y: 64, z: 0 }).find((i) => i.name === 'bread')?.count, 3);
  assert.equal(bot.countItem('bread'), 2, 'deposited 3 of 5');
  assert.ok(report.callTree.some((f) => f.skill === 'deposit'));
  assert.ok(report.callTree.some((f) => f.skill === 'use-chest'));
});

test('bread: tend-bread-farm runs one cycle — harvest → bake → store — composing every pair', async () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 3, y: 64, z: 0 }, 'wheat'); // a mature crop to reap this cycle
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'crafting_table');
  bot.setBlock({ x: 2, y: 64, z: 1 }, 'chest');
  bot.give('wheat', 6); // ≥ threshold → bakes 2 loaves
  bot.give('bread', 10); // already-held loaves so the deposit lands (fake craft doesn't mint named bread)
  const { engine } = harness(bot);
  const report = await engine.run('tend-bread-farm', { cycles: 1, chest: { x: 2, y: 64, z: 1 } }, MORTAL);
  assert.equal(report.outcome.ok, true);
  const value = report.outcome.ok ? (report.outcome.value as { harvested: number; baked: number }) : { harvested: 0, baked: 0 };
  assert.equal(value.harvested, 1, 'reaped the one mature crop');
  assert.equal(value.baked, 2, 'baked floor(6/3) = 2 loaves');
  assert.ok(report.callTree.some((f) => f.skill === 'harvest-nearby-crop'), 'composed the harvest pair');
  assert.ok(report.callTree.some((f) => f.skill === 'make-bread'), 'composed the bake pair');
  assert.ok(report.callTree.some((f) => f.skill === 'store-in-chest'), 'composed the stash step');
  assert.ok((bot.chestContents({ x: 2, y: 64, z: 1 }).find((i) => i.name === 'bread')?.count ?? 0) >= 2, 'loaves stored');
});
