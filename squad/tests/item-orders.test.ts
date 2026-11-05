// The stock commands of orders bound to items (docs/29 §5.4 item 8), on FakeBots over a flat world (stone up to
// y = 63) that walk to their pathfinder goals: `line` (the shield wall and the archers' line, once
// `mur-de-boucliers` and `ligne-archers`) and `attack` (once `epee` and `tir`, docs/40), whatever item carries them (a
// click only says where the commander points: pointedTarget). Each test checks the command's choices: where the bots
// stand, what they face and fight, what a later click changes without restarting the order, and what `attack` shoots.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';

import { HelperError } from '../src/api/errors';
import { lineSlots, lookDir, mineflayerYaw, toVec3 } from '../src/api/helpers';
import type { Order } from '../src/orders/order';
import { steer } from '../src/bots/mount';
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
/** A test may refuse some shots, as shoot does when the line of fire is blocked: the message, or null to shoot. */
let refuse: ((target: unknown) => string | null) | null = null;
recordShots((name, t) => {
  const live = !!t && typeof t === 'object' && 'isValid' in t && !!(t as { position?: unknown }).position;
  aims.get(name)?.push(live ? t : { position: toVec3(t as never), isValid: true });
  const why = refuse?.(t);
  if (why) throw new HelperError(why);
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
    // A physics clock for everyone, as a real bot has: a guard's last step onto its exact place in a shield wall is
    // walked with its controls (an archer's clock comes in bursts, for its draws).
    if (items.some((i) => i.name === 'bow')) b.archer();
    else b.physics();
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
/**
 * Where a bot's walk starts in its calls: its pathfinder goal or a direct step (from the fake pathfinder, a bot whose
 * slot is its block's centre lands exactly on it, with no step to walk).
 */
const walkStart = (calls: string[]): number => calls.findIndex((c) => (c.startsWith('pathfinder.setGoal') && c !== 'pathfinder.setGoal(null)') || c === 'setControlState(forward,true)');
/** The shield wall formed facing west on x = -7.5 (the block looked at, x -8): every guard there, facing it, shield up. The shield goes up before the walk, so a raised shield alone is not there yet. */
const formedWest = (guards: FakeBot[]): boolean => guards.every((g) => shieldUp(g) && g.entity.position.x === -7.5 && facing(g, 90));

// -- line: the shield wall (guards alone) ---------------------------------------------------------------------

test('line (guards): facing west the guards walk shield up to the block looked at, line up along z and face west; a click re-forms the wall elsewhere without restarting the order, shields kept up', async () => {
  const f = field();
  const guards = [f.add('Guard0', -3, 3, SHIELD), f.add('Guard1', -3, -2, SHIELD), f.add('Guard2', -3, 0, SHIELD)];
  const o = await f.start('line', f.snap({ yaw: 90, lookBlock: { x: -8, y: 63, z: 0, name: 'grass_block' }, trigger: { kind: 'use', item: 'shield' } }));
  try {
    await until(() => formedWest(guards), 3_000, 'the wall formed facing west');
    // On top of the block looked at, across the view (along z), 1 block apart. Facing west, the left is +Z: each guard
    // got the slot on its own side of the others, so no two paths crossed.
    assert.deepEqual(guards.map(xz), [[-7.5, 1.5], [-7.5, -0.5], [-7.5, 0.5]]);
    for (const g of guards) {
      const raised = g.calls.indexOf('activateItem(offHand)');
      const walked = walkStart(g.calls);
      assert.ok(raised >= 0 && walked >= 0 && raised < walked, `${g.username} raised its shield before walking: ${g.calls.join(' ')}`);
      assert.ok(g.calls.includes('equip(shield,off-hand)'));
    }

    // A click facing south at (0, 63, 10): the same order re-forms there, the guards walking there behind their shields.
    const from = guards.map((g) => g.calls.length);
    const r = await f.click('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: { kind: 'use', item: 'shield' } }));
    assert.deepEqual(r, { ok: true, text: '', orderId: o.id, delivered: true });
    const down = new Set<string>();
    await until(() => {
      for (const g of guards) if (!shieldUp(g)) down.add(g.username);
      return guards.every((g) => g.entity.position.z === 10.5 && shieldUp(g) && facing(g, 0));
    }, 3_000, 'the wall re-formed facing south');
    assert.deepEqual(guards.map((g) => g.entity.position.x).sort((a, b) => a - b), [-0.5, 0.5, 1.5]);
    assert.deepEqual([...down], [], 'no shield lowered on the way');
    guards.forEach((g, i) => {
      const after = g.calls.slice(from[i]);
      assert.ok(walkStart(after) >= 0, `${g.username} walked to its new slot: ${after.join(' ')}`);
      assert.ok(!after.includes('deactivateItem'), `${g.username} kept its shield up: ${after.join(' ')}`);
    });
    assert.equal(o.status, 'running');
    assert.equal(f.h.runner.running().length, 1);
  } finally {
    await f.h.runner.stopAll(); // also on a failure: the guards' loops would keep the test process alive
  }
});

test('line with horsemen (no shield, no bow): they hold the wall\'s flanks, 2 blocks apart, facing the view, with no shield to raise (docs/41)', async () => {
  const f = field();
  const SPEAR: FakeItem[] = [{ name: 'iron_spear', count: 1 }];
  const guards = [f.add('Guard0', -3, 3, SHIELD), f.add('Guard1', -3, -2, SHIELD), f.add('Guard2', -3, 0, SHIELD)];
  const riders = [f.add('Rider0', -3, 6, SPEAR), f.add('Rider1', -3, -5, SPEAR)];
  const o = await f.start('line', f.snap({ yaw: 90, lookBlock: { x: -8, y: 63, z: 0, name: 'grass_block' }, trigger: { kind: 'use', item: 'shield' } }));
  try {
    assert.deepEqual(o.roles.melee?.map((b) => (b as unknown as FakeBot).username).sort(), ['Rider0', 'Rider1']);
    await until(() => guards.every(shieldUp), 3_000, 'the wall up');
    // The wall spans z −0.5 … 1.5; the flanks are 2 beyond its ends, each rider on its own side.
    await until(() => riders.every((r) => r.entity.position.x === -7.5 && facing(r, 90)), 3_000, 'the riders on the flanks');
    assert.deepEqual(riders.map(xz), [[-7.5, 3.5], [-7.5, -2.5]]);
    for (const r of riders) assert.ok(!r.calls.some((c) => c.startsWith('activateItem') || c.startsWith('equip(shield')), `${r.username} raised no shield`);
    assert.ok(!o.report.logs.some((l) => /shield/.test(l)), o.report.logs.join('\n'));
  } finally {
    await f.h.runner.stopAll();
  }
});

for (const yaw of [87, 45, 90]) {
  test(`line (guards): ten guards at yaw ${yaw}°: a straight line, each guard on its exact lineSlots place (not a block centre), no two closer than a body's width (docs/35 F2)`, async () => {
    const f = field();
    const guards = Array.from({ length: 10 }, (_, i) => f.add(`Guard${i}`, 4, i - 5, SHIELD));
    await f.start('line', f.snap({ yaw, lookBlock: { x: 10, y: 63, z: 0, name: 'stone' }, trigger: { kind: 'use', item: 'shield' } }));
    try {
      const point = new Vec3(10.5, 64, 0.5);
      const exact = lineSlots(point, yaw, 10, { spacing: 1 });
      const block = (p: { x: number; z: number }) => `${Math.floor(p.x)},${Math.floor(p.z)}`;
      // Block centres are not the line: most places lie off their block's centre (at 90° all, on the blocks' edges), and
      // at 87° and 45° two places share a block (the middle two at 87°), so guards on their blocks' centres overlapped.
      const offCentre = exact.filter((s) => Math.hypot(s.x - Math.floor(s.x) - 0.5, s.z - Math.floor(s.z) - 0.5) > 0.2);
      assert.ok(offCentre.length >= 6, `${offCentre.length} places off their block's centre`);
      if (yaw !== 90) assert.ok(new Set(exact.map(block)).size < 10, 'two exact places in one block');
      // A guard faces the yaw on its way too (docs/49): wait for every place to be taken.
      const taken = () => exact.every((s) => guards.some((g) => Math.hypot(g.entity.position.x - s.x, g.entity.position.z - s.z) <= 0.15 && !g.controlState.forward));
      await until(() => taken() && guards.every((g) => shieldUp(g) && facing(g, yaw)), 5_000, 'every place taken, shields up, facing the yaw');

      const pos = guards.map((g) => g.entity.position);
      const show = pos.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`).join(' ');
      // Each exact place has exactly one guard on it (within 0.2), on the ground.
      for (const s of exact) {
        const on = pos.filter((p) => Math.hypot(p.x - s.x, p.z - s.z) <= 0.2);
        assert.equal(on.length, 1, `one guard on ${s.x.toFixed(2)},${s.z.toFixed(2)}: ${show}`);
      }
      assert.ok(pos.every((p) => p.y === 64), `on the ground: ${show}`);
      // Collinear: every guard on the line through the point across the view.
      const fwd = lookDir(yaw);
      for (const p of pos) assert.ok(Math.abs((p.x - point.x) * fwd.x + (p.z - point.z) * fwd.z) <= 0.2, `on the line: ${show}`);
      // No two bodies (0.6 wide) overlap: the middle two of the old wall stood on one block's centre.
      let min = Infinity;
      for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) min = Math.min(min, Math.hypot(pos[i]!.x - pos[j]!.x, pos[i]!.z - pos[j]!.z));
      assert.ok(min >= 0.6, `the closest two are ${min.toFixed(2)} apart: ${show}`);
      // The last 2 blocks were walked with the controls, never sneaking (docs/43 B), and they were let go.
      assert.ok(guards.some((g) => g.calls.includes('setControlState(forward,true)')), 'a last walk with the controls');
      assert.ok(guards.every((g) => !g.calls.includes('setControlState(sneak,true)')), 'never sneaking');
      assert.ok(guards.every((g) => !g.controlState.forward), 'controls released on the slot');
    } finally {
      await f.h.runner.stopAll();
    }
  });
}

test('line (guards): a new formation ends a last step at once, its controls let go, and the guard walks to its new slot', async () => {
  const f = field();
  // Two guards: their places sit half a block either side of the point's block centre, where their walks end. A slow
  // clock (40 ms a tick), so each step is seen under way before it ends.
  const guards = [f.add('Guard0', 4, 0, SHIELD).physics({ tickMs: 40 }), f.add('Guard1', 4, 1, SHIELD).physics({ tickMs: 40 })];
  await f.start('line', f.snap({ yaw: 87, lookBlock: { x: 10, y: 63, z: 0, name: 'stone' }, trigger: { kind: 'use', item: 'shield' } }));
  try {
    // Each guard frozen as soon as its last step is under way: the step cannot end by itself (STEP_IN_MS is 3 s).
    const frozen = new Set<FakeBot>();
    await until(() => {
      for (const g of guards) {
        if (g.controlState.forward && !frozen.has(g)) {
          g.stopTicks();
          frozen.add(g);
        }
      }
      return frozen.size === guards.length;
    }, 3_000, 'both last steps under way');
    const from = guards.map((g) => g.calls.length);
    await f.click('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: { kind: 'use', item: 'shield' } }));
    await until(() => guards.every((g) => Math.abs(g.entity.position.z - 10.5) < 0.01), 1_500, 'both at the new wall, well before a step would give up');
    guards.forEach((g, i) => {
      const after = g.calls.slice(from[i]);
      const letGo = after.indexOf('setControlState(forward,false)');
      assert.ok(letGo >= 0 && letGo < after.indexOf('pathfinder.setGoal'), `${g.username}: controls let go before the walk: ${after.join(' ')}`);
    });
    for (const g of guards) g.physics({ tickMs: 10 });
    // On their exact places (x = 0 and 1), not the block centres the fake pathfinder leaves them on: a guard faces
    // south on its way too (docs/49).
    const atWall = () => [0, 1].every((x) => guards.some((g) => Math.abs(g.entity.position.x - x) <= 0.15 && Math.abs(g.entity.position.z - 10.5) <= 0.15));
    await until(() => atWall() && guards.every((g) => shieldUp(g) && facing(g, 0)), 3_000, 'both on the new wall, shields up');
    // Facing south, the left is +X: the exact places are x = 1 and x = 0, half a block either side of the point.
    const xs = guards.map((g) => g.entity.position.x).sort((a, b) => a - b);
    assert.ok(Math.abs(xs[0]! - 0) <= 0.2 && Math.abs(xs[1]! - 1) <= 0.2, `on the exact places: ${xs.join(', ')}`);
    assert.ok(guards.every((g) => Math.abs(g.entity.position.z - 10.5) <= 0.2));
  } finally {
    await f.h.runner.stopAll();
  }
});

test('line (guards): a guard keeps its shield up with a zombie at the wall; hit in melee it hits back once, then raises its shield again', async () => {
  const f = field();
  const guards = [f.add('Guard0', -3, 3, SHIELD), f.add('Guard1', -3, -2, SHIELD), f.add('Guard2', -3, 0, SHIELD)];
  await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: { kind: 'use', item: 'shield' } }));
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

test('line (guards): hit by an attacker out of arm\'s reach, the guard steps toward it, strikes once and walks back to its slot', async () => {
  const f = field();
  const g = f.add('Guard0', -3, 0, SHIELD);
  await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: { kind: 'use', item: 'shield' } }));
  try {
    await until(() => g.entity.position.z === 10.5 && shieldUp(g), 3_000, 'on its slot');
    // Knocked back by the shield, the zombie stands 4 blocks off: a step toward it first.
    const z = f.spawn(zombie(0.5, 14.5));
    g.emit('meleeHit', z, { blocked: true });
    await until(() => (g.pathfinder.goal as { entity?: unknown } | null)?.entity === z, 1_000, 'a step toward it');
    assert.equal(g.hits.length, 0, 'no blow out of reach');
    g.entity.position = new Vec3(0.5, 64, 12.5); // the step
    await until(() => g.hits.length === 1, 1_000, 'the blow');
    await until(() => Math.abs(xz(g)[1] - 10.5) <= 0.15 && Math.abs(xz(g)[0] - 0.5) <= 0.15 && shieldUp(g), 2_000, 'back on its slot, shield up');
    assert.equal(g.hits.length, 1);
  } finally {
    await f.h.runner.stopAll();
  }
});

test('line (horsemen): a rider\'s reach is measured from its eyes in the saddle: a chicken 2.7 blocks off is out of its arm\'s reach, so it steps first (docs/43 A8)', async () => {
  const f = field();
  const r = f.add('Rider0', -3, 0, [{ name: 'iron_spear', count: 1 }]);
  // mount.ts: a rider's eyes are the player's plus the seat (1.62 + 0.84375).
  Object.assign(r.entity, { eyeHeight: 2.46375 });
  await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: { kind: 'use', item: 'shield' } }));
  try {
    await until(() => r.entity.position.z === 10.5 && facing(r, 0), 3_000, 'the rider on its slot');
    const chicken = f.spawn({ id: nextId++, type: 'animal', name: 'chicken', position: new Vec3(r.entity.position.x, 64, 13.2), isValid: true, height: 0.7 });
    Object.assign(chicken, { width: 0.4 });
    r.emit('meleeHit', chicken, { blocked: false });
    // From 1.62 the chicken's hitbox is 2.66 away (a blow at once); from the saddle's 2.46, 3.06: a step toward it first.
    await until(() => (r.pathfinder.goal as { entity?: unknown } | null)?.entity === chicken || r.hits.length > 0, 1_000, 'a step or a blow');
    assert.equal(r.hits.length, 0, 'no blow out of reach from the saddle');
  } finally {
    await f.h.runner.stopAll();
  }
});

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

test('line (guards): a guard pushed 2 blocks off its slot long after the wall formed walks back to the exact slot, shield up', async () => {
  const f = field();
  const guards = [f.add('Guard0', -3, 3, SHIELD), f.add('Guard1', -3, -2, SHIELD), f.add('Guard2', -3, 0, SHIELD)];
  await f.start('line', f.snap({ yaw: 90, lookBlock: { x: -8, y: 63, z: 0, name: 'grass_block' }, trigger: { kind: 'use', item: 'shield' } }));
  await until(() => formedWest(guards), 3_000, 'the wall formed facing west');
  await tick(300); // a guard faces west on its way too (docs/49): one more look (200 ms) and it has marked its slot reached
  const g = guards[2]!;
  const [sx, sz] = xz(g);
  // 11 s after it reached its slot (STUCK_MS is 10 s), a fight leaves it 2 blocks off. Before the fix its timer still
  // ran from the first walk: a loose GoalNear at once, "arrived" within 2.5, and the shield up 2 blocks off the slot.
  try {
    await later(11_000, async () => {
      const from = g.calls.length;
      g.entity.position = new Vec3(sx + 2, 64, sz);
      // 2 blocks off: it walks straight back (docs/43 B) onto its exact slot (a loose hold would stop within 2.5),
      // its shield up all the way.
      let lowered = false;
      await until(() => {
        if (!shieldUp(g)) lowered = true;
        return Math.hypot(xz(g)[0] - sx, xz(g)[1] - sz) <= 0.15;
      }, 3_000, 'back on its exact slot');
      assert.equal(lowered, false, 'the shield stayed up on the way back');
      const after = g.calls.slice(from);
      assert.ok(after.includes('setControlState(forward,true)') && !after.includes('setControlState(sneak,true)'), `walked back with forward, never sneaking: ${after.join(' ')}`);
      assert.ok(!after.includes('deactivateItem'), `never lowered: ${after.join(' ')}`);
    });
  } finally {
    await f.h.runner.stopAll(); // also on a failure: the guards' loops would keep the test process alive
  }
});

test('line (guards): a wall re-formed 8 blocks behind itself walks there backward, facing the enemy with its shields up on every tick, never sprinting (docs/49)', async () => {
  const f = field();
  const guards = [f.add('Guard0', -3, 1, SHIELD), f.add('Guard1', -3, -1, SHIELD), f.add('Guard2', -3, 0, SHIELD)];
  await f.start('line', f.snap({ yaw: 90, lookBlock: { x: -8, y: 63, z: 0, name: 'grass_block' }, trigger: { kind: 'use', item: 'shield' } }));
  try {
    await until(() => formedWest(guards), 3_000, 'the wall formed facing west');
    await tick(300);
    // From here the guards walk with their bodies, as the real pathfinder steers them (steer: a free look turns only
    // the walk), and the fake pathfinder no longer puts them on their goals.
    const ticks: Array<{ facing: boolean; shield: boolean; sprint: boolean }> = [];
    for (const g of guards) {
      g.autoWalk = false;
      g.on('physicsTick', () => {
        const goal = g.pathfinder.goal as { x?: number; z?: number } | null;
        if (!goal || typeof goal.x !== 'number' || typeof goal.z !== 'number') return;
        const p = g.entity.position;
        const [dx, dz] = [goal.x + 0.5 - p.x, goal.z + 0.5 - p.z];
        if (Math.hypot(dx, dz) <= 1) {
          g.setControlState('forward', false);
          g.pathfinder.goal = null;
          return;
        }
        steer(g as never, Math.atan2(-dx, -dz));
        g.setControlState('forward', true);
        ticks.push({ facing: facing(g, 90), shield: shieldUp(g), sprint: !!g.controlState.sprint });
      });
    }
    // The wall falls back 8 blocks east (behind it), still facing west.
    await f.click('line', f.snap({ yaw: 90, lookBlock: { x: 0, y: 63, z: 0, name: 'grass_block' }, trigger: { kind: 'use', item: 'shield' } }));
    await until(() => guards.every((g) => Math.abs(g.entity.position.x - 0.5) <= 0.15 && !g.controlState.forward), 5_000, 'the wall 8 blocks back');
    assert.ok(ticks.length >= 3 * 20, `${ticks.length} walked ticks`);
    assert.ok(ticks.every((t) => t.facing), 'facing west (the enemy) on every walked tick');
    assert.ok(ticks.every((t) => t.shield), 'shield up on every walked tick');
    assert.ok(ticks.every((t) => !t.sprint), 'never sprinting');
    assert.ok(guards.every((g) => facing(g, 90) && shieldUp(g)), 'on the new wall: facing west, shields up');
  } finally {
    await f.h.runner.stopAll();
  }
});

test('line (guards) on a bow: the wall forms where the arrow landed, a later release does not move it, its hit does', async () => {
  const f = field();
  const guards = [f.add('Guard0', -3, 3, SHIELD), f.add('Guard1', -3, -2, SHIELD), f.add('Guard2', -3, 0, SHIELD)];
  // The look went far past (30 blocks, beyond `distance`); the arrow hit the ground 8 blocks west.
  const hitAt = (x: number, z: number) => ({ kind: 'arrow-hit' as const, item: 'bow', hit: { position: { x, y: 64.05, z } } });
  const o = await f.start('line', f.snap({ yaw: 90, lookBlock: { x: -30, y: 63, z: 0, name: 'stone' }, trigger: hitAt(-7.5, 0.5) }));
  try {
    await until(() => formedWest(guards), 3_000, 'the wall at the hit');
    assert.deepEqual(guards.map(xz), [[-7.5, 1.5], [-7.5, -0.5], [-7.5, 0.5]]);
    // A release while looking south: delivered, and the wall stays where it is.
    const release = await f.click('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: { kind: 'arrow-release', item: 'bow' } }));
    assert.deepEqual(release, { ok: true, text: '', orderId: o.id, delivered: true });
    await tick(500);
    assert.deepEqual(guards.map(xz), [[-7.5, 1.5], [-7.5, -0.5], [-7.5, 0.5]], 'not moved by the release');
    assert.ok(guards.every((g) => facing(g, 90) && shieldUp(g)));
    // Its hit: the wall re-forms there, facing the release's view.
    await f.click('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: hitAt(0.5, 12.5) }));
    await until(() => guards.every((g) => g.entity.position.z === 12.5 && shieldUp(g) && facing(g, 0)), 3_000, 'the wall at the new hit');
    assert.equal(o.status, 'running');
  } finally {
    await f.h.runner.stopAll();
  }
});

// -- attack: melee (and archers) on a creature or a point -----------------------------------------------------------

test('attack from any item: the creature nearest the point (within `near`) is attacked, and the order ends once it is dead; farther than that, the melee bots go to the point', async () => {
  const f = field();
  const guards = [f.add('Guard0', 0, 2, SWORD), f.add('Guard1', 1, 2, SWORD)];
  const stick = { kind: 'use' as const, item: 'stick' };
  // The block (10, 63, 0): its top (10.5, 64, 0.5) is 2.8 blocks from the zombie.
  const z = f.spawn(zombie(12.5, 2.5));
  await f.start('attack', f.snap({ yaw: -90, lookBlock: { x: 10, y: 63, z: 0, name: 'stone' }, trigger: stick }), ['radius=4']);
  try {
    await until(() => on(guards, z) === 2, 2_000, 'both guards on the zombie near the point');
    z.isValid = false;
    await until(() => !!f.ended('attack'), 2_000, 'the target down');
    assert.equal(f.ended('attack'), '[Bots] « attack » terminé : Cible abattue (zombie).');
    // The block (30, 63, 0) with a zombie 6 blocks from its top: no target, the bots go to the point (a radius of 4
    // around it, so that zombie is not theirs either).
    f.h.notices.length = 0;
    const far = f.spawn(zombie(30.5, 6.5));
    const o = await f.start('attack', f.snap({ yaw: -90, lookBlock: { x: 30, y: 63, z: 0, name: 'stone' }, trigger: stick }), ['radius=4']);
    const point = new Vec3(30.5, 64, 0.5);
    await until(() => guards.every((g) => Math.abs(Math.hypot(g.entity.position.x - point.x, g.entity.position.z - point.z) - 3) < 1), 3_000, 'on the ring around the point');
    assert.equal(on(guards, far), 0, 'the zombie 6 blocks off is left alone');
    await until(() => !!f.ended('attack'), 3_000, 'the point held');
    assert.equal(f.ended('attack'), '[Bots] « attack » terminé : Point tenu.');
    assert.equal(o.status, 'done');
  } finally {
    await f.h.runner.stopAll();
  }
});

test('attack: looking at a zombie, its group is attacked: the archers shoot it and two melee bots fight it, the others take the one next to it; the order ends once both are dead, not before (docs/44)', async () => {
  const f = field();
  const guards = [0, 1, 2, 3].map((i) => f.add(`Guard${i}`, i - 1, -2, SWORD));
  const archer = f.add('Archer0', 0, -4, BOW);
  const target = f.spawn(zombie(8, 0));
  const other = f.spawn(zombie(11, 3));
  const o = await f.start('attack', f.snap({ yaw: -90, lookEntity: { id: target.id, name: 'zombie', type: 'mob', position: { x: 8, y: 64, z: 0 } }, trigger: { kind: 'use', item: 'iron_sword' } }));
  await until(() => on(guards, target) === 2 && on(guards, other) === 2, 3_000, 'two guards on the target, two on the zombie next to it');
  await until(() => f.shots.get(archer)!.includes(target), 2_000, 'the archer on the target');
  assert.ok(!archer.calls.includes('pathfinder.setGoal'), 'the archer shoots from where it stands');
  try {
    // The target down, the one next to it (4.2 blocks off, within `group`) still stands: the attack goes on, on it.
    target.isValid = false;
    await until(() => on(guards, other) >= 2 && f.shots.get(archer)!.at(-1) === other, 2_000, 'everyone on the rest of the group');
    await tick(1_800);
    assert.equal(f.ended('attack'), undefined, 'not over while its group stands');
    other.isValid = false;
    await until(() => !!f.ended('attack'), 3_000, 'the end');
    assert.match(f.ended('attack')!, /« attack » terminé : Cible abattue \(zombie\)/);
    assert.equal(o.status, 'done');
  } finally {
    other.isValid = false;
    await f.h.runner.stopAll();
  }
});

test('attack: looking at a zombie in a group, two archers spread over the group (the pointed one first), and leave alone a zombie beyond `group` (docs/44)', async () => {
  const f = field();
  const archers = [f.add('Archer0', 0, -4, BOW), f.add('Archer1', 3, -4, BOW)];
  const target = f.spawn(zombie(8, 0));
  const other = f.spawn(zombie(11, 3));
  const far = f.spawn(zombie(8, 14)); // 14 from the target: beyond group=8
  await f.start('attack', f.snap({ yaw: -90, lookEntity: { id: target.id, name: 'zombie', type: 'mob', position: { x: 8, y: 64, z: 0 } }, trigger: { kind: 'use', item: 'bow' } }));
  try {
    await until(() => archers.some((a) => f.shots.get(a)!.includes(target)) && archers.some((a) => f.shots.get(a)!.includes(other)), 3_000, 'one archer on each');
    assert.ok(archers.every((a) => !f.shots.get(a)!.includes(far)), 'the zombie beyond the group left alone');
  } finally {
    target.isValid = false;
    other.isValid = false;
    far.isValid = false;
    await f.h.runner.stopAll();
  }
});

/** The worst timer lateness while `fn` runs: a script loop that awaits no timer starves every timer (the 3 s canary). */
async function worstLag(fn: () => Promise<void>): Promise<number> {
  let worst = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - 20);
    last = now;
  }, 20);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
  return worst;
}

test('attack: melee bots far from the point ride there before they fight what is near it; the loop never spins on an attack that breaks off at once (found live: 30 bots, loop p99 3 s)', async () => {
  const f = field();
  const riders = [f.add('Rider0', 0, 2, SWORD), f.add('Rider1', 1, 2, SWORD)];
  // A zombie 2 blocks from the point, 40 blocks away: within radius of the point, far beyond radius + 4 of the bots.
  const z = f.spawn(zombie(42.5, 0.5));
  const lag = await worstLag(async () => {
    await f.start('attack', f.snap({ yaw: -90, lookBlock: { x: 40, y: 63, z: 0, name: 'grass_block' }, trigger: { kind: 'use', item: 'iron_sword' } }), ['radius=4', 'near=0']);
    await until(() => on(riders, z) === 2, 4_000, 'both riders on the zombie by the point');
  });
  assert.ok(lag < 1_000, `the event loop kept turning (worst timer lateness ${lag} ms)`);
  z.isValid = false;
  await f.h.runner.stopAll();
});

test('attack at the ground: the archers fire their volley from where they stand, the melee bots take a ring of 3 around the point and fight what comes near it; a click at the sky changes nothing', async () => {
  const f = field();
  const guards = [f.add('Guard0', 0, 2, SWORD), f.add('Guard1', 1, 2, SWORD)];
  const archers = [f.add('Archer0', 0, -2, BOW), f.add('Archer1', 0, -5, BOW)];
  const o = await f.start('attack', f.snap({ yaw: -90, lookBlock: { x: 20, y: 63, z: 0, name: 'grass_block' }, trigger: { kind: 'use', item: 'iron_sword' } }), ['volley=2']);
  const point = new Vec3(20.5, 64, 0.5);
  const d = (b: FakeBot) => Math.hypot(b.entity.position.x - point.x, b.entity.position.z - point.z);
  await until(() => guards.every((g) => Math.abs(d(g) - 3) < 1), 3_000, 'the guards on their ring around the point');
  assert.notDeepEqual(xz(guards[0]!), xz(guards[1]!), 'distinct slots');
  await until(() => archers.every((a) => f.shots.get(a)!.length >= 2), 3_000, 'the volley');

  // A zombie near the point: fought by the guards, shot by the archers.
  const z = f.spawn(zombie(25, 5));
  await until(() => on(guards, z) === 2, 2_000, 'the guards on it');
  await until(() => archers.every((a) => f.shots.get(a)!.some((s) => s === z)), 2_000, 'the archers on it');

  // Looking at the sky: « Aucune cible. », the attack goes on.
  const r = await f.click('attack', f.snap({ yaw: -90, pitch: -60, trigger: { kind: 'use', item: 'iron_sword' } }), ['volley=2']);
  assert.deepEqual(r, { ok: true, text: '', orderId: o.id, delivered: true });
  await until(() => o.report.logs.includes('say: Aucune cible.'), 1_000, 'the answer');
  assert.equal(o.status, 'running');
  for (const a of archers) assert.ok(!a.calls.includes('pathfinder.setGoal'), `${a.username} did not walk`);
  z.isValid = false;
  await until(() => !!f.ended('attack'), 4_000, 'the point held');
  assert.match(f.ended('attack')!, /« attack » terminé : Volée tirée, point tenu : \d+ flèches\./);
});

// -- line: the archers (archers alone, then behind the wall) -------------------------------------------------

test('line (archers): the line stands `back` blocks short of the point, across the view and facing it, and shoots what comes in front first', async () => {
  const f = field();
  const archers = [-2, 0, 2].map((x, i) => f.add(`Archer${i}`, x, -3, BOW));
  const o = await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), ['back=4']);
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

test('line: the archers behind the shield wall: each archer lobs over the guard 2 blocks in front of it, from its slot (the high arc, aim.overFriends), not into its back', { timeout: 15_000 }, async () => {
  const f = field();
  const archers = [-2, 0, 2].map((x, i) => f.add(`Archer${i}`, x, -3, BOW));
  // The wall: one of Paul's guards 2 blocks in front of each archer's slot (x −1.5, 0.5, 2.5 at z 8.5).
  [-2, 0, 2].forEach((x, i) => f.add(`Guard${i}`, x, 10, SHIELD));
  await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), ['back=4']);
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

test('line (archers): one rank by default, ten archers too; `ranks=2`: two ranks 2 blocks apart (docs/35 F4)', async () => {
  for (const [tokens, front, back] of [[[], 10, 0], [['ranks=2'], 5, 5]] as const) {
    const f = field();
    const archers = Array.from({ length: 10 }, (_, i) => f.add(`Archer${i}`, i - 5, -6, BOW));
    await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), [...tokens]);
    try {
      await until(() => archers.filter((a) => a.entity.position.z === 8.5).length === front && archers.filter((a) => a.entity.position.z === 6.5).length === back, 3_000, `${front} + ${back}`);
      assert.equal(new Set(archers.map((a) => xz(a).join())).size, 10, 'distinct slots');
    } finally {
      await f.h.runner.stopAll();
    }
  }
});

/** The block 12 ahead of Paul along the view, as a click on it gives lookBlock (its top centre is the point). */
const blockAhead = (yaw: number) => {
  const d = lookDir(yaw);
  return { x: Math.floor(0.5 + d.x * 12), y: 63, z: Math.floor(0.5 + d.z * 12), name: 'grass_block' };
};
/** The line's centre for a click on `look`: `back` blocks short of the block's top centre, toward Paul (exact, as the order computes it). */
const lineCentre = (look: { x: number; z: number }, yaw: number, back: number): Vec3 => {
  const fwd = lookDir(yaw);
  return new Vec3(look.x + 0.5 - fwd.x * back, 64, look.z + 0.5 - fwd.z * back);
};

// Spacing 1, the closest the line allows (neighbours' places 1 apart, bodies 0.6 wide), except two ranks at 90°: ranks
// of 5 at spacing 1 across an axis stand on block centres, where they always stood; at 1.5 four places lie on the
// blocks' edges.
for (const [yaw, ranks, spacing] of [[87, 1, 1], [87, 2, 1], [45, 1, 1], [45, 2, 1], [90, 1, 1], [90, 2, 1.5]] as const) {
  test(`line (archers): ten archers at yaw ${yaw}°, ${ranks === 1 ? 'one rank' : 'ranks=2'}, spacing ${spacing}: each rank a straight line, each archer on its exact lineSlots place (not a block centre), no two closer than a body's width (docs/35 F4, as the wall's F2)`, async () => {
    const f = field();
    const archers = Array.from({ length: 10 }, (_, i) => f.add(`Archer${i}`, i - 5, -6, BOW));
    const look = blockAhead(yaw);
    await f.start('line', f.snap({ yaw, lookBlock: look, trigger: { kind: 'use', item: 'arrow' } }), [`archerSpacing=${spacing}`, `ranks=${ranks}`]);
    try {
      const centre = lineCentre(look, yaw, 4);
      const exact = lineSlots(centre, yaw, 10, { spacing, ranks, depth: 2 });
      // Block centres are not the line: places lie off their block's centre (at 90° on the blocks' edges), so archers
      // on their blocks' centres stood in a jagged line, and at 87° and 45° two of them on one spot.
      const offCentre = exact.filter((s) => Math.hypot(s.x - Math.floor(s.x) - 0.5, s.z - Math.floor(s.z) - 0.5) > 0.2);
      assert.ok(offCentre.length >= 4, `${offCentre.length} places off their block's centre`);
      // Not sneaking: done with its last step (whose look toward the place can be the view's own yaw).
      const done = (a: FakeBot) => facing(a, yaw) && !a.controlState.forward && !a.controlState.sneak;
      await until(() => archers.every(done), 5_000, 'every archer facing the yaw, its last step done');

      const pos = archers.map((a) => a.entity.position);
      const show = pos.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`).join(' ');
      // Each exact place has exactly one archer on it (within 0.2), on the ground.
      for (const s of exact) {
        const on = pos.filter((p) => Math.hypot(p.x - s.x, p.z - s.z) <= 0.2);
        assert.equal(on.length, 1, `one archer on ${s.x.toFixed(2)},${s.z.toFixed(2)}: ${show}`);
      }
      assert.ok(pos.every((p) => p.y === 64), `on the ground: ${show}`);
      // Each rank collinear: on its line across the view, rank r 2r blocks behind the centre (toward Paul).
      const fwd = lookDir(yaw);
      const ahead = (p: Vec3) => (p.x - centre.x) * fwd.x + (p.z - centre.z) * fwd.z;
      for (let r = 0; r < ranks; r++) assert.equal(pos.filter((p) => Math.abs(ahead(p) + 2 * r) <= 0.2).length, 10 / ranks, `rank ${r} on its line: ${show}`);
      // No two bodies (0.6 wide) overlap.
      let min = Infinity;
      for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) min = Math.min(min, Math.hypot(pos[i]!.x - pos[j]!.x, pos[i]!.z - pos[j]!.z));
      assert.ok(min >= 0.6, `the closest two are ${min.toFixed(2)} apart: ${show}`);
      // The last 2 blocks were walked with the controls, never sneaking (docs/43 B).
      assert.ok(archers.some((a) => a.calls.includes('setControlState(forward,true)')), 'a last walk with the controls');
      assert.ok(archers.every((a) => !a.calls.includes('setControlState(sneak,true)')), 'never sneaking');
    } finally {
      await f.h.runner.stopAll();
    }
  });
}

/** Stop an archer's fast clock and tick it every `tickMs` instead (0: the test ticks it), so a last step is seen under way. */
const slowClock = (a: FakeBot, tickMs: number): FakeBot => {
  a.stopTicks();
  return a.archer({ tickMs });
};

test('line (archers): a new formation ends a last step at once, its controls let go, and the archer walks to its new slot', async () => {
  const f = field();
  // Two archers, back 0 and spacing 1: their places sit half a block either side of the point's block centre, where
  // their walks end. A slow clock (40 ms a tick), so each step is seen under way before it ends.
  const archers = [slowClock(f.add('Archer0', 4, 0, BOW), 40), slowClock(f.add('Archer1', 4, 1, BOW), 40)];
  const tokens = ['back=0', 'archerSpacing=1'];
  const look = blockAhead(87);
  const places = lineSlots(lineCentre(look, 87, 0), 87, 2, { spacing: 1 });
  assert.equal(new Set(places.map((s) => `${Math.floor(s.x)},${Math.floor(s.z)}`)).size, 1, 'both places in one block');
  await f.start('line', f.snap({ yaw: 87, lookBlock: look, trigger: { kind: 'use', item: 'arrow' } }), tokens);
  try {
    // Each archer frozen as soon as its last step is under way: the step cannot end by itself (STEP_IN_MS is 3 s).
    const frozen = new Set<FakeBot>();
    await until(() => {
      for (const a of archers) {
        if (a.controlState.forward && !frozen.has(a)) {
          a.stopTicks();
          frozen.add(a);
        }
      }
      return frozen.size === archers.length;
    }, 3_000, 'both last steps under way');
    const from = archers.map((a) => a.calls.length);
    // The same args: a click with others would restart the order (docs/35 F5).
    await f.click('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 10, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), tokens);
    await until(() => archers.every((a) => Math.abs(a.entity.position.z - 10.5) < 0.01), 1_500, 'both at the new line, well before a step would give up');
    archers.forEach((a, i) => {
      const after = a.calls.slice(from[i]);
      const walk = after.indexOf('pathfinder.setGoal');
      const at = after.indexOf('setControlState(forward,false)');
      assert.ok(at >= 0 && at < walk, `${a.username}: forward let go before the walk: ${after.join(' ')}`);
    });
    for (const a of archers) a.archer();
    await until(() => archers.every((a) => facing(a, 0) && !a.controlState.sneak), 3_000, 'both on the new line, facing south');
    // Facing south, the left is +X: the exact places are x = 1 and x = 0, half a block either side of the point.
    const xs = archers.map((a) => a.entity.position.x).sort((a, b) => a - b);
    assert.ok(Math.abs(xs[0]! - 0) <= 0.2 && Math.abs(xs[1]! - 1) <= 0.2, `on the exact places: ${xs.join(', ')}`);
    assert.ok(archers.every((a) => Math.abs(a.entity.position.z - 10.5) <= 0.2));
  } finally {
    await f.h.runner.stopAll();
  }
});

test('line (archers), march=0: a foe in range ends a last step: the archer lets go of forward before it draws, shoots from where it stands, then finishes the step (docs/35 F4)', async () => {
  const f = field();
  // The test ticks this archer's clock itself until the step is under way.
  const a = slowClock(f.add('Archer0', 4, 0, BOW), 0);
  // The controls and the body's place at each draw.
  const atDraw: Array<{ forward: boolean; sneak: boolean; at: Vec3 }> = [];
  const activate = a.activateItem.bind(a);
  a.activateItem = (offHand = false) => {
    if (!offHand) atDraw.push({ forward: !!a.controlState.forward, sneak: !!a.controlState.sneak, at: a.entity.position.clone() });
    activate(offHand);
  };
  const look = blockAhead(45);
  // One archer: its place is the line's centre, 4 short of the point, about 0.24 off its block's centre.
  const slot = lineCentre(look, 45, 4);
  const off = (p: Vec3) => Math.hypot(p.x - slot.x, p.z - slot.z);
  await f.start('line', f.snap({ yaw: 45, lookBlock: look, trigger: { kind: 'use', item: 'arrow' } }), ['march=0']);
  try {
    await until(() => a.listenerCount('physicsTick') > 0, 2_000, 'the last step under way (its steering on the ticks)');
    const from = a.entity.position.clone();
    assert.ok(off(from) > 0.15, `its walk ended ${off(from).toFixed(2)} off the place`);
    a.tick(); // one physics tick: the step steers toward the place and holds forward
    assert.ok(a.controlState.forward, 'the step walks with forward');
    const z = f.spawn(zombie(look.x + 0.5, look.z + 4.5));
    await until(() => !a.controlState.forward, 1_000, 'the step letting go for the foe, at once');
    const stopped = a.entity.position.clone();
    assert.ok(off(a.entity.position) > 0.15, 'still off its place: the step was ended, not done');
    a.archer(); // its clock again: the draw counts ticks
    await until(() => a.releases.some((r) => r.fired), 3_000, 'a shot');
    assert.equal(f.shots.get(a)![0], z);
    assert.deepEqual({ forward: atDraw[0]!.forward, sneak: atDraw[0]!.sneak }, { forward: false, sneak: false }, 'the controls let go at the draw');
    // Drawn where the step stopped (the body slides a little after one walked tick: velocity × 2.2).
    assert.ok(atDraw[0]!.at.distanceTo(stopped) < 0.3, 'drawn from where the step stopped');
    assert.ok(!a.calls.includes('setControlState(sneak,true)'), 'never sneaking');
    // In the calls too: forward let go after the last forward and before the draw, and not taken again.
    const draw = a.calls.indexOf('activateItem');
    const lastForward = a.calls.lastIndexOf('setControlState(forward,true)', draw);
    assert.ok(a.calls.lastIndexOf('setControlState(forward,false)', draw) > lastForward, `forward let go after the step's last forward and before the draw: ${a.calls.join(' ')}`);
    // Dead: the archer finishes its step onto the exact place (its controls let go) and faces the view. The step's look
    // toward the place is the view's own yaw here (the centre lies along the view from the block's centre).
    z.isValid = false;
    await until(() => facing(a, 45) && off(a.entity.position) <= 0.15 && !a.controlState.forward, 3_000, 'on its exact place, its step done, facing the view');
  } finally {
    await f.h.runner.stopAll();
  }
});

test('line (archers), march=0: an archer still walking to its slot shoots a foe in range from where it stands, then goes on (docs/35 F4)', async () => {
  const f = field();
  const a = f.add('Archer0', 0, -3, BOW);
  a.walkMs = 60_000; // still on its way for the whole test
  const o = await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), ['back=4', 'march=0']);
  try {
    await until(() => a.pathfinder.goal !== null, 2_000, 'walking to its slot');
    const start = xz(a);
    const z = f.spawn(zombie(0.5, 30));
    await until(() => a.releases.some((r) => r.fired), 3_000, 'a shot on the way');
    assert.deepEqual(f.shots.get(a)![0], z);
    assert.deepEqual(xz(a), start, 'from where it stood');
    // It stopped walking to draw: the goal cleared before the draw, set again after.
    const draw = a.calls.indexOf('activateItem');
    assert.ok(a.calls.lastIndexOf('pathfinder.setGoal(null)', draw) > a.calls.indexOf('pathfinder.setGoal'), 'the goal cleared before the draw');
    z.isValid = false;
    await until(() => a.pathfinder.goal !== null, 2_000, 'walking on to its slot');
    assert.ok(o.report.logs.some((l) => /Archer0: holds fire: walking to its slot, nothing within 120 blocks/.test(l)));
  } finally {
    await f.h.runner.stopAll();
  }
});

test('line (archers): told to a new slot, an archer on foot gets there first: it holds fire on the way, never stops its walk, and shoots once there', async () => {
  const f = field();
  const a = f.add('Archer0', 0, -3, BOW);
  a.walkMs = 1_500; // on its way for 1.5 s
  const o = await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), ['back=4']);
  try {
    await until(() => a.pathfinder.goal !== null, 2_000, 'walking to its slot');
    const z = f.spawn(zombie(0.5, 30));
    await tick(800);
    assert.equal(f.shots.get(a)!.length, 0, 'no shot on the way');
    assert.ok(a.pathfinder.goal !== null, 'still walking');
    assert.ok(!a.calls.includes('pathfinder.setGoal(null)'), 'its walk never cleared for a shot');
    assert.ok(o.report.logs.some((l) => /Archer0: holds fire: marching to its new slot/.test(l)));
    await until(() => a.entity.position.z === 8.5, 3_000, 'on its slot');
    await until(() => f.shots.get(a)!.includes(z), 3_000, 'shot once there');
    z.isValid = false;
  } finally {
    await f.h.runner.stopAll();
  }
});

test('line (archers): a march holds fire for `march` seconds at most: an archer that cannot get there shoots on the way after it', async () => {
  const f = field();
  const a = f.add('Archer0', 0, -3, BOW);
  a.walkMs = 60_000; // never gets there
  await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), ['back=4', 'march=1']);
  try {
    await until(() => a.pathfinder.goal !== null, 2_000, 'walking to its slot');
    const t0 = Date.now();
    const z = f.spawn(zombie(0.5, 30));
    await until(() => f.shots.get(a)!.includes(z), 4_000, 'shot on the way once the march is over');
    assert.ok(Date.now() - t0 >= 700, 'not before the march ended');
    z.isValid = false;
  } finally {
    await f.h.runner.stopAll();
  }
});

test('line (horse archers): a rider told to a new slot rides on and shoots on the move: its walk is never cleared, the draw holds a free rein (docs/41)', async () => {
  const f = field();
  const a = f.add('Archer0', 0, -3, BOW);
  Object.assign(a, { vehicle: { id: 99, name: 'horse', type: 'animal', position: a.entity.position.clone(), isValid: true } });
  a.walkMs = 60_000; // still riding there for the whole test
  // At each draw: whether its walk was on and whether the body walked along its own heading (moveYaw: a free rein).
  const atDraw: Array<{ goal: boolean; rein: boolean }> = [];
  const activate = a.activateItem.bind(a);
  a.activateItem = (offHand = false) => {
    if (!offHand) atDraw.push({ goal: a.pathfinder.goal !== null, rein: (a.entity as { moveYaw?: number }).moveYaw !== undefined });
    activate(offHand);
  };
  const o = await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), ['back=4']);
  try {
    await until(() => a.pathfinder.goal !== null, 2_000, 'riding to its slot');
    const z = f.spawn(zombie(0.5, 30));
    await until(() => f.shots.get(a)!.filter((t) => t === z).length >= 2, 6_000, 'two shots on the move');
    assert.ok(!a.calls.includes('pathfinder.setGoal(null)'), 'its walk never cleared for a shot');
    // A shot is recorded when shoot() is called, its draw a moment later.
    await until(() => atDraw.length >= 2, 3_000, 'the second draw');
    assert.ok(atDraw.length >= 2 && atDraw.every((d) => d.goal && d.rein), `drawn riding on, with a free rein: ${JSON.stringify(atDraw)}`);
    assert.equal((a.entity as { moveYaw?: number }).moveYaw === undefined || a.usingHeldItem, true, 'the rein let go between draws');
    z.isValid = false;
    await until(() => o.report.logs.some((l) => /Archer0: holds fire: riding to its slot, nothing within 120 blocks/.test(l)), 2_000, 'riding on, nothing to shoot');
    assert.ok(a.pathfinder.goal !== null, 'still riding to its slot');
  } finally {
    await f.h.runner.stopAll();
  }
});

test('line (archers): range is from each archer, 120 by default: a foe 100 blocks away is shot, one 130 away is not; holding fire is logged once per reason (docs/35 F4)', async () => {
  const f = field();
  const a = f.add('Archer0', 0, -3, BOW);
  const o = await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), ['back=4']);
  try {
    await until(() => a.entity.position.z === 8.5, 3_000, 'on its slot');
    const far = f.spawn(zombie(0.5, 8.5 + 130));
    await tick(800);
    assert.equal(f.shots.get(a)!.length, 0, 'nothing shot at 130 blocks');
    const holds = o.report.logs.filter((l) => /holds fire/.test(l));
    assert.deepEqual(holds.slice(-1), ['Archer0: holds fire: on its slot, nothing within 120 blocks'], 'logged once, not every look');
    assert.equal(holds.filter((l) => /on its slot/.test(l)).length, 1);
    const near = f.spawn(zombie(0.5, 8.5 + 100));
    await until(() => f.shots.get(a)!.includes(near), 3_000, 'the foe 100 blocks away shot');
    assert.ok(!f.shots.get(a)!.includes(far));
    near.isValid = false;
    far.isValid = false;
  } finally {
    await f.h.runner.stopAll();
  }
});

test('line (archers): an archer passes over, for a while, a target a block stopped its shot at (docs/35 F4, found live)', async () => {
  const f = field();
  const a = f.add('Archer0', 0, -3, BOW);
  await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }), ['back=4']);
  try {
    await until(() => a.entity.position.z === 8.5, 3_000, 'on its slot');
    // The nearer one is in a cave below the line, say: every shot at it is refused for the blocks in the way.
    const hidden = f.spawn(zombie(0.5, 14));
    const open = f.spawn(zombie(0.5, 30));
    refuse = (t) => (t === hidden ? 'shoot(Archer0): no clear line of fire: stone is in the way at (0, 60, 14) (the high arc too)' : null);
    await until(() => f.shots.get(a)!.includes(open), 4_000, 'the one it can hit shot');
    const atHidden = () => f.shots.get(a)!.filter((t) => t === hidden).length;
    assert.equal(atHidden(), 1, 'the hidden one tried once');
    await tick(1_500);
    assert.equal(atHidden(), 1, 'and not again for a while');
    open.isValid = false;
    hidden.isValid = false;
  } finally {
    refuse = null;
    await f.h.runner.stopAll();
  }
});

// -- a click takes back the order's bots (docs/35 F5) -----------------------------------------------------------

const wallClick = (f: ReturnType<typeof field>, z = 0) =>
  f.snap({ yaw: 90, lookBlock: { x: -8, y: 63, z, name: 'stone' }, trigger: { kind: 'use', item: 'shield' } });

test('a click on the wall takes back the guards an attack reclaimed; the attack goes on with its archers; no stack holds an order twice (docs/35 F5)', async () => {
  const f = field();
  const guards = [f.add('Guard0', -3, 3, SHIELD), f.add('Guard1', -3, -2, SHIELD), f.add('Guard2', -3, 0, SHIELD)];
  f.add('Archer0', 2, -3, BOW);
  f.add('Archer1', 4, -3, BOW);
  // The guards alone (@bot filters): a line would take the idle archers too.
  const only = ['Guard0', 'Guard1', 'Guard2'];
  const wallTrigger = () => f.h.runner.trigger({ commander: PAUL, command: 'line', tokens: [], filters: only, snap: wallClick(f) });
  const started = await wallTrigger();
  assert.ok(started.ok && 'orderId' in started, started.text);
  const wall = f.h.runner.get(started.orderId!)!;
  try {
    await until(() => guards.every(shieldUp), 3_000, 'the wall up');
    // An attack on a zombie reclaims every bot: the guards from the wall, the idle archers.
    const z = f.spawn(zombie(30.5, 0.5));
    const attack = await f.start('attack', f.snap({ yaw: -90, lookEntity: { id: z.id, name: 'zombie', type: 'mob', position: { x: 30.5, y: 64, z: 0.5 } }, trigger: { kind: 'use', item: 'iron_sword' } }), ['seconds=600']);
    assert.equal(attack.memberNames().length, 5);
    assert.deepEqual(wall.memberNames(), []);
    // Before, this click was delivered to a wall with no bots (#205, #220).
    const r = await wallTrigger();
    assert.deepEqual(r, { ok: true, text: '', orderId: wall.id, delivered: true });
    assert.deepEqual(wall.memberNames().sort(), ['Guard0', 'Guard1', 'Guard2']);
    assert.deepEqual(attack.memberNames().sort(), ['Archer0', 'Archer1'], 'the attack keeps its archers');
    assert.equal(attack.status, 'running');
    for (const g of guards) assert.deepEqual(f.h.leases.stack(g.username).map((e) => e.orderId), [wall.id], `${g.username}: the wall once, the attack popped`);
    await until(() => guards.every(shieldUp), 3_000, 'the guards back in the wall, shields up');
    // Another click: nothing more to take back, nothing pushed twice.
    await wallTrigger();
    for (const g of guards) assert.equal(f.h.leases.stack(g.username).length, 1);
  } finally {
    await f.h.runner.stopAll();
  }
});

test('a click on the wall brings in an idle guard that was not in it (docs/35 F5)', async () => {
  const f = field();
  const guards = [f.add('Guard0', -3, 3, SHIELD), f.add('Guard1', -3, -2, SHIELD)];
  const wall = await f.start('line', wallClick(f));
  try {
    await until(() => guards.every(shieldUp), 3_000, 'the wall up');
    const late = f.add('Guard2', -3, 0, SHIELD); // a guard spawned (or respawned) since
    await f.click('line', wallClick(f));
    assert.ok(wall.hasMember('Guard2'));
    await until(() => [...guards, late].every(shieldUp), 3_000, 'three shields up');
    assert.equal(new Set([...guards, late].map((g) => xz(g).join())).size, 3, 'three slots');
  } finally {
    await f.h.runner.stopAll();
  }
});

test('a click whose args differ from the running order restarts it with them; the same args (defaults too) are delivered (docs/35 F5)', async () => {
  const f = field();
  f.add('Guard0', -3, 3, SHIELD);
  f.add('Guard1', -3, -2, SHIELD);
  const first = await f.start('line', wallClick(f), ['spacing=2']);
  try {
    // A rebind with spacing=1 (#221 → #223): restarted, with spacing 1.
    const r = await f.click('line', wallClick(f), ['spacing=1']);
    assert.ok(r.ok && 'restarted' in r && r.restarted, r.text);
    const second = f.h.runner.get((r as { orderId: string }).orderId)!;
    assert.notEqual(second.id, first.id);
    assert.equal(first.status, 'stopped');
    assert.equal(second.args.spacing, 1);
    // No args: spacing's default is 1, the same line: delivered.
    assert.deepEqual(await f.click('line', wallClick(f)), { ok: true, text: '', orderId: second.id, delivered: true });
    // Other @bot filters restart it too.
    const third = await f.click('line', wallClick(f));
    assert.ok('delivered' in third);
    const filtered = await f.h.runner.trigger({ commander: PAUL, command: 'line', tokens: [], filters: ['Guard0'], snap: wallClick(f) });
    assert.ok(filtered.ok && 'restarted' in filtered && filtered.restarted, filtered.text);
  } finally {
    await f.h.runner.stopAll();
  }
});

// -- attack: archers alone (once tir) -----------------------------------------------------------------------

test('attack from any item, archers alone: the creature nearest the block pointed at (within `near`) is shot; farther than that, the volley goes on the block', async () => {
  const f = field();
  // Side by side, not one behind the other: an archer in front of another, in its line of fire, would stop its arrows.
  const archers = [f.add('Archer0', 0, 0, BOW), f.add('Archer1', 2, 3, BOW)];
  // A stick's right-click at the block (10, 63, 0): the zombie 2.8 blocks from its top is the target.
  const z = f.spawn(zombie(12.5, 2.5));
  await f.click('attack', f.snap({ yaw: -90, lookBlock: { x: 10, y: 63, z: 0, name: 'stone' }, trigger: { kind: 'use', item: 'stick' } }));
  await until(() => archers.every((a) => f.shots.get(a)!.includes(z)), 2_000, 'both archers on the zombie');
  z.isValid = false;
  await until(() => !!f.ended('attack'), 2_000, 'the end');
  assert.match(f.ended('attack')!, /Cible abattue \(zombie\)/);

  // `/bots order attack` (no trigger) at the same block, a zombie 6 blocks from it: a volley on the block, not the zombie.
  f.h.notices.length = 0;
  const before = archers.map((a) => f.shots.get(a)!.length);
  const far = f.spawn(zombie(10.5, 6.5));
  await f.click('attack', f.snap({ yaw: -90, lookBlock: { x: 10, y: 63, z: 0, name: 'stone' } }), ['volley=2', 'spread=0', 'radius=4']);
  await until(() => !!f.ended('attack'), 3_000, 'the volley');
  assert.equal(f.ended('attack'), '[Bots] « attack » terminé : Volée tirée, point tenu : 4 flèches.');
  const volley = archers.flatMap((a, i) => f.shots.get(a)!.slice(before[i]!)) as Array<{ position?: Vec3 }>;
  assert.ok(!volley.includes(far as never), 'not at the zombie');
  assert.deepEqual(volley.map((s) => [s.position!.x, s.position!.y, s.position!.z]), Array(4).fill([10.5, 64, 0.5]));
});

test('attack (archers): an arrow in the ground sends a volley, `volley` arrows per archer spread over the disc, from where they stand', async () => {
  const f = field();
  // A file across the line of fire (one beside another, not one in front of another: it would stop its arrows).
  const archers = [0, -3, -6].map((z, i) => f.add(`Archer${i}`, 0, z, BOW));
  const hit = { x: 20.5, y: 64.05, z: 10.5 };
  const r = await f.click('attack', f.snap({ yaw: -60, trigger: { kind: 'arrow-hit', item: 'bow', hit: { position: hit } } }), ['volley=3', 'spread=3']);
  assert.ok(r.ok && 'started' in r && r.started, r.text);
  await until(() => !!f.ended('attack'), 5_000, 'the volley to end');
  assert.equal(f.ended('attack'), '[Bots] « attack » terminé : Volée tirée, point tenu : 9 flèches.');
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

test('attack with Infinity bows: the volley counts every arrow, and the archers keep theirs (docs/35 F3)', async () => {
  const f = field();
  const INFINITY: FakeItem[] = [{ name: 'bow', count: 1, enchants: [{ name: 'infinity', lvl: 1 }, { name: 'unbreaking', lvl: 3 }] }, { name: 'arrow', count: 64 }];
  const archers = [0, -3, -6].map((z, i) => f.add(`Archer${i}`, 0, z, INFINITY));
  const hit = { x: 20.5, y: 64.05, z: 10.5 };
  const r = await f.click('attack', f.snap({ yaw: -60, trigger: { kind: 'arrow-hit', item: 'bow', hit: { position: hit } } }), ['volley=3', 'spread=3']);
  assert.ok(r.ok, r.text);
  await until(() => !!f.ended('attack'), 5_000, 'the volley to end');
  assert.equal(f.ended('attack'), '[Bots] « attack » terminé : Volée tirée, point tenu : 9 flèches.');
  for (const a of archers) {
    assert.equal(a.releases.filter((x) => x.fired).length, 3, `${a.username}: 3 arrows fired`);
    assert.equal(a.inventory.items().find((i) => i.name === 'arrow')?.count, 64, `${a.username}: still 64 arrows`);
  }
});

test('attack (archers): a release looking at nothing waits for its hit; the creature hit is shot by every archer until it is dead', async () => {
  const f = field();
  const archers = [f.add('Archer0', 0, 0, BOW), f.add('Archer1', 2, 0, BOW)];
  const z = f.spawn(zombie(15, 15));
  const release = await f.click('attack', f.snap({ yaw: -45, trigger: { kind: 'arrow-release', item: 'bow' } }));
  assert.ok(release.ok && 'started' in release && release.started, release.text);
  await tick(150);
  assert.ok(archers.every((a) => f.shots.get(a)!.length === 0), 'nothing shot before the hit');
  const entity = { id: z.id, name: 'zombie', type: 'mob', position: { x: 15, y: 64, z: 15 } };
  const r = await f.click('attack', f.snap({ yaw: -45, trigger: { kind: 'arrow-hit', item: 'bow', hit: { position: { x: 15, y: 65, z: 15 }, entity } } }));
  assert.ok('delivered' in r && r.delivered, 'the hit reached the order its release started');
  await until(() => archers.every((a) => f.shots.get(a)!.includes(z)), 2_000, 'both archers on the zombie');
  z.isValid = false;
  await until(() => !!f.ended('attack'), 2_000, 'the end');
  assert.match(f.ended('attack')!, /« attack » terminé : Cible abattue \(zombie\) : \d+ flèches\./);
});

test('attack (archers): a release with no hit within 4 s fires at the block looked at; one of our own is refused', { timeout: 15_000 }, async () => {
  const f = field();
  const archer = f.add('Archer0', 0, 0, BOW);
  const mate = f.add('Guard0', 3, 3, SWORD);
  await f.click('attack', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 20, name: 'stone' }, trigger: { kind: 'arrow-release', item: 'bow' } }), ['volley=2', 'spread=0', 'radius=4']);
  await until(() => !!f.ended('attack'), 7_000, 'the volley after the wait');
  assert.equal(f.ended('attack'), '[Bots] « attack » terminé : Volée tirée, point tenu : 2 flèches.');
  assert.deepEqual((f.shots.get(archer)! as Array<{ position: Vec3 }>).map((s) => [s.position.x, s.position.y, s.position.z]), [[0.5, 64, 20.5], [0.5, 64, 20.5]]);

  f.h.notices.length = 0;
  await f.click('attack', f.snap({ yaw: 0, lookEntity: { id: (mate.entity as unknown as { id: number }).id, name: 'player', type: 'player', username: 'Guard0', position: { x: 3.5, y: 64, z: 3.5 } } }));
  await until(() => !!f.ended('attack'), 2_000, 'the refusal');
  assert.equal(f.ended('attack'), "[Bots] « attack » terminé : Guard0 est des nôtres : je n'attaque pas.");
  assert.equal(f.shots.get(archer)!.length, 2, 'nothing more shot');
});

test('attack takes the archers off a line without moving them; when it ends they go back to the line, each to its own slot', async () => {
  const f = field();
  const archers = [-2, 0, 2].map((x, i) => f.add(`Archer${i}`, x, -3, BOW));
  const line = await f.start('line', f.snap({ yaw: 0, lookBlock: { x: 0, y: 63, z: 12, name: 'grass_block' }, trigger: { kind: 'use', item: 'arrow' } }));
  await until(() => archers.every((a) => a.entity.position.z === 8.5), 3_000, 'the line formed');
  const slots = archers.map((a) => a.entity.position.clone());

  const r = await f.click('attack', f.snap({ yaw: 0, trigger: { kind: 'arrow-hit', item: 'bow', hit: { position: { x: 0.5, y: 64, z: 30.5 } } } }), ['volley=2']);
  assert.ok(r.ok, r.text);
  assert.match(r.text, /réquisitionné de #1/);
  assert.deepEqual(line.memberNames(), [], 'all three taken');
  // One archer is knocked out of place during the volley: the line puts it back on its own slot afterwards.
  archers[0]!.entity.position = new Vec3(6.5, 64, 2.5);
  await until(() => !!f.ended('attack'), 5_000, 'the volley to end');
  assert.equal(f.ended('attack'), '[Bots] « attack » terminé : Volée tirée, point tenu : 6 flèches.');
  await until(() => line.memberNames().length === 3, 2_000, 'the archers back on the line');
  await until(() => archers.every((a, i) => a.entity.position.equals(slots[i]!)), 2_000, 'each on its own slot again');
  assert.equal(line.status, 'running');
  await f.h.runner.stopAll();
});

test('attack (archers), approach: a foe beyond `approach` is closed in on before it is shot; 0 shoots from where they stand; a foe a block stops is passed over (docs/45)', async () => {
  const f = field();
  const a = f.add('Archer0', 0, 0, BOW);
  const far = f.spawn(zombie(0.5, 60.5));
  const o = await f.start('attack', f.snap({ yaw: 0, lookEntity: { id: far.id, name: 'zombie', type: 'hostile', position: far.position } }), ['approach=20', 'seconds=30']);
  try {
    await until(() => f.shots.get(a)!.includes(far), 5_000, 'shot once within 20');
    assert.ok(far.position.distanceTo(a.entity.position) <= 20.5, `it closed in: ${a.entity.position}`);
    assert.ok(a.entity.position.z > 30, 'it walked toward the foe');
    // The nearer foe of the group a block hides: tried once, then passed over for a while.
    const hidden = f.spawn(zombie(3.5, 58.5));
    refuse = (t) => (t === hidden ? 'shoot(Archer0): no clear line of fire: grass_block is in the way at (2, 63, 50)' : null);
    await tick(1_500);
    const atHidden = f.shots.get(a)!.filter((t) => t === hidden).length;
    assert.ok(atHidden <= 1, `the hidden one not tried again: ${atHidden}`);
    far.isValid = false;
    hidden.isValid = false;
    await until(() => !o.running, 5_000, 'the attack ends');
  } finally {
    refuse = null;
    await f.h.runner.stopAll();
  }
});

test('flank: the squad goes round the target to its right (seen from the squad when it stands still), then attacks its group from there (docs/45)', async () => {
  const f = field();
  const a = f.add('Sword0', 0, 0, SWORD);
  const b = f.add('Sword1', 2, 0, SWORD);
  const z = f.spawn(zombie(1.5, 30.5));
  const o = await f.start('flank', f.snap({ yaw: 0, lookEntity: { id: z.id, name: 'zombie', type: 'hostile', position: z.position } }), ['side=right', 'radius=12', 'march=10']);
  try {
    // Facing the zombie from the squad is facing south (+z): its right is west (-x), 12 blocks out.
    await until(() => [a, b].every((x) => x.entity.position.x < -6 && Math.abs(x.entity.position.z - 30.5) < 4), 5_000, 'round to its right');
    await until(() => [a, b].some((x) => x.pvp.target === z), 5_000, 'then the attack');
    z.isValid = false;
    await until(() => !o.running, 8_000, 'the flank ends with its attack');
    assert.match(o.report.result ?? '', /^Flanc droit pris/);
  } finally {
    await f.h.runner.stopAll();
  }
});

test('line reserve: the first melee bot waits behind the wall, counter-attacks a foe that reaches it, and comes back (docs/45)', async () => {
  const f = field();
  f.add('Guard0', 0, 0, SHIELD);
  const res = f.add('Sword0', 0, -2, SWORD);
  const flank = f.add('Sword1', 0, 2, SWORD);
  const o = await f.start('line', wallClick(f), ['reserve=1']);
  try {
    // The wall on x = -7.5 facing west; the reserve back + 3 = 7 blocks behind it, on x = -0.5; the other on a flank.
    await until(() => Math.abs(res.entity.position.x + 0.5) < 1 && Math.abs(flank.entity.position.x + 7.5) < 1, 5_000, 'reserve behind, the other on the flank');
    const z = f.spawn(zombie(-12, 0.5));
    await until(() => res.pvp.target === z, 5_000, 'the reserve counter-attacks');
    assert.notEqual(flank.pvp.target, z, 'the flank holds');
    z.isValid = false;
    await until(() => Math.abs(res.entity.position.x + 0.5) < 1 && res.pvp.target !== z, 8_000, 'back to its place');
    assert.ok(o.running);
    assert.ok(o.report.logs.some((l) => /reserve: Sword0 counter-attack at the wall/.test(l)));
  } finally {
    await f.h.runner.stopAll();
  }
});
