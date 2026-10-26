import type { Bot } from 'mineflayer';
import { log, logDebug } from '../logger.js';
import * as actions from './actions.js';
import { compileScript, CycleBudget, prepareScript, ScriptGlobals } from './sandbox.js';
import { surveyTerrain } from './terrain.js';
import { VillageContext } from './context.js';
import { Villager } from './villager.js';
import { VillageEvent, VillageEventType } from './types.js';

/**
 * The VillagerAPI: the ONE surface bot-authored code programs against
 * (VILLAGE_PLAN §4). `API_DTS` below is the published contract — it goes into
 * the system prompt verbatim and into the pre-run typechecker. Keep it in
 * lockstep with the runtime object built by {@link buildScriptGlobals}; drift
 * here means the typechecker blesses code that explodes at runtime.
 */

export const API_DTS = `interface Vec3Like { x: number; y: number; z: number; }
interface SelfState { name: string; role: string; position: Vec3Like; health: number; food: number; heldItem: string | null; home: Vec3Like; workstation: Vec3Like | null; mood: string; needs: { rest: number; social: number }; }
interface EntityInfo { id: number; name: string; kind: 'hostile' | 'player' | 'villager' | 'animal' | 'other'; role?: string; position: Vec3Like; distance: number; }
interface InventoryEntry { item: string; count: number; }
interface BlockInfo { name: string; position: Vec3Like; mature?: boolean; }
interface HurtEvent { type: 'hurt'; attacker?: EntityInfo; }
interface SpottedEvent { type: 'entity-spotted'; entity: EntityInfo; }
interface MessageEvent { type: 'message'; from: string; text: string; }
interface PlayerChatEvent { type: 'player-chat'; from: string; text: string; }
interface ItemReceivedEvent { type: 'item-received'; item: string; count: number; }
interface NightFallsEvent { type: 'night-falls'; }
interface NewDayEvent { type: 'new-day'; }
interface TiredEvent { type: 'tired'; value: number; }
interface LonelyEvent { type: 'lonely'; value: number; }
interface DiedEvent { type: 'died'; }
interface JobDoneEvent { type: 'job-done'; job: string; outcome?: string; futile?: boolean; }
interface JobFailedEvent { type: 'job-failed'; job: string; error: string; outcome?: string; }
interface RosterEntry { name: string; role: string; online: boolean; }
interface VillagerAPI {
  /** My own state snapshot. */
  self(): SelfState;
  /** Entities near me, closest first (default radius 16). */
  nearbyEntities(radius?: number): EntityInfo[];
  /** Blocks matching a name/substring near me (default radius 16). */
  nearbyBlocks(nameQuery: string, radius?: number): BlockInfo[];
  /** ASCII relief map of the terrain around me (elevation, water, trees, cliffs, me=@). Radius clamped 8..48, default 24. Pure read, free. */
  surveyTerrain(radius?: number): string;
  /** My inventory, aggregated by item. */
  inventory(): InventoryEntry[];
  /** Minecraft time of day, 0..24000 (night starts ~13000). */
  timeOfDay(): number;
  /** Pathfind near a position. Throws if unreachable/timeout. */
  goTo(x: number, y: number, z: number, range?: number): Promise<void>;
  /** Run directly away from a position (default 16 blocks). */
  flee(from: Vec3Like, distance?: number): Promise<void>;
  stopMoving(): void;
  /** Mine the block at a position (walks there if needed). */
  dig(x: number, y: number, z: number): Promise<void>;
  /** Place an inventory item as a block at a position. */
  place(item: string, x: number, y: number, z: number): Promise<void>;
  /** Till grass/dirt into farmland (needs a hoe in inventory; block above must be air). */
  till(x: number, y: number, z: number): Promise<void>;
  /** Find, mine and pick up N blocks of a type. Returns how many were collected. */
  collect(blockType: string, count?: number): Promise<number>;
  /** Craft an item (uses a nearby crafting table when needed). count = how
   *  many ITEMS you want (not recipe executions). Returns how many were made. */
  craft(item: string, count?: number): Promise<number>;
  /** Equip the named item in hand. */
  equip(item: string): Promise<void>;
  /** Start attacking an entity (combat runs on its own; use stopCombat() to break off). */
  attack(entityId: number): void;
  stopCombat(): Promise<void>;
  /** Put items into my chest (falls back to any chest near it or near me; a found chest is remembered). Returns count moved. */
  deposit(item: string, count: number): Promise<number>;
  /** Take items from my chest (falls back to any chest near it or near me; a found chest is remembered). Returns count moved. */
  withdraw(item: string, count: number): Promise<number>;
  /** Hand items directly to another villager — no chest needed (atomic via the
   *  village settlement service, with a walk-up-and-toss fallback). Returns
   *  how many items were actually delivered. */
  give(botName: string, item: string, count: number): Promise<number>;
  /** Everyone in the village (me included), with role and online state. Check
   *  this BEFORE waiting on another role — the role may not exist here. */
  roster(): RosterEntry[];
  /** Whether any ONLINE villager has this role (e.g. 'crafter'). If false, do
   *  the work yourself or escalate — nobody is coming. */
  hasRole(role: string): boolean;
  /** Say something out loud (players and nearby villagers hear it). */
  say(message: string): void;
  /** Send a direct message to another villager's inbox (free, instant). */
  tell(botName: string, message: string): void;
  /** Escalate to my own LLM brain — use when this code is out of its depth. */
  think(reason: string, urgency?: 'low' | 'high'): void;
  /** Append a note to my episodic memory. */
  remember(note: string): void;
  /** Run another of my ROUTINE skills inline and wait for it (compose instead of
   *  duplicating code). Depth cap 2; shares my loop budget and cancellation. */
  invokeSkill(name: string): Promise<void>;
  /** Register an event handler. ONLY valid at the top level of a reflex script. */
  on(event: 'hurt', handler: (e: HurtEvent) => void | Promise<void>): void;
  on(event: 'entity-spotted', handler: (e: SpottedEvent) => void | Promise<void>): void;
  on(event: 'message', handler: (e: MessageEvent) => void | Promise<void>): void;
  on(event: 'player-chat', handler: (e: PlayerChatEvent) => void | Promise<void>): void;
  on(event: 'item-received', handler: (e: ItemReceivedEvent) => void | Promise<void>): void;
  on(event: 'night-falls', handler: (e: NightFallsEvent) => void | Promise<void>): void;
  on(event: 'new-day', handler: (e: NewDayEvent) => void | Promise<void>): void;
  on(event: 'tired', handler: (e: TiredEvent) => void | Promise<void>): void;
  on(event: 'lonely', handler: (e: LonelyEvent) => void | Promise<void>): void;
  on(event: 'died', handler: (e: DiedEvent) => void | Promise<void>): void;
  on(event: 'job-done', handler: (e: JobDoneEvent) => void | Promise<void>): void;
  on(event: 'job-failed', handler: (e: JobFailedEvent) => void | Promise<void>): void;
}
declare const bot: VillagerAPI;
/** Pause (ms, max 5 min). Also resets the loop budget — use it inside long loops. */
declare function sleep(ms: number): Promise<void>;
declare const console: { log(...args: unknown[]): void };`;

export interface ScriptApiOptions {
  /**
   * 'register': reflex install — bot.on() captures handlers, world actions throw.
   * 'live': handler invocation / routine run — actions work, bot.on() throws.
   */
  mode: 'register' | 'live';
  registrar?: (type: VillageEventType, handler: (e: VillageEvent) => void | Promise<void>) => void;
  /** Routine cancellation probe; actions/sleep throw once it returns true. */
  cancelled?: () => boolean;
  budget: CycleBudget;
  actionTimeoutMs?: number;
  /** invokeSkill nesting depth (composition cap). */
  invokeDepth?: number;
  /**
   * Observer for every world action's outcome (label, success, return value).
   * The RoutineRunner uses it to detect FUTILE runs — completions where the
   * script swallowed every action error and produced nothing — which would
   * otherwise look identical to productive ones.
   */
  onAction?: (label: string, ok: boolean, result?: unknown) => void;
}

const MAX_INVOKE_DEPTH = 2;

const VALID_EVENTS: ReadonlySet<string> = new Set([
  'hurt', 'entity-spotted', 'message', 'player-chat', 'item-received',
  'night-falls', 'new-day', 'tired', 'lonely', 'died', 'job-done', 'job-failed',
]);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export function buildScriptGlobals(villager: Villager, ctx: VillageContext, opts: ScriptApiOptions): ScriptGlobals {
  const checkCancelled = (): void => {
    if (opts.cancelled?.()) throw new Error('routine cancelled');
  };

  const act = <T>(label: string, fn: (bot: Bot) => Promise<T>): Promise<T> => {
    if (opts.mode === 'register') {
      throw new Error(`${label}: world actions are not allowed at the top level of a reflex script — put them inside an event handler`);
    }
    checkCancelled();
    const queuedAt = Date.now();
    return villager.runExclusive(async () => {
      checkCancelled();
      const bot = villager.requireBot();
      const startedAt = Date.now();
      const waited = startedAt - queuedAt;
      logDebug(villager.name, `act ${label} start${waited > 50 ? ` (queued ${waited}ms)` : ''}`);
      try {
        const result = await withTimeout(fn(bot), opts.actionTimeoutMs ?? 45_000, label);
        logDebug(villager.name, `act ${label} ok in ${Date.now() - startedAt}ms${typeof result === 'number' ? ` → ${result}` : ''}`);
        opts.onAction?.(label, true, result);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDebug(villager.name, `act ${label} FAILED after ${Date.now() - startedAt}ms: ${message}`);
        opts.onAction?.(label, false);
        // A timeout abandons the promise but pvp/collectblock keep driving the
        // bot — leave the controls inert so the next action doesn't fight them.
        if (message.includes('timed out after')) await actions.abortActiveTasks(bot);
        throw err;
      }
    });
  };

  const perceive = <T>(fn: (bot: Bot) => T, fallback: T): T => {
    const bot = villager.bot();
    return bot ? fn(bot) : fallback;
  };

  const api = {
    // -- perception (sync, free) -------------------------------------------
    self: () =>
      perceive((bot) => ({
        name: villager.name,
        role: villager.roster.role,
        position: { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) },
        health: bot.health,
        food: bot.food,
        heldItem: bot.heldItem?.name ?? null,
        home: villager.homeAnchor() ?? { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) },
        workstation: villager.roster.workstation ?? null,
        mood: villager.memory.mood(),
        needs: { ...villager.memory.needs() },
      }), {
        name: villager.name,
        role: villager.roster.role,
        position: villager.homeAnchor() ?? { x: 0, y: 64, z: 0 },
        health: 0,
        food: 0,
        heldItem: null,
        home: villager.homeAnchor() ?? { x: 0, y: 64, z: 0 },
        workstation: villager.roster.workstation ?? null,
        mood: villager.memory.mood(),
        needs: { ...villager.memory.needs() },
      }),

    nearbyEntities: (radius = 16) =>
      perceive((bot) => {
        const result: Array<ReturnType<typeof actions.describeEntity> & { distance: number; role?: string }> = [];
        for (const entity of Object.values(bot.entities)) {
          if (!entity || entity === bot.entity) continue;
          const distance = bot.entity.position.distanceTo(entity.position);
          if (distance > radius) continue;
          const info = actions.describeEntity(bot, entity, ctx.villagerNames);
          const role = info.kind === 'villager' ? ctx.villagers.get(info.name)?.roster.role : undefined;
          result.push({ ...info, distance: Math.round(distance * 10) / 10, ...(role ? { role } : {}) });
        }
        return result.sort((a, b) => a.distance - b.distance);
      }, []),

    nearbyBlocks: (nameQuery: string, radius = 16) =>
      perceive((bot) => actions.findBlocks(bot, nameQuery, radius), []),

    surveyTerrain: (radius?: number) =>
      perceive((bot) => surveyTerrain(bot, radius !== undefined ? { radius } : {}), 'survey_terrain: you are not in the world right now.'),

    inventory: () => perceive((bot) => actions.inventorySummary(bot), []),

    timeOfDay: () => perceive((bot) => bot.time.timeOfDay, 0),

    // -- world actions (async, serialized, timed out) ------------------------
    goTo: (x: number, y: number, z: number, range = 1) =>
      act(`goTo(${x},${y},${z} r${range})`, (bot) => actions.goTo(bot, x, y, z, range)),
    flee: (from: { x: number; y: number; z: number }, distance = 16) =>
      act(`flee(from ${Math.floor(from.x)},${Math.floor(from.z)} d${distance})`, (bot) => actions.flee(bot, from, distance)),
    stopMoving: () => {
      const bot = villager.bot();
      if (bot) {
        logDebug(villager.name, 'act stopMoving');
        actions.stopMoving(bot);
      }
    },
    dig: (x: number, y: number, z: number) =>
      act(`dig(${x},${y},${z})`, async (bot) => { await actions.digBlock(bot, x, y, z); }),
    place: (item: string, x: number, y: number, z: number) =>
      act(`place(${item} @${x},${y},${z})`, (bot) => actions.placeBlock(bot, item, x, y, z)),
    till: (x: number, y: number, z: number) =>
      act(`till(${x},${y},${z})`, (bot) => actions.tillBlock(bot, x, y, z)),
    collect: (blockType: string, count = 1) =>
      act(`collect(${blockType} x${count})`, (bot) => actions.collectBlocks(bot, blockType, count)),
    craft: (item: string, count = 1) =>
      act(`craft(${item} x${count})`, (bot) => actions.craftItem(bot, item, count)).then((crafted) => {
        // A success contradicts any stored "can't craft X" belief — retire it.
        villager.memory.refuteBlockedBeliefs(
          `craft ${item}`,
          `vérifié: j'ai fabriqué ${crafted}x ${item} — mes anciennes conclusions disant que c'était impossible étaient fausses`
        );
        return crafted;
      }),
    equip: (item: string) =>
      act(`equip(${item})`, async (bot) => { await actions.equipItem(bot, item); }),
    attack: (entityId: number) => {
      if (opts.mode === 'register') {
        throw new Error('attack: not allowed at the top level of a reflex script');
      }
      const bot = villager.bot();
      if (bot) {
        logDebug(villager.name, `act attack(entity ${entityId})`);
        actions.attackEntity(bot, entityId);
      }
    },
    stopCombat: () => act('stopCombat', (bot) => actions.stopCombat(bot)),
    deposit: (item: string, count: number) =>
      act(`deposit(${item} x${count})`, (bot) =>
        actions.depositToChest(bot, villager.chestAnchor(), item, count, (pos) =>
          villager.setChestAnchor(pos, "trouvé en déposant — l'ancien emplacement n'avait pas de coffre"))),
    withdraw: (item: string, count: number) =>
      act(`withdraw(${item} x${count})`, (bot) =>
        actions.withdrawFromChest(bot, villager.chestAnchor(), item, count, (pos) =>
          villager.setChestAnchor(pos, "trouvé en retirant — l'ancien emplacement n'avait pas de coffre"))),
    give: (botName: string, item: string, count: number) =>
      act(`give(${count}x ${item} → ${botName})`, () =>
        ctx.trades.give(villager.name, String(botName), item, count)),

    // -- roster awareness (sync, free) ----------------------------------------
    roster: () =>
      Array.from(ctx.villagers.values()).map((v) => ({
        name: v.name,
        role: v.roster.role,
        online: Boolean(v.bot()),
      })),
    hasRole: (role: string) => {
      const needle = String(role).toLowerCase();
      for (const v of ctx.villagers.values()) {
        if (v.roster.role.toLowerCase() === needle && v.bot()) return true;
      }
      return false;
    },

    // -- social (free) -------------------------------------------------------
    say: (message: string) => {
      const text = String(message).slice(0, 300);
      logDebug(villager.name, `say "${text}"`);
      villager.mirrorChat(text);
      villager.memory.append('social', `I said: ${text}`);
      for (const other of villager.villagersInEarshot(ctx.villagers.values())) {
        other.memory.append('social', `${villager.name} said: ${text}`, [villager.name]);
      }
    },
    tell: (botName: string, message: string) => {
      const target = ctx.villagers.get(botName);
      if (!target) {
        log('warn', `${villager.name} tell(): no villager named '${botName}'`);
        return;
      }
      const text = String(message).slice(0, 300);
      logDebug(villager.name, `tell ${botName} "${text}"`);
      target.pushInbox(villager.name, text);
      villager.memory.append('social', `I told ${botName}: ${text}`, [botName]);
    },

    // -- cognition ------------------------------------------------------------
    think: (reason: string, urgency: 'low' | 'high' = 'low') => {
      logDebug(villager.name, `think(${urgency}) "${String(reason).slice(0, 150)}"`);
      ctx.scheduler.request(
        villager.name,
        urgency === 'high' ? 'combat' : 'job',
        `my own code escalated: ${String(reason).slice(0, 200)}`
      );
    },
    remember: (note: string) => {
      villager.memory.append('thought', String(note));
    },
    invokeSkill: async (name: string): Promise<void> => {
      if (opts.mode === 'register') {
        throw new Error('invokeSkill: not allowed at the top level of a reflex script');
      }
      const depth = opts.invokeDepth ?? 0;
      if (depth >= MAX_INVOKE_DEPTH) {
        throw new Error(`invokeSkill: depth cap (${MAX_INVOKE_DEPTH}) reached — flatten the composition`);
      }
      const skill = villager.skills.get(String(name));
      if (!skill) throw new Error(`invokeSkill: no skill named '${String(name)}'`);
      if (skill.kind !== 'routine') throw new Error(`invokeSkill: '${skill.name}' is a ${skill.kind} — only routines compose`);
      if (skill.status !== 'active') throw new Error(`invokeSkill: '${skill.name}' is disabled — fix it first`);
      checkCancelled();
      const prepared = prepareScript(skill.code);
      if (!prepared.ok) throw new Error(`invokeSkill: '${skill.name}' failed validation: ${prepared.errors.join('; ')}`);
      // Same budget + cancellation: the composition is ONE logical script.
      const globals = buildScriptGlobals(villager, ctx, { ...opts, invokeDepth: depth + 1 });
      logDebug(villager.name, `invokeSkill '${skill.name}' start (depth ${depth + 1})`);
      const invokedAt = Date.now();
      try {
        await compileScript(prepared.instrumented)(globals, opts.budget);
        logDebug(villager.name, `invokeSkill '${skill.name}' ok in ${Date.now() - invokedAt}ms`);
      } catch (err) {
        logDebug(villager.name, `invokeSkill '${skill.name}' FAILED after ${Date.now() - invokedAt}ms: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },

    // -- reactivity -------------------------------------------------------------
    on: (event: string, handler: (e: VillageEvent) => void | Promise<void>) => {
      if (opts.mode !== 'register' || !opts.registrar) {
        throw new Error('bot.on() is only valid at the top level of a reflex script');
      }
      if (!VALID_EVENTS.has(event)) {
        throw new Error(`unknown event '${event}' — valid: ${Array.from(VALID_EVENTS).join(', ')}`);
      }
      if (typeof handler !== 'function') throw new Error('bot.on() handler must be a function');
      opts.registrar(event as VillageEventType, handler);
    },
  };

  const sleep = async (ms: number): Promise<void> => {
    if (opts.mode === 'register') {
      throw new Error('sleep() is not allowed at the top level of a reflex script');
    }
    checkCancelled();
    // A real await means we're not in a tight loop — refund the cycle budget.
    opts.budget.reset();
    const clamped = Math.min(Math.max(Number(ms) || 0, 10), 300_000);
    await new Promise((resolve) => setTimeout(resolve, clamped));
    checkCancelled();
  };

  const scriptConsole = {
    log: (...args: unknown[]) => {
      const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      log('info', `[${villager.name}/script] ${line.slice(0, 300)}`);
    },
  };

  return { bot: api, sleep, console: scriptConsole };
}
