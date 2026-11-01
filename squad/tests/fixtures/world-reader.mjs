// A reader thread over the shared world (tests/world.test.ts): it opens the descriptor it is given and answers
// batches of reads, each inside one enter()/leave() bracket, as a P2 reader worker will.
import { parentPort, workerData } from 'node:worker_threads';

import { openWorld } from '../../src/world/reader.mjs';

const reader = openWorld(workerData.descriptor);

parentPort.on('message', (m) => {
  if (m.hold) {
    // Enter and never leave: a worker killed in the middle of a batch.
    reader.enter();
    parentPort.postMessage({ id: m.id, out: [], inside: true });
    return;
  }
  reader.enter();
  try {
    const out = m.points.map(([x, y, z]) => reader.stateId(m.dim, x, y, z));
    parentPort.postMessage({ id: m.id, out, version: reader.version(), name: reader.states.name(out[0] ?? -1) });
  } finally {
    reader.leave();
  }
});
parentPort.postMessage({ t: 'ready' });
