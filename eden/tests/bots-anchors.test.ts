import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBot } from './fakes/fake-bot';
import { AnchorService } from '../src/bots/anchors';

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'eden-anchor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('heal discovers home as standable ground near spawn', (t) => {
  const bot = new FakeBot({ position: { x: 10, y: 64, z: 10 } });
  bot.setBlock({ x: 10, y: 64, z: 10 }, 'grass_block'); // ground at bot spawn
  const svc = new AnchorService(tmp(t));
  const anchors = svc.heal('Firmin', bot, {});
  // Feet stand on top of the ground block (65), which has air at head height.
  assert.deepEqual(anchors.home, [10, 65, 10]);
});

test('heal discovers chest as the nearest container', (t) => {
  const bot = new FakeBot({ position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 0, y: 64, z: 0 }, 'grass_block'); // standable home ground
  bot.setBlock({ x: 4, y: 64, z: 0 }, 'barrel'); // the real container
  bot.setBlock({ x: 9, y: 64, z: 0 }, 'chest'); // a farther chest — must NOT win over the barrel
  const svc = new AnchorService(tmp(t), { searchRadius: 16 });
  const anchors = svc.heal('Remy', bot, {});
  assert.deepEqual(anchors.chest, [4, 64, 0], 'nearest chest/trapped_chest/barrel wins');
});

test('discovered chest is reused on subsequent boots', (t) => {
  const dir = tmp(t);
  const bot = new FakeBot({ position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 0, y: 64, z: 0 }, 'grass_block');
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'chest');
  // First boot discovers the chest
  const first = new AnchorService(dir).heal('Remy', bot, {});
  assert.deepEqual(first.chest, [2, 64, 0]);
  // Second boot reuses it even if the world changed
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'air'); // chest is gone
  const second = new AnchorService(dir).heal('Remy', bot, {});
  assert.deepEqual(second.chest, [2, 64, 0], 'persisted chest is reused');
});

test('discovered anchors persist across boots', (t) => {
  const dir = tmp(t);
  const bot = new FakeBot();
  bot.setBlock({ x: 0, y: 64, z: 0 }, 'grass_block');
  bot.setBlock({ x: 4, y: 64, z: 0 }, 'chest');
  // First boot discovers + persists.
  const discovered = new AnchorService(dir).heal('Remy', bot, {});
  assert.deepEqual(discovered.chest, [4, 64, 0]);
  assert.ok(existsSync(join(dir, 'bots', 'Remy.json')), 'anchors persisted');
  const stored = JSON.parse(readFileSync(join(dir, 'bots', 'Remy.json'), 'utf8'));
  assert.deepEqual(stored.anchors.chest, [4, 64, 0]);

  // Second boot reuses persisted anchors.
  const fresh = new AnchorService(dir).heal('Remy', bot, {});
  assert.deepEqual(fresh.chest, [4, 64, 0], 'persisted anchor is reused');
  assert.deepEqual(fresh.home, [0, 65, 0]);
});

test('an unrecoverable anchor produces ONE loud warning, not an error loop', (t) => {
  const bot = new FakeBot({ position: { x: 5, y: 65, z: 5 } }); // empty world: no ground nearby, no containers anywhere
  const warnings: string[] = [];
  const svc = new AnchorService(tmp(t), { searchRadius: 8, onWarn: (m) => warnings.push(m) });
  const anchors = svc.heal('Lost', bot, {});
  // Home falls back to bot's current position; chest is null (none found).
  assert.deepEqual(anchors.home, [5, 65, 5]);
  assert.equal(anchors.chest, null);
  // Exactly one warning per unrecoverable anchor — never a loop.
  assert.equal(warnings.length, 1, 'one warn for chest — bounded, loud, once');
});
