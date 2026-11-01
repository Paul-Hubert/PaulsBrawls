// Live probe of world.shared (docs/37 P5) for what the live suites do not do: placing a block, opening a chest
// (looking in, taking, depositing), digging (bot.dig, then mineBlock with collectblock), a sign's block entity, and
// two bots seeing each other's changes. The real runtime in process with world.shared (PROBE_SHARED=0: without, to
// compare), two bots on a stone pad the probe lays on the dev world at 1300,100,1100.
//
//   ./gradlew runDevServer          (dev/: its server.properties gives the ports and the RCON password)
//   cd squad && npx tsx live-tests/probe-shared.ts        PROBE_PORT=8792, PROBE_SHARED=0|1, SERVER_PROPERTIES=…

import { mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

import { parseConfig } from '../src/config';
import { start } from '../src/main';
import { logger } from '../src/logger';
import { checkItemInsideChest, depositItemIntoChest, getItemFromChest, mineBlock, placeItem } from '../src/api/helpers';
import { Rcon } from './rcon';

const here = fileURLToPath(new URL('.', import.meta.url));
const PROPS_FILE = process.env.SERVER_PROPERTIES ? resolve(process.env.SERVER_PROPERTIES) : resolve(here, '..', '..', 'dev', 'server.properties');
const props = Object.fromEntries(
  readFileSync(PROPS_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
) as Record<string, string>;
const MC_PORT = Number(props['server-port'] ?? 25599);
if (MC_PORT === 25565 || !/[\\/]dev[\\/]server\.properties$/.test(PROPS_FILE)) throw new Error('the probe changes the world: dev server (dev/) only');
const PORT = Number(process.env.PROBE_PORT ?? 8792);
const SHARED = process.env.PROBE_SHARED !== '0';
const TOKEN = 'live-test-token';
const OWNER = { uuid: '33333333-3333-3333-3333-333333333333', name: 'Probe' };
const PAD = { x: 1300, y: 100, z: 1100 };
const BOTS = ['SharedA', 'SharedB'];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (line: string): void => logger.info('probe', line);

async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const results: Array<{ check: string; ok: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    results.push({ check: name, ok: true, detail: await fn() });
    log(`✔ ${name}: ${results.at(-1)?.detail}`);
  } catch (e) {
    results.push({ check: name, ok: false, detail: (e as Error).message });
    log(`✖ ${name}: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  const rcon = new Rcon('127.0.0.1', Number(props['rcon.port']), props['rcon.password'] ?? '');
  await rcon.connect();
  const cfg = parseConfig({ minecraft: { port: MC_PORT }, port: PORT, dataDir: mkdtempSync(join(tmpdir(), 'probe-shared-')), loginStaggerMs: 500, world: { shared: SHARED } }, { PAULSBRAWLS_SQUAD_TOKEN: TOKEN });
  const rt = await start(cfg, { connectBots: true, installGuards: true });
  const { pool } = rt.service.deps;
  const api = async (path: string, body: unknown): Promise<{ ok: boolean; text: string }> => {
    const r = await fetch(`http://127.0.0.1:${rt.port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    return (await r.json()) as { ok: boolean; text: string };
  };
  const bot = (n: string): Bot => pool.bot(n) as Bot;
  const block = (b: Bot, p: { x: number; y: number; z: number }): string => b.blockAt(new Vec3(p.x, p.y, p.z))?.name ?? 'null';
  const server = async (p: { x: number; y: number; z: number }, name: string): Promise<boolean> => /passed/i.test(await rcon.command(`execute if block ${p.x} ${p.y} ${p.z} ${name}`));
  try {
    log(`world.shared ${SHARED ? 'on' : 'off'}; laying the pad`);
    await rcon.command(`forceload add ${PAD.x - 16} ${PAD.z - 16} ${PAD.x + 16} ${PAD.z + 16}`);
    await rcon.command(`fill ${PAD.x - 8} ${PAD.y} ${PAD.z - 8} ${PAD.x + 8} ${PAD.y} ${PAD.z + 8} stone`);
    await rcon.command(`fill ${PAD.x - 8} ${PAD.y + 1} ${PAD.z - 8} ${PAD.x + 8} ${PAD.y + 6} ${PAD.z + 8} air`);
    const chest = { x: PAD.x + 3, y: PAD.y + 1, z: PAD.z };
    await rcon.command(`setblock ${chest.x} ${chest.y} ${chest.z} chest[facing=west]{Items:[{Slot:0b,id:"minecraft:iron_ingot",count:8},{Slot:1b,id:"minecraft:bread",count:5}]}`);
    const sign = { x: PAD.x - 3, y: PAD.y + 1, z: PAD.z };
    await rcon.command(`setblock ${sign.x} ${sign.y} ${sign.z} oak_sign{front_text:{messages:['"Squad"','"P5"','""','""']}}`);
    for (const name of BOTS) {
      const r = await api('/api/bots/spawn', { by: OWNER, admin: true, name, owners: [OWNER] });
      if (!r.ok) throw new Error(r.text);
    }
    await until(() => BOTS.every((b) => pool.status(b) === 'online'), 60_000, 'both bots online');
    for (const [i, b] of BOTS.entries()) {
      await rcon.command(`clear ${b}`);
      await rcon.command(`tp ${b} ${PAD.x + 0.5} ${PAD.y + 1} ${PAD.z - 2 + i * 4 + 0.5}`);
    }
    await rcon.command(`give ${BOTS[0]} cobblestone 8`);
    await rcon.command(`give ${BOTS[1]} iron_pickaxe`);
    await until(() => BOTS.every((b) => bot(b)?.blockAt(new Vec3(chest.x, chest.y, chest.z))?.name === 'chest'), 20_000, 'the pad in both bots\' worlds');
    await sleep(1_000);
    const a = bot(BOTS[0] as string);
    const b = bot(BOTS[1] as string);

    await check('the sign: its block entity, as the server set it', async () => {
      const blk = a.blockAt(new Vec3(sign.x, sign.y, sign.z)) as unknown as { name: string; blockEntity?: unknown; getSignText?: () => unknown };
      const text = JSON.stringify(blk.getSignText?.() ?? blk.blockEntity);
      if (!/Squad/.test(text) || !/P5/.test(text)) throw new Error(`${blk.name}: ${text}`);
      return `${blk.name}: ${text}`;
    });
    await check('a chest: look in, take, deposit', async () => {
      const before = await checkItemInsideChest(a, chest);
      if (before.iron_ingot !== 8 || before.bread !== 5) throw new Error(`in the chest: ${JSON.stringify(before)}`);
      const taken = await getItemFromChest(a, chest, { iron_ingot: 3 });
      const dep = await depositItemIntoChest(a, chest, { cobblestone: 2 });
      const after = await checkItemInsideChest(b, chest);
      if (after.iron_ingot !== 5 || after.cobblestone !== 2) throw new Error(`after: ${JSON.stringify(after)}`);
      return `before ${JSON.stringify(before)}; taken ${JSON.stringify(taken.taken)}; deposited ${JSON.stringify(dep.deposited)}; b sees ${JSON.stringify(after)}`;
    });
    const spot = { x: PAD.x, y: PAD.y + 1, z: PAD.z + 1 };
    await check('placing: a cobblestone, seen by both bots and by the server', async () => {
      await placeItem(a, 'cobblestone', spot);
      await until(() => block(b, spot) === 'cobblestone', 5_000, 'b to see it');
      if (block(a, spot) !== 'cobblestone' || !(await server(spot, 'cobblestone'))) throw new Error(`a ${block(a, spot)}, server ${await server(spot, 'cobblestone')}`);
      return `a ${block(a, spot)}, b ${block(b, spot)}, server cobblestone`;
    });
    await check('digging: bot.dig resolves on its blockUpdate, air for both bots and the server', async () => {
      const top = { x: PAD.x + 1, y: PAD.y + 1, z: PAD.z + 1 };
      await rcon.command(`setblock ${top.x} ${top.y} ${top.z} dirt`);
      await until(() => block(b, top) === 'dirt' && block(a, top) === 'dirt', 5_000, 'the dirt');
      const t = Date.now();
      await b.dig(b.blockAt(new Vec3(top.x, top.y, top.z)) as never, true);
      const ms = Date.now() - t;
      await until(() => block(a, top) === 'air', 5_000, 'a to see it go');
      if (block(b, top) !== 'air' || !(await server(top, 'air'))) throw new Error(`b ${block(b, top)}`);
      return `dug in ${ms} ms; a ${block(a, top)}, b ${block(b, top)}, server air`;
    });
    await check('mineBlock (collectblock): the placed cobblestone mined and picked up', async () => {
      const r = await mineBlock(b, 'cobblestone', 1, { maxDistance: 8 });
      await until(() => block(a, spot) === 'air', 5_000, 'a to see it go');
      await sleep(1_500);
      const have = b.inventory.items().filter((i) => i.name === 'cobblestone').reduce((s, i) => s + i.count, 0);
      if (r.mined !== 1 || have < 1) throw new Error(`mined ${r.mined}, cobblestone in the inventory ${have}`);
      return `mined ${r.mined} at ${r.at.map(String).join(' ')}; b has ${have} cobblestone`;
    });
    await check('every bot agrees with the server around the pad, no overlay left', async () => {
      await sleep(1_500);
      let bad = 0;
      let n = 0;
      for (let x = PAD.x - 4; x <= PAD.x + 4; x++) {
        for (let z = PAD.z - 4; z <= PAD.z + 4; z++) {
          for (const y of [PAD.y, PAD.y + 1]) {
            n++;
            if (block(a, { x, y, z }) !== block(b, { x, y, z })) bad++;
          }
        }
      }
      const st = rt.world?.stats();
      if (bad > 0 || (SHARED && (st?.shared?.overlay ?? 0) > 0)) throw new Error(`${bad} of ${n} blocks differ; overlay ${st?.shared?.overlay}`);
      return `${n} blocks the same in both bots' worlds${st?.shared ? `; overlay ${st.shared.overlay}, expired ${st.shared.expired}, resyncs ${st.resyncs}` : ''}`;
    });
  } finally {
    for (const name of BOTS) await api('/api/bots/despawn', { by: OWNER, admin: true, name }).catch(() => undefined);
    await rcon.command(`forceload remove ${PAD.x - 16} ${PAD.z - 16} ${PAD.x + 16} ${PAD.z + 16}`).catch(() => undefined);
    await rt.stop();
    rcon.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  log(`${results.length - failed}/${results.length} checks passed (world.shared ${SHARED ? 'on' : 'off'})`);
  process.exit(failed ? 1 : 0);
}

void main().catch((e: unknown) => {
  logger.error('probe', (e as Error).stack ?? String(e));
  process.exit(1);
});
