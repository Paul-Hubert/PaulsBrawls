// M5-3 (role defaults) — roles.json seeds each villager's default subscriptions at FIRST boot only
// (04: "Role defaults seed each villager at first boot. Defaults are config data (roles.json), not
// code."). Seeding is idempotent: a re-boot over an already-seeded store adds nothing (it would
// otherwise pile up duplicate reflexes every restart).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryJournal } from './fakes/memory-journal';
import { SubscriptionStore } from '../src/villagers/subscriptions';
import { loadRoles, resetRoleDefaults, seedRoleDefaults, upgradeRoleDefaults, DEFAULT_ROLES_PATH } from '../src/villagers/role-defaults';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'eden-roles-'));
}

test('M5-3 (roles.json): the shipped roles.json parses and defines an "everyone" block + named roles', () => {
  const roles = loadRoles(DEFAULT_ROLES_PATH);
  assert.ok(roles.everyone, 'there is an "everyone" default block');
  assert.ok(Array.isArray(roles.everyone), 'everyone is an array of subscription specs');
  assert.ok(roles.everyone.length > 0, 'everyone seeds at least one reflex');
  // Every shipped default carries an event type + a handler with a known kind (data, not code — P5).
  for (const list of Object.values(roles)) {
    for (const spec of list) {
      assert.ok(typeof spec.on === 'string' && spec.on.length > 0);
      assert.ok(spec.handler.kind === 'skill' || spec.handler.kind === 'deliberate');
    }
  }
});

test('M5-3 (seeding): a fresh villager gets everyone + its role defaults, all source:role-default', () => {
  const store = new SubscriptionStore({ dataDir: tmp(), journal: new MemoryJournal() });
  const roles = loadRoles(DEFAULT_ROLES_PATH);
  const n = seedRoleDefaults(store, 'Firmin', 'farmer', roles);
  const subs = store.list('Firmin');
  assert.equal(subs.length, n, 'returns how many it seeded');
  assert.ok(subs.length >= roles.everyone.length, 'at least the everyone defaults landed');
  for (const s of subs) assert.equal(s.source, 'role-default', 'all seeded subs are role-default');
  // A farmer-specific default (new-day) rode along beyond the everyone block, if the role defines one.
  if (roles['farmer']) {
    assert.ok(subs.length >= roles.everyone.length + roles['farmer'].length - overlap(roles), 'role block applied');
  }
});

test('M5-3 (idempotent first-boot): seeding a villager that already has subscriptions seeds NOTHING', () => {
  const store = new SubscriptionStore({ dataDir: tmp(), journal: new MemoryJournal() });
  const roles = loadRoles(DEFAULT_ROLES_PATH);
  const first = seedRoleDefaults(store, 'Firmin', 'farmer', roles);
  assert.ok(first > 0, 'first boot seeds');
  const second = seedRoleDefaults(store, 'Firmin', 'farmer', roles);
  assert.equal(second, 0, 're-boot seeds nothing (idempotent — first boot only, 04)');
  assert.equal(store.list('Firmin').length, first, 'no duplicate reflexes piled up');
});

test('M5-3 (unknown role): an unknown role still gets the everyone defaults', () => {
  const store = new SubscriptionStore({ dataDir: tmp(), journal: new MemoryJournal() });
  const roles = loadRoles(DEFAULT_ROLES_PATH);
  const n = seedRoleDefaults(store, 'Zed', 'wizard', roles);
  assert.equal(n, roles.everyone.length, 'unknown role → exactly the everyone block');
});

test('M5-3 (custom roles file): loadRoles reads an arbitrary path; seeding honors it', () => {
  const dir = tmp();
  const path = join(dir, 'roles.json');
  writeFileSync(path, JSON.stringify({
    everyone: [{ on: 'hurt', handler: { kind: 'skill', name: 'flee', args: {} } }],
    guard: [{ on: 'entity-spotted', filter: { entityKind: 'hostile', within: 16 }, handler: { kind: 'deliberate', hint: 'un ennemi approche', priority: 'interrupt' } }],
  }));
  const roles = loadRoles(path);
  const store = new SubscriptionStore({ dataDir: dir, journal: new MemoryJournal() });
  const n = seedRoleDefaults(store, 'Garde', 'guard', roles);
  assert.equal(n, 2, 'everyone(1) + guard(1)');
  const guardSub = store.list('Garde').find((s) => s.on === 'entity-spotted');
  assert.ok(guardSub, 'the guard hostile reflex was seeded');
  assert.equal(guardSub!.handler.kind, 'deliberate');
  assert.deepEqual(guardSub!.filter, { entityKind: 'hostile', within: 16 });
});

test('M5-3 (missing file): loadRoles of a non-existent path returns an empty everyone (no crash)', () => {
  const roles = loadRoles(join(tmp(), 'does-not-exist.json'));
  assert.deepEqual(roles, { everyone: [] });
});

/** How many of a role's specs duplicate an everyone spec (same on+handler kind+name) — they dedupe. */
function overlap(roles: ReturnType<typeof loadRoles>): number {
  const farmer = roles['farmer'] ?? [];
  let n = 0;
  for (const f of farmer) {
    if (roles.everyone.some((e) => e.on === f.on && e.handler.kind === f.handler.kind)) n++;
  }
  return n;
}

// Review of B3.6/bug #16: role defaults seed on FIRST boot only, so (a) an existing data dir never received the
// updated go-home args ($home.x/y/z) and (b) /villagers restart left a villager without any role default it had
// unsubscribed. upgradeRoleDefaults refreshes a still-present default in place; resetRoleDefaults reseeds them all.
test('upgradeRoleDefaults refreshes a still-present role default to the current roles.json (removals stay removed)', () => {
  const store = new SubscriptionStore({ dataDir: tmp(), journal: new MemoryJournal() });
  const roles = loadRoles(DEFAULT_ROLES_PATH);
  // An old data dir: go-home seeded without args; the hurt reflex was unsubscribed by the villager.
  store.add({ villager: 'Firmin', on: 'night-falls', handler: { kind: 'skill', name: 'go-home', args: {} }, source: 'role-default' });
  store.add({ villager: 'Firmin', on: 'tick-30s', handler: { kind: 'skill', name: 'look-around', args: {} }, source: 'self' });
  assert.equal(upgradeRoleDefaults(store, 'Firmin', 'farmer', roles), 1);
  const goHome = store.list('Firmin').find((s) => s.on === 'night-falls')!;
  assert.deepEqual((goHome.handler as { args: unknown }).args, { x: '$home.x', y: '$home.y', z: '$home.z' });
  assert.equal(store.list('Firmin').some((s) => s.on === 'hurt'), false, 'a removed default is not re-added');
  assert.equal(store.list('Firmin').some((s) => s.source === 'self'), true, 'self-authored untouched');
  assert.equal(upgradeRoleDefaults(store, 'Firmin', 'farmer', roles), 0, 'idempotent');
});

test('resetRoleDefaults gives a restarted villager its full current role defaults back', () => {
  const store = new SubscriptionStore({ dataDir: tmp(), journal: new MemoryJournal() });
  const roles = loadRoles(DEFAULT_ROLES_PATH);
  const n = seedRoleDefaults(store, 'Firmin', 'farmer', roles);
  const hurt = store.list('Firmin').find((s) => s.on === 'hurt')!;
  store.remove(hurt.id); // the villager unsubscribed it
  store.add({ villager: 'Firmin', on: 'tick-30s', handler: { kind: 'deliberate', hint: 'x' }, source: 'god' });
  assert.equal(resetRoleDefaults(store, 'Firmin', 'farmer', roles), n);
  const subs = store.list('Firmin');
  assert.equal(subs.filter((s) => s.source === 'role-default').length, n, 'all role defaults, once each');
  assert.ok(subs.some((s) => s.on === 'hurt'));
  assert.ok(subs.some((s) => s.source === 'god'), 'god/admin subscriptions are not the villager’s life — kept');
});
