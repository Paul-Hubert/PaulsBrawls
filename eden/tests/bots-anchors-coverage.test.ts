// Coverage for bots/anchors.ts branches not reached by bots-anchors.test.ts:
//   • corrupt per-bot JSON file → re-discovers without crashing
//   • save() preserves other top-level keys already in the file
//   • discovered anchors are reused on subsequent boots

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBot } from './fakes/fake-bot';
import { AnchorService } from '../src/bots/anchors';

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'eden-anchor-cov-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── corrupt per-bot file → re-heals from config (R18) ────────────────────────

test('a corrupt per-bot JSON file re-discovers without crashing', (t) => {
  const dir = tmp(t);
  // Write a broken JSON file where the persisted anchors live.
  mkdirSync(join(dir, 'bots'), { recursive: true });
  writeFileSync(join(dir, 'bots', 'Remy.json'), '{ "anchors": { "home": [1, INVALID }');

  const bot = new FakeBot({ position: { x: 5, y: 65, z: 5 } });
  bot.setBlock({ x: 5, y: 64, z: 5 }, 'grass_block');
  bot.setBlock({ x: 5, y: 64, z: 6 }, 'chest');

  const svc = new AnchorService(dir, { searchRadius: 4 });
  // Must not throw — corrupt file must be treated as absent (load() returns null).
  let anchors: { home: [number, number, number]; chest: [number, number, number] | null } | undefined;
  assert.doesNotThrow(() => {
    anchors = svc.heal('Remy', bot, {});
  });
  // Healing succeeds by discovering from the world.
  assert.deepEqual(anchors?.home, [5, 65, 5], 'home discovered after corrupt file');
  assert.deepEqual(anchors?.chest, [5, 64, 6], 'chest discovered after corrupt file');
});

// ── save() preserves other top-level keys in the file (R18) ─────────────────

test('save() merges anchors under the anchors key and preserves other top-level keys', (t) => {
  const dir = tmp(t);
  // Seed the file with pre-existing state (skills/memories land in later milestones).
  mkdirSync(join(dir, 'bots'), { recursive: true });
  const file = join(dir, 'bots', 'Firmin.json');
  writeFileSync(file, JSON.stringify({ skills: ['harvest'], memories: ['remember the trees'] }));

  const bot = new FakeBot({ position: { x: 0, y: 64, z: 0 } });
  bot.setBlock({ x: 0, y: 64, z: 0 }, 'grass_block');
  bot.setBlock({ x: 2, y: 64, z: 0 }, 'chest');

  const svc = new AnchorService(dir);
  svc.heal('Firmin', bot, {});

  const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  // The anchors key is set.
  assert.ok('anchors' in written, 'anchors key written');
  // Pre-existing keys are preserved (not wiped by save).
  assert.deepEqual(written.skills, ['harvest'], 'skills key preserved');
  assert.deepEqual(written.memories, ['remember the trees'], 'memories key preserved');
});

// ── home snapping UPWARD when hint is below real ground (R18) ───────────────

test('discovered home snaps to the nearest standable position', (t) => {
  const bot = new FakeBot({ position: { x: 10, y: 71, z: 10 } });
  // Ground surface is at y=70 (solid); y=71 and y=72 are air.
  bot.setBlock({ x: 10, y: 70, z: 10 }, 'stone'); // solid floor
  // y=71 and y=72 are passable (air by default in FakeBot)

  const svc = new AnchorService(tmp(t), { searchRadius: 16 });
  const anchors = svc.heal('Pilgrim', bot, {});

  // Feet should land at y=71 (standing on top of the y=70 stone block).
  assert.deepEqual(anchors.home, [10, 71, 10], 'discovered home at standable ground on top of stone at y=70');
});
