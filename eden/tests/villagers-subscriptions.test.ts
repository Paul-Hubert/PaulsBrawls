// M5-2 — the SubscriptionStore (sole writer of subscription state, S2) + the FilterEvaluator (a CLAUSE
// REGISTRY: declarative Filter clauses AND-composed, no predicate code — P5) + ArgTemplate $event.*
// substitution + per-subscription cooldownMs + JSON persistence. Proofs:
//   • the filter-matching matrix — each clause in isolation (pass + fail) AND AND-composition;
//   • ArgTemplate $event.field substitution at fire time;
//   • persistence round-trip (a fresh store over the same dir sees the same subscriptions);
//   • cooldown suppresses a second fire inside the window, allows it after.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryJournal } from './fakes/memory-journal';
import {
  SubscriptionStore,
  FilterEvaluator,
  substituteArgs,
  type FilterContext,
} from '../src/villagers/subscriptions';
import type { Envelope, EdenEvent, Filter, Subscription } from '../src/types/index';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'eden-subs-'));
}

const env = (event: EdenEvent, over: Partial<Envelope> = {}): Envelope => ({ at: 1000, villager: 'Firmin', event, ...over });

// ── SubscriptionStore: sole writer, journaling, persistence ──────────────────────────────────────
test('M5-2 (sole writer): add/list/remove journal subscription.created / .removed', () => {
  const journal = new MemoryJournal();
  const store = new SubscriptionStore({ dataDir: tmp(), journal });
  const sub = store.add({
    villager: 'Firmin',
    on: 'hurt',
    handler: { kind: 'skill', name: 'flee-to-safety', args: {} },
    source: 'self',
  });
  assert.ok(sub.id, 'an id was assigned');
  assert.equal(sub.enabled, true, 'created enabled by default');
  assert.equal(store.list('Firmin').length, 1);
  const created = journal.query({ kinds: ['subscription.created'] });
  assert.equal(created.length, 1);
  assert.equal((created[0]!.payload as { handler: string }).handler, 'skill');

  const removed = store.remove(sub.id);
  assert.equal(removed, true);
  assert.equal(store.list('Firmin').length, 0);
  assert.equal(journal.query({ kinds: ['subscription.removed'] }).length, 1);
  assert.equal(store.remove(sub.id), false, 'removing again is a no-op (false)');
});

test('M5-2 (persistence round-trip): a fresh store over the same dir reloads subscriptions', () => {
  const dir = tmp();
  const j1 = new MemoryJournal();
  const s1 = new SubscriptionStore({ dataDir: dir, journal: j1 });
  s1.add({ villager: 'Firmin', on: 'player-chat', handler: { kind: 'deliberate', hint: 'un joueur te parle' }, source: 'role-default' });
  s1.add({ villager: 'Hervé', on: 'night-falls', handler: { kind: 'skill', name: 'go-home', args: {} }, source: 'self' });

  const j2 = new MemoryJournal();
  const s2 = new SubscriptionStore({ dataDir: dir, journal: j2 });
  assert.equal(s2.list('Firmin').length, 1);
  assert.equal(s2.list('Hervé').length, 1);
  assert.equal(s2.list('Firmin')[0]!.on, 'player-chat');
  // Reload does NOT re-journal created events (it's a load, not a new write).
  assert.equal(j2.query({ kinds: ['subscription.created'] }).length, 0);
});

test('M5-2 (cooldown): markFired then inCooldown suppresses inside the window, clears after', () => {
  let now = 0;
  const store = new SubscriptionStore({ dataDir: tmp(), journal: new MemoryJournal(), now: () => now });
  const sub = store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'skill', name: 'flee', args: {} }, source: 'self', cooldownMs: 5000 });
  assert.equal(store.inCooldown(sub.id), false, 'fresh sub is not cooling');
  store.markFired(sub.id);
  assert.equal(store.inCooldown(sub.id), true, 'just fired → cooling');
  now += 4999;
  assert.equal(store.inCooldown(sub.id), true, 'still inside the window');
  now += 2;
  assert.equal(store.inCooldown(sub.id), false, 'past the window → eligible again');
});

test('M5-2: a sub with no cooldownMs is never in cooldown', () => {
  const store = new SubscriptionStore({ dataDir: tmp(), journal: new MemoryJournal() });
  const sub = store.add({ villager: 'Firmin', on: 'tick-30s', handler: { kind: 'deliberate', hint: 'patrouille' }, source: 'self' });
  store.markFired(sub.id);
  assert.equal(store.inCooldown(sub.id), false);
});

test('M5-2: setEnabled toggles a sub without removing it (the quarantine auto-disable path, 04)', () => {
  const store = new SubscriptionStore({ dataDir: tmp(), journal: new MemoryJournal() });
  const sub = store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'skill', name: 'flee', args: {} }, source: 'self' });
  store.setEnabled(sub.id, false);
  assert.equal(store.get(sub.id)?.enabled, false);
  store.setEnabled(sub.id, true);
  assert.equal(store.get(sub.id)?.enabled, true);
});

// ── FilterEvaluator: the clause registry (P5) — each clause in isolation + AND-composition ─────────
const CTX = (over: Partial<FilterContext> = {}): FilterContext => ({
  selfPos: [0, 64, 0],
  timeOfDay: 6000, // day
  health: 20,
  food: 20,
  runningSkills: [],
  ...over,
});

function passes(filter: Filter | undefined, e: Envelope, ctx: FilterContext): boolean {
  return new FilterEvaluator().matches(filter, e, ctx);
}

test('M5-2 (filter): undefined filter always matches (no clauses = always on)', () => {
  assert.equal(passes(undefined, env({ type: 'tick-30s' }), CTX()), true);
  assert.equal(passes({}, env({ type: 'tick-30s' }), CTX()), true);
});

test('M5-2 (clause within): distance from self gates entity/block events', () => {
  const e = env({ type: 'entity-spotted', entity: 'zombie:7', distance: 5 });
  assert.equal(passes({ within: 8 }, e, CTX()), true, 'inside radius');
  assert.equal(passes({ within: 4 }, e, CTX()), false, 'outside radius');
});

test('M5-2 (clause entityKind): classifies the entity name (hostile/animal/player/villager)', () => {
  const zombie = env({ type: 'entity-spotted', entity: 'zombie:7', distance: 2 });
  const cow = env({ type: 'entity-spotted', entity: 'cow:3', distance: 2 });
  assert.equal(passes({ entityKind: 'hostile' }, zombie, CTX()), true);
  assert.equal(passes({ entityKind: 'hostile' }, cow, CTX()), false);
  assert.equal(passes({ entityKind: 'animal' }, cow, CTX()), true);
});

test('M5-2 (clause nameMatches): substring on entity/item/block/text', () => {
  assert.equal(passes({ nameMatches: 'log' }, env({ type: 'item-received', item: 'oak_log', count: 1 }), CTX()), true);
  assert.equal(passes({ nameMatches: 'diamond' }, env({ type: 'item-received', item: 'oak_log', count: 1 }), CTX()), false);
  assert.equal(passes({ nameMatches: 'trade' }, env({ type: 'player-chat', player: 'Paul', text: 'veux-tu trade?' }), CTX()), true);
});

test('M5-2 (clause timeOfDay): day/night/dawn/dusk phase gate', () => {
  const e = env({ type: 'tick-30s' });
  assert.equal(passes({ timeOfDay: 'day' }, e, CTX({ timeOfDay: 6000 })), true);
  assert.equal(passes({ timeOfDay: 'day' }, e, CTX({ timeOfDay: 18000 })), false);
  assert.equal(passes({ timeOfDay: 'night' }, e, CTX({ timeOfDay: 18000 })), true);
});

test('M5-2 (clause healthBelow / foodBelow): vitals gates', () => {
  const e = env({ type: 'tick-30s' });
  assert.equal(passes({ healthBelow: 10 }, e, CTX({ health: 8 })), true);
  assert.equal(passes({ healthBelow: 10 }, e, CTX({ health: 15 })), false);
  assert.equal(passes({ foodBelow: 6 }, e, CTX({ food: 3 })), true);
  assert.equal(passes({ foodBelow: 6 }, e, CTX({ food: 12 })), false);
});

test('M5-2 (clause notWhileRunning): suppress while a named skill runs (e.g. don’t flee-interrupt flee)', () => {
  const e = env({ type: 'hurt', damage: 3 });
  assert.equal(passes({ notWhileRunning: ['flee-to-safety'] }, e, CTX({ runningSkills: ['flee-to-safety'] })), false);
  assert.equal(passes({ notWhileRunning: ['flee-to-safety'] }, e, CTX({ runningSkills: ['mine-loop'] })), true);
  assert.equal(passes({ notWhileRunning: ['flee-to-safety'] }, e, CTX({ runningSkills: [] })), true);
});

test('M5-2 (AND-composition): all clauses must pass; any failing clause fails the whole filter', () => {
  const e = env({ type: 'entity-spotted', entity: 'zombie:7', distance: 5 });
  const ctx = CTX({ timeOfDay: 18000, health: 20 });
  // hostile + within 8 + at night → all pass
  assert.equal(passes({ entityKind: 'hostile', within: 8, timeOfDay: 'night' }, e, ctx), true);
  // same but within 4 fails → whole filter fails
  assert.equal(passes({ entityKind: 'hostile', within: 4, timeOfDay: 'night' }, e, ctx), false);
  // same but require day fails → whole filter fails
  assert.equal(passes({ entityKind: 'hostile', within: 8, timeOfDay: 'day' }, e, ctx), false);
});

// ── ArgTemplate $event.* substitution ─────────────────────────────────────────────────────────────
test('M5-2 (ArgTemplate): $event.field paths are substituted at fire time', () => {
  const e = env({ type: 'entity-spotted', entity: 'zombie:7', distance: 5 });
  const args = substituteArgs({ target: '$event.entity', range: 3, note: 'fixe' }, e);
  assert.deepEqual(args, { target: 'zombie:7', range: 3, note: 'fixe' });
});

test('M5-2 (ArgTemplate): a literal args object passes through unchanged', () => {
  const e = env({ type: 'hurt', damage: 4, byEntity: 'zombie:7' });
  const args = substituteArgs({ to: 'home', n: 2 }, e);
  assert.deepEqual(args, { to: 'home', n: 2 });
});

// B3.6: an unresolved path now DROPS the key (it used to be `{ x: undefined }`). An undefined value fails the
// callee's arg type check ("x: expected number, got undefined"); an absent optional arg takes the skill's default.
test('M5-2 (ArgTemplate): an unresolved $event.* path drops the key (never throws)', () => {
  const e = env({ type: 'tick-30s' });
  const args = substituteArgs({ x: '$event.entity', keep: 1 }, e);
  assert.deepEqual(args, { keep: 1 });
});

test('B3.6 (ArgTemplate): $home.* resolves from the host scope; a missing home drops the keys', () => {
  const e = env({ type: 'night-falls' });
  const tpl = { x: '$home.x', y: '$home.y', z: '$home.z', range: 2 };
  assert.deepEqual(substituteArgs(tpl, e, { home: { x: 10, y: 64, z: -3 } }), { x: 10, y: 64, z: -3, range: 2 });
  assert.deepEqual(substituteArgs(tpl, e, {}), { range: 2 }, 'a root the scope does not provide is unresolved — dropped');
  assert.deepEqual(substituteArgs(tpl, e, { home: undefined }), { range: 2 }, 'a known-but-empty home drops the coords');
});

test('M5-2 (ArgTemplate): $event.type and nested numeric fields resolve', () => {
  const e = env({ type: 'item-received', item: 'oak_log', count: 7 });
  const args = substituteArgs({ kind: '$event.type', item: '$event.item', amount: '$event.count' }, e);
  assert.deepEqual(args, { kind: 'item-received', item: 'oak_log', amount: 7 });
});

// Type sanity: the store returns full Subscription objects.
test('M5-2: list returns full Subscription objects (id/villager/on/handler/source/enabled)', () => {
  const store = new SubscriptionStore({ dataDir: tmp(), journal: new MemoryJournal() });
  store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'skill', name: 'flee', args: {} }, source: 'self' });
  const subs: Subscription[] = store.list('Firmin');
  const s = subs[0]!;
  assert.equal(s.villager, 'Firmin');
  assert.equal(s.on, 'hurt');
  assert.equal(s.source, 'self');
});
