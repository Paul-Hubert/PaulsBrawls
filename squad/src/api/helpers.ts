// The helpers: scope globals every command can call (docs/29 §5.2). Voyager's primitives under Voyager's names
// and signatures (mineBlock, craftItem, smeltItem, placeItem, killMob, exploreUntil, getItemFromChest,
// depositItemIntoChest, checkItemInsideChest), plus movement, combat and lookup helpers, and the formation helpers
// of orders bound to items (lookDir, lineSlots, groundAt, faceYaw, raiseShield, entityOf; docs/29 §5.4). The
// hard-won fixes come from Eden's stock skills (copied): hops of ≤ 40 blocks (R7), window safety (R1–R3), numeric
// ids for recipesFor (gap C), drops picked up by walking onto them (gap E).
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
import { GoalFollowOffset, slotStandable, type FollowOffset } from '../bots/follow-goal';
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
 * many followers do not all stand in the same block. While nobody could stand at that slot (the commander is on a
 * ladder, or at the edge of a drop), the bot follows the entity itself, at `range`, until the slot is open again.
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
  /** The offset to follow at now: none while the slot is in the air or in a wall. */
  const slot = (): FollowOffset | null => (offset && slotStandable(real, entity, offset) ? offset : null);
  let want = slot();
  const current = real.pathfinder?.goal as { entity?: unknown; rangeSq?: number } | null | undefined;
  let goal: unknown;
  const setFollowGoal = (): void => {
    goal = want ? new GoalFollowOffset(entity, range, want) : new goals.GoalFollow(entity, range);
    bot.pathfinder.setGoal(goal as never, true);
    followKept.set(real, { goal });
  };
  if (kept && current === kept.goal && current instanceof goals.GoalFollow && current.entity === entity && current.rangeSq === range * range && sameOffset(current, want)) {
    goal = current;
    bot.pathfinder.isMoving(); // a guarded call: the lease is checked here as setGoal would have
  } else {
    setFollowGoal();
  }
  try {
    const deadline = opts.untilMs !== undefined ? Date.now() + opts.untilMs : Infinity;
    while (Date.now() < deadline) {
      if (o && !o.alive) break;
      if (!(entity as { isValid?: boolean }).isValid) break;
      await sleepMs(Math.min(250, Math.max(0, deadline - Date.now())));
      bot.pathfinder.isMoving(); // a guarded call: throws BotLeftError once the bot is no longer this order's
      if (offset && (o?.alive ?? true) && (want !== null) !== (slot() !== null)) {
        // The slot opened or closed (the commander stepped off the ladder, or onto it): switch goals.
        want = want ? null : offset;
        setFollowGoal();
      }
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
 * `bot.look(…, true)` only sets the bot's yaw/pitch: the look packet goes out with the next physics tick (50 ms). A
 * release sent at once flew at the old aim, so a hand-aimed release waits this long after the look.
 */
export const LOOK_SETTLE_MS = 60;

/** A live entity (prismarine-entity always has `isValid`), as opposed to a position, a block or a snapshot ref. */
function isLiveEntity(t: unknown): t is Entity {
  return !!t && typeof t === 'object' && !Array.isArray(t) && 'isValid' in t && !!(t as { position?: unknown }).position;
}

/**
 * Shoot once with a bow (or crossbow) at an entity, or at a position (a volley on the ground): aims with hawkEye
 * (gravity, and an entity's motion), equips the weapon, needs arrows. Resolves as soon as an arrow has left (the
 * arrow count drops: ~1.25 s for a bow), so an archer can pick its next target at once.
 *
 * A position goes to hawkEye as `{ position, isValid: true }` (a target without `type` is a point to it). hawkEye's
 * block check raycasts every step of its arc, so a point on the ground can count as blocked: when it has no
 * trajectory for a position (`getMasterGrade`), the bow's pitch comes from the arrow's ballistics (bowAim) and the
 * shot is made by hand. A snapshot ref (`at.lookEntity`) is a position here: pass `entityOf(bot, ref)` for the live one.
 */
export async function shoot(bot: Bot, target: Entity | PosLike | null | undefined, opts: { weapon?: 'bow' | 'crossbow' } = {}): Promise<{ shot: true }> {
  const label = `shoot(${who(bot)})`;
  if (!target) throw new HelperError(`${label}: no target (null)`);
  const entity = isLiveEntity(target) ? target : null;
  const point = entity ? null : toVec3(target as PosLike, `${label} target`);
  const what = entity ? `${entity.name ?? entity.username ?? 'entity'} ${fmt(entity.position)}` : fmt(point);
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
  type HawkTarget = Entity | { position: Vec3; isValid: true };
  const hawk = (bot as unknown as {
    hawkEye?: { oneShot?: (t: HawkTarget, w: string) => void; stop?: () => void; getMasterGrade?: (t: HawkTarget, speed: Vec3, w: string) => unknown };
  }).hawkEye;
  const hawkTarget: HawkTarget = entity ?? { position: point as Vec3, isValid: true };
  /** Whether hawkEye has a trajectory: always tried for an entity (it moves); asked first for a position. */
  const hawkCanAim = (): boolean => {
    if (entity || !hawk?.getMasterGrade) return true;
    try {
      return !!hawk.getMasterGrade(hawkTarget, new Vec3(0, 0, 0), weapon);
    } catch (e) {
      passControl(e);
      return false;
    }
  };
  const aim = async (): Promise<void> => {
    if (entity) {
      // A manual aim: a little above the target, for the drop over the distance.
      const d = bot.entity.position.distanceTo(entity.position);
      await bot.lookAt(entity.position.offset(0, (entity.height ?? 1.8) * 0.8 + d * 0.02, 0), true);
      return;
    }
    const a = bowAim(bot.entity.position, point as Vec3);
    await bot.look(mineflayerYaw(a.yaw), mineflayerPitch(a.pitch), true);
  };
  try {
    if (bot.heldItem?.name !== weapon) await bot.equip(item, 'hand');
    // hawkEye aims for gravity and the target's motion, but when it finds no clear trajectory it silently fires
    // nothing and keeps the bow drawn (found live: an archer "shot" for a minute through leaves without using an
    // arrow, docs/29 §16).
    if (hawk?.oneShot && hawkCanAim()) {
      hawk.oneShot(hawkTarget, weapon);
      if (await waitArrow(SHOT_WAIT_MS[weapon])) return { shot: true };
      // Still drawn with no trajectory: aim by hand, then stop it (stopping releases the drawn bow, at our aim).
      await aim();
      await sleepMs(LOOK_SETTLE_MS);
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
    throw new HelperError(`${label}: ${(e as Error).message} at ${what}`);
  }
  if (!gone()) {
    throw new HelperError(`${label}: no arrow left the bow at ${what} from ${fmt(bot.entity.position)} (no clear line of fire? move closer or into the open)`);
  }
  return { shot: true };
}

// -- formations and aiming (orders bound to items, docs/29 §5.4) ------------------------------------------------
//
// YAW CONVENTION. Every helper here takes yaw as the commander's snapshot gives it (`ctx.commander.at.yaw`):
// Minecraft's degrees, 0 = south (+Z), 90 = west (−X), 180 = north (−Z), −90 = east (+X); pitch in Minecraft's
// degrees, negative = up. Mineflayer's own `bot.entity.yaw`/`pitch` are radians from another origin: faceYaw
// converts with mineflayer's formulas (lib/conversions.js, fromNotchianYaw/fromNotchianPitch).

const RAD = Math.PI / 180;

/** Float dust off (6e-17 → 0, 1.4999999999 → 1.5) and −0 → 0, so a slot on an axis is exactly on it. */
const snap = (n: number): number => Math.round(n * 1e9) / 1e9 + 0;

function degrees(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HelperError(`${what}: expected degrees (Minecraft's: 0 = south, 90 = west, as ctx.commander.at.yaw), got ${safeJson(v)}`);
  return n;
}

const euclideanMod = (a: number, b: number): number => ((a % b) + b) % b;

/** Mineflayer's yaw (radians) for a Minecraft yaw in degrees: mineflayer's fromNotchianYaw. */
export function mineflayerYaw(yaw: number): number {
  return euclideanMod(Math.PI - yaw * RAD, 2 * Math.PI);
}

/** Mineflayer's pitch (radians, positive = up) for a Minecraft pitch in degrees: mineflayer's fromNotchianPitch. */
export function mineflayerPitch(pitch: number): number {
  return euclideanMod(-pitch * RAD + Math.PI, 2 * Math.PI) - Math.PI;
}

/** The unit view vector of a yaw and pitch (the commander's convention): lookDir(0) = (0, 0, 1), lookDir(90) = (−1, 0, 0). */
export function lookDir(yaw: number, pitch = 0): Vec3 {
  const y = degrees(yaw, 'lookDir yaw') * RAD;
  const p = degrees(pitch, 'lookDir pitch') * RAD;
  return new Vec3(snap(-Math.sin(y) * Math.cos(p)), snap(-Math.sin(p)), snap(Math.cos(y) * Math.cos(p)));
}

/**
 * `count` positions on a line through `center`, perpendicular to the view `yaw`, `spacing` apart, ordered left to
 * right as the commander sees them (their right hand is −X when they face south). With `ranks` > 1 the slots are
 * filled rank by rank, Math.ceil(count / ranks) per rank, each rank centred, rank r `depth * r` blocks behind the
 * first (toward the commander). Pure: a slot keeps center's y; groundAt puts it on the ground.
 */
export function lineSlots(center: PosLike, yaw: number, count: number, opts: { spacing?: number; ranks?: number; depth?: number } = {}): Vec3[] {
  const c = toVec3(center, 'lineSlots center');
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const spacing = Number(opts.spacing ?? 1.5);
  const depth = Number(opts.depth ?? 2);
  const ranks = Math.max(1, Math.floor(Number(opts.ranks ?? 1) || 1));
  if (!Number.isFinite(spacing) || !Number.isFinite(depth)) throw new HelperError(`lineSlots: spacing and depth must be numbers, got ${safeJson(opts)}`);
  const fwd = lookDir(yaw);
  const right = lookDir(degrees(yaw, 'lineSlots yaw') + 90);
  const per = Math.ceil(n / ranks);
  const out: Vec3[] = [];
  for (let r = 0; out.length < n; r++) {
    const inRank = Math.min(per, n - out.length);
    for (let i = 0; i < inRank; i++) {
      const side = (i - (inRank - 1) / 2) * spacing;
      out.push(new Vec3(snap(c.x + right.x * side - fwd.x * depth * r), c.y, snap(c.z + right.z * side - fwd.z * depth * r)));
    }
  }
  return out;
}

/** Blocks nobody should stand in although nothing stops the body there. */
const HARMFUL = new Set(['lava', 'fire', 'soul_fire', 'sweet_berry_bush', 'powder_snow', 'cobweb', 'wither_rose']);

/**
 * The feet position (the block's centre, x + 0.5 and z + 0.5) nearest `pos.y` in pos's column where the feet and
 * head blocks are open and the block under them is solid, searched `up` blocks above and `down` below; null when
 * there is none or the chunk is not loaded. A formation slot goes through it, so nobody is sent into a wall or the air.
 */
export function groundAt(bot: Bot, pos: PosLike, opts: { up?: number; down?: number } = {}): Vec3 | null {
  const p = toVec3(pos, 'groundAt');
  const x = Math.floor(p.x);
  const z = Math.floor(p.z);
  const y0 = Math.floor(p.y);
  const up = Math.max(0, Math.floor(opts.up ?? 3));
  const down = Math.max(0, Math.floor(opts.down ?? 4));
  const cache = new Map<number, { name: string; boundingBox: string } | null>();
  const at = (y: number): { name: string; boundingBox: string } | null => {
    if (!cache.has(y)) cache.set(y, (bot.blockAt(new Vec3(x, y, z)) as { name: string; boundingBox: string } | null) ?? null);
    return cache.get(y) ?? null;
  };
  if (at(y0) === null) return null; // not loaded (or outside the world)
  const open = (b: { name: string; boundingBox: string }): boolean => b.boundingBox === 'empty' && !HARMFUL.has(b.name);
  // Nearest pos.y first; between two equally near, the lower one (the ground under a canopy, not the leaves).
  const ys: number[] = [];
  for (let y = y0 - down; y <= y0 + up; y++) ys.push(y);
  ys.sort((a, b) => Math.abs(a - p.y) - Math.abs(b - p.y) || a - b);
  for (const y of ys) {
    const below = at(y - 1);
    const feet = at(y);
    const head = at(y + 1);
    if (below && feet && head && open(feet) && open(head) && below.boundingBox === 'block' && !HARMFUL.has(below.name)) return new Vec3(x + 0.5, y, z + 0.5);
  }
  return null;
}

/** Turn the bot to a yaw and pitch in the commander's convention (faceYaw(bot, ctx.commander.at.yaw): where they looked). */
export async function faceYaw(bot: Bot, yaw: number, pitch = 0): Promise<{ yaw: number; pitch: number }> {
  const y = degrees(yaw, `faceYaw(${who(bot)}) yaw`);
  const p = degrees(pitch, `faceYaw(${who(bot)}) pitch`);
  try {
    await bot.look(mineflayerYaw(y), mineflayerPitch(p), true);
  } catch (e) {
    passControl(e);
    throw new HelperError(`faceYaw(${who(bot)}): ${(e as Error).message}`);
  }
  return { yaw: y, pitch: p };
}

/** The off-hand slot of the player's inventory window (mineflayer's armorSlots['off-hand']). */
export const OFF_HAND_SLOT = 45;
/**
 * While raised, raiseShield sends the use again at most this often. Mineflayer's `usingHeldItem` is a hint only:
 * any entity_status packet (any entity's) resets it to false, so it re-sends needlessly near mobs (harmless: the
 * server ignores a use while one is held); and it stays true when the server dropped the block of an off-hand
 * shield (an axe's cooldown packet only clears it for the main-hand item), which this refresh recovers from.
 */
export const SHIELD_REASSERT_MS = 5_000;
/** Per body: when raiseShield last sent the off-hand use. */
const shieldUp = new WeakMap<object, number>();

/**
 * Raise (`on`, the default) or lower the shield. Raising puts a shield in the off-hand when it is elsewhere in the
 * inventory, then holds use with `bot.activateItem(true)` (the off-hand `use_item` packet); calling it again while
 * raised sends nothing. Lowering is `bot.deactivateItem()`. Blocking slows walking: raise it after arriving. While
 * auto-eat eats (it lowers the shield to eat), neither is sent; call it again to raise the shield after the meal.
 * Leaving an order lowers it (the abort sequence's deactivateItem).
 */
export async function raiseShield(bot: Bot, on = true): Promise<{ raised: boolean }> {
  const label = `raiseShield(${who(bot)})`;
  const real = unwrap(bot) as object;
  try {
    const eating = !!(bot as unknown as { autoEat?: { isEating?: boolean } }).autoEat?.isEating;
    if (!on) {
      const raised = shieldUp.has(real) || !!bot.usingHeldItem;
      shieldUp.delete(real);
      if (raised && !eating) bot.deactivateItem();
      return { raised: false };
    }
    const offHand = bot.inventory.slots[OFF_HAND_SLOT];
    if (offHand?.name !== 'shield') {
      const shield = bot.inventory.items().find((i) => i.name === 'shield');
      if (!shield) {
        throw new HelperError(`${label}: no shield in the off-hand or the inventory (off-hand: ${offHand?.name ?? 'empty'}, hand: ${bot.heldItem?.name ?? 'empty'})`);
      }
      await bot.equip(shield, 'off-hand');
      shieldUp.delete(real);
    }
    if (eating) return { raised: false };
    const sent = shieldUp.get(real);
    if (bot.usingHeldItem && sent !== undefined && Date.now() - sent < SHIELD_REASSERT_MS) return { raised: true };
    bot.activateItem(true);
    shieldUp.set(real, Date.now());
    return { raised: true };
  } catch (e) {
    passControl(e);
    if (e instanceof HelperError) throw e;
    throw new HelperError(`${label}: ${(e as Error).message}`);
  }
}

/** An entity as a snapshot names it: `ctx.commander.at.lookEntity`, `at.trigger.hit.entity`. */
export interface EntityRefLike {
  id?: number;
  name?: string;
  type?: string;
  username?: string;
  position?: PosLike;
}

/**
 * The live entity of a snapshot ref as this bot sees it now, or null: by `id` (the network entity id, the key of
 * `bot.entities`), else a player by `username`, else the nearest entity of that `name` within 4 blocks of the ref's
 * position. The name search is only for a ref without an id (a mod that sends none): the id is the same for every
 * client, so a ref whose id this bot lacks is dead or out of its sight, and another zombie next to where it stood is
 * not it (a target "killed" that way was replaced by its neighbour, and the fight never ended).
 */
export function entityOf(bot: Bot, ref: EntityRefLike | null | undefined): Entity | null {
  if (!ref || typeof ref !== 'object') return null;
  const live = (e: Entity | null | undefined): e is Entity => !!e && e.isValid !== false && !!e.position;
  if (typeof ref.id === 'number') {
    const e = bot.entities[ref.id];
    if (live(e)) return e;
    if (!ref.username) return null;
  }
  if (ref.username) {
    const e = bot.players[ref.username]?.entity;
    return live(e) ? e : null;
  }
  if (!ref.name || !ref.position) return null;
  const name = bareName(ref.name);
  return nearestEntity(bot, (e) => e.name === name, 4, { from: toVec3(ref.position, 'entityOf ref.position') });
}

/** An arrow's flight (Minecraft 1.21 PersistentProjectileEntity): per tick, move by v, then v × 0.99, then v.y − 0.05. */
export const ARROW = {
  /** Blocks per tick at full draw (a bow held ≥ 1 s; speed = pull × 3). */
  speed: 3,
  gravity: 0.05,
  drag: 0.99,
  /** It leaves at the shooter's eyes minus 0.1: 1.62 − 0.1 for a standing player. */
  eye: 1.52,
} as const;

/** The arrow's height (relative to where it left) when it has gone `d` blocks horizontally, or null if it never does. */
function arrowHeightAt(elevationDeg: number, d: number, speed: number): { y: number; ticks: number } | null {
  let vh = speed * Math.cos(elevationDeg * RAD);
  let vy = speed * Math.sin(elevationDeg * RAD);
  let h = 0;
  let y = 0;
  for (let t = 1; t <= 300; t++) {
    if (h + vh >= d) {
      const f = vh > 0 ? (d - h) / vh : 0;
      return { y: y + vy * f, ticks: t - 1 + f };
    }
    h += vh;
    y += vy;
    vh *= ARROW.drag;
    vy = vy * ARROW.drag - ARROW.gravity;
    if (y < -512) return null;
  }
  return null;
}

/**
 * The bow's aim to hit `to` from a bot standing at `from` (feet), in the commander's convention: yaw and pitch in
 * Minecraft degrees (pitch negative = up). The low arc: the smallest elevation whose flight passes through the point
 * (simulated tick by tick, ARROW); out of range, the elevation that gets nearest. `error` is how far above (+) or
 * below the point the arrow passes, `ticks` its flight time.
 */
export function bowAim(from: PosLike, to: PosLike, speed: number = ARROW.speed): { yaw: number; pitch: number; error: number; ticks: number } {
  const f = toVec3(from, 'bowAim from');
  const t = toVec3(to, 'bowAim to');
  const dx = t.x - f.x;
  const dz = t.z - f.z;
  const d = Math.hypot(dx, dz);
  const dy = t.y - (f.y + ARROW.eye);
  const yaw = d > 1e-9 ? Math.atan2(-dx, dz) / RAD : 0;
  if (d < 0.5) return { yaw, pitch: dy < 0 ? 90 : -90, error: 0, ticks: Math.abs(dy) / speed };
  const miss = (e: number): number => {
    const r = arrowHeightAt(e, d, speed);
    return r ? r.y - dy : -Infinity;
  };
  const result = (e: number) => {
    const r = arrowHeightAt(e, d, speed);
    return { yaw, pitch: snap(-e), error: r ? r.y - dy : -Infinity, ticks: r ? r.ticks : Infinity };
  };
  // The miss rises with the elevation up to the longest-range angle, then falls: the low arc is its first root.
  let lo = -89;
  if (miss(lo) >= 0) return result(lo);
  for (let e = -88; e <= 89; e++) {
    if (miss(e) >= 0) {
      let hi = e;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (miss(mid) >= 0) hi = mid;
        else lo = mid;
      }
      return result(hi);
    }
    lo = e;
  }
  // Out of range: the elevation that carries farthest at the point's height, falling short by `error` (negative).
  let best = 0;
  let bestReach = -Infinity;
  for (let e = -89; e <= 89; e++) {
    const r = arrowReach(e, dy, speed);
    if (r > bestReach) {
      best = e;
      bestReach = r;
    }
  }
  return { yaw, pitch: snap(-best), error: bestReach - d, ticks: Infinity };
}

/** How far (horizontally) the arrow gets before it comes down through the height `dy` (relative to where it left). */
function arrowReach(elevationDeg: number, dy: number, speed: number): number {
  let vh = speed * Math.cos(elevationDeg * RAD);
  let vy = speed * Math.sin(elevationDeg * RAD);
  let h = 0;
  let y = 0;
  for (let t = 1; t <= 300; t++) {
    if (vy < 0 && y + vy < dy) return h + (y > dy ? (vh * (y - dy)) / -vy : 0);
    h += vh;
    y += vy;
    vh *= ARROW.drag;
    vy = vy * ARROW.drag - ARROW.gravity;
  }
  return h;
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
  lookDir,
  lineSlots,
  groundAt,
  faceYaw,
  raiseShield,
  entityOf,
} as const;
