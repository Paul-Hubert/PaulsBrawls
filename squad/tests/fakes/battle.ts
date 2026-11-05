// The General's benchmark (docs/45 §4): a 20 v 20 battle in virtual time, to score a doctrine (the model's policy
// plus the runtime's standing orders) by numbers instead of by feel. The real Generals service runs on a fake order
// runner: an order is a record (command, args, snapshot) that this file's coarse combat model carries out, so a
// three-minute battle takes a second. What it measures is the decision layer (how soon each squad has an order after
// contact, how long bots stand idle, kills per loss); the stock orders' own mechanics have their own tests
// (item-orders.test.ts, lance.test.ts). The model is coarse on purpose and documented here, so a change of score is a
// change of doctrine, not of physics.
//
//   • Army bots move at 4.3 b/s on foot, 7 on a horse, toward the place their squad's order gives them.
//   • Archers (archer, horsearcher) shoot every 1.25 s, hit with p = clamp(1 − d/140, 0.1, 0.9), 5 damage.
//   • Melee bots hit what is within 3 blocks: 3 hp/s, a horseman in attack/flank 5 hp/s.
//   • The enemy: 10 archers static 100 blocks out on the axis, with our archers' numbers (the same stock `line`: range
//     `enemyRange`, default 120, the same hit curve, 5 damage),
//     and 10 melee next to them that charge the nearest army bot at 4 b/s from `chargeAt` s on (3 hp/s within 3).
//   • 20 hp each; a seeded random draw, so a run replays.

import { EventEmitter } from 'node:events';

import { Vec3 } from 'vec3';

import { DEFAULT_LIMITS } from '../../src/config';
import { Generals, type GeneralRecord } from '../../src/general/general';
import { dirOf } from '../../src/general/geometry';
import { Roster, type Player } from '../../src/roster';
import type { Snapshot } from '../../src/types';
import { FakePool, type FakeBot } from './fake-bot';

export const ROUGE: Player = { uuid: 'uuid-rouge', name: 'Rouge' };
const ADMIN: Player = { uuid: 'uuid-paul', name: 'Paul' };
export const SPAWN = { x: 0, y: 64, z: 0, dimension: 'overworld', yaw: 270 }; // facing east
const DT = 0.25;
const ARCHERS = new Set(['archer', 'horsearcher']);
const MOUNTED = new Set(['horseman', 'horsearcher']);

/** A seeded random draw (mulberry32), so a battle replays. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -- a fake order runner: orders are records the combat model reads ------------------------------------------------

class BenchOrder {
  status: 'running' | 'done' | 'stopped' = 'running';
  silentEnd = false;
  readonly listening = false;
  readonly report: { logs: string[]; status: string; result?: string } = { logs: [], status: 'running' };
  readonly command: { name: string };
  private readonly waiters: Array<() => void> = [];
  quietSince = 0;
  clearSince = 0;
  constructor(
    readonly id: string,
    name: string,
    readonly args: Record<string, string>,
    public snap: Snapshot,
    readonly commander: Player,
    readonly members: Set<string>,
    readonly startedAt: number,
  ) {
    this.command = { name };
  }
  get running(): boolean {
    return this.status === 'running';
  }
  get ended(): boolean {
    return this.status !== 'running';
  }
  waitEnded(): Promise<void> {
    return this.ended ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }
  private end(status: 'done' | 'stopped', result?: string): void {
    if (this.ended) return;
    this.status = status;
    this.report.status = status;
    if (result) this.report.result = result;
    for (const w of this.waiters.splice(0)) w();
  }
  stop(): Promise<void> {
    this.end('stopped');
    return Promise.resolve();
  }
  complete(result: string): void {
    this.end('done', result);
  }
  deliverTrigger(): boolean {
    return false;
  }
  hasMember(n: string): boolean {
    return this.members.has(n);
  }
  roleOf(n: string): string | undefined {
    return this.members.has(n) ? 'member' : undefined;
  }
}

class BenchRunner extends EventEmitter {
  readonly orders = new Map<string, BenchOrder>();
  private next = 1;
  /** Every start: when, which bots, which command. */
  readonly starts: Array<{ t: number; bots: string[]; command: string }> = [];
  running(): BenchOrder[] {
    return [...this.orders.values()].filter((o) => o.running);
  }
  get(id: string): BenchOrder | undefined {
    return this.orders.get(id);
  }
  async start(req: { commander: Player; command: string; tokens: string[]; filters?: string[]; snap: Snapshot }): Promise<{ ok: true; orderId: string; bots: Array<{ name: string; role: string }>; text: string }> {
    const args: Record<string, string> = {};
    for (const t of req.tokens) {
      const i = t.indexOf('=');
      if (i > 0) args[t.slice(0, i)] = t.slice(i + 1);
    }
    const bots = req.filters ?? [];
    // A bot is in one order at a time: a new order takes it from the one it was in (as the leases do).
    for (const o of this.running()) for (const b of bots) o.members.delete(b);
    const id = String(this.next++);
    const o = new BenchOrder(id, req.command, args, req.snap, req.commander, new Set(bots), Date.now());
    this.orders.set(id, o);
    this.starts.push({ t: Date.now(), bots, command: req.command });
    return { ok: true, orderId: id, bots: bots.map((name) => ({ name, role: 'member' })), text: '' };
  }
  async stopAll(): Promise<void> {
    for (const o of this.running()) await o.stop();
  }
}

// -- the battle -------------------------------------------------------------------------------------------------------

export interface Unit {
  name: string;
  kit: string;
  hp: number;
  alive: boolean;
  bot: FakeBot;
  nextShot: number;
  idleFor: number;
}

export interface Foe {
  id: number;
  name: string;
  kind: 'archer' | 'melee';
  hp: number;
  alive: boolean;
  entity: { id: number; type: string; username: string; position: Vec3; equipment: Array<{ name: string }>; isValid: boolean; velocity: Vec3 };
  nextShot: number;
}

export interface Score {
  doctrine: string;
  /** Seconds from the first contact until each squad has a running order (0: it had one already; the mean, the worst). */
  contactToOrder: { mean: number; max: number; bySquad: Record<string, number> };
  /** Bot-seconds an army bot stood with no order for more than 5 s while an enemy lived. */
  idleBotSeconds: number;
  kills: number;
  losses: number;
  killsPerLoss: number;
  /** Seconds until every enemy was dead (null: not within the battle). */
  wonAt: number | null;
  /** What the model's turns were refused (an order out of budget, a bad squad…). */
  turnErrors: string[];
}

/** What a doctrine's model turn sees and can do. */
export interface TurnCtx {
  generals: Generals;
  g: GeneralRecord;
  now: number;
  /** The events since its last turn. */
  events: Array<{ kind: string; text: string }>;
}

export interface Doctrine {
  name: string;
  /** Right after the squads arrived. */
  setup(c: TurnCtx): Promise<void>;
  /** One model turn: it ends `latencyS` after it was woken (what a Claude turn takes). */
  turn(c: TurnCtx): Promise<void>;
}

export interface BattleOpts {
  seconds?: number;
  /** A model turn's length (seconds). */
  latencyS?: number;
  /** When the enemy melee charge. */
  chargeAt?: number;
  /** The enemy archers' range (ours is `line`'s 120). */
  enemyRange?: number;
  seed?: number;
}

/** Run one battle with `doctrine`; Date must be mocked (mock.timers, apis ['Date']) and `tickMs` advances it. */
export async function battle(doctrine: Doctrine, tickMs: (ms: number) => void, opts: BattleOpts = {}): Promise<Score> {
  const seconds = opts.seconds ?? 180;
  const latency = opts.latencyS ?? 15;
  const chargeAt = opts.chargeAt ?? 20;
  const enemyRange = opts.enemyRange ?? 120;
  const rand = rng(opts.seed ?? 7);
  const roster = new Roster(null);
  const pool = new FakePool();
  const poolEvents = new EventEmitter();
  const runner = new BenchRunner();
  const generals = new Generals({ roster, pool: pool as never, poolEvents, runner: runner as never, limits: { ...DEFAULT_LIMITS, maxBots: 100 }, revive: (n) => roster.setDead(n, false), file: null, sampleMs: 0, coalesceMs: 0 });
  const sent: Array<Record<string, unknown>> = [];
  generals.sink = (_e, d) => {
    sent.push(d as Record<string, unknown>);
    return true;
  };
  const r = generals.create({ by: ADMIN, admin: true, name: 'Rouge', owner: ROUGE, spawn: SPAWN, allowance: { guard: 5, archer: 5, horseman: 5, horsearcher: 5 }, reinforce: 0, range: 400 });
  const g = generals.byTicket(r.ticket);
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((res) => setImmediate(res));
  };

  // The enemy, 100 blocks east: archers in a row, melee just in front of them.
  const world: Record<number, Foe['entity']> = {};
  const foes: Foe[] = [];
  for (let i = 0; i < 20; i++) {
    const kind = i < 10 ? 'archer' : 'melee';
    const lat = ((i % 10) - 4.5) * 2;
    const entity = { id: 500 + i, type: 'player', username: `Hub${kind === 'archer' ? 'Arc' : 'Swd'}${i % 10}`, position: new Vec3(100 + (kind === 'melee' ? -3 : 0), 64, lat), equipment: [{ name: kind === 'archer' ? 'bow' : 'iron_sword' }], isValid: true, velocity: new Vec3(0, 0, 0) };
    world[entity.id] = entity;
    foes.push({ id: entity.id, name: entity.username, kind, hp: 20, alive: true, entity, nextShot: 0 });
  }

  // The army: four squads of five, spawned through the mod's reports, at the spawn point.
  const units: Unit[] = [];
  const kits: Array<[string, string]> = [
    ['G', 'guard'],
    ['A', 'archer'],
    ['H', 'horseman'],
    ['HA', 'horsearcher'],
  ];
  for (const [squad, kit] of kits) {
    generals.spawnSquad(g, squad, kit, 5);
    const d = sent.at(-1)!;
    for (let i = 1; i <= 5; i++) {
      const name = `${String(d.prefix)}${String(i).padStart(2, '0')}`;
      roster.add(name, [ROUGE], 'bench', 100);
      roster.tag(name, [kit]);
      const bot = pool.add(name);
      bot.entity.position = new Vec3(-2, 64, (units.length % 10) * 2 - 9);
      bot.entities = world as never;
      units.push({ name, kit, hp: 20, alive: true, bot, nextShot: 0, idleFor: 0 });
      generals.spawned(String(d.request), name);
      generals.arrived(String(d.request), name);
    }
  }
  await settle();
  const t0 = Date.now();
  const ctx = (events: TurnCtx['events'] = []): TurnCtx => ({ generals, g, now: Date.now(), events });
  await doctrine.setup(ctx());
  await settle();

  const unitOf = new Map(units.map((u) => [u.name, u]));
  const squadOf = (n: string): string => Object.entries(g.squads).find(([, s]) => s.bots.includes(n))?.[0] ?? '?';
  const orderOf = (u: Unit): BenchOrder | undefined => runner.running().find((o) => o.members.has(u.name));
  const pointOf = (o: BenchOrder): Vec3 | null => {
    const id = o.snap.lookEntity?.id;
    const f = id !== undefined ? foes.find((x) => x.id === id) : undefined;
    if (f?.alive) return f.entity.position;
    if (o.args.x !== undefined) return new Vec3(Number(o.args.x), 64, Number(o.args.z));
    if (o.snap.lookBlock) return new Vec3(o.snap.lookBlock.x + 0.5, 64, o.snap.lookBlock.z + 0.5);
    if (f) return f.entity.position; // its target is dead: where it fell
    return null;
  };
  const alive = (): Foe[] => foes.filter((f) => f.alive);
  const nearestFoe = (p: Vec3, within: number, from: Vec3 = p): Foe | null => {
    let best: Foe | null = null;
    let bd = Infinity;
    for (const f of alive()) {
      if (f.entity.position.distanceTo(from) > within) continue;
      const d = f.entity.position.distanceTo(p);
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    return best;
  };
  const moveToward = (u: Unit, dest: Vec3, stopAt = 0.5): void => {
    const p = u.bot.entity.position;
    const d = Math.hypot(dest.x - p.x, dest.z - p.z);
    if (d <= stopAt) return;
    const step = Math.min(d - stopAt, (MOUNTED.has(u.kit) ? 7 : 4.3) * DT);
    u.bot.entity.position = new Vec3(p.x + ((dest.x - p.x) / d) * step, 64, p.z + ((dest.z - p.z) / d) * step);
  };
  const damageFoe = (f: Foe, dmg: number, by: Unit): void => {
    f.hp -= dmg;
    if (f.hp > 0 || !f.alive) return;
    f.alive = false;
    f.entity.isValid = false;
    delete world[f.id];
    by.bot.emit('entityDead', { id: f.id });
  };
  const damageUnit = (u: Unit, dmg: number, f: Foe, kind: 'arrow' | 'melee'): void => {
    if (!u.alive) return;
    generals.hurt(g, u.name, { attacker: f.entity as never, kind, weapon: f.kind === 'archer' ? 'bow' : 'iron_sword', from: f.entity.position });
    u.hp -= dmg;
    u.bot.health = Math.max(0, u.hp);
    if (u.hp > 0) return;
    u.alive = false;
    roster.setDead(u.name, true);
    poolEvents.emit('gone', u.name, 'died');
    for (const o of runner.running()) o.members.delete(u.name);
  };
  const shoot = (u: Unit, f: Foe, now: number): void => {
    if (now < u.nextShot) return;
    u.nextShot = now + 1.25;
    const d = u.bot.entity.position.distanceTo(f.entity.position);
    if (rand() < Math.min(0.9, Math.max(0.1, 1 - d / 140))) damageFoe(f, 5, u);
  };
  const melee = (u: Unit, now: number, strong: boolean): void => {
    const f = nearestFoe(u.bot.entity.position, 3);
    if (f) damageFoe(f, (strong ? 5 : 3) * DT, u);
    void now;
  };

  // The orders, as the model carries them out.
  const act = (u: Unit, now: number): void => {
    const o = orderOf(u);
    const archer = ARCHERS.has(u.kit);
    const here = u.bot.entity.position;
    if (!o) {
      if (!archer) melee(u, now, false); // hit back what is on it
      return;
    }
    const point = pointOf(o);
    const i = [...o.members].indexOf(u.name);
    const fwd = dirOf(o.snap.yaw);
    const lateral = new Vec3(-fwd.z, 0, fwd.x).scaled((i - (o.members.size - 1) / 2) * 2);
    switch (o.command.name) {
      case 'line': {
        if (!point) return;
        const back = archer ? Number(o.args.back ?? 4) : 0;
        moveToward(u, point.plus(lateral).minus(new Vec3(fwd.x, 0, fwd.z).scaled(back)));
        if (archer) {
          const f = nearestFoe(here, Number(o.args.range ?? 120));
          if (f) shoot(u, f, now);
        } else melee(u, now, false);
        return;
      }
      case 'attack':
      case 'flank': {
        if (!point) return;
        const group = Number(o.args.group ?? 8);
        const f = nearestFoe(here, group + 2, point) ?? nearestFoe(point, group);
        if (archer) {
          const approach = Number(o.args.approach ?? 0);
          if (f) {
            const d = here.distanceTo(f.entity.position);
            if (approach > 0 && d > approach) moveToward(u, f.entity.position, approach * 0.8);
            else if (d <= 120) shoot(u, f, now);
          }
        } else {
          moveToward(u, (f ? f.entity.position : point).plus(lateral.scaled(0.25)), 1.5);
          melee(u, now, MOUNTED.has(u.kit));
        }
        return;
      }
      case 'raid': {
        if (!point) return;
        const f = nearestFoe(here, archer ? 48 : 24);
        if (f && archer) shoot(u, f, now);
        else if (f) {
          moveToward(u, f.entity.position, 1.5);
          melee(u, now, false);
        } else moveToward(u, point.plus(lateral), 2);
        return;
      }
    }
  };
  /** Orders that end by themselves: attack/flank when their group is down, raid after `quiet` s with nobody at its point. */
  const endOrders = (now: number): void => {
    for (const o of runner.running()) {
      if (o.members.size === 0) {
        o.complete('nobody left');
        continue;
      }
      const point = pointOf(o);
      if (o.command.name === 'attack' || o.command.name === 'flank') {
        const group = Number(o.args.group ?? 8);
        if (!point || !nearestFoe(point, group + 4)) o.complete('Cible abattue');
      } else if (o.command.name === 'raid') {
        if (point && nearestFoe(point, 64)) o.quietSince = now;
        else if (now - (o.quietSince || now) >= Number(o.args.quiet ?? 60)) o.complete('Raid terminé');
        else o.quietSince ||= now;
      }
    }
  };
  const enemy = (now: number, t: number): void => {
    const living = units.filter((u) => u.alive);
    for (const f of alive()) {
      let best: Unit | null = null;
      let bd = Infinity;
      for (const u of living) {
        const d = u.bot.entity.position.distanceTo(f.entity.position);
        if (d < bd) {
          bd = d;
          best = u;
        }
      }
      if (!best) return;
      if (f.kind === 'archer') {
        if (bd <= enemyRange && now >= f.nextShot) {
          f.nextShot = now + 1.25;
          if (rand() < Math.min(0.9, Math.max(0.1, 1 - bd / 140))) damageUnit(best, 5, f, 'arrow');
        }
      } else if (t >= chargeAt) {
        const p = f.entity.position;
        const to = best.bot.entity.position;
        if (bd > 2) {
          const step = Math.min(bd - 2, 4 * DT);
          f.entity.velocity = new Vec3(((to.x - p.x) / bd) * 4, 0, ((to.z - p.z) / bd) * 4);
          f.entity.position = new Vec3(p.x + ((to.x - p.x) / bd) * step, 64, p.z + ((to.z - p.z) / bd) * step);
        } else f.entity.velocity = new Vec3(0, 0, 0);
        if (bd <= 3) damageUnit(best, 3 * DT, f, 'melee');
      }
    }
  };

  // The loop: the sampler (and its standing orders), the model's turns, the fight.
  let cursor = generals.events(g).cursor;
  let contactAt: number | null = null;
  let busyUntil = -1;
  let lastTurn = 0;
  let pending: TurnCtx['events'] | null = null;
  let idleBotSeconds = 0;
  let wonAt: number | null = null;
  const firstOrder: Record<string, number> = {};
  const turnErrors: string[] = [];
  for (let step = 0; step < seconds / DT; step++) {
    tickMs(DT * 1000);
    const now = Date.now();
    const t = (now - t0) / 1000;
    generals.sample(now);
    await settle();
    const evs = generals.events(g).since(cursor);
    if (contactAt === null && evs.some((e) => e.kind === 'contact')) contactAt = t;
    // The model: woken by any event (or its timeout), it acts `latency` seconds later.
    if (pending === null && (evs.length > 0 || t - lastTurn >= (alive().length ? 8 : 45))) {
      pending = evs.map((e) => ({ kind: e.kind, text: e.text }));
      cursor = generals.events(g).cursor;
      busyUntil = t + latency;
    }
    if (pending !== null && t >= busyUntil) {
      try {
        await doctrine.turn({ generals, g, now, events: pending });
      } catch (e) {
        turnErrors.push(`t=${t}: ${(e as Error).message}`);
      }
      await settle();
      pending = null;
      lastTurn = t;
    }
    // When each squad has an order after the contact (one it already had counts from the contact: 0 s).
    if (contactAt !== null) {
      for (const u of units) {
        const sq = squadOf(u.name);
        if (u.alive && firstOrder[sq] === undefined && orderOf(u)) firstOrder[sq] = Math.max(0, t - DT - contactAt);
      }
    }
    // The fight.
    for (const u of units) if (u.alive) act(u, t);
    enemy(t, t);
    endOrders(t);
    await settle();
    // Idle bots while an enemy lives.
    if (alive().length) {
      for (const u of units) {
        if (!u.alive) continue;
        if (orderOf(u)) u.idleFor = 0;
        else {
          u.idleFor += DT;
          if (u.idleFor > 5) idleBotSeconds += DT;
        }
      }
    } else if (wonAt === null) wonAt = t;
    if (!units.some((u) => u.alive)) break;
    void unitOf;
  }
  await runner.stopAll();
  const kills = foes.filter((f) => !f.alive).length;
  const losses = units.filter((u) => !u.alive).length;
  const latencies = Object.values(firstOrder);
  for (const [s] of kits) if (firstOrder[s] === undefined) latencies.push(seconds);
  return {
    doctrine: doctrine.name,
    contactToOrder: { mean: latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length), max: Math.max(...latencies), bySquad: firstOrder },
    idleBotSeconds: Math.round(idleBotSeconds),
    kills,
    losses,
    killsPerLoss: kills / Math.max(1, losses),
    wonAt,
    turnErrors,
  };
}
