// The journal — the single append-only history table (P4: if it didn't journal, it
// didn't happen). SOLE WRITER of the journal table (S2). better-sqlite3, WAL,
// synchronous=NORMAL on the shared event loop (D-07). An in-process pub/sub fans every
// appended event out to live consumers (admin WebSocket, derived views).

import Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

import type { JournalEvent, JournalQuery, Refs } from '../types/index';
import { type JournalKind, type PayloadOf, isKnownKind } from './kinds';

type DB = Database.Database;

/**
 * The journal kinds {@link Journal.prune} may delete past the retention horizon. STRICT invariant: a kind
 * is prunable ONLY if NO view in views/ folds it for durable derived state — otherwise replaying a pruned
 * journal would diverge from the live fold (the rebuild==live design law). These two are the high-volume
 * OBSERVABILITY summaries: `vitals` (the per-bot snapshot cadence) and `system.loop-lag` (the backpressure
 * canary spikes). Verified against views/index.ts (folds: skill.run / conversation.* / trade.* /
 * god.task-closed / god.verdict / rolloutId-tagged) — neither prunable kind appears there.
 */
const PRUNABLE_KINDS: readonly JournalKind[] = ['vitals', 'system.loop-lag'] as const;

/** Live consumer of appended events (e.g. the admin WS stream). */
export type JournalListener = (event: JournalEvent) => void;
/** Returned by `subscribe` — call it to detach the listener. */
export type Unsubscribe = () => void;

/** The surface both the real Journal and the in-memory test fake implement. */
export interface IJournal {
  append<K extends JournalKind>(actor: string, kind: K, payload: PayloadOf<K>, refs?: Refs): string;
  query(q?: JournalQuery): JournalEvent[];
  subscribe(listener: JournalListener): Unsubscribe;
}

/** Just the write side — what the lag monitor and other emitters depend on. */
export type JournalAppender = Pick<IJournal, 'append'>;

interface Row {
  id: string;
  at: number;
  actor: string;
  kind: string;
  payload: string;
  refs: string;
}

const ulid = monotonicFactory();

/** The SQLite-backed sole writer of `eden.db` (S2). WAL + synchronous=NORMAL on the shared loop (D-07). */
export class Journal implements IJournal {
  private readonly db: DB;
  private readonly listeners = new Set<JournalListener>();
  private readonly insertStmt: Database.Statement;

  constructor(db: DB | string) {
    // Accept an OPEN handle (so main.ts can share ONE connection with the VectorStore — "one spine, one
    // connection") or a path (the standalone/test/rebuild-stats callers). Pragmas are idempotent on a
    // shared handle.
    this.db = typeof db === 'string' ? new Database(db) : db;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal (
        id      TEXT PRIMARY KEY,
        at      INTEGER NOT NULL,
        actor   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        payload TEXT NOT NULL,
        refs    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journal_at        ON journal(at);
      CREATE INDEX IF NOT EXISTS idx_journal_actor_at  ON journal(actor, at);
      CREATE INDEX IF NOT EXISTS idx_journal_kind_at   ON journal(kind, at);
      CREATE INDEX IF NOT EXISTS idx_journal_run       ON journal(json_extract(refs, '$.runId'));
      CREATE INDEX IF NOT EXISTS idx_journal_rollout   ON journal(json_extract(refs, '$.rolloutId'));
      CREATE INDEX IF NOT EXISTS idx_journal_skill     ON journal(json_extract(refs, '$.skill'));
    `);
    this.insertStmt = this.db.prepare(
      'INSERT INTO journal (id, at, actor, kind, payload, refs) VALUES (?, ?, ?, ?, ?, ?)',
    );
  }

  append<K extends JournalKind>(actor: string, kind: K, payload: PayloadOf<K>, refs: Refs = {}): string {
    // The kind union is enforced at the type level; this guard catches a bad dynamic kind.
    if (!isKnownKind(kind)) {
      throw new Error(`journal.append: unregistered kind "${kind}" — add a row to journal/kinds.ts (S1)`);
    }
    const id = ulid();
    const at = Date.now();
    this.insertStmt.run(id, at, actor, kind, JSON.stringify(payload), JSON.stringify(refs));
    const event: JournalEvent = { id, at, actor, kind, payload: payload as object, refs };
    this.fan(event);
    return id;
  }

  query(q: JournalQuery = {}): JournalEvent[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (q.kinds && q.kinds.length > 0) {
      clauses.push(`kind IN (${q.kinds.map(() => '?').join(', ')})`);
      params.push(...q.kinds);
    }
    if (q.actor !== undefined) {
      clauses.push('actor = ?');
      params.push(q.actor);
    }
    if (q.id !== undefined) {
      clauses.push('id = ?');
      params.push(q.id);
    }
    if (q.since !== undefined) {
      clauses.push('at >= ?');
      params.push(q.since);
    }
    if (q.until !== undefined) {
      clauses.push('at <= ?');
      params.push(q.until);
    }
    if (q.ref !== undefined) {
      // LOW-1: query the three typed ref paths so the `json_extract` expression indexes (rollout/run/skill,
      // the ones every caller queries by) apply. The old `json_each(refs).value` was a full value-scan that
      // could NOT use those indexes → O(table) ref lookups on the unbounded journal.
      clauses.push(
        "(json_extract(refs, '$.rolloutId') = ? OR json_extract(refs, '$.runId') = ? OR json_extract(refs, '$.skill') = ?)",
      );
      params.push(q.ref, q.ref, q.ref);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const hasLimit = typeof q.limit === 'number' && q.limit > 0;
    const wantDesc = q.order === 'desc';
    // A limit must select the most-recent N (the tail of the timeline), which needs a DESC scan + LIMIT.
    // Without a limit we scan directly in the requested order. After the scan the rows are newest-first
    // iff `scanDesc`; we then flip to the caller's requested order (default asc / chronological).
    const scanDesc = hasLimit || wantDesc;
    const order = scanDesc ? 'ORDER BY at DESC, id DESC' : 'ORDER BY at ASC, id ASC';
    const limit = hasLimit ? ` LIMIT ${Math.floor(q.limit as number)}` : '';
    const rows = this.db.prepare(`SELECT * FROM journal ${where} ${order}${limit}`).all(...params) as Row[];
    const events = rows.map(rowToEvent);
    if (wantDesc) return scanDesc ? events : events.reverse();
    return scanDesc ? events.reverse() : events;
  }

  subscribe(listener: JournalListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Total rows in the journal table. */
  count(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM journal').get() as { n: number };
    return r.n;
  }

  /**
   * Retention (config `journal.retentionDays`): delete rows older than the cutoff, but ONLY the
   * high-volume OBSERVABILITY kinds {@link PRUNABLE_KINDS} that NO view in views/ folds for durable
   * derived state (vitals per-bot snapshots + the loop-lag canary spikes). This is the bound on the
   * otherwise-unbounded journal. It must NEVER touch a kind any view consumes, or replay-from-the-pruned-
   * journal would no longer equal the live fold (the rebuild==live invariant). `now` is injectable so the
   * caller controls the clock (tests pass a fixed `now`; the host passes Date.now()). Returns rows deleted.
   */
  prune(retentionDays: number, now: number = Date.now()): number {
    if (!(retentionDays > 0)) return 0; // 0/negative/NaN ⇒ retention disabled (keep everything)
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const placeholders = PRUNABLE_KINDS.map(() => '?').join(', ');
    const info = this.db
      .prepare(`DELETE FROM journal WHERE at < ? AND kind IN (${placeholders})`)
      .run(cutoff, ...PRUNABLE_KINDS);
    return info.changes;
  }

  /** Close the underlying database (call on host shutdown). */
  close(): void {
    this.db.close();
  }

  private fan(event: JournalEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A bad consumer must never break the write path (P4) or other consumers.
      }
    }
  }
}

function rowToEvent(row: Row): JournalEvent {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    kind: row.kind,
    payload: JSON.parse(row.payload) as object,
    refs: JSON.parse(row.refs) as Refs,
  };
}
