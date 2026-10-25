import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walk } from '../lib/walk.mjs';
import { layer, concat } from '../lib/plan.mjs';
import { box, walls } from '../lib/geom.mjs';
import { door } from '../lib/components.mjs';

// A 7 × 7 pen: walls x/z 0..6 from y = 1 to `h`, the walker starts in the middle at y = 1 (on the ground).
const pen = (h, wallBlock = 'minecraft:stone') => layer(wallBlock, walls([0, 1, 0], [6, h, 6]));
const mid = [3, 1, 3];

test('walls: one block is jumped, two hold, a 1.5-high fence holds', () => {
    assert.ok(walk(pen(1), mid).out, 'a 1-high wall is a step');
    assert.equal(walk(pen(2), mid).out, null, '2 high holds a villager');
    assert.equal(walk(pen(1, 'minecraft:oak_fence'), mid).out, null, 'nothing jumps a fence');
    assert.equal(walk(pen(1, 'minecraft:mud_brick_wall'), mid).out, null, 'or a wall block');
});

test('doors: villagers open wooden ones only; players open gates too', () => {
    const withDoor = id => concat(pen(3), layer('minecraft:air', [[3, 1, 0], [3, 2, 0]]), door(id, [3, 1, 0], 'south'));
    assert.ok(walk(withDoor('minecraft:oak_door'), mid).out, 'a wooden door lets a villager out');
    assert.ok(walk(withDoor('minecraft:oak_door'), mid, { walker: 'zombie' }).out, 'and a zombie (it breaks it)');
    assert.equal(walk(withDoor('minecraft:iron_door'), mid).out, null, 'an iron door holds');
    const gate = concat(pen(3), layer('minecraft:oak_fence_gate[facing=south,open=false]', [[3, 1, 0]]), layer('minecraft:air', [[3, 2, 0]]));
    assert.equal(walk(gate, mid).out, null, 'a villager cannot open a fence gate');
    assert.ok(walk(gate, mid, { walker: 'player' }).out, 'a player can');
});

test('ladders, water and falls are walked conservatively', () => {
    const ladder = concat(pen(3), layer('minecraft:ladder[facing=north]', [[3, 1, 5], [3, 2, 5], [3, 3, 5]]));
    assert.ok(walk(ladder, mid).out, 'a ladder up the inside of a wall is a way out');
    // A pit 3 deep: water fills it to the brim, so a swimmer climbs out.
    const pit = (fill) => concat(layer('minecraft:air', box([1, -2, 1], [5, 0, 5])), fill ? layer('minecraft:water', box([1, -2, 1], [5, 0, 5])) : []);
    assert.equal(walk(pit(false), [3, -2, 3]).out, null, 'a dry pit 3 deep holds');
    assert.ok(walk(pit(true), [3, -2, 3]).out, 'a flooded one does not');
    const small = concat(pen(2), layer('minecraft:air', [[3, 1, 0]]));
    assert.equal(walk(small, mid).out, null, 'a 1 × 1 hole holds a villager');
    assert.ok(walk(small, mid, { walker: 'small' }).out, 'but not a chicken');
});

test('the way in: reachable cells include the far side of an open gate', () => {
    const yard = concat(pen(3), layer('minecraft:air', [[3, 1, 0], [3, 2, 0]]));
    const { cells, out } = walk(yard, mid);
    assert.ok(out, 'an opening is a way out');
    assert.ok(cells.has('3,1,0'), 'through the opening');
    assert.throws(() => walk(pen(2), mid, { walker: 'ghost' }), /unknown walker/);
});
