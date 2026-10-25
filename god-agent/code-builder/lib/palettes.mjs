// Palettes: named roles -> block ids. Components only ever ask for a role, so one palette swap restyles a
// whole build. Override any role per call: palette({ ...PALETTES.stoneCastle, roof: 'minecraft:bricks' }) or
// palette('stoneCastle', { wall: 'minecraft:cobblestone' }).
//
// Roles:
//   wall        main wall block              trim        corners, courses, merlons' caps, foundation
//   floor       floors, walkways             accent      a sparing highlight (keystones, bands)
//   pillar      a log-like block (axis set by the component: posts y, beams x/z)
//   roof        full roof block (ridge, cone cap)
//   roofStairs  the slope (a *_stairs id)    roofSlab    a *_slab id (ridges, railings caps)
//   glass       windows (full blocks)        light       a standing light (lantern…)
//   door        a *_door id                  fence       railings (a *_fence or *_wall id)
//   path        paths and passage floors     bars        portcullis / grilles
//   stairs      walkable stairs (a *_stairs id: spiral staircases, bridge ramps, flights)

export const PALETTES = {
    stoneCastle: {
        wall: 'minecraft:stone_bricks', trim: 'minecraft:polished_andesite', floor: 'minecraft:spruce_planks',
        accent: 'minecraft:chiseled_stone_bricks', pillar: 'minecraft:spruce_log', roof: 'minecraft:dark_oak_planks',
        roofStairs: 'minecraft:dark_oak_stairs', roofSlab: 'minecraft:dark_oak_slab', glass: 'minecraft:glass',
        light: 'minecraft:lantern', door: 'minecraft:spruce_door', fence: 'minecraft:stone_brick_wall',
        path: 'minecraft:cobblestone', bars: 'minecraft:iron_bars',
        stairs: 'minecraft:spruce_stairs',
    },
    oakCottage: {
        wall: 'minecraft:oak_planks', trim: 'minecraft:cobblestone', floor: 'minecraft:spruce_planks',
        accent: 'minecraft:bricks', pillar: 'minecraft:oak_log', roof: 'minecraft:spruce_planks',
        roofStairs: 'minecraft:spruce_stairs', roofSlab: 'minecraft:spruce_slab', glass: 'minecraft:glass',
        light: 'minecraft:lantern', door: 'minecraft:oak_door', fence: 'minecraft:oak_fence',
        path: 'minecraft:dirt_path', bars: 'minecraft:oak_fence',
        stairs: 'minecraft:spruce_stairs',
    },
    sandstone: {
        wall: 'minecraft:cut_sandstone', trim: 'minecraft:smooth_sandstone', floor: 'minecraft:smooth_sandstone',
        accent: 'minecraft:chiseled_sandstone', pillar: 'minecraft:stripped_jungle_log', roof: 'minecraft:smooth_sandstone',
        roofStairs: 'minecraft:smooth_sandstone_stairs', roofSlab: 'minecraft:smooth_sandstone_slab',
        glass: 'minecraft:orange_stained_glass', light: 'minecraft:lantern', door: 'minecraft:jungle_door',
        fence: 'minecraft:sandstone_wall', path: 'minecraft:sandstone', bars: 'minecraft:iron_bars',
        stairs: 'minecraft:sandstone_stairs',
    },
    deepslate: {
        wall: 'minecraft:deepslate_bricks', trim: 'minecraft:polished_deepslate', floor: 'minecraft:dark_oak_planks',
        accent: 'minecraft:chiseled_deepslate', pillar: 'minecraft:dark_oak_log', roof: 'minecraft:deepslate_tiles',
        roofStairs: 'minecraft:deepslate_tile_stairs', roofSlab: 'minecraft:deepslate_tile_slab',
        glass: 'minecraft:tinted_glass', light: 'minecraft:soul_lantern', door: 'minecraft:dark_oak_door',
        fence: 'minecraft:deepslate_brick_wall', path: 'minecraft:cobbled_deepslate', bars: 'minecraft:iron_bars',
        stairs: 'minecraft:polished_deepslate_stairs',
    },
};

export const ROLES = Object.keys(PALETTES.stoneCastle);

/**
 * A complete palette: a preset name or object, with overrides. Unknown roles are refused (a typo would
 * otherwise silently keep the default); missing roles come from stoneCastle.
 */
export function palette(base = 'stoneCastle', overrides = {}) {
    const b = typeof base === 'string' ? PALETTES[base] : base;
    if (!b) throw new Error(`Unknown palette '${base}' (known: ${Object.keys(PALETTES).join(', ')})`);
    for (const k of Object.keys({ ...b, ...overrides })) if (!ROLES.includes(k)) throw new Error(`Unknown palette role '${k}' (roles: ${ROLES.join(', ')})`);
    return { ...PALETTES.stoneCastle, ...b, ...overrides };
}
