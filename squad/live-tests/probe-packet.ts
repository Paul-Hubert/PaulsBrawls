// Capture the packet mineflayer cannot decode and print its id and the namespaced identifiers inside it, to tell
// which mod put them there.   $env:SERVER_PROPERTIES='../server/server.properties'; npx tsx live-tests/probe-packet.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';

const propsFile = resolve(process.env.SERVER_PROPERTIES ?? '../run/server.properties');
const port = Number(/^server-port=(\d+)/m.exec(readFileSync(propsFile, 'utf8'))?.[1] ?? 25565);
const data = minecraftData('1.21.1');
const mappings = (data.protocol as unknown as { play: { toClient: { types: { packet: [string, Array<{ type: [string, { mappings: Record<string, string> }] }>] } } } }).play.toClient.types.packet[1][0]!.type[1].mappings;

const bot = mineflayer.createBot({ host: '127.0.0.1', port, username: 'LiveProbe3', version: '1.21.1', viewDistance: 'short' });
bot.on('error', () => undefined);
let last: Buffer | null = null;
const frames: Buffer[] = [];
setImmediate(function hook() {
  const d = (bot._client as unknown as { decompressor?: NodeJS.EventEmitter }).decompressor;
  if (!d) return void setTimeout(hook, 20);
  d.on('data', (f: Buffer) => {
    last = f;
    frames.push(f);
  });
});
bot._client.on('error', (e: Error) => {
  const f = last as Buffer | null;
  if (!f) return console.log('error without a frame:', e.message);
  let id = 0;
  let i = 0;
  for (; i < 5; i++) {
    id |= (f[i]! & 0x7f) << (7 * i);
    if (!(f[i]! & 0x80)) break;
  }
  const hex = '0x' + id.toString(16).padStart(2, '0');
  console.log(`failing packet ${hex} = ${mappings[hex]} (${f.length} bytes): ${e.message.slice(0, 150)}`);
  writeFileSync('failing-packet.bin', f);
  const text = f.toString('latin1');
  const ids = new Map<string, number>();
  for (const m of text.matchAll(/([a-z0-9_.-]{2,40}):([a-z0-9_/.-]{2,80})/g)) {
    const ns = m[1]!;
    ids.set(ns, (ids.get(ns) ?? 0) + 1);
  }
  console.log('namespaces in it:', [...ids].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(' '));
  const foreign = [...text.matchAll(/((?!minecraft:)[a-z0-9_.-]{2,40}:[a-z0-9_/.-]{2,80})/g)].map((m) => m[1]).filter((s) => !s!.startsWith('minecraft:'));
  console.log('non-minecraft ids (first 30):', [...new Set(foreign)].slice(0, 30).join(' '));
  setTimeout(() => {
    bot.quit();
    process.exit(0);
  }, 300);
});
setTimeout(() => {
  console.log('no decode error within 20 s');
  process.exit(1);
}, 20_000);
