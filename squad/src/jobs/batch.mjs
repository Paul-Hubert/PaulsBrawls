// Running one batch of jobs under a CPU budget (docs/37 §2.5). The same code runs in a reader worker (worker.mjs)
// and on the main thread when no worker is alive (the inline fallback, pool.ts), so a handler behaves the same in
// both. Plain JS, so a worker imports it with no loader; batch.d.mts types it.
//
// A handler module:   export const type = 'aim';
//                     export function run(input, ctx) { … return result }      (or return { continue: state })
//                     export function init(env) { … }                          (optional, once per thread)
//
// The budget is wall time from the batch's start. Before each job but the first, the batch stops when the budget is
// spent or the job's estimated cost (the main thread's running estimate, or this thread's own once it has run that
// type) would overrun it: the jobs not started go back to the queue. A handler that runs long can read
// ctx.budgetLeftMs() and return { continue: state }: it is resumed next tick on the same thread with ctx.state.
//
// Async handlers are allowed but discouraged: the batch awaits them, so the time they wait counts against the
// budget, nothing else runs on this thread's batch meanwhile, and no answer of the batch goes back until it settles.

import { performance } from 'node:perf_hooks';

/** The weight of a new sample in a type's running cost estimate. */
export const COST_ALPHA = 0.2;

/**
 * Import every handler module. Returns the handlers by type and what failed (a module that did not load, or that
 * does not export a string `type` and a `run` function, or a type exported twice).
 */
export async function loadHandlers(urls, env) {
  const handlers = new Map();
  const errors = [];
  for (const url of urls) {
    try {
      const m = await import(url);
      if (typeof m.type !== 'string' || typeof m.run !== 'function') {
        errors.push({ url, message: 'a job handler module must export `type` (a string) and `run` (a function)' });
        continue;
      }
      if (handlers.has(m.type)) {
        errors.push({ url, message: `job type ${m.type} is already handled by another module` });
        continue;
      }
      if (typeof m.init === 'function') await m.init(env);
      handlers.set(m.type, m);
    } catch (e) {
      errors.push({ url, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { handlers, errors };
}

export function isContinue(v) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, 'continue');
}

export function serializeError(e) {
  if (e instanceof Error) return { message: e.message, stack: e.stack, name: e.name };
  return { message: String(e), name: 'Error' };
}

function isThenable(v) {
  return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}

/**
 * Run a batch. `batch` = { tick, budgetMs, jobs: [{ id, type, input?, resume?, deadlineTick, est }] } in the order
 * to run them. `env` = { handlers, held (Map id → { input, state }), costs (Map type → ms), world, entities,
 * version, worker, inline }.
 *
 * Results, one per job: { id, r: 'done', value, ms } | { id, r: 'continue', ms } | { id, r: 'failed', error, ms }
 * | { id, r: 'notStarted', held } (held: its input stays here, because it was transferred and the main thread has
 * no copy).
 */
export async function runBatch(batch, env) {
  const start = performance.now();
  const budget = batch.budgetMs;
  const budgetLeftMs = () => budget - (performance.now() - start);
  const results = [];
  const jobs = batch.jobs;
  env.world?.enter();
  env.entities?.pin();
  try {
    let i = 0;
    for (; i < jobs.length; i++) {
      const j = jobs[i];
      if (i > 0) {
        const elapsed = performance.now() - start;
        const est = Math.max(j.est ?? 0, env.costs.get(j.type) ?? 0);
        if (elapsed >= budget || elapsed + est > budget) break;
      }
      let entry = j.resume ? env.held.get(j.id) : undefined;
      if (j.resume && !entry) {
        results.push({ id: j.id, r: 'failed', ms: 0, error: { message: `job ${j.id} has no state on this thread`, name: 'Error' }, lost: true });
        continue;
      }
      entry ??= { input: j.input, state: undefined };
      const h = env.handlers.get(j.type);
      if (!h) {
        env.held.delete(j.id);
        results.push({ id: j.id, r: 'failed', ms: 0, error: { message: `no handler for job type ${j.type}`, name: 'Error' }, unknownType: true });
        continue;
      }
      const ctx = {
        world: env.world ?? null,
        entities: env.entities ?? null,
        tick: batch.tick,
        deadlineTick: j.deadlineTick,
        state: entry.state,
        version: env.version,
        worker: env.worker,
        inline: env.inline,
        budgetLeftMs,
      };
      const t0 = performance.now();
      try {
        let v = h.run(entry.input, ctx);
        if (isThenable(v)) v = await v;
        const ms = performance.now() - t0;
        observe(env.costs, j.type, ms);
        if (isContinue(v)) {
          entry.state = v.continue;
          env.held.set(j.id, entry);
          results.push({ id: j.id, r: 'continue', ms });
        } else {
          env.held.delete(j.id);
          results.push({ id: j.id, r: 'done', value: v, ms });
        }
      } catch (e) {
        const ms = performance.now() - t0;
        observe(env.costs, j.type, ms);
        env.held.delete(j.id);
        results.push({ id: j.id, r: 'failed', ms, error: serializeError(e) });
      }
    }
    for (; i < jobs.length; i++) {
      const j = jobs[i];
      // A transferred input is not on the main thread any more: it waits here for its next batch.
      if (j.transferred && !j.resume) env.held.set(j.id, { input: j.input, state: undefined });
      results.push({ id: j.id, r: 'notStarted', held: Boolean(j.transferred) || Boolean(j.resume) });
    }
  } finally {
    env.entities?.unpin();
    env.world?.leave();
  }
  return { results, usedMs: performance.now() - start };
}

function observe(costs, type, ms) {
  const prev = costs.get(type);
  costs.set(type, prev === undefined ? ms : prev + COST_ALPHA * (ms - prev));
}
