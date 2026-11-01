// The shared world, main-thread side (docs/37 §2, phase P1): ONE copy of the chunks the bots receive, in
// SharedArrayBuffers that every thread reads lock-free (reader.mjs), written by ONE writer thread (writer.mjs,
// store.mjs). P1 feeds it from the bots' packets beside their own worlds; nothing reads it yet but `world.verify` and
// the tests. P2-P5 build on it: reader workers (descriptor()), the aim solver and A* over it, then the bots' own reads.
//
// What this side does (the writer decodes, this side only routes, and copies each payload once):
//   • attach(bot) follows the bot's world packets (follow.ts: the same rules as the pathfinding workers' mirror).
//   • Holders. Each column is held by the bots that received it, in order; the first is its PRIMARY. A column new to
//     every bot is forwarded (its payload copied into an ArrayBuffer that is transferred: mineflayer still parses the
//     original). Another bot receiving it adds a holder and forwards nothing: the store already has it. A re-send to a
//     holder is forwarded (the writer replaces the column, or keeps it when the payload is the same) and makes that
//     holder the primary.
//   • Block changes: only the primary's are forwarded, so N bots hearing one change send it once, and in the order
//     one bot heard them (two bots' streams interleaved could apply an older value last). When the primary lets a
//     column go while others hold it, and a change was heard there in the last RESYNC_WINDOW_MS, the next holder's own
//     column is re-sent (`getColumn().dump()`): a change it heard first, while the old primary was still in charge,
//     would otherwise be lost.
//   • The last holder unloading it, leaving the dimension or disconnecting releases the column: the writer keeps it
//     CACHED (readers: unknown) for world.cacheSeconds, at most world.cacheColumns; a bot receiving the same clean
//     payload again gets it back without a decode.
//   • The writer's answers become 'published' (dim, x, z) / 'unloaded' (dim, x, z) events (P5 turns them into the
//     bots' chunkColumnLoad / chunkColumnUnload).
//   • A writer that dies is restarted over the same buffers (descriptors stay valid): it drops every column (readers
//     read -1 meanwhile) and this side re-sends what the bots hold, from their own worlds. Three deaths in a minute
//     disable it: the store is cleared once and stays empty (every read -1).
//   • world.verify: once a second, a random sample of the store is compared with the primary holders' own worlds.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

import { Vec3 } from 'vec3';

import { logger } from '../logger';
import { followWorldPackets, type FollowedBot } from './follow';
import { allocateWorld, K_READERS } from './layout.mjs';
import { openWorld, type WorldDescriptor, type WorldReader } from './reader.mjs';
import type { StoreStats } from './store.mjs';
import { WorldStore } from './store.mjs';
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

export interface SharedWorldOptions {
  /** The bots' Minecraft version (its registry gives the per-state tables). */
  version: string;
  cacheSeconds: number;
  cacheColumns: number;
  /** Reader epoch slots, the main thread's own reader included (descriptor() hands out the others). */
  maxReaders: number;
  /** Once a second, compare a random sample of the store with the bots' own worlds and log mismatches. */
  verify?: boolean;
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
  /** Columns re-sent from a bot's own world: primary switches, and after a writer restart. */
  resyncs: number;
  restarts: number;
  writer: 'up' | 'disabled' | 'stopped';
  verify: { rounds: number; checked: number; mismatches: number };
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
}

interface Held {
  dim: string;
  x: number;
  z: number;
  /** Bots holding it, the primary first. */
  holders: Holder[];
  /** When a block change was last heard there (any holder). */
  lastChange: number;
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

export class SharedWorld extends EventEmitter {
  /** The main thread's own reader (epoch slot 0). */
  readonly reader: WorldReader;
  private readonly base: WorldDescriptor;
  /** Per epoch slot: 0 = free, else the readerToken of the descriptor holding it (slot 0: this thread's reader). */
  private readonly slots: number[];
  private nextToken = 1;
  private readonly writerUrl: URL;
  private writer: Worker | null = null;
  private state: 'up' | 'disabled' | 'stopped' = 'up';
  private readonly holders = new WeakMap<object, Holder>();
  private readonly columns = new Map<string, Held>();
  /** Keys the writer reported live. */
  private readonly live = new Set<string>();
  private pending: Op[] = [];
  private transfer: ArrayBuffer[] = [];
  private flushScheduled = false;
  private seq = 0;
  private acked = 0;
  private settleWaiters: Array<() => void> = [];
  private writerStats: StoreStats | null = null;
  /** Counters of writers that died, so stats() keeps counting across restarts. */
  private past = { decoded: 0, skipped: 0, failed: 0, rejected: 0 };
  private readonly decodeSamples: number[] = [];
  private decodeAt = 0;
  private crashes: number[] = [];
  private readonly counters = { dropped: 0, resyncs: 0, restarts: 0 };
  private readonly verifyCounters = { rounds: 0, checked: 0, mismatches: 0 };
  private verifyTimer: ReturnType<typeof setInterval> | null = null;
  private lastVerifyWarn = 0;
  private unreported = 0;

  constructor(private readonly opts: SharedWorldOptions) {
    super();
    const t0 = performance.now();
    const registry = require('prismarine-registry')(opts.version) as unknown;
    const tables = buildStateTables(registry);
    this.base = allocateWorld({ version: opts.version, maxReaders: opts.maxReaders, tables, decoder: decoderOptions(registry, tables) });
    this.slots = new Array<number>(opts.maxReaders).fill(0);
    this.slots[0] = -1;
    this.reader = openWorld({ ...this.base, reader: 0 });
    this.writerUrl = opts.writerUrl ?? new URL('./writer.mjs', import.meta.url);
    this.spawn(false);
    if (opts.verify) {
      this.verifyTimer = setInterval(() => this.verifyRound(), opts.verifyIntervalMs ?? 1_000);
      this.verifyTimer.unref();
    }
    logger.info('world', `shared world up (${tables.count} states, tables in ${(performance.now() - t0).toFixed(0)} ms${opts.verify ? ', verify on' : ''})`);
  }

  // -- the bots -----------------------------------------------------------------------------------------------------

  /** Follow a bot's world packets. Call right after createBot, before its first packet. */
  attach(bot: unknown): void {
    const b = bot as WorldBot;
    if (this.state === 'stopped' || !b || typeof b !== 'object' || this.holders.has(b)) return;
    const h: Holder = { bot: b, dim: null, held: new Set() };
    const followed = followWorldPackets(
      b,
      {
        dimension: (name) => {
          this.releaseAll(h);
          h.dim = name;
        },
        chunk: (x, z, data) => this.onChunk(h, x, z, data),
        unload: (x, z) => {
          if (h.dim !== null) this.releaseColumn(h, keyOf(h.dim, x, z));
        },
        block: (x, y, z, s) => this.onBlock(h, x, y, z, s),
        end: () => this.releaseAll(h),
      },
      'world',
      () => this.state !== 'stopped',
    );
    if (followed) this.holders.set(b, h);
  }

  /**
   * The dimension an attached bot is in, as the store names it (its login's or last respawn's world name, e.g.
   * "minecraft:overworld"; mineflayer's bot.game.dimension is the dimension type, "overworld"). Null for a bot not
   * attached here, or before its login (docs/37 P6: a job that reads the store for a bot needs it).
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
      col = { dim: h.dim, x, z, holders: [], lastChange: 0 };
      this.columns.set(key, col);
    }
    const i = col.holders.indexOf(h);
    if (i < 0) {
      col.holders.push(h);
      h.held.add(key);
      // Another bot already holds it: the store has it, and that bot's block changes keep it current.
      if (col.holders.length > 1) return;
    } else if (i > 0) {
      // A re-send: this bot's stream is the newest view of the column now.
      col.holders.splice(i, 1);
      col.holders.unshift(h);
    }
    this.load(col, h, data);
  }

  private onBlock(h: Holder, x: number, y: number, z: number, stateId: number): void {
    if (h.dim === null) return;
    const key = keyOf(h.dim, x >> 4, z >> 4);
    if (!h.held.has(key)) return; // mineflayer ignores these too
    const col = this.columns.get(key);
    if (!col) return;
    col.lastChange = Date.now();
    if (col.holders[0] !== h) {
      this.counters.dropped++;
      return;
    }
    this.push(['set', h.dim, x, y, z, stateId]);
  }

  private releaseColumn(h: Holder, key: string): void {
    if (!h.held.delete(key)) return;
    const col = this.columns.get(key);
    if (!col) return;
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

  /** Re-send a column from its primary's own world (prismarine's dump is the packet's chunkData format). */
  private resync(col: Held): boolean {
    const h = col.holders[0];
    const data = h?.bot.world?.getColumn?.(col.x, col.z)?.dump?.();
    if (!h || !data) return false;
    this.counters.resyncs++;
    this.load(col, h, data);
    return true;
  }

  private load(col: Held, h: Holder, data: Buffer): void {
    // A copy: mineflayer's blocks plugin parses the same Buffer after this listener.
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    this.transfer.push(ab);
    this.push(['load', col.dim, col.x, col.z, h.bot.game?.minY ?? -64, h.bot.game?.height ?? 384, ab]);
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
    if (!this.writer) return;
    this.seq++;
    this.writer.postMessage({ t: 'ops', seq: this.seq, ops }, transfer);
  }

  private spawn(reset: boolean): void {
    const w = new Worker(this.writerUrl, {
      workerData: { descriptor: this.base, cacheSeconds: this.opts.cacheSeconds, cacheColumns: this.opts.cacheColumns, reset },
    });
    w.unref(); // the bots and the HTTP server keep the process alive, never the writer
    this.writer = w;
    w.on('message', (m: WriterMessage) => this.onMessage(w, m));
    w.on('error', (e) => logger.warn('world', `writer failed: ${e.message}`));
    w.on('exit', (code) => this.onExit(w, code));
  }

  private onMessage(w: Worker, m: WriterMessage): void {
    if (w !== this.writer) return;
    this.writerStats = m.stats;
    if (m.t !== 'done') return;
    this.acked = m.seq;
    for (let i = 0; i < m.published.length; i += 3) {
      const [dim, x, z] = [m.published[i] as string, m.published[i + 1] as number, m.published[i + 2] as number];
      this.live.add(keyOf(dim, x, z));
      this.emit('published', dim, x, z);
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
    this.wakeSettled();
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
    this.acked = this.seq; // what the dead writer had not applied is in the bots' worlds, re-sent below
    this.dropLive();
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 60_000);
    this.crashes.push(now);
    if (this.crashes.length >= MAX_CRASHES_PER_MINUTE) {
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
        const bot = col?.holders[0]?.bot;
        const bounds = col && this.reader.bounds(col.dim);
        if (!col || !bot?.world?.getBlockStateId || !bounds) continue;
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
      writer: this.state,
      verify: { ...this.verifyCounters },
    };
  }

  /** Tests: end the writer as a crash would. */
  async killWriter(): Promise<void> {
    await this.writer?.terminate();
  }

  /** Stop the writer and the verify timer. The buffers stay readable (frozen). */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    if (this.verifyTimer) clearInterval(this.verifyTimer);
    this.pending = [];
    this.transfer = [];
    const w = this.writer;
    this.writer = null;
    await w?.terminate();
    this.wakeSettled();
  }
}
