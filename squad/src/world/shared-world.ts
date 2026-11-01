// The shared world, main-thread side (docs/37 §2, phase P1): ONE copy of the chunks the bots receive, in
// SharedArrayBuffers that every thread reads lock-free (reader.mjs), written by ONE writer thread (writer.mjs,
// store.mjs). The reader workers (descriptor()) read it: A* since P4 (bots/pathworkers/offload.ts: dimensionOf, isLive,
// applied), the aim solver in P3. With world.shared (P5) the bots read it too: each bot's `bot.world` is a
// SharedBotWorld (bot-world.ts) over it, made by the blocks plugin (blocks-plugin.ts, blocksPlugin()), and no bot
// parses a chunk any more.
//
// What this side does (the writer decodes, this side only routes, and copies each payload once):
//   • attach(bot) follows the bot's world packets (follow.ts: the same rules as the pathfinding workers' mirror).
//   • Holders. Each column is held by the bots that received it, in order; the first is its PRIMARY. A column new to
//     every bot is forwarded (its payload copied into an ArrayBuffer for the writer). Another bot receiving it adds a
//     holder and forwards nothing: the store already has it. A re-send to a holder is forwarded (the writer replaces
//     the column, or keeps it when the payload is the same) and makes that holder the primary.
//   • Block changes: only the primary's are forwarded, so N bots hearing one change send it once, and in the order
//     one bot heard them (two bots' streams interleaved could apply an older value last). When the primary lets a
//     column go while others hold it, and a change was heard there in the last RESYNC_WINDOW_MS, the next holder's view
//     of it is re-sent: a change it heard first, while the old primary was still in charge, would otherwise be lost.
//     Without world.shared that is the holder's own column (`getColumn().dump()`); with it, the changes the new
//     primary's overlay still shows (bot-world.ts: what it heard that the store does not show yet).
//   • The last holder unloading it, leaving the dimension or disconnecting releases the column: the writer keeps it
//     CACHED (readers: unknown) for world.cacheSeconds, at most world.cacheColumns; a bot receiving the same clean
//     payload again gets it back without a decode.
//   • The writer's answers become 'published' (dim, x, z) / 'unloaded' (dim, x, z) events, and with world.shared each
//     holder's chunkColumnLoad (once the column is readable for it) and the pruning of the bots' overlays.
//   • A writer that dies is restarted over the same buffers (descriptors stay valid): it drops every column (readers
//     read -1 meanwhile) and this side re-sends what the bots hold. Without world.shared, from the bots' own worlds;
//     three deaths in a minute disable it (the store is cleared once and stays empty: every read -1). With world.shared
//     the bots have no world of their own: what the dead writer had applied is read back from the store itself (it is
//     shared memory, and no writer runs now), encoded as payloads (encode.mjs), and what it had not acknowledged is
//     re-sent from the copies kept until each batch's acknowledgement. The third death in a minute does not leave the
//     bots blind: this thread then runs the writer's logic itself (applyOps, store.mjs), decoding each column once.
//   • world.verify: once a second, a random sample of the store is compared with the primary holders' own worlds
//     (nothing to compare with world.shared).

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

import { Vec3 } from 'vec3';

import { logger } from '../logger';
import { injectSharedBlocks, type MineflayerPlugin } from './blocks-plugin';
import { BlockTemplates } from './blocks.mjs';
import { SharedBotWorld, type BotWorldHost, type SharedColumn } from './bot-world';
import { encodeColumn } from './encode.mjs';
import { followWorldPackets, type FollowedBot } from './follow';
import { allocateWorld, K_READERS } from './layout.mjs';
import { openWorld, type WorldDescriptor, type WorldReader } from './reader.mjs';
import type { StoreStats } from './store.mjs';
import { applyOps, WorldStore } from './store.mjs';
import { buildStateTables, decoderOptions } from './tables.mjs';

const require = createRequire(import.meta.url);

/** A change heard in a column this recently, when its primary lets it go, makes the next holder re-send it. */
export const RESYNC_WINDOW_MS = 5_000;
/** A writer that dies this many times in a minute is not restarted again. */
const MAX_CRASHES_PER_MINUTE = 3;
/** Decode times kept for stats() (the last N columns decoded). */
const DECODE_SAMPLES = 2_048;
/** At most one verify warning per this many ms. */
const VERIFY_WARN_MS = 10_000;
/**
 * The bots' reader (world.shared) stays inside its epoch bracket and moves to the current epoch this often, so memory
 * the writer freed is reused about this long after (a worker's bracket lasts a batch, at most a tick).
 */
const BOTS_READER_REFRESH_MS = 50;
/** The inline writer (world.shared, after the writer thread was given up) expires its cache this often. */
const INLINE_TICK_MS = 1_000;

export interface SharedWorldOptions {
  /** The bots' Minecraft version (its registry gives the per-state tables). */
  version: string;
  cacheSeconds: number;
  cacheColumns: number;
  /** Reader epoch slots, the main thread's own reader included (descriptor() hands out the others). */
  maxReaders: number;
  /** Once a second, compare a random sample of the store with the bots' own worlds and log mismatches. */
  verify?: boolean;
  /** P5 (world.shared): the bots read the store instead of keeping their own worlds (blocksPlugin()). */
  shared?: boolean;
  /** Tests: the verify period and sample size (default 1 000 ms, 256 blocks). */
  verifyIntervalMs?: number;
  verifySamples?: number;
  /** Tests: another writer script. */
  writerUrl?: URL;
}

export interface SharedWorldStats {
  columnsLive: number;
  columnsCached: number;
  /** Sections stored (an all-air or one-state section takes none). */
  sections: number;
  /** Sections ever handed out (the high-water mark: it grows only when no freed section can be reused). */
  sectionCapacity: number;
  /** Batches of freed memory waiting for every reader to move past them. */
  retiredBatches: number;
  /** Bytes of shared memory the store has committed (sections, columns, index, tables). */
  bytes: number;
  /** Columns decoded since the start (restarts included). */
  decoded: number;
  /** Decode time per column over the last DECODE_SAMPLES decodes, ms. */
  decodeMs: { p50: number; max: number };
  /** Payloads published without a decode (the same clean payload: a respawn, walking back, a resync). */
  skipped: number;
  /** Payloads that could not be decoded (the column is not stored) and loads refused (store full, height). */
  failed: number;
  rejected: number;
  /** Columns held by at least one bot, as this side counts them. */
  held: number;
  /** Block changes heard by a holder that is not the column's primary (not forwarded). */
  dropped: number;
  /**
   * Columns re-sent: a primary switch after a recent change (P1: from the next holder's own world; world.shared: the
   * changes its overlay shows), and every held column after a writer restart.
   */
  resyncs: number;
  restarts: number;
  /** Payloads sent to the writer (new columns, re-sends, resyncs) and their bytes. */
  payloads: { count: number; bytes: number };
  /** 'inline': world.shared, the writer thread given up after its crashes, this thread writes the store. */
  writer: 'up' | 'inline' | 'disabled' | 'stopped';
  verify: { rounds: number; checked: number; mismatches: number };
  /** world.shared (P5): the bots reading the store, their overlay entries now, and those given up after OVERLAY_MS. */
  shared?: {
    bots: number;
    overlay: number;
    expired: number;
    /** Bytes of payloads kept until the writer acknowledges their batch (the restart's copies), now and at most. */
    unacked: number;
    unackedPeak: number;
  };
}

/** The parts of a mineflayer bot read here. Loose on purpose: fakes drive it in tests. */
interface WorldBot extends FollowedBot {
  game?: { minY?: number; height?: number };
  world?: {
    getColumn?: (x: number, z: number) => { dump?: () => Buffer } | null | undefined;
    getBlockStateId?: (pos: Vec3) => number | undefined;
  };
}

interface Holder {
  bot: WorldBot;
  dim: string | null;
  /** Keys ("dim|x,z") of the columns this bot instance holds. */
  held: Set<string>;
  /** world.shared: the bot's world (bindView), which this side tells what the bot can read. */
  view: SharedBotWorld | null;
}

interface Held extends SharedColumn {
  dim: string;
  x: number;
  z: number;
  /** Bots holding it, the primary first. */
  holders: Holder[];
  /** When a block change was last heard there (any holder). */
  lastChange: number;
  /** The writer batch of the last load sent for it. */
  loadSeq: number;
  /** world.shared: holders waiting for it to be readable, with the batch that makes it so. */
  pending: Map<Holder, number> | null;
}

type Op =
  | ['load', string, number, number, number, number, ArrayBuffer]
  | ['release', string, number, number]
  | ['set', string, number, number, number, number];

type WriterMessage =
  | { t: 'ready'; stats: StoreStats }
  | { t: 'stats'; stats: StoreStats }
  | { t: 'done'; seq: number; published: Array<string | number>; unloaded: Array<string | number>; decodeMs: number[]; errors: string[]; stats: StoreStats };

const keyOf = (dim: string, x: number, z: number): string => `${dim}|${x},${z}`;

export class SharedWorld extends EventEmitter implements BotWorldHost {
  /** The main thread's own reader (epoch slot 0). */
  readonly reader: WorldReader;
  /** world.shared: the bots' reader, always inside its bracket (refreshed every BOTS_READER_REFRESH_MS). */
  readonly botsReader: WorldReader;
  /** world.shared: one prismarine Block template per state id, for every bot's blockAt. */
  readonly templates: BlockTemplates;
  private readonly sharedBots: boolean;
  private readonly base: WorldDescriptor;
  /** Per epoch slot: 0 = free, else the readerToken of the descriptor holding it (slot 0: this thread's reader). */
  private readonly slots: number[];
  private nextToken = 1;
  private readonly writerUrl: URL;
  private writer: Worker | null = null;
  /** world.shared, after the writer thread was given up: the writer's logic on this thread. */
  private inline: { store: WorldStore; timer: ReturnType<typeof setInterval> } | null = null;
  private state: 'up' | 'disabled' | 'stopped' = 'up';
  private readonly holders = new WeakMap<object, Holder>();
  private readonly columns = new Map<string, Held>();
  /** Keys the writer reported live. */
  private readonly live = new Set<string>();
  private pending: Op[] = [];
  private transfer: ArrayBuffer[] = [];
  /** world.shared: the ops of every batch sent and not acknowledged yet, by seq (a writer restart re-sends them). */
  private readonly inflight = new Map<number, { ops: Op[]; bytes: number }>();
  private unackedBytes = 0;
  private unackedPeak = 0;
  private flushScheduled = false;
  private seq = 0;
  private acked = 0;
  private settleWaiters: Array<() => void> = [];
  private appliedWaiters: Array<{ seq: number; resolve: () => void }> = [];
  private writerStats: StoreStats | null = null;
  /** Counters of writers that died, so stats() keeps counting across restarts. */
  private past = { decoded: 0, skipped: 0, failed: 0, rejected: 0 };
  private readonly decodeSamples: number[] = [];
  private decodeAt = 0;
  private crashes: number[] = [];
  private readonly counters = { dropped: 0, resyncs: 0, restarts: 0 };
  private readonly payloads = { count: 0, bytes: 0 };
  private readonly verifyCounters = { rounds: 0, checked: 0, mismatches: 0 };
  private verifyTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastVerifyWarn = 0;
  private unreported = 0;
  /** world.shared: the bots' worlds with overlay entries to prune. */
  private readonly withOverlay = new Set<SharedBotWorld>();
  private readonly views = new Set<SharedBotWorld>();
  private expiredGone = 0;

  constructor(private readonly opts: SharedWorldOptions) {
    super();
    const t0 = performance.now();
    const registry = require('prismarine-registry')(opts.version) as unknown;
    const tables = buildStateTables(registry);
    this.base = allocateWorld({ version: opts.version, maxReaders: opts.maxReaders, tables, decoder: decoderOptions(registry, tables) });
    this.slots = new Array<number>(opts.maxReaders).fill(0);
    this.slots[0] = -1;
    this.reader = openWorld({ ...this.base, reader: 0 });
    this.sharedBots = opts.shared === true;
    this.templates = new BlockTemplates(registry);
    if (this.sharedBots) {
      this.botsReader = openWorld(this.descriptor());
      this.botsReader.enter();
      let n = 0;
      this.refreshTimer = setInterval(() => {
        this.botsReader.refresh();
        // About once a second: overlay entries older than OVERLAY_MS go even when no batch comes to prune them.
        if (++n % Math.round(1_000 / BOTS_READER_REFRESH_MS) === 0) this.pruneOverlays();
      }, BOTS_READER_REFRESH_MS);
      this.refreshTimer.unref();
    } else {
      this.botsReader = this.reader;
    }
    this.writerUrl = opts.writerUrl ?? new URL('./writer.mjs', import.meta.url);
    this.spawn(false);
    if (opts.verify && !this.sharedBots) {
      this.verifyTimer = setInterval(() => this.verifyRound(), opts.verifyIntervalMs ?? 1_000);
      this.verifyTimer.unref();
    }
    if (opts.verify && this.sharedBots) logger.warn('world', 'world.verify does nothing with world.shared: the bots have no world of their own to compare with');
    logger.info(
      'world',
      `shared world up (${tables.count} states, tables in ${(performance.now() - t0).toFixed(0)} ms${opts.verify && !this.sharedBots ? ', verify on' : ''}${this.sharedBots ? ', the bots read it (world.shared)' : ''})`,
    );
  }

  // -- the bots -----------------------------------------------------------------------------------------------------

  /** Follow a bot's world packets. Call right after createBot, before its first packet. */
  attach(bot: unknown): void {
    const b = bot as WorldBot;
    if (this.state === 'stopped' || !b || typeof b !== 'object' || this.holders.has(b)) return;
    const h: Holder = { bot: b, dim: null, held: new Set(), view: null };
    const followed = followWorldPackets(
      b,
      {
        dimension: (name) => {
          h.view?._enter(name);
          this.releaseAll(h);
          h.dim = name;
        },
        chunk: (x, z, data) => this.onChunk(h, x, z, data),
        unload: (x, z) => {
          if (h.dim !== null) this.releaseColumn(h, keyOf(h.dim, x, z));
          h.view?._unload(x, z);
        },
        block: (x, y, z, s) => this.onBlock(h, x, y, z, s),
        end: () => {
          this.releaseAll(h);
          if (h.view) {
            h.view._end();
            this.views.delete(h.view);
            this.withOverlay.delete(h.view);
            this.expiredGone += h.view.expired;
          }
        },
      },
      'world',
      () => this.state !== 'stopped',
    );
    if (followed) this.holders.set(b, h);
  }

  /** world.shared: the mineflayer plugin that replaces mineflayer's own blocks plugin (createBot's `plugins.blocks`). */
  blocksPlugin(): MineflayerPlugin | null {
    if (!this.sharedBots) return null;
    return (bot, options) => injectSharedBlocks(bot, options, this);
  }

  /** Whether the bots read the store (world.shared). */
  get shared(): boolean {
    return this.sharedBots;
  }

  /**
   * world.shared: the bot's world over the store, made once per bot instance (blocks-plugin.ts calls it when mineflayer
   * loads its plugins, before the first play packet). It attaches the bot when the pool has not. Null when the bot has
   * no packet stream or the shared world is stopped (the plugin then gives the bot mineflayer's own world).
   */
  bindView(bot: unknown): SharedBotWorld | null {
    if (!this.sharedBots || this.state === 'stopped') return null;
    this.attach(bot);
    const h = bot && typeof bot === 'object' ? this.holders.get(bot) : undefined;
    if (!h) return null;
    if (!h.view) {
      h.view = new SharedBotWorld(this);
      this.views.add(h.view);
    }
    return h.view;
  }

  /**
   * The dimension an attached bot is in, as the store names it (its login's or last respawn's world name, e.g.
   * "minecraft:overworld"; mineflayer's bot.game.dimension is the dimension type, "overworld"). Null for a bot not
   * attached here, or before its login. A job that reads the store for a bot needs it (docs/37 P3 aim, P4 A*, P6 findBlocks).
   */
  dimensionOf(bot: unknown): string | null {
    if (!bot || typeof bot !== 'object') return null;
    return this.holders.get(bot)?.dim ?? null;
  }

  private onChunk(h: Holder, x: number, z: number, data: Buffer): void {
    if (h.dim === null) return;
    const key = keyOf(h.dim, x, z);
    let col = this.columns.get(key);
    if (!col) {
      col = { dim: h.dim, x, z, holders: [], lastChange: 0, loadSeq: 0, pending: null, blockEntities: null };
      this.columns.set(key, col);
    }
    const i = col.holders.indexOf(h);
    let send = true;
    if (i < 0) {
      col.holders.push(h);
      h.held.add(key);
      // Another bot already holds it: the store has it, and that bot's block changes keep it current.
      if (col.holders.length > 1) send = false;
    } else if (i > 0) {
      // A re-send: this bot's stream is the newest view of the column now.
      col.holders.splice(i, 1);
      col.holders.unshift(h);
    }
    if (send) this.load(col, data, h.bot.game?.minY ?? -64, h.bot.game?.height ?? 384);
    if (!h.view) return;
    h.view._hold(x, z, col);
    // Readable for this bot now when the store has it and nothing newer is on its way; else when the writer says so.
    if (!send && this.live.has(key) && col.loadSeq <= this.acked) h.view._ready(x, z);
    else (col.pending ??= new Map()).set(h, col.loadSeq);
  }

  private onBlock(h: Holder, x: number, y: number, z: number, stateId: number): void {
    if (h.dim === null) return;
    const key = keyOf(h.dim, x >> 4, z >> 4);
    if (!h.held.has(key)) return; // mineflayer ignores these too
    const col = this.columns.get(key);
    if (!col) return;
    col.lastChange = Date.now();
    if (col.holders[0] === h) this.push(['set', h.dim, x, y, z, stateId]);
    else this.counters.dropped++;
    h.view?._heard(x, y, z, stateId);
  }

  private releaseColumn(h: Holder, key: string): void {
    if (!h.held.delete(key)) return;
    const col = this.columns.get(key);
    if (!col) return;
    col.pending?.delete(h);
    const i = col.holders.indexOf(h);
    if (i >= 0) col.holders.splice(i, 1);
    if (col.holders.length === 0) {
      this.columns.delete(key);
      this.push(['release', col.dim, col.x, col.z]);
      return;
    }
    if (i === 0 && Date.now() - col.lastChange < RESYNC_WINDOW_MS) this.resync(col);
  }

  private releaseAll(h: Holder): void {
    for (const key of [...h.held]) this.releaseColumn(h, key);
  }

  /**
   * The column's new primary takes over after a recent change. P1: its own column is re-sent (prismarine's dump is the
   * packet's chunkData format). world.shared: the changes it heard that the store does not show yet (its overlay) are
   * sent as its own.
   */
  private resync(col: Held): boolean {
    const h = col.holders[0];
    if (!h) return false;
    if (h.view) {
      const changes = h.view._pending(col.x, col.z);
      for (const [x, y, z, s] of changes) this.push(['set', col.dim, x, y, z, s]);
      if (changes.length > 0) this.counters.resyncs++;
      return changes.length > 0;
    }
    const data = h.bot.world?.getColumn?.(col.x, col.z)?.dump?.();
    if (!data) return false;
    this.counters.resyncs++;
    this.load(col, data, h.bot.game?.minY ?? -64, h.bot.game?.height ?? 384);
    return true;
  }

  private load(col: Held, data: Uint8Array, minY: number, height: number): void {
    // A copy: the packet's Buffer is a slice of a larger one (and without world.shared mineflayer parses it after us).
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    // world.shared keeps it until the writer acknowledges the batch (a restart re-sends it): it is copied to the writer,
    // not transferred.
    if (!this.sharedBots) this.transfer.push(ab);
    this.payloads.count++;
    this.payloads.bytes += data.byteLength;
    col.loadSeq = this.seq + 1;
    this.push(['load', col.dim, col.x, col.z, minY, height, ab]);
  }

  // -- BotWorldHost ------------------------------------------------------------------------------------------------

  nextSeq(): number {
    return this.seq + 1;
  }

  appliedSeq(): number {
    return this.acked;
  }

  settled(): boolean {
    return this.state === 'up' && this.pending.length === 0 && this.acked === this.seq;
  }

  overlaid(world: SharedBotWorld): void {
    this.withOverlay.add(world);
  }

  // -- the writer ---------------------------------------------------------------------------------------------------

  private push(op: Op): void {
    if (this.state !== 'up') return;
    this.pending.push(op);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.pending.length === 0) return;
    const ops = this.pending;
    const transfer = this.transfer;
    this.pending = [];
    this.transfer = [];
    if (this.inline) {
      this.seq++;
      const r = applyOps(this.inline.store, ops);
      this.onMessage({ t: 'done', seq: this.seq, ...r, stats: this.inline.store.stats() });
      return;
    }
    if (!this.writer) return;
    this.seq++;
    if (this.sharedBots) {
      let bytes = 0;
      for (const op of ops) if (op[0] === 'load') bytes += op[6].byteLength;
      this.inflight.set(this.seq, { ops, bytes });
      this.unackedBytes += bytes;
      if (this.unackedBytes > this.unackedPeak) this.unackedPeak = this.unackedBytes;
    }
    this.writer.postMessage({ t: 'ops', seq: this.seq, ops }, transfer);
  }

  private spawn(reset: boolean): void {
    const w = new Worker(this.writerUrl, {
      workerData: { descriptor: this.base, cacheSeconds: this.opts.cacheSeconds, cacheColumns: this.opts.cacheColumns, reset },
    });
    w.unref(); // the bots and the HTTP server keep the process alive, never the writer
    this.writer = w;
    w.on('message', (m: WriterMessage) => {
      if (w === this.writer) this.onMessage(m);
    });
    w.on('error', (e) => logger.warn('world', `writer failed: ${e.message}`));
    w.on('exit', (code) => this.onExit(w, code));
  }

  private onMessage(m: WriterMessage): void {
    this.writerStats = m.stats;
    if (m.t !== 'done') return;
    this.acked = m.seq;
    for (const [s, batch] of this.inflight) {
      if (s > m.seq) break;
      this.unackedBytes -= batch.bytes;
      this.inflight.delete(s);
    }
    for (let i = 0; i < m.published.length; i += 3) {
      const [dim, x, z] = [m.published[i] as string, m.published[i + 1] as number, m.published[i + 2] as number];
      const key = keyOf(dim, x, z);
      this.live.add(key);
      this.emit('published', dim, x, z);
      this.ready(this.columns.get(key), m.seq);
    }
    for (let i = 0; i < m.unloaded.length; i += 3) {
      const [dim, x, z] = [m.unloaded[i] as string, m.unloaded[i + 1] as number, m.unloaded[i + 2] as number];
      this.live.delete(keyOf(dim, x, z));
      this.emit('unloaded', dim, x, z);
    }
    for (const ms of m.decodeMs) {
      this.decodeSamples[this.decodeAt] = ms;
      this.decodeAt = (this.decodeAt + 1) % DECODE_SAMPLES;
    }
    for (const e of m.errors) logger.warn('world', `column not stored: ${e}`);
    this.pruneOverlays();
    this.wakeSettled();
  }

  /** A column was published by batch `seq`: the holders that waited for it can read it now (chunkColumnLoad). */
  private ready(col: Held | undefined, seq: number): void {
    if (!col?.pending) return;
    for (const [h, want] of col.pending) {
      if (want > seq) continue;
      col.pending.delete(h);
      if (h.held.has(keyOf(col.dim, col.x, col.z))) h.view?._ready(col.x, col.z);
    }
    if (col.pending.size === 0) col.pending = null;
  }

  /** world.shared: drop the overlay entries the store shows now (after every applied batch, and once a second). */
  private pruneOverlays(): void {
    if (this.withOverlay.size === 0) return;
    const now = Date.now();
    const settled = this.settled();
    for (const v of this.withOverlay) {
      if (!v._prune(this.acked, now, settled)) this.withOverlay.delete(v);
    }
  }

  private onExit(w: Worker, code: number): void {
    if (w !== this.writer) return;
    this.writer = null;
    if (this.state === 'stopped') return;
    const s = this.writerStats;
    if (s) {
      this.past.decoded += s.decoded;
      this.past.skipped += s.skipped;
      this.past.failed += s.failed;
      this.past.rejected += s.rejected;
    }
    this.writerStats = null;
    if (this.sharedBots) {
      this.restartShared(code);
      return;
    }
    this.acked = this.seq; // what the dead writer had not applied is in the bots' worlds, re-sent below
    this.dropLive();
    if (this.crashed()) {
      this.state = 'disabled';
      this.pending = [];
      this.transfer = [];
      // No writer is left to race with: clear the store once, so readers stop reading what the dead one left.
      new WorldStore(this.base, { cacheSeconds: 0, cacheColumns: 0, reset: true });
      logger.error('world', `writer exited (${code}) ${this.crashes.length} times in a minute: disabled, every read is unknown now`);
      this.wakeSettled();
      return;
    }
    logger.warn('world', `writer exited (${code}); restarting it, and re-sending the bots' ${this.columns.size} column(s)`);
    this.counters.restarts++;
    this.spawn(true);
    for (const col of this.columns.values()) this.resync(col);
    this.wakeSettled();
  }

  /** Count a writer death; true when it is the third in a minute. */
  private crashed(): boolean {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 60_000);
    this.crashes.push(now);
    return this.crashes.length >= MAX_CRASHES_PER_MINUTE;
  }

  /**
   * world.shared: the writer died. Every column the bots hold is rebuilt in a new store over the same buffers: from the
   * last payload sent for it when the dead writer had not acknowledged that batch (it may have been half-decoded),
   * else from the store itself, read back now that no writer runs (encode.mjs); then the block changes sent after that
   * payload, in order. The third death in a minute makes this thread the writer (decoding once per column, as the
   * writer did), so the bots never go blind.
   */
  private restartShared(code: number): void {
    const unacked: Op[] = [];
    for (const batch of this.inflight.values()) unacked.push(...batch.ops);
    unacked.push(...this.pending);
    this.inflight.clear();
    this.unackedBytes = 0;
    this.pending = [];
    this.transfer = [];
    const lastLoad = new Map<string, Op & { 0: 'load' }>();
    const after = new Map<string, Op[]>();
    for (const op of unacked) {
      if (op[0] === 'load') {
        const key = keyOf(op[1], op[2], op[3]);
        lastLoad.set(key, op);
        after.set(key, []);
      } else if (op[0] === 'set') {
        const key = keyOf(op[1], op[2] >> 4, op[4] >> 4);
        let list = after.get(key);
        if (!list) after.set(key, (list = []));
        list.push(op);
      }
    }
    // The store as the dead writer left it, for the columns no unacknowledged payload replaces (read before the reset).
    const decoder = this.base.decoder;
    const snapshots = new Map<string, { bytes: Uint8Array; minY: number; height: number }>();
    for (const [key, col] of this.columns) {
      if (lastLoad.has(key)) continue;
      const copy = this.botsReader.copyColumn(col.dim, col.x, col.z);
      if (copy) snapshots.set(key, { bytes: encodeColumn(copy.sections, decoder), minY: copy.minY, height: copy.sections.length * 16 });
    }
    this.acked = this.seq;
    this.dropLive();
    if (this.crashed()) {
      const store = new WorldStore(this.base, { cacheSeconds: this.opts.cacheSeconds, cacheColumns: this.opts.cacheColumns, reset: true });
      const timer = setInterval(() => {
        store.expire();
        store.endBatch();
      }, INLINE_TICK_MS);
      timer.unref();
      this.inline = { store, timer };
      logger.error('world', `writer exited (${code}) ${this.crashes.length} times in a minute: the main thread writes the store from now on (each column decoded once, here)`);
    } else {
      logger.warn('world', `writer exited (${code}); restarting it, and re-sending the bots' ${this.columns.size} column(s) from the store`);
      this.spawn(true);
    }
    this.counters.restarts++;
    for (const [key, col] of this.columns) {
      const load = lastLoad.get(key);
      const snap = snapshots.get(key);
      if (load) {
        col.loadSeq = this.seq + 1;
        this.push(load);
      } else if (snap) {
        this.load(col, snap.bytes, snap.minY, snap.height);
      } else {
        continue;
      }
      this.counters.resyncs++;
      for (const op of after.get(key) ?? []) this.push(op);
      for (const h of col.holders) if (h.view) (col.pending ??= new Map()).set(h, col.loadSeq);
    }
    this.wakeSettled();
  }

  /** Every column stops being live (a writer died): tell the listeners. */
  private dropLive(): void {
    for (const key of this.live) {
      const col = this.columns.get(key);
      const bar = key.indexOf('|');
      const [x, z] = key.slice(bar + 1).split(',').map(Number) as [number, number];
      this.emit('unloaded', col?.dim ?? key.slice(0, bar), x, z);
    }
    this.live.clear();
  }

  private isSettled(): boolean {
    return this.state !== 'up' || (this.pending.length === 0 && this.acked === this.seq);
  }

  private wakeSettled(): void {
    if (this.appliedWaiters.length > 0) {
      const up = this.state === 'up';
      const still: Array<{ seq: number; resolve: () => void }> = [];
      for (const w of this.appliedWaiters) {
        if (up && this.acked < w.seq) still.push(w);
        else w.resolve();
      }
      this.appliedWaiters = still;
    }
    if (!this.isSettled() || this.settleWaiters.length === 0) return;
    const ws = this.settleWaiters;
    this.settleWaiters = [];
    for (const r of ws) r();
  }

  /** Resolves when the writer has applied everything sent so far (tests, the live probe, verify). */
  settle(): Promise<void> {
    if (this.flushScheduled) this.flush();
    if (this.isSettled()) return Promise.resolve();
    return new Promise((r) => this.settleWaiters.push(r));
  }

  /**
   * Resolves once the writer has applied what the bots heard so far (later batches may still be on their way, unlike
   * settle()). P4 submits a search after it: a block change heard just before is then in the store when the worker
   * reads it. Resolves at once when the writer is disabled or stopped.
   */
  applied(): Promise<void> {
    if (this.flushScheduled) this.flush();
    if (this.state !== 'up' || this.acked >= this.seq) return Promise.resolve();
    const seq = this.seq;
    return new Promise((r) => this.appliedWaiters.push({ seq, resolve: r }));
  }

  /** Whether the writer has published this column and it is still live (readers see it), as this thread knows it. */
  isLive(dim: string, chunkX: number, chunkZ: number): boolean {
    return this.live.has(keyOf(dim, chunkX, chunkZ));
  }

  /** 'up', or 'disabled' (its writer died too often: every read is unknown), or 'stopped'. */
  get writerState(): 'up' | 'disabled' | 'stopped' {
    return this.state;
  }

  // -- readers ------------------------------------------------------------------------------------------------------

  /** A descriptor with its own epoch slot, for one reader thread (workerData). release() gives the slot back. */
  descriptor(): WorldDescriptor {
    const i = this.slots.indexOf(0);
    if (i < 0) throw new Error(`world: all ${this.opts.maxReaders} reader slots are taken (maxReaders)`);
    const token = this.nextToken++;
    this.slots[i] = token;
    return { ...this.base, reader: i, readerToken: token };
  }

  /**
   * Free the epoch slot of a reader that will never read again (a dead worker). Idempotent. A worker killed inside
   * enter() never calls leave(): its slot keeps the old epoch, and no memory freed since could ever be reused. This
   * clears it (the writer reclaims at its next batch, or within a second). Only the descriptor that holds the slot
   * frees it: releasing it again, after the slot went to a new reader, does nothing. Call it once the thread is gone:
   * a reader still running would read memory that is being reused.
   */
  release(d: WorldDescriptor): void {
    if (!d || d.reader <= 0 || d.reader >= this.slots.length || this.slots[d.reader] !== d.readerToken) return;
    Atomics.store(new Int32Array(this.base.control), K_READERS + d.reader, 0);
    this.slots[d.reader] = 0;
  }

  // -- verify -------------------------------------------------------------------------------------------------------

  /** Compare a random sample of the store with the primary holders' own worlds (only when the writer is caught up). */
  verifyRound(samples = this.opts.verifySamples ?? 256): { checked: number; mismatches: number } {
    const out = { checked: 0, mismatches: 0 };
    if (!this.isSettled() || this.state !== 'up' || this.live.size === 0) return out;
    const keys = [...this.live];
    let example = '';
    this.reader.enter();
    try {
      for (let n = 0; n < samples; n++) {
        const col = this.columns.get(keys[Math.floor(Math.random() * keys.length)] as string);
        const primary = col?.holders[0];
        const bot = primary?.bot;
        const bounds = col && this.reader.bounds(col.dim);
        // A bot reading the store (world.shared) has no world of its own to compare with.
        if (!col || primary?.view || !bot?.world?.getBlockStateId || !bounds) continue;
        const x = col.x * 16 + Math.floor(Math.random() * 16);
        const z = col.z * 16 + Math.floor(Math.random() * 16);
        const y = bounds.minY + Math.floor(Math.random() * bounds.height);
        const theirs = bot.world.getBlockStateId(new Vec3(x, y, z));
        const ours = this.reader.stateId(col.dim, x, y, z);
        out.checked++;
        if (ours !== theirs) {
          out.mismatches++;
          example ||= `${col.dim} ${x} ${y} ${z}: store ${ours} (${this.reader.states.name(ours)}), bot ${String(theirs)} (${this.reader.states.name(theirs ?? -1)})`;
        }
      }
    } finally {
      this.reader.leave();
    }
    this.verifyCounters.rounds++;
    this.verifyCounters.checked += out.checked;
    this.verifyCounters.mismatches += out.mismatches;
    this.unreported += out.mismatches;
    const now = Date.now();
    if (this.unreported > 0 && now - this.lastVerifyWarn >= VERIFY_WARN_MS) {
      logger.warn('world', `verify: ${this.unreported} block(s) differ from the bots' worlds since the last report; e.g. ${example || '(see earlier)'}`);
      this.unreported = 0;
      this.lastVerifyWarn = now;
    }
    return out;
  }

  // -- stats, stop --------------------------------------------------------------------------------------------------

  stats(): SharedWorldStats {
    const s = this.writerStats;
    const d = this.base;
    const t = d.tables;
    const tableBytes = t.flags.byteLength + t.blockId.byteLength + t.shapeOf.byteLength + t.shapeStart.byteLength + t.shapeCount.byteLength + t.boxData.byteLength;
    const sorted = this.decodeSamples.filter((v) => v !== undefined).sort((a, b) => a - b);
    let overlay = 0;
    let expired = this.expiredGone;
    for (const v of this.views) {
      overlay += v.overlayEntries();
      expired += v.expired;
    }
    return {
      columnsLive: s?.columnsLive ?? 0,
      columnsCached: s?.columnsCached ?? 0,
      sections: s?.sections ?? 0,
      sectionCapacity: s?.sectionCapacity ?? 0,
      retiredBatches: s?.retiredBatches ?? 0,
      bytes: d.control.byteLength + d.index.byteLength + d.columns.byteLength + d.sections.byteLength + d.dims.byteLength + tableBytes,
      decoded: this.past.decoded + (s?.decoded ?? 0),
      decodeMs: { p50: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted.at(-1) ?? 0 },
      skipped: this.past.skipped + (s?.skipped ?? 0),
      failed: this.past.failed + (s?.failed ?? 0),
      rejected: this.past.rejected + (s?.rejected ?? 0),
      held: this.columns.size,
      ...this.counters,
      payloads: { ...this.payloads },
      writer: this.state === 'up' && this.inline ? 'inline' : this.state,
      verify: { ...this.verifyCounters },
      ...(this.sharedBots ? { shared: { bots: this.views.size, overlay, expired, unacked: this.unackedBytes, unackedPeak: this.unackedPeak } } : {}),
    };
  }

  /** Tests: end the writer as a crash would. */
  async killWriter(): Promise<void> {
    await this.writer?.terminate();
  }

  /** Stop the writer and the timers. The buffers stay readable (frozen). */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    if (this.verifyTimer) clearInterval(this.verifyTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.inline) clearInterval(this.inline.timer);
    this.pending = [];
    this.transfer = [];
    const w = this.writer;
    this.writer = null;
    await w?.terminate();
    this.wakeSettled();
  }
}
