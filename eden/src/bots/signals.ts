// Per-bot reactivity SIGNAL ADAPTER (layer 1, bots/) — the translation seam between mineflayer's native
// bot events and the synthetic "raw signals" the M5 EventRouter (villagers/events.ts) consumes. The
// EventRouter is DESIGNED to listen to a normalized shape (its `entityHurt` row expects
// `(self, { damage, byEntity })`, not mineflayer's bare `entityHurt(entity)`), so something must do the
// translation. That is this module, and it keeps that knowledge in ONE place (bots/, where the raw bot
// lives), not smeared across the actor layer.
//
// Why a dedicated emitter (the bus) and NOT the bot itself:
//   • mineflayer fires native `entityHurt(entity)` for EVERY entity (incl. the bot) with no damage/attacker.
//     If the router listened to the bot directly it would receive those too and emit spurious damage-0
//     `hurt` events for every entity in the world. So we synthesize `entityHurt` from the bot's own
//     `health` delta and emit it on a FRESH bus the router attaches to instead — no collision, no leakage.
//
// Forwarded today: `hurt` + `health` + `death` (M5), and since docs/22 B3.1: `chat` (player vs villager, with
// the speaker's distance), `entitySpotted` / `entityGone` (a proximity edge WITH hysteresis — enter within
// `spotRadius`, leave beyond `loseRadius`, so an entity pacing on the boundary does not flap), `time` (the router
// owns the night-falls/new-day edge), and `inbox` through {@link BotSignals.emit} (the host signals it; the bot
// has no inbox). item-received / block-broken-nearby / run-finished stay inert: no role subscribes to them yet.
//
// bots/ may import journal/config/types — never engines or actors (the dependency law).

import { EventEmitter } from 'node:events';

import type { Bot, EmitterLike, Vec3Like } from '../types/bot';

/** Hostile entity names — the attacker derivation classifies `bot.entities` by name (mirrors the
 *  FilterEvaluator's table in villagers/subscriptions.ts; kept local so bots/ imports no actor code). */
const HOSTILE: ReadonlySet<string> = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'witch', 'slime', 'silverfish', 'phantom',
  'pillager', 'vindicator', 'illusioner', 'ravager', 'evoker',
  'blaze', 'ghast', 'magma_cube', 'zoglin', 'hoglin', 'piglin', 'piglin_brute', 'enderman',
]);

/** What {@link attachReactivitySignals} returns: the bus the EventRouter attaches to + a detacher. */
export interface BotSignals {
  /** The synthetic-signal bus — pass as the EventRouter's `signals`; it reads live state from the bot. */
  signals: EmitterLike;
  /** Emit a host-side signal that has no mineflayer source (today: `inbox`) on this bot's bus. */
  emit(raw: string, ...args: unknown[]): void;
  /** Remove every native listener this adapter added to the bot (pair with the router's detach). */
  detach(): void;
}

/** Options for {@link attachReactivitySignals}. */
export interface SignalOptions {
  /** True for a roster villager's username — its chat becomes `villager-chat`, everyone else's `player-chat`. */
  isVillager?: (username: string) => boolean;
  /** Speakers whose chat is not an event at all (the divine avatar: God reaches villagers through the inbox). */
  isSilent?: (username: string) => boolean;
  /** An entity entering this radius (blocks) is `entitySpotted`. Default 16 (the guard role's filter). */
  spotRadius?: number;
  /** A spotted entity is `entityGone` only beyond this radius (hysteresis). Default 24. */
  loseRadius?: number;
}

/** Chat distance when the speaker's entity is not loaded (out of render range) — far beyond any `within`. */
export const CHAT_DISTANCE_UNKNOWN = 9999;

/** Entity kinds that never count as "spotted" (items, xp orbs, arrows, the world). */
const NOT_SPOTTABLE: ReadonlySet<string> = new Set(['object', 'orb', 'projectile', 'global', 'other']);

/**
 * Wire one bot's native mineflayer events to a fresh synthetic-signal bus for the M5 EventRouter.
 *
 * Mapping (the defensible derivation the kickoff calls for):
 *   • native `health` → recompute the health delta. A DECREASE since the last observation is the damage;
 *     emit a synthetic `entityHurt(self, { damage, byEntity })` where `byEntity` is the nearest hostile's
 *     bare name (mineflayer's native `entityHurt` carries neither damage nor attacker). ALSO re-emit
 *     `health` so the router's hysteresis-edged `health-low` fires + re-arms (it reads `bot.health` itself).
 *   • native `death` → `death` (the router maps it to a `died` event).
 *
 * The first `health` observation only sets the baseline (no spurious hurt at spawn). Food-only `health`
 * ticks (mineflayer fires `health` for both) carry no decrease, so they forward `health` but no `entityHurt`.
 */
export function attachReactivitySignals(bot: Bot, opts: SignalOptions = {}): BotSignals {
  const bus = new EventEmitter();
  bus.setMaxListeners(0); // the router binds one listener per emitter row (~11); never warn
  let lastHealth: number | undefined = typeof bot.health === 'number' ? bot.health : undefined;
  const spotRadius = opts.spotRadius ?? 16;
  const loseRadius = Math.max(opts.loseRadius ?? 24, spotRadius);
  /** id → name of the entities currently inside the spotted set (the proximity edge's latch). */
  const spotted = new Map<number, string>();

  const onHealth = (): void => {
    const hp = typeof bot.health === 'number' ? bot.health : 20;
    if (lastHealth !== undefined && hp < lastHealth) {
      const info: { damage: number; byEntity?: string } = { damage: lastHealth - hp };
      const attacker = nearestHostileName(bot);
      if (attacker !== undefined) info.byEntity = attacker;
      bus.emit('entityHurt', bot.entity, info);
    }
    lastHealth = hp;
    bus.emit('health'); // drives health-low (edge fires once; re-arms when health recovers)
  };
  const onDeath = (): void => void bus.emit('death');

  // chat(username, message): the bot's own lines are not an event for itself. The speaker's distance rides in the
  // meta so `within` can gate a chat subscription (an unloaded speaker is CHAT_DISTANCE_UNKNOWN away).
  const onChat = (...args: unknown[]): void => {
    const username = String(args[0] ?? '');
    if (!username || username === bot.username || opts.isSilent?.(username)) return;
    const isVillager = opts.isVillager?.(username) ?? false;
    bus.emit('chat', username, String(args[1] ?? ''), { isVillager, distance: distanceTo(bot, playerPosition(bot, username)) });
  };

  // Proximity edge with hysteresis (04: hysteresis lives in the emitter). entityMoved fires for every visible
  // entity on every movement packet, so this stays a cheap distance check against a small latch map.
  const onEntity = (...args: unknown[]): void => {
    const e = args[0] as { id?: number; name?: string; type?: string; position?: Vec3Like } | undefined;
    if (!e || typeof e.id !== 'number' || !e.name || !e.position) return;
    if (e === (bot.entity as unknown) || (e.type !== undefined && NOT_SPOTTABLE.has(e.type))) return;
    const d = distanceTo(bot, e.position);
    if (!spotted.has(e.id)) {
      if (d <= spotRadius) {
        spotted.set(e.id, e.name);
        bus.emit('entitySpotted', { id: e.id, name: e.name, distance: Math.round(d * 10) / 10 });
      }
    } else if (d > loseRadius) {
      spotted.delete(e.id);
      bus.emit('entityGone', { id: e.id, name: e.name });
    }
  };
  const onEntityGone = (...args: unknown[]): void => {
    const e = args[0] as { id?: number; name?: string } | undefined;
    if (!e || typeof e.id !== 'number' || !spotted.has(e.id)) return;
    spotted.delete(e.id);
    bus.emit('entityGone', { id: e.id, name: e.name });
  };

  const onTime = (): void => void bus.emit('time'); // the router reads bot.time and owns the day/night edge

  const native: Array<[string, (...a: unknown[]) => void]> = [
    ['health', onHealth],
    ['death', onDeath],
    ['chat', onChat],
    ['entitySpawn', onEntity],
    ['entityMoved', onEntity],
    ['entityGone', onEntityGone],
    ['time', onTime],
  ];
  for (const [ev, fn] of native) bot.on(ev, fn);

  return {
    signals: bus,
    emit(raw: string, ...args: unknown[]): void {
      bus.emit(raw, ...args);
    },
    detach(): void {
      for (const [ev, fn] of native) bot.removeListener(ev, fn);
      spotted.clear();
      bus.removeAllListeners();
    },
  };
}

/** Euclidean distance from the bot to a position, or CHAT_DISTANCE_UNKNOWN when either side is unknown. */
function distanceTo(bot: Bot, p: Vec3Like | undefined): number {
  const me = bot.entity?.position;
  if (!me || !p) return CHAT_DISTANCE_UNKNOWN;
  const dx = p.x - me.x, dy = p.y - me.y, dz = p.z - me.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** A player's position from mineflayer's `bot.players[username].entity` (mineflayer-only; localized cast). */
function playerPosition(bot: Bot, username: string): Vec3Like | undefined {
  const players = (bot as unknown as { players?: Record<string, { entity?: { position?: Vec3Like } } | undefined> }).players;
  return players?.[username]?.entity?.position;
}

/** The bare name of the nearest hostile entity to the bot, or undefined (no entities / none in range).
 *  `bot.entities` is mineflayer-only (not on the narrowed Bot seam), read through a localized cast. */
function nearestHostileName(bot: Bot): string | undefined {
  const me = bot.entity?.position;
  if (!me) return undefined;
  const entities = (bot as unknown as {
    entities?: Record<string, { name?: string; position?: Vec3Like } | undefined>;
  }).entities;
  if (!entities) return undefined;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const e of Object.values(entities)) {
    if (!e || !e.name || !e.position || !HOSTILE.has(e.name)) continue;
    const dx = e.position.x - me.x, dy = e.position.y - me.y, dz = e.position.z - me.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < bestDist) {
      bestDist = d;
      best = e.name;
    }
  }
  return best;
}
