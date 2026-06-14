// Plain functions over the narrowed Bot seam, composed by the exemplar skills (M2-6). These are
// the v1 movement/collection/chest primitives, ported with their hard-won corrections (R7, R10).
// Layer 1: bots/ may import journal/config/types — never engines or actors (the dependency law).

import pathfinderPkg from 'mineflayer-pathfinder';

import type { Bot, BotContainer, BotItem, Vec3Like } from '../types/index';

const { goals } = pathfinderPkg;

/** R7: a single goal into far/unloaded chunks stalls or detours absurdly — walk in ≤40-block legs. */
export const MAX_HOP_BLOCKS = 40;

function dist(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function fmt(p: Vec3Like): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}

/**
 * R7: walk to `target` in hops of at most {@link MAX_HOP_BLOCKS} blocks, so a distant or
 * not-yet-loaded goal never produces a single unbounded path. Each leg is a real pathfinder
 * goal; the bot's body advances each hop so the next leg is computed from where it actually is.
 */
export async function goToHops(bot: Bot, target: Vec3Like, range = 1): Promise<void> {
  const pf = bot.pathfinder;
  if (!pf) throw new Error(`goToHops: bot ${bot.username} has no pathfinder (plugin failed to load? R16)`);
  if (!bot.entity) throw new Error(`goToHops: bot ${bot.username} has no body (disconnected/dead)`);

  // March toward the target in capped legs; recompute from the live position each hop.
  // Bounded iteration so a non-advancing bot can't loop forever (the wall-clock cap is upstream).
  for (let guard = 0; guard < 1024; guard++) {
    const pos = bot.entity.position;
    const remaining = dist(pos, target);
    if (remaining <= MAX_HOP_BLOCKS) break;
    const t = MAX_HOP_BLOCKS / remaining;
    const wp = { x: pos.x + (target.x - pos.x) * t, y: pos.y + (target.y - pos.y) * t, z: pos.z + (target.z - pos.z) * t };
    await pf.goto(new goals.GoalNear(wp.x, wp.y, wp.z, 2));
  }
  await pf.goto(new goals.GoalNear(target.x, target.y, target.z, range));
}

function isLog(name: string): boolean {
  return name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_stem') || name.endsWith('_hyphae');
}

/** Options for {@link collectTrunk}. */
export interface CollectTrunkOptions {
  /** How far up the column to walk before giving up. Default 32. */
  maxHeight?: number;
}

/**
 * R10: harvest a tree trunk the SAFE way — the column-connected-to-ground logs only, one block per
 * dig, skip-on-failure. Bulk collectblock chases floating leaf-logs and dies mid-list; this walks
 * straight up from `base` and stops at the first non-log, so disconnected floating logs are never
 * touched. Returns the number of blocks actually dug. (No collectblock plugin → no Movements
 * clobber, so nothing to re-assert here — that caveat is for callers of `bot.collectBlock.collect`.)
 */
export async function collectTrunk(bot: Bot, base: Vec3Like, opts: CollectTrunkOptions = {}): Promise<number> {
  const maxHeight = opts.maxHeight ?? 32;
  let dug = 0;
  for (let dy = 0; dy < maxHeight; dy++) {
    const pos = { x: base.x, y: base.y + dy, z: base.z };
    const block = bot.blockAt(pos);
    if (!block || !isLog(block.name)) break; // top of the contiguous trunk reached
    try {
      await bot.dig(block);
      dug++;
    } catch {
      // R10: skip-on-failure — a single un-diggable block must not abort the whole trunk.
    }
  }
  return dug;
}

/**
 * Walk to a chest (in hops), open it, run `fn`, and always close it. Pauses the autonomous
 * inventory mutators for the duration (R3) — they corrupt any multi-click window sequence.
 */
export async function useChest<T>(bot: Bot, chestPos: Vec3Like, fn: (chest: BotContainer) => Promise<T>): Promise<T> {
  await goToHops(bot, chestPos, 3);
  const block = bot.blockAt(chestPos);
  if (!block) {
    throw new Error(`useChest: no block at ${fmt(chestPos)} — chest gone or chunk unloaded (R8)`);
  }
  bot.autoEat?.disableAuto(); // R3
  bot.armorManager?.pause?.(); // R3
  const chest = await bot.openContainer(block);
  try {
    return await fn(chest);
  } finally {
    chest.close();
    bot.armorManager?.resume?.();
    bot.autoEat?.enableAuto();
  }
}

function itemId(bot: Bot, name: string): number {
  const id = bot.registry?.itemsByName[name]?.id;
  if (id === undefined) throw new Error(`item "${name}" is unknown to this bot's registry`);
  return id;
}

/** Deposit items (by name) into the chest at `chestPos`. */
export async function deposit(bot: Bot, chestPos: Vec3Like, items: BotItem[]): Promise<void> {
  await useChest(bot, chestPos, async (chest) => {
    for (const it of items) await chest.deposit(itemId(bot, it.name), null, it.count);
  });
}

/** Withdraw items (by name) from the chest at `chestPos`. */
export async function withdraw(bot: Bot, chestPos: Vec3Like, items: BotItem[]): Promise<void> {
  await useChest(bot, chestPos, async (chest) => {
    for (const it of items) await chest.withdraw(itemId(bot, it.name), null, it.count);
  });
}
