import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layer, concat, translate, rotate, mirror, placeAt, resolve, stats, swapBlocks } from '../lib/plan.mjs';
import { hipRoof, gableRoof, line } from '../lib/geom.mjs';
import { withProps } from '../lib/blockstate.mjs';

/** A resolved plan as a sorted list of "x,y,z=block" (order-free, for comparing layouts). */
export const layout = plan => resolve(plan).layers.flatMap(l => l.points.map(p => `${p.join(',')}=${l.block}`)).sort();

const stairsOf = (cells, id = 'minecraft:oak_stairs') => cells.map(({ p, dir }) => ({ block: withProps(id, { facing: dir, half: 'bottom' }), points: [p] }));

test('resolve: the last write wins, passes are air, structure, attachments', () => {
    const plan = concat(
        layer('minecraft:torch', [[0, 2, 0]]),
        layer('minecraft:stone', [[0, 0, 0], [0, 1, 0], [1, 0, 0]]),
        layer('minecraft:air', [[0, 1, 0]]),
        layer('minecraft:oak_planks', [[1, 0, 0]]),
    );
    const r = resolve(plan);
    assert.equal(r.total, 4);
    assert.deepEqual(r.layers.map(l => [l.block, l.pass, l.points.length]), [
        ['minecraft:air', 0, 1], ['minecraft:stone', 1, 1], ['minecraft:oak_planks', 1, 1], ['minecraft:torch', 2, 1],
    ]);
    const s = stats(plan);
    assert.equal(s.solid, 3);
    assert.equal(s.air, 1);
    assert.deepEqual(s.bbox.size, [2, 3, 1]);
});

test('resolve sorts each structure layer bottom-up (sand and gravel need it)', () => {
    const r = resolve(layer('minecraft:sand', [[0, 5, 0], [0, 1, 0], [0, 3, 0]]));
    assert.deepEqual(r.layers[0].points.map(p => p[1]), [1, 3, 5]);
});

test('rotate four times / mirror twice is identity; translate moves', () => {
    const roof = gableRoof({ x0: 0, z0: 0, x1: 5, z1: 7, base: 4 });
    const plan = concat(stairsOf(roof.slope), layer('minecraft:oak_log[axis=x]', line([0, 3, 0], [5, 3, 0])));
    assert.deepEqual(layout(rotate(rotate(rotate(rotate(plan, 1), 1), 1), 1)), layout(plan));
    assert.deepEqual(layout(mirror(mirror(plan, 'x'), 'x')), layout(plan));
    assert.deepEqual(layout(rotate(plan, 2)), layout(mirror(mirror(plan, 'x'), 'z')), 'a half turn = both mirrors');
    assert.deepEqual(translate(layer('minecraft:stone', [[1, 2, 3]]), 1, 1, 1)[0].points, [[2, 3, 4]]);
    assert.deepEqual(placeAt(layer('minecraft:oak_stairs[facing=north]', [[1, 0, 0]]), { at: [10, 0, 10], turns: 1 }),
        [{ block: 'minecraft:oak_stairs[facing=east]', points: [[10, 0, 11]] }]);
    assert.equal(swapBlocks(layer('minecraft:oak_stairs[facing=north]', [[0, 0, 0]]), { 'minecraft:oak_stairs': 'minecraft:spruce_stairs' })[0].block,
        'minecraft:spruce_stairs[facing=north]');
});

test('finalize: hip roof corners get outer shapes', () => {
    const h = hipRoof({ x0: 0, z0: 0, x1: 4, z1: 4, base: 0, overhang: 0 });
    const r = resolve(stairsOf(h.slope));
    const at = new Map(r.layers.flatMap(l => l.points.map(p => [p.join(','), l.block])));
    for (const corner of ['0,0,0', '4,0,0', '0,0,4', '4,0,4']) assert.match(at.get(corner), /shape=outer_(left|right)/, corner);
    assert.doesNotMatch(at.get('2,0,0'), /shape=/, 'the middle of an edge stays straight');
});

test('finalize: an inner corner (L-shaped stairs)', () => {
    const plan = concat(
        layer('minecraft:oak_stairs[facing=north]', [[0, 0, 0], [1, 0, 0]]),
        layer('minecraft:oak_stairs[facing=west]', [[0, 0, 1]]),
    );
    const at = new Map(resolve(plan).layers.flatMap(l => l.points.map(p => [p.join(','), l.block])));
    assert.match(at.get('0,0,0'), /shape=(inner|outer)_/);
});

test('finalize commutes with rotation and mirroring (shapes are recomputed consistently)', () => {
    const h = hipRoof({ x0: 0, z0: 0, x1: 6, z1: 4, base: 0 });
    const plan = stairsOf(h.slope);
    const fin = p => resolve(p).layers.map(l => ({ block: l.block, points: l.points }));
    for (const t of [1, 2, 3]) assert.deepEqual(layout(fin(rotate(plan, t))), layout(rotate(fin(plan), t)), `turn ${t}`);
    for (const ax of ['x', 'z']) assert.deepEqual(layout(fin(mirror(plan, ax))), layout(mirror(fin(plan), ax)), `mirror ${ax}`);
});

test('finalize: fences and walls connect to each other and to solid blocks', () => {
    const plan = concat(
        layer('minecraft:stone', [[0, 0, 0]]),
        layer('minecraft:oak_fence', [[1, 0, 0], [2, 0, 0], [2, 0, 1]]),
        layer('minecraft:cobblestone_wall', [[5, 0, 0], [6, 0, 0], [7, 0, 0]]),
        layer('minecraft:lantern', [[7, 1, 0]]),
    );
    const at = new Map(resolve(plan).layers.flatMap(l => l.points.map(p => [p.join(','), l.block])));
    assert.equal(at.get('1,0,0'), 'minecraft:oak_fence[north=false,east=true,south=false,west=true]');
    assert.equal(at.get('2,0,0'), 'minecraft:oak_fence[north=false,east=false,south=true,west=true]');
    assert.equal(at.get('6,0,0'), 'minecraft:cobblestone_wall[north=none,east=low,south=none,west=low,up=false]');
    assert.equal(at.get('7,0,0'), 'minecraft:cobblestone_wall[north=none,east=none,south=none,west=low,up=true]');
});
