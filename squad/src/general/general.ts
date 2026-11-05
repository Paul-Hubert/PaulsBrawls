// The General (docs/38): a Claude Code instance commanding an army of squads with no body. An admin's
// `/bots general create NAME …` gives it a virtual owner (its bots are everyone else's enemies through the usual
// friend rules), a spawn point, an axis of attack (the admin's facing) and an allowance; the instance reaches it over
// `/mcp/general` with the `gen-…` ticket. Every act is an order the runtime carries out (the stock commands, started
// for a squad's bots with a commander snapshot written here); Claude waits on the events between moves.
//
// The admin's side answers in French (the mod shows it), the agent's in English. Spawning goes through the mod (it
// owns the whitelist, the arrival teleport and the kits): `sink('general-spawn' | 'general-despawn', …)` reaches it
// over SSE and it reports back through /api/general/spawned|arrived|failed.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventEmitter } from 'node:events';

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

import type { Limits } from '../config';
import type { OrderRunner } from '../orders/runner';
import type { Order } from '../orders/order';
import type { Player, Roster } from '../roster';
import type { EntityRef, Snapshot, Vec3Like } from '../types';
import { errorMessage } from '../api/errors';
import type { HurtBy } from '../bots/hits';
import { logger } from '../logger';
import { DEFAULT_WAKE, EVENT_KINDS, EventRing, type EventKind, type GeneralEvent } from './events';
import { along, dirName, dirOf, horizontal, onAxis, parseDirection, parsePosition, rel, roundYaw16, yawToward } from './geometry';
import { centroid, ClusterTracker, kit as kitOfCluster, type Cluster, type Sighting } from './perception';

/** The kits the mod knows (SquadKits), and the bot-name part each one gives: `<General><Arc>01`. */
export const KITS = ['archer', 'guard', 'miner', 'farmer', 'spearman', 'horseman', 'horsearcher'] as const;
export type Kit = (typeof KITS)[number];
const KIT_PREFIX: Record<Kit, string> = { archer: 'Arc', guard: 'Gar', miner: 'Min', farmer: 'Far', spearman: 'Spe', horseman: 'Hor', horsearcher: 'Hac' };

/** The stock orders a General may give (the ones that work with no commander's body). */
export const OFFERED = ['raid', 'attack', 'line'] as const;

/** A General's name: also its virtual owner's player name, and the prefix of its bots' names (16 chars at most). */
export const GENERAL_NAME = /^[A-Za-z0-9_]{3,11}$/;
const SQUAD_NAME = /^[A-Za-z0-9_-]{1,16}$/;

export const DEFAULT_RANGE = 256;
export const DEFAULT_LEG = 48;
/** Orders per General per minute: a confused agent cannot thrash its army. */
export const MAX_ORDERS_PER_MINUTE = 20;
/** Orders the runtime gives by itself (advance legs, standing orders) per General per minute: their own budget. */
export const MAX_RUNTIME_ORDERS_PER_MINUTE = 60;
/** wait_events' default timeout while an enemy is in sight, and otherwise (seconds). */
export const FIGHT_WAIT_S = 8;
export const QUIET_WAIT_S = 45;
/** No enemy and no order for this long: one `idle` event (the default advance is due). */
const IDLE_MS = 20_000;
/** A squad more than this far ahead of the slowest advancing squad waits before its next leg. */
const LEG_SPREAD = 16;
/** Squads side by side when they advance together, and archers this far behind. */
const LANE = 12;
const ARCHER_BACK = 6;
/** A spawn request the mod never fully answered is closed after this long. */
const SPAWN_TIMEOUT_MS = 180_000;
const HP_BANDS = [75, 50, 25];
/** Hits are remembered this long (a casualty's killer is its last hit within it). */
const HIT_MEMORY_MS = 10_000;
/** under-fire: this many arrows on one squad within UNDER_FIRE_MS, said again after UNDER_FIRE_AGAIN_MS at most. */
const UNDER_FIRE_ARROWS = 3;
const UNDER_FIRE_MS = 5_000;
const UNDER_FIRE_AGAIN_MS = 10_000;
/** enemy-approach: a cluster within this of a squad, closing at least APPROACH_SPEED b/s; again once beyond APPROACH_RESET. */
export const APPROACH_WITHIN = 48;
const APPROACH_SPEED = 1;
const APPROACH_RESET = 64;

export interface SquadRecord {
  bots: string[];
}

export interface GeneralRecord {
  name: string;
  owner: Player;
  ticket: string;
  spawn: Vec3Like & { dimension: string };
  /** The axis of attack: a Minecraft yaw, one of 16 directions. */
  axis: number;
  /** Bots of each kit the General may field (alive or dead: the dead come back only as reinforcements). */
  allowance: Record<string, number>;
  /** Dead bots it may still bring back. */
  reinforce: number;
  /** How far along the axis the advance may go. */
  range: number;
  mission: { goal?: string; strategy?: string };
  squads: Record<string, SquadRecord>;
  /** The kit of each bot it spawned. */
  kits: Record<string, string>;
  createdAt: number;
  createdBy: string;
}

interface OrderEntry {
  orderId: string;
  command: string;
  /** What the General typed as args (the point and target are added per start). */
  args: string;
  at: AtInput;
  advance: boolean;
  /** Who gave it: the model (a tool call) or the runtime (an advance leg, a standing order). */
  by: 'model' | 'runtime';
  /** When it started. */
  startedAt: number;
  /** Replaced or stopped by the General itself: its end is not an event. */
  quiet: boolean;
}

interface Advance {
  distance: number;
  lane: number;
  back: number;
  /** Its leg ended: the next one starts once the others caught up. */
  waiting: boolean;
  target?: Vec3Like;
}

interface PendingSpawn {
  id: string;
  general: string;
  squad: string;
  kit: string;
  want: number;
  revive: boolean;
  names: string[];
  arrived: string[];
  failed: string[];
  at: number;
}

interface Runtime {
  events: EventRing;
  tracker: ClusterTracker;
  orders: Map<string, OrderEntry>;
  advancing: Map<string, Advance>;
  bands: Map<string, number>;
  /** Hostile mobs near each squad at the last sample. */
  mobs: Map<string, number>;
  orderTimes: number[];
  runtimeOrderTimes: number[];
  /** The last sitrep wait_events sent, by line key (the next one is a diff against it). */
  lastSitrep?: Map<string, string>;
  idleSince?: number;
  idleSaid: boolean;
  axisEndSaid: boolean;
  startedAt: number;
  /** Deaths per squad: when. */
  deaths: Map<string, number[]>;
  /** Bots whose entityDead listener is installed. */
  watched: WeakSet<object>;
  /** Who hurt the army's bots in the last HIT_MEMORY_MS (attribution: casualty, hp-band, under-fire). */
  hits: Hit[];
  /** When each squad's last under-fire event was said. */
  fireSaid: Map<string, number>;
  /** `cluster|squad` → when its enemy-approach was said (again only after it went away). */
  approachSaid: Map<string, number>;
}

/** One hit on one of the army's bots (hits.ts `hurtBy`). */
interface Hit {
  t: number;
  bot: string;
  squad: string;
  /** The attacker's name and entity id, when the bot saw it. */
  name: string | null;
  id: number | null;
  kind: 'melee' | 'arrow' | 'other';
  weapon: string | null;
  from: Vec3Like | null;
}

export interface AtInput {
  pos?: string;
  target?: string;
  facing?: string;
}

/** What the General's service needs from the rest of the runtime. */
export interface GeneralDeps {
  roster: Roster;
  pool: { bot(name: string): Bot | undefined };
  /** The bot pool's events ('online', 'gone'); absent in tests that drive sample() by hand. */
  poolEvents?: EventEmitter;
  runner: OrderRunner;
  limits: Limits;
  /** Bring a dead bot back (roster + pool), as /bots squad respawn does. */
  revive(name: string): void;
  /** generals.json, or null (tests). */
  file: string | null;
  /** The sampling period; 0: none (tests call sample()). */
  sampleMs?: number;
  /** Coalescing of wait_events (tests: 0). */
  coalesceMs?: number;
}

export class GeneralError extends Error {
  override name = 'GeneralError';
}

function fail(m: string): never {
  throw new GeneralError(m);
}

export class Generals {
  private readonly records = new Map<string, GeneralRecord>();
  private readonly rt = new Map<string, Runtime>();
  private readonly pending = new Map<string, PendingSpawn>();
  private timer?: ReturnType<typeof setInterval>;
  /** Reaches the mod over SSE; false when no mod listens (then nothing can spawn). Set by the HTTP layer. */
  sink: (event: string, data: unknown) => boolean = () => false;

  constructor(private readonly deps: GeneralDeps) {
    if (deps.file && existsSync(deps.file)) {
      try {
        const raw = JSON.parse(readFileSync(deps.file, 'utf8')) as { generals?: GeneralRecord[] };
        for (const g of raw.generals ?? []) this.records.set(g.name.toLowerCase(), g);
      } catch (e) {
        logger.warn('general', `generals.json unreadable, starting empty: ${errorMessage(e)}`);
      }
    }
    deps.poolEvents?.on('gone', (name: string, reason: string) => this.botGone(name, reason));
    deps.poolEvents?.on('online', (name: string, bot: Bot) => this.watch(name, bot));
    deps.runner.on('state', () => this.forgetDespawned());
    const ms = deps.sampleMs ?? 1_000;
    if (ms > 0) {
      this.timer = setInterval(() => {
        try {
          this.sample();
        } catch (e) {
          logger.warn('general', `sample failed: ${errorMessage(e)}`);
        }
      }, ms);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // -- the admin's side (French: the mod shows it) ----------------------------------------------------------------

  create(req: { by: Player; admin: boolean; name: string; owner: Player; spawn: Vec3Like & { dimension: string; yaw: number }; allowance: Record<string, number>; reinforce?: number; range?: number }): { ok: boolean; text: string; ticket?: string } {
    if (!req.admin) return { ok: false, text: '[Bots] Seul un admin peut créer un général.' };
    if (!GENERAL_NAME.test(req.name)) return { ok: false, text: `[Bots] Nom de général invalide « ${req.name} » (3 à 11 caractères : lettres, chiffres, _).` };
    if (this.records.has(req.name.toLowerCase())) return { ok: false, text: `[Bots] Le général ${req.name} existe déjà (/bots general stop ${req.name}).` };
    if (this.deps.roster.has(req.name)) return { ok: false, text: `[Bots] ${req.name} est déjà un bot.` };
    let allowance: Record<string, number>;
    try {
      allowance = checkAllowance(req.allowance);
    } catch (e) {
      return { ok: false, text: `[Bots] ${errorMessage(e)}` };
    }
    if (Object.keys(allowance).length === 0) return { ok: false, text: '[Bots] Donne au moins une dotation, par exemple archer=10 guard=10.' };
    const g: GeneralRecord = {
      name: req.name,
      owner: req.owner,
      ticket: `gen-${randomBytes(12).toString('base64url')}`,
      spawn: { x: req.spawn.x, y: req.spawn.y, z: req.spawn.z, dimension: req.spawn.dimension || 'overworld' },
      axis: roundYaw16(req.spawn.yaw),
      allowance,
      reinforce: clampInt(req.reinforce ?? 0, 0, 1000),
      range: clampInt(req.range ?? DEFAULT_RANGE, 16, 4000),
      mission: {},
      squads: {},
      kits: {},
      createdAt: Date.now(),
      createdBy: req.by.name,
    };
    this.records.set(g.name.toLowerCase(), g);
    this.save();
    this.runtime(g);
    return {
      ok: true,
      ticket: g.ticket,
      text: `[Bots] Général ${g.name} prêt : apparition en ${fmt(g.spawn)}, axe d'attaque ${dirName(g.axis)}, dotation ${allowanceText(g)}, renforts ${g.reinforce}, portée ${g.range}.`,
    };
  }

  allow(by: Player, admin: boolean, name: string, allowance: Record<string, number>, reinforce?: number, range?: number): { ok: boolean; text: string } {
    if (!admin) return { ok: false, text: '[Bots] Seul un admin peut changer une dotation.' };
    const g = this.records.get(name.toLowerCase());
    if (!g) return { ok: false, text: `[Bots] Aucun général ${name}.` };
    try {
      g.allowance = { ...g.allowance, ...checkAllowance(allowance) };
    } catch (e) {
      return { ok: false, text: `[Bots] ${errorMessage(e)}` };
    }
    for (const [k, v] of Object.entries(g.allowance)) if (v === 0) delete g.allowance[k];
    if (reinforce !== undefined) g.reinforce = clampInt(reinforce, 0, 1000);
    if (range !== undefined) g.range = clampInt(range, 16, 4000);
    this.save();
    const text = `allowance changed by ${by.name}: ${allowanceText(g)}, reinforcements ${g.reinforce}, range ${g.range}`;
    this.runtime(g).events.push('allowance', text);
    return { ok: true, text: `[Bots] Général ${g.name} : dotation ${allowanceText(g)}, renforts ${g.reinforce}, portée ${g.range}.` };
  }

  tell(by: Player, admin: boolean, name: string, text: string): { ok: boolean; text: string } {
    if (!admin) return { ok: false, text: '[Bots] Seul un admin parle au général.' };
    const g = this.records.get(name.toLowerCase());
    if (!g) return { ok: false, text: `[Bots] Aucun général ${name}.` };
    if (!text.trim()) return { ok: false, text: '[Bots] Message vide.' };
    this.runtime(g).events.push('admin', `${by.name}: ${text.trim().slice(0, 1000)}`);
    return { ok: true, text: `[Bots] Transmis au général ${g.name}.` };
  }

  /** Revoke the ticket and stop the General's orders. The answer names its bots (the mod despawns them on request). */
  async end(by: Player, admin: boolean, name: string): Promise<{ ok: boolean; text: string; bots?: string[] }> {
    if (!admin) return { ok: false, text: '[Bots] Seul un admin arrête un général.' };
    const g = this.records.get(name.toLowerCase());
    if (!g) return { ok: false, text: `[Bots] Aucun général ${name}.` };
    const rt = this.runtime(g);
    rt.advancing.clear();
    for (const e of rt.orders.values()) e.quiet = true;
    const mine = this.deps.runner.running().filter((o) => o.commander.uuid === g.owner.uuid);
    for (const o of mine) o.silentEnd = true;
    await Promise.all(mine.map((o) => o.stop('stopped', `General ${g.name} stopped by ${by.name}`)));
    rt.events.push('admin', `${by.name} ended this General: the ticket is revoked, every order stopped. Stop working.`);
    this.records.delete(g.name.toLowerCase());
    this.rt.delete(g.name.toLowerCase());
    this.save();
    const bots = this.deps.roster.botsOf(g.owner.uuid).map((b) => b.name);
    return { ok: true, bots, text: `[Bots] Général ${g.name} arrêté (ticket révoqué, ${mine.length} ordre(s) arrêté(s)).` };
  }

  list(admin: boolean): { ok: boolean; text: string } {
    if (!admin) return { ok: false, text: '[Bots] Réservé aux admins.' };
    const all = [...this.records.values()];
    if (all.length === 0) return { ok: true, text: '[Bots] Aucun général.' };
    const lines = all.map((g) => {
      const bots = this.deps.roster.botsOf(g.owner.uuid);
      const dead = bots.filter((b) => b.dead).length;
      const mins = Math.round((Date.now() - g.createdAt) / 60_000);
      return ` • ${g.name} (${mins} min) — ${bots.length - dead} bot(s) en vie, ${dead} mort(s) ; dotation ${allowanceText(g, this.fieldedAll(g))} ; renforts ${g.reinforce} ; axe ${dirName(g.axis)}${g.mission.goal ? ` ; mission : ${g.mission.goal}` : ''}`;
    });
    return { ok: true, text: ['[Bots] Généraux :', ...lines].join('\n') };
  }

  /** Whether this player uuid is a General's virtual owner (its orders' notices go nowhere). */
  isGeneralOwner(uuid: string): boolean {
    for (const g of this.records.values()) if (g.owner.uuid === uuid) return true;
    return false;
  }

  // -- the mod's reports on spawning -------------------------------------------------------------------------------

  spawned(request: string, name: string): { ok: boolean; text: string } {
    const p = this.pending.get(request);
    if (!p) return { ok: false, text: 'unknown spawn request' };
    const g = this.byRequest(p);
    if (!g) return { ok: false, text: 'the General is gone' };
    if (!p.names.includes(name)) p.names.push(name);
    g.kits[name] = p.kit;
    this.putInSquad(g, name, p.squad);
    this.save();
    return { ok: true, text: '' };
  }

  arrived(request: string, name: string): { ok: boolean; text: string } {
    const p = this.pending.get(request);
    if (!p) return { ok: false, text: 'unknown spawn request' };
    if (!p.arrived.includes(name)) p.arrived.push(name);
    this.closeIfDone(p);
    return { ok: true, text: '' };
  }

  failed(request: string, text: string, name?: string): { ok: boolean; text: string } {
    const p = this.pending.get(request);
    if (!p) return { ok: false, text: 'unknown spawn request' };
    const g = this.byRequest(p);
    p.failed.push(name ?? `#${p.failed.length + 1}`);
    if (g) this.runtime(g).events.push('spawn-refused', `squad ${p.squad}: a ${p.kit} could not be ${p.revive ? 'brought back' : 'spawned'} (${text.replace(/^\[Bots\]\s*/, '')})`);
    this.closeIfDone(p, true);
    return { ok: true, text: '' };
  }

  // -- the agent's side (English) -------------------------------------------------------------------------------

  /** The General of a ticket (the MCP layer's gate). */
  byTicket(ticket: string | undefined): GeneralRecord {
    const t = String(ticket ?? '').trim();
    for (const g of this.records.values()) if (g.ticket === t && t) return g;
    return fail('unknown or revoked General ticket (SQUAD_GENERAL_TICKET): ask the admin for /bots general create');
  }

  briefing(g: GeneralRecord): string {
    const fielded = this.fieldedAll(g);
    const lines = [
      `You are General ${g.name}. You command an army of Minecraft bots with no body of your own. Every bot not of your army is an enemy (other players and their bots), as are hostile mobs.`,
      `Spawn point: ${fmt(g.spawn)} (${g.spawn.dimension}). Positions are relative to it: E = +x, N = -z ("E12 N3"); "axis+48" = 48 blocks past your army's front along the axis; "spawn"; or absolute "x y z".`,
      `Axis of attack: ${dirName(g.axis)} (the admin's facing). Advance limit (range): ${g.range} blocks along it.`,
      `Allowance (bots of each kit you may field, alive or dead): ${allowanceText(g, fielded)}. Reinforcements (dead bots you may bring back): ${g.reinforce}. Everything spawns at the spawn point.`,
      `Mission: ${missionText(g)}`,
      '',
      'Orders (order tool; `at` = { pos?, target?, facing? }; target = a cluster id like X1, an enemy name, or #entityId):',
      ' raid — march in formation on at.pos (or the target, whom it hunts) and fight every enemy met; ends after `quiet` seconds without enemies at the point. args: radius=8..48 (24) quiet=1..600 (60). Roles: archers (bow), melee.',
      ' attack — at.target: its group is attacked, it and every enemy within `group` of it, spread over the bots (archers shoot from where they stand, 2 melee on one foe at most) until the group is down or `seconds`; no target: each archer fires a volley at at.pos, the melee take a ring of 3 around it and fight threats within radius. Horsemen with spears charge in waves: through the group at speed, out `backoff` beyond it, re-form, charge back. Ends by itself (the group down, or the volley fired and the point clear); bots it took from a line go back to it. Retarget re-aims it. args: radius=4..48 (16) seconds=5..600 (60) near=0..16 (4) volley=0..16 (3) spread (3) group=0..32 (8) backoff=6..32 (12). Roles: archers (bow), melee.',
      ' line — guards (shield) form a straight shield wall at at.pos facing at.facing and hit back what hits them; archers form a line `back` blocks behind it and shoot everything in range, in front first. Until stopped; retarget re-forms it. args: spacing=1..3 (1, guards) archerSpacing=1..4 (2) back (4) range=4..120 (120) ranks=1..3 (1) reach (4) march=0..60 (20: seconds an archer on foot walks to a new slot before it shoots on the way; horse archers always shoot on the move). Roles: guards (shield), archers (bow), melee (neither, e.g. horsemen: on the wall flanks, 2 apart).',
      'advance — the default move when no enemy is visible: squads march along the axis in legs of 48 blocks (raid legs), side by side, until contact or the range.',
      '',
      'How to work: restate the mission in one line, spawn squads (spawn_squad), give orders, then call wait_events and react to what it returns. Never poll sitrep in a loop: wait_events returns when something happens (contact, casualty, order-end, idle…) and carries a sitrep.',
      'If the admin gave no goal: seek and destroy enemy bots along the axis. With no enemy in sight, advance along the axis.',
      'Sitrep legend: squad line = name online/total kits hp% order @position [contact Xn dist] [deadN] [mobsN]; cluster line = Xn count @position →heading speed weapons armor seen-ago.',
    ];
    return lines.join('\n');
  }

  sitrep(g: GeneralRecord): string {
    return this.sitrepLines(g)
      .map(([, l]) => l)
      .join('\n');
  }

  /**
   * The sitrep against the last one wait_events sent (docs/45 §2): the header always, then only the lines that changed
   * or are new, the keys of the unchanged ones, and what is gone. The first one, or `full`, is whole. A line's "seen
   * Ns ago" alone is no change.
   */
  sitrepDiff(g: GeneralRecord, full = false): string {
    const rt = this.runtime(g);
    const lines = this.sitrepLines(g);
    const prev = rt.lastSitrep;
    const norm = (l: string): string => l.replace(/ seen \d+s ago$/, '').replace(/ LOST \d+s ago/, ' LOST');
    rt.lastSitrep = new Map(lines.map(([k, l]) => [k, norm(l)]));
    if (full || !prev) return lines.map(([, l]) => l).join('\n');
    const out: string[] = [];
    const same: string[] = [];
    for (const [k, l] of lines) {
      if (k === 'header' || prev.get(k) !== norm(l)) out.push(l);
      else if (/^[sc]:/.test(k)) same.push(k.slice(2));
    }
    const gone = [...prev.keys()].filter((k) => !rt.lastSitrep!.has(k) && /^[sc]:/.test(k)).map((k) => k.slice(2));
    if (same.length) out.push(`unchanged: ${same.join(' ')}`);
    if (gone.length) out.push(`gone: ${gone.join(' ')}`);
    return out.join('\n');
  }

  /** The sitrep's lines, each with its key: header, mission, a squad's name, a cluster's id. */
  private sitrepLines(g: GeneralRecord): Array<[string, string]> {
    const rt = this.runtime(g);
    const now = Date.now();
    const fielded = this.fieldedAll(g);
    const out: Array<[string, string]> = [];
    out.push([
      'header',
      `t=${Math.round((now - rt.startedAt) / 1000)}s cur=${rt.events.cursor} spawn=(${Math.round(g.spawn.x)},${Math.round(g.spawn.y)},${Math.round(g.spawn.z)}) axis=${dirName(g.axis)} front=${Math.round(this.front(g))}/${g.range} allow ${allowanceText(g, fielded)} reinf ${g.reinforce}`,
    ]);
    out.push(['mission', `mission: ${missionText(g)}`]);
    const names = Object.keys(g.squads);
    if (names.length === 0) out.push(['nosquads', 'no squads: spawn_squad(name, kit, count)']);
    const visible = rt.tracker.visible(now);
    for (const s of names) out.push([`s:${s}`, this.squadLine(g, rt, s, visible)]);
    const clusters = rt.tracker.all();
    if (clusters.length === 0) out.push(['noenemies', 'enemies: none seen']);
    for (const c of clusters) out.push([`c:${c.id}`, clusterLine(g, c, now)]);
    return out;
  }

  squadDetail(g: GeneralRecord, squad: string): string {
    const s = this.squadName(g, squad);
    const rt = this.runtime(g);
    const lines = [`squad ${s}:`];
    for (const n of g.squads[s]!.bots) {
      const rb = this.deps.roster.get(n);
      const bot = this.deps.pool.bot(n);
      const kit = g.kits[n] ?? '?';
      if (!rb) continue;
      if (rb.dead) {
        lines.push(` ${n} ${kit} DEAD`);
        continue;
      }
      if (!bot?.entity) {
        lines.push(` ${n} ${kit} offline`);
        continue;
      }
      const o = this.orderOf(n);
      const now = Date.now();
      const hits = rt.hits.filter((h) => h.bot === n && now - h.t < HIT_MEMORY_MS);
      const lastHit = hits.at(-1);
      const said = o ? [...o.report.logs].reverse().find((l) => l.includes(n)) : undefined;
      lines.push(
        ` ${n} ${kit} hp${Math.round(bot.health ?? 0)} @${rel(g.spawn, bot.entity.position)} y${Math.round(bot.entity.position.y)} ${o ? `${o.command.name}:${o.roleOf(n) ?? '?'}` : 'no order'}: ${doing(g, bot)}` +
          (hits.length ? `; hit ${hits.length}x in 10s, last by ${this.hitText(rt, lastHit!, bot.entity.position)}` : '') +
          (said ? `; log: ${said.replace(`${n}: `, '').slice(0, 140)}` : ''),
      );
    }
    const e = rt.orders.get(s);
    const o = e ? this.deps.runner.get(e.orderId) : undefined;
    if (o) {
      lines.push(`order ${o.command.name} #${o.id} ${o.status}${e?.advance ? ' (advance leg)' : ''}; last log lines:`);
      for (const l of o.report.logs.slice(-6)) lines.push(`  ${l}`);
    }
    return lines.join('\n');
  }

  map(g: GeneralRecord, center?: string, radius = 48, cell = 4): string {
    const rt = this.runtime(g);
    const c = center ? parsePosition(center, this.posCtx(g)) : this.armyCenter(g) ?? g.spawn;
    const r = clampInt(radius, 8, 64);
    const step = clampInt(cell, 1, 8);
    const probe = this.anyBot(g);
    if (!probe) return 'no bot online to read the terrain';
    const overlay = new Map<string, string>();
    const key = (x: number, z: number): string => `${Math.floor((x - (c.x - r)) / step)},${Math.floor((z - (c.z - r)) / step)}`;
    overlay.set(key(g.spawn.x, g.spawn.z), 'S');
    const visible = new Set(rt.tracker.visible(Date.now()));
    for (const cl of rt.tracker.all()) for (const m of cl.members.values()) overlay.set(key(m.pos.x, m.pos.z), visible.has(cl) ? 'x' : 'o');
    for (const [s, sq] of Object.entries(g.squads)) {
      for (const n of sq.bots) {
        const p = this.deps.pool.bot(n)?.entity?.position;
        if (p) overlay.set(key(p.x, p.z), s.charAt(0).toUpperCase());
      }
    }
    const rows: string[] = [];
    const cells = Math.floor((2 * r) / step);
    for (let j = 0; j < cells; j++) {
      let row = '';
      for (let i = 0; i < cells; i++) {
        const ov = overlay.get(`${i},${j}`);
        if (ov) {
          row += ov;
          continue;
        }
        const x = c.x - r + i * step + step / 2;
        const z = c.z - r + j * step + step / 2;
        row += terrainChar(probe, x, z, g.spawn.y);
      }
      rows.push(row);
    }
    return [
      `map centre ${rel(g.spawn, c)} radius ${r} cell ${step} (north up, east right; one char = ${step}x${step} blocks)`,
      ...rows,
      'legend: . level with spawn (±1)  + 2-4 up  ^ 5+ up  - 2-4 down  _ 5+ down  ~ water  ! lava  ? not loaded  S spawn  x enemy  o enemy last seen (lost)  A-Z your squads (first letter)',
    ].join('\n');
  }

  /**
   * The long poll (docs/38 §5, docs/45 §2): returns once a waking event came (and its burst was gathered), else at the
   * timeout. Default timeout: FIGHT_WAIT_S while an enemy is in sight, QUIET_WAIT_S otherwise. `minGapS`: never sooner
   * than this after the call (the events of that time come together). The sitrep is a diff against the last one sent,
   * unless `full`.
   */
  async waitEvents(
    g: GeneralRecord,
    opts: { cursor?: number; timeoutS?: number; wakeOn?: string[]; minGapS?: number; full?: boolean },
    signal?: AbortSignal,
  ): Promise<string> {
    const rt = this.runtime(g);
    const t0 = Date.now();
    const from = opts.cursor ?? rt.events.cursor;
    const wake = new Set<EventKind>((opts.wakeOn?.length ? opts.wakeOn : DEFAULT_WAKE).filter((k): k is EventKind => (EVENT_KINDS as readonly string[]).includes(k)));
    const timeoutS = clampInt(opts.timeoutS ?? (rt.tracker.visible(t0).length ? FIGHT_WAIT_S : QUIET_WAIT_S), 1, 50);
    const { events: first, woke } = await rt.events.wait(from, timeoutS * 1000, wake, signal);
    let events = first;
    const gap = clampInt(opts.minGapS ?? 0, 0, 30) * 1000 - (Date.now() - t0);
    if (woke && gap > 0 && !signal?.aborted) {
      await rt.events.wait(rt.events.cursor, gap, new Set(), signal); // nothing wakes it: it just waits out the gap
      events = rt.events.since(from);
    }
    const now = Date.now();
    const lines = [woke ? `cursor=${rt.events.cursor} (pass it to the next wait_events)` : `cursor=${rt.events.cursor} nothing new in ${timeoutS}s`];
    for (const e of events) lines.push(eventLine(e, now));
    lines.push('--- sitrep', this.sitrepDiff(g, !!opts.full));
    return lines.join('\n');
  }

  setMission(g: GeneralRecord, goal?: string, strategy?: string): string {
    if (goal !== undefined) g.mission.goal = goal.trim().slice(0, 300) || undefined;
    if (strategy !== undefined) g.mission.strategy = strategy.trim().slice(0, 300) || undefined;
    this.save();
    return `mission: ${missionText(g)}`;
  }

  setAxis(g: GeneralRecord, direction: string): string {
    g.axis = roundYaw16(parseDirection(direction));
    const rt = this.runtime(g);
    rt.axisEndSaid = false;
    this.save();
    return `axis is now ${dirName(g.axis)}; front ${Math.round(this.front(g))}/${g.range} along it`;
  }

  spawnSquad(g: GeneralRecord, squad: string, kit: string, count: number): string {
    if (!SQUAD_NAME.test(squad)) fail(`invalid squad name "${squad}" (1-16 of a-z, 0-9, _ and -)`);
    const k = kit.toLowerCase();
    if (!(k in g.allowance)) fail(`kit "${kit}" is not in your allowance (${allowanceText(g)})`);
    const n = clampInt(count, 1, 50);
    const room = (g.allowance[k] ?? 0) - this.fielded(g, k);
    if (room <= 0) fail(`no ${k} left in your allowance (${allowanceText(g, this.fieldedAll(g))}); dead ones come back with reinforce`);
    if (n > room) fail(`only ${room} ${k} left in your allowance`);
    const free = this.deps.limits.maxBots - this.deps.roster.all().length - this.pendingTotal();
    if (free < n) fail(`the server's bot limit leaves room for ${Math.max(0, free)} more bot(s) (limits.maxBots ${this.deps.limits.maxBots})`);
    const name = this.squadName(g, squad, true);
    const p: PendingSpawn = { id: `sp-${randomBytes(6).toString('hex')}`, general: g.name, squad: name, kit: k, want: n, revive: false, names: [], arrived: [], failed: [], at: Date.now() };
    const sent = this.sink('general-spawn', {
      request: p.id,
      general: g.name,
      owner: g.owner,
      kit: k,
      n,
      prefix: `${g.name}${KIT_PREFIX[k as Kit] ?? 'Bot'}`,
      spawn: { ...g.spawn, yaw: g.axis },
      revive: [],
    });
    if (!sent) fail('the server mod is not connected to the runtime: nothing can spawn right now');
    g.squads[name] ??= { bots: [] };
    this.save();
    this.pending.set(p.id, p);
    return `requested ${n} ${k} for squad ${name}: they appear at the spawn point one by one (about 4 s each); an "arrived" event follows`;
  }

  reinforce(g: GeneralRecord, squad: string, count: number): string {
    const s = this.squadName(g, squad);
    if (g.reinforce <= 0) fail('no reinforcements left');
    const dead = g.squads[s]!.bots.filter((n) => this.deps.roster.get(n)?.dead);
    if (dead.length === 0) fail(`squad ${s} has no dead bot to bring back`);
    const back = dead.slice(0, Math.min(clampInt(count, 1, 50), g.reinforce));
    const kits: Record<string, string> = {};
    for (const n of back) kits[n] = g.kits[n] ?? '';
    const p: PendingSpawn = { id: `sp-${randomBytes(6).toString('hex')}`, general: g.name, squad: s, kit: [...new Set(Object.values(kits))].join('/'), want: back.length, revive: true, names: [...back], arrived: [], failed: [], at: Date.now() };
    const sent = this.sink('general-spawn', { request: p.id, general: g.name, owner: g.owner, kit: '', n: 0, prefix: '', spawn: { ...g.spawn, yaw: g.axis }, revive: back, kits });
    if (!sent) fail('the server mod is not connected to the runtime: nothing can spawn right now');
    for (const n of back) this.deps.revive(n);
    g.reinforce -= back.length;
    this.save();
    this.pending.set(p.id, p);
    this.deps.runner.emit('state');
    return `bringing back ${back.join(', ')} at the spawn point (${g.reinforce} reinforcement(s) left)`;
  }

  assign(g: GeneralRecord, bots: string[], squad: string): string {
    if (!SQUAD_NAME.test(squad)) fail(`invalid squad name "${squad}"`);
    const name = this.squadName(g, squad, true);
    const moved: string[] = [];
    for (const b of bots) {
      const canonical = this.deps.roster.canonical(b);
      if (!canonical || !this.deps.roster.isOwner(canonical, g.owner.uuid)) fail(`${b} is not one of your bots`);
      this.putInSquad(g, canonical!, name);
      moved.push(canonical!);
    }
    this.save();
    return `squad ${name}: ${g.squads[name]!.bots.join(', ')} (moved ${moved.join(', ')}; a running order keeps the bots it has until you give a new one)`;
  }

  async order(g: GeneralRecord, squad: string, command: string, args: string, at: AtInput): Promise<string> {
    const s = this.squadName(g, squad);
    const c = command.trim().toLowerCase();
    if (!(OFFERED as readonly string[]).includes(c)) fail(`unknown order "${command}" (${OFFERED.join(', ')}; or advance)`);
    const rt = this.runtime(g);
    rt.advancing.delete(s);
    return this.start(g, s, c, args, at, { by: 'model' });
  }

  /**
   * A plan in one call (docs/45 §2): several squads' orders, all checked first (squads, commands, bots online, the
   * minute's budget), then started one after the other. Nothing starts when one is wrong.
   */
  async orderMany(g: GeneralRecord, items: Array<{ squad: string; command: string; args?: string; at?: AtInput }>): Promise<string> {
    if (items.length === 0) fail('no orders given');
    const seen = new Set<string>();
    const plan = items.map((it) => {
      const s = this.squadName(g, it.squad);
      if (seen.has(s)) fail(`squad ${s} is given two orders in one plan`);
      seen.add(s);
      const c = it.command.trim().toLowerCase();
      if (!(OFFERED as readonly string[]).includes(c)) fail(`squad ${s}: unknown order "${it.command}" (${OFFERED.join(', ')})`);
      if (this.online(g, s).length === 0) fail(`squad ${s} has no bot online`);
      return { s, c, args: it.args ?? '', at: it.at ?? {} };
    });
    this.budget(this.runtime(g), 'model', plan.length);
    const out: string[] = [];
    for (const p of plan) {
      this.runtime(g).advancing.delete(p.s);
      try {
        out.push(await this.start(g, p.s, p.c, p.args, p.at, { by: 'model' }));
      } catch (e) {
        out.push(`squad ${p.s}: ${errorMessage(e)}`);
      }
    }
    return out.join('\n');
  }

  async retarget(g: GeneralRecord, squad: string, at: AtInput): Promise<string> {
    const s = this.squadName(g, squad);
    const rt = this.runtime(g);
    const e = rt.orders.get(s);
    const o = e ? this.deps.runner.get(e.orderId) : undefined;
    if (!e || !o || !o.running) fail(`squad ${s} has no running order to retarget (give one with order)`);
    const merged: AtInput = { ...e!.at, ...at };
    if (o!.listening && !e!.advance) {
      const { snap, desc } = this.snapFor(g, s, merged);
      if (o!.deliverTrigger(snap)) {
        e!.at = merged;
        return `${e!.command} of squad ${s} re-aimed: ${desc}`;
      }
    }
    rt.advancing.delete(s);
    return this.start(g, s, e!.command, e!.args, merged, { by: 'model' });
  }

  async advance(g: GeneralRecord, squads: string[] | undefined, distance: number | undefined): Promise<string> {
    const rt = this.runtime(g);
    const list = (squads?.length ? squads.map((s) => this.squadName(g, s)) : Object.keys(g.squads)).filter((s) => this.online(g, s).length > 0);
    if (list.length === 0) fail('no squad with a bot online to advance');
    const front = this.front(g);
    if (front >= g.range - 2) fail(`the army is at the range limit (${g.range} along ${dirName(g.axis)}): change the axis or hold`);
    const leg = clampInt(distance ?? DEFAULT_LEG, 8, 128);
    rt.axisEndSaid = false;
    const lanes = [0, LANE, -LANE, 2 * LANE, -2 * LANE, 3 * LANE, -3 * LANE];
    const out: string[] = [];
    for (const [i, s] of list.entries()) {
      rt.advancing.set(s, { distance: leg, lane: lanes[i % lanes.length]!, back: this.mostlyArchers(g, s) ? ARCHER_BACK : 0, waiting: false });
      try {
        out.push(await this.leg(g, s));
      } catch (e) {
        rt.advancing.delete(s);
        out.push(`squad ${s}: ${errorMessage(e)}`);
      }
    }
    return out.join('\n');
  }

  async stopSquad(g: GeneralRecord, squad: string): Promise<string> {
    const s = this.squadName(g, squad);
    const rt = this.runtime(g);
    rt.advancing.delete(s);
    const e = rt.orders.get(s);
    const o = e ? this.deps.runner.get(e.orderId) : undefined;
    if (!e || !o || o.ended) return `squad ${s} had no running order`;
    e.quiet = true;
    o.silentEnd = true;
    await o.stop('stopped', `stopped by General ${g.name}`);
    return `squad ${s}: ${e.command} stopped; the bots stay where they are`;
  }

  async disband(g: GeneralRecord, squad: string): Promise<string> {
    const s = this.squadName(g, squad);
    await this.stopSquad(g, s);
    const bots = [...g.squads[s]!.bots];
    if (bots.length && !this.sink('general-despawn', { general: g.name, bots })) fail('the server mod is not connected: the bots cannot be despawned now');
    delete g.squads[s];
    this.runtime(g).bands.delete(s);
    this.save();
    return `squad ${s} disbanded: ${bots.length} bot(s) leave (their allowance slots are free again; reinforcements are not refunded)`;
  }

  // -- orders ------------------------------------------------------------------------------------------------------

  /** Whether one more order fits this minute's budget (the model's or the runtime's); fails with the reason. */
  private budget(rt: Runtime, by: 'model' | 'runtime', n = 1, now = Date.now()): void {
    rt.orderTimes = rt.orderTimes.filter((t) => now - t < 60_000);
    rt.runtimeOrderTimes = rt.runtimeOrderTimes.filter((t) => now - t < 60_000);
    if (by === 'model' && rt.orderTimes.length + n > MAX_ORDERS_PER_MINUTE) fail(`${MAX_ORDERS_PER_MINUTE} orders a minute at most (${rt.orderTimes.length} given in the last minute): let the last ones work, wait_events`);
    if (by === 'runtime' && rt.runtimeOrderTimes.length + n > MAX_RUNTIME_ORDERS_PER_MINUTE) fail(`the runtime's ${MAX_RUNTIME_ORDERS_PER_MINUTE} orders a minute are spent`);
  }

  private async start(g: GeneralRecord, s: string, command: string, args: string, at: AtInput, opts: { advance?: boolean; by: 'model' | 'runtime' }): Promise<string> {
    const rt = this.runtime(g);
    const now = Date.now();
    this.budget(rt, opts.by, 1, now);
    const members = this.online(g, s);
    if (members.length === 0) fail(`squad ${s} has no bot online`);
    const { snap, desc, point, sighting } = this.snapFor(g, s, at);
    const tokens = args.trim() ? args.trim().split(/\s+/) : [];
    if (command === 'raid' && !tokens.some((t) => /^[xyz]=/.test(t))) {
      tokens.push(`x=${Math.round(point.x)}`, `y=${Math.round(point.y)}`, `z=${Math.round(point.z)}`);
      if (sighting && !tokens.some((t) => t.startsWith('target='))) tokens.push(`target=${sighting.name}`);
    }
    const prev = rt.orders.get(s);
    const prevOrder = prev ? this.deps.runner.get(prev.orderId) : undefined;
    if (prev && prevOrder && !prevOrder.ended) {
      prev.quiet = true;
      prevOrder.silentEnd = true;
      await prevOrder.stop('stopped', `replaced by General ${g.name}`);
    }
    (opts.by === 'model' ? rt.orderTimes : rt.runtimeOrderTimes).push(now);
    const r = await this.deps.runner.start({ commander: g.owner, command, tokens, filters: members, snap });
    if (!r.ok) fail(`${command} for squad ${s} did not start: ${r.text.replace(/^\[Bots\]\s*/, '')}`);
    const ok = r as { orderId: string; bots: Array<{ name: string; role: string }> };
    const o = this.deps.runner.get(ok.orderId) as Order;
    o.silentEnd = true;
    const entry: OrderEntry = { orderId: ok.orderId, command, args, at, advance: !!opts.advance, by: opts.by, startedAt: now, quiet: false };
    rt.orders.set(s, entry);
    void o.waitEnded().then(() => this.ended(g.name, s, entry, o));
    const roles = new Map<string, number>();
    for (const b of ok.bots) roles.set(b.role, (roles.get(b.role) ?? 0) + 1);
    return `squad ${s}: ${command} #${ok.orderId} (${[...roles].map(([k, v]) => `${v} ${k}`).join(', ')}) ${desc}`;
  }

  private ended(name: string, s: string, entry: OrderEntry, o: Order): void {
    const g = this.records.get(name.toLowerCase());
    if (!g) return;
    const rt = this.runtime(g);
    if (entry.quiet) return; // the entry stays for squad_detail's logs until a newer order replaces it
    const adv = rt.advancing.get(s);
    if (entry.advance && adv && o.report.status === 'done') {
      adv.waiting = true; // the next leg starts from sample() once the others caught up
      return;
    }
    if (adv) rt.advancing.delete(s);
    const r = o.report;
    const why = r.result ? `: ${r.result}` : r.error ? `: ${r.error.message.split('\n')[0]}` : '';
    rt.events.push('order-end', `squad ${s}: ${entry.command} ${r.status}${why}`);
  }

  private async leg(g: GeneralRecord, s: string): Promise<string> {
    const rt = this.runtime(g);
    const adv = rt.advancing.get(s);
    if (!adv) return `squad ${s}: not advancing`;
    const front = this.front(g);
    if (front >= g.range - 2) {
      rt.advancing.clear();
      if (!rt.axisEndSaid) {
        rt.axisEndSaid = true;
        rt.events.push('axis-end', `the advance reached the range limit (${g.range} along ${dirName(g.axis)}) with no contact: the army holds`);
      }
      return `squad ${s}: at the range limit, holding`;
    }
    const forward = Math.min(g.range, front + adv.distance) - adv.back;
    const target = onAxis(g.spawn, g.axis, forward, adv.lane);
    target.y = this.groundY(g, target.x, target.z, this.armyCenter(g)?.y ?? g.spawn.y) ?? g.spawn.y;
    adv.target = target;
    adv.waiting = false;
    const pos = `${Math.round(target.x)} ${Math.round(target.y)} ${Math.round(target.z)}`;
    return this.start(g, s, 'raid', 'quiet=3 radius=24', { pos, facing: dirName(g.axis) }, { advance: true, by: 'runtime' });
  }

  /** The commander snapshot of an order: where it "stands" (just behind the point), its facing, what it points at. */
  private snapFor(g: GeneralRecord, s: string, at: AtInput): { snap: Snapshot; desc: string; point: Vec3Like; sighting?: Sighting } {
    const rt = this.runtime(g);
    const here = this.squadCenter(g, s) ?? g.spawn;
    let sighting: Sighting | undefined;
    if (at.target) {
      sighting = this.resolveTarget(rt, at.target, here);
      if (!sighting) fail(`no enemy "${at.target}" in sight (a cluster id like X1, an enemy name, or #entityId; see the sitrep)`);
    }
    let point: Vec3Like;
    if (sighting) point = { ...sighting.pos };
    else if (at.pos) point = parsePosition(at.pos, this.posCtx(g));
    else point = { ...here };
    if (!sighting) point.y = this.groundY(g, point.x, point.z, point.y === g.spawn.y ? here.y : point.y) ?? point.y;
    const facing = at.facing ? parseDirection(at.facing) : sighting && horizontal(here, point) > 2 ? yawToward(here, point) : g.axis;
    const d = dirOf(facing);
    const lookEntity: EntityRef | null = sighting ? { id: sighting.id, name: 'player', type: 'player', username: sighting.name, position: { ...sighting.pos } } : null;
    const snap: Snapshot = {
      position: { x: point.x - d.x * 4, y: point.y, z: point.z - d.z * 4 },
      yaw: facing,
      pitch: 0,
      dimension: g.spawn.dimension,
      heldItem: null,
      lookBlock: sighting ? null : { x: Math.floor(point.x), y: Math.floor(point.y) - 1, z: Math.floor(point.z), name: 'ground' },
      lookEntity,
      trigger: { kind: 'use', item: 'general' },
    };
    const desc = sighting ? `on ${sighting.name} @${rel(g.spawn, point)} facing ${dirName(facing)}` : `at ${rel(g.spawn, point)} facing ${dirName(facing)}`;
    return { snap, desc, point, ...(sighting ? { sighting } : {}) };
  }

  private resolveTarget(rt: Runtime, target: string, from: Vec3Like): Sighting | undefined {
    const t = target.trim();
    const c = /^X\d+$/i.test(t) ? rt.tracker.get(t) : undefined;
    if (c) {
      let best: Sighting | undefined;
      for (const m of c.members.values()) if (!best || horizontal(m.pos, from) < horizontal(best.pos, from)) best = m;
      return best;
    }
    const id = /^#(\d+)$/.exec(t);
    for (const cl of rt.tracker.all()) {
      for (const m of cl.members.values()) {
        if (id ? m.id === Number(id[1]) : m.name.toLowerCase() === t.toLowerCase()) return m;
      }
    }
    return undefined;
  }

  // -- the sampler ---------------------------------------------------------------------------------------------------

  /** Once a second: what the army sees, the events it gives, the advance's next legs. Public for the tests. */
  sample(now = Date.now()): void {
    for (const g of this.records.values()) this.sampleOne(g, now);
    for (const p of [...this.pending.values()]) if (now - p.at > SPAWN_TIMEOUT_MS) this.closeIfDone(p, true, true);
  }

  private sampleOne(g: GeneralRecord, now: number): void {
    const rt = this.runtime(g);
    const army = new Set(this.deps.roster.botsOf(g.owner.uuid).map((b) => b.name.toLowerCase()));
    const sightings = new Map<number, Sighting>();
    rt.mobs.clear();
    for (const [s, sq] of Object.entries(g.squads)) {
      const healths: number[] = [];
      let mobs = 0;
      for (const n of sq.bots) {
        const bot = this.deps.pool.bot(n);
        if (!bot?.entity) continue;
        this.watch(n, bot);
        healths.push(bot.health ?? 0);
        for (const e of Object.values(bot.entities ?? {})) {
          if (!e || e === bot.entity || !e.position) continue;
          if (e.type === 'player') {
            const u = e.username;
            if (!u || army.has(u.toLowerCase()) || u === g.owner.name) continue;
            if (bot.players?.[u]?.gamemode === 3) continue;
            if (!sightings.has(e.id)) {
              const eq = (e as unknown as { equipment?: Array<{ name: string } | null> }).equipment ?? [];
              sightings.set(e.id, { id: e.id, name: u, pos: { x: e.position.x, y: e.position.y, z: e.position.z }, held: eq[0]?.name ?? null, armor: eq[4]?.name ?? null });
            }
          } else if (e.type === 'hostile' && bot.entity.position.distanceTo(e.position) <= 16) {
            mobs++;
          }
        }
      }
      if (mobs) rt.mobs.set(s, mobs);
      this.band(g, rt, s, healths, now);
    }
    const u = rt.tracker.update(now, [...sightings.values()]);
    for (const c of u.appeared) rt.events.push('contact', `${clusterLine(g, c, now)}${this.nearestSquadText(g, c)}`, now);
    for (const c of u.lost) rt.events.push('contact-lost', `${clusterLine(g, c, now)}${this.nearestSquadText(g, c)}`, now);
    this.underFire(g, rt, now);
    this.approaches(g, rt, now);

    // The advance: a squad whose leg ended goes on once it is not far ahead of the slowest advancing squad.
    for (const [s, adv] of rt.advancing) {
      if (!adv.waiting) continue;
      const mine = this.squadCenter(g, s);
      if (!mine) continue;
      const mineAlong = along(g.spawn, g.axis, mine);
      const others = [...rt.advancing.keys()].filter((o) => o !== s).map((o) => this.squadCenter(g, o)).filter((p): p is Vec3Like => !!p).map((p) => along(g.spawn, g.axis, p));
      if (others.length && mineAlong - Math.min(...others) > LEG_SPREAD) continue;
      adv.waiting = false;
      void this.leg(g, s).catch((e) => {
        rt.advancing.delete(s);
        rt.events.push('order-end', `squad ${s}: the advance stopped (${errorMessage(e)})`);
      });
    }

    // Idle: bots online, nothing seen, nothing running, no advance.
    const online = Object.keys(g.squads).some((s) => this.online(g, s).length > 0);
    const busy = [...rt.orders.values()].some((e) => this.deps.runner.get(e.orderId)?.running) || rt.advancing.size > 0;
    if (online && !busy && rt.tracker.visible(now).length === 0) {
      rt.idleSince ??= now;
      if (!rt.idleSaid && now - rt.idleSince >= IDLE_MS) {
        rt.idleSaid = true;
        rt.events.push('idle', `no enemy in sight and every squad idle: advance along the axis (${dirName(g.axis)}) unless the mission says otherwise`, now);
      }
    } else {
      rt.idleSince = undefined;
      rt.idleSaid = false;
    }
  }

  /** A squad hit by UNDER_FIRE_ARROWS arrows within UNDER_FIRE_MS: where they come from (once per UNDER_FIRE_AGAIN_MS). */
  private underFire(g: GeneralRecord, rt: Runtime, now: number): void {
    rt.hits = rt.hits.filter((h) => now - h.t < HIT_MEMORY_MS);
    const arrows = new Map<string, number>();
    for (const h of rt.hits) if (h.kind === 'arrow' && now - h.t < UNDER_FIRE_MS) arrows.set(h.squad, (arrows.get(h.squad) ?? 0) + 1);
    for (const [s, n] of arrows) {
      if (n < UNDER_FIRE_ARROWS || !g.squads[s]) continue;
      if (now - (rt.fireSaid.get(s) ?? -Infinity) < UNDER_FIRE_AGAIN_MS) continue;
      rt.fireSaid.set(s, now);
      rt.events.push('under-fire', `squad ${s}: ${this.hitsSummary(g, rt, s, now, UNDER_FIRE_MS)}`, now);
    }
  }

  /** A visible cluster within APPROACH_WITHIN of a squad and closing on it: once, until it goes beyond APPROACH_RESET. */
  private approaches(g: GeneralRecord, rt: Runtime, now: number): void {
    for (const c of rt.tracker.visible(now)) {
      for (const s of Object.keys(g.squads)) {
        const at = this.squadCenter(g, s);
        if (!at) continue;
        const key = `${c.id}|${s}`;
        const d = horizontal(at, c.center);
        if (d > APPROACH_RESET) rt.approachSaid.delete(key);
        if (d > APPROACH_WITHIN || rt.approachSaid.has(key) || !c.velocity || d < 1) continue;
        const closing = (c.velocity.x * (at.x - c.center.x) + c.velocity.z * (at.z - c.center.z)) / d;
        if (closing < APPROACH_SPEED) continue;
        rt.approachSaid.set(key, now);
        rt.events.push('enemy-approach', `${c.id} (${c.members.size}, ${kitOfCluster(c.members.values())}) ${Math.round(d)}b from squad ${s}, closing at ${closing.toFixed(1)}b/s from ${dirName(yawToward(at, c.center))}: contact in ~${Math.round(d / closing)}s`, now);
      }
    }
  }

  /** A squad's mean health crossing 75 / 50 / 25 % downward is an event; it is armed again 10 points above. */
  private band(g: GeneralRecord, rt: Runtime, s: string, healths: number[], now: number): void {
    if (healths.length === 0) return;
    const pct = (healths.reduce((a, b) => a + b, 0) / healths.length / 20) * 100;
    const last = rt.bands.get(s) ?? 100;
    const lowest = HP_BANDS.filter((b) => pct < b).pop();
    if (lowest !== undefined && lowest < last) {
      rt.bands.set(s, lowest);
      const why = this.hitsSummary(g, rt, s, now);
      rt.events.push('hp-band', `squad ${s} health down to ${Math.round(pct)}% (below ${lowest}%); ${why || 'no hit seen (fire, a fall, hunger?)'}`);
    } else if (pct >= last + 10) {
      rt.bands.set(s, [...HP_BANDS, 100].filter((b) => b > pct - 10).sort((a, b) => a - b)[0] ?? 100);
    }
  }

  private botGone(name: string, reason: string): void {
    if (reason !== 'died') return;
    for (const g of this.records.values()) {
      if (!this.deps.roster.isOwner(name, g.owner.uuid)) continue;
      const s = this.squadOf(g, name) ?? '(no squad)';
      const rt = this.runtime(g);
      const list = rt.deaths.get(s) ?? [];
      list.push(Date.now());
      rt.deaths.set(s, list);
      const left = this.online(g, s).filter((n) => n !== name).length;
      const now = Date.now();
      const last = [...rt.hits].reverse().find((h) => h.bot.toLowerCase() === name.toLowerCase() && now - h.t < HIT_MEMORY_MS);
      const by = last ? `, killed by ${this.hitText(rt, last, this.squadCenter(g, s))}` : '';
      rt.events.push('casualty', `${name} of squad ${s} died${by} (${left} left online; ${g.reinforce} reinforcement(s))`);
    }
  }

  /** Each army bot reports the deaths it sees: an enemy of a cluster dying is a kill. */
  private watch(name: string, bot: Bot): void {
    const g = [...this.records.values()].find((r) => this.deps.roster.isOwner(name, r.owner.uuid));
    if (!g) return;
    const rt = this.runtime(g);
    if (rt.watched.has(bot)) return;
    rt.watched.add(bot);
    bot.on('entityDead', (e: { id: number }) => {
      const gg = this.records.get(g.name.toLowerCase());
      if (!gg) return;
      const r = this.runtime(gg);
      const s = r.tracker.remove(e.id);
      if (s) r.events.push('kill', `${s.name} died (seen by ${name})`);
    });
    // hits.ts emits it (not one of mineflayer's typed events).
    (bot as unknown as EventEmitter).on('hurtBy', (h: HurtBy) => {
      const gg = this.records.get(g.name.toLowerCase());
      if (!gg) return;
      this.hurt(gg, name, h);
    });
  }

  /** One hit on an army bot, remembered for HIT_MEMORY_MS. Public for the tests (the fakes emit no damage_event). */
  hurt(g: GeneralRecord, bot: string, h: HurtBy, now = Date.now()): void {
    const rt = this.runtime(g);
    rt.hits = rt.hits.filter((x) => now - x.t < HIT_MEMORY_MS);
    const a = h.attacker as { id?: number; username?: string; name?: string } | null;
    rt.hits.push({
      t: now,
      bot,
      squad: this.squadOf(g, bot) ?? '(no squad)',
      name: a ? (a.username ?? a.name ?? null) : null,
      id: typeof a?.id === 'number' ? a.id : null,
      kind: h.kind,
      weapon: h.weapon,
      from: h.from ? { x: h.from.x, y: h.from.y, z: h.from.z } : null,
    });
  }

  /** "Paul (bow, arrow from NE 70b, X3)": one hit, seen from `at`. */
  private hitText(rt: Runtime, h: Hit, at: Vec3Like | undefined): string {
    const parts = [h.weapon ? shortItem(h.weapon) : null, h.kind === 'melee' ? 'melee' : h.kind === 'arrow' ? 'arrow' : null].filter(Boolean);
    if (h.from && at) {
      const d = horizontal(at, h.from);
      parts.push(d >= 2 ? `from ${dirName(yawToward(at, h.from))} ${Math.round(d)}b` : 'point-blank');
    }
    const c = h.id !== null ? rt.tracker.all().find((cl) => cl.members.has(h.id!)) : undefined;
    if (c) parts.push(c.id);
    return `${h.name ?? (h.kind === 'arrow' ? 'an unseen archer' : 'unknown')} (${parts.join(', ')})`;
  }

  /** The hits on a squad in the last `ms`, in one phrase: "7 hits in 10s: 5 arrows from NE ~70b (X3), 2 melee (Paul)". */
  private hitsSummary(g: GeneralRecord, rt: Runtime, s: string, now: number, ms = HIT_MEMORY_MS): string {
    const mine = rt.hits.filter((h) => h.squad === s && now - h.t < ms);
    if (mine.length === 0) return '';
    const at = this.squadCenter(g, s);
    const groups = new Map<string, { n: number; h: Hit; d: number[] }>();
    for (const h of mine) {
      const c = h.id !== null ? rt.tracker.all().find((cl) => cl.members.has(h.id!))?.id : undefined;
      const dir = h.from && at && horizontal(at, h.from) >= 2 ? dirName(yawToward(at, h.from)) : '';
      const k = `${h.kind}|${c ?? h.name ?? ''}|${dir}`;
      const e = groups.get(k) ?? { n: 0, h, d: [] };
      e.n++;
      if (h.from && at) e.d.push(horizontal(at, h.from));
      groups.set(k, e);
    }
    const parts = [...groups.values()]
      .sort((a, b) => b.n - a.n)
      .map(({ n, h, d }) => {
        const what = h.kind === 'arrow' ? `arrow${n === 1 ? '' : 's'}` : h.kind === 'melee' ? 'melee' : 'other';
        const dir = h.from && at && horizontal(at, h.from) >= 2 ? ` from ${dirName(yawToward(at, h.from))} ~${Math.round(d.reduce((a, b) => a + b, 0) / Math.max(1, d.length))}b` : '';
        const c = h.id !== null ? rt.tracker.all().find((cl) => cl.members.has(h.id!))?.id : undefined;
        const who = c ?? h.name;
        return `${n} ${what}${dir}${who ? ` (${who})` : ''}`;
      });
    return `${mine.length} hit${mine.length === 1 ? '' : 's'} in ${Math.round(ms / 1000)}s: ${parts.join(', ')}`;
  }

  // -- helpers -------------------------------------------------------------------------------------------------------

  private runtime(g: GeneralRecord): Runtime {
    const k = g.name.toLowerCase();
    let rt = this.rt.get(k);
    if (!rt) {
      rt = {
        events: new EventRing(this.deps.coalesceMs),
        tracker: new ClusterTracker(),
        orders: new Map(),
        advancing: new Map(),
        bands: new Map(),
        mobs: new Map(),
        orderTimes: [],
        runtimeOrderTimes: [],
        idleSaid: false,
        axisEndSaid: false,
        startedAt: Date.now(),
        deaths: new Map(),
        watched: new WeakSet(),
        hits: [],
        fireSaid: new Map(),
        approachSaid: new Map(),
      };
      this.rt.set(k, rt);
    }
    return rt;
  }

  /** For the tests: the General's event ring. */
  events(g: GeneralRecord): EventRing {
    return this.runtime(g).events;
  }

  private squadName(g: GeneralRecord, squad: string, create = false): string {
    const want = squad.trim().toLowerCase();
    const found = Object.keys(g.squads).find((s) => s.toLowerCase() === want);
    if (found) return found;
    if (create) return squad.trim();
    return fail(`unknown squad "${squad}" (${Object.keys(g.squads).join(', ') || 'none yet: spawn_squad'})`);
  }

  private squadOf(g: GeneralRecord, bot: string): string | undefined {
    return Object.entries(g.squads).find(([, sq]) => sq.bots.some((b) => b.toLowerCase() === bot.toLowerCase()))?.[0];
  }

  private putInSquad(g: GeneralRecord, bot: string, squad: string): void {
    for (const sq of Object.values(g.squads)) sq.bots = sq.bots.filter((b) => b.toLowerCase() !== bot.toLowerCase());
    (g.squads[squad] ??= { bots: [] }).bots.push(bot);
  }

  /** A despawned bot leaves its squad (the roster no longer has it). */
  private forgetDespawned(): void {
    let changed = false;
    for (const g of this.records.values()) {
      for (const sq of Object.values(g.squads)) {
        const keep = sq.bots.filter((b) => this.deps.roster.has(b) || this.pendingNames().has(b.toLowerCase()));
        if (keep.length !== sq.bots.length) {
          sq.bots = keep;
          changed = true;
        }
      }
      for (const b of Object.keys(g.kits)) if (!this.deps.roster.has(b)) {
        delete g.kits[b];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private pendingNames(): Set<string> {
    const s = new Set<string>();
    for (const p of this.pending.values()) for (const n of p.names) s.add(n.toLowerCase());
    return s;
  }

  private online(g: GeneralRecord, s: string): string[] {
    return (g.squads[s]?.bots ?? []).filter((n) => !this.deps.roster.get(n)?.dead && !!this.deps.pool.bot(n)?.entity);
  }

  private orderOf(bot: string): Order | undefined {
    return this.deps.runner.running().find((o) => o.hasMember(bot));
  }

  private kitOf(g: GeneralRecord, bot: string): string | undefined {
    return g.kits[bot] ?? this.deps.roster.get(bot)?.tags.find((t) => (KITS as readonly string[]).includes(t));
  }

  private fielded(g: GeneralRecord, kit: string): number {
    const have = this.deps.roster.botsOf(g.owner.uuid).filter((b) => this.kitOf(g, b.name) === kit).length;
    let pending = 0;
    for (const p of this.pending.values()) if (!p.revive && p.kit === kit && this.byRequest(p) === g) pending += Math.max(0, p.want - p.names.length - p.failed.length);
    return have + pending;
  }

  private fieldedAll(g: GeneralRecord): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of Object.keys(g.allowance)) out[k] = this.fielded(g, k);
    return out;
  }

  private pendingTotal(): number {
    let n = 0;
    for (const p of this.pending.values()) if (!p.revive) n += Math.max(0, p.want - p.names.length - p.failed.length);
    return n;
  }

  private byRequest(p: PendingSpawn): GeneralRecord | undefined {
    return this.records.get(p.general.toLowerCase());
  }

  private closeIfDone(p: PendingSpawn, force = false, timedOut = false): void {
    const done = p.arrived.length + p.failed.length >= p.want;
    if (!done && !force) return;
    if (!done && !timedOut && p.names.length + p.failed.length < p.want) return; // more answers are coming
    this.pending.delete(p.id);
    const g = this.byRequest(p);
    if (!g || p.arrived.length === 0) return;
    const late = p.want - p.arrived.length - p.failed.length;
    this.runtime(g).events.push(
      'arrived',
      `squad ${p.squad}: ${p.arrived.length} ${p.kit} ${p.revive ? 'back' : 'arrived'} at the spawn point (${p.arrived.join(', ')})${late > 0 ? `; ${late} never came` : ''}`,
    );
  }

  private squadCenter(g: GeneralRecord, s: string): Vec3Like | undefined {
    const ps = this.online(g, s).map((n) => this.deps.pool.bot(n)!.entity.position);
    return ps.length ? centroid(ps) : undefined;
  }

  private armyCenter(g: GeneralRecord): Vec3Like | undefined {
    const ps: Vec3Like[] = [];
    for (const s of Object.keys(g.squads)) for (const n of this.online(g, s)) ps.push(this.deps.pool.bot(n)!.entity.position);
    return ps.length ? centroid(ps) : undefined;
  }

  /** How far along the axis the army's foremost bot stands (0 with nobody online). */
  private front(g: GeneralRecord): number {
    let best = 0;
    for (const s of Object.keys(g.squads)) for (const n of this.online(g, s)) best = Math.max(best, along(g.spawn, g.axis, this.deps.pool.bot(n)!.entity.position));
    return best;
  }

  private posCtx(g: GeneralRecord): { spawn: Vec3Like; axis: number; front: number } {
    return { spawn: g.spawn, axis: g.axis, front: this.front(g) };
  }

  private mostlyArchers(g: GeneralRecord, s: string): boolean {
    const bots = this.online(g, s);
    return bots.filter((n) => ['archer', 'horsearcher'].includes(this.kitOf(g, n) ?? '')).length * 2 > bots.length;
  }

  private anyBot(g: GeneralRecord): Bot | undefined {
    for (const s of Object.keys(g.squads)) for (const n of this.online(g, s)) return this.deps.pool.bot(n);
    return undefined;
  }

  /** The feet height of the ground at (x, z) near `nearY`, as an army bot knows it; null when no bot has that chunk. */
  private groundY(g: GeneralRecord, x: number, z: number, nearY: number): number | null {
    const bot = this.anyBot(g);
    return bot ? groundFeet(bot, x, z, nearY) : null;
  }

  private squadLine(g: GeneralRecord, rt: Runtime, s: string, visible: Cluster[]): string {
    const bots = g.squads[s]!.bots.filter((n) => this.deps.roster.has(n));
    const on = this.online(g, s);
    const kits = new Map<string, number>();
    for (const n of bots) {
      const k = this.kitOf(g, n) ?? '?';
      kits.set(k, (kits.get(k) ?? 0) + 1);
    }
    const hp = on.length ? Math.round((on.reduce((a, n) => a + (this.deps.pool.bot(n)?.health ?? 0), 0) / on.length / 20) * 100) : 0;
    const center = this.squadCenter(g, s);
    const adv = rt.advancing.get(s);
    const e = rt.orders.get(s);
    const o = e ? this.deps.runner.get(e.orderId) : undefined;
    const doing = adv ? `advance${adv.target ? `→${rel(g.spawn, adv.target)}` : ''}${adv.waiting ? ' (waiting for the others)' : ''}` : o?.running ? e!.command : 'idle';
    let contact = '';
    if (center) {
      let best: { c: Cluster; d: number } | undefined;
      for (const c of visible) {
        const d = horizontal(center, c.center);
        if (d <= 32 && (!best || d < best.d)) best = { c, d };
      }
      if (best) contact = ` contact ${best.c.id} ${Math.round(best.d)}b`;
    }
    const dead = bots.filter((n) => this.deps.roster.get(n)?.dead).length;
    const mobs = rt.mobs.get(s);
    return `${s} ${on.length}/${bots.length} ${[...kits].map(([k, v]) => `${k}${v}`).join(' ')} hp${hp} ${doing}${center ? ` @${rel(g.spawn, center)}` : ''}${contact}${dead ? ` dead${dead}` : ''}${mobs ? ` mobs${mobs}` : ''}`;
  }

  private nearestSquadText(g: GeneralRecord, c: Cluster): string {
    let best: { s: string; d: number } | undefined;
    for (const s of Object.keys(g.squads)) {
      const p = this.squadCenter(g, s);
      if (!p) continue;
      const d = horizontal(p, c.center);
      if (!best || d < best.d) best = { s, d };
    }
    return best ? ` (${Math.round(best.d)} blocks from squad ${best.s})` : '';
  }

  private save(): void {
    const file = this.deps.file;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ generals: [...this.records.values()] }, null, 2));
    renameSync(tmp, file);
  }
}

// -- formatting ---------------------------------------------------------------------------------------------------------

function clusterLine(g: GeneralRecord, c: Cluster, now: number): string {
  const v = c.lost ? c.lastVelocity : c.velocity;
  const speed = v ? Math.hypot(v.x, v.z) : 0;
  const heading = v && speed >= 0.5 ? ` →${dirName(yawToward({ x: 0, y: 0, z: 0 }, { x: v.x, y: 0, z: v.z }))} ${speed.toFixed(1)}b/s` : ' static';
  const names = [...c.members.values()].map((m) => m.name);
  const shown = names.slice(0, 3).join(',') + (names.length > 3 ? `,+${names.length - 3}` : '');
  const ago = Math.round((now - c.lastSeen) / 1000);
  // A lost cluster keeps where it was last seen and how it was moving then (docs/45 §2).
  return c.lost
    ? `${c.id} ${c.members.size} LOST ${ago}s ago, last @${rel(g.spawn, c.center)} y${Math.round(c.center.y)}${heading} ${kitOfCluster(c.members.values())} [${shown}]`
    : `${c.id} ${c.members.size} @${rel(g.spawn, c.center)} y${Math.round(c.center.y)}${heading} ${kitOfCluster(c.members.values())} [${shown}] seen ${ago}s ago`;
}

function eventLine(e: GeneralEvent, now: number): string {
  return `[${Math.round((now - e.at) / 1000)}s ago] ${e.kind}: ${e.text}`;
}

function missionText(g: GeneralRecord): string {
  const goal = g.mission.goal ? `goal: ${g.mission.goal}` : 'goal: (not set: seek and destroy enemy bots along the axis)';
  const strat = g.mission.strategy ? `strategy: ${g.mission.strategy}` : 'strategy: (not set: your choice)';
  return `${goal} | ${strat}`;
}

function allowanceText(g: GeneralRecord, fielded?: Record<string, number>): string {
  return Object.entries(g.allowance).map(([k, v]) => (fielded ? `${k} ${fielded[k] ?? 0}/${v}` : `${k}=${v}`)).join(' ') || 'none';
}

/**
 * What a bot is doing now, read from its body (no script API: docs/45 §2): mounted or not, its fight (pvp's target),
 * a drawn bow or a raised shield, the pathfinder's goal, else standing; with what it holds.
 */
function doing(g: GeneralRecord, bot: Bot): string {
  const b = bot as unknown as {
    vehicle?: unknown;
    usingHeldItem?: boolean;
    heldItem?: { name: string } | null;
    pvp?: { target?: { username?: string; name?: string } | null };
    pathfinder?: { goal?: { x?: number; z?: number } | null };
    inventory?: { slots?: Array<{ name?: string } | null> };
  };
  const parts: string[] = [];
  if (b.vehicle) parts.push('mounted');
  const held = b.heldItem?.name ?? null;
  const t = b.pvp?.target;
  const goal = b.pathfinder?.goal;
  const offHand = b.inventory?.slots?.[45]?.name;
  if (t) parts.push(`fighting ${t.username ?? t.name ?? '?'}`);
  else if (b.usingHeldItem && held && /bow/.test(held)) parts.push('drawing its bow');
  else if (b.usingHeldItem && (held === 'shield' || offHand === 'shield')) parts.push('shield up');
  else if (b.usingHeldItem && held && /_spear$/.test(held)) parts.push('charging (spear held)');
  if (goal && typeof goal.x === 'number' && typeof goal.z === 'number') {
    const d = horizontal(bot.entity.position, { x: goal.x, y: 0, z: goal.z });
    parts.push(d > 1.5 ? `moving to ${rel(g.spawn, { x: goal.x, y: 0, z: goal.z })} (${Math.round(d)}b)` : 'at its place');
  } else if (!t && !b.usingHeldItem) parts.push('standing');
  return `${parts.join(', ')}, holds ${held ? shortItem(held) : 'nothing'}`;
}

/** An item's name without its namespace. */
function shortItem(name: string): string {
  return name.replace(/^minecraft:/, '');
}

function fmt(p: Vec3Like): string {
  return `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`;
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function checkAllowance(a: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a ?? {})) {
    const kit = k.toLowerCase();
    if (!(KITS as readonly string[]).includes(kit)) throw new GeneralError(`kit inconnu « ${k} » (${KITS.join(', ')})`);
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new GeneralError(`« ${k} » : un nombre entier de 0 à 100`);
    out[kit] = n;
  }
  return out;
}

/** Feet height of the ground nearest `nearY` at (x, z): a solid block under two open ones. Null if not loaded. */
export function groundFeet(bot: Bot, x: number, z: number, nearY: number): number | null {
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  const at = (y: number) => bot.blockAt(new Vec3(bx, y, bz));
  const base = Math.round(nearY);
  for (let d = 0; d <= 24; d++) {
    for (const y of d === 0 ? [base] : [base + d, base - d]) {
      const below = at(y - 1);
      if (!below) return null;
      const feet = at(y);
      const head = at(y + 1);
      if (below.boundingBox === 'block' && feet?.boundingBox === 'empty' && head?.boundingBox === 'empty') return y;
    }
  }
  return null;
}

function terrainChar(bot: Bot, x: number, z: number, levelY: number): string {
  const y = groundFeet(bot, x, z, bot.entity?.position.y ?? levelY);
  if (y === null) return '?';
  const under = bot.blockAt(new Vec3(Math.floor(x), y - 1, Math.floor(z)))?.name ?? '';
  const feet = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)))?.name ?? '';
  if (feet === 'water' || under === 'water') return '~';
  if (feet === 'lava' || under === 'lava') return '!';
  const d = y - levelY;
  if (d >= 5) return '^';
  if (d >= 2) return '+';
  if (d <= -5) return '_';
  if (d <= -2) return '-';
  return '.';
}

