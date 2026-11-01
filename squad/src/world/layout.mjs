// The shared world's memory layout (docs/37 §2.1): every number the reader (reader.mjs, any thread) and the writer
// (store.mjs, the writer thread) must agree on, and the allocation of the buffers. Plain JS so a worker needs no
// loader (as script/typecheck-worker.mjs).
//
// Five SharedArrayBuffers, allocated once by the main thread (SharedWorld) and shared by reference with every thread:
//   control   Int32: the epoch, the change counter, the high-water marks, then one epoch slot per reader.
//   index     Int32 × 4 per entry, open addressing: [tag, chunkX, chunkZ, column slot]. tag = dimension + 1, 0 = empty
//             (ends a probe), -1 = tombstone. The writer fills the entry, then stores the tag with Atomics.store.
//   columns   Int32 × COL_INTS per column slot: [state, tag, x, z, minY, sections, version, -, refs…]. Growable.
//   sections  Uint16 × 4096 per section, the block state ids, index (y << 8) | (z << 4) | x. Growable.
//   dims      Int32 × DIM_INTS per dimension: [minY, height, name bytes, name (UTF-8)…], count in control[K_DIMS].
// A section ref in a column is 0 (all air: nothing stored), -stateId (the whole section is that one state: nothing
// stored either, e.g. an ocean's water) or 1 + the section's index.
//
// The growable buffers reserve their maximum address space and commit pages as the writer grows them. A reader never
// reads them through a length-tracking view (15-20 times slower to read in V8 24, measured): it builds a fixed view
// per page, the first time a ref points into it. Growth happens before the writer publishes anything in the new page
// (Atomics.store), so a reader that found the ref sees the grown buffer: no message announces a page.

export const LAYOUT_VERSION = 1;

/** Block state ids per section (16 × 16 × 16). */
export const SECTION_BLOCKS = 4096;
/** Sections per page: 1 024 × 8 KB = 8 MB, the step the sections buffer grows by. */
export const PAGE_SECTIONS = 1024;
export const PAGE_SECTION_BYTES = PAGE_SECTIONS * SECTION_BLOCKS * 2;
/** 512 pages: 4 GB of address space reserved (committed only as it grows), 524 288 sections. */
export const MAX_SECTION_PAGES = 512;

/** Column slot: an 8-int header, then one section ref per section. */
export const COL_REFS = 8;
/** At most 32 sections: 512 blocks tall (vanilla: 384 in the overworld, 256 in the nether and the end). */
export const MAX_COLUMN_SECTIONS = 32;
export const COL_INTS = COL_REFS + MAX_COLUMN_SECTIONS;
export const PAGE_COLUMNS = 1024;
export const PAGE_COLUMN_BYTES = PAGE_COLUMNS * COL_INTS * 4;
/** 64 pages: 65 536 columns, live and cached together (48 bots far apart hold ~15 000). */
export const MAX_COLUMN_PAGES = 64;
export const MAX_COLUMNS = PAGE_COLUMNS * MAX_COLUMN_PAGES;

// Column header fields.
export const C_STATE = 0;
export const C_TAG = 1;
export const C_X = 2;
export const C_Z = 3;
export const C_MINY = 4;
export const C_SECTIONS = 5;
export const C_VERSION = 6;

// Column states. Readers see only LIVE columns; CACHED ones are held by no bot, so they may be stale.
export const FREE = 0;
export const LIVE = 1;
export const CACHED = 2;

/** Index entries: twice the maximum number of columns, so probes stay short with tombstones. A power of two. */
export const INDEX_CAPACITY = MAX_COLUMNS * 2;
export const TOMBSTONE = -1;

// Control fields.
/** The global epoch (≥ 1). Only the writer moves it, after it retires memory. */
export const K_EPOCH = 0;
/** Bumped after every batch that changed the store: a reader's cheap "has anything changed". */
export const K_VERSION = 1;
/** Sections and column slots ever handed out (a restarted writer retires them all, store.mjs reset()). */
export const K_SECTIONS_HWM = 2;
export const K_COLUMNS_HWM = 3;
/** Dimensions registered in the dims table. */
export const K_DIMS = 4;
/** First reader epoch slot: 0 = not reading, else the epoch the reader entered in. */
export const K_READERS = 16;

/** Dimensions: at most 32, each name at most 64 bytes of UTF-8. */
export const MAX_DIMS = 32;
export const DIM_NAME_BYTES = 64;
export const DIM_INTS = 3 + DIM_NAME_BYTES / 4;

/** The index entry where a probe for this key starts. `tag` is the dimension + 1. */
export function slotOf(tag, cx, cz, mask) {
  let h = Math.imul(cx, 0x9e3779b1) ^ Math.imul(cz, 0x85ebca77) ^ Math.imul(tag, 0xc2b2ae3d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h & mask;
}

/** True when epoch `e` (a reader's) is later than `r` (a retirement's). Epochs are Int32 and wrap, skipping 0. */
export function after(e, r) {
  return ((e - r) | 0) > 0;
}

/**
 * The buffers of an empty store. `tables` are the per-state tables (tables.mjs), built once and shared read-only.
 * The descriptor is structured-cloneable: the SharedArrayBuffers cross by reference.
 */
export function allocateWorld({ version, maxReaders, tables, decoder }) {
  if (!Number.isInteger(maxReaders) || maxReaders < 1) throw new Error(`world: maxReaders must be an integer ≥ 1, got ${maxReaders}`);
  const control = new SharedArrayBuffer((K_READERS + maxReaders) * 4);
  new Int32Array(control)[K_EPOCH] = 1;
  return {
    layout: LAYOUT_VERSION,
    version,
    maxReaders,
    control,
    index: new SharedArrayBuffer(INDEX_CAPACITY * 16),
    columns: new SharedArrayBuffer(0, { maxByteLength: MAX_COLUMN_PAGES * PAGE_COLUMN_BYTES }),
    sections: new SharedArrayBuffer(0, { maxByteLength: MAX_SECTION_PAGES * PAGE_SECTION_BYTES }),
    dims: new SharedArrayBuffer(MAX_DIMS * DIM_INTS * 4),
    tables,
    decoder,
    reader: -1,
    readerToken: 0,
  };
}
