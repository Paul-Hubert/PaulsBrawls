// Two armies (2026-10-31, `/bots raid`): friends are only the order's own team now, so an army fights another
// player's bots; and the stock `raid`, which marches an army in formation on a point and fights what it meets.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';

import { GoalFollowOffset } from '../src/bots/follow-goal';
import type { Player } from '../src/roster';
import type { Order } from '../src/orders/order';
import { loadStock } from '../src/stock';
import { EMPTY_SNAPSHOT } from '../src/types';
import type { FakeBot } from './fakes/fake-bot';
import { ALICE, harness, PAUL, tick, until } from './fakes/harness';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

const { goals } = pathfinderPkg;
const stock = await loadStock();
const RAIDER: Player = { uuid: 'uuid-envahisseur', name: 'Envahisseur' };
const BOB: Player = { uuid: 'uuid-bob', name: 'Bob' };

// -- friends --------------------------------------------------------------------------------------------------

test("friends: the commander, the order's co-owners and the bots sharing an owner with them; not another owner's bots", async () => {
  const h = harness({ stock });
  h.bot('Guard1', [PAUL, BOB], [{ name: 'iron_sword', count: 1 }]);
  h.bot('Guard2', [PAUL]); // busy elsewhere, but Paul's: a friend
  h.bot('BobBot', [BOB]); // shares Bob with Guard1: the server spares it too
  h.bot('AliceBot', [ALICE]);
  const r = await h.order(PAUL, 'defend', [], { filters: ['Guard1'] });
  assert.ok(r.ok, r.text);
  const o = h.runner.get(r.orderId) as Order;
  assert.deepEqual([...o.friends].sort(), ['Bob', 'BobBot', 'Guard1', 'Guard2', 'Paul']);

  // A new bot of Paul's, spawned mid-order (a spawn emits 'state'), joins the team.
  h.bot('Guard3', [PAUL]);
  h.runner.emit('state');
  assert.ok(o.friends.has('Guard3'));
  await h.runner.stopAll();
});

test('friends: a bot given away leaves the team at the next roster change', async () => {
  const h = harness({ stock });
  h.bot('Guard1', [PAUL], [{ name: 'iron_sword', count: 1 }]);
  h.bot('Turncoat', [PAUL]);
  const r = await h.order(PAUL, 'defend', [], { filters: ['Guard1'] });
  assert.ok(r.ok, r.text);
  const o = h.runner.get(r.orderId) as Order;
  assert.ok(o.friends.has('Turncoat'));
  h.roster.addOwners('Turncoat', [ALICE]);
  h.roster.removeOwners('Turncoat', [PAUL]);
  h.runner.emit('state');
  assert.ok(!o.friends.has('Turncoat'));
  assert.ok(!o.friends.has('Alice'));
  await h.runner.stopAll();
});

test("defend: a guard attacks another owner's bot near the commander, never one of its own team", async () => {
  const h = harness({ stock });
  const g = h.bot('Guard1', [PAUL], [{ name: 'iron_sword', count: 1 }]);
  h.bot('Mate', [PAUL]);
  h.bot('Enemy', [ALICE]);
  const commander = { id: 1, type: 'player', username: 'Paul', position: new Vec3(0, 64, 0), isValid: true };
  const mate = { id: 2, type: 'player', username: 'Mate', position: new Vec3(2, 64, 0), isValid: true };
  const enemy = { id: 3, type: 'player', username: 'Enemy', position: new Vec3(5, 64, 0), isValid: true };
  g.entities = { 1: commander, 2: mate, 3: enemy };
  g.players = { Paul: { entity: commander }, Mate: { entity: mate }, Enemy: { entity: enemy } };
  const r = await h.order(PAUL, 'defend', [], { filters: ['Guard1'] });
  assert.ok(r.ok, r.text);
  await until(() => g.pvp.target === enemy, 2_000, 'the guard on the enemy bot');
  enemy.isValid = false;
  await tick(400);
  assert.notEqual(g.pvp.target, mate, 'its own team is left alone');
  await h.runner.stopAll();
});

// -- the stock raid ---------------------------------------------------------------------------------------------

/** Raiders owned by Envahisseur in a column at x = 0, and Paul's army at `at`; every bot sees every entity. */
function battlefield(guards: number, archers: number) {
  const h = harness({ stock });
  const world: Record<string, { id: number; type: string; username: string; position: Vec3; isValid: boolean }> = {};
  const players: Record<string, { entity: unknown }> = {};
  let id = 10;
  const raiders: FakeBot[] = [];
  const place = (b: FakeBot, x: number, z: number) => {
    b.entity.position = new Vec3(x, 64, z);
    const e = Object.assign(b.entity, { id: id++ });
    world[e.id] = e;
    players[b.username] = { entity: e };
    b.entities = world;
    b.players = players;
  };
  for (let i = 0; i < guards; i++) {
    const b = h.bot(`EnnGarde0${i + 1}`, [RAIDER], [{ name: 'iron_sword', count: 1 }]);
    place(b, 0, i);
    raiders.push(b);
  }
  for (let i = 0; i < archers; i++) {
    const b = h.bot(`EnnArcher0${i + 1}`, [RAIDER], [{ name: 'bow', count: 1 }, { name: 'arrow', count: 64 }]);
    place(b, -1, i);
    raiders.push(b);
  }
  /** A player of Paul's side (Paul himself, or one of his bots) standing at x, z. */
  const foe = (username: string, x: number, z = 0) => {
    const e = { id: id++, type: 'player', username, position: new Vec3(x, 64, z), isValid: true };
    world[e.id] = e;
    players[username] = { entity: e };
    return e;
  };
  const start = async (tokens: string[]): Promise<Order> => {
    const r = await h.runner.start({ commander: RAIDER, command: 'raid', tokens, snap: EMPTY_SNAPSHOT });
    assert.ok(r.ok, r.text);
    return h.runner.get(r.orderId) as Order;
  };
  return { h, raiders, guards: raiders.slice(0, guards), archers: raiders.slice(guards), foe, start };
}

test('raid: the leader steps toward the point; the others hold distinct slots behind it, archers behind the melee', async () => {
  const s = battlefield(4, 3);
  s.h.bot('PaulGuard', [PAUL]);
  s.foe('Paul', 100); // far away: out of the engage radius
  await s.start(['x=100', 'y=64', 'z=0', 'target=Paul']);
  const [lead, ...rest] = s.raiders;
  await until(() => lead!.pathfinder.goal instanceof goals.GoalNearXZ && rest.every((b) => b.pathfinder.goal instanceof GoalFollowOffset), 2_000, 'the march formation');
  const step = lead!.pathfinder.goal as { x: number; z: number };
  assert.ok(Math.abs(step.x - 12) < 0.01 && Math.abs(step.z) < 0.01, `a 12-block step toward the point: ${JSON.stringify(step)}`);
  const offsets = rest.map((b) => (b.pathfinder.goal as GoalFollowOffset).offset);
  assert.equal(new Set(offsets.map((o) => `${o.x},${o.z}`)).size, offsets.length, `distinct slots: ${JSON.stringify(offsets)}`);
  for (const b of rest) assert.equal((b.pathfinder.goal as GoalFollowOffset).entity, lead!.entity as never, 'around the leader');
  const melee = offsets.slice(0, 3);
  const archers = offsets.slice(3);
  assert.ok(melee.every((o) => o.x < 0), 'the melee behind the leader (it marches toward +x)');
  assert.ok(Math.max(...archers.map((o) => o.x)) < Math.min(...melee.map((o) => o.x)), 'the archers behind the melee');
  assert.equal(lead!.pvp.target, null, 'no fight with nobody in reach');
  await s.h.runner.stopAll();
});

test('raid: it fights the other army on the way (two guards per enemy at most, archers shoot), never itself', async () => {
  const s = battlefield(4, 2);
  const shots: unknown[] = [];
  for (const a of s.archers) {
    a.hawkEye.oneShot = ((t: unknown) => {
      shots.push(t);
      const left = a.inventory.items().find((i) => i.name === 'arrow')!.count - 1;
      setTimeout(() => a.setItems([{ name: 'bow', count: 1 }, { name: 'arrow', count: left }]), 30);
    }) as never;
  }
  s.foe('Paul', 100);
  const e1 = s.foe('PaulGuard1', 10, 3);
  const e2 = s.foe('PaulGuard2', 10, -3);
  await s.start(['x=100', 'y=64', 'z=0', 'target=Paul', 'radius=24']);
  const on = (e: unknown) => s.guards.filter((g) => g.pvp.target === e).length;
  await until(() => on(e1) === 2 && on(e2) === 2, 2_000, 'two guards on each enemy bot');
  await until(() => shots.length >= 2, 3_000, 'the archers shooting');
  const raiderEntities = new Set(s.raiders.map((b) => b.entity));
  assert.ok(shots.every((t) => !raiderEntities.has(t as never)), 'no arrow at a raider');
  assert.ok(s.guards.every((g) => !raiderEntities.has(g.pvp.target as never)));
  await s.h.runner.stopAll();
});

test('raid: at the point it hunts the nearest enemy, then ends after `quiet` seconds without one', async () => {
  const s = battlefield(2, 0);
  await s.start(['x=0', 'y=64', 'z=0', 'quiet=1']);
  const lead = s.guards[0]!;
  const far = s.foe('Straggler', 50, 0); // beyond the engage radius, within the hunt
  await until(() => {
    const g = lead.pathfinder.goal as { x?: number } | null;
    return g instanceof goals.GoalNearXZ && (g.x ?? 0) > 5;
  }, 2_000, 'the leader marching on the enemy it found');
  far.isValid = false; // gone
  lead.entity.position = new Vec3(50, 64, 0); // the leader got there
  const order = s.h.runner.get(s.h.runner.running()[0]!.id) as Order;
  await until(() => order.ended, 4_000, 'the raid ending once nobody is left');
  assert.equal(order.report.status, 'done');
  assert.match(String(order.report.result), /Raid terminé/);
});
