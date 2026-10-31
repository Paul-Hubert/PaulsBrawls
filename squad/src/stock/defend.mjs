// Stock command: archers are pulled off whatever they were doing and shoot from range; melee bots are taken only
// if idle and fight up close. Friends are never targeted (and the server cancels damage between bots of the same
// owner, docs/system/squad/overview.md).
//
// Everything is relative to the COMMANDER, the player defended: only threats within `radius` of them count, the one
// nearest to them first (what reaches the player is dealt with first). A guard breaks off when its target leaves
// that circle or it strays too far itself, so nobody chases a zombie across the map. Guards spread over the threats
// (at most PER_TARGET on one, an untaken threat first); archers prefer a threat no other archer is shooting. Between
// threats every bot holds its own slot around the commander (guards on a ring of 3, archers on a ring of 6), so
// twenty bots do not stand in the same block. When the commander is out of a bot's sight, it defends itself.
export const manifest = {
  summary: 'Me défendre : archers à distance, mêlée au contact',
  params: { type: 'object', properties: { radius: { type: 'integer', minimum: 4, maximum: 48, default: 16 } } },
  roles: {
    archers: { select: { hasItem: 'bow' }, take: 'reclaim' },
    melee: { select: { not: { hasItem: 'bow' } }, take: 'free' },
  },
  duration: 'until-stopped',
};

/** Guards on one threat at most; the others take another one or hold their slot. */
const PER_TARGET = 2;
/** How often an idle bot looks for a threat (follow keeps its goal between calls, so this is cheap). */
const LOOK_MS = 200;

export default async function (squad, { radius }, ctx) {
  if (squad.bots.length === 0) throw new Error('no bot available (archers need a bow; melee bots must be idle)');

  const commander = (bot) => ctx.commander.entity(bot);
  /** The point defended, as this bot sees it: the commander, else the bot itself. */
  const center = (bot) => commander(bot)?.position ?? bot.entity.position;

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

  /** The threat nearest the commander: an untaken one first, then one with room (fewer than `cap` on it). */
  const pick = (bot, map, cap) => {
    const from = center(bot);
    for (const max of [1, cap]) {
      const room = (e) => load(map, e) < max;
      const t =
        nearestHostile(bot, radius, { from, filter: room }) ??
        nearestEntity(bot, (e) => e.type === 'player' && !isFriend(e) && room(e), radius, { from });
      if (t) return t;
    }
    return null;
  };

  /** This bot's slot: an angle by its index within its role, on a ring around the commander. */
  const slot = (bot, role, ring, phase) => {
    const list = squad.roles[role] ?? [];
    const n = Math.max(1, list.length);
    const a = phase + (2 * Math.PI * Math.max(0, list.indexOf(bot))) / n;
    return { x: Math.round(Math.cos(a) * ring * 10) / 10, z: Math.round(Math.sin(a) * ring * 10) / 10 };
  };

  /** Two blocks to one side of the line to the target: out from behind whatever blocked the shot. */
  const sidestep = async (bot, t) => {
    const p = bot.entity.position;
    const dx = t.position.x - p.x;
    const dz = t.position.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const side = Math.random() < 0.5 ? 2 : -2;
    bot.pathfinder.setGoal(new goals.GoalNear(p.x - (dz / len) * side, p.y, p.z + (dx / len) * side, 1));
    await squad.sleep(400);
  };

  /** One loop per bot: fight the threat it picked, else hold its slot. `fight` gets `home` to go back to it. */
  const guard = ({ role, ring, phase, range, cap, fight }) => async (bot) => {
    const map = taken[role];
    const home = () => follow(bot, commander(bot), range, { untilMs: LOOK_MS, offset: slot(bot, role, ring, phase) });
    while (!squad.stopped) {
      const t = pick(bot, map, cap);
      if (!t) {
        await home();
        continue;
      }
      const release = take(map, t, bot);
      try {
        await fight(bot, t, home);
      } catch (e) {
        if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
        ctx.log(`${bot.username}: ${e.message}`);
        if (/no clear line of fire/.test(e.message)) await sidestep(bot, t);
        else await squad.sleep(250);
      } finally {
        release();
      }
    }
  };

  await Promise.all([
    // One shot, then the next target is picked at once (it may be another one, or the same).
    squad.parallel(squad.roles.archers, guard({ role: 'archers', ring: 6, phase: Math.PI / 8, range: 2, cap: Infinity, fight: (bot, t) => shoot(bot, t) })),
    squad.parallel(
      squad.roles.melee,
      guard({
        role: 'melee',
        ring: 3,
        phase: 0,
        range: 1.5,
        cap: PER_TARGET,
        // Broken off (the target left the circle, or the guard strayed from the commander): back to the slot first.
        fight: async (bot, t, home) => {
          const r = await attack(bot, t, { timeoutMs: 15000, leash: { center: () => commander(bot)?.position, radius } });
          if (r.brokeOff) await home();
        },
      }),
    ),
  ]);
  return 'Défense levée.';
}
