// Helpers against the failures the production server showed (docs/29 §16), and the formation helpers of orders bound
// to items (docs/29 §5.4): the yaw convention, line slots, the ground, facing, the shield, shots at a position and the
// arrow's ballistics, snapshot entities.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { Vec3 } from 'vec3';

import {
  ARROW,
  bowAim,
  entityOf,
  faceYaw,
  goTo,
  groundAt,
  lineSlots,
  lookDir,
  mineflayerPitch,
  mineflayerYaw,
  OFF_HAND_SLOT,
  raiseShield,
  SHIELD_REASSERT_MS,
  shoot,
} from '../src/api/helpers';
import { HelperError } from '../src/api/errors';
import { FakeBot, flatWorld } from './fakes/fake-bot';
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

// -- formations and aiming (docs/29 §5.4) ----------------------------------------------------------------------

const xyz = (v: { x: number; y: number; z: number }): [number, number, number] => [v.x, v.y, v.z];

test('lookDir: Minecraft yaw (0 = south +Z, 90 = west −X) and pitch (negative = up)', () => {
  assert.deepEqual(xyz(lookDir(0)), [0, 0, 1]);
  assert.deepEqual(xyz(lookDir(90)), [-1, 0, 0]);
  assert.deepEqual(xyz(lookDir(180)), [0, 0, -1]);
  assert.deepEqual(xyz(lookDir(-90)), [1, 0, 0]);
  assert.deepEqual(xyz(lookDir(0, -90)), [0, 1, 0], 'pitch −90: straight up');
  const d = lookDir(45, -30);
  assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-6, 'a unit vector');
  assert.throws(() => lookDir(Number.NaN), /expected degrees/);
});

test('lineSlots: a line through the centre perpendicular to the view, left to right as the commander sees it', () => {
  const c = new Vec3(10, 64, 20);
  // Facing south (+Z) the right hand is −X: left to right runs from +X to −X.
  assert.deepEqual(lineSlots(c, 0, 3, { spacing: 2 }).map(xyz), [[12, 64, 20], [10, 64, 20], [8, 64, 20]]);
  // Facing west (−X) the line runs along z, from +Z (left) to −Z.
  assert.deepEqual(lineSlots(c, 90, 3, { spacing: 2 }).map(xyz), [[10, 64, 22], [10, 64, 20], [10, 64, 18]]);
  assert.deepEqual(lineSlots(c, 180, 3, { spacing: 2 }).map(xyz), [[8, 64, 20], [10, 64, 20], [12, 64, 20]]);
  assert.deepEqual(lineSlots(c, -90, 3, { spacing: 2 }).map(xyz), [[10, 64, 18], [10, 64, 20], [10, 64, 22]]);
  for (const yaw of [0, 90, 180, -90, 30]) {
    const d = lookDir(yaw);
    for (const s of lineSlots(c, yaw, 4)) assert.ok(Math.abs((s.x - c.x) * d.x + (s.z - c.z) * d.z) < 1e-9, `yaw ${yaw}: on the perpendicular`);
  }
  // Default spacing 1.5; an even count is centred on the point.
  assert.deepEqual(lineSlots(c, 0, 2).map(xyz), [[10.75, 64, 20], [9.25, 64, 20]]);
  assert.deepEqual(lineSlots(c, 0, 0), []);
});

test('lineSlots: ranks fill one by one, each centred, `depth` blocks behind toward the commander', () => {
  const c = new Vec3(0, 64, 0);
  // Facing south: behind is −Z. 5 slots in 2 ranks: 3 in front, 2 behind.
  assert.deepEqual(lineSlots(c, 0, 5, { spacing: 2, ranks: 2, depth: 2 }).map(xyz), [
    [2, 64, 0], [0, 64, 0], [-2, 64, 0],
    [1, 64, -2], [-1, 64, -2],
  ]);
  // Facing west: behind is +X.
  assert.deepEqual(lineSlots(c, 90, 4, { spacing: 1, ranks: 2, depth: 3 }).map(xyz), [
    [0, 64, 0.5], [0, 64, -0.5],
    [3, 64, 0.5], [3, 64, -0.5],
  ]);
});

test('groundAt: the nearest standable feet position in the column; null when none or not loaded', () => {
  const b = new FakeBot('Bob');
  assert.equal(groundAt(b as never, [5, 64, 5]), null, 'an unknown chunk');
  // A pillar of 3 at (5, 64..66), a stone slab over (7, 65, 7), an unloaded column at x = 11.
  b.world = flatWorld(63, ['5,64,5', '5,65,5', '5,66,5', '7,65,7'], (x) => x === 11);
  assert.deepEqual(xyz(groundAt(b as never, new Vec3(3.2, 64, 3.9))!), [3.5, 64, 3.5], 'flat ground: the block centre');
  assert.deepEqual(xyz(groundAt(b as never, new Vec3(3.2, 66.4, 3.9))!), [3.5, 64, 3.5], 'from above: down to the ground');
  assert.deepEqual(xyz(groundAt(b as never, [5, 64, 5])!), [5.5, 67, 5.5], 'on top of the pillar');
  assert.deepEqual(xyz(groundAt(b as never, [7, 64, 7])!), [7.5, 66, 7.5], 'no head room under the slab: on top of it');
  assert.equal(groundAt(b as never, [3, 75, 3]), null, 'the ground is more than `down` blocks below');
  assert.deepEqual(xyz(groundAt(b as never, [3, 75, 3], { down: 12 })!), [3.5, 64, 3.5]);
  assert.equal(groundAt(b as never, [11, 64, 0]), null, 'an unloaded column');
});

test("faceYaw: the commander's yaw through mineflayer's own conversions", async () => {
  const conv = createRequire(import.meta.url)('mineflayer/lib/conversions.js') as { fromNotchianYaw(y: number): number; fromNotchianPitch(p: number): number };
  for (const [yaw, pitch] of [[0, 0], [90, -30], [180, 45], [-90, 10], [370, -89]] as const) {
    assert.ok(Math.abs(mineflayerYaw(yaw) - conv.fromNotchianYaw(yaw)) < 1e-12, `yaw ${yaw}`);
    assert.ok(Math.abs(mineflayerPitch(pitch) - conv.fromNotchianPitch(pitch)) < 1e-12, `pitch ${pitch}`);
    // Mineflayer's view vector for its yaw/pitch is lookDir's for the commander's.
    const y = mineflayerYaw(yaw);
    const p = mineflayerPitch(pitch);
    const d = lookDir(yaw, pitch);
    assert.ok(Math.abs(-Math.sin(y) * Math.cos(p) - d.x) < 1e-9 && Math.abs(Math.sin(p) - d.y) < 1e-9 && Math.abs(-Math.cos(y) * Math.cos(p) - d.z) < 1e-9);
  }
  const b = new FakeBot('Bob');
  assert.deepEqual(await faceYaw(b as never, 90), { yaw: 90, pitch: 0 });
  assert.ok(Math.abs(b.entity.yaw - Math.PI / 2) < 1e-12, "yaw 90 (west) is mineflayer's π/2");
  assert.ok(b.calls.at(-1)!.endsWith(',force)'), 'forced: no wait for the server');
});

test('raiseShield: into the off-hand, held up once, again after something lowered it, lowered; no shield is an error', async () => {
  const b = new FakeBot('Guard', { items: [{ name: 'iron_sword', count: 1 }, { name: 'shield', count: 1 }] });
  assert.deepEqual(await raiseShield(b as never), { raised: true });
  assert.ok(b.calls.includes('equip(shield,off-hand)'));
  assert.equal(b.inventory.slots[OFF_HAND_SLOT]?.name, 'shield');
  assert.equal(b.usingHeldItem, true);
  await raiseShield(b as never);
  await raiseShield(b as never, true);
  assert.equal(b.calls.filter((c) => c === 'activateItem(offHand)').length, 1, 'already raised: nothing sent');
  assert.equal(b.calls.filter((c) => c.startsWith('equip')).length, 1, 'already in the off-hand');
  // Something lowered it (mineflayer clears usingHeldItem on an entity_status, a held-item change, auto-eat…).
  b.usingHeldItem = false;
  await raiseShield(b as never);
  assert.equal(b.calls.filter((c) => c === 'activateItem(offHand)').length, 2);
  assert.ok(SHIELD_REASSERT_MS >= 1000);
  assert.deepEqual(await raiseShield(b as never, false), { raised: false });
  assert.equal(b.calls.filter((c) => c === 'deactivateItem').length, 1);
  assert.equal(b.usingHeldItem, false);
  await raiseShield(b as never, false);
  assert.equal(b.calls.filter((c) => c === 'deactivateItem').length, 1, 'already lowered: nothing sent');
  // While auto-eat eats, neither: it lowered the shield to eat, and a use would not raise it.
  (b as unknown as { autoEat: { isEating: boolean } }).autoEat = { isEating: true };
  assert.deepEqual(await raiseShield(b as never), { raised: false });
  assert.equal(b.calls.filter((c) => c === 'activateItem(offHand)').length, 2);

  const none = new FakeBot('Bare', { items: [{ name: 'iron_sword', count: 1 }] });
  none.heldItem = { name: 'iron_sword' };
  await assert.rejects(
    raiseShield(none as never),
    (e: unknown) => e instanceof HelperError && /raiseShield\(Bare\): no shield in the off-hand or the inventory \(off-hand: empty, hand: iron_sword\)/.test((e as Error).message),
  );
});

/** An independent flight (pos += v; v × 0.99; v.y − 0.05, from the eyes − 0.1): the closest it comes to `target`. */
function closestApproach(feet: Vec3, yawDeg: number, pitchDeg: number, target: Vec3): number {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  let p = feet.offset(0, 1.52, 0);
  let v = new Vec3(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).scaled(3);
  let best = Infinity;
  for (let t = 0; t < 400; t++) {
    const q = p.plus(v);
    // The distance from the target to the segment p→q.
    const seg = q.minus(p);
    const k = Math.max(0, Math.min(1, target.minus(p).dot(seg) / (seg.dot(seg) || 1)));
    best = Math.min(best, p.plus(seg.scaled(k)).distanceTo(target));
    p = q;
    v = new Vec3(v.x * 0.99, v.y * 0.99 - 0.05, v.z * 0.99);
  }
  return best;
}

test('bowAim: the low arc whose flight passes within a block of the point (3 blocks/tick, gravity 0.05, drag 0.99)', () => {
  assert.deepEqual([ARROW.speed, ARROW.gravity, ARROW.drag], [3, 0.05, 0.99]);
  const from = new Vec3(0.5, 64, 0.5);
  for (const to of [new Vec3(10.5, 64, 0.5), new Vec3(0.5, 64, 30.5), new Vec3(-40, 64, -12), new Vec3(25, 70, 10), new Vec3(-15, 55, 20), new Vec3(60, 64, 0)]) {
    const a = bowAim(from, to);
    assert.ok(closestApproach(from, a.yaw, a.pitch, to) < 1, `to ${to}: yaw ${a.yaw} pitch ${a.pitch}`);
    assert.ok(a.pitch > -45, `the low arc (pitch ${a.pitch})`);
    assert.ok(Math.abs(a.error) < 0.05);
  }
  // The yaw is the commander's convention: a point due west is yaw 90.
  assert.ok(Math.abs(bowAim(from, new Vec3(-20, 64, 0.5)).yaw - 90) < 1e-9);
  // Out of range: the angle that gets nearest, falling short.
  const far = bowAim(from, new Vec3(500, 64, 0.5));
  assert.ok(far.error < 0 && far.pitch < -30 && far.pitch > -50, `the longest shot: pitch ${far.pitch}`);
});

test('shoot at a position: hawkEye gets { position, isValid: true }; the shot returns when the arrow has left', async () => {
  const b = new FakeBot('Archer', { items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] });
  const targets: unknown[] = [];
  b.hawkEye.oneShot = ((t: unknown) => {
    targets.push(t);
    const left = b.inventory.items().find((i) => i.name === 'arrow')!.count - 1;
    setTimeout(() => b.setItems([{ name: 'bow', count: 1 }, { name: 'arrow', count: left }]), 30);
  }) as never;
  assert.deepEqual(await shoot(b as never, new Vec3(12.3, 64, -4)), { shot: true });
  assert.equal(targets.length, 1);
  const t = targets[0] as { position: Vec3; isValid: boolean };
  assert.deepEqual([xyz(t.position), t.isValid, 'type' in t], [[12.3, 64, -4], true, false], 'a point to hawkEye: no `type`');
  assert.ok(!b.calls.includes('activateItem'), 'no manual shot');
  // An array is a position too, and so is a snapshot entity (no isValid: its position at the click).
  await shoot(b as never, [1, 64, 1]);
  assert.deepEqual(xyz((targets[1] as { position: Vec3 }).position), [1, 64, 1]);
  await shoot(b as never, { name: 'zombie', type: 'mob', position: new Vec3(5, 64, 5) } as never);
  assert.deepEqual(xyz((targets[2] as { position: Vec3 }).position), [5, 64, 5]);
});

test('shoot at a position: with no hawkEye trajectory, the bow is aimed by the ballistics and the shot made by hand', { timeout: 20_000 }, async () => {
  const b = new FakeBot('Archer', { position: new Vec3(0.5, 64, 0.5), items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] });
  const asked: unknown[] = [];
  Object.assign(b.hawkEye, { getMasterGrade: (t: unknown) => void asked.push(t) });
  b.deactivateItem = () => {
    b.calls.push('deactivateItem');
    b.setItems([{ name: 'bow', count: 1 }, { name: 'arrow', count: 9 }]);
  };
  const point = new Vec3(-30.5, 63, 18);
  await shoot(b as never, point);
  assert.equal(asked.length, 1, 'hawkEye was asked for a trajectory');
  assert.ok(!b.calls.includes('hawkEye.oneShot'), 'and not told to shoot without one');
  const look = b.calls.findIndex((c) => c.startsWith('look('));
  assert.ok(look >= 0 && look < b.calls.indexOf('activateItem') && b.calls.indexOf('activateItem') < b.calls.indexOf('deactivateItem'), b.calls.join(' '));
  // Back to the commander's convention from mineflayer's radians: the flight passes within a block of the point.
  const yaw = ((Math.PI - b.entity.yaw) * 180) / Math.PI;
  const pitch = (-b.entity.pitch * 180) / Math.PI;
  assert.ok(closestApproach(b.entity.position, yaw, pitch, point) < 1, `yaw ${yaw} pitch ${pitch}`);

  const c = new FakeBot('Archer2', { items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] });
  Object.assign(c.hawkEye, { getMasterGrade: () => undefined });
  await assert.rejects(shoot(c as never, point), /no arrow left the bow at \(-30, 63, 18\) .*no clear line of fire/);
});

test('entityOf: by network id, else a player by name, else the nearest of that name near the snapshot position', () => {
  const b = new FakeBot('Bob');
  const z1 = { id: 41, name: 'zombie', type: 'hostile', position: new Vec3(10, 64, 0), isValid: true };
  const z2 = { id: 42, name: 'zombie', type: 'hostile', position: new Vec3(14, 64, 0), isValid: true };
  const alice = { id: 7, name: 'player', type: 'player', username: 'Alice', position: new Vec3(3, 64, 3), isValid: true };
  b.entities = { 41: z1, 42: z2, 7: alice };
  b.players = { Alice: { entity: alice } };
  assert.equal(entityOf(b as never, { id: 42, name: 'zombie', type: 'mob', position: new Vec3(10, 64, 0) }), z2 as never, 'the id wins');
  assert.equal(entityOf(b as never, { name: 'zombie', type: 'mob', position: new Vec3(13, 64, 1) }), z2 as never, 'no id: the nearest zombie to the snapshot');
  assert.equal(entityOf(b as never, { name: 'zombie', type: 'mob', position: new Vec3(30, 64, 0) }), null, 'none within 4 blocks');
  assert.equal(entityOf(b as never, { id: 99, name: 'player', type: 'player', username: 'Alice', position: new Vec3(0, 64, 0) }), alice as never, 'a player by name');
  z2.isValid = false;
  // Its id gone, the zombie 4 blocks from where it stood is another one: not it.
  assert.equal(entityOf(b as never, { id: 42, name: 'zombie', type: 'mob', position: new Vec3(14, 64, 0) }), null, 'dead and gone');
  assert.equal(entityOf(b as never, { name: 'zombie', type: 'mob', position: new Vec3(14, 64, 0) }), z1 as never, 'without an id, the nearest of its kind');
  assert.equal(entityOf(b as never, { id: 99, name: 'player', type: 'player', username: 'Carol', position: new Vec3(0, 64, 0) }), null);
  assert.equal(entityOf(b as never, null), null);
});
