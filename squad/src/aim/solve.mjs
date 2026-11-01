// The aim solver (docs/37 §3, D5): where to point a bow so the arrow hits a target, and what the arrow would hit
// first on the way. It replaces hawkEye, whose aim (a sweep of 179 flights plus 21 raycast flights, every tick of
// every drawing archer, each voxel a new prismarine Block) was 45 % of the main thread in a 20 v 20 fight (docs/36).
//
//   • The target leads along its velocity: the aim point is where its centre will be when the arrow gets there,
//     `lead` ticks (to the release) plus the flight, found by fixed-point iteration (2–3 rounds). A point (a volley
//     at the ground) is not led.
//   • The pitch is a one-dimensional root of the vertical miss at the aim point's distance, flown in closed form
//     (arrow.mjs heightAt: no per-tick loop): warm-started from the previous answer (1–3 flights when it is close),
//     else bracketed upward from the straight line and refined by regula falsi (Illinois). The low arc first; the high
//     arc when a wall blocks the low one (over friends too with `overFriends`, aim.overFriends).
//   • One checked flight, tick by tick as the game moves the arrow: each tick's segment walked voxel by voxel
//     (Amanatides–Woo) through the world reader, against each state's collision boxes (vanilla tests only the voxels
//     the segment visits, so an arrow over a fence's upper half passes); then a slab test against every hitbox of
//     the entity snapshot near the flight, grown by 0.3 (vanilla's margin), up to the block hit. The first thing hit
//     decides: the target, or another enemy, is a hit; a friend blocks; a block blocks. Unknown blocks (-1: no live
//     column) count as air and are counted.
//
// Other entities are tested where the snapshot has them, not led: its velocity is the move between two snapshots,
// and the server sends a player's position every 2 ticks and a mob's every 3, so a one-tick velocity reads 0, 0, 3v…
// Leading them would move them more wrongly than leaving them. The target's velocity comes smoothed from the main
// thread (aim/draw.ts, a least-squares slope over its last positions).
//
// Plain JS so a reader worker runs it with no loader (the `aim` job, jobs/handlers/aim.mjs) and the main thread runs
// the same code inline when there is no pool (aim/inline.ts). Types in solve.d.mts.

import { DRAG, ENTITY_MARGIN, GRAVITY, MAX_TICKS, WATER_DRAG, heightAt, launch } from './arrow.mjs';

/** The entity snapshot's row layout (jobs/entities.mjs), repeated here so this file needs nothing else. */
const HEADER_LENGTH = 4;
const STRIDE = 12;
const C_ID = 0;
const C_KIND = 2;
const C_X = 3;
const C_Y = 4;
const C_Z = 5;
const C_WIDTH = 9;
const C_HEIGHT = 10;
const C_TEAM = 11;
/** KINDS indices (jobs/entities.mjs): player 1 … mob 7 are creatures, `living` 8 is the armor stand. */
const KIND_PLAYER = 1;
const KIND_LAST_CREATURE = 7;
const KIND_LIVING = 8;

/** A miss within this (blocks) is a hit on the aim point. */
const TOL = 0.005;
const E_MAX = Math.PI / 2 - 1e-4;
const E_MIN = -E_MAX;
/** A water or flag bit of the per-state tables (world/tables.mjs F_WATER). */
const F_WATER = 16;
/** A point counts as reached when the arrow comes down within this many blocks of it (or gets past it). */
export const POINT_REACH = 1.5;

/**
 * Solve one aim. `world`: a WorldReader (or anything with dimIndex, stateIdIn and states), or null (every block
 * unknown). `entities`: the snapshot's rows ({ data, count }, an EntityReader), or null.
 */
export function solveAim(input, world, entities) {
  const counter = { flights: 0 };
  const from = input.from;
  const speed = input.speed;
  const ux = input.vel?.x ?? 0;
  const uy = input.vel?.y ?? 0;
  const uz = input.vel?.z ?? 0;
  const t = input.target;
  const isEntity = typeof t.id === 'number' && t.id >= 0;
  const lead = Math.max(0, input.lead ?? 0);
  const center = (T) =>
    isEntity
      ? { x: t.x + (t.vx ?? 0) * T, y: t.y + (t.height ?? 0) / 2, z: t.z + (t.vz ?? 0) * T }
      : { x: t.x, y: t.y, z: t.z };

  const solveArc = (arc, warm) => {
    let T = lead + (warm?.ticks ?? 0);
    let sol = null;
    let w = warm && warm.arc === arc ? warm.pitch : undefined;
    for (let it = 0; it < 5; it++) {
      const P = center(T);
      const s = pitchFor(from, P, speed, ux, uy, uz, arc, w, counter);
      if (!s) return sol;
      sol = { ...s, aim: P };
      w = s.pitch;
      if (!isEntity) break;
      const next = lead + s.ticks;
      if (Math.abs(next - T) < 0.05) break;
      T = next;
    }
    return sol;
  };

  const ctx = prepare(input, world, entities);
  let low = solveArc('low', input.warm);
  if (!low) {
    // Nothing to solve (an unreachable aim point): straight at it, as a last resort.
    const P = center(lead);
    const dx = P.x - from.x;
    const dz = P.z - from.z;
    low = { pitch: Math.atan2(P.y - from.y, Math.hypot(dx, dz)), wx: dx, wz: dz, vh: 0, vy: 0, ticks: 0, outOfRange: true, aim: P };
  }
  const lowFlight = fly(low, input, ctx, isEntity, counter);
  let chosen = { sol: low, arc: 'low', flight: lowFlight };
  /** What the other arc met, when both were flown. */
  let other = null;
  // A friend in the line blocks (docs/37 §3); with `overFriends` the high arc may go over it, as over a wall.
  if (!lowFlight.clear && !low.outOfRange && (lowFlight.hit !== 'friend' || input.overFriends === true)) {
    const high = solveArc('high', input.warm?.arc === 'high' ? input.warm : { arc: 'high', ticks: (low.ticks ?? 0) * 3 });
    if (high && !high.outOfRange) {
      const highFlight = fly(high, input, ctx, isEntity, counter);
      if (highFlight.clear) {
        chosen = { sol: high, arc: 'high', flight: highFlight };
        other = { arc: 'low', hit: lowFlight.hit, at: lowFlight.at };
      } else {
        other = { arc: 'high', hit: highFlight.hit, at: highFlight.at };
      }
    }
  }
  const { sol, arc, flight } = chosen;
  const out = {
    yaw: Math.atan2(-sol.wx, -sol.wz),
    pitch: sol.pitch,
    arc,
    ticks: flight.ticks,
    hit: flight.hit,
    clear: flight.clear,
    at: flight.at,
    entity: flight.entity,
    block: flight.block,
    aim: { x: sol.aim.x, y: sol.aim.y, z: sol.aim.z },
    unknown: flight.unknown,
    flights: counter.flights,
    outOfRange: !!sol.outOfRange,
  };
  if (other) out.other = other;
  return out;
}

// -- the pitch ------------------------------------------------------------------------------------------------------

/**
 * The elevation (radians, + up) whose flight passes through P on the given arc, with its launch and flight time;
 * `warm` is a previous elevation of the same arc. Out of range: the elevation that carries highest at P's distance,
 * falling short (`outOfRange`). Null when P is right above or below and nothing can be solved.
 */
function pitchFor(from, P, speed, ux, uy, uz, arc, warm, counter) {
  const ddx = P.x - from.x;
  const ddz = P.z - from.z;
  const D = Math.hypot(ddx, ddz);
  const dy = P.y - from.y;
  if (D < 0.5) {
    // Straight up or down: no arc to speak of.
    const e = dy >= 0 ? E_MAX : E_MIN;
    return { pitch: e, wx: 0, wz: -1, vh: 0, vy: speed * Math.sin(e), ticks: Math.abs(dy) / speed };
  }
  const dx = ddx / D;
  const dz = ddz / D;
  const miss = (e) => {
    counter.flights++;
    const l = launch(e, speed, ux, uy, uz, dx, dz);
    if (!l) return -Infinity;
    const h = heightAt(l.vh, l.vy, D);
    return h ? h.y - dy : -Infinity;
  };
  const result = (e, outOfRange = false) => {
    const l = launch(e, speed, ux, uy, uz, dx, dz) ?? { wx: dx, wz: dz, vh: 0, vy: 0 };
    const h = heightAt(l.vh, l.vy, D);
    return { pitch: e, wx: l.wx, wz: l.wz, vh: l.vh, vy: l.vy, ticks: h ? h.ticks : D / speed, outOfRange };
  };
  // Rising with the elevation on the low arc, falling on the high one.
  const rising = arc === 'low';

  if (warm !== undefined && Number.isFinite(warm)) {
    const e = warmRoot(miss, warm, rising);
    if (e !== null) return result(e);
  }
  if (rising) {
    const r = lowRoot(miss, Math.atan2(dy, D), D, speed);
    if (r.root !== null) return result(r.root);
    const pk = peak(miss, r.from, E_MAX);
    return result(pk.e, true);
  }
  // The high arc: past the peak.
  const lowE = lowRoot(miss, Math.atan2(dy, D), D, speed);
  const pk = peak(miss, lowE.root ?? lowE.from, E_MAX);
  if (!(pk.m >= 0)) return result(pk.e, true);
  const e = rootIn(miss, pk.e, pk.m, E_MAX, miss(E_MAX));
  return e === null ? result(pk.e, true) : result(e);
}

/** From a previous elevation: secant steps toward the root on the right side of the peak, or null (go cold). */
function warmRoot(miss, e0, rising) {
  let a = Math.min(E_MAX, Math.max(E_MIN, e0));
  let ma = miss(a);
  if (Math.abs(ma) < TOL) return a;
  if (!Number.isFinite(ma)) return null;
  // The side to step toward: up when the arrow passes low on the low arc (down on the high arc).
  const up = rising ? ma < 0 : ma > 0;
  let b = a + (up ? 0.003 : -0.003);
  let mb = miss(b);
  for (let i = 0; i < 5; i++) {
    if (!Number.isFinite(mb)) return null;
    const slope = (mb - ma) / (b - a);
    if (rising ? !(slope > 0) : !(slope < 0)) return null; // past the peak: not this arc's side
    if (Math.abs(mb) < TOL) return b;
    if (Math.sign(ma) !== Math.sign(mb)) return rootIn(miss, a, ma, b, mb);
    let c = b - mb / slope;
    c = Math.min(b + 0.25, Math.max(b - 0.25, c));
    c = Math.min(E_MAX, Math.max(E_MIN, c));
    a = b;
    ma = mb;
    b = c;
    mb = miss(b);
  }
  return Math.abs(mb) < TOL ? b : null;
}

/**
 * The low arc's root: upward from the straight line (where gravity leaves the arrow below the point), the bracket
 * doubling until the miss turns positive. `root` null when the miss falls again first (past the peak: out of range);
 * `from` is the last elevation tried below the peak.
 */
function lowRoot(miss, eLine, D, speed) {
  let a = Math.min(E_MAX - 0.01, Math.max(E_MIN, eLine));
  let ma = miss(a);
  while (ma >= 0 && a > E_MIN + 0.02) {
    // Above the point already (a shooter rising fast): step down to get below it.
    a = Math.max(E_MIN, a - 0.05);
    ma = miss(a);
  }
  if (ma >= 0) return { root: a, from: a };
  let step = Math.min(0.3, Math.max(0.002, (0.5 * GRAVITY * D) / (speed * speed)));
  let b = Math.min(E_MAX, a + step);
  let mb = miss(b);
  while (mb < 0) {
    if (mb < ma || b >= E_MAX) return { root: null, from: a };
    a = b;
    ma = mb;
    step *= 2;
    b = Math.min(E_MAX, b + step);
    mb = miss(b);
  }
  return { root: rootIn(miss, a, ma, b, mb), from: a };
}

/** The elevation that carries highest at the distance (golden section, to about 0.1°). */
function peak(miss, lo, hi) {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let mc = miss(c);
  let md = miss(d);
  while (b - a > 0.002) {
    if (mc >= md) {
      b = d;
      d = c;
      md = mc;
      c = b - g * (b - a);
      mc = miss(c);
    } else {
      a = c;
      c = d;
      mc = md;
      d = a + g * (b - a);
      md = miss(d);
    }
  }
  return mc >= md ? { e: c, m: mc } : { e: d, m: md };
}

/** A root between a and b (signs differ; a non-finite end is bisected toward): regula falsi, Illinois variant. */
function rootIn(miss, a, ma, b, mb) {
  let side = 0;
  for (let i = 0; i < 40; i++) {
    let c;
    if (Number.isFinite(ma) && Number.isFinite(mb)) c = (a * mb - b * ma) / (mb - ma);
    else c = (a + b) / 2;
    if (!(c > Math.min(a, b) && c < Math.max(a, b))) c = (a + b) / 2;
    const mc = miss(c);
    if (Math.abs(mc) < TOL || Math.abs(b - a) < 1e-7) return c;
    if (Math.sign(mc) === Math.sign(mb) || (!Number.isFinite(mc) && !Number.isFinite(mb))) {
      b = c;
      mb = mc;
      if (side === -1 && Number.isFinite(ma)) ma /= 2;
      side = -1;
    } else {
      a = c;
      ma = mc;
      if (side === 1 && Number.isFinite(mb)) mb /= 2;
      side = 1;
    }
  }
  return (a + b) / 2;
}

// -- the checked flight -------------------------------------------------------------------------------------------

/** What the flights of one solve share: the world, the dimension, the entity rows near the shot, the friends. */
function prepare(input, world, entities) {
  const d = world && input.dim !== undefined && input.dim !== null ? world.dimIndex(input.dim) : world ? 0 : -1;
  const friends = new Set(input.friends ?? []);
  let team = input.team ?? 0;
  const rows = [];
  const data = entities?.data ?? null;
  const n = data ? (entities.count ?? data[2]) : 0;
  const targetId = typeof input.target.id === 'number' ? input.target.id : -1;
  for (let i = 0; i < n; i++) {
    const o = HEADER_LENGTH + i * STRIDE;
    const id = data[o + C_ID];
    if (id === input.shooter) {
      if (!team) team = data[o + C_TEAM];
      continue;
    }
    if (id === targetId) continue;
    const kind = data[o + C_KIND];
    if (kind < KIND_PLAYER || kind > KIND_LIVING) continue; // items, orbs, arrows, vehicles: not in the way
    rows.push({ id, kind, x: data[o + C_X], y: data[o + C_Y], z: data[o + C_Z], w: data[o + C_WIDTH], h: data[o + C_HEIGHT], team: data[o + C_TEAM] });
  }
  return { world: d >= 0 ? world : null, dim: d, rows, friends, team, mobsEnemies: input.mobs !== 'neutral' };
}

/** How a row counts when the arrow meets it. */
function classify(row, ctx) {
  if (ctx.friends.has(row.id) || (ctx.team !== 0 && row.team === ctx.team)) return 'friend';
  if (row.kind === KIND_PLAYER) return 'enemy';
  if (row.kind <= KIND_LAST_CREATURE) return ctx.mobsEnemies ? 'enemy' : 'entity';
  return 'entity'; // an armor stand
}

/**
 * Fly the solution tick by tick through the world and the snapshot. Returns what is hit first ('target', 'enemy',
 * 'friend', 'block', 'entity', or 'none' when it gets past the aim point untouched), where, after how many ticks,
 * and how many unknown voxels it crossed.
 */
function fly(sol, input, ctx, isEntity, counter) {
  const f = flyRaw(sol, input, ctx, isEntity, counter);
  f.clear = f.hit === 'target' || f.hit === 'enemy' || f.hit === 'none';
  return f;
}

function flyRaw(sol, input, ctx, isEntity, counter) {
  counter.flights++;
  const from = input.from;
  const speed = input.speed;
  const t = input.target;
  const cosE = Math.cos(sol.pitch);
  let vx = sol.wx * speed * cosE + (input.vel?.x ?? 0);
  let vy = speed * Math.sin(sol.pitch) + (input.vel?.y ?? 0);
  let vz = sol.wz * speed * cosE + (input.vel?.z ?? 0);
  let px = from.x;
  let py = from.y;
  let pz = from.z;
  const aim = sol.aim;
  const D = Math.hypot(aim.x - from.x, aim.z - from.z);
  const dirx = D > 1e-9 ? (aim.x - from.x) / D : 0;
  const dirz = D > 1e-9 ? (aim.z - from.z) / D : 0;
  const lead = Math.max(0, input.lead ?? 0);
  const tw = (t.width ?? 0) / 2 + ENTITY_MARGIN;
  const th = t.height ?? 0;
  // The rows near the flight: its box from the start to the aim point, up to its apex, and a margin.
  const rise = vy > 0 ? (vy * vy) / (2 * GRAVITY) : 0;
  const m = 3;
  const bx0 = Math.min(px, aim.x) - m;
  const bx1 = Math.max(px, aim.x) + m;
  const bz0 = Math.min(pz, aim.z) - m;
  const bz1 = Math.max(pz, aim.z) + m;
  const by0 = Math.min(py, aim.y) - m - 2;
  const by1 = Math.max(py, aim.y) + rise + m;
  const near = ctx.rows.filter((r) => r.x + r.w / 2 >= bx0 && r.x - r.w / 2 <= bx1 && r.z + r.w / 2 >= bz0 && r.z - r.w / 2 <= bz1 && r.y + r.h >= by0 && r.y <= by1);
  const unknown = { n: 0, last: '' };
  const maxTicks = Math.min(MAX_TICKS, Math.ceil((sol.ticks ?? 0) + lead) + 40);
  for (let k = 0; k < maxTicks; k++) {
    // Blocks: the first voxel along this tick's segment whose collision boxes the segment crosses.
    const b = ctx.world ? walk(ctx, px, py, pz, vx, vy, vz, unknown) : (unknown.n += 1, null);
    let tEnd = b ? b.t : 1;
    // Entities, up to the block hit: the nearest box the segment enters.
    let best = null;
    let tBest = tEnd;
    for (const r of near) {
      const hw = r.w / 2 + ENTITY_MARGIN;
      const tt = entry(px, py, pz, vx, vy, vz, r.x - hw, r.y - ENTITY_MARGIN, r.z - hw, r.x + hw, r.y + r.h + ENTITY_MARGIN, r.z + hw, tBest);
      if (tt !== null && (tt < tBest || (best === null && tt <= tBest))) {
        best = r;
        tBest = tt;
      }
    }
    if (isEntity) {
      // The target where it will be at this tick of the flight.
      const T = lead + k;
      const cx = t.x + (t.vx ?? 0) * T;
      const cz = t.z + (t.vz ?? 0) * T;
      const tt = entry(px, py, pz, vx, vy, vz, cx - tw, t.y - ENTITY_MARGIN, cz - tw, cx + tw, t.y + th + ENTITY_MARGIN, cz + tw, tBest);
      if (tt !== null && tt <= tBest) {
        return { hit: 'target', at: point(px, py, pz, vx, vy, vz, tt), ticks: k + tt, entity: t.id, block: -1, unknown: unknown.n };
      }
    }
    if (best) {
      return { hit: classify(best, ctx), at: point(px, py, pz, vx, vy, vz, tBest), ticks: k + tBest, entity: best.id, block: -1, unknown: unknown.n };
    }
    if (b) {
      const at = point(px, py, pz, vx, vy, vz, b.t);
      // A point on the ground is reached when the arrow comes down at it.
      if (!isEntity && (at.x - from.x) * dirx + (at.z - from.z) * dirz >= D - POINT_REACH) {
        return { hit: 'target', at, ticks: k + b.t, entity: -1, block: b.state, unknown: unknown.n };
      }
      return { hit: 'block', at, ticks: k + b.t, entity: -1, block: b.state, unknown: unknown.n };
    }
    // Vanilla's isTouchingWater is from the start of the tick: the voxel the segment started in.
    const drag = ctx.world && ctx.startState > 0 && (ctx.world.states.flags(ctx.startState) & F_WATER) !== 0 ? WATER_DRAG : DRAG;
    px += vx;
    py += vy;
    pz += vz;
    vx *= drag;
    vy = vy * drag - GRAVITY;
    vz *= drag;
    const along = (px - from.x) * dirx + (pz - from.z) * dirz;
    // Past the aim point (and the target's box), still untouched: a point is reached; an entity is missed.
    if (along > D + (isEntity ? tw + 1 : POINT_REACH)) {
      return { hit: isEntity ? 'none' : 'target', at: { x: px, y: py, z: pz }, ticks: k + 1, entity: -1, block: -1, unknown: unknown.n };
    }
    if (py < -2048) break;
  }
  return { hit: 'none', at: null, ticks: maxTicks, entity: -1, block: -1, unknown: unknown.n };
}

function point(px, py, pz, vx, vy, vz, t) {
  return { x: px + vx * t, y: py + vy * t, z: pz + vz * t };
}

/**
 * Amanatides–Woo through the voxels of the segment p → p + v: the first voxel whose boxes the segment enters,
 * { t, state, x, y, z }, or null. Records the start voxel's state (ctx.startState) for the water drag.
 */
function walk(ctx, px, py, pz, vx, vy, vz, unknown) {
  const world = ctx.world;
  const states = world.states;
  const boxData = states.boxData;
  let x = Math.floor(px);
  let y = Math.floor(py);
  let z = Math.floor(pz);
  const sx = vx > 0 ? 1 : vx < 0 ? -1 : 0;
  const sy = vy > 0 ? 1 : vy < 0 ? -1 : 0;
  const sz = vz > 0 ? 1 : vz < 0 ? -1 : 0;
  const ddx = sx !== 0 ? Math.abs(1 / vx) : Infinity;
  const ddy = sy !== 0 ? Math.abs(1 / vy) : Infinity;
  const ddz = sz !== 0 ? Math.abs(1 / vz) : Infinity;
  let tx = sx > 0 ? (x + 1 - px) * ddx : sx < 0 ? (px - x) * ddx : Infinity;
  let ty = sy > 0 ? (y + 1 - py) * ddy : sy < 0 ? (py - y) * ddy : Infinity;
  let tz = sz > 0 ? (z + 1 - pz) * ddz : sz < 0 ? (pz - z) * ddz : Infinity;
  let first = true;
  for (let i = 0; i < 64; i++) {
    const s = world.stateIdIn(ctx.dim, x, y, z);
    if (first) {
      ctx.startState = s;
      first = false;
    }
    if (s < 0) {
      const key = `${x},${y},${z}`;
      if (key !== unknown.last) {
        unknown.n++;
        unknown.last = key;
      }
    } else if (s > 0) {
      const count = states.boxCount(s);
      if (count > 0) {
        const start = states.boxStart(s);
        let tHit = null;
        for (let j = 0; j < count; j++) {
          const o = start + j * 6;
          const tt = slab(px, py, pz, vx, vy, vz, x + boxData[o], y + boxData[o + 1], z + boxData[o + 2], x + boxData[o + 3], y + boxData[o + 4], z + boxData[o + 5], 1);
          if (tt !== null && (tHit === null || tt < tHit)) tHit = tt;
        }
        if (tHit !== null) return { t: tHit, state: s, x, y, z };
      }
    }
    const tn = Math.min(tx, ty, tz);
    if (tn > 1) return null;
    if (tn === tx) {
      x += sx;
      tx += ddx;
    } else if (tn === ty) {
      y += sy;
      ty += ddy;
    } else {
      z += sz;
      tz += ddz;
    }
  }
  return null;
}

/**
 * An entity's box: only an entry counts, as vanilla's Box.raycast has it (ProjectileUtil.getEntityCollision): a segment
 * that starts inside the box (a friend standing in the shooter, the arrow still in a box it entered) does not hit it.
 */
function entry(px, py, pz, vx, vy, vz, x0, y0, z0, x1, y1, z1, tMax) {
  if (px > x0 && px < x1 && py > y0 && py < y1 && pz > z0 && pz < z1) return null;
  return slab(px, py, pz, vx, vy, vz, x0, y0, z0, x1, y1, z1, tMax);
}

/** The segment p + t·v, t in [0, tMax], against a box: the entry t (0 when it starts inside), or null. */
function slab(px, py, pz, vx, vy, vz, x0, y0, z0, x1, y1, z1, tMax) {
  let t0 = 0;
  let t1 = tMax;
  if (vx !== 0) {
    let a = (x0 - px) / vx;
    let b = (x1 - px) / vx;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return null;
  } else if (px < x0 || px > x1) return null;
  if (vy !== 0) {
    let a = (y0 - py) / vy;
    let b = (y1 - py) / vy;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return null;
  } else if (py < y0 || py > y1) return null;
  if (vz !== 0) {
    let a = (z0 - pz) / vz;
    let b = (z1 - pz) / vz;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return null;
  } else if (pz < z0 || pz > z1) return null;
  return t0;
}
