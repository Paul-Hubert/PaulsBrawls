import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseBlock, formatBlock, withProps, rotateBlock, mirrorBlock, rotatePoint, mirrorPoint, rotateDir, mirrorDir,
    dirStep, DIRS, stepDir,
} from '../lib/blockstate.mjs';

test('parse / format round trip', () => {
    const s = 'minecraft:oak_stairs[facing=east,half=top]';
    assert.deepEqual(parseBlock(s), { id: 'minecraft:oak_stairs', props: { facing: 'east', half: 'top' } });
    assert.equal(formatBlock(parseBlock(s)), s);
    assert.equal(formatBlock(parseBlock('minecraft:stone')), 'minecraft:stone');
    assert.equal(withProps('minecraft:oak_log', { axis: 'x' }), 'minecraft:oak_log[axis=x]');
    assert.equal(withProps('minecraft:oak_log[axis=y]', { axis: 'z' }), 'minecraft:oak_log[axis=z]');
    assert.throws(() => parseBlock('minecraft:oak_log[axis=y'));
});

test('rotateBlock: facing turns clockwise, four turns are identity, -1 = 3', () => {
    assert.equal(rotateBlock('minecraft:oak_stairs[facing=north,half=bottom]', 1), 'minecraft:oak_stairs[facing=east,half=bottom]');
    assert.equal(rotateBlock('minecraft:oak_stairs[facing=west]', 1), 'minecraft:oak_stairs[facing=north]');
    assert.equal(rotateBlock('minecraft:furnace[facing=south]', 2), 'minecraft:furnace[facing=north]');
    assert.equal(rotateBlock('minecraft:oak_stairs[facing=east]', -1), rotateBlock('minecraft:oak_stairs[facing=east]', 3));
    assert.equal(rotateBlock('minecraft:hopper[facing=down]', 1), 'minecraft:hopper[facing=down]');
    for (const d of DIRS) {
        const b = `minecraft:spruce_stairs[facing=${d},half=top,shape=inner_left]`;
        assert.equal(rotateBlock(rotateBlock(rotateBlock(rotateBlock(b, 1), 1), 1), 1), b);
    }
});

test('rotateBlock: log axis swaps on odd turns only; sign rotation moves 4 per turn', () => {
    assert.equal(rotateBlock('minecraft:oak_log[axis=x]', 1), 'minecraft:oak_log[axis=z]');
    assert.equal(rotateBlock('minecraft:oak_log[axis=x]', 2), 'minecraft:oak_log[axis=x]');
    assert.equal(rotateBlock('minecraft:oak_log[axis=y]', 1), 'minecraft:oak_log[axis=y]');
    assert.equal(rotateBlock('minecraft:oak_sign[rotation=0]', 1), 'minecraft:oak_sign[rotation=4]');
    assert.equal(rotateBlock('minecraft:oak_sign[rotation=14]', 1), 'minecraft:oak_sign[rotation=2]');
});

test('side properties (fences, walls) move with the turn', () => {
    assert.equal(rotateBlock('minecraft:oak_fence[north=true,east=false,south=false,west=false]', 1),
        'minecraft:oak_fence[north=false,east=true,south=false,west=false]');
    assert.equal(mirrorBlock('minecraft:cobblestone_wall[east=low,north=none,south=none,up=true,west=tall]', 'x'),
        'minecraft:cobblestone_wall[up=true,north=none,east=tall,south=none,west=low]');
});

test('mirrorBlock: flips facing on its axis, swaps stair shape, door hinge and chest halves', () => {
    assert.equal(mirrorBlock('minecraft:oak_stairs[facing=east,shape=outer_left]', 'x'), 'minecraft:oak_stairs[facing=west,shape=outer_right]');
    assert.equal(mirrorBlock('minecraft:oak_stairs[facing=north]', 'x'), 'minecraft:oak_stairs[facing=north]');
    assert.equal(mirrorBlock('minecraft:oak_stairs[facing=north]', 'z'), 'minecraft:oak_stairs[facing=south]');
    assert.equal(mirrorBlock('minecraft:oak_door[facing=north,hinge=left,half=lower]', 'x'), 'minecraft:oak_door[facing=north,hinge=right,half=lower]');
    assert.equal(mirrorBlock('minecraft:chest[facing=north,type=left]', 'x'), 'minecraft:chest[facing=north,type=right]');
    assert.equal(mirrorBlock('minecraft:oak_log[axis=x]', 'x'), 'minecraft:oak_log[axis=x]');
    assert.equal(mirrorBlock('minecraft:oak_sign[rotation=4]', 'x'), 'minecraft:oak_sign[rotation=12]');
    assert.equal(mirrorBlock('minecraft:oak_sign[rotation=0]', 'z'), 'minecraft:oak_sign[rotation=8]');
    assert.equal(mirrorBlock('minecraft:oak_sign[rotation=4]', 'z'), 'minecraft:oak_sign[rotation=4]');
});

test('rail shapes stay valid names', () => {
    assert.equal(rotateBlock('minecraft:rail[shape=north_south]', 1), 'minecraft:rail[shape=east_west]');
    assert.equal(rotateBlock('minecraft:rail[shape=east_west]', 1), 'minecraft:rail[shape=north_south]');
    assert.equal(rotateBlock('minecraft:rail[shape=south_east]', 1), 'minecraft:rail[shape=south_west]');
    assert.equal(rotateBlock('minecraft:rail[shape=north_east]', 1), 'minecraft:rail[shape=south_east]');
    assert.equal(rotateBlock('minecraft:rail[shape=ascending_north]', 1), 'minecraft:rail[shape=ascending_east]');
    assert.equal(mirrorBlock('minecraft:rail[shape=north_west]', 'x'), 'minecraft:rail[shape=north_east]');
});

// The property everything else rests on: the block's direction and the points turn the SAME way.
test('points and directions rotate and mirror consistently', () => {
    const add = (p, d) => { const [dx, dz] = dirStep(d); return [p[0] + dx, p[1], p[2] + dz]; };
    const p = [3, 7, -2];
    for (const d of DIRS) {
        for (let t = -2; t <= 5; t++) assert.deepEqual(rotatePoint(add(p, d), t), add(rotatePoint(p, t), rotateDir(d, t)), `turn ${t} ${d}`);
        for (const ax of ['x', 'z']) assert.deepEqual(mirrorPoint(add(p, d), ax), add(mirrorPoint(p, ax), mirrorDir(d, ax)), `mirror ${ax} ${d}`);
    }
    assert.deepEqual(rotatePoint([1, 0, 0], 1), [0, 0, 1], 'east turns to south');
    assert.equal(stepDir(0, -3), 'north');
    assert.equal(stepDir(2, 1), 'east');
});
