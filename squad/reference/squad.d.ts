// ============================================================================================================
//  SQUAD COMMAND API — the normative reference (docs/29 §5). What a command file can use, with types.
//  The author agent reads this file (MCP tool `get_api_reference`), and `check_script` typechecks a command against
//  it (checkJs), together with mineflayer's own types. Everything below is a GLOBAL in a command: no import needed.
// ============================================================================================================
//
//  A command is ONE ES module file:
//
//    export const manifest = {
//      summary: 'Défendre le commandant',          // French, one line, shown to players
//      params: { type: 'object', properties: {     // what `/bots order NAME …` accepts, positional in this order
//        radius: { type: 'integer', minimum: 1, maximum: 64, default: 16 },
//      } },
//      roles: {                                    // optional; default { all: { min: 1 } }
//        archers: { select: { hasItem: 'bow' }, min: 1, take: 'reclaim' },
//        melee:   { select: { tag: 'melee' }, take: 'free' },
//      },
//      duration: 'until-stopped',                  // or 'bounded' (default; maxMinutes, default 10)
//    };
//
//    export default async function (squad, args, ctx) {
//      …                                           // control every bot of the order at once
//      return 'Défense levée.';                    // a short French sentence, shown to the commander
//    }
//
//  Rules of the dialect:
//    • Each bot is a REAL mineflayer bot (pathfinder, pvp, collectBlock, tool, autoEat, armorManager and hawkEye
//      loaded). Prefer the helpers below: they are proven, claim their targets and throw errors with evidence.
//    • A bot leaving the order (reclaimed by another order, released, dead, disconnected) makes calls on it throw
//      BotLeftError. squad.parallel and squad.tasks handle that for you; a bare loop over squad.bots must catch it.
//    • Long-running commands loop on `while (!squad.stopped) { …; await squad.sleep(ms) }` and declare
//      duration: 'until-stopped'. A stopped order throws OrderStoppedError at its next await: let it propagate.
//    • Never block: no busy loops without an await. Use Minecraft ids ('oak_log', 'iron_ingot', 'zombie').
//    • Timers (setTimeout, setInterval, sleep), listeners added with bot.on, squad.on and ctx.commander.on are
//      removed at the end.

import type { Bot as MineflayerBot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Block } from 'prismarine-block';
import type { Vec3 as Vec3Class } from 'vec3';
import type { goals as PathfinderGoals, Movements as PathfinderMovements } from 'mineflayer-pathfinder';
import type {} from 'mineflayer-pvp';
import type {} from 'mineflayer-collectblock';
import type {} from 'mineflayer-tool';
import type {} from 'mineflayer-auto-eat';
import type {} from 'minecrafthawkeye';

declare module 'mineflayer' {
  interface Bot {
    /** mineflayer-armor-manager: equips the best armor by itself. */
    armorManager: { equipAll(): Promise<void> };
    /** Squad: the bot's tags (set by owners with /bots tag) and its role in this order. Read-only. */
    readonly tags: string[];
    readonly role: string | undefined;
  }
}

declare global {
  /** A bot of the order: a guarded, real mineflayer Bot. */
  type SquadBot = MineflayerBot;
  type Pos = Vec3Class | { x: number; y: number; z: number } | [number, number, number] | { position: { x: number; y: number; z: number } };

  // ---------------------------------------------------------------------------------------------------------
  //  The command's manifest and entry point
  // ---------------------------------------------------------------------------------------------------------

  interface SquadParam {
    type: 'string' | 'integer' | 'number' | 'boolean';
    description?: string;
    default?: string | number | boolean;
    enum?: Array<string | number | boolean>;
    minimum?: number;
    maximum?: number;
  }

  /** Which bots a role takes (AND of the clauses; an array is an OR). */
  interface SquadSelector {
    tag?: string | string[];
    /** Substring of an item id in the inventory: 'bow', '_pickaxe' (any pickaxe), 'shield'. */
    hasItem?: string | string[];
    name?: string | string[];
    not?: SquadSelector;
  }

  interface SquadRole {
    select?: SquadSelector;
    /** Fewer matching bots than `min` → the order is refused (nothing is reclaimed). Default 0. */
    min?: number;
    /** Default: every matching bot. */
    max?: number;
    /** 'free' (default): only idle bots. 'reclaim': also take bots busy on another order (they come back after). */
    take?: 'free' | 'reclaim';
  }

  interface SquadManifest {
    summary: string;
    params?: { type?: 'object'; properties?: Record<string, SquadParam>; required?: string[] };
    roles?: Record<string, SquadRole>;
    duration?: 'bounded' | 'until-stopped';
    maxMinutes?: number;
  }

  type SquadCommand = (squad: Squad, args: Record<string, any>, ctx: SquadCtx) => unknown;

  // ---------------------------------------------------------------------------------------------------------
  //  squad — the order's bots and the cooperation primitives
  // ---------------------------------------------------------------------------------------------------------

  interface ParallelResult<T> {
    bot: SquadBot;
    ok: boolean;
    value?: T;
    error?: string;
    /** The bot left the order during the call. */
    left?: boolean;
  }

  interface TaskResult<T> {
    item: unknown;
    ok: boolean;
    value?: T;
    error?: string;
    /** Name of the bot that did it (or last tried). */
    bot?: string;
  }

  interface Squad {
    /** Every bot of the order, live: bots that leave are removed, bots that join are added. */
    readonly bots: SquadBot[];
    /** The bots of each manifest role, live (roles[name] is [] when none). */
    readonly roles: Record<string, SquadBot[]>;
    /** True once the order is stopped, timed out or finished. */
    readonly stopped: boolean;
    readonly signal: AbortSignal;

    /**
     * Run fn on each bot at once. One bot failing or leaving never rejects: check result.ok. Given squad.bots or a
     * squad.roles[x] array itself (not a copy), a bot that comes back from another order (it was reclaimed) runs fn
     * again, and the call waits while a reclaimed bot can still come back: one result per run.
     */
    parallel<T>(bots: SquadBot[] | SquadBot, fn: (bot: SquadBot) => Promise<T> | T): Promise<Array<ParallelResult<T>>>;

    /**
     * Work queue: each free bot takes the next item. An item whose bot leaves goes back in the queue; a failed one
     * is retried `retries` times (default 1); bots that join mid-run pull too. One result per item, in item order.
     */
    tasks<I, T>(items: I[], fn: (bot: SquadBot, item: I, index: number) => Promise<T> | T, opts?: { bots?: SquadBot[]; retries?: number }): Promise<Array<TaskResult<T>>>;

    /** Reserve a key across ALL running orders (true if it is now yours). blockKey(pos) makes a block key. */
    claim(key: string, opts?: { ttlSeconds?: number }): boolean;
    unclaim(key: string): void;

    /** Ask for more of the commander's bots mid-run (same rules as a role); they join squad.bots and roles[as]. */
    acquire(spec: SquadRole & { as?: string }): Promise<SquadBot[]>;
    /** Let a bot go: it returns to the order it was reclaimed from, or goes idle. */
    release(bot: SquadBot): Promise<void>;

    on(event: 'joined', fn: (bot: SquadBot, role: string) => unknown): void;
    on(event: 'left', fn: (bot: SquadBot, reason: 'reclaimed' | 'released' | 'died' | 'disconnected' | 'despawned') => unknown): void;
    off(event: 'joined' | 'left', fn: (...a: any[]) => unknown): void;

    /** Resolves after ms (rejects with OrderStoppedError if the order stops first). */
    sleep(ms: number): Promise<void>;
    /** Call fn every ms until the order ends; returns a function that stops it. */
    every(ms: number, fn: () => unknown): () => void;
    /** Resolves when the order is stopped (for event-driven until-stopped commands). */
    untilStopped(): Promise<void>;
  }

  // ---------------------------------------------------------------------------------------------------------
  //  ctx — the order's context
  // ---------------------------------------------------------------------------------------------------------

  /** An entity in the commander's snapshot. `id` is the network entity id, mineflayer's key: bot.entities[id]. */
  interface SquadAtEntity {
    id?: number;
    name: string;
    /** 'player' or 'mob'. */
    type: string;
    username?: string;
    position: Vec3Class;
  }

  /** What a bound item did: a right-click ('use'), an arrow leaving the bound bow, or that arrow's first hit. */
  interface SquadAtTrigger {
    kind: 'use' | 'arrow-release' | 'arrow-hit';
    /** The bound item's id: 'shield', 'bow', 'iron_sword'… */
    item: string;
    /** 'arrow-hit' only: where the arrow hit, and the entity when it hit one. */
    hit?: { position: Vec3Class; entity?: SquadAtEntity };
  }

  /** Where the commander stood and looked (exact, from the server), at the order or at the last bound-item click. */
  interface SquadCommanderAt {
    position: Vec3Class;
    /** Degrees, Minecraft's convention: 0 = south (+Z), 90 = west (−X). */
    yaw: number;
    pitch: number;
    dimension: string;
    heldItem: string | null;
    /** The block they were looking at (≤ 64 blocks), or null. */
    lookBlock: (Vec3Class & { name: string }) | null;
    /** The entity they were looking at, or null. */
    lookEntity: SquadAtEntity | null;
    /** Present when a bound item gave the order or this click (absent for /bots order). */
    trigger?: SquadAtTrigger;
  }

  interface SquadCtx {
    commander: {
      name: string;
      uuid: string;
      /**
       * Where the commander stood and looked when they gave the order. An order started by a bound item has `trigger`.
       * Each later click of the bound item while the order runs REPLACES this object (read ctx.commander.at again
       * after a trigger; an old reference keeps the old snapshot).
       */
      at: SquadCommanderAt;
      /** The commander as `bot` sees them now (null when out of range or offline). Use it to follow/come. */
      entity(bot: SquadBot): Entity | null;
      /**
       * Each later click of the bound item while the order runs (the new `at`). Calling on() or next() once makes the
       * order LISTEN: a click then re-aims it instead of restarting it (a click on an order that never listens stops
       * and restarts it with the new snapshot). A throwing listener fails the order. Listeners end with the order.
       */
      on(event: 'trigger', fn: (at: SquadCommanderAt) => unknown): void;
      off(event: 'trigger', fn: (at: SquadCommanderAt) => unknown): void;
      /**
       * The next click, or the latest one that arrived since the last call (one slot, latest wins). Resolves null after
       * timeoutMs (no timeout: waits until the order ends); rejects with OrderStoppedError when the order stops.
       */
      next(timeoutMs?: number): Promise<SquadCommanderAt | null>;
    };
    /**
     * Player names isFriend() accepts: the commander, the co-owners of the order's bots, and the squad bots sharing an
     * owner with them (your own team). Other players' bots are NOT friends: another army is an enemy like any player.
     */
    readonly friends: ReadonlySet<string>;
    readonly args: Record<string, any>;
    /** True during an authoring trial run (60 s max on idle bots). */
    readonly trial: boolean;
    readonly signal: AbortSignal;
    /** A line in the order's report (what /bots fix shows the author). console.log does the same. */
    log(...parts: unknown[]): void;
    /** A French chat line to the commander (rate-limited: 5 quick, then 1 per second). */
    say(text: string): void;
    /** Run another command the commander can use, as a subroutine on some of the bots (default: all). */
    run(name: string, args?: Record<string, unknown>, opts?: { bots?: SquadBot[] }): Promise<unknown>;
  }

  // ---------------------------------------------------------------------------------------------------------
  //  Values
  // ---------------------------------------------------------------------------------------------------------

  const Vec3: typeof Vec3Class;
  /** mineflayer-pathfinder goals: GoalNear(x,y,z,r), GoalBlock, GoalXZ, GoalNearXZ, GoalFollow(entity, r), GoalY… */
  const goals: typeof PathfinderGoals;
  /** new Movements(bot) for bot.pathfinder.setMovements (the runtime restores its own after the order). */
  const Movements: typeof PathfinderMovements;

  class BotLeftError extends Error {
    readonly bot: string;
    readonly reason: 'reclaimed' | 'released' | 'died' | 'disconnected' | 'despawned' | 'order-ended';
  }
  class OrderStoppedError extends Error {}

  function sleep(ms: number): Promise<void>;
  function setTimeout(fn: (...args: any[]) => unknown, ms?: number, ...args: any[]): unknown;
  function clearTimeout(t: unknown): void;
  function setInterval(fn: (...args: any[]) => unknown, ms?: number, ...args: any[]): unknown;
  function clearInterval(t: unknown): void;
  /** console.* writes to the order's report. */
  const console: { log(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; debug(...a: unknown[]): void };

  // ---------------------------------------------------------------------------------------------------------
  //  Helpers (Voyager's names and signatures first). Each takes the bot first, returns data, and throws an Error
  //  that says what and where. Block targets are claimed across orders: bots never fight over one block.
  // ---------------------------------------------------------------------------------------------------------

  /** Mine `count` blocks of a kind nearby (path, best tool, dig, pick up). "_log" = any log. Skips blocks it can't get. */
  function mineBlock(bot: SquadBot, name: string, count?: number, opts?: { maxDistance?: number }): Promise<{ mined: number; at: Vec3Class[] }>;
  /** Craft `count` times. Uses a crafting table within 32 blocks, or places one from the inventory if needed. */
  function craftItem(bot: SquadBot, name: string, count?: number): Promise<{ crafted: number; item: string }>;
  /** Smelt in a furnace within 32 blocks (or placed from the inventory). */
  function smeltItem(bot: SquadBot, itemName: string, fuelName: string, count?: number): Promise<{ smelted: number }>;
  /** Place a block from the inventory at a position (needs a solid neighbour). */
  function placeItem(bot: SquadBot, name: string, position: Pos): Promise<{ placed: true; at: Vec3Class }>;
  /** Fight the nearest mob of that name (within 32) until dead or `timeout` seconds (default 300). */
  function killMob(bot: SquadBot, mobName: string, timeout?: number): Promise<{ killed: boolean }>;
  /** Walk in a direction (a Vec3 of -1/0/1) until callback() returns something truthy, or maxTime seconds (default 60). */
  function exploreUntil<T>(bot: SquadBot, direction: Pos, maxTime?: number, callback?: () => T | Promise<T>): Promise<T | null>;
  /** Take items from a chest: { iron_ingot: 8 } (takes what is there, up to each count). */
  function getItemFromChest(bot: SquadBot, chestPosition: Pos, itemsToGet: Record<string, number> | string[]): Promise<{ taken: Record<string, number> }>;
  /** Put items in a chest: { cobblestone: 64 } or ['cobblestone'] (all of it). */
  function depositItemIntoChest(bot: SquadBot, chestPosition: Pos, itemsToDeposit: Record<string, number> | string[]): Promise<{ deposited: Record<string, number> }>;
  /** What a chest holds: { name: count }. */
  function checkItemInsideChest(bot: SquadBot, chestPosition: Pos): Promise<Record<string, number>>;

  /** Walk to within `range` (default 1) of a position, in hops of ≤ 40 blocks. Throws if stuck for 20 s. */
  function goTo(bot: SquadBot, pos: Pos, range?: number): Promise<{ arrived: true; position: Vec3Class }>;
  /**
   * Stay within `range` (default 3) of an entity, for untilMs (else until the order stops). A null entity just waits untilMs (default 1 s).
   * Call it in a loop: the next call on the same entity, range and offset keeps the path going; after the last call the goal is cleared ~0.3 s later.
   * `offset` {x, z} follows a point that many blocks beside the entity: give each bot its own slot around the commander
   * (e.g. an angle by its index in its role) so followers do not all stand in the same block.
   */
  function follow(bot: SquadBot, entity: Entity | null | undefined, range?: number, opts?: { untilMs?: number; offset?: { x: number; z: number } | null }): Promise<{ following: boolean }>;
  /** Keep a fight near a point: center() (null/undefined = no leash right now) and how far from it. */
  interface SquadLeash {
    center: () => Pos | null | undefined;
    radius: number;
  }
  /**
   * Melee an entity (best sword/axe) until it dies, is gone, or timeoutMs (default 30 s).
   * `leash` breaks off once the target is more than leash.radius from leash.center() (the commander's position), or the
   * bot itself more than radius + 4; `until()` returning true breaks off too. Both are checked before the first swing
   * and every 200 ms. `brokeOff` says which one ended the fight (absent when it died, left or timed out).
   */
  function attack(
    bot: SquadBot,
    entity: Entity | null | undefined,
    opts?: { timeoutMs?: number; leash?: SquadLeash; until?: () => boolean },
  ): Promise<{ killed: boolean; brokeOff?: 'leash' | 'until' }>;
  /**
   * One aimed bow (or crossbow) shot at an entity, or at a position (a volley on the ground: `shoot(bot, point)`);
   * needs the weapon and arrows. Resolves as soon as the arrow has left (~1.25 s for a bow); when hawkEye finds no
   * trajectory, it aims by hand (a position: the bow's angle from the arrow's flight) (up to ~3 s). Throws "no arrow
   * left the bow … (no clear line of fire? …)" when nothing was fired: step aside or move closer. A snapshot entity
   * (at.lookEntity) is only a position: shoot entityOf(bot, ref) to aim at the live one.
   */
  function shoot(bot: SquadBot, target: Entity | Pos | null | undefined, opts?: { weapon?: 'bow' | 'crossbow' }): Promise<{ shot: true }>;
  /** Equip by id; "_sword" picks the best sword. */
  function equip(bot: SquadBot, name: string, destination?: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet'): Promise<{ equipped: string }>;
  /** Eat the best safe food in the inventory. */
  function eat(bot: SquadBot): Promise<{ ate: string }>;
  /** Walk onto dropped items within radius (default 8). */
  function pickupDrops(bot: SquadBot, radius?: number, opts?: { timeoutMs?: number }): Promise<{ picked: number }>;

  /** Nearest block of that id within maxDistance (default 48), or null. "_log" = any log. */
  function findBlock(bot: SquadBot, name: string, maxDistance?: number): Block | null;
  /**
   * Nearest entity passing filter (a function, or a name like 'zombie' / a player name) within maxDistance (default 32), or null.
   * Distances are from the bot, or from `opts.from` (e.g. the commander's position: the threat nearest the player you defend).
   */
  function nearestEntity(bot: SquadBot, filter: ((e: Entity) => boolean) | string, maxDistance?: number, opts?: { from?: Pos | null }): Entity | null;
  /** Nearest hostile mob within maxDistance (default 16), or null. `from` as in nearestEntity; `filter` narrows further (e.g. not already taken). */
  function nearestHostile(bot: SquadBot, maxDistance?: number, opts?: { from?: Pos | null; filter?: (e: Entity) => boolean }): Entity | null;
  /**
   * A player in ctx.friends (the commander, co-owners, the bots of your team). Never target one. Bots of other owners
   * are not friends. PvP is on; the server only cancels a bot's hits on its own owners and on bots sharing an owner
   * with it, so anyone else can be hurt: spare whom you mean to spare. A snapshot entity (at.lookEntity) works too.
   */
  function isFriend(entity: Entity | SquadAtEntity | null | undefined): boolean;
  /** A claim key for a block position. */
  function blockKey(pos: Pos): string;

  // ---------------------------------------------------------------------------------------------------------
  //  Formations and aiming (orders bound to items: a click re-aims a running order, see ctx.commander.on).
  //  YAW CONVENTION: every helper below takes yaw as ctx.commander.at.yaw gives it, Minecraft's degrees:
  //  0 = south (+Z), 90 = west (−X), 180 = north (−Z), −90 = east (+X). Pitch: Minecraft's degrees, negative = up.
  //  (bot.entity.yaw / bot.entity.pitch are mineflayer's radians, another convention: do not mix them.)
  // ---------------------------------------------------------------------------------------------------------

  /** The unit view vector of a yaw (and pitch): lookDir(0) = (0, 0, 1), lookDir(90) = (−1, 0, 0), lookDir(0, −90) = straight up. */
  function lookDir(yaw: number, pitch?: number): Vec3Class;
  /**
   * `count` positions on a line through `center`, perpendicular to the view `yaw`, `spacing` apart (default 1.5),
   * ordered LEFT TO RIGHT as the commander sees them. With `ranks` > 1 they fill rank by rank, Math.ceil(count / ranks)
   * per rank, each rank centred, rank r `depth * r` blocks (default 2) behind the first, toward the commander. Pure (no
   * bot): every slot keeps center's y, so pass each through groundAt. Give bots their slots sorted by their position
   * along the line (lookDir(yaw + 90) points to the commander's right) so their paths do not cross.
   */
  function lineSlots(center: Pos, yaw: number, count: number, opts?: { spacing?: number; ranks?: number; depth?: number }): Vec3Class[];
  /**
   * Where to stand in pos's column: the feet position (block centre) nearest pos.y with feet and head open and a solid
   * block under, within `up` (default 3) blocks above and `down` (default 4) below; null when there is none or the
   * chunk is not loaded. The top of a looked-at block: groundAt(bot, ctx.commander.at.lookBlock.offset(0.5, 1, 0.5)).
   */
  function groundAt(bot: SquadBot, pos: Pos, opts?: { up?: number; down?: number }): Vec3Class | null;
  /** Turn the bot to a yaw (and pitch) in the commander's convention: faceYaw(bot, ctx.commander.at.yaw) faces where they looked. */
  function faceYaw(bot: SquadBot, yaw: number, pitch?: number): Promise<{ yaw: number; pitch: number }>;
  /**
   * Raise the shield (on, default) or lower it (false). Raising moves a shield into the off-hand when it is elsewhere
   * in the inventory (throws when there is none) and holds use; calling it again while raised sends nothing, so call it
   * in your loop: it raises the shield again after something lowered it (auto-eat lowers it to eat). Blocking slows
   * walking: lower it to walk, raise it once there. A bot leaving the order lowers it.
   */
  function raiseShield(bot: SquadBot, on?: boolean): Promise<{ raised: boolean }>;
  /**
   * The live entity of a snapshot entity (ctx.commander.at.lookEntity, at.trigger.hit.entity) as this bot sees it now,
   * or null (dead, gone, out of its sight): by `id` (bot.entities[id]), else a player by `username`, else the nearest
   * entity of that `name` within 4 blocks of the snapshot's position.
   */
  function entityOf(bot: SquadBot, ref: SquadAtEntity | { id?: number; name?: string; username?: string; position?: Pos } | null | undefined): Entity | null;
}

declare module 'squad' {
  export type Command = SquadCommand;
  export type Manifest = SquadManifest;
  export const Vec3: typeof Vec3Class;
  export const goals: typeof PathfinderGoals;
  export const Movements: typeof PathfinderMovements;
  export { BotLeftError, OrderStoppedError };
  export {
    mineBlock, craftItem, smeltItem, placeItem, killMob, exploreUntil, getItemFromChest, depositItemIntoChest,
    checkItemInsideChest, goTo, follow, attack, shoot, equip, eat, pickupDrops, findBlock, nearestEntity,
    nearestHostile, isFriend, blockKey, lookDir, lineSlots, groundAt, faceYaw, raiseShield, entityOf,
  };
}

export {};
