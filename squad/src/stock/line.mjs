// Stock command: the battle line across the commander's view, where they point (merged `mur-de-boucliers` and
// `ligne-archers`, docs/40). Guards (a shield) form a shield wall on the point; archers (a bow) a line `back` blocks
// behind it, shooting threats within `range` of each archer. Any item carries it: a click only says WHERE
// (pointedTarget); too far or the sky, a few blocks ahead. A later click re-forms the line without restarting the order
// (ctx.commander.on('trigger')); a bow's arrow-release does not move it, its hit does.
// Each rank is straight at the exact yaw: each slot is an exact place at its column's ground height (lineUp), given to
// the bots by where they stand so no paths cross. A bot paths to within 2 blocks of its slot, then walks onto it itself
// (approach, docs/43 B). A bot lent to another order (an `attack`) keeps its slot and comes back to it.
// Guards: shield up, on their slot and on the way to it (a re-formed wall walks to its new place behind its shields,
// then faces the new direction); hit in melee, a guard hits back once (a step toward the attacker, not past `reach`),
// then raises its shield again. Melee bots (no shield, no bow: horsemen) hold the wall's flanks the same way. Archers
// shoot from where they stand, the wall's guards over; after "no clear line of fire" on its slot an archer steps aside
// for a moment. Given a new slot (the line formed or re-formed), an archer on foot gets there first: it holds fire on
// the way (at most `march` seconds, then it shoots what comes as before). A horse archer rides there and shoots on the move
// (shoot holds a free rein: the horse keeps its heading while the rider aims, docs/41).
// A reserve (`reserve` = N, docs/45): the first N melee bots stand loose `back` + 3 behind the wall, not on its flanks;
// when a foe comes within `reach` + 8 of the wall's point, they counter-attack it there (the stock `attack` on the
// point, lent to it as a subroutine) and come back to their places once it is clear.
export const manifest = {
  summary: 'Ligne : mur de boucliers là où je vise, archers derrière lui, qui tirent sur ce qui approche',
  params: {
    type: 'object',
    properties: {
      distance: { type: 'integer', minimum: 4, maximum: 64, default: 24, description: 'au-delà, la ligne se forme devant moi' },
      spacing: { type: 'number', minimum: 1, maximum: 3, default: 1, description: 'écart entre deux gardes' },
      archerSpacing: { type: 'number', minimum: 1, maximum: 4, default: 2, description: 'écart entre deux archers' },
      back: { type: 'integer', minimum: 0, maximum: 16, default: 4, description: 'les archers se tiennent à tant de blocs en deçà du point (et du mur), de mon côté' },
      range: { type: 'integer', minimum: 4, maximum: 120, default: 120, description: "portée de tir autour de chaque archer (120 : aussi loin qu'un arc porte)" },
      ranks: { type: 'integer', minimum: 1, maximum: 3, default: 1, description: "nombre de rangs d'archers, 2 blocs entre deux rangs" },
      reach: { type: 'integer', minimum: 1, maximum: 12, default: 4, description: "jusqu'où, depuis sa place, un garde frappé avance pour rendre le coup" },
      reserve: { type: 'integer', minimum: 0, maximum: 8, default: 0, description: "fantassins gardés en réserve derrière le mur, qui contre-attaquent ce qui l'atteint" },
      march: { type: 'integer', minimum: 0, maximum: 60, default: 20, description: "secondes pendant lesquelles un archer à pied gagne sa nouvelle place sans tirer (0 : il tire en chemin ; à cheval, il tire toujours en chemin)" },
    },
  },
  roles: {
    guards: { select: { hasItem: 'shield' }, take: 'reclaim' },
    archers: { select: { hasItem: 'bow', not: { hasItem: 'shield' } }, take: 'reclaim' },
    melee: { select: { not: { hasItem: ['shield', 'bow'] } }, take: 'reclaim' },
  },
  duration: 'until-stopped',
};

const LOOK_MS = 200; // how often a bot on its slot looks again (a new formation, a foe, its shield)
const FLANK = 2; // between two melee bots on a flank, and from the wall's end (a horse is 1.4 wide)
const AHEAD = 8; // the point when the pointed one is too far or the sky: this many blocks ahead
const ON_SLOT = 0.15; // on its slot: within this of its exact place, horizontally
const HOLD = 0.25; // a bot that was on its slot holds it until pushed farther than this
const STUCK_MS = 10_000; // a slot not reached in this long gets a looser goal (something stands there)
const LOOSE = 2.5; // with the looser goal, a bot holds within this of its slot
const STRIKE_REACH = 3; // a guard's arm's reach (inReach): eyes to the attacker's hitbox
const STEP_MS = 1_500; // how long a guard steps toward an attacker out of reach
const ANSWER_MS = 2_000; // a hit not answered within this long is forgotten
const MAX_RANGE = 120; // about as far as a full-draw arrow carries (docs/35 D4)
const ASIDE_MS = 3_000; // an archer that stepped aside shoots from there this long
const WALK_ON_MS = 1_000; // away from its slot, a shot refused for the line of fire: walk on this long first
const BLOCKED_MS = 5_000; // a target a block stopped an archer's shot at is passed over this long (docs/35 F4)

export default async function (squad, args, ctx) {
  // First: a later click re-forms the line; a bow's arrow-release does not (its hit does), but a first one is used.
  let aimAt = ctx.commander.at;
  ctx.commander.on('trigger', (at) => {
    if (at.trigger && at.trigger.kind === 'arrow-release') return;
    aimAt = at;
    form();
  });
  if (squad.bots.length === 0) throw new Error('no bot for a line (guards need a shield, archers a bow)');
  const distance = Number(args.distance) || 24;
  const spacing = Math.min(3, Math.max(1, Number(args.spacing) || 1));
  const archerSpacing = Number(args.archerSpacing) || 2;
  const back = Number(args.back ?? 4);
  const range = Math.min(MAX_RANGE, Number(args.range) || MAX_RANGE);
  const ranks = Math.min(3, Math.max(1, Math.floor(Number(args.ranks) || 1)));
  const reach = Number(args.reach) || 4;
  const marchMs = Math.min(60, Math.max(0, Number(args.march ?? 20) || 0)) * 1000; // an archer on foot to a new slot holds fire this long at most
  const reserveN = Math.min(8, Math.max(0, Math.floor(Number(args.reserve) || 0)));
  /** The reserve's names, chosen once (the first melee bots at the first formation). */
  const reserves = new Set();

  /** The formation: a new one bumps `v`; the yaw it faces, the archers' centre, each bot's slot by name. */
  const line = { v: 0, yaw: 0, centre: ctx.commander.at.position, point: null, slots: new Map() };
  const roleOf = (bot) => ['guards', 'melee'].find((r) => (squad.roles[r] ?? []).includes(bot)) ?? 'archers';
  const shield = (bot, up) => (roleOf(bot) === 'guards' ? raiseShield(bot, up) : undefined);

  /** Line up where the commander points now: the wall on the point, the archers' ranks `back` blocks short of it. */
  function form() {
    const at = aimAt;
    const bots = squad.bots.filter((b) => b.entity);
    const of = (role) => bots.filter((b) => roleOf(b) === role);
    const [guards, archers, allMelee] = [of('guards'), of('archers'), of('melee')];
    if (reserves.size === 0) for (const b of allMelee.slice(0, reserveN)) reserves.add(b.username);
    const melee = allMelee.filter((b) => !reserves.has(b.username));
    const reserve = allMelee.filter((b) => reserves.has(b.username));
    const fwd = lookDir(at.yaw);
    const right = lookDir(at.yaw + 90);
    const point = pointOf(squad.bots, at, { distance, ahead: AHEAD });
    // The wall: one rank on the point, given out left to right.
    const given = lineUp(guards, point, at.yaw, { spacing, ground: squad.bots });
    // The flanks: the melee bots beyond the wall's ends (on the point when there is no wall), FLANK apart (a horse's width).
    const edge = guards.length ? ((guards.length - 1) * spacing) / 2 + FLANK : -((melee.length - 1) * FLANK) / 2;
    const flank = melee.map((_, i) => (guards.length ? (i % 2 ? 1 : -1) * (edge + Math.floor(i / 2) * FLANK) : edge + i * FLANK));
    for (const [name, s] of assignSlots(melee, flank.map((o) => onGround(squad.bots, point.offset(right.x * o, 0, right.z * o))), at.yaw)) given.set(name, s);
    // The archers: front-most to the front rank, then left to right.
    const centre = onGround(squad.bots, point.offset(-fwd.x * back, 0, -fwd.z * back));
    for (const [name, s] of lineUp(archers, centre, at.yaw, { spacing: archerSpacing, ranks, depth: 2, ground: squad.bots })) given.set(name, s);
    // The reserve: loose, behind the archers.
    const rear = onGround(squad.bots, point.offset(-fwd.x * (back + 3), 0, -fwd.z * (back + 3)));
    for (const [name, s] of lineUp(reserve, rear, at.yaw, { spacing: 2, ground: squad.bots })) given.set(name, s);
    line.point = point;
    line.v++;
    line.yaw = at.yaw;
    line.centre = centre;
    line.slots = given;
  }

  /**
   * Where each bot is heading: the slot's key, since when, loose or exact, reached once, a direct walk given up, and
   * whether it is a new place (`march`: an archer gets there first) or the same one again (pushed off, back from a fight).
   */
  const heading = new Map();
  const keyOf = (s) => `${s.x},${s.y},${s.z}`;
  const fresh = (slot, march = true) => ({ key: keyOf(slot), since: Date.now(), loose: !Number.isInteger(slot.y), reached: false, gaveUp: false, march });
  const headingOf = (bot, slot) => {
    let h = heading.get(bot.username);
    if (!h || h.key !== keyOf(slot)) heading.set(bot.username, (h = fresh(slot)));
    return h;
  };
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  /** Whether a bot holds its slot now (else it goes there). */
  const holds = (bot, slot) => {
    const p = bot.entity.position;
    const d = flat(p, slot);
    const h = heading.get(bot.username);
    const mine = h && h.key === keyOf(slot) ? h : null;
    if (Math.abs(p.y - slot.y) > 2) return false;
    return d <= ON_SLOT || (!!mine?.reached && d <= HOLD) || ((!!mine?.loose || !!mine?.gaveUp) && d <= LOOSE);
  };
  /**
   * Go to the slot (approach: the pathfinder, then the direct walk onto the exact place); a new formation or `until()`
   * ends it. Not reached in STUCK_MS: held loosely (LOOSE). A direct walk that gave up: held where the body got.
   */
  const go = async (bot, slot, until) => {
    let h = headingOf(bot, slot);
    // The same slot again after it had reached it (back from a fight, pushed off): a fresh exact goal (docs/29 §16).
    if (h.reached) heading.set(bot.username, (h = fresh(slot, false)));
    if (!h.loose && Date.now() - h.since > STUCK_MS) h.loose = true;
    const v = line.v;
    const left = h.loose ? 30_000 : Math.max(1, STUCK_MS - (Date.now() - h.since));
    const r = await approach(bot, slot, { until: () => line.v !== v || until(), tolerance: h.loose ? LOOSE : ON_SLOT, timeoutMs: left });
    if (r.timedOut && !h.loose && r.off <= 2.75 && Date.now() - h.since < STUCK_MS) {
      h.gaveUp = true;
      ctx.log(`${bot.username}: holds ${r.off.toFixed(2)} off its slot (the last step did not get there)`);
    }
  };
  const there = (bot, slot) => {
    const h = heading.get(bot.username);
    if (h && h.key === keyOf(slot)) h.reached = true;
  };

  /** The last melee hit each guard took and has not answered yet: the attacker, when. */
  const struck = new Map();
  /** One blow back: shield down, a step toward the attacker when out of arm's reach (never past `reach`), the blow. */
  const strikeBack = async (bot, foe, slot) => {
    if (!foe.isValid || flat(foe.position, slot) > reach + STRIKE_REACH) return;
    await shield(bot, false);
    if (!inReach(bot, foe)) {
      const v = line.v;
      const end = Date.now() + STEP_MS;
      bot.pathfinder.setGoal(new goals.GoalFollow(foe, 1), true);
      while (!inReach(bot, foe) && foe.isValid && line.v === v && Date.now() < end && flat(bot.entity.position, slot) <= reach) await squad.sleep(50);
      bot.pathfinder.setGoal(null);
      if (!foe.isValid || !inReach(bot, foe)) return;
    }
    if (!/_sword$|_axe$|_spear$/.test(bot.heldItem?.name ?? '')) {
      const weapon = bot.inventory.items().find((i) => /_sword$|_axe$|_spear$/.test(i.name));
      if (weapon) await bot.equip(weapon, 'hand');
    }
    await bot.lookAt(foe.position.offset(0, (foe.height ?? 1.8) * 0.8, 0), true);
    bot.attack(foe);
    ctx.log(`${bot.username}: hit back at ${foe.username ?? foe.name ?? '?'}`);
  };
  /** One look of one guard: hit back once if it was hit, else go to its slot shield up, else hold it facing the line. */
  const guard = async (bot) => {
    const slot = line.slots.get(bot.username);
    if (!slot) return squad.sleep(LOOK_MS); // until a formation gives it a slot
    const hit = struck.get(bot.username);
    if (hit) {
      struck.delete(bot.username);
      if (Date.now() - hit.at <= ANSWER_MS) return strikeBack(bot, hit.attacker, slot);
    }
    if (!holds(bot, slot)) {
      await shield(bot, true); // it walks behind its shield (the bots' physics does not slow a blocking bot)
      return go(bot, slot, () => struck.has(bot.username));
    }
    there(bot, slot);
    await faceYaw(bot, line.yaw);
    await shield(bot, true);
    await squad.sleep(LOOK_MS);
  };

  /** Who shoots what, and the targets a block stopped each archer's shot at. */
  const tg = targets();
  /** A threat within `range` of this archer, the nearest: in front of the line and untaken first, then in front, then untaken. */
  const pick = (bot) => {
    const c = line.centre;
    const d = lookDir(line.yaw);
    const front = (e) => (e.position.x - c.x) * d.x + (e.position.z - c.z) * d.z > 0;
    return tg.pick(bot, { radius: range, tiers: [(e, n) => front(e) && n === 0, front, (e, n) => n === 0, () => true] });
  };
  /** Why each archer holds fire now; logged once per change, not every look. */
  const holding = new Map();
  const holdFire = (bot, why) => {
    if (holding.get(bot.username) === why) return;
    holding.set(bot.username, why);
    if (why) ctx.log(`${bot.username}: holds fire: ${why}`);
  };
  /** Until when each archer that stepped aside shoots from where it is; until when one away from its slot walks on. */
  const aside = new Map();
  const walkOn = new Map();
  /** Whether an archer still marches to a new slot (holding fire on foot): not reached yet, for `march` seconds at most. */
  const marching = (bot, slot) => {
    const h = headingOf(bot, slot);
    return h.march && !h.reached && Date.now() - h.since < marchMs;
  };
  /** What this archer shoots now: nothing on its way to a new slot or walking on after a refused shot, else pick. */
  const target = (bot, slot, onSlot) => {
    if (slot && !onSlot && (marching(bot, slot) || Date.now() < (walkOn.get(bot.username) ?? 0))) return null;
    return pick(bot);
  };
  /** A bot on a horse (mineflayer's bot.vehicle): it can shoot on the move. */
  const riding = (bot) => !!bot.vehicle;
  /**
   * A horse archer away from its slot: it rides there (go) and, on the way, shoots what is in range without stopping
   * (shoot holds a free rein: the horse keeps its heading, the rider aims). Ends when the ride does (there, a new
   * formation, too long).
   */
  const rideAndShoot = async (bot, slot) => {
    let done = false;
    const ride = go(bot, slot, () => false).finally(() => {
      done = true;
    });
    ride.catch(() => undefined); // awaited below; a shot's error must not leave it unhandled meanwhile
    while (!done) {
      const t = pick(bot);
      if (!t) {
        holdFire(bot, `riding to its slot, nothing within ${range} blocks`);
        await Promise.race([ride, squad.sleep(LOOK_MS)]);
        continue;
      }
      holdFire(bot, null);
      const release = tg.take(t, bot);
      try {
        await shoot(bot, t);
      } catch (e) {
        if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
        ctx.log(`${bot.username}: ${e.message}`);
        if (/no clear line of fire/.test(e.message) && !/a friend is in the way/.test(e.message)) tg.block(bot, t, BLOCKED_MS);
        await Promise.race([ride, squad.sleep(250)]);
      } finally {
        release();
      }
    }
    await ride;
  };
  /** One look of one archer: shoot a threat in range from where it stands, else go to its slot, else face the view. */
  const archer = async (bot) => {
    const slot = line.slots.get(bot.username);
    const onSlot = !!slot && holds(bot, slot);
    if (onSlot) there(bot, slot);
    const isAside = Date.now() < (aside.get(bot.username) ?? 0);
    if (slot && !onSlot && !isAside && riding(bot)) return rideAndShoot(bot, slot);
    const t = slot ? target(bot, slot, onSlot) : pick(bot);
    if (t) {
      holdFire(bot, null);
      if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);
      const h = slot && !onSlot ? heading.get(bot.username) : undefined;
      const t0 = Date.now();
      const release = tg.take(t, bot);
      try {
        await shoot(bot, t);
      } catch (e) {
        if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
        ctx.log(`${bot.username}: ${e.message}`);
        const noLine = /no clear line of fire/.test(e.message);
        if (noLine && !/a friend is in the way/.test(e.message)) tg.block(bot, t, BLOCKED_MS);
        if (noLine && slot && !onSlot && !isAside) walkOn.set(bot.username, Date.now() + WALK_ON_MS);
        else if (noLine) {
          // A fresh heading back to the same slot (not a new place: it shoots on the way back).
          if (slot) heading.set(bot.username, fresh(slot, false));
          else heading.delete(bot.username);
          sidestep(bot, t);
          aside.set(bot.username, Date.now() + ASIDE_MS);
          await squad.sleep(500);
        } else await squad.sleep(250);
      } finally {
        release();
        if (h && h.key === keyOf(slot)) h.since += Date.now() - t0; // shooting is not being stuck
      }
      return;
    }
    if (!slot) {
      holdFire(bot, 'no slot yet, nothing in range');
      return squad.sleep(LOOK_MS);
    }
    // An archer aside stays there (the sidestep's goal is its own) until ASIDE_MS is over.
    if (!isAside && !onSlot) {
      const why = marching(bot, slot) ? 'marching to its new slot' : Date.now() < (walkOn.get(bot.username) ?? 0) ? 'walking to its slot after a blocked shot' : `walking to its slot, nothing within ${range} blocks`;
      holdFire(bot, why);
      return go(bot, slot, () => !!target(bot, slot, false));
    }
    holdFire(bot, isAside ? `stepped aside, nothing within ${range} blocks` : `on its slot, nothing within ${range} blocks`);
    await faceYaw(bot, line.yaw);
    await squad.sleep(LOOK_MS);
  };

  // A bot back from another order keeps its slot (it was kept for it); a newcomer re-forms the line.
  squad.on('joined', (bot) => {
    if (!line.slots.has(bot.username)) form();
  });
  form();
  // One loop per bot (squad.crew: started again for one that comes back), with who hit it in melee (the shield's blocks
  // too): its listener is removed when it leaves and added again when it comes back.
  squad.crew((bot) => (roleOf(bot) === 'archers' ? archer(bot) : guard(bot)), {
    setup: (bot) =>
      bot.on('meleeHit', (attacker) => {
        if (roleOf(bot) !== 'archers' && !isFriend(attacker)) struck.set(bot.username, { attacker, at: Date.now() });
      }),
  });
  // The reserve's watch: a foe near the wall's point → the reserve counter-attacks it there, then comes back.
  let countering = false;
  let counters = 0;
  const watch = async () => {
    for (;;) {
      await squad.sleep(300);
      if (countering || reserves.size === 0 || !line.point) continue;
      const pt = line.point;
      const rs = (squad.roles.melee ?? []).filter((b) => reserves.has(b.username) && b.entity);
      if (rs.length === 0 || !anyBot(squad.bots, (b) => nearestFoe(b, reach + 8, { from: pt }))) continue;
      countering = true;
      counters++;
      ctx.log(`reserve: ${rs.map((b) => b.username).join(', ')} counter-attack at the wall`);
      ctx
        .run('attack', { radius: reach + 8, seconds: 30, volley: 0, group: 8 }, { bots: rs })
        .catch((e) => ctx.log(`reserve: ${e.message}`))
        .finally(() => {
          countering = false;
        });
    }
  };
  if (reserveN > 0) watch().catch(() => undefined); // ends with the order (its sleep throws)
  await squad.untilStopped();
  return counters ? `Ligne rompue (${counters} contre-attaque${counters === 1 ? '' : 's'} de la réserve).` : 'Ligne rompue.';
}
