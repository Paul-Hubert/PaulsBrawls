// Team ids for the entity snapshot (docs/37 §2.4): bots sharing an owner are friends, as the scripts' isFriend and
// the server's friendly-fire rule (SquadFriends) have it. A snapshot row carries one number, so a team here is a
// connected group of the owner graph: bots and their owners, joined through any shared owner. That is a superset of
// every order's isFriend set (its commander, the co-owners of its bots, the bots sharing an owner with them), so a
// worker that treats "same team" as "do not hit" never hits someone isFriend protects.
//
// Owners are players and get their team's number too (isFriend counts them as friends); everyone else, and every
// mob, is 0. The ids stay the same while the groups do: a group's id is the smallest id among its owners, and an
// owner keeps the id it first got.

import type { RosterBot } from '../roster';

export class TeamIds {
  private readonly ownerIds = new Map<string, number>();
  private byName = new Map<string, number>();
  private builtAt = -Infinity;

  /**
   * @param bots the roster (read again when the cache is older than `maxAgeMs`)
   * @param now  the clock (tests)
   */
  constructor(
    private readonly bots: () => RosterBot[],
    private readonly maxAgeMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The team of a username (a bot or one of its owners), 0 = none. */
  teamOf(username: string): number {
    const t = this.now();
    if (t - this.builtAt > this.maxAgeMs) {
      this.byName = this.build(this.bots());
      this.builtAt = t;
    }
    return this.byName.get(username) ?? 0;
  }

  /** Forget the cache (the roster changed). */
  invalidate(): void {
    this.builtAt = -Infinity;
  }

  private build(bots: RosterBot[]): Map<string, number> {
    // Union-find over owner uuids.
    const parent = new Map<string, string>();
    const find = (u: string): string => {
      let r = u;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(u) !== r) {
        const next = parent.get(u)!;
        parent.set(u, r);
        u = next;
      }
      return r;
    };
    for (const b of bots) {
      for (const o of b.owners) {
        if (!parent.has(o.uuid)) parent.set(o.uuid, o.uuid);
        if (!this.ownerIds.has(o.uuid)) this.ownerIds.set(o.uuid, this.ownerIds.size + 1);
      }
      const first = b.owners[0];
      if (!first) continue;
      for (const o of b.owners) {
        const a = find(first.uuid);
        const c = find(o.uuid);
        if (a !== c) parent.set(c, a);
      }
    }
    const groupId = new Map<string, number>();
    for (const u of parent.keys()) {
      const r = find(u);
      const id = this.ownerIds.get(u)!;
      const cur = groupId.get(r);
      if (cur === undefined || id < cur) groupId.set(r, id);
    }
    const out = new Map<string, number>();
    for (const b of bots) {
      const first = b.owners[0];
      if (!first) continue;
      const team = groupId.get(find(first.uuid))!;
      out.set(b.name, team);
      for (const o of b.owners) out.set(o.name, team);
    }
    return out;
  }
}
