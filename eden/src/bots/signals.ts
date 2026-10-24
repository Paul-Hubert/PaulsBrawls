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
//     The same separation lets us shape `chat`/`playerCollect` into the router's exact row payloads and
//     synthesize the `entitySpotted`/`entityGone` signals mineflayer has no native event for.
//
// What this adapter bridges onto the bus (HIGH-3 — the rows in events.ts that were previously inert):
//   • `entityHurt` ← derived from the bot's `health` delta (damage + nearest-hostile attacker).
//   • `health`     ← native `health` re-emitted so the hysteresis-edged `health-low` row fires + re-arms.
//   • `death`      ← native `death`.
//   • `chat`       ← native `chat`/`whisper`, shaped `(from, text, { isVillager })`. A speaker that is one
//                    of OUR bots (a villager or the avatar) is tagged `isVillager:true` so the router maps
//                    it to `villager-chat`, never `player-chat` — a villager must not react to its own
//                    speech (or another bot's) as if a player spoke, or two villagers loop forever.
//   • `itemReceived` ← native `playerCollect`, but ONLY when the collector is THIS bot (mineflayer fires it
//                    for every nearby player's pickup too).
//   • `entitySpotted`/`entityGone` ← a BOUNDED poll over `bot.entities` (no native "spotted" event). It is
//                    storm-proofed: an `entitySpotted` fires only when a NEW qualifying entity ENTERS range
//                    (deduped by entity id), and `entityGone` fires once on leave so a re-entry re-fires.
//                    The hysteresis/coalescing downstream (events.ts + the router's R36) does the rest.
//
// NOT bridged off the bot here (by design):
//   • `time` (night-falls/new-day) — mineflayer's native `time` fires ~20 Hz. Rather than forward that
//     stream (churning the router's mapper) or throttle it (risk dropping the one crossing we care about),
//     the day/night phase is SAMPLED on the host's existing 30 s coarse clock: EventRouter.tick() now
//     re-evaluates the `time` row (events.ts). A phase lasts minutes, so 30 s sampling always catches the
//     crossing, and the mapper's latch keeps it one-edge-per-transition. No native `time` listener needed.
//   • `inbox` — an inbox delivery is an in-process event, not a bot signal, so it is wired at the delivery
//     site (villagers/inbox.ts → main.ts → VillagerReactivity.signalInbox), not off the bot.
//   • `runFinished`/`blockBrokenNearby` — a documented follow-up (no live mortal subscription needs them
//     yet; their rows stay inert until a source is bridged — no spurious wake-up before its source is real).
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

/** How far a NEW entity must be (blocks) to count as "spotted". Above this it's out of perception and the
 *  poll drops it (so re-entry re-fires). 16 matches the guard's `entity-spotted within:16` role default. */
const SPOTTED_RANGE = 24;
/** How often the entity poll scans `bot.entities`. Coarse on purpose — entering range is a discrete
 *  incident (dedupe by id), so a slow poll never misses a stay; it only bounds how fast a re-entry re-fires. */
const ENTITY_POLL_MS = 2000;

/** Options for {@link attachReactivitySignals}. */
export interface ReactivitySignalsOptions {
  /**
   * The usernames of OUR bots (every villager + the avatar). A `chat`/`whisper` from one of these is
   * tagged `isVillager:true` so the router emits `villager-chat`, not `player-chat` — the load-bearing
   * guard against a villager reacting to its own (or a peer's) speech as a player tell (would loop).
   * Defaults to empty (every speaker is then treated as a player — the unit-test default).
   */
  botNames?: ReadonlySet<string>;
  /** Entity-poll interval (ms). Defaults to {@link ENTITY_POLL_MS}; tests lower it to drive the poll fast. */
  entityPollMs?: number;
}

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
 *   • native `chat`/`whisper` → `chat(from, text, { isVillager })` (own-bot speech tagged so it can't
 *     drive a player-chat deliberation loop).
 *   • native `playerCollect` (collector === self) → `itemReceived(item)`.
 *   • a bounded `bot.entities` poll → `entitySpotted`/`entityGone` on range crossings (deduped by id).
 *
 * The first `health` observation only sets the baseline (no spurious hurt at spawn). Food-only `health`
 * ticks (mineflayer fires `health` for both) carry no decrease, so they forward `health` but no `entityHurt`.
 */
export function attachReactivitySignals(bot: Bot, opts: ReactivitySignalsOptions = {}): BotSignals {
  const bus = new EventEmitter();
  bus.setMaxListeners(0); // the router binds one listener per emitter row (~11); never warn
  const botNames = opts.botNames ?? new Set<string>();
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

  // chat/whisper: shape into the router's `chat(from, text, { isVillager })` row. Own-bot speech (any
  // villager or the avatar) is tagged isVillager so it routes to villager-chat, never player-chat (R36 +
  // CRIT-4 hygiene: a villager must not deliberate on its own/another bot's words as if a player spoke).
  const onChat = (...args: unknown[]): void => {
    const from = typeof args[0] === 'string' ? args[0] : '';
    const text = typeof args[1] === 'string' ? args[1] : '';
    if (from === bot.username) return; // never react to your OWN line (would self-trigger every reply)
    bus.emit('chat', from, text, { isVillager: botNames.has(from) });
  };

  // playerCollect(collector, collected): only OUR pickups become item-received (mineflayer fires it for
  // every nearby player's pickup too). The collected entity carries the item metadata on different shapes
  // across versions — read name/count defensively, defaulting count to 1 (the router defaults it too).
  const onPlayerCollect = (...args: unknown[]): void => {
    const collector = args[0] as { username?: string } | undefined;
    if (!collector || collector.username !== bot.username) return;
    const collected = args[1] as
      | { name?: string; count?: number; metadata?: unknown; getDroppedItem?: () => { name?: string; count?: number } }
      | undefined;
    const dropped = typeof collected?.getDroppedItem === 'function' ? collected.getDroppedItem() : undefined;
    const name = dropped?.name ?? collected?.name ?? '';
    const count = typeof dropped?.count === 'number' ? dropped.count
      : typeof collected?.count === 'number' ? collected.count : 1;
    bus.emit('itemReceived', { name, count });
  };

  // entity poll: emit `entitySpotted` once when a qualifying entity ENTERS range, `entityGone` once on
  // leave (so a re-entry re-fires). Deduped by entity id → a stay never re-fires (R36 one-incident).
  const present = new Set<number>(); // ids currently inside SPOTTED_RANGE (the dedupe set)
  const onPoll = (): void => {
    const me = bot.entity?.position;
    if (!me) return;
    const entities = (bot as unknown as {
      entities?: Record<string, { name?: string; id?: number; position?: Vec3Like; username?: string } | undefined>;
    }).entities;
    if (!entities) return;
    const seenNow = new Set<number>();
    for (const [key, e] of Object.entries(entities)) {
      if (!e || !e.position) continue;
      // mineflayer keys `bot.entities` by id; the value also carries `.id`. Prefer the value's id, fall
      // back to the (numeric) key — either gives a stable dedupe handle. Skip if neither is a number.
      const id = typeof e.id === 'number' ? e.id : Number.isFinite(Number(key)) ? Number(key) : undefined;
      if (id === undefined) continue;
      if (e.username === bot.username) continue; // never "spot" yourself
      const dx = e.position.x - me.x, dy = e.position.y - me.y, dz = e.position.z - me.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > SPOTTED_RANGE) continue; // out of perception — not present
      seenNow.add(id);
      if (!present.has(id)) {
        present.add(id);
        const name = e.name ?? e.username ?? 'entity';
        bus.emit('entitySpotted', { name, id, distance: dist });
      }
    }
    // Anything previously present but not seen this scan has LEFT range — emit one entityGone + drop it.
    for (const id of [...present]) {
      if (!seenNow.has(id)) {
        present.delete(id);
        bus.emit('entityGone', { id });
      }
    }
  };

  bot.on('health', onHealth);
  bot.on('death', onDeath);
  bot.on('chat', onChat);
  bot.on('whisper', onChat);
  bot.on('playerCollect', onPlayerCollect);
  const pollTimer = setInterval(onPoll, opts.entityPollMs ?? ENTITY_POLL_MS);
  pollTimer.unref(); // never hold the loop open (CI/test safety — the host's only timers are unref'd)

  return {
    signals: bus,
    detach(): void {
      bot.removeListener('health', onHealth);
      bot.removeListener('death', onDeath);
      bot.removeListener('chat', onChat);
      bot.removeListener('whisper', onChat);
      bot.removeListener('playerCollect', onPlayerCollect);
      clearInterval(pollTimer);
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
