import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, summary, cliOptions, sliceMap } from '../lib/build.mjs';
import { layer, concat } from '../lib/plan.mjs';
import { box } from '../lib/geom.mjs';

/** A stand-in for open(): records every call, answers like the server ("N bloc(s) … placé(s)."). */
function fakeClient({ busyTimes = 0, failOn = null } = {}) {
    const calls = [], open = new Set();
    let n = 0, busy = busyTimes;
    return {
        calls, open, pivot: { x: 100, y: 64, z: -20 },
        async begin(label, ax, ay, az) {
            if (busy-- > 0) throw new Error('begin_sub_build: Sous-construction refusée : 4 tournent déjà sur le serveur.');
            const id = `sb-${++n}`;
            open.add(id);
            calls.push(['begin', label, [ax, ay, az]]);
            return {
                id,
                async placeRaw(block, points) {
                    assert.ok(open.has(id), 'placing into a closed sub-build');
                    assert.ok(points.length <= 128, `${points.length} points in one call`);
                    if (failOn && block === failOn) throw new Error(`place_blocks: Bloc inconnu ou mal formé : '${block}'.`);
                    calls.push(['place', label, block, points.length]);
                    return `${points.length} bloc(s) ${block} placé(s).`;
                },
                async end() { open.delete(id); calls.push(['end', label]); },
            };
        },
    };
}

const quiet = () => {};
const sample = () => concat(
    layer('minecraft:wall_torch[facing=north]', [[0, 2, -1]]),
    layer('minecraft:stone_bricks', box([0, 0, 0], [19, 4, 9])),
    layer('minecraft:air', [[5, 1, 0], [5, 2, 0]]),
);

test('dry run: no client, a summary with counts and bounding box', async () => {
    const lines = [];
    const r = await build(sample(), { label: 'test', anchor: [1, 2, 3], log: l => lines.push(l), client: { begin() { throw new Error('no'); } } });
    assert.equal(r.summary.stats.total, 1001);
    assert.match(lines.join('\n'), /998  minecraft:stone_bricks/);
    assert.match(lines.join('\n'), /x 0\.\.19, y 0\.\.4, z -1\.\.9/);
    assert.match(summary(sample()).text, /1001 positions \(999 blocks \+ 2 air\)/);
});

test('live: ≤128 per call, structure then attachments in their own sub-build, all ended', async () => {
    const c = fakeClient();
    const r = await build(sample(), { label: 'test', anchor: [0, 1, 0], live: true, client: c, log: quiet });
    assert.equal(r.confirmed, 1001);
    assert.deepEqual(r.anchorAbs, [100, 65, -20]);
    assert.equal(c.open.size, 0, 'every sub-build ended');
    const places = c.calls.filter(x => x[0] === 'place');
    assert.equal(places[0][2], 'minecraft:air', 'air first');
    assert.equal(places.at(-1)[2], 'minecraft:wall_torch[facing=north]', 'the torch last');
    assert.equal(places.at(-1)[1], 'test:details', 'in its own sub-build, after the structure one ended');
    const endStructure = c.calls.findIndex(x => x[0] === 'end' && x[1] === 'test');
    assert.ok(endStructure < c.calls.findIndex(x => x[0] === 'begin' && x[1] === 'test:details'));
});

test('live: parallel regions, each ended; a refusal still ends every sub-build and surfaces', async () => {
    const c = fakeClient();
    await build(sample(), { label: 'p', live: true, parallel: 3, client: c, log: quiet });
    assert.equal(c.calls.filter(x => x[0] === 'begin').length, 4, '3 regions + details');
    assert.equal(c.open.size, 0);
    const bad = fakeClient({ failOn: 'minecraft:stone_bricks' });
    await assert.rejects(build(sample(), { label: 'x', live: true, parallel: 2, client: bad, log: quiet }), /Bloc inconnu/);
    assert.equal(bad.open.size, 0, 'ended in finally');
    assert.ok(!bad.calls.some(x => x[1] === 'x:details'), 'no attachments after a failed structure');
});

test('live: over the guard without yes is refused before any call; busy slots are retried', async () => {
    const big = layer('minecraft:stone', box([0, 0, 0], [20, 20, 20]));
    const c = fakeClient();
    await assert.rejects(build(big, { live: true, client: c, log: quiet }), /--yes/);
    assert.equal(c.calls.length, 0);
    const busy = fakeClient({ busyTimes: 2 });
    const r = await build(sample(), { live: true, client: busy, retryMs: 1, log: quiet });
    assert.equal(r.confirmed, 1001);
    const never = fakeClient({ busyTimes: 1e9 });
    await assert.rejects(build(sample(), { live: true, client: never, retryMs: 1, waitSlotsMs: 20, log: quiet }), /tournent déjà/);
});

test('cliOptions and sliceMap', () => {
    assert.deepEqual(cliOptions(['--build', '--yes', '--anchor=1,-2,3', '--parallel=2', '--size=20', '--roof=cone', '--turrets=false']),
        { live: true, yes: true, parallel: 2, anchor: [1, -2, 3], params: { size: 20, roof: 'cone', turrets: false } });
    assert.throws(() => cliOptions(['--anchor=1,2']), /x,y,z/);
    assert.throws(() => cliOptions(['oops']), /Unknown argument/);
    const m = sliceMap(concat(layer('minecraft:stone', [[0, 0, 0], [1, 0, 0]]), layer('minecraft:oak_stairs[facing=east]', [[0, 0, 1]])), 0);
    assert.match(m, /\n##\n>\./);
});

test('sliceMap and a parallel live build handle plans over 150 000 positions', async () => {
    const big = layer('minecraft:stone', box([0, 0, 0], [449, 0, 449])); // 202 500 positions
    assert.match(sliceMap(big, 0).split('\n')[0], /x 0\.\.449/);
    const r = await build(big, { live: true, yes: true, parallel: 4, client: fakeClient(), log: () => {} });
    assert.equal(r.confirmed, 202500);
});
