// The live test (docs/29 §13): the real runtime, real Mineflayer bots on a real server, RCON for ground truth.
// Not part of `npm run check` (it needs a server). Against the dev server:
//
//   ./gradlew runServer                      (run/, port 25599, RCON 25575 — read run/server.properties, R28)
//   cd squad && npm run live-test
//   SERVER_PROPERTIES=../server/server.properties npm run live-test     (the production server)
//
// The ports and the RCON password come from that server.properties (default ../run/server.properties); MC_PORT,
// RCON_PORT, RCON_PASSWORD override them. Only on the dev server (run/) does the test set the time, the gamerules and
// the difficulty; elsewhere it leaves the world as it is (LIVE_SETUP_WORLD=1 forces it). LIVE_ONLY=core runs only the
// first group below, LIVE_ONLY=items only the second. The runtime listens on LIVE_RUNTIME_PORT (default 0: any free
// port).
//
// Core scenarios (on the dev world they start from a camp the test lays at 1100,100,1000: grass, two oaks, clean
// kits): bots connect; `come` walks them to a point; `gather` mines logs (real collectblock); reclaim per role:
// `follow` holds three bots, `defend` pulls only the archer away and it shoots a husk, then the archer returns to
// `follow`; `/bots stop`; on the dev world, a ladder it builds: a bot follows the archer up it with `follow`, then with
// `defend`; despawn.
//
// Bound-item scenarios (items.ts, docs/29 §5.4; dev world only, on an arena laid at 1200,100,1000): a captain
// (LiveCaptain, a plain mineflayer client, not in the roster) owns three guards (sword, off-hand shield) and two
// archers. `mur-de-boucliers` from /api/orders/trigger: the wall across yaw 90 (RCON Pos and Rotation, shields up as
// the captain's client sees them; one guard's shield starts in its inventory, so raiseShield equips it), a second
// click delivered to the same order re-forms it across yaw 0, a husk in front of it is fought and the line re-forms,
// the stop lowers the shields. Through the mod (needs run/squad.properties
// → http://127.0.0.1:8779 and LIVE_RUNTIME_PORT=8779, else skipped): `/bots orders bind mur-de-boucliers` puts
// custom_data.squad, a lore line and the glint on the held shield; a right-click starts the order, a second one
// re-forms it, sneak + right-click stops it, unbind removes it all; `/bots orders bind tir` on a bow, real shots: at
// the ground, arrow-release starts `tir`, arrow-hit (onBlockHit) reaches it, the archers fire exactly 3 arrows each
// around the hit; at a husk, arrow-hit names it (onEntityHit) and the archers kill it. `epee` at a NoAI husk (archers
// shoot, at most 2 guards on it, it dies), then at the ground (the bots hold around it); `ligne-archers` (a line across
// the view, 4 short of the point); a guard reclaimed from `defend` by a wall goes back to `defend` when the wall stops
// and follows the captain again.
//
// Evidence goes to live-tests/.runs/<ts>/ (journal, result.json).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pathfinderPkg from 'mineflayer-pathfinder';

import { parseConfig } from '../src/config';
import { start } from '../src/main';
import type { Notice } from '../src/types';
import { itemScenarios } from './items';
import { Rcon } from './rcon';

const { goals } = pathfinderPkg;

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
const RUNTIME_PORT = Number(process.env.LIVE_RUNTIME_PORT ?? 0);
const ONLY = process.env.LIVE_ONLY ?? '';
if (!['', 'core', 'items'].includes(ONLY)) throw new Error(`LIVE_ONLY=${ONLY}: expected core or items`);
const PAUL = { uuid: '11111111-1111-1111-1111-111111111111', name: 'Paul' };
const ALICE = { uuid: '22222222-2222-2222-2222-222222222222', name: 'Alice' };
const BOTS = ['LiveArcher', 'LiveBrute', 'LiveMiner'];
/** The core scenarios' camp on the dev world: grass at y 100 (feet at 101), two oaks, 100 blocks from the ladder. */
const CAMP = { x: 1100, y: 100, z: 1000 };

const runDir = join(here, '.runs', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(runDir, { recursive: true });

const results: Array<{ scenario: string; ok: boolean; ms: number; detail: string }> = [];
const notices: Notice[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

  // LIVE_PATH_WORKERS=N runs the same scenarios with the pathfinding worker pool (docs/32 D).
  const pathfinding = { workers: Number(process.env.LIVE_PATH_WORKERS ?? 0) };
  const cfg = parseConfig({ minecraft: { port: MC_PORT }, port: RUNTIME_PORT, dataDir: join(runDir, 'data'), loginStaggerMs: 1500, pathfinding }, { PAULSBRAWLS_SQUAD_TOKEN: TOKEN });
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
    if (ONLY !== 'items') {
      await scenario('bots spawn and connect', async () => {
        // On the dev world the bots start from a camp the test lays itself: a bot logs in where it last stood, and
        // runs had left the archer at the bottom of a pond, where it drowned with its kit (docs/29 §16).
        if (SETUP_WORLD) {
          await rcon.command(`forceload add ${CAMP.x - 16} ${CAMP.z - 16} ${CAMP.x + 16} ${CAMP.z + 16}`);
          await rcon.command(`fill ${CAMP.x - 12} ${CAMP.y - 1} ${CAMP.z - 12} ${CAMP.x + 12} ${CAMP.y - 1} ${CAMP.z + 12} dirt`);
          await rcon.command(`fill ${CAMP.x - 12} ${CAMP.y} ${CAMP.z - 12} ${CAMP.x + 12} ${CAMP.y} ${CAMP.z + 12} grass_block`);
          await rcon.command(`fill ${CAMP.x - 12} ${CAMP.y + 1} ${CAMP.z - 12} ${CAMP.x + 12} ${CAMP.y + 14} ${CAMP.z + 12} air`);
          await rcon.command(`kill @e[type=!minecraft:player,x=${CAMP.x - 14},y=${CAMP.y - 4},z=${CAMP.z - 14},dx=28,dy=24,dz=28]`);
          // Two oaks for `gather`: a 5-log trunk under persistent leaves.
          for (const dx of [-5, 5]) {
            const x = CAMP.x + dx;
            const z = CAMP.z + 5;
            await rcon.command(`fill ${x - 2} ${CAMP.y + 4} ${z - 2} ${x + 2} ${CAMP.y + 6} ${z + 2} oak_leaves[persistent=true]`);
            await rcon.command(`fill ${x} ${CAMP.y + 1} ${z} ${x} ${CAMP.y + 5} ${z} oak_log`);
          }
        }
        for (const name of BOTS) {
          const owners = name === 'LiveMiner' ? [PAUL] : [PAUL, ALICE];
          const r = await api('/api/bots/spawn', { by: PAUL, admin: true, name, owners });
          if (!r.ok) throw new Error(r.text);
        }
        await until(() => BOTS.every((b) => pool.status(b) === 'online'), 60_000, 'all bots online');
        await sleep(1500);
        if (SETUP_WORLD) {
          await rcon.command(`tp ${BOTS[0]} ${CAMP.x + 0.5} ${CAMP.y + 1} ${CAMP.z - 4.5}`);
          // Clean kits: items picked up in earlier runs (another bot's bow) change who the roles select.
          for (const b of BOTS) await rcon.command(`clear ${b}`);
        }
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
        // Counted before the husk appears: the archer keeps its arrows from earlier runs (its player data persists), so
        // "fewer than one stack" is not a shot.
        const arrows = (): number => pool.bot('LiveArcher')!.inventory.items().filter((i) => i.name === 'arrow').reduce((s, i) => s + i.count, 0);
        const arrowsBefore = arrows();
        // Next to the miner: a spot where a mob can stand (the canopy around spawn is leaves, §16).
        await rcon.command('execute at LiveMiner run summon husk ~2 ~ ~ {PersistenceRequired:1b,NoAI:1b,Health:4f,Tags:["squadlive"]}');
        await sleep(15_000);
        const left = (await rcon.command('kill @e[type=minecraft:husk,tag=squadlive]')).trim();
        const shot = defend.report.logs.join('\n');
        const arrowsLeft = arrows();
        await api('/api/orders/stop', { by: ALICE, target: `#${d.orderId}` });
        await until(() => follow.memberNames().includes('LiveArcher'), 10_000, 'the archer back in follow');
        await api('/api/orders/stop', { by: PAUL, target: 'all' });
        if (arrowsLeft >= arrowsBefore) throw new Error(`the archer never shot (arrows ${arrowsBefore} → ${arrowsLeft}; husk: ${left}; log: ${shot.slice(0, 300)})`);
        return `arrows ${arrowsBefore} → ${arrowsLeft}; after 15 s: "${left}"; archer returned to follow`;
      });

      // A ladder the scenario builds itself, high above the dev world (never elsewhere): an 8-block pillar with a ladder on
      // its south face and a platform on top. LiveArcher climbs it; LiveClimber, owned by a player named after the
      // archer (so the archer is the commander the order follows), comes after it with `follow`, then with `defend`
      // (its own slot around the commander, docs/29 §16).
      const LEADER = { uuid: '44444444-4444-4444-4444-444444444444', name: 'LiveArcher' };
      const L = { x: 1000, y: 100, z: 1000 };
      const climbScenario = (command: 'follow' | 'defend', detail: string) =>
        scenario(`ladder: a bot ${detail}`, async () => {
          if (!SETUP_WORLD) return 'skipped (it builds on the dev world only)';
          const top = { x: L.x, y: L.y + 9, z: L.z - 2 };
          await rcon.command(`forceload add ${L.x - 16} ${L.z - 16} ${L.x + 16} ${L.z + 16}`);
          await rcon.command(`fill ${L.x - 10} ${L.y} ${L.z - 10} ${L.x + 10} ${L.y} ${L.z + 12} stone`);
          await rcon.command(`fill ${L.x - 10} ${L.y + 1} ${L.z - 10} ${L.x + 10} ${L.y + 12} ${L.z + 12} air`);
          await rcon.command(`fill ${L.x - 1} ${L.y + 1} ${L.z - 1} ${L.x + 1} ${L.y + 8} ${L.z + 1} stone`);
          await rcon.command(`fill ${L.x - 3} ${L.y + 8} ${L.z - 3} ${L.x + 3} ${L.y + 8} ${L.z + 1} stone`);
          await rcon.command(`fill ${L.x} ${L.y + 1} ${L.z + 2} ${L.x} ${L.y + 8} ${L.z + 2} minecraft:ladder[facing=south]`);
          if (pool.status('LiveClimber') !== 'online') {
            const r = await api('/api/bots/spawn', { by: PAUL, admin: true, name: 'LiveClimber', owners: [LEADER] });
            if (!r.ok) throw new Error(r.text);
            await until(() => pool.status('LiveClimber') === 'online', 60_000, 'LiveClimber online');
            await sleep(1500);
          }
          // Put back where it was afterwards: a bot logs in again where it left (its player data), and `gather` needs trees.
          const home = pool.bot('LiveArcher')!.entity.position.clone();
          await rcon.command(`tp LiveArcher ${L.x - 0.5} ${L.y + 1} ${L.z + 8.5}`);
          await rcon.command(`tp LiveClimber ${L.x + 1.5} ${L.y + 1} ${L.z + 8.5}`);
          await sleep(2000);
          const archer = pool.bot('LiveArcher')!;
          const r = await api('/api/orders/start', { by: LEADER, command, tokens: [], snap: snapAt(archer.entity.position) });
          if (!r.ok) throw new Error(r.text);
          try {
            await sleep(2000);
            await archer.pathfinder.goto(new goals.GoalBlock(top.x, top.y, top.z));
            const climber = (): number => pool.bot('LiveClimber')?.entity?.position?.y ?? 0;
            await until(() => climber() >= top.y - 0.01, 30_000, `LiveClimber up the ladder (at y ${climber().toFixed(2)})`);
            // Up there it stays: a path that ended over the top of the ladder let it slide back down (§16).
            await sleep(4000);
            const p = pool.bot('LiveClimber')!.entity.position;
            if (p.y < top.y - 0.01) throw new Error(`LiveClimber slid back down to y ${p.y.toFixed(2)}`);
            const ladder = (await rcon.command(`execute if block ${L.x} ${L.y + 5} ${L.z + 2} minecraft:ladder`)).trim();
            if (!/passed/.test(ladder)) throw new Error(`the ladder was broken: ${ladder}`);
            return `LiveClimber at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}, ${p.distanceTo(archer.entity.position).toFixed(1)} from the archer; ladder intact`;
          } finally {
            await api('/api/orders/stop', { by: LEADER, target: 'all' });
            await rcon.command(`tp LiveArcher ${home.x} ${home.y} ${home.z}`);
            await rcon.command(`tp LiveClimber ${home.x} ${home.y} ${home.z}`);
          }
        });
      await climbScenario('follow', 'follows up a ladder');
      await climbScenario('defend', 'defending the commander follows them up a ladder');
      if (pool.status('LiveClimber') === 'online') await api('/api/bots/despawn', { by: PAUL, admin: true, name: 'LiveClimber' });
      if (SETUP_WORLD) await rcon.command(`forceload remove ${L.x - 16} ${L.z - 16} ${L.x + 16} ${L.z + 16}`);
      if (SETUP_WORLD) await rcon.command(`forceload remove ${CAMP.x - 16} ${CAMP.z - 16} ${CAMP.x + 16} ${CAMP.z + 16}`);

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
    }

    if (ONLY !== 'core') {
      await itemScenarios({ rcon, rt, mcPort: MC_PORT, setupWorld: SETUP_WORLD, notices, api, scenario, until, sleep, admin: PAUL });
    }
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
