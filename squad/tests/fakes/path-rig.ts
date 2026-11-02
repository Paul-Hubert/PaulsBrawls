// A* on the reader workers (docs/37 P4), wired for tests as main.ts wires it: the real shared world (its writer
// thread), the real job pool (one reader worker by default, ticked by hand) running the real `path` handler, and the
// main-thread offload. A fake bot only needs a packet stream (`_client`, for the shared world) and a `pathfinder`
// object (for the hook).

import { JobPool, type JobPoolOptions } from '../../src/jobs/pool';
import { PathOffload, type OffloadedBot } from '../../src/bots/pathworkers/offload';
import { SharedWorld } from '../../src/world/shared-world';

export const PATH_HANDLER = new URL('../../src/jobs/handlers/path.mjs', import.meta.url);
export const WORLD_READER = new URL('../../src/world/reader.mjs', import.meta.url);
export const VERSION = '1.21.1';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface PathRig {
  world: SharedWorld;
  jobs: JobPool;
  paths: PathOffload;
  /** Follow the bot's packets (before its login) and take over its searches. */
  attach(bot: unknown): void;
  /** compute() as the plugin calls it, once per tick (here: once per pool tick), until it is no longer partial. */
  settle(ctx: { compute(): any }, ms?: number): Promise<any>;
  /** Tick the pool by hand for about `ms`. */
  pump(ms: number, gapMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface PathRigOptions extends Partial<Pick<JobPoolOptions, 'workers' | 'tickBudgetMs' | 'workerUrl' | 'maxCrashesPerMinute'>> {
  handlers?: URL[];
  graceMs?: number;
}

export async function pathRig(opts: PathRigOptions = {}): Promise<PathRig> {
  const world = new SharedWorld({ version: VERSION, cacheSeconds: 60, cacheColumns: 100, maxReaders: 16 });
  const jobs = new JobPool({
    workers: opts.workers ?? 1,
    handlers: opts.handlers ?? [PATH_HANDLER],
    ticks: 'manual',
    version: VERSION,
    world,
    worldModule: WORLD_READER,
    ...(opts.tickBudgetMs === undefined ? {} : { tickBudgetMs: opts.tickBudgetMs }),
    ...(opts.workerUrl ? { workerUrl: opts.workerUrl } : {}),
    ...(opts.maxCrashesPerMinute === undefined ? {} : { maxCrashesPerMinute: opts.maxCrashesPerMinute }),
  });
  await jobs.ready();
  const paths = new PathOffload({ jobs, world, ...(opts.graceMs === undefined ? {} : { graceMs: opts.graceMs }) });
  return {
    world,
    jobs,
    paths,
    attach(bot) {
      world.attach(bot);
      paths.install(bot as OffloadedBot);
    },
    async settle(ctx, ms = 20_000) {
      let r = ctx.compute();
      const end = Date.now() + ms;
      while (r.status === 'partial') {
        if (Date.now() > end) throw new Error('the offloaded search never settled');
        await jobs.tick();
        await sleep(2);
        r = ctx.compute();
      }
      return r;
    },
    async pump(ms, gapMs = 2) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await jobs.tick();
        await sleep(gapMs);
      }
    },
    async stop() {
      paths.stop();
      await jobs.stop();
      await world.stop();
    },
  };
}
