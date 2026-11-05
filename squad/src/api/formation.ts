// The formation and fight helpers (docs/43 C1): what the stock `line`, `attack` and `raid` had each written for
// themselves, once, as scope globals. A new formation (one that moves, a flank, a line that charges and re-forms) is
// then short: slots from `lineUp`, `approach` to walk onto them, `squad.crew` for one loop per bot, `targets()` to
// share the threats, `melee` for a leash-safe fight.
//
// The approach (docs/43 B): far from its place a bot follows the pathfinder (GoalNear on the exact coordinates, range
// 2); within APPROACH_DIRECT blocks it walks there itself, at walking speed (never sneaking), steered on every physics
// tick, and stops on the place: within 0.15, at rest, with no overshoot. It brakes from the body's velocity: on the
// ground prismarine-physics keeps GROUND_INERTIA (0.546) of the horizontal velocity per tick, so a body let go slides
// v / (1 − 0.546) on (v: mineflayer's `entity.velocity`, after that tick's friction). Each tick it predicts where the
// body would come to rest if let go now; it lets go of `forward` when that is the place, and otherwise holds it one
// more tick toward the error (a held tick moves the rest point by the walking acceleration × 1 / (1 − 0.546)); an
// error smaller than one such tick is closed by two ticks at an angle on either side of it. A mounted bot (mount.ts)
// works the same: its body walks, at its horse's speed.

import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

import { steer as steerWalk } from '../bots/mount';
import { checkLease, orderOf, unwrap } from '../orders/guard';
import { HelperError, isBotLeft, isStopped } from './errors';
import { attack, groundAt, isHostile, lineSlots, lookDir, nearestEntity, pointedTarget, toVec3, type Leash, type PointedAt, type PosLike } from './helpers';

const { goals } = pathfinderPkg;

/** On the ground, the share of the horizontal velocity kept per tick (slipperiness 0.6 × 0.91, prismarine-physics). */
export const GROUND_INERTIA = 0.546;
/** A body let go slides its velocity × this before it stops (Σ 0.546^k). */
const SLIDE = 1 / (1 - GROUND_INERTIA);
/** A walking player's acceleration per tick: speed attribute 0.1 × 0.1627714 / 0.546³ (≈ 1) × the 0.98 input. */
export const WALK_ACCEL = 0.098;
/** Within this many blocks of its place (horizontally), `approach` stops pathfinding and walks there itself. */
export const APPROACH_DIRECT = 2;
/** `stepTo` walks straight, blind: a place farther than this needs a path first (`approach` does both). */
export const STEP_REACH = 2.75;
/** The pathfinder's goal while far: GoalNear on the exact place, this range (whole blocks). */
export const APPROACH_PATH_RANGE = 2;
/** On its place: within this, horizontally (the stock line's ON_SLOT). */
export const APPROACH_TOLERANCE = 0.15;
/** The rest point is this close to the place: no more input, the body slides there. */
const AIM_EPS = 0.04;
/** At rest: moving less than this per tick. */
const AT_REST = 0.005;
/** The direct walk gives up after this long by default (a block beside the place keeps the body off it). */
const STEP_TIMEOUT_MS = 3_000;
/** `approach` looks at what ends it this often. */
const APPROACH_LOOK_MS = 100;
/** `approach` gives up after this long by default. */
const APPROACH_TIMEOUT_MS = 30_000;

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const who = (bot: Bot): string => bot.username ?? '?';
const fmt = (v: { x: number; y: number; z: number }): string => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

interface Attribute {
  value: number;
  modifiers?: Array<{ amount: number; operation: number }>;
}
type Body = Entity & { velocity?: Vec3; onGround?: boolean; attributes?: Record<string, Attribute> };

/** The walking acceleration per tick from the bot's speed attribute (its modifiers too: a potion, a horse's speed). */
function walkAccel(bot: Bot): number {
  const e = bot.entity as Body;
  const key = (bot as unknown as { registry?: { attributesByName?: Record<string, { resource?: string }> } }).registry?.attributesByName?.movementSpeed?.resource ?? 'minecraft:movement_speed';
  const a = e?.attributes?.[key] ?? e?.attributes?.['generic.movement_speed'];
  if (!a || !Number.isFinite(a.value) || a.value <= 0) return WALK_ACCEL;
  let x = a.value;
  const mods = (a.modifiers ?? []).filter((m) => m && Number.isFinite(m.amount));
  for (const m of mods) if (m.operation === 0) x += m.amount;
  let y = x;
  for (const m of mods) if (m.operation === 1) y += x * m.amount;
  for (const m of mods) if (m.operation === 2) y += y * m.amount;
  return y > 0 ? y * 0.98 * (0.1627714 / GROUND_INERTIA ** 3) : WALK_ACCEL;
}

/** Per body: the stepTo that drives its controls. A later one takes over, and the earlier one then leaves them alone. */
const stepping = new WeakMap<object, object>();

function letGo(bot: Bot): void {
  try {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  } catch (e) {
    if (!isBotLeft(e) && !isStopped(e)) throw e;
  }
}

/** What `stepTo` and `approach` answer. */
export interface ApproachResult {
  /** At rest within `tolerance` of the place. */
  there: boolean;
  /** Ran out of time (the place is blocked, or out of reach). */
  timedOut: boolean;
  /** How far (horizontally) the body ended from the place. */
  off: number;
}

/**
 * The direct walk onto an exact place (its x and z, not a block's centre) from close by, within STEP_REACH (2.75)
 * blocks: at walking speed, never sneaking, steered on every physics tick (mineflayer runs late ticks in a burst),
 * braking from the body's velocity so that it stops on the place (see the file's header). It clears the pathfinder's
 * goal first (the pathfinder steers too). It ends at rest within `tolerance` (default 0.15: `there`), when `until()`
 * returns true (checked every 50 ms: a new formation, a hit to answer, a foe to shoot), or after `timeoutMs` (default
 * 3 s: `timedOut`). On every exit it takes its steering off the ticks and lets go of forward, unless a later stepTo on
 * the same body took them over. A place one block up is jumped onto. A bot that left throws BotLeftError.
 */
export async function stepTo(bot: Bot, place: PosLike, opts: { until?: () => boolean; timeoutMs?: number; tolerance?: number } = {}): Promise<ApproachResult> {
  checkLease(bot);
  const label = `stepTo(${who(bot)})`;
  const to = toVec3(place, `${label} place`);
  const timeoutMs = Number(opts.timeoutMs ?? STEP_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new HelperError(`${label}: timeoutMs must be a number of milliseconds ≥ 0, got ${String(opts.timeoutMs)}`);
  const tolerance = Math.max(AIM_EPS, Number(opts.tolerance ?? APPROACH_TOLERANCE));
  const until = opts.until ?? (() => false);
  const off = (): number => flat(to, bot.entity.position);
  if (off() > STEP_REACH) throw new HelperError(`${label}: ${off().toFixed(2)} blocks from ${fmt(to)}, more than ${STEP_REACH}: approach(bot, place) paths there first`);
  const real = unwrap(bot) as object;
  const me = {};
  stepping.set(real, me);
  let accel = walkAccel(bot);
  /** The rest point before the last tick, and the direction that tick was walked (null: not walked). */
  let lastRest: Vec3 | null = null;
  let lastDir: { x: number; z: number } | null = null;
  let still = false;
  let flip = 1;
  const steer = (): void => {
    const e = bot.entity as Body;
    const p = e.position;
    const v = e.velocity ?? new Vec3(0, 0, 0);
    const rest = new Vec3(p.x + v.x * SLIDE, p.y, p.z + v.z * SLIDE);
    // The acceleration as seen: a walked tick moved the rest point by accel × SLIDE along its direction.
    if (lastRest && lastDir && e.onGround !== false) {
      const seen = ((rest.x - lastRest.x) * lastDir.x + (rest.z - lastRest.z) * lastDir.z) / SLIDE;
      const est = walkAccel(bot);
      if (seen > est * 0.5 && seen < est * 2) accel = seen;
    }
    const rx = to.x - rest.x;
    const rz = to.z - rest.z;
    const r = Math.hypot(rx, rz);
    const tap = accel * SLIDE;
    lastRest = rest;
    lastDir = null;
    if (r <= AIM_EPS || (e.onGround === false && r < tap)) {
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
      still = Math.hypot(v.x, v.z) < AT_REST && off() <= tolerance;
      return;
    }
    still = false;
    // Toward the error, or (smaller than one tick's worth) at an angle either side of it: two ticks close it.
    let a = Math.atan2(rx, rz);
    if (r < tap - AIM_EPS) {
      a += flip * Math.acos(Math.min(1, r / (2 * tap)));
      flip = -flip;
    }
    const dir = { x: Math.sin(a), z: Math.cos(a) };
    lastDir = dir;
    steerWalk(bot, Math.atan2(-dir.x, -dir.z), true); // mineflayer's yaw for that direction (a rider aiming: its horse's)
    bot.setControlState('forward', true);
    bot.setControlState('jump', e.onGround !== false && to.y - p.y > 0.5 && to.y - p.y < 1.3 && off() < 1.2);
  };
  const end = Date.now() + timeoutMs;
  let timedOut = false;
  try {
    if (bot.pathfinder?.goal) bot.pathfinder.setGoal(null);
    if ((bot as unknown as { controlState?: Record<string, boolean> }).controlState?.sneak) bot.setControlState('sneak', false);
    bot.on('physicsTick', steer);
    while (!still && stepping.get(real) === me && !until()) {
      if (Date.now() >= end) {
        timedOut = true;
        break;
      }
      await sleepMs(50);
      checkLease(bot);
    }
  } finally {
    bot.removeListener('physicsTick', steer);
    if (stepping.get(real) === me) {
      stepping.delete(real);
      letGo(bot);
    }
  }
  return { there: still, timedOut, off: off() };
}

/**
 * Go to an exact place (docs/43 B): the pathfinder until within APPROACH_DIRECT (2) blocks of it (GoalNear on its exact
 * coordinates, range 2), then the direct walk of `stepTo` onto it. `tolerance` (default 0.15) is how close counts as
 * there; one of a block or more (a loose hold) is pathfinding only, there within it. Ends at rest there (`there`),
 * when `until()` returns true (checked every 100 ms, through both parts), after `timeoutMs` (default 30 s) or, for the
 * direct walk, `stepTimeoutMs` (3 s: `timedOut`). A bot that left throws BotLeftError.
 */
export async function approach(
  bot: Bot,
  place: PosLike,
  opts: { until?: () => boolean; timeoutMs?: number; stepTimeoutMs?: number; tolerance?: number } = {},
): Promise<ApproachResult> {
  checkLease(bot);
  const to = toVec3(place, `approach(${who(bot)}) place`);
  const until = opts.until ?? (() => false);
  const tolerance = Number(opts.tolerance ?? APPROACH_TOLERANCE);
  const end = Date.now() + Number(opts.timeoutMs ?? APPROACH_TIMEOUT_MS);
  const loose = tolerance >= 1;
  let goal: unknown = null;
  const result = (timedOut: boolean): ApproachResult => {
    const off = flat(to, bot.entity.position);
    return { there: off <= tolerance && !timedOut, timedOut, off };
  };
  try {
    for (;;) {
      if (until()) return result(false);
      const p = bot.entity.position;
      const d = flat(to, p);
      const level = Math.abs(p.y - to.y) <= 1.25;
      if (loose && d <= tolerance && level) return result(false);
      const idle = !bot.pathfinder.goal || bot.pathfinder.goal !== goal;
      if (!loose && level && (d <= APPROACH_DIRECT || (d <= STEP_REACH && idle && goal !== null))) {
        const left = end - Date.now();
        if (left <= 0) return result(true);
        return await stepTo(bot, to, { until, tolerance, timeoutMs: Math.min(left, Number(opts.stepTimeoutMs ?? STEP_TIMEOUT_MS)) });
      }
      if (Date.now() >= end) return result(true);
      if (bot.pathfinder.goal !== goal || goal === null) {
        goal = new goals.GoalNear(to.x, to.y, to.z, loose ? Math.max(1, Math.floor(tolerance)) : APPROACH_PATH_RANGE);
        bot.pathfinder.setGoal(goal as never);
      }
      await sleepMs(APPROACH_LOOK_MS);
      checkLease(bot);
    }
  } finally {
    try {
      if (goal && bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null);
    } catch {
      /* best-effort: a bot that left had its goal cleared by the abort sequence */
    }
  }
}

// -- many bots, one answer ----------------------------------------------------------------------------------------

/** The first truthy answer of `fn` over `bots` (one that has just left is skipped), or null. */
export function anyBot<T>(bots: Bot[], fn: (bot: Bot) => T | null | undefined | false): T | null {
  for (const b of bots) {
    try {
      const r = fn(b);
      if (r) return r;
    } catch (e) {
      if (!isBotLeft(e)) throw e;
    }
  }
  return null;
}

/** The exact place `p` at its column's ground height (groundAt's y, keeping p's own x and z), as any of `bots` knows it; p itself when none does. */
export function onGround(bots: Bot | Bot[], p: PosLike): Vec3 {
  const q = toVec3(p, 'onGround');
  const list = Array.isArray(bots) ? bots : [bots];
  const g = anyBot(list, (b) => groundAt(b, q));
  return g ? new Vec3(q.x, g.y, q.z) : q;
}

/**
 * Where a click points, for a formation (the stock line): the pointed position (pointedTarget, `near` 0) on the ground
 * when within `distance` (default 24) of the commander horizontally; else `ahead` (default 8) blocks along their view,
 * on the ground when known.
 */
export function pointOf(bots: Bot[], at: PointedAt & { position: PosLike; yaw: number }, opts: { distance?: number; ahead?: number } = {}): Vec3 {
  const distance = Number(opts.distance ?? 24);
  const ahead = Number(opts.ahead ?? 8);
  const from = toVec3(at.position, 'pointOf at.position');
  const bot = bots.find((b) => b.entity);
  if (bot) {
    const p = pointedTarget(bot, at, { near: 0 }).position;
    if (p && flat(p, from) <= distance) {
      const top = anyBot(bots, (b) => groundAt(b, p));
      if (top) return top;
    }
  }
  const d = lookDir(at.yaw);
  const q = from.offset(d.x * ahead, 0, d.z * ahead);
  return anyBot(bots, (b) => groundAt(b, q)) ?? q;
}

/**
 * Give out `slots` to `bots` by where they stand, so that no two paths cross (docs/35 F2, F4): the slots are taken as
 * ranks (by depth along the view `yaw`, front first), each left to right as the commander sees them; the bots the same
 * way: the front-most to the front rank, each rank's bots left to right. A Map from bot name to its slot. Bots without
 * a body, or beyond the slots, get none.
 */
export function assignSlots(bots: Bot[], slots: PosLike[], yaw: number): Map<string, Vec3> {
  const fwd = lookDir(yaw);
  const right = lookDir(yaw + 90);
  const dot = (q: { x: number; z: number }, d: { x: number; z: number }): number => q.x * d.x + q.z * d.z;
  const places = slots.map((s) => toVec3(s, 'assignSlots slot'));
  // Ranks: slots within half a block of the same depth.
  const byDepth = [...places].sort((a, b) => dot(b, fwd) - dot(a, fwd));
  const ranks: Vec3[][] = [];
  for (const s of byDepth) {
    const r = ranks[ranks.length - 1];
    if (r && Math.abs(dot(r[0]!, fwd) - dot(s, fwd)) < 0.5) r.push(s);
    else ranks.push([s]);
  }
  for (const r of ranks) r.sort((a, b) => dot(a, right) - dot(b, right));
  const bodies = bots.filter((b) => b.entity).sort((a, b) => dot(b.entity.position, fwd) - dot(a.entity.position, fwd));
  const out = new Map<string, Vec3>();
  let i = 0;
  for (const r of ranks) {
    const rank = bodies.slice(i, i + r.length).sort((a, b) => dot(a.entity.position, right) - dot(b.entity.position, right));
    rank.forEach((b, k) => out.set(b.username, r[k]!));
    i += r.length;
  }
  return out;
}

/**
 * A line of `bots` through `center` across the view `yaw` (lineSlots: `spacing`, `ranks`, `depth`), each slot an exact
 * place on its column's ground (onGround, as any of `ground` knows it, default the bots), given out by assignSlots.
 */
export function lineUp(bots: Bot[], center: PosLike, yaw: number, opts: { spacing?: number; ranks?: number; depth?: number; ground?: Bot[] } = {}): Map<string, Vec3> {
  const live = bots.filter((b) => b.entity);
  const ranks = Math.max(1, Math.min(Math.floor(Number(opts.ranks ?? 1)) || 1, live.length || 1));
  const slots = lineSlots(center, yaw, live.length, { spacing: opts.spacing ?? 1.5, ranks, depth: opts.depth ?? 2 }).map((s) => onGround(opts.ground ?? bots, s));
  return assignSlots(live, slots, yaw);
}

// -- fights ---------------------------------------------------------------------------------------------------------

/** A player not of the bot's order's team (isFriend), and not a spectator (nobody can hit one). */
export function isEnemy(bot: Bot, e: Entity | null | undefined): boolean {
  if (!e || e.type !== 'player' || !e.username) return false;
  const friends = orderOf<{ friends?: Set<string> }>(bot)?.friends;
  if (friends?.has(e.username)) return false;
  return (bot.players?.[e.username] as { gamemode?: number } | undefined)?.gamemode !== 3;
}

/**
 * The threat for this bot within `range` of `from` (default the bot): a hostile mob or an enemy player (isEnemy),
 * passing `filter`. `prefer`: 'hostile' (default: the nearest hostile mob, else the nearest enemy player, as the stock
 * line and attack pick) or 'nearest' (whichever is nearer, as raid does).
 */
export function nearestFoe(bot: Bot, range = 16, opts: { from?: PosLike | null; filter?: (e: Entity) => boolean; prefer?: 'hostile' | 'nearest' } = {}): Entity | null {
  const ok = opts.filter ?? (() => true);
  const from = opts.from ?? null;
  const mob = nearestEntity(bot, (e) => isHostile(bot, e) && ok(e), range, { from });
  if (opts.prefer !== 'nearest' && mob) return mob;
  const player = nearestEntity(bot, (e) => isEnemy(bot, e) && ok(e), range, { from });
  if (!mob || !player) return mob ?? player;
  const c = from ? toVec3(from) : bot.entity.position;
  return player.position.distanceTo(c) <= mob.position.distanceTo(c) ? player : mob;
}

/** One tier of a pick: (entity, how many bots are on it now) → whether it fits. */
export type PickTier = (e: Entity, load: number) => boolean;

/** Who fights what, shared by the bots of one role (docs/43 C1). */
export interface Targets {
  /** How many bots are on it now. */
  load(e: Entity): number;
  /** This bot is on it; call the function returned to let it go (in a `finally`). */
  take(e: Entity, bot: Bot): () => void;
  /**
   * The threat for this bot (nearestFoe within `radius` of `from`): the first tier that finds one wins. Default tiers:
   * nobody on it, then fewer than `cap` (default Infinity) on it. `skip` and the targets this bot passes over (block)
   * are never picked.
   */
  pick(bot: Bot, opts?: { from?: PosLike | null; radius?: number; cap?: number; tiers?: PickTier[]; skip?: Entity | null; prefer?: 'hostile' | 'nearest' }): Entity | null;
  /** This bot passes over `e` for `ms` (a block stopped its shot at it: docs/35 F4). */
  block(bot: Bot, e: Entity, ms: number): void;
  /** Whether this bot passes over `e` now. */
  blocked(bot: Bot, e: Entity): boolean;
}

/** A new Targets (one per role that shares its threats). */
export function targets(): Targets {
  const on = new Map<number, Set<string>>();
  const passed = new Map<string, Map<number, number>>();
  const idOf = (e: Entity): number => (e as { id: number }).id;
  const load = (e: Entity): number => on.get(idOf(e))?.size ?? 0;
  const blocked = (bot: Bot, e: Entity): boolean => {
    const m = passed.get(bot.username);
    if (!m) return false;
    const now = Date.now();
    for (const [id, t] of m) if (t <= now) m.delete(id);
    return (m.get(idOf(e)) ?? 0) > now;
  };
  return {
    load,
    take(e, bot) {
      const id = idOf(e);
      const set = on.get(id) ?? new Set<string>();
      set.add(bot.username);
      on.set(id, set);
      return () => {
        set.delete(bot.username);
        if (set.size === 0 && on.get(id) === set) on.delete(id);
      };
    },
    pick(bot, opts = {}) {
      const cap = Number(opts.cap ?? Infinity);
      const tiers = opts.tiers ?? [(_e: Entity, n: number) => n === 0, (_e: Entity, n: number) => n < cap];
      for (const tier of tiers) {
        const fits = (e: Entity): boolean => e !== opts.skip && !blocked(bot, e) && tier(e, load(e));
        const t = nearestFoe(bot, opts.radius ?? 16, { from: opts.from ?? null, filter: fits, prefer: opts.prefer ?? 'hostile' });
        if (t) return t;
      }
      return null;
    },
    block(bot, e, ms) {
      let m = passed.get(bot.username);
      if (!m) passed.set(bot.username, (m = new Map()));
      m.set(idOf(e), Date.now() + ms);
    },
    blocked,
  };
}

/** A player's arm's reach: the eyes to the target's hitbox. */
export const ARM_REACH = 3;

/** Whether `e`'s hitbox is within `reach` (default 3) of the bot's eyes (its eyeHeight: a rider's are in the saddle). */
export function inReach(bot: Bot, e: Entity, reach = ARM_REACH): boolean {
  const eyes = (bot.entity as Body & { eyeHeight?: number }).eyeHeight ?? 1.62;
  const eye = bot.entity.position.offset(0, eyes, 0);
  const w = ((e as { width?: number }).width ?? 0.6) / 2;
  const h = (e as { height?: number }).height ?? 1.8;
  const gap = (v: number, lo: number, hi: number): number => Math.max(lo - v, 0, v - hi);
  return Math.hypot(gap(eye.x, e.position.x - w, e.position.x + w), gap(eye.y, e.position.y, e.position.y + h), gap(eye.z, e.position.z - w, e.position.z + w)) <= reach;
}

/** attack()'s leash slack (helpers.ts LEASH_SLACK is 4): a bot farther than radius + this from the centre closes in first. */
export const MELEE_CLOSE_IN = 3;
/** How long `melee` waits after closing in or a fight that broke off at once. */
export const MELEE_PAUSE_MS = 200;

/**
 * A leash-safe melee fight (docs/43 C1): attack() breaks off before its first swing when the bot is more than
 * radius + 4 from the leash's centre, and a loop around it spun (found live, docs/41 §4). Farther than radius + 3,
 * `melee` closes in first: `closeIn(bot, centre)` when given (a goal of the command's own), else a GoalNear 3 on the
 * centre, then a 200 ms pause (`closing: true`). Otherwise attack(), and after a break-off the same pause. It always
 * awaits a timer.
 */
export async function melee(
  bot: Bot,
  foe: Entity,
  opts: { leash?: Leash; until?: () => boolean; timeoutMs?: number; closeIn?: (bot: Bot, centre: Vec3) => unknown } = {},
): Promise<{ killed: boolean; brokeOff?: 'leash' | 'until'; closing?: boolean }> {
  checkLease(bot);
  const c = opts.leash?.center();
  if (opts.leash && c) {
    const centre = toVec3(c, `melee(${who(bot)}) leash center`);
    if (bot.entity.position.distanceTo(centre) > opts.leash.radius + MELEE_CLOSE_IN) {
      if (opts.closeIn) await opts.closeIn(bot, centre);
      else bot.pathfinder.setGoal(new goals.GoalNear(centre.x, centre.y, centre.z, 3));
      await sleepMs(MELEE_PAUSE_MS);
      checkLease(bot);
      return { killed: false, closing: true };
    }
  }
  const r = await attack(bot, foe, { timeoutMs: opts.timeoutMs ?? 15_000, ...(opts.leash ? { leash: opts.leash } : {}), ...(opts.until ? { until: opts.until } : {}) });
  if (r.brokeOff) await sleepMs(MELEE_PAUSE_MS);
  return r;
}

/**
 * Step aside, out from behind whatever blocked a shot at `from` (an entity or a position): a GoalNear 1 on a point
 * `min`–`max` blocks (random, default 1–2) to a random side of the line to it. Returns the goal (not awaited).
 */
export function sidestep(bot: Bot, from: PosLike, opts: { min?: number; max?: number } = {}): unknown {
  checkLease(bot);
  const t = toVec3(from, `sidestep(${who(bot)}) from`);
  const p = bot.entity.position;
  const dx = t.x - p.x;
  const dz = t.z - p.z;
  const len = Math.hypot(dx, dz) || 1;
  const min = Number(opts.min ?? 1);
  const max = Number(opts.max ?? 2);
  const side = (Math.random() < 0.5 ? 1 : -1) * (min + Math.random() * Math.max(0, max - min));
  const goal = new goals.GoalNear(p.x - (dz / len) * side, p.y, p.z + (dx / len) * side, 1);
  bot.pathfinder.setGoal(goal);
  return goal;
}

/** The formation and fight helpers by name (scope globals). */
export const FORMATION_HELPERS = {
  approach,
  stepTo,
  anyBot,
  onGround,
  pointOf,
  assignSlots,
  lineUp,
  isEnemy,
  nearestFoe,
  targets,
  inReach,
  melee,
  sidestep,
} as const;
