// The helpers: scope globals every command can call (docs/29 §5.2). Voyager's primitives under Voyager's names
// and signatures (mineBlock, craftItem, smeltItem, placeItem, killMob, exploreUntil, getItemFromChest,
// depositItemIntoChest, checkItemInsideChest), plus movement, combat and lookup helpers. The hard-won fixes come
// from Eden's stock skills (copied): hops of ≤ 40 blocks (R7), window safety (R1–R3), numeric ids for recipesFor
// (gap C), drops picked up by walking onto them (gap E).
//
// Every helper:
//   • takes a (guarded) bot first; when it belongs to an order, block targets are claimed across orders, so two bots
//     told `mineBlock(bot, 'oak_log', 5)` at the same time chop different logs;
//   • returns data and throws a HelperError that says what and where (`mineBlock(Bob): no oak_log within 32 blocks
//     of (102, 64, -40)`); a BotLeftError / OrderStoppedError passes through untouched;
//   • has a progress watchdog where it can stall (no movement, dig or window event for 20 s → it stops and throws).

import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

import { closeStrayWindow, windowOperation, type WindowBot } from '../bots/hardening';
import { GoalFollowOffset, type FollowOffset } from '../bots/follow-goal';
import { orderOf, unwrap } from '../orders/guard';
import { HelperError, isBotLeft, isStopped } from './errors';

const { goals } = pathfinderPkg;

/** What a helper needs from the order its bot belongs to (Order implements it). */
interface OrderLike {
  id: string;
  log(line: string): void;
  readonly signal: AbortSignal;
  readonly alive: boolean;
  friends: Set<string>;
  claimKey?(key: string, ttlSeconds?: number): boolean;
  heldByOther?(key: string): boolean;
  unclaimKey?(key: string): void;
}

export const STALL_MS = 20_000;
export const MAX_HOP = 40;

export type PosLike = Vec3 | { x: number; y: number; z: number } | [number, number, number] | { position: { x: number; y: number; z: number } };

// -- small utilities -------------------------------------------------------------------------------------------

export function toVec3(p: PosLike | null | undefined, what = 'position'): Vec3 {
  if (!p) throw new HelperError(`${what}: expected {x, y, z}, [x, y, z], a block or an entity, got ${String(p)}`);
  if (Array.isArray(p)) return new Vec3(Number(p[0]), Number(p[1]), Number(p[2]));
  const o = p as { x?: number; y?: number; z?: number; position?: { x: number; y: number; z: number } };
  if (o.position && typeof o.position.x === 'number') return new Vec3(o.position.x, o.position.y, o.position.z);
  if (typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number') return new Vec3(o.x, o.y, o.z);
  throw new HelperError(`${what}: expected {x, y, z}, [x, y, z], a block or an entity, got ${safeJson(p)}`);
}

/** A claim key for a block position (integer coordinates). */
export function blockKey(p: PosLike): string {
  const v = toVec3(p, 'blockKey');
  return `block:${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
}

const fmt = (v: { x: number; y: number; z: number } | undefined | null): string =>
  v ? `(${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.z)})` : '(?)';

const who = (bot: Bot): string => bot.username ?? '?';

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function passControl(e: unknown): void {
  if (isBotLeft(e) || isStopped(e)) throw e;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function order(bot: Bot): OrderLike | undefined {
  return orderOf<OrderLike>(bot);
}

function log(bot: Bot, line: string): void {
  order(bot)?.log(`${who(bot)}: ${line}`);
}

function bareName(name: string): string {
  return String(name).replace(/^minecraft:/, '').trim();
}

function itemIdOf(bot: Bot, name: string, helper: string): number {
  const n = bareName(name);
  const e = bot.registry?.itemsByName?.[n];
  if (!e) throw new HelperError(`${helper}(${who(bot)}): unknown item "${n}" (use a Minecraft id like "oak_planks")`);
  return e.id;
}

/** Block ids matching a name: an exact id, or every block whose id contains it when it starts or ends with "_". */
function blockIds(bot: Bot, name: string, helper: string): number[] {
  const n = bareName(name);
  const exact = bot.registry?.blocksByName?.[n];
  if (exact) return [exact.id];
  if (n.startsWith('_') || n.endsWith('_')) {
    const ids = Object.values(bot.registry.blocksByName).filter((b) => b.name.includes(n)).map((b) => b.id);
    if (ids.length) return ids;
  }
  throw new HelperError(`${helper}(${who(bot)}): unknown block "${n}" (a Minecraft id like "oak_log", or "_log" for every kind)`);
}

/** Count of an item in the inventory. */
export function countItem(bot: Bot, name: string): number {
  const n = bareName(name);
  return bot.inventory.items().filter((i) => i.name === n).reduce((s, i) => s + i.count, 0);
}

/**
 * Race `work` against a progress watchdog: progress = the bot moved ≥ 0.3 blocks, dug, or its inventory changed,
 * sampled every second. `onStall` stops whatever drives the bot so `work` settles too.
 */
async function withProgress<T>(bot: Bot, label: string, work: () => Promise<T>, onStall: () => void, stallMs = STALL_MS): Promise<T> {
  let last = bot.entity?.position?.clone?.() ?? null;
  let lastItems = inventoryCount(bot);
  let quietSince = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      try {
        const p = bot.entity?.position;
        const items = inventoryCount(bot);
        const moved = p && last ? p.distanceTo(last) >= 0.3 : false;
        const digging = !!(bot as unknown as { targetDigBlock?: unknown }).targetDigBlock;
        if (moved || digging || items !== lastItems) {
          quietSince = Date.now();
          last = p?.clone?.() ?? last;
          lastItems = items;
        } else if (Date.now() - quietSince > stallMs) {
          clearInterval(timer);
          try {
            onStall();
          } catch {
            /* best-effort */
          }
          reject(new HelperError(`${label}: no progress for ${Math.round(stallMs / 1000)} s at ${fmt(bot.entity?.position)}`));
        }
      } catch (e) {
        clearInterval(timer);
        reject(e);
      }
    }, 1_000);
  });
  stalled.catch(() => undefined);
  try {
    return await Promise.race([work(), stalled]);
  } finally {
    if (timer) clearInterval(timer);
  }
}

function inventoryCount(bot: Bot): number {
  try {
    return bot.inventory.items().reduce((s, i) => s + i.count, 0);
  } catch {
    return 0;
  }
}

function stopMoving(bot: Bot): void {
  try {
    bot.pathfinder.stop();
    bot.pathfinder.setGoal(null);
  } catch {
    /* the bot may have left */
  }
}

// -- movement --------------------------------------------------------------------------------------------------

/**
 * Walk to within `range` blocks of a position, in hops of ≤ 40 blocks (R7: far goals in unloaded chunks fail). A
 * target nobody can stand at (in leaves, in the air: found live on a forest canopy, docs/29 §16) is approached
 * step by step: within range + 2, then the column at any height. Hops aim at the column (a hop end is rarely
 * standable at an interpolated height).
 */
export async function goTo(bot: Bot, pos: PosLike, range = 1): Promise<{ arrived: true; position: Vec3 }> {
  const target = toVec3(pos, 'goTo');
  const label = `goTo(${who(bot)})`;
  const go = (goal: unknown) => withProgress(bot, label, () => bot.pathfinder.goto(goal as never), () => stopMoving(bot));
  try {
    for (let hop = 0; hop < 256; hop++) {
      const p = bot.entity.position;
      const d = p.distanceTo(target);
      if (d <= MAX_HOP) break;
      const t = MAX_HOP / d;
      await go(new goals.GoalNearXZ(p.x + (target.x - p.x) * t, p.z + (target.z - p.z) * t, 3));
    }
    const attempts = [
      new goals.GoalNear(target.x, target.y, target.z, range),
      new goals.GoalNear(target.x, target.y, target.z, range + 2),
      new goals.GoalNearXZ(target.x, target.z, range + 2),
    ];
    for (let i = 0; i < attempts.length; i++) {
      try {
        await go(attempts[i]);
        break;
      } catch (e) {
        passControl(e);
        if (i === attempts.length - 1 || !/no path/i.test((e as Error).message)) throw e;
      }
    }
  } catch (e) {
    passControl(e);
    throw new HelperError(`${label}: ${(e as Error).message} — toward ${fmt(target)} from ${fmt(bot.entity?.position)}`);
  }
  return { arrived: true, position: bot.entity.position.clone() };
}

/** How long `follow` keeps its goal after a call returns, waiting for the next call to take it over. */
export const FOLLOW_KEEP_MS = 300;

/** Per body (the real bot): the GoalFollow `follow` last set, and the timer that will clear it if nobody keeps it. */
const followKept = new WeakMap<object, { goal: unknown; timer?: ReturnType<typeof setTimeout>; cancel?: () => void }>();

/**
 * Stay within `range` of an entity (the commander: `ctx.commander.entity(bot)`). Returns after `untilMs` when
 * given, otherwise when the order stops, the entity is gone or the bot leaves. A null entity just waits `untilMs`
 * (default 1 s), so a loop around it can look again.
 *
 * `offset` ({x, z}, blocks) follows a point beside the entity instead: a bot's own slot around the commander, so
 * many followers do not all stand in the same block.
 *
 * Commands call it in a loop (`follow(bot, e, 3, { untilMs: 1000 })`). A new goal resets the path and releases the
 * controls, so a follower used to stop and re-plan once a second (docs/31 §5.3). The goal is kept instead: a call
 * finding the GoalFollow it set last on the same entity at the same range leaves it alone, and a call that returns
 * clears the goal only FOLLOW_KEEP_MS later, if no call kept it and it is still that same goal object (so the timer
 * never clears a goal another order or another helper set meanwhile).
 */
export async function follow(
  bot: Bot,
  entity: Entity | null | undefined,
  range = 3,
  opts: { untilMs?: number; offset?: FollowOffset | null } = {},
): Promise<{ following: boolean }> {
  const o = order(bot);
  if (!entity) {
    await sleepMs(opts.untilMs ?? 1_000);
    return { following: false };
  }
  const real = unwrap(bot) as Bot;
  const kept = followKept.get(real);
  if (kept) {
    // A call follows on: the previous call's deferred clear must not fire, whatever this call does with the goal.
    if (kept.timer) clearTimeout(kept.timer);
    kept.cancel?.();
    kept.timer = undefined;
    kept.cancel = undefined;
  }
  const offset = opts.offset ? { x: Number(opts.offset.x) || 0, z: Number(opts.offset.z) || 0 } : null;
  const current = real.pathfinder?.goal as { entity?: unknown; rangeSq?: number } | null | undefined;
  let goal: unknown;
  if (kept && current === kept.goal && current instanceof goals.GoalFollow && current.entity === entity && current.rangeSq === range * range && sameOffset(current, offset)) {
    goal = current;
    bot.pathfinder.isMoving(); // a guarded call: the lease is checked here as setGoal would have
  } else {
    goal = offset ? new GoalFollowOffset(entity, range, offset) : new goals.GoalFollow(entity, range);
    bot.pathfinder.setGoal(goal as never, true);
    followKept.set(real, { goal });
  }
  try {
    const deadline = opts.untilMs !== undefined ? Date.now() + opts.untilMs : Infinity;
    while (Date.now() < deadline) {
      if (o && !o.alive) break;
      if (!(entity as { isValid?: boolean }).isValid) break;
      await sleepMs(Math.min(250, Math.max(0, deadline - Date.now())));
      bot.pathfinder.isMoving(); // a guarded call: throws BotLeftError once the bot is no longer this order's
    }
  } finally {
    // When the order ended, the abort sequence (R4/R5) has cleared the goal already.
    if (o?.alive !== false) deferFollowClear(bot, real, goal, o);
  }
  return { following: true };
}

/** Whether a kept follow goal follows at that offset (none for a plain GoalFollow). */
function sameOffset(goal: unknown, offset: FollowOffset | null): boolean {
  if (!(goal instanceof GoalFollowOffset)) return offset === null;
  return !!offset && goal.offset.x === offset.x && goal.offset.z === offset.z;
}

/**
 * Clear `goal` FOLLOW_KEEP_MS from now unless a follow call keeps it first. The clear goes through the guarded bot,
 * so it is lease-checked like any call of the order: once the bot left the order (or the order ended), the call
 * throws, the error is dropped here (nobody awaits a timer), and the goal of whoever drives the body now is left
 * alone. The timer is unref'd, and cancelled when the order ends.
 */
function deferFollowClear(bot: Bot, real: Bot, goal: unknown, o: OrderLike | undefined): void {
  const kept = followKept.get(real);
  if (!kept || kept.goal !== goal) return; // a later call (another order's, say) set its own goal
  const fire = (): void => {
    kept.cancel?.();
    kept.timer = undefined;
    kept.cancel = undefined;
    if (followKept.get(real) !== kept || real.pathfinder?.goal !== goal) return;
    followKept.delete(real);
    try {
      bot.pathfinder.setGoal(null);
    } catch {
      /* the bot left the order or the order ended: the goal is no longer ours to clear */
    }
  };
  const timer = setTimeout(fire, FOLLOW_KEEP_MS);
  timer.unref?.();
  kept.timer = timer;
  if (o) {
    const onAbort = (): void => {
      clearTimeout(timer);
      if (kept.timer === timer) kept.timer = undefined;
    };
    o.signal.addEventListener('abort', onAbort, { once: true });
    kept.cancel = () => o.signal.removeEventListener('abort', onAbort);
  }
}

/** Explore in a direction (Voyager: a Vec3 of -1/0/1 per axis) until `callback()` returns something, or `maxTime` s. */
export async function exploreUntil<T>(bot: Bot, direction: PosLike, maxTime = 60, callback?: () => T | Promise<T>): Promise<T | null> {
  const dir = toVec3(direction, 'exploreUntil direction');
  if (dir.x === 0 && dir.z === 0 && dir.y === 0) throw new HelperError('exploreUntil: direction must not be (0, 0, 0)');
  const deadline = Date.now() + maxTime * 1000;
  const label = `exploreUntil(${who(bot)})`;
  try {
    while (Date.now() < deadline) {
      const found = callback ? await callback() : null;
      if (found) {
        stopMoving(bot);
        return found;
      }
      if (!bot.pathfinder.isMoving()) {
        const p = bot.entity.position;
        const step = 32;
        bot.pathfinder.setGoal(new goals.GoalNearXZ(p.x + dir.x * step, p.z + dir.z * step, 3));
      }
      await sleepMs(1_000);
    }
  } catch (e) {
    passControl(e);
    throw new HelperError(`${label}: ${(e as Error).message} at ${fmt(bot.entity?.position)}`);
  } finally {
    try {
      stopMoving(bot);
    } catch {
      /* left */
    }
  }
  return null;
}

// -- blocks ----------------------------------------------------------------------------------------------------

/** The nearest block of that id within `maxDistance`, or null (`"_log"` matches every log). */
export function findBlock(bot: Bot, name: string, maxDistance = 48): Block | null {
  const ids = blockIds(bot, name, 'findBlock');
  return bot.findBlock({ matching: ids, maxDistance }) ?? null;
}

/**
 * Mine `count` blocks of a kind (Voyager's mineBlock): find them, skip blocks another bot or order claimed, path,
 * dig with the best tool and pick up the drops (mineflayer-collectblock). A block that fails is skipped. Throws when
 * nothing at all was mined.
 */
export async function mineBlock(bot: Bot, name: string, count = 1, opts: { maxDistance?: number } = {}): Promise<{ mined: number; at: Vec3[] }> {
  const ids = blockIds(bot, name, 'mineBlock');
  const maxDistance = opts.maxDistance ?? 32;
  const o = order(bot);
  const label = `mineBlock(${who(bot)})`;
  const at: Vec3[] = [];
  const failed = new Set<string>();
  let lastError = '';
  for (let round = 0; round < 3 && at.length < count; round++) {
    const positions = bot.findBlocks({ matching: ids, maxDistance, count: Math.max(64, count * 8) });
    const free = positions.filter((p) => !failed.has(blockKey(p)) && !o?.heldByOther?.(blockKey(p)));
    if (free.length === 0) break;
    for (const p of free) {
      if (at.length >= count) break;
      const key = blockKey(p);
      if (o?.claimKey && !o.claimKey(key, 120)) continue;
      const block = bot.blockAt(p);
      if (!block || !ids.includes(block.type)) {
        o?.unclaimKey?.(key);
        continue;
      }
      try {
        await withProgress(bot, label, () => bot.collectBlock.collect(block, { ignoreNoPath: true }), () => {
          bot.collectBlock.cancelTask();
          stopMoving(bot);
        });
        at.push(p.clone());
      } catch (e) {
        passControl(e);
        lastError = (e as Error).message;
        failed.add(key);
        log(bot, `${label}: skipped ${fmt(p)}: ${lastError}`);
      } finally {
        o?.unclaimKey?.(key);
      }
    }
  }
  if (at.length === 0) {
    throw new HelperError(
      `${label}: no ${bareName(name)} mined within ${maxDistance} blocks of ${fmt(bot.entity?.position)}` +
        (lastError ? ` (last error: ${lastError})` : failed.size ? '' : ' (none found, or all claimed by other bots)'),
    );
  }
  return { mined: at.length, at };
}

/**
 * Place a block of `name` at `position` (Voyager's placeItem): equip it, walk within reach, find a solid
 * neighbour to place against.
 */
export async function placeItem(bot: Bot, name: string, position: PosLike): Promise<{ placed: true; at: Vec3 }> {
  const target = toVec3(position, 'placeItem').floored();
  const label = `placeItem(${who(bot)})`;
  const o = order(bot);
  const key = blockKey(target);
  if (o?.heldByOther?.(key)) throw new HelperError(`${label}: ${fmt(target)} is claimed by another order`);
  const item = bot.inventory.items().find((i) => i.name === bareName(name));
  if (!item) throw new HelperError(`${label}: no ${bareName(name)} in the inventory`);
  const current = bot.blockAt(target);
  if (current && !['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass', 'snow'].includes(current.name)) {
    throw new HelperError(`${label}: ${fmt(target)} is already ${current.name}`);
  }
  const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  let ref: Block | null = null;
  let face: Vec3 | null = null;
  for (const f of faces) {
    const b = bot.blockAt(target.plus(f));
    if (b && b.boundingBox === 'block') {
      ref = b;
      face = f.scaled(-1);
      break;
    }
  }
  if (!ref || !face) throw new HelperError(`${label}: nothing solid next to ${fmt(target)} to place against`);
  try {
    if (bot.entity.position.distanceTo(target) > 4) await goTo(bot, target, 3);
    await bot.equip(item, 'hand');
    await bot.placeBlock(ref, face);
  } catch (e) {
    passControl(e);
    const now = bot.blockAt(target);
    if (now && now.name === bareName(name)) return { placed: true, at: target }; // placed despite a late ack
    throw new HelperError(`${label}: ${(e as Error).message} at ${fmt(target)}`);
  }
  return { placed: true, at: target };
}

// -- crafting, smelting, chests -------------------------------------------------------------------------------

async function nearbyStation(bot: Bot, blockName: string, label: string): Promise<Block | null> {
  const id = bot.registry.blocksByName[blockName]?.id;
  if (id === undefined) return null;
  let station = bot.findBlock({ matching: id, maxDistance: 32 });
  if (!station && countItem(bot, blockName) > 0) {
    // Put one down next to the bot (Voyager does the same): on a free spot with solid ground under it.
    const base = bot.entity.position.floored();
    for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(1, 0, 1), new Vec3(-1, 0, -1)]) {
      const spot = base.plus(d);
      const here = bot.blockAt(spot);
      const below = bot.blockAt(spot.offset(0, -1, 0));
      if (here?.name === 'air' && below?.boundingBox === 'block') {
        await placeItem(bot, blockName, spot);
        station = bot.blockAt(spot);
        log(bot, `${label}: placed a ${blockName} at ${fmt(spot)}`);
        break;
      }
    }
  }
  if (station && bot.entity.position.distanceTo(station.position) > 3.5) await goTo(bot, station.position, 2);
  return station ?? null;
}

/**
 * Craft `name` (Voyager's craftItem): `count` is how many times the recipe is made. Uses a crafting table within
 * 32 blocks, or places one from the inventory when the recipe needs it.
 */
export async function craftItem(bot: Bot, name: string, count = 1): Promise<{ crafted: number; item: string }> {
  const label = `craftItem(${who(bot)})`;
  const id = itemIdOf(bot, name, 'craftItem');
  let table: Block | null = null;
  let recipe = bot.recipesFor(id, null, 1, null)[0];
  if (!recipe) {
    table = await nearbyStation(bot, 'crafting_table', label);
    if (table) recipe = bot.recipesFor(id, null, 1, table)[0];
  }
  if (!recipe) {
    const any = bot.recipesAll(id, null, true)[0];
    const needs = any
      ? (any.delta ?? []).filter((d) => d.count < 0).map((d) => `${-d.count} ${bot.registry.items[d.id]?.name ?? d.id}`).join(', ')
      : '';
    throw new HelperError(
      `${label}: cannot craft ${bareName(name)}` +
        (any ? ` — one craft needs ${needs}${any.requiresTable && !table ? ' and a crafting_table' : ''}` : ' (no recipe exists)'),
    );
  }
  try {
    await windowOperation(bot as unknown as WindowBot, () => bot.craft(recipe, count, table ?? undefined));
  } catch (e) {
    passControl(e);
    throw new HelperError(`${label}: ${(e as Error).message} (crafting ${count} × ${bareName(name)})`);
  }
  return { crafted: count, item: bareName(name) };
}

/** Smelt `count` items in a furnace within 32 blocks (or placed from the inventory), fuelled with `fuelName`. */
export async function smeltItem(bot: Bot, itemName: string, fuelName: string, count = 1): Promise<{ smelted: number }> {
  const label = `smeltItem(${who(bot)})`;
  const input = itemIdOf(bot, itemName, 'smeltItem');
  const fuel = itemIdOf(bot, fuelName, 'smeltItem');
  if (countItem(bot, itemName) < count) throw new HelperError(`${label}: only ${countItem(bot, itemName)} ${bareName(itemName)} in the inventory, ${count} asked`);
  const block = await nearbyStation(bot, 'furnace', label);
  if (!block) throw new HelperError(`${label}: no furnace within 32 blocks and none in the inventory`);
  const fuelCount = ['coal', 'charcoal'].includes(bareName(fuelName)) ? Math.ceil(count / 8) : count;
  if (countItem(bot, fuelName) < fuelCount) throw new HelperError(`${label}: ${fuelCount} ${bareName(fuelName)} needed, ${countItem(bot, fuelName)} in the inventory`);
  let smelted = 0;
  try {
    await windowOperation(bot as unknown as WindowBot, async () => {
      const furnace = await bot.openFurnace(block);
      try {
        await furnace.putFuel(fuel, null, fuelCount);
        await furnace.putInput(input, null, count);
        const deadline = Date.now() + count * 12_000 + 5_000;
        while (smelted < count && Date.now() < deadline) {
          await sleepMs(1_000);
          if (furnace.outputItem()) {
            const out = await furnace.takeOutput();
            smelted += out?.count ?? 0;
          }
        }
      } finally {
        furnace.close();
      }
    });
  } catch (e) {
    passControl(e);
    throw new HelperError(`${label}: ${(e as Error).message} (smelted ${smelted}/${count})`);
  }
  if (smelted === 0) throw new HelperError(`${label}: nothing came out of the furnace at ${fmt(block.position)}`);
  return { smelted };
}

type Items = Record<string, number> | Array<{ name: string; count: number }> | string[];

function itemList(items: Items): Array<{ name: string; count: number | null }> {
  if (Array.isArray(items)) {
    return items.map((it) => (typeof it === 'string' ? { name: bareName(it), count: null } : { name: bareName(it.name), count: it.count }));
  }
  return Object.entries(items).map(([name, count]) => ({ name: bareName(name), count }));
}

async function withChest<T>(bot: Bot, chestPosition: PosLike, label: string, fn: (chest: Awaited<ReturnType<Bot['openContainer']>>) => Promise<T>): Promise<T> {
  const pos = toVec3(chestPosition, label).floored();
  const block = bot.blockAt(pos);
  if (!block) throw new HelperError(`${label}: no block at ${fmt(pos)} (chunk not loaded?)`);
  if (!/chest|barrel|shulker_box/.test(block.name)) throw new HelperError(`${label}: ${fmt(pos)} is ${block.name}, not a chest`);
  if (bot.entity.position.distanceTo(pos) > 3.5) await goTo(bot, pos, 2);
  try {
    return await windowOperation(bot as unknown as WindowBot, async () => {
      const chest = await bot.openContainer(block);
      try {
        return await fn(chest);
      } finally {
        chest.close();
      }
    });
  } catch (e) {
    passControl(e);
    throw e instanceof HelperError ? e : new HelperError(`${label}: ${(e as Error).message} at ${fmt(pos)}`);
  }
}

/** Put items in a chest: `{ cobblestone: 64 }` or `['cobblestone', 'dirt']` (all of each). */
export async function depositItemIntoChest(bot: Bot, chestPosition: PosLike, itemsToDeposit: Items): Promise<{ deposited: Record<string, number> }> {
  const label = `depositItemIntoChest(${who(bot)})`;
  const deposited: Record<string, number> = {};
  await withChest(bot, chestPosition, label, async (chest) => {
    for (const { name, count } of itemList(itemsToDeposit)) {
      const have = countItem(bot, name);
      const n = Math.min(have, count ?? have);
      if (n <= 0) continue;
      await chest.deposit(itemIdOf(bot, name, 'depositItemIntoChest'), null, n);
      deposited[name] = n;
    }
  });
  return { deposited };
}

/** Take items from a chest: `{ iron_ingot: 8 }`. Takes what is there, up to each count. */
export async function getItemFromChest(bot: Bot, chestPosition: PosLike, itemsToGet: Items): Promise<{ taken: Record<string, number> }> {
  const label = `getItemFromChest(${who(bot)})`;
  const taken: Record<string, number> = {};
  await withChest(bot, chestPosition, label, async (chest) => {
    for (const { name, count } of itemList(itemsToGet)) {
      const inChest = chest.containerItems().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
      const n = Math.min(inChest, count ?? inChest);
      if (n <= 0) continue;
      await chest.withdraw(itemIdOf(bot, name, 'getItemFromChest'), null, n);
      taken[name] = n;
    }
  });
  return { taken };
}

/** What a chest holds: `{ name: count }`. */
export async function checkItemInsideChest(bot: Bot, chestPosition: PosLike): Promise<Record<string, number>> {
  const label = `checkItemInsideChest(${who(bot)})`;
  return withChest(bot, chestPosition, label, async (chest) => {
    const out: Record<string, number> = {};
    for (const it of chest.containerItems()) out[it.name] = (out[it.name] ?? 0) + it.count;
    return out;
  });
}

// -- inventory -------------------------------------------------------------------------------------------------

/** Equip an item by id (`"_sword"` picks any sword, the best one first). */
export async function equip(bot: Bot, name: string, destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet' = 'hand'): Promise<{ equipped: string }> {
  const n = bareName(name);
  const items = bot.inventory.items();
  const pick = n.startsWith('_') || n.endsWith('_')
    ? items.filter((i) => i.name.includes(n)).sort((a, b) => toolRank(b.name) - toolRank(a.name))[0]
    : items.find((i) => i.name === n);
  if (!pick) throw new HelperError(`equip(${who(bot)}): no ${n} in the inventory`);
  try {
    await bot.equip(pick, destination);
  } catch (e) {
    passControl(e);
    throw new HelperError(`equip(${who(bot)}): ${(e as Error).message}`);
  }
  return { equipped: pick.name };
}

function toolRank(name: string): number {
  return ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].findIndex((m) => name.startsWith(m));
}

const BANNED_FOOD = new Set(['rotten_flesh', 'pufferfish', 'chorus_fruit', 'poisonous_potato', 'spider_eye']);

/** Eat the most nourishing safe food in the inventory. */
export async function eat(bot: Bot): Promise<{ ate: string }> {
  const foods = bot.registry.foodsByName ?? {};
  const best = bot.inventory
    .items()
    .filter((i) => foods[i.name] && !BANNED_FOOD.has(i.name))
    .sort((a, b) => (foods[b.name]?.foodPoints ?? 0) - (foods[a.name]?.foodPoints ?? 0))[0];
  if (!best) throw new HelperError(`eat(${who(bot)}): no food in the inventory`);
  try {
    await bot.equip(best, 'hand');
    await bot.consume();
  } catch (e) {
    passControl(e);
    throw new HelperError(`eat(${who(bot)}): ${(e as Error).message}`);
  }
  return { ate: best.name };
}

/** Walk onto dropped items within `radius` (gap E: dig drops land out of pickup range). */
export async function pickupDrops(bot: Bot, radius = 8, opts: { timeoutMs?: number } = {}): Promise<{ picked: number }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let picked = 0;
  for (let i = 0; i < 32 && Date.now() < deadline; i++) {
    const drop = nearestEntity(bot, (e) => e.name === 'item', radius);
    if (!drop) break;
    try {
      await goTo(bot, drop.position, 0.5);
      picked++;
    } catch (e) {
      passControl(e);
      log(bot, `pickupDrops: ${(e as Error).message}`);
      break;
    }
    await sleepMs(250);
  }
  return { picked };
}

// -- entities and combat ---------------------------------------------------------------------------------------

/**
 * The nearest entity passing `filter` (a function, or an entity name like "zombie") within `maxDistance`. Distances
 * are from the bot, or from `opts.from` when given (the commander's position: "the threat nearest to the player I
 * defend"). A null `from` means the bot.
 */
export function nearestEntity(
  bot: Bot,
  filter: ((e: Entity) => boolean) | string,
  maxDistance = 32,
  opts: { from?: PosLike | null } = {},
): Entity | null {
  const test = typeof filter === 'string' ? (e: Entity) => e.name === bareName(filter) || e.username === filter : filter;
  const me = bot.entity;
  const from = opts.from ? toVec3(opts.from, 'nearestEntity from') : me.position;
  let best: Entity | null = null;
  let bestD = maxDistance;
  for (const e of Object.values(bot.entities)) {
    if (!e || e === me || !e.position || !e.isValid) continue;
    const d = e.position.distanceTo(from);
    if (d > bestD) continue;
    let ok = false;
    try {
      ok = !!test(e);
    } catch {
      ok = false;
    }
    if (ok) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

/** Hostile mobs (zombies, skeletons, creepers, slimes, phantoms…). */
export function isHostile(bot: Bot, e: Entity): boolean {
  if (e.type === 'hostile') return true;
  const data = e.name ? (bot.registry.entitiesByName[e.name] as { category?: string } | undefined) : undefined;
  return data?.category === 'Hostile mobs';
}

/** The nearest hostile mob; `opts.from` as in nearestEntity, `opts.filter` narrows further (e.g. not yet taken). */
export function nearestHostile(
  bot: Bot,
  maxDistance = 16,
  opts: { from?: PosLike | null; filter?: (e: Entity) => boolean } = {},
): Entity | null {
  const more = opts.filter;
  return nearestEntity(bot, (e) => isHostile(bot, e) && (!more || !!more(e)), maxDistance, { from: opts.from });
}

/** Keep a fight near a point: `center()` (null = no leash right now) and how far from it. */
export interface Leash {
  center: () => PosLike | null | undefined;
  radius: number;
}

/** How much farther than the leash radius the fighter itself may be (it stands next to a target at the edge). */
export const LEASH_SLACK = 4;

/** Why a fight should stop now, or null: the target left the leash, the fighter strayed, or `until()` said so. */
function breakOff(bot: Bot, entity: Entity, opts: { leash?: Leash; until?: () => boolean }): 'leash' | 'until' | null {
  if (opts.until && opts.until()) return 'until';
  const c = opts.leash?.center();
  if (opts.leash && c) {
    const center = toVec3(c, 'attack leash center');
    if (entity.position.distanceTo(center) > opts.leash.radius) return 'leash';
    if (bot.entity.position.distanceTo(center) > opts.leash.radius + LEASH_SLACK) return 'leash';
  }
  return null;
}

/**
 * Fight an entity in melee (mineflayer-pvp) until it dies, is gone, or `timeoutMs`. Equips the best sword/axe first.
 * A guard must not chase one zombie across the map while the player it defends is attacked: with `opts.leash` it
 * breaks off once the target is more than `radius` from `center()`, or the bot itself more than radius +
 * LEASH_SLACK; `opts.until()` returning true breaks off too. Both are checked before the first swing and every
 * 200 ms; `brokeOff` says which one ended the fight.
 */
export async function attack(
  bot: Bot,
  entity: Entity | null | undefined,
  opts: { timeoutMs?: number; leash?: Leash; until?: () => boolean } = {},
): Promise<{ killed: boolean; brokeOff?: 'leash' | 'until' }> {
  const label = `attack(${who(bot)})`;
  if (!entity) throw new HelperError(`${label}: no target (null)`);
  if (opts.leash && !(opts.leash.radius >= 0)) throw new HelperError(`${label}: leash.radius must be a number ≥ 0, got ${safeJson(opts.leash.radius)}`);
  let brokeOff: 'leash' | 'until' | null;
  try {
    // Before the first swing, outside the try below: pvp.stop() would also clear whatever goal the bot follows.
    brokeOff = breakOff(bot, entity, opts);
  } catch (e) {
    passControl(e);
    throw new HelperError(`${label}: ${(e as Error).message}`);
  }
  if (brokeOff) return { killed: false, brokeOff };
  const weapon = bot.inventory.items().filter((i) => /_sword$|_axe$/.test(i.name)).sort((a, b) => toolRank(b.name) - toolRank(a.name))[0];
  try {
    if (weapon && bot.heldItem?.name !== weapon.name) await bot.equip(weapon, 'hand');
    await bot.pvp.attack(entity);
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    while ((entity as { isValid?: boolean }).isValid && Date.now() < deadline) {
      await sleepMs(200);
      if (!bot.pvp.target) break; // pvp gave up (out of reach for too long)
      brokeOff = breakOff(bot, entity, opts);
      if (brokeOff) break;
    }
  } catch (e) {
    passControl(e);
    throw new HelperError(`${label}: ${(e as Error).message} against ${entity.name ?? entity.username ?? 'entity'} at ${fmt(entity.position)}`);
  } finally {
    try {
      await bot.pvp.stop();
    } catch {
      /* left */
    }
  }
  const killed = !(entity as { isValid?: boolean }).isValid;
  return brokeOff && !killed ? { killed, brokeOff } : { killed };
}

/** Voyager's killMob: the nearest `mobName` within 32 blocks, fought until dead or `timeout` seconds. */
export async function killMob(bot: Bot, mobName: string, timeout = 300): Promise<{ killed: boolean }> {
  const mob = nearestEntity(bot, bareName(mobName), 32);
  if (!mob) throw new HelperError(`killMob(${who(bot)}): no ${bareName(mobName)} within 32 blocks of ${fmt(bot.entity?.position)}`);
  const r = await attack(bot, mob, { timeoutMs: timeout * 1000 });
  if (r.killed) await pickupDrops(bot, 6, { timeoutMs: 5_000 }).catch((e) => passControl(e));
  return r;
}

/** How long `shoot` waits for hawkEye's arrow: its draw is 1.2 s (bow), plus a tick or two for the inventory update. */
export const SHOT_WAIT_MS = { bow: 1_450, crossbow: 1_900 } as const;
/** How often `shoot` looks at the arrow count while it waits. */
export const SHOT_POLL_MS = 50;

/**
 * Shoot once at an entity with a bow (or crossbow): aims with hawkEye (gravity and target motion), equips the
 * weapon, needs arrows. Resolves as soon as an arrow has left (the arrow count drops: ~1.25 s for a bow), so an
 * archer can pick its next target at once.
 */
export async function shoot(bot: Bot, entity: Entity | null | undefined, opts: { weapon?: 'bow' | 'crossbow' } = {}): Promise<{ shot: true }> {
  const label = `shoot(${who(bot)})`;
  if (!entity) throw new HelperError(`${label}: no target (null)`);
  const weapon = opts.weapon ?? 'bow';
  const item = bot.inventory.items().find((i) => i.name === weapon);
  if (!item) throw new HelperError(`${label}: no ${weapon} in the inventory`);
  const arrows = (): number => countItem(bot, 'arrow') + countItem(bot, 'spectral_arrow') + countItem(bot, 'tipped_arrow');
  const before = arrows();
  if (before === 0) throw new HelperError(`${label}: no arrows`);
  const gone = (): boolean => arrows() < before;
  /** Poll the arrow count until one has left or `ms` ran out. */
  const waitArrow = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!gone() && Date.now() < deadline) await sleepMs(Math.min(SHOT_POLL_MS, Math.max(1, deadline - Date.now())));
    return gone();
  };
  const hawk = (bot as unknown as { hawkEye?: { oneShot?: (t: Entity, w: string) => void; stop?: () => void } }).hawkEye;
  const aim = async (): Promise<void> => {
    // A manual aim: a little above the target, for the drop over the distance.
    const d = bot.entity.position.distanceTo(entity.position);
    await bot.lookAt(entity.position.offset(0, (entity.height ?? 1.8) * 0.8 + d * 0.02, 0), true);
  };
  try {
    if (bot.heldItem?.name !== weapon) await bot.equip(item, 'hand');
    // hawkEye aims for gravity and the target's motion, but when it finds no clear trajectory it silently fires
    // nothing and keeps the bow drawn (found live: an archer "shot" for a minute through leaves without using an
    // arrow, docs/29 §16).
    if (hawk?.oneShot) {
      hawk.oneShot(entity, weapon);
      if (await waitArrow(SHOT_WAIT_MS[weapon])) return { shot: true };
      // Still drawn with no trajectory: aim by hand, then stop it (stopping releases the drawn bow, at our aim).
      await aim();
      hawk.stop?.();
      if (await waitArrow(300)) return { shot: true };
    }
    // A manual shot: aim, draw, release.
    await aim();
    bot.activateItem();
    await sleepMs(1_100);
    bot.deactivateItem();
    await waitArrow(500);
  } catch (e) {
    passControl(e);
    throw new HelperError(`${label}: ${(e as Error).message} at ${entity.name ?? entity.username ?? 'entity'} ${fmt(entity.position)}`);
  }
  if (!gone()) {
    throw new HelperError(
      `${label}: no arrow left the bow at ${entity.name ?? entity.username ?? 'entity'} ${fmt(entity.position)} from ${fmt(bot.entity.position)} (no clear line of fire? move closer or into the open)`,
    );
  }
  return { shot: true };
}

/** Close a window left open by a script's own window code (R1). */
export async function closeWindow(bot: Bot): Promise<void> {
  await closeStrayWindow(bot as unknown as WindowBot);
}

/** The helpers by name, as the scope hands them in (blockKey and isFriend are added per order). */
export const HELPERS = {
  mineBlock,
  craftItem,
  smeltItem,
  placeItem,
  killMob,
  exploreUntil,
  getItemFromChest,
  depositItemIntoChest,
  checkItemInsideChest,
  goTo,
  follow,
  attack,
  shoot,
  equip,
  eat,
  pickupDrops,
  findBlock,
  nearestEntity,
  nearestHostile,
} as const;
