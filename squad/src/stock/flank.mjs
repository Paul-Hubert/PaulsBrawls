// Stock command: take the enemy in the flank (docs/45 §3). The target is what the commander points at (pointedTarget:
// the crosshair's creature, else the nearest one within `near` of the point). The squad goes round it at `radius`
// blocks to its `side`, measured against the way the target moves (else the way from the squad to it): `left` or
// `right` of it, or behind it (`rear`, by way of its `via` side, so the march does not cross its front). Each bot walks
// or rides to its own place in a loose line there (2 blocks apart), and once most of them are there (or `march`
// seconds passed), the squad attacks the target's group from that side: the stock `attack` as a subroutine
// (ctx.run, docs/43 C2), with `group`, `backoff`, `seconds` and `approach` (horsemen charge in waves, archers close
// in). Ends when that attack ends. Nobody there: « Aucune cible. ».
export const manifest = {
  summary: 'Flanc : contourner la cible par un côté, puis attaquer son groupe de là',
  params: {
    type: 'object',
    properties: {
      side: { type: 'string', enum: ['left', 'right', 'rear'], default: 'right', description: 'le côté de la cible à prendre (selon sa marche, sinon vu de nous)' },
      via: { type: 'string', enum: ['left', 'right'], default: 'right', description: 'pour rear : par quel côté passer' },
      radius: { type: 'integer', minimum: 8, maximum: 64, default: 24, description: 'distance à la cible du point de contournement' },
      march: { type: 'integer', minimum: 10, maximum: 120, default: 45, description: 'secondes au plus pour gagner chaque point' },
      near: { type: 'integer', minimum: 0, maximum: 16, default: 4, description: 'distance autour du point visé où chercher une cible' },
      group: { type: 'integer', minimum: 0, maximum: 32, default: 8, description: "rayon du groupe attaqué ensuite" },
      backoff: { type: 'integer', minimum: 6, maximum: 32, default: 12, description: 'recul des cavaliers entre deux charges' },
      seconds: { type: 'integer', minimum: 5, maximum: 600, default: 90, description: "durée maximale de l'attaque" },
      approach: { type: 'integer', minimum: 0, maximum: 64, default: 40, description: "un archer plus loin que cela de sa cible s'en approche" },
    },
  },
  roles: {
    all: { select: {}, take: 'reclaim' },
  },
  duration: 'bounded',
  maxMinutes: 15,
};

/** Bots within this of their place count as there; the attack starts once this share of them is. */
const THERE = 4;
const MOST = 0.7;
const LOOK_MS = 300;

export default async function (squad, args, ctx) {
  if (squad.bots.length === 0) throw new Error('no bot available for a flank');
  const side = ['left', 'right', 'rear'].includes(args.side) ? args.side : 'right';
  const via = args.via === 'left' ? 'left' : 'right';
  const radius = Number(args.radius) || 24;
  const marchMs = (Number(args.march) || 45) * 1000;
  const near = Math.max(0, Number(args.near ?? 4));

  const p = pointedTarget(squad.bots, ctx.commander.at, { near });
  if (!p.entity) return 'Aucune cible.';
  const target = anyBot(squad.bots, (b) => entityOf(b, p.entity));
  if (!target) return 'Cible hors de vue de mes bots.';

  // The reference direction: the target's march, else from the squad's centre to it.
  const centre = () => {
    const ps = squad.bots.filter((b) => b.entity).map((b) => b.entity.position);
    const c = new Vec3(0, 0, 0);
    for (const q of ps) c.add(q);
    return ps.length ? c.scaled(1 / ps.length) : target.position.clone();
  };
  const v = target.velocity;
  const moving = v && Math.hypot(v.x, v.z) > 0.05;
  const raw = moving ? new Vec3(v.x, 0, v.z) : target.position.minus(centre());
  const n = Math.hypot(raw.x, raw.z) || 1;
  const f = new Vec3(raw.x / n, 0, raw.z / n);
  // Right of one facing along f (lookDir(yaw + 90)); left is its opposite.
  const right = new Vec3(-f.z, 0, f.x);
  const sideVec = (s) => (s === 'right' ? right : right.scaled(-1));
  const at = (dir) => onGround(squad.bots, target.position.plus(dir.scaled(radius)));
  const legs = side === 'rear' ? [at(sideVec(via)), at(f)] : [at(sideVec(side))];

  /** Each bot's place at a leg's point: a loose line across the way to the target, 2 blocks apart. */
  const placesAt = (pt) => {
    const across = new Vec3(-(target.position.z - pt.z), 0, target.position.x - pt.x);
    const l = Math.hypot(across.x, across.z) || 1;
    const u = across.scaled(1 / l);
    const bots = squad.bots.filter((b) => b.entity);
    return new Map(bots.map((b, i) => [b.username, onGround(squad.bots, pt.plus(u.scaled((i - (bots.length - 1) / 2) * 2)))]));
  };

  for (const [i, pt] of legs.entries()) {
    const places = placesAt(pt);
    const goalOf = new Map();
    const t0 = Date.now();
    ctx.log(`leg ${i + 1}/${legs.length}: to ${Math.round(pt.x)} ${Math.round(pt.z)}`);
    for (;;) {
      let there = 0;
      let count = 0;
      for (const b of squad.bots) {
        if (!b.entity) continue;
        const place = places.get(b.username) ?? pt;
        count++;
        if (Math.hypot(b.entity.position.x - place.x, b.entity.position.z - place.z) <= THERE) {
          there++;
          continue;
        }
        const g = goalOf.get(b.username);
        if (!g || b.pathfinder.goal !== g) {
          const goal = new goals.GoalNear(place.x, place.y, place.z, 2);
          b.pathfinder.setGoal(goal);
          goalOf.set(b.username, goal);
        }
      }
      if (count && there >= Math.ceil(count * MOST)) break;
      if (Date.now() - t0 > marchMs) {
        ctx.log(`leg ${i + 1}: ${there}/${count} there after ${Math.round(marchMs / 1000)} s, going on`);
        break;
      }
      await squad.sleep(LOOK_MS);
    }
  }

  // From there: the stock attack on the target's group, on every bot of the squad (lent to it).
  const r = await ctx.run(
    'attack',
    { group: Number(args.group ?? 8), backoff: Number(args.backoff ?? 12), seconds: Number(args.seconds ?? 90), approach: Number(args.approach ?? 40), near },
    { bots: squad.bots },
  );
  return `Flanc ${side === 'rear' ? 'arrière' : side === 'left' ? 'gauche' : 'droit'} pris : ${r ?? 'attaque arrêtée'}`;
}
