// The lance (docs/44): how a mounted bot with a spear hits. A spear does not hit like a sword: 26.x gives it an attack
// range of 2–4.5 blocks from the eyes (its `attack_range` component), so a target nearer than 2 blocks is out of reach,
// and mineflayer-pvp, which closes in to 2 blocks and swings from there, missed (found live: horsemen « miss range »).
// Its real blow is the charge (its `kinetic_weapon` component): while its holder keeps using it (right button held),
// the server hits every creature within that range along the holder's look, each server tick, for damage that grows
// with the speed between them. So a lancer holds the spear's use and rides at speed through its foe, looking at it
// until it is within the near reach, then on along its heading to a point beyond, and lets go there.
//
// Unverified live (docs/44 §5): the spears' exact numbers (range, the use's delay, how long the charge lasts, the
// minimum speeds), and the server's speed for a ridden horse moved by vehicle_move (mount.ts).

import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';

import { freeRein, isRiding, steer as steerHorse } from '../bots/mount';
import { checkLease, unwrap } from '../orders/guard';
import { HelperError, isBotLeft, isStopped } from './errors';
import { assignSlots, isEnemy, onGround } from './formation';
import { isHostile, lookDir, toVec3, type PosLike } from './helpers';

const { goals } = pathfinderPkg;

/** A spear's item name (wooden_spear … netherite_spear, 26.x). */
export const SPEAR = /_spear$/;
/** A spear's reach from the eyes (26.x `attack_range`): nearer than the first, or beyond the second, is not hit. */
export const SPEAR_MIN_REACH = 2;
export const SPEAR_MAX_REACH = 4.5;
/** A lance steers onto its foe only while the foe is within this angle (radians) of the way to its run-out point. */
export const LANCE_CONE = Math.PI / 3;
/** The pass ends this close (horizontally) to its run-out point, or once past it. */
export const LANCE_ARRIVE = 1.5;
/** A pass that moved less than LANCE_STUCK_MOVE blocks in this long is stuck (a wall, a crowd): it ends. */
export const LANCE_STUCK_MS = 1_200;
const LANCE_STUCK_MOVE = 0.5;
/** A pass ends after this long by default. */
export const LANCE_TIMEOUT_MS = 8_000;
/** A hurt creature counts as struck by this lancer when it was this close to it (the reach, plus a tick's ride). */
const STRUCK_RANGE = SPEAR_MAX_REACH + 1.5;

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const who = (bot: Bot): string => bot.username ?? '?';
const fmt = (v: { x: number; y: number; z: number }): string => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
type Body = Entity & { eyeHeight?: number; onGround?: boolean; isCollidedHorizontally?: boolean };

/** The bot's spear: the one in hand, else the first in its inventory, else null. */
export function spearOf(bot: Bot): { name: string } | null {
  const h = bot.heldItem as { name: string } | null;
  if (h && SPEAR.test(h.name)) return h;
  return (bot.inventory.items().find((i) => SPEAR.test(i.name)) as { name: string } | undefined) ?? null;
}

/** Whether this bot charges with a lance: it rides a horse (mount.ts) and has a spear. */
export function canLance(bot: Bot): boolean {
  return !!bot.entity && isRiding(bot) && !!spearOf(bot);
}

/**
 * Every threat within `range` of `from` (default the bot): hostile mobs and enemy players (nearestFoe's kinds), passing
 * `filter`, nearest first.
 */
export function foesNear(bot: Bot, range = 16, opts: { from?: PosLike | null; filter?: (e: Entity) => boolean } = {}): Entity[] {
  const from = opts.from ? toVec3(opts.from, 'foesNear from') : bot.entity.position;
  const ok = opts.filter ?? (() => true);
  const out: Array<[number, Entity]> = [];
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || e.isValid === false) continue;
    const d = e.position.distanceTo(from);
    if (d > range) continue;
    let fits = false;
    try {
      fits = (isHostile(bot, e) || isEnemy(bot, e)) && !!ok(e);
    } catch {
      fits = false;
    }
    if (fits) out.push([d, e]);
  }
  return out.sort((a, b) => a[0] - b[0]).map(([, e]) => e);
}

/** What `lance` answers. */
export interface LanceResult {
  /** Reached its run-out point (or rode past it). */
  passed: boolean;
  /** Creatures seen hurt within the spear's reach of this lancer during the pass (the server's hits, as far as seen). */
  struck: number;
  /** Why it ended. */
  why: 'passed' | 'until' | 'stuck' | 'timeout';
}

/**
 * ONE LANCE PASS (a mounted bot with a spear, canLance): the spear in hand and its use held (the charge), the bot
 * rides at full speed toward `through`, the run-out point beyond its foes, on a free rein (mount.ts): while `foe()` is
 * ahead (within LANCE_CONE of the way) it looks at the foe's body, so the charge's reach meets it, and rides onto it
 * until it is within the near reach (SPEAR_MIN_REACH); otherwise it rides, and looks, straight at `through`. It ends there (passed), when `until()`
 * returns true, when it is stuck (less than 0.5 blocks in 1.2 s) or after `timeoutMs` (default 8 s). On every exit it
 * lets go of the use and the controls. The pathfinder's goal is cleared first (the pass steers). A bot that left
 * throws BotLeftError.
 */
export async function lance(
  bot: Bot,
  through: PosLike,
  opts: { foe?: () => Entity | null | undefined; until?: () => boolean; timeoutMs?: number } = {},
): Promise<LanceResult> {
  checkLease(bot);
  const label = `lance(${who(bot)})`;
  const to = toVec3(through, `${label} through`);
  const timeoutMs = Number(opts.timeoutMs ?? LANCE_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new HelperError(`${label}: timeoutMs must be a number of milliseconds ≥ 0, got ${String(opts.timeoutMs)}`);
  const spear = spearOf(bot);
  if (!spear) throw new HelperError(`${label}: no spear (an item named *_spear) in hand or inventory`);
  if (!isRiding(bot)) throw new HelperError(`${label}: not riding a horse`);
  const until = opts.until ?? (() => false);
  const start = bot.entity.position.clone();
  const way0 = new Vec3(to.x - start.x, 0, to.z - start.z);
  if (Math.hypot(way0.x, way0.z) < 1e-6) return { passed: true, struck: 0, why: 'passed' };

  const real = unwrap(bot);
  let passed = false;
  const hurt = new Set<number>();
  const onHurt = (e: Entity): void => {
    if (!e?.position || e === bot.entity) return;
    if (e.position.distanceTo(bot.entity.position) <= STRUCK_RANGE) hurt.add((e as { id: number }).id);
  };
  const steer = (): void => {
    const e = bot.entity as Body;
    const p = e.position;
    const wx = to.x - p.x;
    const wz = to.z - p.z;
    const wd = Math.hypot(wx, wz);
    if (wd <= LANCE_ARRIVE || wx * way0.x + wz * way0.z <= 0) {
      passed = true;
      return;
    }
    const eyes = p.y + (e.eyeHeight ?? 1.62);
    // The heading (the horse's, on the free rein) and the look (the spear's: the charge hits along it).
    let heading = Math.atan2(-wx, -wz); // mineflayer's yaw for that direction
    let look = heading;
    let pitch = 0;
    const f = opts.foe?.();
    if (f && f.isValid !== false && f.position) {
      const fx = f.position.x - p.x;
      const fz = f.position.z - p.z;
      const fd = Math.hypot(fx, fz);
      const cos = fd > 0 ? (fx * wx + fz * wz) / (fd * wd) : -1;
      if (cos >= Math.cos(LANCE_CONE)) {
        // Ahead: the spear on its body, and onto it until it is within the near reach.
        look = Math.atan2(-fx, -fz);
        const body = f.position.y + ((f as { height?: number }).height ?? 1.8) * 0.5;
        pitch = Math.atan2(body - eyes, fd);
        if (fd > SPEAR_MIN_REACH * 0.75) heading = look;
      }
    }
    steerHorse(real, heading, true);
    bot.look(look, pitch, true).catch(() => undefined);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    bot.setControlState('jump', !!e.isCollidedHorizontally && e.onGround !== false);
  };

  let why: LanceResult['why'] = 'timeout';
  // A free rein (mount.ts): the horse keeps the heading, the rider looks where the spear goes.
  const release = freeRein(real);
  try {
    if (bot.pathfinder?.goal) bot.pathfinder.setGoal(null);
    if (bot.heldItem?.name !== spear.name) await bot.equip(spear as never, 'hand');
    bot.activateItem();
    bot.on('physicsTick', steer);
    bot.on('entityHurt', onHurt);
    const end = Date.now() + timeoutMs;
    let mark = bot.entity.position.clone();
    let markAt = Date.now();
    for (;;) {
      if (passed) {
        why = 'passed';
        break;
      }
      if (until()) {
        why = 'until';
        break;
      }
      const now = Date.now();
      if (now >= end) break;
      if (now - markAt >= LANCE_STUCK_MS) {
        const p = bot.entity.position;
        if (Math.hypot(p.x - mark.x, p.z - mark.z) < LANCE_STUCK_MOVE) {
          why = 'stuck';
          break;
        }
        mark = p.clone();
        markAt = now;
      }
      await sleepMs(50);
      checkLease(bot);
    }
  } catch (e) {
    if (isBotLeft(e) || isStopped(e)) throw e;
    throw new HelperError(`${label}: ${(e as Error).message} riding from ${fmt(start)} to ${fmt(to)}`);
  } finally {
    bot.removeListener('physicsTick', steer);
    release();
    bot.removeListener('entityHurt', onHurt);
    try {
      bot.deactivateItem();
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      bot.setControlState('jump', false);
    } catch {
      /* best-effort: a bot that left had its controls cleared by the abort sequence */
    }
  }
  return { passed: why === 'passed', struck: hurt.size, why };
}

// -- waves of horsemen (docs/44): the stock `attack`'s charges, as one planner -------------------------------------

/** Waves: a first charge starts from where the riders stand when the group is within backoff + this. */
export const CHARGE_FROM = 20;
/** Waves: a wave's charge ends after this long at most, its forming up too. */
export const CHARGE_MS = 9_000;
export const FORM_MS = 8_000;
/** Waves: on its place in the formation within this (a horse is 1.4 wide). */
export const FORMED = 2.5;
/** Waves: at least this far apart across the charge (2 horses side by side). */
export const LANE = 2;

/**
 * One rider's look in the waves: it charged (one lance pass), rides to its place in the formation, waits for the
 * others (its pass is done, or it has no place), or the waves are idle (no group: the command decides).
 */
export type WaveLook = 'charged' | 'forming' | 'waiting' | 'idle';

/** Waves of horsemen with spears (lanceWaves). */
export interface LanceWaves {
  /** Every look of the order (~200 ms): `riders` (canLance) and the foes of the group now, nearest its centre first. */
  step(riders: Bot[], foes: Entity[]): void;
  /** A new decision (a new target): the next step starts as the order's first. */
  reset(): void;
  /** One look of one rider: its pass of this wave, else a ride to its place in the formation. */
  ride(bot: Bot, opts: { foe: (lane: { id: number; username: string | null } | undefined, center: Vec3) => Entity | null | undefined; until?: () => boolean; log?: (line: string) => void }): Promise<WaveLook>;
  /** Passes ridden, creatures seen struck. */
  readonly passes: number;
  readonly struck: number;
}

const flatUnit = (v: Vec3): Vec3 | null => {
  const d = Math.hypot(v.x, v.z);
  return d > 1e-6 ? new Vec3(v.x / d, 0, v.z / d) : null;
};
/** The Minecraft yaw (degrees) that looks along the unit vector f (lookDir's inverse). */
const yawOf = (f: Vec3): number => (Math.atan2(-f.x, f.z) * 180) / Math.PI;
/** The right hand of one facing along f (lookDir(yaw + 90)). */
const rightOf = (f: Vec3): Vec3 => new Vec3(-f.z, 0, f.x);
const centroid = (ps: Vec3[]): Vec3 => {
  const c = new Vec3(0, 0, 0);
  for (const p of ps) c.add(p);
  return ps.length ? c.scaled(1 / ps.length) : c;
};
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * WAVES OF HORSEMEN WITH SPEARS (docs/44), the stock `attack`'s charges: in the formation the riders stood in when the
 * waves took them (their places across and along the axis of the charge), together, each at the foe of the group
 * nearest its lane, through it at full speed (lance), out `backoff` blocks beyond the group; there they re-form the
 * same shape facing back, and charge again, while the group lasts. Far from it (more than backoff + 20), they first
 * form up `backoff` short of it. `ground` gives the bots that know the ground (onGround); `view` the yaw (degrees) to
 * charge along when the riders stand on top of the group with no wave before. Call step() every look of the order
 * and ride() in each rider's loop.
 */
export function lanceWaves(opts: { backoff?: number; ground: () => Bot[]; view?: () => number }): LanceWaves {
  const backoff = Math.max(6, Number(opts.backoff ?? 12));
  type Place = { lat: number; rear: number };
  type Lane = { id: number; username: string | null };
  const cav = {
    wave: 0,
    phase: 'idle' as 'idle' | 'form' | 'charge',
    first: true,
    since: 0,
    axis: null as Vec3 | null,
    center: null as Vec3 | null,
    shape: null as Map<string, Place> | null,
    slots: new Map<string, Vec3>(),
    through: new Map<string, Vec3>(),
    lanes: new Map<string, Lane>(),
    done: new Set<string>(),
    passes: 0,
    struck: 0,
  };
  /** The goal each rider was given toward its place (set once, not awaited). */
  const heading = new WeakMap<object, { slot: Vec3; goal: unknown }>();
  const pos = (b: Bot): Vec3 => b.entity.position;

  /** The formation the riders stand in now, about their centre `c`, facing along `f`; lanes at least LANE apart per rank. */
  const shapeOf = (list: Bot[], f: Vec3, c: Vec3): Map<string, Place> => {
    const r = rightOf(f);
    const raw = list.map((b) => {
      const d = pos(b).minus(c);
      return { name: b.username, lat: d.x * r.x + d.z * r.z, depth: d.x * f.x + d.z * f.z };
    });
    const front = Math.max(...raw.map((o) => o.depth));
    const out = new Map<string, Place>();
    const ranks = new Map<number, Array<Place & { name: string }>>();
    for (const o of raw) {
      const k = Math.round(Math.min(8, Math.max(0, front - o.depth)) / FORMED);
      if (!ranks.has(k)) ranks.set(k, []);
      ranks.get(k)!.push({ name: o.name, lat: Math.max(-16, Math.min(16, o.lat)), rear: k * FORMED });
    }
    for (const rank of ranks.values()) {
      rank.sort((a, b) => a.lat - b.lat);
      for (let i = 1; i < rank.length; i++) rank[i]!.lat = Math.max(rank[i]!.lat, rank[i - 1]!.lat + LANE);
      const mid = (rank[0]!.lat + rank[rank.length - 1]!.lat) / 2;
      for (const o of rank) out.set(o.name, { lat: o.lat - mid, rear: o.rear });
    }
    return out;
  };
  /** Every rider's place in the shape (one that came later: at the end of the front rank). */
  const placesOf = (list: Bot[]): Place[] => {
    const shape = cav.shape!;
    let edge = Math.max(0, ...[...shape.values()].map((o) => o.lat));
    return list.map((b) => {
      let o = shape.get(b.username);
      if (!o) shape.set(b.username, (o = { lat: (edge += LANE), rear: 0 }));
      return o;
    });
  };
  /** The axis from the riders to the group (on top of each other: the last wave's, turned back; else the view). */
  const axisTo = (list: Bot[], center: Vec3): Vec3 =>
    flatUnit(center.minus(centroid(list.map(pos)))) ?? (cav.axis ? cav.axis.scaled(-1) : lookDir(opts.view?.() ?? 0));
  const begin = (list: Bot[], center: Vec3): { f: Vec3; r: Vec3 } => {
    const f = axisTo(list, center);
    if (!cav.shape) cav.shape = shapeOf(list, f, centroid(list.map(pos)));
    return { f, r: rightOf(f) };
  };

  /** Form up `backoff` short of the group, in the shape, facing it. */
  const startForm = (list: Bot[], center: Vec3): void => {
    const { f, r } = begin(list, center);
    const slots = placesOf(list).map((o) => onGround(opts.ground(), center.offset(-f.x * (backoff + o.rear) + r.x * o.lat, 0, -f.z * (backoff + o.rear) + r.z * o.lat)));
    Object.assign(cav, { phase: 'form', since: Date.now(), axis: f, center, slots: assignSlots(list, slots, yawOf(f)), wave: cav.wave + 1 });
    cav.done.clear();
  };
  /** Charge: each rider through the group to `backoff` beyond it, at the foe nearest its lane. */
  const startCharge = (list: Bot[], foes: Entity[], center: Vec3): void => {
    const { f, r } = begin(list, center);
    const lat = (p: Vec3): number => (p.x - center.x) * r.x + (p.z - center.z) * r.z;
    const load = new Map<number, number>();
    const through = new Map<string, Vec3>();
    const lanes = new Map<string, Lane>();
    for (const b of [...list].sort((a, c) => lat(pos(a)) - lat(pos(c)))) {
      const p = pos(b);
      const along = Math.max(0, (center.x - p.x) * f.x + (center.z - p.z) * f.z) + backoff;
      through.set(b.username, onGround(opts.ground(), p.offset(f.x * along, 0, f.z * along)));
      // The foe nearest its lane, spread: each rider already on one counts as 3 blocks off the lane.
      let best: Entity | null = null;
      let bestCost = Infinity;
      for (const e of foes) {
        const cost = Math.abs(lat(e.position) - lat(p)) + 3 * (load.get(e.id) ?? 0);
        if (cost < bestCost) [best, bestCost] = [e, cost];
      }
      if (best) {
        load.set(best.id, (load.get(best.id) ?? 0) + 1);
        lanes.set(b.username, { id: best.id, username: (best as { username?: string }).username ?? null });
      }
    }
    Object.assign(cav, { phase: 'charge', since: Date.now(), axis: f, center, through, lanes, wave: cav.wave + 1 });
    cav.done.clear();
  };

  return {
    get passes() {
      return cav.passes;
    },
    get struck() {
      return cav.struck;
    },
    reset() {
      Object.assign(cav, { phase: 'idle', first: true });
    },
    step(riders, foes) {
      const list = riders.filter((b) => b.entity);
      if (!list.length) return;
      const group = foes.filter((e) => e?.position);
      const center = group.length ? centroid(group.map((e) => e.position)) : null;
      // A wave starts on a group; with none seen, the waves wait (idle) for one.
      const form = (): void => void (center ? startForm(list, center) : (cav.phase = 'idle'));
      const charge = (): void => void (center ? startCharge(list, group, center) : (cav.phase = 'idle'));
      const now = Date.now();
      if (cav.phase === 'idle') {
        if (!center) return;
        // The first charge starts from where they stand, in the formation they stand in, unless the group is far.
        if (cav.first && list.every((b) => flat(pos(b), center) <= backoff + CHARGE_FROM)) charge();
        else form();
        cav.first = false;
      } else if (cav.phase === 'charge') {
        if (list.every((b) => cav.done.has(b.username)) || now - cav.since > CHARGE_MS) form();
      } else if (list.every((b) => !cav.slots.has(b.username) || flat(pos(b), cav.slots.get(b.username)!) <= FORMED) || now - cav.since > FORM_MS) {
        charge();
      }
    },
    async ride(bot, o) {
      const name = bot.username;
      const w = cav.wave;
      const until = o.until ?? (() => false);
      if (cav.phase === 'charge' && !cav.done.has(name) && cav.through.has(name)) {
        const lane = cav.lanes.get(name);
        const center = cav.center!;
        try {
          const r = await lance(bot, cav.through.get(name)!, { foe: () => o.foe(lane, center), until: () => until() || cav.wave !== w, timeoutMs: CHARGE_MS });
          cav.struck += r.struck;
          cav.passes++;
          if (r.why === 'stuck') o.log?.(`${name}: charge stuck at ${bot.entity.position.floored()}`);
        } catch (e) {
          if (isBotLeft(e) || isStopped(e)) throw e;
          o.log?.(`${name}: ${(e as Error).message}`);
          await sleepMs(250);
        } finally {
          if (cav.wave === w) cav.done.add(name);
        }
        return 'charged';
      }
      if (cav.phase !== 'form') return cav.phase === 'idle' ? 'idle' : 'waiting';
      const slot = cav.slots.get(name);
      if (!slot) return 'waiting';
      const h = heading.get(unwrap(bot) as object);
      if (!h || h.slot !== slot || bot.pathfinder.goal !== h.goal) {
        const goal = new goals.GoalNear(slot.x, slot.y, slot.z, 1);
        bot.pathfinder.setGoal(goal);
        heading.set(unwrap(bot) as object, { slot, goal });
      }
      return 'forming';
    },
  };
}

/** The lance helpers by name (scope globals). */
export const LANCE_HELPERS = {
  canLance,
  foesNear,
  lance,
  lanceWaves,
} as const;
