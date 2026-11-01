// Test job type: elastic (batch.mjs). Each run burns its share of the budget (ctx.shareMs()) and records it; after
// input.slices runs it answers the shares.

import { performance } from 'node:perf_hooks';

export const type = 'elastic';
export const elasticMinMs = 2;

export function run(input, ctx) {
  const share = ctx.shareMs();
  const t0 = performance.now();
  while (performance.now() - t0 < share) {
    // spin
  }
  const shares = [...(ctx.state ?? []), share];
  if (shares.length < input.slices) return { continue: shares };
  return { shares, worker: ctx.worker };
}
