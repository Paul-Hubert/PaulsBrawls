// Block searches, mineflayer's against the shared world's (docs/37 P6), no Minecraft server: the forest columns of the
// tests (tests/fakes/terrain.ts, real prismarine-chunk data: deepslate, stone with ores, dirt, grass, ponds, trees),
// 9 × 9 columns sent through one packet stream to mineflayer's own blocks plugin and to the shared world.
//
//  - one search, gather's (mineBlock: logs within 48 blocks, count 64) and others, from several points: mineflayer's
//    bot.findBlocks on the main thread against the store's search (the job handler's code) on the main thread;
//  - what the store's walk does per search (sections walked, read, skipped) and the time per section read, which is
//    what a per-section summary (docs/37 P6: "skip the sections that cannot match") could save at most;
//  - a findBlocks job through the pool (4 workers, the pool's own 50 ms ticks): submit → positions.
//
//   cd squad && npm run bench:find-blocks          (results also in bench/.runs/<ts>-find-blocks/find-blocks.json)

import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';

import { Vec3 } from 'vec3';

import { findBlocksIn, matchTable } from '../src/world/find-blocks.mjs';
import type { FindBlocksAnswer, FindBlocksInput } from '../src/world/find-blocks.mjs';
import { SharedWorld } from '../src/world/shared-world';
import { JobPool } from '../src/jobs/pool';
import { STOCK_HANDLERS } from '../src/jobs/handlers/index';
import { blockIdOf, GROUND_Y, loginBot, mineflayerBot, OVERWORLD, sendForest } from '../tests/fakes/terrain';

const here = dirname(fileURLToPath(import.meta.url));
const out: Record<string, unknown> = { cpu: cpus()[0]?.model, node: process.version };
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function stats(xs: number[]): { p50: number; p95: number; mean: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { p50: r3(at(0.5)), p95: r3(at(0.95)), mean: r3(s.reduce((a, b) => a + b, 0) / s.length), max: r3(s[s.length - 1]!) };
}

async function main(): Promise<void> {
  const world = new SharedWorld({ version: '1.21.1', cacheSeconds: 60, cacheColumns: 2_000, maxReaders: 16 });
  const bot = mineflayerBot(new Vec3(0.5, GROUND_Y + 1, 0.5));
  world.attach(bot);
  loginBot(bot);
  out.columns = sendForest(bot, 4);
  await world.settle();
  const LOGS = Object.values(bot.registry.blocksByName as Record<string, { id: number; name: string }>).filter((b) => b.name.includes('_log')).map((b) => b.id);
  const queries: Array<{ what: string; ids: number[]; maxDistance: number; count: number }> = [
    { what: "gather's mineBlock: every _log within 48, count 64", ids: LOGS, maxDistance: 48, count: 64 },
    { what: 'oak_log within 32, count 1 (findBlock)', ids: [blockIdOf('oak_log')], maxDistance: 32, count: 1 },
    { what: 'iron_ore within 16, count 8', ids: [blockIdOf('iron_ore')], maxDistance: 16, count: 8 },
    { what: 'diamond_block within 48 (none: the whole walk)', ids: [blockIdOf('diamond_block')], maxDistance: 48, count: 64 },
  ];
  const points = [new Vec3(0.5, GROUND_Y + 1, 0.5), new Vec3(-20, GROUND_Y + 1, 13), new Vec3(30, GROUND_Y + 1, -25), new Vec3(5, GROUND_Y + 8, -40)];
  const r = world.reader;
  const rows: Record<string, unknown>[] = [];
  for (const q of queries) {
    const mf: number[] = [];
    const st: number[] = [];
    const tables: number[] = [];
    let walk: FindBlocksAnswer | null = null;
    const match = matchTable(r.states, { blocks: q.ids });
    for (let round = 0; round < 12; round++) {
      for (const p of points) {
        let t = performance.now();
        const theirs = bot.findBlocks({ matching: q.ids, maxDistance: q.maxDistance, count: q.count, point: p }) as Vec3[];
        if (round >= 2) mf.push(performance.now() - t);
        const input: FindBlocksInput = { dim: OVERWORLD, x: p.x, y: p.y, z: p.z, maxDistance: q.maxDistance, count: q.count, blocks: q.ids };
        t = performance.now();
        const m = round === 0 ? matchTable(r.states, input) : match;
        if (round === 0) tables.push(performance.now() - t);
        t = performance.now();
        r.enter();
        let ours: FindBlocksAnswer;
        try {
          ours = findBlocksIn(r, input, m);
        } finally {
          r.leave();
        }
        if (round >= 2) st.push(performance.now() - t);
        if (ours.positions.length !== theirs.length * 3) throw new Error(`${q.what}: ${ours.positions.length / 3} found, mineflayer ${theirs.length}`);
        if (p === points[0]) walk = ours;
      }
    }
    rows.push({
      query: q.what,
      'mineflayer findBlocks (ms)': stats(mf),
      'shared world (ms)': stats(st),
      'match table, first search of a query (ms)': stats(tables),
      'walk from the first point': walk && { found: walk.positions.length / 3, hits: walk.hits, sections: walk.sections, scanned: walk.scanned, unknown: walk.unknown },
    });
  }
  out.searches = rows;

  // The time to read one stored section (4 096 ids against the match table): what a per-section summary could skip.
  {
    const input: FindBlocksInput = { dim: OVERWORLD, x: 0.5, y: GROUND_Y + 1, z: 0.5, maxDistance: 48, count: 1_000_000, blocks: [blockIdOf('diamond_block')] };
    const m = matchTable(r.states, input);
    const xs: number[] = [];
    let scanned = 0;
    for (let i = 0; i < 50; i++) {
      r.enter();
      const t = performance.now();
      const a = findBlocksIn(r, input, m);
      xs.push(performance.now() - t);
      r.leave();
      scanned = a.scanned;
    }
    const s = stats(xs.slice(10));
    out['per section read (µs), from the full walk with no hit'] = r3((s.p50 * 1000) / Math.max(1, scanned));
    out['sections read in that walk'] = scanned;
  }

  // Through the pool: 4 workers, the pool's own ticks (as with a bot's physics ticks), submitted at random points.
  {
    const jobs = new JobPool({ workers: 4, handlers: STOCK_HANDLERS, version: '1.21.1', world, worldModule: new URL('../src/world/reader.mjs', import.meta.url) });
    await jobs.ready();
    const input: FindBlocksInput = { dim: OVERWORLD, x: 0.5, y: GROUND_Y + 1, z: 0.5, maxDistance: 48, count: 64, blocks: LOGS };
    for (let i = 0; i < 10; i++) await jobs.submit({ type: 'findBlocks', input });
    const xs: number[] = [];
    for (let i = 0; i < 100; i++) {
      await new Promise((res) => setTimeout(res, Math.random() * 50));
      const t = performance.now();
      await jobs.submit({ type: 'findBlocks', input });
      xs.push(performance.now() - t);
    }
    const t = jobs.stats().types.findBlocks;
    out['job: submit → positions, 4 workers, timer ticks (ms)'] = stats(xs);
    out['job: worker time per search (ms, running estimate)'] = t?.costMs === null || t?.costMs === undefined ? null : r3(t.costMs);
    await jobs.stop();
  }
  await world.stop();

  const dir = join(here, '.runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-find-blocks`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'find-blocks.json'), JSON.stringify(out, null, 2));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`bench:find-blocks crashed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(2);
});
