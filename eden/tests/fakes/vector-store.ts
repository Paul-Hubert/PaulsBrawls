// An in-memory IVectorStore for tests — mirrors SqliteVecStore's semantics (cosine SIMILARITY,
// max(0, cosine)) in pure JS so CI never loads the native sqlite-vec extension. `enabled()` is togglable
// to prove the store floor (R38 extended to the store). `upserts` counts writes so a test can assert
// embed-at-write + backfill idempotency.
//
// Faithful to SqliteVecStore's KEY CONTRACT: `key` is a GLOBAL primary key, `ns` is only a partition.
// So entries live in ONE global map keyed by `key` (each carrying its `ns`); `ns` scopes only the KNN
// scan, `scoreFor`, `keys`, and `clear` — NOT `upsert`/`delete`. Reusing a key across namespaces
// clobbers the single global row (re-partitioning it), exactly as the vec0 text PK does.

import { cosine } from '../../src/llm/embeddings';
import type { IVectorStore } from '../../src/vectors/store';

interface Entry {
  ns: string;
  vector: number[];
}

export class FakeVectorStore implements IVectorStore {
  // ONE global map keyed by the global `key` — mirrors vec0's `key text primary key` (not per-ns maps).
  private readonly store = new Map<string, Entry>();
  private on: boolean;
  /** Total upsert calls — proves the per-write embed + the once-only backfill (idempotency). */
  upserts = 0;

  constructor(enabled = true) {
    this.on = enabled;
  }

  setEnabled(b: boolean): void {
    this.on = b;
  }

  enabled(): boolean {
    return this.on;
  }

  upsert(ns: string, key: string, vector: Float32Array | number[]): void {
    if (!this.on) return;
    this.upserts++;
    // Global key: a re-upsert under a different ns re-partitions the SAME row (no second isolated entry).
    this.store.set(key, { ns, vector: Array.from(vector) });
  }

  knn(ns: string, query: Float32Array | number[], k: number): Array<{ key: string; score: number }> {
    if (!this.on) return [];
    const q = Array.from(query);
    const arr = [...this.store]
      .filter(([, e]) => e.ns === ns) // ns partitions the KNN scan
      .map(([key, e]) => ({ key, score: Math.max(0, cosine(q, e.vector)) }));
    arr.sort((a, b) => b.score - a.score);
    return arr.slice(0, k);
  }

  scoreFor(ns: string, query: Float32Array | number[], keys: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!this.on) return out;
    const q = Array.from(query);
    for (const key of keys) {
      const e = this.store.get(key);
      if (e && e.ns === ns) out.set(key, Math.max(0, cosine(q, e.vector))); // scoped to the ns partition
    }
    return out;
  }

  // `ns` is ADVISORY — delete is by the global `key`, matching SqliteVecStore (`DELETE ... WHERE key = ?`).
  delete(_ns: string, key: string): void {
    this.store.delete(key);
  }

  clear(ns: string): void {
    // The only ns-scoped removal — drop every entry in this partition.
    for (const [key, e] of this.store) if (e.ns === ns) this.store.delete(key);
  }

  keys(ns: string): Set<string> {
    const out = new Set<string>();
    for (const [key, e] of this.store) if (e.ns === ns) out.add(key);
    return out;
  }
}
