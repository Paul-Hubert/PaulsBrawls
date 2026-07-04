// HIGH-3 — the reactivity SIGNAL ADAPTER (bots/signals.ts) now bridges the remaining native mineflayer
// sources onto the synthetic bus the EventRouter consumes (previously only health/death/hurt fired; the
// rows for time/chat/itemReceived/entitySpotted were inert). These are ADAPTER-LEVEL tests: they emit the
// NATIVE bot event (or seed bot.entities + run the poll) and assert the EXACT synthetic signal shape the
// EventRouter rows expect (events.ts) lands on the bus — the part the existing host/router tests skip by
// emitting raw signals directly. The storm-proofing (entity dedupe, chat self/own filtering, time
// throttle) is pinned here because it is the load-bearing safety of the bridge (R36 one-incident).

import test from 'node:test';
import assert from 'node:assert/strict';

import { RecordingBot } from './fakes/recording-bot';
import { attachReactivitySignals } from '../src/bots/signals';

/** Collect every signal of `name` emitted on the adapter bus, with its raw args (so shape is assertable). */
function collect(signals: { on(e: string, l: (...a: unknown[]) => void): unknown }, name: string): unknown[][] {
  const out: unknown[][] = [];
  signals.on(name, (...args: unknown[]) => out.push(args));
  return out;
}

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── time is NOT forwarded off the bot (it's sampled on the router's 30 s clock — see events.ts tick) ──

test('adapter: native `time` is NOT forwarded (a 20 Hz native stream never reaches the bus)', () => {
  const bot = new RecordingBot({ username: 'Firmin' });
  const { signals } = attachReactivitySignals(bot);
  const times = collect(signals, 'time');
  for (let i = 0; i < 50; i++) bot.emit('time'); // mineflayer fires `time` every tick — a burst
  assert.equal(times.length, 0, 'the adapter ignores native time; the router samples the phase on tick()');
});

// ── chat → player-chat vs villager-chat (the self/peer loop guard) ────────────────────────────────

test('adapter: a PLAYER chat forwards chat(from, text, { isVillager:false })', () => {
  const bot = new RecordingBot({ username: 'Firmin' });
  const { signals } = attachReactivitySignals(bot, { botNames: new Set(['Firmin', 'Hervé', 'Dieu']) });
  const chats = collect(signals, 'chat');
  bot.emit('chat', 'Paul', 'salut Firmin');
  assert.equal(chats.length, 1);
  assert.deepEqual(chats[0], ['Paul', 'salut Firmin', { isVillager: false }]);
});

test('adapter: a peer VILLAGER/avatar chat is tagged isVillager:true (router → villager-chat, not player)', () => {
  const bot = new RecordingBot({ username: 'Firmin' });
  const { signals } = attachReactivitySignals(bot, { botNames: new Set(['Firmin', 'Hervé', 'Dieu']) });
  const chats = collect(signals, 'chat');
  bot.emit('chat', 'Hervé', 'bonjour voisin'); // a fellow villager
  bot.emit('chat', 'Dieu', 'écoutez bien'); // the avatar
  assert.equal(chats.length, 2);
  assert.equal((chats[0]![2] as { isVillager: boolean }).isVillager, true, 'a villager speaker is tagged');
  assert.equal((chats[1]![2] as { isVillager: boolean }).isVillager, true, 'the avatar is bot speech too');
});

test('adapter: a villager NEVER reacts to its OWN chat line (dropped before the bus — no self-loop)', () => {
  const bot = new RecordingBot({ username: 'Firmin' });
  const { signals } = attachReactivitySignals(bot, { botNames: new Set(['Firmin']) });
  const chats = collect(signals, 'chat');
  bot.emit('chat', 'Firmin', 'je réponds'); // the bot hearing its own message echoed back
  assert.equal(chats.length, 0, 'own speech is dropped (else a reply would re-trigger forever)');
});

test('adapter: native `whisper` is bridged like chat', () => {
  const bot = new RecordingBot({ username: 'Firmin' });
  const { signals } = attachReactivitySignals(bot, { botNames: new Set(['Firmin']) });
  const chats = collect(signals, 'chat');
  bot.emit('whisper', 'Paul', 'psst, échange?');
  assert.equal(chats.length, 1);
  assert.equal((chats[0]![2] as { isVillager: boolean }).isVillager, false);
});

// ── playerCollect → item-received (only OUR pickups) ──────────────────────────────────────────────

test('adapter: playerCollect by THIS bot forwards itemReceived({ name, count })', () => {
  const bot = new RecordingBot({ username: 'Firmin' });
  const { signals } = attachReactivitySignals(bot);
  const items = collect(signals, 'itemReceived');
  bot.emit('playerCollect', { username: 'Firmin' }, { name: 'wheat', count: 3 });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]![0], { name: 'wheat', count: 3 });
});

test('adapter: a DIFFERENT player collecting does NOT forward itemReceived (not our pickup)', () => {
  const bot = new RecordingBot({ username: 'Firmin' });
  const { signals } = attachReactivitySignals(bot);
  const items = collect(signals, 'itemReceived');
  bot.emit('playerCollect', { username: 'Paul' }, { name: 'wheat', count: 1 });
  assert.equal(items.length, 0, 'mineflayer fires playerCollect for every nearby pickup — filter to self');
});

// ── entity poll → entitySpotted / entityGone, deduped, NO storm ───────────────────────────────────

test('adapter (poll): a NEW entity entering range fires entitySpotted ONCE; staying does NOT re-fire', async () => {
  const bot = new RecordingBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  const { signals, detach } = attachReactivitySignals(bot, { entityPollMs: 10 });
  const spotted = collect(signals, 'entitySpotted');
  bot.setEntities({ 7: { name: 'zombie', position: { x: 3, y: 64, z: 0 } } });
  await tick(40); // several poll cycles
  assert.equal(spotted.length, 1, 'a stay does NOT storm — one spotted per entity (deduped by id)');
  assert.equal((spotted[0]![0] as { name: string }).name, 'zombie');
  assert.equal((spotted[0]![0] as { id: number }).id, 7, 'the numeric entities key is the dedupe id');
  assert.ok((spotted[0]![0] as { distance: number }).distance > 0, 'carries the self-relative distance');
  detach();
});

test('adapter (poll): an entity LEAVING range fires entityGone once, and a RE-ENTRY re-fires spotted', async () => {
  const bot = new RecordingBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  const { signals, detach } = attachReactivitySignals(bot, { entityPollMs: 10 });
  const spotted = collect(signals, 'entitySpotted');
  const gone = collect(signals, 'entityGone');

  bot.setEntities({ 7: { name: 'zombie', position: { x: 3, y: 64, z: 0 } } }); // in range
  await tick(30);
  bot.setEntities({ 7: { name: 'zombie', position: { x: 999, y: 64, z: 0 } } }); // far away → left
  await tick(30);
  assert.equal(gone.length, 1, 'one entityGone on leave');
  bot.setEntities({ 7: { name: 'zombie', position: { x: 4, y: 64, z: 0 } } }); // back in range → re-enters
  await tick(30);
  assert.equal(spotted.length, 2, 're-entry re-fires (drop-on-leave so it is a NEW incident)');
  detach();
});

test('adapter (poll): the bot never spots ITSELF, and out-of-range entities never fire', async () => {
  const bot = new RecordingBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  const { signals, detach } = attachReactivitySignals(bot, { entityPollMs: 10 });
  const spotted = collect(signals, 'entitySpotted');
  bot.setEntities({
    1: { name: 'player', position: { x: 1, y: 64, z: 0 }, username: 'Firmin' } as { name?: string; position?: { x: number; y: number; z: number } },
    2: { name: 'zombie', position: { x: 500, y: 64, z: 0 } }, // far out of perception
  });
  await tick(40);
  assert.equal(spotted.length, 0, 'self is skipped (username match) and the far zombie is out of range');
  detach();
});

test('adapter (poll): detach stops the poll (no spotted after detach)', async () => {
  const bot = new RecordingBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  const { signals, detach } = attachReactivitySignals(bot, { entityPollMs: 10 });
  const spotted = collect(signals, 'entitySpotted');
  detach();
  bot.setEntities({ 7: { name: 'zombie', position: { x: 2, y: 64, z: 0 } } });
  await tick(40);
  assert.equal(spotted.length, 0, 'a detached adapter polls nothing');
});
