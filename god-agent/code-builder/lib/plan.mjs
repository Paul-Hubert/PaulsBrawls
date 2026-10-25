// Plans: what components return and build() places.
//
// A plan is an array of layers [{ block, points }] in placement order (support before attachments). Plans compose
// by concatenation; later layers win where they overlap (`resolve` keeps the LAST block written at each position,
// on purpose: a door's air layer after a wall cuts the opening). Transforms rotate/mirror the points AND the
// blockstates, so a stair keeps pointing up its slope and a log keeps its axis along its beam.

import { rotateBlock, mirrorBlock, rotatePoint, mirrorPoint, parseBlock, formatBlock, dirStep, rotateDir, DIRS } from './blockstate.mjs';
import { bbox } from './geom.mjs';

const key = (x, y, z) => `${x},${y},${z}`;

export const layer = (block, points) => [{ block, points }];

/** Concatenates plans (and single layers), in order. Falsy entries are skipped so `cond && plan` works. */
export const concat = (...plans) => plans.flat().filter(Boolean);

export function translate(plan, dx = 0, dy = 0, dz = 0) {
    return plan.map(l => ({ block: l.block, points: l.points.map(([x, y, z]) => [x + dx, y + dy, z + dz]) }));
}

/** Quarter turns clockwise seen from above (north -> east), about the Y axis through the plan's origin. */
export function rotate(plan, turns) {
    return plan.map(l => ({ block: rotateBlock(l.block, turns), points: l.points.map(p => rotatePoint(p, turns)) }));
}

/** Mirror across 'x' (east <-> west, x -> -x) or 'z' (north <-> south, z -> -z). */
export function mirror(plan, axis) {
    return plan.map(l => ({ block: mirrorBlock(l.block, axis), points: l.points.map(p => mirrorPoint(p, axis)) }));
}

/** Places a plan in a parent: mirror (optional), then turn, then move to `at`. */
export function placeAt(plan, { at = [0, 0, 0], turns = 0, mirror: m = null } = {}) {
    let p = m ? mirror(plan, m) : plan;
    if (turns) p = rotate(p, turns);
    return translate(p, at[0], at[1], at[2]);
}

// ------------------------------------------------------------------------------------------------------ spawns

/**
 * A spawn group for build({ spawns }): `entity` (e.g. 'minecraft:villager') at every point (the block its feet stand
 * in), with optional nbt (SNBT, as for /summon) and persistent (default true). Kept apart from block layers.
 */
export const spawns = (entity, points, { nbt, persistent } = {}) => [{ entity, points, nbt, persistent }];

/** placeAt for spawn groups: mirror, turn, then move their points like a plan's (nbt is not rewritten). */
export function placeSpawns(groups, { at = [0, 0, 0], turns = 0, mirror: m = null } = {}) {
    return groups.map(g => ({ ...g, points: g.points.map(p => {
        let q = m ? mirrorPoint(p, m) : p;
        if (turns) q = rotatePoint(q, turns);
        return [q[0] + at[0], q[1] + at[1], q[2] + at[2]];
    }) }));
}

/** Replaces blocks by a mapping { from: to } on the base id (properties kept), e.g. a palette swap after the fact. */
export function swapBlocks(plan, mapping) {
    return plan.map(l => {
        const b = parseBlock(l.block);
        return mapping[b.id] ? { block: formatBlock({ id: mapping[b.id], props: b.props }), points: l.points } : l;
    });
}

// ---------------------------------------------------------------------------------------------------- ordering

const ATTACHMENT = /(torch|(?<!sea_)lantern|ladder|_door|_button|lever|_sign|_banner|carpet|rail|pressure_plate|flower_pot|^minecraft:(dandelion|poppy|.*_tulip|cornflower|allium|azure_bluet|oxeye_daisy|lily_of_the_valley)$|_sapling|vine|candle|chain$|tripwire|redstone_wire|snow$|_bed$|bell$)/;
const GRAVITY = /(^minecraft:(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$|concrete_powder|anvil$|scaffolding)/;

/** Blocks that need a neighbour to stand on or hang from; placed after everything else. */
export const isAttachment = block => ATTACHMENT.test(parseBlock(block).id);
export const isAir = block => /^minecraft:(cave_|void_)?air$/.test(parseBlock(block).id);
export const isGravity = block => GRAVITY.test(parseBlock(block).id);

/**
 * Flattens a plan into what will be placed: the last block written at each position wins, then layers are
 * regrouped by block in passes — 0 air (clears), 1 structure (by first use, each bottom-up), 2 attachments (by
 * first use). Stair shapes and fence/wall/pane connections are computed from the final layout (finalize), since
 * the server keeps the state it is given. Returns { layers: [{ block, points, pass }], total }.
 */
export function resolve(plan, { finalize: fin = true } = {}) {
    const at = new Map(); // key -> { p, block }
    for (const l of plan) for (const p of l.points) {
        const q = [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])];
        const k = key(...q);
        at.delete(k); // re-insert so iteration order follows the LAST write
        at.set(k, { p: q, block: l.block });
    }
    if (fin) finalizeStates(at);
    const groups = new Map(); // block -> { block, points, pass, first }
    let i = 0;
    for (const { p, block } of at.values()) {
        let g = groups.get(block);
        if (!g) groups.set(block, g = { block, points: [], pass: isAir(block) ? 0 : isAttachment(block) ? 2 : 1, first: i });
        g.points.push(p);
        i++;
    }
    const layers = [...groups.values()].sort((a, b) => a.pass - b.pass || a.first - b.first);
    for (const g of layers) if (g.pass === 1) g.points.sort((a, b) => a[1] - b[1]);
    return { layers: layers.map(({ block, points, pass }) => ({ block, points, pass })), total: at.size };
}

/** Blocks per material, the bounding box and the total of a plan, as build() would place it. */
export function stats(plan) {
    const { layers, total } = resolve(plan);
    const byBlock = {}, byMaterial = {};
    for (const l of layers) {
        byBlock[l.block] = (byBlock[l.block] || 0) + l.points.length;
        const id = parseBlock(l.block).id;
        byMaterial[id] = (byMaterial[id] || 0) + l.points.length;
    }
    const all = layers.flatMap(l => l.points);
    const solid = layers.filter(l => l.pass !== 0).flatMap(l => l.points);
    return { total, solid: solid.length, air: total - solid.length, byBlock, byMaterial, bbox: bbox(all), layers };
}

// ---------------------------------------------------------------------------------------------------- finalize

const isStairs = id => id.endsWith('_stairs');
const isFence = id => id.endsWith('_fence');
const isWall = id => id.endsWith('_wall') && !/(wall_torch|wall_sign|wall_banner|wall_head|wall_skull|wall_fan|wall_hanging_sign)/.test(id);
const isPane = id => id.endsWith('glass_pane') || id === 'minecraft:iron_bars';
const NOT_SOLID = /(_slab|_stairs|_fence|_fence_gate|_wall|glass_pane|iron_bars|leaves|_trapdoor)$/;

function finalizeStates(at) {
    const parsed = new Map();
    const get = (x, y, z) => {
        const e = at.get(key(x, y, z));
        if (!e) return null;
        let b = parsed.get(e.block);
        if (!b) parsed.set(e.block, b = parseBlock(e.block));
        return b;
    };
    const updates = [];
    for (const [k, { p, block }] of at) {
        const b = parseBlock(block);
        if (isStairs(b.id)) updates.push([k, stairShape(b, p, get)]);
        else if (isFence(b.id) || isWall(b.id) || isPane(b.id)) updates.push([k, connections(b, p, get)]);
    }
    for (const [k, nb] of updates) at.get(k).block = nb;
}

// Minecraft's StairsBlock.getStairShape, on the plan's own blocks.
function stairShape(b, [x, y, z], get) {
    const f = b.props.facing || 'north', half = b.props.half || 'bottom';
    const stairAt = d => { const [dx, dz] = dirStep(d); const n = get(x + dx, y, z + dz); return n && isStairs(n.id) && (n.props.half || 'bottom') === half ? n : null; };
    const differs = d => { const n = stairAt(d); return !n || (n.props.facing || 'north') !== f; };
    const axis = d => (d === 'north' || d === 'south' ? 'z' : 'x');
    const ccw = rotateDir(f, -1);
    let shape = 'straight';
    const back = stairAt(f);
    const front = stairAt(rotateDir(f, 2));
    if (back && axis(back.props.facing || 'north') !== axis(f) && differs(rotateDir(back.props.facing, 2))) {
        shape = back.props.facing === ccw ? 'outer_left' : 'outer_right';
    } else if (front && axis(front.props.facing || 'north') !== axis(f) && differs(front.props.facing)) {
        shape = front.props.facing === ccw ? 'inner_left' : 'inner_right';
    }
    const props = { ...b.props };
    if (shape === 'straight') delete props.shape; else props.shape = shape;
    return formatBlock({ id: b.id, props });
}

function connections(b, [x, y, z], get) {
    const same = isFence(b.id) ? isFence : isWall(b.id) ? (id => isWall(id) || isPane(id)) : (id => isPane(id) || isWall(id));
    const props = { ...b.props };
    const on = {};
    for (const d of DIRS) {
        const [dx, dz] = dirStep(d);
        const n = get(x + dx, y, z + dz);
        on[d] = !!n && (same(n.id) || (isFence(b.id) && n.id.endsWith('_fence_gate')) ||
            (!isAir(n.id) && !isAttachment(n.id) && !NOT_SOLID.test(n.id)));
    }
    if (isWall(b.id)) {
        for (const d of DIRS) props[d] = on[d] ? 'low' : 'none';
        const straight = (on.north && on.south && !on.east && !on.west) || (on.east && on.west && !on.north && !on.south);
        const above = get(x, y + 1, z);
        props.up = String(!straight || (!!above && !isAir(above.id)));
    } else {
        for (const d of DIRS) props[d] = String(on[d]);
    }
    return formatBlock({ id: b.id, props });
}
