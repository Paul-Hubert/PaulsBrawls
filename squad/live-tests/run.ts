// The live test (docs/29 §13): the real runtime, real Mineflayer bots on a real server, RCON for ground truth.
// Not part of `npm run check` (it needs a server). Against the dev server:
//
//   ./gradlew runServer                      (run/, port 25599, RCON 25575 — read run/server.properties, R28)
//   cd squad && npm run live-test
//   SERVER_PROPERTIES=../server/server.properties npm run live-test     (the production server)
//
// The ports and the RCON password come from that server.properties (default ../run/server.properties); MC_PORT,
// RCON_PORT, RCON_PASSWORD override them. Only on the dev server (run/) does the test set the time, the gamerules and
// the difficulty; elsewhere it leaves the world as it is (LIVE_SETUP_WORLD=1 forces it).
//
// Scenarios: bots connect; `come` walks them to a point; `gather` mines logs (real collectblock); reclaim per role:
// `follow` holds three bots, `defend` pulls only the archer away and it shoots a husk, then the archer returns to
// `follow`; `/bots stop`; despawn. Evidence goes to live-tests/.runs/<ts>/ (journal, result.json).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig } from '../src/config';
import { start } from '../src/main';
import type { Notice } from '../src/types';
import { Rcon } from './rcon';

const here = fileURLToPath(new URL('.', import.meta.url));
const PROPS_FILE = process.env.SERVER_PROPERTIES ? resolve(process.env.SERVER_PROPERTIES) : resolve(here, '..', '..', 'run', 'server.properties');
const props = Object.fromEntries(
  readFileSync(PROPS_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
) as Record<string, string>;
const MC_PORT = Number(process.env.MC_PORT ?? props['server-port'] ?? 25599);
const RCON_PORT = Number(process.env.RCON_PORT ?? props['rcon.port'] ?? 25575);
const RCON_PASSWORD = process.env.RCON_PASSWORD ?? props['rcon.password'] ?? '';
const SETUP_WORLD = process.env.LIVE_SETUP_WORLD ? process.env.LIVE_SETUP_WORLD === '1' : /[\\/]run[\\/]server\.properties$/.test(PROPS_FILE);
const TOKEN = 'live-test-token';
const PAUL = { uuid: '11111111-1111-1111-1111-111111111111', name: 'Paul' };
const ALICE = { uuid: '22222222-2222-2222-2222-222222222222', name: 'Alice' };
const BOTS = ['LiveArcher', 'LiveBrute', 'LiveMiner'];

const runDir = join(here, '.runs', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(runDir, { recursive: true });

const results: Array<{ scenario: string; ok: boolean; ms: number; detail: string }> = [];
const notices: Notice[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out (${ms / 1000} s) waiting for ${what}`);
    await sleep(250);
  }
}

async function scenario(name: string, fn: () => Promise<string>): Promise<void> {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ scenario: name, ok: true, ms: Date.now() - t, detail });
    console.log(`✔ ${name} (${Math.round((Date.now() - t) / 100) / 10} s) ${detail}`);
  } catch (e) {
    results.push({ scenario: name, ok: false, ms: Date.now() - t, detail: (e as Error).message });
    console.log(`✖ ${name}: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  if (props['enable-rcon'] !== 'true' && !process.env.RCON_PASSWORD) throw new Error(`RCON is off in ${PROPS_FILE} (enable-rcon=true)`);
  const rcon = new Rcon('127.0.0.1', RCON_PORT, RCON_PASSWORD);
  await rcon.connect();
  console.log(`server ${PROPS_FILE} (port ${MC_PORT}); RCON:`, (await rcon.command('list')).trim());
  if (SETUP_WORLD) {
    await rcon.command('time set day');
    await rcon.command('gamerule doDaylightCycle false');
    await rcon.command('gamerule doMobSpawning false');
    await rcon.command('difficulty easy');
  }

  const cfg = parseConfig({ minecraft: { port: MC_PORT }, port: 0, dataDir: join(runDir, 'data'), loginStaggerMs: 1500 }, { PAULSBRAWLS_SQUAD_TOKEN: TOKEN });
  const rt = await start(cfg, { connectBots: true, installGuards: true });
  const { pool, runner } = rt.service.deps;
  runner.on('notice', (n: Notice) => {
    notices.push(n);
    console.log('   notice →', n.to.map((u) => (u === PAUL.uuid ? 'Paul' : u === ALICE.uuid ? 'Alice' : u)).join(','), n.text);
  });
  const api = async (path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${rt.port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    return (await r.json()) as Record<string, unknown> & { ok: boolean; text: string };
  };
  const pos = (name: string) => pool.bot(name)?.entity?.position;
  const snapAt = (p: { x: number; y: number; z: number }) => ({ position: { x: p.x, y: p.y, z: p.z }, yaw: 0, pitch: 0, dimension: 'overworld' });
  const waitNotice = (re: RegExp, ms = 60_000) => until(() => notices.some((n) => re.test(n.text)), ms, `a notice ${re}`);

  try {
    await scenario('bots spawn and connect', async () => {
      for (const name of BOTS) {
        const owners = name === 'LiveMiner' ? [PAUL] : [PAUL, ALICE];
        const r = await api('/api/bots/spawn', { by: PAUL, admin: true, name, owners });
        if (!r.ok) throw new Error(r.text);
      }
      await until(() => BOTS.every((b) => pool.status(b) === 'online'), 60_000, 'all bots online');
      await sleep(1500);
      await rcon.command(`tp ${BOTS[1]} ${BOTS[0]}`);
      await rcon.command(`tp ${BOTS[2]} ${BOTS[0]}`);
      await rcon.command(`give ${BOTS[0]} bow`);
      await rcon.command(`give ${BOTS[0]} arrow 64`);
      await rcon.command(`give ${BOTS[1]} iron_sword`);
      await rcon.command(`give ${BOTS[2]} iron_axe`);
      await sleep(1500);
      const p = pos(BOTS[0]);
      return `at ${p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '?'}`;
    });

    await scenario('gather: a real mineBlock with collectblock picks up logs', async () => {
      const before = pool.bot('LiveMiner')!.inventory.items().filter((i) => i.name.endsWith('_log')).length;
      const r = await api('/api/orders/start', { by: PAUL, command: 'gather', tokens: ['_log', '3'], filters: ['LiveMiner'], snap: snapAt(pos('LiveMiner')!) });
      if (!r.ok) throw new Error(r.text);
      await waitNotice(/« gather » (terminé|a échoué)/, 180_000);
      const n = notices.filter((x) => /« gather »/.test(x.text)).at(-1)!;
      const logs = pool.bot('LiveMiner')!.inventory.items().filter((i) => i.name.endsWith('_log')).reduce((s, i) => s + i.count, 0);
      if (!/terminé/.test(n.text) || logs <= before) throw new Error(`${n.text} (logs in inventory: ${logs})`);
      return `${n.text} (inventory: ${logs} logs)`;
    });

    await scenario('come: every bot walks to the commander', async () => {
      // A spot someone really stands on (the miner, after gather): a synthetic offset can land in leaves (§16).
      const p = pos('LiveMiner')!;
      const target = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
      const r = await api('/api/orders/start', { by: PAUL, command: 'come', tokens: ['range=3'], snap: snapAt(target) });
      if (!r.ok) throw new Error(r.text);
      await waitNotice(/« come » (terminé|a échoué)/);
      const n = notices.find((x) => /« come »/.test(x.text))!;
      if (!/terminé/.test(n.text)) throw new Error(n.text);
      const far = BOTS.filter((b) => (pos(b)?.distanceTo({ x: target.x, y: target.y, z: target.z } as never) ?? 99) > 5);
      if (far.length) throw new Error(`not arrived: ${far.join(', ')} (${n.text})`);
      return n.text;
    });

    await scenario('reclaim per role: defend takes the archer only; it shoots; it returns to follow', async () => {
      const here = pos('LiveArcher')!;
      const f = await api('/api/orders/start', { by: PAUL, command: 'follow', tokens: [], snap: snapAt(here) });
      if (!f.ok) throw new Error(f.text);
      const followId = String(f.orderId);
      await sleep(1000);
      const d = await api('/api/orders/start', { by: ALICE, command: 'defend', tokens: ['radius=24'], snap: snapAt(here) });
      if (!d.ok) throw new Error(d.text);
      const follow = runner.get(followId)!;
      const defend = runner.get(String(d.orderId))!;
      if (defend.memberNames().join() !== 'LiveArcher') throw new Error(`defend got ${defend.memberNames().join()}`);
      if (follow.memberNames().sort().join() !== 'LiveBrute,LiveMiner') throw new Error(`follow kept ${follow.memberNames().join()}`);
      await until(() => notices.some((n) => /Alice a réquisitionné LiveArcher pour « defend »/.test(n.text)), 5_000, 'the reclaim notice');
      // Next to the miner: a spot where a mob can stand (the canopy around spawn is leaves, §16).
      await rcon.command('execute at LiveMiner run summon husk ~2 ~ ~ {PersistenceRequired:1b,NoAI:1b,Health:4f,Tags:["squadlive"]}');
      await sleep(15_000);
      const left = (await rcon.command('kill @e[type=minecraft:husk,tag=squadlive]')).trim();
      const shot = defend.report.logs.join('\n');
      const arrowsLeft = pool.bot('LiveArcher')!.inventory.items().filter((i) => i.name === 'arrow').reduce((s, i) => s + i.count, 0);
      await api('/api/orders/stop', { by: ALICE, target: `#${d.orderId}` });
      await until(() => follow.memberNames().includes('LiveArcher'), 10_000, 'the archer back in follow');
      await api('/api/orders/stop', { by: PAUL, target: 'all' });
      if (arrowsLeft >= 64) throw new Error(`the archer never shot (arrows ${arrowsLeft}; husk: ${left}; log: ${shot.slice(0, 300)})`);
      return `arrows left ${arrowsLeft}; after 15 s: "${left}"; archer returned to follow`;
    });

    await scenario('despawn: bots leave and the roster is empty', async () => {
      for (const b of BOTS) {
        const r = await api('/api/bots/despawn', { by: PAUL, admin: true, name: b });
        if (!r.ok) throw new Error(r.text);
      }
      await sleep(2000);
      const list = (await rcon.command('list')).trim();
      if (BOTS.some((b) => list.includes(b))) throw new Error(`still connected: ${list}`);
      return list;
    });
  } finally {
    writeFileSync(join(runDir, 'result.json'), JSON.stringify({ results, notices }, null, 2));
    await rt.stop();
    rcon.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios passed — evidence in ${runDir}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('live test crashed:', e);
  process.exit(2);
});
