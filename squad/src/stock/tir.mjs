// Stock command, made for a bound bow (/bots orders bind tir): the archers shoot at what the commander's arrow went
// for, from where they stand (they never move, so a line of archers keeps its formation). The target, from the click:
//   • the arrow hit a creature or a player: that one. Every archer shoots it until it is dead or gone, or `seconds`;
//   • the arrow hit the ground: a volley, `volley` arrows per archer at points spread evenly over a disc of radius
//     `spread` around where it hit;
//   • the arrow left the bow while the commander looked at a creature or a player: that one; looking at nothing,
//     the order waits up to 4 s for that arrow's hit, then takes the block they looked at, else ends (« Aucune cible. »);
//   • no arrow (`/bots order tir`, or a right-click): the creature looked at, else the block looked at.
// One of our own as the target is refused. A new click while the archers shoot retargets them. Then the order ends:
// archers it took from a `ligne-archers` go back to it, and to their slots there.
export const manifest = {
  summary: 'Tir des archers sur la cible de ma flèche',
  params: {
    type: 'object',
    properties: {
      volley: { type: 'integer', minimum: 1, maximum: 16, default: 3, description: 'flèches par archer sur un point au sol' },
      spread: { type: 'number', minimum: 0, maximum: 16, default: 3, description: 'rayon de la volée autour du point visé' },
      seconds: { type: 'integer', minimum: 1, maximum: 50, default: 8, description: 'durée maximale du tir sur une créature' },
    },
  },
  roles: { archers: { select: { hasItem: 'bow' }, min: 1, take: 'reclaim' } },
  duration: 'bounded',
  maxMinutes: 1,
};

/** How long an arrow's hit is awaited after its release, when the release said nothing about the target. */
const HIT_WAIT_MS = 4_000;
/** How often the order looks at the target (gone, out of time, every arrow fired). */
const LOOK_MS = 100;
/** An entity last seen this close to an archer and then gone is taken for dead. */
const NEAR = 24;

export default async function (squad, args, ctx) {
  // First: every later click retargets the archers (from the first target on) instead of restarting the order.
  let ready = false;
  ctx.commander.on('trigger', (at) => {
    if (ready) retarget(at);
  });
  const volley = Math.max(1, Math.min(16, Math.floor(Number(args.volley) || 3)));
  const spread = Math.max(0, Number(args.spread ?? 3));
  const seconds = Number(args.seconds) || 8;

  /** A target: kind 'entity' (ref), 'ground' (point), 'wait' (a release: its hit follows), 'refuse' (text), 'none'. */
  const target = (kind, ref = null, point = null, text = '') => ({ kind, ref, point, text, id: null, username: null, name: '' });

  /** What a click points at (see the header). */
  const fromAt = (at) => {
    const t = at.trigger;
    const entity = (ref) => (isFriend(ref) ? target('refuse', ref, null, `${ref.username ?? ref.name} est des nôtres : je ne tire pas dessus.`) : target('entity', ref));
    if (t && t.kind === 'arrow-hit') {
      if (t.hit && t.hit.entity) return entity(t.hit.entity);
      return t.hit ? target('ground', null, t.hit.position) : target('none');
    }
    if (at.lookEntity) return entity(at.lookEntity);
    if (t && t.kind === 'arrow-release') return target('wait');
    return at.lookBlock ? target('ground', null, at.lookBlock.offset(0.5, 1, 0.5)) : target('none');
  };

  /** The first answer of `fn` over the archers (one that has just left is skipped). */
  const anyArcher = (fn) => {
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

  /** The entity target as this archer sees it, by the id resolved when it was chosen (a player by name). */
  const track = (bot, t) => {
    const e = t.username ? bot.players[t.username]?.entity : bot.entities[t.id];
    return e && e.isValid !== false ? e : null;
  };

  /** What the archers shoot now; `v` bumps with each new target. `left`: arrows still to fire per archer (ground). */
  const aim = { v: 0, target: target('none'), until: 0, left: new Map(), busy: new Set(), shots: 0, near: false, done: false, end: '' };

  /** Whether an archer stands within NEAR of the entity (then its disappearance is a death, not a loss of sight). */
  const nearAnArcher = (e) => squad.bots.some((b) => b.entity && b.entity.position.distanceTo(e.position) <= NEAR);

  /** Aim at a target; false when no archer sees the entity. */
  const setTarget = (t) => {
    let near = false;
    if (t.kind === 'entity') {
      const e = anyArcher((b) => entityOf(b, t.ref));
      if (!e) return false;
      t.id = e.id;
      t.username = e.username ?? null;
      t.name = e.username ?? e.name;
      near = nearAnArcher(e);
    }
    aim.target = t;
    aim.v++;
    aim.until = Date.now() + seconds * 1000;
    aim.near = near;
    aim.left = new Map(squad.bots.map((b) => [b.username, t.kind === 'ground' ? volley : 0]));
    return true;
  };

  /** A later click: a new target (a release without one waits for its hit, which comes as the next click). */
  const retarget = (at) => {
    const t = fromAt(at);
    if (t.kind === 'refuse') ctx.say(t.text);
    else if ((t.kind === 'entity' || t.kind === 'ground') && !setTarget(t)) ctx.log(`retarget: no archer sees ${t.ref?.name ?? 'the target'}`);
  };

  /** A point of the volley: uniform over the disc around `c`, on the ground where an archer knows it. */
  const spot = (bot, c) => {
    const r = spread * Math.sqrt(Math.random());
    const a = Math.random() * 2 * Math.PI;
    const p = new Vec3(c.x + Math.cos(a) * r, c.y, c.z + Math.sin(a) * r);
    const g = groundAt(bot, p);
    return g ? new Vec3(p.x, g.y, p.z) : p;
  };

  /** One archer: shoot the target from where it stands until the order ends. */
  const fire = async (bot) => {
    while (!squad.stopped && !aim.done) {
      const t = aim.target;
      let at = null;
      if (t.kind === 'entity') at = track(bot, t);
      else if (t.kind === 'ground' && (aim.left.get(bot.username) ?? 0) > 0) {
        aim.left.set(bot.username, (aim.left.get(bot.username) ?? 0) - 1);
        at = spot(bot, t.point);
      }
      if (!at) {
        await squad.sleep(LOOK_MS);
        continue;
      }
      aim.busy.add(bot.username);
      try {
        await shoot(bot, at);
        aim.shots++;
      } catch (e) {
        if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
        ctx.log(`${bot.username}: ${e.message}`);
        if (/no arrows|no bow/.test(e.message)) aim.left.set(bot.username, 0);
        await squad.sleep(250);
      } finally {
        aim.busy.delete(bot.username);
      }
    }
  };

  // The first target.
  let first = fromAt(ctx.commander.at);
  if (first.kind === 'wait') {
    const hit = await ctx.commander.next(HIT_WAIT_MS);
    first = hit ? fromAt(hit) : first;
    if (first.kind === 'wait') {
      const b = (hit ?? ctx.commander.at).lookBlock;
      first = b ? target('ground', null, b.offset(0.5, 1, 0.5)) : target('none');
    }
  }
  if (first.kind === 'refuse') return first.text;
  if (first.kind === 'none') return 'Aucune cible.';
  if (!setTarget(first)) return 'Cible hors de vue des archers.';
  ready = true;

  const running = [];
  const launch = (bot) => running.push(squad.parallel(bot, fire).catch(() => undefined));
  squad.on('joined', (bot) => launch(bot));
  for (const bot of squad.bots) launch(bot);

  while (!aim.done) {
    await squad.sleep(LOOK_MS);
    const t = aim.target;
    if (t.kind === 'entity') {
      const seen = anyArcher((b) => track(b, t));
      if (seen) aim.near = nearAnArcher(seen);
      if (!seen) aim.end = aim.near ? `Cible abattue (${t.name})` : `Cible perdue de vue (${t.name})`;
      else if (Date.now() > aim.until) aim.end = `Cible toujours debout après ${seconds} s (${t.name})`;
    } else if (squad.bots.every((b) => (aim.left.get(b.username) ?? 0) <= 0) && aim.busy.size === 0) {
      aim.end = 'Volée tirée';
    }
    if (aim.end) aim.done = true;
  }
  await Promise.all(running);
  return `${aim.end} : ${aim.shots} flèche${aim.shots === 1 ? '' : 's'}.`;
}
