// The approach onto an exact place (docs/43 B): stepTo walks the last ≤ 2.75 blocks itself, at walking speed and never
// sneaking, braking from the body's velocity so that it stops on the place (within 0.15, at rest, no overshoot, no
// back-and-forth); approach paths there first (GoalNear on the exact coordinates) when it is farther. On FakeBots whose
// physics is prismarine-physics' on the ground (acceleration 0.098 a tick, inertia 0.546), and a horse's speed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';

import { approach, stepTo } from '../src/api/formation';
import { HelperError } from '../src/api/errors';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

/** Record the body every tick: its distance to `place` and its progress along the line from the start to it. */
function watch(b: FakeBot, place: Vec3) {
  const start = b.entity.position.clone();
  const len = Math.hypot(place.x - start.x, place.z - start.z) || 1;
  const ux = (place.x - start.x) / len;
  const uz = (place.z - start.z) / len;
  const along: number[] = [];
  const dist: number[] = [];
  const onTick = (): void => {
    const p = b.entity.position;
    along.push((p.x - start.x) * ux + (p.z - start.z) * uz);
    dist.push(Math.hypot(p.x - place.x, p.z - place.z));
  };
  b.on('physicsTick', onTick);
  return {
    len,
    along,
    dist,
    /** How far the body went past the place along the line (0: never). */
    overshoot: () => Math.max(0, ...along.map((a) => a - len)),
    /** After first coming within `tol`, the farthest it got again. */
    after: (tol: number) => {
      const i = dist.findIndex((d) => d <= tol);
      return i < 0 ? Infinity : Math.max(...dist.slice(i));
    },
    stop: () => b.removeListener('physicsTick', onTick),
  };
}

const neverSneaked = (b: FakeBot): boolean => !b.calls.includes('setControlState(sneak,true)');

for (const [dx, dz] of [
  [0, 2],
  [1.4, -1.4],
  [-2.6, 0.4],
  [0.35, -0.35],
  [0.06, 0.1],
]) {
  test(`stepTo: ${Math.hypot(dx, dz).toFixed(2)} blocks off, the bot walks straight onto the exact place, never sneaking: within 0.15, at rest, no overshoot, no back-and-forth`, async () => {
    const b = new FakeBot('Guard', { position: new Vec3(0.5, 64, 0.5) }).physics({ tickMs: 2 });
    const place = new Vec3(0.5 + dx, 64, 0.5 + dz);
    const w = watch(b, place);
    try {
      b.pathfinder.goal = { x: 0, y: 64, z: 0 };
      const r = await stepTo(b as never, place);
      assert.deepEqual([r.there, r.timedOut], [true, false]);
      assert.ok(r.off <= 0.15, `${r.off.toFixed(3)} off`);
      assert.ok(Math.hypot(b.entity.velocity.x, b.entity.velocity.z) < 0.005, 'at rest');
      assert.equal(b.calls[0], 'pathfinder.setGoal(null)', 'the walk goal cleared first');
      assert.ok(neverSneaked(b), 'never sneaking');
      assert.ok(w.overshoot() <= 0.1, `overshoot ${w.overshoot().toFixed(3)}`);
      assert.ok(w.after(0.15) <= 0.15, `back out to ${w.after(0.15).toFixed(3)} after reaching the place`);
      // Walking speed: 2 blocks take about 14 ticks (0.7 s) with the braking; sneaking took 40.
      if (w.len >= 1.5) assert.ok(w.dist.findIndex((d) => d <= 0.15) <= 9 * w.len, `${w.dist.findIndex((d) => d <= 0.15)} ticks for ${w.len.toFixed(2)} blocks`);
      assert.ok(!b.controlState.forward, 'let go');
      assert.equal(b.listenerCount('physicsTick'), 1, 'no steering left on the ticks (only the test\'s watch)');
    } finally {
      w.stop();
      b.stopTicks();
    }
  });
}

test('stepTo, mounted: a horse (speed 0.225: one held tick moves the rest point 0.37 block, more than twice the tolerance) still stops within 0.15', async () => {
  for (const [dx, dz] of [
    [0, 2.2],
    [0.2, 0.05],
    [-1.1, -0.9],
  ]) {
    const b = new FakeBot('Rider', { position: new Vec3(0.5, 64, 0.5) }).physics({ tickMs: 2 });
    // mount.ts: the body's speed attribute is the horse's ÷ 1.3 (the pathfinder's sprint goes at the horse's speed).
    Object.assign(b.entity, { attributes: { 'minecraft:movement_speed': { value: 0.225 / 1.3, modifiers: [] } } });
    const place = new Vec3(0.5 + dx, 64, 0.5 + dz);
    const w = watch(b, place);
    try {
      const r = await stepTo(b as never, place);
      assert.equal(r.there, true, `${dx},${dz}: ${r.off.toFixed(3)} off`);
      assert.ok(r.off <= 0.15);
      assert.ok(neverSneaked(b));
      assert.ok(w.overshoot() <= 0.15, `overshoot ${w.overshoot().toFixed(3)}`);
    } finally {
      w.stop();
      b.stopTicks();
    }
  }
});

test('stepTo: a body arriving at speed (the pathfinder sprinting) brakes in time; one faster than its attribute says is learned from its ticks', async () => {
  const b = new FakeBot('Runner', { position: new Vec3(0.5, 64, 0.5) }).physics({ tickMs: 2 });
  b.entity.velocity = new Vec3(0, 0, 0.28); // a sprint toward +Z
  // A speed potion the attribute does not show: 0.13 instead of 0.1.
  Object.assign(b.entity, { attributes: { 'minecraft:movement_speed': { value: 0.13, modifiers: [] } } });
  const place = new Vec3(0.5, 64, 2.3);
  const w = watch(b, place);
  try {
    const r = await stepTo(b as never, place);
    assert.equal(r.there, true, `${r.off.toFixed(3)} off`);
    assert.ok(w.overshoot() <= 0.15, `overshoot ${w.overshoot().toFixed(3)}`);
  } finally {
    w.stop();
    b.stopTicks();
  }
});

test('stepTo: until() ends it at once; with no move it gives up after timeoutMs; either way forward is let go; a place 3 blocks off is an error', async () => {
  const b = new FakeBot('Archer', { position: new Vec3(0.5, 64, 0.5) }).physics({ tickMs: 40 });
  try {
    let foe = false;
    const step = stepTo(b as never, new Vec3(0.5, 64, 2.5), { until: () => foe });
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(b.controlState.forward, true, 'under way');
    foe = true;
    const r = await step;
    assert.deepEqual([r.there, r.timedOut], [false, false]);
    assert.ok(r.off > 0.15, 'not there yet');
    assert.ok(!b.controlState.forward, 'let go');
    assert.equal(b.listenerCount('physicsTick'), 0);
  } finally {
    b.stopTicks();
  }
  // No physics ticks: the body never moves.
  const t0 = Date.now();
  const r = await stepTo(b as never, new Vec3(0.5, 64, 0.95), { timeoutMs: 200 });
  assert.deepEqual([r.there, r.timedOut], [false, true]);
  assert.ok(Date.now() - t0 >= 200);
  assert.ok(!b.controlState.forward, 'let go after giving up');
  await assert.rejects(stepTo(b as never, new Vec3(3.5, 64, 0.5)), (e: unknown) => e instanceof HelperError && /stepTo\(Archer\): 3\.00 blocks from .*: approach\(bot, place\) paths there first/.test((e as Error).message));
});

test('stepTo: a later stepTo on the same body takes its controls over; the earlier one ends and leaves them alone', async () => {
  const b = new FakeBot('Guard', { position: new Vec3(0.5, 64, 0.5) });
  const first = stepTo(b as never, new Vec3(0.9, 64, 0.5));
  b.tick(); // one tick: the first step holds forward
  assert.equal(b.controlState.forward, true);
  let done = false;
  const second = stepTo(b as never, new Vec3(0.1, 64, 2.5), { until: () => done });
  b.tick();
  const r1 = await first;
  assert.deepEqual([r1.there, r1.timedOut], [false, false], 'taken over, not timed out');
  b.tick();
  assert.equal(b.controlState.forward, true, "the later step's forward stays");
  done = true;
  await second;
  assert.ok(!b.controlState.forward, 'let go by the later step');
});

test('approach: from 12 blocks the pathfinder takes the bot near (GoalNear on the exact place, range 2), then it walks onto the place itself', async () => {
  const b = new FakeBot('Guard', { position: new Vec3(0.5, 64, 0.5) }).physics({ tickMs: 2 });
  b.autoWalk = true; // a goal arrives: the bot stands on the goal's block centre
  const place = new Vec3(8.85, 64, 8.2);
  try {
    const r = await approach(b as never, place);
    assert.deepEqual([r.there, r.timedOut], [true, false]);
    assert.ok(r.off <= 0.15, `${r.off.toFixed(3)} off`);
    const goal = b.calls.indexOf('pathfinder.setGoal');
    assert.ok(goal >= 0 && b.calls.indexOf('setControlState(forward,true)') > goal, 'the path first, then the direct walk');
    assert.ok(neverSneaked(b));
  } finally {
    b.stopTicks();
  }
});

test('approach: until() ends the path part too; a loose tolerance (2.5) is pathfinding only', async () => {
  const b = new FakeBot('Guard', { position: new Vec3(0.5, 64, 0.5) }).physics({ tickMs: 2 });
  try {
    let stop = false;
    const go = approach(b as never, new Vec3(20.5, 64, 0.5), { until: () => stop }); // no autoWalk: the path never ends
    await new Promise((r) => setTimeout(r, 150));
    stop = true;
    const r = await go;
    assert.deepEqual([r.there, r.timedOut], [false, false]);
    assert.equal(b.pathfinder.goal, null, 'its goal cleared');
    b.autoWalk = true;
    const loose = await approach(b as never, new Vec3(6.2, 64, 0.5), { tolerance: 2.5 });
    assert.equal(loose.there, true);
    assert.ok(!b.calls.includes('setControlState(forward,true)'), 'no direct walk for a loose hold');
  } finally {
    b.stopTicks();
  }
});
