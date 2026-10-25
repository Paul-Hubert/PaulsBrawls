// Parameterized components. Each returns a plan ([{ block, points }] in placement order) in its own local frame,
// documented per function; place it in a parent with placeAt(plan, { at, turns, mirror }). Every option has a
// default, so tower() alone is a valid tower. `palette` is a preset name or a palette object (palettes.mjs).
//
// Conventions: y = 0 is the ground course (the component's floor replaces the ground block); walls start at
// y = 1. Air layers cut openings; build() places air first, then structure, then attachments (doors, torches,
// ladders, lanterns), so order inside a component is about which write wins, not about support.

import { box, walls, rectRing, disc, ring, cylinder, archOpening, archRing, extrude, spiralSquare, gableRoof, hipRoof, coneRoof, dome, line } from './geom.mjs';
import { layer, concat, placeAt, rotate, translate } from './plan.mjs';
import { withProps, rotateDir, rotatePoint, dirStep, DIRS, stepDir } from './blockstate.mjs';
import { palette as makePalette } from './palettes.mjs';

const pal = p => (p && typeof p === 'object' ? makePalette(p) : makePalette(p || 'stoneCastle'));
const stairs = (id, facing, half = 'bottom') => withProps(id, { facing, half });
const log = (id, axis) => withProps(id, { axis });
const half = n => Math.floor(n / 2);

/** Groups [{ p, dir }] into one layer per facing, as stairs of `id` (half bottom or top). */
function stairLayers(id, cells, halfType = 'bottom') {
    const by = {};
    for (const { p, dir } of cells) (by[dir] ||= []).push(p);
    return Object.entries(by).map(([dir, points]) => ({ block: stairs(id, dir, halfType), points }));
}

/** Cells of `ringCells` sorted by angle around (cx, cz); every other one (a merlon pattern). */
function alternate(ringCells, cx = 0, cz = 0) {
    const sorted = [...ringCells].sort((a, b) => Math.atan2(a[2] - cz, a[0] - cx) - Math.atan2(b[2] - cz, b[0] - cx));
    return sorted.filter((_, i) => i % 2 === 0);
}

/** A door: lower and upper halves (`facing` = the way you look when you walk in). */
export function door(id, [x, y, z], facing, hinge = 'left') {
    return concat(
        layer(withProps(id, { facing, half: 'lower', hinge }), [[x, y, z]]),
        layer(withProps(id, { facing, half: 'upper', hinge }), [[x, y + 1, z]]),
    );
}

// ------------------------------------------------------------------------------------------------------- tower

/**
 * A round tower centred on (0, 0, 0): floor at y = 0, wall ring of `radius` from y = 1 to height - 1, top platform at
 * y = height. roof: 'flat' (parapet + merlons when crenellations), 'cone', 'dome' or 'none'. overhang widens the top
 * by one ring. stairs: 'auto' (spiral when radius >= 3, else ladder), 'spiral', 'ladder' or 'none'.
 * openings: [{ side, y = 1, height = 2, width = 1, door = false }] cut through the ring on a cardinal side.
 * landings: [y] — an interior floor ring at those levels (around the spiral), e.g. where a wall walkway arrives.
 * windowSides: the sides that get a glass slit every `windowEvery` blocks.
 */
export function tower({
    radius = 3, height = 10, roof = 'flat', crenellations = true, overhang = true, stairs: stairKind = 'auto',
    openings = [], landings = [], windowSides = DIRS, windowEvery = 5, lights = true, palette,
} = {}) {
    const P = pal(palette);
    if (radius < 2) throw new Error('tower: radius must be >= 2');
    if (height < 4) throw new Error('tower: height must be >= 4');
    const kind = stairKind === 'auto' ? (radius >= 3 ? 'spiral' : 'ladder') : stairKind;
    if (kind === 'spiral' && radius < 3) throw new Error('tower: a spiral staircase needs radius >= 3');
    const R = overhang ? radius + 1 : radius;
    // The ring cell on a cardinal side, k blocks off its centre line (cells (r, ±1) are on the ring too).
    const sideCell = (side, k, r) => { const [dx, dz] = dirStep(side); return dx ? [dx * r, k] : [k, dz * r]; };
    const atSide = (side, y, k, r) => { const [x, z] = sideCell(side, k, r); return [x, y, z]; };

    const plan = [];
    // Floor and walls.
    plan.push(...layer(P.trim, ring(0, 0, 0, radius)), ...layer(P.floor, disc(0, 0, 0, radius - 1)));
    plan.push(...layer(P.wall, cylinder(0, 0, radius, 1, height - 1, { hollow: true })));
    // Top platform (the wall top and the overhang ring in trim).
    plan.push(...layer(P.floor, disc(0, height, 0, radius - 1)), ...layer(P.trim, ring(0, height, 0, radius)));
    if (overhang) plan.push(...layer(P.trim, ring(0, height, 0, R)));
    for (const y of landings) {
        const hole = kind === 'spiral' ? new Set(box([-1, y, -1], [1, y, 1]).map(String)) : new Set();
        plan.push(...layer(P.floor, disc(0, y, 0, radius - 1).filter(p => !hole.has(String(p)))));
    }
    // Roof.
    if (roof === 'flat' && crenellations) {
        plan.push(...layer(P.wall, ring(0, height + 1, 0, R)));
        plan.push(...layer(P.wall, alternate(ring(0, height + 2, 0, R))));
    } else if (roof === 'cone') {
        const c = coneRoof(0, 0, R, height + 1);
        plan.push(...stairLayers(P.roofStairs, c.slope), ...layer(P.roof, c.cap));
    } else if (roof === 'dome') {
        plan.push(...layer(P.roof, dome([0, height + 1, 0], R)));
    } else if (roof !== 'flat' && roof !== 'none') throw new Error(`tower: unknown roof '${roof}'`);
    // Climbing.
    if (kind === 'spiral') {
        plan.push(...layer(P.wall, line([0, 1, 0], [0, height - 1, 0])));
        const steps = spiralSquare(0, 0, 1, 1, height);
        plan.push(...stairLayers(P.stairs, steps));
        plan.push(...layer('minecraft:air', steps.filter(s => s.p[1] >= height - 3 && s.p[1] < height).map(s => [s.p[0], height, s.p[2]])));
    } else if (kind === 'ladder') {
        const blocked = new Set(openings.map(o => o.side));
        const side = ['west', 'north', 'east', 'south'].find(s => !blocked.has(s)) || 'west';
        const [x, z] = sideCell(side, 0, radius - 1);
        plan.push(...layer(withProps('minecraft:ladder', { facing: rotateDir(side, 2) }), line([x, 1, z], [x, height, z])));
    } else if (kind !== 'none') throw new Error(`tower: unknown stairs '${stairKind}'`);
    // Windows, then openings (later writes win).
    for (const side of windowSides) {
        for (let y = 3; y + 1 < height; y += windowEvery) {
            if (openings.some(o => o.side === side && y + 1 >= (o.y ?? 1) && y <= (o.y ?? 1) + (o.height ?? 2) - 1)) continue;
            plan.push(...layer(P.glass, [atSide(side, y, 0, radius), atSide(side, y + 1, 0, radius)]));
        }
    }
    for (const o of openings) {
        const y0 = o.y ?? 1, h = o.height ?? 2, w = o.width ?? 1;
        const cells = [];
        for (let k = -half(w - 1); k <= w - 1 - half(w - 1); k++) for (let y = y0; y < y0 + h; y++) cells.push(atSide(o.side, y, k, radius));
        plan.push(...layer('minecraft:air', cells));
        if (o.door) plan.push(...door(P.door, atSide(o.side, y0, 0, radius), rotateDir(o.side, 2)));
    }
    // Lights: wall torches inside every 6 blocks, lanterns on the top platform.
    if (lights) {
        for (let y = 2, i = 0; y < height - 1; y += 6, i++) {
            const t = i % 4; // a different wall each time
            const p = rotatePoint([radius - 1, y, 1], t);
            plan.push(...layer(withProps('minecraft:wall_torch', { facing: rotateDir('west', t) }), [p]));
        }
        if (roof !== 'none') plan.push(...layer(P.light, [0, 1, 2, 3].map(t => rotatePoint([radius - 1, height + 1, 1], t))));
    }
    return plan;
}

// -------------------------------------------------------------------------------------------------------- wall

/**
 * A straight curtain wall from `from` [x, z] to `to` [x, z] (axis-aligned), its body from y to y + height - 1,
 * `thickness` blocks thick, centred on the line. walkway: the top is a walkway in trim (needs thickness >= 3).
 * crenellations: 'outer' (needs `outer`, the side facing away from the courtyard), 'both' or 'none'.
 * A parapet course and alternating merlons sit above the walkway on the crenellated faces; lights put a
 * lantern every 8 blocks on the inner face (or on the parapet when both faces are crenellated).
 */
export function wall({
    from = [0, 0], to = [15, 0], y = 0, height = 6, thickness = 3, walkway = true, crenellations = 'both',
    outer = null, lights = true, palette,
} = {}) {
    const P = pal(palette);
    const dx = to[0] - from[0], dz = to[1] - from[1];
    if (dx && dz) throw new Error('wall: from and to must share an x or a z (axis-aligned); rotate a plan for other angles');
    const L = Math.abs(dx || dz) + 1;
    const dir = dx || dz ? stepDir(dx, dz) : 'east';
    const turns = DIRS.indexOf(dir) - 1; // local frame runs east
    if (crenellations === 'outer' && !outer) throw new Error("wall: crenellations 'outer' needs outer (a side)");
    const localOuter = outer ? rotateDir(outer, -turns) : null;
    if (localOuter && localOuter !== 'north' && localOuter !== 'south') throw new Error(`wall: outer '${outer}' is not across the wall`);
    // Local frame: x = 0..L-1 east, z from -half(thickness-1).
    const z0 = -half(thickness - 1), z1 = z0 + thickness - 1, top = y + height - 1;
    const plan = [];
    plan.push(...layer(P.trim, box([0, y, z0], [L - 1, y, z1])));
    plan.push(...layer(P.wall, box([0, y + 1, z0], [L - 1, top, z1])));
    if (walkway && thickness >= 3) plan.push(...layer(P.trim, box([0, top, z0 + 1], [L - 1, top, z1 - 1])));
    const faces = crenellations === 'both' ? [z0, z1] : crenellations === 'outer' ? [localOuter === 'north' ? z0 : z1] : [];
    for (const fz of faces) {
        plan.push(...layer(P.wall, line([0, top + 1, fz], [L - 1, top + 1, fz])));
        plan.push(...layer(P.wall, line([0, top + 2, fz], [L - 1, top + 2, fz]).filter(([x]) => x % 2 === 0)));
    }
    if (lights && walkway && thickness >= 3) {
        const inner = faces.length === 2 ? null : faces[0] === z0 ? z1 : z0;
        const pts = [];
        for (let x = 3; x < L - 2; x += 8) pts.push(inner === null ? [x, top + 2, z0] : [x, top + 1, inner]);
        // On a crenellated face, x odd is a gap between merlons: put the lantern on the parapet there.
        plan.push(...layer(P.light, pts.map(([x, yy, z]) => (inner === null && x % 2 === 0 ? [x + 1, yy, z] : [x, yy, z]))));
    }
    return placeAt(plan, { at: [from[0], 0, from[1]], turns });
}

// --------------------------------------------------------------------------------------------------- gatehouse

/**
 * A gatehouse: a rectangular block with an arched passage `width` × `height` running along Z through its full
 * `depth`. Local frame: the passage is centred on x = 0, the front (north) face at z = 0, the back face at
 * z = depth - 1. Side rooms flank the passage (a door into each at mid-depth, a ladder up in the west one);
 * an upper floor at `upperFloor`, a crenellated roof at the body top. `sideDoors` cuts an opening on the east
 * and west faces at y = upperFloor + 1 (where a wall walkway arrives). turrets: two small cone-roofed
 * turrets at the front corners (they reach 3 blocks past the sides and the front). width must be odd.
 */
export function gatehouse({
    width = 3, height = 4, depth = 7, sideWidth = 3, upperFloor = null, bodyHeight = null, sideDoors = false,
    turrets = true, portcullis = true, palette,
} = {}) {
    const P = pal(palette);
    if (width % 2 === 0) throw new Error('gatehouse: width must be odd');
    const up = upperFloor ?? height + 2;
    if (up < height + 2) throw new Error(`gatehouse: upperFloor must be >= height + 2 (${height + 2})`);
    const H = bodyHeight ?? up + 4;
    const hw = half(width) + sideWidth + 1, zb = depth - 1, mid = half(depth);
    const cx = u => u - half(width);
    const plan = [];
    plan.push(...layer(P.trim, box([-hw, 0, 0], [hw, 0, zb])));
    plan.push(...layer(P.wall, walls([-hw, 1, 0], [hw, H - 1, zb])));
    plan.push(...layer(P.floor, box([-hw + 1, up, 1], [hw - 1, up, zb - 1])));
    plan.push(...layer(P.trim, box([-hw, H, 0], [hw, H, zb])));
    plan.push(...layer(P.wall, rectRing(-hw, 0, hw, zb, H + 1)));
    plan.push(...layer(P.wall, rectRing(-hw, 0, hw, zb, H + 2).filter(([x, , z]) => (x + z) % 2 === 0)));
    // The vaulted passage: lining through the whole depth, trim on both faces, a keystone, air inside.
    const lining = extrude(archRing(width, height, 1), 'x', depth).map(([u, v, z]) => [cx(u), 1 + v, z]);
    plan.push(...layer(P.wall, lining));
    plan.push(...layer(P.trim, lining.filter(([, , z]) => z === 0 || z === zb)));
    plan.push(...layer(P.accent, [[0, height + 1, 0], [0, height + 1, zb]]));
    const passage = extrude(archOpening(width, height), 'x', depth).map(([u, v, z]) => [cx(u), 1 + v, z]);
    plan.push(...layer('minecraft:air', passage));
    plan.push(...layer(P.path, box([-half(width), 0, 0], [half(width), 0, zb])));
    if (portcullis) plan.push(...layer(P.bars, passage.filter(([, y, z]) => z === 1 && y >= height - 1)));
    // Side rooms: a door from the passage, a ladder to the upper floor and the roof, slits upstairs.
    const sx = half(width) + 1;
    plan.push(...layer('minecraft:air', [[-sx, 1, mid], [-sx, 2, mid], [sx, 1, mid], [sx, 2, mid]]));
    plan.push(...layer(withProps('minecraft:ladder', { facing: 'east' }), line([-hw + 1, 1, 1], [-hw + 1, H, 1])));
    plan.push(...layer(P.glass, [-hw + 2, hw - 2].flatMap(x => [[x, up + 2, 0], [x, up + 2, zb]])));
    if (sideDoors) plan.push(...layer('minecraft:air', [-hw, hw].flatMap(x => [[x, up + 1, mid], [x, up + 2, mid]])));
    // Torches either side of the arch, front and back; lanterns in the side rooms.
    plan.push(...layer(withProps('minecraft:wall_torch', { facing: 'north' }), [[-sx, 3, -1], [sx, 3, -1]]));
    plan.push(...layer(withProps('minecraft:wall_torch', { facing: 'south' }), [[-sx, 3, zb + 1], [sx, 3, zb + 1]]));
    plan.push(...layer(P.light, [[hw - 1, 1, zb - 1], [-hw + 2, up + 1, zb - 1], [hw - 1, up + 1, 1]]));
    if (turrets) {
        const t = tower({ radius: 2, height: H + 2, roof: 'cone', overhang: false, stairs: 'none', windowSides: [], lights: false, palette: P });
        // Centred one block out from each front corner: their rings only overwrite the gatehouse's own shell.
        plan.push(...placeAt(t, { at: [-hw - 1, 0, -1] }), ...placeAt(t, { at: [hw + 1, 0, -1] }));
    }
    return plan;
}

// ------------------------------------------------------------------------------------------------------- house

/**
 * A timber-framed house. The footprint is x = 0..w-1, z = 0..d-1 (walls included) whatever the door side;
 * `floors` storeys of `floorHeight`, log posts at the corners and log beams (axis along each beam) at every
 * storey top. roof: 'gable' (ridge along the longer side) or 'hip'. door: the side the front door is on.
 * furnish: a crafting table, a furnace and a chest along the back wall, a hanging lantern per storey, a ladder
 * between storeys.
 */
export function house({ w = 7, d = 9, floors = 1, floorHeight = 4, roof = 'gable', door: doorSide = 'north', furnish = true, palette = 'oakCottage' } = {}) {
    const P = pal(palette);
    const turns = DIRS.indexOf(doorSide);
    if (turns < 0) throw new Error(`house: unknown door side '${doorSide}'`);
    if (w < 5 || d < 5) throw new Error('house: w and d must be >= 5');
    // Built with the door on the local north side, then turned; local width/depth swap on an odd turn.
    const [lw, ld] = turns % 2 ? [d, w] : [w, d];
    const top = floors * floorHeight, X = lw - 1, Z = ld - 1, cxd = half(lw);
    const plan = [];
    plan.push(...layer(P.trim, rectRing(0, 0, X, Z, 0)), ...layer(P.floor, box([1, 0, 1], [X - 1, 0, Z - 1])));
    plan.push(...layer(P.wall, walls([0, 1, 0], [X, top, Z])));
    for (let f = 1; f <= floors; f++) {
        const y = f * floorHeight;
        plan.push(...layer(log(P.pillar, 'x'), [...line([1, y, 0], [X - 1, y, 0]), ...line([1, y, Z], [X - 1, y, Z])]));
        plan.push(...layer(log(P.pillar, 'z'), [...line([0, y, 1], [0, y, Z - 1]), ...line([X, y, 1], [X, y, Z - 1])]));
        plan.push(...layer(P.floor, box([1, y, 1], [X - 1, y, Z - 1])));
    }
    plan.push(...layer(log(P.pillar, 'y'), [[0, 0], [X, 0], [0, Z], [X, Z]].flatMap(([x, z]) => line([x, 1, z], [x, top, z]))));
    // Windows: every third cell along each wall, on each storey, away from the corners and the door.
    const win = [];
    for (let f = 0; f < floors; f++) {
        const ys = floorHeight >= 5 ? [f * floorHeight + 2, f * floorHeight + 3] : [f * floorHeight + 2];
        for (let x = 2; x <= X - 2; x += 2) {
            if (!(f === 0 && Math.abs(x - cxd) <= 1)) for (const y of ys) win.push([x, y, 0]);
            for (const y of ys) win.push([x, y, Z]);
        }
        for (let z = 2; z <= Z - 2; z += 2) for (const y of ys) win.push([0, y, z], [X, y, z]);
    }
    plan.push(...layer(P.glass, win));
    // Roof.
    if (roof === 'gable') {
        const g = gableRoof({ x0: 0, z0: 0, x1: X, z1: Z, base: top + 1, ridge: lw >= ld ? 'x' : 'z', overhang: 1 });
        plan.push(...layer(P.wall, g.gable), ...stairLayers(P.roofStairs, g.slope), ...layer(withProps(P.roofSlab, { type: 'bottom' }), g.ridge));
        plan.push(...stairLayers(P.roofStairs, g.eaves, 'top'));
    } else if (roof === 'hip') {
        const h = hipRoof({ x0: 0, z0: 0, x1: X, z1: Z, base: top + 1, overhang: 1 });
        plan.push(...stairLayers(P.roofStairs, h.slope), ...layer(withProps(P.roofSlab, { type: 'bottom' }), h.ridge));
    } else throw new Error(`house: unknown roof '${roof}'`);
    // Door, step, torches.
    plan.push(...door(P.door, [cxd, 1, 0], 'south'));
    plan.push(...layer(P.path, [[cxd, 0, -1]]));
    plan.push(...layer(withProps('minecraft:wall_torch', { facing: 'north' }), [[cxd - 1, 2, -1], [cxd + 1, 2, -1]]));
    if (furnish) {
        plan.push(...layer('minecraft:crafting_table', [[1, 1, Z - 1]]));
        plan.push(...layer(withProps('minecraft:furnace', { facing: 'north' }), [[2, 1, Z - 1]]));
        if (lw >= 6) plan.push(...layer(withProps('minecraft:chest', { facing: 'north' }), [[3, 1, Z - 1]]));
        for (let f = 0; f < floors; f++) plan.push(...layer(withProps(P.light, { hanging: 'true' }), [[cxd, (f + 1) * floorHeight - 1, half(ld)]]));
        if (floors > 1) plan.push(...layer(withProps('minecraft:ladder', { facing: 'west' }), line([X - 1, 1, 1], [X - 1, (floors - 1) * floorHeight, 1])));
    }
    // Turn so the door faces doorSide, then bring the footprint back to x = 0..w-1, z = 0..d-1.
    if (!turns) return plan;
    const corners = [[0, 0, 0], [X, 0, Z]].map(p => rotatePoint(p, turns));
    return translate(rotate(plan, turns), -Math.min(corners[0][0], corners[1][0]), 0, -Math.min(corners[0][2], corners[1][2]));
}

// ------------------------------------------------------------------------------------------------------ bridge

/**
 * A footbridge along +X from x = 0 to length - 1, `width` walkable blocks centred on z = 0, rising `rise` blocks
 * (one per block, as stairs) from each end to a flat middle. Railings on both edges, lanterns on the posts at
 * both ends and the middle; piers (pierDepth > 0) go down that far under the middle.
 */
export function bridge({ length = 15, width = 3, rise = 2, railings = true, lights = true, pierDepth = 0, palette } = {}) {
    const P = pal(palette);
    if (length < 2 * rise + 2) throw new Error(`bridge: length must be >= ${2 * rise + 2} for rise ${rise}`);
    const h = (x) => Math.min(rise, x, length - 1 - x);
    const zl = -half(width - 1) - (railings ? 1 : 0), zh = zl + width - 1 + (railings ? 2 : 0);
    const deck = [], east = [], west = [];
    for (let x = 0; x < length; x++) {
        const y = h(x);
        for (let z = zl; z <= zh; z++) {
            if (x > 0 && y > h(x - 1)) east.push({ p: [x, y, z], dir: 'east' });
            else if (x < length - 1 && y > h(x + 1)) west.push({ p: [x, y, z], dir: 'west' });
            else deck.push([x, y, z]);
        }
    }
    const plan = concat(layer(P.floor, deck), stairLayers(P.stairs, [...east, ...west]));
    if (railings) plan.push(...layer(P.fence, [zl, zh].flatMap(z => Array.from({ length }, (_, x) => [x, h(x) + 1, z]))));
    if (lights && railings) {
        const xs = [0, half(length), length - 1];
        plan.push(...layer(P.light, xs.flatMap(x => [[x, h(x) + 2, zl], [x, h(x) + 2, zh]])));
    }
    if (pierDepth > 0) plan.push(...layer(P.wall, box([half(length) - 1, h(half(length)) - pierDepth, zl], [half(length) + 1, h(half(length)) - 1, zh])));
    return plan;
}

// ----------------------------------------------------------------------------------------------- stairsBetween

/**
 * A straight flight of stairs from a = [x, y, z] to b (either may be the higher end), along the dominant
 * horizontal axis, `width` blocks wide (centred), climbing at most one block per block. Stairs face the way
 * up; level cells are `landing` blocks. fill: solid support under every cell down to the lower end's y.
 */
export function stairsBetween(a, b, { width = 1, block, landing, fill = false, fillBlock, palette } = {}) {
    const P = pal(palette);
    let [lo, hi] = a[1] <= b[1] ? [a, b] : [b, a];
    const dx = hi[0] - lo[0], dz = hi[2] - lo[2], dy = hi[1] - lo[1];
    const n = Math.max(Math.abs(dx), Math.abs(dz));
    if (dy > n) throw new Error(`stairsBetween: climbing ${dy} needs at least ${dy} blocks of run, got ${n}`);
    if (n === 0) return layer(landing || P.floor, [lo]);
    const dir = stepDir(Math.abs(dx) >= Math.abs(dz) ? dx : 0, Math.abs(dx) >= Math.abs(dz) ? 0 : dz);
    const [sx, sz] = dirStep(dir), [px, pz] = dirStep(rotateDir(dir, 1));
    const cells = [], flat = [], under = [];
    let prev = lo[1];
    for (let i = 0; i <= n; i++) {
        const y = lo[1] + Math.round((dy * i) / n);
        for (let k = -half(width - 1); k <= width - 1 - half(width - 1); k++) {
            const p = [lo[0] + sx * i + px * k, y, lo[2] + sz * i + pz * k];
            if (i > 0 && y > prev) cells.push({ p, dir }); else flat.push(p);
            if (fill) for (let yy = lo[1]; yy < y; yy++) under.push([p[0], yy, p[2]]);
        }
        prev = y;
    }
    return concat(layer(fillBlock || P.wall, under), layer(landing || P.floor, flat), stairLayers(block || P.stairs, cells));
}

// ------------------------------------------------------------------------------------------------------ castle

/**
 * A square castle: four corner towers, curtain walls between them (crenellated outward, walkway on top), a
 * gatehouse in the middle of the north wall, a stair from the courtyard to the walkway along the west wall,
 * and a path from the gate to the centre. Local frame: the towers' centres are (0,0), (size,0), (0,size),
 * (size,size); the courtyard is inside; north is z = 0. Options pass through to the parts.
 */
export function castle({
    size = 22, towerRadius = 3, towerHeight = 11, towerRoof = 'cone', wallHeight = 7, wallThickness = 3,
    gate = {}, palette,
} = {}) {
    const P = pal(palette);
    const S = size, r = towerRadius, walk = wallHeight; // walkway surface: the body top is y = walk - 1
    const g = { width: 3, height: 4, depth: wallThickness + 3, sideWidth: 2, ...gate };
    const ghw = half(g.width) + g.sideWidth + 1;
    if (S - 2 * r - 2 < 2 * ghw + 1) throw new Error(`castle: size ${S} is too small for the gatehouse (needs ${2 * ghw + 2 * r + 3})`);
    if (towerHeight < walk + 3) throw new Error('castle: towerHeight must be >= wallHeight + 3');
    if (walk < g.height + 3) throw new Error(`castle: wallHeight must be >= gate height + 3 (${g.height + 3}): the gatehouse's upper floor is the walkway`);
    const common = { height: walk, thickness: wallThickness, walkway: true, crenellations: 'outer', palette: P };
    const plan = concat(
        wall({ ...common, from: [r, 0], to: [S - r, 0], outer: 'north' }),
        wall({ ...common, from: [r, S], to: [S - r, S], outer: 'south' }),
        wall({ ...common, from: [0, r], to: [0, S - r], outer: 'west' }),
        wall({ ...common, from: [S, r], to: [S, S - r], outer: 'east' }),
    );
    // Towers: openings at walkway level toward their two walls, a landing inside there.
    const corner = [[0, 0, ['east', 'south']], [S, 0, ['west', 'south']], [0, S, ['east', 'north']], [S, S, ['west', 'north']]];
    for (const [x, z, sides] of corner) {
        const outward = DIRS.filter(d => !sides.includes(d));
        plan.push(...placeAt(tower({
            radius: r, height: towerHeight, roof: towerRoof, palette: P, windowSides: outward,
            openings: sides.map(side => ({ side, y: walk })), landings: [walk - 1],
        }), { at: [x, 0, z] }));
    }
    // Gatehouse straddling the north wall; its upper floor meets the walkway.
    const gh = gatehouse({ ...g, upperFloor: walk - 1, sideDoors: true, palette: P });
    plan.push(...placeAt(gh, { at: [half(S), 0, -half(g.depth)] }));
    // Courtyard: a path from the gate to the centre, a flight up to the west walkway.
    const zIn = half(g.depth) + 1;
    plan.push(...layer(P.path, box([half(S) - 1, 0, zIn], [half(S) + 1, 0, half(S)])));
    const xIn = half(wallThickness - 1) + 1, zEnd = S - r - 2;
    plan.push(...stairsBetween([xIn, 0, zEnd - (walk - 1)], [xIn, walk - 1, zEnd], { width: 1, fill: true, palette: P }));
    return plan;
}
