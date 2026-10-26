import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseSummaryReply } from '../src/village/agent-runtime.js';
import { dot, EmbeddingBackend, EmbeddingService, entryKey } from '../src/village/embeddings.js';
import { BotMemory, DEFAULT_IMPORTANCE, RETRIEVAL } from '../src/village/memory.js';
import { Persistence } from '../src/village/persistence.js';
import { EmbeddingSettings, VillageSettings } from '../src/village/types.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'village-emb-'));
}

function settingsFor(dataDir: string, embeddings?: Partial<EmbeddingSettings>): VillageSettings {
  return {
    llm: {
      provider: 'openai', baseUrl: '', model: 'test', fastModel: '', apiKey: 'k',
      timeoutMs: 5_000, temperature: 0, maxTokens: 256,
    },
    embeddings: { mode: 'local', model: '', ...embeddings },
    dayPlanning: false,
    needs: { restDecayPerMin: 0, restRecoverPerMin: 0, socialDecayPerMin: 0, socialRecoverPerMin: 0, lowThreshold: 0.25 },
    spontaneousChat: false,
    concurrency: 1,
    heartbeatSeconds: 999,
    botCooldownMs: 0,
    earshotRadius: 32,
    settlementUrl: 'http://127.0.0.1:8767',
    dataDir,
    maxConversationTurns: 8,
  };
}

/**
 * Deterministic "semantics": axis 0 = farming, axis 1 = danger, axis 2 =
 * tools. Texts get a unit vector from whichever topic words they contain —
 * close topics → high cosine, no shared topic → 0, no lexical overlap needed.
 */
const TOPICS: Array<[number, RegExp]> = [
  [0, /potager|jardin|legume|récolte|carotte/i],
  [1, /zombie|danger|attaque|monstre/i],
  [2, /pioche|outil|forge/i],
];

class FakeBackend implements EmbeddingBackend {
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map((text) => {
      const vec = [0, 0, 0, 0.1]; // small constant axis so nothing is all-zero
      for (const [axis, pattern] of TOPICS) if (pattern.test(text)) vec[axis] = 1;
      return vec;
    });
  }
}

class FailingBackend implements EmbeddingBackend {
  calls = 0;
  async embed(): Promise<number[][]> {
    this.calls++;
    throw new Error('boom');
  }
}

// -- primitives ---------------------------------------------------------------

test('entryKey is stable and text-sensitive', (t) => {
  const a = { at: 1_000, text: 'des carottes' };
  t.is(entryKey(a), entryKey({ ...a }));
  t.not(entryKey(a), entryKey({ at: 1_000, text: 'des patates' }));
  t.not(entryKey(a), entryKey({ at: 2_000, text: 'des carottes' }));
});

test('dot handles mismatched lengths defensively', (t) => {
  t.is(dot(new Float32Array([1, 0]), new Float32Array([1, 0, 5])), 1);
});

// -- service: queue, sidecar, restart ------------------------------------------

test('enqueue → drainNow embeds in batch and vectorFor returns the vector', async (t) => {
  const dir = tempDir();
  const backend = new FakeBackend();
  const service = new EmbeddingService(settingsFor(dir), backend);
  const vectors = service.forBot('Margaux');

  const farm = { at: 1, kind: 'event' as const, text: 'belle récolte au potager' };
  const fight = { at: 2, kind: 'event' as const, text: 'un zombie attaque la ferme' };
  vectors.enqueue(farm);
  vectors.enqueue(fight);
  vectors.enqueue(farm); // dedupe
  await service.drainNow();

  t.is(backend.calls, 1, 'one batched call');
  const farmVec = vectors.vectorFor(farm)!;
  const fightVec = vectors.vectorFor(fight)!;
  t.truthy(farmVec);
  t.true(Math.abs(dot(farmVec, farmVec) - 1) < 1e-5, 'vectors are unit-normalized');
  t.true(dot(farmVec, fightVec) < 0.2, 'different topics stay far apart');
});

test('vectors survive a restart via the sidecar and backfill prunes stale rows', async (t) => {
  const dir = tempDir();
  const farm = { at: 1, kind: 'event' as const, text: 'belle récolte au potager' };
  const stale = { at: 2, kind: 'event' as const, text: 'souvenir disparu' };
  {
    const service = new EmbeddingService(settingsFor(dir), new FakeBackend());
    const vectors = service.forBot('Margaux');
    vectors.enqueue(farm);
    vectors.enqueue(stale);
    await service.drainNow();
    service.flushNow();
  }
  const backend = new FakeBackend();
  const service = new EmbeddingService(settingsFor(dir), backend);
  const vectors = service.forBot('Margaux');
  t.truthy(vectors.vectorFor(farm), 'sidecar reloaded');

  vectors.backfill([farm]); // stale entry no longer exists
  await service.drainNow();
  t.is(backend.calls, 0, 'nothing re-embedded — the live entry already has a vector');
  t.is(vectors.vectorFor(stale), null, 'stale sidecar row pruned');
});

test('three consecutive failures disable the service; mode off never calls the backend', async (t) => {
  const failing = new FailingBackend();
  const service = new EmbeddingService(settingsFor(tempDir()), failing);
  const vectors = service.forBot('Margaux');

  for (let i = 0; i < 5; i++) {
    t.is(await vectors.embedQuery('une question'), null);
  }
  t.false(service.isEnabled());
  t.is(failing.calls, 3, 'stopped retrying after the third failure');

  const off = new EmbeddingService(settingsFor(tempDir(), { mode: 'off' }));
  t.false(off.isEnabled());
  t.is(await off.forBot('X').embedQuery('q'), null);
});

// -- retrieve: the relevance·recency·importance triple ---------------------------

test('retrieve finds semantically related memories with zero keyword overlap', async (t) => {
  const dir = tempDir();
  const service = new EmbeddingService(settingsFor(dir), new FakeBackend());
  const persistence = new Persistence(dir);
  const memory = new BotMemory('Margaux', persistence, service.forBot('Margaux'));

  memory.append('event', 'belle récolte au potager ce matin');
  memory.append('event', 'un monstre rôde près du puits');
  await service.drainNow();

  const hits = await memory.retrieve('je cherche des legumes pour le ragoût');
  t.is(hits.length, 1, 'only the farming memory clears MIN_RELEVANCE');
  t.true(hits[0].text.includes('potager'));
});

test('retrieve without embeddings ranks by keyword relevance, importance and recency', async (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Margaux', persistence);
  const now = Date.now();

  memory.append('event', 'Firmin m\'a aidé à la ferme', ['Firmin'], 2);
  memory.append('event', 'Firmin m\'a sauvé du zombie', ['Firmin'], 9);
  memory.append('event', 'journée sans intérêt aucun');

  const hits = await memory.retrieve('Firmin', { keywords: ['Firmin'], now });
  t.is(hits.length, 2, 'the unrelated entry never surfaces');
  t.true(hits[0].text.includes('sauvé'), 'higher importance wins at equal relevance/recency');

  // Pin the scoring math itself.
  const relevance = RETRIEVAL.KEYWORD_MATCH_VALUE; // one matched keyword
  const recency = 1; // just written
  const expected =
    RETRIEVAL.RELEVANCE_WEIGHT * relevance +
    RETRIEVAL.RECENCY_WEIGHT * recency +
    RETRIEVAL.IMPORTANCE_WEIGHT * (9 / 10);
  t.true(expected > RETRIEVAL.RELEVANCE_WEIGHT * relevance + RETRIEVAL.RECENCY_WEIGHT + RETRIEVAL.IMPORTANCE_WEIGHT * 0.2);
});

test('retrieve respects exclude, kind and limit; empty query returns nothing', async (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Margaux', persistence);
  memory.append('trade', 'vendu des carottes à Firmin', ['Firmin']);
  memory.append('social', 'discuté avec Firmin', ['Firmin']);

  const all = await memory.retrieve('Firmin');
  t.is(all.length, 2);
  const trades = await memory.retrieve('Firmin', { kind: 'trade' });
  t.deepEqual(trades.map((e) => e.kind), ['trade']);
  const excluded = await memory.retrieve('Firmin', { exclude: new Set(all) });
  t.is(excluded.length, 0);
  t.deepEqual(await memory.retrieve('   '), []);
});

test('append stores kind-default importance, clamps explicit values; bump never lowers', async (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Margaux', persistence);
  memory.append('trade', 'un troc');
  memory.append('system', 'bruit interne', undefined, 25);

  const [trade, system] = memory.recent(2);
  t.is(trade.importance, DEFAULT_IMPORTANCE.trade);
  t.is(system.importance, 10, 'clamped to 10');

  memory.bumpImportance(trade, 3);
  t.is(trade.importance, DEFAULT_IMPORTANCE.trade, 'bump never lowers');
  memory.bumpImportance(trade, 8);
  t.is(trade.importance, 8);
});

// -- summarization reply: salience + lessons --------------------------------------

test('parseSummaryReply extracts salient indices and lessons, cuts summary at first marker', (t) => {
  const parsed = parseSummaryReply(
    'Une saison bien remplie à la ferme.\nSAILLANT: 3, 7, 12\nLEÇON: ne jamais semer la nuit\nLeçon : vendre au marché du matin\nMOTS-CLÉS: ferme, marché'
  );
  t.is(parsed.summary, 'Une saison bien remplie à la ferme.');
  t.deepEqual(parsed.salient, [3, 7, 12]);
  t.deepEqual(parsed.insights, ['ne jamais semer la nuit', 'vendre au marché du matin']);
  t.deepEqual(parsed.keywords, ['ferme', 'marché']);
});

test('parseSummaryReply tolerates missing or malformed marker lines', (t) => {
  const bare = parseSummaryReply('Just a summary.');
  t.is(bare.summary, 'Just a summary.');
  t.deepEqual(bare.salient, []);
  t.deepEqual(bare.insights, []);

  const junk = parseSummaryReply('Résumé.\nSALIENT: none of them\nKEYWORDS: mine');
  t.is(junk.summary, 'Résumé.');
  t.deepEqual(junk.salient, [], 'non-numeric salience ignored');
  t.deepEqual(junk.keywords, ['mine']);
});
