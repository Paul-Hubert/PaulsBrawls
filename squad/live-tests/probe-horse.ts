// Live probe of riding (docs/41): one runtime bot on the dev server (dev-26.1.2/, ./gradlew runDevServer, port 25602,
// RCON 25579) is put on a saddled horse over RCON on a stone platform it builds at y 199, walks forward 2 s, and the
// horse's position before and after is read back. It printed « horse moved 0 blocks » before the mineflayer patch
// (a mount stopped mineflayer's physics: no body motion, no vehicle_move), and about 14 after it.
//   npx tsx live-tests/probe-horse.ts      (MC_PORT, RCON_PORT, RCON_PASSWORD override the dev server's)

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Bot } from 'mineflayer';

import { parseConfig } from '../src/config';
import { start } from '../src/main';
import { Rcon } from './rcon';

const MC_PORT = Number(process.env.MC_PORT ?? 25602);
const rcon = new Rcon('127.0.0.1', Number(process.env.RCON_PORT ?? 25579), process.env.RCON_PASSWORD ?? 'paulsbrawls-eval');
await rcon.connect();
const run = (c: string): Promise<string> => rcon.command(c);
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const horseZ = async (): Promise<number> => Number(/\[[^,]+, [^,]+, (-?[\d.]+)d\]/.exec(await run('data get entity @e[type=horse,tag=probe_horse,limit=1] Pos'))?.[1]);

const cfg = parseConfig({ minecraft: { port: MC_PORT }, port: 0, dataDir: mkdtempSync(join(tmpdir(), 'probe-horse-')) }, { PAULSBRAWLS_SQUAD_TOKEN: 'probe' });
const rt = await start(cfg, { connectBots: false, installGuards: true });
const { pool } = rt.service.deps;
let code = 1;
try {
  pool.add('HorseProbe');
  for (let i = 0; i < 300 && pool.status('HorseProbe') !== 'online'; i++) await sleep(100);
  const bot = pool.bot('HorseProbe') as Bot & { vehicle?: { name?: string } | null };
  await run('forceload add 1000 1000 1040 1040');
  await run('fill 1000 199 1000 1040 199 1040 minecraft:stone');
  await run('fill 1000 200 1000 1040 203 1040 minecraft:air');
  await run('tp HorseProbe 1010.5 200 1010.5 0 0');
  await sleep(2000);
  await run('kill @e[type=horse,tag=probe_horse]');
  await run('execute as HorseProbe at @s run summon minecraft:horse ~ ~ ~ {Tame:1b,Tags:["probe_horse"]}');
  await run('item replace entity @e[type=horse,tag=probe_horse,limit=1] saddle with minecraft:saddle');
  await run('item replace entity @e[type=horse,tag=probe_horse,limit=1] horse.saddle with minecraft:saddle');
  await run('ride HorseProbe mount @e[type=horse,tag=probe_horse,limit=1]');
  await sleep(1500);
  const z0 = await horseZ();
  bot.setControlState('forward', true);
  await sleep(2000);
  bot.setControlState('forward', false);
  await sleep(500);
  const moved = (await horseZ()) - z0;
  console.log(`riding ${bot.vehicle?.name ?? 'nothing'}; horse moved ${moved.toFixed(1)} blocks in 2 s`);
  code = moved > 5 ? 0 : 1;
} finally {
  await run('kill @e[type=horse,tag=probe_horse]');
  pool.remove('HorseProbe');
  await rt.stop();
  rcon.close();
}
process.exit(code);
