// Reading the shared world (docs/37 §2.1) from any thread: the main thread (SharedWorld.reader) or a worker given a
// descriptor in its workerData. Lock-free: a lookup is a few Atomics.loads on the index and the column, no message,
// no lock. Plain JS so a worker needs no loader; types in reader.d.mts.
//
// The rules a reader keeps (layout.mjs has the memory map):
//   • Every batch of reads is bracketed by enter() / leave(). enter() publishes the epoch the reader reads in; the
//     writer reuses memory freed at epoch e only once every reader has left or entered after e. So within a bracket,
//     a column slot or a section the reader found keeps meaning the same chunk, even if the chunk is dropped meanwhile.
//     A read outside a bracket throws; so does a second enter() before leave().
//   • Only LIVE columns are read: a column no bot holds any more is CACHED (it may be stale) and reads as unknown, -1.
//   • A block inside a live column is always answered: above or below the dimension's height it is air (0), as in
//     prismarine-world. Values are single Uint16 loads, never torn; a block change or a re-sent chunk applied while a
//     batch runs may be seen by some of its reads and not others, as the bots' own worlds change between two ticks.

import { TextDecoder } from 'node:util';

import {
  COL_INTS,
  COL_REFS,
  C_MINY,
  C_SECTIONS,
  C_STATE,
  C_VERSION,
  DIM_INTS,
  K_DIMS,
  K_EPOCH,
  K_READERS,
  K_VERSION,
  LAYOUT_VERSION,
  LIVE,
  PAGE_COLUMNS,
  PAGE_COLUMN_BYTES,
  PAGE_SECTIONS,
  PAGE_SECTION_BYTES,
  SECTION_BLOCKS,
  slotOf,
} from './layout.mjs';
import { F_BB_BLOCK, F_CLIMBABLE, F_EMPTY, F_LAVA, F_LIQUID, F_SOLID, F_WATER, F_WATERLOGGED } from './tables.mjs';

export { F_BB_BLOCK, F_CLIMBABLE, F_EMPTY, F_LAVA, F_LIQUID, F_SOLID, F_WATER, F_WATERLOGGED };

const NO_BOXES = new Float32Array(0);
const utf8 = new TextDecoder();

/** The per-state tables (tables.mjs), read in place. Never write into what they return: it is shared memory. */
export class StateTables {
  constructor(t) {
    this.count = t.count;
    this.flagsOf = new Uint8Array(t.flags);
    this.blockIds = new Uint16Array(t.blockId);
    this.shapeOf = new Uint16Array(t.shapeOf);
    this.shapeStart = new Uint32Array(t.shapeStart);
    this.shapeCount = new Uint8Array(t.shapeCount);
    this.boxData = new Float32Array(t.boxData);
    this.blockNames = t.blockNames;
    /** One view per shape, made on first use: boxes() allocates nothing after that. */
    this.views = new Array(this.shapeStart.length);
  }

  boxes(stateId) {
    if (!(stateId >= 0 && stateId < this.count)) return NO_BOXES;
    const si = this.shapeOf[stateId];
    let v = this.views[si];
    if (v === undefined) {
      const start = this.shapeStart[si];
      v = this.boxData.subarray(start, start + this.shapeCount[si] * 6);
      this.views[si] = v;
    }
    return v;
  }

  /** Where a state's boxes start in boxData (in floats) and how many there are: loops without a view. */
  boxStart(stateId) {
    return stateId >= 0 && stateId < this.count ? this.shapeStart[this.shapeOf[stateId]] : 0;
  }

  boxCount(stateId) {
    return stateId >= 0 && stateId < this.count ? this.shapeCount[this.shapeOf[stateId]] : 0;
  }

  /** The flag byte (F_* bits); 0 for an id out of range. */
  flags(stateId) {
    return stateId >= 0 && stateId < this.count ? this.flagsOf[stateId] : 0;
  }

  isEmpty(stateId) {
    return (this.flags(stateId) & F_EMPTY) !== 0;
  }

  isLiquid(stateId) {
    return (this.flags(stateId) & F_LIQUID) !== 0;
  }

  isClimbable(stateId) {
    return (this.flags(stateId) & F_CLIMBABLE) !== 0;
  }

  isSolid(stateId) {
    return (this.flags(stateId) & F_SOLID) !== 0;
  }

  isWater(stateId) {
    return (this.flags(stateId) & F_WATER) !== 0;
  }

  name(stateId) {
    return stateId >= 0 && stateId < this.count ? (this.blockNames[this.blockIds[stateId]] ?? '') : '';
  }

  blockId(stateId) {
    return stateId >= 0 && stateId < this.count ? this.blockIds[stateId] : -1;
  }
}

export class WorldReader {
  constructor(d) {
    if (d.layout !== LAYOUT_VERSION) throw new Error(`world: descriptor layout ${d.layout}, this reader reads ${LAYOUT_VERSION}`);
    this.ctl = new Int32Array(d.control);
    this.idx = new Int32Array(d.index);
    this.mask = (d.index.byteLength >> 4) - 1;
    this.columnBuffer = d.columns;
    this.sectionBuffer = d.sections;
    this.colPages = [];
    this.secPages = [];
    this.dimTable = new Int32Array(d.dims);
    this.dimBytes = new Uint8Array(d.dims);
    this.dimIds = new Map();
    this.dimBounds = [];
    this.dimsSeen = 0;
    this.slot = d.reader;
    this.inside = false;
    this.states = new StateTables(d.tables);
    // The last dimension name asked, and the last column found (valid within one bracket).
    this.lastDimName = null;
    this.lastDim = -1;
    this.lastTag = 0;
    this.lastX = 0;
    this.lastZ = 0;
    this.lastView = null;
    this.lastBase = 0;
  }

  // -- the bracket --------------------------------------------------------------------------------------------------

  enter() {
    if (this.inside) throw new Error('WorldReader.enter(): already inside a bracket (leave() first; enter is not re-entrant)');
    if (this.slot < 0) throw new Error('WorldReader.enter(): this descriptor has no reader slot (SharedWorld.descriptor() gives one)');
    Atomics.store(this.ctl, K_READERS + this.slot, Atomics.load(this.ctl, K_EPOCH));
    this.inside = true;
    this.lastTag = 0;
  }

  leave() {
    if (!this.inside) throw new Error('WorldReader.leave(): not inside a bracket');
    this.lastTag = 0;
    this.lastView = null;
    this.inside = false;
    Atomics.store(this.ctl, K_READERS + this.slot, 0);
  }

  // -- reads --------------------------------------------------------------------------------------------------------

  stateId(dim, x, y, z) {
    const d = this.dimIndex(dim);
    if (d < 0) {
      if (!this.inside) this.outside('stateId');
      return -1;
    }
    return this.stateIdIn(d, x, y, z);
  }

  /** stateId with a dimension index (dimIndex()): the same answer without the name lookup. */
  stateIdIn(d, x, y, z) {
    if (!this.inside) this.outside('stateIdIn');
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    const cx = x >> 4;
    const cz = z >> 4;
    const tag = d + 1;
    if (tag !== this.lastTag || cx !== this.lastX || cz !== this.lastZ) {
      if (!this.find(tag, cx, cz)) return -1;
    }
    let view = this.lastView;
    let base = this.lastBase;
    if (Atomics.load(view, base + C_STATE) !== LIVE) {
      // The column found earlier in this bracket was dropped: look again (it may be back, in another slot).
      if (!this.find(tag, cx, cz)) return -1;
      view = this.lastView;
      base = this.lastBase;
      if (Atomics.load(view, base + C_STATE) !== LIVE) return -1;
    }
    const minY = view[base + C_MINY];
    const sy = (y - minY) >> 4;
    if (sy < 0 || sy >= view[base + C_SECTIONS]) return 0;
    const ref = Atomics.load(view, base + COL_REFS + sy);
    if (ref === 0) return 0;
    if (ref < 0) return -ref;
    const s = ref - 1;
    const page = this.secPages[s >> 10] ?? this.sectionPage(s >> 10);
    if (page === null) return -1;
    return page[((s & (PAGE_SECTIONS - 1)) << 12) | (((y - minY) & 15) << 8) | ((z & 15) << 4) | (x & 15)];
  }

  hasColumn(dim, chunkX, chunkZ) {
    if (!this.inside) this.outside('hasColumn');
    const d = this.dimIndex(dim);
    if (d < 0 || !this.find(d + 1, chunkX | 0, chunkZ | 0)) return false;
    return Atomics.load(this.lastView, this.lastBase + C_STATE) === LIVE;
  }

  /** A live column's change counter (bumped by every block change and re-decode), or -1. */
  columnVersion(dim, chunkX, chunkZ) {
    if (!this.hasColumn(dim, chunkX, chunkZ)) return -1;
    return Atomics.load(this.lastView, this.lastBase + C_VERSION);
  }

  /** The store's change counter: it moves after every writer batch that changed anything. Any thread, any time. */
  version() {
    return Atomics.load(this.ctl, K_VERSION);
  }

  /** The dimension's index for stateIdIn, or -1 while no column of it was ever stored. Any time. */
  dimIndex(dim) {
    if (dim === this.lastDimName) return this.lastDim;
    let d = this.dimIds.get(dim);
    if (d === undefined) {
      this.readDims();
      d = this.dimIds.get(dim);
      if (d === undefined) return -1;
    }
    this.lastDimName = dim;
    this.lastDim = d;
    return d;
  }

  /** { minY, height } of a dimension the store knows, or null. Any time (dimensions are never removed). */
  bounds(dim) {
    const d = this.dimIndex(dim);
    return d < 0 ? null : this.dimBounds[d];
  }

  // -- internals ----------------------------------------------------------------------------------------------------

  outside(what) {
    throw new Error(`WorldReader.${what}(): read outside enter()/leave()`);
  }

  /** Probe the index; on success lastView/lastBase hold the column (whatever its state). */
  find(tag, cx, cz) {
    const idx = this.idx;
    const mask = this.mask;
    let i = slotOf(tag, cx, cz, mask);
    for (let n = 0; n <= mask; n++) {
      const b = i << 2;
      const t = Atomics.load(idx, b);
      if (t === 0) break;
      if (t === tag && idx[b + 1] === cx && idx[b + 2] === cz) {
        const col = idx[b + 3];
        const view = this.colPages[col >> 10] ?? this.columnPage(col >> 10);
        if (view === null) break;
        this.lastTag = tag;
        this.lastX = cx;
        this.lastZ = cz;
        this.lastView = view;
        this.lastBase = (col & (PAGE_COLUMNS - 1)) * COL_INTS;
        return true;
      }
      i = (i + 1) & mask;
    }
    this.lastTag = 0;
    return false;
  }

  columnPage(p) {
    try {
      const v = new Int32Array(this.columnBuffer, p * PAGE_COLUMN_BYTES, PAGE_COLUMN_BYTES / 4);
      this.colPages[p] = v;
      return v;
    } catch {
      return null; // not grown as far as this reader can see: never expected (the grow precedes the publish)
    }
  }

  sectionPage(p) {
    try {
      const v = new Uint16Array(this.sectionBuffer, p * PAGE_SECTION_BYTES, PAGE_SECTIONS * SECTION_BLOCKS);
      this.secPages[p] = v;
      return v;
    } catch {
      return null;
    }
  }

  readDims() {
    const n = Atomics.load(this.ctl, K_DIMS);
    for (let d = this.dimsSeen; d < n; d++) {
      const base = d * DIM_INTS;
      const len = this.dimTable[base + 2];
      // TextDecoder cannot read shared memory: copy the few bytes out first.
      const name = utf8.decode(this.dimBytes.slice((base + 3) * 4, (base + 3) * 4 + len));
      this.dimIds.set(name, d);
      this.dimBounds[d] = Object.freeze({ minY: this.dimTable[base], height: this.dimTable[base + 1] });
    }
    this.dimsSeen = n;
  }
}

/** A reader over a descriptor (SharedWorld.descriptor() on the main thread, then workerData). */
export function openWorld(descriptor) {
  return new WorldReader(descriptor);
}
