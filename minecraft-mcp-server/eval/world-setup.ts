import {
  ARENA,
  EVAL_BOTS,
  FARM,
  GROUND_Y,
  STAND_Y,
  TAG_ALL,
  VILLAGE,
  WORLD_SPAWN,
} from './fixture.js';
import type { RconClient } from './rcon.js';

/**
 * Builds the deterministic test village by RCON commands — no world zips.
 * Idempotent: every run first wipes the airspace (fill air), then re-lays the
 * platforms and fixtures, so re-running is always safe.
 *
 * The platforms are self-contained slabs at GROUND_Y with a 2-high perimeter
 * wall, independent of whatever terrain the underlying (superflat) world has.
 */

export const DEATH_OBJECTIVE = 'evalDeaths';

function platformCommands(minX: number, minZ: number, maxX: number, maxZ: number): string[] {
  const commands: string[] = [];
  // Airspace first (also clears fixtures from previous runs), one y-layer per
  // command to stay under the 32768-block fill limit.
  for (let y = STAND_Y; y <= STAND_Y + 8; y++) {
    commands.push(`fill ${minX} ${y} ${minZ} ${maxX} ${y} ${maxZ} minecraft:air`);
  }
  commands.push(`fill ${minX} ${GROUND_Y} ${minZ} ${maxX} ${GROUND_Y} ${maxZ} minecraft:grass_block`);
  // Perimeter walls (the platforms float above the superflat floor — keep
  // fleeing bots and chased zombies from pathing off the edge).
  commands.push(
    `fill ${minX} ${STAND_Y} ${minZ} ${maxX} ${STAND_Y + 1} ${minZ} minecraft:stone_bricks`,
    `fill ${minX} ${STAND_Y} ${maxZ} ${maxX} ${STAND_Y + 1} ${maxZ} minecraft:stone_bricks`,
    `fill ${minX} ${STAND_Y} ${minZ} ${minX} ${STAND_Y + 1} ${maxZ} minecraft:stone_bricks`,
    `fill ${maxX} ${STAND_Y} ${minZ} ${maxX} ${STAND_Y + 1} ${maxZ} minecraft:stone_bricks`
  );
  return commands;
}

export function worldSetupCommands(): string[] {
  const commands: string[] = [
    // Determinism knobs: the eval owns time, weather and every mob in play.
    'gamerule doMobSpawning false',
    'gamerule doDaylightCycle false',
    'gamerule doWeatherCycle false',
    'gamerule doFireTick false',
    'gamerule doInsomnia false',
    'gamerule announceAdvancements false',
    'gamerule spawnRadius 0',
    'gamerule doImmediateRespawn true',
    'gamerule keepInventory true',
    'difficulty hard',
    'weather clear',
    'time set 1000',
    `setworldspawn ${WORLD_SPAWN.x} ${WORLD_SPAWN.y} ${WORLD_SPAWN.z}`,
    `scoreboard objectives add ${DEATH_OBJECTIVE} deathCount`,
    // Keep both fixture regions loaded even with no player nearby, so setup
    // commands and scenario summons always land in loaded chunks.
    `forceload add ${VILLAGE.minX} ${VILLAGE.minZ} ${VILLAGE.maxX} ${VILLAGE.maxZ}`,
    `forceload add ${ARENA.minX} ${ARENA.minZ} ${ARENA.maxX} ${ARENA.maxZ}`,
  ];

  commands.push(...platformCommands(VILLAGE.minX, VILLAGE.minZ, VILLAGE.maxX, VILLAGE.maxZ));
  commands.push(...platformCommands(ARENA.minX, ARENA.minZ, ARENA.maxX, ARENA.maxZ));

  // Farm plot: hydrated farmland with mature wheat (S-scenarios don't harvest
  // it, but the farm-loop routine and any real-LLM run find real work here).
  commands.push(
    `fill ${FARM.minX} ${GROUND_Y} ${FARM.minZ} ${FARM.maxX} ${GROUND_Y} ${FARM.maxZ} minecraft:farmland`,
    `setblock ${FARM.water.x} ${GROUND_Y} ${FARM.water.z} minecraft:water`,
    `fill ${FARM.minX} ${STAND_Y} ${FARM.minZ} ${FARM.maxX} ${STAND_Y} ${FARM.maxZ} minecraft:wheat[age=7]`,
    `setblock ${FARM.water.x} ${STAND_Y} ${FARM.water.z} minecraft:air`
  );

  // Per-bot fixtures: chest, bed (foot+head, two blocks south of home), torch.
  for (const bot of EVAL_BOTS) {
    if (bot.chest) {
      commands.push(`setblock ${bot.chest.x} ${bot.chest.y} ${bot.chest.z} minecraft:chest`);
    }
    commands.push(
      `setblock ${bot.home.x} ${STAND_Y} ${bot.home.z + 2} minecraft:red_bed[facing=south,part=foot]`,
      `setblock ${bot.home.x} ${STAND_Y} ${bot.home.z + 3} minecraft:red_bed[facing=south,part=head]`,
      `setblock ${bot.home.x + 1} ${STAND_Y} ${bot.home.z} minecraft:torch`
    );
  }

  // Crafter's workstation.
  const crafter = EVAL_BOTS.find((b) => b.role === 'crafter');
  if (crafter?.workstation) {
    commands.push(`setblock ${crafter.workstation.x} ${crafter.workstation.y} ${crafter.workstation.z} minecraft:crafting_table`);
  }

  // Sweep anything a previous run left behind.
  commands.push(`kill @e[tag=${TAG_ALL}]`, 'kill @e[type=minecraft:item]');

  return commands;
}

/** Responses that are fine even though they sound like complaints. */
const TOLERATED = [
  /already exists/i,
  /No entity was found/i,
  /Nothing changed/i,
  /Test failed/i,
  /That position is already/i,
  /no blocks were filled/i,
];

const FATAL = [/^Unknown /i, /Incorrect argument/i, /Expected /i, /Invalid /i];

export async function runWorldSetup(rcon: RconClient, logLine: (line: string) => void): Promise<void> {
  for (const command of worldSetupCommands()) {
    const response = await rcon.send(command);
    if (FATAL.some((re) => re.test(response)) && !TOLERATED.some((re) => re.test(response))) {
      throw new Error(`world-setup command failed: '${command}' -> ${response}`);
    }
  }
  logLine('[world-setup] fixture built (village + arena platforms, farm, chests, beds)');
}
