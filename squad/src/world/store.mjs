// The writer's side of the shared world (docs/37 §2.2-2.3): the only code that writes the store. writer.mjs runs it
// on the writer thread; tests drive it synchronously on theirs. Plain JS, types in store.d.mts.
//
// What it does with the main thread's ops (SharedWorld batches them per macrotask):
//   load(dim, x, z, minY, height, bytes)   a chunk payload, for a column no bot held yet, a re-send, or a resync. Its
//                                          sha1 is compared with the column's last payload: a column still clean
//                                          (no block change since) with the same payload is published as is, without
//                                          decoding (a respawn, walking back). Otherwise it is decoded in place.
//   release(dim, x, z)                     the last bot holding it let it go: LIVE → CACHED (readers: unknown).
//   set(dim, x, y, z, stateId)             a block change of a live column (one per change, the main thread dedups).
//   expire(now)                            drop cached columns older than cacheSeconds, or beyond cacheColumns.
//   endBatch()                             after a batch: bump the change counter, retire what was freed at the
//                                          current epoch and move the epoch, then reclaim what every reader is past.
//
// Publishing: a new column's slot is filled (header, section refs) before its index entry's tag is stored, and it
// becomes LIVE last, with Atomics.store; a reader that sees LIVE sees the whole column. A new section is filled before
// the ref that points to it is stored. Freed slots, sections and index entries (tombstones) are reused only after
// every reader has left the epoch they were freed in (reclaim()).
//
// A section that one value fills (air, an ocean's water) is a ref, not 8 KB. Block changes into it materialise it.

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { TextDecoder, TextEncoder } from 'node:util';

import { decodeColumn, FULL } from './decode.mjs';
import {
  after,
  CACHED,
  COL_INTS,
  COL_REFS,
  C_MINY,
  C_SECTIONS,
  C_STATE,
  C_TAG,
  C_VERSION,
  C_X,
  C_Z,
  DIM_INTS,
  DIM_NAME_BYTES,
  FREE,
  K_COLUMNS_HWM,
  K_DIMS,
  K_EPOCH,
  K_READERS,
  K_SECTIONS_HWM,
  K_VERSION,
  LIVE,
  MAX_COLUMN_PAGES,
  MAX_COLUMN_SECTIONS,
  MAX_DIMS,
  MAX_SECTION_PAGES,
  PAGE_COLUMNS,
  PAGE_COLUMN_BYTES,
  PAGE_SECTIONS,
  PAGE_SECTION_BYTES,
  SECTION_BLOCKS,
  TOMBSTONE,
  slotOf,
} from './layout.mjs';

const utf8 = new TextEncoder();

// Index entry states, writer-private (the shared tag says empty / tombstone / used; this says whether a tombstone is
// reusable yet).
const E_EMPTY = 0;
const E_USED = 1;
const E_RETIRED = 2;
const E_REUSABLE = 3;

function sha1(bytes) {
  return createHash('sha1').update(bytes).digest('base64');
}

export class WorldStore {
  /**
   * @param descriptor the buffers (layout.mjs allocateWorld)
   * @param opts { cacheSeconds, cacheColumns, reset?: boolean, now?: () => number }
   */
  constructor(descriptor, opts) {
    this.d = descriptor;
    this.cacheMs = Math.max(0, opts.cacheSeconds) * 1000;
    this.cacheColumns = Math.max(0, Math.floor(opts.cacheColumns));
    this.now = opts.now ?? Date.now;
    this.decoder = descriptor.decoder;
    this.ctl = new Int32Array(descriptor.control);
    this.idx = new Int32Array(descriptor.index);
    this.mask = (descriptor.index.byteLength >> 4) - 1;
    this.entryState = new Uint8Array(this.mask + 1);
    this.dimTable = new Int32Array(descriptor.dims);
    this.dimBytes = new Uint8Array(descriptor.dims);
    this.colPages = [];
    this.secPages = [];
    /** "tag|x|z" → column record (writer-private) */
    this.columns = new Map();
    /** Cached columns, oldest first (a Map keeps insertion order). */
    this.cache = new Map();
    this.freeColumns = [];
    this.freeSections = [];
    this.pending = { columns: [], sections: [], entries: [] };
    /** Retired batches, oldest first: { epoch, columns, sections, entries }. */
    this.retired = [];
    this.dims = new Map();
    this.scratch = new Uint16Array(SECTION_BLOCKS);
    this.changed = false;
    this.sectionsUsed = 0;
    this.tombstones = 0;
    this.used = 0;
    this.counters = { decoded: 0, skipped: 0, failed: 0, rejected: 0, evicted: 0 };
    this.readDims();
    this.mapPages();
    if (opts.reset) this.reset();
  }

  // -- the ops ------------------------------------------------------------------------------------------------------

  /**
   * A chunk payload. Returns { live, decoded, ms, wasLive, error? }: live = the column is LIVE now with this content
   * (publish it), decoded = it was decoded (ms = the decode time), wasLive = it was LIVE before (an error then
   * unpublishes it).
   */
  load(dim, x, z, minY, height, bytes) {
    const nSections = height >> 4;
    const d = this.dimOf(dim, minY, height);
    if (d < 0 || nSections <= 0 || nSections > MAX_COLUMN_SECTIONS || (height & 15) !== 0) {
      this.counters.rejected++;
      return { live: false, decoded: false, ms: 0, wasLive: false, error: d < 0 ? `dimension ${dim} not stored` : `height ${height} not stored (at most ${MAX_COLUMN_SECTIONS * 16})` };
    }
    const tag = d + 1;
    const key = `${tag}|${x}|${z}`;
    const hash = sha1(bytes);
    let col = this.columns.get(key);
    if (col && (col.minY !== minY || col.nSections !== nSections)) {
      this.evict(col);
      col = undefined;
    }
    const wasLive = col?.state === LIVE;
    if (col && !col.dirty && col.hash === hash) {
      this.counters.skipped++;
      if (col.state !== LIVE) {
        this.cache.delete(key);
        this.setState(col, LIVE);
      }
      return { live: true, decoded: false, ms: 0, wasLive };
    }
    let fresh = false;
    if (!col) {
      col = this.newColumn(tag, x, z, minY, nSections);
      if (!col) {
        this.counters.rejected++;
        return { live: false, decoded: false, ms: 0, wasLive: false, error: 'the store is full' };
      }
      fresh = true;
    }
    const t0 = performance.now();
    try {
      decodeColumn(bytes, nSections, this.decoder, this.scratch, (i, kind, value) => this.putSection(col, i, kind, value));
    } catch (e) {
      // An unreadable column is a hole, never stale or half-written data.
      this.counters.failed++;
      if (fresh) this.dropNew(col);
      else this.evict(col);
      return { live: false, decoded: false, ms: 0, wasLive, error: e instanceof Error ? e.message : String(e) };
    }
    const ms = performance.now() - t0;
    col.hash = hash;
    col.dirty = false;
    this.bumpColumn(col);
    if (fresh && !this.publishEntry(col)) {
      this.counters.rejected++;
      this.dropNew(col);
      return { live: false, decoded: false, ms: 0, wasLive: false, error: 'the index is full' };
    }
    this.cache.delete(key);
    this.setState(col, LIVE);
    this.counters.decoded++;
    return { live: true, decoded: true, ms, wasLive };
  }

  /** The last bot let the column go: it becomes CACHED. Returns true when it was LIVE. */
  release(dim, x, z) {
    const d = this.dims.get(dim);
    if (d === undefined) return false;
    const col = this.columns.get(`${d + 1}|${x}|${z}`);
    if (!col || col.state !== LIVE) return false;
    this.setState(col, CACHED);
    col.cachedAt = this.now();
    this.cache.set(col.key, col);
    while (this.cache.size > this.cacheColumns) this.evict(this.cache.values().next().value);
    return true;
  }

  /** A block change. Ignored for a column that is not LIVE (no bot holds it, as mineflayer ignores it). */
  set(dim, x, y, z, stateId) {
    const d = this.dims.get(dim);
    if (d === undefined) return;
    const col = this.columns.get(`${d + 1}|${x >> 4}|${z >> 4}`);
    if (!col || col.state !== LIVE) return;
    const sy = (y - col.minY) >> 4;
    if (sy < 0 || sy >= col.nSections) return;
    const i = (((y - col.minY) & 15) << 8) | ((z & 15) << 4) | (x & 15);
    const view = col.view;
    const at = col.base + COL_REFS + sy;
    const ref = view[at];
    if (ref > 0) {
      const page = this.secPages[(ref - 1) >> 10];
      const off = ((ref - 1) & (PAGE_SECTIONS - 1)) * SECTION_BLOCKS + i;
      if (page[off] === stateId) return;
      page[off] = stateId;
    } else {
      const fill = -ref; // 0 for air
      if (fill === stateId) return;
      const s = this.allocSection();
      if (s < 0) return; // full: the change is lost, verify would show it
      const page = this.secPages[s >> 10];
      const off = (s & (PAGE_SECTIONS - 1)) * SECTION_BLOCKS;
      page.fill(fill, off, off + SECTION_BLOCKS);
      page[off + i] = stateId;
      Atomics.store(view, at, s + 1);
    }
    col.dirty = true;
    this.bumpColumn(col);
  }

  /** Drop cached columns past cacheSeconds. Returns how many. */
  expire(now = this.now()) {
    let n = 0;
    for (const col of this.cache.values()) {
      if (now - col.cachedAt < this.cacheMs) break;
      this.evict(col);
      n++;
    }
    return n;
  }

  /** After a batch of ops: publish the change counter, retire what was freed, reclaim what readers are past. */
  endBatch() {
    if (this.changed) {
      Atomics.add(this.ctl, K_VERSION, 1);
      this.changed = false;
    }
    const p = this.pending;
    if (p.columns.length || p.sections.length || p.entries.length) {
      const epoch = Atomics.load(this.ctl, K_EPOCH);
      this.retired.push({ epoch, ...p });
      this.pending = { columns: [], sections: [], entries: [] };
      // Every reader that enters from now on reads the next epoch, and cannot reach what was just retired.
      Atomics.store(this.ctl, K_EPOCH, ((epoch + 1) | 0) || 1);
    }
    this.reclaim();
  }

  /** Free the retired batches that every reader has left behind. */
  reclaim() {
    if (this.retired.length === 0) return 0;
    const n = this.d.maxReaders;
    let freed = 0;
    while (this.retired.length > 0) {
      const r = this.retired[0];
      let blocked = false;
      for (let i = 0; i < n; i++) {
        const e = Atomics.load(this.ctl, K_READERS + i);
        if (e !== 0 && !after(e, r.epoch)) {
          blocked = true;
          break;
        }
      }
      if (blocked) break;
      this.retired.shift();
      for (const c of r.columns) this.freeColumns.push(c);
      for (const s of r.sections) this.freeSections.push(s);
      for (const e of r.entries) this.entryState[e] = E_REUSABLE;
      freed++;
    }
    return freed;
  }

  /**
   * A new writer over the buffers of a dead one: its private state died with it, so every column is dropped (readers
   * see -1 at once) and all memory handed out so far is retired at the current epoch; the main thread then re-sends
   * what its bots hold. Dimensions keep their indexes.
   */
  reset() {
    const colHwm = Atomics.load(this.ctl, K_COLUMNS_HWM);
    const secHwm = Atomics.load(this.ctl, K_SECTIONS_HWM);
    this.mapPages();
    for (let c = 0; c < colHwm; c++) {
      const view = this.colPages[c >> 10];
      Atomics.store(view, (c & (PAGE_COLUMNS - 1)) * COL_INTS + C_STATE, FREE);
      this.pending.columns.push(c);
    }
    for (let s = 0; s < secHwm; s++) this.pending.sections.push(s);
    for (let e = 0; e <= this.mask; e++) {
      const t = this.idx[e << 2];
      if (t === 0) continue;
      if (t !== TOMBSTONE) Atomics.store(this.idx, e << 2, TOMBSTONE);
      this.entryState[e] = E_RETIRED;
      this.pending.entries.push(e);
      this.tombstones++;
    }
    this.changed = true;
    this.endBatch();
  }

  stats() {
    const cached = this.cache.size;
    return {
      columnsLive: this.columns.size - cached,
      columnsCached: cached,
      sections: this.sectionsUsed,
      sectionCapacity: Atomics.load(this.ctl, K_SECTIONS_HWM),
      retiredBatches: this.retired.length,
      indexUsed: this.used,
      tombstones: this.tombstones,
      ...this.counters,
    };
  }

  // -- columns ------------------------------------------------------------------------------------------------------

  newColumn(tag, x, z, minY, nSections) {
    const slot = this.allocColumn();
    if (slot < 0) return null;
    const view = this.colPages[slot >> 10];
    const base = (slot & (PAGE_COLUMNS - 1)) * COL_INTS;
    // Not reachable by any reader yet (no index entry): plain stores.
    view.fill(0, base, base + COL_INTS);
    view[base + C_TAG] = tag;
    view[base + C_X] = x;
    view[base + C_Z] = z;
    view[base + C_MINY] = minY;
    view[base + C_SECTIONS] = nSections;
    const col = { key: `${tag}|${x}|${z}`, tag, x, z, minY, nSections, slot, view, base, entry: -1, state: FREE, hash: '', dirty: false, cachedAt: 0 };
    this.columns.set(col.key, col);
    return col;
  }

  /** Store one decoded section into the column (in place when it already has its own section). */
  putSection(col, i, kind, value) {
    const at = col.base + COL_REFS + i;
    const old = col.view[at];
    if (kind === FULL) {
      if (old > 0) {
        const s = old - 1;
        this.secPages[s >> 10].set(this.scratch, (s & (PAGE_SECTIONS - 1)) * SECTION_BLOCKS);
        return;
      }
      const s = this.allocSection();
      if (s < 0) throw new Error('the store has no room for another section');
      this.secPages[s >> 10].set(this.scratch, (s & (PAGE_SECTIONS - 1)) * SECTION_BLOCKS);
      Atomics.store(col.view, at, s + 1);
      return;
    }
    const ref = value === 0 ? 0 : -value;
    if (old === ref) return;
    Atomics.store(col.view, at, ref);
    if (old > 0) this.retireSection(old - 1);
  }

  publishEntry(col) {
    const idx = this.idx;
    let i = slotOf(col.tag, col.x, col.z, this.mask);
    for (let n = 0; n <= this.mask; n++) {
      const st = this.entryState[i];
      if (st === E_EMPTY || st === E_REUSABLE) {
        const b = i << 2;
        idx[b + 1] = col.x;
        idx[b + 2] = col.z;
        idx[b + 3] = col.slot;
        Atomics.store(idx, b, col.tag);
        if (st === E_REUSABLE) this.tombstones--;
        this.entryState[i] = E_USED;
        col.entry = i;
        this.used++;
        return true;
      }
      i = (i + 1) & this.mask;
    }
    return false;
  }

  setState(col, state) {
    col.state = state;
    Atomics.store(col.view, col.base + C_STATE, state);
    this.changed = true;
  }

  bumpColumn(col) {
    Atomics.add(col.view, col.base + C_VERSION, 1);
    this.changed = true;
  }

  /** Drop a column for good: unpublish, tombstone its entry, retire its slot and sections. */
  evict(col) {
    if (col.state !== FREE) this.setState(col, FREE);
    if (col.entry >= 0) {
      Atomics.store(this.idx, col.entry << 2, TOMBSTONE);
      this.entryState[col.entry] = E_RETIRED;
      this.pending.entries.push(col.entry);
      this.used--;
      this.tombstones++;
      col.entry = -1;
    }
    for (let i = 0; i < col.nSections; i++) {
      const ref = col.view[col.base + COL_REFS + i];
      if (ref > 0) this.retireSection(ref - 1);
    }
    this.pending.columns.push(col.slot);
    this.columns.delete(col.key);
    this.cache.delete(col.key);
    this.counters.evicted++;
  }

  /** A column that was never published (its decode failed): its memory is free again at once. */
  dropNew(col) {
    for (let i = 0; i < col.nSections; i++) {
      const ref = col.view[col.base + COL_REFS + i];
      if (ref > 0) {
        this.freeSections.push(ref - 1);
        this.sectionsUsed--;
      }
    }
    this.freeColumns.push(col.slot);
    this.columns.delete(col.key);
  }

  retireSection(s) {
    this.pending.sections.push(s);
    this.sectionsUsed--;
  }

  // -- memory -------------------------------------------------------------------------------------------------------

  allocColumn() {
    const free = this.freeColumns.pop();
    if (free !== undefined) return free;
    const hwm = Atomics.load(this.ctl, K_COLUMNS_HWM);
    if ((hwm >> 10) >= this.colPages.length) {
      if (this.colPages.length >= MAX_COLUMN_PAGES) return -1;
      this.d.columns.grow((this.colPages.length + 1) * PAGE_COLUMN_BYTES);
      this.mapPages();
    }
    Atomics.store(this.ctl, K_COLUMNS_HWM, hwm + 1);
    return hwm;
  }

  allocSection() {
    let s = this.freeSections.pop();
    if (s === undefined) {
      const hwm = Atomics.load(this.ctl, K_SECTIONS_HWM);
      if ((hwm >> 10) >= this.secPages.length) {
        if (this.secPages.length >= MAX_SECTION_PAGES) return -1;
        this.d.sections.grow((this.secPages.length + 1) * PAGE_SECTION_BYTES);
        this.mapPages();
      }
      Atomics.store(this.ctl, K_SECTIONS_HWM, hwm + 1);
      s = hwm;
    }
    this.sectionsUsed++;
    return s;
  }

  /** Fixed views over every grown page (layout.mjs: length-tracking views are slow). */
  mapPages() {
    const cols = this.d.columns.byteLength / PAGE_COLUMN_BYTES;
    for (let p = this.colPages.length; p < cols; p++) this.colPages.push(new Int32Array(this.d.columns, p * PAGE_COLUMN_BYTES, PAGE_COLUMN_BYTES / 4));
    const secs = this.d.sections.byteLength / PAGE_SECTION_BYTES;
    for (let p = this.secPages.length; p < secs; p++) this.secPages.push(new Uint16Array(this.d.sections, p * PAGE_SECTION_BYTES, PAGE_SECTIONS * SECTION_BLOCKS));
  }

  // -- dimensions -----------------------------------------------------------------------------------------------------

  readDims() {
    const n = Atomics.load(this.ctl, K_DIMS);
    const decoder = new TextDecoder();
    for (let d = 0; d < n; d++) {
      const base = d * DIM_INTS;
      const len = this.dimTable[base + 2];
      this.dims.set(decoder.decode(this.dimBytes.slice((base + 3) * 4, (base + 3) * 4 + len)), d);
    }
  }

  /** The dimension's index, registering it on first sight; -1 when the table is full or the name too long. */
  dimOf(dim, minY, height) {
    const known = this.dims.get(dim);
    if (known !== undefined) return known;
    const bytes = utf8.encode(dim);
    const d = Atomics.load(this.ctl, K_DIMS);
    if (bytes.length > DIM_NAME_BYTES || d >= MAX_DIMS) return -1;
    const base = d * DIM_INTS;
    this.dimTable[base] = minY;
    this.dimTable[base + 1] = height;
    this.dimTable[base + 2] = bytes.length;
    this.dimBytes.set(bytes, (base + 3) * 4);
    Atomics.store(this.ctl, K_DIMS, d + 1);
    this.dims.set(dim, d);
    return d;
  }
}
