// The entity snapshot's writer (docs/37 §2.4), main thread. On the dispatcher's ticks that need it (pool.ts: a job of
// a type that reads entities is about to be dispatched) it merges what every online bot knows (`bot.entities`, plus
// the bot itself) into one row per entity id: the ids are the server's, so N bots seeing one zombie give one row. The
// first bot that knows an entity gives its row (the pool's order is stable, so the same bot keeps giving it, and its
// positions come from one packet stream).
//
// Incremental (docs/37 §14). Walking every bot's `entities` at each write was the snapshot's whole cost: in a 20 v 20
// fight, 40 bots × ~60 entities, 2 400 dictionary entries a tick, 3.5 % of the main thread's busy time, more than the
// inline aim it replaced. So the writer follows each bot instead: it walks a bot's entities once, when it first sees
// the bot, then keeps up with mineflayer's `entitySpawn`, `entityGone` and `end`, and a write walks only the merged
// entities, one per id (60–120 in a fight). Before an entity's row is written, the bot that gives it is checked to
// still hold it (`bot.entities[id]` is that object, not marked invalid), so one that mineflayer dropped without an
// event (a login empties `bot.entities`) leaves at the next write; and each followed bot's entities are walked again
// once every RESCAN_WRITES writes (a few bots a write, in turn), for one mineflayer made without a spawn event (a packet
// about an id it had not seen). A
// bot that emits no events (a test fake) is walked at every write, as before. Both give the same rows.
//
// Velocity is the move between the last two snapshots the entity was in, per tick: mineflayer's own `velocity` is
// only set by the few packets that carry one. An entity seen for the first time, or not seen for more than
// MAX_VELOCITY_GAP ticks, has velocity 0. The rows are sorted by id for the readers' binary search (entities.mjs).
//
// The source is injected (the pool's online bots and a teamOf function), so tests drive it with fakes.

import { performance } from 'node:perf_hooks';

import {
  COL,
  HEADER,
  HEADER_LENGTH,
  STRIDE,
  createEntityBuffers,
  freeBuffer,
  kindCode,
  publishBuffer,
  type EntityHandles,
} from './entities.mjs';

/** What the writer reads of a mineflayer entity. */
export interface EntityLike {
  id: number;
  type?: string;
  entityType?: number;
  username?: string;
  position?: { x: number; y: number; z: number } | null;
  width?: number;
  height?: number;
  isValid?: boolean;
}

/** What the writer reads of a bot. With `on` (a mineflayer bot) it is followed; without, walked at every write. */
export interface EntitySourceBot {
  entity?: EntityLike | null;
  entities?: Record<string, EntityLike | undefined> | null;
  on?(event: string, fn: (...args: never[]) => void): unknown;
  removeListener?(event: string, fn: (...args: never[]) => void): unknown;
}

export interface EntitySource {
  /** The online bots whose entities are merged. */
  bots(): Iterable<EntitySourceBot | null | undefined>;
  /** The team (owner group) of a player's username, 0 = none. Called once per player row per snapshot. */
  teamOf(username: string): number;
}

/** A row's velocity is 0 past this many ticks between two sightings. */
export const MAX_VELOCITY_GAP = 4;
export const DEFAULT_ENTITY_CAPACITY = 4096;
/** Each followed bot's entities are walked again once in this many writes (see the header). */
export const RESCAN_WRITES = 100;

interface Track {
  ent: EntityLike;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** The tick of the last snapshot that held it. */
  tick: number;
  /** The write that last saw it (to dedupe within a write and drop the unseen); 0: not written yet. */
  seen: number;
}

/** A bot the writer follows: its listeners, its rank (the order it came in), the ids it knows. */
interface Follow {
  bot: EntitySourceBot;
  rank: number;
  seen: number;
  ids: Set<number>;
  onSpawn: (e: EntityLike) => void;
  onGone: (e: EntityLike) => void;
  onEnd: () => void;
}

/** One entity id as the followed bots know it: its track, and who knows it (by rank, each with its own object). */
interface Known extends Track {
  id: number;
  by: Array<{ f: Follow; ent: EntityLike }>;
}

export interface SnapshotStats {
  /** Rows in the last published snapshot. */
  count: number;
  published: number;
  /** Writes skipped because a reader still held the other buffer. */
  skipped: number;
  /** Entities left out because the snapshot was full. */
  overflow: number;
  /** Main-thread time spent writing (the merge and the rows), ms, since the last reset. */
  writeMs: number;
  /** Bots followed (incremental). */
  followed: number;
}

export class EntitySnapshot {
  readonly handles: EntityHandles;
  private readonly views: Float64Array[];
  private readonly incremental: boolean;
  private readonly order: Track[] = [];
  private writes = 0;
  private epoch = 0;
  private readonly counters = { count: 0, published: 0, skipped: 0, overflow: 0, writeMs: 0 };
  /** Walked bots: the tracks by id. */
  private readonly tracks = new Map<number, Track>();
  /** Followed bots. */
  private readonly followed = new Map<EntitySourceBot, Follow>();
  private readonly known = new Map<number, Known>();
  /** `known` by id, sorted again when an id came or went. */
  private sorted: Known[] = [];
  private sortedDirty = false;
  private ranks = 0;
  /** The followed bots in order, and the next one to walk again. */
  private followList: Follow[] = [];
  private rescanAt = 0;

  /** @param opts.incremental follow the bots that emit events (default); false walks every bot at every write. */
  constructor(opts: { capacity?: number; readers: number; incremental?: boolean }) {
    this.handles = createEntityBuffers(opts.capacity ?? DEFAULT_ENTITY_CAPACITY, opts.readers);
    this.views = this.handles.buffers.map((b) => new Float64Array(b));
    this.incremental = opts.incremental ?? true;
  }

  /** Merge the source's entities and publish them as `tick`'s snapshot. False when skipped (both buffers held). */
  write(tick: number, source: EntitySource): boolean {
    const t0 = performance.now();
    try {
      return this.writeNow(tick, source);
    } finally {
      this.counters.writeMs += performance.now() - t0;
    }
  }

  private writeNow(tick: number, source: EntitySource): boolean {
    const w = ++this.writes;
    const order = this.order;
    order.length = 0;
    const bots: EntitySourceBot[] = [];
    let follow = this.incremental;
    for (const bot of source.bots()) {
      if (!bot) continue;
      bots.push(bot);
      if (typeof bot.on !== 'function') follow = false;
    }
    if (follow) this.mergeFollowed(bots, w, tick);
    else this.mergeWalked(bots, w, tick);

    const b = freeBuffer(this.handles);
    if (b < 0) {
      this.counters.skipped++;
      return false;
    }
    if (!follow) order.sort((a, c) => a.ent.id - c.ent.id); // the followed ones come in id order
    const cap = this.handles.capacity;
    const n = Math.min(order.length, cap);
    this.counters.overflow += order.length - n;
    const data = this.views[b]!;
    for (let i = 0; i < n; i++) {
      const t = order[i]!;
      const e = t.ent;
      const o = HEADER_LENGTH + i * STRIDE;
      data[o + COL.ID] = e.id;
      data[o + COL.TYPE] = typeof e.entityType === 'number' ? e.entityType : -1;
      data[o + COL.KIND] = kindCode(e.type);
      data[o + COL.X] = t.x;
      data[o + COL.Y] = t.y;
      data[o + COL.Z] = t.z;
      data[o + COL.VX] = t.vx;
      data[o + COL.VY] = t.vy;
      data[o + COL.VZ] = t.vz;
      data[o + COL.WIDTH] = typeof e.width === 'number' ? e.width : 0;
      data[o + COL.HEIGHT] = typeof e.height === 'number' ? e.height : 0;
      data[o + COL.TEAM] = e.type === 'player' && e.username ? source.teamOf(e.username) || 0 : 0;
    }
    data[HEADER.EPOCH] = ++this.epoch;
    data[HEADER.TICK] = tick;
    data[HEADER.COUNT] = n;
    data[HEADER.WRITTEN_AT] = performance.timeOrigin + performance.now();
    publishBuffer(this.handles, b);
    this.counters.published++;
    this.counters.count = n;
    return true;
  }

  /** The epoch of the last published snapshot (0: none yet). */
  get currentEpoch(): number {
    return this.epoch;
  }

  stats(reset = false): SnapshotStats {
    const s = { ...this.counters, writeMs: Math.round(this.counters.writeMs * 1000) / 1000, followed: this.followed.size };
    if (reset) this.counters.published = this.counters.skipped = this.counters.overflow = this.counters.writeMs = 0;
    return s;
  }

  /** Stop following the bots (their listeners are removed). */
  close(): void {
    for (const f of [...this.followed.values()]) this.unfollow(f);
  }

  // -- walked: every bot at every write (bots that emit no events) --------------------------------------------------

  private mergeWalked(bots: EntitySourceBot[], w: number, tick: number): void {
    if (this.followed.size > 0) this.close();
    for (const bot of bots) {
      if (bot.entity) this.see(bot.entity, w, tick);
      const ents = bot.entities;
      if (!ents) continue;
      for (const k in ents) {
        const e = ents[k];
        if (e) this.see(e, w, tick);
      }
    }
    // Forget what no bot knows any more (its next sighting starts with velocity 0).
    for (const [id, t] of this.tracks) if (t.seen !== w) this.tracks.delete(id);
  }

  private see(e: EntityLike, w: number, tick: number): void {
    const p = e.position;
    if (!p || typeof e.id !== 'number' || e.isValid === false) return;
    let t = this.tracks.get(e.id);
    if (t && t.seen === w) return; // another bot already gave this entity
    if (!t) {
      t = { ent: e, x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, tick, seen: w };
      this.tracks.set(e.id, t);
    } else {
      move(t, p, tick);
      t.ent = e;
      t.seen = w;
    }
    this.order.push(t);
  }

  // -- followed: incremental ----------------------------------------------------------------------------------------

  private mergeFollowed(bots: EntitySourceBot[], w: number, tick: number): void {
    if (this.tracks.size > 0) this.tracks.clear();
    for (const bot of bots) (this.followed.get(bot) ?? this.follow(bot)).seen = w;
    for (const f of [...this.followed.values()]) if (f.seen !== w) this.unfollow(f);
    const list = this.followList;
    for (let i = Math.ceil(list.length / RESCAN_WRITES); i > 0 && list.length > 0; i--) {
      if (this.rescanAt >= list.length) this.rescanAt = 0;
      this.walk(list[this.rescanAt++]!);
    }
    if (this.sortedDirty) {
      this.sorted = [...this.known.values()].sort((a, c) => a.id - c.id);
      this.sortedDirty = false;
    }
    const order = this.order;
    for (const k of this.sorted) {
      const ent = this.giver(k);
      if (!ent) continue;
      const p = ent.position!;
      // Not in the last write: a gap (velocity 0 past MAX_VELOCITY_GAP), as for a walked bot. Never written: here now.
      if (k.seen === 0) {
        k.x = p.x;
        k.y = p.y;
        k.z = p.z;
        k.tick = tick;
      } else move(k, p, tick);
      k.ent = ent;
      k.seen = w;
      order.push(k);
    }
  }

  /** The first bot (by rank) that still holds the entity gives it; the ones that dropped it are forgotten. */
  private giver(k: Known): EntityLike | null {
    while (k.by.length > 0) {
      const { f, ent } = k.by[0]!;
      const bot = f.bot;
      if (ent.isValid !== false && ent.position && (bot.entities?.[ent.id] === ent || bot.entity === ent)) return ent;
      k.by.shift();
      f.ids.delete(k.id);
    }
    this.known.delete(k.id);
    this.sortedDirty = true;
    return null;
  }

  private follow(bot: EntitySourceBot): Follow {
    const f: Follow = {
      bot,
      rank: ++this.ranks,
      seen: 0,
      ids: new Set(),
      onSpawn: (e) => this.sight(f, e),
      onGone: (e) => this.unsight(f, e?.id),
      onEnd: () => this.unfollow(f),
    };
    this.followed.set(bot, f);
    this.followList.push(f);
    bot.on!('entitySpawn', f.onSpawn as never);
    bot.on!('entityGone', f.onGone as never);
    bot.on!('end', f.onEnd as never);
    this.walk(f);
    return f;
  }

  private unfollow(f: Follow): void {
    if (this.followed.get(f.bot) !== f) return;
    this.followed.delete(f.bot);
    this.followList = this.followList.filter((x) => x !== f);
    f.bot.removeListener?.('entitySpawn', f.onSpawn as never);
    f.bot.removeListener?.('entityGone', f.onGone as never);
    f.bot.removeListener?.('end', f.onEnd as never);
    for (const id of [...f.ids]) this.unsight(f, id);
  }

  /** What the bot knows now: itself and its entities (at first sight, then once every RESCAN_WRITES writes). */
  private walk(f: Follow): void {
    const bot = f.bot;
    if (bot.entity) this.sight(f, bot.entity);
    const ents = bot.entities;
    if (!ents) return;
    for (const k in ents) {
      const e = ents[k];
      if (e) this.sight(f, e);
    }
  }

  private sight(f: Follow, e: EntityLike): void {
    if (!e || typeof e.id !== 'number' || e.isValid === false) return;
    let k = this.known.get(e.id);
    if (!k) {
      k = { id: e.id, by: [], ent: e, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tick: 0, seen: 0 };
      this.known.set(e.id, k);
      this.sortedDirty = true;
    }
    // Its place among the bots that know it, by rank (a binary search: a rescan sights every entity again).
    const by = k.by;
    let lo = 0;
    let hi = by.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (by[mid]!.f.rank < f.rank) lo = mid + 1;
      else hi = mid;
    }
    if (lo < by.length && by[lo]!.f === f) by[lo]!.ent = e;
    else {
      by.splice(lo, 0, { f, ent: e });
      f.ids.add(e.id);
    }
  }

  private unsight(f: Follow, id: number | undefined): void {
    if (typeof id !== 'number') return;
    f.ids.delete(id);
    const k = this.known.get(id);
    if (!k) return;
    const i = k.by.findIndex((s) => s.f === f);
    if (i >= 0) k.by.splice(i, 1);
    if (k.by.length === 0) {
      // Known by no bot any more: its next sighting starts with velocity 0.
      this.known.delete(id);
      this.sortedDirty = true;
    }
  }
}

/** A sighting at `tick`: the velocity is the move since the last one, if that was at most MAX_VELOCITY_GAP ago. */
function move(t: Track, p: { x: number; y: number; z: number }, tick: number): void {
  const gap = tick - t.tick;
  if (gap > 0 && gap <= MAX_VELOCITY_GAP) {
    t.vx = (p.x - t.x) / gap;
    t.vy = (p.y - t.y) / gap;
    t.vz = (p.z - t.z) / gap;
  } else if (gap !== 0) {
    t.vx = t.vy = t.vz = 0;
  }
  t.x = p.x;
  t.y = p.y;
  t.z = p.z;
  t.tick = tick;
}
