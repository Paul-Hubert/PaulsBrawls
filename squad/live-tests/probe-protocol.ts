// Protocol probe: one bare mineflayer bot (no Squad), to see which server packets mineflayer cannot decode and
// whether inventory updates arrive. Run against a server whose server.properties has RCON on:
//
//   $env:SERVER_PROPERTIES='../server/server.properties'; npx tsx live-tests/probe-protocol.ts

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';

import { Rcon } from './rcon';

const propsFile = resolve(process.env.SERVER_PROPERTIES ?? '../run/server.properties');
const props = Object.fromEntries(
  readFileSync(propsFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
) as Record<string, string>;
const NAME = process.env.PROBE_NAME ?? 'LiveProbe';

const data = minecraftData('1.21.1');
const toClient = (data.protocol as unknown as { play: { toClient: { types: { packet: [string, Array<{ type: [string, { mappings: Record<string, string> }] }>] } } } }).play.toClient.types.packet[1][0]!.type[1].mappings;

const counts = new Map<string, number>();
const errors: string[] = [];

const bot = mineflayer.createBot({ host: '127.0.0.1', port: Number(props['server-port'] ?? 25565), username: NAME, version: '1.21.1', viewDistance: 'short' });
const t0 = Date.now();
const timeline: string[] = [];
bot._client.on('packet', (_d: unknown, meta: { name: string }) => {
  counts.set(meta.name, (counts.get(meta.name) ?? 0) + 1);
  timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${meta.name}`);
});
bot._client.on('error', (e: Error & { buffer?: Buffer; field?: string }) => {
  timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ERROR`);
  let id = '?';
  if (e.buffer && e.buffer.length) {
    const hex = '0x' + e.buffer[0]!.toString(16).padStart(2, '0');
    id = `${hex} ${toClient[hex] ?? '?'}`;
  }
  errors.push(`${id} (${e.buffer?.length ?? '?'} bytes): ${e.message.split('\n')[0]?.slice(0, 160)}`);
});
bot.on('error', () => undefined);

// Raw frames after decompression (before decoding): the packet id is the leading varint.
const rawAfterGive: string[] = [];
let watching = false;
const varint = (b: Buffer): number => {
  let v = 0;
  for (let i = 0; i < 5 && i < b.length; i++) {
    v |= (b[i]! & 0x7f) << (7 * i);
    if (!(b[i]! & 0x80)) break;
  }
  return v;
};
bot._client.on('connect', () => undefined);
setImmediate(function hook() {
  const c = bot._client as unknown as { decompressor?: NodeJS.EventEmitter; splitter?: NodeJS.EventEmitter; compressionThreshold?: number };
  const src = c.decompressor ?? null;
  if (!src) return void setTimeout(hook, 50);
  src.on('data', (frame: Buffer) => {
    if (!watching) return;
    const id = '0x' + varint(frame).toString(16).padStart(2, '0');
    rawAfterGive.push(`${id}:${toClient[id] ?? '?'}`);
  });
});

bot.once('spawn', async () => {
  const rcon = new Rcon('127.0.0.1', Number(props['rcon.port'] ?? 25575), props['rcon.password'] ?? '');
  await rcon.connect();
  await new Promise((r) => setTimeout(r, 2000));
  const before = { set_slot: counts.get('set_slot') ?? 0, window_items: counts.get('window_items') ?? 0 };
  watching = true;
  console.log('give:', (await rcon.command(`give ${NAME} bow`)).trim());
  console.log('give:', (await rcon.command(`give ${NAME} oak_log 3`)).trim());
  await new Promise((r) => setTimeout(r, 3000));
  console.log('server says:', (await rcon.command(`data get entity ${NAME} Inventory`)).trim().slice(0, 300));
  console.log('bot.inventory:', JSON.stringify(bot.inventory.items().map((i) => `${i.count} ${i.name}`)));
  console.log('set_slot packets decoded since give:', (counts.get('set_slot') ?? 0) - before.set_slot,
    ' window_items:', (counts.get('window_items') ?? 0) - before.window_items);
  watching = false;
  const kinds = new Map<string, number>();
  for (const k of rawAfterGive) kinds.set(k, (kinds.get(k) ?? 0) + 1);
  console.log('raw frames after the give:', [...kinds].map(([k, n]) => `${k}×${n}`).join(' ') || 'none');
  console.log('decode errors:', errors.length ? '\n  ' + errors.join('\n  ') : 'none');
  console.log('last decoded packets:', timeline.slice(-12).join(' | '));
  console.log('now:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('decoded packet kinds:', [...counts.keys()].sort().join(' '));
  rcon.close();
  bot.quit();
  setTimeout(() => process.exit(0), 500);
});
setTimeout(() => {
  console.log('no spawn within 30 s; errors:', errors);
  process.exit(1);
}, 30_000);
