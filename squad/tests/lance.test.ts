// The lance (docs/44): one pass (`lance`) on a FakeBot that rides (a `vehicle` named horse, the horse's speed as its
// speed attribute, the rider's eyes in the saddle) and has a spear, and the stock `attack`'s waves of horsemen: a
// charge from the formation they stand in, through the group around the target to `backoff` beyond it, forming up
// there and charging back, until the group is gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';

import { canLance, foesNear, lance, SPEAR_MAX_REACH } from '../src/api/lance';
import { HORSE_SEAT, HORSE_SPEED, PLAYER_EYES } from '../src/bots/mount';
import { loadStock } from '../src/stock';
import { EMPTY_SNAPSHOT, type Snapshot } from '../src/types';
import { FakeBot, flatWorld, type FakeItem } from './fakes/fake-bot';
import { harness, PAUL, until } from './fakes/harness';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

const SPEAR: FakeItem[] = [{ name: 'iron_spear', count: 1 }];
let nextId = 500;
const zombie = (x: number, z: number) => ({ id: nextId++, type: 'hostile', name: 'zombie', position: new Vec3(x, 64, z), isValid: true, height: 1.95 });

/** Seat a FakeBot on a horse, as mount.ts leaves a rider: its eyes in the saddle, the horse's speed as its own. */
function ride(b: FakeBot): FakeBot {
  Object.assign(b, { vehicle: { id: nextId++, name: 'horse', position: b.entity.position.clone() } });
  Object.assign(b.entity, { eyeHeight: PLAYER_EYES + HORSE_SEAT, attributes: { 'minecraft:movement_speed': { value: HORSE_SPEED / 1.3, modifiers: [] } } });
  return b;
}

/** The pitches of the looks it took (mineflayer's: up positive), from its `look(yaw,pitch,force)` calls. */
const pitches = (b: FakeBot): number[] =>
  b.calls.filter((c) => c.startsWith('look(')).map((c) => Number(c.slice(5, -1).split(',')[1]));

test('lance: the spear in hand and its use held, the rider rides through its foe looking at its body, out to the run-out point, and lets go there', async () => {
  const b = ride(new FakeBot('Rider0', { items: SPEAR }));
  b.entity.position = new Vec3(0.5, 64, 0.5);
  const z = zombie(0.5, 10.5);
  b.entities = { [z.id]: z };
  b.physics({ tickMs: 5 });
  // The server's hit, once the rider is within the spear's reach of it.
  let hurt = false;
  b.on('physicsTick', () => {
    if (!hurt && b.entity.position.distanceTo(z.position) <= SPEAR_MAX_REACH) {
      hurt = true;
      b.emit('entityHurt', z);
    }
  });
  try {
    const r = await lance(b as never, new Vec3(0.5, 64, 22.5), { foe: () => z as never });
    assert.deepEqual(r, { passed: true, struck: 1, why: 'passed' });
    assert.ok(b.entity.position.z >= 21, `ran out to the point: ${b.entity.position}`);
    const use = b.calls.indexOf('activateItem');
    assert.ok(b.calls.indexOf('equip(iron_spear,hand)') >= 0 && b.calls.indexOf('equip(iron_spear,hand)') < use, 'the spear in hand before its use');
    assert.ok(b.calls.lastIndexOf('deactivateItem') > use && !b.usingHeldItem, 'the use let go at the end');
    assert.ok(!b.controlState.forward && !b.controlState.sprint, 'the controls let go');
    // From the saddle the spear points down at the zombie's body: the look's pitch below level while it was ahead.
    assert.ok(pitches(b).some((p) => p < -0.1), `looked down at its body: ${pitches(b).slice(0, 5).join(' ')}`);
    assert.equal((b.entity as { moveYaw?: number }).moveYaw, undefined, 'the free rein released');
  } finally {
    b.stopTicks();
  }
});

test('lance: a pass that cannot move ends stuck; on foot or with no spear there is no lance', async () => {
  const b = ride(new FakeBot('Rider0', { items: SPEAR }));
  b.entity.position = new Vec3(0.5, 64, 0.5);
  // No physics ticks: the body never moves.
  const r = await lance(b as never, new Vec3(0.5, 64, 20.5), { timeoutMs: 5_000 });
  assert.equal(r.why, 'stuck');
  assert.ok(!b.usingHeldItem);
  assert.equal(canLance(b as never), true);
  assert.equal(canLance(new FakeBot('Walker', { items: SPEAR }) as never), false, 'on foot');
  assert.equal(canLance(ride(new FakeBot('Swordsman', { items: [{ name: 'iron_sword', count: 1 }] })) as never), false, 'no spear (1.21.1 kits)');
  await assert.rejects(lance(new FakeBot('Walker', { items: SPEAR }) as never, new Vec3(0, 64, 10)), /not riding a horse/);
});

test('foesNear: every hostile within range of the point, nearest first; not animals', () => {
  const b = new FakeBot('Rider0');
  const a = zombie(3, 0);
  const c = zombie(1, 0);
  const far = zombie(30, 0);
  const cow = { id: nextId++, type: 'animal', name: 'cow', position: new Vec3(2, 64, 0), isValid: true };
  b.entities = { [a.id]: a, [c.id]: c, [far.id]: far, [cow.id]: cow };
  assert.deepEqual(foesNear(b as never, 8, { from: new Vec3(0, 64, 0) }), [c, a]);
});

/** Paul's field: flat ground, every bot seeing the same entities, walking to its pathfinder goals. */
function field() {
  const h = harness({ stock });
  const commander = { id: 1, type: 'player', username: 'Paul', name: 'player', position: new Vec3(0.5, 64, 0.5), isValid: true, height: 1.8 };
  const world: Record<string, unknown> = { 1: commander };
  const players: Record<string, { entity: unknown }> = { Paul: { entity: commander } };
  let id = 10;
  const add = (name: string, x: number, z: number, items: FakeItem[]): FakeBot => {
    const b = h.bot(name, [PAUL], items) as FakeBot;
    b.entity.position = new Vec3(x + 0.5, 64, z + 0.5);
    const e = Object.assign(b.entity, { id: id++ });
    world[e.id] = e;
    players[name] = { entity: e };
    b.entities = world;
    b.players = players;
    b.world = flatWorld(63);
    b.autoWalk = true;
    b.physics({ tickMs: 5 });
    return b;
  };
  const spawn = <T extends { id: number }>(m: T): T => {
    world[m.id] = m;
    return m;
  };
  const snap = (over: Partial<Snapshot>): Snapshot => ({ ...EMPTY_SNAPSHOT, position: { x: 0.5, y: 64, z: 0.5 }, ...over });
  const start = async (s: Snapshot, tokens: string[] = []) => {
    const r = await h.runner.trigger({ commander: PAUL, command: 'attack', tokens, snap: s });
    assert.ok(r.ok, r.text);
  };
  const ended = () => h.notices.find((n) => n.text.startsWith('[Bots] « attack » terminé'))?.text;
  return { h, add, spawn, snap, start, ended };
}

const stock = await loadStock();

test('attack (horsemen with spears): they charge from their formation through the group around the target, ride out `backoff` beyond it, form up again side by side and charge back, until the group is gone (docs/44)', { timeout: 20_000 }, async () => {
  const f = field();
  // Two riders side by side, 4 apart across the charge (along x), facing south toward the group.
  const riders = [ride(f.add('Rider0', -2, 0, SPEAR)), ride(f.add('Rider1', 2, 0, SPEAR))];
  const target = f.spawn(zombie(0.5, 15.5));
  const other = f.spawn(zombie(3.5, 17.5)); // within `group` (8) of the target: the group
  const loner = f.spawn(zombie(30.5, 15.5)); // 30 blocks off: not of the group
  const track = riders.map(() => [] as number[]);
  riders.forEach((r, i) => r.on('physicsTick', () => track[i]!.push(r.entity.position.z)));
  await f.start(f.snap({ yaw: 0, lookEntity: { id: target.id, name: 'zombie', type: 'mob', position: { x: 0.5, y: 64, z: 15.5 } }, trigger: { kind: 'use', item: 'iron_spear' } }), ['backoff=10']);
  try {
    // The first charge: through the group (centre z 16.5) to 10 beyond it, from where they stood.
    await until(() => riders.every((r) => r.entity.position.z >= 24), 4_000, 'both riders through the group and out');
    for (const r of riders) assert.ok(r.calls.includes('activateItem'), `${r.username} held its spear's use`);
    // Then back: formed up beyond the group, they charge north through it again.
    await until(() => riders.every((r) => r.entity.position.z <= 9), 8_000, 'the second charge, back through the group');
    for (const t of track) assert.ok(Math.max(...t) >= 24 && t.at(-1)! <= 9, 'out past the group, then back');
    // Side by side, not on one lane: their run-out points kept them apart across the charge.
    assert.ok(Math.abs(riders[0]!.entity.position.x - riders[1]!.entity.position.x) >= 1.5, `apart: ${riders.map((r) => r.entity.position.x.toFixed(2)).join(' ')}`);
    assert.equal(f.ended(), undefined, 'still at it while the group stands');
    target.isValid = false;
    other.isValid = false;
    await until(() => !!f.ended(), 4_000, 'the end');
    assert.match(f.ended()!, /« attack » terminé : Cible abattue \(zombie\) : \d+ charges \(\d+ touchés?\)\./);
    assert.ok(Math.abs(loner.position.x - 30.5) < 1e-9);
    for (const r of riders) assert.ok(!r.usingHeldItem, `${r.username} let go of its spear's use`);
  } finally {
    loner.isValid = false;
    await f.h.runner.stopAll();
  }
});
