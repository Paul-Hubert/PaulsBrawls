// Stock command: attack where the commander points. It merged `epee` and `tir` (docs/40). Any item can carry it
// (/bots orders bind attack), a sword, a bow, a stick, or none (/bots order attack): a click only says WHERE
// (pointedTarget): an arrow's hit, else the crosshair's creature or block.
//   • a creature or a player who is not on our team there, or the nearest one within `near` blocks of the point: its
//     group is attacked, it and every threat within `group` blocks of it (docs/44), spread over the bots: each takes
//     one nobody is on (the pointed one first), else one with room. Archers shoot from where they stand; at most two
//     melee bots on one foe. Until it is dead or gone and nothing is left of its group, or `seconds`;
//   • nobody there (the ground): each archer fires a volley, `volley` arrows at points spread evenly over a disc of
//     radius `spread` around the point, then shoots threats within `radius` of it; the melee bots go to the point (a
//     ring of 3) and fight what is there. Until the volley is fired and nothing is left to fight there, or `seconds`;
//   • the sky: « Aucune cible. »; one of our own with nobody to fight near them: refused, never a volley onto a friend.
// Then the order ends: bots it took from a `line` go back to it, and to their slots there. A new click while it runs
// retargets it (it listens: ctx.commander.on('trigger')); a bow's arrow-release with no creature in the crosshair waits
// for its arrow's hit (the first one up to 4 s, then the look). Archers never walk, except a step aside after "no clear
// line of fire", so a line of archers keeps its shape.
// Horsemen with spears (canLance: mounted, a spear) do not swing: a spear misses nearer than 2 blocks, and its real
// blow is the charge (docs/44). They charge in waves, in the formation they stood in when the order took them (their
// places across and along the axis of the charge): together, each at the foe of the group nearest its lane, through
// it at full speed with the spear's use held (lance), out `backoff` blocks beyond the group; there they re-form the
// same shape facing back, and charge again, until the group is gone. Far from the group (more than backoff + 20),
// they first form up `backoff` blocks short of it (lanceWaves plans the waves). On the ground with nothing near the point,
// they hold the ring.
export const manifest = {
  summary: 'Attaque : tout le monde sur ce que je vise, sinon une volée et une charge sur le point visé',
  params: {
    type: 'object',
    properties: {
      radius: { type: 'integer', minimum: 4, maximum: 48, default: 16, description: 'rayon défendu autour de la cible ou du point' },
      seconds: { type: 'integer', minimum: 5, maximum: 600, default: 60, description: "durée maximale de l'attaque" },
      near: { type: 'integer', minimum: 0, maximum: 16, default: 4, description: 'distance autour du point visé où chercher une cible' },
      volley: { type: 'integer', minimum: 0, maximum: 16, default: 3, description: 'flèches par archer sur un point au sol' },
      spread: { type: 'number', minimum: 0, maximum: 16, default: 3, description: 'rayon de la volée autour du point visé' },
      group: { type: 'integer', minimum: 0, maximum: 32, default: 8, description: 'rayon du groupe attaqué autour de la cible visée' },
      backoff: { type: 'integer', minimum: 6, maximum: 32, default: 12, description: 'recul des cavaliers entre deux charges' },
    },
  },
  roles: {
    archers: { select: { hasItem: 'bow' }, take: 'reclaim' },
    melee: { select: { not: { hasItem: 'bow' } }, take: 'reclaim' },
  },
  duration: 'bounded',
  maxMinutes: 10,
};

/** Melee bots on one target at most. */
const PER_TARGET = 2;
/** How often a bot looks again. */
const LOOK_MS = 200;
/** A target last seen this close to one of the bots and then gone is taken for dead. */
const NEAR = 24;
/** How long an arrow's hit is awaited after the release that started the order, when the release named no creature. */
const HIT_WAIT_MS = 4_000;
/** The point is held: the volley fired, every melee bot by the point, and no threat near it for this long. */
const CLEAR_MS = 1_500;

export default async function (squad, args, ctx) {
  // First: every later click retargets (from the first target on) instead of restarting the order.
  let ready = false;
  ctx.commander.on('trigger', (at) => {
    if (ready) retarget(at);
  });
  if (squad.bots.length === 0) throw new Error('no bot available');
  const radius = Number(args.radius) || 16;
  const seconds = Number(args.seconds) || 60;
  const near = Math.max(0, Number(args.near ?? 4));
  const volley = Math.max(0, Math.min(16, Math.floor(Number(args.volley ?? 3))));
  const spread = Math.max(0, Number(args.spread ?? 3));
  const group = Math.max(0, Number(args.group ?? 8));
  const backoff = Math.max(6, Number(args.backoff ?? 12));

  /** What a click points at: 'target' (an entity), 'ground' (a point), 'wait' (a release: its hit follows), 'refuse', 'none'. */
  const fromAt = (at, final = false) => {
    const p = pointedTarget(squad.bots, at, { near });
    if (p.entity) return { kind: 'target', ref: p.entity };
    if (p.pending && !final) return { kind: 'wait' };
    const t = at.trigger;
    const ref = t && t.kind === 'arrow-hit' && t.hit ? t.hit.entity : at.lookEntity;
    if (ref && isFriend(ref)) return { kind: 'refuse', text: `${ref.username ?? ref.name} est des nôtres : je n'attaque pas.` };
    return p.position ? { kind: 'ground', point: anyBot(squad.bots, (b) => groundAt(b, p.position)) ?? p.position } : { kind: 'none' };
  };

  /** Whether a bot stands within NEAR of the entity (then its disappearance is a death, not a loss of sight). */
  const nearABot = (e) => squad.bots.some((b) => b.entity && b.entity.position.distanceTo(e.position) <= NEAR);

  /** The target as this bot sees it, by the id resolved at the decision (a player by name). */
  const track = (bot, t) => {
    const e = t.username ? bot.players[t.username]?.entity : bot.entities[t.id];
    return e && e.isValid !== false ? e : null;
  };

  /**
   * What the bots do now; every decision bumps `v`, which ends what each bot was doing. `left`: volley arrows still to
   * fire per archer; `clearSince`: since when the point has been held.
   */
  const state = { v: 0, mode: null, shots: 0, end: '' };

  /** Aim at a decision; false when no bot sees the entity. */
  const setMode = (d) => {
    const m = { kind: d.kind, point: d.point ?? null, target: null, until: Date.now() + seconds * 1000, near: false, left: new Map(), busy: new Set(), clearSince: 0 };
    if (d.kind === 'target') {
      const e = anyBot(squad.bots, (b) => entityOf(b, d.ref));
      if (!e) return false;
      m.target = { id: e.id, username: e.username ?? null, name: e.username ?? e.name };
      m.near = nearABot(e);
      m.last = e.position.clone();
    } else {
      for (const b of squad.roles.archers ?? []) m.left.set(b.username, volley);
    }
    state.mode = m;
    state.v++;
    waves.reset();
    spots.clear();
    return true;
  };

  /** A later click: a new target (a release without one waits for its hit, which comes as the next click). */
  const retarget = (at) => {
    const d = fromAt(at);
    if (d.kind === 'refuse') ctx.say(d.text);
    else if (d.kind === 'none') ctx.say('Aucune cible.');
    else if ((d.kind === 'target' || d.kind === 'ground') && !setMode(d)) ctx.say('Cible hors de vue de mes bots.');
  };

  /** Who fights what, per role (targets: entity → the bots on it). */
  const taken = { archers: targets(), melee: targets() };
  /** A threat within `radius` of `from`, nearest to it first: an untaken one, then one with room (fewer than cap on it). */
  const pick = (bot, role, cap, from, skip) => taken[role].pick(bot, { from, radius, cap, skip });

  /** The group attacked: around the pointed target (where it is, else where it was last seen), or the point. */
  const zoneOf = (m) =>
    m.kind === 'target'
      ? { center: anyBot(squad.bots, (b) => track(b, m.target)?.position) ?? m.last, r: group }
      : { center: m.point, r: radius };
  /**
   * A foe of the pointed target's group for this bot: the target when nobody is on it, else one of the group nobody is
   * on (nearest the target first), else the target or one of the group with fewer than `cap` on it.
   */
  const groupPick = (bot, role, cap, m) => {
    const t = taken[role];
    const e = track(bot, m.target);
    const from = e?.position ?? m.last;
    if (e && t.load(e) === 0 && !t.blocked(bot, e)) return e;
    const free = t.pick(bot, { from, radius: group, tiers: [(_x, n) => n === 0], skip: e });
    if (free) return free;
    if (e && t.load(e) < cap && !t.blocked(bot, e)) return e;
    return t.pick(bot, { from, radius: group, cap, skip: e });
  };
  /** The foes of the group, as the first bot that sees any sees them (the pointed target first), nearest its centre first. */
  const groupFoes = (m) => {
    const z = zoneOf(m);
    const foes =
      anyBot(squad.bots, (b) => {
        const list = foesNear(b, z.r, { from: z.center });
        const t = m.kind === 'target' ? track(b, m.target) : null;
        if (t && !list.includes(t)) list.unshift(t);
        return list.length ? list : null;
      }) ?? [];
    return { ...z, foes };
  };

  /** A point of the volley: uniform over the disc around `c`, on the ground where this archer knows it. */
  const volleySpot = (bot, c) => {
    const r = spread * Math.sqrt(Math.random());
    const a = Math.random() * 2 * Math.PI;
    const p = new Vec3(c.x + Math.cos(a) * r, c.y, c.z + Math.sin(a) * r);
    const g = groundAt(bot, p);
    return g ? new Vec3(p.x, g.y, p.z) : p;
  };

  /** Each melee bot's place by the point: a ring of 3, by its index (per decision: cleared by setMode). */
  const spots = new Map();
  const spotOf = (bot, m) => {
    let s = spots.get(bot.username);
    if (!s) {
      const list = squad.roles.melee ?? [];
      const a = (2 * Math.PI * Math.max(0, list.indexOf(bot))) / Math.max(1, list.length);
      const raw = m.point.offset(Math.round(Math.cos(a) * 30) / 10, 0, Math.round(Math.sin(a) * 30) / 10);
      s = anyBot(squad.bots, (b) => groundAt(b, raw)) ?? raw;
      spots.set(bot.username, s);
    }
    return s;
  };
  /** The goal each melee bot was given toward its spot (set once, not awaited). */
  const heading = new Map();
  const goNear = (bot, spot) => {
    const h = heading.get(bot.username);
    if (h && h.spot === spot && bot.pathfinder.goal === h.goal) return;
    const goal = new goals.GoalNear(spot.x, spot.y, spot.z, 1);
    bot.pathfinder.setGoal(goal);
    heading.set(bot.username, { spot, goal });
  };
  const byPoint = (bot, m) => {
    const p = bot.entity.position;
    const s = spotOf(bot, m);
    return Math.hypot(p.x - s.x, p.z - s.z) <= 2;
  };

  /** One look of one archer: the target's group, else the volley, else a threat near the point; shot from where it stands. */
  const archer = async (bot) => {
    const m = state.mode;
    let at = null;
    let foe = null;
    if (m.kind === 'target') foe = groupPick(bot, 'archers', Infinity, m);
    else if ((m.left.get(bot.username) ?? 0) > 0) {
      m.left.set(bot.username, (m.left.get(bot.username) ?? 0) - 1);
      at = volleySpot(bot, m.point);
    } else foe = pick(bot, 'archers', Infinity, m.point);
    if (!foe && !at) {
      await squad.sleep(LOOK_MS);
      return;
    }
    m.busy.add(bot.username);
    const release = foe ? taken.archers.take(foe, bot) : () => undefined;
    try {
      await shoot(bot, foe ?? at);
      state.shots++;
    } catch (e) {
      if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
      ctx.log(`${bot.username}: ${e.message}`);
      if (/no arrows|no bow/.test(e.message)) m.left.set(bot.username, 0);
      if (foe && /no clear line of fire/.test(e.message)) sidestep(bot, foe); // out from behind what blocked the shot
      await squad.sleep(foe && /no clear line of fire/.test(e.message) ? 500 : 250);
    } finally {
      release();
      m.busy.delete(bot.username);
    }
  };

  /** One look of one melee bot: a foe of the target's group (two on one at most); on the ground, what is near the point. */
  const fight = async (bot) => {
    if (lancer(bot)) return rider(bot);
    const m = state.mode;
    const v = state.v;
    let foe = null;
    let leash = null;
    if (m.kind === 'target') {
      foe = groupPick(bot, 'melee', PER_TARGET, m);
      leash = () => zoneOf(m).center;
      if (!foe) {
        // Nothing with room: stay close to the group.
        const c = zoneOf(m).center;
        bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, 3));
        await squad.sleep(LOOK_MS);
        return;
      }
    } else {
      foe = pick(bot, 'melee', PER_TARGET, m.point);
      leash = () => m.point;
      if (!foe) {
        goNear(bot, spotOf(bot, m));
        await squad.sleep(LOOK_MS);
        return;
      }
    }
    // melee(): too far from the leash's centre, it rides closer first (a horseman riding to a far point starved the
    // event loop, docs/41 §4); a fight that broke off is followed by a pause.
    const release = taken.melee.take(foe, bot);
    try {
      const opts = { timeoutMs: 15000, until: () => state.v !== v };
      const closeIn = m.kind === 'target' ? undefined : (b) => goNear(b, spotOf(b, m));
      await melee(bot, foe, leash ? { ...opts, leash: { center: leash, radius }, closeIn } : opts);
    } catch (e) {
      if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
      ctx.log(`${bot.username}: ${e.message}`);
      await squad.sleep(250);
    } finally {
      release();
    }
  };

  // -- horsemen with spears: charges in waves (docs/44: lanceWaves plans them) -------------------------------------

  /** Whether this melee bot charges with a lance now (it rides, with a spear: its horse can die). */
  const lancer = (bot) => {
    try {
      return canLance(bot);
    } catch (e) {
      if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
      return false;
    }
  };
  const riders = () => (squad.roles.melee ?? []).filter((b) => b.entity && lancer(b));
  const waves = lanceWaves({ backoff, ground: () => squad.bots, view: () => ctx.commander.at.yaw ?? 0 });
  /** One look of one horseman: its charge of this wave, else its place in the formation, else the ring (ground). */
  const rider = async (bot) => {
    const m = state.mode;
    const v = state.v;
    const foe = (lane, center) => (lane && track(bot, lane)) || nearestFoe(bot, group || 4, { from: center });
    const look = await waves.ride(bot, { foe, until: () => state.v !== v || !!state.end, log: (line) => ctx.log(line) });
    if (look === 'charged') return;
    if (look === 'idle' && m.kind === 'ground') goNear(bot, spotOf(bot, m));
    await squad.sleep(LOOK_MS);
  };

  /** Whether any bot sees a threat within `r` (default `radius`) of the point. */
  const threatNear = (p, r = radius) => !!anyBot(squad.bots, (b) => nearestFoe(b, r, { from: p }));

  // The first target.
  let first = fromAt(ctx.commander.at);
  if (first.kind === 'wait') {
    // The hit, or (none within 4 s, or another release) the look of the latest snapshot.
    const hit = await ctx.commander.next(HIT_WAIT_MS);
    first = fromAt(hit ?? ctx.commander.at, true);
  }
  if (first.kind === 'refuse') return first.text;
  if (first.kind === 'none') return 'Aucune cible.';
  if (!setMode(first)) return 'Cible hors de vue de mes bots.';
  ready = true;

  // One loop per bot (squad.crew: started again for one that comes back), until the attack ends.
  squad.crew((bot, role) => (role === 'archers' ? archer(bot) : fight(bot)), { while: () => !state.end });

  while (!state.end) {
    await squad.sleep(LOOK_MS);
    const m = state.mode;
    const rs = riders();
    if (rs.length) waves.step(rs, groupFoes(m).foes);
    if (m.kind === 'target') {
      const seen = anyBot(squad.bots, (b) => track(b, m.target));
      if (seen) {
        m.near = nearABot(seen);
        m.last = seen.position.clone();
        m.gone = false;
      } else m.gone = true;
      if (m.gone && !m.near) state.end = `Cible perdue de vue (${m.target.name})`;
      else if (m.gone && !threatNear(m.last, group)) {
        // Down, and nothing left of its group.
        m.clearSince = m.clearSince || Date.now();
        if (Date.now() - m.clearSince >= CLEAR_MS || group === 0) state.end = `Cible abattue (${m.target.name})`;
      } else m.clearSince = 0;
      if (!state.end && Date.now() > m.until) state.end = m.gone ? `Toujours à l'attaque après ${seconds} s` : `Cible toujours debout après ${seconds} s (${m.target.name})`;
      continue;
    }
    const fired = [...m.left.values()].every((n) => n <= 0) && m.busy.size === 0;
    const there = (squad.roles.melee ?? []).every((b) => !b.entity || byPoint(b, m));
    if (fired && there && !threatNear(m.point)) {
      m.clearSince = m.clearSince || Date.now();
      if (Date.now() - m.clearSince >= CLEAR_MS) state.end = (squad.roles.archers ?? []).length && volley > 0 ? 'Volée tirée, point tenu' : 'Point tenu';
    } else m.clearSince = 0;
    if (!state.end && Date.now() > m.until) state.end = `Toujours à l'attaque après ${seconds} s`;
  }
  const tally = [];
  if (state.shots) tally.push(`${state.shots} flèche${state.shots === 1 ? '' : 's'}`);
  if (waves.passes) tally.push(`${waves.passes} charge${waves.passes === 1 ? '' : 's'} (${waves.struck} touché${waves.struck === 1 ? '' : 's'})`);
  return tally.length ? `${state.end} : ${tally.join(', ')}.` : `${state.end}.`;
}
