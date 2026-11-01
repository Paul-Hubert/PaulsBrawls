// Test job type: input.slices slices, each answering { continue, progress: slice number }, then { done }. With
// input.uncloneable, the second slice's progress is a function (it cannot cross threads).

export const type = 'progress';

export function run(input, ctx) {
  const n = (ctx.state ?? 0) + 1;
  if (n >= input.slices) return { done: n, worker: ctx.worker };
  if (input.uncloneable && n === 2) return { continue: n, progress: () => n };
  return { continue: n, progress: n };
}
