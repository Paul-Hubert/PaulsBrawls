// The stock commands of orders bound to items (docs/29 §5.4 item 8), on FakeBots over a flat world (stone up to
// y = 63) that walk to their pathfinder goals: `mur-de-boucliers`, `epee`, `ligne-archers` and `tir`, whatever item
// carries them (a click only says where the commander points: pointedTarget). Each test checks the command's choices:
// where the bots stand, what they face and fight, what a later click changes without restarting the order, and what
// `tir` shoots.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';

import { mineflayerYaw, toVec3 } from '../src/api/helpers';
import { GoalFollowOffset } from '../src/bots/follow-goal';
import type { Order } from '../src/orders/order';
import { loadStock } from '../src/stock';
import { EMPTY_SNAPSHOT, type Snapshot } from '../src/types';
import { flatWorld, type FakeBot, type FakeItem } from './fakes/fake-bot';
import { harness, PAUL, tick, until } from './fakes/harness';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { recordShots } from './fakes/shots';

holdEventLoopPerTest();

/**
 * What each archer shoots at, by name (the test's current field): the real shoot runs. A point is kept as hawkEye was
 * handed it, { position, isValid: true }; an entity as itself.
 */
const aims = new Map<string, unknown[]>();
recordShots((name, t) => {
  const live = !!t && typeof t === 'object' && 'isValid' in t && !!(t as { position?: unknown }).position;
  aims.get(name)?.push(live ? t : { position: toVec3(t as never), isValid: true });
});

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
const zombie = (x: number, z: number): Mob => ({ id: nextId++, type: 'hostile', name: 'zombie', position: new Vec3(x, 64, z), isValid: true, height: 1.95 });

const SHIELD: FakeItem[] =[{ name: 'iron_sword', count: 1 }, { name: 'shield', count: 1 }];
const SWORD: FakeItem[] = [{ name: 'iron_sword', count: 1 }];
const BOW: FakeItem[] = [{ name: 'bow', count: 1 }, { name: 'arrow', count: 64 }];

/** Paul at (0.5, 64, 0.5) on flat ground; his bots see the same entities (by network id) and walk to their goals. */
function field() {
  aims.clear();
  const h = harness({ stock });
  const commander = { id: 1, type: 'player', username: 'Paul', name: 'player', position: new Vec3(0.5, 64, 0.5), isValid: true, height: 1.8 };
  const world: Record<string, unknown> = { 1: commander };
  const players: Record<string, { entity: unknown }> = { Paul: { entity: commander } };
  const shots = new Map<FakeBot, unknown[]>();
  let id = 10;
  /** A bot of Paul's standing on the block (x, 63, z). An archer's shot takes its 24 (fast, fake) ticks. */
  const add = (name: string, x: number, z: number, items: FakeItem[]): FakeBot => {
    const b = h.bot(name, [PAUL], items);
    b.entity.position = new Vec3(x + 0.5, 64, z + 0.5);
    const e = Object.assign(b.entity, { id: id++ });
    world[e.id] = e;
    players[name] = { entity: e };
    b.entities = world;
    b.players = players;
    b.world = flatWorld(63);
    b.autoWalk = true;
    const list: unknown[] = [];
    shots.set(b, list);
    aims.set(name, list);
    if (items.some((i) => i.name === 'bow')) b.archer();
    return b;
  };
  const spawn = (m: Mob): Mob => {
    world[m.id] = m;
    return m;
  };
  const snap = (over: Partial<Snapshot>): Snapshot => ({ ...EMPTY_SNAPSHOT, position: { x: 0.5, y: 64, z: 0.5 }, ...over });
  const click = (command: string, s: Snapshot, tokens: string[] = []) => h.runner.trigger({ commander: PAUL, command, tokens, snap: s });
  const start = async (command: string, s: Snapshot, tokens: string[] = []): Promise<Order> => {
    const r = await click(command, s, tokens);
    assert.ok(r.ok, r.text);
    return h.runner.get((r as { orderId?: string }).orderId!) as Order;
  };
  const ended = (command: string) => h.notices.find((n) => n.text.startsWith(`[Bots] « ${command} » terminé`))?.text;
  return { h, commander, add, spawn, snap, click, start, shots, ended };
}

const xz = (b: FakeBot): [number, number] => [b.entity.position.x, b.entity.position.z];
const shieldUp = (b: FakeBot): boolean => b.usingHeldItem && b.inventory.slots[45]?.name === 'shield';
const facing = (b: FakeBot, yaw: number): boolean => Math.abs(b.entity.yaw - mineflayerYaw(yaw)) < 1e-9;
const on = (bots: FakeBot[], m: unknown): number => bots.filter((b) => b.pvp.target === m).length;

// -- mur-de-boucliers ---------------------------------------------------------------------------------------------

test('mur-de-boucliers: facing west the guards line up along z at the block looked at, face west and raise their shields once there; a click re-forms the wall without restarting the order', async () => {
  const f = field();
  const guards = [f.add('Guard0', -3, 3, SHIELD), f.add('Guard1', -3, -2, SHIELD), f.add('Guard2', -3, 0, SHIELD)];
  const o = await f.start('mur-de-boucliers', f.snap({ yaw: 90, lookBlock: { x: -8, y: 63, z: 0, name: 'grass_block' }, trigger: { kind: 'use', item: 'shield' } }));
  await until(() => guards.every(shieldUp), 3_000, 'every shield up');
  // On top of the block looked at, across the view (along z), 1 block apart. Facing west, the left is +Z: each guard
  // got the slot on its own side of the others, so no two paths crossed.
  assert.deepEqual(guards.map(xz), [[-7.5, 1.5], [-7.5, -0.5], [-7.5, 0.5]]);
  for (const g of guards) {
    assert.ok(facing(g, 90), `${g.username} faces west`);
    assert.ok(g.calls.indexOf('activateItem(offHand)') > g.calls.lastIndexOf('pathfinder.setGoal'), 'raised after arriving, not while walking');
    assert.ok(g.calls.includes('equip(shield,off-hand)'));
  }

  // A click facing south at (0, 63, 10): the same order re-forms there.
  const lowered = guards.map((g) => g.calls.filter((c) => c === 'deactivateItem').length);
  const r = await f.click('mur-de-boucliers', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: { kind: 'use', item: 'shield' } }));
  assert.deepEqual(r, { ok: true, text: '', orderId: o.id, delivered: true });
  await until(() => guards.every((g) => g.entity.position.z === 10.5 && shieldUp(g) && facing(g, 0)), 3_000, 'the wall re-formed facing south');
  assert.deepEqual(guards.map((g) => g.entity.position.x).sort((a, b) => a - b), [-0.5, 0.5, 1.5]);
  guards.forEach((g, i) => assert.ok(g.calls.filter((c) => c === 'deactivateItem').length > lowered[i]!, `${g.username} lowered its shield to walk`));
  assert.equal(o.status, 'running');
  assert.equal(f.h.runner.running().length, 1);
  await f.h.runner.stopAll();
});

test('mur-de-boucliers: a guard keeps its shield up with a zombie at the wall; hit in melee it hits back once, then raises its shield again', async () => {
  const f = field();
  const guards = [f.add('Guard0', -3, 3, SHIELD), f.add('Guard1', -3, -2, SHIELD), f.add('Guard2', -3, 0, SHIELD)];
  await f.start('mur-de-boucliers', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: { kind: 'use', item: 'shield' } }));
  try {
    await until(() => guards.every((g) => g.entity.position.z === 10.5 && shieldUp(g) && facing(g, 0)), 3_000, 'the wall facing south');
    const g = guards.find((b) => b.entity.position.x === 0.5)!;

    // A zombie 1.5 blocks in front of the wall: nobody leaves the wall or lowers a shield for it (before, the nearest
    // guard went to fight anything within `reach` of its slot).
    const z = f.spawn(zombie(0.5, 12));
    await tick(600);
    assert.ok(guards.every(shieldUp), 'every shield still up');
    assert.ok(guards.every((b) => b.hits.length === 0 && b.pvp.target === null), 'nobody struck or chased it');

    // It hits Guard1's shield: one blow back, at it, with the shield down for it, then the shield up again.
    const before = g.calls.length;
    g.emit('meleeHit', z, { blocked: true });
    await until(() => g.hits.length === 1, 1_000, 'the blow back');
    assert.equal(g.hits[0], z);
    await until(() => shieldUp(g), 1_000, 'the shield up again');
    const after = g.calls.slice(before);
    const lower = after.indexOf('deactivateItem');
    const blow = after.indexOf('attack');
    assert.ok(lower >= 0 && lower < blow && blow < after.lastIndexOf('activateItem(offHand)'), `shield down, blow, shield up: ${after.join(' ')}`);
    await tick(600);
    assert.equal(g.hits.length, 1, 'once per hit');
    assert.deepEqual(xz(g), [0.5, 10.5], 'on its slot');
    assert.ok(guards.filter((b) => b !== g).every((b) => b.hits.length === 0 && shieldUp(b)), 'the others did nothing');

    // A friend's blow (isFriend), and a hit from far off (no melee: beyond arm's reach plus `reach`), are not answered.
    g.emit('meleeHit', f.commander, { blocked: false });
    g.emit('meleeHit', f.spawn(zombie(0.5, 25)), { blocked: false });
    await tick(600);
    assert.equal(g.hits.length, 1);
    assert.ok(shieldUp(g));
  } finally {
    await f.h.runner.stopAll();
  }
});

test('mur-de-boucliers: hit by an attacker out of arm\'s reach, the guard steps toward it, strikes once and walks back to its slot', async () => {
  const f = field();
  const g = f.add('Guard0', -3, 0, SHIELD);
  await f.start('mur-de-boucliers', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: { kind: 'use', item: 'shield' } }));
  try {
    await until(() => g.entity.position.z === 10.5 && shieldUp(g), 3_000, 'on its slot');
    // Knocked back by the shield, the zombie stands 4 blocks off: a step toward it first.
    const z = f.spawn(zombie(0.5, 14.5));
    g.emit('meleeHit', z, { blocked: true });
    await until(() => (g.pathfinder.goal as { entity?: unknown } | null)?.entity === z, 1_000, 'a step toward it');
    assert.equal(g.hits.length, 0, 'no blow out of reach');
    g.entity.position = new Vec3(0.5, 64, 12.5); // the step
    await until(() => g.hits.length === 1, 1_000, 'the blow');
    await until(() => xz(g)[1] === 10.5 && shieldUp(g), 2_000, 'back on its slot, shield up');
    assert.equal(g.hits.length, 1);
  } finally {
    await f.h.runner.stopAll();
  }
});

/** The goal's class name: GoalBlock is a slot exactly, GoalNear the loose goal of a slot not reached in 10 s. */
const goalOf = (b: FakeBot): string | undefined => (b.pathfinder.goal as { constructor?: { name: string } } | null)?.constructor?.name;

/** Run `fn` with Date.now `ms` later (the scripts run in this realm, so their STUCK_MS timers see it too). */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test('mur-de-boucliers: a guard pushed 2 blocks off its slot long after the wall formed walks back to the exact slot, shield down until there', async () => {
  const f = field();
  const guards = [f.add('Guard0', -3, 3, SHIELD), f.add('Guard1', -3, -2, SHIELD), f.add('Guard2', -3, 0, SHIELD)];
  await f.start('mur-de-boucliers', f.snap({ yaw: 90, lookBlock: { x: -8, y: 63, z: 0, name: 'grass_block' }, trigger: { kind: 'use', item: 'shield' } }));
  await until(() => guards.every(shieldUp), 3_000, 'every shield up');
  const g = guards[2]!;
  const [sx, sz] = xz(g);
  // 11 s after it reached its slot (STUCK_MS is 10 s), a fight leaves it 2 blocks off. Before the fix its timer still
  // ran from the first walk: a loose GoalNear at once, "arrived" within 2.5, and the shield up 2 blocks off the slot.
  try {
    await later(11_000, async () => {
      g.autoWalk = false;
      g.entity.position = new Vec3(sx + 2, 64, sz);
      await until(() => goalOf(g) !== undefined, 2_000, 'a goal back to the slot');
      await tick(600); // three looks
      assert.equal(goalOf(g), 'GoalBlock', 'an exact goal, with its own 10 s');
      assert.equal(shieldUp(g), false, 'no shield raised 2 blocks off the slot');
      g.autoWalk = true;
      g.pathfinder.setGoal(g.pathfinder.goal); // the walk completes
      await until(() => shieldUp(g) && xz(g)[0] === sx && xz(g)[1] === sz, 2_000, 'back on its exact slot, shield up');
    });
  } finally {
    await f.h.runner.stopAll(); // also on a failure: the guards' loops would keep the test process alive
  }
});

test('mur-de-boucliers on a bow: the wall forms where the arrow landed, a later release does not move it, its hit does', async () => {
  const f = field();
  const guards = [f.add('Guard0', -3, 3, SHIELD), f.add('Guard1', -3, -2, SHIELD), f.add('Guard2', -3, 0, SHIELD)];
  // The look went far past (30 blocks, beyond `distance`); the arrow hit the ground 8 blocks west.
  const hitAt = (x: number, z: number) => ({ kind: 'arrow-hit' as const, item: 'bow', hit: { position: { x, y: 64.05, z } } });
  const o = await f.start('mur-de-boucliers', f.snap({ yaw: 90, lookBlock: { x: -30, y: 63, z: 0, name: 'stone' }, trigger: hitAt(-7.5, 0.5) }));
  try {
    await until(() => guards.every(shieldUp), 3_000, 'the wall at the hit');
    assert.deepEqual(guards.map(xz), [[-7.5, 1.5], [-7.5, -0.5], [-7.5, 0.5]]);
    // A release while looking south: delivered, and the wall stays where it is.
    const release = await f.click('mur-de-boucliers', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: { kind: 'arrow-release', item: 'bow' } }));
    assert.deepEqual(release, { ok: true, text: '', orderId: o.id, delivered: true });
    await tick(500);
    assert.deepEqual(guards.map(xz), [[-7.5, 1.5], [-7.5, -0.5], [-7.5, 0.5]], 'not moved by the release');
    assert.ok(guards.every((g) => facing(g, 90) && shieldUp(g)));
    // Its hit: the wall re-forms there, facing the release's view.
    await f.click('mur-de-boucliers', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: hitAt(0.5, 12.5) }));
    await until(() => guards.every((g) => g.entity.position.z === 12.5 && shieldUp(g) && facing(g, 0)), 3_000, 'the wall at the new hit');
    assert.equal(o.status, 'running');
  } finally {
    await f.h.runner.stopAll();
  }
});

// -- epee ---------------------------------------------------------------------------------------------------------

test('epee from any item: the creature nearest the point (within `near`) is attacked; farther than that, the bots hold the point', async () => {
  const f = field();
  const guards = [f.add('Guard0', 0, 2, SWORD), f.add('Guard1', 1, 2, SWORD)];
  const stick = { kind: 'use' as const, item: 'stick' };
  // The block (10, 63, 0): its top (10.5, 64, 0.5) is 2.8 blocks from the zombie.
  const z = f.spawn(zombie(12.5, 2.5));
  const o = await f.start('epee', f.snap({ yaw: -90, lookBlock: { x: 10, y: 63, z: 0, name: 'stone' }, trigger: stick }), ['radius=4']);
  try {
    await until(() => on(guards, z) === 2, 2_000, 'both guards on the zombie near the point');
    z.isValid = false;
    await until(() => o.report.logs.includes('say: Cible abattue (zombie).'), 2_000, 'the target down');
    // The block (30, 63, 0) with a zombie 6 blocks from its top: no target, the bots hold the point (a radius of 4
    // around it, so that zombie is not theirs either).
    const far = f.spawn(zombie(30.5, 6.5));
    const r = await f.click('epee', f.snap({ yaw: -90, lookBlock: { x: 30, y: 63, z: 0, name: 'stone' }, trigger: stick }));
    assert.ok('delivered' in r && r.delivered);
    const point = new Vec3(30.5, 64, 0.5);
    await until(() => guards.every((g) => Math.abs(Math.hypot(g.entity.position.x - point.x, g.entity.position.z - point.z) - 3) < 1), 3_000, 'on the ring around the point');
    assert.equal(on(guards, far), 0, 'the zombie 6 blocks off is left alone');
  } finally {
    await f.h.runner.stopAll();
  }
});

test('epee: looking at a zombie, the archers shoot it and two guards fight it, the others take the one next to it; once it is dead, the bots defend the commander', async () => {
  const f = field();
  const guards = [0, 1, 2, 3].map((i) => f.add(`Guard${i}`, i - 1, -2, SWORD));
  const archer = f.add('Archer0', 0, -4, BOW);
  const target = f.spawn(zombie(8, 0));
  const other = f.spawn(zombie(11, 3));
  const o = await f.start('epee', f.snap({ yaw: -90, lookEntity: { id: target.id, name: 'zombie', type: 'mob', position: { x: 8, y: 64, z: 0 } }, trigger: { kind: 'use', item: 'iron_sword' } }));
  await until(() => on(guards, target) === 2 && on(guards, other) === 2, 3_000, 'two guards on the target, two on the zombie next to it');
  await until(() => f.shots.get(archer)!.includes(target), 2_000, 'the archer on the target');
  target.isValid = false;
  await until(() => o.report.logs.includes('say: Cible abattue (zombie).'), 2_000, 'the line to the commander');
  other.isValid = false;
  await until(() => guards.every((g) => g.pvp.target === null && g.pathfinder.goal instanceof GoalFollowOffset), 3_000, 'every guard back around the commander');
  for (const g of guards) assert.equal((g.pathfinder.goal as GoalFollowOffset).entity, f.commander as never);
  assert.equal(o.status, 'running');
  await f.h.runner.stopAll();
});

test('epee: looking at the ground, the bots hold that spot (guards on a ring of 3, archers of 6) and fight what comes near it; a click at the sky brings them back to the commander', async () => {
  const f = field();
  const guards = [f.add('Guard0', 0, 2, SWORD), f.add('Guard1', 1, 2, SWORD)];
  const archers = [f.add('Archer0', 0, -2, BOW), f.add('Archer1', 1, -2, BOW)];
  const o = await f.start('epee', f.snap({ yaw: -90, lookBlock: { x: 20, y: 63, z: 0, name: 'grass_block' }, trigger: { kind: 'use', item: 'iron_sword' } }));
  const point = new Vec3(20.5, 64, 0.5);
  const d = (b: FakeBot) => Math.hypot(b.entity.position.x - point.x, b.entity.position.z - point.z);
  await until(() => guards.every((g) => Math.abs(d(g) - 3) < 1) && archers.every((a) => Math.abs(d(a) - 6) < 1), 3_000, 'on their rings around the point');
  assert.notDeepEqual(xz(guards[0]!), xz(guards[1]!), 'distinct slots');

  // A zombie near the point, 25 blocks from the commander: fought, because the point is what they hold.
  const z = f.spawn(zombie(25, 5));
  await until(() => on(guards, z) === 2, 2_000, 'the guards on it');
  // A guard on its ring can stand between an archer and the zombie: that archer shoots over it, by hand.
  await until(() => archers.every((a) => f.shots.get(a)!.some((s) => s === z)), 2_000, 'the archers on it');

  // Looking at the sky: defend the commander, and that zombie is now outside the circle around them.
  const r = await f.click('epee', f.snap({ yaw: -90, pitch: -60, trigger: { kind: 'use', item: 'iron_sword' } }));
  assert.deepEqual(r, { ok: true, text: '', orderId: o.id, delivered: true });
  await until(() => guards.every((g) => g.pvp.target === null && g.pathfinder.goal instanceof GoalFollowOffset), 2_000, 'the guards back around the commander');
  const n = f.shots.get(archers[0]!)!.length;
  await tick(400);
  assert.ok(f.shots.get(archers[0]!)!.length <= n + 1, 'the archers stopped shooting outside the circle');
  assert.equal(o.status, 'running');
  await f.h.runner.stopAll();
});

// -- ligne-archers ------------------------------------------------------------------------------------------------

test('ligne-archers: the line stands `back` blocks short of the point, across the view and facing it, and shoots what comes in front first', async () => {
  const f = field();
  const archers = [-2, 0, 2].map((x, i) => f.add(`Archer${i}`, x, -3, BOW));
  const o = await f.start('ligne-archers', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), ['back=4']);
  // Facing south, the point is (0.5, 64, 12.5): the line is at z = 8.5, 2 blocks apart, each archer on its own side.
  await until(() => archers.every((a) => a.entity.position.z === 8.5 && facing(a, 0)), 3_000, 'the line formed, facing south');
  assert.deepEqual(archers.map((a) => a.entity.position.x), [-1.5, 0.5, 2.5]);

  const behind = f.spawn(zombie(0.5, 5));
  const ahead = f.spawn(zombie(0.5, 20));
  await until(() => archers.every((a) => f.shots.get(a)!.length > 0), 2_000, 'every archer shooting');
  assert.ok(archers.every((a) => f.shots.get(a)![0] === ahead), 'the zombie in front of the line first');
  ahead.isValid = false;
  await until(() => archers.every((a) => f.shots.get(a)!.at(-1) === behind), 2_000, 'then the one behind');
  assert.ok(archers.every((a) => a.entity.position.z === 8.5), 'from their slots');
  assert.equal(o.status, 'running');
  await f.h.runner.stopAll();
});

test('ligne-archers behind a shield wall: each archer lobs over the guard 2 blocks in front of it, from its slot (the high arc, aim.overFriends), not into its back', { timeout: 15_000 }, async () => {
  const f = field();
  const archers = [-2, 0, 2].map((x, i) => f.add(`Archer${i}`, x, -3, BOW));
  // The wall: one of Paul's guards 2 blocks in front of each archer's slot (x −1.5, 0.5, 2.5 at z 8.5).
  [-2, 0, 2].forEach((x, i) => f.add(`Guard${i}`, x, 10, SHIELD));
  await f.start('ligne-archers', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), ['back=4']);
  try {
    await until(() => archers.every((a) => a.entity.position.z === 8.5), 3_000, 'the line formed');
    const z = f.spawn(zombie(0.5, 16));
    await until(() => archers.every((a) => a.releases.some((r) => r.fired)), 8_000, 'every archer shooting');
    for (const a of archers) {
      // Mineflayer's pitch, up positive: the flat arc to a zombie 7.5 blocks out is about 0, through the guard's back.
      const fired = a.releases.filter((r) => r.fired);
      assert.ok(fired.every((r) => r.pitch > 0.5), `${a.username} lobbed over the wall: ${fired.map((r) => r.pitch.toFixed(2)).join(', ')}`);
      assert.equal(a.entity.position.z, 8.5, 'from its slot, no step aside');
    }
    z.isValid = false;
  } finally {
    await f.h.runner.stopAll();
  }
});

test('ligne-archers: past 8 archers, two ranks 2 blocks apart', async () => {
  const f = field();
  const archers = Array.from({ length: 10 }, (_, i) => f.add(`Archer${i}`, i - 5, -6, BOW));
  await f.start('ligne-archers', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }));
  await until(() => archers.every((a) => a.entity.position.z === 8.5 || a.entity.position.z === 6.5), 3_000, 'the two ranks formed');
  assert.equal(archers.filter((a) => a.entity.position.z === 8.5).length, 5);
  assert.equal(new Set(archers.map((a) => xz(a).join())).size, 10, 'distinct slots');
  await f.h.runner.stopAll();
});

// -- tir ----------------------------------------------------------------------------------------------------------

test('tir from any item: the creature nearest the block pointed at (within `near`) is shot; farther than that, the volley goes on the block', async () => {
  const f = field();
  // Side by side, not one behind the other: an archer in front of another, in its line of fire, would stop its arrows.
  const archers = [f.add('Archer0', 0, 0, BOW), f.add('Archer1', 2, 3, BOW)];
  // A stick's right-click at the block (10, 63, 0): the zombie 2.8 blocks from its top is the target.
  const z = f.spawn(zombie(12.5, 2.5));
  await f.click('tir', f.snap({ yaw: -90, lookBlock: { x: 10, y: 63, z: 0, name: 'stone' }, trigger: { kind: 'use', item: 'stick' } }));
  await until(() => archers.every((a) => f.shots.get(a)!.includes(z)), 2_000, 'both archers on the zombie');
  z.isValid = false;
  await until(() => !!f.ended('tir'), 2_000, 'the end');
  assert.match(f.ended('tir')!, /Cible abattue \(zombie\)/);

  // `/bots order tir` (no trigger) at the same block, a zombie 6 blocks from it: a volley on the block, not the zombie.
  f.h.notices.length = 0;
  const before = archers.map((a) => f.shots.get(a)!.length);
  const far = f.spawn(zombie(10.5, 6.5));
  await f.click('tir', f.snap({ yaw: -90, lookBlock: { x: 10, y: 63, z: 0, name: 'stone' } }), ['volley=2', 'spread=0']);
  await until(() => !!f.ended('tir'), 3_000, 'the volley');
  assert.equal(f.ended('tir'), '[Bots] « tir » terminé : Volée tirée : 4 flèches.');
  const volley = archers.flatMap((a, i) => f.shots.get(a)!.slice(before[i]!)) as Array<{ position?: Vec3 }>;
  assert.ok(!volley.includes(far as never), 'not at the zombie');
  assert.deepEqual(volley.map((s) => [s.position!.x, s.position!.y, s.position!.z]), Array(4).fill([10.5, 64, 0.5]));
});

test('tir: an arrow in the ground sends a volley, `volley` arrows per archer spread over the disc, from where they stand', async () => {
  const f = field();
  // A file across the line of fire (one beside another, not one in front of another: it would stop its arrows).
  const archers = [0, -3, -6].map((z, i) => f.add(`Archer${i}`, 0, z, BOW));
  const hit = { x: 20.5, y: 64.05, z: 10.5 };
  const r = await f.click('tir', f.snap({ yaw: -60, trigger: { kind: 'arrow-hit', item: 'bow', hit: { position: hit } } }), ['volley=3', 'spread=3']);
  assert.ok(r.ok && 'started' in r && r.started, r.text);
  await until(() => !!f.ended('tir'), 5_000, 'the volley to end');
  assert.equal(f.ended('tir'), '[Bots] « tir » terminé : Volée tirée : 9 flèches.');
  for (const a of archers) {
    const t = f.shots.get(a)! as Array<{ position: Vec3; isValid: boolean }>;
    assert.equal(t.length, 3, `${a.username}: 3 arrows`);
    for (const s of t) {
      assert.ok(Math.hypot(s.position.x - hit.x, s.position.z - hit.z) <= 3 + 1e-9, 'within the spread');
      assert.equal(s.position.y, 64, 'on the ground');
      assert.equal(s.isValid, true);
    }
    assert.ok(!a.calls.includes('pathfinder.setGoal'), 'the archers do not move');
  }
  const all = archers.flatMap((a) => f.shots.get(a)! as Array<{ position: Vec3 }>);
  assert.ok(new Set(all.map((s) => `${s.position.x},${s.position.z}`)).size > 1, 'spread, not one point');
});

test('tir: a release looking at nothing waits for its hit; the creature hit is shot by every archer until it is dead', async () => {
  const f = field();
  const archers = [f.add('Archer0', 0, 0, BOW), f.add('Archer1', 2, 0, BOW)];
  const z = f.spawn(zombie(15, 15));
  const release = await f.click('tir', f.snap({ yaw: -45, trigger: { kind: 'arrow-release', item: 'bow' } }));
  assert.ok(release.ok && 'started' in release && release.started, release.text);
  await tick(150);
  assert.ok(archers.every((a) => f.shots.get(a)!.length === 0), 'nothing shot before the hit');
  const entity = { id: z.id, name: 'zombie', type: 'mob', position: { x: 15, y: 64, z: 15 } };
  const r = await f.click('tir', f.snap({ yaw: -45, trigger: { kind: 'arrow-hit', item: 'bow', hit: { position: { x: 15, y: 65, z: 15 }, entity } } }));
  assert.ok('delivered' in r && r.delivered, 'the hit reached the order its release started');
  await until(() => archers.every((a) => f.shots.get(a)!.includes(z)), 2_000, 'both archers on the zombie');
  z.isValid = false;
  await until(() => !!f.ended('tir'), 2_000, 'the end');
  assert.match(f.ended('tir')!, /« tir » terminé : Cible abattue \(zombie\) : \d+ flèches\./);
});

test('tir: a release with no hit within 4 s fires at the block looked at; one of our own is refused', { timeout: 15_000 }, async () => {
  const f = field();
  const archer = f.add('Archer0', 0, 0, BOW);
  const mate = f.add('Guard0', 3, 3, SWORD);
  await f.click('tir', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 20, name: 'stone' }, trigger: { kind: 'arrow-release', item: 'bow' } }), ['volley=2', 'spread=0']);
  await until(() => !!f.ended('tir'), 7_000, 'the volley after the wait');
  assert.equal(f.ended('tir'), '[Bots] « tir » terminé : Volée tirée : 2 flèches.');
  assert.deepEqual((f.shots.get(archer)! as Array<{ position: Vec3 }>).map((s) => [s.position.x, s.position.y, s.position.z]), [[0.5, 64, 20.5], [0.5, 64, 20.5]]);

  f.h.notices.length = 0;
  await f.click('tir', f.snap({ yaw: 0, lookEntity: { id: (mate.entity as unknown as { id: number }).id, name: 'player', type: 'player', username: 'Guard0', position: { x: 3.5, y: 64, z: 3.5 } } }));
  await until(() => !!f.ended('tir'), 2_000, 'the refusal');
  assert.equal(f.ended('tir'), '[Bots] « tir » terminé : Guard0 est des nôtres : je ne tire pas dessus.');
  assert.equal(f.shots.get(archer)!.length, 2, 'nothing more shot');
});

test('tir takes the archers off a ligne-archers without moving them; when it ends they go back to the line, each to its own slot', async () => {
  const f = field();
  const archers = [-2, 0, 2].map((x, i) => f.add(`Archer${i}`, x, -3, BOW));
  const line = await f.start('ligne-archers', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }));
  await until(() => archers.every((a) => a.entity.position.z === 8.5), 3_000, 'the line formed');
  const slots = archers.map((a) => a.entity.position.clone());

  const r = await f.click('tir', f.snap({ yaw: 0, trigger: { kind: 'arrow-hit', item: 'bow', hit: { position: { x: 0.5, y: 64, z: 30.5 } } } }), ['volley=2']);
  assert.ok(r.ok, r.text);
  assert.match(r.text, /réquisitionné de #1/);
  assert.deepEqual(line.memberNames(), [], 'all three taken');
  // One archer is knocked out of place during the volley: the line puts it back on its own slot afterwards.
  archers[0]!.entity.position = new Vec3(6.5, 64, 2.5);
  await until(() => !!f.ended('tir'), 5_000, 'the volley to end');
  assert.equal(f.ended('tir'), '[Bots] « tir » terminé : Volée tirée : 6 flèches.');
  await until(() => line.memberNames().length === 3, 2_000, 'the archers back on the line');
  await until(() => archers.every((a, i) => a.entity.position.equals(slots[i]!)), 2_000, 'each on its own slot again');
  assert.equal(line.status, 'running');
  await f.h.runner.stopAll();
});
