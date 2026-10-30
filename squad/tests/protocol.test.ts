// docs/29 §16: a packet mineflayer cannot decode costs that packet, never the bot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import protodef from 'protodef';

import { keepDecodersAlive, RECIPES_AS_BYTES, type SkippedPacket } from '../src/bots/protocol';
import { BotPool } from '../src/bots/pool';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { until } from './fakes/harness';

holdEventLoopPerTest();
const require = createRequire(import.meta.url);

test('declare_recipes is read as raw bytes: a recipe list mineflayer cannot parse no longer reaches its decoder', async () => {
  const { createDeserializer } = require('minecraft-protocol/src/transforms/serializer');
  const d = createDeserializer({ state: 'play', isServer: false, version: '1.21.1', customPackets: RECIPES_AS_BYTES });
  const garbage = Buffer.from([0x77, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x01, 0x02, 0x03]); // 0x77 = declare_recipes
  const parsed = await new Promise<{ data: { name: string; params: { raw: Buffer } } }>((resolve, reject) => {
    d.once('data', resolve);
    d.once('error', reject);
    d.write(garbage);
  });
  assert.equal(parsed.data.name, 'declare_recipes');
  assert.deepEqual([...parsed.data.params.raw], [0xff, 0xff, 0xff, 0xff, 0x0f, 0x01, 0x02, 0x03]);
});

test('an undecodable packet is skipped and reported; the decoder keeps going', async () => {
  const skipped: SkippedPacket[] = [];
  keepDecodersAlive((s) => skipped.push(s));
  const proto = {
    parsePacketBuffer(_type: string, b: Buffer) {
      if (b[0] === 1) throw new Error('array size is abnormally large');
      if (b[0] === 2) throw Object.assign(new Error('Missing characters in string'), { partialReadError: true });
      return { data: { name: 'ok', n: b[0] }, metadata: { size: b.length } };
    },
  };
  const parser = new (protodef as unknown as { FullPacketParser: new (p: unknown, t: string) => NodeJS.ReadWriteStream })
    .FullPacketParser(proto, 'packet');
  const seen: number[] = [];
  let failed = false;
  parser.on('data', (p: { data: { n: number } }) => seen.push(p.data.n));
  parser.on('error', () => (failed = true));
  for (const b of [1, 7, 2, 8]) parser.write(Buffer.from([b]));
  await until(() => seen.length === 2, 1000, 'two packets');
  assert.deepEqual(seen, [7, 8]);
  assert.equal(failed, false);
  assert.deepEqual(skipped.map((s) => [s.partial, s.message]), [[false, 'array size is abnormally large'], [true, 'Missing characters in string']]);
});

test('a bot that hears nothing for the deaf limit is ended and reconnected', async () => {
  const made: FakeBot[] = [];
  const pool = new BotPool({
    host: 'x',
    port: 1,
    staggerMs: 1,
    deafMs: 150,
    setup: () => undefined,
    createBot: (req) => {
      const b = new FakeBot(req.username);
      made.push(b);
      setTimeout(() => b.emit('spawn'), 1);
      return b as never;
    },
  });
  pool.add('Deafy');
  await until(() => pool.status('Deafy') === 'online', 1000, 'online');
  // A live bot keeps receiving packets: no reconnect.
  const live = setInterval(() => made[0]!._client.emit('packet', {}, { name: 'keep_alive' }), 30);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(made.length, 1);
  clearInterval(live);
  // Silence: the watchdog ends it, the pool reconnects (backoff 1 s).
  await until(() => made[0]!.calls.includes('end(deaf)'), 2000, 'the deaf bot ended');
  await until(() => made.length === 2 && pool.status('Deafy') === 'online', 3000, 'reconnected');
  assert.match(pool.lastReason('Deafy') ?? 'cleared on spawn', /cleared on spawn|deaf/);
  pool.stop();
});
