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
// This pass's scope (the M5 host-wiring milestone): `hurt` + `health` + `death`. The other normalized
// events (entity-spotted / item-received / block-broken-nearby / run-finished / inbox / time) are a
// documented follow-up — their native sources need their own translation and are not needed for the
// cooperative-mob-defense reflex. Forwarding only these three means the unfired router rows stay inert
// (no emitter ever fires them), so nothing spams a wake-up before its source is real.
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
  /** Remove every native listener this adapter added to the bot (pair with the router's detach). */
  detach(): void;
}

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
export function attachReactivitySignals(bot: Bot): BotSignals {
  const bus = new EventEmitter();
  bus.setMaxListeners(0); // the router binds one listener per emitter row (~11); never warn
  let lastHealth: number | undefined = typeof bot.health === 'number' ? bot.health : undefined;

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

  bot.on('health', onHealth);
  bot.on('death', onDeath);

  return {
    signals: bus,
    detach(): void {
      bot.removeListener('health', onHealth);
      bot.removeListener('death', onDeath);
      bus.removeAllListeners();
    },
  };
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
