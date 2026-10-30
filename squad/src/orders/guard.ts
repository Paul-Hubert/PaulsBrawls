// The lease-guarded bot (docs/29 §6.4). A script never holds a raw mineflayer bot: it gets a Proxy made for its
// order, so two orders can never drive one body, even when a script keeps a reference to a bot it lost.
//   • Reads pass through (bot.entity, bot.inventory, bot.players …).
//   • Every method call on the bot and on its plugin objects checks the lease first; a promise that rejects after
//     the bot left becomes a BotLeftError (the abort sequence makes in-flight goto/dig/attack reject).
//   • Listeners added through the proxy are recorded and wrapped (an error in one fails its own order, nothing
//     else), and removed when the bot leaves the order or the order ends.
//   • chat/whisper are rate-limited below vanilla's spam kick; quit/end/connect throw.
//   • A guarded bot passed to a plugin or to `new Movements(bot)` is unwrapped to the real one.

import type { Bot } from 'mineflayer';

export const REAL = Symbol.for('squad.realBot');
export const ORDER = Symbol.for('squad.order');

/** Plugin objects whose methods act on the body (they are guarded like the bot's own methods). */
export const PLUGIN_NAMESPACES = new Set(['pathfinder', 'pvp', 'collectBlock', 'tool', 'hawkEye', 'autoEat', 'armorManager']);

const LISTEN = new Set(['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']);
const UNLISTEN = new Set(['off', 'removeListener']);
const FORBIDDEN = new Set(['quit', 'end', 'connect']);

/** What the guard needs from its order. */
export interface GuardControl {
  /** Throws BotLeftError / OrderStoppedError when the order may not drive this bot right now. */
  check(): void;
  /** Whether the order still holds the bot (used to turn a late rejection into BotLeftError). */
  live(): boolean;
  /** The error to throw for a call made after the bot left. */
  leftError(): Error;
  /** Wrap a script listener (error attribution) and remember it for removal. */
  addListener(emitter: object, event: string | symbol, fn: (...a: unknown[]) => unknown): (...a: unknown[]) => unknown;
  /** The wrapper registered for `fn`, forgetting it. */
  takeListener(emitter: object, event: string | symbol, fn: (...a: unknown[]) => unknown): ((...a: unknown[]) => unknown) | undefined;
  /** A line in the order's report. */
  log(line: string): void;
  /** The order (helpers find their order through the bot). */
  order: unknown;
  /** `bot.tags` and `bot.role` (read-only extras of a guarded bot). */
  tags(): string[];
  role(): string | undefined;
}

export function unwrap<T>(value: T): T {
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    const real = (value as Record<symbol, unknown>)[REAL];
    if (real) return real as T;
  }
  return value;
}

export function isGuarded(value: unknown): boolean {
  return !!value && typeof value === 'object' && !!(value as Record<symbol, unknown>)[REAL];
}

/** The order a guarded bot belongs to (helpers use it for claims and logs), or undefined for a raw bot. */
export function orderOf<T = unknown>(bot: unknown): T | undefined {
  if (!bot || typeof bot !== 'object') return undefined;
  return (bot as Record<symbol, unknown>)[ORDER] as T | undefined;
}

// -- chat rate limit (per body, shared by every order) ---------------------------------------------------------

/** Vanilla adds 20 to a counter per chat message, removes 1 per tick, and kicks above 200: 5 quick, then 1 / 1.2 s. */
export const CHAT_BURST = 5;
export const CHAT_REFILL_MS = 1_200;
const buckets = new WeakMap<object, { tokens: number; at: number }>();

export function takeChatToken(real: object, now = Date.now()): boolean {
  const b = buckets.get(real) ?? { tokens: CHAT_BURST, at: now };
  b.tokens = Math.min(CHAT_BURST, b.tokens + (now - b.at) / CHAT_REFILL_MS);
  b.at = now;
  buckets.set(real, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// -- the proxy ---------------------------------------------------------------------------------------------------

export function guardBot(real: Bot, ctl: GuardControl): Bot {
  const methodCache = new Map<PropertyKey, unknown>();
  const nsCache = new Map<PropertyKey, unknown>();

  const settle = (r: unknown): unknown => {
    if (r && typeof (r as { then?: unknown }).then === 'function') {
      return (r as Promise<unknown>).then(
        (v) => v,
        (e) => {
          if (!ctl.live()) throw ctl.leftError();
          throw e;
        },
      );
    }
    return r;
  };

  const guardMethod = (owner: object, fn: (...a: unknown[]) => unknown): ((...a: unknown[]) => unknown) =>
    function guarded(...args: unknown[]) {
      ctl.check();
      return settle(fn.apply(owner, args.map(unwrap)));
    };

  // A plugin call (`bot.pathfinder.isMoving()`) used to build a new wrapper on every access: the wrappers are kept
  // per plugin object and property, and rebuilt only when the property now holds another function (a plugin or a
  // script replaced it). The lease is still checked on every call, inside the wrapper.
  const nsMethods = new WeakMap<object, Map<PropertyKey, { fn: unknown; g: unknown }>>();
  const guardNamespace = (ns: object): object =>
    new Proxy(ns, {
      get(target, prop) {
        if (prop === REAL) return target;
        const v = Reflect.get(target, prop, target);
        if (typeof v !== 'function' || isClass(v)) return v;
        let methods = nsMethods.get(target);
        if (!methods) nsMethods.set(target, (methods = new Map()));
        let g = methods.get(prop);
        if (!g || g.fn !== v) {
          g = { fn: v, g: guardMethod(target, v as (...a: unknown[]) => unknown) };
          methods.set(prop, g);
        }
        return g.g;
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, unwrap(value), target);
      },
    });

  const handler: ProxyHandler<Bot> = {
    get(target, prop) {
      if (prop === REAL) return target;
      if (prop === ORDER) return ctl.order;
      if (prop === 'tags') return ctl.tags();
      if (prop === 'role') return ctl.role();
      if (typeof prop === 'string') {
        if (LISTEN.has(prop)) {
          return (event: string | symbol, fn: (...a: unknown[]) => unknown) => {
            ctl.check();
            if (typeof fn !== 'function') throw new TypeError(`bot.${prop}(${String(event)}, fn): fn must be a function`);
            const wrapped = ctl.addListener(target, event, fn);
            (target as unknown as Record<string, (e: unknown, f: unknown) => unknown>)[prop]?.(event, wrapped);
            return proxy;
          };
        }
        if (UNLISTEN.has(prop)) {
          return (event: string | symbol, fn: (...a: unknown[]) => unknown) => {
            const wrapped = ctl.takeListener(target, event, fn) ?? fn;
            target.removeListener(event as never, wrapped as never);
            return proxy;
          };
        }
        if (prop === 'removeAllListeners') {
          return () => {
            throw new Error("bot.removeAllListeners() would also remove the runtime's own listeners; remove yours with bot.off(event, fn)");
          };
        }
        if (FORBIDDEN.has(prop)) {
          return () => {
            throw new Error(`bot.${prop}() is not allowed in a command: the runtime owns the bot's connection`);
          };
        }
        if (prop === 'chat' || prop === 'whisper') {
          return (...args: unknown[]) => {
            ctl.check();
            if (!takeChatToken(target)) {
              ctl.log(`${target.username}: chat dropped (rate limit, ${CHAT_BURST} quick then 1 per ${CHAT_REFILL_MS / 1000} s): ${String(args[args.length - 1]).slice(0, 80)}`);
              return;
            }
            (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        if (PLUGIN_NAMESPACES.has(prop)) {
          const ns = Reflect.get(target, prop, target);
          if (!ns || typeof ns !== 'object') return ns;
          let g = nsCache.get(prop);
          if (!g || unwrap(g) !== ns) {
            g = guardNamespace(ns as object);
            nsCache.set(prop, g);
          }
          return g;
        }
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value === 'function' && !isClass(value)) {
        let g = methodCache.get(prop) as { fn: unknown; g: unknown } | undefined;
        if (!g || g.fn !== value) {
          g = { fn: value, g: guardMethod(target, value as (...a: unknown[]) => unknown) };
          methodCache.set(prop, g);
        }
        return g.g;
      }
      return value;
    },
    set(target, prop, value) {
      if (prop === 'tags' || prop === 'role') return false;
      return Reflect.set(target, prop, unwrap(value), target);
    },
  };
  const proxy: Bot = new Proxy(real, handler);
  return proxy;
}

// Whether a function is a class: a class is handed back unwrapped, since a guarded wrapper could not be `new`ed.
// Printing a function's source on every property read was most of a plugin call's cost; a function's source never
// changes, so the answer is kept per function.
const classes = new WeakMap<object, boolean>();

function isClass(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  let c = classes.get(fn);
  if (c === undefined) {
    c = /^class[\s{]/.test(Function.prototype.toString.call(fn));
    classes.set(fn, c);
  }
  return c;
}
