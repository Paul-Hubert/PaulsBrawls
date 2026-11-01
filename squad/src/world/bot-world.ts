// One bot's world with world.shared (docs/37 P5): `bot.world` is this object, prismarine-world's sync API (what
// mineflayer, its plugins and Squad call) over the ONE shared store, instead of ~313 columns parsed into the bot's own
// prismarine-world (20-35 MB a bot, decoded once per bot on the main thread: docs/36 §6's login stall).
//
// What a bot sees, and when (the rules mineflayer's own world keeps, as far as a store a few ms behind can):
//   • Only the columns THIS bot holds (it received them and has not unloaded them), and only once the store has them
//     live. A column the writer has not published yet reads as unloaded (getBlock null), as a column a few ms before
//     its packet would; another bot's columns are not this bot's world.
//   • chunkColumnLoad fires when the column becomes readable for the bot: at once when the store already had it
//     (another bot holds it), else when the writer publishes it (SharedWorld calls _ready). waitForChunksToLoad waits
//     on it, as before. chunkColumnUnload fires on every unload_chunk, and for every column on a change of dimension.
//   • blockUpdate (and `blockUpdate:(x, y, z)`) fires for this bot when IT hears the change (block_change,
//     multi_block_change, explosion) or makes one locally (digging's prediction: setBlockStateId), as mineflayer
//     fires it, synchronously in the packet's handler: placing and digging wait on it. The store applies the change a
//     few ms later (only the column's primary holder's changes are applied, P1), so until it shows it, the bot's own
//     OVERLAY shows it: blockAt agrees with the event at once. An overlay entry goes when the store shows the same
//     state after the batch it was heard in, or after OVERLAY_MS (the store, the primary's stream, wins). A local
//     write is never sent to the store: the server's own block change follows (or the store's state comes back).
//   • Block entities (a sign's text, a chest's nbt) are kept on the main thread per column, one copy for every bot
//     holding it (SharedWorld's record), from map_chunk and tile_entity_data. Light and biomes are not stored: nothing
//     in Squad, its plugins or physics reads them (docs/37 §13); a block's light, skyLight and biome are the template's
//     (0, 0, biome 0), and getBlockLight / getSkyLight / getBiome answer 0.
//   • Blocks are the per-state templates of world/blocks.mjs, specialised by position (35-56 ns, against a whole
//     prismarine Block per call). Whatever a caller writes on a block lands on that small object, never the template.
//
// The store is read through the main thread's bots' reader, which stays inside its epoch bracket and is refreshed
// every few ticks (SharedWorld). This file has no packets and no mineflayer: SharedWorld drives it (_hold, _ready,
// _unload, _heard, _enter, _end), and blocks-plugin.ts makes it the bot's world.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { Vec3 } from 'vec3';

import type { BlockLike, BlockTemplates } from './blocks.mjs';
import type { WorldReader } from './reader.mjs';

const require = createRequire(import.meta.url);
const { RaycastIterator } = require('prismarine-world').iterators as {
  RaycastIterator: new (from: Vec3, dir: Vec3, range: number) => { next(): Vec3 | null; intersect(shapes: number[][], pos: Vec3): { face: number; pos: Vec3 } | null };
};

/** A change this bot heard (or made) that the store does not show yet is shown to it this long at most. */
export const OVERLAY_MS = 5_000;

/** What a bot's world needs from the shared world (SharedWorld implements it). */
export interface BotWorldHost {
  /** The main thread's reader for the bots: always inside its bracket. */
  readonly botsReader: WorldReader;
  readonly templates: BlockTemplates;
  /** The writer batch the next op goes into (an overlay entry is checked once that batch is applied). */
  nextSeq(): number;
  /** The last batch the writer has applied. */
  appliedSeq(): number;
  /** Nothing is on its way to the writer: every op sent so far is applied (the store is as new as the primaries). */
  settled(): boolean;
  /** A bot whose overlay is not empty (SharedWorld prunes it after every applied batch). */
  overlaid(world: SharedBotWorld): void;
}

/** The shared world's record of a column, as a bot's world reads it: one per column, for every bot holding it. */
export interface SharedColumn {
  /** Block entities by in-column position `${x & 15},${y},${z & 15}` (prismarine-chunk's key), or null: none. */
  blockEntities: Record<string, unknown> | null;
}

interface OverlayEntry {
  x: number;
  y: number;
  z: number;
  state: number;
  /** Date.now() when heard. */
  at: number;
  /** The writer batch it was heard before (nextSeq()). */
  seq: number;
}

interface BotColumn {
  x: number;
  z: number;
  shared: SharedColumn;
  /** Changes not shown by the store yet, by blockKey; null when none. */
  overlay: Map<number, OverlayEntry> | null;
  view: ColumnView | null;
}

/** A column's key in a bot's map: chunk coordinates are within ±2^21. */
const colKey = (cx: number, cz: number): number => (cx + 0x200000) * 0x400000 + (cz + 0x200000);
/** A block's key in its column's overlay. */
const blockKey = (x: number, y: number, z: number): number => (y << 8) | ((z & 15) << 4) | (x & 15);
/** prismarine-chunk's block-entity key (in-column x and z, absolute y). */
const entityKey = (x: number, y: number, z: number): string => `${x & 15},${y},${z & 15}`;

/**
 * What `bot.world.getColumn()` returns with world.shared: a light view of one column of the bot's world (prismarine-
 * chunk's per-column reads, positions in the column: x and z 0-15, y absolute), not a parsed column. Squad's own
 * hot readers do not go through it (aim/inline.ts reads stateIdAt).
 */
export class ColumnView {
  constructor(
    private readonly world: SharedBotWorld,
    readonly x: number,
    readonly z: number,
    private readonly col: BotColumn,
  ) {}

  get minY(): number {
    return this.world.bounds()?.minY ?? 0;
  }

  get worldHeight(): number {
    return this.world.bounds()?.height ?? 0;
  }

  get blockEntities(): Record<string, unknown> {
    return (this.col.shared.blockEntities ??= {});
  }

  getBlockStateId(p: { x: number; y: number; z: number }): number {
    const s = this.world.stateIdAt(this.x * 16 + (p.x & 15), Math.floor(p.y), this.z * 16 + (p.z & 15));
    return s < 0 ? 0 : s;
  }

  /** A Block of this column, its position null (prismarine-chunk's getBlock: the world sets the position). */
  getBlock(p: { x: number; y: number; z: number }): BlockLike {
    const b = this.world.host.templates.at(this.getBlockStateId(p), null);
    const e = this.col.shared.blockEntities?.[entityKey(p.x, Math.floor(p.y), p.z)];
    if (e !== undefined) b.entity = e;
    return b;
  }

  getBlockType(p: { x: number; y: number; z: number }): number {
    return this.world.host.templates.template(this.getBlockStateId(p)).type;
  }

  getBlockData(p: { x: number; y: number; z: number }): number {
    return this.world.host.templates.template(this.getBlockStateId(p)).metadata as number;
  }

  getBlockLight(): number {
    return 0;
  }

  getSkyLight(): number {
    return 0;
  }

  getBiome(): number {
    return 0;
  }

  getBlockEntity(p: { x: number; y: number; z: number }): unknown {
    return this.col.shared.blockEntities?.[entityKey(p.x, p.y, p.z)];
  }

  setBlockEntity(p: { x: number; y: number; z: number }, tag: unknown): void {
    this.blockEntities[entityKey(p.x, p.y, p.z)] = tag;
  }

  removeBlockEntity(p: { x: number; y: number; z: number }): void {
    if (this.col.shared.blockEntities) delete this.col.shared.blockEntities[entityKey(p.x, p.y, p.z)];
  }
}

export class SharedBotWorld extends EventEmitter {
  /** The store's name of the bot's dimension (its login's or last respawn's world name), null before the login. */
  dim: string | null = null;
  /** Called on a change of dimension before the columns go (blocks-plugin.ts: mineflayer's switchWorld cleanup). */
  onSwitch: (() => void) | null = null;
  /** Overlay entries given up after OVERLAY_MS: the store never showed what the bot heard (or predicted). */
  expired = 0;
  private d = -1;
  private readonly cols = new Map<number, BotColumn>();
  /** The columns whose overlay is not empty. */
  private readonly withOverlay = new Set<BotColumn>();
  private lastCx = Number.NaN;
  private lastCz = Number.NaN;
  private lastCol: BotColumn | null = null;

  constructor(readonly host: BotWorldHost) {
    super();
    this.setMaxListeners(0);
  }

  // -- reads (prismarine-world's sync API) ----------------------------------------------------------------------

  /**
   * The state id at an integer position as this bot sees it, or -1: a column it does not hold, or that the store does
   * not have live yet. The hot path of every read (physics, A* on the main thread, the inline aim).
   */
  stateIdAt(x: number, y: number, z: number): number {
    const cx = x >> 4;
    const cz = z >> 4;
    let c: BotColumn | null;
    if (cx === this.lastCx && cz === this.lastCz) {
      c = this.lastCol;
    } else {
      c = this.cols.get(colKey(cx, cz)) ?? null;
      this.lastCx = cx;
      this.lastCz = cz;
      this.lastCol = c;
    }
    if (c === null) return -1;
    let d = this.d;
    if (d < 0) {
      if (this.dim === null) return -1;
      d = this.d = this.host.botsReader.dimIndex(this.dim);
      if (d < 0) return -1;
    }
    const s = this.host.botsReader.stateIdIn(d, x, y, z);
    if (s < 0 || c.overlay === null) return s;
    const e = c.overlay.get(blockKey(x, y, z));
    return e === undefined ? s : e.state;
  }

  getBlock(pos: { x: number; y: number; z: number }): BlockLike | null {
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    const z = Math.floor(pos.z);
    const s = this.stateIdAt(x, y, z);
    if (s < 0) return null;
    const b = this.host.templates.at(s, new Vec3(x, y, z));
    // stateIdAt left the column in lastCol.
    const be = (this.lastCol as BotColumn).shared.blockEntities;
    if (be !== null) {
      const e = be[entityKey(x, y, z)];
      if (e !== undefined) b.entity = e;
    }
    return b;
  }

  /** 0 for a column not loaded, as prismarine-world. */
  getBlockStateId(pos: { x: number; y: number; z: number }): number {
    const s = this.stateIdAt(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    return s < 0 ? 0 : s;
  }

  getBlockType(pos: { x: number; y: number; z: number }): number {
    const s = this.stateIdAt(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    return s < 0 ? 0 : this.host.templates.template(s).type;
  }

  getBlockData(pos: { x: number; y: number; z: number }): number {
    const s = this.stateIdAt(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    return s < 0 ? 0 : (this.host.templates.template(s).metadata as number);
  }

  /** Light and biomes are not stored (see the header). */
  getBlockLight(): number {
    return 0;
  }

  getSkyLight(): number {
    return 0;
  }

  getBiome(): number {
    return 0;
  }

  /** The column at chunk (x, z) when the bot holds it and the store has it live, else undefined (prismarine's). */
  getColumn(chunkX: number, chunkZ: number): ColumnView | undefined {
    const c = this.cols.get(colKey(chunkX, chunkZ));
    if (!c || !this.isLive(chunkX, chunkZ)) return undefined;
    return (c.view ??= new ColumnView(this, chunkX, chunkZ, c));
  }

  getColumnAt(pos: { x: number; z: number }): ColumnView | undefined {
    return this.getColumn(Math.floor(pos.x / 16), Math.floor(pos.z / 16));
  }

  getColumns(): Array<{ chunkX: number; chunkZ: number; column: ColumnView }> {
    const out: Array<{ chunkX: number; chunkZ: number; column: ColumnView }> = [];
    for (const c of this.cols.values()) {
      const column = this.getColumn(c.x, c.z);
      if (column) out.push({ chunkX: c.x, chunkZ: c.z, column });
    }
    return out;
  }

  /** Whether the bot holds this column (received, not unloaded), readable or not yet. */
  holds(chunkX: number, chunkZ: number): boolean {
    return this.cols.has(colKey(chunkX, chunkZ));
  }

  /** Columns the bot holds. */
  get size(): number {
    return this.cols.size;
  }

  /** { minY, height } of the bot's dimension, once the store has seen it. */
  bounds(): { readonly minY: number; readonly height: number } | null {
    return this.dim === null ? null : this.host.botsReader.bounds(this.dim);
  }

  /** prismarine-world's raycast (worldsync.js), line for line, over this bot's world. */
  raycast(from: Vec3, direction: Vec3, range: number, matcher: ((block: BlockLike, iter: unknown) => boolean) | null = null): BlockLike | null {
    const iter = new RaycastIterator(from, direction, range);
    let pos: Vec3 | null = from;
    while (pos) {
      const position = new Vec3(pos.x, pos.y, pos.z);
      const block = this.getBlock(position);
      if (block) {
        if (matcher) {
          if (matcher(block, iter)) return block;
        } else {
          const intersect = iter.intersect(block.shapes, position);
          if (intersect) {
            block.face = intersect.face;
            block.intersect = intersect.pos;
            return block;
          }
        }
      }
      pos = iter.next();
    }
    return null;
  }

  // -- local writes ---------------------------------------------------------------------------------------------

  /**
   * A write by the bot itself (mineflayer's digging predicts the dug block's air with it): shown to this bot only, in
   * its overlay, with the events; never sent to the store. The server's block change confirms it (or puts the block
   * back), and after OVERLAY_MS the store wins anyway.
   */
  setBlockStateId(pos: { x: number; y: number; z: number }, stateId: number): void {
    this._heard(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), stateId);
  }

  setBlock(pos: { x: number; y: number; z: number }, block: { stateId?: number; entity?: unknown }): void {
    if (typeof block.stateId === 'number') this.setBlockStateId(pos, block.stateId);
    if (block.entity !== undefined) this._setBlockEntity(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), block.entity);
  }

  setBlockType(pos: { x: number; y: number; z: number }, type: number): void {
    const min = (this.host.templates.registry as { blocks?: Record<number, { minStateId?: number }> }).blocks?.[type]?.minStateId;
    if (typeof min === 'number') this.setBlockStateId(pos, min);
  }

  setBlockData(pos: { x: number; y: number; z: number }, data: number): void {
    const s = this.stateIdAt(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    if (s < 0) return;
    const t = this.host.templates.template(s);
    this.setBlockStateId(pos, s - (t.metadata as number) + data);
  }

  /** Light and biomes are not stored: these change nothing. */
  setBlockLight(): void {}

  setSkyLight(): void {}

  setBiome(): void {}

  /** The shared world holds the columns: a bot's world cannot add or drop one. */
  setColumn(): void {
    throw new Error('bot.world.setColumn: not available with world.shared (the shared world holds the columns)');
  }

  unloadColumn(): void {
    throw new Error('bot.world.unloadColumn: not available with world.shared (the shared world holds the columns)');
  }

  // -- block entities (blocks-plugin.ts) --------------------------------------------------------------------------

  /** A map_chunk's block entities (1.17+: { x, y, z, nbtData }, x and z in the column): the column's whole set. */
  _setBlockEntities(chunkX: number, chunkZ: number, list: Array<{ x?: number; y?: number; z?: number; nbtData?: unknown }>): void {
    const c = this.cols.get(colKey(chunkX, chunkZ));
    if (!c) return;
    const map: Record<string, unknown> = {};
    let n = 0;
    for (const e of list) {
      if (e.x === undefined || e.y === undefined || e.z === undefined) continue;
      map[entityKey(e.x, e.y, e.z)] = e.nbtData;
      n++;
    }
    c.shared.blockEntities = n > 0 ? map : null;
  }

  /** One block entity (tile_entity_data). False when the bot does not hold the column (mineflayer ignores it). */
  _setBlockEntity(x: number, y: number, z: number, tag: unknown): boolean {
    const c = this.cols.get(colKey(x >> 4, z >> 4));
    if (!c) return false;
    (c.shared.blockEntities ??= {})[entityKey(x, y, z)] = tag;
    return true;
  }

  // -- driven by SharedWorld --------------------------------------------------------------------------------------

  /** The bot received the column (map_chunk): it holds it now, readable once the store has it live. */
  _hold(chunkX: number, chunkZ: number, shared: SharedColumn): void {
    const k = colKey(chunkX, chunkZ);
    const c = this.cols.get(k);
    if (c) {
      c.shared = shared;
      return;
    }
    this.cols.set(k, { x: chunkX, z: chunkZ, shared, overlay: null, view: null });
    this.forget();
  }

  /** The column became readable for the bot: chunkColumnLoad. */
  _ready(chunkX: number, chunkZ: number): void {
    if (!this.cols.has(colKey(chunkX, chunkZ))) return;
    this.emit('chunkColumnLoad', new Vec3(chunkX * 16, 0, chunkZ * 16));
  }

  /** unload_chunk: the column goes (the event fires even for a column the bot did not hold, as mineflayer's). */
  _unload(chunkX: number, chunkZ: number): void {
    this.drop(colKey(chunkX, chunkZ));
    this.emit('chunkColumnUnload', new Vec3(chunkX * 16, 0, chunkZ * 16));
  }

  /**
   * A block change the bot heard (or made): its overlay shows it until the store does; the events fire as mineflayer
   * fires them (old and new Block, one position object), for a column the bot holds and can read.
   */
  _heard(x: number, y: number, z: number, stateId: number): void {
    const c = this.cols.get(colKey(x >> 4, z >> 4));
    if (!c) return; // mineflayer ignores a change in a column it does not have
    const before = this.stateIdAt(x, y, z);
    const k = blockKey(x, y, z);
    if (before >= 0 && this.host.settled() && this.host.botsReader.stateIdIn(this.d, x, y, z) === stateId) {
      // The store shows it already and nothing is on its way to the writer (another bot, the column's primary, heard
      // it first): no overlay needed, and an older entry of this block is out of date.
      if (c.overlay?.delete(k) && c.overlay.size === 0) {
        c.overlay = null;
        this.withOverlay.delete(c);
      }
    } else {
      const now = Date.now();
      const seq = this.host.nextSeq();
      let overlay = c.overlay;
      if (overlay === null) {
        overlay = c.overlay = new Map();
        this.withOverlay.add(c);
        this.host.overlaid(this);
      }
      const e = overlay.get(k);
      if (e) {
        e.state = stateId;
        e.at = now;
        e.seq = seq;
      } else {
        overlay.set(k, { x, y, z, state: stateId, at: now, seq });
      }
    }
    if (before < 0) return; // not readable yet: chunkColumnLoad comes when it is
    const position = new Vec3(x, y, z);
    const templates = this.host.templates;
    const oldBlock = templates.at(before, position);
    const newBlock = templates.at(stateId, position);
    const be = c.shared.blockEntities?.[entityKey(x, y, z)];
    if (be !== undefined) {
      oldBlock.entity = be;
      newBlock.entity = be;
    }
    this.emit('blockUpdate', oldBlock, newBlock);
    this.emit(`blockUpdate:${position}`, oldBlock, newBlock);
  }

  /**
   * A new dimension (login, or a respawn into another world): mineflayer's switchWorld (onSwitch, then every column
   * unloaded with its event). The first login has nothing to unload.
   */
  _enter(name: string): void {
    if (this.dim !== null) {
      this.onSwitch?.();
      for (const c of [...this.cols.values()]) this._unload(c.x, c.z);
    }
    this.clear();
    this.dim = name;
    this.d = -1;
  }

  /** The bot ended: it holds nothing now. */
  _end(): void {
    this.clear();
  }

  /**
   * After a writer batch (and once a second): drop the overlay entries the store now shows (after the batch they were
   * heard before, or with nothing on its way to the writer: `settled`) and the ones older than OVERLAY_MS. Returns
   * whether any are left.
   */
  _prune(applied: number, now: number, settled = false): boolean {
    const reader = this.host.botsReader;
    for (const c of this.withOverlay) {
      const overlay = c.overlay as Map<number, OverlayEntry>;
      for (const [k, e] of overlay) {
        if (now - e.at > OVERLAY_MS) {
          overlay.delete(k);
          this.expired++;
        } else if ((settled || applied >= e.seq) && this.d >= 0 && reader.stateIdIn(this.d, e.x, e.y, e.z) === e.state) {
          overlay.delete(k);
        }
      }
      if (overlay.size === 0) {
        c.overlay = null;
        this.withOverlay.delete(c);
      }
    }
    return this.withOverlay.size > 0;
  }

  /** The changes in a column the store does not show yet ([x, y, z, state] each): a new primary's replay (P1 §9.3). */
  _pending(chunkX: number, chunkZ: number): Array<[number, number, number, number]> {
    const c = this.cols.get(colKey(chunkX, chunkZ));
    if (!c?.overlay) return [];
    return [...c.overlay.values()].map((e) => [e.x, e.y, e.z, e.state]);
  }

  /** Overlay entries now (stats). */
  overlayEntries(): number {
    let n = 0;
    for (const c of this.withOverlay) n += c.overlay?.size ?? 0;
    return n;
  }

  // -- internals ------------------------------------------------------------------------------------------------

  /** Whether the store has the column live (readable), as the bots' reader sees it now. */
  private isLive(chunkX: number, chunkZ: number): boolean {
    return this.dim !== null && this.host.botsReader.hasColumn(this.dim, chunkX, chunkZ);
  }

  private drop(k: number): void {
    const c = this.cols.get(k);
    if (!c) return;
    this.cols.delete(k);
    this.withOverlay.delete(c);
    this.forget();
  }

  private clear(): void {
    this.cols.clear();
    this.withOverlay.clear();
    this.forget();
  }

  /** The last-column cache, after the map changed. */
  private forget(): void {
    this.lastCx = Number.NaN;
    this.lastCz = Number.NaN;
    this.lastCol = null;
  }
}
