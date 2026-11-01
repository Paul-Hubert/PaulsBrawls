// A job reading P1's real shared world from a reader worker (tests/jobs-world.test.ts): the state at a position, and
// the per-state tables (state 1 is stone in 1.21.1, a full cube).
export const type = 'world-probe';

export function run(input, ctx) {
  const w = ctx.world;
  return { state: w.stateId(input.dim, input.x, input.y, input.z), states: w.states.count, stoneSolid: w.states.isSolid(1), worker: ctx.worker };
}
