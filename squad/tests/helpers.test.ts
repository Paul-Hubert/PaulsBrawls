// Helpers against the failures the production server showed (docs/29 §16).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';

import { goTo, shoot } from '../src/api/helpers';
import { HelperError } from '../src/api/errors';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

test('goTo: a target nobody can stand at falls back to a looser range, then to the column', async () => {
  const b = new FakeBot('Bob', { position: new Vec3(0, 80, 0) });
  b.pathfinder.gotoImpl = async (goal) => {
    if (goal.constructor.name === 'GoalNear') throw new Error('No path to the goal!');
    b.entity.position = new Vec3(goal.x, 79, goal.z);
  };
  const r = await goTo(b as never, [4, 80, 2], 1);
  assert.deepEqual(b.calls.filter((c) => c.startsWith('pathfinder.goto')), ['pathfinder.goto(GoalNear)', 'pathfinder.goto(GoalNear)', 'pathfinder.goto(GoalNearXZ)']);
  assert.equal(r.position.x, 4);
});

test('goTo: when every fallback fails, the error says where from and where to', async () => {
  const b = new FakeBot('Bob', { position: new Vec3(0, 80, 0) });
  b.pathfinder.gotoImpl = async () => {
    throw new Error('No path to the goal!');
  };
  await assert.rejects(goTo(b as never, [4, 80, 2]), (e: unknown) => e instanceof HelperError && /No path to the goal! — toward \(4, 80, 2\) from \(0, 80, 0\)/.test((e as Error).message));
});

test('shoot: when hawkEye fires nothing, a manual shot is tried, and a shot that uses no arrow is an error', { timeout: 20_000 }, async () => {
  const target = { name: 'husk', position: new Vec3(10, 80, 0), height: 1.95, isValid: true };
  const b = new FakeBot('Archer', { items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] });
  b.deactivateItem = () => {
    b.calls.push('deactivateItem');
    b.setItems([{ name: 'bow', count: 1 }, { name: 'arrow', count: 9 }]); // the manual shot released an arrow
  };
  await shoot(b as never, target as never);
  assert.ok(b.calls.includes('hawkEye.oneShot') && b.calls.includes('activateItem'));

  const c = new FakeBot('Archer2', { items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] });
  await assert.rejects(shoot(c as never, target as never), /no arrow left the bow at husk \(10, 80, 0\)/);
});
