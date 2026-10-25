import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    line, box, hollowBox, walls, frame, disc, ring, cylinder, sphere, sphereShell, dome, archOpening, archRing,
    extrude, spiralSquare, gableRoof, hipRoof, coneRoof, bbox, uniq, subtract, helix,
} from '../lib/geom.mjs';
import { dirStep } from '../lib/blockstate.mjs';

const K = p => p.join(',');
const set = pts => new Set(pts.map(K));

test('line: both ends, one block per step, no duplicates', () => {
    const l = line([0, 0, 0], [5, 2, -3]);
    assert.equal(l.length, 6);
    assert.deepEqual(l[0], [0, 0, 0]);
    assert.deepEqual(l.at(-1), [5, 2, -3]);
    assert.equal(set(l).size, l.length);
    assert.deepEqual(line([1, 2, 3], [1, 2, 3]), [[1, 2, 3]]);
});

test('box / hollowBox / walls / frame counts', () => {
    assert.equal(box([0, 0, 0], [3, 2, 4]).length, 4 * 3 * 5);
    assert.equal(box([3, 2, 4], [0, 0, 0]).length, 60, 'corner order does not matter');
    assert.equal(hollowBox([0, 0, 0], [4, 4, 4]).length, 125 - 27);
    const w = walls([0, 0, 0], [4, 2, 6]);
    assert.equal(w.length, 3 * (2 * 5 + 2 * 5)); // perimeter of 5x7 is 20, three high
    assert.ok(w.every(([x, , z]) => x === 0 || x === 4 || z === 0 || z === 6));
    assert.equal(frame([0, 0, 0], [2, 2, 2]).length, 20);
});

test('disc / ring / cylinder: centred, symmetric, ring = disc minus the inner disc', () => {
    assert.deepEqual(disc(5, 1, 5, 0), [[5, 1, 5]]);
    const d = disc(0, 0, 0, 3);
    const s = set(d);
    for (const [x, y, z] of d) for (const q of [[-x, y, z], [x, y, -z], [z, y, x]]) assert.ok(s.has(K(q)), `symmetric ${q}`);
    assert.equal(bbox(d).size[0], 7);
    const r = ring(0, 0, 0, 3);
    assert.equal(r.length, d.length - disc(0, 0, 0, 2).length);
    assert.equal(cylinder(0, 0, 3, 1, 5, { hollow: true }).length, r.length * 5);
    assert.equal(cylinder(0, 0, 3, 1, 5).length, d.length * 5);
});

test('ring is closed: every ring cell has at least two ring neighbours (8-connected)', () => {
    for (const rad of [2, 3, 5, 8]) {
        const r = ring(0, 0, 0, rad), s = set(r);
        for (const [x, , z] of r) {
            let n = 0;
            for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if ((dx || dz) && s.has(K([x + dx, 0, z + dz]))) n++;
            assert.ok(n >= 2, `radius ${rad}: (${x},${z}) has ${n} neighbours`);
        }
    }
});

test('sphere / sphereShell / dome', () => {
    const ball = sphere([0, 0, 0], 4), shell = sphereShell([0, 0, 0], 4);
    const b = set(ball);
    assert.ok(shell.every(p => b.has(K(p))), 'shell is part of the ball');
    assert.ok(!set(shell).has('0,0,0'), 'shell is hollow');
    assert.ok(shell.length < ball.length);
    const dm = dome([10, 5, 10], 4);
    assert.ok(dm.every(p => p[1] >= 5));
    assert.equal(bbox(dm).size[1], 5);
    // Watertight: no cell inside the shell sees the outside through a face.
    const inside = subtract(ball, shell), sh = set(shell);
    for (const [x, y, z] of inside) for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const q = K([x + dx, y + dy, z + dz]);
        assert.ok(b.has(q) || sh.has(q), `leak at ${q}`);
    }
});

test('archOpening: straight sides then a round top, symmetric', () => {
    const a = archOpening(5, 5);
    const rows = {};
    for (const [u, v] of a) (rows[v] ||= []).push(u);
    assert.equal(rows[0].length, 5);
    assert.equal(rows[4].length, 3);
    for (const [u, v] of a) assert.ok(set(a.map(([x, y]) => [x, y])).has(K([4 - u, v])), 'mirror-symmetric');
    const ring2 = archRing(5, 5, 1), inner = set(a);
    assert.ok(ring2.every(c => !inner.has(K(c))), 'the ring does not fill the opening');
    assert.ok(set(ring2).has('-1,0') && set(ring2).has('5,0') && set(ring2).has('2,5'), 'sides and keystone');
    assert.deepEqual(extrude([[1, 2]], 'x', 2), [[1, 2, 0], [1, 2, 1]]);
    assert.deepEqual(extrude([[1, 2]], 'z', 1), [[0, 2, 1]]);
});

test('spiralSquare: each step is one block from the next, one higher, facing it', () => {
    const s = spiralSquare(0, 0, 1, 1, 20);
    assert.equal(s.length, 20);
    for (let i = 0; i + 1 < s.length; i++) {
        const [dx, dz] = dirStep(s[i].dir);
        assert.deepEqual([s[i].p[0] + dx, s[i].p[1] + 1, s[i].p[2] + dz], s[i + 1].p, `step ${i}`);
    }
    assert.ok(s.every(({ p }) => Math.max(Math.abs(p[0]), Math.abs(p[2])) === 1), 'around the centre post');
    assert.equal(set(s.slice(0, 8).map(({ p }) => [p[0], 0, p[2]])).size, 8, 'one loop visits 8 cells');
});

test('helix stays on its radius and climbs', () => {
    const h = helix(0, 0, 5, 0, 2);
    assert.ok(h.every(([x, , z]) => Math.abs(Math.hypot(x, z) - 5) < 1));
    assert.equal(h.at(-1)[1], 16);
});

function climbsToRidge(slope, top) {
    const at = new Map(slope.map(s => [K(s.p), s]));
    for (const { p, dir } of slope) {
        const [dx, dz] = dirStep(dir);
        const up = K([p[0] + dx, p[1] + 1, p[2] + dz]), level = at.get(K([p[0] + dx, p[1], p[2] + dz]));
        assert.ok(at.has(up) || top.has(up) || (level && level.dir !== dir), `stair at ${p} facing ${dir} does not face up the slope`);
    }
}

test('gableRoof: stairs face the ridge, odd span gets a ridge row, gables stay inside the walls', () => {
    for (const ridge of ['x', 'z']) for (const [x1, z1] of [[6, 8], [7, 6]]) {
        const g = gableRoof({ x0: 0, z0: 0, x1, z1, base: 5, ridge, overhang: 1 });
        climbsToRidge(g.slope, set(g.ridge));
        const span = (ridge === 'x' ? z1 : x1) + 1 + 2;
        assert.equal(g.ridge.length > 0, span % 2 === 1, `ridge row iff odd span (${ridge} ${x1}x${z1})`);
        assert.ok(g.gable.every(([x, y, z]) => x >= 0 && x <= x1 && z >= 0 && z <= z1 && y >= 5));
        assert.ok(g.eaves.every(e => e.p[1] === 4));
        const north = g.slope.filter(s => s.p[ridge === 'x' ? 2 : 0] === -1);
        assert.ok(north.every(s => s.dir === (ridge === 'x' ? 'south' : 'east')), 'the low edge faces inward');
    }
});

test('hipRoof and coneRoof stairs face inward and up', () => {
    const h = hipRoof({ x0: 0, z0: 0, x1: 6, z1: 8, base: 3 });
    climbsToRidge(h.slope, set(h.ridge));
    // A cone's rings are not one block apart on the diagonals, so a stair may face a stair of its own ring
    // (a short terrace): it must face a cell of the roof at its level or one up, closer to the axis.
    const c = coneRoof(0, 0, 4, 10);
    const roof = set([...c.slope.map(s => s.p), ...c.cap]);
    for (const { p, dir } of c.slope) {
        const [dx, dz] = dirStep(dir), q = [p[0] + dx, p[1], p[2] + dz];
        assert.ok(Math.hypot(q[0], q[2]) < Math.hypot(p[0], p[2]), `${p} faces the axis`);
        assert.ok(roof.has(K(q)) || roof.has(K([q[0], q[1] + 1, q[2]])), `${p} faces the roof`);
    }
    assert.deepEqual(c.cap[0], [0, 13, 0]);
});

test('bbox / uniq / subtract', () => {
    assert.deepEqual(bbox([[1, 2, 3], [-1, 5, 0]]), { min: [-1, 2, 0], max: [1, 5, 3], size: [3, 4, 4] });
    assert.equal(bbox([]), null);
    assert.equal(uniq([[1, 1, 1], [1, 1, 1], [2, 2, 2]]).length, 2);
    assert.deepEqual(subtract([[1, 1, 1], [2, 2, 2]], [[2, 2, 2]]), [[1, 1, 1]]);
});
