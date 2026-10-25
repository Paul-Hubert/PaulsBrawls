// The slavers' labor prison (brief: prompts/labor-prison.md). Captured villagers farm walled fields, work locked
// stalls and sleep in locked cells; illager guards stand watch as statues (they never shoot a prisoner). From the
// outside in:
//   moat → berm → glacis → curtain wall (crenellated and lipped on both faces) with a square tower at every corner
//   and every `towerEvery` blocks → ONE gatehouse (south), closed fence gates at both ends of its passage → the
//   guards' ward: the overseer's house (its top-floor office looks over the inner wall), barracks, armory, stable →
//   an inner wall, its gate closed by fence gates → the prisoners' yard: the cell block (west), the workshop hall
//   (east), walled fields (north). The cell block and the hall open only into the ward.
// Local frame: the curtain wall's centre lines run x = 0..W, z = 0..D (north = z 0); y = 0 is the ground course.
//   node build-labor-prison.mjs                    # dry run: counts, bounding box, the walk proof per zone
//   node build-labor-prison.mjs --slice=1          # plus the top view at y = 1 (from the anchor)
//   node build-labor-prison.mjs --build --yes --parallel=4
// Parameters: --wallHeight, --cellsPerRow (cells per side of the corridor, <= 10), --fields (1..3), --farmers (per field).
import { squareTower, wall, gatehouse, house, bridge, earthworks, cellBlock, cellBlockLayout, door, layer, concat, placeAt,
    translate, spawns, resolve, box, walls, rectRing, line, palette, withProps, rotateDir, rotatePoint, build,
    cliOptions, sliceMap, walk } from './lib/index.mjs';

const { params, ...run } = cliOptions();
const { wallHeight: WH = 10, cellsPerRow: CELLS = 10, fields: NFIELDS = 3, farmers: FARMERS = 3, slice } = params;
const W = 112, D = 112, EVERY = 28;
if (CELLS < 1 || CELLS > 10) throw new Error('--cellsPerRow must be 1..10 (the cell block runs from the inner wall to the north fields)');
const ANCHOR = run.anchor || [-W / 2, 0, -D / 2]; // centred on the pivot: open plains, nothing else within 128 blocks

const P = palette('deepslate', { light: 'minecraft:lantern' });
const TIMBER = palette('deepslate', {
    wall: 'minecraft:dark_oak_planks', floor: 'minecraft:spruce_planks', glass: 'minecraft:glass', light: 'minecraft:lantern',
    fence: 'minecraft:dark_oak_fence', stairs: 'minecraft:dark_oak_stairs', roofStairs: 'minecraft:deepslate_tile_stairs',
});
const GATE = withProps('minecraft:dark_oak_fence_gate', { facing: 'south', open: 'false' });
const GLOW = 'minecraft:shroomlight'; // set flush into the ground where nothing can hang a lantern
const half = n => Math.floor(n / 2);

export const plan = [];
const add = (...parts) => plan.push(...concat(...parts));
const creatures = [];   // spawn groups
const statues = [];     // { entity, p }: for the panic check
const zones = [];       // prisoner zones: { name, start, bounds: [x0, y0, z0, x1, y1, z1] }
const clearOfGlacis = [];

// --------------------------------------------------------------------------------------------------- creatures

const TYPES = ['plains', 'desert', 'savanna', 'snow', 'swamp', 'taiga', 'jungle'];
let nType = 0;
const villager = (p, profession, level = 2) => creatures.push(...spawns('minecraft:villager', [p], {
    nbt: `{VillagerData:{profession:"minecraft:${profession}",level:${level},type:"minecraft:${TYPES[nType++ % TYPES.length]}"}${level > 1 ? ',Xp:10' : ''}}`,
}));
/** Minecraft yaw for looking along (dx, dz): 0 south, 90 west, 180 north, -90 east. */
const yaw = (dx, dz) => Math.round((Math.atan2(-dx, dz) * 180) / Math.PI);
/** A guard statue: frozen, silent, invulnerable, holding `item`, looking along `look` [dx, dz]. */
function guard(entity, p, look, item) {
    creatures.push(...spawns(`minecraft:${entity}`, [p], {
        nbt: `{NoAI:1b,Silent:1b,Invulnerable:1b,Rotation:[${yaw(...look)}f,0f],HandItems:[{id:"minecraft:${item}",count:1},{}]}`,
    }));
    statues.push({ entity: `minecraft:${entity}`, p });
}
/** Applies a placeAt transform to a point or a direction (dir: no translation). */
const at = (p, { at: a = [0, 0, 0], turns = 0 }) => { const q = rotatePoint(p, turns); return [q[0] + a[0], q[1] + a[1], q[2] + a[2]]; };
const dir = ([dx, dz], turns) => { const q = rotatePoint([dx, 0, dz], turns); return [q[0], q[2]]; };
/** The bounds [x0, y0, z0, x1, y1, z1] of a local box after a placeAt transform. */
function boundsAt(a, b, tf) {
    const [p, q] = [at(a, tf), at(b, tf)];
    return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2]), Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])];
}

// ------------------------------------------------------------------------------------------------ fortification

// No tower has a ground door or ground-level slits (a 1 × 1 hole at y = 2 lets a baby in, and a ladder up to the
// walkway is a way out): guards reach the towers along the walkway from the gatehouse.
const MID_H = WH + 6, CORNER_H = WH + 7; // decks 16+ above the fields: a pillager up there is out of panic range
const midTower = {
    plan: translate(squareTower({ w: 7, d: 9, height: MID_H, floors: [6, WH - 1], ladder: 'north', slits: false, palette: P,
        openings: [{ side: 'west', y: WH, width: 3, at: 6 }, { side: 'east', y: WH, width: 3, at: 6 }] }), -3, 0, -6),
    deck: [0, MID_H + 1, -2], out: [0, -1],
};
const cornerTower = {
    plan: translate(squareTower({ w: 11, d: 11, height: CORNER_H, floors: [6, WH - 1, WH + 3], ladder: 'north', slits: false, palette: P,
        openings: [{ side: 'east', y: WH, width: 3 }, { side: 'south', y: WH, width: 3 }] }), -5, 0, -5),
    deck: [0, CORNER_H + 1, 0], out: [-1, -1],
};

/** The curtain wall: corner towers, mid towers at `mids`, segments between them, `gaps` left for the gatehouse. */
function fortify({ x0, z0, x1, z1, mids, gaps = {}, wallOpts }) {
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
        for (const a of mids[name] || []) { const [x, z] = S.at(a); towers.push({ t: midTower, tf: { at: [x, 0, z], turns: S.turns } }); }
    }
    [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].forEach(([x, z], turns) => towers.push({ t: cornerTower, tf: { at: [x, 0, z], turns } }));
    for (const { t, tf } of towers) {
        const placed = placeAt(t.plan, tf);
        add(placed);
        const base = placed.flatMap(l => l.points.filter(p => p[1] === 0)); // the footprint, without the overhang
        const xs = base.map(p => p[0]), zs = base.map(p => p[2]);
        clearOfGlacis.push([Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]);
        guard('pillager', at(t.deck, tf), dir(t.out, tf.turns), 'crossbow');
    }
}

const MOAT_AT = 6 + 4;                 // glacis run + berm, from the wall face
const MZ = D + 2 + MOAT_AT;            // the moat's first row (south) is MZ + 1
const works = () => earthworks({
    x0: -2, z0: -2, x1: W + 2, z1: D + 2, glacisHeight: 3, glacisRun: 6, berm: 4, moatWidth: 5, moatDepth: 3,
    clear: [...clearOfGlacis, [W / 2 - 6, D - 4, W / 2 + 6, MZ]],
});
const worksAt = plan.length; // spliced in once the tower footprints are known

const towersAt = n => Array.from({ length: n / EVERY - 1 }, (_, i) => (i + 1) * EVERY);
fortify({
    x0: 0, z0: 0, x1: W, z1: D,
    mids: { north: towersAt(W), east: towersAt(D), west: towersAt(D), south: towersAt(W).filter(a => a !== W / 2) },
    gaps: { south: [[W / 2 - 5, W / 2 + 5]] },
    wallOpts: { height: WH, thickness: 5, walkway: true, crenellations: 'both', overhang: true },
});

// The gatehouse: the only way in. Closed fence gates at both ends of the passage (nothing but a player opens them);
// its side rooms, between the gates, hold the guards' ladder up to the walkways.
const GH = { width: 3, height: 5, depth: 9, sideWidth: 3, upperFloor: WH - 1 };
const ghTf = { at: [W / 2, 0, D + 4], turns: 2 };
add(placeAt(concat(gatehouse({ ...GH, turrets: false, sideDoors: true, palette: P }),
    layer(GATE, [-1, 0, 1].flatMap(x => [[x, 1, 1], [x, 1, GH.depth - 2]]))), ghTf));
for (const x of [-2, 2]) guard('pillager', at([x, GH.upperFloor + 5, 1], ghTf), dir([0, -1], ghTf.turns), 'crossbow');
for (const x of [W / 2 - 3, W / 2 + 3]) guard('vindicator', [x, 1, D + 6], [0, 1], 'iron_axe');

// The bridge over the moat and the approach.
add(placeAt(bridge({ length: 9, width: 3, rise: 1, railings: true, lights: true, palette: TIMBER }), { at: [W / 2, 0, MZ - 1], turns: 1 }));
add(layer(P.path, [...box([W / 2 - 1, 0, D + 5], [W / 2 + 1, 0, MZ - 2]), ...box([W / 2 - 1, 0, MZ + 8], [W / 2 + 1, 0, MZ + 11])]));

// ------------------------------------------------------------------------------------------- inner wall and gate

const IZ = 85;                                   // the inner wall's centre line: the ward lies south of it
const CB_X = 3, WS_X = 97;                       // the cell block and the workshop hall stand on the inner wall
add(wall({ from: [18, IZ], to: [WS_X - 1, IZ], height: 6, thickness: 3, walkway: false, crenellations: 'both', lights: false, palette: P }));
add(layer('minecraft:air', box([W / 2 - 1, 1, IZ - 1], [W / 2 + 1, 3, IZ + 1])), layer(P.path, box([W / 2 - 1, 0, IZ - 1], [W / 2 + 1, 0, IZ + 1])));
add(layer(GATE, line([W / 2 - 1, 1, IZ], [W / 2 + 1, 1, IZ])));
add(layer(P.light, Array.from({ length: 13 }, (_, i) => [21 + i * 6, 6, IZ]))); // in the wall-top gutter

// ------------------------------------------------------------------------------------------------- cell block

// Two rows of cells facing each other across a corridor, a guards' catwalk over it; the corridor's only door opens
// into the ward. Built along local x, turned so the corridor runs north from the inner wall.
const CB = { cells: CELLS, rows: 2, cellW: 3, cellD: 4, height: 3, corridor: 3, entrances: ['west'], entranceButtons: 'both', palette: P };
const cbTf = { at: [CB_X, 0, IZ + 1], turns: 3 };
const cbLay = cellBlockLayout(CB);
add(placeAt(cellBlock(CB), cbTf));
for (const c of cbLay.cells) {
    zones.push({ name: `cell ${c.row ? 'E' : 'W'}${c.index + 1}`, start: at(c.spawn, cbTf), bounds: boundsAt([c.x0, 1, c.z0], [c.x1, CB.height, c.z1], cbTf) });
    villager(at(c.spawn, cbTf), 'none', 1);
}
// Catwalk guards over the corridor, looking down at it (on the cell roofs, between the railings and the outer walls).
const F1 = cbLay.fronts[1];
for (const [x, z, look] of [[10, 3, [0, 1]], [Math.min(26, cbLay.L - 8), 3, [0, 1]], [18, F1 + 2, [0, -1]], [Math.min(34, cbLay.L - 6), F1 + 2, [0, -1]]]) {
    if (x > cbLay.L - 3) continue;
    guard('pillager', at([x, CB.height + 2, z], cbTf), dir(look, cbTf.turns), 'crossbow');
}

// ---------------------------------------------------------------------------------------------- workshop hall

// Ten locked stalls along a hall, one job-site block and one villager of the matching profession in each.
const JOBS = [
    ['minecraft:blast_furnace', 'armorer', 'facing'], ['minecraft:smithing_table', 'toolsmith'], ['minecraft:grindstone', 'weaponsmith', 'floor'],
    ['minecraft:stonecutter', 'mason', 'facing'], ['minecraft:loom', 'shepherd', 'facing'], ['minecraft:smoker', 'butcher', 'facing'],
    ['minecraft:fletching_table', 'fletcher'], ['minecraft:cauldron', 'leatherworker'], ['minecraft:lectern', 'librarian', 'facing'],
    ['minecraft:brewing_stand', 'cleric'],
];
const WS = { cells: 5, rows: 2, cellW: 3, cellD: 3, height: 3, corridor: 3, bed: null, catwalk: false, entrances: ['west'], entranceButtons: 'both', palette: P };
const wsTf = { at: [WS_X, 0, IZ + 1], turns: 3 };
const wsLay = cellBlockLayout(WS);
const jobs = wsLay.cells.map((c, i) => {
    const [id, , kind] = JOBS[i], facing = rotateDir(c.facing, 2); // looks out of the stall, at its door
    const block = kind === 'facing' ? withProps(id, { facing }) : kind === 'floor' ? withProps(id, { face: 'floor', facing }) : id;
    return layer(block, [c.back]);
});
add(placeAt(concat(cellBlock(WS), ...jobs), wsTf));
wsLay.cells.forEach((c, i) => {
    zones.push({ name: `stall ${JOBS[i][1]}`, start: at(c.spawn, wsTf), bounds: boundsAt([c.x0, 1, c.z0], [c.x1, WS.height, c.z1], wsTf) });
    villager(at(c.spawn, wsTf), JOBS[i][1]);
});

// ------------------------------------------------------------------------------------------------------ fields

// Walled plots (3 high: a composter beside a 2-high wall is a step over it) of farmland and ripe crops, a water
// channel every 9 rows, a path inside the wall, one composter per farmer, an iron door with its button outside.
const FW = 19, FD = 22, FZ = 9;
const CROPS = ['minecraft:wheat[age=7]', 'minecraft:carrots[age=7]', 'minecraft:potatoes[age=7]', 'minecraft:beetroots[age=3]'];
function field(x0, z0, n) {
    const x1 = x0 + FW - 1, z1 = z0 + FD - 1, xm = x0 + half(FW), parts = [];
    parts.push(layer(P.wall, walls([x0, 1, z0], [x1, 3, z1])), layer(P.trim, rectRing(x0, z0, x1, z1, 0)));
    parts.push(layer(P.path, rectRing(x0 + 1, z0 + 1, x1 - 1, z1 - 1, 0)));
    const soil = [], water = [], crops = Object.fromEntries(CROPS.map(c => [c, []]));
    for (let z = z0 + 2; z <= z1 - 2; z++) {
        const k = z - (z0 + 2);
        if (k % 9 === 4) { water.push(...line([x0 + 2, 0, z], [x1 - 2, 0, z])); continue; }
        soil.push(...line([x0 + 2, 0, z], [x1 - 2, 0, z]));
        crops[CROPS[(Math.floor(k / 9) * 2 + (k % 9 > 4 ? 1 : 0) + n) % CROPS.length]].push(...line([x0 + 2, 1, z], [x1 - 2, 1, z]));
    }
    parts.push(layer('minecraft:water', water), layer('minecraft:farmland[moisture=7]', soil), ...Object.entries(crops).map(([b, p]) => layer(b, p)));
    // Lights: lanterns on the wall top every 6, glow blocks in the path ring every 6.
    const tops = [];
    for (let x = x0; x <= x1; x += 6) tops.push([x, 4, z0], [x, 4, z1]);
    for (let z = z0 + 6; z < z1; z += 6) tops.push([x0, 4, z], [x1, 4, z]);
    parts.push(layer(P.light, tops), layer(GLOW, rectRing(x0 + 1, z0 + 1, x1 - 1, z1 - 1, 0).filter(([x, , z]) => (x - x0 + z - z0) % 6 === 0)));
    const cx = Array.from({ length: FARMERS }, (_, i) => x0 + 1 + Math.round(((i + 1) * (FW - 3)) / (FARMERS + 1)));
    parts.push(layer('minecraft:composter', cx.map(x => [x, 1, z0 + 1])));
    parts.push(door('minecraft:iron_door', [xm, 1, z1], 'north'));
    parts.push(layer('minecraft:stone_button[face=wall,facing=south]', [[xm + 1, 2, z1 + 1]]));
    add(...parts);
    zones.push({ name: `field ${n + 1}`, start: [cx[0] + 1, 1, z1 - 1], bounds: [x0 + 1, 0, z0 + 1, x1 - 1, 3, z1 - 1] });
    for (const x of cx) villager([x + 1, 1, z1 - 1], 'farmer');
}
const FIELD_X = [24, 47, 70].slice(0, NFIELDS);
FIELD_X.forEach((x, n) => field(x, FZ, n));

// ------------------------------------------------------------------------------------------------------- yard

const YARD = [3, 0, 3, W - 3, 2, IZ - 1]; // up to the inner gate's fence gates (z = IZ)
zones.push({ name: 'yard', start: [W / 2, 1, 60], bounds: YARD });
add(layer(P.path, [...box([W / 2 - 1, 0, FZ + FD + 3], [W / 2 + 1, 0, IZ - 2]), ...box([FIELD_X[0] - 2, 0, FZ + FD], [FIELD_X.at(-1) + FW + 1, 0, FZ + FD + 2])]));
// Guards at the yard's corners (vindicators: they panic a villager only within 10 blocks, and the fields are farther).
guard('vindicator', [7, 1, 7], [1, 1], 'iron_axe');
guard('vindicator', [W - 7, 1, 7], [-1, 1], 'iron_axe');
guard('vindicator', [20, 1, IZ - 4], [1, -1], 'iron_axe');
guard('vindicator', [WS_X - 3, 1, IZ - 4], [-1, -1], 'iron_axe');

// ------------------------------------------------------------------------------------------------- the ward

// Paths: the lane from the gatehouse to the inner gate, a cross path, spurs to the cell block and hall doors.
const cbDoor = at([0, 1, cbLay.corridor.mid], cbTf), wsDoor = at([0, 1, wsLay.corridor.mid], wsTf);
add(layer(P.path, [...box([W / 2 - 1, 0, IZ + 2], [W / 2 + 1, 0, D - 5]), ...box([4, 0, 96], [W - 4, 0, 97]),
    ...box([cbDoor[0] - 1, 0, IZ + 2], [cbDoor[0] + 1, 0, 95]), ...box([wsDoor[0] - 1, 0, IZ + 2], [wsDoor[0] + 1, 0, 95])]));
const lamp = (x, z) => concat(layer(TIMBER.fence, [[x, 1, z], [x, 2, z]]), layer(P.light, [[x, 3, z]]));
for (const z of [89, 93, 101, 105]) add(lamp(W / 2 - 2, z), lamp(W / 2 + 2, z));

// The overseer's house: three storeys against the inner wall; the top one is his office, its north windows over
// the wall top, the overseer (an evoker statue) at the glass.
const OV = { x: 62, z: IZ + 2 };
add(placeAt(house({ w: 11, d: 9, floors: 3, floorHeight: 4, roof: 'flat', door: 'south', palette: TIMBER }), { at: [OV.x, 0, OV.z] }));
add(layer('minecraft:bookshelf', [...line([OV.x + 9, 9, OV.z + 2], [OV.x + 9, 9, OV.z + 5]), ...line([OV.x + 9, 10, OV.z + 2], [OV.x + 9, 10, OV.z + 5])]));
add(layer('minecraft:dark_oak_slab[type=top]', line([OV.x + 4, 9, OV.z + 2], [OV.x + 6, 9, OV.z + 2])), layer('minecraft:chest[facing=south]', [[OV.x + 2, 9, OV.z + 1]]));
guard('evoker', [OV.x + 5, 9, OV.z + 1], [0, -1], 'book');

// Barracks (bunks on both floors), the armory, the stable.
const BK = { x: 20, z: 99 };
add(placeAt(house({ w: 17, d: 7, floors: 2, floorHeight: 4, roof: 'flat', door: 'north', palette: TIMBER }), { at: [BK.x, 0, BK.z] }));
for (const y of [1, 5]) for (const x of [25, 27, 29, 31, 33]) {
    add(layer('minecraft:red_bed[facing=south,part=foot]', [[x, y, BK.z + 4]]), layer('minecraft:red_bed[facing=south,part=head]', [[x, y, BK.z + 5]]));
}
const AR = { x: 40, z: 99 };
add(placeAt(house({ w: 9, d: 7, floors: 1, floorHeight: 5, roof: 'flat', door: 'north', furnish: false, palette: TIMBER }), { at: [AR.x, 0, AR.z] }));
add(layer('minecraft:anvil[facing=east]', [[AR.x + 1, 1, AR.z + 5], [AR.x + 2, 1, AR.z + 5]]), layer('minecraft:iron_block', [[AR.x + 4, 1, AR.z + 5], [AR.x + 4, 2, AR.z + 5]]),
    layer('minecraft:barrel[facing=up]', [[AR.x + 6, 1, AR.z + 5], [AR.x + 7, 1, AR.z + 5], [AR.x + 7, 2, AR.z + 5]]),
    layer('minecraft:chest[facing=east]', [[AR.x + 1, 1, AR.z + 2], [AR.x + 1, 1, AR.z + 3]]), layer('minecraft:lantern[hanging=true]', [[AR.x + 4, 4, AR.z + 3]]));
const ST = { x: 74, z: 99 };
add(placeAt(house({ w: 19, d: 7, floors: 1, floorHeight: 4, roof: 'gable', door: 'north', furnish: false, palette: TIMBER }), { at: [ST.x, 0, ST.z] }));
add(layer(TIMBER.fence, [ST.x + 6, ST.x + 12].flatMap(x => line([x, 1, ST.z + 2], [x, 1, ST.z + 5]))),
    layer('minecraft:hay_block', [[ST.x + 1, 1, ST.z + 5], [ST.x + 2, 1, ST.z + 5], [ST.x + 8, 1, ST.z + 5], [ST.x + 14, 1, ST.z + 5], [ST.x + 17, 1, ST.z + 5]]),
    layer('minecraft:lantern[hanging=true]', [[ST.x + 3, 3, ST.z + 3], [ST.x + 9, 3, ST.z + 3], [ST.x + 15, 3, ST.z + 3]]));
creatures.push(...spawns('minecraft:horse', [[ST.x + 3, 1, ST.z + 4], [ST.x + 9, 1, ST.z + 4], [ST.x + 15, 1, ST.z + 4]], { nbt: '{Tame:1b}' }));

// --------------------------------------------------------------------------------------------- light and finish

plan.splice(worksAt, 0, ...works());
// A glow block flush in the ground every 6 blocks of open yard and ward, wherever nothing stands.
{
    const used = new Set(resolve(plan, { finalize: false }).layers.flatMap(l => l.points.filter(p => p[1] <= 1).map(p => `${p[0]},${p[2]}`)));
    const glow = [];
    for (let x = 6; x <= W - 6; x += 6) for (let z = 6; z <= D - 6; z += 6) if (!used.has(`${x},${z}`)) glow.push([x, 0, z]);
    add(layer(GLOW, glow));
}

// ------------------------------------------------------------------------------------------------------ proofs

/**
 * The containment proof, run on every dry run: from one start in every prisoner zone a villager and a 1-high
 * walker must stay inside that zone's bounds; zombies from beyond the moat must reach no prisoner zone; no illager
 * statue may stand within a villager's panic radius of a field (open sky: the cells and stalls are closed rooms).
 */
function prove() {
    const inside = (b, [x, y, z]) => x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5];
    const resolved = resolve(plan, { finalize: false }).layers;
    let ok = true;
    for (const zn of zones) {
        const res = ['villager', 'small'].map(walker => {
            const { cells, out } = walk(resolved, zn.start, { walker });
            const stray = [...cells].map(k => k.split(',').map(Number)).find(p => !inside(zn.bounds, p));
            return { walker, n: cells.size, out, stray };
        });
        const good = res.every(r => !r.out && !r.stray);
        ok &&= good;
        console.log(`  walk ${good ? 'ok  ' : 'FAIL'} ${zn.name.padEnd(20)} ${res.map(r => `${r.walker} ${r.n} cells${r.out ? `, OUT at ${r.out}` : ''}${r.stray ? `, strays to ${r.stray}` : ''}`).join(' · ')}`);
    }
    // Zombies: from the far side of the moat, inside a barrier ring that keeps the walk finite.
    const R = 24, ring = layer('minecraft:barrier', Array.from({ length: 40 }, (_, y) => rectRing(-R, -R, W + R, D + R, y + 1)).flat());
    const z = walk(concat(resolved, ring), [W / 2, 1, MZ + 10], { walker: 'zombie' });
    const reached = zones.filter(zn => [...z.cells].some(k => inside(zn.bounds, k.split(',').map(Number))));
    const zGood = !z.out && !reached.length;
    ok &&= zGood;
    console.log(`  walk ${zGood ? 'ok  ' : 'FAIL'} ${'zombie from outside'.padEnd(20)} ${z.cells.size} cells, reaches ${reached.length ? reached.map(r => r.name).join(', ') : 'no prisoner zone'}${z.out ? `, OUT at ${z.out}` : ''}`);
    // Panic: a villager panics (and stops working) with an illager in sight within 15 (pillager) / 12 (evoker) / 10 blocks.
    const RANGE = { 'minecraft:pillager': 15, 'minecraft:evoker': 12, 'minecraft:vindicator': 10 };
    let worst = null;
    for (const zn of zones.filter(zz => zz.name.startsWith('field'))) for (const s of statues) {
        const b = zn.bounds, c = [1, 2].map(y => [Math.max(b[0], Math.min(s.p[0], b[3])), y, Math.max(b[2], Math.min(s.p[2], b[5]))]);
        const d = Math.min(...c.map(q => Math.hypot(q[0] - s.p[0], q[1] - s.p[1], q[2] - s.p[2])));
        const margin = d - RANGE[s.entity];
        if (!worst || margin < worst.margin) worst = { margin, d, s, zn };
    }
    if (worst) {
        const pGood = worst.margin > 0;
        ok &&= pGood;
        console.log(`  panic ${pGood ? 'ok  ' : 'FAIL'} nearest illager to a field: ${worst.s.entity.slice(10)} ${worst.d.toFixed(1)} blocks from ${worst.zn.name} (range ${RANGE[worst.s.entity]})`);
    }
    return ok;
}

if (slice !== undefined) console.log(sliceMap(plan, Number(slice)));
console.log('containment proof:');
if (!prove()) throw new Error('labor-prison: the containment proof failed; fix the plan before building');
await build(plan, { label: 'labor-prison', ...run, anchor: ANCHOR, spawns: creatures });
