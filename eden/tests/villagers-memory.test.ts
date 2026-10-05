// M6-1 — villagers/memory.ts (the full memory port). Proofs (plan §4):
//   • eviction → archive + rolling life summary (fast LLM, ScriptedLlm) with keyword/importance/lesson
//     enrichment;
//   • retrieval ranking — the 0.5·relevance + 0.25·recency(2 h half-life) + 0.25·importance blend,
//     relevance = max(embedding cosine, keyword overlap);
//   • R32 — a memory carrying a DIFFERENT world-id is quarantined behind an admin decision (not silently
//     used, not silently dropped).
// All on the fakes (no Minecraft, no real model). DROP refuteBlockedBeliefs (the critic owns R37).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryJournal } from './fakes/memory-journal';
import { ScriptedLlm } from './fakes/scripted-llm';
import { EmbeddingsService } from '../src/llm/embeddings';
import { LlmClient, ProviderRegistry } from '../src/llm/client';
import { VillagerMemory, MemorySummarizer } from '../src/villagers/memory';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'eden-mem-'));
}

/** A clock you can advance (recency half-life depends on it). */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('M6-1: remember adds to the window; recent() returns newest-first', () => {
  const journal = new MemoryJournal();
  const mem = new VillagerMemory({ villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1' });
  mem.remember({ kind: 'event', text: 'mined oak logs' });
  mem.remember({ kind: 'social', text: 'salua Pilou' });
  const recent = mem.recent(5);
  assert.equal(recent.length, 2);
  assert.match(recent[0]!, /salua Pilou/, 'newest first');
});

test('M6-1: importance is heuristic by kind when omitted; lessons rank highest', () => {
  const journal = new MemoryJournal();
  const mem = new VillagerMemory({ villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1' });
  mem.remember({ kind: 'system', text: 'boot' });
  mem.remember({ kind: 'lesson', text: 'sans pioche on ne mine pas la pierre' });
  const entries = mem.all();
  const lesson = entries.find((e) => e.kind === 'lesson')!;
  const system = entries.find((e) => e.kind === 'system')!;
  assert.ok(lesson.importance > system.importance, 'a lesson outranks a system note');
});

test('M6-1 (eviction → archive + summary): overflowing the window evicts the oldest batch into the archive AND folds it into a rolling life summary (fast LLM)', async () => {
  const journal = new MemoryJournal();
  const dir = tmp();
  // ScriptedLlm returns the summarizer's structured JSON (life summary + tag/importance/lesson enrichment).
  const llm = await ScriptedLlm.start([
    {
      content: JSON.stringify({
        summary: 'Firmin a passé sa journée à miner du bois et de la pierre.',
        tags: { 'entry-0': ['bois', 'récolte'] },
        importanceBumps: { 'entry-0': 9 },
        lessons: ['Le bois se récolte plus vite avec une hache.'],
      }),
      finishReason: 'stop',
    },
  ]);
  const client = new LlmClient({
    providers: new ProviderRegistry({
      strong: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 48000 },
      fast: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 16000 },
    }),
    journal,
  });
  const summarizer = new MemorySummarizer(client);

  const mem = new VillagerMemory({
    villager: 'Firmin',
    dataDir: dir,
    journal,
    worldId: 'w1',
    windowMax: 4, // tiny window so 5 entries forces ONE eviction batch
    evictBatch: 2,
    archiveMax: 2000,
    summarizer,
  });

  for (let i = 0; i < 5; i++) mem.remember({ kind: 'event', text: `action ${i}` });
  await mem.flushSummary(); // the summarization runs off the hot path; the test awaits it

  // The window kept at most windowMax; the evicted batch landed in the archive.
  assert.ok(mem.all().length <= 4, 'window stays bounded');
  assert.ok(mem.archive().length >= 2, 'evicted batch persisted to the archive');

  // The rolling life summary was produced by the fast LLM and is readable.
  assert.match(mem.lifeSummary(), /miner du bois/);
  // The summarizer call was a FAST-tier call (D-13: summarization is cheap, not novelty).
  const llmCalls = journal.events.filter((e) => e.kind === 'llm.call');
  assert.ok(llmCalls.some((e) => (e.payload as { tier: string }).tier === 'fast'), 'a fast-tier summarizer call');
  // A LESSON memory was seeded from the enrichment.
  assert.ok(mem.all().some((e) => e.kind === 'lesson' && /hache/.test(e.text)), 'a lesson memory was folded in');

  await llm.close();
});

test('M6-1 (summary is best-effort): a broken summarizer reply never throws into the flow — entries still evict + persist', async () => {
  const journal = new MemoryJournal();
  const llm = await ScriptedLlm.start([{ content: 'not json at all', finishReason: 'stop' }]);
  const client = new LlmClient({
    providers: new ProviderRegistry({
      strong: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 48000 },
      fast: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 16000 },
    }),
    journal,
  });
  const mem = new VillagerMemory({
    villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1',
    windowMax: 4, evictBatch: 2, summarizer: new MemorySummarizer(client),
  });
  for (let i = 0; i < 5; i++) mem.remember({ kind: 'event', text: `a${i}` });
  await assert.doesNotReject(mem.flushSummary());
  assert.ok(mem.archive().length >= 2, 'eviction persisted despite a bad summary reply');
  await llm.close();
});

test('M6-1 (retrieval ranking): the 0.5·relevance + 0.25·recency(2h) + 0.25·importance blend ranks a relevant, recent, important memory above an old, irrelevant one', async () => {
  const journal = new MemoryJournal();
  const clock = fakeClock();
  const mem = new VillagerMemory({
    villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1',
    embeddings: new EmbeddingsService({}), // off → keyword floor (deterministic)
    now: clock.now,
  });

  // An OLD, low-importance, irrelevant memory.
  mem.remember({ kind: 'event', text: 'il pleuvait hier', importance: 1 });
  clock.advance(4 * 60 * 60 * 1000); // 4 h later (≥ 2 half-lives)
  // A RECENT, high-importance, ON-TOPIC memory.
  mem.remember({ kind: 'event', text: 'miner pierre avec pioche', importance: 9 });

  const ranked = await mem.retrieve('pierre pioche', 5);
  assert.ok(ranked.length >= 1);
  assert.match(ranked[0]!.text, /pierre/, 'the relevant+recent+important memory ranks first');
});

test('M6-1 (recency half-life): two equally-relevant, equally-important memories rank by recency (2 h half-life)', async () => {
  const journal = new MemoryJournal();
  const clock = fakeClock();
  const mem = new VillagerMemory({
    villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1',
    embeddings: new EmbeddingsService({}), now: clock.now,
  });
  mem.remember({ kind: 'event', text: 'récolte pierre matin', importance: 5 });
  clock.advance(2 * 60 * 60 * 1000); // one half-life
  mem.remember({ kind: 'event', text: 'récolte pierre soir', importance: 5 });
  const ranked = await mem.retrieve('récolte pierre', 5);
  assert.match(ranked[0]!.text, /soir/, 'the more recent of two equal memories ranks first');
});

test('M6-1: relevance = max(embedding cosine, keyword overlap) — a semantic backend lifts a keyword-poor match', async () => {
  const journal = new MemoryJournal();
  // A backend that returns identical vectors for the query + one entry (cosine 1) and orthogonal for the
  // other — so the "semantically identical but keyword-poor" entry wins on the cosine half of max(...).
  const embeddings = new EmbeddingsService({
    backend: async (texts: string[]) =>
      texts.map((t) => (t.includes('cible') ? [1, 0, 0] : t.includes('bruit') ? [0, 1, 0] : [1, 0, 0])),
  });
  const mem = new VillagerMemory({ villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1', embeddings });
  mem.remember({ kind: 'event', text: 'cible importante', importance: 5 });
  mem.remember({ kind: 'event', text: 'bruit de fond', importance: 5 });
  const ranked = await mem.retrieve('cible', 5);
  assert.match(ranked[0]!.text, /cible/, 'the cosine-matched entry ranks first');
});

test('M6-1 (relations): moveRelation accumulates a score + replaces the note; relations() reflects it', () => {
  const journal = new MemoryJournal();
  const mem = new VillagerMemory({ villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1' });
  mem.moveRelation('Pilou', 2, 'partage du bois');
  const r = mem.moveRelation('Pilou', 3, 'bon partenaire de troc');
  assert.equal(r.score, 5, 'scores accumulate');
  assert.match(r.note, /troc/, 'the note is replaced by the latest');
  assert.equal(mem.relations().find((x) => x.other === 'Pilou')?.score, 5);
});

test('M6-1 (persistence): a re-opened store on the SAME world reloads its window + archive + relations', () => {
  const journal = new MemoryJournal();
  const dir = tmp();
  const a = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1' });
  a.remember({ kind: 'event', text: 'persistera-t-il ?' });
  a.moveRelation('Pilou', 1, 'voisin');
  const b = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1' });
  assert.ok(b.all().some((e) => /persistera/.test(e.text)), 'window reloaded');
  assert.equal(b.relations().find((x) => x.other === 'Pilou')?.score, 1, 'relations reloaded');
});

test('M6-1 (R32): a persisted store from a DIFFERENT world is QUARANTINED behind an admin decision — not silently used, not silently dropped', () => {
  const journal = new MemoryJournal();
  const dir = tmp();
  // Boot once on world w1 and persist real memories + a relation.
  const old = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1' });
  old.remember({ kind: 'lesson', text: 'pas de graines dans ce monde' }); // the classic poisoned belief
  old.moveRelation('Pilou', 4, 'ami');

  // Re-boot on a DIFFERENT world id.
  const fresh = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w2' });

  // Quarantined: the poisoned belief is NOT in the live window, but it is NOT lost either.
  assert.equal(fresh.isQuarantined(), true, 'a world mismatch quarantines persisted state');
  assert.ok(!fresh.all().some((e) => /graines/.test(e.text)), 'quarantined memories are not silently used');
  assert.ok(fresh.quarantinedCount() >= 1, 'the quarantined memories are held for the admin decision');

  // The admin decides. WIPE drops them; MIGRATE adopts them.
  const wiped = new VillagerMemory({ villager: 'Firmin', dataDir: tmp(), journal, worldId: 'w1' });
  void wiped;
});

test('M6-1 (R32 admin decision: wipe): wipe clears the quarantine and adopts the new world id', () => {
  const journal = new MemoryJournal();
  const dir = tmp();
  const old = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1' });
  old.remember({ kind: 'lesson', text: 'belief from a dead world' });

  const fresh = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w2' });
  assert.equal(fresh.isQuarantined(), true);
  fresh.resolveQuarantine('wipe');
  assert.equal(fresh.isQuarantined(), false, 'wipe clears the quarantine');
  assert.equal(fresh.all().length, 0, 'wipe dropped the dead-world memories');

  // A subsequent boot on w2 is clean (the stamp was adopted).
  const after = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w2' });
  assert.equal(after.isQuarantined(), false, 'the new world id is now the stamp');
});

test('M6-1 (R32 admin decision: migrate): migrate adopts the quarantined memories into the new world', () => {
  const journal = new MemoryJournal();
  const dir = tmp();
  const old = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1' });
  old.remember({ kind: 'event', text: 'a memory worth keeping' });

  const fresh = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w2' });
  assert.equal(fresh.isQuarantined(), true);
  fresh.resolveQuarantine('migrate');
  assert.equal(fresh.isQuarantined(), false);
  assert.ok(fresh.all().some((e) => /worth keeping/.test(e.text)), 'migrate adopted the memories');
});

test('M6-1 (R37 dropped): VillagerMemory exposes NO refuteBlockedBeliefs — the critic owns belief retirement', () => {
  const mem = new VillagerMemory({ villager: 'Firmin', dataDir: tmp(), journal: new MemoryJournal(), worldId: 'w1' });
  assert.equal((mem as unknown as Record<string, unknown>)['refuteBlockedBeliefs'], undefined);
});

test('M6-1 (persistence file): memory is written under the data dir per villager (S2 sole writer)', () => {
  const journal = new MemoryJournal();
  const dir = tmp();
  const mem = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1' });
  mem.remember({ kind: 'event', text: 'x' });
  const f = join(dir, 'bots', 'Firmin.json');
  assert.ok(existsSync(f), 'per-bot file exists');
  const data = JSON.parse(readFileSync(f, 'utf8')) as { memory?: unknown };
  assert.ok(data.memory !== undefined, 'memory state under the bot file (alongside anchors/subscriptions)');
});

// ── Coverage: MemorySummarizer parse robustness (audit 2026-06-14) ────────────────────────────────
// The summarizer must tolerate the shapes a real LLM actually emits — fenced JSON, surrounding prose —
// and degrade (return null) on anything unusable, NEVER throw (it runs inside eviction). These cover the
// extractJson fenced branch + the empty-batch and missing-summary early returns that VillagerMemory's
// happy-path test didn't reach.

async function summarizerHarness(content: string | null): Promise<{ result: import('../src/villagers/memory-summarizer').SummaryResult | null; close: () => Promise<void> }> {
  const journal = new MemoryJournal();
  const turns = content === null ? [] : [{ content, finishReason: 'stop' as const }];
  const llm = await ScriptedLlm.start(turns);
  const client = new LlmClient({
    providers: new ProviderRegistry({
      strong: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 48000 },
      fast: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 16000 },
    }),
    journal,
  });
  const summarizer = new MemorySummarizer(client);
  const evicted = [{ kind: 'event' as const, text: 'mined oak', importance: 3, at: 0, tags: [] }];
  const result = await summarizer.summarize('Firmin', '', evicted);
  return { result, close: () => llm.close() };
}

test('M6-1 (summarizer): a ```json-fenced reply with surrounding prose is parsed (extractJson)', async () => {
  const h = await summarizerHarness('Voici le résumé:\n```json\n{"summary":"Firmin a miné du chêne.","lessons":["Le bois brûle."]}\n```\nVoilà.');
  try {
    assert.ok(h.result, 'a fenced JSON reply parses');
    assert.match(h.result!.summary, /chêne/);
    assert.deepEqual(h.result!.lessons, ['Le bois brûle.']);
  } finally {
    await h.close();
  }
});

test('M6-1 (summarizer): a reply with NO summary field degrades to null (never a partial)', async () => {
  const h = await summarizerHarness('{"lessons":["sans résumé"]}');
  try {
    assert.equal(h.result, null, 'a missing summary → null (the batch still archives upstream)');
  } finally {
    await h.close();
  }
});

test('M6-1 (summarizer): an empty eviction batch returns null without an LLM call', async () => {
  const journal = new MemoryJournal();
  const llm = await ScriptedLlm.start([]);
  const client = new LlmClient({
    providers: new ProviderRegistry({
      strong: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 48000 },
      fast: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 16000 },
    }),
    journal,
  });
  try {
    const result = await new MemorySummarizer(client).summarize('Firmin', 'résumé existant', []);
    assert.equal(result, null);
    assert.equal(llm.requests.length, 0, 'an empty batch never calls the model');
  } finally {
    await llm.close();
  }
});

test('bug #16: reset() forgets the live life, and a summary already in flight does not write it back', async () => {
  const journal = new MemoryJournal();
  const dir = tmp();
  const llm = await ScriptedLlm.start([
    { content: JSON.stringify({ summary: 'ancienne vie', lessons: ['ancienne leçon'] }), finishReason: 'stop' },
  ]);
  const client = new LlmClient({
    providers: new ProviderRegistry({
      strong: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 48000 },
      fast: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 16000 },
    }),
    journal,
  });
  const mem = new VillagerMemory({
    villager: 'Firmin', dataDir: dir, journal, worldId: 'w1',
    windowMax: 4, evictBatch: 2, archiveMax: 2000, summarizer: new MemorySummarizer(client),
  });
  for (let i = 0; i < 5; i++) mem.remember({ kind: 'event', text: `action ${i}` });
  mem.moveRelation('Alban', 10, 'ami');
  mem.reset(); // the summarization scheduled by the eviction is still in flight
  await mem.flushSummary();
  assert.deepEqual(mem.all(), []);
  assert.deepEqual(mem.archive(), []);
  assert.deepEqual(mem.relations(), []);
  assert.equal(mem.lifeSummary(), '', 'the in-flight summary of the old life was dropped');
  await llm.close();
});
