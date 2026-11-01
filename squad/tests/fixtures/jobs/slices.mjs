// Test job type: a long job in input.slices slices, resumed with its state ({ continue }).

export const type = 'slices';

export function run(input, ctx) {
  const state = ctx.state ?? { workers: [], ticks: [] };
  state.workers.push(ctx.worker);
  state.ticks.push(ctx.tick);
  if (state.workers.length < input.slices) return { continue: state };
  return state;
}
