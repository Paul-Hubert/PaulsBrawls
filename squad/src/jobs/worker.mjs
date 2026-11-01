// A reader worker (docs/37 §2.5). It runs batches of read-only jobs (aim, raycasts, A*, block searches as later
// phases add their handlers) under a per-tick CPU budget, reading the shared world (P1) and the entity snapshot
// without a message. It never writes the world and never touches a bot.
//
// Plain JS so the worker needs no loader (as pathworkers/worker.mjs). workerData:
//   { handlers: string[] (module URLs), budgetMs, worldModule?: string, world?: descriptor, entities: EntityHandles,
//     version, index }
//
// Messages in (pool.ts is the other side):
//   { t: 'batch', tick, budgetMs, jobs: [{ id, type, input?, resume?, transferred?, deadlineTick, est }] }
//   { t: 'drop', ids }        forget the state or the held input of these jobs (cancelled, late, superseded)
// Messages out:
//   { t: 'ready', types, errors }
//   { t: 'done', tick, usedMs, results }      one per batch (batch.mjs's results)

import { parentPort, workerData } from 'node:worker_threads';

import { loadHandlers, runBatch, serializeError } from './batch.mjs';
import { openEntities } from './entities.mjs';

const data = workerData;
const world = data.worldModule ? (await import(data.worldModule)).openWorld(data.world) : null;
const entities = openEntities(data.entities, data.index);
const { handlers, errors } = await loadHandlers(data.handlers, { version: data.version, world, inline: false, worker: data.index });

/** Jobs continued here (their state), or not started with a transferred input. */
const held = new Map();
/** This thread's own running cost estimate per type. */
const costs = new Map();

parentPort.on('message', async (m) => {
  if (m.t === 'drop') {
    for (const id of m.ids) held.delete(id);
    return;
  }
  if (m.t !== 'batch') return;
  const out = await runBatch(m, { handlers, held, costs, world, entities, version: data.version, worker: data.index, inline: false });
  const msg = { t: 'done', tick: m.tick, usedMs: out.usedMs, results: out.results };
  try {
    parentPort.postMessage(msg);
  } catch {
    // A result that cannot be copied fails alone, not its whole batch.
    for (const r of out.results) {
      if (r.r !== 'done') continue;
      try {
        structuredClone(r.value);
      } catch (e) {
        r.r = 'failed';
        r.value = undefined;
        r.error = { ...serializeError(e), message: `the job's result cannot be copied to the main thread: ${serializeError(e).message}` };
        r.clone = true;
      }
    }
    parentPort.postMessage(msg);
  }
});

parentPort.postMessage({ t: 'ready', types: [...handlers.keys()], errors });
