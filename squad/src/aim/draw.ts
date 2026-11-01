// One bow draw on Paul's schedule (docs/37 §3, D5), main thread: the look, the draw, the release; the aim itself is
// solved by aim/solve.mjs, as `aim` jobs on the reader workers when there is a job pool and a shared world, else
// here, synchronously, over the bot's own world (aim/inline.ts).
//
// The clock is the bot's own physics ticks (with a 50 ms fallback when they stop: a fake, a paused physics). The
// loop runs after each tick's position packet, so a look set there goes out with the NEXT tick's packet; the bow's
// release (block_dig, sent at once) at tick R therefore flies at the look set at tick R − 1.
//   • Update 0 is solved before the draw: a wall in the line (both arcs) is refused at once, with no arrow drawn (the
//     command steps aside), instead of hawkEye's 1.45 s with the bow drawn and a hand-aimed shot.
//   • The draw starts on the next tick (tick 0): use_item. The updates of `aim.schedule` (tick 0, 10, 11–14, 20–23)
//     are each submitted SUBMIT_AHEAD_TICKS before their tick (a job's answer comes two ticks after its submit at
//     most, docs/37 §8.4) and taken on their tick; solved inline, they are solved on their tick.
//   • Turning: every tick, the look is interpolated from where it was when the newest answer was taken to that
//     answer, arriving exactly on the next update's tick (the release for the last one).
//   • An answer that is late (or fails) keeps the last aim. The release is at `aim.drawTicks` (24) whatever came,
//     unless the line is blocked then.
//   • Update 0 blocked by a friend: drawn anyway, since friends move (a friend blocks unless aim.overFriends lets the
//     high arc go over it). At the release the answer must be clear; otherwise the draw is held, asked again every tick,
//     for HOLD_TICKS, then put down without firing (a hotbar switch away and back: the server drops the use, no
//     arrow) and the shot is refused. A target that dies or leaves mid-draw is shot at the last aim (`lost`); with a
//     blocked last aim, put down (`gone`). auto-eat is paused for the draw; a draw something else interrupted (the
//     hand changed) is `lowered`.
// Each solve leads the target to where it will be at the release plus the flight: its velocity is a least-squares
// slope over its last positions (kept per entity across shots), because the server sends a player's position every
// 2 ticks and a mob's every 3: a one-tick velocity (the entity snapshot's) reads 0, 0, 3v.
//
// A crossbow: charged for CROSSBOW_CHARGE_TICKS + 2 ticks, then fired by use_item, which carries the look in 1.21.1
// (the server takes the rotation from the packet): the late updates move with the fire tick.

import { performance } from 'node:perf_hooks';

import type { Bot } from 'mineflayer';

import { DEFAULT_AIM, type AimConfig } from '../config';
import { logger } from '../logger';
import { orderOf, unwrap } from '../orders/guard';
import { BOW_SPEED, CROSSBOW_SPEED, EYE_DROP } from './arrow.mjs';
import { botEntities, botWorld } from './inline';
import { solveAim, type AimInput, type AimSolution, type AimTarget, type XYZ } from './solve.mjs';

/** A job's answer is applied at most two ticks after its submit (docs/37 §8.4). */
export const SUBMIT_AHEAD_TICKS = 2;
/** The server reads the release, then spawns the arrow: about a tick. */
const RELEASE_LATENCY_TICKS = 1;
/** A crossbow is loaded after 25 ticks of use (CrossbowItem.getPullTime, no Quick Charge). */
export const CROSSBOW_CHARGE_TICKS = 25;
/** Priority of an aim job: above paths and block searches; within a draw, later updates (nearer the release) first. */
export const AIM_PRIORITY = 100;
const TICK_MS = 50;
/** No physicsTick for this long: the clock ticks every 50 ms on its own. */
const CLOCK_GRACE_MS = 75;
/** Past the release, a draw waits this long for a clear line (a friend stepping out of it), then is put down. */
export const HOLD_TICKS = 20;
/** Ticks the first update may take on the pool before the draw solves it here instead. */
const FIRST_WAIT_TICKS = 4;
/** A target's positions kept for its velocity, and how old they may be. */
const TRACK_SAMPLES = 16;
const TRACK_MS = 800;
/** A move longer than this between two samples is a teleport or a respawn: the history starts again. */
const TRACK_JUMP = 4;
/** No lead faster than this (blocks per tick, a sprint-jump is ~0.35). */
const MAX_LEAD_SPEED = 0.6;
/** Lead-error samples kept for aimStats. */
const LEAD_SAMPLES = 4096;

export type Weapon = 'bow' | 'crossbow';

/** The job pool as the aim uses it (jobs/pool.ts JobPool). */
export interface AimJobs {
  submit<T>(spec: { type: string; input: unknown; priority?: number; deadlineTick?: number }): Promise<T>;
  readonly currentTick: number;
}

/** The shared world as the aim uses it (world/shared-world.ts SharedWorld). */
export interface AimSharedWorld {
  dimensionOf(bot: unknown): string | null;
}

interface AimRuntime extends AimConfig {
  jobs: AimJobs | null;
  world: AimSharedWorld | null;
  /** Tick every 50 ms when the bot's physics ticks stop (off only in tests that tick by hand). */
  fallbackTicks: boolean;
}

let runtime: AimRuntime = { ...DEFAULT_AIM, schedule: [...DEFAULT_AIM.schedule], jobs: null, world: null, fallbackTicks: true };

/**
 * Set the aim's config and, when both exist, the job pool and the shared world it solves on (main.ts, once at start;
 * tests). Without both, every aim is solved inline over the bot's own world: the workers see blocks only through the
 * shared world.
 */
export function configureAim(r: Partial<AimRuntime>): void {
  runtime = { ...runtime, ...r };
}

/** Where the aims are solved now. */
export function aimMode(): 'jobs' | 'inline' {
  return runtime.jobs && runtime.world ? 'jobs' : 'inline';
}

// -- stats -----------------------------------------------------------------------------------------------------------

export interface AimStats {
  mode: 'jobs' | 'inline';
  /** Shots asked (shoot calls that got to aim). */
  shots: number;
  /** Draws started (use_item sent) and arrows released. */
  draws: number;
  released: number;
  /** Refused before the draw: the first answer was blocked. */
  refused: Record<'friend' | 'block' | 'entity', number>;
  /** Draws put down without firing: still blocked HOLD_TICKS after the release, or the target gone with a blocked aim. */
  cancelled: { blocked: number; gone: number };
  /** Draws started although update 0 saw a friend in the line (it may step out before the release). */
  drawnBlocked: number;
  /** Draws held past the release, waiting for a clear line. */
  held: number;
  /** Draws whose target died or left: released at the last aim. */
  lost: number;
  /** Draws the bot interrupted itself, by what took the hand (auto-eat's food). */
  lowered: Record<string, number>;
  /** Shots released on the high arc. */
  highArc: number;
  solves: { inline: number; jobs: number; late: number; failed: number; firstFallback: number };
  /** Flights per solve (closed-form pitch search + checked flights). */
  flightsPerSolve: number | null;
  /** Main-thread time of an inline solve. */
  inlineUs: { p50: number | null; p95: number | null };
  /** Answers that met unknown blocks (no live column). */
  unknownAnswers: number;
  /**
   * How far (horizontally, blocks) the target was from where the lead predicted when the arrow got there, for the
   * lead used (least-squares velocity), a one-tick velocity (the snapshot's), and no lead at all.
   */
  leadError: Record<'smoothed' | 'oneTick' | 'none', { n: number; p50: number | null; p95: number | null }>;
}

const blank = () => ({
  shots: 0,
  draws: 0,
  released: 0,
  refused: { friend: 0, block: 0, entity: 0 },
  cancelled: { blocked: 0, gone: 0 },
  drawnBlocked: 0,
  held: 0,
  lost: 0,
  lowered: {} as Record<string, number>,
  highArc: 0,
  solves: { inline: 0, jobs: 0, late: 0, failed: 0, firstFallback: 0 },
  flights: 0,
  answers: 0,
  unknownAnswers: 0,
  inlineUs: [] as number[],
  lead: { smoothed: [] as number[], oneTick: [] as number[], none: [] as number[] },
});
let counters = blank();
let warnedFailure = false;

const pct = (xs: number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]! * 100) / 100;
};

/** The aim's counters since the last reset (the fight bench reads them). */
export function aimStats(reset = false): AimStats {
  const c = counters;
  const out: AimStats = {
    mode: aimMode(),
    shots: c.shots,
    draws: c.draws,
    released: c.released,
    refused: { ...c.refused },
    cancelled: { ...c.cancelled },
    drawnBlocked: c.drawnBlocked,
    held: c.held,
    lost: c.lost,
    lowered: { ...c.lowered },
    highArc: c.highArc,
    solves: { ...c.solves },
    flightsPerSolve: c.answers ? Math.round((c.flights / c.answers) * 100) / 100 : null,
    inlineUs: { p50: pct(c.inlineUs, 0.5), p95: pct(c.inlineUs, 0.95) },
    unknownAnswers: c.unknownAnswers,
    leadError: {
      smoothed: { n: c.lead.smoothed.length, p50: pct(c.lead.smoothed, 0.5), p95: pct(c.lead.smoothed, 0.95) },
      oneTick: { n: c.lead.oneTick.length, p50: pct(c.lead.oneTick, 0.5), p95: pct(c.lead.oneTick, 0.95) },
      none: { n: c.lead.none.length, p50: pct(c.lead.none, 0.5), p95: pct(c.lead.none, 0.95) },
    },
  };
  if (reset) counters = blank();
  return out;
}

const keep = (xs: number[], v: number): void => {
  if (xs.length < LEAD_SAMPLES) xs.push(v);
  else xs[Math.floor(Math.random() * LEAD_SAMPLES)] = v;
};

// -- the clock -------------------------------------------------------------------------------------------------------

interface TickSource {
  on(event: 'physicsTick', fn: () => void): unknown;
  removeListener(event: 'physicsTick', fn: () => void): unknown;
}

const clocks = new Set<TickClock>();
let fallbackTimer: ReturnType<typeof setInterval> | undefined;

/** The bot's physics ticks as a counter to await; ticks on its own every 50 ms when they stop for 75 ms. */
class TickClock {
  n = 0;
  private last = performance.now();
  private waiters: Array<() => void> = [];
  private readonly onTick = (): void => {
    this.last = performance.now();
    this.bump();
  };

  constructor(
    private readonly src: TickSource | null,
    fallback = true,
  ) {
    src?.on('physicsTick', this.onTick);
    if (!fallback) return;
    clocks.add(this);
    if (!fallbackTimer) {
      fallbackTimer = setInterval(fallbackTicks, TICK_MS);
      fallbackTimer.unref();
    }
  }

  /** Resolves after the next tick (several ticks may have passed: read `n`). */
  next(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }

  check(now: number): void {
    if (now - this.last < CLOCK_GRACE_MS) return;
    this.last = now - (CLOCK_GRACE_MS - TICK_MS);
    this.bump();
  }

  stop(): void {
    this.src?.removeListener('physicsTick', this.onTick);
    clocks.delete(this);
    if (clocks.size === 0 && fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = undefined;
    }
    this.bump();
  }

  private bump(): void {
    this.n++;
    if (this.waiters.length === 0) return;
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
}

function fallbackTicks(): void {
  const now = performance.now();
  for (const c of clocks) c.check(now);
}

// -- the target's velocity -------------------------------------------------------------------------------------------

interface Track {
  t: number[];
  x: number[];
  y: number[];
  z: number[];
}

/** Per entity object (each bot sees its own), so a target's history carries over from one shot to the next. */
const tracks = new WeakMap<object, Track>();

function sampleTrack(e: object, p: XYZ, now: number): Track {
  let tr = tracks.get(e);
  if (!tr) tracks.set(e, (tr = { t: [], x: [], y: [], z: [] }));
  const n = tr.t.length;
  if (n > 0 && Math.hypot(p.x - tr.x[n - 1]!, p.z - tr.z[n - 1]!) > TRACK_JUMP) tr.t.length = tr.x.length = tr.y.length = tr.z.length = 0;
  while (tr.t.length > 0 && (now - tr.t[0]! > TRACK_MS || tr.t.length >= TRACK_SAMPLES)) {
    tr.t.shift();
    tr.x.shift();
    tr.y.shift();
    tr.z.shift();
  }
  tr.t.push(now);
  tr.x.push(p.x);
  tr.y.push(p.y);
  tr.z.push(p.z);
  return tr;
}

/** Blocks per tick: the least-squares slope over the track (≥ 3 samples over ≥ 2 ticks), else 0. */
function smoothedVelocity(tr: Track | null): { vx: number; vz: number } {
  if (!tr || tr.t.length < 3) return { vx: 0, vz: 0 };
  const n = tr.t.length;
  const t0 = tr.t[0]!;
  if ((tr.t[n - 1]! - t0) / TICK_MS < 2) return { vx: 0, vz: 0 };
  let st = 0;
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    st += (tr.t[i]! - t0) / TICK_MS;
    sx += tr.x[i]!;
    sz += tr.z[i]!;
  }
  const mt = st / n;
  const mx = sx / n;
  const mz = sz / n;
  let num = 0;
  let nz = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dt = (tr.t[i]! - t0) / TICK_MS - mt;
    num += dt * (tr.x[i]! - mx);
    nz += dt * (tr.z[i]! - mz);
    den += dt * dt;
  }
  if (!(den > 0)) return { vx: 0, vz: 0 };
  return clampSpeed(num / den, nz / den);
}

/** The one-tick velocity the entity snapshot would give: the last two samples. */
function oneTickVelocity(tr: Track | null): { vx: number; vz: number } {
  if (!tr || tr.t.length < 2) return { vx: 0, vz: 0 };
  const n = tr.t.length;
  const dt = (tr.t[n - 1]! - tr.t[n - 2]!) / TICK_MS;
  if (!(dt > 0.2)) return { vx: 0, vz: 0 };
  return clampSpeed((tr.x[n - 1]! - tr.x[n - 2]!) / dt, (tr.z[n - 1]! - tr.z[n - 2]!) / dt);
}

function clampSpeed(vx: number, vz: number): { vx: number; vz: number } {
  const s = Math.hypot(vx, vz);
  return s > MAX_LEAD_SPEED ? { vx: (vx / s) * MAX_LEAD_SPEED, vz: (vz / s) * MAX_LEAD_SPEED } : { vx, vz };
}

// -- the draw --------------------------------------------------------------------------------------------------------

/** What is read of the target entity. */
export interface AimEntity {
  id?: number;
  position: XYZ;
  width?: number;
  height?: number;
  isValid?: boolean;
}

/** How a draw ended. `released`: the release (or the crossbow's fire) was sent; the caller sees the arrow leave. */
export type DrawEnd =
  | { kind: 'released'; sol: AimSolution }
  | { kind: 'blocked'; sol: AimSolution; drawn: boolean }
  | { kind: 'gone' }
  | { kind: 'lowered'; held: string | null };

interface ShooterBot {
  entity: { id: number; position: XYZ; yaw: number; pitch: number; onGround?: boolean; eyeHeight?: number };
  heldItem?: { name: string } | null;
  quickBarSlot?: number;
  players?: Record<string, { entity?: { id?: number } } | undefined>;
  autoEat?: { isEating?: boolean; enabled?: boolean; disableAuto?: () => void; enableAuto?: () => void };
  on(event: 'physicsTick', fn: () => void): unknown;
  removeListener(event: 'physicsTick', fn: () => void): unknown;
}

interface Plan {
  updates: number[];
  release: number;
  /** A crossbow's tick to stop using it (loaded); -1 for a bow. */
  charge: number;
}

/** Crossbows already loaded by a draw that did not fire (their next use fires at once). */
const loaded = new WeakSet<object>();

function planFor(weapon: Weapon, rt: AimConfig, preloaded: boolean): Plan {
  if (weapon === 'bow') return { updates: rt.schedule, release: rt.drawTicks, charge: -1 };
  if (preloaded) return { updates: rt.schedule, release: rt.drawTicks, charge: -1 };
  const fire = CROSSBOW_CHARGE_TICKS + 4;
  const shift = fire - rt.drawTicks;
  return { updates: rt.schedule.map((k) => (k > rt.drawTicks / 2 ? k + shift : k)), release: fire, charge: CROSSBOW_CHARGE_TICKS + 2 };
}

/** The next update after tick t (the release after the last one). */
function nextUpdate(plan: Plan, t: number): number {
  for (const k of plan.updates) if (k > t) return k;
  return plan.release;
}

interface Turn {
  y0: number;
  p0: number;
  y1: number;
  p1: number;
  a: number;
  b: number;
}

function wrapAngle(a: number): number {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
}

function lookAlong(bot: Bot, turn: Turn, t: number): void {
  const f = turn.b > turn.a ? Math.min(1, Math.max(0, (t - turn.a) / (turn.b - turn.a))) : 1;
  const yaw = turn.y0 + wrapAngle(turn.y1 - turn.y0) * f;
  const pitch = turn.p0 + (turn.p1 - turn.p0) * f;
  // Forced: the yaw goes out exactly as set, with the next tick's packet, with no per-tick turn limit of its own.
  void bot.look(yaw, pitch, true)?.catch?.(() => undefined);
}

/** Put a drawn bow down without firing: a hotbar switch away and back makes the server drop the use. */
function putDown(bot: Bot, real: ShooterBot): void {
  const s = real.quickBarSlot;
  const b = bot as unknown as { setQuickBarSlot?: (n: number) => void };
  if (typeof s !== 'number' || typeof b.setQuickBarSlot !== 'function') return;
  b.setQuickBarSlot((s + 1) % 9);
  b.setQuickBarSlot(s);
}

/** The order's friends (isFriend's players) as entity ids this bot sees. */
function friendIds(bot: Bot, real: ShooterBot): number[] {
  const names = orderOf<{ friends?: Set<string> }>(bot)?.friends;
  if (!names || names.size === 0) return [];
  const out: number[] = [];
  for (const n of names) {
    const id = real.players?.[n]?.entity?.id;
    if (typeof id === 'number' && id !== real.entity.id) out.push(id);
  }
  return out;
}

/**
 * Draw, aim on the schedule, release. `bot` is the (guarded) bot the command holds: its calls check the lease, so a
 * BotLeftError / OrderStoppedError comes out of here as it is.
 */
export async function drawShot(bot: Bot, at: { entity: AimEntity | null; point: XYZ | null }, opts: { weapon: Weapon }): Promise<DrawEnd> {
  const real = unwrap(bot) as unknown as ShooterBot;
  const rt = runtime;
  const weapon = opts.weapon;
  const speed = weapon === 'crossbow' ? CROSSBOW_SPEED : BOW_SPEED;
  const preloaded = weapon === 'crossbow' && loaded.has(real);
  const plan = planFor(weapon, rt, preloaded);
  const dim = rt.jobs && rt.world ? rt.world.dimensionOf(real) : null;
  const jobs = dim !== null ? rt.jobs : null;
  const ahead = jobs ? SUBMIT_AHEAD_TICKS : 0;
  const friends = friendIds(bot, real);
  const ent = at.entity;
  const clock = new TickClock(real, rt.fallbackTicks);
  counters.shots++;

  /** The answers by update tick. */
  const answers = new Map<number, AimSolution>();
  let newestK = -1;
  let drawStart = -1;
  let finished = false;
  let eatPaused = false;
  let selfPrev = { n: clock.n, x: real.entity.position.x, y: real.entity.position.y, z: real.entity.position.z };
  let selfVel = { x: 0, y: 0, z: 0 };
  let track: Track | null = null;

  const sample = (): void => {
    const p = real.entity.position;
    if (clock.n > selfPrev.n) {
      const d = clock.n - selfPrev.n;
      selfVel = { x: (p.x - selfPrev.x) / d, y: (p.y - selfPrev.y) / d, z: (p.z - selfPrev.z) / d };
      selfPrev = { n: clock.n, x: p.x, y: p.y, z: p.z };
    }
    if (ent?.position) track = sampleTrack(ent, ent.position, performance.now());
  };

  const take = (k: number, sol: AimSolution): void => {
    if (finished) return;
    answers.set(k, sol);
    if (k > newestK) newestK = k;
    counters.answers++;
    counters.flights += sol.flights;
    if (sol.unknown > 0) counters.unknownAnswers++;
  };

  const input = (): AimInput => {
    const p = real.entity.position;
    const t = drawStart < 0 ? -1 : clock.n - drawStart;
    const toRelease = t < 0 ? plan.release + 1 : Math.max(0, plan.release - t);
    const eye = (real.entity.eyeHeight ?? 1.62) - EYE_DROP;
    let target: AimTarget;
    if (ent) {
      const v = smoothedVelocity(track);
      target = { id: ent.id ?? -1, x: ent.position.x, y: ent.position.y, z: ent.position.z, vx: v.vx, vy: 0, vz: v.vz, width: ent.width ?? 0.6, height: ent.height ?? 1.8 };
    } else {
      target = { x: at.point!.x, y: at.point!.y, z: at.point!.z };
    }
    const warm = newestK >= 0 ? answers.get(newestK)! : null;
    return {
      dim,
      speed,
      from: { x: p.x + selfVel.x * toRelease, y: p.y + eye, z: p.z + selfVel.z * toRelease },
      vel: weapon === 'bow' ? { x: selfVel.x, y: real.entity.onGround === false ? selfVel.y : 0, z: selfVel.z } : { x: 0, y: 0, z: 0 },
      shooter: real.entity.id,
      team: 0,
      friends,
      target,
      lead: toRelease + RELEASE_LATENCY_TICKS,
      overFriends: rt.overFriends,
      warm: warm ? { pitch: warm.pitch, arc: warm.arc, ticks: warm.ticks } : null,
    };
  };

  const solveHere = (k: number): void => {
    const t0 = performance.now();
    const sol = solveAim(input(), botWorld(real as never), botEntities(real as never));
    counters.solves.inline++;
    if (counters.inlineUs.length < LEAD_SAMPLES) counters.inlineUs.push(Math.round((performance.now() - t0) * 1000));
    take(k, sol);
  };

  const request = (k: number): void => {
    if (!jobs) return solveHere(k);
    counters.solves.jobs++;
    jobs
      .submit<AimSolution>({ type: 'aim', input: input(), priority: AIM_PRIORITY + k, deadlineTick: jobs.currentTick + SUBMIT_AHEAD_TICKS })
      .then(
        (sol) => take(k, sol),
        (e: unknown) => {
          if ((e as { name?: string })?.name === 'JobLateError') counters.solves.late++;
          else {
            counters.solves.failed++;
            if (!warnedFailure) {
              warnedFailure = true;
              logger.warn('aim', `an aim job failed (the last aim is kept): ${(e as Error)?.message ?? String(e)}`);
            }
          }
        },
      );
  };

  try {
    // Update 0, before anything is drawn.
    sample();
    request(0);
    for (let i = 0; i < FIRST_WAIT_TICKS && !answers.has(0); i++) {
      await clock.next();
      sample();
    }
    if (!answers.has(0)) {
      counters.solves.firstFallback++;
      solveHere(0);
    }
    const first = answers.get(0)!;
    // A wall (both arcs blocked) does not move: refused at once, nothing drawn. A friend in the line may step out of
    // it during the draw: the draw goes on, and the release waits for a clear answer (HOLD_TICKS at most).
    if (!first.clear && first.hit !== 'friend') {
      counters.refused[first.hit === 'entity' ? 'entity' : 'block']++;
      return { kind: 'blocked', sol: first, drawn: false };
    }
    if (!first.clear) counters.drawnBlocked++;
    if (ent && ent.isValid === false) return { kind: 'gone' };

    // Tick 0: the draw.
    await clock.next();
    drawStart = clock.n;
    sample();
    bot.activateItem();
    counters.draws++;
    // No meal in the middle of a draw (it would take the hand and drop it, R3's rule for multi-step sequences):
    // auto-eat is paused until the release, and eats right after if it must.
    if (real.autoEat?.enabled && typeof real.autoEat.disableAuto === 'function') {
      real.autoEat.disableAuto();
      eatPaused = true;
    }
    let applied = 0;
    let turn: Turn = { y0: real.entity.yaw, p0: real.entity.pitch, y1: first.yaw, p1: first.pitch, a: 0, b: nextUpdate(plan, 0) };
    const requested = new Set<number>([0]);
    let charged = plan.charge < 0;
    /** The target died or left: the draw goes on to the release at the last aim (the arrow may still find someone). */
    let lost = false;
    let held = false;
    /**
     * Take the newest answer due at tick t: a scheduled one (before the release) while its window, up to the next
     * update, is open; with `hold`, one asked past the release. The look then turns to it, arriving on the next
     * update's tick (past the release: the next tick).
     */
    const adopt = (t: number, hold: boolean): void => {
      let best = applied;
      for (const k of answers.keys()) {
        if (k <= best || k > t) continue;
        if (hold ? k < plan.release : k >= plan.release || nextUpdate(plan, k) <= t) continue;
        best = k;
      }
      if (best === applied) return;
      applied = best;
      const sol = answers.get(best)!;
      turn = { y0: real.entity.yaw, p0: real.entity.pitch, y1: sol.yaw, p1: sol.pitch, a: t, b: t >= plan.release ? t + 1 : nextUpdate(plan, t) };
    };
    lookAlong(bot, turn, 1);
    /** The turn and draw tick of the look set last: it goes out with the next tick's packet, and the release flies at it. */
    let sent = { turn, at: 1 };
    for (;;) {
      await clock.next();
      const t = clock.n - drawStart;
      sample();
      if (!lost && ent && ent.isValid === false) {
        lost = true;
        counters.lost++;
      }
      const inHand = real.heldItem?.name ?? null;
      if (inHand !== weapon) {
        // Something else took the hand (auto-eat's food): the server dropped the draw.
        const k = inHand ?? 'nothing';
        counters.lowered[k] = (counters.lowered[k] ?? 0) + 1;
        return { kind: 'lowered', held: inHand };
      }
      if (!charged && t >= plan.charge) {
        // The crossbow is loaded: stop using it (the arrow leaves the inventory now).
        bot.deactivateItem();
        charged = true;
      }
      if (!lost) {
        for (const k of plan.updates) {
          if (k > 0 && !requested.has(k) && k - ahead <= t) {
            requested.add(k);
            request(k);
          }
        }
      }
      // The newest scheduled answer whose tick has come and whose window is still open (an early one waits for its
      // tick; one that missed its window is late: the last aim stays).
      adopt(t, false);
      if (t >= plan.release) {
        const cur = answers.get(applied)!;
        if (cur.clear) {
          // Release only once the look the last packet carried is this answer's, exactly. A late event loop runs
          // several physics ticks at once (clock.next() can skip ticks): the last look set may then still be one of the
          // turn's in-between ones, and the arrow flew there (found by a flaky test, docs/37 §11). Set the final look
          // and release on a later tick instead.
          if (t >= turn.b && sent.turn === turn && sent.at >= turn.b) break;
          const at = t >= turn.b ? turn.b : t + 1;
          lookAlong(bot, turn, at);
          sent = { turn, at };
          continue;
        }
        if (lost && !cur.clear) {
          counters.cancelled.gone++;
          if (weapon === 'crossbow' && charged) loaded.add(real);
          putDown(bot, real);
          return { kind: 'gone' };
        }
        if (t >= plan.release + HOLD_TICKS) {
          counters.cancelled.blocked++;
          if (weapon === 'crossbow' && charged) loaded.add(real);
          putDown(bot, real);
          return { kind: 'blocked', sol: answers.get(newestK)!, drawn: true };
        }
        // Held drawn past the release: ask again every tick until an answer is clear.
        if (!held) {
          held = true;
          counters.held++;
        }
        if (!lost && !cur.clear) {
          const k = t + ahead;
          if (!requested.has(k)) {
            requested.add(k);
            request(k);
          }
          adopt(t, true);
        }
      }
      lookAlong(bot, turn, t + 1);
      sent = { turn, at: t + 1 };
    }

    // The release, at the look the last packet carried.
    const used = answers.get(applied)!;
    if (weapon === 'bow') {
      bot.deactivateItem();
    } else {
      // use_item carries the rotation: the final look exactly, then the fire.
      void bot.look(used.yaw, used.pitch, true)?.catch?.(() => undefined);
      bot.activateItem();
      bot.deactivateItem();
      loaded.delete(real);
    }
    counters.released++;
    if (used.arc === 'high') counters.highArc++;
    if (ent && !lost) measureLead(ent, track, used);
    return { kind: 'released', sol: used };
  } finally {
    finished = true;
    clock.stop();
    if (eatPaused) real.autoEat?.enableAuto?.();
  }
}

/**
 * How well the lead did: where the target is when the arrow gets there, against where each velocity estimate put it
 * at the release. Read later on a timer (unref'd); a target gone by then is not counted.
 */
function measureLead(ent: AimEntity, tr: Track | null, sol: AimSolution): void {
  const T = RELEASE_LATENCY_TICKS + Math.max(0, sol.ticks);
  if (!Number.isFinite(T) || T > 200) return;
  const p0 = { x: ent.position.x, z: ent.position.z };
  const vs = smoothedVelocity(tr);
  const v1 = oneTickVelocity(tr);
  const timer = setTimeout(() => {
    if (ent.isValid === false || !ent.position) return;
    const p = ent.position;
    const err = (vx: number, vz: number): number => Math.hypot(p0.x + vx * T - p.x, p0.z + vz * T - p.z);
    keep(counters.lead.smoothed, err(vs.vx, vs.vz));
    keep(counters.lead.oneTick, err(v1.vx, v1.vz));
    keep(counters.lead.none, err(0, 0));
  }, T * TICK_MS);
  timer.unref();
}
