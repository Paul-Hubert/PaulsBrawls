// Live probe of the horse archers' orbit (docs/47): five horse archers of a captain who is not online, on a stone floor
// the probe lays at y 100 on the dev server (dev-26.1.2/, ./gradlew runDevServer, port 25602, RCON 25579), `attack` a
// group of husks and skeletons (200 hp each, so the fight lasts) for SECONDS, twice: circling (the default) and
// standing (`orbit=0 approach=40`, what `attack` did before). Each pass starts from the same place 45 blocks south of
// the group, with fresh mobs and healed bots. It prints, per pass: the radius held round the group's centre (median
// and the 10–90 % range, after the first 10 s), shots released, shots per minute, the damage the mobs took (their
// health lost, read over RCON), and the damage the riders and their horses took.
//   npx tsx live-tests/probe-orbit.ts       (MC_PORT, RCON_PORT, RCON_PASSWORD override the dev server's; SECONDS=45;
//                                            PASSES=orbit,still)

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

import { aimStats } from '../src/aim/draw';
import { parseConfig } from '../src/config';
import { start } from '../src/main';
import { offlineUuid } from './items';
import { Rcon } from './rcon';

const MC_PORT = Number(process.env.MC_PORT ?? 25602);
const TOKEN = 'probe-orbit';
const SECONDS = Number(process.env.SECONDS ?? 45);
const PASSES = (process.env.PASSES ?? 'orbit,still').split(',');
const CAPTAIN = { uuid: offlineUuid('OrbitProbeCapt'), name: 'OrbitProbeCapt' };
const ADMIN = { uuid: offlineUuid('OrbitProbeAdmin'), name: 'OrbitProbeAdmin' };
const RIDERS = Array.from({ length: 5 }, (_, i) => `OPHac${i + 1}`);
/** The floor: 141×141 stone at y 100 (feet at 101); the mobs' group at its centre. */
const A = { x: 2400, y: 100, z: 2400 };
const C = new Vec3(A.x + 0.5, A.y + 1, A.z + 0.5);
const HALF = 70;
const MOB_TAG = 'probe_orbit_mob';
const HORSE_TAG = 'probe_orbit_horse';
const MOBS = ['husk', 'husk', 'husk', 'husk', 'skeleton', 'skeleton', 'skeleton'];

const rcon = new Rcon('127.0.0.1', Number(process.env.RCON_PORT ?? 25579), process.env.RCON_PASSWORD ?? 'paulsbrawls-eval');
await rcon.connect();
const run = (c: string): Promise<string> => rcon.command(c);
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const floats = (s: string): number[] => [...s.matchAll(/(-?\d+(?:\.\d+)?(?:E-?\d+)?)[dfF]/g)].map((m) => Number(m[1]));
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : NaN;
};

const cfg = parseConfig({ minecraft: { port: MC_PORT, version: '26.1.2' }, port: 0, dataDir: mkdtempSync(join(tmpdir(), 'probe-orbit-')), loginStaggerMs: 400 }, { PAULSBRAWLS_SQUAD_TOKEN: TOKEN });
const rt = await start(cfg, { connectBots: true, installGuards: true });
const { pool } = rt.service.deps;
const api = async (path: string, body: unknown): Promise<Record<string, unknown> & { ok: boolean; text: string }> => {
  const r = await fetch(`http://127.0.0.1:${rt.port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  return (await r.json()) as Record<string, unknown> & { ok: boolean; text: string };
};
const until = async (cond: () => boolean, ms: number, what: string): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
};
/** The sum of the Health of every entity matching `selector` (RCON, one by one). */
const healthOf = async (selector: string, n: number): Promise<number> => {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = await run(`data get entity @e[${selector},limit=1,sort=nearest,x=${C.x},y=${C.y},z=${C.z},tag=!probe_counted] Health`);
    const v = floats(s)[0];
    if (v === undefined) break;
    sum += v;
    await run(`tag @e[${selector},limit=1,sort=nearest,x=${C.x},y=${C.y},z=${C.z},tag=!probe_counted] add probe_counted`);
  }
  await run(`tag @e[${selector}] remove probe_counted`);
  return sum;
};
const mobs = (b: Bot): Array<{ id: number; name: string; position: Vec3 }> =>
  Object.values(b.entities).filter((e) => e && (e.name === 'husk' || e.name === 'skeleton') && e.position.distanceTo(C) < 40) as never;

let code = 0;
try {
  await run(`forceload add ${A.x - HALF - 8} ${A.z - HALF - 8} ${A.x + HALF + 8} ${A.z + HALF + 8}`);
  await run(`fill ${A.x - HALF} ${A.y} ${A.z - HALF} ${A.x + HALF} ${A.y} ${A.z + HALF} minecraft:stone`);
  for (let dy = 1; dy <= 6; dy += 3) await run(`fill ${A.x - HALF} ${A.y + dy} ${A.z - HALF} ${A.x + HALF} ${A.y + dy + 2} ${A.z + HALF} minecraft:air`);
  await run(`kill @e[type=!minecraft:player,x=${A.x - HALF - 1},y=${A.y - 2},z=${A.z - HALF - 1},dx=${2 * HALF + 2},dy=12,dz=${2 * HALF + 2}]`);
  for (const name of RIDERS) {
    const r = await api('/api/bots/spawn', { by: ADMIN, admin: true, name, owners: [CAPTAIN] });
    if (!r.ok && !/existe déjà|already/.test(r.text)) throw new Error(r.text);
  }
  await until(() => RIDERS.every((b) => pool.status(b) === 'online'), 120_000, 'all bots online');
  await sleep(1500);
  await run('gamerule doMobSpawning false');
  await run('time set midnight');

  const rows: string[] = [];
  for (const pass of PASSES) {
    // The riders: healed, re-armed, each on a fresh horse, in a row 45 blocks south of the group, facing it.
    await run(`kill @e[type=horse,tag=${HORSE_TAG}]`);
    await run(`kill @e[tag=${MOB_TAG}]`);
    await run(`kill @e[type=arrow,x=${A.x - HALF},y=${A.y - 2},z=${A.z - HALF},dx=${2 * HALF},dy=20,dz=${2 * HALF}]`);
    for (const [i, name] of RIDERS.entries()) {
      const x = C.x + (i - 2) * 3;
      const z = C.z + 45;
      await run(`clear ${name}`);
      await run(`give ${name} bow`);
      await run(`give ${name} arrow 128`);
      await run(`effect give ${name} minecraft:instant_health 1 10`);
      await run(`tp ${name} ${x} ${C.y} ${z} 180 0`);
      await run(`execute at ${name} run summon minecraft:horse ~ ~ ~ {Tame:1b,Tags:["${HORSE_TAG}"],attributes:[{id:"minecraft:movement_speed",base:0.225d},{id:"minecraft:max_health",base:30d}],Health:30f}`);
      await run(`item replace entity @e[type=horse,tag=${HORSE_TAG},limit=1,sort=nearest,x=${x},y=${C.y},z=${z}] saddle with minecraft:saddle`);
      await run(`ride ${name} mount @e[type=horse,tag=${HORSE_TAG},limit=1,sort=nearest,x=${x},y=${C.y},z=${z}]`);
    }
    // The group: husks and skeletons round the centre, 200 hp each.
    for (const [i, kind] of MOBS.entries()) {
      const a = (2 * Math.PI * i) / MOBS.length;
      await run(`summon minecraft:${kind} ${(C.x + Math.cos(a) * 3).toFixed(1)} ${C.y} ${(C.z + Math.sin(a) * 3).toFixed(1)} {Tags:["${MOB_TAG}"],PersistenceRequired:1b,attributes:[{id:"minecraft:max_health",base:200d}],Health:200f}`);
    }
    await sleep(3000);
    const riding = RIDERS.filter((n) => (pool.bot(n) as unknown as { vehicle?: { name?: string } | null })?.vehicle?.name === 'horse').length;
    const mobsBefore = await healthOf(`tag=${MOB_TAG}`, MOBS.length);
    const horsesBefore = await healthOf(`type=horse,tag=${HORSE_TAG}`, RIDERS.length);
    const seer = pool.bot(RIDERS[0]!)!;
    const first = mobs(seer).sort((a, b) => a.position.distanceTo(seer.entity.position) - b.position.distanceTo(seer.entity.position))[0];
    if (!first) throw new Error('no mob in sight');
    const snap = {
      position: { x: C.x, y: C.y, z: C.z + 47 },
      yaw: 180,
      pitch: 0,
      dimension: 'overworld',
      heldItem: 'bow',
      lookBlock: null,
      lookEntity: { id: first.id, name: first.name, type: 'mob', position: { x: first.position.x, y: first.position.y, z: first.position.z } },
      trigger: { kind: 'use', item: 'bow' },
    };
    aimStats(true);
    const tokens = [`seconds=${SECONDS}`, ...(pass === 'still' ? ['orbit=0', 'approach=40'] : [])];
    const t0 = Date.now();
    const r = await api('/api/orders/trigger', { by: CAPTAIN, command: 'attack', tokens, filters: [], snap });
    if (!r.ok) throw new Error(`attack: ${r.text}`);
    const radii: number[] = [];
    let ridersLost = 0;
    const last = new Map(RIDERS.map((n) => [n, pool.bot(n)?.health ?? 20]));
    while (Date.now() - t0 < (SECONDS + 2) * 1000) {
      const now = Date.now();
      const ms = mobs(seer);
      const centre = ms.length ? ms.reduce((c, m) => c.plus(m.position), new Vec3(0, 0, 0)).scaled(1 / ms.length) : C;
      for (const n of RIDERS) {
        const b = pool.bot(n);
        if (!b?.entity) continue;
        if (now - t0 > 10_000) radii.push(Math.hypot(b.entity.position.x - centre.x, b.entity.position.z - centre.z));
        const h = b.health ?? 20;
        if (h < last.get(n)!) ridersLost += last.get(n)! - h;
        last.set(n, h);
      }
      await sleep(250);
    }
    const st = aimStats(true);
    const mobsAfter = await healthOf(`tag=${MOB_TAG}`, MOBS.length);
    const horsesAfter = await healthOf(`type=horse,tag=${HORSE_TAG}`, RIDERS.length);
    rows.push(
      `${pass.padEnd(6)} riding ${riding}/5 · radius median ${pct(radii, 50).toFixed(1)} (10–90 %: ${pct(radii, 10).toFixed(1)}–${pct(radii, 90).toFixed(1)}) · ` +
        `shots ${st.released} (${((st.released * 60) / SECONDS / RIDERS.length).toFixed(1)}/min per rider) · damage dealt ${(mobsBefore - mobsAfter).toFixed(0)} · ` +
        `taken: riders ${ridersLost.toFixed(0)}, horses ${(horsesBefore - horsesAfter).toFixed(0)}`,
    );
    console.log(rows.at(-1));
    await sleep(3000);
  }
  console.log(`\n[probe-orbit] ${SECONDS} s per pass, 5 horse archers v 4 husks + 3 skeletons (200 hp each):\n${rows.join('\n')}`);
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await run(`kill @e[type=horse,tag=${HORSE_TAG}]`).catch(() => '');
  await run(`kill @e[tag=${MOB_TAG}]`).catch(() => '');
  for (const n of RIDERS) await api('/api/bots/despawn', { by: ADMIN, admin: true, name: n }).catch(() => undefined);
  await rt.stop();
  rcon.close();
}
process.exit(code);
