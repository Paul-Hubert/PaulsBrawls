// In-memory IJournal — drives D-07 and admin tests without SQLite. Same surface as the
// real Journal (append/query/subscribe); events are kept in an array.

import type { JournalEvent, JournalQuery, Refs } from '../../src/types/index';
import type { IJournal, JournalListener, Unsubscribe } from '../../src/journal/journal';
import type { JournalKind, PayloadOf } from '../../src/journal/kinds';

export class MemoryJournal implements IJournal {
  readonly events: JournalEvent[] = [];
  private readonly listeners = new Set<JournalListener>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  append<K extends JournalKind>(actor: string, kind: K, payload: PayloadOf<K>, refs: Refs = {}): string {
    const id = `mem-${(this.seq++).toString().padStart(8, '0')}`;
    const event: JournalEvent = { id, at: this.now(), actor, kind, payload: payload as object, refs };
    this.events.push(event);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* a bad consumer must not break the write path */
      }
    }
    return id;
  }

  query(q: JournalQuery = {}): JournalEvent[] {
    let out = this.events.filter((e) => {
      if (q.kinds && q.kinds.length > 0 && !q.kinds.includes(e.kind)) return false;
      if (q.actor !== undefined && e.actor !== q.actor) return false;
      if (q.id !== undefined && e.id !== q.id) return false;
      if (q.since !== undefined && e.at < q.since) return false;
      if (q.until !== undefined && e.at > q.until) return false;
      if (q.ref !== undefined && !Object.values(e.refs).includes(q.ref)) return false;
      return true;
    });
    // `events` is insertion order (chronological). A limit selects the most-recent N (the tail).
    if (typeof q.limit === 'number' && q.limit > 0) out = out.slice(-Math.floor(q.limit));
    if (q.order === 'desc') out = out.slice().reverse();
    return out.map((e) => ({ ...e }));
  }

  subscribe(listener: JournalListener): Unsubscribe {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}
