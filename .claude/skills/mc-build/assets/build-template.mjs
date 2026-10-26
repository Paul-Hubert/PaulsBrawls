// <What this is, in a sentence or two, from the outside in.>
// Local frame: <where x = 0, z = 0 is and which way is north>; y = 0 is the ground course.
//   node build-<name>.mjs                    # dry run: counts, bounding box, proofs
//   node build-<name>.mjs --slice=1          # plus the top view at y = 1 (from the anchor)
//   node build-<name>.mjs --build --yes --parallel=4
//   --mobs=only | --mobs=none                # creatures only / blocks only: a re-run must never spawn twice
// Parameters: --size (…), <the others that give a variant>.
import { box, rectRing, layer, concat, placeAt, palette, withProps, rotatePoint, spawns, resolve, walk,
    build, cliOptions, sliceMap } from './lib/index.mjs';

const { params, ...run } = cliOptions();
const { size: S = 32, slice, mobs = 'all' } = params;
const ANCHOR = run.anchor || [-Math.floor(S / 2), 0, -Math.floor(S / 2)]; // from the survey: <why here>

const P = palette('stoneCastle');

export const plan = [];
const add = (...parts) => plan.push(...concat(...parts));
const creatures = [];   // spawn groups, from spawns()
const zones = [];       // { name, start: [x, y, z], bounds: [x0, y0, z0, x1, y1, z1] }: a creature there must stay inside
const outside = null;   // a feet cell beyond the walls for the zombie checks, e.g. [S / 2, 1, S + 20]; null: none

/** A point (or [dx, dz] direction with dir) through a placeAt transform, to keep data in step with the blocks. */
const at = (p, { at: a = [0, 0, 0], turns = 0 }) => { const q = rotatePoint(p, turns); return [q[0] + a[0], q[1] + a[1], q[2] + a[2]]; };

// ---------------------------------------------------------------------------------------------------- structure

// Compose from lib/components.mjs; place each part with placeAt(part, tf) and push its zones and spawn points
// through the same tf with at(). Example shape, replace it:
//   const tf = { at: [10, 0, 4], turns: 1 };
//   add(placeAt(house({ w: 7, d: 9, palette: P }), tf));
//   creatures.push(...spawns('minecraft:villager', [at([3, 1, 4], tf)], { nbt: '{VillagerData:{profession:"minecraft:farmer",level:2,type:"minecraft:plains"},Xp:10}' }));

// ------------------------------------------------------------------------------------------------------- proofs

/**
 * From every zone's start a villager and a 1-high walker must stay inside the zone's bounds; zombies and baby
 * zombies from `outside` must reach no zone. Prints one line per check; returns false if any fails.
 */
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
        // walk() stops at the first cell past the plan's box, so a barrier ring (never built) keeps it exploring.
        // The ring: 8 out from the plan and the start (a loop, not Math.min(...): plans are too big to spread).
        const r = [outside[0] - 8, outside[2] - 8, outside[0] + 8, outside[2] + 8];
        for (const l of layers) for (const [x, , z] of l.points) { r[0] = Math.min(r[0], x - 8); r[1] = Math.min(r[1], z - 8); r[2] = Math.max(r[2], x + 8); r[3] = Math.max(r[3], z + 8); }
        const ring = layer('minecraft:barrier', Array.from({ length: 48 }, (_, y) => rectRing(r[0], r[1], r[2], r[3], y + 1)).flat());
        // Baby zombies too: a 1 × 1 arrow slit at y = 2 lets them into a tower that an adult cannot enter.
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
if (zones.length || outside) {
    console.log('containment proof:');
    if (!prove()) throw new Error('<name>: the containment proof failed; fix the plan before building');
}
await build(mobs === 'only' ? [] : plan, { label: '<name>', ...run, anchor: ANCHOR, spawns: mobs === 'none' ? [] : creatures });
