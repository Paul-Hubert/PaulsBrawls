import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tower, squareTower, wall, gatehouse, house, bridge, stairsBetween, earthworks, castle, door } from '../lib/components.mjs';
import { resolve, stats, rotate, mirror, isAir } from '../lib/plan.mjs';
import { parseBlock, dirStep, rotateDir, DIRS } from '../lib/blockstate.mjs';
import { palette, PALETTES } from '../lib/palettes.mjs';

const K = p => p.join(',');
const world = plan => new Map(resolve(plan).layers.flatMap(l => l.points.map(p => [K(p), l.block])));
const solid = b => !!b && !isAir(b) && !/(torch|lantern|ladder|_door|_stairs|_slab|_fence|_wall$)/.test(parseBlock(b).id);
const add = (p, d, dy = 0) => { const [dx, dz] = dirStep(d); return [p[0] + dx, p[1] + dy, p[2] + dz]; };

/** Every attachment in the plan has what it hangs on or stands on (in the plan itself). */
function assertSupported(plan, name) {
    const w = world(plan);
    for (const [k, b] of w) {
        const { id, props } = parseBlock(b);
        const p = k.split(',').map(Number);
        const at = q => w.get(K(q));
        if (id === 'minecraft:wall_torch' || id === 'minecraft:ladder') {
            assert.ok(solid(at(add(p, rotateDir(props.facing, 2)))), `${name}: ${b} at ${k} hangs on nothing`);
        } else if (/lantern$/.test(id) && props.hanging === 'true') {
            assert.ok(at([p[0], p[1] + 1, p[2]]), `${name}: hanging lantern at ${k} under nothing`);
        } else if (/lantern$/.test(id) || id === 'minecraft:torch') {
            const below = at([p[0], p[1] - 1, p[2]]);
            assert.ok(below && !isAir(below), `${name}: ${b} at ${k} stands on nothing`);
        } else if (id.endsWith('_door')) {
            const other = at([p[0], p[1] + (props.half === 'lower' ? 1 : -1), p[2]]);
            assert.ok(other && parseBlock(other).id === id, `${name}: door half at ${k} has no other half`);
            if (props.half === 'lower') assert.ok(solid(at([p[0], p[1] - 1, p[2]])), `${name}: door at ${k} stands on nothing`);
        }
    }
}

/**
 * Every bottom stair faces up its slope: the cell ahead and one up is roof/deck, or the cell ahead is a block at the same
 * level (a terrace, two top rows meeting, the ridge, the landing). A stair turned 180° faces open air.
 */
function assertStairsClimb(plan, name, idPattern) {
    const w = world(plan);
    for (const [k, b] of w) {
        const { id, props } = parseBlock(b);
        if (!idPattern.test(id) || props.half !== 'bottom') continue;
        const p = k.split(',').map(Number);
        const ahead = w.get(K(add(p, props.facing))), up = w.get(K(add(p, props.facing, 1)));
        const level = ahead && !isAir(ahead); // a stair, a slab (ridge) or the landing at the top of a flight
        assert.ok((up && !isAir(up)) || level, `${name}: ${b} at ${k} faces nothing to climb`);
    }
}

test('tower: spiral by default, ladder when narrow, openings are air, everything supported', () => {
    const t = tower({ radius: 3, height: 12, openings: [{ side: 'east', y: 7 }, { side: 'south', door: true }], landings: [6] });
    const w = world(t);
    assert.ok(isAir(w.get('3,7,0')) && isAir(w.get('3,8,0')), 'east opening');
    assert.match(w.get('0,1,3'), /_door\[.*facing=north/, 'the door faces into the tower');
    assert.ok([...w.values()].some(b => /spruce_stairs/.test(b)), 'spiral stairs');
    assertSupported(t, 'tower r3');
    const narrow = tower({ radius: 2, height: 8, openings: [{ side: 'west' }] });
    const ladders = [...world(narrow)].filter(([, b]) => /ladder/.test(b));
    assert.equal(ladders.length, 8, 'ladder from y=1 to the top platform');
    assert.ok(ladders.every(([k]) => k.startsWith('0,') && k.endsWith(',-1')), 'ladder avoids the west opening (north side)');
    assertSupported(narrow, 'tower r2');
    assert.throws(() => tower({ radius: 2, stairs: 'spiral' }), /radius >= 3/);
    for (const roof of ['flat', 'cone', 'dome', 'none']) assertSupported(tower({ roof }), `tower ${roof}`);
});

test('tower spiral climbs to the top platform with headroom', () => {
    const h = 12, w = world(tower({ radius: 3, height: h, lights: false }));
    const steps = [...w].filter(([, b]) => /spruce_stairs/.test(b)).map(([k, b]) => [k.split(',').map(Number), parseBlock(b).props.facing]);
    assert.equal(steps.length, h, 'one step per level, 1..height');
    for (const [p, f] of steps) {
        if (p[1] === h) continue;
        const next = w.get(K(add(p, f, 1)));
        assert.match(next, /_stairs/, `the step at ${p} leads to the next one`);
        for (const dy of [1, 2]) assert.ok(!w.get(K([p[0], p[1] + dy, p[2]])) || isAir(w.get(K([p[0], p[1] + dy, p[2]]))), `headroom over ${p}`);
    }
});

test('wall: any axis direction, crenellations on the outer side', () => {
    for (const [from, to, outer] of [[[0, 0], [10, 0], 'north'], [[0, 0], [0, 10], 'east'], [[10, 0], [0, 0], 'south'], [[0, 10], [0, 0], 'west']]) {
        const w = world(wall({ from, to, height: 5, thickness: 3, crenellations: 'outer', outer }));
        const merlons = [...w.keys()].map(k => k.split(',').map(Number)).filter(p => p[1] === 6);
        assert.ok(merlons.length > 0);
        const [dx, dz] = dirStep(outer);
        assert.ok(merlons.every(([x, , z]) => (dx ? x * dx : z * dz) === 1), `merlons on the ${outer} face`);
        assertSupported(wall({ from, to, crenellations: 'outer', outer }), `wall ${outer}`);
    }
    assert.throws(() => wall({ from: [0, 0], to: [5, 5] }), /axis-aligned/);
    assert.throws(() => wall({ from: [0, 0], to: [5, 0], crenellations: 'outer', outer: 'east' }), /not across/);
});

test('house: footprint stays 0..w-1 x 0..d-1 and the door is on the asked side, for every side and roof', () => {
    for (const side of DIRS) for (const roof of ['gable', 'hip']) {
        const p = house({ w: 7, d: 9, floors: 2, door: side, roof });
        const w = world(p);
        const posts = [...w].filter(([, b]) => /oak_log\[axis=y\]/.test(b)).map(([k]) => k.split(',').map(Number));
        const xs = posts.map(q => q[0]), zs = posts.map(q => q[2]);
        assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)], [0, 6, 0, 8], `${side} ${roof} footprint`);
        const [k, b] = [...w].find(([, bb]) => /oak_door.*half=lower/.test(bb));
        const q = k.split(',').map(Number);
        const onSide = { north: q[2] === 0, south: q[2] === 8, west: q[0] === 0, east: q[0] === 6 }[side];
        assert.ok(onSide, `door at ${k} on the ${side} wall`);
        assert.equal(parseBlock(b).props.facing, rotateDir(side, 2), 'the door faces in');
        assertSupported(p, `house ${side} ${roof}`);
        assertStairsClimb(p, `house ${side} ${roof}`, /spruce_stairs/);
        // Beams lie along their wall: an x-axis log has x-axis or corner neighbours along x.
        for (const [kk, bb] of w) if (/oak_log\[axis=x\]/.test(bb)) {
            const [x, y, z] = kk.split(',').map(Number);
            assert.ok(/oak_log/.test(w.get(K([x + 1, y, z])) || '') || /oak_log/.test(w.get(K([x - 1, y, z])) || ''), `beam at ${kk} runs along x`);
        }
    }
});

test('house roofs face up the slope (roof stairs point inward to the ridge)', () => {
    const w = world(house({ w: 7, d: 9 }));
    // Ridge along z (d > w): the west slope faces east, the east slope faces west.
    assert.match(w.get('-1,5,4'), /facing=east/);
    assert.match(w.get('7,5,4'), /facing=west/);
    assert.match(w.get('-1,4,4'), /facing=east.*half=top|half=top.*facing=east/, 'eave');
});

test('gatehouse: an open passage through, a portcullis up high, supported details', () => {
    const g = gatehouse({ width: 3, height: 4, depth: 7 });
    const w = world(g);
    for (let z = 0; z < 7; z++) for (const y of [1, 2]) assert.ok(isAir(w.get(K([0, y, z]))), `passage open at y=${y} z=${z}`);
    assert.match(w.get('0,4,1'), /iron_bars/);
    assertSupported(g, 'gatehouse');
    assert.throws(() => gatehouse({ width: 4 }), /odd/);
});

test('bridge and stairsBetween climb one block per block, either direction', () => {
    const b = bridge({ length: 13, rise: 3 });
    assertStairsClimb(b, 'bridge', /_stairs/);
    assertSupported(b, 'bridge');
    const up = world(stairsBetween([0, 0, 0], [6, 4, 0]));
    const down = world(stairsBetween([6, 4, 0], [0, 0, 0]));
    assert.deepEqual([...up].sort(), [...down].sort(), 'a flight is the same whichever end comes first');
    assert.ok([...up].filter(([, v]) => /_stairs/.test(v)).every(([, v]) => /facing=east/.test(v)));
    assert.throws(() => stairsBetween([0, 0, 0], [2, 5, 0]), /run/);
});

test('castle: composes, every detail is supported, the demo stays small', () => {
    const c = castle({ size: 18, towerHeight: 10, wallHeight: 7 });
    assertSupported(c, 'castle');
    const s = stats(c);
    assert.ok(s.solid < 3200, `${s.solid} blocks`);
    const w = world(c);
    for (let z = -3; z <= 4; z++) assert.ok(!w.get(K([9, 1, z])) || isAir(w.get(K([9, 1, z]))), `the gate is open at z=${z}`);
    assert.throws(() => castle({ size: 12 }), /too small/);
});

test('components survive rotation and mirroring with their details supported', () => {
    const c = castle({ size: 18, towerHeight: 10, wallHeight: 7 });
    assertSupported(rotate(c, 1), 'castle turned');
    assertSupported(mirror(c, 'x'), 'castle mirrored');
    assertSupported(mirror(house({ door: 'east' }), 'z'), 'house mirrored');
});

test('palettes: presets are complete, overrides apply, typos are refused', () => {
    for (const [name, p] of Object.entries(PALETTES)) assert.deepEqual(Object.keys(palette(name)).sort(), Object.keys(PALETTES.stoneCastle).sort(), name);
    assert.equal(palette('oakCottage', { roof: 'minecraft:bricks' }).roof, 'minecraft:bricks');
    assert.throws(() => palette('stoneCastle', { rooof: 'x' }), /Unknown palette role/);
    assert.throws(() => palette('nope'), /Unknown palette/);
    const t = world(tower({ palette: palette('deepslate') }));
    assert.ok([...t.values()].some(b => b === 'minecraft:deepslate_bricks'));
    assert.deepEqual(door('minecraft:oak_door', [0, 1, 0], 'south').map(l => l.block),
        ['minecraft:oak_door[facing=south,half=lower,hinge=left]', 'minecraft:oak_door[facing=south,half=upper,hinge=left]']);
});

test('squareTower: hollow storeys, 1×1 slits, a ladder through every floor, openings and a door, all supported', () => {
    const t = squareTower({ w: 7, d: 9, height: 17, floors: [6, 11], ladder: 'north',
        openings: [{ side: 'west', y: 12, width: 3, at: 6 }, { side: 'south', door: true }] });
    const w = world(t);
    assert.equal(w.get('3,6,4'), 'minecraft:spruce_planks', 'a floor at 6');
    assert.ok(!w.get('3,3,4'), 'hollow below it');
    for (const fy of [0, 6, 11]) {
        assert.ok(isAir(w.get(K([2, fy + 2, 0]))), `slit at y=${fy + 2}`);
        assert.ok(!isAir(w.get(K([2, fy + 3, 0]))) && !isAir(w.get(K([2, fy + 1, 0]))), 'a slit is one block tall');
    }
    const ladders = [...w].filter(([, b]) => /ladder/.test(b)).map(([k]) => k.split(',').map(Number));
    assert.equal(ladders.length, 17, 'ladder from y=1 through the floors to the roof deck');
    assert.ok(ladders.every(([x, , z]) => x === 5 && z === 1));
    for (const z of [5, 6, 7]) for (const y of [12, 13]) assert.ok(isAir(w.get(K([0, y, z]))), `west opening at z=${z} y=${y}`);
    assert.match(w.get('3,1,8'), /spruce_door\[.*facing=north/, 'the door faces in');
    assert.match(w.get('-1,18,-1'), /stone_bricks/, 'the parapet stands on the overhang');
    assertSupported(t, 'squareTower');
    assertSupported(rotate(t, 1), 'squareTower turned');
    assert.throws(() => squareTower({ height: 10, floors: [8] }), /height - 3/);
    assert.throws(() => squareTower({ ladder: 'up' }), /ladder side/);
});

test('earthworks: a glacis falling away from the faces, a berm, then the moat; clear areas stay bare', () => {
    const e = earthworks({ x0: 0, z0: 0, x1: 20, z1: 20, glacisHeight: 4, glacisRun: 8, berm: 3, moatWidth: 2, moatDepth: 3, clear: [[5, -8, 9, -1]] });
    const w = world(e);
    const top = (x, z) => { let y = 0; while (w.get(K([x, y + 1, z]))) y++; return y; };
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(d => top(12, -d)), [4, 4, 3, 3, 2, 2, 1, 1], 'two blocks per level, down to the berm');
    assert.equal(top(12, -9), 0, 'the berm is bare');
    assert.equal(top(7, -2), 0, 'cleared');
    for (const y of [0, -1, -2]) assert.equal(w.get(K([12, y, -12])), 'minecraft:water', `moat at y=${y}`);
    assert.ok(!w.get('12,-3,-12') && !w.get('12,0,-14'), 'three deep, two wide');
    assert.ok(!w.get('10,1,10') && !w.get('10,0,10'), 'nothing inside the ring');
    assert.equal(w.get('-12,0,-12'), 'minecraft:water', 'square corners');
});

test('wall overhang and the flat house roof', () => {
    const w = world(wall({ from: [0, 0], to: [10, 0], height: 6, thickness: 3, crenellations: 'outer', outer: 'north', overhang: true }));
    for (let x = 0; x <= 10; x++) assert.equal(w.get(K([x, 5, -2])), 'minecraft:polished_andesite', `lip at x=${x}`);
    assert.ok(!w.get('5,5,2'), 'no lip on the inner face');
    const h = house({ w: 7, d: 9, floorHeight: 4, roof: 'flat', palette: 'bronzeAge' });
    const hw = world(h);
    for (const [x, z] of [[0, 0], [6, 8], [3, 4]]) assert.equal(hw.get(K([x, 5, z])), 'minecraft:packed_mud', `roof deck at ${x},${z}`);
    assert.match(hw.get('0,6,0'), /mud_brick_wall/, 'parapet');
    assert.ok(!hw.get('3,6,4'), 'the deck is open inside the parapet');
    assert.ok(isAir(hw.get('2,2,8')), 'bronzeAge windows are open');
    assertSupported(h, 'flat house');
});
