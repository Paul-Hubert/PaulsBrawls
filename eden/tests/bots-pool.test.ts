import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { BotPool, stampWorldId, LOGIN_STAGGER_MS, type SpawnRequest } from '../src/bots/pool';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'eden-pool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A createBot factory that records each spawn request and emits `spawn` on the next microtask. */
function recordingFactory(): { createBot: (o: SpawnRequest) => FakeBot; requests: SpawnRequest[]; bots: FakeBot[] } {
  const requests: SpawnRequest[] = [];
  const bots: FakeBot[] = [];
  const createBot = (o: SpawnRequest): FakeBot => {
    requests.push(o);
    const b = new FakeBot({ username: o.username });
    bots.push(b);
    queueMicrotask(() => b.emit('spawn'));
    return b;
  };
  return { createBot, requests, bots };
}

test('I1 default login stagger is the v1 constant (4 s), not a config key', () => {
  assert.equal(LOGIN_STAGGER_MS, 4_000);
});

test('spawnAll staggers logins and brings the avatar up LAST (R13/I1)', async (t) => {
  const { createBot, requests } = recordingFactory();
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot,
    journal,
    host: '127.0.0.1',
    port: 25599,
    villagers: [
      { name: 'Firmin', role: 'farmer' },
      { name: 'Remy', role: 'lumberjack' },
    ],
    avatarName: 'Dieu',
    dataDir: tmp(t),
    worldId: 'w',
    vitalsIntervalMs: 10_000,
    staggerMs: 30,
  });
  await pool.spawnAll();
  await delay(5); // let the last spawn's microtask settle

  assert.deepEqual(requests.map((r) => r.username), ['Firmin', 'Remy', 'Dieu'], 'avatar last');
  // R11/R8: every login carries the protocol pin and the short view distance.
  assert.ok(requests.every((r) => r.version === '1.21.1'), 'protocol pinned 1.21.1 (R11)');
  assert.ok(requests.every((r) => r.viewDistance === 'short'), "viewDistance 'short' (R8)");
  assert.ok(requests.every((r) => r.checkTimeoutInterval === 90_000), 'keepalive 90 s (R13)');

  // Each spawn journalled exactly one system.bot-connected.
  assert.equal(journal.query({ kinds: ['system.bot-connected'] }).length, 3);
});

test('op is the avatar-only privilege — the pool never ops, and exactly one member is divine (R14)', (t) => {
  const { createBot } = recordingFactory();
  const pool = new BotPool({
    createBot,
    journal: new MemoryJournal(),
    host: '127.0.0.1',
    port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    avatarName: 'Dieu',
    dataDir: tmp(t),
    worldId: 'w',
    vitalsIntervalMs: 10_000,
  });
  const roster = pool.roster();
  const divine = roster.filter((m) => m.tier === 'divine');
  assert.equal(divine.length, 1, 'exactly one divine member');
  assert.equal(divine[0]?.name, 'Dieu');
  assert.ok(roster.find((m) => m.name === 'Firmin')?.tier === 'mortal', 'villagers are mortal');
  // Read-contract (R14): op-on-join is the Java mod's job keyed on the avatar name. The pool has
  // NO op path of its own — it must never grant op to a villager.
  assert.equal(typeof (pool as unknown as { op?: unknown }).op, 'undefined', 'pool exposes no op method');
});

test('a death_combat_event packet is journalled as world.death with its cause (R27/G2)', async (t) => {
  const { createBot, bots } = recordingFactory();
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot,
    journal,
    host: '127.0.0.1',
    port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    avatarName: 'Dieu',
    dataDir: tmp(t),
    worldId: 'w',
    vitalsIntervalMs: 10_000,
    staggerMs: 0,
  });
  await pool.spawnAll();
  await delay(5);
  const firmin = bots.find((b) => b.username === 'Firmin')!;
  // R27: the authoritative cause is the death_combat_event packet, not entity inference.
  firmin._client.emit('death_combat_event', { playerId: 1, entityId: 99, message: 'Firmin was slain by Zombie' });

  const deaths = journal.query({ kinds: ['world.death'] });
  assert.equal(deaths.length, 1);
  assert.deepEqual(deaths[0]?.payload, { name: 'Firmin', cause: 'Firmin was slain by Zombie' });
  pool.stop();
});

test('M1-5 vitals: per-bot snapshot cadence, full payload, and ZERO pulse events (R44)', async (t) => {
  const { createBot } = recordingFactory();
  const journal = new MemoryJournal();
  const villagers = Array.from({ length: 10 }, (_v, i) => ({ name: `V${i}`, role: 'villager' }));
  const pool = new BotPool({
    createBot,
    journal,
    host: '127.0.0.1',
    port: 25599,
    villagers,
    avatarName: 'Dieu', // 10 villagers + avatar = 11 bots
    dataDir: tmp(t),
    worldId: 'w',
    vitalsIntervalMs: 40,
    staggerMs: 0,
  });
  await pool.spawnAll();
  await delay(5);
  pool.startVitals();
  await delay(150); // ~3 ticks at 40 ms
  pool.stop();

  const vitals = journal.query({ kinds: ['vitals'] });
  // Cadence scales with bot count: 11 bots per tick. At the production 10 s interval that is
  // 1.1 events/s; here (40 ms) we just assert the per-bot coverage and multi-tick volume.
  const names = new Set(vitals.map((e) => (e.payload as { name: string }).name));
  assert.equal(names.size, 11, 'all 11 bots are snapshotted each tick');
  assert.ok(vitals.length >= 22, `expected ≥2 full ticks (≥22 events), got ${vitals.length}`);

  // Payload schema (docs/05 World domain): name/health/food/position[3]/held/currentRun.
  const sample = vitals[0]?.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(sample).sort(), ['currentRun', 'food', 'health', 'held', 'name', 'position'].sort());
  assert.equal((sample.position as number[]).length, 3);
  assert.equal(sample.currentRun, null, 'no skill engine yet → currentRun null');

  // R44: NOT ONE per-tick / pulse stream made it into the journal.
  for (const e of journal.query()) {
    assert.doesNotMatch(e.kind, /pulse|physic|path_update|positionDelta/i, `${e.kind} smells like a pulse (R44)`);
  }
});

test('stampWorldId stamps fresh, matches on re-boot, and flags a world swap (R32)', (t) => {
  const dir = tmp(t);
  assert.deepEqual(stampWorldId(dir, 'world-A'), { status: 'fresh', worldId: 'world-A' });
  assert.deepEqual(stampWorldId(dir, 'world-A'), { status: 'match', worldId: 'world-A' });
  const swap = stampWorldId(dir, 'world-B');
  assert.equal(swap.status, 'mismatch');
  assert.equal(swap.previous, 'world-A'); // R32: a regenerated world poisons persisted beliefs
});

// R74: stop() during the staggered login used to let spawnAll's loop keep logging bots in AFTER the stop — on a
// host shutdown those late logins journaled into a closed database ("The database connection is not open").
test('R74: stop() during the staggered login stops the remaining logins (no bot after stop)', async (t) => {
  const { createBot, requests } = recordingFactory();
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot,
    journal,
    host: '127.0.0.1',
    port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }, { name: 'Remy', role: 'lumberjack' }],
    avatarName: 'Dieu',
    dataDir: tmp(t),
    worldId: 'w',
    vitalsIntervalMs: 10_000,
    staggerMs: 40,
  });
  const started = pool.start();
  await delay(10); // Firmin is logging in; Remy + Dieu are still waiting out the stagger
  pool.stop();
  await started;
  await delay(120);
  assert.deepEqual(requests.map((r) => r.username), ['Firmin'], 'no login after stop()');
});

test('R74: a stop→start cycle mid-stagger does not let the OLD login loop double-connect members', async (t) => {
  const { createBot, requests } = recordingFactory();
  const journal = new MemoryJournal();
  const pool = new BotPool({
    createBot,
    journal,
    host: '127.0.0.1',
    port: 25599,
    villagers: [{ name: 'Firmin', role: 'farmer' }, { name: 'Remy', role: 'lumberjack' }],
    avatarName: 'Dieu',
    dataDir: tmp(t),
    worldId: 'w',
    vitalsIntervalMs: 10_000,
    staggerMs: 40,
  });
  const first = pool.start();
  await delay(10);
  pool.stop();
  const second = pool.start(); // a /villagers restart: the old loop must not resume alongside the new one
  await Promise.all([first, second]);
  await delay(20);
  t.after(() => pool.stop());
  const counts = requests.reduce<Record<string, number>>((m, r) => ({ ...m, [r.username]: (m[r.username] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { Firmin: 2, Remy: 1, Dieu: 1 }, 'Firmin once per start; the rest only from the live loop');
});
