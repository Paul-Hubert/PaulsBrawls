// docs/21 §8 — the embed-at-write migration of VillagerMemory. Proves the DEFECT is gone (recall embeds
// ONLY the query, not the pool) and that the ranking math is unchanged, the R38 keyword floor still
// fires two ways (embeddings OR store off), the vector lifecycle tracks eviction/trim, the boot backfill
// is idempotent, and R32 wipe clears the namespace. All on fakes — never the real model or sqlite-vec.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryJournal } from './fakes/memory-journal';
import { FakeVectorStore } from './fakes/vector-store';
import { EmbeddingsService } from '../src/llm/embeddings';
import { VillagerMemory } from '../src/villagers/memory';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'eden-memvec-'));
}

/** A deterministic, language-agnostic embedder: maps a TOPIC to a one-hot axis so French and English
 *  texts about the same thing share a vector (multilingual stand-in) while keyword overlap is zero. */
function topicVec(text: string): number[] {
  const t = text.toLowerCase();
  if (/bl[ée]|wheat|graine|seed|moisson/.test(t)) return [1, 0, 0];
  if (/[ée]p[ée]e|sword|forger|forge/.test(t)) return [0, 1, 0];
  if (/pierre|stone|mine|pioche/.test(t)) return [0, 0, 1];
  return [0.5, 0.5, 0.5];
}

/** A counting EmbeddingsService: records exactly how many TEXTS were passed to embed (the defect probe). */
function countingEmbeddings(): { svc: EmbeddingsService; texts: () => number; reset: () => void } {
  let n = 0;
  const svc = new EmbeddingsService({
    backend: async (texts: string[]) => {
      n += texts.length;
      return texts.map((t) => topicVec(t));
    },
  });
  return { svc, texts: () => n, reset: () => (n = 0) };
}

test('docs/21 §8 (headline — the defect is gone): a warm-store recall embeds ONLY the query (1 text), not the pool (N+1)', async () => {
  const journal = new MemoryJournal();
  const counter = countingEmbeddings();
  const vectors = new FakeVectorStore();
  const mem = new VillagerMemory({
    villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1', embeddings: counter.svc, vectors,
  });

  for (let i = 0; i < 8; i++) mem.remember({ kind: 'event', text: `souvenir numéro ${i}` });
  await mem.flushVectors(); // the per-write embeds land off the hot path
  assert.equal(vectors.upserts, 8, 'every entry embedded once at write (embed-at-write)');

  counter.reset();
  await mem.retrieve('souvenir', 5);
  assert.equal(counter.texts(), 1, 'recall embeds ONLY the query — NOT 1 + pool (the ~7.3 s defect)');
});

test('docs/21 §8 (ranking parity, FR↔EN): the stored cosine lifts a semantically-matched but KEYWORD-POOR French memory above an irrelevant one', async () => {
  const journal = new MemoryJournal();
  const counter = countingEmbeddings();
  const vectors = new FakeVectorStore();
  const mem = new VillagerMemory({
    villager: 'Alban', dataDir: tmp(), journal, worldId: 'w1', embeddings: counter.svc, vectors,
  });
  // Both equally recent + important; the query shares NO keyword with either French text.
  mem.remember({ kind: 'event', text: 'récolter la moisson au champ', importance: 5 }); // topic: wheat
  mem.remember({ kind: 'event', text: 'forger une lame au feu', importance: 5 });        // topic: sword
  await mem.flushVectors();

  const ranked = await mem.retrieve('wheat harvest', 5); // EN query, topic wheat → [1,0,0]
  assert.match(ranked[0]!.text, /moisson/, 'cosine (multilingual stand-in) lifted the keyword-poor FR match');
});

test('docs/21 §8 (R38 floor — embeddings OFF): retrieval equals the pure-keyword ranking and never embeds', async () => {
  const journal = new MemoryJournal();
  const vectors = new FakeVectorStore();
  const mem = new VillagerMemory({
    villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1',
    embeddings: new EmbeddingsService({}), // off → keyword floor
    vectors,
  });
  mem.remember({ kind: 'event', text: 'miner la pierre avec la pioche', importance: 5 });
  mem.remember({ kind: 'event', text: 'il pleuvait hier', importance: 5 });
  await mem.flushVectors();
  assert.equal(vectors.upserts, 0, 'embeddings off → nothing embedded at write either');

  const ranked = await mem.retrieve('pierre pioche', 5);
  assert.match(ranked[0]!.text, /pierre/, 'keyword floor ranks the lexical match first');
});

test('docs/21 §8 (R38 floor — store DISABLED, the extension "failed to load"): keyword floor, and recall does NOT embed the query', async () => {
  const journal = new MemoryJournal();
  const counter = countingEmbeddings();
  const vectors = new FakeVectorStore(false); // enabled() === false (like a load failure / R74)
  const mem = new VillagerMemory({
    villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1', embeddings: counter.svc, vectors,
  });
  mem.remember({ kind: 'event', text: 'miner la pierre avec la pioche', importance: 5 });
  mem.remember({ kind: 'event', text: 'il pleuvait hier', importance: 5 });
  await mem.flushVectors();
  assert.equal(vectors.upserts, 0, 'a disabled store is never written to');

  counter.reset();
  const ranked = await mem.retrieve('pierre pioche', 5);
  assert.equal(counter.texts(), 0, 'no store → no point embedding the query; straight to the keyword floor');
  assert.match(ranked[0]!.text, /pierre/);
});

test('docs/21 §8 (vector lifecycle): eviction keeps the vector (text unchanged); a trim past archiveMax DELETEs it', async () => {
  const journal = new MemoryJournal();
  const counter = countingEmbeddings();
  const vectors = new FakeVectorStore();
  const mem = new VillagerMemory({
    villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1', embeddings: counter.svc, vectors,
    windowMax: 3, evictBatch: 2, archiveMax: 2, // tiny so overflow forces eviction AND a trim
  });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push(mem.remember({ kind: 'event', text: `action ${i}` }).id);
  await mem.flushVectors();

  const live = new Set([...mem.all(), ...mem.archive()].map((e) => e.id));
  const stored = vectors.keys('Firmin');
  assert.equal(stored.size, live.size, 'the store holds exactly the live pool — trimmed entries were deleted');
  for (const id of live) assert.ok(stored.has(id), 'every surviving entry keeps its vector');
  const trimmed = ids.filter((id) => !live.has(id));
  assert.ok(trimmed.length > 0, 'some entries were FIFO-trimmed past archiveMax');
  for (const id of trimmed) assert.ok(!stored.has(id), 'a trimmed entry had its vector deleted');
});

test('docs/21 §8 (backfill): a re-opened store with entries but NO vectors backfills once, then is idempotent', async () => {
  const journal = new MemoryJournal();
  const dir = tmp();
  // Boot A: persist 4 entries to disk WITHOUT a vector store (so the JSON has entries, the store is empty).
  const a = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1' });
  for (let i = 0; i < 4; i++) a.remember({ kind: 'event', text: `souvenir ${i}` });

  // Boot B: same dir, a FRESH (empty) store → construction backfills all 4 (the migration path).
  const counter = countingEmbeddings();
  const store = new FakeVectorStore();
  const b = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1', embeddings: counter.svc, vectors: store });
  await b.flushVectors();
  assert.equal(counter.texts(), 4, 'the boot backfill embedded the 4 pre-existing entries');
  assert.equal(store.keys('Firmin').size, 4);

  // Boot C: same dir, the SAME (now warm) store → backfill is a no-op (idempotent, no re-embed).
  counter.reset();
  const c = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1', embeddings: counter.svc, vectors: store });
  await c.flushVectors();
  assert.equal(counter.texts(), 0, 'every id already has a vector → no bulk re-embed (idempotent)');
});

test('docs/21 §8 (R32 wipe): resolving a quarantine with "wipe" clears the villager namespace in the store', async () => {
  const journal = new MemoryJournal();
  const dir = tmp();
  const counter = countingEmbeddings();
  const store = new FakeVectorStore();
  // World w1: remember + embed → a vector is stored.
  const old = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1', embeddings: counter.svc, vectors: store });
  old.remember({ kind: 'lesson', text: 'croyance du monde mort' });
  await old.flushVectors();
  assert.equal(store.keys('Firmin').size, 1, 'the dead-world vector is stored');

  // Re-boot on a DIFFERENT world → quarantine; wipe must also drop the dead-world vectors.
  const fresh = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w2', embeddings: counter.svc, vectors: store });
  assert.equal(fresh.isQuarantined(), true);
  fresh.resolveQuarantine('wipe');
  assert.equal(store.keys('Firmin').size, 0, 'wipe cleared the villager namespace (R32)');
});
