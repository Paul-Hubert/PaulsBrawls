// The stock commands of orders bound to items (docs/29 §5.4 item 8), on FakeBots over a flat world (stone up to
// y = 63) that walk to their pathfinder goals: `mur-de-boucliers` (shield), `epee` (sword), `ligne-archers` (arrow)
// and `tir` (bow). Each test checks the command's choices: where the bots stand, what they face and fight, what a
// later click changes without restarting the order, and what `tir` shoots.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';

import { mineflayerYaw } from '../src/api/helpers';
import { GoalFollowOffset } from '../src/bots/follow-goal';
import type { Order } from '../src/orders/order';
import { loadStock } from '../src/stock';
import { EMPTY_SNAPSHOT, type Snapshot } from '../src/types';
import { flatWorld, type FakeBot, type FakeItem } from './fakes/fake-bot';
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
const zombie = (x: number, z: number): Mob => ({ id: nextId++, type: 'hostile', name: 'zombie', position: new Vec3(x, 64, z), isValid: true, height: 1.95 });

const SHIELD: FakeItem[] = [{ name: 'iron_sword', count: 1 }, { name: 'shield', count: 1 }];
const SWORD: FakeItem[] = [{ name: 'iron_sword', count: 1 }];
const BOW: FakeItem[] = [{ name: 'bow', count: 1 }, { name: 'arrow', count: 64 }];

/** Paul at (0.5, 64, 0.5) on flat ground; his bots see the same entities (by network id) and walk to their goals. */
function field() {
  const h = harness({ stock });
  const commander = { id: 1, type: 'player', username: 'Paul', name: 'player', position: new Vec3(0.5, 64, 0.5), isValid: true, height: 1.8 };
  const world: Record<string, unknown> = { 1: commander };
  const players: Record<string, { entity: unknown }> = { Paul: { entity: commander } };
  const shots = new Map<FakeBot, unknown[]>();
  let id = 10;
  /** A bot of Paul's standing on the block (x, 63, z). Archers shoot at once: an arrow leaves 20 ms after hawkEye is told. */
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
    shots.set(b, []);
    b.hawkEye.oneShot = ((t: unknown) => {
      shots.get(b)!.push(t);
      const left = (b.inventory.items().find((i) => i.name === 'arrow')?.count ?? 1) - 1;
      setTimeout(() => b.setItems([{ name: 'bow', count: 1 }, { name: 'arrow', count: left }]), 20);
    }) as never;
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

  // A zombie within `reach` (4) of one slot only: that guard lowers its shield and fights it, the others hold.
  const z = f.spawn(zombie(5, 12));
  const fighter = guards.find((g) => g.entity.position.x === 1.5)!;
  await until(() => fighter.pvp.target === z, 2_000, 'the guard nearest the zombie on it');
  assert.equal(fighter.usingHeldItem, false);
  assert.equal(on(guards, z), 1);
  assert.ok(guards.filter((g) => g !== fighter).every(shieldUp), 'the others keep their shields up');
  z.isValid = false;
  await until(() => fighter.pvp.target === null && shieldUp(fighter), 2_000, 'back on its slot, shield up');
  assert.deepEqual(xz(fighter), [1.5, 10.5]);
  await f.h.runner.stopAll();
});

// -- epee ---------------------------------------------------------------------------------------------------------

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
  await until(() => archers.every((a) => f.shots.get(a)!.includes(z)), 2_000, 'the archers on it');

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

test('tir: an arrow in the ground sends a volley, `volley` arrows per archer spread over the disc, from where they stand', async () => {
  const f = field();
  const archers = [0, 2, 4].map((x, i) => f.add(`Archer${i}`, x, 0, BOW));
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
