// Test job type: reads the entity snapshot.

export const type = 'entity';

export function run(input, ctx) {
  const e = ctx.entities;
  const ids = [];
  e.each((r) => {
    ids.push(r.id);
  });
  return { row: e.get(input.id), count: e.count, epoch: e.epoch, tick: e.tick, ids };
}
