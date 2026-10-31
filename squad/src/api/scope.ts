// The per-order scope a compiled command runs with (the names in compile.SCOPE_NAMES), and its `ctx`.
// Order-specific: the loop budget and fences, tracked timers, `console` into the report, `isFriend` over the
// order's friends. Everything else is the same instance for every order (Vec3, goals, the helpers).

import { inspect } from 'node:util';

import type { Bot } from 'mineflayer';
import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
import vec3Module, { Vec3 } from 'vec3';

import { createLoopBudget, SCOPE_NAMES } from '../script/compile';
import type { Order } from '../orders/order';
import { unwrap } from '../orders/guard';
import type { EntityRef, Snapshot, TriggerKind, Vec3Like } from '../types';
import { BotLeftError, OrderStoppedError } from './errors';
import { HELPERS, blockKey } from './helpers';
import type { Squad } from './squad';

const { goals, Movements } = pathfinderPkg;

/** `new Movements(bot)` with a guarded bot builds on the real one (a Movements outlives the order's lease). */
class SquadMovements extends Movements {
  constructor(bot: Bot, ...rest: unknown[]) {
    super(unwrap(bot), ...(rest as []));
  }
}

const SQUAD_MODULE_KEYS = ['Vec3', 'goals', 'Movements', 'BotLeftError', 'OrderStoppedError', 'blockKey', ...Object.keys(HELPERS)];

function format(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 3, breakLength: 160 }))).join(' ');
}

/** Build the scope object (every name of SCOPE_NAMES, nothing else). */
export function buildScope(order: Order): Record<string, unknown> {
  const budget = createLoopBudget(() => order.assertRunning());
  const isFriend = (e: unknown): boolean => {
    const ent = e as { type?: string; username?: string } | null;
    return !!ent && ent.type === 'player' && !!ent.username && order.friends.has(ent.username);
  };
  const values: Record<string, unknown> = {
    ...budget,
    Vec3,
    goals,
    Movements: SquadMovements,
    BotLeftError,
    OrderStoppedError,
    sleep: (ms: number) => order.sleep(ms),
    setTimeout: (fn: (...a: unknown[]) => unknown, ms?: number, ...a: unknown[]) => order.setTimeout(fn, ms, ...a),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => order.clearTimeout(t),
    setInterval: (fn: (...a: unknown[]) => unknown, ms?: number, ...a: unknown[]) => order.setInterval(fn, ms, ...a),
    clearInterval: (t: ReturnType<typeof setInterval>) => order.clearInterval(t),
    console: {
      log: (...a: unknown[]) => order.log(format(a)),
      info: (...a: unknown[]) => order.log(format(a)),
      debug: (...a: unknown[]) => order.log(format(a)),
      warn: (...a: unknown[]) => order.log('warn: ' + format(a)),
      error: (...a: unknown[]) => order.log('error: ' + format(a)),
    },
    ...HELPERS,
    isFriend,
    blockKey,
  };
  const squadModule: Record<string, unknown> = {};
  for (const k of SQUAD_MODULE_KEYS) squadModule[k] = values[k];
  squadModule.isFriend = isFriend;
  const modules: Record<string, unknown> = {
    squad: { ...squadModule, default: squadModule },
    vec3: { Vec3, default: vec3Module },
    'mineflayer-pathfinder': { ...pathfinderPkg, goals, Movements: SquadMovements, default: { ...pathfinderPkg, goals, Movements: SquadMovements } },
    'minecraft-data': { default: minecraftData },
  };
  const __import = (spec: string): unknown => {
    const name = String(spec).replace(/^node:/, '');
    const m = modules[name];
    if (!m) throw new Error(`cannot import "${spec}" in a command: only ${Object.keys(modules).join(', ')} (and none is needed: every helper is a global)`);
    return m;
  };
  values.__import = __import;
  // CommonJS habit: require('mineflayer-pathfinder') gives the module itself (its default export).
  values.require = (spec: string) => {
    const m = __import(spec) as { default?: unknown };
    return m.default ?? m;
  };
  const scope: Record<string, unknown> = {};
  for (const name of SCOPE_NAMES) {
    if (!(name in values)) throw new Error(`scope: missing ${name}`);
    scope[name] = values[name];
  }
  return scope;
}

/** An entity in a snapshot, with a Vec3 position. `id` is mineflayer's key: `bot.entities[id]`. */
export interface EntityAt {
  id?: number;
  name: string;
  type: string;
  username?: string;
  position: Vec3;
}

/** Where the commander stood and looked when they gave the order, or at the last delivered trigger (§5.4). */
export interface CommanderAt {
  position: Vec3;
  yaw: number;
  pitch: number;
  dimension: string;
  heldItem: string | null;
  lookBlock: (Vec3 & { name: string }) | null;
  lookEntity: EntityAt | null;
  /** The bound item's trigger that gave this snapshot (absent for `/bots order`). */
  trigger?: { kind: TriggerKind; item: string; hit?: { position: Vec3; entity?: EntityAt } };
}

export interface Commander {
  name: string;
  uuid: string;
  /** Replaced (a new object) by each delivered trigger; a script holding the old one keeps it. */
  at: CommanderAt;
  /** The commander as `bot` sees them now (null when out of the bot's range or offline). */
  entity(bot: Bot): unknown;
  /** Each later click of the bound item while the order runs. The order then listens: clicks no longer restart it. */
  on(event: 'trigger', fn: (at: CommanderAt) => unknown): void;
  off(event: 'trigger', fn: (at: CommanderAt) => unknown): void;
  /**
   * The next click (or the latest one since the last call: one slot, latest wins); null after `timeoutMs` (none:
   * wait until the order ends). Rejects with OrderStoppedError when the order stops, like `squad.sleep`.
   */
  next(timeoutMs?: number): Promise<CommanderAt | null>;
}

const v = (p: Vec3Like): Vec3 => new Vec3(p.x, p.y, p.z);

function entityAt(e: EntityRef): EntityAt {
  return { ...e, position: v(e.position) };
}

/** A snapshot as the script sees it: positions as Vec3, a fresh object every time. */
export function atOf(snap: Snapshot): CommanderAt {
  const t = snap.trigger;
  return {
    position: v(snap.position),
    yaw: snap.yaw,
    pitch: snap.pitch,
    dimension: snap.dimension,
    heldItem: snap.heldItem,
    lookBlock: snap.lookBlock ? Object.assign(v(snap.lookBlock), { name: snap.lookBlock.name }) : null,
    lookEntity: snap.lookEntity ? entityAt(snap.lookEntity) : null,
    ...(t
      ? {
          trigger: {
            kind: t.kind,
            item: t.item,
            ...(t.hit ? { hit: { position: v(t.hit.position), ...(t.hit.entity ? { entity: entityAt(t.hit.entity) } : {}) } } : {}),
          },
        }
      : {}),
  };
}

// One commander per order, shared by its `ctx.run` subroutines: a trigger reaches the whole order once, whichever
// part of the script listens, and `at` is the same everywhere.
const commanders = new WeakMap<Order, Commander>();

export function commanderOf(order: Order): Commander {
  const known = commanders.get(order);
  if (known) return known;
  const listeners: Array<{ fn: (at: CommanderAt) => unknown; wrapped: (...a: unknown[]) => unknown }> = [];
  const waiters = new Set<(at: CommanderAt) => void>();
  let latest: CommanderAt | null = null;
  const event = (method: string, e: unknown): void => {
    if (e !== 'trigger') throw new Error(`ctx.commander.${method}: unknown event "${String(e)}" (trigger)`);
  };
  const commander: Commander = {
    name: order.commander.name,
    uuid: order.commander.uuid,
    at: atOf(order.snap),
    entity(bot: Bot) {
      const real = unwrap(bot) as Bot | undefined;
      return real?.players?.[order.commander.name]?.entity ?? null;
    },
    on(e, fn) {
      event('on', e);
      if (typeof fn !== 'function') throw new TypeError("ctx.commander.on('trigger', fn): fn must be a function");
      order.listening = true;
      // Wrapped like a bot listener: a throw fails this order only, and nothing runs once the order has ended.
      listeners.push({ fn, wrapped: order.wrapCallback(fn as (...a: unknown[]) => unknown, "ctx.commander.on('trigger')") });
    },
    off(e, fn) {
      event('off', e);
      const i = listeners.findIndex((l) => l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    next(timeoutMs?: number) {
      order.assertRunning();
      order.listening = true;
      if (latest) {
        const at = latest;
        latest = null;
        return Promise.resolve(at);
      }
      return new Promise<CommanderAt | null>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (at: CommanderAt | null, err?: unknown): void => {
          waiters.delete(onTrigger);
          order.signal.removeEventListener('abort', onAbort);
          if (timer) clearTimeout(timer);
          if (err) reject(err);
          else resolve(at);
        };
        const onTrigger = (at: CommanderAt): void => settle(at);
        const onAbort = (): void => {
          try {
            order.assertRunning(); // throws the order's own OrderStoppedError (status is set before the abort)
            settle(null, new OrderStoppedError('order ended'));
          } catch (e) {
            settle(null, e);
          }
        };
        waiters.add(onTrigger);
        order.signal.addEventListener('abort', onAbort, { once: true });
        // Infinity or nothing: no timer (Node would fire one past 2^31 - 1 ms after 1 ms).
        const ms = timeoutMs === undefined || timeoutMs === null ? NaN : Number(timeoutMs);
        if (Number.isFinite(ms)) timer = setTimeout(() => settle(null), Math.min(Math.max(0, ms), 2_147_483_647));
      });
    },
  };
  order.setTriggerSink((snap) => {
    const at = atOf(snap);
    commander.at = at;
    for (const l of [...listeners]) l.wrapped(at);
    if (waiters.size > 0) for (const w of [...waiters]) w(at);
    else latest = at;
  });
  order.signal.addEventListener(
    'abort',
    () => {
      listeners.length = 0;
      latest = null;
    },
    { once: true },
  );
  commanders.set(order, commander);
  return commander;
}

export interface Ctx {
  commander: Commander;
  friends: ReadonlySet<string>;
  args: Record<string, unknown>;
  trial: boolean;
  signal: AbortSignal;
  log(...parts: unknown[]): void;
  say(text: string): void;
  run(name: string, args?: Record<string, unknown>, opts?: { bots?: Bot[] }): Promise<unknown>;
}

export function buildCtx(order: Order, args: Record<string, unknown>, run: Ctx['run']): Ctx {
  return {
    commander: commanderOf(order),
    friends: order.friends,
    args,
    trial: order.trial,
    signal: order.signal,
    log: (...parts: unknown[]) => order.log(format(parts)),
    say: (text: string) => order.say(String(text)),
    run,
  };
}

export type { Squad };
