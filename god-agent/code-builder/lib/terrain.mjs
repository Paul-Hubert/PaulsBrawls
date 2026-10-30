// Building on real terrain (a hill, a forest) instead of superflat: an exact heightmap read through query_terrain,
// trees told apart from the ground, and the earthwork that sits parts on the slope (level pads with foundations and
// retaining walls, roads that climb at most one block per block) and cuts down the trees in the way.
//
// Everything here works in ABSOLUTE world coordinates [x, y, z]; a build script composes in them and translates the
// finished plan to its anchor (translate(plan, -pivot...)) at the end. Earthwork goes into its own plan, which the
// script places BEFORE its structures: later layers win, so a house always overwrites the pad's air and fill.

import { layer, concat } from './plan.mjs';

const SHADE = ' .:-=+*#%@';
const GRID = 16;
const key = (x, z) => `${x},${z}`;

// ------------------------------------------------------------------------------------------------ the heightmap

/**
 * One query_terrain answer, parsed: { cx, cz, r, step, lo, hi, clamped, rows } where rows[gz][gx] is the cell's
 * character (shade, '~' water, '?' unloaded) and cell (gx, gz) is world (cx - r + gx·step, cz - r + gz·step).
 * Null when the text is not a map (an unloaded area).
 */
export function parseTerrain(text) {
    const head = /center=\((-?\d+),(-?\d+)\) radius=(\d+) step=(\d+)/.exec(text);
    const range = /Y range (-?\d+)\.\.(-?\d+)/.exec(text);
    if (!head || !range) return null;
    const lines = text.split('\n');
    const at = lines.findIndex(l => l.startsWith('Legend'));
    if (at < 0) return null;
    // A cell is "c " (character + space); a trimmed trailing space is the lowest shade.
    const rows = lines.slice(at + 1, at + 1 + GRID).map(l => Array.from({ length: GRID }, (_, k) => l[2 * k] ?? ' '));
    if (rows.length < GRID) return null;
    return { cx: +head[1], cz: +head[2], r: +head[3], step: +head[4], lo: +range[1], hi: +range[2], clamped: /clamped/.test(text), rows };
}

/** An empty scan of x0..x1 × z0..z1: lo/hi bounds per cell (null: never seen), water flags. */
export function emptyScan(x0, z0, x1, z1) {
    const W = x1 - x0 + 1, D = z1 - z0 + 1;
    const grid = v => Array.from({ length: D }, () => Array(W).fill(v));
    return { x0, z0, x1, z1, lo: grid(null), hi: grid(null), water: grid(false) };
}

/**
 * Folds one parsed full-resolution tile (step 1) into a scan. The server shades a cell
 * round((y - lo) / span · 9), so each shade is an interval of heights; intersecting the intervals of tiles with
 * different ranges pins the height. Returns false (and folds nothing) for a clamped or coarse tile.
 */
export function foldTile(scan, t) {
    if (!t || t.clamped || t.step !== 1) return false;
    const span = Math.max(1, t.hi - t.lo);
    for (let gz = 0; gz < GRID; gz++) for (let gx = 0; gx < GRID; gx++) {
        const X = t.cx - t.r + gx - scan.x0, Z = t.cz - t.r + gz - scan.z0;
        if (Z < 0 || Z >= scan.lo.length || X < 0 || X >= scan.lo[0].length) continue;
        const c = t.rows[gz][gx];
        if (c === '?') continue;
        if (c === '~') { scan.water[Z][X] = true; continue; }
        const i = SHADE.indexOf(c);
        if (i < 0) continue;
        const a = Math.max(t.lo, Math.ceil(t.lo + ((i - 0.5) * span) / 9 - 1e-9));
        const b = Math.min(t.hi, Math.floor(t.lo + ((i + 0.5) * span) / 9 - 1e-9));
        scan.lo[Z][X] = scan.lo[Z][X] === null ? a : Math.max(scan.lo[Z][X], a);
        scan.hi[Z][X] = scan.hi[Z][X] === null ? b : Math.min(scan.hi[Z][X], b);
    }
    return true;
}

/**
 * Scans x0..x1 × z0..z1 (absolute) at full resolution with radius-8 tiles at several offsets (`client` from
 * open()). Heights come out exact on most cells and within a block or two elsewhere (lo/hi). The server clamps
 * a tile's centre to within 128 blocks of the ticket's player: such tiles are dropped, so stand near the site.
 * The heightmap is MOTION_BLOCKING_NO_LEAVES: logs count, leaves do not (groundModel tells trunks apart).
 */
export async function scanHeights(client, x0, z0, x1, z1, {
    offsets = [[0, 0], [8, 0], [0, 8], [8, 8], [4, 12], [12, 4]], log = () => {},
} = {}) {
    const scan = emptyScan(x0, z0, x1, z1);
    let tiles = 0, dropped = 0;
    for (const [ox, oz] of offsets) {
        for (let tz = z0 - 16 + oz; tz <= z1; tz += 16) for (let tx = x0 - 16 + ox; tx <= x1; tx += 16) {
            if (tx + 15 < x0 || tz + 15 < z0) continue;
            if (foldTile(scan, parseTerrain(await client.terrain(tx + 8, tz + 8, 8)))) tiles++; else dropped++;
        }
        log(`  scan: offset ${ox},${oz} done (${tiles} tiles, ${dropped} dropped)`);
    }
    return scan;
}

// ------------------------------------------------------------------------------------------------ ground model

/**
 * The ground under a scan. A tree shows in the heightmap as a 1 × 1 spike (its top log), so a cell is a trunk when
 * at least three of its four neighbours and the median of its eight are 3 or more below it: a slope never
 * qualifies (its uphill side is as high), and two trunks side by side still do. Returns
 * { top(x, z): the scanned height (logs included), ground(x, z): the ground (under a trunk: its low neighbours'
 *   median), groundHi(x, z): the highest the ground can be (for cuts that must reach it), water(x, z),
 *   trunks: [{ x, z, top, ground }], has(x, z) }; out of the scan or on water, heights are null.
 */
export function groundModel(scan) {
    const { x0, z0 } = scan, D = scan.lo.length, W = scan.lo[0].length;
    const mid = (x, z) => {
        const a = scan.lo[z - z0]?.[x - x0], b = scan.hi[z - z0]?.[x - x0];
        return a === null || a === undefined || scan.water[z - z0][x - x0] ? null : Math.round((a + Math.max(a, b)) / 2);
    };
    const median = v => { const s = [...v].sort((a, b) => a - b); return s[(s.length - 1) >> 1]; };
    const ground = new Map(), trunks = [];
    for (let z = z0; z < z0 + D; z++) for (let x = x0; x < x0 + W; x++) {
        const h = mid(x, z);
        if (h === null) continue;
        const n4 = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => mid(x + dx, z + dz)).filter(v => v !== null);
        const n8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dz]) => mid(x + dx, z + dz)).filter(v => v !== null);
        const low = n8.filter(v => v <= h - 3);
        if (n4.length === 4 && n4.filter(v => v <= h - 3).length >= 3 && median(n8) <= h - 3) {
            const g = median(low);
            ground.set(key(x, z), g);
            trunks.push({ x, z, top: h, ground: g });
        }
    }
    const inScan = (x, z) => z >= z0 && z < z0 + D && x >= x0 && x < x0 + W;
    return {
        trunks,
        has: (x, z) => mid(x, z) !== null,
        water: (x, z) => inScan(x, z) && scan.water[z - z0][x - x0],
        top: (x, z) => mid(x, z),
        ground: (x, z) => ground.get(key(x, z)) ?? mid(x, z),
        groundHi: (x, z) => {
            if (ground.has(key(x, z))) return ground.get(key(x, z));
            const h = mid(x, z);
            return h === null ? null : Math.max(h, scan.hi[z - z0][x - x0]);
        },
    };
}

// ------------------------------------------------------------------------------------------------ rasterizing

/** The cells of a polyline [[x, z], …] as a 4-connected path (a diagonal becomes a staircase nothing slips through). */
export function raster4(points) {
    const out = [];
    const push = (x, z) => { const l = out.at(-1); if (!l || l[0] !== x || l[1] !== z) out.push([x, z]); };
    for (let i = 0; i + 1 < points.length; i++) {
        let [x, z] = points[i];
        const [x1, z1] = points[i + 1];
        const n = Math.max(Math.abs(x1 - x), Math.abs(z1 - z));
        push(x, z);
        for (let s = 1; s <= n; s++) {
            const nx = Math.round(points[i][0] + ((x1 - points[i][0]) * s) / n), nz = Math.round(points[i][1] + ((z1 - points[i][1]) * s) / n);
            if (nx !== x && nz !== z) push(nx, z); // the corner cell closes the diagonal step
            push(nx, nz);
            x = nx; z = nz;
        }
    }
    if (points.length === 1) push(points[0][0], points[0][1]);
    return out;
}

/** Point in polygon [[x, z], …] (even-odd rule, cell centres). */
export function insidePolygon(poly, x, z) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i], [xj, zj] = poly[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

// ------------------------------------------------------------------------------------------------ earthwork

const hash = (x, z) => { let h = (x * 374761393 + z * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
/** One block of a list, chosen by position (stable across runs): a mix of cobblestone and mossy cobblestone, … */
export const mix = (blocks, x, z) => (typeof blocks === 'string' ? blocks : blocks[Math.floor(hash(x, z) * blocks.length)]);

/**
 * Earthwork over a groundModel, collected into one plan. Every shape records the columns it shapes (`used`, for
 * cutTrees) and the surface height it leaves there (`level`, so a road can start flush with a square). Options:
 * fill (under aprons and roads), top (an apron's surface), retain (retaining walls; a list mixes by position).
 */
export function earthwork(model, { fill = 'minecraft:dirt', top = 'minecraft:grass_block', retain = ['minecraft:cobblestone', 'minecraft:cobblestone', 'minecraft:mossy_cobblestone'] } = {}) {
    const byBlock = new Map();
    const put = (block, x, y, z) => { if (!byBlock.has(block)) byBlock.set(block, []); byBlock.get(block).push([x, y, z]); };
    const plan = [];
    const flush = () => { for (const [b, pts] of byBlock) plan.push(...layer(b, pts)); byBlock.clear(); };
    const used = new Set(), level = new Map();
    const AIR = 'minecraft:air';
    const missing = [];

    /** Shapes one column to surface y: fill from the ground up (body, then `surf` at y), air from y + 1 over the old ground and its plants. */
    function column(x, z, y, { body, surf, clear = 2 }) {
        const g = model.ground(x, z), gh = model.groundHi(x, z);
        if (g === null) { missing.push([x, z]); return false; }
        for (let yy = Math.min(g, y); yy < y; yy++) put(mix(body, x, z), x, yy, z);
        if (surf) put(mix(surf, x, z), x, y, z);
        for (let yy = y + 1; yy <= Math.max(y + clear, gh + 1); yy++) put(AIR, x, yy, z);
        used.add(key(x, z)); level.set(key(x, z), y);
        return true;
    }

    const api = {
        plan, used, level, missing,
        /** Ground statistics over a rectangle: { min, max, median, n, missing } (trunks count as their ground). */
        stats(x0, z0, x1, z1) {
            const v = []; let miss = 0;
            for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
                const g = model.ground(x, z); if (g === null) miss++; else v.push(g);
            }
            v.sort((a, b) => a - b);
            return { min: v[0], max: v.at(-1), median: v[(v.length - 1) >> 1], n: v.length, missing: miss };
        },
        /**
         * A level pad: the core x0..x1 × z0..z1 at surface y and an apron `margin` wide around it. Under the core,
         * `core` (a foundation: it shows where the pad stands above the slope) up to y - 1 and `coreTop` at y (null:
         * leave y to the structure); under the apron, fill and `top`. Air above, down to y + 1, over the old ground.
         * Where the apron's rim stands 2+ above the ground it becomes a retaining wall; where the ground beyond it
         * is 2+ higher, the face of that cut is lined with the retaining wall instead.
         */
        pad(x0, z0, x1, z1, y, { margin = 1, core = 'minecraft:cobblestone', coreTop = null, apron = top, rim = true, clear = 2 } = {}) {
            for (let x = x0 - margin; x <= x1 + margin; x++) for (let z = z0 - margin; z <= z1 + margin; z++) {
                const inCore = x >= x0 && x <= x1 && z >= z0 && z <= z1;
                const onRim = !inCore && (x === x0 - margin || x === x1 + margin || z === z0 - margin || z === z1 + margin);
                const g = model.ground(x, z);
                if (inCore) column(x, z, y, { body: core, surf: coreTop || core, clear });
                else if (rim && onRim && g !== null && g <= y - 2) column(x, z, y, { body: retain, surf: retain, clear });
                else column(x, z, y, { body: fill, surf: apron, clear });
            }
            if (rim && margin > 0) {
                // The cut face: the ring just outside the apron, from y + 1 up to its ground, where that is 2+ higher.
                for (let x = x0 - margin - 1; x <= x1 + margin + 1; x++) for (let z = z0 - margin - 1; z <= z1 + margin + 1; z++) {
                    if (x > x0 - margin - 1 && x < x1 + margin + 1 && z > z0 - margin - 1 && z < z1 + margin + 1) continue;
                    if (level.has(key(x, z))) continue;
                    const g = model.ground(x, z);
                    if (g !== null && g >= y + 2) for (let yy = y + 1; yy <= g; yy++) put(mix(retain, x, z), x, yy, z);
                }
            }
            flush();
            return api;
        },
        /**
         * A road along a polyline of centre points [[x, z], …]: `width` wide, its surface the ground smoothed and then
         * limited to one block of climb per block (fills and cuts where the slope is steeper), flush with any column
         * already shaped (a square, another road) where it starts or crosses one. A shoulder each side is brought
         * to the road's height. surface: a block or a list (mixed by position). Returns the road's height map
         * (Map "x,z" → y over the road and its shoulders) and records it in `level`.
         */
        road(points, { width = 3, surface = 'minecraft:dirt_path', shoulder = top, headroom = 3, smooth = 2 } = {}) {
            const cells = raster4(points), n = cells.length, hw = Math.floor(width / 2);
            // The cross-section direction at each centre cell: perpendicular to the local run.
            const across = cells.map((c, i) => {
                const a = cells[Math.max(0, i - 1)], b = cells[Math.min(n - 1, i + 1)];
                return Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? [0, 1] : [1, 0];
            });
            const raw = cells.map(([x, z], i) => {
                const v = [];
                for (let k = -hw; k <= hw; k++) { const g = model.ground(x + across[i][0] * k, z + across[i][1] * k); if (g !== null) v.push(g); }
                return v.length ? v.reduce((s, a) => s + a, 0) / v.length : null;
            });
            for (let i = 0; i < n; i++) if (raw[i] === null) raw[i] = raw[i - 1] ?? raw.find(v => v !== null);
            const fixed = cells.map(([x, z]) => level.get(key(x, z)));
            let p = raw.map((_, i) => {
                if (fixed[i] !== undefined) return fixed[i];
                let s = 0, c = 0;
                for (let j = Math.max(0, i - smooth); j <= Math.min(n - 1, i + smooth); j++) { s += raw[j]; c++; }
                return Math.round(s / c);
            });
            // One block per block at most, never moving a fixed cell: alternate passes until nothing changes.
            for (let pass = 0; pass < 2 * n; pass++) {
                let changed = false;
                for (let i = 1; i < n; i++) if (fixed[i] === undefined) { const q = Math.max(p[i - 1] - 1, Math.min(p[i - 1] + 1, p[i])); if (q !== p[i]) { p[i] = q; changed = true; } }
                for (let i = n - 2; i >= 0; i--) if (fixed[i] === undefined) { const q = Math.max(p[i + 1] - 1, Math.min(p[i + 1] + 1, p[i])); if (q !== p[i]) { p[i] = q; changed = true; } }
                if (!changed) break;
            }
            for (let i = 1; i < n; i++) if (Math.abs(p[i] - p[i - 1]) > 1) throw new Error(`road: fixed heights ${p[i - 1]} and ${p[i]} meet at ${cells[i]} (steeper than 1 per block)`);
            const heights = new Map();
            const shoulders = [];
            cells.forEach(([x, z], i) => {
                for (let k = -hw; k <= hw; k++) {
                    const cx = x + across[i][0] * k, cz = z + across[i][1] * k;
                    if (fixed[i] !== undefined && level.has(key(cx, cz)) && !heights.has(key(cx, cz))) continue; // a square already there
                    column(cx, cz, p[i], { body: fill, surf: surface, clear: headroom });
                    heights.set(key(cx, cz), p[i]);
                }
                for (const k of [-hw - 1, hw + 1]) shoulders.push([x + across[i][0] * k, z + across[i][1] * k, p[i]]);
            });
            for (const [x, z, y] of shoulders) {
                if (heights.has(key(x, z)) || level.has(key(x, z))) continue;
                column(x, z, y, { body: fill, surf: shoulder });
                heights.set(key(x, z), y);
            }
            flush();
            return heights;
        },
        /**
         * Cuts down every tree whose trunk is within `reach` columns (Chebyshev) of a shaped column, or that `also`
         * selects: air over the trunk and a (2·radius + 1)² canopy box from top - 3 to top + 2, the ground block
         * restored under the trunk. A tree left standing keeps its trunk (the boxes skip its column). Returns
         * { plan, cut } — put that plan FIRST, so everything built later wins over the canopy's air.
         */
        cutTrees({ reach = 3, radius = 2, also = () => false, ground: groundBlock = top } = {}) {
            const out = new Map();
            const add = (b, x, y, z) => { if (!out.has(b)) out.set(b, []); out.get(b).push([x, y, z]); };
            const near = (x, z) => { for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) if (used.has(key(x + dx, z + dz))) return true; return false; };
            const cut = model.trunks.filter(t => near(t.x, t.z) || also(t));
            const cutKeys = new Set(cut.map(t => key(t.x, t.z)));
            const standing = new Set(model.trunks.filter(t => !cutKeys.has(key(t.x, t.z))).map(t => key(t.x, t.z)));
            const done = new Set();
            for (const t of cut) {
                for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
                    const x = t.x + dx, z = t.z + dz;
                    if (standing.has(key(x, z))) continue;
                    const gh = model.groundHi(x, z);
                    const y0 = dx === 0 && dz === 0 ? t.ground + 1 : Math.max(gh === null ? t.ground + 1 : gh + 1, t.top - 3);
                    for (let y = y0; y <= t.top + 2; y++) { const k = `${x},${y},${z}`; if (!done.has(k)) { done.add(k); add(AIR, x, y, z); } }
                }
                add(groundBlock, t.x, t.ground, t.z);
            }
            return { plan: concat(...[...out].map(([b, pts]) => layer(b, pts))), cut };
        },
    };
    return api;
}
