// Babylon. From the outside in:
//   moat (water) → berm → the city wall (mud brick, crenellated outward, a walkway on top) with a square tower every
//   `EVERY` blocks, iron doors with buttons at their feet → ONE way in, from the north: a bridge, then the Ishtar
//   Gate (lapis glazed brick, gold and ochre aurochs and sirrush, stepped merlons), fence gates closing both ends of
//   its passage → the Processional Way (lion walls) south to the ziggurat. West of it the palace (its own blue great
//   gate onto the avenue, the throne hall with its glazed facade, a courtyard pool, wings); east of it the fort (corner
//   towers, a gate, the keep, barracks, an armory, a cistern). Middle: the temple precinct with Etemenanki (five
//   stepped tiers, a grand stair and zigzag flights up to the blue temple on top) and, west of it, the Hanging
//   Gardens (four terraced vaulted galleries, trees, hedges, vines, glowing cave vines in every arch, a pool on top).
//   South and east: the village, a family and its job site in every house, irrigated fields, a market with a well
//   and a bell. Every open surface gets a light block on a `lightEvery` grid so nothing spawns inside the walls.
// Local frame: the city wall's centre lines run x = 0..180, z = 0..180 (north = z 0); y = 0 is the ground course.
//   node build-babylon.mjs                     # dry run: counts, bounding box, the walk proofs
//   node build-babylon.mjs --slice=1           # plus the top view at y = 1 (from the anchor)
//   node build-babylon.mjs --build --yes --parallel=4
//   --mobs=only | --mobs=none                  # creatures only / blocks only: a re-run must never spawn twice
// Parameters: --wallHeight (city wall, default 13), --seed (house sizes, plants), --lightEvery (grid of lights).
import { squareTower, wall, gatehouse, house, bridge, stairsBetween, earthworks, layer, concat, placeAt, translate, rotate,
    spawns, resolve, isAir, parseBlock, box, walls, rectRing, line, archOpening, archRing, extrude, palette, withProps,
    rotatePoint, DIRS, walk, build, cliOptions, sliceMap } from './lib/index.mjs';

const { params, ...run } = cliOptions();
const { wallHeight: WH = 13, seed = 11, lightEvery: LE = 10, slice, mobs = 'all' } = params;
const S = 180, C = S / 2, EVERY = 20;
const ANCHOR = run.anchor || [-C, 0, -C]; // centred on the pivot: superflat plains, nothing built within 150 blocks

const LAPIS = 'minecraft:lapis_block', GOLD = 'minecraft:gold_block', QUARTZ = 'minecraft:smooth_quartz';
const OCHRE = 'minecraft:yellow_terracotta', CREAM = 'minecraft:smooth_sandstone', BAND = 'minecraft:blue_glazed_terracotta';
const PAVE = 'minecraft:smooth_sandstone', KERB = 'minecraft:cut_red_sandstone', GRASS = 'minecraft:grass_block';
const GLOW = 'minecraft:shroomlight', AIR = 'minecraft:air', WATER = 'minecraft:water', LANTERN = 'minecraft:lantern';
const MUD = palette('bronzeAge');
const TOWER = palette('bronzeAge', { door: 'minecraft:iron_door' });
const GLAZE = palette('bronzeAge', { wall: LAPIS, trim: QUARTZ, accent: GOLD, path: PAVE });
const SAND = palette('sandstone', { glass: AIR });
const GATE = withProps('minecraft:spruce_fence_gate', { facing: 'south', open: 'false' });
const HANG = withProps(LANTERN, { hanging: 'true' });
const CHEST = withProps('minecraft:chest', { facing: 'south' });
const button = facing => withProps('minecraft:stone_button', { face: 'wall', facing });
const leaves = id => withProps(id, { persistent: 'true' });
const PALM_LOG = withProps('minecraft:jungle_log', { axis: 'y' }), PALM_LEAF = leaves('minecraft:jungle_leaves');
const HEDGE = [leaves('minecraft:azalea_leaves'), leaves('minecraft:flowering_azalea_leaves')];
const FLOWERS = ['poppy', 'dandelion', 'cornflower', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip',
    'pink_tulip', 'oxeye_daisy', 'lily_of_the_valley'].map(f => `minecraft:${f}`);
const half = n => Math.floor(n / 2);
const mod6 = n => ((n % 6) + 6) % 6;
let s = seed;
const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rand() * a.length)];

export const plan = [];
const add = (...parts) => plan.push(...concat(...parts));
const creatures = [];
const zones = [];                 // { name, start, bounds }: a villager there must stay inside
const outside = [C, 1, -30];      // north of the bridge: zombies from here must reach no zone

// ------------------------------------------------------------------------------------------------------ helpers

/** Pixel art on a wall: rows top-down, '#' = ink; put(u, v) gives the block for column u, row v (0 = bottom). */
function relief(rows, ink, put) {
    const pts = [];
    rows.forEach((r, i) => [...r].forEach((c, u) => { if (c === '#') pts.push(put(u, rows.length - 1 - i)); }));
    return layer(ink, pts);
}
const AUROCHS = ['.....#.', '######.', '#######', '.#...#.', '.#...#.'];
const SIRRUSH = ['.....##', '.....#.', '#...##.', '######.', '.#..#..', '.#..#..'];
const LION = ['#....##', '.######', '.#####.', '.#...#.'];

/**
 * A row of figures (7 wide, 1 apart, centred) on a face: axis 'z' = the plane z = c, figures along x from a0 to a1;
 * axis 'x' = the plane x = c, along z. dir +1: heads toward +x (or +z), -1 toward -x (-z).
 */
function frieze(fig, ink, { axis, c, a0, a1, y0, dir }) {
    const w = fig[0].length, n = Math.floor((a1 - a0 + 2) / (w + 1));
    const start = a0 + half(a1 - a0 + 1 - (n * (w + 1) - 1));
    const out = [];
    for (let i = 0; i < n; i++) {
        const s0 = start + i * (w + 1);
        out.push(...relief(fig, ink, (u, v) => { const a = dir > 0 ? s0 + u : s0 + w - 1 - u; return axis === 'z' ? [a, y0 + v, c] : [c, y0 + v, a]; }));
    }
    return out;
}

/** Stepped Babylonian merlons on the rim of x0..x1 × z0..z1 at y: three on, one off, the middle one a step higher. */
function stepped(x0, z0, x1, z1, y, block) {
    const pts = [];
    const run = cells => cells.forEach(([x, , z], i) => { if (i % 4 < 3) pts.push([x, y, z]); if (i % 4 === 1) pts.push([x, y + 1, z]); });
    run(line([x0, y, z0], [x1, y, z0])); run(line([x0, y, z1], [x1, y, z1]));
    if (z1 - z0 > 1) { run(line([x0, y, z0 + 1], [x0, y, z1 - 1])); run(line([x1, y, z0 + 1], [x1, y, z1 - 1])); }
    return layer(block, pts);
}

/** A date palm: a jungle-log trunk from y0, a crown of fronds `arm` long (the tips droop a block). */
function palm(x, y0, z, trunk = 7, arm = 3) {
    const t = y0 + trunk - 1, fronds = [[x, t + 1, z]];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (let i = 1; i <= arm; i++) fronds.push([x + dx * i, i === arm ? t : t + 1, z + dz * i]);
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { fronds.push([x + dx, t + 1, z + dz]); if (arm > 2) fronds.push([x + 2 * dx, t, z + 2 * dz]); }
    return concat(layer(PALM_LOG, line([x, y0, z], [x, t, z])), layer(PALM_LEAF, fronds));
}
/** A flowering azalea bush on the ground at y0: 3 × 3, a cap on top. */
const bush = (x, y0, z) => layer(pick(HEDGE), [...box([x - 1, y0, z - 1], [x + 1, y0, z + 1]), [x, y0 + 1, z], [x + 1, y0 + 1, z], [x, y0 + 1, z - 1]]);
/** A cypress: a narrow column of dark leaves on a short trunk. */
const cypress = (x, y0, z, h = 6) => concat(layer(withProps('minecraft:spruce_log', { axis: 'y' }), line([x, y0, z], [x, y0 + 1, z])),
    layer(leaves('minecraft:spruce_leaves'), [...line([x, y0 + 2, z], [x, y0 + h, z]),
        ...[[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dz]) => line([x + dx, y0 + 2, z + dz], [x + dx, y0 + h - 2, z + dz]))]));

/** Applies a placeAt transform to a point. */
const at = (p, { at: a = [0, 0, 0], turns = 0 }) => { const q = rotatePoint(p, turns); return [q[0] + a[0], q[1] + a[1], q[2] + a[2]]; };

// ------------------------------------------------------------------------------------------------ the city wall

// Earthworks first (everything else overwrites them): a 10-block berm, then a moat 7 wide and 3 deep.
add(earthworks({ x0: -2, z0: -2, x1: S + 2, z1: S + 2, glacisRun: 0, glacisHeight: 1, berm: 10, moatWidth: 7, moatDepth: 3 }));

/** A tower straddling a wall that runs east-west with the outside to the north; iron door on the city face. */
const midTower = concat(translate(squareTower({
    w: 7, d: 9, height: WH + 5, floors: [6, WH - 1], ladder: 'north', palette: TOWER,
    openings: [{ side: 'west', y: WH, width: 3, at: 6 }, { side: 'east', y: WH, width: 3, at: 6 }, { side: 'south', door: true }],
}), -3, 0, -6),
// No ground-storey slits (a baby zombie would climb in, up the ladder and down off the walkway); the door is at
// (0, 1, 2), its button on (-1, 2, 2) inside and outside.
layer(MUD.wall, rectRing(-3, -6, 3, 2, 2).filter(([x, , z]) => x || z !== 2)), layer(button('north'), [[-1, 2, 1]]), layer(button('south'), [[-1, 2, 3]]));
/** A tower centred on a north-west corner (walls leave east and south); its iron door at (4, 1, 5) opens into the city. */
const cornerTower = concat(translate(squareTower({
    w: 11, d: 11, height: WH + 7, floors: [6, WH - 1, WH + 3], ladder: 'north', palette: TOWER,
    openings: [{ side: 'east', y: WH, width: 3 }, { side: 'south', y: WH, width: 3 }, { side: 'south', door: true, at: 9 }],
}), -5, 0, -5),
layer(MUD.wall, rectRing(-5, -5, 5, 5, 2).filter(([x, , z]) => x !== 4 || z !== 5)), layer(button('north'), [[3, 2, 4]]), layer(button('south'), [[3, 2, 6]]),
// One corner lantern leaves the far corner of a 9 × 9 storey dark: a lantern under every ceiling too.
layer(HANG, [6, WH - 1, WH + 3, WH + 7].map(f => [0, f - 1, 0])));

/** A ring of walls on centre lines x0..x1 × z0..z1: corner and mid towers, wall pieces between, gaps for gates. */
function fortify({ x0, z0, x1, z1, mids, gaps = {}, wallOpts, corner, mid, cornerHalf = 5, midHalf = 3, palette: P }) {
    const sides = {
        north: { at: a => [a, z0], range: [x0, x1], turns: 0 }, east: { at: a => [x1, a], range: [z0, z1], turns: 1 },
        south: { at: a => [a, z1], range: [x0, x1], turns: 2 }, west: { at: a => [x0, a], range: [z0, z1], turns: 3 },
    };
    const towers = [];
    for (const [name, sd] of Object.entries(sides)) {
        const stops = [[sd.range[0], cornerHalf], ...(mids[name] || []).map(a => [a, midHalf]), [sd.range[1], cornerHalf]];
        for (let i = 0; i + 1 < stops.length; i++) {
            let pieces = [[stops[i][0] + stops[i][1], stops[i + 1][0] - stops[i + 1][1]]];
            for (const [g0, g1] of gaps[name] || []) pieces = pieces.flatMap(([a, b]) => (g0 > a && g1 < b ? [[a, g0], [g1, b]] : [[a, b]]));
            for (const [a, b] of pieces) add(wall({ ...wallOpts, from: sd.at(a), to: sd.at(b), outer: name, palette: P }));
        }
        if (mid) for (const a of mids[name] || []) { const [x, z] = sd.at(a); towers.push(placeAt(mid, { at: [x, 0, z], turns: sd.turns })); }
    }
    [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].forEach(([x, z], t) => towers.push(placeAt(corner, { at: [x, 0, z], turns: t })));
    for (const t of towers) add(t);
}

const every = Array.from({ length: S / EVERY - 1 }, (_, i) => (i + 1) * EVERY);
fortify({
    x0: 0, z0: 0, x1: S, z1: S, palette: MUD, corner: cornerTower, mid: midTower,
    mids: { north: every.filter(a => Math.abs(a - C) > 20), east: every, south: every, west: every },
    gaps: { north: [[C - 21, C + 21]] },
    wallOpts: { height: WH, thickness: 5, walkway: true, crenellations: 'outer', overhang: true },
});

// ------------------------------------------------------------------------------------------------ Ishtar Gate

/**
 * The Ishtar Gate, passage along Z centred on x = 0, the city wall's centre line at z = 0: a lower outer gate (body and
 * two towers, z -12..-3) in front of the taller inner gate (body and two towers, z -6..11). Solid lapis masses on a
 * quartz footing, a glazed base course, a quartz-and-gold band under stepped quartz merlons, rows of aurochs (ochre) and
 * sirrush (gold) walking toward the passage. The passage (5 wide, 10 then 13 high) is closed by fence gates at both ends.
 */
function ishtarGate() {
    const g = [];
    const masses = [[-9, -9, 9, -3, 14], [-18, -12, -10, -3, 18], [10, -12, 18, -3, 18], [-12, -2, 12, 11, 23], [-21, -6, -13, 11, 28], [13, -6, 21, 11, 28]];
    for (const [x0, z0, x1, z1, top] of masses) {
        g.push(...layer(QUARTZ, box([x0, 0, z0], [x1, 0, z1])), ...layer(LAPIS, box([x0, 1, z0], [x1, top, z1])));
        g.push(...layer(BAND, rectRing(x0, z0, x1, z1, 1)));
        const band = rectRing(x0, z0, x1, z1, top - 1);
        g.push(...layer(QUARTZ, band.filter(([x, , z]) => (x + z) % 2 === 0)), ...layer(GOLD, band.filter(([x, , z]) => (x + z) % 2 !== 0)));
        g.push(...stepped(x0, z0, x1, z1, top + 1, QUARTZ));
    }
    // Figures (heads toward the passage). North faces: outer towers, the inner gate above the outer one, inner towers above the outer towers.
    for (const sgn of [-1, 1]) {
        const toward = -sgn, x0 = sgn < 0 ? -18 : 10, x1 = sgn < 0 ? -10 : 18;
        g.push(...frieze(AUROCHS, OCHRE, { axis: 'z', c: -12, a0: x0, a1: x1, y0: 3, dir: toward }));
        g.push(...frieze(SIRRUSH, GOLD, { axis: 'z', c: -12, a0: x0, a1: x1, y0: 10, dir: toward }));
        g.push(...frieze(SIRRUSH, GOLD, { axis: 'z', c: -6, a0: sgn < 0 ? -21 : 13, a1: sgn < 0 ? -13 : 21, y0: 21, dir: toward }));
        g.push(...frieze(AUROCHS, OCHRE, { axis: 'z', c: -2, a0: sgn < 0 ? -12 : 1, a1: sgn < 0 ? -1 : 12, y0: 16, dir: toward }));
        // South faces (city side): inner body beside the arch, inner towers.
        for (const [c, a0, a1, rows] of [[11, sgn < 0 ? -12 : 4, sgn < 0 ? -4 : 12, [[AUROCHS, OCHRE, 3], [SIRRUSH, GOLD, 10], [AUROCHS, OCHRE, 17]]],
            [11, sgn < 0 ? -21 : 13, sgn < 0 ? -13 : 21, [[AUROCHS, OCHRE, 3], [SIRRUSH, GOLD, 10], [AUROCHS, OCHRE, 18]]]]) {
            for (const [fig, ink, y0] of rows) g.push(...frieze(fig, ink, { axis: 'z', c, a0, a1, y0, dir: toward }));
        }
    }
    // The passage, its arch rings and keystones, paving, gates, lights.
    const arch = (w, h, z0, z1) => extrude(archOpening(w, h), 'x', z1 - z0 + 1).map(([u, v, d]) => [u - half(w), 1 + v, z0 + d]);
    g.push(...layer(AIR, [...arch(5, 10, -9, -3), ...arch(5, 13, -2, 11)]));
    g.push(...layer(QUARTZ, [...archRing(5, 10, 1).map(([u, v]) => [u - 2, 1 + v, -9]), ...archRing(5, 13, 1).map(([u, v]) => [u - 2, 1 + v, 11])]));
    g.push(...layer(GOLD, [[0, 11, -9], [0, 14, 11]]));
    g.push(...layer(PAVE, box([-2, 0, -12], [2, 0, 13])));
    g.push(...layer(GATE, [...line([-2, 1, -9], [2, 1, -9]), ...line([-2, 1, 11], [2, 1, 11])]));
    g.push(...layer(HANG, [[0, 10, -6], [0, 13, 0], [0, 13, 6]]));
    for (const z of [-6, 0, 6]) g.push(...layer(withProps('minecraft:wall_torch', { facing: 'east' }), [[-2, 4, z]]), ...layer(withProps('minecraft:wall_torch', { facing: 'west' }), [[2, 4, z]]));
    return g;
}
add(placeAt(ishtarGate(), { at: [C, 0, 0] }));

// The bridge over the moat (z -19..-13) and the road to it.
add(placeAt(bridge({ length: 11, width: 5, rise: 1, railings: true, lights: true, palette: palette('bronzeAge', { floor: PAVE }) }), { at: [C, 0, -21], turns: 1 }));
add(layer(PAVE, box([C - 3, 0, -27], [C + 3, 0, -22])));

// --------------------------------------------------------------------------------------- streets and the avenue

const STREET = MUD.path;
add(layer(STREET, [...box([7, 0, 59], [172, 0, 63]), ...box([7, 0, 133], [172, 0, 137])])); // street C (north), street A (south)

// The Processional Way: paved, kerbed, palms on a strip each side, lion walls (lapis toward the avenue, mud brick behind).
const GZ = 35; // the palace and fort gates' centre z
add(layer(PAVE, box([C - 4, 0, 12], [C + 4, 0, 61])), layer(KERB, [...line([C - 4, 0, 12], [C - 4, 0, 58]), ...line([C + 4, 0, 12], [C + 4, 0, 58])]));
for (const [xin, xout, dir] of [[C - 6, C - 7, 1], [C + 6, C + 7, 1]]) {
    for (const [z0, z1] of [[14, GZ - 4], [GZ + 4, 57]]) {
        add(layer(QUARTZ, box([Math.min(xin, xout), 0, z0], [Math.max(xin, xout), 0, z1])));
        add(layer(MUD.wall, box([xout, 1, z0], [xout, 6, z1])), layer(LAPIS, box([xin, 1, z0], [xin, 6, z1])), layer(BAND, line([xin, 1, z0], [xin, 1, z1])));
        add(frieze(LION, CREAM, { axis: 'x', c: xin, a0: z0, a1: z1, y0: 2, dir }));
        const band = line([xin, 6, z0], [xin, 6, z1]);
        add(layer(GOLD, band.filter(p => p[2] % 2 === 0)), layer(QUARTZ, band.filter(p => p[2] % 2 !== 0)), stepped(xin, z0, xin, z1, 7, QUARTZ));
    }
}
for (const z of [18, 26, 44, 52]) add(palm(C - 5, 1, z, 8), palm(C + 5, 1, z, 8));
add(layer(PAVE, [...box([79, 0, GZ - 2], [C - 5, 0, GZ + 2]), ...box([C + 5, 0, GZ - 2], [102, 0, GZ + 2])])); // to the palace and fort gates

// ---------------------------------------------------------------------------------------- palace, fort, precinct

/** A walled compound: wall centre lines x0..x1 × z0..z1, square corner towers (cw wide) with doors inward, gaps for gates. */
function compound({ x0, z0, x1, z1, wallH, cw, towerH, floors, gaps = {}, P }) {
    const corner = translate(squareTower({
        w: cw, d: cw, height: towerH, floors, ladder: 'north', palette: P,
        openings: [{ side: 'east', y: wallH, width: 3 }, { side: 'south', y: wallH, width: 3 }, { side: 'south', door: true, at: cw - 2 }],
    }), -half(cw), 0, -half(cw));
    fortify({ x0, z0, x1, z1, mids: {}, gaps, corner, cornerHalf: half(cw), palette: P,
        wallOpts: { y: 0, height: wallH, thickness: 3, walkway: true, crenellations: 'both' } });
}

// The palace (north-west): wall centre lines x 12..74, z 16..54; interior x 14..72, z 18..52.
add(layer('minecraft:cut_sandstone', box([14, 0, 18], [72, 0, 52])));
compound({ x0: 12, z0: 16, x1: 74, z1: 54, wallH: 10, cw: 7, towerH: 15, floors: [5, 9], gaps: { east: [[GZ - 6, GZ + 6]] }, P: MUD });
// Its great gate on the east wall, facing the avenue: lapis, quartz-lined arch, a gold lion above, copper portcullis.
add(placeAt(concat(gatehouse({ width: 5, height: 7, depth: 9, sideWidth: 3, upperFloor: 9, turrets: false, sideDoors: true, palette: GLAZE }),
    layer(AIR, [...rectRing(-6, 0, 6, 8, 14), ...rectRing(-6, 0, 6, 8, 15)]), stepped(-6, 0, 6, 8, 14, QUARTZ), layer(BAND, rectRing(-6, 0, 6, 8, 1).filter(([x]) => Math.abs(x) > 2)),
    frieze(LION, GOLD, { axis: 'z', c: 0, a0: -3, a1: 3, y0: 9, dir: 1 })), { at: [78, 0, GZ], turns: 1 }));

/** The throne hall: x 22..64, z 32..46, its glazed facade on the north (the courtyard), the throne on a dais at the back. */
function throneHall() {
    const h = [], X0 = 22, X1 = 64, Z0 = 32, Z1 = 46, TOP = 11, CX = 43;
    h.push(...layer(PAVE, box([X0 + 1, 0, Z0 + 1], [X1 - 1, 0, Z1 - 1])));
    h.push(...layer(MUD.wall, walls([X0, 1, Z0], [X1, TOP, Z1])), ...layer(LAPIS, box([X0, 1, Z0], [X1, TOP, Z0])));
    h.push(...layer(MUD.roof, box([X0, TOP + 1, Z0], [X1, TOP + 1, Z1])), ...stepped(X0, Z0, X1, Z1, TOP + 2, MUD.wall));
    h.push(...layer(QUARTZ, line([X0, TOP + 2, Z0], [X1, TOP + 2, Z0]).filter((p, i) => i % 4 < 3)), ...layer(QUARTZ, line([X0, TOP + 3, Z0], [X1, TOP + 3, Z0]).filter((p, i) => i % 4 === 1)));
    // Facade: glazed base, lions at both ends, palmette columns, a rosette band and a gold cornice.
    h.push(...layer(BAND, line([X0, 1, Z0], [X1, 1, Z0])));
    h.push(...frieze(LION, CREAM, { axis: 'z', c: Z0, a0: X0 + 1, a1: X0 + 7, y0: 2, dir: 1 }), ...frieze(LION, CREAM, { axis: 'z', c: Z0, a0: X1 - 7, a1: X1 - 1, y0: 2, dir: -1 }));
    for (const x of [37, 49]) h.push(...layer(GOLD, line([x, 2, Z0], [x, 8, Z0])), ...layer(QUARTZ, [[x, 9, Z0], [x - 1, 9, Z0], [x + 1, 9, Z0], [x, 10, Z0]]));
    const band = line([X0, 10, Z0], [X1, 10, Z0]);
    h.push(...layer(QUARTZ, band.filter((p, i) => i % 2 === 0 && Math.abs(p[0] - 37) > 1 && Math.abs(p[0] - 49) > 1)), ...layer(GOLD, line([X0, TOP, Z0], [X1, TOP, Z0])));
    // Doorways: a 5 × 7 arch in the middle, 3 × 4 doors either side.
    h.push(...layer(AIR, archOpening(5, 7).map(([u, v]) => [CX - 2 + u, 1 + v, Z0])));
    h.push(...layer(QUARTZ, archRing(5, 7, 1).map(([u, v]) => [CX - 2 + u, 1 + v, Z0])), ...layer(GOLD, [[CX, 8, Z0]]));
    h.push(...layer(AIR, [31, 55].flatMap(x => box([x - 1, 1, Z0], [x + 1, 4, Z0]))));
    // Inside: a red runner, a two-step quartz dais, the throne between gold arms against a gold back panel.
    h.push(...layer('minecraft:red_carpet', box([CX - 1, 1, Z0 + 1], [CX + 1, 1, Z1 - 6])));
    h.push(...layer(QUARTZ, box([CX - 4, 1, Z1 - 4], [CX + 4, 1, Z1 - 1])), ...layer(QUARTZ, box([CX - 2, 2, Z1 - 2], [CX + 2, 2, Z1 - 1])));
    h.push(...layer(withProps('minecraft:quartz_stairs', { facing: 'south' }), [[CX, 3, Z1 - 1]]), ...layer(GOLD, [[CX - 1, 3, Z1 - 1], [CX + 1, 3, Z1 - 1]]));
    h.push(...layer(GOLD, box([CX - 1, 3, Z1], [CX + 1, 7, Z1])), ...layer(LAPIS, box([CX - 3, 3, Z1], [CX - 2, 7, Z1])), ...layer(LAPIS, box([CX + 2, 3, Z1], [CX + 3, 7, Z1])));
    for (const x of [27, 35, 43, 51, 59]) for (const z of [36, 42]) h.push(...layer(HANG, [[x, TOP, z]]));
    for (const x of [26, 60]) h.push(...layer(LANTERN, [[x, 1, Z1 - 1]]));
    // The hanging lanterns are 10 up: glowing floor tiles keep the floor lit.
    for (let x = X0 + 3; x < X1; x += 6) for (const zz of [Z0 + 3, Z0 + 9]) if (Math.abs(x - CX) > 1) h.push(...layer(GLOW, [[x, 0, zz]]));
    return h;
}
add(throneHall());
// Wings for the court, the courtyard pool with palms.
add(placeAt(house({ w: 7, d: 15, floors: 2, roof: 'flat', door: 'east', palette: MUD }), { at: [14, 0, 32] }));
add(placeAt(house({ w: 7, d: 9, floors: 2, roof: 'flat', door: 'west', palette: MUD }), { at: [66, 0, 42] }));
add(layer(WATER, box([37, -1, 22], [49, 0, 27])), layer(QUARTZ, rectRing(36, 21, 50, 28, 0)), layer(withProps('minecraft:smooth_sandstone_slab', { type: 'bottom' }), rectRing(36, 21, 50, 28, 1)));
for (const [x, z] of [[32, 24], [54, 24]]) add(palm(x, 1, z, 7));
for (const [x, z] of [[20, 22], [43, 19], [66, 22]]) add(layer(QUARTZ, [[x, 1, z]]), layer(LANTERN, [[x, 2, z]]));

// The fort (north-east): wall centre lines x 106..168, z 16..54; interior x 108..166, z 18..52.
add(layer(STREET, box([108, 0, 18], [166, 0, 52])));
compound({ x0: 106, z0: 16, x1: 168, z1: 54, wallH: 12, cw: 9, towerH: 18, floors: [6, 11, 15], gaps: { west: [[GZ - 5, GZ + 5]] }, P: MUD });
add(placeAt(gatehouse({ width: 3, height: 5, depth: 7, sideWidth: 3, upperFloor: 11, turrets: false, sideDoors: true, palette: MUD }), { at: [103, 0, GZ], turns: 3 }));
const KEEP = palette('bronzeAge', { door: 'minecraft:spruce_door' });
add(placeAt(squareTower({ w: 13, d: 13, height: 28, floors: [6, 11, 16, 21, 25], ladder: 'north', palette: KEEP, openings: [{ side: 'west', door: true }] }), { at: [142, 0, 26] }));
add(layer(MUD.accent, rectRing(142, 26, 154, 38, 14)), layer(MUD.accent, rectRing(142, 26, 154, 38, 22)), layer(HANG, [6, 11, 16, 21, 25, 28].map(f => [148, f - 1, 32])));
add(placeAt(house({ w: 23, d: 7, floors: 2, roof: 'flat', door: 'north', palette: MUD }), { at: [112, 0, 44] }));         // barracks
add(layer(HANG, [116, 130].flatMap(x => [[x, 3, 47], [x, 7, 47]])));
add(placeAt(house({ w: 11, d: 9, roof: 'flat', door: 'south', furnish: false, palette: MUD }), { at: [112, 0, 19] }));    // armory
add(layer('minecraft:anvil[facing=east]', [[114, 1, 21], [114, 1, 24]]), layer(CHEST, [[118, 1, 20], [119, 1, 20], [120, 1, 20]]),
    layer('minecraft:waxed_copper_block', [[121, 1, 23], [121, 1, 24], [121, 2, 23]]), layer(LANTERN, [[117, 1, 25]]));
for (const x of [128, 132, 136]) add(layer('minecraft:hay_block', [[x, 1, 22]]), layer('minecraft:target', [[x, 2, 22]])); // archery butts
add(layer(WATER, box([128, -2, 32], [132, 0, 36])), layer(MUD.trim, rectRing(127, 31, 133, 37, 0)), layer(MUD.fence, rectRing(127, 31, 133, 37, 1)),
    layer(LANTERN, [[127, 2, 31], [133, 2, 37]]));                                                                        // cistern
for (const [x, z] of [[124, 27], [138, 44], [160, 24], [160, 46], [126, 40]]) add(layer(QUARTZ, [[x, 1, z]]), layer(LANTERN, [[x, 2, z]]));

// The temple precinct: wall centre lines x 62..118, z 65..129, blue gates north and south; courtyard paved.
add(layer(PAVE, box([64, 0, 67], [116, 0, 127])));
compound({ x0: 62, z0: 65, x1: 118, z1: 129, wallH: 7, cw: 7, towerH: 11, floors: [6], gaps: { north: [[C - 6, C + 6]], south: [[C - 6, C + 6]] }, P: MUD });
const pgate = concat(gatehouse({ width: 5, height: 4, depth: 7, sideWidth: 2, upperFloor: 6, turrets: false, sideDoors: true, palette: GLAZE }),
    layer(AIR, [...rectRing(-5, 0, 5, 6, 11), ...rectRing(-5, 0, 5, 6, 12)]), stepped(-5, 0, 5, 6, 11, QUARTZ), layer(BAND, rectRing(-5, 0, 5, 6, 1).filter(([x]) => Math.abs(x) > 2)));
add(placeAt(pgate, { at: [C, 0, 62] }), placeAt(pgate, { at: [C, 0, 132], turns: 2 }));
for (const [x, z] of [[69, 72], [111, 72], [69, 122], [111, 122]]) add(palm(x, 1, z, 7));

// ------------------------------------------------------------------------------------------------- Etemenanki

/**
 * The ziggurat, centred on (cx, cz): five solid stepped tiers of mud brick (packed-mud pilasters every 4, a sandstone
 * edge course; the top tier glazed), a 7-wide grand stair on the north face up to tier 2, side flights to tier 1,
 * zigzag flights up the north faces of tiers 3..5, and the blue temple with a gold floor on top.
 */
function ziggurat(cx, cz) {
    const z = [];
    const tiers = [[20, 6], [16, 12], [12, 17], [8, 22], [5, 27]];
    z.push(...layer(CREAM, box([cx - 20, 0, cz - 20], [cx + 20, 0, cz + 20])));
    let base = 1;
    tiers.forEach(([h, top], i) => {
        const glazed = i === tiers.length - 1, x0 = cx - h, x1 = cx + h, z0 = cz - h, z1 = cz + h;
        z.push(...layer(glazed ? LAPIS : MUD.wall, box([x0, base, z0], [x1, top, z1])));
        const pil = [];
        for (let y = base; y < top; y++) for (const p of rectRing(x0, z0, x1, z1, y)) if ((p[0] - cx) % 4 === 0 || (p[2] - cz) % 4 === 0) pil.push(p);
        z.push(...layer(glazed ? BAND : MUD.roof, pil.filter(([x, , zz]) => (x === x0 || x === x1) ? (zz - cz) % 4 === 0 : (x - cx) % 4 === 0)));
        z.push(...layer(glazed ? GOLD : CREAM, rectRing(x0, z0, x1, z1, top)));
        // Lanterns on the terrace edge every 8 (none on the north face, where the stairs arrive).
        if (!glazed) z.push(...layer(LANTERN, rectRing(x0, z0, x1, z1, top + 1).filter(([x, , zz], j) => j % 8 === 4 && zz !== z0)));
        base = top + 1;
    });
    const ST = 'minecraft:smooth_sandstone_stairs', flight = (a, b, width) => stairsBetween(a, b, { width, fill: true, block: ST, landing: PAVE, fillBlock: MUD.wall });
    // The grand stair, cutting into tiers 1 and 2 (headroom cut above it), and the two side flights to tier 1.
    const grand = flight([cx, 0, cz - 26], [cx, 12, cz - 14], 7);
    z.push(...grand, ...layer(AIR, grand.filter(l => /stairs/.test(l.block)).flatMap(l => l.points).flatMap(([x, y, zz]) => [[x, y + 1, zz], [x, y + 2, zz]])));
    z.push(...flight([cx - 18, 0, cz - 22], [cx - 12, 6, cz - 22], 2), ...flight([cx + 18, 0, cz - 21], [cx + 12, 6, cz - 21], 2));
    // Zigzag up the north faces: tier 2 -> 3 east, 3 -> 4 west, 4 -> 5 west.
    z.push(...flight([cx + 4, 12, cz - 14], [cx + 9, 17, cz - 14], 2), ...flight([cx + 9, 17, cz - 9], [cx + 4, 22, cz - 9], 2),
        ...flight([cx + 4, 22, cz - 6], [cx - 1, 27, cz - 6], 2));
    // The temple: x cx-3..cx+3, z cz..cz+5 on tier 5; lapis, gold cornice and floor, stepped quartz merlons, an altar.
    const T0 = cx - 3, T1 = cx + 3, U0 = cz, U1 = cz + 5;
    z.push(...layer(LAPIS, walls([T0, 28, U0], [T1, 33, U1])), ...layer(BAND, rectRing(T0, U0, T1, U1, 28)), ...layer(GOLD, rectRing(T0, U0, T1, U1, 33)));
    z.push(...layer(LAPIS, box([T0, 34, U0], [T1, 34, U1])), ...stepped(T0, U0, T1, U1, 35, QUARTZ), ...layer(GOLD, box([T0 + 1, 27, U0 + 1], [T1 - 1, 27, U1 - 1])));
    z.push(...layer(AIR, box([cx - 1, 28, U0], [cx + 1, 30, U0])), ...layer(QUARTZ, [[cx - 2, 31, U0], [cx - 1, 31, U0], [cx, 31, U0], [cx + 1, 31, U0], [cx + 2, 31, U0]]));
    z.push(...layer('minecraft:chiseled_quartz_block', [[cx, 28, U1 - 1]]), ...layer(LANTERN, [[cx, 29, U1 - 1]]), ...layer(HANG, [[cx, 33, U0 + 2]]));
    z.push(...layer(LANTERN, [[cx - 3, 28, U0 - 2], [cx + 3, 28, U0 - 2]]));
    return z;
}
add(ziggurat(C, 97));

// ------------------------------------------------------------------------------------------- the Hanging Gardens

/**
 * Four terraced galleries centred on (cx, cz), tier k half-size 22 - 5k, 8 high (walls b..b+5, ceiling c, soil t):
 * arcades with a glowing cave vine in every arch, pillars and lanterns inside, vines down the piers, leaves spilling
 * over the edges, a hedge rim, trees and flowers on every terrace, a pool and palms on top, and flights of stairs up the
 * south faces, each landing where the next one starts.
 */
function hangingGardens(cx, cz) {
    const g = [], T = [0, 1, 2, 3].map(k => { const h = 22 - 5 * k, b = 1 + 8 * k; return { h, b, c: b + 6, t: b + 7, x0: cx - h, x1: cx + h, z0: cz - h, z1: cz + h }; });
    const F = [[[cx - 8, 0], [cx, 8]], [[cx, 8], [cx - 8, 16]], [[cx - 8, 16], [cx, 24]], [[cx + 2, 24], [cx - 6, 32]]]
        .map(([[xa, ya], [xb, yb]], k) => ({ a: [xa, ya, T[k].z1 + 2], b: [xb, yb, T[k].z1 + 2], lo: Math.min(xa, xb), hi: Math.max(xa, xb), zc: T[k].z1 + 2 }));
    const onFlight = (x, z) => F.some(f => x >= f.lo - 1 && x <= f.hi + 1 && Math.abs(z - f.zc) <= 2);
    const gap = (k, x, z) => z === T[k].z1 && Math.abs(x - F[k].b[0]) <= 1;
    const vine = { north: 'minecraft:vine[south=true]', south: 'minecraft:vine[north=true]', west: 'minecraft:vine[east=true]', east: 'minecraft:vine[west=true]' };
    T.forEach((tr, k) => {
        const { h, b, c, t, x0, x1, z0, z1 } = tr;
        g.push(...layer(PAVE, box([x0, b - 1, z0], [x1, b - 1, z1])));        // floor (on the ground or the tier below)
        g.push(...layer(SAND.wall, walls([x0, b, z0], [x1, c, z1])), ...layer(CREAM, box([x0 + 1, c, z0 + 1], [x1 - 1, c, z1 - 1])));
        g.push(...layer(GRASS, box([x0, t, z0], [x1, t, z1])), ...layer(CREAM, rectRing(x0, z0, x1, z1, c)));
        for (let dx = 3 - h; dx <= h - 3; dx++) for (let dz = 3 - h; dz <= h - 3; dz++)
            if (mod6(dx) === 3 && mod6(dz) === 3) g.push(...layer('minecraft:chiseled_sandstone', line([cx + dx, b, cz + dz], [cx + dx, c - 1, cz + dz])));
        for (let d1 = -6 * Math.floor((h - 1) / 6); d1 <= h - 1; d1 += 6) for (let d2 = -6 * Math.floor((h - 1) / 6); d2 <= h - 1; d2 += 6) g.push(...layer(HANG, [[cx + d1, c - 1, cz + d2]]));
        // Arcades on the four faces, centred every 6, skipping the arches behind this tier's flight; vines down the piers.
        const faces = [['north', a => [a, z0], [0, -1]], ['south', a => [a, z1], [0, 1]], ['west', a => [x0, a], [-1, 0]], ['east', a => [x1, a], [1, 0]]];
        for (const [side, pos, [ox, oz]] of faces) {
            const mid = side === 'north' || side === 'south' ? cx : cz;
            for (let d = -6 * Math.floor((h - 3) / 6); d <= h - 3; d += 6) {
                const [ax, az] = pos(mid + d);
                if (side === 'south' && ax >= F[k].lo - 2 && ax <= F[k].hi + 2) continue;
                const cells = [];
                for (let e = -1; e <= 1; e++) for (let y = b; y <= b + 3; y++) cells.push(side === 'north' || side === 'south' ? [ax + e, y, az] : [ax, y, az + e]);
                cells.push([ax, b + 4, az]);
                g.push(...layer(AIR, cells), ...layer('minecraft:cave_vines[berries=true]', [[ax, b + 4, az]]));
            }
            for (let d = 1 - h; d <= h - 1; d++) {
                if (mod6(d) !== 3) continue;
                const [px, pz] = pos(mid + d), vx = px + ox, vz = pz + oz;
                if (onFlight(vx, vz)) continue;
                const len = 3 + Math.floor(rand() * 4);
                g.push(...layer(vine[side], line([vx, c, vz], [vx, Math.max(b, c - len + 1), vz])));
            }
        }
        // The terrace: hedge rim (gap where the flight from below arrives), spilling leaves, trees, flowers.
        const inner = T[k + 1];
        const ringCell = (x, z) => !inner || x < inner.x0 || x > inner.x1 || z < inner.z0 || z > inner.z1;
        const rim = rectRing(x0, z0, x1, z1, t + 1).filter(([x, , z]) => !gap(k, x, z));
        g.push(...layer(HEDGE[0], rim.filter((_, j) => j % 3)), ...layer(HEDGE[1], rim.filter((_, j) => !(j % 3))));
        const spill = [];
        for (const [x, , z] of rectRing(x0 - 1, z0 - 1, x1 + 1, z1 + 1, t)) {
            const corner = (x === x0 - 1 || x === x1 + 1) && (z === z0 - 1 || z === z1 + 1);
            if (!corner && !onFlight(x, z) && rand() < 0.5) spill.push([x, t, z]);
        }
        g.push(...layer(HEDGE[1], spill));
        const used = new Set();
        const free = (x, z) => ringCell(x, z) && !onFlight(x, z) && !used.has(`${x},${z}`);
        if (inner) {
            rectRing(x0 + 2, z0 + 2, x1 - 2, z1 - 2, t + 1).forEach(([x, , z], i) => {
                if (i % 7 !== 3 || onFlight(x, z) || [...F].some(f => Math.abs(z - f.zc) <= 4 && x >= f.lo - 3 && x <= f.hi + 3)) return;
                const kind = (i / 7 | 0) % 3;
                g.push(...(kind === 0 ? palm(x, t + 1, z, 4, 2) : kind === 1 ? bush(x, t + 1, z) : cypress(x, t + 1, z, 5)));
                for (let a = -1; a <= 1; a++) for (let e = -1; e <= 1; e++) used.add(`${x + a},${z + e}`);
            });
        } else {
            // The top: a pool with a rim and lanterns, palms in the corners.
            g.push(...layer(WATER, box([cx - 2, t, cz - 2], [cx + 2, t, cz + 2])), ...layer(PAVE, rectRing(cx - 3, cz - 3, cx + 3, cz + 3, t + 1)));
            g.push(...layer(LANTERN, [[cx - 3, t + 2, cz - 3], [cx + 3, t + 2, cz - 3], [cx - 3, t + 2, cz + 3], [cx + 3, t + 2, cz + 3]]));
            for (let a = -3; a <= 3; a++) for (let e = -3; e <= 3; e++) used.add(`${cx + a},${cz + e}`);
            for (const [x, z] of [[x0 + 2, z0 + 2], [x1 - 2, z0 + 2], [x0 + 2, z1 - 3], [x1 - 2, z1 - 3]]) {
                g.push(...palm(x, t + 1, z, 5, 2));
                for (let a = -1; a <= 1; a++) for (let e = -1; e <= 1; e++) used.add(`${x + a},${z + e}`);
            }
        }
        const fl = [];
        for (let x = x0 + 1; x <= x1 - 1; x++) for (let z = z0 + 1; z <= z1 - 1; z++) if (free(x, z) && rand() < 0.3) fl.push([pick(FLOWERS), [x, t + 1, z]]);
        for (const id of FLOWERS) g.push(...layer(id, fl.filter(f => f[0] === id).map(f => f[1])));
    });
    for (const f of F) g.push(...stairsBetween(f.a, f.b, { width: 3, fill: true, block: 'minecraft:smooth_sandstone_stairs', landing: PAVE, fillBlock: SAND.wall }));
    return g;
}
add(hangingGardens(32, 90));
for (const [x, z] of [[12, 120], [22, 126], [40, 121], [50, 127], [56, 119]]) add(palm(x, 1, z, pick([6, 7, 8])));

// ------------------------------------------------------------------------------------------------- the village

const PROFS = ['farmer', 'mason', 'farmer', 'shepherd', 'farmer', 'librarian', 'farmer', 'cleric', 'farmer', 'toolsmith', 'farmer',
    'butcher', 'farmer', 'fletcher', 'farmer', 'weaponsmith', 'farmer', 'armorer', 'farmer', 'cartographer', 'farmer', 'leatherworker'];
const JOB = {
    farmer: 'minecraft:composter', mason: 'minecraft:stonecutter[facing=north]', shepherd: 'minecraft:loom[facing=north]',
    librarian: 'minecraft:lectern[facing=north]', cleric: 'minecraft:brewing_stand', toolsmith: 'minecraft:smithing_table',
    butcher: 'minecraft:smoker[facing=north]', fletcher: 'minecraft:fletching_table', weaponsmith: 'minecraft:grindstone[face=floor,facing=north]',
    armorer: 'minecraft:blast_furnace[facing=north]', cartographer: 'minecraft:cartography_table', leatherworker: 'minecraft:cauldron',
};
const BEDS = ['yellow', 'orange', 'blue', 'white', 'red', 'cyan', 'lime'];
let nHome = 0;
/**
 * A family house (mud brick, flat roof, a lantern on the roof) at footprint x..x+w-1, z..z+d-1, its door on `side`: a bed
 * along the back wall, the family's job site in the front corner, one villager of that profession inside.
 */
function home(x, z, w, d, side, floors = 1) {
    const turns = DIRS.indexOf(side), [lw, ld] = turns % 2 ? [d, w] : [w, d];
    const X = lw - 1, Z = ld - 1, cxd = half(lw), prof = PROFS[nHome % PROFS.length], bed = `minecraft:${BEDS[nHome % BEDS.length]}_bed`;
    nHome++;
    const local = concat(house({ w: lw, d: ld, floors, roof: 'flat', door: 'north', palette: MUD }),
        layer(withProps(bed, { facing: 'east', part: 'foot' }), [[X - 2, 1, Z - 1]]), layer(withProps(bed, { facing: 'east', part: 'head' }), [[X - 1, 1, Z - 1]]),
        layer(JOB[prof], [[1, 1, 1]]), layer(LANTERN, [[cxd, floors * 4 + 2, half(ld)]]));
    let p = local, sp = [cxd, 1, half(ld)];
    if (turns) {
        const cs = [[0, 0, 0], [X, 0, Z]].map(q => rotatePoint(q, turns));
        const dx = -Math.min(cs[0][0], cs[1][0]), dz = -Math.min(cs[0][2], cs[1][2]);
        p = translate(rotate(local, turns), dx, 0, dz);
        const r = rotatePoint(sp, turns); sp = [r[0] + dx, 1, r[2] + dz];
    }
    add(translate(p, x, 0, z));
    creatures.push(...spawns('minecraft:villager', [[sp[0] + x, 1, sp[2] + z]], {
        nbt: `{VillagerData:{profession:"minecraft:${prof}",level:2,type:"minecraft:desert"},Xp:10}`,
    }));
    return [sp[0] + x, 1, sp[2] + z];
}
/** Houses side by side along x0..x1 on the footprint row z..z+6, doors on `side`. */
function houseRow(x0, x1, z, side) {
    const out = [];
    for (let x = x0; ;) {
        let w = pick([7, 7, 8, 9]);
        if (x + w - 1 > x1) w = x1 - x + 1;
        if (w < 7) break;
        out.push(home(x, z, w, 7, side, pick([1, 1, 2])));
        x += w + pick([1, 2]);
    }
    return out;
}
/** Houses one behind the other along z0..z1 on the footprint column x..x+6, doors on `side`. */
function houseColumn(x, z0, z1, side) {
    for (let z = z0; ;) {
        const d = pick([8, 9]);
        if (z + d - 1 > z1) break;
        home(x, z, 7, d, side, pick([1, 1, 2]));
        z += d + 2;
    }
}
/** Irrigated field: farmland and ripe crops, a full row of water every 9 rows (4 on each side of it). */
function field(x0, z0, x1, z1) {
    const soil = [], water = [], crops = { 'minecraft:wheat[age=7]': [], 'minecraft:carrots[age=7]': [], 'minecraft:beetroots[age=3]': [], 'minecraft:potatoes[age=7]': [] };
    const kinds = Object.keys(crops);
    for (let z = z0; z <= z1; z++) {
        if ((z - z0) % 9 === 4) { water.push(...line([x0, 0, z], [x1, 0, z])); continue; }
        soil.push(...line([x0, 0, z], [x1, 0, z]));
        crops[kinds[(Math.floor((z - z0) / 9) + x0) % kinds.length]].push(...line([x0, 1, z], [x1, 1, z]));
    }
    add(layer(WATER, water), layer('minecraft:farmland[moisture=7]', soil), ...Object.entries(crops).map(([b, p]) => layer(b, p)));
}

// South band: row 1 (doors onto street A), fields, row 2 (doors onto the lane along the wall); streets between blocks.
add(layer(STREET, [...box([88, 0, 133], [92, 0, 177]), ...box([38, 0, 138], [40, 0, 177]), ...box([140, 0, 138], [142, 0, 177])]));
const firstHomes = [];
for (const [a, b] of [[7, 37], [41, 75], [105, 139], [143, 172]]) { firstHomes.push(...houseRow(a, b, 139, 'north')); field(a, 147, b, 164); }
for (const [a, b] of [[7, 37], [41, 87], [93, 139], [143, 172]]) houseRow(a, b, 166, 'south');
// East quarter: a street x 146..150, a column of houses each side, fields behind them.
add(layer(STREET, box([146, 0, 64], [150, 0, 132])));
houseColumn(139, 66, 130, 'east');
houseColumn(151, 66, 130, 'west');
field(124, 66, 137, 128);
field(159, 66, 171, 128);

// The market: paved, a well, stalls, the bell, palms.
const M = { x0: 76, z0: 139, x1: 104, z1: 164 };
add(layer(PAVE, box([M.x0, 0, M.z0], [M.x1, 0, M.z1])), layer(KERB, rectRing(M.x0, M.z0, M.x1, M.z1, 0)));
const well = (cx, cz) => concat(layer(WATER, box([cx - 1, -2, cz - 1], [cx + 1, 0, cz + 1])),
    layer(MUD.trim, rectRing(cx - 2, cz - 2, cx + 2, cz + 2, 0)), layer(MUD.fence, rectRing(cx - 2, cz - 2, cx + 2, cz + 2, 1)),
    layer(withProps(MUD.pillar, { axis: 'y' }), [2, 3].flatMap(y => [[cx - 2, y, cz], [cx + 2, y, cz]])),
    layer(withProps(MUD.pillar, { axis: 'x' }), line([cx - 2, 4, cz], [cx + 2, 4, cz])), layer(HANG, [[cx, 3, cz]]));
add(well(C, 151));
const stall = (x, z, wool) => concat(layer('minecraft:spruce_fence', [[x, z], [x + 2, z], [x, z + 1], [x + 2, z + 1]].flatMap(([a, b]) => [[a, 1, b], [a, 2, b]])),
    layer(wool, box([x, 3, z], [x + 2, 3, z + 1])), layer(CHEST, [[x + 1, 1, z]]));
add(stall(78, 141, 'minecraft:purple_wool'), stall(100, 141, 'minecraft:red_wool'), stall(78, 160, 'minecraft:orange_wool'),
    stall(100, 160, 'minecraft:blue_wool'), stall(80, 150, 'minecraft:yellow_wool'), stall(98, 150, 'minecraft:white_wool'));
add(layer(MUD.wall, [[96, 1, 145]]), layer('minecraft:bell[attachment=floor,facing=north]', [[96, 2, 145]]));
for (const [x, z] of [[83, 144], [97, 158], [83, 158]]) add(palm(x, 1, z, pick([6, 7])));

// ------------------------------------------------------------------------------------------------------ lights

/**
 * A light block on a grid over the area: in each column the topmost block is replaced when it is plain floor, roof or
 * ground (or the soil under a crop or flower, which is removed); nothing else is touched. A grid point that fails
 * tries its 8 neighbours. Returns the layers to append.
 */
function surfaceLights([ax0, az0, ax1, az1], every, off = 5) {
    const { layers } = resolve(plan, { finalize: false });
    const id = new Map(), top = new Map();
    for (const l of layers) {
        if (isAir(l.block)) continue;
        const b = parseBlock(l.block).id;
        for (const [x, y, z] of l.points) { id.set(`${x},${y},${z}`, b); const k = `${x},${z}`; if (!(top.get(k) >= y)) top.set(k, y); }
    }
    const FULL = /^minecraft:(mud_bricks|packed_mud|smooth_sandstone|cut_sandstone|sandstone|cut_red_sandstone|lapis_block|smooth_quartz|grass_block|dirt|spruce_planks)$/;
    const PLANT = /^minecraft:(wheat|carrots|potatoes|beetroots|poppy|dandelion|cornflower|allium|azure_bluet|oxeye_daisy|lily_of_the_valley|[a-z]+_tulip)$/;
    const lights = [], cut = [];
    const tryAt = (x, z) => {
        const y = top.get(`${x},${z}`);
        if (y === undefined) { lights.push([x, 0, z]); return true; }
        const b = id.get(`${x},${y},${z}`);
        if (FULL.test(b)) { lights.push([x, y, z]); return true; }
        if (PLANT.test(b) && /^minecraft:(farmland|grass_block|dirt)$/.test(id.get(`${x},${y - 1},${z}`))) { lights.push([x, y - 1, z]); cut.push([x, y, z]); return true; }
        return false;
    };
    for (let x = ax0; x <= ax1; x++) for (let z = az0; z <= az1; z++) {
        if (((x - off) % every + every) % every || ((z - off) % every + every) % every) continue;
        [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].some(([dx, dz]) => tryAt(x + dx, z + dz));
    }
    return concat(layer(AIR, cut), layer(GLOW, lights));
}
add(surfaceLights([-2, -2, S + 2, S + 2], LE));

// ------------------------------------------------------------------------------------------------------ proofs

zones.push({ name: 'city (market)', start: [80, 1, 143], bounds: [3, -3, 3, S - 3, 80, S - 3] });
zones.push({ name: 'city (a house)', start: firstHomes[0], bounds: [3, -3, 3, S - 3, 80, S - 3] });

/** From every zone's start a villager and a 1-high walker must stay inside its bounds; zombies from `outside` reach no zone. */
function prove() {
    const inside = (b, [x, y, z]) => x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5];
    const layers = resolve(plan, { finalize: false }).layers;
    let ok = true;
    for (const zn of zones) {
        const res = ['villager', 'small'].map(walker => {
            const { cells, out } = walk(layers, zn.start, { walker });
            const stray = [...cells].map(k => k.split(',').map(Number)).find(p => !inside(zn.bounds, p));
            return { walker, n: cells.size, out, stray };
        });
        const good = res.every(r => !r.out && !r.stray);
        ok &&= good;
        console.log(`  walk ${good ? 'ok  ' : 'FAIL'} ${zn.name.padEnd(20)} ${res.map(r => `${r.walker} ${r.n} cells${r.out ? `, OUT at ${r.out}` : ''}${r.stray ? `, strays to ${r.stray}` : ''}`).join(' · ')}`);
    }
    if (outside) {
        const r = [outside[0] - 8, outside[2] - 8, outside[0] + 8, outside[2] + 8];
        for (const l of layers) for (const [x, , z] of l.points) { r[0] = Math.min(r[0], x - 8); r[1] = Math.min(r[1], z - 8); r[2] = Math.max(r[2], x + 8); r[3] = Math.max(r[3], z + 8); }
        const ring = layer('minecraft:barrier', Array.from({ length: 48 }, (_, y) => rectRing(r[0], r[1], r[2], r[3], y + 1)).flat());
        for (const walker of ['zombie', 'small']) {
            const z = walk(concat(layers, ring), outside, { walker });
            const reached = zones.filter(zn => [...z.cells].some(k => inside(zn.bounds, k.split(',').map(Number))));
            const good = !z.out && !reached.length;
            ok &&= good;
            console.log(`  walk ${good ? 'ok  ' : 'FAIL'} ${`${walker} from outside`.padEnd(20)} ${z.cells.size} cells, reaches ${reached.map(x => x.name).join(', ') || 'no zone'}`);
        }
    }
    return ok;
}

// ------------------------------------------------------------------------------------------------------- build

if (slice !== undefined) console.log(sliceMap(plan, Number(slice)));
console.log(`containment proof (${creatures.length} villagers in ${nHome} houses):`);
if (!prove()) throw new Error('babylon: the containment proof failed; fix the plan before building');
await build(mobs === 'only' ? [] : plan, { label: 'babylon', ...run, anchor: ANCHOR, spawns: mobs === 'none' ? [] : creatures });
