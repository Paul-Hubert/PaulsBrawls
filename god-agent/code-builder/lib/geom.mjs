// Pure geometry: every function returns a list of integer points [[x, y, z], …] (offsets, one unit = one block).
// X east+, Y up+, Z south+. Boxes are inclusive of both corners. Circles are centred on a block: a cell is in
// the disc of radius r when dx² + dz² < (r + 0.5)², so radius 0 is one block and radius r spans 2r + 1 blocks.
// None of these know about blocks or the server; components (components.mjs) turn them into plans.

const key = (x, y, z) => `${x},${y},${z}`;

/** Drops duplicate points, keeping the first occurrence's order. */
export function uniq(points) {
    const seen = new Set(), out = [];
    for (const p of points) {
        const k = key(p[0], p[1], p[2]);
        if (!seen.has(k)) { seen.add(k); out.push([p[0], p[1], p[2]]); }
    }
    return out;
}

/** `points` minus every point that is in `remove`. */
export function subtract(points, remove) {
    const r = new Set(remove.map(p => key(p[0], p[1], p[2])));
    return points.filter(p => !r.has(key(p[0], p[1], p[2])));
}

export const translatePoints = (points, dx = 0, dy = 0, dz = 0) => points.map(([x, y, z]) => [x + dx, y + dy, z + dz]);

/** Every block on the straight segment a -> b, both ends included (steps along the longest axis). */
export function line([x0, y0, z0], [x1, y1, z1]) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    if (n === 0) return [[x0, y0, z0]];
    const out = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        out.push([Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), Math.round(z0 + (z1 - z0) * t)]);
    }
    return uniq(out);
}

/** A polyline through several points. */
export const polyline = pts => uniq(pts.slice(1).flatMap((p, i) => line(pts[i], p)));

const range = (a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b), r = []; for (let i = lo; i <= hi; i++) r.push(i); return r; };

/** A solid box between two corners (inclusive). */
export function box([x0, y0, z0], [x1, y1, z1]) {
    const out = [];
    for (const y of range(y0, y1)) for (const z of range(z0, z1)) for (const x of range(x0, x1)) out.push([x, y, z]);
    return out;
}

/** The shell of a box: its six faces. */
export function hollowBox(a, b) {
    const [xl, xh] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
    const [yl, yh] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    const [zl, zh] = [Math.min(a[2], b[2]), Math.max(a[2], b[2])];
    return box(a, b).filter(([x, y, z]) => x === xl || x === xh || y === yl || y === yh || z === zl || z === zh);
}

/** The four side walls of a box, no floor and no ceiling. */
export function walls(a, b) {
    const [xl, xh] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
    const [zl, zh] = [Math.min(a[2], b[2]), Math.max(a[2], b[2])];
    return box(a, b).filter(([x, , z]) => x === xl || x === xh || z === zl || z === zh);
}

/** The twelve edges of a box (a frame: corner posts and the rims). */
export function frame(a, b) {
    const [xl, xh] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
    const [yl, yh] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    const [zl, zh] = [Math.min(a[2], b[2]), Math.max(a[2], b[2])];
    return box(a, b).filter(([x, y, z]) => ((x === xl || x === xh) + (y === yl || y === yh) + (z === zl || z === zh)) >= 2);
}

/** A rectangle ring at height y: the perimeter of x0..x1 × z0..z1. */
export const rectRing = (x0, z0, x1, z1, y) => walls([x0, y, z0], [x1, y, z1]);

const inDisc = (dx, dz, r) => dx * dx + dz * dz < (r + 0.5) * (r + 0.5);

/** A filled disc (one layer) of radius r around (cx, y, cz). */
export function disc(cx, y, cz, r) {
    const out = [];
    const R = Math.ceil(r);
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) if (inDisc(dx, dz, r)) out.push([cx + dx, y, cz + dz]);
    return out;
}

/** The outer ring of a disc, `thickness` blocks thick (the cells of disc(r) not in disc(r - thickness)). */
export function ring(cx, y, cz, r, thickness = 1) {
    return disc(cx, y, cz, r).filter(([x, , z]) => !inDisc(x - cx, z - cz, r - thickness));
}

/** A vertical cylinder from y0 to y1 (inclusive); hollow = only its ring of `thickness`. */
export function cylinder(cx, cz, r, y0, y1, { hollow = false, thickness = 1 } = {}) {
    const layer = hollow ? ring(cx, 0, cz, r, thickness) : disc(cx, 0, cz, r);
    const out = [];
    for (const y of range(y0, y1)) for (const [x, , z] of layer) out.push([x, y, z]);
    return out;
}

const inBall = (dx, dy, dz, r) => dx * dx + dy * dy + dz * dz < (r + 0.5) * (r + 0.5);

/** A solid ball of radius r around c. */
export function sphere([cx, cy, cz], r) {
    const out = [], R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++)
        if (inBall(dx, dy, dz, r)) out.push([cx + dx, cy + dy, cz + dz]);
    return out;
}

/** The shell of a ball: cells of sphere(r) not in sphere(r - thickness). Watertight for thickness >= 1. */
export function sphereShell(c, r, thickness = 1) {
    return sphere(c, r).filter(([x, y, z]) => !inBall(x - c[0], y - c[1], z - c[2], r - thickness));
}

/** The upper half (y >= cy) of a sphere shell: a dome standing on the plane y = cy. */
export const dome = (c, r, thickness = 1) => sphereShell(c, r, thickness).filter(p => p[1] >= c[1]);

/**
 * The 2D cells (u, v) inside an arched opening `width` wide and `height` tall: straight sides, then a
 * semicircular top. u runs 0..width-1, v 0..height-1 (v = 0 is the sill).
 */
export function archOpening(width, height) {
    const c = (width - 1) / 2, R = width / 2, spring = height - R;
    const out = [];
    for (let v = 0; v < height; v++) for (let u = 0; u < width; u++)
        if (v <= spring || (u - c) ** 2 + (v - spring) ** 2 < R * R) out.push([u, v]);
    return out;
}

/** The 2D cells of the arch ring `thickness` thick around archOpening(width, height). u may be negative. */
export function archRing(width, height, thickness = 1) {
    const inside = new Set(archOpening(width, height).map(([u, v]) => `${u},${v}`));
    const c = (width - 1) / 2, R = width / 2 + thickness, spring = height - width / 2;
    const out = [];
    for (let v = 0; v < height + thickness; v++) for (let u = -thickness; u < width + thickness; u++) {
        if (inside.has(`${u},${v}`)) continue;
        if (v <= spring || (u - c) ** 2 + (v - spring) ** 2 < R * R) out.push([u, v]);
    }
    return out;
}

/**
 * Extrudes 2D (u, v) cells into 3D: u along `axis` ('x' or 'z'), v = y, and `depth` layers along the other
 * horizontal axis (0..depth-1).
 */
export function extrude(cells, axis, depth = 1) {
    const out = [];
    for (let d = 0; d < depth; d++) for (const [u, v] of cells) out.push(axis === 'x' ? [u, v, d] : [d, v, u]);
    return out;
}

/**
 * A spiral staircase path climbing one block per step around a square of half-size `half` centred on
 * (cx, cz): the 8·half cells of that square ring, walked clockwise from its north-west corner. Returns
 * [{ p: [x, y, z], dir }] where dir is the direction of the next step (the way a stair there must face).
 */
export function spiralSquare(cx, cz, half, y0, y1) {
    const loop = [];
    for (let x = -half; x < half; x++) loop.push([x, -half]);           // north side, going east
    for (let z = -half; z < half; z++) loop.push([half, z]);            // east side, going south
    for (let x = half; x > -half; x--) loop.push([x, half]);            // south side, going west
    for (let z = half; z > -half; z--) loop.push([-half, z]);           // west side, going north
    const out = [];
    for (let i = 0, y = y0; y <= y1; i++, y++) {
        const [u, w] = loop[i % loop.length], [nu, nw] = loop[(i + 1) % loop.length];
        const dx = nu - u, dz = nw - w;
        out.push({ p: [cx + u, y, cz + w], dir: dx > 0 ? 'east' : dx < 0 ? 'west' : dz > 0 ? 'south' : 'north' });
    }
    return out;
}

/**
 * A helix of single cells at radius r around (cx, cz), `perTurn` cells per turn, rising `rise` blocks per
 * turn: for spiral ramps, vines, decorative coils. Returns points.
 */
export function helix(cx, cz, r, y0, turns, { perTurn = 24, rise = 8 } = {}) {
    const out = [];
    for (let i = 0; i <= turns * perTurn; i++) {
        const a = (2 * Math.PI * i) / perTurn;
        out.push([cx + Math.round(r * Math.cos(a)), y0 + Math.round((rise * i) / perTurn), cz + Math.round(r * Math.sin(a))]);
    }
    return uniq(out);
}

/**
 * A gable roof over the rectangle x0..x1 × z0..z1 (the wall tops), on top of y = base. The ridge runs along
 * `ridge` ('x' or 'z'); the roof sticks out `overhang` blocks past the walls. Returns
 *   slope:  [{ p, dir }]   one stair per cell, dir = the way Y rises (toward the ridge: the stair's facing)
 *   ridge:  [p]            the top row when the span is odd (a full block or a slab)
 *   gable:  [p]            the two triangular wall ends under the roof (above base, inside the walls)
 *   eaves:  [{ p, dir }]   one row under the lowest stairs, just outside the walls (upside-down stairs)
 */
export function gableRoof({ x0, z0, x1, z1, base, ridge = 'x', overhang = 1 }) {
    const slope = [], ridgeRow = [], gable = [], eaves = [];
    const along = ridge === 'x' ? [x0 - overhang, x1 + overhang] : [z0 - overhang, z1 + overhang];
    const [lo, hi] = ridge === 'x' ? [z0, z1] : [x0, x1];      // the span across the ridge, walls only
    const ends = ridge === 'x' ? [x0, x1] : [z0, z1];         // the gable-end walls
    const P = (a, y, s) => (ridge === 'x' ? [a, y, s] : [s, y, a]);
    const up = ridge === 'x' ? ['south', 'north'] : ['east', 'west']; // facing on the low side, high side
    for (let k = 0; ; k++) {
        const sLo = lo - overhang + k, sHi = hi + overhang - k, y = base + k;
        if (sLo > sHi) break;
        for (let a = along[0]; a <= along[1]; a++) {
            if (sLo === sHi) ridgeRow.push(P(a, y, sLo));
            else { slope.push({ p: P(a, y, sLo), dir: up[0] }); slope.push({ p: P(a, y, sHi), dir: up[1] }); }
        }
        for (const e of ends) for (let s = Math.max(sLo + 1, lo); s <= Math.min(sHi - 1, hi); s++) gable.push(P(e, y, s));
        if (sLo === sHi) break;
    }
    if (overhang >= 1) for (let a = along[0]; a <= along[1]; a++) {
        eaves.push({ p: P(a, base - 1, lo - 1), dir: up[0] });
        eaves.push({ p: P(a, base - 1, hi + 1), dir: up[1] });
    }
    return { slope, ridge: ridgeRow, gable, eaves };
}

/**
 * A hip roof over x0..x1 × z0..z1 on top of y = base: four slopes rising one block per ring until they meet.
 * Returns { slope: [{ p, dir }], ridge: [p] }; the four corner stairs are reshaped by finalize().
 */
export function hipRoof({ x0, z0, x1, z1, base, overhang = 1 }) {
    const slope = [], ridgeRow = [];
    for (let k = 0; ; k++) {
        const a0 = x0 - overhang + k, a1 = x1 + overhang - k, b0 = z0 - overhang + k, b1 = z1 + overhang - k;
        const y = base + k;
        if (a0 > a1 || b0 > b1) break;
        if (a0 === a1 || b0 === b1) { for (const p of box([a0, y, b0], [a1, y, b1])) ridgeRow.push(p); break; }
        for (let x = a0; x <= a1; x++) {
            slope.push({ p: [x, y, b0], dir: 'south' });
            slope.push({ p: [x, y, b1], dir: 'north' });
        }
        for (let z = b0 + 1; z < b1; z++) {
            slope.push({ p: [a0, y, z], dir: 'east' });
            slope.push({ p: [a1, y, z], dir: 'west' });
        }
    }
    return { slope, ridge: ridgeRow };
}

/**
 * A cone roof (45°) over a round tower: rings of shrinking radius from r at y = base, up to a single cap
 * block and a spire. Returns { slope: [{ p, dir }], cap: [p] }, dir pointing toward the centre (the stair's facing).
 */
export function coneRoof(cx, cz, r, base) {
    const slope = [];
    let y = base, rr = r;
    for (; rr >= 1; rr--, y++) {
        for (const [x, , z] of ring(cx, 0, cz, rr)) {
            const dx = cx - x, dz = cz - z;
            const dir = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
            slope.push({ p: [x, y, z], dir });
        }
    }
    return { slope, cap: [[cx, y - 1, cz], [cx, y, cz]] }; // centre of the last ring + a spire block
}

/** Axis-aligned bounding box of points: { min: [x,y,z], max: [x,y,z], size: [w,h,d] } (null when empty). */
export function bbox(points) {
    if (!points.length) return null;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let i = 0; i < 3; i++) { if (p[i] < min[i]) min[i] = p[i]; if (p[i] > max[i]) max[i] = p[i]; }
    return { min, max, size: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1] };
}
