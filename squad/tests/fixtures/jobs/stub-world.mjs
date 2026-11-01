// A stand-in for P1's world reader (squad/src/world/reader.mjs openWorld): counts enter/leave in shared memory so
// the test can check every batch is bracketed, and flags a nested or unbalanced bracket.

export function openWorld(desc) {
  const counters = new Int32Array(desc.sab); // [enters, leaves, violations]
  let depth = 0;
  return {
    enter() {
      if (depth !== 0) Atomics.add(counters, 2, 1);
      depth++;
      Atomics.add(counters, 0, 1);
    },
    leave() {
      if (depth !== 1) Atomics.add(counters, 2, 1);
      depth--;
      Atomics.add(counters, 1, 1);
    },
    depth: () => depth,
    stateId: (_dim, _x, y) => (y < 64 ? 1 : 0),
    hasColumn: () => true,
    bounds: () => ({ minY: -64, height: 384 }),
    states: {},
  };
}
