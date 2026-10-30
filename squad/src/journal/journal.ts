// The journal (docs/29 §11): SQLite (better-sqlite3, WAL) holding every order and its report. It is what
// `/bots fix` reads (the last report of a command), what a restart marks `interrupted`, and what the order ids count
// from. Only orders are journaled, plus one vitals row per minute (docs/32 C): the hot stream (positions, pulses,
// physics ticks) never is (Eden's R44).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type { OrderReport, OrderStatus } from '../types';

export interface OrderRow {
  id: string;
  status: OrderStatus;
  author: string;
  command: string;
  version: number;
  commander: string;
  commanderName: string;
  trial: boolean;
  startedAt: number;
  endedAt: number | null;
}

/** One minute of the runtime's health (src/vitals/metrics.ts). `data` holds the details as JSON. */
export interface VitalsRow {
  /** End of the minute, ms since the epoch. */
  at: number;
  seconds: number;
  elu: number;
  loopP50: number;
  loopP99: number;
  loopMax: number;
  cpuPct: number;
  rssMb: number;
  heapMb: number;
  /** Bots online at the end of the minute. */
  bots: number;
  /** The slowest online bot's physics ticks per second over the minute (null: no bot online). */
  minTicksPerSec: number | null;
  data: Record<string, unknown>;
}

/** Vitals rows older than this are deleted when a new one is written. */
export const VITALS_KEEP_MS = 7 * 24 * 3600_000;

export class Journal {
  private readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        author TEXT NOT NULL,
        command TEXT NOT NULL,
        version INTEGER NOT NULL,
        commander TEXT NOT NULL,
        commander_name TEXT NOT NULL,
        trial INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        report TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orders_command ON orders (author, command, id);
      CREATE TABLE IF NOT EXISTS vitals (
        at INTEGER NOT NULL,
        seconds REAL NOT NULL,
        elu REAL NOT NULL,
        loop_p50 REAL NOT NULL,
        loop_p99 REAL NOT NULL,
        loop_max REAL NOT NULL,
        cpu_pct REAL NOT NULL,
        rss_mb INTEGER NOT NULL,
        heap_mb INTEGER NOT NULL,
        bots INTEGER NOT NULL,
        min_tps REAL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vitals_at ON vitals (at);
    `);
  }

  nextId(): number {
    const r = this.db.prepare('SELECT MAX(id) AS m FROM orders').get() as { m: number | null };
    return (r.m ?? 0) + 1;
  }

  /** Insert or update an order with its current report. */
  save(r: OrderReport): void {
    this.db
      .prepare(
        `INSERT INTO orders (id, status, author, command, version, commander, commander_name, trial, started_at, ended_at, report)
         VALUES (@id, @status, @author, @command, @version, @commander, @commanderName, @trial, @startedAt, @endedAt, @report)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at, report = excluded.report`,
      )
      .run({
        id: Number(r.id),
        status: r.status,
        author: r.command.author.uuid,
        command: r.command.name,
        version: r.command.version,
        commander: r.commander.uuid,
        commanderName: r.commander.name,
        trial: r.trial ? 1 : 0,
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? null,
        report: JSON.stringify(r),
      });
  }

  report(id: string): OrderReport | undefined {
    const row = this.db.prepare('SELECT report FROM orders WHERE id = ?').get(Number(id)) as { report: string } | undefined;
    return row ? (JSON.parse(row.report) as OrderReport) : undefined;
  }

  /** The most recent finished, non-trial order of a command (whoever ran it): what `/bots fix` hands the agent. */
  lastReport(author: string, command: string): OrderReport | undefined {
    const row = this.db
      .prepare(`SELECT report FROM orders WHERE author = ? AND command = ? AND trial = 0 AND status != 'running' ORDER BY id DESC LIMIT 1`)
      .get(author, command) as { report: string } | undefined;
    return row ? (JSON.parse(row.report) as OrderReport) : undefined;
  }

  /** A restart: every order still `running` becomes `interrupted`. Returns them. */
  markInterrupted(now = Date.now()): OrderRow[] {
    const rows = this.rows(`SELECT * FROM orders WHERE status = 'running'`);
    const upd = this.db.prepare(`UPDATE orders SET status = 'interrupted', ended_at = ?, report = ? WHERE id = ?`);
    for (const row of rows) {
      const rep = this.report(row.id);
      if (rep) {
        rep.status = 'interrupted';
        rep.endedAt = now;
        upd.run(now, JSON.stringify(rep), Number(row.id));
      }
    }
    return rows.map((r) => ({ ...r, status: 'interrupted' as const }));
  }

  /** Write one minute of vitals and delete the rows older than {@link VITALS_KEEP_MS} (measured from `row.at`). */
  saveVitals(row: VitalsRow): void {
    this.db
      .prepare(
        `INSERT INTO vitals (at, seconds, elu, loop_p50, loop_p99, loop_max, cpu_pct, rss_mb, heap_mb, bots, min_tps, data)
         VALUES (@at, @seconds, @elu, @loopP50, @loopP99, @loopMax, @cpuPct, @rssMb, @heapMb, @bots, @minTicksPerSec, @data)`,
      )
      .run({ ...row, data: JSON.stringify(row.data) });
    this.db.prepare('DELETE FROM vitals WHERE at < ?').run(row.at - VITALS_KEEP_MS);
  }

  /** The newest vitals rows first. */
  vitals(limit = 60): VitalsRow[] {
    const rows = this.db.prepare(`SELECT * FROM vitals ORDER BY at DESC LIMIT ?`).all(Math.max(1, Math.min(10_080, Math.floor(limit)))) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      at: r.at as number,
      seconds: r.seconds as number,
      elu: r.elu as number,
      loopP50: r.loop_p50 as number,
      loopP99: r.loop_p99 as number,
      loopMax: r.loop_max as number,
      cpuPct: r.cpu_pct as number,
      rssMb: r.rss_mb as number,
      heapMb: r.heap_mb as number,
      bots: r.bots as number,
      minTicksPerSec: (r.min_tps as number | null) ?? null,
      data: JSON.parse(r.data as string) as Record<string, unknown>,
    }));
  }

  recent(limit = 20): OrderRow[] {
    return this.rows(`SELECT * FROM orders ORDER BY id DESC LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}`);
  }

  close(): void {
    this.db.close();
  }

  private rows(sql: string): OrderRow[] {
    return (this.db.prepare(sql).all() as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      status: r.status as OrderStatus,
      author: r.author as string,
      command: r.command as string,
      version: r.version as number,
      commander: r.commander as string,
      commanderName: r.commander_name as string,
      trial: r.trial === 1,
      startedAt: r.started_at as number,
      endedAt: (r.ended_at as number | null) ?? null,
    }));
  }
}
