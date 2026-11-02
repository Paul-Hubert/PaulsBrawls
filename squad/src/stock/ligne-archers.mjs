// Stock command: the archers form a line across the commander's view, `back` blocks short of where they point (on the
// commander's side), face along the view and shoot the threats within `range` of each archer (as far as a bow carries
// by default): hostile mobs and players who are not on our team, those in front of the line first, then one no other
// archer shoots. An archer with a threat in range shoots it from where it stands, walking to its slot or not, then
// goes on to its slot: a click re-forms the line and archers come back from other orders, so a fight is mostly spent
// walking, and an archer that only shot from its slot often never shot (docs/35 F4). Any item can carry it (/bots orders bind ligne-archers), an arrow, a bow, a stick, or none (/bots order): a
// click only says WHERE (pointedTarget: an arrow's hit, else the crosshair's creature or block); too far (`distance`)
// or the sky, the point is a few blocks ahead. After "no clear line of fire" an archer steps one or two blocks aside,
// shoots from there for a moment, then goes back to its slot. Each later click re-forms the line where the commander
// now points, without stopping the order (it listens: ctx.commander.on('trigger')); a bow's arrow-release does not
// move it, its hit does.
//
// One rank unless `ranks` says more (2 blocks apart; a back rank shoots over the front one on the high arc). Slots go
// to the bots by where they stand (the front-most to the front rank, then left to right as the commander sees it), so no two paths cross; that assignment holds for one
// formation and is redone when the line moves or a new archer joins. An archer pulled away by another order (a `tir`)
// keeps its slot, and goes back to it afterwards.
export const manifest = {
  summary: "Ligne d'archers en travers de mon regard, en deçà du point visé, qui tire sur ce qui approche",
  params: {
    type: 'object',
    properties: {
      distance: { type: 'integer', minimum: 4, maximum: 64, default: 24, description: 'au-delà, la ligne se forme devant moi' },
      spacing: { type: 'number', minimum: 1, maximum: 4, default: 2, description: 'écart entre deux archers' },
      back: { type: 'integer', minimum: 0, maximum: 16, default: 4, description: 'la ligne se tient à tant de blocs en deçà du point, de mon côté' },
      range: { type: 'integer', minimum: 4, maximum: 120, default: 120, description: "portée de tir autour de chaque archer (120 : aussi loin qu'un arc porte)" },
      ranks: { type: 'integer', minimum: 1, maximum: 3, default: 1, description: 'nombre de rangs, 2 blocs entre deux rangs' },
    },
  },
  roles: { archers: { select: { hasItem: 'bow' }, min: 1, take: 'reclaim' } },
  duration: 'until-stopped',
};

/** How often an archer looks again (a new formation, a threat). */
const LOOK_MS = 200;
/** Where the point is when the pointed one is too far or there is none (the sky): this many blocks ahead. */
const AHEAD = 10;
/**
 * The farthest a foe counts: about as far as an arrow carries. A full-draw arrow goes about 117 blocks on flat ground
 * and 124 shooting 10 blocks down (aim/arrow.mjs, ARROW in helpers.ts), and the bots see entities out to about 128
 * (viewDistance 'short', 8 chunks; production's server view distance is larger, so the bots' is the limit). Paul:
 * « as far as possible » (docs/35 D4).
 */
const MAX_RANGE = 120;
/** On its slot: within this many blocks horizontally. */
const ARRIVED = 0.8;
/** A slot not reached in this long gets a looser goal (something stands there, or no path ends on it). */
const STUCK_MS = 10_000;
/** How long an archer that stepped aside shoots from there before going back to its slot. */
const ASIDE_MS = 3_000;
/** Away from its slot, a shot refused for the line of fire: walk on this long before trying again (no sidestep). */
const WALK_ON_MS = 1_000;
/**
 * A target a block stopped an archer's shot at: that archer passes over it this long. Out to 120 blocks the range
 * reaches mobs in caves and under water below the line (found live, docs/35 F4): picked again and again, they kept
 * the archer stepping aside instead of shooting what it can hit. A friend in the way is not remembered (they move).
 */
const BLOCKED_MS = 5_000;

export default async function (squad, args, ctx) {
  // First: every later click re-forms the line instead of restarting the order.
  // A bow's arrow-release says where only once its arrow lands: it does not move the line, the hit does. As the
  // order's first snapshot it is used, provisionally.
  let aimAt = ctx.commander.at;
  ctx.commander.on('trigger', (at) => {
    if (at.trigger && at.trigger.kind === 'arrow-release') return;
    aimAt = at;
    form();
  });
  const distance = Number(args.distance) || 24;
  const spacing = Number(args.spacing) || 2;
  const back = Number(args.back ?? 4);
  const range = Math.min(MAX_RANGE, Number(args.range) || MAX_RANGE);
  const ranksWanted = Math.min(3, Math.max(1, Math.floor(Number(args.ranks) || 1)));

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

  /** Line up `back` blocks short of where the commander points now. */
  function form() {
    const at = aimAt;
    const bots = squad.bots.filter((b) => b.entity);
    const fwd = lookDir(at.yaw);
    const right = lookDir(at.yaw + 90);
    const p = bots.length > 0 ? pointOf(at, bots[0]) : at.position;
    const raw = p.offset(-fwd.x * back, 0, -fwd.z * back);
    const centre = ground(raw) ?? raw;
    const ranks = Math.max(1, Math.min(ranksWanted, bots.length));
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

  /**
   * A threat within `range` of this archer, the nearest to it: in front of the line and untaken first, then in front,
   * then untaken, then any.
   */
  const pick = (bot) => {
    const c = line.centre;
    const d = lookDir(line.yaw);
    const front = (e) => (e.position.x - c.x) * d.x + (e.position.z - c.z) * d.z > 0;
    const free = (e) => load(e) === 0;
    const passed = blocked.get(bot.username);
    const open = (e) => !passed || !((passed.get(e.id) ?? 0) > Date.now());
    for (const ok of [(e) => front(e) && free(e), front, free, () => true]) {
      const fits = (e) => ok(e) && open(e);
      const t = nearestHostile(bot, range, { filter: fits }) ?? nearestEntity(bot, (e) => isFoe(bot, e) && fits(e), range);
      if (t) return t;
    }
    return null;
  };

  /** Per archer: the targets a block stopped its shot at, until when it passes over them (BLOCKED_MS). */
  const blocked = new Map();
  const blockedOf = (bot) => {
    let m = blocked.get(bot.username);
    if (!m) blocked.set(bot.username, (m = new Map()));
    for (const [id, until] of m) if (until <= Date.now()) m.delete(id);
    return m;
  };

  /** Why each archer holds fire now; logged once per change, not every look. */
  const holding = new Map();
  const hold = (bot, why) => {
    if (holding.get(bot.username) === why) return;
    holding.set(bot.username, why);
    if (why) ctx.log(`${bot.username}: holds fire: ${why}`);
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
  /** Until when each archer away from its slot walks on after a refused shot. */
  const walkOn = new Map();

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

  /**
   * One look of one archer: a threat in range is shot from where the archer stands (it stops walking to draw: the
   * pathfinder turns the head toward the path and the shooter's own motion goes into the arrow); otherwise it walks to
   * its slot, or faces the view once there.
   */
  const archer = async (bot) => {
    const slot = line.slots.get(bot.username);
    const there = !!slot && arrived(bot, slot);
    const h = slot ? heading.get(bot.username) : undefined;
    if (h && h.key === keyOf(slot) && there) h.reached = true;
    const stepping = Date.now() < (aside.get(bot.username) ?? 0);
    // Walking on after a refused shot: moving changes the line of fire, so the next look may shoot.
    const t = !there && slot && Date.now() < (walkOn.get(bot.username) ?? 0) ? null : pick(bot);
    if (t) {
      hold(bot, null);
      const walking = !!h && !!h.goal && bot.pathfinder.goal === h.goal;
      if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);
      const t0 = Date.now();
      const release = take(t, bot);
      try {
        await shoot(bot, t);
      } catch (e) {
        if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
        ctx.log(`${bot.username}: ${e.message}`);
        const noLine = /no clear line of fire/.test(e.message);
        if (noLine && !/a friend is in the way/.test(e.message)) blockedOf(bot).set(t.id, Date.now() + BLOCKED_MS);
        if (noLine && slot && !there && !stepping) walkOn.set(bot.username, Date.now() + WALK_ON_MS);
        else if (noLine) await sidestep(bot, t);
        else await squad.sleep(250);
      } finally {
        release();
        // The time spent shooting does not count toward giving up on the exact slot.
        if (walking) h.since += Date.now() - t0;
      }
      return;
    }
    if (!slot) {
      hold(bot, 'no slot yet, nothing in range');
      await squad.sleep(LOOK_MS); // until a formation gives it a slot
      return;
    }
    if (!stepping && !there) {
      hold(bot, Date.now() < (walkOn.get(bot.username) ?? 0) ? 'walking to its slot after a blocked shot' : `walking to its slot, nothing within ${range} blocks`);
      walk(bot, slot);
      await squad.sleep(LOOK_MS);
      return;
    }
    hold(bot, stepping ? `stepped aside, nothing within ${range} blocks` : `on its slot, nothing within ${range} blocks`);
    await faceYaw(bot, line.yaw);
    await squad.sleep(LOOK_MS);
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
