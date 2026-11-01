// The shared world's writer (src/world/writer.mjs), except that after a { t: 'deaf' } message it applies and answers
// nothing more: the batches sent to it stay unacknowledged, as a writer that dies mid-batch leaves them (P5's restart).

import { parentPort, workerData } from 'node:worker_threads';

import { applyOps, WorldStore } from '../../src/world/store.mjs';

const store = new WorldStore(workerData.descriptor, {
  cacheSeconds: workerData.cacheSeconds,
  cacheColumns: workerData.cacheColumns,
  reset: Boolean(workerData.reset),
});
let deaf = false;

parentPort.on('message', (m) => {
  if (m.t === 'deaf') deaf = true;
  if (m.t !== 'ops' || deaf) return;
  const r = applyOps(store, m.ops);
  parentPort.postMessage({ t: 'done', seq: m.seq, ...r, stats: store.stats() });
});

parentPort.postMessage({ t: 'ready', stats: store.stats() });
