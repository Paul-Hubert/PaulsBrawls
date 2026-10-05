// The Bot seam (Decision D-14). M0 deliberately kept `Bot` out of types/; M1 needs ONE type
// that BOTH the real mineflayer bot and the test FakeBot satisfy. This is a NARROWED interface
// covering only the surface bots/hardening, bots/helpers, and bots/pool actually touch — not
// the whole of mineflayer. The real `import('mineflayer').Bot` structurally satisfies it; pool.ts
// casts the freshly-created bot through `unknown` at the one boundary because the plugin objects
// (pathfinder/pvp/collectBlock/autoEat/armorManager) attach POST-spawn, so a direct assignment
// of the bare bot wouldn't typecheck anyway. FakeBot already models the seams (R1–R3, R10, D-10).
//
// Layer 0: imports nothing (the dependency law). No `any` — src/ bans it; listener args are
// `unknown[]` (the narrowed emitter is intentionally untyped here; callers cast as needed).

/** A bare position — a real mineflayer `Vec3` structurally satisfies this (it has x/y/z). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** An inventory item, narrowed to what helpers/vitals read. */
export interface BotItem {
  name: string;
  count: number;
  slot?: number;
}

/** A world block, narrowed to what collectTrunk/useChest read. */
export interface BotBlock {
  name: string;
  position: Vec3Like;
}

/** An open container/crafting window. */
export interface BotWindow {
  id: number;
  type?: string;
  title?: string;
}

/** The pathfinder plugin surface the hardening corpus bounds + drives (R6/R7). */
export interface PathfinderLike {
  thinkTimeout: number;
  tickTimeout: number;
  searchRadius: number;
  /** Replace the bot-global Movements cost model (collectblock clobbers it — R10). */
  setMovements(movements: unknown): void;
  /** Set or clear (null) the active goal — used by the abort sequence (R4). */
  setGoal(goal: unknown, dynamic?: boolean): void;
  /** Stop the active path. ORDER MATTERS: stop() then setGoal(null) (R4). */
  stop(): void;
  /** Walk to a goal; resolves when reached or rejects/aborts on interruption. */
  goto(goal: unknown): Promise<void>;
}

/** The pvp plugin surface — only `stop` is in the abort sequence (R4). */
export interface PvpLike {
  stop(): void | Promise<void>;
}

/** The collectblock plugin surface — abort clears its in-flight targets first (R4). */
export interface CollectBlockLike {
  /** Cancel the active collect, if the plugin exposes it. */
  cancelTask?: (cb?: (err?: Error) => void) => void;
  /** v1's escape hatch: empty the greedy-nearest target list (R10). */
  targets?: unknown[];
}

/** The auto-eat plugin surface (native ESM). Config is load-bearing (R17). */
export interface AutoEatLike {
  enableAuto(): void;
  disableAuto(): void;
  setOpts?(opts: unknown): void;
}

/** The armor-manager plugin surface — paused during window ops (R3). */
export interface ArmorManagerLike {
  pause?(): void;
  resume?(): void;
}

/**
 * Item/block id lookup — mineflayer exposes this as `bot.registry` (the prismarine-registry /
 * minecraft-data instance). `itemsByName` backs deposit/withdraw; `blocksByName` backs find-block's
 * numeric matcher. Surfaced to skills as `ctx.mcData` (Blocker D1), so the LLM's idiomatic
 * `mcData.itemsByName[name].id` resolves instead of dereferencing `undefined`.
 */
export interface ItemRegistry {
  itemsByName: Record<string, { id: number } | undefined>;
  blocksByName?: Record<string, { id: number } | undefined>;
}

/** An open container window (a chest), narrowed to what deposit/withdraw use. */
export interface BotContainer {
  /** Move `count` of item id `type` from the bot's inventory into the container. */
  deposit(type: number, metadata: number | null, count: number): Promise<void>;
  /** Move `count` of item id `type` from the container into the bot's inventory. */
  withdraw(type: number, metadata: number | null, count: number): Promise<void>;
  /** Items currently inside the container. */
  containerItems?(): BotItem[];
  close(): void;
}

/** A minimal event-emitter surface (real Bot + FakeBot both extend EventEmitter). */
export interface EmitterLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * The narrowed mineflayer bot — only what M1's bots/ layer uses. Plugin objects are optional
 * because they attach post-spawn and any single load may fail (R16). Everything here is
 * satisfied by the real `mineflayer.Bot` (with plugins) and by the test FakeBot.
 */
export interface Bot extends EmitterLike {
  readonly username: string;
  /** Null while disconnected/dead; `position` is the body's location. */
  entity: { position: Vec3Like } | null;
  game?: { dimension?: string };
  health?: number;
  food?: number;
  /** World time — mineflayer's `bot.time.timeOfDay` (0..24000); the night-falls/new-day emitter edges on it. */
  time?: { timeOfDay: number };
  inventory: { items(): BotItem[] };
  /** What the bot currently holds, if anything (read by vitals). */
  heldItem?: { name: string } | null;
  /** The open window — a stray one hijacks every clickWindow (R1). */
  currentWindow: BotWindow | null;
  /** The low-level protocol client — packet seam for craft quiescence + death (R2/R27). */
  readonly _client: EmitterLike;

  pathfinder?: PathfinderLike;
  pvp?: PvpLike;
  collectBlock?: CollectBlockLike;
  autoEat?: AutoEatLike;
  armorManager?: ArmorManagerLike;
  /** Item id lookup for deposit/withdraw (mineflayer's `bot.registry`). */
  registry?: ItemRegistry;

  /** Public chat. The chat interceptor wraps this to drop `/`-commands on mortal runs (R25). */
  chat(message: string): void;
  closeWindow(window: BotWindow): void;
  /** Real mineflayer calls `point.floored()`: pass a real Vec3 (`ctx.Vec3` in skills, the vec3 package in host code),
   *  never a plain {x,y,z} — the narrowed type cannot say so (types/ imports nothing). */
  blockAt(point: Vec3Like): BotBlock | null;
  /** Open the container at `block` (a chest/barrel) — used by useChest/deposit/withdraw. */
  openContainer(block: BotBlock): Promise<BotContainer>;
  dig(block: BotBlock): Promise<void>;
  loadPlugin(plugin: unknown): void;
  /** Disconnect the bot (pool shutdown). */
  quit(reason?: string): void;
}
