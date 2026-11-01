// The per-state tables of the shared world (docs/37 §2.1): for every block state id of the registry, its collision
// boxes, its flags, its block id and name. Built once on the main thread from the bots' registry (minecraft-data
// 1.21.1: 26 684 states, 4 811 distinct shapes) into SharedArrayBuffers that every reader reads in place, instead of
// building a prismarine Block per lookup (`Block.fromStateId`, today's hottest function, docs/36).
//
// Boxes come from minecraft-data's collision shapes per state, exactly as prismarine-block picks them (a block's
// list indexed by state - minStateId, or its single shape; the first one if the list is short). They are block-local
// [minX, minY, minZ, maxX, maxY, maxZ], six Float32 each, deduplicated by shape.

// Flag bits (one byte per state).
/** No collision box in this state (per state: an open fence gate, a one-layer snow). */
export const F_EMPTY = 1;
/** Exactly the full cube, one box 0,0,0 → 1,1,1: the fast path of a raycast or a collision test. */
export const F_SOLID = 2;
/** Water or lava, any level (the blocks mineflayer-pathfinder's Movements calls liquids). */
export const F_LIQUID = 4;
/** In 1.21.1's #minecraft:climbable tag (ladder, vine, scaffolding, the weeping, twisting and cave vines). */
export const F_CLIMBABLE = 8;
/** Water as prismarine-physics swims in it: water, bubble column, seagrass, kelp, or any waterlogged state. */
export const F_WATER = 16;
export const F_LAVA = 32;
/** The state's `waterlogged` property is true. */
export const F_WATERLOGGED = 64;
/** minecraft-data's per-block boundingBox is 'block' (what mineflayer-pathfinder and prismarine-physics read). */
export const F_BB_BLOCK = 128;

const CLIMBABLE = new Set(['ladder', 'vine', 'scaffolding', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant', 'cave_vines', 'cave_vines_plant']);
const WATER_LIKE = new Set(['water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);

/** The value index of each property, decoded as prismarine-block does (the last property varies fastest). */
function waterloggedOf(block, metadata) {
  const states = block.states;
  if (!states || states.length === 0) return false;
  let data = metadata;
  for (let i = states.length - 1; i >= 0; i--) {
    const prop = states[i];
    const value = data % prop.num_values;
    data = Math.floor(data / prop.num_values);
    if (prop.name === 'waterlogged') return prop.type === 'bool' ? value === 0 : prop.values?.[value] === 'true';
  }
  return false;
}

/** Build the tables of a prismarine-registry (the bots' own version). */
export function buildStateTables(registry) {
  const blocks = registry.blocksArray;
  let maxState = 0;
  for (const b of blocks) maxState = Math.max(maxState, b.maxStateId);
  const count = maxState + 1;
  const flags = new Uint8Array(new SharedArrayBuffer(count));
  const blockId = new Uint16Array(new SharedArrayBuffer(count * 2));
  const shapeOf = new Uint16Array(new SharedArrayBuffer(count * 2));
  const shapes = registry.blockCollisionShapes ?? { blocks: {}, shapes: {} };
  // Shape 0 is "no box". Others in the order first met.
  const shapeIndex = new Map([[-1, 0]]);
  const shapeBoxes = [[]];
  const blockNames = [];
  for (const b of blocks) {
    blockNames[b.id] = b.name;
    const ids = shapes.blocks[b.name];
    for (let s = b.minStateId; s <= b.maxStateId; s++) {
      const meta = s - b.minStateId;
      const sid = Array.isArray(ids) ? (ids[meta] ?? ids[0]) : ids;
      const boxes = sid === undefined ? [] : (shapes.shapes[sid] ?? []);
      const key = sid === undefined || boxes.length === 0 ? -1 : sid;
      let si = shapeIndex.get(key);
      if (si === undefined) {
        si = shapeBoxes.length;
        shapeIndex.set(key, si);
        shapeBoxes.push(boxes);
      }
      shapeOf[s] = si;
      blockId[s] = b.id;
      let f = 0;
      if (boxes.length === 0) f |= F_EMPTY;
      if (boxes.length === 1 && boxes[0].every((v, i) => v === (i < 3 ? 0 : 1))) f |= F_SOLID;
      if (b.name === 'water' || b.name === 'lava') f |= F_LIQUID;
      if (b.name === 'lava') f |= F_LAVA;
      if (CLIMBABLE.has(b.name)) f |= F_CLIMBABLE;
      const logged = waterloggedOf(b, meta);
      if (logged) f |= F_WATERLOGGED;
      if (logged || WATER_LIKE.has(b.name)) f |= F_WATER;
      if (b.boundingBox === 'block') f |= F_BB_BLOCK;
      flags[s] = f;
    }
  }
  const shapeStart = new Uint32Array(new SharedArrayBuffer(shapeBoxes.length * 4));
  const shapeCount = new Uint8Array(new SharedArrayBuffer(shapeBoxes.length));
  let floats = 0;
  for (const boxes of shapeBoxes) floats += boxes.length * 6;
  const boxData = new Float32Array(new SharedArrayBuffer(Math.max(4, floats * 4)));
  let at = 0;
  shapeBoxes.forEach((boxes, si) => {
    shapeStart[si] = at;
    shapeCount[si] = boxes.length;
    for (const box of boxes) for (const v of box) boxData[at++] = v;
  });
  return {
    count,
    flags: flags.buffer,
    blockId: blockId.buffer,
    shapeOf: shapeOf.buffer,
    shapeStart: shapeStart.buffer,
    shapeCount: shapeCount.buffer,
    boxData: boxData.buffer,
    blockNames,
  };
}

/** What the writer needs to decode chunk payloads, from the same registry (prismarine-chunk's ChunkColumn rules). */
export function decoderOptions(registry, tables) {
  const v = registry.version;
  return {
    // prismarine-chunk 1.18+: the direct palette's width is the bits of the highest state id (15 in 1.21.1).
    maxBitsPerBlock: 32 - Math.clz32(tables.count - 1),
    // 1.21.5+ writes no size prefix before a container's longs; 26.1+ adds a fluid count per section.
    noSizePrefix: typeof v?.['>='] === 'function' ? v['>=']('1.21.5') : false,
    hasFluidCount: typeof v?.['>='] === 'function' ? v['>=']('26.1') : false,
  };
}
