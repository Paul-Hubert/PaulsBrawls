// The entity snapshot's writer (docs/37 §2.4), main thread. Once per dispatcher tick it merges what every online bot
// knows (`bot.entities`, plus the bot itself) into one row per entity id: the ids are the server's, so N bots seeing
// one zombie give one row. The first bot that knows an entity gives its row (the pool's order is stable, so the same
// bot keeps giving it, and its positions come from one packet stream).
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

/** What the writer reads of a bot. */
export interface EntitySourceBot {
  entity?: EntityLike | null;
  entities?: Record<string, EntityLike | undefined> | null;
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
  /** The write that last saw it (to dedupe within a write and drop the unseen). */
  seen: number;
}

export interface SnapshotStats {
  /** Rows in the last published snapshot. */
  count: number;
  published: number;
  /** Writes skipped because a reader still held the other buffer. */
  skipped: number;
  /** Entities left out because the snapshot was full. */
  overflow: number;
}

export class EntitySnapshot {
  readonly handles: EntityHandles;
  private readonly views: Float64Array[];
  private readonly tracks = new Map<number, Track>();
  private readonly order: Track[] = [];
  private writes = 0;
  private epoch = 0;
  private readonly counters: SnapshotStats = { count: 0, published: 0, skipped: 0, overflow: 0 };

  constructor(opts: { capacity?: number; readers: number }) {
    this.handles = createEntityBuffers(opts.capacity ?? DEFAULT_ENTITY_CAPACITY, opts.readers);
    this.views = this.handles.buffers.map((b) => new Float64Array(b));
  }

  /** Merge the source's entities and publish them as `tick`'s snapshot. False when skipped (both buffers held). */
  write(tick: number, source: EntitySource): boolean {
    const w = ++this.writes;
    const order = this.order;
    order.length = 0;
    for (const bot of source.bots()) {
      if (!bot) continue;
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

    const b = freeBuffer(this.handles);
    if (b < 0) {
      this.counters.skipped++;
      return false;
    }
    order.sort((a, c) => a.ent.id - c.ent.id);
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
    const s = { ...this.counters };
    if (reset) this.counters.published = this.counters.skipped = this.counters.overflow = 0;
    return s;
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
      const gap = tick - t.tick;
      if (gap > 0 && gap <= MAX_VELOCITY_GAP) {
        t.vx = (p.x - t.x) / gap;
        t.vy = (p.y - t.y) / gap;
        t.vz = (p.z - t.z) / gap;
      } else if (gap !== 0) {
        t.vx = t.vy = t.vz = 0;
      }
      t.ent = e;
      t.x = p.x;
      t.y = p.y;
      t.z = p.z;
      t.tick = tick;
      t.seen = w;
    }
    this.order.push(t);
  }
}
