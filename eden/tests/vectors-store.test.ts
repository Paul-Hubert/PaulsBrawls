// docs/21 §8 — the sqlite-vec round-trip, GATED behind EDEN_TEST_SQLITE_VEC=1 so `npm run check` (CI)
// NEVER loads the native extension (the hard rule). Run locally with:
//   EDEN_TEST_SQLITE_VEC=1  node --import tsx --test tests/vectors-store.test.ts
// It proves the real SqliteVecStore on an in-memory eden.db: load+verify (vec_version), upsert (the
// delete-then-insert idiom — R74), partition-scoped KNN, scoreFor over the exact pool, delete, clear,
// keys, and that a bad call (wrong dimension) degrades silently (S10) instead of throwing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteVecStore } from '../src/vectors/store';

const RUN_REAL = process.env['EDEN_TEST_SQLITE_VEC'] === '1';

/** A deterministic unit vector (so cosine is meaningful). */
function unit(seed: number, dim = 384): Float32Array {
  const v = new Float32Array(dim);
  let s = (seed * 2654435761) >>> 0;
  let n = 0;
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const x = s / 0xffffffff - 0.5;
    v[i] = x;
    n += x * x;
  }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i]! /= n;
  return v;
}

test('docs/21 §8 (sqlite-vec round-trip): load+verify, upsert/knn/scoreFor/delete/clear on a real eden.db', { skip: !RUN_REAL }, async () => {
  // Dynamic import so the native dep is only touched when the gate is on.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  const warns: string[] = [];
  const store = new SqliteVecStore({ db, onWarn: (m) => warns.push(m) });
  assert.equal(store.enabled(), true, 'sqlite-vec loaded and registered functions (vec_version ok)');

  // Two namespaces; the query is identical to harry-0 → distance ~0 → top hit.
  for (let i = 0; i < 5; i++) store.upsert('harry', `h${i}`, unit(i + 1));
  for (let i = 0; i < 5; i++) store.upsert('marie', `m${i}`, unit(i + 100));

  const q = unit(1);
  const knn = store.knn('harry', q, 3);
  assert.equal(knn[0]!.key, 'h0', 'nearest is the identical vector');
  assert.ok(knn[0]!.score > 0.99, 'self-similarity ≈ 1');
  assert.ok(knn.every((r) => r.key.startsWith('h')), 'KNN scoped to the harry partition only');

  // scoreFor returns a similarity ONLY for requested keys that have a vector.
  const scores = store.scoreFor('harry', q, ['h0', 'h2', 'absent']);
  assert.ok(scores.has('h0') && scores.has('h2'));
  assert.ok(!scores.has('absent'), 'a key with no stored vector is simply absent (→ keyword floor)');
  assert.ok(scores.get('h0')! >= scores.get('h2')!, 'closer vector scores higher');

  // upsert is a replace (delete-then-insert): re-upserting h0 keeps the count, not a duplicate.
  store.upsert('harry', 'h0', unit(999));
  assert.equal(store.keys('harry').size, 5, 'upsert replaced, did not duplicate');

  store.delete('harry', 'h1');
  assert.equal(store.keys('harry').size, 4, 'delete removed one');

  store.clear('marie');
  assert.equal(store.keys('marie').size, 0, 'clear dropped the whole namespace');
  assert.equal(store.keys('harry').size, 4, 'clear is namespace-scoped');

  // A wrong-dimension vector degrades silently (S10) — reports via onWarn, never throws.
  assert.doesNotThrow(() => store.upsert('harry', 'bad', [1, 2, 3]));
  assert.ok(warns.some((w) => /upsert failed/.test(w)), 'the bad upsert was reported with evidence');

  db.close();
});
