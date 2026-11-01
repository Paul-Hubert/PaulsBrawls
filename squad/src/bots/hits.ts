// Who hit this bot in melee, as one event: `bot.on('meleeHit', (attacker, { blocked }) => …)`. A shield-wall guard
// answers a melee hit with one blow (mur-de-boucliers, docs/29 §5.4), and mineflayer tells only half of it: an
// unblocked hit is a damage_event naming its cause (mineflayer's `entityHurt`), but a hit the raised shield stopped is
// entity status 29 (Minecraft's BLOCK_WITH_SHIELD), which names nobody and which mineflayer does not report at all.
//   • Unblocked: a damage_event on this bot whose direct source is its cause (a sword, a zombie's arm; an arrow, a
//     fireball or evoker fangs are a direct source of their own), a living entity within MELEE_REACH.
//   • Blocked: the entity within MELEE_REACH whose arm swing (animation 0) came nearest the block. A mob swings in the
//     tick of its hit, before it; a player's client sends its attack, then its swing, so that swing arrives just after
//     the block: the block waits SWING_LATE_MS for it. Nobody swung (an arrow, an explosion): no event.

import type { EventEmitter } from 'node:events';

import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';

/** Farther than this (feet to feet) is not a melee hit: a player reaches 3 blocks from the eyes, plus knockback. */
export const MELEE_REACH = 5;
/** A swing this long before a block can be its hit's. */
export const SWING_EARLY_MS = 400;
/** How long a blocked hit waits for its attacker's swing (a player's comes after the block). */
export const SWING_LATE_MS = 150;
/** Minecraft's EntityStatuses.BLOCK_WITH_SHIELD. */
export const STATUS_SHIELD_BLOCK = 29;

/** What `meleeHit` says besides the attacker. */
export interface MeleeHit {
  /** The raised shield stopped it (no damage). */
  blocked: boolean;
}

/** Not a creature: arrows, tridents, fireballs, items, XP orbs, vehicles. */
const NOT_LIVING = new Set(['projectile', 'other', 'object', 'orb', 'global']);

/** Install the `meleeHit` event on one bot instance (once, after spawn; its listeners end with its connection). */
export function installMeleeHits(bot: Bot): void {
  const client = (bot as unknown as { _client?: EventEmitter })._client;
  if (!client?.on) return;
  /** Entity id → when it last swung its main arm. */
  const swings = new Map<number, number>();
  const inReach = (e: Entity | undefined): e is Entity =>
    !!e && e !== bot.entity && e.isValid !== false && !!e.position && !!bot.entity?.position && !NOT_LIVING.has(String(e.type)) && e.position.distanceTo(bot.entity.position) <= MELEE_REACH;

  client.on('animation', (p: { entityId: number; animation: number }) => {
    if (p.animation !== 0) return;
    const now = Date.now();
    swings.set(p.entityId, now);
    if (swings.size > 64) for (const [id, t] of swings) if (t < now - SWING_EARLY_MS) swings.delete(id);
  });

  client.on('damage_event', (p: { entityId: number; sourceCauseId: number; sourceDirectId: number }) => {
    if (!bot.entity || p.entityId !== bot.entity.id) return;
    // Both ids are the entity's id + 1, 0 for none.
    if (p.sourceCauseId <= 0 || p.sourceDirectId !== p.sourceCauseId) return;
    const attacker = bot.entities[p.sourceCauseId - 1];
    if (inReach(attacker)) bot.emit('meleeHit' as never, attacker as never, { blocked: false } as never);
  });

  client.on('entity_status', (p: { entityId: number; entityStatus: number }) => {
    if (!bot.entity || p.entityId !== bot.entity.id || p.entityStatus !== STATUS_SHIELD_BLOCK) return;
    const at = Date.now();
    setTimeout(() => {
      let attacker: Entity | null = null;
      let nearest = Infinity;
      for (const [id, t] of swings) {
        if (t < at - SWING_EARLY_MS) continue;
        const e = bot.entities[id];
        if (!inReach(e) || Math.abs(t - at) >= nearest) continue;
        attacker = e;
        nearest = Math.abs(t - at);
      }
      if (attacker) bot.emit('meleeHit' as never, attacker as never, { blocked: true } as never);
    }, SWING_LATE_MS);
  });
}
