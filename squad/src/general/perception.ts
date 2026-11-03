// What a General's army sees (docs/38 §4): every enemy any of its bots sees, merged by entity id (the same on every
// client), grouped in clusters that keep their id (X1, X2…) while they persist. Only what the bots perceive: an enemy
// is a player who is not of the army (another player, another player's bot), with what it visibly carries; never the
// roster's owners or kit tags of another army (fog of war). Pure, so the tests drive it with plain objects.

import type { Vec3Like } from '../types';

export interface Sighting {
  id: number;
  name: string;
  pos: Vec3Like;
  /** The item in its main hand, as the bots see it. */
  held: string | null;
  /** Its chestplate (armor material), as the bots see it. */
  armor: string | null;
}

export interface Cluster {
  id: string;
  members: Map<number, Sighting>;
  center: Vec3Like;
  /** Blocks per second, from the center's last few seconds; null until it has moved for a while. */
  velocity: { x: number; z: number } | null;
  firstSeen: number;
  lastSeen: number;
  /** contact-lost was announced (it has not been seen for LOST_MS). */
  lost: boolean;
}

/** Enemies within this many blocks of each other are one cluster (single link). */
export const LINK = 8;
/** A cluster nobody sees for this long is lost (an event), and forgotten after FORGET_MS. */
export const LOST_MS = 15_000;
export const FORGET_MS = 120_000;
/** The center's history used for the velocity. */
const TRACK_MS = 3_000;

export interface TrackUpdate {
  appeared: Cluster[];
  lost: Cluster[];
}

export class ClusterTracker {
  private readonly clusters = new Map<string, Cluster>();
  private readonly history = new Map<string, Array<{ t: number; x: number; z: number }>>();
  private next = 1;

  all(): Cluster[] {
    return [...this.clusters.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }

  get(id: string): Cluster | undefined {
    return this.clusters.get(id.toUpperCase());
  }

  /** The clusters seen in the last LOST_MS. */
  visible(now: number): Cluster[] {
    return this.all().filter((c) => now - c.lastSeen < LOST_MS);
  }

  update(now: number, sightings: Sighting[]): TrackUpdate {
    const groups = link(sightings);
    const taken = new Set<string>();
    const appeared: Cluster[] = [];
    for (const g of groups) {
      // The previous cluster sharing the most members keeps its id; else the nearest one within LINK of the group.
      let best: Cluster | undefined;
      let bestScore = 0;
      for (const c of this.clusters.values()) {
        if (taken.has(c.id)) continue;
        const shared = g.filter((s) => c.members.has(s.id)).length;
        if (shared > bestScore) {
          best = c;
          bestScore = shared;
        }
      }
      const center = centroid(g.map((s) => s.pos));
      if (!best) {
        let d = LINK;
        for (const c of this.clusters.values()) {
          if (taken.has(c.id)) continue;
          const dd = Math.hypot(c.center.x - center.x, c.center.z - center.z);
          if (dd <= d) {
            best = c;
            d = dd;
          }
        }
      }
      const reappeared = !!best && best.lost;
      const c: Cluster = best ?? { id: `X${this.next++}`, members: new Map(), center, velocity: null, firstSeen: now, lastSeen: now, lost: false };
      c.members = new Map(g.map((s) => [s.id, s]));
      c.center = center;
      c.lastSeen = now;
      c.lost = false;
      this.clusters.set(c.id, c);
      taken.add(c.id);
      this.track(c, now);
      if (!best || reappeared) appeared.push(c);
    }
    const lost: Cluster[] = [];
    for (const c of [...this.clusters.values()]) {
      if (taken.has(c.id)) continue;
      if (now - c.lastSeen >= FORGET_MS) {
        this.clusters.delete(c.id);
        this.history.delete(c.id);
      } else if (!c.lost && now - c.lastSeen >= LOST_MS) {
        c.lost = true;
        c.velocity = null;
        lost.push(c);
      }
    }
    return { appeared, lost };
  }

  /** An enemy the army saw die: it leaves its cluster at once. */
  remove(id: number): Sighting | undefined {
    for (const c of this.clusters.values()) {
      const s = c.members.get(id);
      if (s) {
        c.members.delete(id);
        return s;
      }
    }
    return undefined;
  }

  private track(c: Cluster, now: number): void {
    const h = this.history.get(c.id) ?? [];
    h.push({ t: now, x: c.center.x, z: c.center.z });
    while (h.length > 2 && now - h[0]!.t > TRACK_MS) h.shift();
    this.history.set(c.id, h);
    const first = h[0]!;
    const dt = (now - first.t) / 1000;
    c.velocity = dt >= 1 ? { x: (c.center.x - first.x) / dt, z: (c.center.z - first.z) / dt } : null;
  }
}

/** Single-link groups: two sightings within LINK blocks (horizontally) are in one group. */
function link(sightings: Sighting[]): Sighting[][] {
  const groups: Sighting[][] = [];
  const seen = new Set<number>();
  for (const s of sightings) {
    if (seen.has(s.id)) continue;
    const g: Sighting[] = [s];
    seen.add(s.id);
    for (let i = 0; i < g.length; i++) {
      for (const o of sightings) {
        if (seen.has(o.id)) continue;
        if (Math.hypot(o.pos.x - g[i]!.pos.x, o.pos.z - g[i]!.pos.z) <= LINK) {
          g.push(o);
          seen.add(o.id);
        }
      }
    }
    groups.push(g);
  }
  return groups;
}

export function centroid(ps: Vec3Like[]): Vec3Like {
  if (ps.length === 0) return { x: 0, y: 0, z: 0 };
  const s = ps.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: a.z + p.z }), { x: 0, y: 0, z: 0 });
  return { x: s.x / ps.length, y: s.y / ps.length, z: s.z / ps.length };
}

/** "bow 3, iron_sword 2" → shortened: the weapons by kind ("bow3 sword2"), the commonest armor material. */
export function kit(members: Iterable<Sighting>): string {
  const weapons = new Map<string, number>();
  const armor = new Map<string, number>();
  for (const s of members) {
    const w = weaponKind(s.held);
    weapons.set(w, (weapons.get(w) ?? 0) + 1);
    if (s.armor) {
      const m = s.armor.replace(/_chestplate$/, '');
      armor.set(m, (armor.get(m) ?? 0) + 1);
    }
  }
  const parts = [...weapons].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}${n}`);
  const top = [...armor].sort((a, b) => b[1] - a[1])[0];
  if (top) parts.push(top[0]);
  return parts.join(' ');
}

function weaponKind(item: string | null): string {
  if (!item) return 'empty';
  if (/crossbow/.test(item)) return 'crossbow';
  if (/bow$/.test(item)) return 'bow';
  if (/sword/.test(item)) return 'sword';
  if (/_axe$/.test(item)) return 'axe';
  if (/shield/.test(item)) return 'shield';
  if (/trident/.test(item)) return 'trident';
  return 'other';
}
