// The stock `defend` after a live fight of 20 bots against zombie waves: guards chased the zombie nearest to
// THEMSELVES far from the player, all piled on the same creature, stood in the same block between threats, and
// archers waited a fixed 1.5 s per shot. Plus the helpers it is built on (commander-relative search, the attack
// leash, follow offsets and their fallback while the slot is in the air (a commander on a ladder), the shot that returns when the arrow leaves) and hawkEye's per-bot copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Vec3 } from 'vec3';

import { attack, follow, FOLLOW_KEEP_MS, nearestEntity, nearestHostile, shoot } from '../src/api/helpers';
import { GoalFollowOffset, slotStandable } from '../src/bots/follow-goal';
import { freshHawkEye } from '../src/bots/plugins';
import { serializeGoal } from '../src/bots/pathworkers/serialize';
import type { Order } from '../src/orders/order';
import { loadStock } from '../src/stock';
import { FakeBot } from './fakes/fake-bot';
import { harness, PAUL, tick, until } from './fakes/harness';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

const stock = await loadStock();

interface Mob {
  id: number;
  type: string;
  name: string;
  position: Vec3;
  isValid: boolean;
  height: number;
}
let nextId = 100;
const zombie = (x: number, z = 0): Mob => ({ id: nextId++, type: 'hostile', name: 'zombie', position: new Vec3(x, 64, z), isValid: true, height: 1.95 });

// -- helpers ----------------------------------------------------------------------------------------------------

test('nearestEntity / nearestHostile: `from` measures from the commander, not from the bot', () => {
  const b = new FakeBot('Guard', { position: new Vec3(10, 64, 0) });
  const nearBot = zombie(12);
  const nearCommander = zombie(-3);
  b.entities = { a: nearBot, b: nearCommander };
  const commander = new Vec3(0, 64, 0);
  assert.equal(nearestHostile(b as never, 16), nearBot as never, 'from the bot: the one next to it');
  assert.equal(nearestHostile(b as never, 16, { from: commander }), nearCommander as never);
  assert.equal(nearestEntity(b as never, 'zombie', 16, { from: commander }), nearCommander as never);
  // The radius is from `from` too: 12 blocks from the commander is outside a radius of 10.
  assert.equal(nearestHostile(b as never, 10, { from: commander, filter: (e) => e !== (nearCommander as never) }), null);
});

test('attack: the leash breaks off when the target leaves the circle, and before the first swing', async () => {
  const b = new FakeBot('Guard', { position: new Vec3(2, 64, 0), items: [{ name: 'iron_sword', count: 1 }] });
  const z = zombie(5);
  const leash = { center: () => new Vec3(0, 64, 0), radius: 8 };
  const fight = attack(b as never, z as never, { leash, timeoutMs: 5_000 });
  await until(() => b.pvp.target === z, 1_000, 'the swing');
  const t0 = Date.now();
  z.position = new Vec3(20, 64, 0);
  const r = await fight;
  assert.deepEqual(r, { killed: false, brokeOff: 'leash' });
  assert.ok(Date.now() - t0 < 500, 'broke off within a check or two');
  assert.equal(b.pvp.target, null, 'pvp stopped');

  // Already outside: no swing at all, and pvp.stop is not called (it would clear the follow goal).
  const calls = b.calls.length;
  assert.deepEqual(await attack(b as never, z as never, { leash }), { killed: false, brokeOff: 'leash' });
  assert.deepEqual(b.calls.slice(calls), []);

  // The guard itself straying more than radius + 4 breaks off too; a null center is no leash.
  b.entity.position = new Vec3(13, 64, 0);
  const near = zombie(7);
  assert.equal((await attack(b as never, near as never, { leash })).brokeOff, 'leash');
  let stop = false;
  const free = attack(b as never, near as never, { leash: { center: () => null, radius: 1 }, until: () => stop });
  await until(() => b.pvp.target === near, 1_000, 'the free swing');
  stop = true;
  assert.deepEqual(await free, { killed: false, brokeOff: 'until' });
  near.isValid = false;
  b.entity.position = new Vec3(2, 64, 0);
  assert.deepEqual(await attack(b as never, near as never, { leash }), { killed: true }, 'a dead target is killed, not broken off');
});

test('follow: an offset follows a slot beside the entity, kept between calls with the same offset', async () => {
  const b = new FakeBot('Guard');
  const e = { isValid: true, position: new Vec3(10, 64, 10) };
  await follow(b as never, e as never, 1.5, { untilMs: 20, offset: { x: 3, z: 0 } });
  const g = b.pathfinder.goal as GoalFollowOffset;
  assert.ok(g instanceof GoalFollowOffset);
  assert.deepEqual([g.x, g.y, g.z], [13, 64, 10]);
  await follow(b as never, e as never, 1.5, { untilMs: 20, offset: { x: 3, z: 0 } });
  assert.equal(b.pathfinder.goal, g, 'same offset: same goal');
  e.position = new Vec3(20, 64, 10);
  assert.equal(g.hasChanged(), true);
  assert.deepEqual([g.x, g.z], [23, 10], 'the slot moves with the entity');
  await follow(b as never, e as never, 1.5, { untilMs: 20, offset: { x: -3, z: 0 } });
  assert.notEqual(b.pathfinder.goal, g, 'another offset: another goal');
  await follow(b as never, e as never, 1.5, { untilMs: 20 });
  assert.ok(!(b.pathfinder.goal instanceof GoalFollowOffset), 'no offset: a plain GoalFollow');
  // The pathfinding workers mirror it like a GoalFollow: a GoalNear on the slot.
  assert.deepEqual(serializeGoal(new GoalFollowOffset(e as never, 2, { x: 0, z: -6 }), null), { t: 'GoalNear', f: { x: 20, y: 64, z: 4, rangeSq: 4 } });
  await tick(FOLLOW_KEEP_MS + 100);
});

/**
 * A FakeBot over a small world: stone up to y = 63, a 3×3 tower (x 9..11, z 9..11) up to y = 71 with a ladder on its
 * south face (x = 10, z = 12), `extra` solid blocks.
 */
function towerBot(name: string, extra: Array<[number, number, number]> = []): FakeBot {
  const b = new FakeBot(name);
  const solid = new Set(extra.map((p) => p.join(',')));
  (b as unknown as { blockAt: (p: Vec3) => unknown }).blockAt = (p: Vec3) => {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    if (x === 10 && z === 12 && y >= 64 && y <= 71) return { name: 'ladder', boundingBox: 'block' };
    const stone = y <= 63 || (x >= 9 && x <= 11 && z >= 9 && z <= 11 && y <= 71) || solid.has(`${x},${y},${z}`);
    return stone ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  };
  return b;
}

test('slotStandable: on the ground or a slope, on a ladder; not in the air nor in a wall; an unknown block does not count', () => {
  const b = towerBot('Guard');
  const at = (x: number, y: number, z: number) => ({ position: new Vec3(x + 0.5, y, z + 0.5) });
  assert.equal(slotStandable(b, at(0, 64, 0), { x: 3, z: 0 }), true, 'flat ground');
  assert.equal(slotStandable(b, at(0, 65, 0), { x: 3, z: 0 }), true, 'one block above the ground: a slope');
  assert.equal(slotStandable(b, at(0, 67, 0), { x: 3, z: 0 }), false, 'three blocks up: in the air');
  assert.equal(slotStandable(b, at(10, 67, 12), { x: 3, z: 0 }), false, 'the commander on the ladder: the slot is in the air');
  assert.equal(slotStandable(b, at(10, 67, 15), { x: 0, z: -3 }), true, 'a slot on the ladder');
  assert.equal(slotStandable(b, at(10, 66, 13), { x: 0, z: -3 }), false, 'a slot inside the tower');
  assert.equal(slotStandable(b, at(10, 72, 10), { x: 1, z: 0 }), true, 'on top of the tower');
  assert.equal(slotStandable(b, at(10, 72, 10), { x: 3, z: 0 }), false, 'beyond its edge');
  assert.equal(slotStandable(new FakeBot('Fake'), at(0, 90, 0), { x: 3, z: 0 }), true, 'blocks the bot does not know');
});

test('follow: while nobody could stand at the slot (the commander on a ladder), the bot follows the commander itself', async () => {
  const b = towerBot('Guard');
  const e = { isValid: true, position: new Vec3(10.5, 67, 12.5) };
  await follow(b as never, e as never, 1.5, { untilMs: 20, offset: { x: 3, z: 0 } });
  let g = b.pathfinder.goal as { entity?: unknown; rangeSq?: number };
  assert.ok(!(g instanceof GoalFollowOffset), 'a plain GoalFollow');
  assert.equal(g.entity, e);
  assert.equal(g.rangeSq, 2.25);
  await follow(b as never, e as never, 1.5, { untilMs: 20, offset: { x: 3, z: 0 } });
  assert.equal(b.pathfinder.goal, g, 'kept between calls like any follow goal');
  // At the top the slot is on the tower again: the next call goes back to it.
  e.position = new Vec3(9.5, 72, 9.5);
  await follow(b as never, e as never, 1.5, { untilMs: 20, offset: { x: 2, z: 0 } });
  g = b.pathfinder.goal as GoalFollowOffset;
  assert.ok(g instanceof GoalFollowOffset);
  assert.deepEqual([g.x, g.y, g.z], [11, 72, 9]);
  // Within one long call too: the commander steps onto the ladder, then off it.
  const long = follow(b as never, e as never, 1.5, { untilMs: 1_500, offset: { x: 2, z: 0 } });
  await tick(100);
  e.position = new Vec3(10.5, 68, 12.5);
  await until(() => !(b.pathfinder.goal instanceof GoalFollowOffset), 1_000, 'the switch to the commander');
  e.position = new Vec3(10.5, 64, 16.5);
  await until(() => b.pathfinder.goal instanceof GoalFollowOffset, 1_000, 'the switch back to the slot');
  await long;
  await tick(FOLLOW_KEEP_MS + 100);
});

test('shoot: returns as soon as the arrow has left, without the manual shot', async () => {
  const b = new FakeBot('Archer', { items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] });
  b.hawkEye.oneShot = () => {
    b.calls.push('hawkEye.oneShot');
    setTimeout(() => b.setItems([{ name: 'bow', count: 1 }, { name: 'arrow', count: 9 }]), 120);
  };
  const t0 = Date.now();
  assert.deepEqual(await shoot(b as never, zombie(10) as never), { shot: true });
  const took = Date.now() - t0;
  assert.ok(took < 400, `returned ${took} ms after the shot, not after a fixed wait`);
  assert.ok(!b.calls.includes('activateItem'), 'no manual shot');
});

test('hawkEye: each bot gets its own copy (the module kept ONE bot and target for the whole process)', () => {
  const mk = () => Object.assign(new EventEmitter(), { deactivateItem: () => undefined, activateItem: () => undefined }) as EventEmitter & { hawkEye?: { oneShot: (t: unknown) => void; stop: () => void } };
  const a = mk();
  const b = mk();
  freshHawkEye()(a as never);
  freshHawkEye()(b as never);
  const target = { position: new Vec3(5, 64, 0), isValid: true };
  a.hawkEye!.oneShot(target);
  assert.ok(a.listenerCount('physicsTick') > 0, 'the bot told to shoot is the one that aims');
  assert.equal(b.listenerCount('physicsTick'), 0, 'the bot loaded last is left alone');
  b.hawkEye!.stop();
  assert.ok(a.listenerCount('physicsTick') > 0, "another bot's stop does not stop it");
  a.hawkEye!.stop();
  assert.equal(a.listenerCount('physicsTick'), 0);
});

// -- the stock command on FakeBots --------------------------------------------------------------------------------

/** A squad of guards (a sword) and archers (a bow), all seeing the same world and the commander at the origin. */
function squad(guards: Array<[number, number]>, archers: Array<[number, number]> = []) {
  const h = harness({ stock });
  const commander = { id: 1, type: 'player', username: 'Paul', name: 'player', position: new Vec3(0, 64, 0), isValid: true, height: 1.8 };
  const world: Record<string, unknown> = { 1: commander };
  const bots: FakeBot[] = [];
  const add = (name: string, [x, z]: [number, number], items: Array<{ name: string; count: number }>) => {
    const b = h.bot(name, [PAUL], items);
    b.entity.position = new Vec3(x, 64, z);
    b.entities = world;
    b.players = { Paul: { entity: commander } };
    bots.push(b);
    return b;
  };
  const g = guards.map((p, i) => add(`Guard${i}`, p, [{ name: 'iron_sword', count: 1 }]));
  const a = archers.map((p, i) => add(`Archer${i}`, p, [{ name: 'bow', count: 1 }, { name: 'arrow', count: 64 }]));
  const spawn = (m: Mob): Mob => {
    world[m.id] = m;
    return m;
  };
  const start = async (radius = 16): Promise<Order> => {
    const r = await h.order(PAUL, 'defend', [`radius=${radius}`]);
    assert.ok(r.ok, r.text);
    return h.runner.get(r.orderId) as Order;
  };
  return { h, commander, world, guards: g, archers: a, bots, spawn, start };
}

const on = (bots: FakeBot[], m: Mob) => bots.filter((b) => b.pvp.target === m).length;

test('defend: a guard takes the threat nearest the COMMANDER, never one outside the radius around them', async () => {
  const s = squad([[10, 0]]);
  const nearGuard = s.spawn(zombie(12)); // 2 from the guard, 12 from the commander
  const nearCommander = s.spawn(zombie(-3)); // 13 from the guard, 3 from the commander
  const far = s.spawn(zombie(25)); // 15 from the guard, outside the radius around the commander
  await s.start(16);
  const g = s.guards[0]!;
  await until(() => g.pvp.target === nearCommander, 2_000, 'the guard on the zombie next to the commander');
  nearCommander.isValid = false; // killed
  await until(() => g.pvp.target === nearGuard, 2_000, 'then the next one');
  nearGuard.isValid = false;
  await tick(500);
  assert.notEqual(g.pvp.target, far, 'the zombie outside the circle is left alone');
  await s.h.runner.stopAll();
});

test('defend: a guard breaks off when its target leaves the circle around the commander, and goes back to its slot', async () => {
  const s = squad([[2, 0]]);
  const z = s.spawn(zombie(6));
  await s.start(10);
  const g = s.guards[0]!;
  await until(() => g.pvp.target === z, 2_000, 'the fight');
  z.position = new Vec3(30, 64, 0); // runs off
  await until(() => g.pvp.target === null && g.pathfinder.goal instanceof GoalFollowOffset, 2_000, 'the guard back on its slot');
  await tick(400);
  assert.equal(g.pvp.target, null, 'it does not go after it again');
  await s.h.runner.stopAll();
});

test('defend: guards spread over the threats, at most two on one', async () => {
  const s = squad([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
  const a = s.spawn(zombie(4));
  const b = s.spawn(zombie(-4, 2));
  await s.start(16);
  await until(() => on(s.guards, a) === 2 && on(s.guards, b) === 2, 2_000, 'two guards on each zombie');
  b.isValid = false; // killed: its two guards may not pile onto the other one
  await tick(600);
  assert.equal(on(s.guards, a), 2, 'still two on the remaining zombie');
  const idle = s.guards.filter((g) => g.pvp.target === null);
  assert.equal(idle.length, 2);
  assert.ok(idle.every((g) => g.pathfinder.goal instanceof GoalFollowOffset), 'the others hold their slots');
  await s.h.runner.stopAll();
});

test('defend: between threats every bot holds its own slot (guards on a ring of 3, archers on a ring of 6)', async () => {
  const s = squad([[0, 1], [0, 1], [0, 1], [0, 1]], [[0, 2], [0, 2], [0, 2]]);
  await s.start();
  await until(() => s.bots.every((b) => b.pathfinder.goal instanceof GoalFollowOffset), 2_000, 'every bot on a slot');
  const slots = s.bots.map((b) => (b.pathfinder.goal as GoalFollowOffset).offset);
  assert.equal(new Set(slots.map((o) => `${o.x},${o.z}`)).size, slots.length, `distinct slots: ${JSON.stringify(slots)}`);
  const ring = (o: { x: number; z: number }) => Math.round(Math.hypot(o.x, o.z));
  assert.deepEqual(slots.slice(0, 4).map(ring), [3, 3, 3, 3]);
  assert.deepEqual(slots.slice(4).map(ring), [6, 6, 6]);
  for (const b of s.bots) assert.equal((b.pathfinder.goal as GoalFollowOffset).entity, s.commander as never, 'around the commander');
  await s.h.runner.stopAll();
});

test('defend: archers spread their fire, shoot only inside the circle, and re-aim right after a shot', async () => {
  const s = squad([], [[0, 3], [0, -3]]);
  const shots = new Map<FakeBot, unknown[]>();
  for (const a of s.archers) {
    shots.set(a, []);
    a.hawkEye.oneShot = ((t: unknown) => {
      shots.get(a)!.push(t);
      const left = a.inventory.items().find((i) => i.name === 'arrow')!.count - 1;
      setTimeout(() => a.setItems([{ name: 'bow', count: 1 }, { name: 'arrow', count: left }]), 30);
    }) as never;
  }
  const x = s.spawn(zombie(8));
  const y = s.spawn(zombie(-8));
  const out = s.spawn(zombie(40));
  await s.start(16);
  await until(() => [...shots.values()].every((l) => l.length >= 3), 3_000, 'three quick shots each');
  const firsts = s.archers.map((a) => shots.get(a)![0]);
  assert.notEqual(firsts[0], firsts[1], 'the two archers opened on different zombies');
  assert.ok([...shots.values()].flat().every((t) => t === x || t === y), 'nothing shot outside the circle');
  assert.ok(![...shots.values()].flat().includes(out));
  await s.h.runner.stopAll();
});
