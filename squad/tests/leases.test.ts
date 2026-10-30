import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LeaseManager, type LeaseHolder, type LeftReason, type RoleRequest } from '../src/leases';

class Holder implements LeaseHolder {
  left: Array<[string, LeftReason, string | undefined]> = [];
  joined: Array<[string, string]> = [];
  constructor(readonly id: string) {}
  onLeft(bot: string, reason: LeftReason, by?: string): void {
    this.left.push([bot, reason, by]);
  }
  onJoined(bot: string, role: string): void {
    this.joined.push([bot, role]);
  }
}

const role = (name: string, take: 'free' | 'reclaim', match: string[] | null, min = 0, max = Infinity): RoleRequest => ({
  name,
  min,
  max,
  take,
  matches: (b) => match === null || match.includes(b),
});

test('idle bots are granted first; busy ones only to a reclaiming role', async () => {
  const L = new LeaseManager();
  const o1 = new Holder('1');
  L.register(o1);
  await L.apply('1', [{ bot: 'A', role: 'all' }]);
  const free = L.plan('2', [role('r', 'free', null)], ['A', 'B']);
  assert.ok(free.ok);
  assert.deepEqual(free.ok && free.grants.map((g) => g.bot), ['B']);
  const reclaim = L.plan('2', [role('r', 'reclaim', null)], ['A', 'B']);
  assert.deepEqual(reclaim.ok && reclaim.grants, [{ bot: 'B', role: 'r' }, { bot: 'A', role: 'r', from: '1' }]);
});

test('a plan below a role min changes nothing and says which role fell short', async () => {
  const L = new LeaseManager();
  const p = L.plan('1', [role('archers', 'free', ['A'], 2)], ['A', 'B']);
  assert.deepEqual(p, { ok: false, shortfall: [{ role: 'archers', got: 1, min: 2 }] });
  assert.ok(L.isIdle('A'));
});

test('a bot goes to the first role that takes it', () => {
  const L = new LeaseManager();
  const p = L.plan('1', [role('archers', 'free', ['A']), role('melee', 'free', null)], ['A', 'B']);
  assert.deepEqual(p.ok && p.grants, [{ bot: 'A', role: 'archers' }, { bot: 'B', role: 'melee' }]);
});

test('reclaim → the old order is told; release → the bot returns to it in its old role', async () => {
  const L = new LeaseManager();
  const o1 = new Holder('1');
  const o2 = new Holder('2');
  L.register(o1);
  L.register(o2);
  await L.apply('1', [{ bot: 'A', role: 'archers' }]);
  await L.apply('2', [{ bot: 'A', role: 'shooters', from: '1' }]);
  assert.deepEqual(o1.left, [['A', 'reclaimed', '2']]);
  assert.ok(L.holds('2', 'A'));
  assert.equal(L.release('2', 'A'), '1');
  assert.deepEqual(o1.joined, [['A', 'archers']]);
  assert.ok(L.holds('1', 'A'));
});

test('a bot whose old order ended goes idle on release', async () => {
  const L = new LeaseManager();
  const o1 = new Holder('1');
  const o2 = new Holder('2');
  L.register(o1);
  L.register(o2);
  await L.apply('1', [{ bot: 'A', role: 'x' }]);
  await L.apply('2', [{ bot: 'A', role: 'y', from: '1' }]);
  assert.deepEqual(L.endOrder('1'), []); // it no longer drove A
  assert.equal(L.release('2', 'A'), undefined);
  assert.ok(L.isIdle('A'));
});

test('the stack is capped: the bottom order will not get the bot back', async () => {
  const L = new LeaseManager(2);
  for (const id of ['1', '2', '3']) {
    L.register(new Holder(id));
    await L.apply(id, [{ bot: 'A', role: 'r' }]);
  }
  assert.deepEqual(L.stack('A').map((e) => e.orderId), ['2', '3']);
});

test('death clears the stack; an owner freeing a bot returns it below', async () => {
  const L = new LeaseManager();
  const o1 = new Holder('1');
  const o2 = new Holder('2');
  L.register(o1);
  L.register(o2);
  await L.apply('1', [{ bot: 'A', role: 'r' }]);
  await L.apply('2', [{ bot: 'A', role: 'r' }]);
  assert.equal(await L.drop('A', 'released', 'Paul'), '1');
  assert.deepEqual(o2.left, [['A', 'released', 'Paul']]);
  await L.drop('A', 'died');
  assert.deepEqual(o1.left.at(-1), ['A', 'died', undefined]);
  assert.ok(L.isIdle('A'));
});
