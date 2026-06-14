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
