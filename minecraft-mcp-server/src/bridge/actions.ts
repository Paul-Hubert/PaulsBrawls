import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { log } from '../logger.js';

/**
 * Bot-action functions used by the bridge HTTP server. Each is a tiny wrapper
 * around a mineflayer primitive plus structured logging. The bridge is a dumb
 * RPC: any non-trivial choice (where to appear, what to say) is made Java-side
 * in pauls-brawls before calling here.
 *
 * All teleports are issued as chat commands because the bot is server-op; this
 * means appear/vanish work without any extra plugin or permission scheme.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  detail?: unknown;
}

function ok(detail?: unknown): ActionResult {
  return detail === undefined ? { ok: true } : { ok: true, detail };
}

function fail(error: string): ActionResult {
  log('warn', `bridge action failed: ${error}`);
  return { ok: false, error };
}

function requireBot(bot: mineflayer.Bot | null): bot is mineflayer.Bot {
  return bot !== null && bot !== undefined;
}

export function health(bot: mineflayer.Bot | null): ActionResult {
  if (!requireBot(bot)) {
    return { ok: false, error: 'bot not connected' };
  }
  return {
    ok: true,
    detail: {
      connected: true,
      username: bot.username,
      position: bot.entity?.position
        ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
        : null,
    },
  };
}

/**
 * Teleports the bot in front of the player and (optionally) makes it face the
 * player in a single command. We rely on the vanilla /tp form
 *   /tp <bot> <x> <y> <z> facing entity <player>
 * which the server applies atomically, sparing us a separate /look round-trip.
 */
export function appear(
  bot: mineflayer.Bot | null,
  args: { x: number; y: number; z: number; facing?: string | null }
): ActionResult {
  if (!requireBot(bot)) return fail('bot not connected');
  if (typeof args.x !== 'number' || typeof args.y !== 'number' || typeof args.z !== 'number') {
    return fail('appear requires numeric x,y,z');
  }
  const botName = bot.username;
  const facing = args.facing && args.facing.length > 0 ? ` facing entity ${args.facing}` : '';
  const cmd = `/tp ${botName} ${args.x.toFixed(2)} ${args.y.toFixed(2)} ${args.z.toFixed(2)}${facing}`;
  bot.chat(cmd);
  log('info', `appear: ${cmd}`);
  return ok({ cmd });
}

export function chat(bot: mineflayer.Bot | null, args: { message: string }): ActionResult {
  if (!requireBot(bot)) return fail('bot not connected');
  if (typeof args.message !== 'string' || args.message.length === 0) {
    return fail('chat requires non-empty message');
  }
  // Strip any leading slash so the model can't make the bot run an arbitrary
  // command by accident through /chat — gestures and teleports have their own
  // endpoints.
  const safe = args.message.startsWith('/') ? args.message.slice(1) : args.message;
  bot.chat(safe);
  return ok();
}

export function look(bot: mineflayer.Bot | null, args: { x: number; y: number; z: number }): ActionResult {
  if (!requireBot(bot)) return fail('bot not connected');
  if (typeof args.x !== 'number' || typeof args.y !== 'number' || typeof args.z !== 'number') {
    return fail('look requires numeric x,y,z');
  }
  bot.lookAt(new Vec3(args.x, args.y, args.z)).catch((err: unknown) => {
    log('warn', `lookAt failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return ok();
}

/**
 * Tiny choreography vocabulary. Anything more elaborate (walk to point, attack
 * mob) belongs in its own endpoint with its own validation.
 */
export function gesture(bot: mineflayer.Bot | null, args: { type: string }): ActionResult {
  if (!requireBot(bot)) return fail('bot not connected');
  const type = (args.type ?? '').toLowerCase();
  switch (type) {
    case 'swing':
      bot.swingArm('right');
      return ok();
    case 'jump':
      bot.setControlState('jump', true);
      setTimeout(() => {
        try { bot.setControlState('jump', false); } catch { /* bot may be gone */ }
      }, 200);
      return ok();
    case 'sneak':
      bot.setControlState('sneak', true);
      setTimeout(() => {
        try { bot.setControlState('sneak', false); } catch { /* bot may be gone */ }
      }, 600);
      return ok();
    case 'nod': {
      // Look slightly down and back up — a quick nod with the head.
      const here = bot.entity?.position;
      if (!here) return fail('bot has no position');
      const down = new Vec3(here.x, here.y - 2, here.z);
      const fwd  = new Vec3(here.x + 1, here.y, here.z);
      bot.lookAt(down).then(() => bot.lookAt(fwd)).catch(() => { /* ignore */ });
      return ok();
    }
    case 'summon': {
      // Raise the arm and look slightly up — a casting gesture.
      const here = bot.entity?.position;
      if (!here) return fail('bot has no position');
      bot.swingArm('right');
      const up = new Vec3(here.x, here.y + 4, here.z);
      bot.lookAt(up).catch(() => { /* ignore */ });
      return ok();
    }
    default:
      return fail(`unknown gesture: ${type}`);
  }
}

/**
 * Sends the bot to a parking spot via /tp. The caller (Java) picks the parking
 * coordinates so the bridge stays oblivious to world layout. If no coords are
 * supplied we use a fixed "deep negative-Y" point that's far from anything
 * players can normally reach.
 */
export function vanish(
  bot: mineflayer.Bot | null,
  args: { x?: number; y?: number; z?: number } = {}
): ActionResult {
  if (!requireBot(bot)) return fail('bot not connected');
  const x = typeof args.x === 'number' ? args.x : 0;
  const y = typeof args.y === 'number' ? args.y : -64;
  const z = typeof args.z === 'number' ? args.z : 0;
  const cmd = `/tp ${bot.username} ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)}`;
  bot.chat(cmd);
  log('info', `vanish: ${cmd}`);
  return ok({ cmd });
}
