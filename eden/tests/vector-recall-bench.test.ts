// docs/21 §8 — the before/after THROUGHPUT proof, GATED behind EDEN_BENCH=1 so it never runs in CI
// (it loads the REAL multilingual-MiniLM ONNX model AND the real sqlite-vec extension). Run with:
//   EDEN_BENCH=1  node --import tsx --test tests/vector-recall-bench.test.ts
// It builds a large memory pool, then contrasts the OLD read path (embed [query, ...whole pool] — the
// ~7.3 s/recall defect) with the NEW path (VillagerMemory.retrieve embeds only the query + a C-side KNN),
// asserting the new median recall is fast and induces no event-loop lag (system.loop-lag, D-07).

import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryJournal } from './fakes/memory-journal';
import { EmbeddingsService, localBackend } from '../src/llm/embeddings';
import { SqliteVecStore } from '../src/vectors/store';
import { VillagerMemory } from '../src/villagers/memory';

const RUN_BENCH = process.env['EDEN_BENCH'] === '1';
const POOL = Number(process.env['EDEN_BENCH_POOL'] ?? 1500);
const RECALLS = 20;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

test('docs/21 §8 (throughput): recall is O(1) inference, not O(pool) — the ~7.3 s defect is gone', { skip: !RUN_BENCH }, async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  const vectors = new SqliteVecStore({ db, onWarn: () => {} });
  assert.equal(vectors.enabled(), true, 'sqlite-vec must be available for the bench');

  const embeddings = new EmbeddingsService({ backend: localBackend() });
  const mem = new VillagerMemory({
    villager: 'Bench', dataDir: mkdtempSync(join(tmpdir(), 'eden-bench-')), journal: new MemoryJournal(),
    worldId: 'w1', embeddings, vectors, windowMax: POOL, archiveMax: POOL, // keep the whole pool live
  });

  console.log(`\n[bench] embedding ${POOL} entries at write (one-time backfill cost)…`);
  const texts: string[] = [];
  for (let i = 0; i < POOL; i++) {
    const t = `Souvenir ${i}: le villageois a ${['miné', 'récolté', 'fabriqué', 'échangé'][i % 4]} ${['du bois', 'de la pierre', 'du blé', 'du pain'][i % 4]} au point ${i}`;
    texts.push(t);
    mem.remember({ kind: 'event', text: t });
  }
  const tWrite = performance.now();
  await mem.flushVectors();
  console.log(`[bench] embed-at-write of ${POOL} entries took ${(performance.now() - tWrite).toFixed(0)} ms (off the hot path).`);

  const query = 'récolter du blé dans les champs';

  // OLD read path: embed [query, ...entire pool] — exactly what retrieve() used to do every recall.
  const tOld = performance.now();
  await embeddings.embed([query, ...texts]);
  const oldMs = performance.now() - tOld;
  console.log(`[bench] OLD path (re-embed query + ${POOL} pool texts) ONE recall: ${oldMs.toFixed(0)} ms`);

  // NEW read path: 20 recalls under an event-loop-delay monitor.
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const recallMs: number[] = [];
  for (let i = 0; i < RECALLS; i++) {
    const t0 = performance.now();
    await mem.retrieve(query, 8);
    recallMs.push(performance.now() - t0);
  }
  h.disable();
  const med = median(recallMs);
  const maxLagMs = h.max / 1e6;
  console.log(`[bench] NEW path median recall: ${med.toFixed(2)} ms (min ${Math.min(...recallMs).toFixed(2)}, max ${Math.max(...recallMs).toFixed(2)}) over ${RECALLS} recalls`);
  console.log(`[bench] speedup ≈ ${(oldMs / med).toFixed(0)}×; event-loop max delay during recalls: ${maxLagMs.toFixed(1)} ms\n`);

  assert.ok(med < 50, `median recall ${med.toFixed(2)} ms should be < 50 ms`);
  assert.ok(maxLagMs < 1000, `event-loop max delay ${maxLagMs.toFixed(1)} ms should be < 1000 ms (no system.loop-lag)`);
  assert.ok(med < oldMs / 10, 'the new path is at least 10× faster than re-embedding the pool');

  db.close();
});
