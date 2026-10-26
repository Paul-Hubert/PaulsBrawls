import test from 'ava';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { findChestNear, isChestBlock, standableYNear } from '../src/village/actions.js';

/**
 * The anchor-healing primitives: roster coordinates are assertions about a
 * world that may have been regenerated — these helpers are how the village
 * recovers instead of erroring forever on "no chest at (x,y,z)".
 */

/** A column world: solid at y <= groundTopY, empty above; null outside the loaded box. */
function columnBot(groundTopY: number, loaded = true): Bot {
  return {
    blockAt: (pos: Vec3) => {
      if (!loaded) return null;
      return { name: pos.y <= groundTopY ? 'stone' : 'air', boundingBox: pos.y <= groundTopY ? 'block' : 'empty', position: pos };
    },
  } as unknown as Bot;
}

test('standableYNear snaps a floating home down onto real ground', (t) => {
  // Ground top at y=62 → feet belong at y=63. Roster says y=64 (the classic).
  t.is(standableYNear(columnBot(62), { x: 10, y: 64, z: 10 }), 63);
});

test('standableYNear digs a buried home out upward', (t) => {
  // Ground top at y=70, home configured at y=64 — inside solid rock.
  t.is(standableYNear(columnBot(70), { x: 10, y: 64, z: 10 }), 71);
});

test('standableYNear keeps an already-valid home unchanged', (t) => {
  t.is(standableYNear(columnBot(63), { x: 0, y: 64, z: 0 }), 64);
});

test('standableYNear returns null for unloaded terrain instead of guessing', (t) => {
  t.is(standableYNear(columnBot(62, false), { x: 0, y: 64, z: 0 }), null);
});

test('standableYNear gives up beyond the scan range', (t) => {
  t.is(standableYNear(columnBot(0), { x: 0, y: 64, z: 0 }, 8), null);
});

test('isChestBlock accepts chests, trapped chests and barrels only', (t) => {
  const block = (name: string): Parameters<typeof isChestBlock>[0] =>
    ({ name }) as unknown as Parameters<typeof isChestBlock>[0];
  t.true(isChestBlock(block('chest')));
  t.true(isChestBlock(block('trapped_chest')));
  t.true(isChestBlock(block('barrel')));
  t.false(isChestBlock(block('crafting_table')));
  t.false(isChestBlock(block('ender_chest'))); // not shared storage
  t.false(isChestBlock(null));
});

test('findChestNear searches around the given point, not the bot', (t) => {
  let seenPoint: Vec3 | null = null;
  const chestPos = new Vec3(5, 64, -3);
  const bot = {
    version: '1.21.1',
    findBlocks: (opts: { point: Vec3 }) => {
      seenPoint = opts.point;
      return [chestPos];
    },
    blockAt: (pos: Vec3) => ({ name: 'chest', boundingBox: 'block', position: pos }),
  } as unknown as Bot;

  const found = findChestNear(bot, { x: 4, y: 64, z: -4 });
  t.truthy(found);
  t.is(found!.name, 'chest');
  t.deepEqual({ x: seenPoint!.x, y: seenPoint!.y, z: seenPoint!.z }, { x: 4, y: 64, z: -4 });
});

test('findChestNear returns null when nothing chest-like is loaded', (t) => {
  const bot = {
    version: '1.21.1',
    findBlocks: () => [],
    blockAt: () => null,
  } as unknown as Bot;
  t.is(findChestNear(bot, { x: 0, y: 64, z: 0 }), null);
});
