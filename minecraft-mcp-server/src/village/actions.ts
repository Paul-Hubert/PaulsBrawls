import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { logDebug } from '../logger.js';
import { benchmark } from './benchmark.js';
import { EventEntityInfo, Vec3Like } from './types.js';

/**
 * The villager action library — plain async functions over a mineflayer bot.
 *
 * This is the VILLAGE_PLAN "actions/* extraction" seam: the same primitives the
 * MCP tools wrap for the God, reimplemented as a narrow, direct-call surface
 * for the villagers (the MCP tool modules are left untouched on purpose — they
 * are God-critical). Every long-running action takes/derives a timeout and
 * throws Error with a readable message; callers (sandbox API, agent tools)
 * decide how to surface failures.
 */

const DEFAULT_MOVE_TIMEOUT_MS = 30_000;

/** prismarine-block's Block, without importing a transitive dep directly. */
type Block = NonNullable<ReturnType<Bot['blockAt']>>;

export class ActionError extends Error {}

function mcDataFor(bot: Bot): ReturnType<typeof minecraftData> {
  return minecraftData(bot.version);
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

/** One bounded pathfinder run toward a goal — no far-goal gating. */
async function gotoOnce(
  bot: Bot,
  x: number,
  y: number,
  z: number,
  range: number,
  timeoutMs: number
): Promise<void> {
  const goal = new goals.GoalNear(x, y, z, range);
  let timedOut = false;
  const gotoPromise = bot.pathfinder.goto(goal);
  const timeout = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      timedOut = true;
      reject(new ActionError(`goTo (${x},${y},${z}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    void gotoPromise.finally(() => clearTimeout(id)).catch(() => {});
  });
  try {
    await Promise.race([gotoPromise, timeout]);
  } finally {
    if (timedOut) {
      bot.pathfinder.setGoal(null);
      gotoPromise.catch(() => {});
    }
  }
}

/** A direct A* run stays under this distance; beyond it (or into unloaded
 *  terrain) we walk in hops. Pathfinder treats unloaded chunks as impassable
 *  walls, so a far/unloaded goal makes A* exhaust the whole loaded volume
 *  before timing out — hops keep every search small and load terrain as we go. */
const FAR_HOP_DISTANCE = 40;
const MAX_HOPS = 8;
const HOP_TIMEOUT_MS = 20_000;

export async function goTo(
  bot: Bot,
  x: number,
  y: number,
  z: number,
  range = 1,
  timeoutMs = DEFAULT_MOVE_TIMEOUT_MS
): Promise<void> {
  const target = new Vec3(x, y, z);
  for (let hop = 0; ; hop++) {
    const pos = bot.entity.position;
    const dist = pos.distanceTo(target);
    if (dist <= range + 0.5) return;
    const targetLoaded = bot.blockAt(target) !== null;
    if (targetLoaded && dist <= FAR_HOP_DISTANCE) {
      await gotoOnce(bot, x, y, z, range, timeoutMs);
      return;
    }
    if (hop >= MAX_HOPS) {
      throw new ActionError(
        `goTo (${x},${y},${z}): still ${Math.round(dist)} blocks away after ${MAX_HOPS} hops — too far or unreachable`
      );
    }
    // Waypoint toward the goal, inside terrain we can actually see. The loose
    // range (8) accepts "close enough" so cliffs/water at the exact waypoint
    // don't fail the hop; the final approach above uses the caller's range.
    const step = Math.min(dist, FAR_HOP_DISTANCE);
    const dir = target.minus(pos).scaled(1 / Math.max(dist, 0.001));
    const wp = pos.plus(dir.scaled(step));
    const before = pos.clone();
    await gotoOnce(bot, Math.round(wp.x), Math.round(wp.y), Math.round(wp.z), 8, Math.min(timeoutMs, HOP_TIMEOUT_MS));
    if (bot.entity.position.distanceTo(before) < 2) {
      throw new ActionError(
        `goTo (${x},${y},${z}): no progress from (${Math.floor(before.x)},${Math.floor(before.y)},${Math.floor(before.z)}) — path blocked`
      );
    }
  }
}

export function stopMoving(bot: Bot): void {
  // pathfinder.stop() sets an internal stopPathing flag. When the very next
  // setGoal() fires (inside goto()), resetPath() sees stopPathing=true, calls
  // the internal stop(), and emits path_stop — immediately rejecting the new
  // goto Promise before navigation can start. Use setGoal(null) instead: it
  // preempts any active navigation via GoalChanged (benign per
  // isBenignPreemption) without leaving stopPathing set.
  bot.pathfinder.setGoal(null);
}

/**
 * Best-effort abort of every plugin-driven task that can outlive a timed-out
 * action: a withTimeout() rejection abandons the promise but pvp/collectblock
 * keep driving the bot, and the next action then fights them for the controls
 * ("Path was stopped before it could be completed" cascades). Call this after
 * any action timeout so the bot is inert before the chain moves on.
 */
export async function abortActiveTasks(bot: Bot): Promise<void> {
  // 1) Empty the collectblock target queue FIRST. An abandoned collectAll loop
  //    re-issues pathfinder goals for leftover targets whenever its current
  //    await settles — GoalChanged-killing the NEXT action. cancelTask() alone
  //    does NOT clear targets (and hangs on 'collectBlock_finished' if the
  //    zombie is parked in a dig/pickup wait); with the queue empty it resolves
  //    immediately and the zombie loop exits on its next iteration.
  // `targets` is typed private in CollectBlock but is the only handle on the
  // leaked queue — hence the unknown-cast.
  const collect = (bot as unknown as {
    collectBlock?: { targets?: { clear?: () => void }; cancelTask?: (cb?: (err?: Error) => void) => void };
  }).collectBlock;
  try { collect?.targets?.clear?.(); } catch { /* best-effort */ }
  try { collect?.cancelTask?.(() => { /* ignore */ }); } catch { /* best-effort */ }
  try { void bot.pvp?.stop(); } catch { /* best-effort */ }
  // 2) stop() THEN setGoal(null). stop() only arms a stopPathing flag; on an
  //    idle pathfinder nothing consumes it and the NEXT setGoal self-cancels
  //    (PathStopped — which collectblock swallows into a silent no-op
  //    "success"). setGoal(null) consumes the flag synchronously via
  //    resetPath → internal stop() → path_stop, and rejects any pending goto
  //    (GoalChanged) so nothing is left mid-flight.
  try { bot.pathfinder.stop(); } catch { /* best-effort */ }
  try { bot.pathfinder.setGoal(null); } catch { /* best-effort */ }
  // 3) A zombie chest op may have left a container window open. An open window
  //    hijacks EVERY subsequent clickWindow (mineflayer routes clicks to
  //    bot.currentWindow regardless of caller intent) — crafts then free-run
  //    against the wrong window and the server crafts nothing.
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch { /* best-effort */ }
  // 4) goto() defers its rejections by a macrotask ("let pathfinder cleanup")
  //    — let those land before the next action takes the controls.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Run away from a position: pick a point `distance` blocks directly away and path there. */
export async function flee(bot: Bot, from: Vec3Like, distance = 16): Promise<void> {
  const pos = bot.entity.position;
  let dx = pos.x - from.x;
  let dz = pos.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) {
    // Threat is on top of us — pick a deterministic-ish direction.
    dx = 1;
    dz = 0;
  } else {
    dx /= len;
    dz /= len;
  }
  const tx = Math.round(pos.x + dx * distance);
  const tz = Math.round(pos.z + dz * distance);
  await goTo(bot, tx, Math.round(pos.y), tz, 3, 15_000);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export async function digBlock(bot: Bot, x: number, y: number, z: number): Promise<string> {
  const target = bot.blockAt(new Vec3(x, y, z));
  if (!target || target.name === 'air') throw new ActionError(`no block to dig at (${x},${y},${z})`);
  if (bot.entity.position.distanceTo(target.position) > 4.5) {
    await goTo(bot, x, y, z, 3);
  }
  if (!bot.canDigBlock(target)) throw new ActionError(`cannot dig ${target.name} at (${x},${y},${z})`);
  const name = target.name;
  await bot.dig(target);
  return name;
}

/** Blocks a placement may overwrite. Explicit list — `includes('grass')` used
 *  to match solid `grass_block` too, green-lighting impossible placements. */
const REPLACEABLE = new Set(['air', 'water', 'short_grass', 'tall_grass', 'grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'seagrass']);

export async function placeBlock(bot: Bot, itemName: string, x: number, y: number, z: number): Promise<void> {
  const item = bot.inventory.items().find((it) => it.name === itemName);
  if (!item) throw new ActionError(`no ${itemName} in inventory`);

  const placePos = new Vec3(x, y, z);
  const targetBlock = bot.blockAt(placePos);
  if (targetBlock && !REPLACEABLE.has(targetBlock.name)) {
    throw new ActionError(`(${x},${y},${z}) is occupied by ${targetBlock.name}`);
  }
  if (bot.entity.position.distanceTo(placePos) > 4.5) {
    await goTo(bot, x, y, z, 3);
  }
  await bot.equip(item, 'hand');

  const countOf = (): number =>
    bot.inventory.items().filter((it) => it.name === itemName).reduce((s, it) => s + it.count, 0);
  const before = countOf();
  // mineflayer's placeBlock can throw its confirmation timeout AFTER the
  // server placed the block (item consumed, block in the world) — seen live:
  // "no reference face" after 5.1s while the crafting table left the
  // inventory. The real verdict: the target stopped being replaceable AND an
  // item left the stack.
  const placedForReal = (): boolean => {
    const now = bot.blockAt(placePos);
    return Boolean(now && !REPLACEABLE.has(now.name)) && countOf() < before;
  };

  const faces = [
    new Vec3(0, -1, 0),
    new Vec3(0, 1, 0),
    new Vec3(0, 0, -1),
    new Vec3(0, 0, 1),
    new Vec3(-1, 0, 0),
    new Vec3(1, 0, 0),
  ];
  for (const face of faces) {
    const reference = bot.blockAt(placePos.plus(face));
    if (!reference || reference.name === 'air' || reference.name === 'water') continue;
    try {
      await bot.lookAt(placePos, true);
      await bot.placeBlock(reference, face.scaled(-1));
      return;
    } catch {
      await bot.waitForTicks(2);
      if (placedForReal()) return; // client-side error, server-side success
      continue;
    }
  }
  if (placedForReal()) return;
  throw new ActionError(`no reference face to place ${itemName} at (${x},${y},${z})`);
}

const TILLABLE = new Set(['grass_block', 'dirt', 'dirt_path', 'coarse_dirt', 'rooted_dirt']);

/** Turn grass/dirt into farmland with a hoe from the inventory. */
export async function tillBlock(bot: Bot, x: number, y: number, z: number): Promise<void> {
  const target = bot.blockAt(new Vec3(x, y, z));
  if (!target) throw new ActionError(`no block at (${x},${y},${z})`);
  if (target.name === 'farmland') return; // already done — idempotent for replant loops
  if (!TILLABLE.has(target.name)) {
    throw new ActionError(`cannot till ${target.name} at (${x},${y},${z}) — need grass or dirt`);
  }
  const above = bot.blockAt(new Vec3(x, y + 1, z));
  if (above && above.name !== 'air') {
    throw new ActionError(`cannot till (${x},${y},${z}): blocked above by ${above.name}`);
  }
  const hoe = bot.inventory.items().find((it) => it.name.includes('hoe'));
  if (!hoe) throw new ActionError('no hoe in inventory — craft or withdraw one first');
  if (bot.entity.position.distanceTo(target.position) > 4) {
    await goTo(bot, x, y, z, 3);
  }
  await bot.equip(hoe, 'hand');
  await bot.lookAt(target.position.offset(0.5, 1, 0.5), true);
  await bot.activateBlock(target);
  const after = bot.blockAt(new Vec3(x, y, z));
  if (!after || after.name !== 'farmland') {
    throw new ActionError(`tilling (${x},${y},${z}) did not produce farmland (got ${after?.name ?? 'nothing'})`);
  }
}

/** Max growth stage per crop block — used to tag `mature` for the farm routines. */
const CROP_MAX_AGE: Record<string, number> = {
  wheat: 7,
  carrots: 7,
  potatoes: 7,
  beetroots: 3,
  nether_wart: 3,
};

export function findBlocks(bot: Bot, nameQuery: string, radius = 16, count = 16): Array<{ name: string; position: Vec3Like; mature?: boolean }> {
  const mcData = mcDataFor(bot);
  const query = nameQuery.toLowerCase();
  const ids: number[] = [];
  const exact = mcData.blocksByName[query];
  if (exact) {
    ids.push(exact.id);
  } else {
    for (const [name, block] of Object.entries(mcData.blocksByName)) {
      if (name.includes(query)) ids.push((block as { id: number }).id);
    }
  }
  if (ids.length === 0) return [];
  const positions = bot.findBlocks({ matching: ids, maxDistance: radius, count });
  return positions.flatMap((pos) => {
    const block = bot.blockAt(pos);
    if (!block) return [];
    const entry: { name: string; position: Vec3Like; mature?: boolean } = {
      name: block.name,
      position: { x: pos.x, y: pos.y, z: pos.z },
    };
    const maxAge = CROP_MAX_AGE[block.name];
    if (maxAge !== undefined) {
      try {
        const props = block.getProperties() as { age?: number | string };
        entry.mature = Number(props.age) >= maxAge;
      } catch {
        entry.mature = false;
      }
    }
    return [entry];
  });
}

// ---------------------------------------------------------------------------
// Collecting / crafting / equipment
// ---------------------------------------------------------------------------

/**
 * A log is a TRUNK log iff walking straight down its column through logs
 * reaches solid ground. Canopy/branch logs (leaves below) fail this test —
 * collectblock targets greedily by 3D distance with zero reachability checks,
 * so a canopy log 8 blocks straight up beats a trunk log 12 blocks away and
 * stalls the whole batch behind an impossible path.
 */
function isTrunkLog(bot: Bot, pos: Vec3): boolean {
  let p = pos;
  for (let i = 0; i < 12; i++) {
    const below = bot.blockAt(p.offset(0, -1, 0));
    if (!below) return false; // unloaded — don't gamble on it
    if (below.name.endsWith('_log')) {
      p = p.offset(0, -1, 0);
      continue;
    }
    return below.boundingBox === 'block';
  }
  return false;
}

export async function collectBlocks(bot: Bot, blockType: string, count = 1): Promise<number> {
  const mcData = mcDataFor(bot);
  const info = mcData.blocksByName[blockType];
  if (!info) throw new ActionError(`unknown block type: ${blockType}`);
  const wantTrunksOnly = blockType.endsWith('_log');

  const countItem = (): number =>
    bot.inventory.items().filter((it) => it.name === info.name).reduce((sum, it) => sum + it.count, 0);
  const before = countItem();

  // One block per collect() call, re-finding between iterations: one
  // unreachable target then skips instead of killing the whole batch (and a
  // timed-out batch can't leak a queue of leftover targets into the next
  // action). Failed/no-op positions are remembered and excluded.
  const skip = new Set<string>();
  let failures = 0;
  let sawOnlyCanopy = false;
  while (countItem() - before < count) {
    const positions = bot.findBlocks({ matching: info.id, maxDistance: 32, count: Math.max(count * 4, 16) });
    const candidates = positions.filter((p) => !skip.has(p.toString()));
    const reachable = wantTrunksOnly ? candidates.filter((p) => isTrunkLog(bot, p)) : candidates;
    sawOnlyCanopy = wantTrunksOnly && reachable.length === 0 && candidates.length > 0;
    if (reachable.length === 0) {
      if (countItem() - before > 0) break; // got some — report what we have
      // "visible" on purpose: findBlocks only sees loaded chunks, so absence
      // here does NOT mean the world has none — moving and retrying may help.
      throw new ActionError(
        sawOnlyCanopy
          ? `only canopy ${blockType} in reach (no trunk connected to the ground) — fell a tree from the bottom or look elsewhere`
          : `no ${blockType} visible within 32 blocks (only loaded terrain is searched — move elsewhere and retry)`
      );
    }
    const targetPos = reachable[0];
    const block = bot.blockAt(targetPos);
    if (!block) {
      skip.add(targetPos.toString());
      continue;
    }
    const beforeThis = countItem();
    try {
      await bot.collectBlock.collect(block);
    } catch (err) {
      skip.add(targetPos.toString());
      if (++failures >= 3) {
        const got = countItem() - before;
        const message = err instanceof Error ? err.message : String(err);
        if (got > 0) return got;
        throw new ActionError(`collect ${blockType} failed 3x: ${message}`);
      }
      continue;
    }
    if (countItem() === beforeThis) {
      // Silent no-op (e.g. a swallowed PathStopped) — don't retry this block forever.
      skip.add(targetPos.toString());
      if (++failures >= 3 && countItem() - before === 0) {
        throw new ActionError(`collect ${blockType}: 3 attempts mined nothing — targets look unreachable`);
      }
    }
  }
  return countItem() - before;
}

/**
 * Wait until the server's container packets go quiet (no set_slot /
 * window_items for `quietMs`, capped at `maxMs`). bot.craft resolves off its
 * own client-side simulation; the genuine server verdict only exists at the
 * packet level — window-level updateSlot events are emitted for local
 * simulated writes too, so they can't be trusted as a sync barrier. A fixed
 * tick wait can sample MID-correction-flood on a lagging server and misread
 * a craft that actually landed.
 */
async function waitForInventoryQuiescence(bot: Bot, quietMs = 150, maxMs = 1_000): Promise<void> {
  const client = (bot as unknown as {
    _client: { on(event: string, handler: () => void): void; off(event: string, handler: () => void): void };
  })._client;
  await new Promise<void>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout>;
    let capTimer: ReturnType<typeof setTimeout>;
    const done = (): void => {
      client.off('set_slot', onPacket);
      client.off('window_items', onPacket);
      clearTimeout(quietTimer);
      clearTimeout(capTimer);
      resolve();
    };
    const onPacket = (): void => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, quietMs);
    };
    client.on('set_slot', onPacket);
    client.on('window_items', onPacket);
    quietTimer = setTimeout(done, quietMs);
    capTimer = setTimeout(done, maxMs);
  });
}

export async function craftItem(bot: Bot, itemName: string, amount = 1): Promise<number> {
  const mcData = mcDataFor(bot);
  const item = mcData.itemsByName[itemName];
  if (!item) throw new ActionError(`unknown item: ${itemName}`);

  // An open container window hijacks EVERY clickWindow: mineflayer routes
  // clicks to bot.currentWindow regardless of which window the caller meant,
  // its result-slot wait matches no branch for chest types (zero awaits), and
  // the local bot.inventory view freezes — so bot.craft "succeeds" in
  // milliseconds while the server crafts nothing and shuffles chest slots.
  // Seen live (June 2026): "crafted oak_planks x16" in 30ms, zero planks.
  if (bot.currentWindow) {
    logDebug(bot.username, `craft: closing stray '${bot.currentWindow.type}' window before crafting`);
    try { bot.closeWindow(bot.currentWindow); } catch { /* best-effort */ }
    await bot.waitForTicks(1);
  }

  const tableInfo = mcData.blocksByName['crafting_table'];
  const table = tableInfo
    ? bot.findBlock({ matching: tableInfo.id, maxDistance: 16 })
    : null;

  let recipes = bot.recipesFor(item.id, null, 1, null);
  let useTable: Block | null = null;
  if (recipes.length === 0 && table) {
    recipes = bot.recipesFor(item.id, null, 1, table);
    if (recipes.length > 0) useTable = table;
  }
  if (recipes.length === 0) {
    throw new ActionError(`cannot craft ${itemName}: ${describeCraftBlocker(bot, item.id, table)}`);
  }
  const recipe = recipes[0];

  // `amount` is the number of ITEMS wanted, not recipe executions — one
  // execution can yield several (1 log → 4 planks).
  const perRun = Math.max(1, recipe.result.count);
  let runs = Math.ceil(amount / perRun);
  // Clamp to what the inventory can pay for. bot.craft simulates the window
  // clicks client-side and can report success past the real stock — the
  // server then rejects the whole sequence and NOTHING lands in the
  // inventory (seen live: 16 plank-runs asked with 4 logs → "success",
  // zero planks).
  for (const d of recipe.delta) {
    if (d.count < 0) {
      runs = Math.min(runs, Math.floor(bot.inventory.count(d.id, d.metadata ?? null) / -d.count));
    }
  }
  if (runs < 1) runs = 1; // recipesFor proved one run is affordable

  if (useTable && bot.entity.position.distanceTo(useTable.position) > 3.5) {
    await goTo(bot, useTable.position.x, useTable.position.y, useTable.position.z, 2);
  }

  const countItem = (): number =>
    bot.inventory.items().filter((it) => it.name === itemName).reduce((sum, it) => sum + it.count, 0);
  // auto-eat mutates the inventory asynchronously (it can fire mid-click-
  // sequence and corrupt the craft's slot bookkeeping) — hold it during the
  // craft and the verification window.
  const autoEat = (bot as { autoEat?: { disableAuto(): void; enableAuto(): void } }).autoEat;
  try { autoEat?.disableAuto(); } catch { /* plugin not loaded */ }
  try {
    const before = countItem();
    await bot.craft(recipe, runs, useTable ?? undefined);
    // bot.craft resolves off its own client-side simulation; wait for the
    // server's correction packets to go quiet before trusting the diff.
    await waitForInventoryQuiescence(bot);
    const crafted = countItem() - before;
    if (crafted <= 0) {
      const windowNote = bot.currentWindow
        ? ` (a '${bot.currentWindow.type}' window was open mid-craft — clicks were misrouted to it)`
        : '';
      logDebug(bot.username, `craft ${itemName} desynced: asked ${runs} run(s), inventory delta ${crafted}${windowNote}`);
      throw new ActionError(
        `craft ${itemName} desynced: the server confirmed nothing${windowNote} — re-check ingredients and retry with a smaller count`
      );
    }
    return crafted;
  } finally {
    try { autoEat?.enableAuto(); } catch { /* plugin not loaded */ }
  }
}

/** Why no recipe matched, phrased so the LLM's next move is obvious. The old
 *  blanket "need ingredients or a crafting table" once convinced a farmer he
 *  needed a crafting table to craft a crafting table. */
function describeCraftBlocker(bot: Bot, itemId: number, table: Block | null): string {
  // recipesAll ignores the inventory: use it to tell "missing ingredients"
  // apart from "needs a table". Its third arg is only truth-tested, so a
  // dummy stands in when no real table is around.
  const noTableRecipes = bot.recipesAll(itemId, null, null);
  const allRecipes = bot.recipesAll(itemId, null, (table ?? true) as unknown as Block);
  if (allRecipes.length === 0) return 'this item has no crafting recipe';
  if (noTableRecipes.length === 0 && !table) {
    return 'its recipe needs a crafting table and none stands within 16 blocks — craft one (4 planks, no table required) and place it first';
  }
  const mcData = mcDataFor(bot);
  let best: { missing: string[]; shortfall: number } | null = null;
  const singleMissing: Array<{ name: string; need: number }> = [];
  for (const recipe of allRecipes) {
    const missing: string[] = [];
    let shortfall = 0;
    let firstMissing: { name: string; need: number } | null = null;
    for (const d of recipe.delta) {
      if (d.count >= 0) continue;
      const have = bot.inventory.count(d.id, d.metadata ?? null);
      const need = -d.count;
      if (have < need) {
        const name = mcData.items[d.id]?.name ?? `item#${d.id}`;
        missing.push(`${need}x ${name} (have ${have})`);
        firstMissing = { name, need };
        shortfall += need - have;
      }
    }
    if (missing.length === 0) continue;
    if (missing.length === 1 && firstMissing) singleMissing.push(firstMissing);
    if (!best || shortfall < best.shortfall) best = { missing, shortfall };
  }
  // Variant-family collapse: when every recipe is missing one ingredient and
  // they only differ by wood/material prefix (oak_planks / cherry_planks /
  // …_planks), naming ONE variant misleads — the old message once sent a bot
  // hunting cherry wood it had never seen. Say "any kind" instead.
  if (singleMissing.length >= 2 && singleMissing.length === allRecipes.length) {
    // lastIndexOf, not indexOf: 'dark_oak_planks' must yield 'planks' like its
    // siblings, or the one dark_oak variant in every plank family (vanilla has
    // 11) silently defeats the collapse.
    const suffixOf = (n: string): string => (n.includes('_') ? n.slice(n.lastIndexOf('_') + 1) : n);
    const suffix = suffixOf(singleMissing[0].name);
    const names = new Set(singleMissing.map((m) => m.name));
    if (names.size > 1 && singleMissing.every((m) => suffixOf(m.name) === suffix)) {
      const need = Math.min(...singleMissing.map((m) => m.need));
      return `missing ingredients: ${need}x ${suffix} of ANY kind (e.g. ${singleMissing[0].name})`;
    }
  }
  return best
    ? `missing ingredients: ${best.missing.join(', ')}`
    : 'no recipe matches the current inventory';
}

export async function equipItem(bot: Bot, itemName: string): Promise<string> {
  const item = bot.inventory.items().find((it) => it.name.includes(itemName.toLowerCase()));
  if (!item) throw new ActionError(`no item matching '${itemName}' in inventory`);
  await bot.equip(item, 'hand');
  return item.name;
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

export function findEntity(bot: Bot, target: string, maxDistance = 16, villagerNames?: ReadonlySet<string>): EventEntityInfo | null {
  const needle = target.toLowerCase();
  const entity = bot.nearestEntity((candidate) => {
    if (candidate === bot.entity) return false;
    const username = (candidate as { username?: string }).username;
    if (username && username.toLowerCase() === needle) return true;
    if (target === 'player') return candidate.type === 'player';
    if (target === 'mob') return candidate.type === 'mob' || candidate.type === 'hostile';
    if (candidate.type === target) return true;
    return Boolean(candidate.name && candidate.name.toLowerCase().includes(needle));
  });
  if (!entity) return null;
  if (bot.entity.position.distanceTo(entity.position) > maxDistance) return null;
  return describeEntity(bot, entity as EntityLike, villagerNames);
}

interface EntityLike {
  id: number;
  type?: string;
  name?: string;
  username?: string;
  kind?: string;
  position: Vec3Like;
}

export function describeEntity(bot: Bot, entity: EntityLike, villagerNames?: ReadonlySet<string>): EventEntityInfo {
  const username = entity.username;
  let kind = 'other';
  if (entity.type === 'player') {
    kind = username && villagerNames?.has(username) ? 'villager' : 'player';
  } else if (typeof entity.kind === 'string') {
    if (entity.kind.toLowerCase().includes('hostile')) kind = 'hostile';
    else if (entity.kind.toLowerCase().includes('passive') || entity.kind.toLowerCase().includes('animal')) kind = 'animal';
  } else if (entity.type === 'hostile') {
    kind = 'hostile';
  }
  return {
    id: entity.id,
    name: username ?? entity.name ?? entity.type ?? 'unknown',
    kind,
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
  };
}

export function attackEntity(bot: Bot, entityId: number): void {
  const entity = bot.entities[entityId];
  if (!entity) throw new ActionError(`entity ${entityId} not found (gone?)`);
  // Fire-and-forget — mineflayer-pvp owns the engagement loop.
  void bot.pvp.attack(entity).catch(() => { /* surfaced via later observations */ });
}

export async function stopCombat(bot: Bot): Promise<void> {
  await bot.pvp.stop();
}

// ---------------------------------------------------------------------------
// Chests
// ---------------------------------------------------------------------------

const CHEST_SEARCH_RADIUS = 16;

export function isChestBlock(block: Block | null): block is Block {
  return Boolean(block && (block.name === 'chest' || block.name === 'trapped_chest' || block.name === 'barrel'));
}

/** Nearest chest-like block around a point (loaded chunks only). */
export function findChestNear(bot: Bot, point: Vec3Like, radius = CHEST_SEARCH_RADIUS): Block | null {
  const mcData = mcDataFor(bot);
  const ids = ['chest', 'trapped_chest', 'barrel']
    .map((name) => mcData.blocksByName[name]?.id)
    .filter((id): id is number => id !== undefined);
  if (ids.length === 0) return null;
  const positions = bot.findBlocks({
    point: new Vec3(point.x, point.y, point.z),
    matching: ids,
    maxDistance: radius,
    count: 1,
  });
  return positions.length > 0 ? bot.blockAt(positions[0]) : null;
}

/**
 * Resolve + open a chest. `chestPos` is a HINT, not a contract: if the exact
 * block isn't a chest (broken, never existed, stale roster, chunk not loaded),
 * we walk over to load the area, re-check, then search around the hint and
 * around the bot before giving up. A find away from the hint is reported via
 * `relocated` so callers can persist the new anchor — without this, a stale
 * roster coordinate makes banking permanently impossible even when the bot
 * places a fresh chest right next to itself.
 */
async function openChestAt(
  bot: Bot,
  chestPos: Vec3Like | null
): Promise<{ chest: Awaited<ReturnType<Bot['openContainer']>>; block: Block; relocated: boolean }> {
  let block: Block | null = null;
  let relocated = false;
  if (chestPos) {
    const hint = new Vec3(chestPos.x, chestPos.y, chestPos.z);
    block = bot.blockAt(hint);
    if (!isChestBlock(block) && bot.entity.position.distanceTo(hint) > 6) {
      // Could be an unloaded chunk lying to us — go look before concluding.
      try {
        await goTo(bot, chestPos.x, chestPos.y, chestPos.z, 3);
      } catch { /* unreachable hint — the searches below still run on what IS loaded */ }
      block = bot.blockAt(hint);
    }
    if (!isChestBlock(block)) {
      block = findChestNear(bot, chestPos) ?? findChestNear(bot, bot.entity.position);
      if (isChestBlock(block)) relocated = true;
    }
    if (!isChestBlock(block)) {
      throw new ActionError(
        `no chest at (${chestPos.x},${chestPos.y},${chestPos.z}) nor within ${CHEST_SEARCH_RADIUS} blocks of it — ` +
        `the configured chest is gone; place a new one nearby, or set_chest to where one actually stands`
      );
    }
  } else {
    block = findChestNear(bot, bot.entity.position);
    if (!isChestBlock(block)) {
      throw new ActionError(`no chest within ${CHEST_SEARCH_RADIUS} blocks of me — place one, or stand near one`);
    }
  }
  if (bot.entity.position.distanceTo(block.position) > 3.5) {
    await goTo(bot, block.position.x, block.position.y, block.position.z, 2);
  }
  const chest = await bot.openContainer(block);
  return { chest, block, relocated };
}

export async function depositToChest(
  bot: Bot,
  chestPos: Vec3Like | null,
  itemName: string,
  count: number,
  onRelocated?: (pos: Vec3Like) => void
): Promise<number> {
  const mcData = mcDataFor(bot);
  const item = mcData.itemsByName[itemName];
  if (!item) throw new ActionError(`unknown item: ${itemName}`);
  const have = bot.inventory.items().filter((it) => it.name === itemName).reduce((s, it) => s + it.count, 0);
  const toMove = Math.min(have, count);
  if (toMove === 0) throw new ActionError(`no ${itemName} in inventory`);

  const { chest, block, relocated } = await openChestAt(bot, chestPos);
  if (relocated) onRelocated?.({ x: block.position.x, y: block.position.y, z: block.position.z });
  try {
    await chest.deposit(item.id, null, toMove);
  } finally {
    chest.close();
  }
  benchmark.onDeposit(bot.username, itemName, toMove, bot);
  return toMove;
}

export async function withdrawFromChest(
  bot: Bot,
  chestPos: Vec3Like | null,
  itemName: string,
  count: number,
  onRelocated?: (pos: Vec3Like) => void
): Promise<number> {
  const mcData = mcDataFor(bot);
  const item = mcData.itemsByName[itemName];
  if (!item) throw new ActionError(`unknown item: ${itemName}`);

  const { chest, block, relocated } = await openChestAt(bot, chestPos);
  if (relocated) onRelocated?.({ x: block.position.x, y: block.position.y, z: block.position.z });
  try {
    const available = chest.containerItems().filter((it) => it.name === itemName).reduce((s, it) => s + it.count, 0);
    const toMove = Math.min(available, count);
    if (toMove === 0) throw new ActionError(`chest has no ${itemName}`);
    await chest.withdraw(item.id, null, toMove);
    benchmark.onWithdraw(bot.username, itemName, toMove, bot);
    return toMove;
  } finally {
    chest.close();
  }
}

// ---------------------------------------------------------------------------
// Terrain sanity (anchor validation)
// ---------------------------------------------------------------------------

/**
 * Find a standable y at (x,z) near the suggested y: feet + head free, solid
 * ground below. Scans outward (±scanRange) so a roster home written for a
 * previous world's ground level snaps onto the real terrain instead of
 * pointing into mid-air or solid rock. Null when the column has no footing
 * in range (or the chunk isn't loaded).
 */
export function standableYNear(bot: Bot, pos: Vec3Like, scanRange = 8): number | null {
  const solidAt = (y: number): boolean | null => {
    const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
    if (!block) return null;
    return block.boundingBox === 'block';
  };
  const standable = (y: number): boolean => {
    const ground = solidAt(y - 1);
    const feet = solidAt(y);
    const head = solidAt(y + 1);
    return ground === true && feet === false && head === false;
  };
  for (let offset = 0; offset <= scanRange; offset++) {
    for (const y of offset === 0 ? [pos.y] : [pos.y + offset, pos.y - offset]) {
      if (standable(y)) return y;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inventory helpers (used by observation + trade pre-validation)
// ---------------------------------------------------------------------------

export function inventorySummary(bot: Bot): Array<{ item: string; count: number }> {
  const totals = new Map<string, number>();
  for (const it of bot.inventory.items()) {
    totals.set(it.name, (totals.get(it.name) ?? 0) + it.count);
  }
  return Array.from(totals.entries()).map(([item, count]) => ({ item, count }));
}

export function inventoryCount(bot: Bot, itemName: string): number {
  return bot.inventory.items().filter((it) => it.name === itemName).reduce((s, it) => s + it.count, 0);
}

/**
 * Whether mineflayer's registry knows this item name. MODDED items (e.g. the
 * Gibber `coin`, really `paulsbrawls:coin`) are invisible to mineflayer —
 * they show up as 'unknown' in bot inventories — so Node-side trade
 * pre-checks must skip them and defer to the Java mod's authoritative
 * validation. On any registry failure, err toward TRUE (enforce the check),
 * which preserves the strict behavior for vanilla items.
 */
export function isRegistryItem(bot: Bot, itemName: string): boolean {
  try {
    return Boolean(mcDataFor(bot).itemsByName[itemName]);
  } catch {
    return true;
  }
}
