// BotPool — owns all 11 bot connections (10 villagers + the avatar). Staggers logins (R13/I1),
// pins the protocol (R11), runs short view distance (R8), reconnects with backoff, journals the
// connect/disconnect lifecycle + the authoritative death packet (R27/G2), and emits the per-bot
// vitals snapshot (M1-5). It NEVER ops anyone — op-on-join is the Java mod's avatar-only privilege
// (R14); the pool's only contract there is to know which single member is divine.
//
// Layer 1: imports journal/config/types + bots/* siblings only (the dependency law).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import mineflayer from 'mineflayer';

import type { Bot, Tier } from '../types/index';
import type { JournalAppender } from '../journal/journal';
import { logger } from '../logger';
import { boundPathfinder } from './hardening';
import { loadPlugins, pathfinder } from './plugins';

const SUPPORTED_MINECRAFT_VERSION = '1.21.1'; // R11 — server, mod, and bot must agree
/** I1: v1's LOGIN_STAGGER_MS. Burst-spawning 11 bots trips login throttles. NOT a config key. */
export const LOGIN_STAGGER_MS = 4_000;
const KEEPALIVE_INTERVAL_MS = 90_000; // R13 — give keepalive more rope; reconnect handles real outages
/** Reconnect backoff schedule (ms), clamped to the last value. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/** What the pool hands a createBot factory — the real one maps it onto mineflayer.createBot. */
export interface SpawnRequest {
  host: string;
  port: number;
  username: string;
  /** Pinned protocol version — server, mod, and bot must agree (R11). */
  version: string;
  /** R8: short, not 'tiny' — 'tiny' makes 32-block searches scan unloaded chunks. */
  viewDistance: 'short';
  /** Keepalive window in ms (R13) — give it rope; reconnect handles real outages. */
  checkTimeoutInterval: number;
}

/** The bot factory seam — defaults to the real mineflayer createBot; tests inject a FakeBot maker. */
export type CreateBot = (req: SpawnRequest) => Bot;

/** A roster member: a villager (mortal) or the single avatar (divine). */
export interface Member {
  name: string;
  role: string;
  tier: Tier;
  isAvatar: boolean;
}

/** Everything {@link BotPool} needs: the factory seam, journal sink, target server, roster, and cadences. */
export interface BotPoolOptions {
  createBot?: CreateBot;
  journal: JournalAppender;
  host: string;
  port: number;
  version?: string;
  villagers: ReadonlyArray<{ name: string; role: string }>;
  avatarName: string;
  dataDir: string;
  /** Stable identifier of the world this data dir belongs to (R32). */
  worldId: string;
  vitalsIntervalMs: number;
  /** Override the login stagger (tests). Production uses {@link LOGIN_STAGGER_MS} (I1). */
  staggerMs?: number;
  /** Which skill (if any) a bot is currently running — for the vitals snapshot. Default: none. */
  currentRunOf?: (name: string) => string | null;
}

interface BotRecord {
  member: Member;
  bot: Bot | null;
  state: 'connecting' | 'connected' | 'disconnected';
  reconnectAttempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The real mineflayer factory: pre-spawn pathfinder, pinned version, short view distance. */
function defaultCreateBot(req: SpawnRequest): Bot {
  // The plugin objects (pvp/collectBlock/…) attach POST-spawn, so the bare bot wouldn't satisfy
  // the seam yet — cast through unknown at this one boundary (Decision D-14, types/bot.ts).
  return mineflayer.createBot({
    host: req.host,
    port: req.port,
    username: req.username,
    version: req.version,
    viewDistance: req.viewDistance,
    checkTimeoutInterval: req.checkTimeoutInterval,
    plugins: { pathfinder },
  }) as unknown as Bot;
}

/** Owns all 11 bot connections (10 villagers + the avatar): staggered login, reconnect, vitals, death. */
export class BotPool {
  private readonly opts: BotPoolOptions;
  private readonly createBot: CreateBot;
  private readonly staggerMs: number;
  private readonly members: Member[];
  private readonly records = new Map<string, BotRecord>();
  private vitalsTimer?: ReturnType<typeof setInterval>;
  private stopping = false;

  constructor(opts: BotPoolOptions) {
    this.opts = opts;
    this.createBot = opts.createBot ?? defaultCreateBot;
    this.staggerMs = opts.staggerMs ?? LOGIN_STAGGER_MS;
    // Villagers are mortal; the avatar is the single divine member (R14). Avatar LAST (R13/I1).
    this.members = [
      ...opts.villagers.map((v) => ({ name: v.name, role: v.role, tier: 'mortal' as Tier, isAvatar: false })),
      { name: opts.avatarName, role: 'avatar', tier: 'divine' as Tier, isAvatar: true },
    ];
    for (const m of this.members) {
      this.records.set(m.name, { member: m, bot: null, state: 'disconnected', reconnectAttempts: 0 });
    }
  }

  /** The roster with tiers — the read-contract that proves op is the avatar's privilege alone (R14). */
  roster(): Member[] {
    return this.members.map((m) => ({ ...m }));
  }

  /** The live bot for `name`, or undefined if not currently connected. */
  bot(name: string): Bot | undefined {
    return this.records.get(name)?.bot ?? undefined;
  }
  /** The single divine member's bot, if it's connected (R14). */
  avatar(): Bot | undefined {
    const m = this.members.find((x) => x.isAvatar);
    return m ? this.bot(m.name) : undefined;
  }
  /** How many members are currently in the `connected` state. */
  connectedCount(): number {
    return [...this.records.values()].filter((r) => r.state === 'connected').length;
  }

  /** Stamp the data dir with the world id (R32), then spawn all bots staggered + start vitals. */
  async start(): Promise<void> {
    const stamp = stampWorldId(this.opts.dataDir, this.opts.worldId);
    if (stamp.status === 'mismatch') {
      // R32: a regenerated world leaves stale BELIEFS, not just coordinates. The quarantine-behind-
      // an-admin-decision lands in M6; M1 just stamps and shouts.
      logger.warn(
        'bots',
        `world id changed ${stamp.previous} → ${stamp.worldId} — persisted memories may be from a dead world (R32); quarantine is an M6 admin decision`,
      );
    }
    await this.spawnAll();
    this.startVitals();
  }

  /** Spawn every member with a stagger between logins; the avatar comes up last (R13/I1). */
  async spawnAll(): Promise<void> {
    for (let i = 0; i < this.members.length; i++) {
      if (i > 0) await delay(this.staggerMs);
      this.connect(this.members[i] as Member);
    }
  }

  // Create a bot for `member` and wire its lifecycle listeners (spawn/end/kick/death).
  private connect(member: Member): void {
    const req: SpawnRequest = {
      host: this.opts.host,
      port: this.opts.port,
      username: member.name,
      version: this.opts.version ?? SUPPORTED_MINECRAFT_VERSION,
      viewDistance: 'short', // R8
      checkTimeoutInterval: KEEPALIVE_INTERVAL_MS, // R13
    };
    const bot = this.createBot(req);
    const rec = this.records.get(member.name) as BotRecord;
    rec.bot = bot;
    rec.state = 'connecting';

    bot.once('spawn', () => this.onSpawn(member, bot));
    bot.on('end', (...args: unknown[]) => this.onEnd(member, String(args[0] ?? 'end')));
    bot.on('kicked', (...args: unknown[]) => this.onEnd(member, `kicked: ${String(args[0] ?? '')}`));
    // R27/G2: the authoritative cause of death is the packet, not entity inference.
    bot._client.on('death_combat_event', (...args: unknown[]) => this.onDeath(member, args[0]));
  }

  private onSpawn(member: Member, bot: Bot): void {
    const rec = this.records.get(member.name);
    if (!rec) return;
    rec.state = 'connected';
    rec.reconnectAttempts = 0; // healthy again — reset the backoff
    boundPathfinder(bot); // R6
    loadPlugins(bot, { onWarn: (m) => logger.warn(`bot:${member.name}`, m) }); // R15/R16/R17
    this.opts.journal.append(`bot:${member.name}`, 'system.bot-connected', { name: member.name });
    logger.info(`bot:${member.name}`, `spawned (${member.tier})`);
  }

  private onEnd(member: Member, reason: string): void {
    const rec = this.records.get(member.name);
    if (!rec || rec.state === 'disconnected') return;
    rec.state = 'disconnected';
    rec.bot = null;
    this.opts.journal.append(`bot:${member.name}`, 'system.bot-disconnected', { name: member.name, reason });
    if (!this.stopping) this.scheduleReconnect(member);
  }

  private onDeath(member: Member, packet: unknown): void {
    const cause = deathCause(packet);
    this.opts.journal.append(
      `bot:${member.name}`,
      'world.death',
      cause !== undefined ? { name: member.name, cause } : { name: member.name },
    );
  }

  // Re-connect after a backoff step (clamped to the last value); unref'd so it never holds the loop open.
  private scheduleReconnect(member: Member): void {
    const rec = this.records.get(member.name);
    if (!rec) return;
    const idx = Math.min(rec.reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1);
    const backoff = RECONNECT_BACKOFF_MS[idx] as number;
    rec.reconnectAttempts++;
    rec.reconnectTimer = setTimeout(() => {
      if (!this.stopping) this.connect(member);
    }, backoff);
    rec.reconnectTimer.unref();
  }

  /** Start the per-bot vitals snapshot (M1-5) — the journalled SUMMARY of the in-memory pulses (R44). */
  startVitals(): void {
    if (this.vitalsTimer) return;
    this.vitalsTimer = setInterval(() => this.snapshotVitals(), this.opts.vitalsIntervalMs);
    this.vitalsTimer.unref();
  }

  private snapshotVitals(): void {
    for (const rec of this.records.values()) {
      if (rec.state !== 'connected' || !rec.bot) continue;
      const bot = rec.bot;
      const pos = bot.entity?.position;
      this.opts.journal.append(`bot:${rec.member.name}`, 'vitals', {
        name: rec.member.name,
        health: bot.health ?? 0,
        food: bot.food ?? 0,
        position: pos ? [Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)] : [0, 0, 0],
        held: bot.heldItem?.name ?? null,
        currentRun: this.opts.currentRunOf?.(rec.member.name) ?? null,
      });
    }
  }

  /** Crash-only friendly shutdown: stop timers, cancel reconnects, quit the bots (D-08). */
  stop(): void {
    this.stopping = true;
    if (this.vitalsTimer) {
      clearInterval(this.vitalsTimer);
      this.vitalsTimer = undefined;
    }
    for (const rec of this.records.values()) {
      if (rec.reconnectTimer) clearTimeout(rec.reconnectTimer);
      try {
        rec.bot?.quit('pool shutdown');
      } catch {
        /* best-effort */
      }
      rec.state = 'disconnected';
      rec.bot = null;
    }
  }
}

/** Pull a human cause out of a death_combat_event packet (R27); shape varies, so be defensive. */
function deathCause(packet: unknown): string | undefined {
  if (!packet || typeof packet !== 'object') return undefined;
  const message = (packet as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (message != null) return JSON.stringify(message);
  return undefined;
}

/** The result of stamping (or checking) a data dir's world identity (R32). */
export interface WorldStampResult {
  status: 'fresh' | 'match' | 'mismatch';
  worldId: string;
  previous?: string;
}

/**
 * R32: stamp the data dir with a world identifier at first boot. On a later boot with a DIFFERENT
 * world id, report a mismatch (the caller decides — quarantine lands in M6) and leave the original
 * stamp in place so the admin's decision still sees it. A matching id is a clean re-boot.
 */
export function stampWorldId(dataDir: string, worldId: string): WorldStampResult {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'world.json');
  if (existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, 'utf8')) as { worldId: string };
    if (prev.worldId === worldId) return { status: 'match', worldId };
    return { status: 'mismatch', worldId, previous: prev.worldId };
  }
  writeFileSync(file, JSON.stringify({ worldId, stampedAt: Date.now() }));
  return { status: 'fresh', worldId };
}
