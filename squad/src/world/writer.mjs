// The writer thread of the shared world (docs/37 §2.2, D2): the only thread that writes the store. It decodes the
// chunk payloads the main thread forwards (shared-world.ts), applies unloads and block changes, keeps the cache, and
// answers each batch with what became live or stopped being live, so the main thread can tell the bots (P5).
// The store's logic is store.mjs (applyOps is one batch); this file is the message loop. Plain JS so the worker needs
// no loader.
//
// workerData: { descriptor, cacheSeconds, cacheColumns, reset }   reset: a restart after a crash (store.mjs reset()).
// In:  { t: 'ops', seq, ops }   ops in order: ['load', dim, x, z, minY, height, ArrayBuffer] | ['release', dim, x, z]
//                               | ['set', dim, x, y, z, stateId]
// Out: { t: 'ready', stats }
//      { t: 'done', seq, published: [dim, x, z, …], unloaded: [dim, x, z, …], decodeMs: number[], errors: string[], stats }
//      { t: 'stats', stats }   after the expiry timer dropped cached columns

import { parentPort, workerData } from 'node:worker_threads';
import { setInterval } from 'node:timers';

import { applyOps, WorldStore } from './store.mjs';

/** How often the cache is expired and retired memory reclaimed between batches. */
const TICK_MS = 1_000;

const store = new WorldStore(workerData.descriptor, {
  cacheSeconds: workerData.cacheSeconds,
  cacheColumns: workerData.cacheColumns,
  reset: Boolean(workerData.reset),
});

parentPort.on('message', (m) => {
  if (m.t !== 'ops') return;
  const r = applyOps(store, m.ops);
  parentPort.postMessage({ t: 'done', seq: m.seq, ...r, stats: store.stats() });
});

setInterval(() => {
  const dropped = store.expire();
  store.endBatch();
  if (dropped > 0) parentPort.postMessage({ t: 'stats', stats: store.stats() });
}, TICK_MS);

parentPort.postMessage({ t: 'ready', stats: store.stats() });
