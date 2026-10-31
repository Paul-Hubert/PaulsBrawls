// Stock command, made for a bound sword (/bots orders bind epee). What the commander looks at decides, and each click
// of the bound sword decides again without stopping the order (it listens: ctx.commander.on('trigger')):
//   • a creature or a player who is not on our team: everyone goes for it. Archers shoot it; at most two guards fight
//     it, the other guards fight what is near it (within `radius` of it). Once it is dead or gone, or after
//     `seconds`, a line to the commander and the bots defend the commander;
//   • the ground (a block): the bots hold that spot, like `defend` anchored on a point instead of the commander:
//     threats within `radius` of the point, guards on a ring of 3 around it, archers on a ring of 6, fights leashed
//     to the point;
//   • the sky, or one of our own: the bots defend the commander, as `defend` does.
// Guards spread over the threats (at most two on one, an untaken one first); archers prefer a threat no other archer
// shoots and step aside after "no clear line of fire". A bot reclaimed by another order resumes when it comes back.
export const manifest = {
  summary: 'Épée : attaquer ce que je regarde, tenir le sol visé, sinon me défendre',
  params: {
    type: 'object',
    properties: {
      radius: { type: 'integer', minimum: 4, maximum: 48, default: 16, description: 'rayon défendu autour de moi, du point ou de la cible' },
      seconds: { type: 'integer', minimum: 5, maximum: 600, default: 60, description: 'durée maximale contre une même cible' },
    },
  },
  roles: {
    archers: { select: { hasItem: 'bow' }, take: 'reclaim' },
    melee: { select: { not: { hasItem: 'bow' } }, take: 'reclaim' },
  },
  duration: 'until-stopped',
};

/** Guards on one target at most. */
const PER_TARGET = 2;
/** How often a bot looks again (follow keeps its goal between calls, so this is cheap). */
const LOOK_MS = 200;
/** A target last seen this close to one of the bots and then gone is taken for dead. */
const NEAR = 20;

export default async function (squad, args, ctx) {
  // First: every later click decides again instead of restarting the order.
  ctx.commander.on('trigger', () => decide());
  if (squad.bots.length === 0) throw new Error('no bot available (archers need a bow)');
  const radius = Number(args.radius) || 16;
  const seconds = Number(args.seconds) || 60;

  /** What the bots do: kind 'target' (an entity), 'anchor' (a point) or 'commander'. One shape for every kind. */
  const mode = (kind, point = null, target = null) => ({ kind, point, target, until: 0, near: false });
  /** The current mode; every decision bumps `v`, which ends what each bot was doing. */
  const state = { v: 0, mode: mode('commander') };

  const commander = (bot) => ctx.commander.entity(bot);

  /** The first answer of `fn` over the order's bots (a bot that has just left is skipped). */
  const anyBot = (fn) => {
    for (const b of squad.bots) {
      try {
        const r = fn(b);
        if (r) return r;
      } catch (e) {
        if (!(e instanceof BotLeftError)) throw e;
      }
    }
    return null;
  };

  /** Whether a bot stands within NEAR of the entity (then its disappearance is a death, not a loss of sight). */
  const nearABot = (e) => squad.bots.some((b) => b.entity && b.entity.position.distanceTo(e.position) <= NEAR);

  /** The target as this bot sees it, by the id resolved at the decision (a player by name). */
  const track = (bot, t) => {
    const e = t.username ? bot.players[t.username]?.entity : bot.entities[t.id];
    return e && e.isValid !== false ? e : null;
  };

  function decide() {
    const at = ctx.commander.at;
    const ref = at.lookEntity;
    let next = mode('commander');
    if (ref && !isFriend(ref)) {
      const e = anyBot((b) => entityOf(b, ref));
      if (e && !isFriend(e)) {
        next = mode('target', null, { id: e.id, username: e.username ?? null, name: e.username ?? e.name });
        next.until = Date.now() + seconds * 1000;
        next.near = nearABot(e);
      }
    }
    if (next.kind === 'commander' && at.lookBlock && !(ref && isFriend(ref))) {
      const top = at.lookBlock.offset(0.5, 1, 0.5);
      next = mode('anchor', anyBot((b) => groundAt(b, top)) ?? top);
    }
    state.mode = next;
    state.v++;
    spots.clear();
  }

  /** The point defended now, as this bot sees it: the anchor, else the commander, else the bot itself. */
  const center = (bot, m) => (m.kind === 'anchor' ? m.point : commander(bot)?.position ?? bot.entity.position);

  /** A player not on our team who is not a spectator (nobody can hit one). */
  const isFoe = (bot, e) => e.type === 'player' && !!e.username && !isFriend(e) && bot.players[e.username]?.gamemode !== 3;

  /** Who fights what, per role: entity id → names of the bots on it. */
  const taken = { archers: new Map(), melee: new Map() };
  const load = (map, e) => map.get(e.id)?.size ?? 0;
  const take = (map, e, bot) => {
    const set = map.get(e.id) ?? new Set();
    set.add(bot.username);
    map.set(e.id, set);
    return () => {
      set.delete(bot.username);
      if (set.size === 0 && map.get(e.id) === set) map.delete(e.id);
    };
  };

  /** A threat within `radius` of `from`, nearest to it first: an untaken one, then one with room (fewer than cap on it). */
  const pick = (bot, map, cap, from, skip) => {
    for (const max of [1, cap]) {
      const room = (e) => e !== skip && load(map, e) < max;
      const t = nearestHostile(bot, radius, { from, filter: room }) ?? nearestEntity(bot, (e) => isFoe(bot, e) && room(e), radius, { from });
      if (t) return t;
    }
    return null;
  };

  /** This bot's slot: an angle by its index within its role, on a ring (guards 3, archers 6). */
  const ring = (bot, role) => {
    const list = squad.roles[role] ?? [];
    const n = Math.max(1, list.length);
    const r = role === 'archers' ? 6 : 3;
    const a = (role === 'archers' ? Math.PI / 8 : 0) + (2 * Math.PI * Math.max(0, list.indexOf(bot))) / n;
    return { x: Math.round(Math.cos(a) * r * 10) / 10, z: Math.round(Math.sin(a) * r * 10) / 10 };
  };

  /** Ground under each bot's anchor slot (per decision: cleared by decide). */
  const spots = new Map();
  /** The goal each bot was given toward its anchor slot. */
  const heading = new Map();

  /** Hold this bot's slot: around the commander (follow), or around the anchor (a pathfinder goal, not awaited). */
  const hold = async (bot, role, m) => {
    const off = ring(bot, role);
    if (m.kind !== 'anchor') {
      await follow(bot, commander(bot), role === 'archers' ? 2 : 1.5, { untilMs: LOOK_MS, offset: off });
      return;
    }
    const key = `${bot.username}:${off.x},${off.z}`;
    if (!spots.has(key)) {
      const raw = m.point.offset(off.x, 0, off.z);
      spots.set(key, anyBot((b) => groundAt(b, raw)) ?? raw);
    }
    const spot = spots.get(key);
    const p = bot.entity.position;
    const h = heading.get(bot.username);
    if (Math.hypot(p.x - spot.x, p.z - spot.z) > 1.5 && !(h && h.spot === spot && bot.pathfinder.goal === h.goal)) {
      const goal = new goals.GoalNear(spot.x, spot.y, spot.z, 1);
      bot.pathfinder.setGoal(goal);
      heading.set(bot.username, { spot, goal });
    }
    await squad.sleep(LOOK_MS);
  };

  /** One to two blocks to one side of the line to the target: out from behind whatever blocked the shot. */
  const sidestep = async (bot, t) => {
    const p = bot.entity.position;
    const dx = t.position.x - p.x;
    const dz = t.position.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const side = (Math.random() < 0.5 ? 1 : -1) * (1 + Math.random());
    bot.pathfinder.setGoal(new goals.GoalNear(p.x - (dz / len) * side, p.y, p.z + (dx / len) * side, 1));
    await squad.sleep(500);
  };

  /** One look of one bot: pick what to fight in the current mode, fight it once, else hold its slot. */
  const step = async (bot, role) => {
    const m = state.mode;
    const v = state.v;
    const map = taken[role];
    let foe = null;
    let leash = null;
    if (m.kind === 'target') {
      const e = track(bot, m.target);
      if (e && (role === 'archers' || load(map, e) < PER_TARGET)) foe = e;
      else if (e) {
        // Two guards on it already: what is near it instead.
        foe = pick(bot, map, PER_TARGET, e.position, e);
        leash = () => track(bot, m.target)?.position;
      }
    } else {
      foe = pick(bot, map, role === 'archers' ? Infinity : PER_TARGET, center(bot, m));
      leash = () => center(bot, m);
    }
    if (!foe) {
      await hold(bot, role, m);
      return;
    }
    const release = take(map, foe, bot);
    try {
      if (role === 'archers') {
        await shoot(bot, foe);
      } else {
        const opts = { timeoutMs: 15000, until: () => state.v !== v };
        const r = await attack(bot, foe, leash ? { ...opts, leash: { center: leash, radius } } : opts);
        if (r.brokeOff === 'leash') await hold(bot, role, state.mode);
      }
    } catch (e) {
      if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
      ctx.log(`${bot.username}: ${e.message}`);
      if (/no clear line of fire/.test(e.message)) await sidestep(bot, foe);
      else await squad.sleep(250);
    } finally {
      release();
    }
  };

  /** One loop per bot, started again for a bot that comes back (reclaimed by another order, then returned). */
  const crew = new Map();
  const launch = (bot, role) => {
    const token = {};
    crew.set(bot.username, token);
    squad
      .parallel(bot, async (b) => {
        while (!squad.stopped && crew.get(b.username) === token) {
          try {
            await step(b, role);
          } catch (e) {
            if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
            ctx.log(`${b.username}: ${e.message}`);
            await squad.sleep(500);
          }
        }
      })
      .catch(() => undefined);
  };

  /** The target's end: dead or gone, or out of time. Back to defending the commander. */
  const end = (m, line) => {
    if (state.mode !== m) return;
    ctx.say(line);
    state.mode = mode('commander');
    state.v++;
  };

  squad.on('joined', (bot, role) => launch(bot, role));
  decide();
  for (const [role, list] of Object.entries(squad.roles)) for (const bot of list) launch(bot, role);
  while (!squad.stopped) {
    const m = state.mode;
    if (m.kind === 'target') {
      const seen = anyBot((b) => track(b, m.target));
      if (seen) m.near = nearABot(seen);
      if (!seen) end(m, m.near ? `Cible abattue (${m.target.name}).` : `Cible perdue de vue (${m.target.name}) : je reviens te défendre.`);
      else if (Date.now() > m.until) end(m, `Cible toujours debout après ${seconds} s (${m.target.name}) : je reviens te défendre.`);
    }
    await squad.sleep(LOOK_MS);
  }
  return 'Épée rengainée.';
}
