// docs/37 P6: findBlocks over the shared world. On real 1.21.1 chunk data (prismarine-chunk forest columns) fed through
// one packet stream to both mineflayer's own blocks plugin and the shared world, the search answers what mineflayer's
// bot.findBlocks answers, position for position and in the same order; then maxDistance, unknown and cached columns,
// a search spread over many ticks by `continue` (a worker and the inline fallback), and mineBlock with and without the
// job pool (its fallbacks to the bot, its unchanged error).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { Vec3 } from 'vec3';

import { answerOf, findBlocksIn, matchTable, Octahedron, startSearch, stepSearch } from '../src/world/find-blocks.mjs';
import type { FindBlocksAnswer, FindBlocksInput } from '../src/world/find-blocks.mjs';
import { SharedWorld } from '../src/world/shared-world';
import { JobPool } from '../src/jobs/pool';
import { STOCK_HANDLERS } from '../src/jobs/handlers/index';
import { blockSearchStats, findBlockPositions, useBlockSearch } from '../src/api/block-search';
import { mineBlock } from '../src/api/helpers';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { blockIdOf, changeBlock, forestColumn, GROUND_Y, loginBot, mineflayerBot, OVERWORLD, registry, sendForest, stateOf, unloadColumn } from './fakes/terrain';

holdEventLoopPerTest(120_000);

const require = createRequire(import.meta.url);
const { OctahedronIterator } = require('prismarine-world').iterators as { OctahedronIterator: new (start: Vec3, max: number) => { next(): Vec3 | null; apothem: number } };
const READER = new URL('../src/world/reader.mjs', import.meta.url);

const LOGS = [blockIdOf('oak_log'), blockIdOf('birch_log')];

const worlds: SharedWorld[] = [];
const pools: JobPool[] = [];
function newWorld(): SharedWorld {
  const w = new SharedWorld({ version: '1.21.1', cacheSeconds: 60, cacheColumns: 2_000, maxReaders: 8 });
  worlds.push(w);
  return w;
}
function newPool(opts: Partial<ConstructorParameters<typeof JobPool>[0]> & { world: SharedWorld }): JobPool {
  const p = new JobPool({ workers: 1, handlers: STOCK_HANDLERS, ticks: 'manual', version: '1.21.1', worldModule: READER, ...opts });
  pools.push(p);
  return p;
}
after(async () => {
  for (const p of pools) await p.stop();
  for (const w of worlds) await w.stop();
});

/** A forest of 7 × 7 columns around chunk (0, 0), in the bot's own world and in the shared world. */
async function forest(opts: { r?: number; skip?: (cx: number, cz: number) => boolean; extra?: Array<[number, number, number, number]>; position?: Vec3 } = {}) {
  const world = newWorld();
  const bot = mineflayerBot(opts.position);
  world.attach(bot);
  loginBot(bot);
  sendForest(bot, opts.r ?? 3, opts.skip, opts.extra);
  await world.settle();
  return { world, bot };
}

const flat = (ps: Vec3[]): number[] => ps.flatMap((p) => [p.x, p.y, p.z]);

/** The store's answer, read on this thread (the job handler's code, without the pool). */
function storeFind(world: SharedWorld, input: FindBlocksInput): FindBlocksAnswer {
  const r = world.reader;
  r.enter();
  try {
    return findBlocksIn(r, input);
  } finally {
    r.leave();
  }
}

/** Run one job to its answer, ticking a manual pool. */
async function runJob<T>(jobs: JobPool, input: unknown): Promise<T> {
  const p = jobs.submit<T>({ type: 'findBlocks', input });
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 20_000 && !done; i++) {
    await jobs.tick();
    await new Promise((r) => setImmediate(r));
  }
  return p;
}

// -- the walk ---------------------------------------------------------------------------------------------------------

test("the section walk is prismarine-world's OctahedronIterator, point for point", () => {
  for (const [start, max] of [[new Vec3(0, 4, 0), 4], [new Vec3(-3, -2, 7), 6], [new Vec3(5, 0, -1), 1]] as Array<[Vec3, number]>) {
    const ref = new OctahedronIterator(start, max);
    const ours = new Octahedron(start.x, start.y, start.z, max);
    let n = 0;
    for (;;) {
      const a = ref.next();
      const more = ours.next();
      assert.equal(more, a !== null, `both end at the same point (${n})`);
      if (!a) break;
      assert.deepEqual([ours.nx, ours.ny, ours.nz], [a.x, a.y, a.z], `point ${n}`);
      assert.equal(ours.apothem, ref.apothem, `layer at point ${n}`);
      n++;
    }
    assert.ok(n > 10);
  }
});

// -- the same answer as mineflayer ------------------------------------------------------------------------------------

test("on real chunk data: the same positions as mineflayer's findBlocks, in the same order", async () => {
  // A pond, ores and logs, and an unknown column (never sent) next to the bot.
  const { world, bot } = await forest({ skip: (cx, cz) => cx === 1 && cz === -1 });
  const queries: Array<{ what: string; ids: number[] }> = [
    { what: 'logs', ids: LOGS },
    { what: 'oak leaves', ids: [blockIdOf('oak_leaves')] },
    { what: 'coal and iron ore', ids: [blockIdOf('coal_ore'), blockIdOf('iron_ore')] },
    { what: 'stone (thousands)', ids: [blockIdOf('stone')] },
    { what: 'deepslate (one-state sections)', ids: [blockIdOf('deepslate')] },
    { what: 'water', ids: [blockIdOf('water')] },
    { what: 'nothing there', ids: [blockIdOf('diamond_block')] },
  ];
  const points = [new Vec3(0.5, GROUND_Y + 1, 0.5), new Vec3(-17.2, GROUND_Y + 3, 23.9), new Vec3(15.99, 20, -0.01), new Vec3(3, -30, 3), new Vec3(-40, 120, -40)];
  let compared = 0;
  let nonEmpty = 0;
  for (const q of queries) {
    for (const point of points) {
      for (const [maxDistance, count] of [[16, 1], [32, 5], [48, 64], [20, 100_000]] as Array<[number, number]>) {
        if (q.what.startsWith('stone') && count > 1000) continue; // a few hundred thousand: slow for mineflayer, nothing new
        const theirs = bot.findBlocks({ matching: q.ids, maxDistance, count, point }) as Vec3[];
        const ours = storeFind(world, { dim: OVERWORLD, x: point.x, y: point.y, z: point.z, maxDistance, count, blocks: q.ids });
        assert.deepEqual(ours.positions, flat(theirs), `${q.what} from ${point} within ${maxDistance}, count ${count}`);
        compared++;
        if (theirs.length > 0) nonEmpty++;
      }
    }
  }
  assert.ok(nonEmpty >= 50, `${nonEmpty} of ${compared} searches found something`);
});

test('a found position is within maxDistance, and one just past it is not', async () => {
  const gold = stateOf('gold_block');
  // From (0, 100, 0): at exactly 10 (on an axis), at √101 ≈ 10.05, at √99 ≈ 9.95.
  const extra: Array<[number, number, number, number]> = [
    [10, 100, 0, gold],
    [10, 101, 0, gold],
    [-7, 107, 1, gold],
  ];
  const { world, bot } = await forest({ r: 1, extra });
  const ids = [blockIdOf('gold_block')];
  const at = (maxDistance: number): number[] => storeFind(world, { dim: OVERWORLD, x: 0, y: 100, z: 0, maxDistance, count: 10, blocks: ids }).positions;
  assert.deepEqual(at(9.9), []);
  assert.deepEqual(at(9.95), [-7, 107, 1], '√99 ≈ 9.9499');
  assert.deepEqual(at(10), [-7, 107, 1, 10, 100, 0]);
  assert.deepEqual(at(10.04), [-7, 107, 1, 10, 100, 0]);
  assert.deepEqual(at(10.05), [-7, 107, 1, 10, 100, 0, 10, 101, 0]);
  for (const d of [9.9, 10, 10.05, 16]) {
    const theirs = bot.findBlocks({ matching: ids, maxDistance: d, count: 10, point: new Vec3(0, 100, 0) }) as Vec3[];
    assert.deepEqual(at(d), flat(theirs), `maxDistance ${d}`);
  }
});

test('unknown columns have no blocks: never received, held only by the bot, or cached after an unload', async () => {
  const gold = stateOf('gold_block');
  const extra: Array<[number, number, number, number]> = [
    [2, 70, 2, gold], // chunk (0, 0): known
    [18, 70, 2, gold], // chunk (1, 0): never sent
    [-14, 70, 2, gold], // chunk (-1, 0): unloaded later (cached in the store)
  ];
  const { world, bot } = await forest({ r: 1, skip: (cx, cz) => cx === 1 && cz === 0, extra });
  const ids = [blockIdOf('gold_block')];
  const q: FindBlocksInput = { dim: OVERWORLD, x: 0, y: 70, z: 0, maxDistance: 32, count: 10, blocks: ids };
  assert.deepEqual(storeFind(world, q).positions, [2, 70, 2, -14, 70, 2]);
  // The bot's own world gets chunk (1, 0) without a packet: the store never saw it, so it stays unknown there.
  const col = forestColumn(1, 0, extra);
  bot.world.setColumn(1, 0, col);
  assert.deepEqual(flat(bot.findBlocks({ matching: ids, maxDistance: 32, count: 10, point: new Vec3(0, 70, 0) })), [2, 70, 2, -14, 70, 2, 18, 70, 2]);
  const known = storeFind(world, q);
  assert.deepEqual(known.positions, [2, 70, 2, -14, 70, 2]);
  assert.ok(known.unknown > 0, 'the walk met unknown columns');
  // Chunk (-1, 0) unloaded: the store keeps it CACHED, which reads as unknown (no bot hears its block changes).
  unloadColumn(bot, -1, 0);
  await world.settle();
  assert.ok(world.stats().columnsCached >= 1);
  assert.deepEqual(storeFind(world, q).positions, [2, 70, 2]);
  // Another dimension's name: nothing at all.
  assert.deepEqual(storeFind(world, { ...q, dim: 'minecraft:the_nether' }).positions, []);
});

test('block changes reach the search; names and state ids match as block ids do', async () => {
  const { world, bot } = await forest({ r: 1 });
  const ids = [blockIdOf('emerald_block')];
  const q: FindBlocksInput = { dim: OVERWORLD, x: 0, y: 64, z: 0, maxDistance: 16, count: 5, blocks: ids };
  assert.deepEqual(storeFind(world, q).positions, []);
  changeBlock(bot, 3, 66, -2, stateOf('emerald_block'));
  changeBlock(bot, -1, 64, 1, stateOf('emerald_block'));
  await world.settle();
  const theirs = flat(bot.findBlocks({ matching: ids, maxDistance: 16, count: 5, point: new Vec3(0, 64, 0) }));
  assert.deepEqual(storeFind(world, q).positions, theirs);
  assert.equal(theirs.length, 6);
  assert.deepEqual(storeFind(world, { dim: OVERWORLD, x: 0, y: 64, z: 0, maxDistance: 16, count: 5, names: ['minecraft:emerald_block'] }).positions, theirs);
  assert.deepEqual(storeFind(world, { dim: OVERWORLD, x: 0, y: 64, z: 0, maxDistance: 16, count: 5, states: [stateOf('emerald_block')] }).positions, theirs);
  const t = matchTable(world.reader.states, { names: ['oak_log'] });
  assert.equal(t[stateOf('oak_log')], 1);
  assert.equal(t[stateOf('birch_log')], 0);
});

// -- continue: a search over many ticks -------------------------------------------------------------------------------

test('a search that runs out of budget continues on the next tick, and answers the same', async () => {
  const { world } = await forest();
  const input: FindBlocksInput = { dim: OVERWORLD, x: 0.5, y: GROUND_Y + 1, z: 0.5, maxDistance: 48, count: 1_000, blocks: LOGS };
  const whole = storeFind(world, input);
  assert.ok(whole.positions.length > 30, `${whole.positions.length / 3} logs`);
  // By hand: one section per step.
  const r = world.reader;
  const s = startSearch(r, input, matchTable(r.states, input));
  let steps = 0;
  for (;;) {
    r.enter();
    try {
      steps++;
      if (stepSearch(r, s, () => 0)) break;
    } finally {
      r.leave();
    }
  }
  assert.deepEqual(answerOf(s).positions, whole.positions);
  assert.ok(steps > 50, `${steps} steps`);
  // Through the pool: a worker, and the inline fallback, each with a budget so small every tick walks one section.
  for (const workers of [1, 0]) {
    const jobs = newPool({ workers, world, tickBudgetMs: 0.01, inlineBudgetMs: 0.01 });
    await jobs.ready();
    const ans = await runJob<FindBlocksAnswer>(jobs, input);
    assert.deepEqual(ans.positions, whole.positions, workers ? 'a worker' : 'inline');
    assert.ok(ans.slices > 20, `${ans.slices} slices`);
    const st = jobs.stats().types.findBlocks;
    assert.ok(st && st.continued > 20 && st.done === 1, JSON.stringify(st));
  }
});

// -- mineBlock --------------------------------------------------------------------------------------------------------

/** mineflayer's bot with what mineBlock also touches: collectblock (the block becomes air), a pathfinder, an inventory. */
function miner(bot: any, world?: SharedWorld): { collected: Vec3[]; scans: number } {
  const seen = { collected: [] as Vec3[], scans: 0 };
  const real = bot.findBlocks.bind(bot);
  bot.findBlocks = (o: unknown) => {
    seen.scans++;
    return real(o);
  };
  bot.collectBlock = {
    collect: async (block: { position: Vec3 }) => {
      seen.collected.push(block.position.clone());
      changeBlock(bot, block.position.x, block.position.y, block.position.z, 0);
      await world?.settle();
    },
    cancelTask: () => undefined,
  };
  bot.pathfinder = { stop: () => undefined, setGoal: () => undefined };
  bot.inventory = { items: () => [] };
  return seen;
}

test('mineBlock without a job pool searches on the bot, as before', async () => {
  const bot = mineflayerBot(new Vec3(0.5, GROUND_Y + 1, 0.5), 'Solo');
  loginBot(bot);
  sendForest(bot, 2);
  const seen = miner(bot);
  const before = blockSearchStats(true);
  assert.equal(before.jobs, 0);
  const expected = (bot.findBlocks({ matching: LOGS, maxDistance: 32, count: 64 }) as Vec3[]).slice(0, 3);
  seen.scans = 0;
  const r = await mineBlock(bot, '_log', 3);
  assert.equal(r.mined, 3);
  assert.deepEqual(r.at.map((p) => [p.x, p.y, p.z]), expected.map((p) => [p.x, p.y, p.z]));
  assert.equal(seen.scans, 1);
  const st = blockSearchStats(true);
  assert.equal(st.jobs, 0);
  assert.equal(st.fallbacks.off, 1);
});

test('mineBlock with the job pool and the shared world: the search is a job, the same logs are mined', async () => {
  const { world, bot } = await forest({ r: 2, position: new Vec3(0.5, GROUND_Y + 1, 0.5) });
  const twin = mineflayerBot(new Vec3(0.5, GROUND_Y + 1, 0.5), 'Twin');
  loginBot(twin);
  sendForest(twin, 2);
  const expected = (twin.findBlocks({ matching: LOGS, maxDistance: 32, count: 64 }) as Vec3[]).slice(0, 4);
  const jobs = newPool({ workers: 1, world, ticks: 'auto' });
  await jobs.ready();
  const seen = miner(bot, world);
  const drop = useBlockSearch({ jobs, world });
  try {
    blockSearchStats(true);
    const r = await mineBlock(bot, '_log', 4);
    assert.equal(r.mined, 4);
    assert.deepEqual(r.at.map((p) => [p.x, p.y, p.z]), expected.map((p) => [p.x, p.y, p.z]));
    assert.equal(seen.scans, 0, 'bot.findBlocks was not called');
    const st = blockSearchStats(true);
    assert.equal(st.jobs, 1);
    assert.equal(Object.values(st.fallbacks).reduce((a, b) => a + b, 0), 0);
    assert.equal(jobs.stats().types.findBlocks?.done, 1);
    // The logs it cut are air in the store too: the next search skips them, as mineflayer's does.
    const next = await findBlockPositions(bot, LOGS, 32, 64);
    for (const p of expected) twin.world.setBlockStateId(p, 0);
    assert.deepEqual(flat(next), flat(twin.findBlocks({ matching: LOGS, maxDistance: 32, count: 64 })));
  } finally {
    drop();
  }
});

test('mineBlock with the job pool falls back to the bot when the store cannot answer for it', async () => {
  const { world } = await forest({ r: 1 });
  const jobs = newPool({ workers: 1, world, ticks: 'auto' });
  await jobs.ready();
  const drop = useBlockSearch({ jobs, world });
  try {
    // Not attached to the shared world: no dimension.
    const stranger = mineflayerBot(new Vec3(0.5, GROUND_Y + 1, 0.5), 'Stranger');
    loginBot(stranger);
    sendForest(stranger, 1);
    const s1 = miner(stranger);
    blockSearchStats(true);
    assert.equal((await mineBlock(stranger, '_log', 1)).mined, 1);
    assert.equal(s1.scans, 1);
    assert.equal(blockSearchStats(true).fallbacks.noDimension, 1);
    // Attached, but standing in a column the store does not hold (it reached the bot without a packet).
    const far = mineflayerBot(new Vec3(200.5, GROUND_Y + 1, 0.5), 'Far');
    world.attach(far);
    loginBot(far);
    far.world.setColumn(12, 0, forestColumn(12, 0, [[200, GROUND_Y + 1, 3, stateOf('oak_log')]]));
    const s2 = miner(far);
    assert.equal((await mineBlock(far, 'oak_log', 1)).mined, 1);
    assert.equal(s2.scans, 1);
    assert.equal(blockSearchStats(true).fallbacks.noColumn, 1);
  } finally {
    drop();
  }
});

test("mineBlock's error is unchanged when the job finds nothing", async () => {
  const { world, bot } = await forest({ r: 1 });
  const jobs = newPool({ workers: 1, world, ticks: 'auto' });
  await jobs.ready();
  miner(bot, world);
  const drop = useBlockSearch({ jobs, world });
  try {
    await assert.rejects(mineBlock(bot, 'diamond_block', 2), (e: Error) => {
      assert.equal(e.name, 'HelperError');
      assert.equal(e.message, `mineBlock(Bot): no diamond_block mined within 32 blocks of (0, 64, 0) (none found, or all claimed by other bots)`);
      return true;
    });
    assert.equal(blockSearchStats(true).jobs, 1);
  } finally {
    drop();
  }
});

test('the registry agrees with the per-state tables on block ids (the job matches registry ids)', () => {
  const world = newWorld();
  const t = world.reader.states;
  for (const name of ['oak_log', 'birch_log', 'stone', 'water', 'deepslate', 'grass_block']) {
    const b = registry.blocksByName[name];
    for (let s = b.minStateId; s <= b.maxStateId; s++) assert.equal(t.blockId(s), b.id, `${name} state ${s}`);
  }
});

