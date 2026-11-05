// Live probe of `line`'s approach to its slots (docs/43 B): ten guards (sword, shield) and ten archers (bow, arrows) of
// a captain who is not online, on a stone floor the probe lays at y 100 on the dev server (dev-26.1.2/, ./gradlew
// runDevServer, port 25602, RCON 25579). For each yaw (0, 45, 87), on foot then mounted (each bot on a saddled horse of
// speed 0.225), the bots start in a block 14 blocks behind the point, the probe posts the click the mod would send,
// and reads each bot's position every 50 ms (its own client) until every bot has stood still for 3 s or 40 s passed.
// It prints the time from the click to the last bot's last movement, and each bot's final offset from the nearest exact
// slot (lineSlots, as `line` computes them), read back over RCON (the server's Pos: the horse's, for a rider).
//   npx tsx live-tests/probe-line.ts        (MC_PORT, RCON_PORT, RCON_PASSWORD override the dev server's; YAWS=0,45;
//                                            MODES=foot,mounted; LABEL=before prints with that label)

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Vec3 } from 'vec3';

import { lineSlots, lookDir } from '../src/api/helpers';
import { parseConfig } from '../src/config';
import { start } from '../src/main';
import { offlineUuid } from './items';
import { Rcon } from './rcon';

const MC_PORT = Number(process.env.MC_PORT ?? 25602);
const TOKEN = 'probe-line';
const YAWS = (process.env.YAWS ?? '0,45,87').split(',').map(Number);
const MODES = (process.env.MODES ?? 'foot,mounted').split(',');
const LABEL = process.env.LABEL ?? '';
const CAPTAIN = { uuid: offlineUuid('LineProbeCapt'), name: 'LineProbeCapt' };
const GUARDS = Array.from({ length: 10 }, (_, i) => `LPGuard${String(i + 1).padStart(2, '0')}`);
const ARCHERS = Array.from({ length: 10 }, (_, i) => `LPArcher${String(i + 1).padStart(2, '0')}`);
const ALL = [...GUARDS, ...ARCHERS];
/** The floor: 81×81 stone at y 100 (feet at 101). */
const A = { x: 1600, y: 100, z: 1600 };
const C = { x: A.x + 0.5, y: A.y + 1, z: A.z + 0.5 };
/** The point the line forms on: this many blocks ahead of the captain. */
const AHEAD = 14;
const TAG = 'probe_line_horse';

const rcon = new Rcon('127.0.0.1', Number(process.env.RCON_PORT ?? 25579), process.env.RCON_PASSWORD ?? 'paulsbrawls-eval');
await rcon.connect();
const run = (c: string): Promise<string> => rcon.command(c);
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const floats = (s: string): number[] => [...s.matchAll(/(-?\d+(?:\.\d+)?(?:E-?\d+)?)[dfF]/g)].map((m) => Number(m[1]));

const cfg = parseConfig({ minecraft: { port: MC_PORT, version: '26.1.2' }, port: 0, dataDir: mkdtempSync(join(tmpdir(), 'probe-line-')), loginStaggerMs: 400 }, { PAULSBRAWLS_SQUAD_TOKEN: TOKEN });
const rt = await start(cfg, { connectBots: true, installGuards: true });
const { pool, runner } = rt.service.deps;
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

const ADMIN = { uuid: offlineUuid('LineProbeAdmin'), name: 'LineProbeAdmin' };
let code = 0;
try {
  await run(`forceload add ${A.x - 48} ${A.z - 48} ${A.x + 48} ${A.z + 48}`);
  await run(`fill ${A.x - 40} ${A.y} ${A.z - 40} ${A.x + 40} ${A.y} ${A.z + 40} minecraft:stone`);
  for (let dy = 1; dy <= 6; dy += 3) await run(`fill ${A.x - 40} ${A.y + dy} ${A.z - 40} ${A.x + 40} ${A.y + dy + 2} ${A.z + 40} minecraft:air`);
  await run(`kill @e[type=!minecraft:player,x=${A.x - 41},y=${A.y - 2},z=${A.z - 41},dx=82,dy=12,dz=82]`);
  for (const name of ALL) {
    const r = await api('/api/bots/spawn', { by: ADMIN, admin: true, name, owners: [CAPTAIN] });
    if (!r.ok && !/existe déjà|already/.test(r.text)) throw new Error(r.text);
  }
  await until(() => ALL.every((b) => pool.status(b) === 'online'), 120_000, 'all bots online');
  await sleep(1500);
  for (const g of GUARDS) {
    await run(`clear ${g}`);
    await run(`give ${g} iron_sword`);
    await run(`item replace entity ${g} weapon.offhand with minecraft:shield`);
  }
  for (const a of ARCHERS) {
    await run(`clear ${a}`);
    await run(`give ${a} bow`);
    await run(`give ${a} arrow 64`);
  }
  await run('gamerule doMobSpawning false');
  await run('time set day');
  await sleep(1000);

  const results: string[] = [];
  for (const mode of MODES) {
    for (const yaw of YAWS) {
      const fwd = lookDir(yaw);
      const right = lookDir(yaw + 90);
      // The start: a 5×4 block of bots, 2 apart, centred 2 blocks behind the captain (the point is AHEAD in front).
      await run(`kill @e[type=horse,tag=${TAG}]`);
      for (const [i, name] of ALL.entries()) {
        const col = (i % 5) - 2;
        const row = Math.floor(i / 5);
        const x = C.x - fwd.x * (2 + row * 2) + right.x * col * 2;
        const z = C.z - fwd.z * (2 + row * 2) + right.z * col * 2;
        await run(`tp ${name} ${x.toFixed(2)} ${C.y} ${z.toFixed(2)} ${yaw} 0`);
        if (mode === 'mounted') {
          await run(`execute at ${name} run summon minecraft:horse ~ ~ ~ {Tame:1b,Tags:["${TAG}"],attributes:[{id:"minecraft:movement_speed",base:0.225d}]}`);
          await run(`item replace entity @e[type=horse,tag=${TAG},limit=1,sort=nearest,x=${x.toFixed(2)},y=${C.y},z=${z.toFixed(2)}] saddle with minecraft:saddle`);
          await run(`ride ${name} mount @e[type=horse,tag=${TAG},limit=1,sort=nearest,x=${x.toFixed(2)},y=${C.y},z=${z.toFixed(2)}]`);
        }
      }
      await sleep(2500);
      if (mode === 'mounted') {
        const riding = ALL.filter((n) => (pool.bot(n) as unknown as { vehicle?: { name?: string } | null })?.vehicle?.name === 'horse').length;
        if (riding < ALL.length) console.log(`  (only ${riding}/${ALL.length} riding)`);
      }
      const point = new Vec3(Math.floor(C.x + fwd.x * AHEAD) + 0.5, A.y + 1, Math.floor(C.z + fwd.z * AHEAD) + 0.5);
      const snap = {
        position: { x: C.x, y: C.y, z: C.z },
        yaw,
        pitch: 20,
        dimension: 'overworld',
        heldItem: 'shield',
        lookBlock: { x: Math.floor(point.x), y: A.y, z: Math.floor(point.z), name: 'stone' },
        lookEntity: null,
        trigger: { kind: 'use', item: 'shield' },
      };
      const wall = lineSlots(point, yaw, GUARDS.length, { spacing: 1 });
      const archers = lineSlots(point.offset(-fwd.x * 4, 0, -fwd.z * 4), yaw, ARCHERS.length, { spacing: 2, ranks: 1, depth: 2 });
      const last = new Map<string, { p: Vec3; at: number }>();
      const t0 = Date.now();
      const r = await api('/api/orders/trigger', { by: CAPTAIN, command: 'line', tokens: [], filters: [], snap });
      if (!r.ok) throw new Error(`line: ${r.text}`);
      for (;;) {
        const now = Date.now();
        for (const n of ALL) {
          const p = pool.bot(n)?.entity?.position;
          if (!p) continue;
          const l = last.get(n);
          if (!l || l.p.distanceTo(p) > 0.01) last.set(n, { p: p.clone(), at: now });
        }
        const settled = [...last.values()].every((l) => now - l.at > 3000) && last.size === ALL.length;
        if (settled || now - t0 > 40_000) break;
        await sleep(50);
      }
      const lastMove = Math.max(...[...last.values()].map((l) => l.at)) - t0;
      const offsets: Array<{ name: string; off: number }> = [];
      for (const n of ALL) {
        const s = await run(mode === 'mounted' ? `data get entity @e[type=horse,tag=${TAG},limit=1,sort=nearest,x=${pool.bot(n)!.entity.position.x},y=${C.y},z=${pool.bot(n)!.entity.position.z}] Pos` : `data get entity ${n} Pos`);
        const [x, , z] = floats(s);
        const slots = GUARDS.includes(n) ? wall : archers;
        const off = Math.min(...slots.map((q) => Math.hypot(q.x - x!, q.z - z!)));
        offsets.push({ name: n, off });
      }
      const worst = Math.max(...offsets.map((o) => o.off));
      const within = offsets.filter((o) => o.off <= 0.15).length;
      const line = `${LABEL ? LABEL + ' ' : ''}${mode} yaw ${yaw}: last bot settled ${(lastMove / 1000).toFixed(1)} s after the click; ${within}/${ALL.length} within 0.15; worst ${worst.toFixed(2)}; offsets ${offsets.map((o) => `${o.name.replace('LP', '')}=${o.off.toFixed(2)}`).join(' ')}`;
      console.log(line);
      results.push(line);
      await api('/api/orders/trigger', { by: CAPTAIN, command: 'line', tokens: [], filters: [], stop: true, snap });
      await sleep(1000);
    }
  }
  await run(`kill @e[type=horse,tag=${TAG}]`);
  console.log('\n' + results.join('\n'));
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  for (const o of runner.running()) await o.stop('stopped', 'probe ended').catch(() => undefined);
  for (const n of ALL) await api('/api/bots/despawn', { by: ADMIN, admin: true, name: n }).catch(() => undefined);
  await run(`kill @e[type=horse,tag=${TAG}]`).catch(() => undefined);
  await rt.stop();
  rcon.close();
}
process.exit(code);
