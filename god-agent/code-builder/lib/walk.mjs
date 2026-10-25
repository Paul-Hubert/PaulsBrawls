// Walking a plan: the cells a creature can reach on foot from a start, with the plan's blocks over a flat world
// (solid at y <= ground, air above). For proving that an enclosure holds (nothing inside reaches out) and that the
// way in works. Conservative on purpose: a walker jumps one block, falls any height, swims, climbs ladders and
// vines, and passes the doors it can open. It never breaks, digs, places, teleports or flies, so endermen, spiders
// (they climb any wall: roof their pens), flying mobs and players with tools are outside what this proves.

import { resolve } from './plan.mjs';
import { parseBlock } from './blockstate.mjs';

const WOOD_DOOR = /^minecraft:(?!iron_door$)[a-z_]+_door$/;
/** Built-in walkers: height in blocks, and the blocks it gets through. */
export const WALKERS = {
    villager: { height: 2, opens: WOOD_DOOR },           // opens wooden doors; never iron doors, fence gates or trapdoors
    zombie: { height: 2, opens: WOOD_DOOR },             // breaks wooden doors on Hard: count them as open
    player: { height: 2, opens: /(_door|_fence_gate|_trapdoor)$/ },
    small: { height: 1, opens: null },                   // baby zombies, chickens, small slimes: 1 high
};

const NO_COLLISION = /^minecraft:(air|cave_air|void_air|light|structure_void|water|bubble_column|[a-z_]*torch|ladder|vine|[a-z_]*_vines(_plant)?|wheat|carrots|potatoes|beetroots|nether_wart|sweet_berry_bush|[a-z_]*_sapling|short_grass|tall_grass|grass|fern|large_fern|dead_bush|dandelion|poppy|[a-z_]*_tulip|cornflower|allium|azure_bluet|oxeye_daisy|lily_of_the_valley|[a-z_]*_mushroom|[a-z_]*_button|lever|[a-z_]*_pressure_plate|[a-z_]*_sign|[a-z_]*_banner|redstone_wire|tripwire|[a-z_]*rail|cobweb|snow|[a-z_]*_carpet)$/;
const TALL = /^minecraft:([a-z_]+_fence|[a-z_]+_fence_gate|[a-z_]+_wall)$/; // 1.5 high: nothing jumps onto it
const CLIMB = /^minecraft:(ladder|vine|water|bubble_column|scaffolding)$/;
const NOT_A_WALL = /(_torch|_sign|_banner|_fan|_head|_skull)$/;

/**
 * Every feet cell ("x,y,z") reachable from `start` (a feet cell). Options: walker (a WALKERS name or
 * { height, opens }), ground (the top of the flat world, default 0), margin (how far past the plan's bounding box
 * the walk may go before it counts as out in the open: default 2), maxCells.
 * Returns { cells: Set, out: [x,y,z] | null } — out is the first cell found beyond the margin (the walker got away).
 */
export function walk(plan, start, { walker = 'villager', ground = 0, margin = 2, maxCells = 3_000_000 } = {}) {
    const W = typeof walker === 'string' ? WALKERS[walker] : walker;
    if (!W) throw new Error(`walk: unknown walker '${walker}' (known: ${Object.keys(WALKERS).join(', ')})`);
    const at = new Map();
    for (const l of resolve(plan, { finalize: false }).layers) {
        const id = parseBlock(l.block).id;
        for (const p of l.points) at.set(`${p[0]},${p[1]},${p[2]}`, id);
    }
    const xs = [], ys = [], zs = [];
    for (const k of at.keys()) { const [x, y, z] = k.split(',').map(Number); xs.push(x); ys.push(y); zs.push(z); }
    const box = xs.length
        ? { x0: Math.min(...xs) - margin, x1: Math.max(...xs) + margin, z0: Math.min(...zs) - margin, z1: Math.max(...zs) + margin, y1: Math.max(...ys) + margin }
        : { x0: -margin, x1: margin, z0: -margin, z1: margin, y1: margin };
    const block = (x, y, z) => at.get(`${x},${y},${z}`) ?? (y <= ground ? 'minecraft:ground' : 'minecraft:air');
    const opens = id => !!W.opens && W.opens.test(id);
    const clearOne = (x, y, z) => { const b = block(x, y, z); return NO_COLLISION.test(b) || opens(b); };
    const clear = (x, y, z) => { for (let h = 0; h < W.height; h++) if (!clearOne(x, y + h, z)) return false; return true; };
    const tall = id => TALL.test(id) && !NOT_A_WALL.test(id) && !opens(id);
    const floor = (x, y, z) => { const b = block(x, y - 1, z); return !NO_COLLISION.test(b) && !opens(b); };
    const climbing = (x, y, z) => CLIMB.test(block(x, y, z));
    const supported = (x, y, z) => floor(x, y, z) || climbing(x, y, z);
    const outside = (x, y, z) => x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1 || y > box.y1;

    const key = (x, y, z) => `${x},${y},${z}`;
    const cells = new Set([key(...start)]);
    const queue = [start];
    const visit = (x, y, z) => {
        const k = key(x, y, z);
        if (cells.has(k)) return false;
        cells.add(k);
        queue.push([x, y, z]);
        if (cells.size > maxCells) throw new Error(`walk: more than ${maxCells} cells (pass a smaller plan or maxCells)`);
        return outside(x, y, z);
    };
    for (let i = 0; i < queue.length; i++) {
        const [x, y, z] = queue[i];
        if (outside(x, y, z)) return { cells, out: [x, y, z] };
        const moves = [];
        if (climbing(x, y, z) || climbing(x, y + 1, z)) {
            if (clear(x, y + 1, z)) moves.push([x, y + 1, z]);
        }
        if (y - 1 > ground - 64 && clear(x, y - 1, z) && !floor(x, y, z)) moves.push([x, y - 1, z]);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, nz = z + dz;
            if (clear(nx, y, nz)) {
                let ny = y; // walk across, then fall to whatever holds it up
                while (!supported(nx, ny, nz) && ny > ground - 64 && clear(nx, ny - 1, nz)) ny--;
                moves.push([nx, ny, nz]);
            } else if (!tall(block(nx, y, nz)) && clear(nx, y + 1, nz) && clearOne(x, y + W.height, z) && supported(x, y, z)) {
                moves.push([nx, y + 1, nz]); // a one-block jump, with headroom to take it
            }
        }
        for (const m of moves) if (visit(...m)) return { cells, out: m };
    }
    return { cells, out: null };
}
