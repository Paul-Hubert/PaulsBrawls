// Riding a horse (docs/41). The mounted kits (`horseman`, `horsearcher`) sit a bot on a tamed, saddled horse, and
// the server moves a horse its player rides only from that player's `vehicle_move` packets (vanilla's client runs the
// horse's physics). Mineflayer sends none: its bot would sit still on its horse whatever its orders.
//
// So a riding bot keeps walking as if on foot: mineflayer's physics moves its body with the pathfinder's controls as
// always (every command, goal, `stepTo` and look works unchanged), with the horse's speed, and every physics tick this
// module sends where that body is as the horse's move. The body stands where the horse stands (its feet are the
// horse's), the eyes are the rider's (`eyeHeight` + the seat), and the server, which moves the horse with its own
// collisions, keeps the claim unless the horse would end in a block: then it sends the horse's position back, and the
// body goes there. A 1.4-wide horse does not pass where a 0.6-wide body does (a door, a 1-wide gap): there it stops.
//   • Sneaking makes a rider get off: while riding, the sneak control stays local (the slow, careful last step of a
//     line still works) and its packets are not sent.
//   • Off the horse (it died, the bot was dismounted), nothing is left of this: eye height and speed are the player's.
//   • A free rein (`freeRein`, held by `shoot` for a draw): the horse goes where the walk steers (the pathfinder, a
//     line's last step: `steer`), the rider looks where it aims. The body's physics walks along `entity.moveYaw`
//     (squad's prismarine-physics patch), the horse's move faces it, and the look is the aim's: a horse archer shoots
//     on the move. On foot a player walks where it looks, so a free rein does nothing there.

import type { EventEmitter } from 'node:events';

import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';

/**
 * The rider's feet above its horse's: the horse's passenger attachment (1.44375) minus a player's vehicle attachment
 * (0.6), Minecraft 1.21 and 26.x. The same for every horse-like mount the kits use.
 */
export const HORSE_SEAT = 0.84375;
/** Mounts this module drives (minecraft-data entity names). */
export const RIDDEN = new Set(['horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse']);
/** A standing player's eyes above its feet. */
export const PLAYER_EYES = 1.62;
/** A horse's speed when the server has not told it (the average of a spawned horse's, 0.1125–0.3375). */
export const HORSE_SPEED = 0.225;
/** Sprinting adds 30 % (prismarine-physics' sprint modifier); the pathfinder sprints, a horse does not. */
const SPRINT = 1.3;

interface Attribute {
  value: number;
  modifiers: unknown[];
}
type Client = EventEmitter & { write: (name: string, params: Record<string, unknown>) => void };
type Riding = Bot & {
  _client?: Client;
  vehicle?: Entity | null;
  entity: Entity & { eyeHeight?: number; attributes?: Record<string, Attribute>; moveYaw?: number };
  pathfinder?: { steer?: (yaw: number) => void };
};

/**
 * Turn a walking bot toward `yaw` (mineflayer's radians): its look, or, while it rides with a free rein, only its
 * horse's heading (the look is the aim's). The pathfinder steers through this (bot.pathfinder.steer, squad's patch).
 */
export function steer(bot: Bot, yaw: number, force = false): void {
  const e = (bot as Riding).entity;
  if (e && e.moveYaw !== undefined) {
    e.moveYaw = yaw;
    return;
  }
  void bot.look(yaw, 0, force)?.catch?.(() => undefined);
}

/**
 * Hold a free rein while a riding bot looks away from where it goes (a bow's draw): the walk keeps its heading
 * (`steer`) and the look is free. Returns the release, which turns the look back to the heading. On foot, or already
 * held: nothing (a no-op release).
 */
export function freeRein(bot: Bot): () => void {
  const e = (bot as Riding).entity;
  if (!isRiding(bot) || !e || e.moveYaw !== undefined) return () => undefined;
  e.moveYaw = e.yaw;
  return () => {
    const heading = e.moveYaw;
    delete e.moveYaw;
    if (heading !== undefined && isRiding(bot)) void bot.look(heading, 0, true)?.catch?.(() => undefined);
  };
}

/** Whether this bot is riding a mount it drives now. */
export function isRiding(bot: Bot): boolean {
  const v = (bot as Riding).vehicle;
  return !!v && RIDDEN.has(String(v.name));
}

/** A sneak packet (start sneaking), in both forms: `player_input` with shift (1.21.6+), `entity_action` 0 before. */
export function isSneakStart(name: string, params: Record<string, unknown> | undefined): boolean {
  if (name === 'player_input') return !!(params?.inputs as { shift?: boolean } | undefined)?.shift;
  if (name === 'entity_action') return params?.actionId === 0 || params?.actionId === 'start_sneaking';
  return false;
}

/** Install riding on one bot instance (once, after spawn; it ends with its connection). */
export function installRiding(bot: Bot): void {
  const b = bot as Riding;
  // prismarine-physics reads the speed under this key (minecraft:movement_speed in 1.21.2+, generic. before).
  const registry = (bot as unknown as { registry?: { attributesByName?: Record<string, { resource?: string }> } }).registry;
  const speedAttribute = registry?.attributesByName?.movementSpeed?.resource ?? 'minecraft:movement_speed';
  const client = b._client;
  if (!client?.on || typeof client.write !== 'function') return;
  let riding = false;
  if (b.pathfinder) b.pathfinder.steer = (yaw: number) => steer(bot, yaw);
  /** The bot's own speed attribute, kept while it rides (the server's value, restored on foot). */
  let own: Attribute | undefined;

  const write = client.write.bind(client);
  client.write = (name: string, params: Record<string, unknown>) => {
    if (riding && isSneakStart(name, params)) return; // a sneaking rider gets off
    write(name, params);
  };

  const horseSpeed = (): number => {
    const a = b.vehicle && (b.vehicle as Entity & { attributes?: Record<string, Attribute> }).attributes?.[speedAttribute];
    return a && Number.isFinite(a.value) && a.value > 0 ? a.value : HORSE_SPEED;
  };

  const mount = (): void => {
    const v = b.vehicle;
    if (!v || !RIDDEN.has(String(v.name)) || !b.entity?.position) return;
    if (!riding) own = b.entity.attributes?.[speedAttribute];
    riding = true;
    // The body starts where the horse stands (the server put the rider on its seat; mineflayer does not move it).
    b.entity.position = v.position.clone();
    b.entity.velocity?.set?.(0, 0, 0);
  };

  const dismount = (): void => {
    if (!riding) return;
    riding = false;
    if (b.entity) {
      b.entity.eyeHeight = PLAYER_EYES;
      if (b.entity.attributes) {
        if (own) b.entity.attributes[speedAttribute] = own;
        else delete b.entity.attributes[speedAttribute];
      }
    }
    own = undefined;
    if (b.entity) delete b.entity.moveYaw;
  };

  bot.on('mount', mount);
  bot.on('dismount', dismount);
  mount(); // already on its horse (the server seated it before this ran)

  // The horse's move, every physics tick: where the body is now, facing where the rider looks (with a free rein: where
  // it goes).
  bot.on('physicsTick', () => {
    if (!riding) return;
    if (!isRiding(bot)) {
      dismount();
      return;
    }
    const e = b.entity;
    // Re-asserted every tick: mineflayer resets the eyes on a pose change, the server's attributes on an update.
    e.eyeHeight = PLAYER_EYES + HORSE_SEAT;
    if (e.attributes) e.attributes[speedAttribute] = { value: horseSpeed() / SPRINT, modifiers: [] };
    const p = e.position;
    write('vehicle_move', {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: notchianYaw(e.moveYaw ?? e.yaw),
      pitch: 0,
      onGround: !!e.onGround,
    });
  });

  // The server put the horse back (it would have ended in a block, or moved too far): the body goes with it.
  client.on('vehicle_move', (p: { x: number; y: number; z: number }) => {
    if (!riding || !b.entity) return;
    b.entity.position.set(p.x, p.y, p.z);
    b.entity.velocity?.set?.(0, 0, 0);
  });
}

/** Mineflayer's yaw (radians, 0 = north, counter-clockwise) to Minecraft's degrees (0 = south), as it sends it. */
export function notchianYaw(yaw: number): number {
  return Math.fround(((180 - (yaw * 180) / Math.PI) % 360 + 360) % 360);
}
