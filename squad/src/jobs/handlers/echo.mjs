// The job pool's trivial job type (P2): answers its input. It proves the pool end to end (dispatch, a worker, apply)
// and measures the pool's own overhead (bench/jobs.ts); the real types (aim, raycast, los, path, findBlocks) come
// with docs/37's later phases, each a module like this one.

export const type = 'echo';

export function run(input) {
  return input;
}
