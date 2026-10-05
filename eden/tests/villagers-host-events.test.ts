// docs/22 B3.1 — the live signal adapter forwarded only health/death/hurt (+ the 30 s tick), so half of roles.json
// was inert: chat, entity-spotted, night-falls, new-day and inbox never fired. These FakeBot tests pin the new
// forwarding (bots/signals.ts) and drive it end-to-end through VillagerReactivity with the SHIPPED roles.json, the
// same assembly main.ts uses. Only a live run proves mineflayer emits the native events (chat/entity*/time) as
// modelled here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { SkillLibrary, AllGranted } from '../src/skills/library';
import { SkillEngine } from '../src/skills/engine';
import { seedStockSkills } from '../src/skills/exemplars/index';
import { attachReactivitySignals, CHAT_DISTANCE_UNKNOWN } from '../src/bots/signals';
import { SubscriptionStore } from '../src/villagers/subscriptions';
import { loadRoles, seedRoleDefaults, DEFAULT_ROLES_PATH } from '../src/villagers/role-defaults';
import { VillagerReactivity } from '../src/villagers/reactivity';
import type { WakeupRequest } from '../src/villagers/events';

holdEventLoopPerTest(); // reflex skill runs await unref'd engine timers (R73)

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: condition not met in time');
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

/** A FakeBot that also exposes mineflayer's `players` table (chat distance reads it). */
function botWithPlayers(username: string, players: Record<string, { x: number; y: number; z: number }> = {}): FakeBot {
  const bot = new FakeBot({ username });
  (bot as unknown as { players: Record<string, { entity: { position: object } }> }).players = Object.fromEntries(
    Object.entries(players).map(([n, p]) => [n, { entity: { position: p } }]),
  );
  return bot;
}

// ── 1. The adapter ────────────────────────────────────────────────────────────────────────────────

test('adapter: chat carries speaker kind + distance; the bot never hears itself', () => {
  const bot = botWithPlayers('Firmin', { paul: { x: 3, y: 64, z: 4 } });
  const { signals, detach } = attachReactivitySignals(bot, { isVillager: (n) => n === 'Alban' });
  const got: unknown[][] = [];
  signals.on('chat', (...a) => got.push(a));
  bot.emit('chat', 'paul', 'bonjour');
  bot.emit('chat', 'Alban', 'salut');
  bot.emit('chat', 'Firmin', 'moi-même');
  assert.deepEqual(got, [
    ['paul', 'bonjour', { isVillager: false, distance: 5 }],
    ['Alban', 'salut', { isVillager: true, distance: CHAT_DISTANCE_UNKNOWN }],
  ]);
  detach();
});

test('adapter: entity-spotted has hysteresis — enter ≤16, stay quiet until >24, then re-arm', () => {
  const bot = new FakeBot({ username: 'Firmin' });
  const { signals, detach } = attachReactivitySignals(bot);
  const events: string[] = [];
  signals.on('entitySpotted', (e) => events.push(`spot ${(e as { name: string }).name}`));
  signals.on('entityGone', (e) => events.push(`gone ${(e as { name: string }).name}`));
  const zombie = { id: 7, name: 'zombie', type: 'hostile', position: { x: 30, y: 64, z: 0 } };
  bot.emit('entitySpawn', zombie); // 30 away: not spotted
  zombie.position = { x: 10, y: 64, z: 0 };
  bot.emit('entityMoved', zombie); // enters → spotted
  zombie.position = { x: 15, y: 64, z: 0 };
  bot.emit('entityMoved', zombie); // still inside: no repeat
  zombie.position = { x: 20, y: 64, z: 0 };
  bot.emit('entityMoved', zombie); // in the hysteresis band: no flap
  zombie.position = { x: 12, y: 64, z: 0 };
  bot.emit('entityMoved', zombie); // back inside: still no repeat
  zombie.position = { x: 25, y: 64, z: 0 };
  bot.emit('entityMoved', zombie); // beyond 24 → gone
  zombie.position = { x: 5, y: 64, z: 0 };
  bot.emit('entityMoved', zombie); // re-armed → spotted again
  bot.emit('entityGone', zombie); // despawn → gone
  bot.emit('entitySpawn', { id: 9, name: 'item', type: 'object', position: { x: 1, y: 64, z: 0 } }); // never spotted
  assert.deepEqual(events, ['spot zombie', 'gone zombie', 'spot zombie', 'gone zombie']);
  detach();
});

test('adapter: native time is forwarded (the router owns the day/night edge)', () => {
  const bot = new FakeBot({ username: 'Firmin' });
  const { signals, detach } = attachReactivitySignals(bot);
  let n = 0;
  signals.on('time', () => n++);
  bot.emit('time');
  bot.emit('time');
  assert.equal(n, 2);
  detach();
  bot.emit('time');
  assert.equal(n, 2, 'detach removes the native listener');
});

// ── 2. End-to-end through VillagerReactivity + the shipped roles.json ─────────────────────────────

function host(roster: Array<{ name: string; role: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'eden-host-events-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  seedStockSkills(library);
  const bots = new Map<string, FakeBot>();
  const engine = new SkillEngine({
    library, journal, grants: new AllGranted(), resolveBot: (name) => bots.get(name),
    runDefaultTimeoutMs: 2_000, stallSeconds: 20, maxCallDepth: 8, autoQuarantineAfter: 5,
  });
  const store = new SubscriptionStore({ dataDir: dir, journal });
  const roles = loadRoles(DEFAULT_ROLES_PATH);
  for (const v of roster) seedRoleDefaults(store, v.name, v.role, roles);
  const wakeups: WakeupRequest[] = [];
  const reactivity = new VillagerReactivity({
    villagers: roster, store, engine, journal,
    wakeup: async (req) => { wakeups.push(req); },
    vitalsFor: (name) => ({ selfPos: [0, 64, 0], timeOfDay: 6000, health: 20, food: 20, runningSkills: engine.runningSkills(name) }),
  });
  return { journal, reactivity, wakeups, bots };
}

test('e2e: a guard deliberates when a hostile comes within 16 (roles.json entity-spotted)', async () => {
  const h = host([{ name: 'Alban', role: 'guard' }]);
  const bot = new FakeBot({ username: 'Alban' });
  h.bots.set('Alban', bot);
  h.reactivity.attach('Alban', bot);
  bot.emit('entitySpawn', { id: 3, name: 'zombie', type: 'hostile', position: { x: 8, y: 64, z: 0 } });
  await waitFor(() => h.wakeups.length === 1);
  assert.equal(h.wakeups[0]!.event.type, 'entity-spotted');
  assert.equal(h.wakeups[0]!.lane, 'combat', 'interrupt priority → combat lane');
  h.reactivity.detach();
});

test('e2e: a nearby player chat wakes the villager; a distant one does not (within 8)', async () => {
  const h = host([{ name: 'Firmin', role: 'farmer' }]);
  const bot = botWithPlayers('Firmin', { near: { x: 2, y: 64, z: 0 }, far: { x: 40, y: 64, z: 0 } });
  h.bots.set('Firmin', bot);
  h.reactivity.attach('Firmin', bot);
  bot.emit('chat', 'far', 'tu m’entends ?');
  await settle();
  assert.equal(h.wakeups.length, 0, 'a speaker 40 blocks away is not talking to me');
  bot.emit('chat', 'near', 'bonjour Firmin');
  await waitFor(() => h.wakeups.length === 1);
  assert.equal(h.wakeups[0]!.event.type, 'player-chat');
  h.reactivity.detach();
});

test('e2e: night falls → the zero-token go-home reflex runs; dawn → new-day (once each)', async () => {
  const h = host([{ name: 'Firmin', role: 'farmer' }]);
  const bot = new FakeBot({ username: 'Firmin' });
  h.bots.set('Firmin', bot);
  h.reactivity.attach('Firmin', bot);
  bot.setTime(6000);
  bot.emit('time'); // first observation: no edge
  bot.setTime(14000);
  bot.emit('time'); // day → night
  bot.emit('time'); // still night: nothing
  await waitFor(() => h.journal.query({ kinds: ['subscription.fired'] }).some((e) => (e.payload as { on: string }).on === 'night-falls'));
  await waitFor(() => h.journal.query({ kinds: ['skill.run'] }).some((e) => (e.payload as { skill: string }).skill === 'go-home'));
  bot.setTime(23500);
  bot.emit('time'); // night → day
  await waitFor(() => h.journal.query({ kinds: ['subscription.fired'] }).some((e) => (e.payload as { on: string }).on === 'new-day'));
  const nights = h.journal.query({ kinds: ['subscription.fired'] }).filter((e) => (e.payload as { on: string }).on === 'night-falls');
  assert.equal(nights.length, 1, 'the edge fired once');
  h.reactivity.detach();
});

test('e2e: an inbox signal wakes the villager on the inbox event; an offline villager is skipped', async () => {
  const h = host([{ name: 'Firmin', role: 'farmer' }, { name: 'Alban', role: 'guard' }]);
  const bot = new FakeBot({ username: 'Firmin' });
  h.bots.set('Firmin', bot);
  h.reactivity.attach('Firmin', bot);
  h.reactivity.signal('Firmin', 'inbox');
  h.reactivity.signal('Alban', 'inbox'); // not attached (offline): no throw, no wake-up
  await waitFor(() => h.wakeups.length === 1);
  assert.equal(h.wakeups[0]!.event.type, 'inbox');
  assert.equal(h.wakeups[0]!.villager, 'Firmin');
  h.reactivity.detach();
});

test('D-17: VillagerInbox reports each delivery to its hook, and peek() does not drain', async () => {
  const { VillagerInbox } = await import('../src/villagers/inbox');
  const seen: string[] = [];
  const inbox = new VillagerInbox('Firmin', new MemoryJournal(), (m) => seen.push(m.kind));
  inbox.deliver({ from: 'villager', kind: 'tell', payload: { text: 'salut' }, at: 1 });
  inbox.deliver({ from: 'god', kind: 'directive', payload: { goal: 'x' }, at: 2 });
  assert.deepEqual(seen, ['tell', 'directive'], 'main.ts filters: only a non-trade tell raises the inbox event');
  assert.equal(inbox.peek().length, 2);
  assert.equal(inbox.depth(), 2, 'peek leaves the messages for the rollout coordinator to drain');
});
