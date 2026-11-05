// The orbit (docs/47): horse archers in `attack` ride round their target's group instead of standing to shoot. A
// rider (mount.ts) walks its body and the horse follows; here the body walks forward on a free rein, its heading set
// every physics tick by `steer`: the tangent of a circle round the group's centre, turned in when the rider is
// outside it and out when inside. The archer's loop shoots as before (`shoot` finds the rein held: the horse keeps
// turning while the rider aims).
//   • Riders share one ring, all one way round, spread by lanes (R ± 4: a rider too close behind another takes the
//     outer lane, slower round, one too far behind the inner one).
//   • Jinks: short releases of the gallop at random, never late in the rider's own draw (its aim extrapolates its
//     motion), so an enemy's lead, which assumes a steady motion, misses.
//   • Terrain: the ground 4 and 8 blocks ahead is read each look; a wall, a drop, water or lava moves the rider's lane
//     (± 6), both blocked reverses it; stuck (under 0.5 blocks in 1.2 s) reverses it too.
//   • Threats: an enemy within 12, or closing faster than 7 b/s within 32: the rider breaks away from it to 24; hit by
//     an arrow: for 15 s it keeps to an arc of ±60° on the far side of the group from the shooter; under 40 % health it
//     withdraws to 64 from the group and holds there, not shooting, until 70 %.
// The geometry and the per-look decisions are pure functions (exported for the tests); orbitRing() applies them.

import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';

import { freeRein, isRiding, steer as steerHorse } from '../bots/mount';
import type { HurtBy } from '../bots/hits';
import { unwrap } from '../orders/guard';
import { isBotLeft, isStopped } from './errors';
import { foesNear } from './lance';
import { groundAt, toVec3, type PosLike } from './helpers';

/** The orbit's radius by default, and its bounds (docs/47 §2: 24 out of a charge's reach, the aim good to ~36). */
export const ORBIT_RADIUS = 30;
export const ORBIT_MIN = 16;
export const ORBIT_MAX = 48;
/** The steering's largest turn off the tangent (in or out), reached this far off the radius. */
export const ORBIT_TURN = Math.PI / 3;
export const ORBIT_SOFT = 8;
/** A spacing lane is this far off the radius; a terrain shift this far. */
export const ORBIT_LANE = 4;
export const ORBIT_SHIFT = 6;
/** The ground is probed this far ahead. */
export const ORBIT_PROBE = [4, 8] as const;
/** A rider shoots at a foe within the radius plus this (farther: still riding in). */
export const ORBIT_SHOOT_SLACK = 12;
/** Threats: an enemy this near breaks the rider away, out to ORBIT_CLEAR; or one closing faster than this (b/s) within ORBIT_WATCH. */
export const ORBIT_NEAR = 12;
export const ORBIT_CLEAR = 24;
export const ORBIT_CLOSING = 7;
export const ORBIT_WATCH = 32;
/** A break-away lasts this long at most. */
export const ORBIT_BREAK_MS = 4_000;
/** Hit by an arrow: the arc on the far side, this long, ± this angle. */
export const ORBIT_ARC_MS = 15_000;
export const ORBIT_ARC_HALF = Math.PI / 3;
/** Health fractions: withdraw under the first, back at the second; how far it withdraws from the group. */
export const ORBIT_LOW_HP = 0.4;
export const ORBIT_HEALED_HP = 0.7;
export const ORBIT_WITHDRAW = 64;
/** Stuck: under this many blocks in this long while galloping. */
export const ORBIT_STUCK_MS = 1_200;
const ORBIT_STUCK_MOVE = 0.5;
/** A reversal is not followed by another for this long (no flapping on a wall's end). */
const REVERSE_MS = 2_000;
/** A terrain shift returns to the lane after the way there has been clear this long. */
const SHIFT_HOLD_MS = 3_000;
/** Jinks: the gallop let go for 3–5 ticks, every 20–40 ticks, and a pulse ends by this tick of the rider's draw. */
export const JINK_TICKS = [3, 5] as const;
export const JINK_EVERY = [20, 40] as const;
export const JINK_LAST_DRAW_TICK = 15;
const MAX_HEALTH = 20;
const TWO_PI = 2 * Math.PI;

type XZ = { x: number; z: number };
const flat = (a: XZ, b: XZ): number => Math.hypot(a.x - b.x, a.z - b.z);
/** An angle into (−π, π]. */
export const wrapAngle = (a: number): number => {
  const w = ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
  return w === -Math.PI ? Math.PI : w;
};
/** Mineflayer's yaw (0 toward −Z, π/2 toward −X) that walks along the unit vector h. */
export const yawAlong = (h: XZ): number => Math.atan2(-h.x, -h.z);
/** The angle of p round c (atan2 of z over x): dir +1 goes round with it rising. */
export const angleRound = (p: XZ, c: XZ): number => Math.atan2(p.z - c.z, p.x - c.x);

/**
 * The heading (a unit vector) of a rider at `p` on the circle of radius `radius` round `c`, going round `dir` (+1: its
 * angle rising): the tangent, turned toward the centre by the smaller of the tangent point's angle (joining from far
 * off, it rides at the point where its way meets the circle) and ORBIT_TURN × (r − R) / ORBIT_SOFT; inside the circle,
 * out by ORBIT_TURN × (R − r) / ORBIT_SOFT, at most. At the centre itself: straight out along +x.
 */
export function orbitHeading(p: XZ, c: XZ, radius: number, dir: 1 | -1): XZ & { r: number } {
  const dx = c.x - p.x;
  const dz = c.z - p.z;
  const r = Math.hypot(dx, dz);
  if (r < 1e-6) return { x: 1, z: 0, r };
  const u = { x: dx / r, z: dz / r }; // toward the centre
  const t = { x: dir * u.z, z: -dir * u.x }; // along the circle
  let inward: number;
  if (r >= radius) inward = Math.min(Math.PI / 2 - Math.asin(Math.min(1, radius / r)), ORBIT_TURN * Math.min(1, (r - radius) / ORBIT_SOFT));
  else inward = -ORBIT_TURN * Math.min(1, (radius - r) / ORBIT_SOFT);
  const cs = Math.cos(inward);
  const sn = Math.sin(inward);
  return { x: t.x * cs + u.x * sn, z: t.z * cs + u.z * sn, r };
}

/**
 * The spacing lanes of riders round one ring (their angles round the centre, going `dir`): each rider's gap to the one
 * ahead against an even share; under half of it: the outer lane (+1, slower round); over one and a half: the inner (−1).
 */
export function orbitLanes(angles: number[], dir: 1 | -1): number[] {
  const n = angles.length;
  if (n < 2) return angles.map(() => 0);
  const share = TWO_PI / n;
  const order = angles.map((a, i) => ({ a: ((dir * a) % TWO_PI + TWO_PI) % TWO_PI, i })).sort((x, y) => x.a - y.a);
  const lanes = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    const me = order[k]!;
    const ahead = order[(k + 1) % n]!;
    const gap = k + 1 < n ? ahead.a - me.a : ahead.a + TWO_PI - me.a;
    lanes[me.i] = gap < share * 0.5 ? 1 : gap > share * 1.5 ? -1 : 0;
  }
  return lanes;
}

/**
 * The way round on an arc of ±`half` centred on the angle `far`: outside it, toward it the short way; at an end,
 * back; else as it goes.
 */
export function arcTurn(angle: number, far: number, half: number, dir: 1 | -1): 1 | -1 {
  const off = wrapAngle(angle - far);
  if (Math.abs(off) > half + 0.2) return off > 0 ? -1 : 1;
  if (off >= half && dir === 1) return -1;
  if (off <= -half && dir === -1) return 1;
  return dir;
}

/** One foe as the threat check sees it: where, and how fast it closes on the rider (b/s; ≤ 0: not closing). */
export interface OrbitFoe {
  id: number;
  position: XZ;
  closing: number;
}

/** What a rider does this look. */
export type OrbitMode = { kind: 'withdraw' } | { kind: 'break'; from: XZ; id: number } | { kind: 'arc'; far: number } | { kind: 'circle' };

/**
 * The rider's mode this look: withdrawn while its health is under ORBIT_LOW_HP (and until ORBIT_HEALED_HP); away from
 * an enemy within ORBIT_NEAR, or closing faster than ORBIT_CLOSING within ORBIT_WATCH (the nearest such), until it is
 * ORBIT_CLEAR away (`breaking` carries a break that is on); an arc on the far side from an arrow's shooter for
 * ORBIT_ARC_MS after its hit; else the circle.
 */
export function orbitMode(s: {
  pos: XZ;
  center: XZ;
  health: number;
  withdrawn: boolean;
  foes: OrbitFoe[];
  breaking: { id: number; since: number } | null;
  hit: { from: XZ; at: number } | null;
  now: number;
}): OrbitMode {
  const hp = s.health / MAX_HEALTH;
  if (hp < ORBIT_LOW_HP || (s.withdrawn && hp < ORBIT_HEALED_HP)) return { kind: 'withdraw' };
  if (s.breaking && s.now - s.breaking.since < ORBIT_BREAK_MS) {
    const f = s.foes.find((x) => x.id === s.breaking!.id);
    if (f && flat(f.position, s.pos) < ORBIT_CLEAR) return { kind: 'break', from: f.position, id: f.id };
  }
  let worst: OrbitFoe | null = null;
  let worstD = Infinity;
  for (const f of s.foes) {
    const d = flat(f.position, s.pos);
    if ((d <= ORBIT_NEAR || (d <= ORBIT_WATCH && f.closing > ORBIT_CLOSING)) && d < worstD) [worst, worstD] = [f, d];
  }
  if (worst) return { kind: 'break', from: worst.position, id: worst.id };
  if (s.hit && s.now - s.hit.at < ORBIT_ARC_MS) {
    const dx = s.center.x - s.hit.from.x;
    const dz = s.center.z - s.hit.from.z;
    // The far side of the group from the shooter (a shooter on the centre: the side the rider is on).
    const far = Math.hypot(dx, dz) > 1 ? Math.atan2(dz, dx) : angleRound(s.pos, s.center);
    return { kind: 'arc', far };
  }
  return { kind: 'circle' };
}

/**
 * Whether a jink may start now, `len` ticks long: always while the bow is down; drawn for `drawTicks`, only if it ends
 * by JINK_LAST_DRAW_TICK (the aim's last answers read a steady motion).
 */
export function jinkMayStart(using: boolean, drawTicks: number, len: number): boolean {
  return !using || drawTicks + len <= JINK_LAST_DRAW_TICK;
}

/** Whether this bot circles in `attack`: it rides a horse (mount.ts) and has a bow. */
export function canOrbit(bot: Bot): boolean {
  if (!bot.entity || !isRiding(bot)) return false;
  if (bot.heldItem?.name === 'bow') return true;
  return bot.inventory.items().some((i) => i.name === 'bow');
}

/** One rider's state in the ring. */
interface Rider {
  bot: Bot;
  real: Bot;
  rein: () => void;
  tick: () => void;
  onHurt: (h: HurtBy) => void;
  dir: 1 | -1;
  lane: number;
  shift: number;
  shiftClearSince: number;
  reversedAt: number;
  mode: OrbitMode;
  breaking: { id: number; since: number } | null;
  hit: { from: XZ; at: number } | null;
  withdrawn: boolean;
  holding: boolean;
  mark: XZ;
  markAt: number;
  lastAngle: number | null;
  turned: number;
  drawTicks: number;
  jinkLeft: number;
  nextJink: number;
}

/** A ring of horse archers (orbitRing). */
export interface OrbitRing {
  /** Every look of the order (~200 ms): the riders that circle (canOrbit) and the centre (the group's, else the point). */
  step(riders: Bot[], center: Vec3 | null): void;
  /** Whether this rider shoots now (not withdrawn, on the ring). */
  canShoot(bot: Bot): boolean;
  /** Whether `at` is within the radius + ORBIT_SHOOT_SLACK of this rider (farther: it is still riding in). */
  inRange(bot: Bot, at: PosLike | null | undefined): boolean;
  /** This rider's mode now ('idle': not in the ring). */
  modeOf(bot: Bot): OrbitMode['kind'] | 'idle';
  /** Every rider out of the ring: the ticks stopped, the gallop and the rein let go. */
  stop(): void;
  /** Laps ridden (all riders), break-aways, reversals (terrain, stuck). */
  readonly laps: number;
  readonly breaks: number;
  readonly reversals: number;
}

/**
 * THE RING OF HORSE ARCHERS (docs/47), the stock `attack`'s orbit: each rider rides round `center` at `radius`
 * (default 30), all the same way, spread by lanes, jinking (`jink`, default on), keeping off walls, water and drops,
 * breaking away from what comes near, keeping to the far side from an archer that hit it, withdrawing when hurt. Call
 * step(riders, center) every look of the order and stop() when it ends (also on an error: in a finally).
 */
export function orbitRing(opts: { radius?: number; jink?: boolean; log?: (line: string) => void; random?: () => number } = {}): OrbitRing {
  const radius = Math.max(ORBIT_MIN, Math.min(ORBIT_MAX, Number(opts.radius ?? ORBIT_RADIUS)));
  const jink = opts.jink !== false;
  const random = opts.random ?? Math.random;
  const riders = new Map<string, Rider>();
  /** Where each foe was (by id), for its closing speed. */
  const seen = new Map<number, { x: number; z: number; t: number }>();
  let center: Vec3 | null = null;
  let turnedOff = 0;
  let breaks = 0;
  let reversals = 0;
  const between = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));

  const radiusOf = (r: Rider): number => Math.max(ORBIT_MIN, Math.min(ORBIT_MAX, radius + r.lane * ORBIT_LANE + r.shift));
  /** The heading of this rider now, by its mode. */
  const headingOf = (r: Rider, p: XZ, c: XZ, rad = radiusOf(r), dir = r.dir): XZ => {
    const m = r.mode;
    if (m.kind === 'withdraw' || m.kind === 'break') {
      const from = m.kind === 'break' ? m.from : c;
      const d = flat(p, from);
      return d > 1e-6 ? { x: (p.x - from.x) / d, z: (p.z - from.z) / d } : { x: 1, z: 0 };
    }
    return orbitHeading(p, c, rad, dir);
  };

  const steerTick = (r: Rider): void => {
    const c = center;
    const e = r.real.entity;
    if (!c || !e?.position) return;
    const p = e.position;
    const h = headingOf(r, p, c);
    steerHorse(r.real, yawAlong(h), true);
    // Laps: the angle turned round the centre while on the ring.
    const a = angleRound(p, c);
    if (r.lastAngle !== null && (r.mode.kind === 'circle' || r.mode.kind === 'arc') && flat(p, c) <= radius + ORBIT_SOFT * 2) r.turned += Math.abs(wrapAngle(a - r.lastAngle));
    r.lastAngle = a;
    // The draw's tick (jinks stay out of its end).
    const using = !!(r.real as unknown as { usingHeldItem?: boolean }).usingHeldItem;
    r.drawTicks = using ? r.drawTicks + 1 : 0;
    let gallop = !r.holding;
    if (jink && gallop && (r.mode.kind === 'circle' || r.mode.kind === 'arc')) {
      if (r.jinkLeft > 0) {
        r.jinkLeft--;
        gallop = false;
      } else if (--r.nextJink <= 0) {
        const len = between(JINK_TICKS[0], JINK_TICKS[1]);
        if (jinkMayStart(using, r.drawTicks, len)) {
          r.jinkLeft = len - 1;
          r.nextJink = between(JINK_EVERY[0], JINK_EVERY[1]);
          gallop = false;
        }
      }
    }
    r.bot.setControlState('forward', gallop);
    r.bot.setControlState('sprint', gallop);
    r.bot.setControlState('jump', gallop && !!(e as { isCollidedHorizontally?: boolean }).isCollidedHorizontally && e.onGround !== false);
  };

  const join = (bot: Bot): Rider => {
    const real = unwrap(bot);
    const p = real.entity.position;
    const r: Rider = {
      bot,
      real,
      rein: () => undefined,
      tick: () => undefined,
      onHurt: () => undefined,
      dir: 1,
      lane: 0,
      shift: 0,
      shiftClearSince: 0,
      reversedAt: 0,
      mode: { kind: 'circle' },
      breaking: null,
      hit: null,
      withdrawn: false,
      holding: false,
      mark: { x: p.x, z: p.z },
      markAt: Date.now(),
      lastAngle: null,
      turned: 0,
      drawTicks: 0,
      jinkLeft: 0,
      nextJink: between(JINK_EVERY[0], JINK_EVERY[1]),
    };
    r.tick = () => steerTick(r);
    r.onHurt = (h: HurtBy) => {
      if (h.kind === 'arrow' && h.from) r.hit = { from: { x: h.from.x, z: h.from.z }, at: Date.now() };
    };
    if (bot.pathfinder?.goal) bot.pathfinder.setGoal(null);
    r.rein = freeRein(real);
    bot.on('physicsTick', r.tick);
    bot.on('hurtBy' as never, r.onHurt as never);
    riders.set(bot.username, r);
    return r;
  };

  const leave = (r: Rider): void => {
    turnedOff += r.turned;
    riders.delete(r.bot.username);
    try {
      r.bot.removeListener('physicsTick', r.tick);
      r.bot.removeListener('hurtBy' as never, r.onHurt as never);
    } catch {
      /* the order is over: it removed its listeners itself */
    }
    r.rein();
    try {
      r.bot.setControlState('forward', false);
      r.bot.setControlState('sprint', false);
      r.bot.setControlState('jump', false);
    } catch (e) {
      if (!isBotLeft(e) && !isStopped(e)) throw e;
    }
  };

  const reverse = (r: Rider, now: number, why: string): void => {
    if (now - r.reversedAt < REVERSE_MS) return;
    r.dir = r.dir === 1 ? -1 : 1;
    r.reversedAt = now;
    reversals++;
    opts.log?.(`${r.bot.username}: orbit reversed (${why}) at ${r.real.entity.position.floored()}`);
  };

  /** Whether the ground along heading h is clear (a horse can gallop there): ORBIT_PROBE ahead, at the rider's level. */
  const clearAhead = (r: Rider, p: Vec3, h: XZ): boolean => {
    let y = p.y;
    for (const d of ORBIT_PROBE) {
      const q = new Vec3(p.x + h.x * d, y, p.z + h.z * d);
      const block = r.real.blockAt(q.floored()) as { name?: string } | null;
      if (block === null) return true; // unknown: not judged
      if (block.name === 'water' || block.name === 'lava') return false;
      const g = groundAt(r.real, q, { up: 1, down: 3 });
      if (!g) return false;
      const under = r.real.blockAt(g.offset(0, 0, 0).floored()) as { name?: string } | null;
      if (under?.name === 'water' || under?.name === 'lava') return false;
      y = g.y;
    }
    return true;
  };

  return {
    get laps() {
      let t = turnedOff;
      for (const r of riders.values()) t += r.turned;
      return Math.floor(t / TWO_PI);
    },
    get breaks() {
      return breaks;
    },
    get reversals() {
      return reversals;
    },
    step(list, c) {
      if (c) center = c.clone();
      const now = Date.now();
      const names = new Set(list.filter((b) => b.entity).map((b) => b.username));
      for (const r of [...riders.values()]) if (!names.has(r.bot.username)) leave(r);
      if (!center) return;
      const ring: Rider[] = [];
      for (const bot of list) {
        if (!bot.entity) continue;
        const r = riders.get(bot.username) ?? join(bot);
        const p = r.real.entity.position;
        // The foes near it, with how fast each closes on it.
        const foes: OrbitFoe[] = [];
        for (const e of foesNear(r.real, ORBIT_WATCH)) {
          const id = (e as Entity & { id: number }).id;
          const prev = seen.get(id);
          const d = flat(e.position, p);
          let closing = 0;
          if (prev && now - prev.t >= 150) closing = ((flat(prev, p) - d) * 1000) / (now - prev.t);
          if (!prev || now - prev.t >= 150) seen.set(id, { x: e.position.x, z: e.position.z, t: now });
          foes.push({ id, position: e.position, closing });
        }
        const before = r.mode.kind;
        r.mode = orbitMode({ pos: p, center, health: r.real.health ?? MAX_HEALTH, withdrawn: r.withdrawn, foes, breaking: r.breaking, hit: r.hit, now });
        if (r.mode.kind === 'break') {
          if (before !== 'break' || r.breaking?.id !== r.mode.id) {
            r.breaking = { id: r.mode.id, since: now };
            breaks++;
          }
        } else r.breaking = null;
        r.withdrawn = r.mode.kind === 'withdraw';
        r.holding = r.withdrawn && flat(p, center) >= ORBIT_WITHDRAW;
        if (r.mode.kind === 'arc') r.dir = arcTurn(angleRound(p, center), r.mode.far, ORBIT_ARC_HALF, r.dir);
        if (r.mode.kind === 'circle' && r.dir === 1) ring.push(r);
        if (r.mode.kind !== 'circle') r.lane = 0;
        // The ground ahead: the lane as it is, else shifted out, else in; none: the way back.
        if (r.mode.kind === 'circle' || r.mode.kind === 'arc') {
          const base = radius + r.lane * ORBIT_LANE;
          const plain = clearAhead(r, p, orbitHeading(p, center, base, r.dir));
          if (r.shift !== 0) {
            if (!plain) r.shiftClearSince = 0;
            else if (!r.shiftClearSince) r.shiftClearSince = now;
            else if (now - r.shiftClearSince >= SHIFT_HOLD_MS) r.shift = 0;
          }
          if (!clearAhead(r, p, orbitHeading(p, center, radiusOf(r), r.dir))) {
            const alt = [ORBIT_SHIFT, -ORBIT_SHIFT].find((s) => s !== r.shift && clearAhead(r, p, orbitHeading(p, center!, base + s, r.dir)));
            if (alt !== undefined) {
              r.shift = alt;
              r.shiftClearSince = 0;
            } else reverse(r, now, 'blocked');
          }
        }
        // Stuck while galloping.
        if (now - r.markAt >= ORBIT_STUCK_MS) {
          if (!r.holding && flat(p, r.mark) < ORBIT_STUCK_MOVE) reverse(r, now, 'stuck');
          r.mark = { x: p.x, z: p.z };
          r.markAt = now;
        }
      }
      // Spacing among those going the ring's way round.
      const lanes = orbitLanes(ring.map((r) => angleRound(r.real.entity.position, center!)), 1);
      ring.forEach((r, i) => (r.lane = lanes[i]!));
      if (seen.size > 256) for (const [id, s] of seen) if (now - s.t > 5_000) seen.delete(id);
    },
    canShoot(bot) {
      const r = riders.get(bot.username);
      return !r || r.mode.kind !== 'withdraw';
    },
    inRange(bot, at) {
      if (!at) return false;
      const q = toVec3(at, `orbit inRange(${bot.username})`);
      return flat(bot.entity.position, q) <= radius + ORBIT_SHOOT_SLACK;
    },
    modeOf(bot) {
      return riders.get(bot.username)?.mode.kind ?? 'idle';
    },
    stop() {
      for (const r of [...riders.values()]) leave(r);
    },
  };
}

/** The orbit helpers by name (scope globals). */
export const ORBIT_HELPERS = {
  canOrbit,
  orbitRing,
} as const;
