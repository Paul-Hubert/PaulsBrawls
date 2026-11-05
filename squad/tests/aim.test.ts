// The archers' aim (docs/37 P3): the arrow model against the game's per-tick flight, hand-computed ticks and
// hawkEye's equations; the solver (a still and a moving target, the high arc over a wall, friends and enemies in the
// line, unknown blocks, the warm start); the draw's schedule (the update ticks, the turning, the release on tick 24,
// late answers; a wall refused at once, a friend waited for, a dead target, auto-eat), the job pool's fake on
// hand-driven ticks; and the inline path over a bot's own world, no pool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { Vec3 } from 'vec3';

import { BOW_SPEED, DRAG, GRAVITY, heightAt, launch, stepFlight } from '../src/aim/arrow.mjs';
import { AIM_PRIORITY, HOLD_TICKS, SUBMIT_AHEAD_TICKS, aimStats, configureAim } from '../src/aim/draw';
import { solveAim, type AimEntities, type AimInput, type AimSolution, type AimWorld } from '../src/aim/solve.mjs';
import { bowAim, shoot } from '../src/api/helpers';
import { DEFAULT_AIM } from '../src/config';
import { COL, HEADER, HEADER_LENGTH, STRIDE } from '../src/jobs/entities.mjs';
import { JobLateError } from '../src/jobs/errors';
import { StateTables } from '../src/world/reader.mjs';
import { buildStateTables } from '../src/world/tables.mjs';
import { ORDER } from '../src/orders/guard';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.1') as { blocksByName: Record<string, { defaultState: number }> };
const TABLES = new StateTables(buildStateTables(registry));
const STONE = registry.blocksByName.stone!.defaultState;
const RAD = 180 / Math.PI;

/** A world of stone where `solid` says, air elsewhere; -1 (unknown) where `unknown` says. */
function world(solid: (x: number, y: number, z: number) => boolean, unknown: (x: number, y: number, z: number) => boolean = () => false): AimWorld {
  return {
    dimIndex: () => 0,
    stateIdIn: (_d, x, y, z) => (unknown(x, y, z) ? -1 : solid(x, y, z) ? STONE : 0),
    states: TABLES as unknown as AimWorld['states'],
  };
}
const floor = (x: number, y: number) => y <= 63;

/** Snapshot rows (jobs/entities.mjs layout). */
function rows(list: Array<{ id: number; kind?: number; x: number; y: number; z: number; w?: number; h?: number; team?: number }>): AimEntities {
  const data = new Float64Array(HEADER_LENGTH + list.length * STRIDE);
  list.forEach((r, i) => {
    const o = HEADER_LENGTH + i * STRIDE;
    data[o + COL.ID] = r.id;
    data[o + COL.KIND] = r.kind ?? 1;
    data[o + COL.X] = r.x;
    data[o + COL.Y] = r.y;
    data[o + COL.Z] = r.z;
    data[o + COL.WIDTH] = r.w ?? 0.6;
    data[o + COL.HEIGHT] = r.h ?? 1.8;
    data[o + COL.TEAM] = r.team ?? 0;
  });
  data[HEADER.COUNT] = list.length;
  return { data, count: list.length };
}

/** An archer standing at (0.5, 64, 0.5): its arrow leaves at the eyes − 0.1. */
const FROM = { x: 0.5, y: 64 + 1.52, z: 0.5 };
const input = (over: Partial<AimInput> & Pick<AimInput, 'target'>): AimInput => ({ dim: null, speed: BOW_SPEED, from: FROM, vel: { x: 0, y: 0, z: 0 }, shooter: 1, lead: 0, ...over });
const zombie = (x: number, z: number, over: Record<string, number> = {}) => ({ id: 50, x, y: 64, z, vx: 0, vy: 0, vz: 0, width: 0.6, height: 1.95, ...over });

/**
 * An independent check: fly the answer tick by tick (stepFlight) and say whether a segment passes through the target's
 * box (grown by 0.3) where the target is at that tick, sampling each segment finely.
 */
function hits(sol: AimSolution, inp: AimInput): boolean {
  const s = inp.speed;
  const v = { x: -Math.sin(sol.yaw) * Math.cos(sol.pitch) * s + inp.vel.x, y: Math.sin(sol.pitch) * s + inp.vel.y, z: -Math.cos(sol.yaw) * Math.cos(sol.pitch) * s + inp.vel.z };
  const pts = [inp.from, ...stepFlight(inp.from, v, 200)];
  const t = inp.target;
  const hw = (t.width ?? 0.6) / 2 + 0.3;
  for (let k = 0; k + 1 < pts.length; k++) {
    const T = inp.lead + k;
    const cx = t.x + (t.vx ?? 0) * T;
    const cz = t.z + (t.vz ?? 0) * T;
    for (let i = 0; i <= 50; i++) {
      const f = i / 50;
      const x = pts[k]!.x + (pts[k + 1]!.x - pts[k]!.x) * f;
      const y = pts[k]!.y + (pts[k + 1]!.y - pts[k]!.y) * f;
      const z = pts[k]!.z + (pts[k + 1]!.z - pts[k]!.z) * f;
      if (Math.abs(x - cx) <= hw && Math.abs(z - cz) <= hw && y >= t.y - 0.3 && y <= t.y + (t.height ?? 1.8) + 0.3) return true;
    }
  }
  return false;
}

// -- the arrow ---------------------------------------------------------------------------------------------------------

test('arrow: Minecraft 1.21.1 constants; a level shot, tick by tick by hand; the closed form is the per-tick flight', () => {
  assert.equal(DRAG, Math.fround(0.99));
  assert.equal(GRAVITY, 0.05);
  // Level, 3 blocks per tick: x 3, 3 + 2.97, + 2.9403; y 0, −0.05, −0.05 − (0.05 × 0.99 + 0.05).
  const pts = stepFlight({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, 3);
  const d = DRAG;
  assert.deepEqual(
    pts.map((p) => [p.x, p.y]),
    [
      [3, 0],
      [3 + 3 * d, -0.05],
      [3 + 3 * d + 3 * d * d, -0.05 + (-0.05 * d - 0.05)],
    ],
  );
  // The closed form lands on the same points, at whole ticks and in between (linear within a tick, as the game moves).
  for (const e of [-0.6, -0.1, 0, 0.05, 0.3, 0.8, 1.2]) {
    const l = launch(e, 3, 0, 0, 0, 1, 0)!;
    const flight = stepFlight({ x: 0, y: 0, z: 0 }, { x: l.vh, y: l.vy, z: 0 }, 60);
    for (const k of [0, 4, 11, 29, 58]) {
      const p = flight[k]!;
      const h = heightAt(l.vh, l.vy, p.x)!;
      assert.ok(Math.abs(h.y - p.y) < 1e-9 && Math.abs(h.ticks - (k + 1)) < 1e-9, `e ${e}, tick ${k + 1}: ${h.y} vs ${p.y}`);
      const q = flight[k + 1]!;
      const mid = heightAt(l.vh, l.vy, (p.x + q.x) / 2)!;
      assert.ok(Math.abs(mid.y - (p.y + q.y) / 2) < 1e-9, 'half a tick: half way along the segment');
    }
  }
  assert.equal(heightAt(3, 0, 400), null, 'never 400 blocks away (it stops at 300 ticks)');
});

/** hawkEye's equations, while the package is still installed (the runtime no longer loads it). */
function hawkEyeEquations(): { loadBot: { default: (b: unknown) => void }; getMasterGrade: (t: unknown, v: Vec3, w: string) => { grade: number } | undefined } | null {
  try {
    const dir = require.resolve('minecrafthawkeye').replace(/index.js$/, '');
    return {
      loadBot: require(`${dir}loadBot.js`) as { default: (b: unknown) => void },
      getMasterGrade: (require(`${dir}hawkEyeEquations.js`) as { default: (t: unknown, v: Vec3, w: string) => { grade: number } | undefined }).default,
    };
  } catch {
    return null;
  }
}
const hawk = hawkEyeEquations();

test("arrow: the solver's pitch matches hawkEye's equations within 0.3° (still points, flat and sloped)", { skip: hawk ? false : 'minecrafthawkeye is not installed' }, () => {
  // hawkEye's own getMasterGrade, its bot stubbed: it starts at the feet + 1.6 and aims a point at its height.
  const { loadBot, getMasterGrade } = hawk!;
  loadBot.default({ entity: { position: new Vec3(0.5, 64, 0.5) }, world: { raycast: () => null } });
  for (const [d, dy] of [[10, 0], [20, 0], [30, 0], [40, 0], [25, 5], [25, -6]] as const) {
    const target = new Vec3(0.5 + d, 64 + dy, 0.5);
    const theirs = getMasterGrade({ position: target, isValid: true }, new Vec3(0, 0, 0), 'bow');
    assert.ok(theirs, `hawkEye has an arc at ${d}, ${dy}`);
    const ours = solveAim(input({ from: { x: 0.5, y: 65.6, z: 0.5 }, target: { x: target.x, y: target.y, z: target.z } }), null, null);
    assert.ok(Math.abs(ours.pitch * RAD - theirs.grade) <= 0.3, `${d} blocks, dy ${dy}: ours ${(ours.pitch * RAD).toFixed(2)}°, hawkEye ${theirs.grade}°`);
  }
});

// -- the solver --------------------------------------------------------------------------------------------------------

test('solver: a still target is hit on the low arc; a point is bowAim\'s low arc', () => {
  for (const [x, z] of [[10.5, 0.5], [20.5, 7.5], [-30.5, 12.5]] as const) {
    const inp = input({ target: zombie(x, z) });
    const s = solveAim(inp, world(floor), null);
    assert.equal(s.hit, 'target', `at ${x}, ${z}: ${s.hit} at ${JSON.stringify(s.at)}`);
    assert.ok(s.clear && s.arc === 'low' && !s.outOfRange && s.pitch < 0.4);
    assert.ok(hits(s, inp), 'an independent flight of the answer goes through the box');
  }
  // A point on the ground: the low arc through it, as bowAim (helpers) has it, and reached.
  for (const to of [new Vec3(10.5, 64, 0.5), new Vec3(-25, 64, 18), new Vec3(30, 70, -4)]) {
    const s = solveAim(input({ target: { x: to.x, y: to.y, z: to.z } }), world(floor), null);
    const b = bowAim(new Vec3(0.5, 64, 0.5), to);
    assert.ok(Math.abs(-s.pitch * RAD - b.pitch) < 0.05, `to ${to}: ${(-s.pitch * RAD).toFixed(3)} vs bowAim ${b.pitch}`);
    assert.equal(s.hit, 'target');
  }
});

test('solver: a moving target is led (to the release, then the flight), and the shooter\'s own movement is added', () => {
  // 0.2 blocks a tick across the line, 12 ticks to the release.
  const inp = input({ target: zombie(20.5, 0.5, { vz: 0.2 }), lead: 12 });
  const s = solveAim(inp, world(floor), null);
  assert.equal(s.hit, 'target');
  assert.ok(Math.abs(s.aim.z - (0.5 + 0.2 * (12 + s.ticks))) < 0.3, `aimed where it will be: z ${s.aim.z.toFixed(2)} after ${s.ticks.toFixed(1)} ticks of flight`);
  assert.ok(hits(s, inp));
  const still = solveAim(input({ target: zombie(20.5, 0.5) }), world(floor), null);
  assert.ok(!hits(still, inp), 'the unled aim misses it');
  // A shooter walking sideways (0.2 a tick): the arrow inherits it; the aim makes up for it.
  const walking = input({ target: zombie(20.5, 0.5), vel: { x: 0, y: 0, z: 0.2 } });
  const w = solveAim(walking, world(floor), null);
  assert.ok(hits(w, walking) && w.hit === 'target', 'with the drift added, still on target');
  assert.ok(!hits(still, walking), 'the aim of a still shooter misses');
});

test('solver: a horse archer riding across the line (8–14 b/s) hits at 30 and 50 blocks; the aim of a still shooter misses by 4–12 blocks; a start a tick off misses by the tick\'s ride (docs/47 §1)', () => {
  /** Where the arrow passes the target's x: its sideways miss (z). */
  const sideMiss = (sol: AimSolution, from: AimInput['from'], vel: AimInput['vel'], tx: number, tz: number): number => {
    const v = { x: -Math.sin(sol.yaw) * Math.cos(sol.pitch) * BOW_SPEED + vel.x, y: Math.sin(sol.pitch) * BOW_SPEED + vel.y, z: -Math.cos(sol.yaw) * Math.cos(sol.pitch) * BOW_SPEED + vel.z };
    const pts = [from, ...stepFlight(from, v, 200)];
    for (let k = 0; k + 1 < pts.length; k++) {
      if (pts[k + 1]!.x < tx) continue;
      const f = (tx - pts[k]!.x) / (pts[k + 1]!.x - pts[k]!.x);
      return pts[k]!.z + (pts[k + 1]!.z - pts[k]!.z) * f - tz;
    }
    return Infinity;
  };
  // A rider's eyes: the horse's seat (0.84375) + 1.62, the arrow 0.1 below.
  const from = { x: 0.5, y: 64 + 0.84375 + 1.62 - 0.1, z: 0.5 };
  const expected: Record<string, number> = { '30/0.4': 4.0, '30/0.7': 7.0, '50/0.4': 6.7, '50/0.7': 11.8 };
  for (const d of [30, 50]) {
    for (const side of [0.4, 0.7]) {
      const vel = { x: 0, y: 0, z: side };
      const tgt = zombie(from.x + d, from.z);
      const riding = input({ from, vel, target: tgt });
      const s = solveAim(riding, world(floor), null);
      assert.equal(s.hit, 'target', `${d} blocks, ${side * 20} b/s`);
      assert.ok(hits(s, riding));
      assert.ok(Math.abs(sideMiss(s, from, vel, tgt.x, tgt.z)) < 0.05);
      const still = solveAim(input({ from, target: tgt }), world(floor), null);
      const m = sideMiss(still, from, vel, tgt.x, tgt.z);
      assert.ok(Math.abs(m - expected[`${d}/${side}`]!) < 0.1, `${d} blocks, ${side * 20} b/s, own motion ignored: ${m.toFixed(2)} blocks`);
      assert.ok(!hits(still, riding));
      // The arrow starting one tick of the ride away from where the aim put it: off by that tick, at any range.
      const late = sideMiss(s, { ...from, z: from.z - side }, vel, tgt.x, tgt.z);
      assert.ok(Math.abs(late + side) < 0.02, `a tick behind: ${late.toFixed(2)}`);
    }
  }
});

test('solver: a wall in the way: the high arc over it; walled in: blocked (both arcs)', () => {
  const wall = (x: number, y: number, _z: number) => floor(x, y) || (x === 10 && y >= 64 && y <= 67);
  const inp = input({ target: zombie(20.5, 0.5) });
  const s = solveAim(inp, world(wall), null);
  assert.equal(s.arc, 'high');
  assert.equal(s.hit, 'target');
  assert.ok(s.clear && s.pitch > 0.8, `steep: ${(s.pitch * RAD).toFixed(1)}°`);
  assert.deepEqual([s.other?.arc, s.other?.hit], ['low', 'block']);
  assert.ok(hits(s, inp));
  // A roof over the archer too: nothing gets out.
  const box = (x: number, y: number, z: number) => wall(x, y, z) || y === 68;
  const b = solveAim(inp, world(box), null);
  assert.equal(b.clear, false);
  assert.equal(b.hit, 'block');
  assert.equal(b.block, STONE);
  assert.deepEqual([b.arc, b.other?.arc, b.other?.hit], ['low', 'high', 'block']);
});

test('solver: a friend in the line blocks (by id or by team; over it on the high arc only with overFriends); an enemy in the line is a hit; items and arrows are not in the way', () => {
  const inp = (over: Partial<AimInput> = {}) => input({ target: zombie(20.5, 0.5), ...over });
  const between = { x: 10.5, y: 64, z: 0.5 };
  const f1 = solveAim(inp({ friends: [7] }), world(floor), rows([{ id: 7, ...between }]));
  assert.deepEqual([f1.hit, f1.clear, f1.entity, f1.arc, f1.other], ['friend', false, 7, 'low', undefined], 'blocked: no high arc over a friend by default');
  const over = solveAim(inp({ friends: [7], overFriends: true }), world(floor), rows([{ id: 7, ...between }]));
  assert.deepEqual([over.arc, over.hit, over.clear, over.other?.arc, over.other?.hit], ['high', 'target', true, 'low', 'friend'], 'overFriends: over the friend');
  // A ceiling at y 70: no room for the high arc.
  const lowCeiling = world((x, y) => floor(x, y) || y === 70);
  const roofed = solveAim(inp({ friends: [7], overFriends: true }), lowCeiling, rows([{ id: 7, ...between }]));
  assert.deepEqual([roofed.hit, roofed.clear, roofed.other?.hit], ['friend', false, 'block']);
  // By team: the shooter's own row gives its team.
  const f2 = solveAim(inp(), lowCeiling, rows([{ id: 1, team: 3, x: 0.5, y: 64, z: 0.5 }, { id: 8, team: 3, ...between }]));
  assert.deepEqual([f2.hit, f2.entity], ['friend', 8]);
  // Another team, or a mob: a hit all the same.
  const e = solveAim(inp(), world(floor), rows([{ id: 1, team: 3, x: 0.5, y: 64, z: 0.5 }, { id: 9, team: 4, ...between }]));
  assert.deepEqual([e.hit, e.clear, e.entity], ['enemy', true, 9]);
  const mob = solveAim(inp(), world(floor), rows([{ id: 10, kind: 2, ...between }]));
  assert.deepEqual([mob.hit, mob.clear], ['enemy', true]);
  const neutral = solveAim(inp({ mobs: 'neutral' }), world(floor), rows([{ id: 10, kind: 2, ...between }]));
  assert.deepEqual([neutral.arc, neutral.other?.hit], ['high', 'entity'], "mobs: 'neutral' makes a mob an obstacle: over it");
  // An item (kind 0), an arrow (9): not in the way. A friend well beside the line: not either.
  const clear = solveAim(inp({ friends: [7] }), world(floor), rows([{ id: 11, kind: 0, ...between }, { id: 12, kind: 9, ...between }, { id: 7, x: 10.5, y: 64, z: 3 }]));
  assert.deepEqual([clear.hit, clear.clear], ['target', true]);
});

test('solver: unknown blocks count as air, and are counted', () => {
  const holes = (x: number) => x >= 5 && x <= 8;
  const s = solveAim(input({ target: zombie(20.5, 0.5) }), world((x, y) => floor(x, y) || (x === 6 && y >= 64 && y <= 67), (x) => holes(x)), null);
  assert.equal(s.hit, 'target', 'the wall in an unknown column is not seen');
  assert.ok(s.unknown >= 4, `${s.unknown} unknown voxels`);
  assert.equal(solveAim(input({ target: zombie(20.5, 0.5) }), world(floor), null).unknown, 0);
  // No world at all (a worker without the shared world): every tick unknown, still an answer.
  const none = solveAim(input({ target: zombie(20.5, 0.5) }), null, null);
  assert.ok(none.unknown > 0 && none.clear);
});

test('solver: warm-started from the last answer, an update takes a few flights', () => {
  const w = world(floor);
  const cold = solveAim(input({ target: zombie(22.5, 4.5, { vz: 0.15 }), lead: 14 }), w, null);
  let warm: AimInput['warm'] = { pitch: cold.pitch, arc: cold.arc, ticks: cold.ticks };
  const counts: number[] = [];
  for (let i = 1; i <= 10; i++) {
    // The target walked on a tick; the archer asks again.
    const s = solveAim(input({ target: zombie(22.5, 4.5 + 0.15 * i, { vz: 0.15 }), lead: 14 - i, warm }), w, null);
    assert.equal(s.hit, 'target');
    counts.push(s.flights);
    warm = { pitch: s.pitch, arc: s.arc, ticks: s.ticks };
  }
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  assert.ok(mean <= 6, `warm: ${counts.join(', ')} flights (cold: ${cold.flights})`);
  assert.ok(cold.flights <= 20, `cold: ${cold.flights} flights, against hawkEye's 380+`);
});

// -- the draw on the schedule ------------------------------------------------------------------------------------------

interface Submit {
  k: number;
  drawTick: number;
  deadlineTick: number;
  poolTick: number;
  input: AimInput;
  resolve(v: AimSolution): void;
  reject(e: unknown): void;
}

/** A solution that only says where to look: yaw 0.01 × its update tick. */
const answer = (k: number, over: Partial<AimSolution> = {}): AimSolution => ({
  yaw: 0.01 * k,
  pitch: -0.002 * k,
  arc: 'low',
  ticks: 8,
  hit: 'target',
  clear: true,
  at: null,
  entity: 50,
  block: -1,
  aim: { x: 0, y: 0, z: 0 },
  unknown: 0,
  flights: 3,
  outOfRange: false,
  ...over,
});

/** An archer ticked by hand, a fake job pool, and what each tick did. */
function bench() {
  const b = new FakeBot('Archer', { items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] }).archer({ tickMs: 0 });
  b.heldItem = { name: 'bow' };
  Object.assign(b.entity, { id: 1 });
  let activateTick = -1;
  const looks: Array<{ tick: number; yaw: number; pitch: number }> = [];
  const act = b.activateItem.bind(b);
  b.activateItem = (off?: boolean) => {
    activateTick = b.ticks;
    act(off);
  };
  b.look = async (yaw: number, pitch: number) => {
    looks.push({ tick: b.ticks, yaw, pitch });
    b.entity.yaw = yaw;
    b.entity.pitch = pitch;
  };
  const submits: Submit[] = [];
  const jobs = {
    currentTick: 100,
    submit<T>(spec: { type: string; input: unknown; priority?: number; deadlineTick?: number }): Promise<T> {
      assert.equal(spec.type, 'aim');
      return new Promise<T>((resolve, reject) => {
        submits.push({
          k: (spec.priority ?? 0) - AIM_PRIORITY,
          drawTick: activateTick < 0 ? -1 : b.ticks - activateTick,
          deadlineTick: spec.deadlineTick ?? Infinity,
          poolTick: jobs.currentTick,
          input: spec.input as AimInput,
          resolve: resolve as (v: AimSolution) => void,
          reject,
        });
      });
    },
  };
  configureAim({ ...DEFAULT_AIM, jobs, world: { dimensionOf: () => 'minecraft:overworld' }, fallbackTicks: false });
  const tick = async (): Promise<void> => {
    jobs.currentTick++;
    b.ticks++;
    b.emit('physicsTick');
    await new Promise((r) => setImmediate(r));
  };
  return { b, jobs, submits, looks, tick, drawTick: () => (activateTick < 0 ? -1 : b.ticks - activateTick) };
}

const target = () => ({ id: 50, name: 'zombie', type: 'hostile', position: new Vec3(20.5, 64, 0.5), height: 1.95, width: 0.6, isValid: true });

test('draw: update 0 before the draw, the others two ticks ahead of their tick, the turn arriving on each next update, the release on tick 24', async () => {
  const s = bench();
  try {
    const shot = shoot(s.b as never, target() as never);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(s.submits.map((x) => [x.k, x.drawTick]), [[0, -1]], 'update 0 is asked before anything is drawn');
    s.submits[0]!.resolve(answer(0));
    // Every job answered as soon as it is asked (on its deadline at the latest).
    for (let i = 0; i < 40 && s.b.releases.length === 0; i++) {
      await s.tick();
      for (const x of s.submits) if (x.k > 0 && !(x as { done?: boolean }).done) {
        (x as { done?: boolean }).done = true;
        x.resolve(answer(x.k));
      }
    }
    assert.deepEqual(await shot, { shot: true });
    const sched = DEFAULT_AIM.schedule.slice(1);
    assert.deepEqual(s.submits.slice(1).map((x) => x.k), sched, 'every update, in order');
    for (const x of s.submits.slice(1)) {
      assert.equal(x.drawTick, x.k - SUBMIT_AHEAD_TICKS, `update ${x.k} submitted two ticks ahead`);
      assert.equal(x.deadlineTick, x.poolTick + SUBMIT_AHEAD_TICKS, 'due two pool ticks after its submit');
      assert.ok(x.input.lead > 0 && x.input.lead <= DEFAULT_AIM.drawTicks + 2, `lead to the release: ${x.input.lead}`);
    }
    assert.ok(s.submits.every((x, i) => i === 0 || x.k > s.submits[i - 1]!.k), 'priorities rise toward the release');
    // The release: at tick 24 of the draw, once, at the last answer's look; one arrow gone.
    assert.equal(s.b.releases.length, 1);
    assert.equal(s.b.releases[0]!.drawnTicks, DEFAULT_AIM.drawTicks);
    assert.ok(Math.abs(s.b.releases[0]!.yaw - 0.23) < 1e-9, `flies at update 23's yaw: ${s.b.releases[0]!.yaw}`);
    // The look a tick carries, set the tick before: from 0 toward update 0's yaw (0) … then each update's yaw exactly
    // on the next update's tick. Keyed by the packet tick it was set for.
    const at = new Map<number, number>();
    for (const l of s.looks) at.set(l.tick, l.yaw);
    const drawStart = s.b.ticks - DEFAULT_AIM.drawTicks;
    const lookFor = (t: number) => at.get(drawStart + t - 1)!;
    for (const [k, next] of [[10, 11], [11, 12], [14, 20], [20, 21], [23, 24]] as const) {
      assert.ok(Math.abs(lookFor(next) - 0.01 * k) < 1e-9, `update ${k}'s yaw reached on tick ${next}: ${lookFor(next)}`);
    }
    // Between 14 and 20 the turn goes on from where it was when update 14 was taken (update 13's yaw).
    assert.ok(Math.abs(lookFor(17) - (0.13 + (0.14 - 0.13) * (17 - 14) / (20 - 14))) < 1e-9, `half way at tick 17: ${lookFor(17)}`);
    const st = aimStats(true);
    assert.equal(st.released, 1);
    assert.equal(st.solves.jobs, DEFAULT_AIM.schedule.length);
  } finally {
    configureAim({ jobs: null, world: null, fallbackTicks: true });
  }
});

test('draw: ticks that come in a burst at the release (a late event loop) still fly at a final aim, never mid-turn', async () => {
  const s = bench();
  const answerAll = (): void => {
    for (const x of s.submits) if (x.k > 0 && !(x as { done?: boolean }).done) {
      (x as { done?: boolean }).done = true;
      x.resolve(answer(x.k));
    }
  };
  try {
    const shot = shoot(s.b as never, target() as never);
    await new Promise((r) => setImmediate(r));
    s.submits[0]!.resolve(answer(0));
    while (s.drawTick() < 16) {
      await s.tick();
      answerAll();
    }
    // Eight physics ticks in one timer callback, as mineflayer catches up after a stall: the draw, mid-way through the
    // turn from update 14 to 20, next sees tick 24 (the release).
    for (let i = 0; i < 8; i++) {
      s.jobs.currentTick++;
      s.b.ticks++;
      s.b.emit('physicsTick');
    }
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 10 && s.b.releases.length === 0; i++) {
      answerAll();
      await s.tick();
    }
    assert.deepEqual(await shot, { shot: true });
    const r = s.b.releases[0]!;
    // The release's look is exactly one answer's (k × 0.01), not a value interpolated between two of them.
    const k = Math.round(r.yaw / 0.01);
    assert.ok(Math.abs(r.yaw - 0.01 * k) < 1e-9 && k >= 14, `flies at update ${k}'s yaw exactly: ${r.yaw}`);
    assert.ok(r.drawnTicks >= DEFAULT_AIM.drawTicks, `released at full draw (${r.drawnTicks} ticks)`);
    aimStats(true);
  } finally {
    configureAim({ jobs: null, world: null, fallbackTicks: true });
  }
});

test('draw: a moving shooter: the arrow starts where it is at the release and carries its movement; a rider\'s a tick behind its body (docs/47 §1)', async () => {
  for (const riding of [false, true]) {
    const s = bench();
    if (riding) Object.assign(s.b, { vehicle: { id: 31, name: 'horse', position: s.b.entity.position.clone() } });
    let atRelease: Vec3 | null = null;
    const deactivate = s.b.deactivateItem.bind(s.b);
    s.b.deactivateItem = () => {
      atRelease = s.b.entity.position.clone();
      deactivate();
    };
    try {
      const shot = shoot(s.b as never, target() as never);
      await new Promise((r) => setImmediate(r));
      s.submits[0]!.resolve(answer(0));
      // Half a block a tick across the line (10 b/s, a horse's canter), moved before each tick's packet.
      for (let i = 0; i < 40 && s.b.releases.length === 0; i++) {
        s.b.entity.position = s.b.entity.position.offset(0, 0, 0.5);
        await s.tick();
        for (const x of s.submits) if (x.k > 0 && !(x as { done?: boolean }).done) {
          (x as { done?: boolean }).done = true;
          x.resolve(answer(x.k));
        }
      }
      assert.deepEqual(await shot, { shot: true });
      const last = s.submits.at(-1)!;
      assert.equal(last.k, DEFAULT_AIM.schedule.at(-1), 'the last update flew');
      assert.ok(Math.abs(last.input.vel.z - 0.5) < 1e-9, `its movement: ${last.input.vel.z}`);
      const start = atRelease!.z - (riding ? 0.5 : 0);
      assert.ok(Math.abs(last.input.from.z - start) < 1e-9, `${riding ? 'riding' : 'on foot'}: from z ${last.input.from.z}, expected ${start}`);
    } finally {
      configureAim({ jobs: null, world: null, fallbackTicks: true });
    }
  }
});

test('draw: a late answer keeps the last aim (the release is still on tick 24)', async () => {
  const s = bench();
  try {
    const shot = shoot(s.b as never, target() as never);
    await new Promise((r) => setImmediate(r));
    s.submits[0]!.resolve(answer(0));
    for (let i = 0; i < 40 && s.b.releases.length === 0; i++) {
      await s.tick();
      for (const x of s.submits) if (x.k > 0 && !(x as { done?: boolean }).done) {
        (x as { done?: boolean }).done = true;
        if (x.k === 23) x.reject(new JobLateError('aim', x.deadlineTick, x.deadlineTick + 1));
        else x.resolve(answer(x.k));
      }
    }
    await shot;
    assert.equal(s.b.releases[0]!.drawnTicks, 24);
    assert.ok(Math.abs(s.b.releases[0]!.yaw - 0.22) < 1e-9, `update 23 was late: the release flies at update 22's look (${s.b.releases[0]!.yaw})`);
    assert.equal(aimStats(true).solves.late, 1);
  } finally {
    configureAim({ jobs: null, world: null, fallbackTicks: true });
  }
});

/** Drive the bench's ticks, answering every job as soon as it is asked with `answerFor(k)`, until `done()`. */
async function run(s: ReturnType<typeof bench>, answerFor: (k: number) => AimSolution, done: () => boolean, max = 80): Promise<void> {
  for (let i = 0; i < max && !done(); i++) {
    await s.tick();
    for (const x of s.submits) {
      if ((x as { done?: boolean }).done) continue;
      (x as { done?: boolean }).done = true;
      x.resolve(answerFor(x.k));
    }
  }
}

test('draw: a wall before the draw: refused at once, nothing drawn; « no clear line of fire »', async () => {
  const s = bench();
  try {
    Object.assign(s.b.registry, { blocksByStateId: { [STONE]: { name: 'stone' } } });
    const shot = assert.rejects(shoot(s.b as never, target() as never), /no clear line of fire: stone is in the way at \(10, 65, 1\), shooting at zombie/);
    await new Promise((r) => setImmediate(r));
    s.submits[0]!.resolve(answer(0, { hit: 'block', clear: false, block: STONE, at: { x: 10, y: 65, z: 0.5 } }));
    await s.tick();
    await shot;
    assert.ok(!s.b.calls.includes('activateItem'), 'nothing drawn');
    assert.equal(aimStats(true).refused.block, 1);
  } finally {
    configureAim({ jobs: null, world: null, fallbackTicks: true });
  }
});

test('draw: a friend in the line: drawn anyway; still there after the hold, put down unfired; out of the line, released', async () => {
  const s = bench();
  try {
    s.b.entities = { 7: { id: 7, type: 'player', username: 'Mate', position: new Vec3(10, 64, 0.5) } };
    const friend = (k: number) => answer(k, { hit: 'friend', clear: false, entity: 7, at: { x: 10, y: 65, z: 0.5 } });
    const blocked = assert.rejects(shoot(s.b as never, target() as never), /no clear line of fire: a friend is in the way \(Mate at \(10, 65, 1\)\).*\(put down unfired\)/);
    await new Promise((r) => setImmediate(r));
    s.submits[0]!.resolve(friend(0));
    await run(s, friend, () => s.b.calls.includes('setQuickBarSlot(1)'));
    await blocked;
    assert.ok(s.b.calls.includes('activateItem'), 'drawn although update 0 saw the friend');
    assert.equal(s.b.releases.length, 0, 'no arrow fired');
    assert.deepEqual(s.b.calls.filter((c) => c.startsWith('setQuickBarSlot')), ['setQuickBarSlot(1)', 'setQuickBarSlot(0)'], 'a hotbar switch away and back');
    assert.equal(s.drawTick(), DEFAULT_AIM.drawTicks + HOLD_TICKS, `held ${HOLD_TICKS} ticks past the release`);
    assert.ok(s.submits.some((x) => x.k > DEFAULT_AIM.drawTicks), 'asked again while held');
    let st = aimStats(true);
    assert.deepEqual([st.drawnBlocked, st.held, st.cancelled.blocked, st.released], [1, 1, 1, 0]);

    // The friend steps out of the line two ticks after the release: the next answer is clear, the arrow leaves.
    const s2 = bench();
    const out = DEFAULT_AIM.drawTicks + 2;
    const shot = shoot(s2.b as never, target() as never);
    await new Promise((r) => setImmediate(r));
    s2.submits[0]!.resolve(friend(0));
    await run(s2, (k) => (k >= out ? answer(k) : friend(k)), () => s2.b.releases.length > 0);
    assert.deepEqual(await shot, { shot: true });
    const drawn = s2.b.releases[0]!.drawnTicks;
    assert.ok(drawn > DEFAULT_AIM.drawTicks && drawn <= out + SUBMIT_AHEAD_TICKS + 2, `released ${drawn} ticks in, once clear`);
    assert.ok(Math.abs(s2.b.releases[0]!.yaw - 0.01 * s2.submits.find((x) => x.k >= out)!.k) < 1e-9, 'at the clear answer');
    st = aimStats(true);
    assert.deepEqual([st.held, st.released], [1, 1]);
  } finally {
    configureAim({ jobs: null, world: null, fallbackTicks: true });
  }
});

test('draw: a target that dies mid-draw: the draw goes on and is released at the last aim', async () => {
  const s = bench();
  try {
    const z = target();
    const shot = shoot(s.b as never, z as never);
    await new Promise((r) => setImmediate(r));
    s.submits[0]!.resolve(answer(0));
    await run(s, (k) => answer(k), () => s.drawTick() >= 11);
    z.isValid = false;
    const asked = s.submits.length;
    await run(s, (k) => answer(k), () => s.b.releases.length > 0);
    assert.deepEqual(await shot, { shot: true });
    assert.equal(s.b.releases[0]!.drawnTicks, DEFAULT_AIM.drawTicks);
    assert.ok(s.submits.length <= asked + 1, 'nothing more asked about a dead target');
    assert.ok(Math.abs(s.b.releases[0]!.yaw - 0.01 * s.submits.at(-1)!.k) < 1e-9, 'at the last aim it had');
    assert.equal(aimStats(true).lost, 1);
  } finally {
    configureAim({ jobs: null, world: null, fallbackTicks: true });
  }
});

test('draw: auto-eat taking the hand drops the draw (« interrupted »); a stuck isEating with the bow in hand does not', async () => {
  const s = bench();
  try {
    const ae = { isEating: true };
    Object.assign(s.b, { autoEat: ae });
    const shot = shoot(s.b as never, target() as never);
    await new Promise((r) => setImmediate(r));
    s.submits[0]!.resolve(answer(0));
    await run(s, (k) => answer(k), () => s.b.releases.length > 0);
    assert.deepEqual(await shot, { shot: true }, 'isEating stuck at true (auto-eat 5 leaves it set after a failed equip): ignored');
    s.submits.length = 0;
    const eaten = assert.rejects(shoot(s.b as never, target() as never), /the draw was interrupted \(cooked_beef in hand/);
    await new Promise((r) => setImmediate(r));
    s.submits[0]!.resolve(answer(0));
    await run(s, (k) => answer(k), () => s.b.calls.filter((c) => c === 'activateItem').length >= 2 && s.drawTick() >= 5);
    s.b.heldItem = { name: 'cooked_beef' };
    await s.tick();
    await eaten;
    assert.deepEqual(aimStats(true).lowered, { cooked_beef: 1 });
  } finally {
    configureAim({ jobs: null, world: null, fallbackTicks: true });
  }
});

// -- inline, no pool ---------------------------------------------------------------------------------------------------

/** A bot's own world as prismarine-world has it: columns with getBlockStateId (chunk-local x, z). */
function botWorldOf(solid: (x: number, y: number, z: number) => boolean) {
  return {
    getColumn: (cx: number, cz: number) => ({
      getBlockStateId: (p: { x: number; y: number; z: number }) => (solid(cx * 16 + p.x, p.y, cz * 16 + p.z) ? STONE : 0),
    }),
  };
}

test('inline (no pool, no shared world): solved on the main thread over the bot\'s own world; a wall sends it over, a roof blocks it', async () => {
  configureAim({ ...DEFAULT_AIM, jobs: null, world: null, fallbackTicks: true });
  aimStats(true);
  const archer = (solid: (x: number, y: number, z: number) => boolean) => {
    const b = new FakeBot('Archer', { position: new Vec3(0.5, 64, 0.5), items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] }).archer();
    Object.assign(b, { version: '1.21.1', world: botWorldOf(solid) });
    Object.assign(b.registry, { blocksByStateId: { [STONE]: { name: 'stone' } } });
    Object.assign(b.entity, { id: 1, eyeHeight: 1.62, onGround: true });
    return b;
  };
  const wall = (x: number, y: number, _z: number) => y <= 63 || (x === 10 && y >= 64 && y <= 67);
  const a = archer(wall);
  try {
    assert.deepEqual(await shoot(a as never, target() as never), { shot: true });
    assert.equal(a.releases.length, 1);
    assert.ok(a.releases[0]!.pitch > 0.8, `the high arc over the wall: ${(a.releases[0]!.pitch * RAD).toFixed(1)}°`);
    const st = aimStats(true);
    assert.equal(st.mode, 'inline');
    // Each update on its own tick; a burst of catch-up ticks (the fake's, mineflayer's) can skip some.
    assert.ok(st.solves.inline >= 2 && st.solves.inline <= DEFAULT_AIM.schedule.length, `${st.solves.inline} inline solves`);
    assert.equal(st.highArc, 1);
    assert.ok((st.inlineUs.p50 ?? 0) < 5_000, `an inline solve: ${st.inlineUs.p50} µs`);
  } finally {
    a.stopTicks();
  }
  const r = archer((x, y, z) => wall(x, y, z) || y === 68);
  try {
    await assert.rejects(shoot(r as never, target() as never), /no clear line of fire: stone is in the way at \(10, \d+, 1\) \(the high arc too\)/);
    assert.ok(!r.calls.includes('activateItem'));
  } finally {
    r.stopTicks();
    aimStats(true);
  }
});

test("inline: the order's friends are friends (by name through the bot's players): held, put down, shot once out of the line", async () => {
  configureAim({ ...DEFAULT_AIM, jobs: null, world: null, fallbackTicks: true });
  const b = new FakeBot('Archer', { position: new Vec3(0.5, 64, 0.5), items: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 10 }] }).archer();
  Object.assign(b.entity, { id: 1 });
  // A ceiling at y 70: no high arc over the friend.
  Object.assign(b, { version: '1.21.1', world: botWorldOf((_x, y) => y <= 63 || y === 70) });
  const mate = { id: 7, type: 'player', username: 'Mate', position: new Vec3(10.5, 64, 0.5), isValid: true, width: 0.6, height: 1.8 };
  b.entities = { 7: mate };
  b.players = { Mate: { entity: mate } };
  (b as unknown as Record<symbol, unknown>)[ORDER] = { friends: new Set(['Mate', 'Archer']), log: () => undefined };
  try {
    await assert.rejects(shoot(b as never, target() as never), /no clear line of fire: a friend is in the way \(Mate.*\(put down unfired\)/);
    assert.equal(b.releases.length, 0, 'drawn, held, put down: nothing fired');
    mate.position = new Vec3(10.5, 64, 6);
    assert.deepEqual(await shoot(b as never, target() as never), { shot: true }, 'stepped out of the line');
  } finally {
    b.stopTicks();
    aimStats(true);
  }
});

// -- the aim job on the real pool ------------------------------------------------------------------------------------

for (const workers of [1, 0]) {
  test(`the aim job: ${workers ? 'a reader worker' : "the pool's inline fallback"} runs it over the shared world (STOCK_HANDLERS)`, async () => {
    const { JobPool } = await import('../src/jobs/pool');
    const { SharedWorld } = await import('../src/world/shared-world');
    const { STOCK_HANDLERS } = await import('../src/jobs/handlers/index');
    const world = new SharedWorld({ version: '1.21.1', cacheSeconds: 60, cacheColumns: 100, maxReaders: 8 });
    const jobs = new JobPool({ workers, handlers: STOCK_HANDLERS, ticks: 'manual', version: '1.21.1', world, worldModule: new URL('../src/world/reader.mjs', import.meta.url) });
    try {
      await jobs.ready();
      const p = jobs.submit<AimSolution>({ type: 'aim', input: input({ dim: 'minecraft:overworld', target: zombie(20.5, 0.5) }), priority: AIM_PRIORITY });
      let done = false;
      void p.then(() => (done = true), () => (done = true));
      for (let i = 0; i < 200 && !done; i++) {
        await jobs.tick();
        await new Promise((r) => setTimeout(r, 3));
      }
      const s = await p;
      assert.equal(s.hit, 'target');
      assert.ok(s.unknown > 0, 'no column held: every block unknown, counted');
      assert.equal(jobs.stats().types.aim?.done, 1);
    } finally {
      await jobs.stop();
      await world.stop();
    }
  });
}

test('config: aim.schedule, aim.drawTicks and aim.overFriends, defaulted and checked', async () => {
  const { parseConfig } = await import('../src/config');
  const env = { PAULSBRAWLS_SQUAD_TOKEN: 't' };
  assert.deepEqual(parseConfig({}, env).aim, { schedule: [0, 10, 11, 12, 13, 14, 20, 21, 22, 23], drawTicks: 24, overFriends: true });
  assert.deepEqual(parseConfig({ aim: { schedule: [0, 12, 22], drawTicks: 30, overFriends: false } }, env).aim, { schedule: [0, 12, 22], drawTicks: 30, overFriends: false });
  assert.throws(() => parseConfig({ aim: { overFriends: 'yes' } }, env), /aim.overFriends must be true or false/);
  assert.throws(() => parseConfig({ aim: { schedule: [10, 20] } }, env), /aim.schedule must be increasing integer ticks from 0/);
  assert.throws(() => parseConfig({ aim: { schedule: [0, 20, 12] } }, env), /aim.schedule/);
  assert.throws(() => parseConfig({ aim: { schedule: [0, 24] } }, env), /each below aim.drawTicks \(24\)/);
  assert.throws(() => parseConfig({ aim: { drawTicks: 15 } }, env), /aim.drawTicks must be an integer from 21/);
});
