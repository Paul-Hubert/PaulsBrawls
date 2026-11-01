// BotPool — the mineflayer connections of the roster's bots. Copied from Eden's pool and made dynamic: bots are
// added and removed at runtime (/bots spawn, /bots despawn) instead of a fixed roster. Kept from Eden: the login
// stagger (I1), the pinned protocol (R11), short view distance (R8), keepalive rope (R13), reconnect backoff,
// identity-guarded lifecycle handlers (R66), legible kick reasons, a bounded pathfinder (R6). The pool never ops
// anyone and stores no ownership: that is the roster's job.

import { EventEmitter } from 'node:events';

import mineflayer, { type Bot } from 'mineflayer';

import { logger } from '../logger';
import { boundPathfinder, defaultMovements, type AbortableBot } from './hardening';
import { installMeleeHits } from './hits';
import { loadPlugins, pathfinder } from './plugins';
import { keepDecodersAlive, RECIPES_AS_BYTES, SHARED_WORLD_PACKETS, type SkippedPacket } from './protocol';
import type { OffloadedBot } from './pathworkers/offload';

/**
 * A* on the reader workers (pathworkers/offload.ts, docs/37 P4): it takes over the bot's pathfinder searches at spawn.
 * The world they read is the shared world's, fed by its own attach (WorldFeed).
 */
export interface PathSearch {
  install(bot: OffloadedBot): void;
}

/** The shared world's seam (world/shared-world.ts): it follows a bot's world packets from its first one. */
export interface WorldFeed {
  attach(bot: unknown): void;
  /**
   * world.shared (docs/37 P5): the plugin that replaces mineflayer's own blocks plugin, so the bot reads the shared
   * world and parses no chunk (null/absent: the bot keeps its own world).
   */
  blocksPlugin?(): BlocksPlugin | null;
}

/** A mineflayer plugin standing in for its internal `blocks` (createBot's `plugins.blocks`). */
export type BlocksPlugin = (bot: unknown, options: Record<string, unknown>) => void;

export const SUPPORTED_MINECRAFT_VERSION = '1.21.1'; // R11: server, mod and bot must agree
const KEEPALIVE_INTERVAL_MS = 90_000; // R13
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
/** A connected bot that received no packet for this long is deaf (its decoder died): it is reconnected. */
export const DEAF_MS = 20_000;

export interface SpawnRequest {
  host: string;
  port: number;
  username: string;
  version: string;
  viewDistance: 'short';
  checkTimeoutInterval: number;
  /** world.shared: mineflayer's blocks plugin replaced by the shared world's (createBot `plugins: { blocks }`). */
  blocks?: BlocksPlugin;
}

export type CreateBot = (req: SpawnRequest) => Bot;

export type BotStatus = 'connecting' | 'online' | 'offline';

/** Why a bot stopped being usable by its order. */
export type GoneReason = 'died' | 'disconnected';

interface Record_ {
  name: string;
  bot: Bot | null;
  status: BotStatus;
  attempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  lastReason?: string;
  /** The runtime's movements for this bot instance, restored after every order (hardening.abortActiveTasks). */
  movements?: unknown;
  /** When the current instance last received a packet (the deaf-bot watchdog). */
  lastPacket: number;
  /** When the current instance spawned (0 while not online): a bot online for part of a window is not "slow". */
  onlineAt: number;
  /** The vitals counters (docs/32 C), zeroed by {@link BotPool.readMeters}. */
  meter: BotCounters;
}

/**
 * Cheap per-bot counters, the same signals the load bench reads (bench/lib/probe.ts). They are plain numbers bumped
 * by the bot's own listeners, so a physics tick costs one increment and allocates nothing; the vitals sampler reads
 * and zeroes them every 10 s. They live on the pool's record, not on the bot instance, so a reconnect keeps them.
 */
export interface BotCounters {
  /** `physicsTick` events: 20 a second when the bot is smooth; mineflayer drops ticks when the loop is late. */
  ticks: number;
  /** Final outcomes of pathfinder searches (`path_update`; a 'partial' result is a search still going). */
  pathSuccess: number;
  pathNoPath: number;
  pathTimeout: number;
  pathOther: number;
  /** Path resets by reason (`path_reset`: stuck, block_updated, chunk_loaded, goal_moved…). */
  resets: Record<string, number>;
  /** Times the deaf-bot watchdog ended this bot. */
  deafTrips: number;
}

/** One bot's counters since the last reset ({@link BotPool.readMeters}), with when it came online (0 = not online). */
export interface BotMeterReading extends BotCounters {
  name: string;
  status: BotStatus;
  onlineAt: number;
}

function newCounters(): BotCounters {
  return { ticks: 0, pathSuccess: 0, pathNoPath: 0, pathTimeout: 0, pathOther: 0, resets: {}, deafTrips: 0 };
}

export interface BotPoolOptions {
  host: string;
  port: number;
  version?: string;
  staggerMs: number;
  createBot?: CreateBot;
  /** Post-spawn setup (tests replace the real plugin loading). */
  setup?: (bot: Bot) => void;
  /** Override {@link DEAF_MS} (tests). */
  deafMs?: number;
  /** A* on the reader workers (workers.count > 0 with the shared world); absent = every search on the main thread. */
  pathSearch?: PathSearch;
  /** The shared world (config world.enabled); absent = the bots' packets feed only their own worlds. */
  world?: WorldFeed;
}

/**
 * Events:
 *  - `online` (name, bot): spawned (also after every reconnect);
 *  - `gone` (name, reason): died or disconnected; its order loses it;
 *  - `status` (name, status).
 */
export class BotPool extends EventEmitter {
  private readonly records = new Map<string, Record_>();
  private readonly createBot: CreateBot;
  private readonly queue: string[] = [];
  private draining = false;
  /** When the last login started (Date.now()): the next one waits until staggerMs after it. */
  private lastConnectAt = 0;
  private stopping = false;
  private readonly watchdog: ReturnType<typeof setInterval>;

  constructor(private readonly opts: BotPoolOptions) {
    super();
    this.createBot = opts.createBot ?? defaultCreateBot;
    keepDecodersAlive(reportSkipped);
    const deafMs = opts.deafMs ?? DEAF_MS;
    this.watchdog = setInterval(() => this.checkDeaf(deafMs), Math.min(5_000, Math.max(50, deafMs / 4)));
    this.watchdog.unref();
  }

  /** A bot whose decoder died stays connected but hears nothing: end it, the reconnect brings it back. */
  private checkDeaf(deafMs: number): void {
    const now = Date.now();
    for (const rec of this.records.values()) {
      if (rec.status !== 'online' || !rec.bot || now - rec.lastPacket <= deafMs) continue;
      rec.lastReason = `deaf: no packet for ${Math.round((now - rec.lastPacket) / 1000)} s`;
      logger.warn(`bot:${rec.name}`, `${rec.lastReason}; reconnecting`);
      rec.meter.deafTrips++;
      rec.lastPacket = now; // one end per silence
      try {
        rec.bot.end('deaf');
      } catch {
        /* already gone */
      }
    }
  }

  /** Add a bot and queue its login (staggered). Re-adding a known name is a no-op. */
  add(name: string): void {
    if (this.records.has(name)) return;
    this.records.set(name, { name, bot: null, status: 'offline', attempts: 0, lastPacket: Date.now(), onlineAt: 0, meter: newCounters() });
    this.enqueue(name);
  }

  /** Disconnect and forget a bot. */
  remove(name: string): void {
    const rec = this.records.get(name);
    if (!rec) return;
    this.records.delete(name);
    if (rec.reconnectTimer) clearTimeout(rec.reconnectTimer);
    const bot = rec.bot;
    rec.bot = null;
    if (bot) {
      try {
        bot.quit('despawned');
      } catch {
        /* best-effort */
      }
    }
  }

  bot(name: string): Bot | undefined {
    const rec = this.records.get(name);
    return rec && rec.status === 'online' && rec.bot ? rec.bot : undefined;
  }

  status(name: string): BotStatus {
    return this.records.get(name)?.status ?? 'offline';
  }

  lastReason(name: string): string | undefined {
    return this.records.get(name)?.lastReason;
  }

  /** The runtime's default movements for a bot (restored after each order). */
  movements(name: string): unknown {
    return this.records.get(name)?.movements;
  }

  names(): string[] {
    return [...this.records.keys()];
  }

  /**
   * Every bot's counters since the last reset; with `reset`, zero them (the vitals sampler is the one reader that
   * resets, every 10 s). Reset reasons keep their keys at 0, so a counted reason never allocates again.
   */
  readMeters(reset: boolean): BotMeterReading[] {
    const out: BotMeterReading[] = [];
    for (const rec of this.records.values()) {
      const m = rec.meter;
      out.push({ name: rec.name, status: rec.status, onlineAt: rec.status === 'online' ? rec.onlineAt : 0, ...m, resets: { ...m.resets } });
      if (!reset) continue;
      m.ticks = m.pathSuccess = m.pathNoPath = m.pathTimeout = m.pathOther = m.deafTrips = 0;
      for (const k in m.resets) m.resets[k] = 0;
    }
    return out;
  }

  stop(): void {
    this.stopping = true;
    clearInterval(this.watchdog);
    for (const name of [...this.records.keys()]) this.remove(name);
  }

  private enqueue(name: string): void {
    if (!this.queue.includes(name)) this.queue.push(name);
    void this.drain();
  }

  /**
   * One login at a time, at least `staggerMs` apart (I1), counted from the last connect whatever drain made it: a
   * spawn arriving after the queue emptied (every /api/bots/spawn is one) used to connect at once, so a squad or a
   * raid logged in all together (docs/36 §6).
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.stopping) {
        const wait = this.lastConnectAt + this.opts.staggerMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (this.stopping || this.queue.length === 0) break;
        const name = this.queue.shift() as string;
        const rec = this.records.get(name);
        if (rec && rec.status === 'offline') {
          this.lastConnectAt = Date.now();
          this.connect(rec);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private setStatus(rec: Record_, status: BotStatus): void {
    rec.status = status;
    this.emit('status', rec.name, status);
  }

  private connect(rec: Record_): void {
    let bot: Bot;
    try {
      const blocks = this.opts.world?.blocksPlugin?.() ?? undefined;
      bot = this.createBot({
        host: this.opts.host,
        port: this.opts.port,
        username: rec.name,
        version: this.opts.version ?? SUPPORTED_MINECRAFT_VERSION,
        viewDistance: 'short',
        checkTimeoutInterval: KEEPALIVE_INTERVAL_MS,
        ...(blocks ? { blocks } : {}),
      });
    } catch (e) {
      rec.lastReason = `createBot failed: ${(e as Error).message}`;
      logger.warn(`bot:${rec.name}`, rec.lastReason);
      this.scheduleReconnect(rec);
      return;
    }
    rec.bot = bot;
    rec.lastPacket = Date.now();
    // Before the first packet: the shared world needs this bot's login and every chunk it receives.
    if (this.opts.world) {
      try {
        this.opts.world.attach(bot);
      } catch (e) {
        logger.warn(`bot:${rec.name}`, `shared world: ${(e as Error).message}`);
      }
    }
    this.setStatus(rec, 'connecting');
    bot._client?.on?.('packet', () => {
      if (rec.bot === bot) rec.lastPacket = Date.now();
    });
    // R66: every handler is bound to THIS instance; an event from a superseded bot is ignored.
    bot.once('spawn', () => {
      if (this.records.get(rec.name) !== rec || rec.bot !== bot) return;
      rec.attempts = 0;
      rec.lastReason = undefined;
      try {
        (this.opts.setup ?? realSetup)(bot);
        rec.movements = safeMovements(bot);
      } catch (e) {
        logger.warn(`bot:${rec.name}`, `post-spawn setup failed: ${(e as Error).message}`);
      }
      this.withPathSearch(rec, bot);
      rec.onlineAt = Date.now();
      this.meter(rec, bot);
      this.setStatus(rec, 'online');
      logger.info(`bot:${rec.name}`, 'online');
      this.emit('online', rec.name, bot);
    });
    bot.on('death', () => {
      if (rec.bot !== bot) return;
      logger.info(`bot:${rec.name}`, 'died (respawns automatically)');
      this.emit('gone', rec.name, 'died' satisfies GoneReason);
    });
    bot.on('end', (reason?: unknown) => this.onEnd(rec, bot, reasonText(reason) || 'end'));
    bot.on('kicked', (reason?: unknown) => {
      rec.lastReason = `kicked: ${reasonText(reason)}`;
    });
    bot.on('error', (err: Error) => {
      rec.lastReason = err.message;
      logger.warn(`bot:${rec.name}`, `error: ${err.message}`);
    });
  }

  /** A failure of the offload's wiring must never cost the bot: its searches then simply stay on this thread. */
  private withPathSearch(rec: Record_, bot: Bot): void {
    const ps = this.opts.pathSearch;
    if (!ps) return;
    try {
      ps.install(bot as unknown as OffloadedBot);
    } catch (e) {
      logger.warn(`bot:${rec.name}`, `A* on the workers: ${(e as Error).message}`);
    }
  }

  /**
   * The vitals listeners, on this bot instance only: they go with it when it ends, and the identity check (R66)
   * keeps a superseded instance from counting into its replacement's record.
   */
  private meter(rec: Record_, bot: Bot): void {
    const m = rec.meter;
    bot.on('physicsTick', () => {
      if (rec.bot === bot) m.ticks++;
    });
    bot.on('path_update' as never, ((r: { status?: string }) => {
      if (rec.bot !== bot) return;
      const s = r?.status;
      if (s === 'partial') return;
      if (s === 'success') m.pathSuccess++;
      else if (s === 'noPath') m.pathNoPath++;
      else if (s === 'timeout') m.pathTimeout++;
      else m.pathOther++;
    }) as never);
    bot.on('path_reset' as never, ((reason: unknown) => {
      if (rec.bot !== bot) return;
      const k = typeof reason === 'string' ? reason : 'other';
      m.resets[k] = (m.resets[k] ?? 0) + 1;
    }) as never);
  }

  private onEnd(rec: Record_, bot: Bot, reason: string): void {
    if (rec.bot !== bot) return; // R66
    const wasOnline = rec.status === 'online';
    rec.bot = null;
    rec.onlineAt = 0;
    rec.lastReason = rec.lastReason ?? reason;
    this.setStatus(rec, 'offline');
    logger.info(`bot:${rec.name}`, `offline (${rec.lastReason})`);
    if (wasOnline) this.emit('gone', rec.name, 'disconnected' satisfies GoneReason);
    if (!this.stopping && this.records.get(rec.name) === rec) this.scheduleReconnect(rec);
  }

  private scheduleReconnect(rec: Record_): void {
    const backoff = RECONNECT_BACKOFF_MS[Math.min(rec.attempts, RECONNECT_BACKOFF_MS.length - 1)] as number;
    rec.attempts++;
    rec.reconnectTimer = setTimeout(() => {
      rec.reconnectTimer = undefined;
      if (!this.stopping && this.records.get(rec.name) === rec && rec.status === 'offline') this.enqueue(rec.name);
    }, backoff);
    rec.reconnectTimer.unref();
  }
}

function defaultCreateBot(req: SpawnRequest): Bot {
  return mineflayer.createBot({
    host: req.host,
    port: req.port,
    username: req.username,
    version: req.version,
    viewDistance: req.viewDistance,
    checkTimeoutInterval: req.checkTimeoutInterval,
    // world.shared (docs/37 P5): the shared world's blocks plugin instead of mineflayer's (no chunk parsed per bot).
    plugins: req.blocks ? { pathfinder, blocks: req.blocks } : { pathfinder },
    // docs/29 §16: the login recipe list is read as bytes (mineflayer never uses it; modded items break it). With
    // world.shared, the chunks' light too (nothing reads it, docs/37 P5).
    customPackets: req.blocks ? SHARED_WORLD_PACKETS : RECIPES_AS_BYTES,
  } as Parameters<typeof mineflayer.createBot>[0]);
}

const skipSeen = new Map<string, number>();
let skippedTotal = 0;

/** Undecodable server packets skipped since the process started, all bots together (one shared decoder patch). */
export function skippedPackets(): number {
  return skippedTotal;
}

/** One line per kind of undecodable packet per minute (protodef printed whole stack traces to stdout). */
function reportSkipped(s: SkippedPacket): void {
  skippedTotal++;
  const key = s.message.slice(0, 120);
  const now = Date.now();
  if ((skipSeen.get(key) ?? 0) > now - 60_000) return;
  skipSeen.set(key, now);
  logger.warn('protocol', `skipped an undecodable server packet (${s.bytes} bytes${s.partial ? ', partial read' : ''}): ${s.message.slice(0, 200)}`);
}

function realSetup(bot: Bot): void {
  boundPathfinder(bot as unknown as AbortableBot); // R6
  loadPlugins(bot); // R15/R16/R17
  installMeleeHits(bot); // bot.on('meleeHit'): who hit it in melee, a shield block included
}

function safeMovements(bot: Bot): unknown {
  const pf = (bot as unknown as AbortableBot).pathfinder;
  if (!pf?.setMovements || !bot.registry) return undefined;
  const m = defaultMovements(bot);
  pf.setMovements(m);
  return m;
}

/** Best-effort human text from a mineflayer end/kick reason (string, JSON string, or chat component). */
export function reasonText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return reasonText(JSON.parse(t));
      } catch {
        /* not JSON */
      }
    }
    return raw;
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.text === 'string' && o.text) return o.text;
    if (typeof o.value === 'string' && o.value) return o.value;
    if (typeof o.translate === 'string') return o.translate;
    return JSON.stringify(raw);
  }
  return String(raw);
}
