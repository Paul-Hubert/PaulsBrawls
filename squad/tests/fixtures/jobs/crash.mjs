// Test job type: ends its worker thread (process.exit in a worker ends the worker only). Inline it survives.

export const type = 'crash';

export function run(input, ctx) {
  if (!ctx.inline) process.exit(7);
  return 'survived inline';
}
