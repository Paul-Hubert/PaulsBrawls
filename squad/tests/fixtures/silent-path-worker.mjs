// A pathfinding worker that never answers a search (tests/pathworkers.test.ts): it stands for a wedged or dead one.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', () => undefined);
parentPort.postMessage({ t: 'ready' });
