// Block ids with blockstates, and how they change when a plan is rotated or mirrored.
//
// A block is a string like the server takes it: 'minecraft:oak_stairs[facing=east,half=top]'.
// Rotation is about the Y axis in quarter turns CLOCKWISE seen from above (north -> east -> south -> west),
// the same turn `rotatePoint` applies to coordinates. Mirroring flips one horizontal axis ('x': east <-> west,
// 'z': north <-> south).
//
// Handled properties: facing (stairs, doors, torches, ladders, chests, furnaces…), axis (logs, pillars),
// rotation 0..15 (signs, banners, heads), north/east/south/west (fences, walls, panes, vines), stair shape
// (left <-> right on a mirror), door hinge, chest type (left <-> right on a mirror), rail shape. Everything else
// (half, type of a slab, waterlogged, …) does not depend on the horizontal orientation and is kept.

export const DIRS = ['north', 'east', 'south', 'west']; // clockwise order
const STEP = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };

/** 'minecraft:x[a=1,b=2]' -> { id: 'minecraft:x', props: { a: '1', b: '2' } } (props keep their order). */
export function parseBlock(block) {
    const s = String(block).trim();
    const i = s.indexOf('[');
    if (i < 0) return { id: s, props: {} };
    if (!s.endsWith(']')) throw new Error(`Malformed block '${s}'`);
    const props = {};
    for (const kv of s.slice(i + 1, -1).split(',')) {
        if (!kv.trim()) continue;
        const [k, v] = kv.split('=');
        if (v === undefined) throw new Error(`Malformed property '${kv}' in '${s}'`);
        props[k.trim()] = v.trim();
    }
    return { id: s.slice(0, i), props };
}

export function formatBlock({ id, props }) {
    const keys = Object.keys(props || {});
    return keys.length ? `${id}[${keys.map(k => `${k}=${props[k]}`).join(',')}]` : id;
}

/** Adds or replaces properties: withProps('minecraft:oak_log', { axis: 'x' }). */
export function withProps(block, extra) {
    const b = parseBlock(block);
    return formatBlock({ id: b.id, props: { ...b.props, ...extra } });
}

/** The id without namespace and properties: 'oak_stairs'. */
export const baseName = block => parseBlock(block).id.replace(/^minecraft:/, '');

export function rotateDir(dir, turns) {
    const i = DIRS.indexOf(dir);
    return i < 0 ? dir : DIRS[(((i + turns) % 4) + 4) % 4];
}

export function mirrorDir(dir, axis) {
    if (axis === 'x') return dir === 'east' ? 'west' : dir === 'west' ? 'east' : dir;
    if (axis === 'z') return dir === 'north' ? 'south' : dir === 'south' ? 'north' : dir;
    throw new Error(`Mirror axis must be 'x' or 'z', got '${axis}'`);
}

/** The unit step [dx, dz] of a horizontal direction. */
export const dirStep = dir => STEP[dir];

/** The horizontal direction of a step (the dominant axis wins; ties go to X). */
export function stepDir(dx, dz) {
    if (Math.abs(dx) >= Math.abs(dz) && dx !== 0) return dx > 0 ? 'east' : 'west';
    if (dz !== 0) return dz > 0 ? 'south' : 'north';
    throw new Error('stepDir of a zero step');
}

export const opposite = dir => rotateDir(dir, 2);

const swapLR = v => v.replace(/left|right/, m => (m === 'left' ? 'right' : 'left'));
const RAIL_ORDER = ['north', 'south', 'east', 'west'];

function mapRailShape(shape, f) {
    const parts = shape.split('_');
    if (parts[0] === 'ascending') return `ascending_${f(parts[1])}`;
    return parts.map(f).sort((a, b) => RAIL_ORDER.indexOf(a) - RAIL_ORDER.indexOf(b)).join('_');
}

function transform(block, dirFn, { swapAxes, rotationFn, mirrored }) {
    const { id, props } = parseBlock(block);
    const out = {};
    const sides = {};
    for (const [k, v] of Object.entries(props)) {
        if (DIRS.includes(k)) { sides[dirFn(k)] = v; continue; }
        if (k === 'facing') out[k] = dirFn(v);
        else if (k === 'axis' && swapAxes) out[k] = v === 'x' ? 'z' : v === 'z' ? 'x' : v;
        else if (k === 'rotation') out[k] = String(rotationFn(Number(v)));
        else if (k === 'shape' && /_(stairs)$/.test(id)) out[k] = mirrored ? swapLR(v) : v;
        else if (k === 'shape' && /rail$/.test(id)) out[k] = mapRailShape(v, dirFn);
        else if (k === 'hinge' && mirrored) out[k] = v === 'left' ? 'right' : 'left';
        else if (k === 'type' && mirrored && /chest$/.test(id) && v !== 'single') out[k] = v === 'left' ? 'right' : 'left';
        else out[k] = v;
    }
    // Keep the side properties in a stable order (north, east, south, west) after they moved.
    for (const d of DIRS) if (d in sides) out[d] = sides[d];
    return formatBlock({ id, props: out });
}

/** The block as it reads after the plan turns `turns` quarter turns clockwise. */
export function rotateBlock(block, turns) {
    const t = ((turns % 4) + 4) % 4;
    if (t === 0) return block;
    return transform(block, d => rotateDir(d, t), {
        swapAxes: t % 2 === 1,
        rotationFn: r => (r + 4 * t) % 16, // 0 = south, 4 = west, 8 = north, 12 = east (clockwise)
        mirrored: false,
    });
}

/** The block as it reads after the plan is mirrored across `axis` ('x' flips east/west, 'z' north/south). */
export function mirrorBlock(block, axis) {
    return transform(block, d => mirrorDir(d, axis), {
        swapAxes: false,
        rotationFn: axis === 'x' ? r => (16 - r) % 16 : r => (24 - r) % 16,
        mirrored: true,
    });
}

/** [x, y, z] turned `turns` quarter turns clockwise about the Y axis through the origin. */
export function rotatePoint([x, y, z], turns) {
    let px = x, pz = z;
    for (let i = 0; i < ((turns % 4) + 4) % 4; i++) [px, pz] = [-pz, px];
    return [px + 0, y, pz + 0]; // +0 turns -0 into 0
}

export function mirrorPoint([x, y, z], axis) {
    return axis === 'x' ? [-x + 0, y, z] : [x, y, -z + 0];
}
