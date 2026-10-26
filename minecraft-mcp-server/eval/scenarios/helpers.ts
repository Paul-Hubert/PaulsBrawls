import { EVAL_BOTS, PARKING, TAG_ALL } from '../fixture.js';
import type { EvalContext } from '../types.js';
import { sleep } from '../util.js';
import { DEATH_OBJECTIVE } from '../world-setup.js';

/**
 * Shared scenario plumbing. Every scenario follows the same hygiene:
 * uninvolved bots get parked out of entity-tracking range, subjects get
 * positioned + equipped via RCON, and teardown sweeps tagged mobs + drops so
 * the suite stays order-independent.
 */

/** Give chunk loads / pathfinder a beat to settle after teleports. */
export const SETTLE_MS = 3_000;

/** Teleport every roster bot EXCEPT `keep` to the parking row. */
export async function parkAllExcept(ctx: EvalContext, keep: string[]): Promise<void> {
  const keepSet = new Set(keep);
  let i = 0;
  for (const bot of EVAL_BOTS) {
    if (keepSet.has(bot.name)) continue;
    await ctx.rcon.tp(bot.name, PARKING.x + i * PARKING.spacing, PARKING.y, PARKING.z);
    i++;
  }
}

export interface CombatKit {
  sword?: boolean;
  armor?: boolean;
}

/** Clear + equip a bot for combat via authoritative `item replace`. */
export async function outfit(ctx: EvalContext, name: string, kit: CombatKit): Promise<void> {
  await ctx.rcon.clearInventory(name);
  if (kit.sword) await ctx.rcon.equip(name, 'weapon.mainhand', 'minecraft:iron_sword');
  if (kit.armor) {
    await ctx.rcon.equip(name, 'armor.head', 'minecraft:iron_helmet');
    await ctx.rcon.equip(name, 'armor.chest', 'minecraft:iron_chestplate');
    await ctx.rcon.equip(name, 'armor.legs', 'minecraft:iron_leggings');
    await ctx.rcon.equip(name, 'armor.feet', 'minecraft:iron_boots');
  }
}

/** Iron helmet keeps daytime zombies from burning to a trivial pass. */
export const ZOMBIE_NBT = 'ArmorItems:[{},{},{},{id:"minecraft:iron_helmet",count:1}]';

export async function summonEvalZombie(ctx: EvalContext, x: number, y: number, z: number, scenarioTag: string): Promise<void> {
  await ctx.rcon.summonTagged('minecraft:zombie', x, y, z, [TAG_ALL, scenarioTag], ZOMBIE_NBT);
}

export async function sweepScenario(ctx: EvalContext, scenarioTag: string): Promise<void> {
  await ctx.rcon.killTagged(scenarioTag);
  await ctx.rcon.killDroppedItems();
  await ctx.rcon.timeSet(1_000);
}

export async function deaths(ctx: EvalContext, name: string): Promise<number> {
  return ctx.rcon.getScore(name, DEATH_OBJECTIVE);
}

export async function settle(ms: number = SETTLE_MS): Promise<void> {
  await sleep(ms);
}

export interface BotPoll {
  position: { x: number; y: number; z: number } | null;
  health: number | null;
  food: number | null;
}

export async function pollBot(ctx: EvalContext, name: string): Promise<BotPoll> {
  const snapshot = await ctx.admin.bot(name);
  return { position: snapshot.position, health: snapshot.health, food: snapshot.food };
}
