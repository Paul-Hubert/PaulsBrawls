// Deterministic RCON arena fixtures. The dev world spawns underground (y≈-60, dark) — never assume a
// surface (the smoke paid for this). Each builder carves a known, lit box at a known y and the scenario
// tp's the bots into it after they connect (setworldspawn does NOT relocate a bot with saved playerdata).
// All commands are absolute SETs (fill/setblock/setworldspawn), so re-applying a fixture is a no-op-safe
// rebuild.

/** A peaceful, daylight-frozen, no-mob, keep-inventory ruleset — the non-combat scenario baseline. */
export const PEACEFUL_RULES: string[] = [
  'difficulty peaceful',
  'time set day',
  'gamerule doDaylightCycle false',
  'gamerule doWeatherCycle false',
  'gamerule doMobSpawning false',
  'gamerule keepInventory true',
  'weather clear',
];

/**
 * A hollow, lit, peaceful stone box centered on (0,0): floor y198, ceiling y204, interior y199..203 air,
 * a glass ceiling for daylight, glowstone in the floor corners so it stays lit, worldspawn on the floor
 * at (0,199,0). The scenario fills its own content (oak / crafting table / farmland) into the interior.
 */
export function litBox(): string[] {
  // A SHALLOW interior (3 tall, y199..201) so pathfinder jitter can't accumulate a lethal fall — peaceful
  // does NOT prevent fall damage, and a tall box let a wandering bot chip itself out (finding D2).
  const X0 = -6, X1 = 6, Z0 = -6, Z1 = 6, FLOOR = 198, CEIL = 202, Y = 199;
  return [
    ...PEACEFUL_RULES,
    `fill ${X0} ${FLOOR} ${Z0} ${X1} ${CEIL} ${Z1} minecraft:stone`,
    `fill ${X0 + 1} ${FLOOR + 1} ${Z0 + 1} ${X1 - 1} ${CEIL - 1} ${Z1 - 1} minecraft:air`,
    `fill ${X0} ${CEIL} ${Z0} ${X1} ${CEIL} ${Z1} minecraft:glass`,
    `setblock ${X0 + 2} ${FLOOR} ${Z0 + 2} minecraft:glowstone`,
    `setblock ${X1 - 2} ${FLOOR} ${Z1 - 2} minecraft:glowstone`,
    `setblock ${X0 + 2} ${FLOOR} ${Z1 - 2} minecraft:glowstone`,
    `setblock ${X1 - 2} ${FLOOR} ${Z0 + 2} minecraft:glowstone`,
    `setworldspawn 0 ${Y} 0`,
  ];
}

/**
 * A COVERED 15×15 stone arena at y=200 for the mob-defense scenario: solid -7..7 block, hollowed interior
 * (-6..6, y201..203), a roof at y204 and glowstone floor lights. Covered + lit on purpose — summoned
 * zombies would otherwise burn in daylight and "die to the sun, not the villagers", and `doMobSpawning
 * false` means the only mobs are the ones the scenario summons. `difficulty easy` so a fair fight is
 * winnable without reinforcement swarms (see the inline note).
 */
export function combatArena(): string[] {
  const X0 = -7, X1 = 7, Z0 = -7, Z1 = 7, FLOOR = 200, CEIL = 204, Y = 201;
  return [
    // `difficulty easy` — hard/normal trigger zombie REINFORCEMENTS (3 summoned became 11; `doMobSpawning
    // false` does NOT stop them), which swarmed and killed the armored guards (finding D1). On easy the
    // reinforcement chance is 0 and zombies hit softer, so 2 iron-armored guards win a fair fight intact.
    'difficulty easy',
    'gamerule doMobSpawning false',
    'gamerule keepInventory true',
    'gamerule doDaylightCycle false',
    'time set day',
    'weather clear',
    `fill ${X0} ${FLOOR} ${Z0} ${X1} ${CEIL} ${Z1} minecraft:stone`,
    `fill ${X0 + 1} ${FLOOR + 1} ${Z0 + 1} ${X1 - 1} ${CEIL - 1} ${Z1 - 1} minecraft:air`,
    `setblock ${X0 + 2} ${FLOOR} ${Z0 + 2} minecraft:glowstone`,
    `setblock ${X1 - 2} ${FLOOR} ${Z1 - 2} minecraft:glowstone`,
    `setblock ${X0 + 2} ${FLOOR} ${Z1 - 2} minecraft:glowstone`,
    `setblock ${X1 - 2} ${FLOOR} ${Z0 + 2} minecraft:glowstone`,
    `setblock 0 ${FLOOR} 0 minecraft:glowstone`,
    `setworldspawn 0 ${Y} 0`,
  ];
}
