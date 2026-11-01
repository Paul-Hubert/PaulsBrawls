// Live parity probe of the shared world (docs/37 P1): the real runtime in process with world.enabled and
// world.verify, six bots on the dev server, two in area A, two in area B far from it, two in area C overlapping A.
// Once their chunks are in:
//   1. every block of every column each bot holds is compared with the store: 0 mismatches expected, every column
//      a bot holds live in the store, and no live column that no bot holds;
//   2. blocks placed and broken over RCON (a setblock where A and C overlap, a fill in B) must reach the store within
//      a tick or two (measured from the RCON reply), then the whole comparison runs again;
//   3. the bots leave: their columns go cached; one comes back before cacheSeconds (its unchanged columns are
//      published without a decode); then every cached column expires.
// It reports the counts, the decode time per column (the writer's, and on this thread ours against prismarine-chunk's
// on the same payloads), and the store's memory against the bots' own worlds. Random ticks and mob griefing are off
// while it runs (put back after), so the world stays still between a packet and the comparison.
//
//   ./gradlew runDevServer          (dev/: its server.properties gives the ports and the RCON password)
//   cd squad && npx tsx live-tests/probe-world.ts        PROBE_PORT=8791, PROBE_CACHE_S=15, SERVER_PROPERTIES=…

import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import type { Bot } from 'mineflayer';

import { parseConfig } from '../src/config';
import { start } from '../src/main';
import { logger } from '../src/logger';
import { decodeColumn } from '../src/world/decode.mjs';
import type { SharedWorld } from '../src/world/shared-world';
import { Rcon } from './rcon';

const require = createRequire(import.meta.url);
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
const PORT = Number(process.env.PROBE_PORT ?? 8791);
const CACHE_S = Number(process.env.PROBE_CACHE_S ?? 15);
const TOKEN = 'live-test-token';
const OW = 'minecraft:overworld';
const AREAS: Record<string, [number, number]> = { A: [0, 0], B: [3000, 3000], C: [160, 0] };
const BOTS: Array<[string, string]> = [
  ['WorldA1', 'A'],
  ['WorldA2', 'A'],
  ['WorldB1', 'B'],
  ['WorldB2', 'B'],
  ['WorldC1', 'C'],
  ['WorldC2', 'C'],
];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (line: string): void => logger.info('probe', line);
const registry = require('prismarine-registry')('1.21.1') as { blocksByName: Record<string, { defaultState: number }> };
const Chunk = require('prismarine-chunk')(registry) as new (o: { minY: number; worldHeight: number }) => { load(b: Buffer): void };
const GOLD = registry.blocksByName.gold_block!.defaultState;
const GLASS = registry.blocksByName.glass!.defaultState;

interface Column {
  getBlockStateId(p: { x: number; y: number; z: number }): number;
  dump(): Buffer;
  sections: Array<{ data?: { data?: { data?: Uint32Array } }; palette?: unknown[] }>;
  biomes?: Array<{ data?: { data?: { data?: Uint32Array } } }>;
  skyLightSections?: Array<{ data?: Uint32Array } | null>;
  blockLightSections?: Array<{ data?: Uint32Array } | null>;
}
const columnsOf = (bot: Bot): Record<string, Column> => (bot.world as unknown as { async: { columns: Record<string, Column> } }).async.columns;

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Wait until the store and the bots' worlds stop changing for `quietMs`. */
async function waitStable(world: SharedWorld, bots: Bot[], quietMs: number, ms: number): Promise<void> {
  const end = Date.now() + ms;
  let last = '';
  let since = Date.now();
  while (Date.now() < end) {
    await world.settle();
    const s = world.stats();
    const sig = `${s.columnsLive}/${s.held}/${s.decoded}/${bots.map((b) => Object.keys(columnsOf(b)).length).join(',')}`;
    if (sig !== last) {
      last = sig;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return;
    await sleep(250);
  }
  throw new Error(`the chunks never settled (${last})`);
}

/** Every block of every column each bot holds, against the store. Synchronous: no packet lands meanwhile. */
function parity(world: SharedWorld, bots: Bot[]): { columns: number; blocks: number; mismatches: number; missing: number; strays: number; ms: number; examples: string[] } {
  const r = world.reader;
  const t0 = performance.now();
  const out = { columns: 0, blocks: 0, mismatches: 0, missing: 0, strays: 0, ms: 0, examples: [] as string[] };
  const union = new Set<string>();
  const p = { x: 0, y: 0, z: 0 };
  r.enter();
  try {
    for (const bot of bots) {
      const game = bot.game as unknown as { minY: number; height: number };
      const minY = game.minY;
      const maxY = minY + game.height;
      for (const [key, col] of Object.entries(columnsOf(bot))) {
        const [cx, cz] = key.split(',').map(Number) as [number, number];
        union.add(key);
        if (!r.hasColumn(OW, cx, cz)) {
          out.missing++;
          continue;
        }
        out.columns++;
        for (let y = minY; y < maxY; y++) {
          p.y = y;
          for (let z = 0; z < 16; z++) {
            p.z = z;
            for (let x = 0; x < 16; x++) {
              p.x = x;
              const theirs = col.getBlockStateId(p);
              const ours = r.stateId(OW, cx * 16 + x, y, cz * 16 + z);
              out.blocks++;
              if (ours !== theirs) {
                out.mismatches++;
                if (out.examples.length < 5) out.examples.push(`${bot.username} ${cx * 16 + x} ${y} ${cz * 16 + z}: store ${ours}, bot ${theirs}`);
              }
            }
          }
        }
      }
    }
  } finally {
    r.leave();
  }
  out.strays = world.stats().columnsLive - union.size;
  out.ms = performance.now() - t0;
  return out;
}

/** Typed-array bytes of a bot's own world: block palettes and data, biomes, light (a lower bound: no object overhead). */
function ownWorldBytes(bot: Bot): number {
  let n = 0;
  for (const col of Object.values(columnsOf(bot))) {
    for (const s of col.sections) n += (s.data?.data?.data?.byteLength ?? 0) + (s.palette?.length ?? 0) * 8;
    for (const b of col.biomes ?? []) n += b.data?.data?.data?.byteLength ?? 0;
    for (const l of [...(col.skyLightSections ?? []), ...(col.blockLightSections ?? [])]) n += l?.data?.byteLength ?? 0;
  }
  return n;
}

/** Poll the store until `check` holds; ms from now, or -1 after `limit`. */
async function storeLatency(world: SharedWorld, check: () => boolean, limit = 2_000): Promise<number> {
  const t0 = performance.now();
  while (performance.now() - t0 < limit) {
    world.reader.enter();
    let ok = false;
    try {
      ok = check();
    } finally {
      world.reader.leave();
    }
    if (ok) return performance.now() - t0;
    await new Promise((r) => setImmediate(r));
  }
  return -1;
}

/** The highest non-air block of a column at (x, z), from the store. */
function surface(world: SharedWorld, x: number, z: number): number {
  const r = world.reader;
  r.enter();
  try {
    for (let y = 319; y > -64; y--) {
      const s = r.stateId(OW, x, y, z);
      if (s > 0 && (!r.states.isEmpty(s) || r.states.isLiquid(s))) return y;
    }
    return 64;
  } finally {
    r.leave();
  }
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main(): Promise<void> {
  const rcon = new Rcon('127.0.0.1', Number(props['rcon.port'] ?? 25576), props['rcon.password'] ?? '');
  await rcon.connect();
  const ruleOf = async (name: string): Promise<string> => (await rcon.command(`gamerule ${name}`)).match(/: (\S+)/)?.[1] ?? '';
  const rules = { randomTickSpeed: await ruleOf('randomTickSpeed'), mobGriefing: await ruleOf('mobGriefing'), doFireTick: await ruleOf('doFireTick') };
  await rcon.command('gamerule randomTickSpeed 0');
  await rcon.command('gamerule mobGriefing false');
  await rcon.command('gamerule doFireTick false');
  const cfg = parseConfig(
    { minecraft: { port: MC_PORT }, port: PORT, dataDir: mkdtempSync(join(tmpdir(), 'probe-world-')), loginStaggerMs: 300, world: { enabled: true, cacheSeconds: CACHE_S, verify: true } },
    { PAULSBRAWLS_SQUAD_TOKEN: TOKEN },
  );
  const rt = await start(cfg, { connectBots: false, installGuards: true });
  const world = rt.world!;
  const { pool } = rt.service.deps;
  const report: Record<string, unknown> = {};
  let fillAt: [number, number, number] | null = null;
  try {
    for (const [name] of BOTS) pool.add(name);
    await waitFor(() => BOTS.every(([n]) => pool.status(n) === 'online'), 60_000, 'the bots online');
    for (const [name, area] of BOTS) {
      const [x, z] = AREAS[area]!;
      await rcon.command(`gamemode creative ${name}`);
      const spread = (await rcon.command(`spreadplayers ${x} ${z} 0 4 false ${name}`)).trim();
      // spreadplayers refuses some spots (water, too steep): from high up, a creative bot falls unhurt.
      if (/could not/i.test(spread)) await rcon.command(`tp ${name} ${x} 200 ${z}`);
      log(`${name}: ${spread}`);
    }
    const bots = BOTS.map(([n]) => pool.bot(n)!);
    const t0 = performance.now();
    await waitStable(world, bots, 5_000, 180_000);
    const s1 = world.stats();
    const held = bots.reduce((n, b) => n + Object.keys(columnsOf(b)).length, 0);
    log(`loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s: bots hold ${held} columns (${bots.map((b) => `${b.username} ${Object.keys(columnsOf(b)).length}`).join(', ')}); the store has ${s1.columnsLive} live, ${s1.columnsCached} cached; decoded ${s1.decoded} (p50 ${s1.decodeMs.p50.toFixed(3)} ms, max ${s1.decodeMs.max.toFixed(2)} ms per column), skipped ${s1.skipped}, ${s1.sections} sections`);

    // 1. Every block.
    const p1 = parity(world, bots);
    log(`parity: ${p1.columns} columns, ${p1.blocks} blocks compared in ${(p1.ms / 1000).toFixed(1)} s: ${p1.mismatches} mismatches, ${p1.missing} held but not in the store, ${p1.strays} live but held by no bot${p1.examples.length ? `; ${p1.examples.join(' | ')}` : ''}`);
    const own = bots.reduce((n, b) => n + ownWorldBytes(b), 0);
    report.memory = { storeBytes: s1.bytes, storeSectionsBytes: s1.sections * 8192, botsOwnWorldsBytes: own, perBot: Math.round(own / bots.length), uniqueColumns: s1.columnsLive, heldColumns: held };
    log(`memory: the store ${mb(s1.bytes)} committed (${s1.sections} sections = ${mb(s1.sections * 8192)}) for ${s1.columnsLive} columns; the bots' own worlds ${mb(own)} of typed arrays for ${held} columns (${mb(own / bots.length)} a bot)`);

    // Our decoder against prismarine-chunk's, on this thread, on payloads of a bot's own columns.
    const dumps = Object.values(columnsOf(bots[0]!)).slice(0, 200).map((c) => c.dump());
    const scratch = new Uint16Array(4096);
    const opts = { maxBitsPerBlock: 15, noSizePrefix: false, hasFluidCount: false };
    for (const d of dumps) decodeColumn(new Uint8Array(d), 24, opts, scratch, () => undefined); // warm
    let ta = performance.now();
    for (const d of dumps) decodeColumn(new Uint8Array(d), 24, opts, scratch, () => undefined);
    const oursMs = (performance.now() - ta) / dumps.length;
    ta = performance.now();
    for (const d of dumps) new Chunk({ minY: -64, worldHeight: 384 }).load(d);
    const theirsMs = (performance.now() - ta) / dumps.length;
    log(`decode on this thread over ${dumps.length} payloads (${mb(dumps.reduce((n, d) => n + d.length, 0))}): ours ${oursMs.toFixed(3)} ms/column, prismarine-chunk ${theirsMs.toFixed(3)} ms/column`);
    report.decode = { writer: s1.decodeMs, oursMs, prismarineMs: theirsMs };

    // 2. Changes over RCON: a block where A and C overlap, a 5×5×5 fill in B, then both taken away.
    const a = new Set(Object.keys(columnsOf(bots[0]!)));
    const shared = Object.keys(columnsOf(bots[4]!)).find((k) => a.has(k));
    if (!shared) throw new Error('areas A and C do not overlap');
    const [cx, cz] = shared.split(',').map(Number) as [number, number];
    const gx = cx * 16 + 8;
    const gz = cz * 16 + 8;
    const gy = surface(world, gx, gz) + 1;
    const holders = bots.filter((b) => columnsOf(b)[shared]).map((b) => b.username);
    log(`setblock ${gx} ${gy} ${gz} gold_block (column ${shared}, held by ${holders.join(', ')})`);
    await rcon.command(`setblock ${gx} ${gy} ${gz} minecraft:gold_block`);
    const gold = await storeLatency(world, () => world.reader.stateId(OW, gx, gy, gz) === GOLD);
    const [bx, bz] = AREAS.B!;
    const by = surface(world, bx, bz) + 2;
    fillAt = [bx, by, bz];
    await rcon.command(`fill ${bx} ${by} ${bz} ${bx + 4} ${by + 4} ${bz + 4} minecraft:glass`);
    const glassAll = (): boolean => {
      for (let x = bx; x <= bx + 4; x++) for (let y = by; y <= by + 4; y++) for (let z = bz; z <= bz + 4; z++) if (world.reader.stateId(OW, x, y, z) !== GLASS) return false;
      return true;
    };
    const glass = await storeLatency(world, glassAll);
    await rcon.command(`setblock ${gx} ${gy} ${gz} minecraft:air`);
    const goldGone = await storeLatency(world, () => world.reader.stateId(OW, gx, gy, gz) === 0);
    await rcon.command(`fill ${bx} ${by} ${bz} ${bx + 4} ${by + 4} ${bz + 4} minecraft:air`);
    const glassGone = await storeLatency(world, () => world.reader.stateId(OW, bx + 2, by + 2, bz + 2) === 0 && world.reader.stateId(OW, bx + 4, by + 4, bz + 4) === 0);
    fillAt = null;
    report.changes = { setblockMs: gold, fillMs: glass, breakMs: goldGone, unfillMs: glassGone };
    log(`changes reached the store, ms after the RCON reply (a tick is 50): setblock ${gold.toFixed(1)}, fill 125 ${glass.toFixed(1)}, break ${goldGone.toFixed(1)}, fill air ${glassGone.toFixed(1)} (-1 = never)`);
    await sleep(500);
    await world.settle();
    const p2 = parity(world, bots);
    log(`parity after the changes: ${p2.columns} columns, ${p2.blocks} blocks: ${p2.mismatches} mismatches, ${p2.missing} missing, ${p2.strays} strays${p2.examples.length ? `; ${p2.examples.join(' | ')}` : ''}`);
    const v = world.stats().verify;
    log(`verify so far: ${v.rounds} rounds, ${v.checked} blocks sampled, ${v.mismatches} mismatches; dropped (non-primary) changes ${world.stats().dropped}, resyncs ${world.stats().resyncs}`);

    // 3. The bots leave: cached. One comes back: no decode for its unchanged columns. Then everything expires.
    const liveBefore = world.stats().columnsLive;
    for (const [name] of BOTS) pool.remove(name);
    await sleep(1_000);
    await world.settle();
    const s3 = world.stats();
    const stillThere = (() => {
      world.reader.enter();
      try {
        return world.reader.hasColumn(OW, cx, cz);
      } finally {
        world.reader.leave();
      }
    })();
    log(`all bots gone: ${s3.columnsLive} live, ${s3.columnsCached} cached (of ${liveBefore}); column ${shared} readable: ${stillThere}`);
    const before = world.stats();
    pool.add('WorldA1');
    await waitFor(() => pool.status('WorldA1') === 'online', 30_000, 'WorldA1 back');
    const back = pool.bot('WorldA1')!;
    await waitStable(world, [back], 3_000, 60_000);
    const s4 = world.stats();
    const backHeld = Object.keys(columnsOf(back)).length;
    log(`WorldA1 back within ${CACHE_S} s: holds ${backHeld} columns; published without a decode ${s4.skipped - before.skipped}, decoded ${s4.decoded - before.decoded}`);
    const p3 = parity(world, [back]);
    log(`parity for WorldA1: ${p3.columns} columns, ${p3.mismatches} mismatches, ${p3.missing} missing`);
    report.revive = { held: backHeld, skipped: s4.skipped - before.skipped, decoded: s4.decoded - before.decoded, mismatches: p3.mismatches };
    pool.remove('WorldA1');
    await sleep(1_000);
    await world.settle();
    const cachedPeak = world.stats().columnsCached;
    const tExp = performance.now();
    await waitFor(() => world.stats().columnsCached === 0, (CACHE_S + 15) * 1_000, 'the cache to expire');
    log(`cached ${cachedPeak} columns expired ${((performance.now() - tExp) / 1000).toFixed(1)} s after the last bot left (cacheSeconds ${CACHE_S}); live ${world.stats().columnsLive}`);
    const end = world.stats();
    report.parity = { first: p1, afterChanges: p2 };
    report.final = end;
    console.log(JSON.stringify(report, null, 1));
  } finally {
    if (fillAt) await rcon.command(`fill ${fillAt[0]} ${fillAt[1]} ${fillAt[2]} ${fillAt[0] + 4} ${fillAt[1] + 4} ${fillAt[2] + 4} minecraft:air`).catch(() => undefined);
    for (const [name] of BOTS) pool.remove(name);
    for (const [rule, value] of Object.entries(rules)) if (value) await rcon.command(`gamerule ${rule} ${value}`).catch(() => undefined);
    await sleep(500);
    await rt.stop();
    rcon.close();
  }
  process.exit(0);
}

main().catch((e) => {
  logger.error('probe', e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(2);
});
