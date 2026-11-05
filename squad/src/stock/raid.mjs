// Stock command: an army marches on a point and fights whoever it meets there, the bots of another player first of
// all. Built for `/bots raid` (an admin's enemy army, owned by a virtual player), but any owner can order it.
//
// The army moves as one group behind a leader (the first melee bot, else the first archer): the leader walks toward
// the point in short steps and waits when most of the others fall behind; every other bot holds its own slot in a
// formation around the leader (melee in rows just behind it, archers a few blocks further back), so twenty bots do
// not stand in the same block. On the way and at the point, any enemy within `radius` of the leader is fought: a
// player who is not a friend (that includes the other army's bots, since friends are only our own team) or a hostile
// mob. Guards go at most two on one enemy, an untaken one first; archers prefer an enemy no other archer shoots.
// Guards are leashed to the leader, so the group does not scatter after one runaway.
//
// At the point the leader hunts: `target` if any bot sees them, else the enemy player nearest to where the target was
// last seen (their bots defend around them), within 64 blocks; the army marches on again toward what it found. The
// raid ends when no enemy player has been found for `quiet` seconds (default a minute) at the point, or when it is stopped.
export const manifest = {
  summary: "Attaquer l'armée d'un joueur",
  params: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'le point à attaquer (défaut : le bloc que tu regardes, sinon ta position)' },
      y: { type: 'number' },
      z: { type: 'number' },
      target: { type: 'string', description: 'le joueur visé : lui et ses bots en premier' },
      radius: { type: 'integer', minimum: 8, maximum: 48, default: 24, description: "distance d'engagement autour du chef" },
      quiet: { type: 'integer', minimum: 1, maximum: 600, default: 60, description: 'secondes sans ennemi au point avant la fin du raid' },
    },
  },
  roles: {
    archers: { select: { hasItem: 'bow' }, take: 'reclaim' },
    melee: { select: { not: { hasItem: 'bow' } }, take: 'reclaim' },
  },
  duration: 'until-stopped',
};

/** Guards on one enemy at most. */
const PER_TARGET = 2;
/** How often a bot looks around between fights (follow keeps its goal between calls, so this is cheap). */
const LOOK_MS = 200;
/** The leader's step toward the point: short, so it looks for enemies between steps and the group keeps up. */
const STEP = 12;
/** Within this many blocks (horizontally) of the point, the leader is there and starts hunting. */
const THERE = 4;
/** How far from the point the hunt looks for enemy players. */
const HUNT = 64;
/** A bot farther than this from the leader is falling behind; the leader waits while most of them are. */
const BEHIND = 14;
/** The leader gives up a step after this long without moving a block, and steps aside. */
const STUCK_MS = 8_000;
/** Formation: bots per row, and the gap between bots and between rows. */
const ROW = 5;
const GAP = 2;

export default async function (squad, args, ctx) {
  if (squad.bots.length === 0) throw new Error('no bot available for the raid');
  const radius = Number(args.radius) || 24;
  /** No enemy player for this long at the point: the raid is over. */
  const quietMs = (Number(args.quiet) || 60) * 1000;
  const at = ctx.commander.at;
  const first =
    args.x !== undefined && args.z !== undefined
      ? new Vec3(Number(args.x), args.y !== undefined ? Number(args.y) : at.position.y, Number(args.z))
      : at.lookBlock
        ? new Vec3(at.lookBlock.x, at.lookBlock.y + 1, at.lookBlock.z)
        : at.position.clone();
  const target = typeof args.target === 'string' && args.target.length > 0 ? args.target : null;

  /** Shared by every bot's loop: where the army goes, which way it faces, since when no enemy was seen, the end. */
  const state = { dest: first, heading: { x: 1, z: 0 }, quietSince: Date.now(), done: false, found: 0 };

  /** The leader: the first melee bot, else the first archer (the lists are live, so a dead leader is replaced). */
  const leader = () => (squad.roles.melee ?? [])[0] ?? (squad.roles.archers ?? [])[0] ?? squad.bots[0];
  /** The leader as `bot` sees it (null when out of its sight). */
  const leaderEntity = (bot) => {
    const l = leader();
    return l ? bot.players[l.username]?.entity ?? null : null;
  };
  /** The point the fight is measured from, as this bot knows it: the leader's position, else its own. */
  const anchor = (bot) => {
    const l = leader();
    return l && l !== bot && l.entity ? l.entity.position : bot.entity.position;
  };

  /** Who fights what, per role (targets: entity → the bots on it). */
  const taken = { archers: targets(), melee: targets() };
  /** An enemy for this bot near its anchor: an untaken one first, then one with room (fewer than `cap` on it). */
  const pick = (bot, role, cap) => taken[role].pick(bot, { from: anchor(bot), radius, cap, prefer: 'nearest' });

  /** The other bots of a role, the leader left out (it has no slot: the formation is around it). */
  const ranks = (role) => (squad.roles[role] ?? []).filter((b) => b !== leader());

  /** This bot's slot behind the leader, facing the march: melee rows first, then the archers' rows. */
  const slot = (bot, role) => {
    const melee = ranks('melee');
    const i = Math.max(0, ranks(role).indexOf(bot));
    const meleeRows = Math.ceil(melee.length / ROW);
    const row = Math.floor(i / ROW);
    const back = role === 'melee' ? (row + 1) * GAP : meleeRows * GAP + 4 + row * GAP;
    const side = ((i % ROW) - (ROW - 1) / 2) * GAP;
    const h = state.heading;
    const x = -h.x * back - h.z * side;
    const z = -h.z * back + h.x * side;
    return { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 };
  };

  /**
   * Fight one enemy with this role's weapon; false when it did not (then the bot keeps up instead). A guard is leashed
   * to the leader (to where it stood, for the leader). One too far from its anchor would break off before its first
   * swing, and the soldier's loop would spin on it (a horseman left behind starved the event loop, found live): melee()
   * does not start it (`closing`), and the soldier keeps up instead.
   */
  const fight = async (bot, role, t) => {
    if (role === 'archers' && bot.inventory.items().some((i) => i.name.endsWith('arrow'))) {
      await shoot(bot, t);
      return true;
    }
    const here = bot.entity.position.clone();
    const center = () => (bot === leader() ? here : anchor(bot));
    const r = await melee(bot, t, { timeoutMs: 15000, leash: { center, radius }, closeIn: () => undefined });
    return !r.closing && !r.brokeOff;
  };

  /** Engage if there is an enemy for this bot; true when it fought (or tried to). */
  const engage = async (bot, role) => {
    const map = taken[role] ?? taken.melee;
    const t = pick(bot, role === 'archers' ? 'archers' : 'melee', role === 'archers' ? Infinity : PER_TARGET);
    if (!t) return false;
    if (t.type === 'player') state.quietSince = Date.now();
    const release = map.take(t, bot);
    try {
      if (!(await fight(bot, role, t))) return false;
    } catch (e) {
      if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
      ctx.log(`${bot.username}: ${e.message}`);
      const blocked = /no clear line of fire/.test(e.message);
      if (blocked) sidestep(bot, t, { min: 2, max: 2 }); // two blocks to one side: out from behind what blocked it
      await squad.sleep(blocked ? 400 : 250);
    } finally {
      release();
    }
    return true;
  };

  /** The leader's intelligence: the target if any bot sees them now (the army goes for them). */
  const spotTarget = () => {
    if (!target) return null;
    for (const b of squad.bots) {
      const e = b.players[target]?.entity;
      if (e && e.position) return e;
    }
    return null;
  };

  /** The leader's current step: where it is walking to, and since when it has not moved. */
  let step = null;

  const lead = async (bot) => {
    const seen = spotTarget();
    if (seen) {
      state.dest = seen.position.clone();
      state.quietSince = Date.now();
    }
    const p = bot.entity.position;
    const dx = state.dest.x - p.x;
    const dz = state.dest.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1) state.heading = heading(dx, dz);

    if (dist <= THERE) {
      step = null;
      // At the point: hunt the enemy player nearest where the target was last seen (their army stands around them).
      const foe = nearestEntity(bot, (e) => isEnemy(bot, e), HUNT, { from: state.dest });
      if (foe) {
        state.quietSince = Date.now();
        if (foe.position.distanceTo(state.dest) > THERE) {
          state.dest = foe.position.clone();
          state.found++;
        }
      } else if (Date.now() - state.quietSince > quietMs) {
        state.done = true;
        return;
      }
      await squad.sleep(LOOK_MS);
      return;
    }
    state.quietSince = Date.now();

    // Wait for the group while most of it is behind (a fighting bot catches up after its fight).
    const others = squad.bots.filter((b) => b !== bot && b.entity);
    const behind = others.filter((b) => b.entity.position.distanceTo(p) > BEHIND).length;
    if (others.length > 0 && behind * 2 > others.length) {
      if (step) bot.pathfinder.setGoal(null);
      step = null;
      await squad.sleep(LOOK_MS * 2);
      return;
    }

    // The next step: STEP blocks toward the point (or the point itself), kept while it still points the same way.
    const t = Math.min(1, STEP / dist);
    const wx = p.x + dx * t;
    const wz = p.z + dz * t;
    const now = Date.now();
    const reached = step && Math.hypot(step.x - p.x, step.z - p.z) <= 2;
    if (!step || reached || Math.hypot(step.x - wx, step.z - wz) > 4 || bot.pathfinder.goal === null) {
      step = { x: wx, z: wz, from: p.clone(), at: now };
      bot.pathfinder.setGoal(new goals.GoalNearXZ(wx, wz, 2));
    } else if (p.distanceTo(step.from) >= 1) {
      step.from = p.clone();
      step.at = now;
    } else if (now - step.at > STUCK_MS) {
      ctx.log(`${bot.username}: stuck on the way to ${Math.round(wx)} ${Math.round(wz)}, stepping aside`);
      step = null;
      bot.pathfinder.setGoal(null);
      const a = Math.random() * 2 * Math.PI;
      bot.pathfinder.setGoal(new goals.GoalNearXZ(p.x + Math.cos(a) * 4, p.z + Math.sin(a) * 4, 1));
      await squad.sleep(1500);
      return;
    }
    await squad.sleep(LOOK_MS);
  };

  /** A bot behind the leader: hold its slot; when the leader is out of its sight, walk to where the leader is. */
  const keepUp = async (bot, role) => {
    const e = leaderEntity(bot);
    if (e) {
      await follow(bot, e, 1.5, { untilMs: LOOK_MS, offset: slot(bot, role) });
      return;
    }
    const l = leader();
    if (!l || !l.entity) {
      await squad.sleep(LOOK_MS);
      return;
    }
    try {
      await goTo(bot, l.entity.position, 4);
    } catch (err) {
      if (err instanceof BotLeftError || err instanceof OrderStoppedError) throw err;
      ctx.log(`${bot.username}: ${err.message}`);
      await squad.sleep(500);
    }
  };

  /** One pass of a soldier: fight if there is an enemy for it, else lead (the leader) or keep up. */
  const soldier = async (bot, role) => {
    if (await engage(bot, role)) {
      if (bot === leader()) step = null; // the fight moved it: plan a new step
      return;
    }
    if (bot === leader()) await lead(bot);
    else await keepUp(bot, role);
  };

  // One loop per bot (squad.crew: a pass that awaited nothing is followed by a pause, a bot that comes back gets a loop).
  squad.crew((bot, role) => soldier(bot, role === 'archers' ? 'archers' : 'melee'), { while: () => !state.done });
  while (!state.done) await squad.sleep(LOOK_MS); // a stop rejects the sleep: the order ends as stopped
  return state.found > 0 ? 'Raid terminé : plus aucun ennemi en vue.' : 'Raid terminé : aucun ennemi trouvé.';
}

/** The march direction rounded to one of 8 (so the formation's slots do not change with every small turn). */
function heading(dx, dz) {
  const a = Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: Math.round(Math.cos(a) * 1000) / 1000, z: Math.round(Math.sin(a) * 1000) / 1000 };
}
