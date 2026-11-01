// The entity snapshot (docs/37 §2.4): one row per entity any online bot knows, written by the main thread once per
// dispatcher tick into SharedArrayBuffers, read by the reader workers (aim lead, hitbox raycasts) without a message.
//
// Plain JS so a worker imports it with no loader (like pathworkers/worker.mjs); entities.d.mts types it for the
// main thread. This file holds both sides of the memory protocol, so it lives in one place:
//
//  - Two row buffers (double-buffered). The writer fills the one that is neither published nor held, then publishes
//    it with one Atomics.store. A reader that Atomics.loads the published index sees complete rows.
//  - Holds. A reader (each worker, and the main thread for the inline fallback) stores the buffer it reads into its
//    own control slot before reading, then checks the buffer is still the published one (else it retries). The
//    writer never writes a buffer someone holds: when both are taken (a reader still on the previous one), it skips
//    this tick's publish, and readers keep the last one. With Atomics' sequential consistency this cannot tear: a
//    reader's hold is stored before its check, and the writer's hold check comes after its publish.
//  - Rows are sorted by entity id, so get(id) is a binary search with no index to share.
//
// Layout of a row buffer (Float64): a header (epoch, tick, count, writtenAt), then `capacity` rows of STRIDE values.

/** The columns of a row. */
export const COL = Object.freeze({ ID: 0, TYPE: 1, KIND: 2, X: 3, Y: 4, Z: 5, VX: 6, VY: 7, VZ: 8, WIDTH: 9, HEIGHT: 10, TEAM: 11 });
export const STRIDE = 12;
/** Header slots, before the rows. */
export const HEADER = Object.freeze({ EPOCH: 0, TICK: 1, COUNT: 2, WRITTEN_AT: 3 });
export const HEADER_LENGTH = 4;
export const BUFFERS = 2;

/**
 * mineflayer's `entity.type` strings, as a code (the index). Unknown types are 0. `player` covers the bots: they are
 * players to every other bot.
 */
export const KINDS = Object.freeze(['other', 'player', 'hostile', 'passive', 'animal', 'ambient', 'water_creature', 'mob', 'living', 'projectile', 'object', 'orb', 'global']);
const KIND_CODES = new Map(KINDS.map((k, i) => [k, i]));

export function kindCode(type) {
  return KIND_CODES.get(type) ?? 0;
}

/**
 * The shared memory of a snapshot: `readers` hold slots (one per worker slot, plus one for the main thread).
 * The returned handles are structured-cloneable (SharedArrayBuffers are shared, not copied).
 */
export function createEntityBuffers(capacity, readers) {
  const bytes = (HEADER_LENGTH + capacity * STRIDE) * 8;
  const buffers = [];
  for (let b = 0; b < BUFFERS; b++) buffers.push(new SharedArrayBuffer(bytes));
  return { control: new SharedArrayBuffer((1 + readers) * 4), buffers, capacity, readers };
}

/**
 * The writer's side: a buffer it may fill now (neither published nor held by a reader), or -1 when every other
 * buffer is held (skip this publish).
 */
export function freeBuffer(handles) {
  const ctrl = new Int32Array(handles.control);
  const published = Atomics.load(ctrl, 0) - 1;
  for (let b = 0; b < handles.buffers.length; b++) {
    if (b === published) continue;
    let held = false;
    for (let r = 0; r < handles.readers; r++) {
      if (Atomics.load(ctrl, 1 + r) === b + 1) {
        held = true;
        break;
      }
    }
    if (!held) return b;
  }
  return -1;
}

/** Publish a filled buffer: from now on every new reader takes it. */
export function publishBuffer(handles, b) {
  Atomics.store(new Int32Array(handles.control), 0, b + 1);
}

/** Clear a dead reader's hold (a worker that died inside a batch never unpins), so the writer is not blocked. */
export function releaseReader(handles, readerIndex) {
  Atomics.store(new Int32Array(handles.control), 1 + readerIndex, 0);
}

/**
 * A reader over the snapshot, usable in any thread. `readerIndex` is its hold slot (a worker's slot index; the
 * main thread's is the last). pin() takes the published buffer for a batch, unpin() lets it go: between the two,
 * every read sees the same snapshot. Outside a pin the reader is empty (the buffer it had may be rewritten).
 */
export function openEntities(handles, readerIndex) {
  const ctrl = new Int32Array(handles.control);
  const views = handles.buffers.map((sab) => new Float64Array(sab));
  const slot = 1 + readerIndex;
  let data = null;

  function row(i) {
    const o = HEADER_LENGTH + i * STRIDE;
    return {
      id: data[o + COL.ID],
      type: data[o + COL.TYPE],
      kind: data[o + COL.KIND],
      x: data[o + COL.X],
      y: data[o + COL.Y],
      z: data[o + COL.Z],
      vx: data[o + COL.VX],
      vy: data[o + COL.VY],
      vz: data[o + COL.VZ],
      width: data[o + COL.WIDTH],
      height: data[o + COL.HEIGHT],
      team: data[o + COL.TEAM],
    };
  }

  const reader = {
    pin() {
      for (;;) {
        const p = Atomics.load(ctrl, 0);
        if (p === 0) {
          Atomics.store(ctrl, slot, 0);
          data = null;
          return;
        }
        Atomics.store(ctrl, slot, p);
        if (Atomics.load(ctrl, 0) === p) {
          data = views[p - 1];
          return;
        }
      }
    },
    unpin() {
      data = null;
      Atomics.store(ctrl, slot, 0);
    },
    get count() {
      return data ? data[HEADER.COUNT] : 0;
    },
    get tick() {
      return data ? data[HEADER.TICK] : -1;
    },
    get epoch() {
      return data ? data[HEADER.EPOCH] : 0;
    },
    /** When the snapshot was written, in ms since the Unix epoch (performance.timeOrigin + now()). */
    get writtenAt() {
      return data ? data[HEADER.WRITTEN_AT] : 0;
    },
    /** The raw rows, for hot loops: data[HEADER_LENGTH + i * STRIDE + COL.X]. Null before the first snapshot. */
    get data() {
      return data;
    },
    get(id) {
      if (!data) return null;
      let lo = 0;
      let hi = data[HEADER.COUNT] - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = data[HEADER_LENGTH + mid * STRIDE + COL.ID];
        if (v === id) return row(mid);
        if (v < id) lo = mid + 1;
        else hi = mid - 1;
      }
      return null;
    },
    /** Every row in id order; `fn` returning false stops the walk. Each row is a new object. */
    each(fn) {
      if (!data) return;
      const n = data[HEADER.COUNT];
      for (let i = 0; i < n; i++) if (fn(row(i)) === false) return;
    },
  };
  return reader;
}
