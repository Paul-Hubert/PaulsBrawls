// The orbit (docs/47): the ring's geometry and per-look decisions as pure functions (the heading on, outside and
// inside the circle, the spacing lanes, the arc's turns, the threat modes, the jink's window), what jinking buys
// against our own aim as the enemy's, and the ring on riding FakeBots: joining and holding the radius, spread round,
// breaking away from a zombie that comes near, a wall on the circle, the jinks out of the draw's end, withdrawing when
// hurt, stopping; then the stock `attack` with horse archers on a zombie group.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { Vec3 } from 'vec3';

import { BOW_SPEED, DRAG, GRAVITY } from '../src/aim/arrow.mjs';
import { solveAim, type AimInput, type AimWorld } from '../src/aim/solve.mjs';
import {
  ORBIT_ARC_HALF,
  ORBIT_ARC_MS,
  ORBIT_TURN,
  angleRound,
  arcTurn,
  canOrbit,
  jinkMayStart,
  orbitHeading,
  orbitLanes,
  orbitMode,
  orbitRing,
  wrapAngle,
} from '../src/api/orbit';
import { HORSE_SEAT, HORSE_SPEED, PLAYER_EYES } from '../src/bots/mount';
import { loadStock } from '../src/stock';
import { EMPTY_SNAPSHOT, type Snapshot } from '../src/types';
import { StateTables } from '../src/world/reader.mjs';
import { buildStateTables } from '../src/world/tables.mjs';
import { FakeBot, flatWorld, type FakeItem } from './fakes/fake-bot';
import { harness, PAUL, until } from './fakes/harness';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

const BOW: FakeItem[] = [
  { name: 'bow', count: 1 },
  { name: 'arrow', count: 64 },
];
let nextId = 700;
const zombie = (x: number, z: number) => ({ id: nextId++, type: 'hostile', name: 'zombie', position: new Vec3(x, 64, z), isValid: true, height: 1.95, width: 0.6 });

/** Seat a FakeBot on a horse, as mount.ts leaves a rider. */
function ride(b: FakeBot): FakeBot {
  Object.assign(b, { vehicle: { id: nextId++, name: 'horse', position: b.entity.position.clone() } });
  Object.assign(b.entity, { id: nextId++, eyeHeight: PLAYER_EYES + HORSE_SEAT, attributes: { 'minecraft:movement_speed': { value: HORSE_SPEED / 1.3, modifiers: [] } } });
  return b;
}
const flatD = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const C = new Vec3(0.5, 64, 0.5);

// -- the geometry ------------------------------------------------------------------------------------------------

test('orbitHeading: on the circle, the tangent (either way round); far out, toward the tangent point, at most 60° in; inside, out by up to 60°', () => {
  const c = { x: 0, z: 0 };
  // On the circle at angle 0 (+x): going round with the angle rising is +z; the other way, −z.
  const h = orbitHeading({ x: 30, z: 0 }, c, 30, 1);
  assert.ok(Math.abs(h.x) < 1e-9 && Math.abs(h.z - 1) < 1e-9, `tangent: ${h.x} ${h.z}`);
  const back = orbitHeading({ x: 30, z: 0 }, c, 30, -1);
  assert.ok(Math.abs(back.z + 1) < 1e-9);
  // 4 outside: in by min(90° − asin(30/34), 60° × 4/8) = 28.07°.
  const out4 = orbitHeading({ x: 34, z: 0 }, c, 30, 1);
  const in4 = Math.atan2(-out4.x, out4.z);
  assert.ok(Math.abs(in4 - (Math.PI / 2 - Math.asin(30 / 34))) < 1e-9, `in by ${((in4 * 180) / Math.PI).toFixed(2)}°`);
  // Far: capped at 60° in, so it closes on the circle without riding at the centre.
  const far = orbitHeading({ x: 200, z: 0 }, c, 30, 1);
  assert.ok(Math.abs(Math.atan2(-far.x, far.z) - ORBIT_TURN) < 1e-9);
  // 8 inside: out by the full 60°.
  const inside = orbitHeading({ x: 22, z: 0 }, c, 30, 1);
  assert.ok(Math.abs(Math.atan2(inside.x, inside.z) - ORBIT_TURN) < 1e-9, 'out at 60°');
  // Unit vectors.
  for (const v of [h, out4, far, inside]) assert.ok(Math.abs(Math.hypot(v.x, v.z) - 1) < 1e-9);
});

test('orbitHeading: followed tick by tick from 80 blocks out, the rider joins the circle and holds it within half a block', () => {
  const c = { x: 0, z: 0 };
  let p = { x: 80, z: 5 };
  const rs: number[] = [];
  for (let t = 0; t < 2000; t++) {
    const h = orbitHeading(p, c, 30, 1);
    p = { x: p.x + h.x * 0.5, z: p.z + h.z * 0.5 };
    rs.push(Math.hypot(p.x, p.z));
  }
  const late = rs.slice(400);
  assert.ok(Math.min(...rs) > 29, `never cut inside: ${Math.min(...rs).toFixed(2)}`);
  assert.ok(Math.max(...late) - 30 < 0.5 && 30 - Math.min(...late) < 0.5, `held: ${Math.min(...late).toFixed(2)}–${Math.max(...late).toFixed(2)}`);
});

test('orbitLanes: evenly spread, every lane 0; bunched, the one close behind takes the outer lane, the one far behind the inner', () => {
  assert.deepEqual(orbitLanes([0, Math.PI / 2, Math.PI, -Math.PI / 2], 1), [0, 0, 0, 0]);
  // Three riders: 0 and 0.3 together, 3 opposite. Going round with the angle rising, 0 has 0.3 just ahead (outer);
  // 0.3 has 3 ahead (2.84, in the share 2.09 × [0.5, 1.5]: lane 0); 3 has 0 ahead at 3.28 (> 3.14: inner).
  assert.deepEqual(orbitLanes([0, 0.3, 3], 1), [1, 0, -1]);
  // The other way round, the roles swap.
  assert.deepEqual(orbitLanes([0, 0.3, 3], -1), [-1, 1, 0]);
  assert.deepEqual(orbitLanes([1], 1), [0]);
});

test('arcTurn: outside the arc, toward it the short way; at its ends, back; inside, as it goes', () => {
  const half = ORBIT_ARC_HALF;
  assert.equal(arcTurn(Math.PI, 0, half, 1), -1, 'opposite (just past π): the short way');
  assert.equal(arcTurn(-2, 0, half, 1), 1);
  assert.equal(arcTurn(half + 0.01, 0, half, 1), -1, 'past the + end going +: back');
  assert.equal(arcTurn(-half - 0.01, 0, half, -1), 1);
  assert.equal(arcTurn(0.2, 0, half, -1), -1, 'inside: as it goes');
  assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-12 && Math.abs(wrapAngle(-Math.PI / 2) + Math.PI / 2) < 1e-12);
});

test('orbitMode: withdraw under 40 % (until 70 %); break from an enemy within 12 or closing faster than 7 b/s within 32; an arrow hit: the far arc for 15 s; else the circle', () => {
  const base = { pos: { x: 30, z: 0 }, center: { x: 0, z: 0 }, health: 20, withdrawn: false, foes: [], breaking: null, hit: null, now: 100_000 };
  assert.deepEqual(orbitMode(base), { kind: 'circle' });
  assert.deepEqual(orbitMode({ ...base, health: 7 }), { kind: 'withdraw' });
  assert.deepEqual(orbitMode({ ...base, health: 12, withdrawn: true }), { kind: 'withdraw' }, 'still under 70 %');
  assert.deepEqual(orbitMode({ ...base, health: 14, withdrawn: true }), { kind: 'circle' }, 'back at 70 %');
  const near = { id: 5, position: { x: 40, z: 0 }, closing: 0 };
  assert.deepEqual(orbitMode({ ...base, foes: [near] }), { kind: 'break', from: near.position, id: 5 });
  const charging = { id: 6, position: { x: 55, z: 0 }, closing: 9 };
  assert.equal(orbitMode({ ...base, foes: [charging] }).kind, 'break', 'a horseman closing at 9 b/s from 25 out');
  assert.equal(orbitMode({ ...base, foes: [{ ...charging, closing: 5 }] }).kind, 'circle', 'a walker closing at 5 b/s: not a threat yet');
  // A break goes on until 24 out, even once the foe is beyond 12.
  const after = { id: 5, position: { x: 50, z: 0 }, closing: 0 };
  assert.equal(orbitMode({ ...base, foes: [after], breaking: { id: 5, since: base.now - 1000 } }).kind, 'break');
  assert.equal(orbitMode({ ...base, foes: [{ ...after, position: { x: 60, z: 0 } }], breaking: { id: 5, since: base.now - 1000 } }).kind, 'circle');
  // Shot from the west of the group: the far side is east (angle 0).
  const shot = orbitMode({ ...base, hit: { from: { x: -40, z: 0 }, at: base.now - 1000 } });
  assert.equal(shot.kind, 'arc');
  assert.ok(shot.kind === 'arc' && Math.abs(shot.far) < 1e-9);
  assert.equal(orbitMode({ ...base, hit: { from: { x: -40, z: 0 }, at: base.now - ORBIT_ARC_MS - 1 } }).kind, 'circle');
  // Withdrawing beats everything.
  assert.equal(orbitMode({ ...base, health: 5, foes: [near] }).kind, 'withdraw');
});

test('jinkMayStart: always with the bow down; drawn, only a pulse that ends by draw tick 15', () => {
  assert.equal(jinkMayStart(false, 0, 5), true);
  assert.equal(jinkMayStart(true, 10, 5), true);
  assert.equal(jinkMayStart(true, 11, 5), false);
  assert.equal(jinkMayStart(true, 20, 3), false);
});

// -- what jinking buys (our own aim as the enemy's) -----------------------------------------------------------------

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.1') as { blocksByName: Record<string, { defaultState: number }> };
const TABLES = new StateTables(buildStateTables(registry));
const STONE = registry.blocksByName.stone!.defaultState;
const FLOOR: AimWorld = { dimIndex: () => 0, stateIdIn: (_d, _x, y) => (y <= 63 ? STONE : 0), states: TABLES as unknown as AimWorld['states'] };

/** A seeded random (a linear congruential generator). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * The fraction of an enemy archer's arrows that hit a rider circling at 30 blocks round (0, 0) at 10 b/s, with and
 * without jinks (the gallop let go 3–5 ticks every 20–40, the ground's inertia 0.546 per tick). The enemy stands at
 * `at` and aims as ours do: the rider's velocity a least-squares fit of its last 16 ticks, led 4 ticks to the release
 * then along the flight; the bow's spread (±0.5° per axis); hit: the horse's box with the arrow's margin, up to the
 * rider's head.
 */
function enemyHitRate(jink: boolean, at: { x: number; z: number }, seed: number): { rate: number; shots: number; speed: number } {
  const rand = seeded(seed);
  const INERTIA = 0.546;
  const V = 0.5;
  const ACCEL = (V * (1 - INERTIA)) / INERTIA;
  const path: Array<{ x: number; z: number }> = [];
  let angle = 0;
  let v = V;
  let next = 20 + Math.floor(rand() * 21);
  let off = 0;
  for (let t = 0; t < 4000; t++) {
    let on = true;
    if (jink) {
      if (off > 0) {
        off--;
        on = false;
      } else if (--next <= 0) {
        off = 2 + Math.floor(rand() * 3);
        next = 20 + Math.floor(rand() * 21);
        on = false;
      }
    }
    v = (v + (on ? ACCEL : 0)) * INERTIA;
    angle += v / 30;
    path.push({ x: 30 * Math.cos(angle), z: 30 * Math.sin(angle) });
  }
  const fit = (ps: Array<{ x: number; z: number }>) => {
    const n = ps.length;
    const mt = (n - 1) / 2;
    const mx = ps.reduce((s, p) => s + p.x, 0) / n;
    const mz = ps.reduce((s, p) => s + p.z, 0) / n;
    let nx = 0;
    let nz = 0;
    let d = 0;
    ps.forEach((p, i) => {
      nx += (i - mt) * (p.x - mx);
      nz += (i - mt) * (p.z - mz);
      d += (i - mt) ** 2;
    });
    return { vx: nx / d, vz: nz / d };
  };
  const spread = () => 0.0172275 * (rand() - rand());
  let hits = 0;
  let shots = 0;
  const lead = 4;
  for (let t0 = 40; t0 + 80 < path.length; t0 += 30) {
    const now = path[t0]!;
    const vel = fit(path.slice(t0 - 15, t0 + 1));
    const from = { x: at.x, y: 64 + 1.52, z: at.z };
    const input: AimInput = { dim: null, speed: BOW_SPEED, from, vel: { x: 0, y: 0, z: 0 }, shooter: 1, lead, target: { id: 50, x: now.x, y: 64, z: now.z, vx: vel.vx, vy: 0, vz: vel.vz, width: 1.4, height: 2.64 } };
    const s = solveAim(input, FLOOR, null);
    let dx = -Math.sin(s.yaw) * Math.cos(s.pitch) + spread();
    let dy = Math.sin(s.pitch) + spread();
    let dz = -Math.cos(s.yaw) * Math.cos(s.pitch) + spread();
    const n = Math.hypot(dx, dy, dz);
    [dx, dy, dz] = [(dx / n) * BOW_SPEED, (dy / n) * BOW_SPEED, (dz / n) * BOW_SPEED];
    let [x, y, z] = [from.x, from.y, from.z];
    let hit = false;
    for (let k = 0; k < 60 && !hit && y > 60; k++) {
      const tp = path[t0 + lead + k]!;
      for (let i = 0; i <= 20 && !hit; i++) {
        const f = i / 20;
        hit = Math.abs(x + dx * f - tp.x) <= 1 && Math.abs(z + dz * f - tp.z) <= 1 && y + dy * f >= 63.7 && y + dy * f <= 66.94;
      }
      [x, y, z] = [x + dx, y + dy, z + dz];
      [dx, dy, dz] = [dx * DRAG, dy * DRAG - GRAVITY, dz * DRAG];
    }
    shots++;
    if (hit) hits++;
  }
  let d = 0;
  for (let i = 1; i < path.length; i++) d += flatD(path[i]!, path[i - 1]!);
  return { rate: hits / shots, shots, speed: (d / path.length) * 20 };
}

test('jinks: a steady circle is hit by an archer aiming as ours do nearly every time; jinking, well under half as often (docs/47 §3)', () => {
  for (const at of [{ x: 0, z: 0 }, { x: -8, z: 0 }]) {
    const steady = enemyHitRate(false, at, 7);
    const jinking = enemyHitRate(true, at, 7);
    assert.ok(steady.rate >= 0.95, `steady, the enemy at (${at.x}, ${at.z}): ${(steady.rate * 100).toFixed(0)} % of ${steady.shots}`);
    assert.ok(jinking.rate <= 0.5, `jinking: ${(jinking.rate * 100).toFixed(0)} % of ${jinking.shots}`);
    assert.ok(jinking.speed > 8, `the jinks cost little speed: ${jinking.speed.toFixed(1)} b/s`);
  }
});

// -- the ring on riding fakes ----------------------------------------------------------------------------------------

/** Riders with bows on flat ground, each on its own physics ticker, seeing `world` entities. */
function riders(spots: Array<[number, number]>, world: Record<string, unknown> = {}, ground = flatWorld(63)): FakeBot[] {
  return spots.map(([x, z], i) => {
    const b = ride(new FakeBot(`Hac${i}`, { items: BOW }));
    b.entity.position = new Vec3(x, 64, z);
    b.world = ground;
    b.entities = world;
    b.physics({ tickMs: 2 });
    return b;
  });
}

test('orbitRing: a rider from 60 out joins the 30-block circle and holds it, going round; stop() lets go of the gallop and the rein', { timeout: 15_000 }, async () => {
  const [b] = riders([[60.5, 0.5]]);
  const ring = orbitRing({ jink: false });
  const timer = setInterval(() => ring.step([b as never], C), 20);
  try {
    assert.ok(canOrbit(b as never));
    await until(() => Math.abs(flatD(b!.entity.position, C) - 30) < 1.5, 5_000, 'on the circle');
    const a0 = angleRound(b!.entity.position, C);
    const rs: number[] = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 10));
      rs.push(flatD(b!.entity.position, C));
    }
    assert.ok(Math.max(...rs) < 32 && Math.min(...rs) > 28, `held: ${Math.min(...rs).toFixed(1)}–${Math.max(...rs).toFixed(1)}`);
    assert.ok(wrapAngle(angleRound(b!.entity.position, C) - a0) > 0.05, 'going round with the angle rising');
    assert.ok((b!.entity as { moveYaw?: number }).moveYaw !== undefined, 'the rein held: the horse goes its own way');
    assert.equal(ring.modeOf(b as never), 'circle');
  } finally {
    clearInterval(timer);
    ring.stop();
    b!.stopTicks();
  }
  assert.ok(!b!.controlState.forward && !b!.controlState.sprint, 'the gallop let go');
  assert.equal((b!.entity as { moveYaw?: number }).moveYaw, undefined, 'the rein released');
  assert.equal(ring.modeOf(b as never), 'idle');
});

test('orbitRing: three riders starting together spread round the circle (lanes), all going the same way', { timeout: 20_000 }, async () => {
  const bs = riders([[30.5, 0.5], [30.5, 2.5], [30.5, -1.5]]);
  const ring = orbitRing({ jink: false });
  const timer = setInterval(() => ring.step(bs as never, C), 20);
  const gaps = () => {
    const as = bs.map((b) => ((angleRound(b.entity.position, C) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).sort((x, y) => x - y);
    return as.map((a, i) => (i + 1 < as.length ? as[i + 1]! - a : as[0]! + 2 * Math.PI - a));
  };
  try {
    const before = Math.min(...gaps());
    await until(() => Math.min(...gaps()) > 0.6, 15_000, `spread out (gaps ${gaps().map((g) => g.toFixed(2)).join(' ')})`);
    assert.ok(before < 0.2, `bunched at the start: ${before.toFixed(2)}`);
  } finally {
    clearInterval(timer);
    ring.stop();
    for (const b of bs) b.stopTicks();
  }
});

test('orbitRing: a zombie that comes within 12 sends the rider away from it, and it comes back to the circle', { timeout: 15_000 }, async () => {
  const z = zombie(30.5, 0.5);
  const world: Record<string, unknown> = { [z.id]: z };
  const [b] = riders([[30.5, -12.5]], world);
  const ring = orbitRing({ jink: false });
  const timer = setInterval(() => ring.step([b as never], C), 20);
  try {
    await until(() => ring.modeOf(b as never) === 'break', 2_000, 'breaking away');
    await until(() => flatD(b!.entity.position, z.position) >= 23, 5_000, 'out to 24 from it');
    assert.ok(ring.breaks >= 1);
    z.isValid = false;
    delete world[z.id];
    await until(() => ring.modeOf(b as never) === 'circle' && Math.abs(flatD(b!.entity.position, C) - 30) < 2, 8_000, 'back on the circle');
  } finally {
    clearInterval(timer);
    ring.stop();
    b!.stopTicks();
  }
});

test('orbitRing: a wall across the circle: the rider moves its lane round it, or turns back; it never stays stuck on it', { timeout: 20_000 }, async () => {
  // A wall 3 high from x 20 to 50 at z 15–16: across the circle's east side, from 18 inside to 20 outside.
  const wall: string[] = [];
  for (let x = 12; x <= 50; x++) for (let y = 64; y <= 66; y++) for (const z of [15, 16]) wall.push(`${x},${y},${z}`);
  const ground = flatWorld(63, wall);
  const [b] = riders([[30.5, -10.5]], {}, ground);
  const blockedAt = (p: Vec3) => wall.includes(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`);
  // The fake's physics walks through blocks: stop the body at the wall, as the server would.
  b!.on('physicsTick', () => {
    const p = b!.entity.position;
    if (blockedAt(p)) b!.entity.position = new Vec3(p.x, p.y, p.z < 15.5 ? 14.6 : 17.4);
  });
  const ring = orbitRing({ jink: false });
  const timer = setInterval(() => ring.step([b as never], C), 20);
  try {
    // Going round with the angle rising from (30, −10), it meets the wall at z 15: it turns back before it.
    await until(() => ring.reversals >= 1, 8_000, 'turned back at the wall');
    const z0 = b!.entity.position.z;
    await until(() => b!.entity.position.z < z0 - 3, 4_000, 'riding away from the wall');
  } finally {
    clearInterval(timer);
    ring.stop();
    b!.stopTicks();
  }
});

test('orbitRing: jinks let go of the gallop for a few ticks, never after draw tick 15; withdrawn under 40 % health it rides out to 64 and holds, not shooting', { timeout: 20_000 }, async () => {
  const [b] = riders([[30.5, 0.5]]);
  b!.stopTicks();
  const ring = orbitRing({ random: seeded(3) });
  ring.step([b as never], C);
  // Ticked by hand: a draw from tick 100 to 124, the gallop recorded each tick.
  const off: number[] = [];
  for (let t = 0; t < 400; t++) {
    b!.usingHeldItem = (t % 40) >= 10 && (t % 40) < 34; // drawn on ticks 10–33 of every 40
    b!.tick();
    if (!b!.controlState.forward) off.push(t);
    if (t % 4 === 0) ring.step([b as never], C);
  }
  assert.ok(off.length >= 10, `jinked: ${off.length} ticks off`);
  for (const t of off) assert.ok(!((t % 40) >= 10 + 16 && (t % 40) < 34), `no jink late in the draw (tick ${t % 40 - 10} of it)`);
  // Hurt: out to 64 from the centre, then held there.
  b!.usingHeldItem = false;
  b!.health = 6;
  b!.physics({ tickMs: 2 });
  const timer = setInterval(() => ring.step([b as never], C), 20);
  try {
    await until(() => ring.modeOf(b as never) === 'withdraw', 1_000, 'withdrawing');
    assert.equal(ring.canShoot(b as never), false);
    await until(() => flatD(b!.entity.position, C) >= 64, 8_000, 'out to 64');
    await until(() => !b!.controlState.forward, 1_000, 'holding there');
    b!.health = 15;
    await until(() => ring.modeOf(b as never) === 'circle' && ring.canShoot(b as never), 1_000, 'healed: back to the circle');
  } finally {
    clearInterval(timer);
    ring.stop();
    b!.stopTicks();
  }
});

// -- the stock attack ----------------------------------------------------------------------------------------------

const stock = await loadStock();

test('attack (horse archers): they circle the zombie group at `orbit` and shoot on the move until it is down; orbit=0: they shoot from where they stand (docs/47)', { timeout: 30_000 }, async () => {
  for (const orbitArg of [null, 0]) {
    const h = harness({ stock });
    const commander = { id: 1, type: 'player', username: 'Paul', name: 'player', position: new Vec3(0.5, 64, 0.5), isValid: true, height: 1.8 };
    const world: Record<string, unknown> = { 1: commander };
    const players: Record<string, { entity: unknown }> = { Paul: { entity: commander } };
    const bs = [0, 1].map((i) => {
      const b = ride(h.bot(`Hac${i}`, [PAUL], BOW) as FakeBot);
      b.entity.position = new Vec3(i * 3 + 0.5, 64, 0.5);
      world[(b.entity as unknown as { id: number }).id] = b.entity;
      players[b.username] = { entity: b.entity };
      b.entities = world;
      b.players = players;
      b.world = flatWorld(63);
      b.physics({ tickMs: 2 });
      b.archer();
      return b;
    });
    // On foot (orbit=0) a target farther than 24 from every bot that vanishes is « lost from sight », not dead: nearer.
    const dz = orbitArg === 0 ? 20 : 40;
    const target = zombie(0.5, dz + 0.5);
    const other = zombie(4.5, dz + 2.5);
    world[target.id] = target;
    world[other.id] = other;
    const snap: Snapshot = { ...EMPTY_SNAPSHOT, position: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, lookEntity: { id: target.id, name: 'zombie', type: 'mob', position: { x: 0.5, y: 64, z: dz + 0.5 } }, trigger: { kind: 'use', item: 'bow' } };
    const r = await h.runner.trigger({ commander: PAUL, command: 'attack', tokens: orbitArg === null ? [] : [`orbit=${orbitArg}`], snap });
    assert.ok(r.ok, r.text);
    const ended = () => h.notices.find((n) => n.text.startsWith('[Bots] « attack » terminé'))?.text;
    const centre = new Vec3(2.5, 64, dz + 1.5);
    try {
      if (orbitArg === null) {
        await until(() => bs.every((b) => Math.abs(flatD(b.entity.position, centre) - 30) < 4), 8_000, 'both on the ring round the group');
        await until(() => bs.every((b) => b.releases.some((x) => x.fired)), 8_000, 'both shooting');
        const p0 = bs.map((b) => b.entity.position.clone());
        await new Promise((res) => setTimeout(res, 200));
        assert.ok(bs.every((b, i) => b.entity.position.distanceTo(p0[i]!) > 1), 'still riding while they shoot');
      } else {
        await until(() => bs.every((b) => b.releases.some((x) => x.fired)), 8_000, 'both shooting');
        assert.ok(bs.every((b) => flatD(b.entity.position, new Vec3(b.username === 'Hac0' ? 0.5 : 3.5, 64, 0.5)) < 1), 'orbit=0: where they stood');
      }
      target.isValid = false;
      other.isValid = false;
      await until(() => !!ended(), 5_000, 'the end');
      assert.match(ended()!, /Cible abattue \(zombie\)/);
      for (const b of bs) assert.ok(!b.controlState.forward && (b.entity as { moveYaw?: number }).moveYaw === undefined, `${b.username}: gallop and rein let go`);
    } finally {
      await h.runner.stopAll();
      for (const b of bs) b.stopTicks();
    }
  }
});
