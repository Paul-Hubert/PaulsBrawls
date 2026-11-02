// Stock command: the guards line up across the commander's view where they point, face along the view and raise
// their shields once in place. Any item can carry it (/bots orders bind mur-de-boucliers), a shield, a bow, a stick,
// or none (/bots order): a click only says WHERE (pointedTarget: an arrow's hit, else the crosshair's creature or
// block); too far (`distance`) or the sky, the wall forms a few blocks ahead. A guard holds its shield up and does not
// go after anyone: hit in melee (the shield stopped the blow or not; bot.on('meleeHit')), it hits back once, a step
// toward the attacker first when out of arm's reach (not past `reach` from its slot), then raises its shield again.
// Arrows and explosions are only blocked. Each later click re-forms the wall where the commander now points, without
// stopping the order (it listens: ctx.commander.on('trigger')); a bow's arrow-release does not move it, its hit does.
//
// The wall keeps the exact yaw and point; when the two middle guards would share a block, the right half of the wall
// moves one block along it. Slots go to the bots in their order along the line (left to right as the commander sees
// it), so no two paths cross; that assignment holds for one formation and is redone when the wall moves or a new guard joins. A guard
// reclaimed by another order keeps its slot, and takes it again when it comes back. Shields go down to walk
// (blocking slows walking) and up on arrival, and the loop raises a shield again when something lowered it (auto-eat
// lowers it to eat). The bots walk with pathfinder goals and look again every 200 ms, so a new formation takes them
// at once.
export const manifest = {
  summary: 'Mur de boucliers en travers de mon regard, là où je vise',
  params: {
    type: 'object',
    properties: {
      distance: { type: 'integer', minimum: 4, maximum: 64, default: 24, description: 'au-delà, le mur se forme quelques blocs devant moi' },
      spacing: { type: 'number', minimum: 1, maximum: 3, default: 1, description: 'écart entre deux gardes' },
      reach: { type: 'integer', minimum: 1, maximum: 12, default: 4, description: "jusqu'où, depuis sa place, un garde frappé avance pour rendre le coup" },
    },
  },
  roles: { guards: { select: { hasItem: 'shield' }, min: 1, take: 'reclaim' } },
  duration: 'until-stopped',
};

/** How often a guard looks again (a new formation, a foe, its shield). */
const LOOK_MS = 200;
/** Where the wall goes when the point is too far or there is none (the sky): this many blocks ahead. */
const AHEAD = 5;
/** On its slot: within this many blocks horizontally. */
const ARRIVED = 0.8;
/** A slot not reached in this long gets a looser goal (something stands there, or no path ends on it). */
const STUCK_MS = 10_000;
/** Arm's reach for the blow back: from the eyes to the attacker's hitbox (the server allows 3, plus 1 of slack). */
const STRIKE_REACH = 3;
/** How long a guard steps toward an attacker out of arm's reach before it gives up the blow. */
const STEP_MS = 1_500;
/** A hit not answered within this long is forgotten (the guard was busy walking or eating). */
const ANSWER_MS = 2_000;
/** The eyes of a standing player above its feet. */
const EYES = 1.62;

export default async function (squad, args, ctx) {
  // First: every later click re-forms the wall instead of restarting the order.
  // A bow's arrow-release says where only once its arrow lands: it does not move the wall, the hit does. As the
  // order's first snapshot it is used, provisionally.
  let aimAt = ctx.commander.at;
  ctx.commander.on('trigger', (at) => {
    if (at.trigger && at.trigger.kind === 'arrow-release') return;
    aimAt = at;
    form();
  });
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

  /**
   * Where the commander points (pointedTarget: an arrow's hit, else the crosshair's creature or the top of its block),
   * standable and within `distance` horizontally; else AHEAD blocks along the view.
   */
  const pointOf = (at, bot) => {
    const p = pointedTarget(bot, at, { near: 0 }).position;
    if (p && Math.hypot(p.x - at.position.x, p.z - at.position.z) <= distance) {
      const top = ground(p);
      if (top) return top;
    }
    const d = lookDir(at.yaw);
    const ahead = at.position.offset(d.x * AHEAD, 0, d.z * AHEAD);
    return ground(ahead) ?? ahead;
  };

  /** Line up where the commander points now: slots across the view, given out left to right. */
  function form() {
    const at = aimAt;
    const bots = squad.bots.filter((b) => b.entity);
    const point = bots.length > 0 ? pointOf(at, bots[0]) : at.position;
    const right = lookDir(at.yaw + 90);
    const slots = lineSlots(point, at.yaw, bots.length, { spacing });
    // An even count puts the middle two half a spacing from the point's block centre: with spacing 1, at any yaw that
    // is not axis-aligned they stood in one block. Then the right half of the wall moves one block along it, which
    // always takes that guard out of the centre block; the yaw and the rest stay as they were (docs/35 F2).
    const mid = slots.length / 2;
    const blockOf = (p) => `${Math.floor(p.x)},${Math.floor(p.z)}`;
    if (mid > 0 && Number.isInteger(mid) && blockOf(slots[mid - 1]) === blockOf(slots[mid])) {
      for (let i = mid; i < slots.length; i++) slots[i] = slots[i].offset(right.x, 0, right.z);
    }
    for (let i = 0; i < slots.length; i++) slots[i] = ground(slots[i]) ?? slots[i];
    const along = (p) => p.x * right.x + p.z * right.z;
    const sorted = [...bots].sort((a, b) => along(a.entity.position) - along(b.entity.position));
    wall.v++;
    wall.yaw = at.yaw;
    wall.slots = new Map(sorted.map((b, i) => [b.username, slots[i]]));
  }

  /** The last melee hit each guard took and has not answered yet: the attacker, when. */
  const struck = new Map();

  /** Within arm's reach: the guard's eyes to the attacker's hitbox. */
  const canStrike = (bot, e) => {
    const eye = bot.entity.position.offset(0, EYES, 0);
    const w = (e.width ?? 0.6) / 2;
    const h = e.height ?? 1.8;
    const gap = (v, lo, hi) => Math.max(lo - v, 0, v - hi);
    return Math.hypot(gap(eye.x, e.position.x - w, e.position.x + w), gap(eye.y, e.position.y, e.position.y + h), gap(eye.z, e.position.z - w, e.position.z + w)) <= STRIKE_REACH;
  };
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

  /**
   * One blow back at whoever hit the guard: shield down, a step toward them when out of arm's reach (for STEP_MS, never
   * past `reach` from the slot, ended by a new formation), the blow. The guard's loop then raises the shield again (and
   * walks back to the slot first when the step took it off).
   */
  const strikeBack = async (bot, foe, slot) => {
    if (!foe.isValid || flat(foe.position, slot) > reach + STRIKE_REACH) return;
    await raiseShield(bot, false);
    if (!canStrike(bot, foe)) {
      const v = wall.v;
      const end = Date.now() + STEP_MS;
      bot.pathfinder.setGoal(new goals.GoalFollow(foe, 1), true);
      while (!canStrike(bot, foe) && foe.isValid && wall.v === v && Date.now() < end && flat(bot.entity.position, slot) <= reach) await squad.sleep(50);
      bot.pathfinder.setGoal(null);
      if (!foe.isValid || !canStrike(bot, foe)) return;
    }
    if (!/_sword$|_axe$/.test(bot.heldItem?.name ?? '')) {
      const weapon = bot.inventory.items().find((i) => /_sword$|_axe$/.test(i.name));
      if (weapon) await bot.equip(weapon, 'hand');
    }
    await bot.lookAt(foe.position.offset(0, (foe.height ?? 1.8) * 0.8, 0), true);
    bot.attack(foe);
    ctx.log(`${bot.username}: hit back at ${foe.username ?? foe.name ?? '?'}`);
  };

  /** Where each guard is heading: the slot's key, the goal set for it, since when, loose or exact, reached once. */
  const heading = new Map();
  const keyOf = (s) => `${s.x},${s.y},${s.z}`;

  /** Set a goal toward the slot unless it is already the current goal; the guard's loop looks again soon. */
  const walk = (bot, slot) => {
    const key = keyOf(slot);
    let h = heading.get(bot.username);
    // A new slot, or the same one again after the guard had reached it (back from a fight, pushed off): a fresh
    // exact goal and its own STUCK_MS. Timed from the first walk, a guard coming back after a fight later than that
    // got the loose goal at once and held its shield up to 2.5 blocks off its slot (found live, docs/29 §16).
    if (!h || h.key !== key || h.reached) {
      // A slot off the ground (an unloaded chunk) gets a loose goal from the start.
      h = { key, since: Date.now(), loose: !Number.isInteger(slot.y), goal: null, reached: false };
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

  /** One look of one guard: hit back once if it was hit, else walk to the slot, else hold it with the shield up. */
  const guard = async (bot) => {
    const slot = wall.slots.get(bot.username);
    if (!slot) {
      await squad.sleep(LOOK_MS); // until a formation gives it a slot
      return;
    }
    const hit = struck.get(bot.username);
    if (hit) {
      struck.delete(bot.username);
      if (Date.now() - hit.at <= ANSWER_MS) {
        await strikeBack(bot, hit.attacker, slot);
        return;
      }
    }
    if (!arrived(bot, slot)) {
      await raiseShield(bot, false);
      walk(bot, slot);
      await squad.sleep(LOOK_MS);
      return;
    }
    const h = heading.get(bot.username);
    if (h && h.key === keyOf(slot)) h.reached = true;
    await faceYaw(bot, wall.yaw);
    await raiseShield(bot, true);
    await squad.sleep(LOOK_MS);
  };

  /** One loop per guard, started again for a guard that comes back (reclaimed by another order, then returned). */
  const crew = new Map();
  const launch = (bot) => {
    const token = {};
    crew.set(bot.username, token);
    // The runtime's event: who hit this bot in melee, the shield's blocks included. Removed when the bot leaves.
    bot.on('meleeHit', (attacker) => {
      if (!isFriend(attacker)) struck.set(bot.username, { attacker, at: Date.now() });
    });
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
