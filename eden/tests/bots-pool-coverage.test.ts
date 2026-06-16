// Coverage for bots/pool.ts branches not reached by bots-pool.test.ts:
//   • deathCause object message → JSON.stringify (R27)
//   • deathCause with no message / null packet → no cause field (R27)
//   • snapshotVitals skips bots that are not in 'connected' state (R44)
//   • system.bot-disconnected journalled on 'end' and 'kicked' events
//   • stop() cancels pending reconnect timer (R13)
//   • stop() is idempotent — no throw on second call
//   • R66: a superseded bot instance's kicked/end is ignored (no clobber, no phantom reconnect storm)
//   • R66: a chat-component OBJECT kick reason renders legibly, not "[object Object]"

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { BotPool, type SpawnRequest } from '../src/bots/pool';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'eden-pool-cov-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Factory where every bot emits 'spawn' immediately. */
function allSpawnFactory(): { createBot: (o: SpawnRequest) => FakeBot; requests: SpawnRequest[]; bots: FakeBot[] } {
  const requests: SpawnRequest[] = [];
  const bots: FakeBot[] = [];
  return {
    createBot: (o) => {
      requests.push(o);
      const b = new FakeBot({ username: o.username });
      bots.push(b);
      queueMicrotask(() => b.emit('spawn'));
      return b;
    },
    requests,
    bots,
  };
}

/** Factory where only bots whose usernames are in `autoSpawnSet` emit 'spawn'. */
function selectiveFactory(autoSpawnSet: ReadonlySet<string>): {
  createBot: (o: SpawnRequest) => FakeBot;
  bots: FakeBot[];
} {
  const bots: FakeBot[] = [];
  return {
    createBot: (o) => {
      const b = new FakeBot({ username: o.username });
      bots.push(b);
      if (autoSpawnSet.has(o.username)) queueMicrotask(() => b.emit('spawn'));
      return b;
    },
    bots,
  };
}

// ── deathCause branches (R27/G2) ─────────────────────────────────────────────

test('world.death with an OBJECT message → JSON.stringify cause (R27)', async (t) => {
  const { createBot, bots } = allSpawnFactory();
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot, journal,
    host: '127.0.0.1', port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    avatarName: 'Dieu',
    dataDir: tmp(t), worldId: 'w',
    vitalsIntervalMs: 10_000, staggerMs: 0,
  });
  await pool.spawnAll();
  await delay(5);

  const firmin = bots.find((b) => b.username === 'Firmin')!;
  // death_combat_event with a structured (non-string) message field.
  firmin._client.emit('death_combat_event', {
    playerId: 1,
    message: { translate: 'death.attack.player', with: ['Firmin', 'Zombie'] },
  });

  const deaths = journal.query({ kinds: ['world.death'] });
  assert.equal(deaths.length, 1, 'one world.death event');
  const payload = deaths[0]?.payload as { name: string; cause?: string };
  assert.equal(payload.cause, JSON.stringify({ translate: 'death.attack.player', with: ['Firmin', 'Zombie'] }));
  pool.stop();
});

test('world.death with no message field → no cause in payload (R27)', async (t) => {
  const { createBot, bots } = allSpawnFactory();
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot, journal,
    host: '127.0.0.1', port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    avatarName: 'Dieu',
    dataDir: tmp(t), worldId: 'w',
    vitalsIntervalMs: 10_000, staggerMs: 0,
  });
  await pool.spawnAll();
  await delay(5);

  const firmin = bots.find((b) => b.username === 'Firmin')!;
  // Packet without a message field.
  firmin._client.emit('death_combat_event', { playerId: 1, entityId: 99 });

  const deaths = journal.query({ kinds: ['world.death'] });
  assert.equal(deaths.length, 1);
  // Payload must be { name } only — no cause key when the packet carries no message (R27).
  assert.deepEqual(deaths[0]?.payload, { name: 'Firmin' });
  pool.stop();
});

test('world.death with null packet → no cause in payload (R27)', async (t) => {
  const { createBot, bots } = allSpawnFactory();
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot, journal,
    host: '127.0.0.1', port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    avatarName: 'Dieu',
    dataDir: tmp(t), worldId: 'w',
    vitalsIntervalMs: 10_000, staggerMs: 0,
  });
  await pool.spawnAll();
  await delay(5);

  const firmin = bots.find((b) => b.username === 'Firmin')!;
  // null packet — defensive deathCause returns undefined → no cause field.
  firmin._client.emit('death_combat_event', null);

  const deaths = journal.query({ kinds: ['world.death'] });
  assert.equal(deaths.length, 1);
  assert.deepEqual(deaths[0]?.payload, { name: 'Firmin' }, 'null packet produces no cause');
  pool.stop();
});

// ── vitals snapshot only covers connected bots (R44) ─────────────────────────

test('snapshotVitals skips bots still in connecting or disconnected state (R44)', async (t) => {
  // V0 spawns immediately; V1 and the avatar never emit 'spawn' → stay in 'connecting'.
  const { createBot } = selectiveFactory(new Set(['V0']));
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot, journal,
    host: '127.0.0.1', port: 25599,
    villagers: [{ name: 'V0', role: 'farmer' }, { name: 'V1', role: 'lumberjack' }],
    avatarName: 'Dieu',
    dataDir: tmp(t), worldId: 'w',
    vitalsIntervalMs: 30, staggerMs: 0,
  });
  await pool.spawnAll();
  await delay(5); // let V0 spawn settle

  pool.startVitals();
  await delay(90); // ~3 ticks at 30 ms
  pool.stop();

  const vitals = journal.query({ kinds: ['vitals'] });
  const names = new Set(vitals.map((e) => (e.payload as { name: string }).name));
  assert.ok(names.has('V0'), 'connected bot V0 is snapshotted');
  assert.ok(!names.has('V1'), 'connecting bot V1 is NOT snapshotted (R44)');
  assert.ok(!names.has('Dieu'), 'connecting avatar Dieu is NOT snapshotted (R44)');
});

// ── system.bot-disconnected on 'end' and 'kicked' (R13) ─────────────────────

test("'end' event journals system.bot-disconnected with the reason", async (t) => {
  const { createBot, bots } = allSpawnFactory();
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot, journal,
    host: '127.0.0.1', port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    avatarName: 'Dieu',
    dataDir: tmp(t), worldId: 'w',
    vitalsIntervalMs: 10_000, staggerMs: 0,
  });
  await pool.spawnAll();
  await delay(5);

  const firmin = bots.find((b) => b.username === 'Firmin')!;
  firmin.emit('end', 'connection reset');
  pool.stop(); // cancel the scheduled reconnect immediately

  const events = journal.query({ kinds: ['system.bot-disconnected'] });
  // pool.stop() also triggers disconnects for any remaining connected bots (avatar);
  // we specifically want the one for Firmin.
  const firminDisconnect = events.find((e) => (e.payload as { name: string }).name === 'Firmin');
  assert.ok(firminDisconnect, 'system.bot-disconnected journalled for Firmin');
  assert.equal((firminDisconnect?.payload as { reason?: string }).reason, 'connection reset');
});

test("'kicked' event journals system.bot-disconnected with a prefixed reason", async (t) => {
  const { createBot, bots } = allSpawnFactory();
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot, journal,
    host: '127.0.0.1', port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    avatarName: 'Dieu',
    dataDir: tmp(t), worldId: 'w',
    vitalsIntervalMs: 10_000, staggerMs: 0,
  });
  await pool.spawnAll();
  await delay(5);

  const firmin = bots.find((b) => b.username === 'Firmin')!;
  firmin.emit('kicked', 'banned by admin');
  pool.stop();

  const events = journal.query({ kinds: ['system.bot-disconnected'] });
  const firminDisconnect = events.find((e) => (e.payload as { name: string }).name === 'Firmin');
  assert.ok(firminDisconnect, 'system.bot-disconnected journalled for kicked bot');
  // The pool prefixes the kick reason with 'kicked: ' (see pool.ts onEnd wiring for 'kicked').
  assert.match((firminDisconnect?.payload as { reason?: string }).reason ?? '', /kicked.*banned by admin/i);
});

// ── stop() lifecycle (R13) ────────────────────────────────────────────────────

test('stop() cancels pending reconnect timer — no further createBot calls after stop', async (t) => {
  const { createBot, bots, requests } = allSpawnFactory();
  const pool = new BotPool({
    createBot,
    journal: new MemoryJournal(),
    host: '127.0.0.1', port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    avatarName: 'Dieu',
    dataDir: tmp(t), worldId: 'w',
    vitalsIntervalMs: 10_000, staggerMs: 0,
  });
  await pool.spawnAll();
  await delay(5);

  const initialCount = requests.length; // 2: one villager + avatar

  // Force a disconnect — schedules a reconnect at the minimum backoff (1 000 ms).
  bots.find((b) => b.username === 'Firmin')!.emit('end', 'test disconnect');

  // stop() must cancel the timer before it fires.
  pool.stop();

  // Wait well less than the 1 000 ms minimum backoff to confirm the timer was cleared.
  await delay(50);
  assert.equal(requests.length, initialCount, 'no new createBot calls after stop() cancelled the reconnect timer');
});

test('stop() is idempotent — calling it twice does not throw', (t) => {
  const { createBot } = allSpawnFactory();
  const pool = new BotPool({
    createBot,
    journal: new MemoryJournal(),
    host: '127.0.0.1', port: 25599,
    villagers: [],
    avatarName: 'Dieu',
    dataDir: tmp(t), worldId: 'w',
    vitalsIntervalMs: 10_000,
  });
  assert.doesNotThrow(() => pool.stop(), 'first stop');
  assert.doesNotThrow(() => pool.stop(), 'second stop — idempotent');
});

// ── R66: the /villagers restart duplicate-login kick storm ────────────────────

test('restart swap: a superseded instance kicked/end does NOT clobber its replacement or storm (R66)', async (t) => {
  const bots: FakeBot[] = [];
  const createBot = (o: SpawnRequest): FakeBot => {
    const b = new FakeBot({ username: o.username });
    bots.push(b);
    queueMicrotask(() => b.emit('spawn'));
    return b;
  };
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot, journal,
    host: '127.0.0.1', port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    avatarName: 'Dieu',
    dataDir: tmp(t), worldId: 'w',
    vitalsIntervalMs: 10_000, staggerMs: 0,
  });

  await pool.start();
  await delay(5);
  const firminOld = pool.bot('Firmin') as FakeBot;
  assert.ok(firminOld, 'old Firmin is the live bot after start');

  // Restart: stop() quits the old instances, start() re-spawns FRESH ones. The old instances are now
  // superseded but their lifecycle listeners persist until GC (exactly the live race).
  pool.stop();
  await pool.start();
  await delay(5);
  const firminNew = pool.bot('Firmin') as FakeBot;
  assert.notEqual(firminNew, firminOld, 'a fresh Firmin instance is live after restart');

  const createsBefore = bots.length;
  // The server evicts the OLD session on the duplicate login → the superseded instance fires kicked+end.
  firminOld.emit('kicked', { translate: 'multiplayer.disconnect.duplicate_login' });
  firminOld.emit('end', 'disconnect.quitting');
  await delay(1200); // > the 1 s reconnect floor — a phantom reconnect WOULD have created a bot by now

  assert.equal(pool.bot('Firmin'), firminNew, 'the live bot is untouched by the superseded instance events');
  assert.equal(bots.length, createsBefore, 'no phantom reconnect — the superseded events created no new bot');
  pool.stop();
});

test('kicked with a chat-component OBJECT reason renders legibly, not [object Object] (R66/S10)', async (t) => {
  const { createBot, bots } = allSpawnFactory();
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot, journal,
    host: '127.0.0.1', port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    avatarName: 'Dieu',
    dataDir: tmp(t), worldId: 'w',
    vitalsIntervalMs: 10_000, staggerMs: 0,
  });
  await pool.spawnAll();
  await delay(5);

  const firmin = bots.find((b) => b.username === 'Firmin')!;
  firmin.emit('kicked', { translate: 'multiplayer.disconnect.duplicate_login' });
  pool.stop(); // cancel the reconnect this schedules

  const ev = journal
    .query({ kinds: ['system.bot-disconnected'] })
    .find((e) => (e.payload as { name: string }).name === 'Firmin');
  const reason = (ev?.payload as { reason?: string }).reason ?? '';
  assert.match(reason, /duplicate_login/, 'the translate key survives into the journal');
  assert.doesNotMatch(reason, /\[object Object\]/, 'the chat-component object is not stringified to [object Object]');
});
