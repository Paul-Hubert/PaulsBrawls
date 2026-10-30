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
import type { Snapshot, Vec3Like } from '../types';
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

export interface Commander {
  name: string;
  uuid: string;
  /** Where the commander stood and looked when they gave the order. */
  at: {
    position: Vec3;
    yaw: number;
    pitch: number;
    dimension: string;
    heldItem: string | null;
    lookBlock: (Vec3 & { name: string }) | null;
    lookEntity: { name: string; type: string; username?: string; position: Vec3 } | null;
  };
  /** The commander as `bot` sees them now (null when out of the bot's range or offline). */
  entity(bot: Bot): unknown;
}

const v = (p: Vec3Like): Vec3 => new Vec3(p.x, p.y, p.z);

export function commanderOf(order: Order): Commander {
  const snap: Snapshot = order.snap;
  const lookBlock = snap.lookBlock ? Object.assign(v(snap.lookBlock), { name: snap.lookBlock.name }) : null;
  return {
    name: order.commander.name,
    uuid: order.commander.uuid,
    at: {
      position: v(snap.position),
      yaw: snap.yaw,
      pitch: snap.pitch,
      dimension: snap.dimension,
      heldItem: snap.heldItem,
      lookBlock,
      lookEntity: snap.lookEntity ? { ...snap.lookEntity, position: v(snap.lookEntity.position) } : null,
    },
    entity(bot: Bot) {
      const real = unwrap(bot) as Bot | undefined;
      return real?.players?.[order.commander.name]?.entity ?? null;
    },
  };
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
