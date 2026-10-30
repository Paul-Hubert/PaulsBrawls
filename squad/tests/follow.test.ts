// `follow` keeps its goal between consecutive calls (docs/31 §5.3): the stock follow and defend call it once a
// second, and a new GoalFollow each time made every follower stop and re-plan.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';

import { follow, FOLLOW_KEEP_MS } from '../src/api/helpers';
import { FakeBot } from './fakes/fake-bot';
import { harness, PAUL, tick, until } from './fakes/harness';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

const target = () => ({ isValid: true, position: new Vec3(5, 64, 0) });
const sets = (b: FakeBot) => b.calls.filter((c) => c === 'pathfinder.setGoal').length;
const clears = (b: FakeBot) => b.calls.filter((c) => c === 'pathfinder.setGoal(null)').length;

test('follow: consecutive calls on the same entity and range keep the same goal object', async () => {
  const b = new FakeBot('Bob');
  const e = target();
  await follow(b as never, e as never, 3, { untilMs: 20 });
  const goal = b.pathfinder.goal;
  assert.ok(goal);
  await follow(b as never, e as never, 3, { untilMs: 20 });
  await follow(b as never, e as never, 3, { untilMs: 20 });
  assert.equal(b.pathfinder.goal, goal, 'the goal object is kept');
  assert.equal(sets(b), 1, 'setGoal ran once');
  assert.equal(clears(b), 0, 'the goal was never cleared between calls');

  // Another range is another goal.
  await follow(b as never, e as never, 5, { untilMs: 20 });
  assert.notEqual(b.pathfinder.goal, goal);
  assert.equal(sets(b), 2);
  await tick(FOLLOW_KEEP_MS + 100);
});

test('follow: with no call after it, the goal is cleared about 300 ms later', async () => {
  const b = new FakeBot('Bob');
  await follow(b as never, target() as never, 3, { untilMs: 20 });
  assert.ok(b.pathfinder.goal, 'still following right after the call');
  await tick(FOLLOW_KEEP_MS / 2);
  assert.ok(b.pathfinder.goal, 'still following before the delay');
  await until(() => b.pathfinder.goal === null, FOLLOW_KEEP_MS * 3, 'the goal to be cleared');
  assert.equal(clears(b), 1);
});

test("follow: a goal set by someone else meanwhile is never cleared by follow's timer", async () => {
  const b = new FakeBot('Bob');
  await follow(b as never, target() as never, 3, { untilMs: 20 });
  const other = { other: true };
  b.pathfinder.setGoal(other);
  await tick(FOLLOW_KEEP_MS + 150);
  assert.equal(b.pathfinder.goal, other);
  assert.equal(clears(b), 0);
});

test('follow: once the bot left the order, the deferred clear neither clears the goal nor throws into nowhere', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => void unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUnhandled);
  try {
    const h = harness();
    const bob = h.bot('Bob', [PAUL]);
    h.command(PAUL, 'fol', `export const manifest = { summary: 'f', duration: 'until-stopped' };
export default async function (squad) {
  await follow(squad.bots[0], { isValid: true, position: new Vec3(5, 64, 0) }, 3, { untilMs: 20 });
  await squad.untilStopped();
}`);
    h.command(PAUL, 'take', `export const manifest = { summary: 't', roles: { all: { min: 1, take: 'reclaim' } } };
export default async function (squad) { await squad.sleep(${FOLLOW_KEEP_MS * 2}); return 'ok'; }`);
    const f = await h.order(PAUL, 'fol');
    assert.ok(f.ok, f.text);
    await until(() => bob.calls.includes('pathfinder.setGoal'), 2000, 'follow to set its goal');
    const goal = bob.pathfinder.goal;
    await tick(40); // the follow call has returned: its clear is pending
    const t = await h.order(PAUL, 'take');
    assert.ok(t.ok, t.text);
    // The reclaim's abort sequence cleared the goal. Put the same object back, as if the new holder used it: the
    // old order's timer must not clear it, since the bot is no longer that order's.
    await until(() => bob.calls.includes('pathfinder.setGoal(null)'), 2000, 'the abort sequence');
    const before = clears(bob);
    bob.pathfinder.goal = goal;
    await tick(FOLLOW_KEEP_MS + 150);
    assert.equal(bob.pathfinder.goal, goal, 'the goal of the new holder is left alone');
    assert.equal(clears(bob), before);
    await h.runner.stopAll();
  } finally {
    process.off('unhandledRejection', onUnhandled);
    process.off('uncaughtException', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});
