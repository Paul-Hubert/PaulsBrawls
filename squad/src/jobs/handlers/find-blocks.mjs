// The `findBlocks` job type (docs/37 P6): mineflayer's bot.findBlocks over the shared world (world/find-blocks.mjs),
// on a reader worker, so a block search (gather's `mineBlock`, a 48-block scan) leaves the main thread. The answer is
// mineflayer's, in its order.
//
//   input:  { dim, x, y, z, maxDistance?, count?, blocks?: block ids, names?: block names, states?: state ids }
//   answer: { positions: [x0, y0, z0, …], hits, sections, scanned, unknown, slices }
//
// A search that runs out of this tick's budget answers { continue } and goes on next tick on the same worker (a 48-block
// search reads well under a millisecond, so only far larger ones do). The match table of a query (a byte per state id)
// is built once per thread and kept for the next search with the same blocks.

import { answerOf, matchKey, matchTable, startSearch, stepSearch } from '../../world/find-blocks.mjs';

export const type = 'findBlocks';

/** Match tables kept per thread (64 KB each): the queries a runtime makes are few (gather's "_log", a few others). */
const MAX_TABLES = 32;
const tables = new Map();

function tableFor(states, input) {
  const key = matchKey(input);
  let t = tables.get(key);
  if (t === undefined) {
    if (tables.size >= MAX_TABLES) tables.clear();
    t = matchTable(states, input);
    tables.set(key, t);
  }
  return t;
}

export function run(input, ctx) {
  const world = ctx.world;
  if (!world) throw new Error('findBlocks: this thread has no shared world (world.enabled is off)');
  const search = ctx.state ?? startSearch(world, input, tableFor(world.states, input));
  return stepSearch(world, search, ctx.budgetLeftMs) ? answerOf(search) : { continue: search };
}
