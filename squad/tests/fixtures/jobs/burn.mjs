// Test job type: burns input.ms of CPU.

import { performance } from 'node:perf_hooks';

export const type = 'burn';

export function run(input, ctx) {
  const start = performance.now();
  while (performance.now() - start < input.ms) {
    // spin
  }
  return { id: input.id, worker: ctx.worker, tick: ctx.tick };
}
