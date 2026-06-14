// M5-1 — the EventRouter: normalize raw mineflayer/world signals into EdenEvent Envelopes through an
// EMITTER REGISTRY (S1: one row per emitter, never a branch), with hysteresis IN the emitter for the
// two edge-style events (health-low, night-falls) and a tick-30s clock. Proofs:
//   • per-event emitter unit tests on FakeBot (each raw signal → exactly one normalized Envelope);
//   • the hysteresis edge test — crossing the threshold fires once, staying past it does NOT re-fire,
//     re-crossing after recovery fires again (the subscriber never needs debounce logic, 04).

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { EventRouter, type EventRouterOptions } from '../src/villagers/events';
import type { Envelope, EdenEvent } from '../src/types/index';

/** Attach a router to a FakeBot and collect every normalized Envelope it emits (the routing sink). */
function harness(over: Partial<EventRouterOptions> = {}) {
  const bot = new FakeBot({ username: 'Firmin' });
  const journal = new MemoryJournal();
  const seen: Envelope[] = [];
  const router = new EventRouter({
    villager: 'Firmin',
    bot,
    journal,
    healthLowThreshold: 6,
    sink: (env) => seen.push(env),
    ...over,
  });
  router.attach();
  return { bot, journal, router, seen };
}

const types = (seen: Envelope[]): EdenEvent['type'][] => seen.map((e) => e.event.type);

test('M5-1 (emitter registry): hurt → a hurt Envelope addressed to the villager', () => {
  const { bot, seen } = harness();
  bot.emit('entityHurt', bot.entity, { damage: 4, byEntity: 'zombie:12' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.villager, 'Firmin');
  assert.equal(seen[0]!.event.type, 'hurt');
  assert.equal((seen[0]!.event as { damage: number }).damage, 4);
  assert.ok(typeof seen[0]!.at === 'number');
});

test('M5-1: player chat within earshot → player-chat; villager chat → villager-chat', () => {
  const { bot, seen } = harness();
  bot.emit('chat', 'Paul', 'salut Firmin', { isVillager: false });
  bot.emit('chat', 'Hervé', 'bonjour voisin', { isVillager: true });
  assert.deepEqual(types(seen), ['player-chat', 'villager-chat']);
  assert.equal((seen[0]!.event as { player: string }).player, 'Paul');
  assert.equal((seen[1]!.event as { villager: string }).villager, 'Hervé');
});

test('M5-1: entitySpotted/entityGone → entity-spotted/entity-lost', () => {
  const { bot, seen } = harness();
  bot.emit('entitySpotted', { name: 'zombie', id: 7, distance: 9, kind: 'hostile' });
  bot.emit('entityGone', { name: 'zombie', id: 7 });
  assert.deepEqual(types(seen), ['entity-spotted', 'entity-lost']);
  assert.equal((seen[0]!.event as { distance: number }).distance, 9);
});

test('M5-1: playerCollect → item-received; blockBreakProgressEnd → block-broken-nearby', () => {
  const { bot, seen } = harness();
  bot.emit('itemReceived', { name: 'oak_log', count: 3 });
  bot.emit('blockBrokenNearby', { name: 'stone' });
  assert.deepEqual(types(seen), ['item-received', 'block-broken-nearby']);
  assert.equal((seen[0]!.event as { count: number }).count, 3);
});

test('M5-1: death → a died Envelope', () => {
  const { bot, seen } = harness();
  bot.emit('death');
  assert.deepEqual(types(seen), ['died']);
});

test('M5-1 (tick-30s clock): the coarse clock emits tick-30s on each interval', () => {
  let now = 0;
  const { router, seen } = harness({ now: () => now });
  // The clock is driven by an injected tick (deterministic; no real timers in CI).
  router.tick(); // first tick → fires
  now += 30_000;
  router.tick();
  assert.deepEqual(types(seen), ['tick-30s', 'tick-30s']);
});

// ── Hysteresis IN the emitter (the load-bearing edge test) ───────────────────────────────────────
test('M5-1 (hysteresis): health-low fires once crossing below; does NOT re-fire while still low', () => {
  const { bot, seen } = harness({ healthLowThreshold: 6 });
  bot.setVitals({ health: 5 });
  bot.emit('health'); // cross below 6 → fire once
  bot.setVitals({ health: 4 });
  bot.emit('health'); // still below → NO re-fire (edge already taken)
  bot.setVitals({ health: 3 });
  bot.emit('health'); // still below → NO re-fire
  assert.deepEqual(types(seen), ['health-low']);
  assert.equal((seen[0]!.event as { health: number }).health, 5);
});

test('M5-1 (hysteresis): health-low re-arms after recovery, then fires again on re-cross', () => {
  const { bot, seen } = harness({ healthLowThreshold: 6 });
  bot.setVitals({ health: 5 });
  bot.emit('health'); // fire
  bot.setVitals({ health: 18 });
  bot.emit('health'); // recover above threshold → re-arm (no event)
  bot.setVitals({ health: 2 });
  bot.emit('health'); // re-cross → fire again
  assert.deepEqual(types(seen), ['health-low', 'health-low']);
});

test('M5-1 (hysteresis): starting already-low fires once, not repeatedly', () => {
  const { bot, seen } = harness({ healthLowThreshold: 6 });
  bot.setVitals({ health: 1 });
  bot.emit('health');
  bot.emit('health');
  bot.emit('health');
  assert.deepEqual(types(seen), ['health-low']);
});

test('M5-1 (hysteresis): night-falls fires once on day→night; new-day on night→day; no re-fire mid-phase', () => {
  const { bot, seen } = harness();
  // Mineflayer timeOfDay: 0..24000; night is ~13000..23000. The emitter edges on the phase transition.
  bot.setTime(1000); bot.emit('time'); // day, no edge yet (first observation is day)
  bot.setTime(14000); bot.emit('time'); // → night: night-falls
  bot.setTime(18000); bot.emit('time'); // still night: NO re-fire
  bot.setTime(500); bot.emit('time'); // → day: new-day
  bot.setTime(6000); bot.emit('time'); // still day: NO re-fire
  bot.setTime(15000); bot.emit('time'); // → night again: night-falls
  assert.deepEqual(types(seen), ['night-falls', 'new-day', 'night-falls']);
});

test('M5-1: run-finished surfaces a finished own run', () => {
  const { bot, seen } = harness();
  bot.emit('runFinished', { skill: 'collect-oak-logs', ok: true });
  assert.deepEqual(types(seen), ['run-finished']);
  assert.equal((seen[0]!.event as { skill: string }).skill, 'collect-oak-logs');
});

test('M5-1: detach removes every listener (no leaks across rebinds)', () => {
  const { bot, router, seen } = harness();
  router.detach();
  bot.emit('entityHurt', bot.entity, { damage: 1 });
  bot.emit('death');
  assert.equal(seen.length, 0, 'a detached router emits nothing');
});
