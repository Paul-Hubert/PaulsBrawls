// docs/32 C: the vitals. The pool's cheap per-bot counters, the 10 s window, the warning (at most one a minute),
// the French line, and one journal row per minute pruned after 7 days. Everything runs on fakes and an injected
// clock, except the loop monitor test, which blocks the real event loop on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import protodef from 'protodef';

import { BotPool, skippedPackets, type BotMeterReading } from '../src/bots/pool';
import { Journal, VITALS_KEEP_MS, type VitalsRow } from '../src/journal/journal';
import { logger } from '../src/logger';
import { LoopMonitor, type LoopWindow } from '../src/vitals/lag-monitor';
import { Vitals, statusText, type LoopSource, type MeteredPool } from '../src/vitals/metrics';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { until } from './fakes/harness';

holdEventLoopPerTest();

function fakePool(made: FakeBot[], deafMs?: number): BotPool {
  return new BotPool({
    host: 'x',
    port: 1,
    staggerMs: 1,
    ...(deafMs ? { deafMs } : {}),
    setup: () => undefined,
    createBot: (req) => {
      const b = new FakeBot(req.username);
      made.push(b);
      setTimeout(() => b.emit('spawn'), 1);
      return b as never;
    },
  });
}

test('the pool counts physics ticks, path outcomes and path resets per bot, and zeroes them on a reset read', async () => {
  const made: FakeBot[] = [];
  const pool = fakePool(made);
  pool.add('Archer1');
  await until(() => pool.status('Archer1') === 'online', 1000, 'online');
  const b = made[0]!;
  for (let i = 0; i < 37; i++) b.emit('physicsTick');
  for (const status of ['partial', 'success', 'success', 'noPath', 'timeout', 'weird']) b.emit('path_update', { status, time: 3 });
  b.emit('path_reset', 'stuck');
  b.emit('path_reset', 'stuck');
  b.emit('path_reset', 'block_updated');

  const peek = pool.readMeters(false)[0]!;
  assert.equal(peek.ticks, 37);
  const r = pool.readMeters(true)[0]!;
  assert.equal(r.name, 'Archer1');
  assert.equal(r.status, 'online');
  assert.ok(r.onlineAt > 0);
  assert.deepEqual([r.ticks, r.pathSuccess, r.pathNoPath, r.pathTimeout, r.pathOther], [37, 2, 1, 1, 1]);
  assert.deepEqual(r.resets, { stuck: 2, block_updated: 1 });
  const z = pool.readMeters(true)[0]!;
  assert.deepEqual([z.ticks, z.pathSuccess, z.pathNoPath, z.pathTimeout, z.pathOther, z.deafTrips], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(z.resets, { stuck: 0, block_updated: 0 });
  pool.stop();
});

test('a superseded bot instance no longer counts, and a deaf trip is counted on the bot', async () => {
  const made: FakeBot[] = [];
  const pool = fakePool(made, 150);
  pool.add('Deafy');
  await until(() => pool.status('Deafy') === 'online', 1000, 'online');
  await until(() => made[0]!.calls.includes('end(deaf)'), 2000, 'the deaf bot ended');
  await until(() => made.length === 2 && pool.status('Deafy') === 'online', 3000, 'reconnected');
  made[0]!.emit('physicsTick'); // the old instance: ignored
  made[1]!.emit('physicsTick');
  const r = pool.readMeters(true)[0]!;
  assert.equal(r.ticks, 1);
  assert.ok(r.deafTrips >= 1);
  pool.stop();
});

test('every skipped packet counts process-wide, even when the log line is rate-limited', async () => {
  const pool = fakePool([]); // installs the pool's reporter
  const proto = {
    parsePacketBuffer() {
      throw new Error('array size is abnormally large');
    },
  };
  const parser = new (protodef as unknown as { FullPacketParser: new (p: unknown, t: string) => NodeJS.ReadWriteStream }).FullPacketParser(proto, 'packet');
  const before = skippedPackets();
  const warn = logger.warn;
  const lines: string[] = [];
  logger.warn = (_a, m) => void lines.push(m);
  try {
    for (let i = 0; i < 3; i++) parser.write(Buffer.from([1]));
    await until(() => skippedPackets() === before + 3, 1000, 'three skips');
  } finally {
    logger.warn = warn;
  }
  assert.ok(lines.length <= 1, 'one log line per kind per minute');
  pool.stop();
});

// -- the sampler, on an injected clock --------------------------------------------------------------------------

class ScriptedLoop implements LoopSource {
  next: LoopWindow = { seconds: 10, p50: 1, p99: 20, max: 40, elu: 0.3, cpuPct: 30, rssMb: 300, heapMb: 120 };
  resets = 0;
  read(reset: boolean): LoopWindow {
    if (reset) this.resets++;
    return { ...this.next };
  }
  stop(): void {}
}

class ScriptedPool implements MeteredPool {
  readings: BotMeterReading[] = [];
  readMeters(_reset: boolean): BotMeterReading[] {
    return this.readings.map((r) => ({ ...r, resets: { ...r.resets } }));
  }
}

function reading(name: string, ticks: number, onlineAt: number, extra: Partial<BotMeterReading> = {}): BotMeterReading {
  return { name, status: 'online', onlineAt, ticks, pathSuccess: 0, pathNoPath: 0, pathTimeout: 0, pathOther: 0, resets: {}, deafTrips: 0, ...extra };
}

class Sink {
  rows: VitalsRow[] = [];
  saveVitals(r: VitalsRow): void {
    this.rows.push(r);
  }
}

test('a window: ticks/s per bot over its online part, the slowest bot in the French line, skipped packets as a delta', () => {
  let now = 1_000_000;
  let skipped = 5;
  const loop = new ScriptedLoop();
  const pool = new ScriptedPool();
  const v = new Vitals({ pool, loop, now: () => now, skipped: () => skipped });
  // Before the first window closes, a request sees the window so far.
  pool.readings = [reading('Archer1', 0, 0, { status: 'connecting' })];
  const early = v.metrics();
  assert.equal(early.window.complete, false);
  assert.equal(loop.resets, 0, 'a peek does not reset the window');
  assert.match(early.text, /mesure en cours/);
  assert.match(early.text, /aucun bot en ligne/);

  now += 10_000;
  skipped = 9;
  pool.readings = [
    reading('Archer1', 200, now - 60_000, { pathSuccess: 3, pathTimeout: 1, resets: { stuck: 2, chunk_loaded: 0 } }),
    reading('Brute', 76, now - 5_000), // online for 5 s of the window: 15.2 ticks/s, not 7.6
    reading('Late', 0, now - 500), // online for half a second: not measured yet
    reading('Gone', 0, 0, { status: 'offline' }),
  ];
  loop.next = { seconds: 10, p50: 12.3, p99: 75.4, max: 178, elu: 0.654, cpuPct: 70.8, rssMb: 412, heapMb: 150 };
  const m = v.sample();
  assert.equal(m.window.complete, true);
  assert.equal(m.window.endedAt, now);
  assert.equal(m.skippedPackets, 4);
  assert.deepEqual(m.loop, { p50: 12.3, p99: 75.4, max: 178 });
  assert.deepEqual(
    m.bots.map((b) => [b.name, b.ticksPerSec]),
    [['Archer1', 20], ['Brute', 15.2], ['Late', null], ['Gone', null]],
  );
  assert.deepEqual(m.bots[0]!.path, { success: 3, noPath: 0, timeout: 1, other: 0 });
  assert.deepEqual(m.bots[0]!.resets, { stuck: 2 }, 'zero reasons are left out');
  assert.equal(
    m.text,
    '[Bots] Charge du runtime (10 s) : ELU 0,65 · boucle p99 75 ms (max 178) · CPU 71 % · RAM 412 Mo · bot le plus lent : Brute à 15,2 ticks/s (3 en ligne).',
  );
  // The same window until the next sample.
  assert.equal(v.metrics(), m);
  assert.equal(v.metrics().skippedPackets, 4);
});

test('an overloaded loop warns at most once a minute and says so in the line', () => {
  let now = 0;
  const loop = new ScriptedLoop();
  const pool = new ScriptedPool();
  const v = new Vitals({ pool, loop, now: () => now });
  const warn = logger.warn;
  const lines: string[] = [];
  logger.warn = (a, msg) => void lines.push(`${a} ${msg}`);
  try {
    loop.next = { seconds: 10, p50: 100, p99: 430, max: 600, elu: 1, cpuPct: 103, rssMb: 500, heapMb: 200 };
    for (let i = 0; i < 6; i++) {
      now += 10_000;
      const m = v.sample();
      assert.match(m.text, /surchargé : les bots ralentissent\.$/);
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^vitals event loop overloaded over the last 10 s: ELU 1, loop p99 430 ms/);
    now += 10_000;
    v.sample(); // 70 s after the first warning
    assert.equal(lines.length, 2);
    // ELU alone over the limit also warns; a calm loop never does.
    loop.next = { ...loop.next, p99: 10, elu: 0.95 };
    now += 60_000;
    v.sample();
    assert.equal(lines.length, 3);
    loop.next = { ...loop.next, p99: 10, elu: 0.5 };
    now += 60_000;
    v.sample();
    assert.equal(lines.length, 3);
  } finally {
    logger.warn = warn;
  }
});

test('one journal row per minute sums the windows: time-weighted ELU, worst p99, slowest bot, counts added up', () => {
  let now = 0;
  const loop = new ScriptedLoop();
  const pool = new ScriptedPool();
  const sink = new Sink();
  const v = new Vitals({ pool, loop, now: () => now, journal: sink });
  for (let i = 0; i < 6; i++) {
    now += 10_000;
    loop.next = { seconds: 10, p50: 2, p99: i === 3 ? 300 : 20, max: i === 3 ? 500 : 40, elu: i < 3 ? 0.2 : 0.8, cpuPct: 50, rssMb: 300 + i, heapMb: 100 };
    pool.readings = [reading('A', i === 4 ? 120 : 200, 1, { pathSuccess: 1, resets: { stuck: 1 } }), reading('B', 200, 1, { deafTrips: i === 0 ? 1 : 0 })];
    v.sample();
    assert.equal(sink.rows.length, i === 5 ? 1 : 0, `after window ${i + 1}`);
  }
  const r = sink.rows[0]!;
  assert.equal(r.at, 60_000);
  assert.equal(r.seconds, 60);
  assert.equal(r.elu, 0.5);
  assert.equal(r.loopP99, 300);
  assert.equal(r.loopMax, 500);
  assert.equal(r.rssMb, 305);
  assert.equal(r.bots, 2);
  assert.equal(r.minTicksPerSec, 12);
  assert.deepEqual(r.data, { windows: 6, slowest: 'A', path: { success: 6, noPath: 0, timeout: 0, other: 0 }, resets: { stuck: 6 }, deafTrips: 1, skippedPackets: 0 });
  // The next minute starts empty.
  now += 10_000;
  v.sample();
  assert.equal(sink.rows.length, 1);
});

test('the journal keeps vitals for 7 days: a write prunes the older rows', () => {
  const j = new Journal(':memory:');
  const row = (at: number): VitalsRow => ({ at, seconds: 60, elu: 0.5, loopP50: 1, loopP99: 20, loopMax: 40, cpuPct: 50, rssMb: 300, heapMb: 100, bots: 2, minTicksPerSec: 19.5, data: { windows: 6 } });
  const t0 = Date.UTC(2026, 9, 1);
  j.saveVitals(row(t0));
  j.saveVitals({ ...row(t0 + 60_000), minTicksPerSec: null });
  assert.equal(j.vitals().length, 2);
  assert.deepEqual(j.vitals(1)[0], { ...row(t0 + 60_000), minTicksPerSec: null });
  // Exactly 7 days after the first: still kept. One minute later: the first goes.
  j.saveVitals(row(t0 + VITALS_KEEP_MS));
  assert.deepEqual(j.vitals().map((r) => r.at), [t0 + VITALS_KEEP_MS, t0 + 60_000, t0]);
  j.saveVitals(row(t0 + VITALS_KEEP_MS + 60_000));
  assert.deepEqual(j.vitals().map((r) => r.at), [t0 + VITALS_KEEP_MS + 60_000, t0 + VITALS_KEEP_MS, t0 + 60_000]);
  j.close();
});

test('the loop monitor sees a synchronous block it was armed before', async () => {
  const mon = new LoopMonitor();
  await new Promise((r) => setTimeout(r, 30)); // let the histogram's timer start
  const end = Date.now() + 300;
  while (Date.now() < end) {
    /* block the loop */
  }
  await new Promise((r) => setTimeout(r, 30));
  const w = mon.read(true);
  mon.stop();
  assert.ok(w.max >= 200, `max ${w.max} ms`);
  assert.ok(w.elu > 0.5, `elu ${w.elu}`);
  assert.ok(w.seconds > 0.3 && w.rssMb > 0 && w.heapMb > 0);
});

test('the French line with no bot measured yet, and singular/plural', () => {
  const base = { ok: true as const, window: { seconds: 10, endedAt: 0, complete: true }, loop: { p50: 0, p99: 3.4, max: 9 }, elu: 0.05, cpuPct: 4, rssMb: 200, heapMb: 80, skippedPackets: 0 };
  const one = { name: 'X', status: 'online' as const, ticksPerSec: null, path: { success: 0, noPath: 0, timeout: 0, other: 0 }, resets: {}, deafTrips: 0 };
  assert.match(statusText({ ...base, bots: [one] }), /· 1 bot en ligne, pas encore mesuré\.$/);
  assert.match(statusText({ ...base, bots: [one, { ...one, name: 'Y' }] }), /· 2 bots en ligne, pas encore mesurés\.$/);
  assert.match(statusText({ ...base, bots: [] }), /ELU 0,05 · boucle p99 3 ms \(max 9\) · CPU 4 % · RAM 200 Mo · aucun bot en ligne\.$/);
});
