// Live check of the paced logins and kits (docs/36 §6): the real runtime in process, a captain (a plain mineflayer
// client, not in the roster) on the dev server, and through the dev mod `/bots squad spawn guard N` then
// `/bots squad spawn archer N` back to back (RCON `execute as` the captain). From the runtime's side it records when
// each bot came online and when its kit (sword or bow) reached its inventory, and prints the gaps: logins should be at
// least loginStaggerMs apart, kits about kitStaggerMs apart (the server gives them on its ticks, so 50-150 ms for
// 100). Then it despawns the squad.
//
//   ./gradlew runDevServer        (dev/squad.properties: enabled=true, url=http\://127.0.0.1\:8779, token=live-test-token)
//   cd squad && npx tsx live-tests/probe-stagger.ts          PROBE_N=10, PROBE_PORT=8779, SERVER_PROPERTIES=…

import { mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import mineflayer, { type Bot } from 'mineflayer';

import { parseConfig } from '../src/config';
import { start } from '../src/main';
import { logger } from '../src/logger';
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
if (MC_PORT === 25565) throw new Error('refusing the production server: use the dev server (dev/)');
const N = Number(process.env.PROBE_N ?? 10);
const PORT = Number(process.env.PROBE_PORT ?? 8779);
const CAPTAIN = 'LiveCaptain';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (line: string): void => logger.info('probe', line);

async function main(): Promise<void> {
  const rcon = new Rcon('127.0.0.1', Number(props['rcon.port'] ?? 25576), props['rcon.password'] ?? '');
  await rcon.connect();
  const cfg = parseConfig({ minecraft: { port: MC_PORT }, port: PORT, dataDir: mkdtempSync(join(tmpdir(), 'probe-stagger-')) }, { PAULSBRAWLS_SQUAD_TOKEN: 'live-test-token' });
  const rt = await start(cfg, { connectBots: true, installGuards: true });
  const { pool } = rt.service.deps;
  const online = new Map<string, number>();
  const kitted = new Map<string, number>();
  pool.on('online', (name: string, bot: Bot) => {
    if (!online.has(name)) online.set(name, Date.now());
    // The kit's weapon in the inventory, seen from the bot (polled: updateSlot fires for every slot of the kit).
    const t = setInterval(() => {
      if (bot.inventory.items().some((i) => i.name === 'iron_sword' || i.name === 'bow')) {
        if (!kitted.has(name)) kitted.set(name, Date.now());
        clearInterval(t);
      }
    }, 5);
  });
  let captain: Bot | undefined;
  try {
    const clients = (): number => (rt.http as unknown as { clients: Set<unknown> }).clients.size;
    for (let i = 0; clients() === 0; i++) {
      if (i > 90) throw new Error(`the dev mod did not connect to :${PORT} (dev/squad.properties)`);
      await sleep(500);
    }
    captain = mineflayer.createBot({ host: '127.0.0.1', port: MC_PORT, username: CAPTAIN, version: '1.21.1', viewDistance: 'short' });
    captain.on('error', () => undefined);
    await new Promise<void>((r) => captain!.once('spawn', () => r()));
    await sleep(3_000);
    log(`loginStaggerMs ${cfg.loginStaggerMs}; spawning ${N} guards and ${N} archers around ${CAPTAIN}`);
    for (const kit of ['guard', 'archer']) log((await rcon.command(`execute as ${CAPTAIN} run bots squad spawn ${kit} ${N}`)).trim() || `(squad spawn ${kit} sent)`);
    for (let i = 0; kitted.size < 2 * N; i++) {
      if (i > 600) throw new Error(`only ${online.size} online, ${kitted.size} kitted after 60 s`);
      await sleep(100);
    }
    const report = (what: string, m: Map<string, number>): void => {
      const ts = [...m.entries()].sort((a, b) => a[1] - b[1]);
      const gaps = ts.slice(1).map(([, t], i) => t - (ts[i] as [string, number])[1]);
      const sorted = [...gaps].sort((a, b) => a - b);
      const mean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
      log(`${what}: ${ts.length} over ${((ts.at(-1)![1] - ts[0]![1]) / 1000).toFixed(2)} s; gaps min ${sorted[0]} / median ${sorted[Math.floor(sorted.length / 2)]} / max ${sorted.at(-1)} / mean ${mean.toFixed(0)} ms`);
      log(`  ${ts.map(([n, t]) => `${n}+${t - ts[0]![1]}`).join(' ')}`);
    };
    report('logins', online);
    report('kits', kitted);
  } finally {
    for (const kit of ['guard', 'archer']) await rcon.command(`execute as ${CAPTAIN} run bots squad despawn ${kit}`).catch(() => undefined);
    await sleep(2_000);
    captain?.quit();
    await rt.stop();
    rcon.close();
  }
  process.exit(0);
}

main().catch((e) => {
  logger.error('probe', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(2);
});
