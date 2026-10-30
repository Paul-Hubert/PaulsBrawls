// The journal (docs/29 §11): SQLite (better-sqlite3, WAL) holding every order and its report. It is what
// `/bots fix` reads (the last report of a command), what a restart marks `interrupted`, and what the order ids count
// from. Only orders are journaled: the hot stream (positions, pulses) never is (Eden's R44).

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
