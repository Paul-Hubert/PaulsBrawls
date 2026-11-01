// Block searches over the shared world (docs/37 P6): mineflayer's `bot.findBlocks`, read from the one shared copy
// (reader.mjs) instead of a bot's own world, so it can run on a reader worker (jobs/handlers/find-blocks.mjs) and leave
// the main thread. Plain JS so a worker imports it with no loader; types in find-blocks.d.mts.
//
// The answer is mineflayer's, position for position and in the same order (tests/find-blocks.test.ts checks it on real
// chunk data). That means its walk, quirks included (mineflayer/lib/plugins/blocks.js, findBlocks):
//   • sections in prismarine-world's OctahedronIterator order around the point's section, out to
//     ceil((maxDistance + 8) / 16) sections, the same section counted once;
//   • inside a section, blocks in x, then y, then z order; a block counts when it matches and its distance from the
//     floored point (block corner to block corner) is ≤ maxDistance;
//   • it stops after the first section of the layer after the one in which it reached `count` hits, then sorts the hits
//     by distance (stable: equal distances keep the walk's order) and keeps the first `count`.
// So "nearest first" is mineflayer's: whole layers of sections, not an exact nearest-k.
//
// What it does not do like mineflayer, because the store has no palettes (and needs none):
//   • a section is read as 4 096 Uint16 state ids against a match table (a byte per state id), not 4 096 blockAt calls
//     each building a prismarine Block;
//   • an all-air or one-state section (refs 0 and -state in the store: no block data) is decided once, from its state;
//   • a section entirely farther than maxDistance is not read (no block in it could count).
// mineflayer skips a section only when its palette has no match; a one-state section has no `palette` in
// prismarine-chunk 1.18+ (SingleValueContainer), so mineflayer reads every block of every all-air section in range.
//
// Unknown columns (never received, unloaded, or CACHED: no bot holds them, so they may be stale) have no blocks, as an
// unloaded column has none for mineflayer. Matching is by data only (block ids, block names or state ids): a matcher
// function cannot cross to a worker, so `bot.findBlocks` with one stays on the bot (and R76's lesson, a matcher run on
// palette blocks whose position is null, does not arise).
//
// A search is resumable: stepSearch() walks sections until its budget is spent and returns false; the job handler
// answers { continue: search } and the next tick goes on from there (the world may have changed meanwhile, as a bot's
// own world changes between two of its ticks). Every read must sit inside the reader's enter()/leave(); a search keeps
// no view of shared memory between steps, only coordinates.

import { COL_REFS, C_MINY, C_SECTIONS, C_STATE, LIVE, PAGE_SECTIONS } from './layout.mjs';

/** mineflayer's defaults: `options.maxDistance || 16`, `options.count || 1`. */
export const DEFAULT_MAX_DISTANCE = 16;
export const DEFAULT_COUNT = 1;
/** A step keeps going while at least this much of its budget is left (one section costs a few µs). */
export const MIN_STEP_MS = 0.05;

const SECTION_BLOCKS = 4096;
/** Match tables cover every Uint16, so a state id never reads past the end (and no bounds check is needed). */
const MATCH_SIZE = 65536;

/**
 * prismarine-world's OctahedronIterator (src/iterators.js), copied with integers instead of a Vec3 per point: the same
 * points in the same order, including its quirks (a point on an axis comes more than once; the last call before the
 * end yields one point of the layer past `maxDistance`).
 */
export class Octahedron {
  constructor(sx, sy, sz, maxDistance) {
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.maxDistance = maxDistance;
    this.apothem = 1;
    this.x = -1;
    this.y = -1;
    this.z = -1;
    this.L = this.apothem;
    this.R = this.L + 1;
    this.nx = 0;
    this.ny = 0;
    this.nz = 0;
  }

  /** The next point into nx, ny, nz; false at the end. */
  next() {
    if (this.apothem > this.maxDistance) return false;
    this.R -= 1;
    if (this.R < 0) {
      this.L -= 1;
      if (this.L < 0) {
        this.z += 2;
        if (this.z > 1) {
          this.y += 2;
          if (this.y > 1) {
            this.x += 2;
            if (this.x > 1) {
              this.apothem += 1;
              this.x = -1;
            }
            this.y = -1;
          }
          this.z = -1;
        }
        this.L = this.apothem;
      }
      this.R = this.L;
    }
    const X = this.x * this.R;
    const Y = this.y * (this.apothem - this.L);
    const Z = this.z * (this.apothem - (Math.abs(X) + Math.abs(Y)));
    this.nx = this.sx + X;
    this.ny = this.sy + Y;
    this.nz = this.sz + Z;
    return true;
  }
}

/**
 * The match table of a query: a byte per state id (1 = matches), sized for any Uint16. `blocks` are block ids (the
 * registry's, as `bot.registry.blocksByName[name].id`), `names` block names, `states` state ids; any mix.
 */
export function matchTable(states, query) {
  const t = new Uint8Array(MATCH_SIZE);
  const blocks = query.blocks?.length ? new Set(query.blocks) : null;
  const names = query.names?.length ? new Set(query.names.map((n) => String(n).replace(/^minecraft:/, ''))) : null;
  if (blocks || names) {
    for (let s = 0; s < states.count; s++) {
      if ((blocks && blocks.has(states.blockId(s))) || (names && names.has(states.name(s)))) t[s] = 1;
    }
  }
  for (const s of query.states ?? []) if (Number.isInteger(s) && s >= 0 && s < MATCH_SIZE) t[s] = 1;
  return t;
}

/** The cache key of a query's match table. */
export function matchKey(query) {
  const part = (a) => (a?.length ? [...a].map(String).sort().join(',') : '');
  return `${part(query.blocks)}|${part(query.names)}|${part(query.states)}`;
}

/**
 * A search, ready for stepSearch(). `match` is matchTable(reader.states, input) (a handler caches it per query).
 * Coordinates are floored, as mineflayer floors the point. `visible(chunkX, chunkZ)`, on the main thread only (a
 * function cannot cross to a worker), limits the search to one bot's columns (P5: a bot's own findBlocks over the
 * store sees the columns that bot holds, as mineflayer's sees its own world only).
 */
export function startSearch(reader, input, match, visible = null) {
  const px = Math.floor(input.x);
  const py = Math.floor(input.y);
  const pz = Math.floor(input.z);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
    throw new Error(`findBlocks: the point must be finite x, y, z, got ${input.x}, ${input.y}, ${input.z}`);
  }
  const maxDistance = Number(input.maxDistance) || DEFAULT_MAX_DISTANCE;
  const count = Number(input.count) || DEFAULT_COUNT;
  const sx = Math.floor(px / 16);
  const sy = Math.floor(py / 16);
  const sz = Math.floor(pz / 16);
  return {
    dim: String(input.dim),
    px,
    py,
    pz,
    maxDistance,
    count,
    match,
    it: new Octahedron(sx, sy, sz, Math.ceil((maxDistance + 8) / 16)),
    // mineflayer's loop state: the section to visit, and the layer the last one was in.
    next: true,
    nx: sx,
    ny: sy,
    nz: sz,
    startedLayer: 0,
    visited: new Set(),
    // Hits, in walk order: coordinates and their distance (the sort key).
    xs: [],
    ys: [],
    zs: [],
    ds: [],
    stats: { sections: 0, scanned: 0, unknown: 0, slices: 0 },
    visible,
    done: false,
  };
}

/**
 * Walk sections until the search ends (true) or `budgetLeftMs()` falls under MIN_STEP_MS (false: call again, inside a
 * new bracket). At least one section is walked per call, so a search always moves on. Inside reader.enter()/leave().
 */
export function stepSearch(reader, s, budgetLeftMs = () => Infinity) {
  if (s.done) return true;
  // The column lookups below go around stateIdIn (which checks it), so check the bracket here.
  if (!reader.inside) throw new Error('findBlocks: read outside enter()/leave()');
  s.stats.slices++;
  const d = reader.dimIndex(s.dim);
  const tag = d + 1;
  const it = s.it;
  let first = true;
  while (s.next) {
    if (!first && budgetLeftMs() < MIN_STEP_MS) return false;
    first = false;
    if (d >= 0) visit(reader, s, tag, s.nx, s.ny, s.nz);
    else s.stats.unknown++;
    // mineflayer: "If we started a layer, we have to finish it otherwise we might miss closer blocks".
    if (s.startedLayer !== it.apothem && s.xs.length >= s.count) break;
    s.startedLayer = it.apothem;
    s.next = it.next();
    if (s.next) {
      s.nx = it.nx;
      s.ny = it.ny;
      s.nz = it.nz;
    }
  }
  s.next = false;
  s.done = true;
  return true;
}

/** One section of the walk (mineflayer's loop body). */
function visit(reader, s, tag, cx, cy, cz) {
  if ((s.visible !== null && !s.visible(cx, cz)) || !reader.find(tag, cx, cz)) {
    s.stats.unknown++;
    return;
  }
  // reader.find() leaves the column in lastView/lastBase (reader.mjs internals, read the way stateIdIn reads them).
  const view = reader.lastView;
  const base = reader.lastBase;
  if (Atomics.load(view, base + C_STATE) !== LIVE) {
    s.stats.unknown++;
    return;
  }
  const minY = view[base + C_MINY];
  const sy = cy - (minY >> 4);
  if (sy < 0 || sy >= view[base + C_SECTIONS]) return;
  const key = ((cx - s.it.sx + 512) * 1024 + (cy - s.it.sy + 512)) * 1024 + (cz - s.it.sz + 512);
  if (s.visited.has(key)) return;
  s.visited.add(key);
  s.stats.sections++;
  const bx = cx * 16;
  const by = sy * 16 + minY;
  const bz = cz * 16;
  // No block of a section entirely out of range can count: its nearest block is farther than maxDistance.
  const ex = s.px < bx ? bx - s.px : s.px > bx + 15 ? s.px - bx - 15 : 0;
  const ey = s.py < by ? by - s.py : s.py > by + 15 ? s.py - by - 15 : 0;
  const ez = s.pz < bz ? bz - s.pz : s.pz > bz + 15 ? s.pz - bz - 15 : 0;
  if (Math.sqrt(ex * ex + ey * ey + ez * ez) > s.maxDistance) return;
  const ref = Atomics.load(view, base + COL_REFS + sy);
  if (ref <= 0) {
    // All air (0) or one state everywhere (-state): the whole section matches or nothing does.
    if (s.match[ref === 0 ? 0 : -ref] === 1) {
      for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) hit(s, bx + x, by + y, bz + z);
    }
    return;
  }
  const sec = ref - 1;
  const page = reader.secPages[sec >> 10] ?? reader.sectionPage(sec >> 10);
  if (page === null) return;
  s.stats.scanned++;
  const off = (sec & (PAGE_SECTIONS - 1)) << 12;
  const match = s.match;
  // The store's order is y, z, x (index (y << 8) | (z << 4) | x); mineflayer's is x, y, z. Collect the hits as
  // x, y, z keys, then sort them (few: a section rarely has more than a handful of what is searched for).
  let keys = null;
  let k = 0;
  for (let i = 0; i < SECTION_BLOCKS; i++) {
    if (match[page[off + i]] === 1) {
      keys ??= scratch;
      keys[k++] = ((i & 15) << 8) | ((i >>> 8) << 4) | ((i >>> 4) & 15);
    }
  }
  if (k === 0) return;
  const sorted = keys.subarray(0, k);
  if (k > 1) sorted.sort();
  for (let j = 0; j < k; j++) {
    const key = sorted[j];
    hit(s, bx + (key >> 8), by + ((key >> 4) & 15), bz + (key & 15));
  }
}

const scratch = new Int32Array(SECTION_BLOCKS);

function hit(s, x, y, z) {
  const dx = s.px - x;
  const dy = s.py - y;
  const dz = s.pz - z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist <= s.maxDistance) {
    s.xs.push(x);
    s.ys.push(y);
    s.zs.push(z);
    s.ds.push(dist);
  }
}

/**
 * The answer of a finished search: `positions` [x0, y0, z0, x1, …], nearest first (mineflayer's stable sort by
 * distance), at most `count`; and what the walk did.
 */
export function answerOf(s) {
  const n = s.xs.length;
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const ds = s.ds;
  order.sort((a, b) => ds[a] - ds[b] || a - b);
  const m = Math.min(n, s.count);
  const positions = new Array(m * 3);
  for (let j = 0; j < m; j++) {
    const i = order[j];
    positions[j * 3] = s.xs[i];
    positions[j * 3 + 1] = s.ys[i];
    positions[j * 3 + 2] = s.zs[i];
  }
  return { positions, hits: n, ...s.stats };
}

/** A whole search at once, inside the caller's enter()/leave() (tests, benchmarks). */
export function findBlocksIn(reader, input, match = matchTable(reader.states, input), visible = null) {
  const s = startSearch(reader, input, match, visible);
  stepSearch(reader, s);
  return answerOf(s);
}
