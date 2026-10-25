// A walled Bronze Age town with a citadel, laid out for a siege. From the outside in:
//   moat (water) → berm → glacis → town wall (mud brick on a limestone socle, crenellated, a lip nothing climbs
//   past) with a square tower every `towerEvery` blocks → the approach: a bridge, a lane under the south wall
//   (the attacker's unshielded right side to the wall), a walled barbican yard entered from its side, then the
//   main gatehouse → inside, a clear lane along the walls, streets, houses, irrigated gardens, a market with a
//   well → a free-standing citadel (taller walls, its own towers and gate) holding the keep (raised entrance),
//   a temple, two granaries full of barrels, a cistern and barracks.
// Local frame: the town wall's centre lines run x = 0..W, z = 0..D (north = z 0); y = 0 is the ground course.
//   node build-bronze-town.mjs                     # dry run: counts and bounding box
//   node build-bronze-town.mjs --slice=12          # plus the top view at y = 12 (from the anchor)
//   node build-bronze-town.mjs --build --yes --parallel=4
// Parameters: --W --D (multiples of --towerEvery), --wallHeight, --citadelHeight, --seed (house sizes).
import { squareTower, wall, gatehouse, house, bridge, stairsBetween, earthworks, layer, concat, placeAt, translate,
    mirror, box, rectRing, line, palette, withProps, build, cliOptions, sliceMap } from './lib/index.mjs';

const { params, ...run } = cliOptions();
const { W = 120, D = 144, towerEvery: EVERY = 24, wallHeight: WH = 12, citadelHeight: CH = 15, seed = 7, slice } = params;
if (W % EVERY || D % EVERY) throw new Error(`W (${W}) and D (${D}) must be multiples of towerEvery (${EVERY})`);
const ANCHOR = run.anchor || [4, 0, -68]; // puts the town in the free flat area east of the pivot (absolute x 182..352)

const P = palette('bronzeAge');
const BRONZE = palette('bronzeAge', { door: 'minecraft:waxed_copper_door' });
const TIMBER = palette('bronzeAge', { stairs: 'minecraft:spruce_stairs', fence: 'minecraft:spruce_fence' });
const GATE = withProps('minecraft:spruce_fence_gate', { facing: 'south', open: 'false' });
const BARREL = withProps('minecraft:barrel', { facing: 'up' });
const half = n => Math.floor(n / 2);
let s = seed;
const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rand() * a.length)];

export const plan = [];
const add = (...parts) => plan.push(...concat(...parts));
const clearOfGlacis = []; // footprints the glacis must not fill

// ------------------------------------------------------------------------------------------------ fortification

/** A tower straddling a wall that runs east-west with the outside to the north; its origin is on the wall line. */
const midTower = (wallH, height, floors) => translate(squareTower({
    w: 7, d: 9, height, floors, ladder: 'north', palette: P,
    openings: [{ side: 'west', y: wallH, width: 3, at: 6 }, { side: 'east', y: wallH, width: 3, at: 6 }, { side: 'south', door: true }],
}), -3, 0, -6);
/** A tower centred on a north-west corner: walls leave east and south, the door opens into the enclosure. */
const cornerTower = (wallH, height, floors) => translate(squareTower({
    w: 11, d: 11, height, floors, ladder: 'north', palette: P,
    openings: [{ side: 'east', y: wallH, width: 3 }, { side: 'south', y: wallH, width: 3 }, { side: 'south', door: true, at: 9 }],
}), -5, 0, -5);
/** A gatehouse with timber gates closing both ends of the passage (fence gates: nothing jumps them). */
function gate(opts) {
    const g = gatehouse({ width: 3, turrets: false, sideDoors: true, palette: P, ...opts });
    return concat(g, layer(GATE, [-1, 0, 1].flatMap(x => [[x, 1, 1], [x, 1, opts.depth - 2]])));
}

/**
 * A ring of walls x0..x1 × z0..z1 (centre lines): corner towers, mid towers at `mids` (positions along each side),
 * wall segments between them, and `gaps` ({ side: [[a, b]] }) left for gatehouses.
 */
function fortify({ x0, z0, x1, z1, mids, gaps = {}, wallOpts, corner, mid }) {
    const sides = {
        north: { at: a => [a, z0], range: [x0, x1], turns: 0 },
        east: { at: a => [x1, a], range: [z0, z1], turns: 1 },
        south: { at: a => [a, z1], range: [x0, x1], turns: 2 },
        west: { at: a => [x0, a], range: [z0, z1], turns: 3 },
    };
    const towers = [];
    for (const [name, S] of Object.entries(sides)) {
        const stops = [[S.range[0], 5], ...(mids[name] || []).map(a => [a, 3]), [S.range[1], 5]];
        for (let i = 0; i + 1 < stops.length; i++) {
            let pieces = [[stops[i][0] + stops[i][1], stops[i + 1][0] - stops[i + 1][1]]];
            for (const [g0, g1] of gaps[name] || []) pieces = pieces.flatMap(([a, b]) => (g0 > a && g1 < b ? [[a, g0], [g1, b]] : [[a, b]]));
            for (const [a, b] of pieces) add(wall({ ...wallOpts, from: S.at(a), to: S.at(b), outer: name, palette: P }));
        }
        for (const a of mids[name] || []) { const [x, z] = S.at(a); towers.push(placeAt(mid, { at: [x, 0, z], turns: S.turns })); }
    }
    [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].forEach(([x, z], t) => towers.push(placeAt(corner, { at: [x, 0, z], turns: t })));
    for (const t of towers) {
        add(t);
        const base = t.flatMap(l => l.points.filter(p => p[1] === 0)); // the footprint, without the roof overhang
        const xs = base.map(p => p[0]), zs = base.map(p => p[2]);
        clearOfGlacis.push([Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]);
    }
}

// The barbican: a walled yard in front of the main gate, entered from its east side.
const BX0 = 40, BX1 = 80, BZ = D + 16, BGZ = D + 8, BRIDGE_X = W - EVERY; // its gate centre z; the bridge's x
const MOAT_AT = 8 + 10;                                                   // glacis run + berm (from the wall face)

// Earthworks first: towers and walls overwrite them in their footprints. (The clear list is filled by fortify.)
const works = () => earthworks({
    x0: -2, z0: -2, x1: W + 2, z1: D + 2, glacisHeight: 4, glacisRun: 8, berm: 10, moatWidth: 5, moatDepth: 3,
    clear: [...clearOfGlacis, [BX0 - 3, D + 3, BX1 + 3, BZ + 3], [BX1 + 3, D + 3, BRIDGE_X + 2, D + 10]],
});
const worksAt = plan.length; // spliced in once the tower footprints are known

// Town wall: 5 thick, crenellated outward, a walkway on top; the main gate in the middle of the south wall.
const townMids = n => Array.from({ length: n / EVERY - 1 }, (_, i) => (i + 1) * EVERY);
fortify({
    x0: 0, z0: 0, x1: W, z1: D,
    mids: { north: townMids(W), south: townMids(W), east: townMids(D), west: townMids(D) },
    gaps: { south: [[W / 2 - 5, W / 2 + 5]] },
    wallOpts: { height: WH, thickness: 5, walkway: true, crenellations: 'outer', overhang: true },
    corner: cornerTower(WH, WH + 7, [6, WH - 1, WH + 3]), mid: midTower(WH, WH + 5, [6, WH - 1]),
});
add(placeAt(gate({ height: 5, depth: 9, sideWidth: 3, upperFloor: WH - 1 }), { at: [W / 2, 0, D + 4], turns: 2 }));

// Barbican walls, corner towers and its side gate.
const bWall = { height: 10, thickness: 3, walkway: true, crenellations: 'outer', overhang: true, palette: P };
add(wall({ ...bWall, from: [BX0, D + 3], to: [BX0, BZ - 3], outer: 'west' }));
add(wall({ ...bWall, from: [BX0 + 3, BZ], to: [BX1 - 3, BZ], outer: 'south' }));
add(wall({ ...bWall, from: [BX1, D + 3], to: [BX1, BGZ - 4], outer: 'east' }));
add(wall({ ...bWall, from: [BX1, BGZ + 4], to: [BX1, BZ - 3], outer: 'east' }));
const bTower = translate(squareTower({
    w: 7, d: 7, height: 14, floors: [9], ladder: 'west', palette: P,
    openings: [{ side: 'north', y: 10, width: 3 }, { side: 'east', y: 10, width: 3 }, { side: 'north', door: true, at: 5 }],
}), -3, 0, -3);
add(placeAt(bTower, { at: [BX0, 0, BZ] }), placeAt(mirror(bTower, 'x'), { at: [BX1, 0, BZ] }));
add(placeAt(gate({ height: 4, depth: 5, sideWidth: 2, upperFloor: 9 }), { at: [BX1 + 2, 0, BGZ], turns: 1 }));

// The bridge over the moat, then the lane along the wall foot to the barbican gate, and the yard's path.
const MZ = D + 2 + MOAT_AT; // the moat's first row is MZ + 1
add(placeAt(bridge({ length: 9, width: 3, rise: 1, railings: true, lights: true, palette: TIMBER }), { at: [BRIDGE_X, 0, MZ - 1], turns: 1 }));
add(layer(P.path, [...box([BRIDGE_X - 1, 0, BGZ - 1], [BRIDGE_X + 1, 0, MZ - 2]), ...box([BX1 + 3, 0, BGZ - 1], [BRIDGE_X + 1, 0, BGZ + 1]),
    ...box([W / 2 - 1, 0, BGZ - 1], [BX1 - 3, 0, BGZ + 1]), ...box([W / 2 - 1, 0, D + 5], [W / 2 + 1, 0, BGZ])]));

// ----------------------------------------------------------------------------------------------------- citadel

const C = { x0: 30, z0: 14, x1: 90, z1: 54 }, CXM = (C.x0 + C.x1) / 2, CZM = (C.z0 + C.z1) / 2;
fortify({
    ...C, mids: { north: [CXM], west: [CZM], east: [CZM] }, gaps: { south: [[CXM - 5, CXM + 5]] },
    wallOpts: { height: CH, thickness: 5, walkway: true, crenellations: 'both', overhang: true },
    corner: cornerTower(CH, CH + 8, [5, 10, CH - 1, CH + 4]), mid: midTower(CH, CH + 5, [5, 10, CH - 1]),
});
add(placeAt(gate({ height: 5, depth: 9, sideWidth: 3, upperFloor: CH - 1 }), { at: [CXM, 0, C.z1 + 4], turns: 2 }));

// The keep: 15 × 15, 30 high, entered only on its first floor up an outside stair; a bronze band and door.
const K = { x: CXM - 7, z: 20 };
add(placeAt(squareTower({ w: 15, d: 15, height: 30, floors: [5, 10, 15, 20, 25], ladder: 'north', palette: BRONZE,
    openings: [{ side: 'south', y: 6, door: true }] }), { at: [K.x, 0, K.z] }));
add(layer(P.accent, rectRing(K.x, K.z, K.x + 14, K.z + 14, 15)));
add(stairsBetween([CXM, 0, K.z + 20], [CXM, 5, K.z + 15], { width: 3, fill: true, palette: P }));
add(layer(BARREL, [...line([K.x + 1, 1, K.z + 3], [K.x + 1, 1, K.z + 12]), ...line([K.x + 1, 2, K.z + 3], [K.x + 1, 2, K.z + 12])]));

// The temple (west): a flat-roofed hall with two towers flanking its porch, an altar and cedar columns inside.
const T = { x: 34, z: 22 };
add(placeAt(house({ w: 11, d: 15, floors: 1, floorHeight: 7, roof: 'flat', door: 'east', furnish: false, palette: P }), { at: [T.x, 0, T.z] }));
const porchTower = door => squareTower({ w: 5, d: 5, height: 12, floors: [5, 8], ladder: 'west', palette: P, openings: [{ side: door, door: true }] });
add(placeAt(porchTower('south'), { at: [T.x + 11, 0, T.z + 1] }), placeAt(porchTower('north'), { at: [T.x + 11, 0, T.z + 9] }));
add(layer(withProps(P.pillar, { axis: 'y' }), [T.x + 4, T.x + 7].flatMap(x => [T.z + 3, T.z + 11].flatMap(z => line([x, 1, z], [x, 6, z])))));
add(layer('minecraft:waxed_chiseled_copper', [[T.x + 2, 1, T.z + 7]]), layer('minecraft:campfire', [[T.x + 2, 2, T.z + 7]]));
add(layer(P.light, [[T.x + 2, 1, T.z + 5], [T.x + 2, 1, T.z + 9]]));

// Granaries (east): two long storehouses lined with barrels.
for (const gx of [70, 79]) {
    add(placeAt(house({ w: 7, d: 17, floors: 1, floorHeight: 5, roof: 'flat', door: 'west', furnish: false, palette: P }), { at: [gx, 0, 20] }));
    const rows = [gx + 1, gx + 5].flatMap(x => [1, 2].flatMap(y => line([x, y, 21], [x, y, 35]).filter(([xx, , z]) => xx !== gx + 1 || Math.abs(z - 28) > 1)));
    add(layer(BARREL, rows), layer('minecraft:hay_block', line([gx + 3, 1, 22], [gx + 3, 1, 34])), layer(P.light, [[gx + 3, 1, 21], [gx + 3, 1, 35]]));
}

// Cistern, barracks, paths.
const cistern = (cx, cz) => concat(layer('minecraft:water', box([cx - 2, -2, cz - 2], [cx + 2, 0, cz + 2])),
    layer(P.trim, rectRing(cx - 3, cz - 3, cx + 3, cz + 3, 0)), layer(P.fence, rectRing(cx - 3, cz - 3, cx + 3, cz + 3, 1)),
    layer(P.light, [[cx - 3, 2, cz - 3], [cx + 3, 2, cz + 3]]));
add(cistern(77, 43));
add(placeAt(house({ w: 15, d: 7, floors: 2, floorHeight: 4, roof: 'flat', door: 'north', palette: P }), { at: [35, 0, 41] }));
// Paths: gate → keep stair, and from the stair foot west, up the gap past the porch towers, into the porch.
add(layer(P.path, [...box([CXM - 2, 0, K.z + 21], [CXM + 2, 0, C.z1 - 3]), ...box([T.x + 11, 0, T.z + 6], [K.x - 1, 0, T.z + 8]),
    ...box([T.x + 16, 0, T.z + 9], [K.x - 1, 0, K.z + 20]), ...box([T.x + 16, 0, K.z + 18], [CXM - 2, 0, K.z + 20])]));

// ------------------------------------------------------------------------------------------------------ the town

const IN = { x0: 8, z0: 8, x1: W - 8, z1: D - 8 }; // inside the clear lane along the walls
const MAIN = [W / 2 - 2, W / 2 + 2], CROSS = [100 - 1, 100 + 1], SIDE = [[30, 32], [W - 32, W - 30]];
const PLAZA = { x0: W / 2 - 10, z0: CROSS[0] - 7, x1: W / 2 + 10, z1: CROSS[1] + 7 };
const FRONT = [C.z1 + 5, C.z1 + 9]; // the street along the citadel front

// Streets and the market square (before the houses, which win any overlap).
add(layer(P.path, [
    ...box([MAIN[0], 0, FRONT[0]], [MAIN[1], 0, D - 5]), ...box([IN.x0, 0, FRONT[0]], [IN.x1, 0, FRONT[1]]),
    ...box([IN.x0, 0, CROSS[0]], [IN.x1, 0, CROSS[1]]), ...SIDE.flatMap(([a, b]) => box([a, 0, FRONT[1] + 1], [b, 0, IN.z1])),
    ...box([PLAZA.x0, 0, PLAZA.z0], [PLAZA.x1, 0, PLAZA.z1]),
]));
const lamp = (x, z) => concat(layer(P.fence, [[x, 1, z], [x, 2, z]]), layer(P.light, [[x, 3, z]]));
for (let z = FRONT[1] + 6; z < D - 6; z += 12) if (z < PLAZA.z0 || z > PLAZA.z1) add(lamp(MAIN[0], z), lamp(MAIN[1], z));
for (let x = IN.x0 + 6; x < IN.x1; x += 12) if (x < PLAZA.x0 || x > PLAZA.x1) add(lamp(x, CROSS[0]), lamp(x, FRONT[1]));

// The well (3 × 3 of water under a curb and a beam) and four market stalls.
const well = (cx, cz) => concat(layer('minecraft:water', box([cx - 1, -2, cz - 1], [cx + 1, 0, cz + 1])),
    layer(P.trim, rectRing(cx - 2, cz - 2, cx + 2, cz + 2, 0)), layer(P.fence, rectRing(cx - 2, cz - 2, cx + 2, cz + 2, 1)),
    layer(withProps(P.pillar, { axis: 'y' }), [2, 3].flatMap(y => [[cx - 2, y, cz], [cx + 2, y, cz]])),
    layer(withProps(P.pillar, { axis: 'x' }), line([cx - 2, 4, cz], [cx + 2, 4, cz])));
add(well(PLAZA.x0 + 4, CROSS[1] + 4));
const stall = (x, z, wool) => concat(layer(TIMBER.fence, [[x, z], [x + 2, z], [x, z + 1], [x + 2, z + 1]].flatMap(([a, b]) => [[a, 1, b], [a, 2, b]])),
    layer(wool, box([x, 3, z], [x + 2, 3, z + 1])), layer(BARREL, [[x + 1, 1, z]]));
add(stall(PLAZA.x0 + 1, PLAZA.z0 + 1, 'minecraft:purple_wool'), stall(PLAZA.x1 - 3, PLAZA.z0 + 1, 'minecraft:red_wool'),
    stall(PLAZA.x1 - 3, PLAZA.z1 - 2, 'minecraft:orange_wool'), stall(W / 2 + 3, PLAZA.z1 - 2, 'minecraft:white_wool'));

// Irrigated gardens: farmland and ripe crops, a water channel every 9 rows.
function garden(x0, z0, x1, z1) {
    const soil = [], water = [], crops = { 'minecraft:wheat[age=7]': [], 'minecraft:carrots[age=7]': [], 'minecraft:beetroots[age=3]': [] };
    const kinds = Object.keys(crops);
    for (let z = z0; z <= z1; z++) {
        const k = (z - z0) % 9;
        if (k === 4) { water.push(...line([x0, 0, z], [x1, 0, z])); continue; }
        soil.push(...line([x0, 0, z], [x1, 0, z]));
        crops[kinds[Math.floor((z - z0) / 9) % 3]].push(...line([x0, 1, z], [x1, 1, z]));
    }
    return concat(layer('minecraft:water', water), layer('minecraft:farmland[moisture=7]', soil), ...Object.entries(crops).map(([b, p]) => layer(b, p)));
}

/** Houses side by side along x0..x1, doors on `side`, the door wall on z = front (the street is beyond it). */
function houseRow(x0, x1, front, side) {
    const d = 7, z = side === 'north' ? front : front - d + 1;
    for (let x = x0; ;) {
        let w = pick([6, 7, 7, 8, 9]);
        if (x + w - 1 > x1) w = x1 - x + 1;
        if (w < 6) break;
        add(placeAt(house({ w, d, floors: pick([1, 1, 2]), floorHeight: 4, roof: 'flat', door: side, palette: P }), { at: [x, 0, z] }));
        x += w + pick([1, 2]);
    }
}

// Two bands of houses, back gardens between their rows. Rows facing the market square stop at its edge.
const blocks = [[IN.x0, SIDE[0][0] - 1], [SIDE[0][1] + 1, MAIN[0] - 1], [MAIN[1] + 1, SIDE[1][0] - 1], [SIDE[1][1] + 1, IN.x1]];
const bands = [[FRONT[1] + 1, CROSS[0] - 1], [CROSS[1] + 1, IN.z1]];
const minus = ([a, b], [c, d]) => (d < a || c > b ? [[a, b]] : [[a, c - 1], [d + 1, b]].filter(([p, q]) => q >= p));
for (const [bz0, bz1] of bands) for (const [x0, x1] of blocks) {
    for (const [front, side] of [[bz0 + 1, 'north'], [bz1 - 1, 'south']]) {
        const [r0, r1] = side === 'north' ? [front, front + 6] : [front - 6, front];
        const pieces = r1 >= PLAZA.z0 - 1 && r0 <= PLAZA.z1 + 1 ? minus([x0, x1], [PLAZA.x0 - 2, PLAZA.x1 + 2]) : [[x0, x1]];
        for (const [a, b] of pieces) houseRow(a, b, front, side);
    }
    add(garden(x0, bz0 + 9, x1, bz1 - 9));
}

// Beside the citadel: a bronze smithy, a pen (west); craftsmen's houses (east).
add(placeAt(house({ w: 9, d: 11, roof: 'flat', door: 'east', palette: P }), { at: [12, 0, 12] }));
add(layer('minecraft:blast_furnace[facing=west]', [[19, 1, 15]]), layer('minecraft:anvil[facing=north]', [[19, 1, 18]]),
    layer('minecraft:waxed_copper_block', [[22, 1, 13], [22, 1, 14], [23, 1, 13], [22, 2, 13]]), layer('minecraft:raw_copper_block', [[23, 1, 14], [23, 1, 15]]));
add(layer(P.fence, rectRing(10, 28, 22, 44, 1).filter(([x, , z]) => !(x === 22 && z === 36))), layer('minecraft:hay_block', [[12, 1, 30], [13, 1, 30], [12, 2, 30]]),
    layer('minecraft:water_cauldron[level=3]', [[20, 1, 42]]));
for (const hz of [12, 26, 40]) add(placeAt(house({ w: 9, d: 9, floors: pick([1, 2]), roof: 'flat', door: 'west', palette: P }), { at: [W - 20, 0, hz] }));

// ------------------------------------------------------------------------------------------------------- build

plan.splice(worksAt, 0, ...works());
if (slice !== undefined) console.log(sliceMap(plan, Number(slice)));
await build(plan, { label: 'bronze-town', ...run, anchor: ANCHOR });
