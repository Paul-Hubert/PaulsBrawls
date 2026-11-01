// Test job type: what the handler saw (its order of runs on this thread, the tick, the thread, the world's depth).

let runs = 0;

export const type = 'probe';

export function run(input, ctx) {
  return {
    input,
    n: ++runs,
    tick: ctx.tick,
    worker: ctx.worker,
    inline: ctx.inline,
    deadlineTick: ctx.deadlineTick,
    worldDepth: ctx.world && typeof ctx.world.depth === 'function' ? ctx.world.depth() : null,
    budgetLeftMs: ctx.budgetLeftMs(),
  };
}
