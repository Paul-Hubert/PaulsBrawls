// Where mineBlock's block search runs (docs/37 P6). With the reader workers (workers.count > 0) and the shared world
// (world.enabled) both on, main.ts hands them here (useBlockSearch) and the search is a `findBlocks` job: mineflayer's
// findBlocks read from the shared world on a worker (jobs/handlers/find-blocks.mjs, world/find-blocks.mjs), with the
// same positions in the same order. Otherwise (the defaults) it is bot.findBlocks on the main thread, as before.
//
// Only async callers use the job. findBlock stays synchronous on the bot's own world: the script API returns a Block
// there at once, and a worker's answer comes one or two ticks later (docs/37 §8.4).
//
// For one call, a search falls back to bot.findBlocks when the store cannot answer for that bot:
//   • the bot is not attached to the shared world, or has not logged in yet (no dimension);
//   • the bot's own column is not live in the store: just logged in or teleported, before the writer published it, or
//     the writer is disabled after crashes (it then holds nothing);
//   • the job failed (no worker alive and no inline fallback, the pool stopping).
// A search is never given up for being slow: it has no deadline, and one that outruns its worker's budget for the tick
// goes on there next tick from where it stopped (find-blocks.mjs answers { continue }), until it answers.
// A failure is logged at most once a minute; blockSearchStats() counts the jobs, the fallbacks and the jobs' latency.

import { performance } from 'node:perf_hooks';

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

import { logger } from '../logger';
import { unwrap } from '../orders/guard';
import type { FindBlocksAnswer, FindBlocksInput } from '../world/find-blocks.mjs';

export const FIND_BLOCKS_JOB = 'findBlocks';
/** The lowest of docs/37 §2.5's order (aim first, then raycasts and line of sight, then paths and block searches). */
export const FIND_BLOCKS_PRIORITY = 0;
const WARN_EVERY_MS = 60_000;
const LATENCY_SAMPLES = 1_024;

/** The parts of the job pool used here (JobPool). */
export interface BlockSearchJobs {
  submit<T>(spec: { type: string; input: unknown; priority?: number }): Promise<T>;
}

/** The parts of the shared world used here (SharedWorld). */
export interface BlockSearchWorld {
  readonly reader: { enter(): void; leave(): void; hasColumn(dim: string, chunkX: number, chunkZ: number): boolean };
  dimensionOf(bot: unknown): string | null;
}

export interface BlockSearchBackend {
  jobs: BlockSearchJobs;
  world: BlockSearchWorld;
}

export type BlockSearchFallback = 'off' | 'noDimension' | 'noColumn' | 'failed';

export interface BlockSearchStats {
  /** Searches answered by a findBlocks job. */
  jobs: number;
  /** Searches run by bot.findBlocks, by why (`off`: no backend, the defaults). */
  fallbacks: Record<BlockSearchFallback, number>;
  /** A job's submit → positions, ms, over the last LATENCY_SAMPLES jobs answered (null: none). */
  jobMs: { p50: number | null; p95: number | null; max: number | null };
}

let backend: BlockSearchBackend | null = null;
let lastWarn = 0;
const fresh = (): Omit<BlockSearchStats, 'jobMs'> => ({ jobs: 0, fallbacks: { off: 0, noDimension: 0, noColumn: 0, failed: 0 } });
let counts = fresh();
let latencies: number[] = [];

/** Process-wide, like the pathfinding settings (one runtime per process). Returns the undo, for stop(). */
export function useBlockSearch(b: BlockSearchBackend): () => void {
  backend = b;
  return () => {
    if (backend === b) backend = null;
  };
}

export function blockSearchStats(reset = false): BlockSearchStats {
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (q: number): number | null => (sorted.length ? Math.round((sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number) * 10) / 10 : null);
  const s = { jobs: counts.jobs, fallbacks: { ...counts.fallbacks }, jobMs: { p50: at(0.5), p95: at(0.95), max: at(1) } };
  if (reset) {
    counts = fresh();
    latencies = [];
  }
  return s;
}

/**
 * bot.findBlocks({ matching: ids, maxDistance, count }): the positions of up to `count` blocks of those ids within
 * `maxDistance` of the bot, nearest first. On a reader worker when there is a backend and the store holds the bot's
 * column, else on the bot.
 */
export async function findBlockPositions(bot: Bot, ids: number[], maxDistance: number, count: number): Promise<Vec3[]> {
  const b = backend;
  if (!b) return onBot(bot, ids, maxDistance, count, 'off');
  const p = bot.entity?.position;
  const dim = b.world.dimensionOf(unwrap(bot));
  if (!dim || !p) return onBot(bot, ids, maxDistance, count, 'noDimension');
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  const z = Math.floor(p.z);
  if (!liveColumn(b.world, dim, x >> 4, z >> 4)) return onBot(bot, ids, maxDistance, count, 'noColumn');
  const input: FindBlocksInput = { dim, x, y, z, maxDistance, count, blocks: ids };
  let answer: FindBlocksAnswer;
  const t0 = performance.now();
  try {
    // No deadline: the search runs on the workers, over as many ticks as it takes.
    answer = await b.jobs.submit<FindBlocksAnswer>({ type: FIND_BLOCKS_JOB, input, priority: FIND_BLOCKS_PRIORITY });
  } catch (e) {
    if (Date.now() - lastWarn > WARN_EVERY_MS) {
      lastWarn = Date.now();
      logger.warn('squad', `findBlocks job failed (${(e as Error).message}): searching on the bot instead`);
    }
    return onBot(bot, ids, maxDistance, count, 'failed');
  }
  counts.jobs++;
  if (latencies.length >= LATENCY_SAMPLES) latencies.shift();
  latencies.push(performance.now() - t0);
  const out: Vec3[] = [];
  const ps = answer.positions;
  for (let i = 0; i + 2 < ps.length; i += 3) out.push(new Vec3(ps[i] as number, ps[i + 1] as number, ps[i + 2] as number));
  return out;
}

function onBot(bot: Bot, ids: number[], maxDistance: number, count: number, why: BlockSearchFallback): Vec3[] {
  counts.fallbacks[why]++;
  return bot.findBlocks({ matching: ids, maxDistance, count });
}

/** The store holds this column live (main thread's reader, one lookup). */
function liveColumn(world: BlockSearchWorld, dim: string, cx: number, cz: number): boolean {
  const r = world.reader;
  try {
    r.enter();
  } catch {
    return false; // this thread is inside a bracket already (not expected): search on the bot
  }
  try {
    return r.hasColumn(dim, cx, cz);
  } finally {
    r.leave();
  }
}
