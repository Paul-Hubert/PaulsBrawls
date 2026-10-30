// A medieval village on a forested hill (birch forest around the pivot 66, 75, -114): a castle on the summit, a
// cobbled market square with a well, a bell and stalls, a chapel, ~40 timber houses along roads that climb the slope,
// terraced fields in the basin and on the lowland, pens with farm animals and a barn, and a log palisade with stone
// guard towers and gates around it all. Every part stands on its own level pad (cobblestone foundations where the
// slope falls away, retaining walls where it is cut), roads climb at most one block per block, and the trees in the
// way (any trunk within 3 columns of anything built) are cut down, canopy and all.
// Frame: ABSOLUTE world coordinates throughout, translated to the pivot at the end; the terrain comes from a scan.
//   node build-forest-village.mjs --scan            # re-scan the terrain (stand near the hill) into terrain-forest-village.json
//   node build-forest-village.mjs                   # dry run: counts, bounding box, pen proofs, terrain report
//   node build-forest-village.mjs --slice=Y         # top view at absolute height Y (e.g. 76)
//   node build-forest-village.mjs --build --yes --parallel=4
//   --mobs=only | --mobs=none                       # creatures only / blocks only: a re-run must never spawn twice
// Parameters: --seed (house sizes, palettes and professions), --houses=0 (no houses), --cut=false (keep the trees).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
    box, line, rectRing, layer, concat, translate, rotate, placeAt, placeSpawns, palette, withProps, rotatePoint, DIRS,
    spawns, resolve, walk, build, cliOptions, sliceMap, house, castle, squareTower, tower, stats,
    scanHeights, groundModel, earthwork, raster4, insidePolygon, mix,
} from './lib/index.mjs';

const { params, ...run } = cliOptions();
const { slice, mobs = 'all', seed = 7, scan: doScan = false, houses: maxHouses = 999, cut = true, dump } = params;
const PIVOT = [66, 75, -114];                     // the /construction pivot this plan was made for
const AREA = [26, -242, 173, -35];                // the scanned rectangle (x0, z0, x1, z1)
const TERRAIN = new URL('./terrain-forest-village.json', import.meta.url);

if (doScan) {
    const client = await (await import('./mcp-build.mjs')).open();
    const scan = await scanHeights(client, ...AREA, { log: console.log });
    writeFileSync(TERRAIN, JSON.stringify(scan));
    console.log(`terrain written: ${TERRAIN.pathname}`);
    process.exit(0);
}
if (!existsSync(TERRAIN)) throw new Error('no terrain-forest-village.json: run with --scan first');
const model = groundModel(JSON.parse(readFileSync(TERRAIN, 'utf8')));
const ew = earthwork(model);

// ------------------------------------------------------------------------------------------------------ palette

const AIR = 'minecraft:air', GRASS = 'minecraft:grass_block', LANTERN = 'minecraft:lantern', WATER = 'minecraft:water';
const HANG = withProps(LANTERN, { hanging: 'true' });
const PANE = 'minecraft:glass_pane';
const STONE = palette('stoneCastle', { glass: PANE });
const TOWER = palette('stoneCastle', { wall: 'minecraft:cobblestone', trim: 'minecraft:stone_bricks', glass: PANE });
const CHAPEL = palette('stoneCastle', { pillar: 'minecraft:dark_oak_log', roof: 'minecraft:deepslate_tiles', roofStairs: 'minecraft:deepslate_tile_stairs',
    roofSlab: 'minecraft:deepslate_tile_slab', door: 'minecraft:dark_oak_door', glass: 'minecraft:purple_stained_glass_pane' });
const HOMES = [
    palette('oakCottage', { pillar: 'minecraft:spruce_log', roof: 'minecraft:dark_oak_planks', roofStairs: 'minecraft:dark_oak_stairs', roofSlab: 'minecraft:dark_oak_slab', door: 'minecraft:spruce_door', glass: PANE }),
    palette('oakCottage', { wall: 'minecraft:calcite', pillar: 'minecraft:dark_oak_log', door: 'minecraft:dark_oak_door', glass: PANE }),
    palette('oakCottage', { wall: 'minecraft:birch_planks', pillar: 'minecraft:spruce_log', roof: 'minecraft:bricks', roofStairs: 'minecraft:brick_stairs', roofSlab: 'minecraft:brick_slab', trim: 'minecraft:stone_bricks', glass: PANE }),
    palette('oakCottage', { wall: 'minecraft:cobblestone', trim: 'minecraft:stone_bricks', pillar: 'minecraft:oak_log', door: 'minecraft:oak_door', glass: PANE }),
    palette('oakCottage', { wall: 'minecraft:spruce_planks', pillar: 'minecraft:stripped_dark_oak_log', floor: 'minecraft:oak_planks', roof: 'minecraft:deepslate_tiles',
        roofStairs: 'minecraft:deepslate_tile_stairs', roofSlab: 'minecraft:deepslate_tile_slab', door: 'minecraft:spruce_door', glass: PANE }),
];
const FENCE = 'minecraft:spruce_fence', GATE = 'minecraft:spruce_fence_gate';
const PALE = withProps('minecraft:spruce_log', { axis: 'y' });
const PAVING = ['minecraft:cobblestone', 'minecraft:stone_bricks', 'minecraft:andesite', 'minecraft:cobblestone', 'minecraft:mossy_cobblestone'];
const ROAD = ['minecraft:dirt_path', 'minecraft:dirt_path', 'minecraft:dirt_path', 'minecraft:coarse_dirt', 'minecraft:gravel'];

let s = seed;
const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rand() * a.length)];
const half = n => Math.floor(n / 2);
const K = (x, z) => `${x},${z}`;

const S = [];                                  // structures, in absolute coordinates (placed after the earthwork)
const add = (...parts) => S.push(...concat(...parts));
const creatures = [];
const zones = [];                              // pens, proved in their own frame: { name, plan, start, bounds }
const occ = new Set();                         // columns taken (footprints + aprons, road surfaces, palisade)
const apronY = new Map();                      // house aprons → their pad's level (a neighbour may share one)
const occupy = (x0, z0, x1, z1) => { for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) occ.add(K(x, z)); };
const free = (x0, z0, x1, z1) => { for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (occ.has(K(x, z))) return false; return true; };
const report = [];                             // one line per pad: what the slope asked of it

/**
 * The pad for a part: level y (default: the median ground under it, + raise), foundation `core`, apron `margin`.
 * sharedApron: only the core is taken; the apron is recorded in apronY for a neighbour house to share.
 */
function site(name, x0, z0, x1, z1, { y, margin = 1, core, coreTop, apron, raise = 0, sharedApron = false } = {}) {
    const st = ew.stats(x0 - margin, z0 - margin, x1 + margin, z1 + margin);
    if (st.missing) throw new Error(`${name}: ${st.missing} columns of ${x0},${z0}..${x1},${z1} are water or unscanned`);
    const Y = (y ?? st.median) + raise;
    ew.pad(x0, z0, x1, z1, Y, { margin, ...(core ? { core } : {}), ...(coreTop ? { coreTop } : {}), ...(apron ? { apron } : {}) });
    if (sharedApron) {
        occupy(x0, z0, x1, z1);
        for (let x = x0 - margin; x <= x1 + margin; x++) for (let z = z0 - margin; z <= z1 + margin; z++) if (!occ.has(K(x, z))) apronY.set(K(x, z), Y);
    } else occupy(x0 - margin, z0 - margin, x1 + margin, z1 + margin);
    report.push(`  ${name.padEnd(22)} y ${Y}  ground ${st.min}..${st.max}  (fill ${Math.max(0, Y - st.min)}, cut ${Math.max(0, st.max - Y)})`);
    return Y;
}

// --------------------------------------------------------------------------------------------- the castle (summit)

// Towers at x 53..83, z -191..-161 (centres), gate in the south wall at x 68, facing the village.
const CS = 30, CX = 53, CZ = -191;
const castleY = site('castle', CX - 6, CZ - 6, CX + CS + 6, CZ + CS + 6, { margin: 2, core: 'minecraft:stone_bricks', coreTop: GRASS, raise: 1 });
add(placeAt(castle({ size: CS, towerRadius: 4, towerHeight: 17, towerRoof: 'cone', wallHeight: 9, wallThickness: 3, gate: { width: 3, height: 5 }, palette: STONE }),
    { at: [CX + CS, castleY, CZ + CS], turns: 2 }));
// Courtyard: the keep at the back on the gate's axis, the great hall west of the gate path, barracks east of it.
add(placeAt(squareTower({ w: 11, d: 11, height: 24, storey: 6, ladder: 'west', openings: [{ side: 'south', door: true }], palette: STONE }), { at: [63, castleY, -189] }),
    layer(HANG, [5, 11, 17].map(y => [68, castleY + y, -184])),
    layer(withProps('minecraft:white_banner', { rotation: '8' }), [[66, castleY + 25, -180], [70, castleY + 25, -180]]));
add(placeAt(house({ w: 9, d: 13, floors: 1, floorHeight: 6, roof: 'gable', door: 'east', palette: palette('stoneCastle', { glass: PANE, roof: 'minecraft:dark_oak_planks' }) }), { at: [56, castleY, -176] }));
add(placeAt(house({ w: 9, d: 11, floors: 2, floorHeight: 4, roof: 'gable', door: 'west', palette: HOMES[3] }), { at: [72, castleY, -174] }));
add(layer(withProps('minecraft:hay_block', { axis: 'y' }), [[60, castleY + 1, -186], [61, castleY + 1, -186], [60, castleY + 2, -186]]),
    layer('minecraft:anvil', [[77, castleY + 1, -186]]), layer(withProps('minecraft:grindstone', { face: 'floor', facing: 'north' }), [[75, castleY + 1, -186]]));
creatures.push(...spawns('minecraft:iron_golem', [[66, castleY + 1, -167], [77, castleY + 1, -180]]));

// ------------------------------------------------------------------------------------------- the market square

const SQ = { x0: 58, z0: -120, x1: 78, z1: -104 };
const sqY = site('square', SQ.x0, SQ.z0, SQ.x1, SQ.z1, { coreTop: PAVING, apron: PAVING });
{
    const [cx, cz] = [68, -112];
    // The well: water 3 deep in a stone rim, a fence ring, a beam with a lantern under it.
    add(layer(WATER, box([cx - 1, sqY - 2, cz - 1], [cx + 1, sqY, cz + 1])), layer('minecraft:stone_bricks', rectRing(cx - 2, cz - 2, cx + 2, cz + 2, sqY)),
        layer(FENCE, rectRing(cx - 2, cz - 2, cx + 2, cz + 2, sqY + 1).filter(([x, , z]) => !(x === cx && Math.abs(z - cz) === 2))),
        layer(withProps('minecraft:spruce_log', { axis: 'y' }), [2, 3].flatMap(y => [[cx - 2, sqY + y, cz], [cx + 2, sqY + y, cz]])),
        layer(withProps('minecraft:spruce_log', { axis: 'x' }), line([cx - 2, sqY + 4, cz], [cx + 2, sqY + 4, cz])), layer(HANG, [[cx, sqY + 3, cz]]));
    add(layer('minecraft:stone_bricks', [[73, sqY + 1, -116]]), layer('minecraft:bell[attachment=floor,facing=south]', [[73, sqY + 2, -116]]));
    const stall = (x, z, wool) => concat(layer(FENCE, [[x, z], [x + 2, z], [x, z + 1], [x + 2, z + 1]].flatMap(([a, b]) => [[a, sqY + 1, b], [a, sqY + 2, b]])),
        layer(wool, box([x, sqY + 3, z], [x + 2, sqY + 3, z + 1])), layer(withProps('minecraft:chest', { facing: 'south' }), [[x + 1, sqY + 1, z]]));
    add(stall(60, -119, 'minecraft:red_wool'), stall(60, -108, 'minecraft:yellow_wool'), stall(75, -108, 'minecraft:blue_wool'), stall(75, -119, 'minecraft:green_wool'));
    add(layer(FENCE, [[58, -120], [78, -120], [58, -104], [78, -104]].flatMap(([x, z]) => [[x, sqY + 1, z], [x, sqY + 2, z]])),
        layer(LANTERN, [[58, sqY + 3, -120], [78, sqY + 3, -120], [58, sqY + 3, -104], [78, sqY + 3, -104]]));
    creatures.push(...spawns('minecraft:iron_golem', [[64, sqY + 1, -112]]));
}

// ------------------------------------------------------------------------------------------------ fields and farm

/** Irrigated field on its own terrace: farmland and ripe crops, a full row of water every 9 rows. */
let nField = 0;
function field(name, x0, z0, x1, z1) {
    nField++;
    const Y = site(name, x0, z0, x1, z1, { core: 'minecraft:dirt', coreTop: 'minecraft:farmland[moisture=7]' });
    const crops = ['minecraft:wheat[age=7]', 'minecraft:carrots[age=7]', 'minecraft:potatoes[age=7]', 'minecraft:beetroots[age=3]', 'minecraft:wheat[age=7]'];
    const soil = [], water = [], plants = {};
    for (let z = z0; z <= z1; z++) {
        if ((z - z0) % 9 === 4) { water.push(...line([x0, Y, z], [x1, Y, z])); continue; }
        soil.push(...line([x0, Y, z], [x1, Y, z]));
        const c = crops[(Math.floor((z - z0) / 9) + 2 * nField) % crops.length];
        (plants[c] ||= []).push(...line([x0, Y + 1, z], [x1, Y + 1, z]));
    }
    add(layer(WATER, water), layer('minecraft:farmland[moisture=7]', soil), ...Object.entries(plants).map(([b, p]) => layer(b, p)));
    return Y;
}
field('field basin NW', 36, -157, 48, -144);
field('field basin NE', 51, -157, 63, -144);
field('field lowland W', 101, -102, 114, -89);
field('field lowland E', 117, -102, 128, -89);

/**
 * A pen in its own frame: x 0..w-1, z 0..d-1, fence ring at y = 1 with a gate in the middle of `gateSide`, a hay bale
 * and a water trough two cells in from every fence (a 1-high block by a fence is a step over it), lanterns on the corner posts.
 */
function penPlan(w, d, gateSide) {
    const X = w - 1, Z = d - 1, cx = half(w), cz = half(d);
    const g = { north: [cx, 0], south: [cx, Z], west: [0, cz], east: [X, cz] }[gateSide];
    return concat(layer(GRASS, box([0, 0, 0], [X, 0, Z])), layer(FENCE, rectRing(0, 0, X, Z, 1)),
        layer(withProps(GATE, { facing: gateSide === 'north' || gateSide === 'south' ? 'north' : 'east', open: 'false' }), [[g[0], 1, g[1]]]),
        // Along the longer axis, so a narrow run keeps them two cells from its fences too.
        layer(withProps('minecraft:hay_block', { axis: 'y' }), [w >= d ? [cx - 1, 1, cz] : [cx, 1, cz - 1]]), layer('minecraft:water_cauldron[level=3]', [w >= d ? [cx + 1, 1, cz] : [cx, 1, cz + 1]]),
        layer(LANTERN, [[0, 2, 0], [X, 2, 0], [0, 2, Z], [X, 2, Z]]));
}
function pen(name, x0, z0, w, d, gateSide, animals) {
    const Y = site(name, x0, z0, x0 + w - 1, z0 + d - 1);
    const local = penPlan(w, d, gateSide);
    add(placeAt(local, { at: [x0, Y, z0] }));
    zones.push({ name, plan: local, start: [1, 1, 1], bounds: [1, 1, 1, w - 2, 2, d - 2] });
    const cells = []; for (let x = 1; x < w - 1; x++) for (let z = 1; z < d - 1; z++) if (w >= d ? !(z === half(d) && Math.abs(x - half(w)) === 1) : !(x === half(w) && Math.abs(z - half(d)) === 1)) cells.push([x, z]);
    let i = 0;
    for (const [entity, n, nbt] of animals) {
        const pts = [];
        for (let k = 0; k < n; k++, i += 3) { const [x, z] = cells[(i * 7) % cells.length]; pts.push([x0 + x, Y + 1, z0 + z]); }
        creatures.push(...spawns(entity, pts, nbt ? { nbt } : {}));
    }
}
pen('pen cows', 101, -81, 10, 8, 'north', [['minecraft:cow', 6]]);
pen('pen sheep', 113, -81, 10, 8, 'north', [['minecraft:sheep', 2, '{Color:0b}'], ['minecraft:sheep', 2, '{Color:8b}'], ['minecraft:sheep', 1, '{Color:12b}'], ['minecraft:sheep', 1, '{Color:15b}']]);
pen('pen pigs', 125, -81, 10, 8, 'north', [['minecraft:pig', 5]]);
pen('pen horses', 137, -81, 9, 8, 'north', [['minecraft:horse', 3]]);
pen('chicken run', 131, -101, 6, 12, 'west', [['minecraft:chicken', 8]]);
// The barn beside the chicken run: tall, hay inside.
{
    const Y = site('barn', 139, -101, 145, -88);
    add(placeAt(house({ w: 7, d: 14, floors: 1, floorHeight: 6, roof: 'gable', door: 'west', furnish: false,
        palette: palette('oakCottage', { wall: 'minecraft:spruce_planks', pillar: 'minecraft:stripped_spruce_log', roof: 'minecraft:dark_oak_planks', roofStairs: 'minecraft:dark_oak_stairs', roofSlab: 'minecraft:dark_oak_slab', glass: PANE }) }), { at: [139, Y, -101] }),
        layer(withProps('minecraft:hay_block', { axis: 'y' }), [...box([143, Y + 1, -99], [144, Y + 2, -97]), ...box([143, Y + 1, -92], [144, Y + 1, -90])]));
}

// ------------------------------------------------------------------------------------------------- the windmill

// On the escarpment between the plateau and the lowland fields, its sails facing the fields (east).
{
    const [cx, cz] = [94, -96];
    const Y = site('windmill', cx - 4, cz - 4, cx + 4, cz + 4, { raise: 1 });
    const MILL = palette('oakCottage', { wall: 'minecraft:calcite', trim: 'minecraft:cobblestone', roofStairs: 'minecraft:spruce_stairs', roof: 'minecraft:spruce_planks', floor: 'minecraft:spruce_planks' });
    add(placeAt(tower({ radius: 4, height: 11, roof: 'cone', overhang: true, stairs: 'spiral', openings: [{ side: 'north', door: true }], windowSides: ['west', 'south'], palette: MILL }), { at: [cx, Y, cz] }));
    // The hub on the east face, four arms (a log spar, a 2-wide sail of white wool on the trailing side).
    const hx = cx + 6, hy = Y + 9;
    add(layer(withProps('minecraft:dark_oak_log', { axis: 'x' }), [[cx + 5, hy, cz], [hx, hy, cz]]));
    const spar = [], sail = [];
    for (let k = 1; k <= 7; k++) {
        spar.push([hx, hy + k, cz], [hx, hy - k, cz], [hx, hy, cz + k], [hx, hy, cz - k]);
        if (k >= 2) sail.push([hx, hy + k, cz - 1], [hx, hy + k, cz - 2], [hx, hy - k, cz + 1], [hx, hy - k, cz + 2], [hx, hy - 1, cz - k], [hx, hy - 2, cz - k], [hx, hy + 1, cz + k], [hx, hy + 2, cz + k]);
    }
    add(layer(withProps('minecraft:stripped_dark_oak_log', { axis: 'y' }), spar.filter(p => p[0] === hx && p[2] === cz)),
        layer(withProps('minecraft:stripped_dark_oak_log', { axis: 'z' }), spar.filter(p => p[2] !== cz)), layer('minecraft:white_wool', sail));
    add(layer(withProps('minecraft:hay_block', { axis: 'y' }), [[cx - 1, Y + 1, cz - 2], [cx + 1, Y + 1, cz - 2]]));
}

// -------------------------------------------------------------------------------------------------- the chapel

{
    const Y = site('chapel', 72, -101, 80, -87);
    add(placeAt(house({ w: 9, d: 15, floors: 1, floorHeight: 7, roof: 'gable', door: 'north', furnish: false, palette: CHAPEL }), { at: [72, Y, -101] }));
    // Pews facing the altar (south), the altar with candles, a bell tower at the back-east corner.
    for (let z = -97; z <= -92; z += 2) add(layer(withProps('minecraft:spruce_stairs', { facing: 'north' }), [[74, Y + 1, z], [75, Y + 1, z], [77, Y + 1, z], [78, Y + 1, z]]));
    add(layer('minecraft:chiseled_stone_bricks', [[75, Y + 1, -89], [76, Y + 1, -89], [77, Y + 1, -89]]), layer('minecraft:candle[candles=3,lit=true]', [[75, Y + 2, -89], [77, Y + 2, -89]]),
        layer('minecraft:brewing_stand', [[76, Y + 2, -89]]));
    add(placeAt(squareTower({ w: 5, d: 5, height: 17, storey: 5, ladder: null, slits: true, lights: true, palette: CHAPEL }), { at: [80, Y, -91] }),
        layer('minecraft:bell[attachment=ceiling,facing=north]', [[82, Y + 15, -89]]));
    creatures.push(...spawns('minecraft:villager', [[76, Y + 1, -99]], { nbt: '{VillagerData:{profession:"minecraft:cleric",level:3,type:"minecraft:plains"},Xp:60,CustomName:\'"Frère Anselme"\'}' }));
}

// --------------------------------------------------------------------------------------------------- the roads

// Laid after the pads they join (castle gate, square), so they start flush with them; then the lanes.
const roads = [];
const road = (name, pts, opts = {}) => {
    const h = ew.road(pts, { surface: ROAD, ...opts });
    // The surface is taken; a shoulder (a cell with a neighbour off the road) stays free for a doorstep or a lamp.
    for (const k of h.keys()) { const [x, z] = k.split(',').map(Number); if ([[1, 0], [-1, 0], [0, 1], [0, -1]].every(([a, b]) => h.has(K(x + a, z + b)))) occ.add(k); }
    roads.push({ name, pts, h });
    return h;
};
// Streets ~22 apart, so the houses between two of them stand in two rows back to back.
road('castle road', [[68, -121], [68, -157]]);
road('west street', [[57, -112], [27, -112]]);
road('south road', [[68, -103], [68, -69]]);
road('east road', [[79, -106], [153, -106]]);
road('basin lane', [[67, -140], [34, -140]]);
road('lower street', [[67, -90], [38, -90]]);
road('farm lane', [[69, -84], [140, -84]]);
road('upper lane', [[69, -128], [127, -128]]);
road('castle lane', [[69, -150], [127, -150]]);
road('hill street', [[90, -107], [90, -149]]);
road('orchard street', [[112, -107], [112, -149]]);

// ------------------------------------------------------------------------------------------- the palisade line

// Clockwise from the castle's south-west tower; guard towers on the corners, gates where the roads cross it.
const POLY = [[48, -160], [30, -160], [30, -94], [62, -72], [150, -72], [150, -114], [130, -114], [130, -154], [100, -157], [89, -160]];
const TOWERS = [[30, -160], [30, -94], [62, -72], [90, -72], [150, -72], [150, -114], [130, -154]];
const inVillage = (x, z, m = 0) => [[0, 0], [m, 0], [-m, 0], [0, m], [0, -m], [m, m], [-m, -m], [m, -m], [-m, m]].every(([dx, dz]) => insidePolygon(POLY, x + dx, z + dz));
const centroid = [POLY.reduce((a, p) => a + p[0], 0) / POLY.length, POLY.reduce((a, p) => a + p[1], 0) / POLY.length];
const towerFoot = new Set();
for (const [cx, cz] of TOWERS) {
    const Y = site(`guard tower ${cx},${cz}`, cx - 3, cz - 3, cx + 3, cz + 3, { raise: 1 });
    const [dx, dz] = [centroid[0] - cx, centroid[1] - cz];
    const side = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
    add(placeAt(squareTower({ w: 7, d: 7, height: 15, storey: 5, ladder: side === 'west' ? 'north' : 'west', openings: [{ side, door: true }], palette: TOWER }), { at: [cx - 3, Y, cz - 3] }),
        layer(withProps('minecraft:red_banner', { rotation: '0' }), [[cx, Y + 16, cz]])); // on the roof deck (y + 15)
    for (let x = cx - 3; x <= cx + 3; x++) for (let z = cz - 3; z <= cz + 3; z++) towerFoot.add(K(x, z));
}
{
    const cells = raster4([...POLY]);
    const pales = [], gates = [], posts = [], lintel = [];
    const roadAt = new Map(); for (const r of roads) for (const [k, y] of r.h) roadAt.set(k, y);
    cells.forEach(([x, z], i) => {
        const k = K(x, z);
        if (towerFoot.has(k)) return;
        if (roadAt.has(k)) {
            // A gate: fence gates across the road, a log lintel over it.
            const y = roadAt.get(k), prev = cells[i - 1] || cells[i + 1];
            const along = prev[0] !== x ? 'x' : 'z';
            gates.push({ p: [x, y + 1, z], facing: along === 'x' ? 'north' : 'east' });
            lintel.push({ p: [x, y + 4, z], axis: along });
            return;
        }
        const g = ew.level.get(k) ?? model.ground(x, z);
        if (g === null) throw new Error(`palisade: no ground at ${x},${z} (water or unscanned): move the line`);
        for (let y = g - 1; y <= g + 4 + (i % 2); y++) pales.push([x, y, z]);
        if (i % 12 === 0) posts.push([x, g + 6 + (i % 2) - 1, z]);
        ew.used.add(k);
        occ.add(k);
    });
    add(layer(PALE, pales), layer(LANTERN, posts));
    for (const g of gates) add(layer(withProps(GATE, { facing: g.facing, open: 'false' }), [g.p]));
    for (const l of lintel) add(layer(withProps('minecraft:spruce_log', { axis: l.axis }), [l.p]));
}

// ------------------------------------------------------------------------------------------------------ houses

const PROFS = ['farmer', 'mason', 'farmer', 'shepherd', 'farmer', 'librarian', 'farmer', 'butcher', 'toolsmith', 'farmer', 'fletcher',
    'weaponsmith', 'farmer', 'armorer', 'cartographer', 'farmer', 'leatherworker', 'fisherman', 'farmer', 'mason'];
const JOB = {
    farmer: 'minecraft:composter', mason: 'minecraft:stonecutter[facing=north]', shepherd: 'minecraft:loom[facing=north]',
    librarian: 'minecraft:lectern[facing=north]', toolsmith: 'minecraft:smithing_table', butcher: 'minecraft:smoker[facing=north]',
    fletcher: 'minecraft:fletching_table', weaponsmith: 'minecraft:grindstone[face=floor,facing=north]', armorer: 'minecraft:blast_furnace[facing=north]',
    cartographer: 'minecraft:cartography_table', leatherworker: 'minecraft:cauldron', fisherman: 'minecraft:barrel[facing=up]',
};
const BEDS = ['red', 'blue', 'white', 'green', 'yellow', 'orange', 'brown', 'cyan'];
let nHome = 0;
const doors = [];                              // { step: the doorstep, out: the way out, Y }: checked against the roads below
const why = { 'no road': 0, 'palisade/end': 0, water: 0, taken: 0, slope: 0 };
/**
 * A family house on its pad: footprint x0..x0+w-1 × z0..z0+d-1, its door on `side`, at level Y. A bed along the back
 * wall, the family's job site in the front corner, one villager of that profession inside. Returns its door cell.
 */
function home(x0, z0, w, d, side, floors, Y, P) {
    const turns = DIRS.indexOf(side), [lw, ld] = turns % 2 ? [d, w] : [w, d];
    const X = lw - 1, Z = ld - 1, cxd = half(lw), prof = PROFS[nHome % PROFS.length], bed = `minecraft:${BEDS[nHome % BEDS.length]}_bed`;
    nHome++;
    const local = concat(house({ w: lw, d: ld, floors, roof: pick(['gable', 'gable', 'gable', 'hip']), door: 'north', palette: P }),
        layer(withProps(bed, { facing: 'east', part: 'foot' }), [[X - 2, 1, Z - 1]]), layer(withProps(bed, { facing: 'east', part: 'head' }), [[X - 1, 1, Z - 1]]),
        layer(JOB[prof], [[1, 1, 1]]));
    const cs = [[0, 0, 0], [X, 0, Z]].map(q => rotatePoint(q, turns));
    const dx = x0 - Math.min(cs[0][0], cs[1][0]), dz = z0 - Math.min(cs[0][2], cs[1][2]);
    const pt = p => { const r = rotatePoint(p, turns); return [r[0] + dx, r[1] + Y, r[2] + dz]; };
    add(translate(rotate(local, turns), dx, Y, dz));
    creatures.push(...spawns('minecraft:villager', [pt([cxd, 1, half(ld)])], {
        nbt: `{VillagerData:{profession:"minecraft:${prof}",level:2,type:"minecraft:plains"},Xp:10}`,
    }));
    return pt([cxd, 0, -1]);
}

/**
 * Whether a house fits at footprint x0..x1 × z0..z1 on a pad at Y: nothing taken under it or its apron, and a
 * neighbour's apron shared only where that pad is within a block of this one (an alley between them, not a step).
 */
function lotFree(x0, z0, x1, z1, Y) {
    if (!free(x0 - 1, z0 - 1, x1 + 1, z1 + 1)) return false;
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) {
        const a = apronY.get(K(x, z)), inFoot = x >= x0 && x <= x1 && z >= z0 && z <= z1;
        if (a !== undefined && (inFoot || Math.abs(a - Y) > 1)) return false;
    }
    return true;
}

/**
 * Houses along one straight road (centre a → b, 3 wide), on both sides, doors onto it: each on a pad at the road's
 * height at its door (±1 when that saves earthwork), never more than 6 of fill or 5 of cut, at least 4 columns
 * inside the palisade.
 */
function lineHouses(a, b) {
    const alongX = a[1] === b[1];
    const [lo, hi] = alongX ? [Math.min(a[0], b[0]), Math.max(a[0], b[0])] : [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    for (const sgn of [-1, 1]) {
        for (let t = lo + 3; t <= hi - 3;) {
            if (nHome >= maxHouses) return;
            // Every lot size, in a shuffled order (variety along the street); the first that fits wins.
            const sizes = [7, 8, 9].flatMap(wa => [7, 8, 9].map(dp => [wa, dp, rand()])).sort((p, q) => p[2] - q[2]);
            let lot = null, reason = 'taken';
            for (const [wa, dp] of sizes) {
                let x0, z0, x1, z1, side;
                if (alongX) {
                    const zr = a[1]; x0 = t; x1 = t + wa - 1;
                    if (sgn > 0) { z0 = zr + 3; z1 = z0 + dp - 1; side = 'north'; } else { z1 = zr - 3; z0 = z1 - dp + 1; side = 'south'; }
                } else {
                    const xr = a[0]; z0 = t; z1 = t + wa - 1;
                    if (sgn > 0) { x0 = xr + 3; x1 = x0 + dp - 1; side = 'west'; } else { x1 = xr - 3; x0 = x1 - dp + 1; side = 'east'; }
                }
                // The road surface in front of the door (this road's, or a crossing road's).
                const ry = ew.level.get(alongX ? K(x0 + half(wa), a[1] + sgn) : K(a[0] + sgn, z0 + half(wa)));
                if (ry === undefined) { reason = 'no road'; continue; }
                if ((alongX ? x1 : z1) > hi || ![[x0, z0], [x1, z0], [x0, z1], [x1, z1]].every(([x, z]) => inVillage(x, z, 3))) { reason = 'palisade/end'; continue; }
                const st = ew.stats(x0 - 1, z0 - 1, x1 + 1, z1 + 1);
                if (st.missing) { reason = 'water'; continue; }
                const ys = [ry, ry + 1, ry - 1].filter(y => y - st.min <= 6 && st.max - y <= 5);
                if (!ys.length) { reason = 'slope'; continue; }
                const Y = ys.find(y => lotFree(x0, z0, x1, z1, y));
                if (Y !== undefined) { lot = { x0, z0, x1, z1, side, Y, wa }; break; }
            }
            if (!lot && params.trace && a === roads.find(r => r.name === params.trace)?.pts[0]) { const [wa, dp] = [7, 7]; let x0, z0, x1, z1; if (alongX) { x0 = t; x1 = t + 6; if (sgn > 0) { z0 = a[1] + 3; z1 = z0 + 6; } else { z1 = a[1] - 3; z0 = z1 - 6; } } else { z0 = t; z1 = t + 6; if (sgn > 0) { x0 = a[0] + 3; x1 = x0 + 6; } else { x1 = a[0] - 3; x0 = x1 - 6; } } const bl = []; for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) if (occ.has(K(x, z)) || apronY.has(K(x, z))) bl.push(`${x},${z}${occ.has(K(x, z)) ? 'O' : 'A' + apronY.get(K(x, z))}`); console.log('  trace', sgn, t, reason, [x0, z0, x1, z1].join(','), bl.slice(0, 6).join(' ')); }
            if (!lot) { why[reason]++; t += 1; continue; }
            site(`house ${nHome + 1}`, lot.x0, lot.z0, lot.x1, lot.z1, { y: lot.Y, sharedApron: true });
            const step = home(lot.x0, lot.z0, lot.x1 - lot.x0 + 1, lot.z1 - lot.z0 + 1, lot.side, pick([1, 1, 2]), lot.Y, pick(HOMES));
            doors.push({ step, out: { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[lot.side], Y: lot.Y });
            t += lot.wa + pick([1, 1, 2]);
        }
    }
}
for (const r of roads) for (let i = 0; i + 1 < r.pts.length; i++) lineHouses(r.pts[i], r.pts[i + 1]);
// Every front door opens onto a road: two cells out from the door is road surface, within a block of the floor.
{
    const surface = new Map(); for (const r of roads) for (const [k, y] of r.h) surface.set(k, y);
    const bad = doors.filter(({ step: [x, , z], out: [dx, dz], Y }) => { const y = surface.get(K(x + dx, z + dz)); return y === undefined || Math.abs(y - Y) > 1; });
    if (bad.length) throw new Error(`${bad.length} house door(s) do not open onto a road: ${bad.map(b => b.step.join(',')).join(' ')}`);
}

// ------------------------------------------------------------------------------------------------ lamp posts

{
    const lamps = [], posts = [];
    for (const r of roads) {
        let n = 0;
        for (const [k, y] of r.h) {
            if (n++ % 11 !== 5) continue;
            const [x, z] = k.split(',').map(Number);
            // A shoulder cell (beside the road surface), not a doorstep, not taken by anything else.
            const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => K(x + a, z + b));
            const shoulder = neighbours.some(q => !r.h.has(q));
            if (!shoulder || occ.has(k) || apronY.has(k) || !inVillage(x, z, 1)) continue;
            posts.push([x, y + 1, z], [x, y + 2, z]); lamps.push([x, y + 3, z]);
            occ.add(k);
        }
    }
    add(layer(FENCE, posts), layer(LANTERN, lamps));
}

// --------------------------------------------------------------------------------------------------- the trees

const trees = cut ? ew.cutTrees({ reach: 3 }) : { plan: [], cut: [] };
const absPlan = concat(trees.plan, ew.plan, S);

// ------------------------------------------------------------------------------------------------------ proofs

/** Each pen in its own frame: a villager-sized and a 1-high walker from inside must stay inside it. */
function prove() {
    const inside = (b, [x, y, z]) => x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5];
    let ok = true;
    for (const zn of zones) {
        const layers = resolve(zn.plan, { finalize: false }).layers;
        const res = ['villager', 'small'].map(walker => {
            const { cells, out } = walk(layers, zn.start, { walker });
            const stray = [...cells].map(k => k.split(',').map(Number)).find(p => !inside(zn.bounds, p));
            return { walker, n: cells.size, out, stray };
        });
        const good = res.every(r => !r.out && !r.stray);
        ok &&= good;
        console.log(`  walk ${good ? 'ok  ' : 'FAIL'} ${zn.name.padEnd(14)} ${res.map(r => `${r.walker} ${r.n} cells${r.out ? `, OUT at ${r.out}` : ''}${r.stray ? `, strays to ${r.stray}` : ''}`).join(' · ')}`);
    }
    return ok;
}

// ------------------------------------------------------------------------------------------------------- build

console.log(`terrain: ${report.length} pads, ${roads.length} roads, ${nHome} houses, ${trees.cut.length} of ${model.trunks.length} scanned trees cut${ew.missing.length ? `, ${ew.missing.length} columns without ground data` : ''}`);
console.log(report.join('\n'));
const cutSet = new Set(trees.cut.map(t => K(t.x, t.z)));
console.log(`  trees left standing inside the palisade: ${model.trunks.filter(t => inVillage(t.x, t.z) && !cutSet.has(K(t.x, t.z))).length}`);
for (const r of roads) { const ys = [...r.h.values()]; console.log(`  road ${r.name.padEnd(16)} y ${Math.min(...ys)}..${Math.max(...ys)}`); }
if (slice !== undefined) console.log(sliceMap(absPlan, Number(slice)));
if (dump) {
    const top = new Map();
    for (const l of resolve(absPlan, { finalize: false }).layers) for (const [x, y, z] of l.points) { const k = K(x, z), t = top.get(k), air = l.block === AIR; if (!t || (air ? t[1] === AIR && y >= t[0] : t[1] === AIR || y >= t[0])) top.set(k, [y, l.block]); }
    writeFileSync(dump, JSON.stringify([...top].map(([k, [y, b]]) => [...k.split(',').map(Number), y, b])));
}
console.log('  house spots refused:', JSON.stringify(why));
console.log('containment proof (pens):');
if (!prove()) throw new Error('forest-village: a pen leaks; fix the plan before building');
export const plan = translate(absPlan, -PIVOT[0], -PIVOT[1], -PIVOT[2]);
const mobsRel = placeSpawns(creatures, { at: [-PIVOT[0], -PIVOT[1], -PIVOT[2]] });
let client = null;
if (run.live) {
    client = await (await import('./mcp-build.mjs')).open();
    const p = client.pivot;
    if (p.x !== PIVOT[0] || p.y !== PIVOT[1] || p.z !== PIVOT[2]) throw new Error(`the pivot moved to ${p.x},${p.y},${p.z} (planned ${PIVOT}): re-plan or set the pivot back`);
}
await build(mobs === 'only' ? [] : plan, { label: 'forest-village', ...run, client, anchor: [0, 0, 0], spawns: mobs === 'none' ? [] : mobsRel });
