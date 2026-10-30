import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTerrain, emptyScan, foldTile, scanHeights, groundModel, raster4, insidePolygon, earthwork } from '../lib/terrain.mjs';

const SHADE = ' .:-=+*#%@';
/** What QueryTerrain.java answers for a radius-8 tile over height(x, z) (water where water(x, z)). */
function renderTile(height, cx, cz, water = () => false) {
    const hs = [];
    let lo = Infinity, hi = -Infinity;
    for (let gz = 0; gz < 16; gz++) for (let gx = 0; gx < 16; gx++) {
        const y = height(cx - 8 + gx, cz - 8 + gz); hs.push(y); lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    const span = Math.max(1, hi - lo);
    let s = `Terrain snapshot — center=(${cx},${cz}) radius=8 step=1\nBiome=minecraft:birch_forest  Y range ${lo}..${hi} (Δ${hi - lo})  playerY=70  slope=flat\nLegend: '${SHADE}' low→high\n`;
    for (let gz = 0; gz < 16; gz++) {
        for (let gx = 0; gx < 16; gx++) {
            const x = cx - 8 + gx, z = cz - 8 + gz;
            if (water(x, z)) { s += '~ '; continue; }
            const i = Math.min(9, Math.max(0, Math.floor(((hs[gz * 16 + gx] - lo) / span) * 9 + 0.5))); // Java Math.round
            s += SHADE[i] + ' ';
        }
        s += '\n';
    }
    return s;
}
// A hill with a few trees (a log column's top shows; leaves do not).
const hillGround = (x, z) => 64 + Math.round(8 * Math.exp(-((x - 20) ** 2 + (z - 20) ** 2) / 300));
const TREES = [[10, 12, 6], [25, 18, 7], [30, 30, 5]];
const withTrees = (x, z) => { const t = TREES.find(([a, b]) => a === x && b === z); return hillGround(x, z) + (t ? t[2] : 0); };

test('parseTerrain reads the header and the 16 × 16 cells', () => {
    const t = parseTerrain(renderTile(hillGround, 8, 8));
    assert.equal(t.cx, 8); assert.equal(t.step, 1); assert.equal(t.rows.length, 16); assert.equal(t.rows[0].length, 16);
    assert.ok(t.lo <= t.hi);
    assert.equal(parseTerrain('QueryTerrain: la zone autour de (0,0) n\'est pas chargée'), null);
    assert.equal(parseTerrain(renderTile(hillGround, 8, 8).replace('step=1', 'step=1 (center clamped to within 128 blocks of the player)')).clamped, true);
});

test('foldTile: every cell interval holds the true height; a clamped tile folds nothing', () => {
    const scan = emptyScan(0, 0, 15, 15);
    assert.equal(foldTile(scan, { ...parseTerrain(renderTile(withTrees, 8, 8)), clamped: true }), false);
    assert.equal(foldTile(scan, parseTerrain(renderTile(withTrees, 8, 8))), true);
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        assert.ok(scan.lo[z][x] <= withTrees(x, z) && withTrees(x, z) <= scan.hi[z][x], `${x},${z}`);
    }
});

test('scanHeights: overlapping tiles pin the heights (exact on most cells, never wrong)', async () => {
    const client = { terrain: async (cx, cz) => renderTile(withTrees, cx, cz, (x, z) => x < 2 && z < 2) };
    const scan = await scanHeights(client, 0, 0, 39, 39);
    let exact = 0, n = 0;
    for (let z = 0; z < 40; z++) for (let x = 0; x < 40; x++) {
        if (x < 2 && z < 2) { assert.equal(scan.water[z][x], true); continue; }
        n++;
        assert.ok(scan.lo[z][x] <= withTrees(x, z) && withTrees(x, z) <= scan.hi[z][x], `${x},${z}`);
        if (scan.lo[z][x] === scan.hi[z][x]) exact++;
    }
    assert.ok(exact / n > 0.9, `exact ${exact}/${n}`);
});

/** A scan straight from a height function (every cell exact). */
function exactScan(h, x0, z0, x1, z1) {
    const s = emptyScan(x0, z0, x1, z1);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { s.lo[z - z0][x - x0] = h(x, z); s.hi[z - z0][x - x0] = h(x, z); }
    return s;
}

test('groundModel: trunks are the spikes, a steep slope is not a tree, ground under a trunk is its neighbours', () => {
    const m = groundModel(exactScan(withTrees, 0, 0, 39, 39));
    assert.deepEqual(m.trunks.map(t => [t.x, t.z]).sort(), TREES.map(([x, z]) => [x, z]).sort());
    for (const [x, z, h] of TREES) {
        const t = m.trunks.find(q => q.x === x && q.z === z);
        assert.equal(t.top, hillGround(x, z) + h);
        assert.equal(m.ground(x, z), hillGround(x, z));
    }
    const cliff = groundModel(exactScan((x, z) => 60 + 2 * x, 0, 0, 15, 15)); // 2 up per block
    assert.equal(cliff.trunks.length, 0);
    assert.equal(m.ground(100, 100), null);
});

test('raster4: 4-connected, both ends, diagonals become staircases', () => {
    const c = raster4([[0, 0], [5, 3], [5, 8]]);
    assert.deepEqual(c[0], [0, 0]); assert.deepEqual(c.at(-1), [5, 8]);
    for (let i = 1; i < c.length; i++) assert.equal(Math.abs(c[i][0] - c[i - 1][0]) + Math.abs(c[i][1] - c[i - 1][1]), 1, `step ${c[i - 1]} -> ${c[i]}`);
    assert.deepEqual(raster4([[2, 3]]), [[2, 3]]);
    assert.ok(insidePolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 5, 5));
    assert.ok(!insidePolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 11, 5));
});

/** The last block written at each position of a plan. */
function final(plan) { const m = new Map(); for (const l of plan) for (const p of l.points) m.set(p.join(','), l.block); return m; }

test('pad: level surface over a slope, foundation under, air over the cut, retaining walls at 2+', () => {
    const slope = (x, z) => 60 + x; // rises 1 per block east
    const m = groundModel(exactScan(slope, -10, -10, 30, 30));
    const ew = earthwork(m).pad(5, 0, 10, 4, 66, { margin: 1, coreTop: 'minecraft:stone' });
    const f = final(ew.plan);
    for (let x = 5; x <= 10; x++) for (let z = 0; z <= 4; z++) {
        assert.equal(f.get(`${x},66,${z}`), 'minecraft:stone', `surface ${x},${z}`);
        for (let y = slope(x, z); y < 66; y++) assert.equal(f.get(`${x},${y},${z}`), 'minecraft:cobblestone', `foundation ${x},${y},${z}`);
        for (let y = 67; y <= slope(x, z) + 1; y++) assert.equal(f.get(`${x},${y},${z}`), 'minecraft:air', `cut ${x},${y},${z}`);
    }
    // West rim (x = 4, ground 64): 2 below the pad: retaining wall; east of the apron (x = 12, ground 72): cut face lined.
    assert.match(f.get('4,66,2'), /cobblestone/);
    assert.match(f.get('12,70,2'), /cobblestone/);
    assert.equal(ew.level.get('7,2'), 66);
    assert.ok(ew.used.has('11,5'));
});

test('road: climbs at most one block per block, flush with a shaped square, shoulders at road height', () => {
    const steep = (x, z) => (x < 10 ? 60 : 68); // an 8-block step at x = 10
    const ew = earthwork(groundModel(exactScan(steep, -5, -5, 40, 10)));
    ew.pad(0, -2, 3, 2, 61, { margin: 0 });
    const h = ew.road([[3, 0], [30, 0]], { width: 3 });
    assert.equal(h.has('3,0'), false, 'the square cells are not the road');
    for (let x = 5; x <= 30; x++) assert.ok(Math.abs(h.get(`${x},0`) - h.get(`${x - 1},0`)) <= 1, `step at ${x}`);
    assert.ok(Math.abs(h.get('4,0') - 61) <= 1, 'next to the square, at most one off it');
    assert.equal(h.get('30,0'), 68);
    assert.equal(h.get('20,2'), h.get('20,0'), 'shoulder');
    assert.equal(ew.level.get('3,0'), 61, 'the square stays');
});

test('cutTrees: only trees near shaped columns; trunk and canopy cleared, ground restored', () => {
    const m = groundModel(exactScan(withTrees, 0, 0, 39, 39));
    const ew = earthwork(m).pad(22, 15, 27, 20, hillGround(25, 18), { margin: 0 });
    const { plan, cut } = ew.cutTrees({ reach: 3 });
    assert.deepEqual(cut.map(t => [t.x, t.z]), [[25, 18]]);
    const f = final(plan);
    const g = hillGround(25, 18);
    for (let y = g + 1; y <= g + 7; y++) assert.equal(f.get(`25,${y},18`), 'minecraft:air');
    assert.equal(f.get(`25,${g},18`), 'minecraft:grass_block');
    assert.equal(f.get(`27,${g + 7},20`), 'minecraft:air', 'canopy corner');
    assert.equal(f.get(`27,${g},20`), undefined, 'ground under the canopy untouched');
});

test('cutTrees: a standing tree next to a felled one keeps its trunk', () => {
    const pair = (x, z) => 64 + ((x === 10 && z === 10) || (x === 12 && z === 10) ? 6 : 0);
    const ew = earthwork(groundModel(exactScan(pair, 0, 0, 30, 30))).pad(4, 8, 6, 12, 64, { margin: 0 });
    const { plan, cut } = ew.cutTrees({ reach: 4 });
    assert.deepEqual(cut.map(t => [t.x, t.z]), [[10, 10]]);
    const f = final(plan);
    assert.equal(f.get('10,68,10'), 'minecraft:air');
    for (let y = 65; y <= 72; y++) assert.equal(f.get(`12,${y},10`), undefined, `standing trunk at y ${y}`);
});
