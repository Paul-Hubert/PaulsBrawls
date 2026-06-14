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

test('heal snaps home down to standable ground (R18)', (t) => {
  const bot = new FakeBot();
  bot.setBlock({ x: 10, y: 64, z: 10 }, 'grass_block'); // real ground far below the configured y
  const svc = new AnchorService(tmp(t));
  const anchors = svc.heal('Firmin', bot, { home: [10, 70, 10], chest: [10, 64, 11] });
  // Feet stand on top of the ground block (65), which has air at head height.
  assert.deepEqual(anchors.home, [10, 65, 10]);
});

test('heal re-discovers a missing chest as the nearest container (R18)', (t) => {
  const bot = new FakeBot();
  bot.setBlock({ x: 0, y: 64, z: 0 }, 'grass_block'); // standable home ground
  bot.setBlock({ x: 4, y: 64, z: 0 }, 'barrel'); // the real container, off the configured spot
  bot.setBlock({ x: 9, y: 64, z: 0 }, 'chest'); // a farther chest — must NOT win over the barrel
  const svc = new AnchorService(tmp(t), { searchRadius: 16 });
  const anchors = svc.heal('Remy', bot, { home: [0, 65, 0], chest: [2, 64, 0] /* nothing here */ });
  assert.deepEqual(anchors.chest, [4, 64, 0], 'nearest chest/trapped_chest/barrel wins');
});

test('a present configured chest is kept as-is (R18)', (t) => {
  const bot = new FakeBot();
  bot.setBlock({ x: 0, y: 64, z: 0 }, 'grass_block');
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'chest');
  const svc = new AnchorService(tmp(t));
  const anchors = svc.heal('Remy', bot, { home: [0, 65, 0], chest: [2, 64, 0] });
  assert.deepEqual(anchors.chest, [2, 64, 0]);
});

test('discovered anchors persist and WIN over a later (changed) config (R18)', (t) => {
  const dir = tmp(t);
  const bot = new FakeBot();
  bot.setBlock({ x: 0, y: 64, z: 0 }, 'grass_block');
  bot.setBlock({ x: 4, y: 64, z: 0 }, 'chest');
  // First boot heals + persists.
  const healed = new AnchorService(dir).heal('Remy', bot, { home: [0, 65, 0], chest: [2, 64, 0] });
  assert.deepEqual(healed.chest, [4, 64, 0]);
  assert.ok(existsSync(join(dir, 'bots', 'Remy.json')), 'override persisted');
  const stored = JSON.parse(readFileSync(join(dir, 'bots', 'Remy.json'), 'utf8'));
  assert.deepEqual(stored.anchors.chest, [4, 64, 0]);

  // Second boot with a DIFFERENT config returns the persisted override, not the new config.
  const fresh = new AnchorService(dir).heal('Remy', bot, { home: [999, 65, 999], chest: [999, 64, 999] });
  assert.deepEqual(fresh.chest, [4, 64, 0], 'persisted override wins over config');
  assert.deepEqual(fresh.home, [0, 65, 0]);
});

test('an unrecoverable anchor produces ONE loud warning, not an error loop (R18)', (t) => {
  const bot = new FakeBot(); // empty world: no ground, no containers anywhere
  const warnings: string[] = [];
  const svc = new AnchorService(tmp(t), { searchRadius: 8, onWarn: (m) => warnings.push(m) });
  const anchors = svc.heal('Lost', bot, { home: [5, 65, 5], chest: [5, 64, 6] });
  // Home falls back to the configured coord; chest is null (none found).
  assert.deepEqual(anchors.home, [5, 65, 5]);
  assert.equal(anchors.chest, null);
  // Exactly one warning per unrecoverable anchor — never a loop.
  assert.equal(warnings.length, 2, 'one warn for home, one for chest — bounded, loud, once');
});
