// Stock command, made for a bound arrow (/bots orders bind ligne-archers, used with a right-click): the archers form
// a line across the commander's view, `back` blocks short of the point looked at (on the commander's side), face along
// the view and shoot, from their slots, the threats within `range` of the line's centre: hostile mobs and players who
// are not on our team, those in front of the line first, then one no other archer shoots. After "no clear line of
// fire" an archer steps one or two blocks aside, shoots from there for a moment, then goes back to its slot. Each
// click of the bound item re-forms the line where the commander now looks, without stopping the order (it listens:
// ctx.commander.on('trigger')).
//
// Past 8 archers the line has two ranks, 2 blocks apart. Slots go to the bots by where they stand (the front-most to
// the front rank, then left to right as the commander sees it), so no two paths cross; that assignment holds for one
// formation and is redone when the line moves or a new archer joins. An archer pulled away by another order (a `tir`
// from the bound bow) keeps its slot, and goes back to it afterwards.
export const manifest = {
  summary: "Ligne d'archers en travers de mon regard, qui tire sur ce qui approche",
  params: {
    type: 'object',
    properties: {
      distance: { type: 'integer', minimum: 4, maximum: 64, default: 24, description: 'au-delà, la ligne se forme devant moi' },
      spacing: { type: 'number', minimum: 1, maximum: 4, default: 2, description: 'écart entre deux archers' },
      back: { type: 'integer', minimum: 0, maximum: 16, default: 4, description: 'la ligne se tient à tant de blocs en deçà du point, de mon côté' },
      range: { type: 'integer', minimum: 4, maximum: 64, default: 24, description: 'portée de tir autour du centre de la ligne' },
    },
  },
  roles: { archers: { select: { hasItem: 'bow' }, min: 1, take: 'reclaim' } },
  duration: 'until-stopped',
};

/** How often an archer looks again (a new formation, a threat). */
const LOOK_MS = 200;
/** Where the point is when the looked-at block is too far or there is none: this many blocks ahead. */
const AHEAD = 10;
/** More archers than this: two ranks. */
const ONE_RANK = 8;
/** On its slot: within this many blocks horizontally. */
const ARRIVED = 0.8;
/** A slot not reached in this long gets a looser goal (something stands there, or no path ends on it). */
const STUCK_MS = 10_000;
/** How long an archer that stepped aside shoots from there before going back to its slot. */
const ASIDE_MS = 3_000;

export default async function (squad, args, ctx) {
  // First: every later click re-forms the line instead of restarting the order.
  ctx.commander.on('trigger', () => form());
  const distance = Number(args.distance) || 24;
  const spacing = Number(args.spacing) || 2;
  const back = Number(args.back ?? 4);
  const range = Number(args.range) || 24;

  /** The line: a new formation bumps `v`; the yaw it faces, its centre, each archer's slot by name. */
  const line = { v: 0, yaw: 0, centre: ctx.commander.at.position, slots: new Map() };

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

  /** Line up `back` blocks short of where the commander looks now. */
  function form() {
    const at = ctx.commander.at;
    const bots = squad.bots.filter((b) => b.entity);
    const fwd = lookDir(at.yaw);
    const right = lookDir(at.yaw + 90);
    const p = pointOf(at);
    const raw = p.offset(-fwd.x * back, 0, -fwd.z * back);
    const centre = ground(raw) ?? raw;
    const ranks = bots.length > ONE_RANK ? 2 : 1;
    const per = Math.ceil(bots.length / ranks);
    const slots = lineSlots(centre, at.yaw, bots.length, { spacing, ranks, depth: 2 }).map((s) => ground(s) ?? s);
    const dot = (q, d) => q.x * d.x + q.z * d.z;
    const byFront = [...bots].sort((a, b) => dot(b.entity.position, fwd) - dot(a.entity.position, fwd));
    const given = new Map();
    for (let r = 0; r < ranks; r++) {
      const rank = byFront.slice(r * per, (r + 1) * per).sort((a, b) => dot(a.entity.position, right) - dot(b.entity.position, right));
      rank.forEach((b, i) => given.set(b.username, slots[r * per + i]));
    }
    line.v++;
    line.yaw = at.yaw;
    line.centre = centre;
    line.slots = given;
  }

  /** A player not on our team who is not a spectator (nobody can hit one). */
  const isFoe = (bot, e) => e.type === 'player' && !!e.username && !isFriend(e) && bot.players[e.username]?.gamemode !== 3;

  /** Who shoots what: entity id → names of the archers on it. */
  const taken = new Map();
  const load = (e) => taken.get(e.id)?.size ?? 0;
  const take = (e, bot) => {
    const set = taken.get(e.id) ?? new Set();
    set.add(bot.username);
    taken.set(e.id, set);
    return () => {
      set.delete(bot.username);
      if (set.size === 0 && taken.get(e.id) === set) taken.delete(e.id);
    };
  };

  /** A threat within `range` of the line's centre: in front of the line and untaken first, then in front, then untaken. */
  const pick = (bot) => {
    const c = line.centre;
    const d = lookDir(line.yaw);
    const front = (e) => (e.position.x - c.x) * d.x + (e.position.z - c.z) * d.z > 0;
    const free = (e) => load(e) === 0;
    for (const ok of [(e) => front(e) && free(e), front, free, () => true]) {
      const t = nearestHostile(bot, range, { from: c, filter: ok }) ?? nearestEntity(bot, (e) => isFoe(bot, e) && ok(e), range, { from: c });
      if (t) return t;
    }
    return null;
  };

  /** Where each archer is heading: the slot's key, the goal set for it, since when, loose or exact, reached once. */
  const heading = new Map();
  const keyOf = (s) => `${s.x},${s.y},${s.z}`;

  /** Set a goal toward the slot unless it is already the current goal; the archer's loop looks again soon. */
  const walk = (bot, slot) => {
    const key = keyOf(slot);
    let h = heading.get(bot.username);
    // A new slot, or the same one again after the archer had reached it (pushed off): a fresh exact goal and its own
    // STUCK_MS, not the loose goal of a timer started at the first walk (docs/29 §16).
    if (!h || h.key !== key || h.reached) {
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

  /** Until when each archer that stepped aside shoots from where it is. */
  const aside = new Map();

  /** One to two blocks to one side of the line to the target: out from behind whatever blocked the shot. */
  const sidestep = async (bot, t) => {
    const p = bot.entity.position;
    const dx = t.position.x - p.x;
    const dz = t.position.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const side = (Math.random() < 0.5 ? 1 : -1) * (1 + Math.random());
    heading.delete(bot.username);
    bot.pathfinder.setGoal(new goals.GoalNear(p.x - (dz / len) * side, p.y, p.z + (dx / len) * side, 1));
    aside.set(bot.username, Date.now() + ASIDE_MS);
    await squad.sleep(500);
  };

  /** One look of one archer: to its slot first, then shoot a threat from there, else face the view. */
  const archer = async (bot) => {
    const slot = line.slots.get(bot.username);
    if (!slot) {
      await squad.sleep(LOOK_MS); // until a formation gives it a slot
      return;
    }
    if (!(Date.now() < (aside.get(bot.username) ?? 0)) && !arrived(bot, slot)) {
      walk(bot, slot);
      await squad.sleep(LOOK_MS);
      return;
    }
    const h = heading.get(bot.username);
    if (h && h.key === keyOf(slot) && arrived(bot, slot)) h.reached = true;
    const t = pick(bot);
    if (!t) {
      await faceYaw(bot, line.yaw);
      await squad.sleep(LOOK_MS);
      return;
    }
    const release = take(t, bot);
    try {
      await shoot(bot, t);
    } catch (e) {
      if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
      ctx.log(`${bot.username}: ${e.message}`);
      if (/no clear line of fire/.test(e.message)) await sidestep(bot, t);
      else await squad.sleep(250);
    } finally {
      release();
    }
  };

  /** One loop per archer, started again for one that comes back (reclaimed by another order, then returned). */
  const crew = new Map();
  const launch = (bot) => {
    const token = {};
    crew.set(bot.username, token);
    squad
      .parallel(bot, async (b) => {
        while (!squad.stopped && crew.get(b.username) === token) {
          try {
            await archer(b);
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
    if (!line.slots.has(bot.username)) form();
    launch(bot);
  });
  form();
  for (const bot of squad.bots) launch(bot);
  await squad.untilStopped();
  return "Ligne d'archers rompue.";
}
