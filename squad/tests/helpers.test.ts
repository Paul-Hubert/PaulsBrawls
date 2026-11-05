// Helpers against the failures the production server showed (docs/29 §16), and the formation helpers of orders bound
// to items (docs/29 §5.4): the yaw convention, line slots, the ground, facing, the shield, shots (the release, a position
// on bowAim's arc; the aim itself is tests/aim.test.ts), the arrow's ballistics, snapshot entities, and where the
// commander points (pointedTarget).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { Vec3 } from 'vec3';

import {
  ARROW,
  ARROW_WAIT_MS,
  bowAim,
  enchantLevel,
  entityOf,
  faceYaw,
  goTo,
  groundAt,
  lineSlots,
  lookDir,
  mineflayerPitch,
  mineflayerYaw,
  OFF_HAND_SLOT,
  pointedTarget,
  raiseShield,
  SHIELD_REASSERT_MS,
  shoot,

} from '../src/api/helpers';
import { HelperError } from '../src/api/errors';
import { ORDER } from '../src/orders/guard';
import { ARROW_ENTITY, FakeBot, flatWorld, type FakeItem } from './fakes/fake-bot';
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

test('shoot: the release fires an arrow and the shot returns at once; a release that uses no arrow is an error', { timeout: 20_000 }, async () => {
  const target = { id: 5, name: 'husk', position: new Vec3(10, 80, 0), height: 1.95, isValid: true };
  const b = new FakeBot('Archer', { position: new Vec3(0, 80, 0), items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] }).archer();
  try {
    assert.deepEqual(await shoot(b as never, target as never), { shot: true });
    assert.equal(b.releases.length, 1);
    assert.ok(b.releases[0]!.fired && b.releases[0]!.drawnTicks >= 24, `drawn ${b.releases[0]!.drawnTicks} ticks`);
    assert.equal(b.calls.filter((c) => c === 'activateItem').length, 1, 'one draw');
  } finally {
    b.stopTicks();
  }
  // The server saw no draw (the release fires nothing): « no arrow left the bow ».
  const c = new FakeBot('Archer2', { items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] }).archer();
  c.deactivateItem = () => void c.calls.push('deactivateItem');
  try {
    await assert.rejects(shoot(c as never, target as never), /no arrow left the bow at husk \(10, 80, 0\)/);
  } finally {
    c.stopTicks();
  }
});

test('shoot with an Infinity bow: the arrow entity it owns is the shot, though the arrow count stays (docs/35 F3)', { timeout: 20_000 }, async () => {
  const target = { id: 5, name: 'husk', position: new Vec3(10, 80, 0), height: 1.95, isValid: true };
  const INFINITY = { name: 'bow', count: 1, enchants: [{ name: 'infinity', lvl: 1 }, { name: 'unbreaking', lvl: 3 }] };
  const PLAIN = { name: 'bow', count: 1 };
  const archer = (name: string, items: FakeItem[], id?: number) => {
    const b = new FakeBot(name, { position: new Vec3(0, 80, 0), items }).archer();
    if (id !== undefined) Object.assign(b.entity, { id });
    return b;
  };
  const arrowsOf = (b: FakeBot) => b.inventory.items().filter((i) => i.name === 'arrow').reduce((n, i) => n + i.count, 0);
  const bots: FakeBot[] = [];
  try {
    // Owned by the bot (the spawn packet's data is its entity id): resolves at once, no wait for a count that never drops.
    const a = archer('Archer', [INFINITY, { name: 'arrow', count: 64 }], 7);
    bots.push(a);
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      assert.deepEqual(await shoot(a as never, target as never), { shot: true });
      assert.ok(Date.now() - t0 < ARROW_WAIT_MS, `shot ${i} returned with the arrow's spawn, not after the ${ARROW_WAIT_MS} ms wait`);
    }
    assert.equal(a.releases.filter((r) => r.fired).length, 3);
    assert.equal(arrowsOf(a), 64, 'Infinity: the arrows stay');
    assert.equal(a.calls.filter((c) => c === 'activateItem').length, 3, 'one draw per shot, no second (manual) one');

    // No owner id to go by (the bot's own id unknown): an arrow at its eyes is its own.
    const b = archer('Archer2', [INFINITY, { name: 'arrow', count: 64 }]);
    bots.push(b);
    assert.deepEqual(await shoot(b as never, target as never), { shot: true });

    // Another shooter's arrow is not this bot's shot.
    const c = archer('Archer3', [INFINITY, { name: 'arrow', count: 64 }], 8);
    bots.push(c);
    const fire = c.deactivateItem.bind(c);
    c.deactivateItem = () => {
      c.drawnAt = null; // the release sends nothing that fires
      c.calls.push('deactivateItem');
      c._client.emit('spawn_entity', { entityId: 1, type: ARROW_ENTITY.internalId, objectData: 99, x: 0, y: 81.5, z: 0 });
    };
    await assert.rejects(shoot(c as never, target as never), /no arrow left the bow/);
    c.deactivateItem = fire;

    // A plain bow still works by the count.
    const d = archer('Archer4', [PLAIN, { name: 'arrow', count: 10 }], 9);
    bots.push(d);
    assert.deepEqual(await shoot(d as never, target as never), { shot: true });
    assert.equal(arrowsOf(d), 9);

    // The bow in hand first (/bots equip put the new one there, the old one went to the main inventory, listed first).
    const e = archer('Archer5', [PLAIN, { name: 'arrow', count: 10 }, INFINITY], 10);
    bots.push(e);
    e.heldItem = { ...INFINITY };
    await shoot(e as never, target as never);
    assert.ok(!e.calls.some((x) => x.startsWith('equip(')), 'the held bow, not re-equipped');
    assert.equal(arrowsOf(e), 10);
    // Nothing in hand but a sword: the Infinity bow over the plain one listed before it.
    e.heldItem = { name: 'stone_sword' };
    await shoot(e as never, target as never);
    assert.ok(e.calls.includes('equip(bow,hand)'));
    assert.equal(e.heldItem?.enchants?.[0]?.name, 'infinity');
    assert.equal(arrowsOf(e), 10);
  } finally {
    for (const b of bots) b.stopTicks();
  }
});

test('enchantLevel: by name before 1.20.5, by registry id from the 1.21.1 component', () => {
  const b = new FakeBot('Bob');
  (b.registry as Record<string, unknown>).enchantments = { 16: { name: 'infinity' }, 39: { name: 'unbreaking' } };
  assert.equal(enchantLevel(b as never, { name: 'bow', enchants: [{ name: 'infinity', lvl: 1 }] }, 'infinity'), 1);
  const component = { name: 'bow', enchants: { enchantments: [{ id: 16, level: 1 }, { id: 39, level: 3 }], showTooltip: true } };
  assert.equal(enchantLevel(b as never, component, 'unbreaking'), 3);
  assert.equal(enchantLevel(b as never, component, 'infinity'), 1);
  assert.equal(enchantLevel(b as never, { name: 'bow', enchants: [] }, 'infinity'), 0);
  assert.equal(enchantLevel(b as never, { name: 'bow' }, 'infinity'), 0);
  const throwing = { name: 'bow', get enchants(): never { throw new Error('bad component'); } };
  assert.equal(enchantLevel(b as never, throwing, 'infinity'), 0);
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

test('shoot at a position: the low arc through it (bowAim), not led; arrays and snapshot refs are positions', { timeout: 20_000 }, async () => {
  const from = new Vec3(0.5, 64, 0.5);
  const b = new FakeBot('Archer', { position: from.clone(), items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] }).archer();
  try {
    const point = new Vec3(-30.5, 63, 18);
    assert.deepEqual(await shoot(b as never, point), { shot: true });
    // Back to the commander's convention from mineflayer's radians: the flight at the release passes through the point.
    const r = b.releases[0]!;
    const yaw = ((Math.PI - r.yaw) * 180) / Math.PI;
    const pitch = (-r.pitch * 180) / Math.PI;
    assert.ok(closestApproach(from, yaw, pitch, point) < 0.5, `yaw ${yaw} pitch ${pitch}`);
    assert.ok(Math.abs(pitch - bowAim(from, point).pitch) < 0.2, `bowAim's pitch: ${pitch} vs ${bowAim(from, point).pitch}`);
    // An array is a position too, and so is a snapshot entity (no isValid: its position at the click).
    await shoot(b as never, [1, 64, 12]);
    await shoot(b as never, { name: 'zombie', type: 'mob', position: new Vec3(5, 64, 15) } as never);
    assert.equal(b.releases.length, 3);
    const last = b.releases[2]!;
    assert.ok(closestApproach(from, ((Math.PI - last.yaw) * 180) / Math.PI, (-last.pitch * 180) / Math.PI, new Vec3(5, 64, 15)) < 0.5, 'at the ref');
  } finally {
    b.stopTicks();
  }
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

/** A bot of an order whose team is Paul and Mate (pointedTarget reads the order's friends through the bot). */
function teamBot(): FakeBot {
  const b = new FakeBot('Archer');
  (b as unknown as Record<symbol, unknown>)[ORDER] = { friends: new Set(['Paul', 'Mate', 'Archer']) };
  return b;
}

/** ctx.commander.at with nothing looked at, Paul at (0.5, 64, 0.5); `over` adds what the click saw. */
const pointing = (over: Record<string, unknown> = {}) =>
  ({ position: new Vec3(0.5, 64, 0.5), yaw: -90, pitch: 0, dimension: 'overworld', heldItem: null, lookBlock: null, lookEntity: null, ...over }) as never;
const block = (x: number, y: number, z: number) => Object.assign(new Vec3(x, y, z), { name: 'stone' });

test('pointedTarget: the point is the arrow hit, else the crosshair entity, else the top of the block; the entity is the one there or the nearest within `near`', () => {
  const b = teamBot();
  const z = { id: 50, name: 'zombie', type: 'hostile', position: new Vec3(12.5, 64, 0.5), isValid: true };
  const cow = { id: 51, name: 'cow', type: 'animal', position: new Vec3(30.5, 64, 30.5), isValid: true };
  b.entities = { 50: z, 51: cow };
  const xyzOf = (v: Vec3 | null) => (v ? xyz(v) : null);

  // The block looked at: its top centre; the zombie 2 blocks from it is the target.
  let p = pointedTarget(b as never, pointing({ lookBlock: block(10, 63, 0) }));
  assert.deepEqual([xyzOf(p.position), p.entity, p.pending], [[10.5, 64, 0.5], z, false]);
  // 6 blocks away: beyond the default `near` (4), not with near 8; near 0 only takes the exact one.
  p = pointedTarget(b as never, pointing({ lookBlock: block(18, 63, 0) }));
  assert.deepEqual([xyzOf(p.position), p.entity], [[18.5, 64, 0.5], null]);
  assert.equal(pointedTarget(b as never, pointing({ lookBlock: block(18, 63, 0) }), { near: 8 }).entity, z as never);
  assert.equal(pointedTarget(b as never, pointing({ lookBlock: block(10, 63, 0) }), { near: 0 }).entity, null);
  // The crosshair entity: its position, itself (also with near 0).
  const look = { id: 50, name: 'zombie', type: 'mob', position: new Vec3(12.5, 64, 0.5) };
  p = pointedTarget(b as never, pointing({ lookEntity: look, lookBlock: block(20, 63, 0) }), { near: 0 });
  assert.deepEqual([xyzOf(p.position), p.entity], [[12.5, 64, 0.5], z]);
  // An arrow's hit wins over the look: the point it hit, and the zombie next to it; or the creature it hit.
  const hitGround = { kind: 'arrow-hit', item: 'bow', hit: { position: new Vec3(13, 64.1, 2) } };
  p = pointedTarget(b as never, pointing({ lookBlock: block(-20, 63, 0), trigger: hitGround }));
  assert.deepEqual([xyzOf(p.position), p.entity], [[13, 64.1, 2], z]);
  const hitCow = { kind: 'arrow-hit', item: 'bow', hit: { position: new Vec3(30.5, 65, 30.5), entity: { id: 51, name: 'cow', type: 'mob', position: new Vec3(30.5, 64, 30.5) } } };
  assert.equal(pointedTarget(b as never, pointing({ trigger: hitCow })).entity, cow as never);
  // A release: pending, the look provisionally.
  p = pointedTarget(b as never, pointing({ lookBlock: block(10, 63, 0), trigger: { kind: 'arrow-release', item: 'bow' } }));
  assert.deepEqual([xyzOf(p.position), p.entity, p.pending], [[10.5, 64, 0.5], z, true]);
  // A right-click reads like no trigger at all; the sky is nothing.
  assert.equal(pointedTarget(b as never, pointing({ lookBlock: block(10, 63, 0), trigger: { kind: 'use', item: 'stick' } })).entity, z as never);
  assert.deepEqual(pointedTarget(b as never, pointing()), { position: null, entity: null, pending: false });
  assert.throws(() => pointedTarget(b as never, pointing(), { near: -1 }), /near must be a number of blocks ≥ 0/);
});

test('pointedTarget: only a living, valid, non-friend, non-spectator entity qualifies (and filter); pointing at a friend gives the one nearest them', () => {
  const b = teamBot();
  const at = (x: number, z: number) => new Vec3(10.5 + x, 64, 0.5 + z);
  const mate = { id: 60, name: 'player', type: 'player', username: 'Mate', position: at(0.5, 0), isValid: true };
  const item = { id: 61, name: 'item', type: 'other', position: at(0.3, 0), isValid: true };
  const arrow = { id: 62, name: 'arrow', type: 'projectile', position: at(0, 0.6), isValid: true };
  const stand = { id: 63, name: 'armor_stand', type: 'mob', position: at(0.7, 0), isValid: true }; // the registry says 'living'
  const orb = { id: 64, name: 'experience_orb', type: 'other', position: at(0, -0.4), isValid: true };
  const spy = { id: 65, name: 'player', type: 'player', username: 'Spy', position: at(0.8, 0), isValid: true };
  const dead = { id: 66, name: 'zombie', type: 'hostile', position: at(0.2, 0.2), isValid: false };
  const enemy = { id: 67, name: 'player', type: 'player', username: 'Enemy', position: at(3, 0), isValid: true };
  const z = { id: 68, name: 'zombie', type: 'hostile', position: at(0, 3.5), isValid: true };
  b.entities = Object.fromEntries([mate, item, arrow, stand, orb, spy, dead, enemy, z].map((e) => [e.id, e]));
  b.players = { Mate: { entity: mate, gamemode: 0 }, Spy: { entity: spy, gamemode: 3 }, Enemy: { entity: enemy, gamemode: 0 } };
  b.registry.entitiesByName.armor_stand = { type: 'living' } as never;

  const look = pointing({ lookBlock: block(10, 63, 0) });
  assert.equal(pointedTarget(b as never, look).entity, enemy as never, 'past the friend, the item, the arrow, the stand, the orb, the spectator and the dead');
  assert.equal(pointedTarget(b as never, look, { filter: (e) => e.type !== 'player' }).entity, z as never, 'filter');
  // The crosshair on a friend: the qualifying entity nearest them; none within `near`: no entity, their position.
  const onMate = pointing({ lookEntity: { id: 60, name: 'player', type: 'player', username: 'Mate', position: mate.position } });
  assert.equal(pointedTarget(b as never, onMate).entity, enemy as never);
  const p = pointedTarget(b as never, onMate, { near: 1 });
  assert.deepEqual([p.entity, xyz(p.position!)], [null, xyz(mate.position)]);
});
