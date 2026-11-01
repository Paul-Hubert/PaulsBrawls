// A reader worker that says it runs `path` jobs and never answers a batch (tests/pathworkers.test.ts): it stands for
// a wedged one. The job pool keeps its batch in flight; the offload's deadline (thinkTimeout + grace) gives up on it.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', () => undefined);
parentPort.postMessage({ t: 'ready', types: ['path'], errors: [] });
