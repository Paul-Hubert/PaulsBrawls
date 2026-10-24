// VectorStore (layer 1) — persisted embedding vectors on the eden.db spine via sqlite-vec.
//
// D-record (vectors-in-the-spine): embeddings are computed ONCE at write time and the vectors are
// stored in a `sqlite-vec` `vec0` virtual table inside the existing `eden.db` (D-03). Recall embeds
// ONLY the query and runs a brute-force cosine KNN in C — replacing the old "re-embed the whole pool
// on every recall" (O(pool) inferences/recall → ~7.3 s on a full pool) with one query embed + a
// sub-millisecond KNN.
//
// Pure storage: imports `better-sqlite3` + `sqlite-vec` + types only (the `vectors-only-types` cruiser
// rule). It cannot import logger/ (the dependency law), so it reports failures through an injected
// `onWarn` callback (the EmbeddingsService pattern) — main.ts wires that to the logger/journal.
//
// SAFETY NET (R38 extended to the store): the native extension is pre-1.0 and the Windows prebuilt can
// silently ABI-mismatch the bundled SQLite (R74). So the constructor LOADS the extension AND VERIFIES
// `vec_version()` returns; on any failure it logs via onWarn, sets `enabled() === false`, and never
// rethrows. An unavailable vector backend is exactly like embeddings being off → callers fall to the
// keyword floor. The host never crashes on a missing vector backend.
//
// S2: the journal owns the `journal` table; this owns its `vec0` table. They share one DB file (and may
// share one connection) without violating S2 — distinct tables, distinct writers.
//
// KEY IDENTITY (read before reusing a key string across namespaces): the vec0 table declares
// `key text primary key` as a GLOBAL primary key. `ns` is ONLY a partition key — it scopes the
// brute-force KNN scan (and `clear(ns)`), NOT key identity. `upsert`/`delete` act on `key` GLOBALLY,
// ignoring `ns`. So callers MUST use globally-unique keys (memory uses ULIDs, which satisfy this);
// reusing one key string under two namespaces would silently clobber the single global row.

import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

type DB = Database.Database;
type Stmt = Database.Statement;

/** The number of dimensions of the default embedding model (multilingual MiniLM, 04 §Memory). */
const DEFAULT_DIM = 384;
/** The default vec0 table name in eden.db. */
const DEFAULT_TABLE = 'vec_embeddings';

/**
 * A namespaced vector store. `ns` is a PARTITION key (e.g. a villager name, or 'skills', or 'qa') so
 * memory / skills / QA can all share one store + one DB while each namespace's KNN scan stays scoped to
 * its own entries.
 *
 * KEY IDENTITY (the contract callers MUST honour): `key` is a GLOBAL primary key. `ns` scopes only the
 * KNN scan (and `clear`), NOT key identity — `upsert`/`delete` act on `key` globally, ignoring `ns`. So
 * callers MUST use globally-unique keys (memory uses ULIDs); reusing one key under two namespaces would
 * silently clobber the single global row, not create two isolated ones.
 */
export interface IVectorStore {
  /** False when the extension failed to load (or the store is disabled) → callers fall to the keyword floor. */
  enabled(): boolean;
  /**
   * Insert-or-replace one vector under the GLOBAL `key` (its `ns` partition is set/updated too). The vector
   * must have the store's dimension. Because `key` is global, reusing a key across namespaces overwrites
   * the same row — callers MUST pass globally-unique keys.
   */
  upsert(ns: string, key: string, vector: Float32Array | number[]): void;
  /** KNN within one namespace (the only ns-scoped read). Returns cosine SIMILARITY (max(0, 1 − cosine_distance)), sorted desc. */
  knn(ns: string, query: Float32Array | number[], k: number): Array<{ key: string; score: number }>;
  /**
   * Cosine similarity for a SPECIFIC set of keys (so a re-rank can score the exact in-RAM pool without
   * losing entries to a top-k-by-cosine prefilter — see docs/21 §6). Scoped to `ns`. Missing keys are
   * simply absent from the result (the caller treats them as 0 → keyword floor).
   */
  scoreFor(ns: string, query: Float32Array | number[], keys: string[]): Map<string, number>;
  /** Delete one vector by GLOBAL `key`. `ns` is advisory — the delete is by key, not (ns, key). */
  delete(ns: string, key: string): void;
  /** Drop a whole namespace (the ONLY ns-scoped removal; R32 wipe; a superseded skill-version sweep). */
  clear(ns: string): void;
  /** Which keys already have a stored vector under `ns` (drives the boot-time backfill). */
  keys(ns: string): Set<string>;
}

/** Construction deps for {@link SqliteVecStore}. */
export interface SqliteVecStoreOptions {
  /** An OPEN better-sqlite3 handle (shared with the journal — "one spine, one connection"). */
  db: DB;
  /** Embedding dimension. Default 384 (multilingual MiniLM). */
  dim?: number;
  /** vec0 table name. Default 'vec_embeddings'. */
  table?: string;
  /** Failure sink — the store never throws into callers; it reports + degrades (S10). */
  onWarn?: (message: string) => void;
}

/**
 * The sqlite-vec backed {@link IVectorStore}. Loads the extension on the shared connection, verifies it
 * registered functions, and creates one partitioned `vec0` table. Every method is failure-tolerant: a
 * disabled store (or a per-call error) degrades to "no vector" so retrieval falls to the keyword floor.
 */
export class SqliteVecStore implements IVectorStore {
  private readonly db: DB;
  private readonly dim: number;
  private readonly table: string;
  private readonly onWarn: ((message: string) => void) | undefined;
  private _enabled = false;

  // Prepared once when enabled (definite-assignment: only touched while `_enabled`).
  private insertStmt!: Stmt;
  private deleteStmt!: Stmt;
  private clearStmt!: Stmt;
  private keysStmt!: Stmt;
  private countStmt!: Stmt;
  private knnStmt!: Stmt;

  constructor(opts: SqliteVecStoreOptions) {
    this.db = opts.db;
    this.dim = opts.dim ?? DEFAULT_DIM;
    this.table = opts.table ?? DEFAULT_TABLE;
    this.onWarn = opts.onWarn;
    try {
      // Load the loadable extension on the shared connection, then PROVE it registered functions — a
      // pre-1.0 Windows prebuilt can load without error yet register nothing on a bundled-SQLite ABI
      // mismatch (R74). `vec_version()` throwing/empty is the signal to degrade.
      sqliteVec.load(this.db);
      const row = this.db.prepare('SELECT vec_version() AS v').get() as { v?: string } | undefined;
      if (!row?.v) throw new Error('vec_version() returned nothing — extension loaded but registered no functions');
      // One partitioned table. `ns` is a partition key (shards the brute-force scan per namespace);
      // `key` is the global text primary key. cosine distance so score = 1 − distance.
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.table} USING vec0(\n` +
          `  key text primary key,\n` +
          `  embedding float[${this.dim}] distance_metric=cosine,\n` +
          `  ns text partition key\n` +
          `);`,
      );
      this.insertStmt = this.db.prepare(`INSERT INTO ${this.table}(key, embedding, ns) VALUES (?, ?, ?)`);
      this.deleteStmt = this.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`);
      this.clearStmt = this.db.prepare(`DELETE FROM ${this.table} WHERE ns = ?`);
      this.keysStmt = this.db.prepare(`SELECT key FROM ${this.table} WHERE ns = ?`);
      this.countStmt = this.db.prepare(`SELECT count(*) AS c FROM ${this.table} WHERE ns = ?`);
      // KNN: `MATCH ? AND k = ?` is the brute-force signal; `ns = ?` scopes to one partition. ORDER BY
      // distance ASC only — sqlite-vec rejects DESC (nearest-first is what we want anyway).
      this.knnStmt = this.db.prepare(
        `SELECT key, distance FROM ${this.table} WHERE embedding MATCH ? AND k = ? AND ns = ? ORDER BY distance`,
      );
      this._enabled = true;
    } catch (e) {
      this._enabled = false;
      this.onWarn?.(
        `vectors: sqlite-vec unavailable — retrieval degrades to the keyword floor (R38/R74): ${msg(e)}`,
      );
    }
  }

  enabled(): boolean {
    return this._enabled;
  }

  upsert(ns: string, key: string, vector: Float32Array | number[]): void {
    if (!this._enabled) return;
    const blob = this.toBlob(vector);
    if (blob === null) return; // dim mismatch hard-disabled the store (warned once) — clean no-op.
    try {
      // INSERT OR REPLACE does NOT replace by a text PK on vec0 (UNIQUE error, R74) — delete-then-insert
      // atomically instead.
      this.db.transaction(() => {
        this.deleteStmt.run(key);
        this.insertStmt.run(key, blob, ns);
      })();
    } catch (e) {
      this.warn('upsert', ns, key, undefined, e);
    }
  }

  knn(ns: string, query: Float32Array | number[], k: number): Array<{ key: string; score: number }> {
    if (!this._enabled || k <= 0) return [];
    const blob = this.toBlob(query);
    if (blob === null) return []; // dim mismatch hard-disabled the store (warned once) — keyword floor.
    try {
      const rows = this.knnStmt.all(blob, k, ns) as Array<{ key: string; distance: number }>;
      return rows.map((r) => ({ key: r.key, score: sim(r.distance) }));
    } catch (e) {
      this.warn('knn', ns, undefined, query, e);
      return [];
    }
  }

  scoreFor(ns: string, query: Float32Array | number[], keys: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!this._enabled || keys.length === 0) return out;
    const blob = this.toBlob(query);
    if (blob === null) return out; // dim mismatch hard-disabled the store (warned once) — keyword floor.
    try {
      const count = (this.countStmt.get(ns) as { c: number }).c;
      if (count === 0) return out;
      // Brute-force the whole partition (k = its size) so EVERY pool entry gets a cosine — the re-rank
      // blends recency/importance over the full pool and must not lose entries to a cosine prefilter
      // (docs/21 §6). Sub-ms at this scale.
      const rows = this.knnStmt.all(blob, count, ns) as Array<{ key: string; distance: number }>;
      const wanted = new Set(keys);
      for (const r of rows) if (wanted.has(r.key)) out.set(r.key, sim(r.distance));
      return out;
    } catch (e) {
      this.warn('scoreFor', ns, undefined, query, e);
      return out;
    }
  }

  delete(ns: string, key: string): void {
    if (!this._enabled) return;
    try {
      this.deleteStmt.run(key);
    } catch (e) {
      this.warn('delete', ns, key, undefined, e);
    }
  }

  clear(ns: string): void {
    if (!this._enabled) return;
    try {
      this.clearStmt.run(ns);
    } catch (e) {
      this.warn('clear', ns, undefined, undefined, e);
    }
  }

  keys(ns: string): Set<string> {
    const out = new Set<string>();
    if (!this._enabled) return out;
    try {
      for (const r of this.keysStmt.all(ns) as Array<{ key: string }>) out.add(r.key);
    } catch (e) {
      this.warn('keys', ns, undefined, undefined, e);
    }
    return out;
  }

  /**
   * Bind a float32 vector as a raw little-endian BLOB — sqlite-vec's native wire format.
   *
   * Dimension-mismatch HARD-DISABLE (stop the per-call warn flood): a vector whose length != `this.dim`
   * is not a transient sqlite error — it means the wired embedding model and the table disagree on
   * dimension forever, so toBlob would throw on EVERY upsert/knn/scoreFor and `onWarn` would fire once
   * per call (a warn storm) while retrieval silently returns nothing. Instead, the FIRST mismatch warns
   * EXACTLY ONCE, flips `_enabled = false` (so all subsequent calls cleanly no-op to the keyword floor —
   * every public method early-returns on `!this._enabled`), and returns `null` so the current call bails
   * without throwing. Returns a Buffer on success. Never throws (the never-throw contract).
   */
  private toBlob(vector: Float32Array | number[]): Buffer | null {
    const f32 = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    if (f32.length !== this.dim) {
      // One clear diagnostic naming BOTH dimensions, then hard-disable — not a per-call warn.
      this._enabled = false;
      this.onWarn?.(
        `vectors: embedding model produced ${f32.length}-dim vectors but the store is ${this.dim}-dim — ` +
          `retrieval stays on the keyword floor (recreate the table with the correct dim or pass { dim } ` +
          `to SqliteVecStore)`,
      );
      return null;
    }
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  }

  /** Report a per-call failure with evidence (S10), then the caller degrades to the keyword floor. */
  private warn(op: string, ns: string, key: string | undefined, query: Float32Array | number[] | undefined, e: unknown): void {
    const k = key !== undefined ? ` key="${key}"` : '';
    const q = query !== undefined ? ` qlen=${query.length}` : '';
    this.onWarn?.(`vectors.${op} failed ns="${ns}"${k}${q} — degrading to the keyword floor (S10): ${msg(e)}`);
  }
}

/** cosine SIMILARITY from sqlite-vec's cosine DISTANCE, clamped to match `Math.max(0, cosine(...))`. */
function sim(distance: number): number {
  const s = 1 - distance;
  return s > 0 ? s : 0;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
