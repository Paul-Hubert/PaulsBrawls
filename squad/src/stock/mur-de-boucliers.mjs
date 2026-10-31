// Stock command, made for a bound shield (/bots orders bind mur-de-boucliers): the guards line up across the
// commander's view at the block they look at (or a few blocks ahead of them when it is too far, or nothing is looked
// at), face along the view and raise their shields once in place. A hostile mob, or a player who is not on our team,
// coming within `reach` of a guard's slot is fought, leashed to the slot; the guard then goes back and raises its
// shield again. Each click of the bound shield re-forms the wall where the commander now looks, without stopping the
// order (it listens: ctx.commander.on('trigger')).
//
// Slots go to the bots in their order along the line (left to right as the commander sees it), so no two paths
// cross; that assignment holds for one formation and is redone when the wall moves or a new guard joins. A guard
// reclaimed by another order keeps its slot, and takes it again when it comes back. Shields go down to walk
// (blocking slows walking) and up on arrival, and the loop raises a shield again when something lowered it (auto-eat
// lowers it to eat). The bots walk with pathfinder goals and look again every 200 ms, so a new formation takes them
// at once.
export const manifest = {
  summary: 'Mur de boucliers en travers de mon regard',
  params: {
    type: 'object',
    properties: {
      distance: { type: 'integer', minimum: 4, maximum: 64, default: 24, description: 'au-delà, le mur se forme quelques blocs devant moi' },
      spacing: { type: 'number', minimum: 1, maximum: 3, default: 1, description: 'écart entre deux gardes' },
      reach: { type: 'integer', minimum: 1, maximum: 12, default: 4, description: 'distance à laquelle un garde quitte le mur pour frapper' },
    },
  },
  roles: { guards: { select: { hasItem: 'shield' }, min: 1, take: 'reclaim' } },
  duration: 'until-stopped',
};

/** How often a guard looks again (a new formation, a foe, its shield). */
const LOOK_MS = 200;
/** Where the wall goes when the looked-at block is too far or there is none: this many blocks ahead. */
const AHEAD = 5;
/** On its slot: within this many blocks horizontally. */
const ARRIVED = 0.8;
/** A slot not reached in this long gets a looser goal (something stands there, or no path ends on it). */
const STUCK_MS = 10_000;

export default async function (squad, args, ctx) {
  // First: every later click re-forms the wall instead of restarting the order.
  ctx.commander.on('trigger', () => form());
  const distance = Number(args.distance) || 24;
  const spacing = Math.min(3, Math.max(1, Number(args.spacing) || 1));
  const reach = Number(args.reach) || 4;

  /** The wall: a new formation bumps `v`; the yaw it faces; each guard's slot by name. */
  const wall = { v: 0, yaw: 0, slots: new Map() };

  /** groundAt with whichever bot knows that chunk; null when none does. */
  const ground = (p) => {
    for (const b of squad.bots) {
      try {
        const g = groundAt(b, p);
        if (g) return g;
      } catch (e) {
        if (!(e instanceof BotLeftError)) throw e;
      }
    }
    return null;
  };

  /** The point looked at: on top of the block when it is within `distance` horizontally, else AHEAD blocks along the view. */
  const pointOf = (at) => {
    const b = at.lookBlock;
    if (b && Math.hypot(b.x + 0.5 - at.position.x, b.z + 0.5 - at.position.z) <= distance) {
      const top = ground(b.offset(0.5, 1, 0.5));
      if (top) return top;
    }
    const d = lookDir(at.yaw);
    const ahead = at.position.offset(d.x * AHEAD, 0, d.z * AHEAD);
    return ground(ahead) ?? ahead;
  };

  /** Line up where the commander looks now: slots across the view, given out left to right. */
  function form() {
    const at = ctx.commander.at;
    const bots = squad.bots.filter((b) => b.entity);
    const slots = lineSlots(pointOf(at), at.yaw, bots.length, { spacing }).map((s) => ground(s) ?? s);
    const right = lookDir(at.yaw + 90);
    const along = (p) => p.x * right.x + p.z * right.z;
    const sorted = [...bots].sort((a, b) => along(a.entity.position) - along(b.entity.position));
    wall.v++;
    wall.yaw = at.yaw;
    wall.slots = new Map(sorted.map((b, i) => [b.username, slots[i]]));
  }

  /** A foe near `from`: a hostile mob, or a player not on our team who is not a spectator (nobody can hit one). */
  const foeNear = (bot, from) =>
    nearestHostile(bot, reach, { from }) ??
    nearestEntity(bot, (e) => e.type === 'player' && !!e.username && !isFriend(e) && bot.players[e.username]?.gamemode !== 3, reach, { from });

  /** Where each guard is heading: the slot's key, the goal set for it, since when, loose or exact. */
  const heading = new Map();
  const keyOf = (s) => `${s.x},${s.y},${s.z}`;

  /** Set a goal toward the slot unless it is already the current goal; the guard's loop looks again soon. */
  const walk = (bot, slot) => {
    const key = keyOf(slot);
    let h = heading.get(bot.username);
    if (!h || h.key !== key) {
      // A slot off the ground (an unloaded chunk) gets a loose goal from the start.
      h = { key, since: Date.now(), loose: !Number.isInteger(slot.y), goal: null };
      heading.set(bot.username, h);
    }
    if (!h.loose && Date.now() - h.since > STUCK_MS) {
      h.loose = true;
      h.goal = null;
    }
    if (h.goal && bot.pathfinder.goal === h.goal) return;
    h.goal = h.loose ? new goals.GoalNear(slot.x, slot.y, slot.z, 2) : new goals.GoalBlock(Math.floor(slot.x), slot.y, Math.floor(slot.z));
    bot.pathfinder.setGoal(h.goal);
  };

  const arrived = (bot, slot) => {
    const h = heading.get(bot.username);
    const near = h && h.key === keyOf(slot) && h.loose ? 2.5 : ARRIVED;
    const p = bot.entity.position;
    return Math.hypot(p.x - slot.x, p.z - slot.z) <= near && Math.abs(p.y - slot.y) <= 2;
  };

  /** One look of one guard: fight a foe at its slot, else walk to the slot, else hold it with the shield up. */
  const guard = async (bot) => {
    const slot = wall.slots.get(bot.username);
    if (!slot) {
      await squad.sleep(LOOK_MS); // until a formation gives it a slot
      return;
    }
    const v = wall.v;
    const foe = foeNear(bot, slot);
    if (foe) {
      await raiseShield(bot, false);
      // Leashed to its slot; a new formation ends the fight at once.
      await attack(bot, foe, { timeoutMs: 15000, leash: { center: () => wall.slots.get(bot.username) ?? slot, radius: reach + 1 }, until: () => wall.v !== v });
      return;
    }
    if (!arrived(bot, slot)) {
      await raiseShield(bot, false);
      walk(bot, slot);
      await squad.sleep(LOOK_MS);
      return;
    }
    await faceYaw(bot, wall.yaw);
    await raiseShield(bot, true);
    await squad.sleep(LOOK_MS);
  };

  /** One loop per guard, started again for a guard that comes back (reclaimed by another order, then returned). */
  const crew = new Map();
  const launch = (bot) => {
    const token = {};
    crew.set(bot.username, token);
    squad
      .parallel(bot, async (b) => {
        while (!squad.stopped && crew.get(b.username) === token) {
          try {
            await guard(b);
          } catch (e) {
            if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
            ctx.log(`${b.username}: ${e.message}`);
            await squad.sleep(500);
          }
        }
      })
      .catch(() => undefined);
  };

  // A bot back from another order keeps its slot (it was kept for it); a newcomer re-forms the line.
  squad.on('joined', (bot) => {
    if (!wall.slots.has(bot.username)) form();
    launch(bot);
  });
  form();
  for (const bot of squad.bots) launch(bot);
  await squad.untilStopped();
  return 'Mur de boucliers rompu.';
}
