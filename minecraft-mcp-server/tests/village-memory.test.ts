import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildRecallBlock, parseSummaryReply } from '../src/village/agent-runtime.js';
import { MemoryIndex, normalizeKeyword, tagsFor, tokenize } from '../src/village/memory-index.js';
import { BotMemory } from '../src/village/memory.js';
import { Persistence } from '../src/village/persistence.js';
import { MemoryEntry, ThinkRequest } from '../src/village/types.js';
import { Villager } from '../src/village/villager.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'village-mem-'));
}

function entry(at: number, kind: MemoryEntry['kind'], text: string, tags?: string[]): MemoryEntry {
  return { at, kind, text, tags: tagsFor(text, tags) };
}

// -- tokenizer ---------------------------------------------------------------

test('normalizeKeyword strips accents and plural s', (t) => {
  t.is(normalizeKeyword('été'), 'ete');
  t.is(normalizeKeyword('blessé'), 'blesse');
  t.is(normalizeKeyword('carottes'), 'carotte');
  t.is(normalizeKeyword('carotte'), 'carotte');
  // 3-char words keep their s (the strip is only for length > 3).
  t.is(normalizeKeyword('les'), 'les');
});

test('tokenize handles French elisions, stopwords and dedupes', (t) => {
  const words = tokenize("J'ai été blessé par le Zombie près des carottes !");
  t.true(words.includes('blesse'));
  t.true(words.includes('zombie'));
  t.true(words.includes('carotte'));
  t.false(words.includes('ete'), 'été is a stopword');
  t.false(words.includes('les'));
  t.false(words.includes('ai'), 'elision fragments are too short');
  t.deepEqual(words, Array.from(new Set(words)), 'no duplicates');
});

test('tagsFor keeps explicit tags first and caps the total', (t) => {
  const tags = tagsFor('un deux trois quatre cinq six sept huit neuf onze douze treize quatorze quinze seize', ['Firmin', 'carottes']);
  t.is(tags[0], 'firmin');
  t.is(tags[1], 'carotte');
  t.true(tags.length <= 16);
});

// -- inverted index ------------------------------------------------------------

test('index scores by distinct matched keywords, recency breaks ties', (t) => {
  const index = new MemoryIndex();
  const both = entry(1_000, 'trade', 'échange avec Firmin: carottes contre planches', ['Firmin']);
  const oneOld = entry(2_000, 'social', 'Firmin m\'a salué', ['Firmin']);
  const oneNew = entry(3_000, 'social', 'Firmin est passé devant la ferme', ['Firmin']);
  for (const e of [both, oneOld, oneNew]) index.add(e);

  const results = index.search(['firmin', 'carottes']);
  t.is(results[0], both, 'two keyword matches outrank one');
  t.is(results[1], oneNew, 'recency breaks the tie');
  t.is(results[2], oneOld);
});

test('index filters by kind and removes entries cleanly', (t) => {
  const index = new MemoryIndex();
  const social = entry(1_000, 'social', 'Firmin parle', ['Firmin']);
  const trade = entry(2_000, 'trade', 'Firmin achète', ['Firmin']);
  index.add(social);
  index.add(trade);
  t.deepEqual(index.search(['firmin'], { kind: 'trade' }), [trade]);
  index.remove(trade);
  t.deepEqual(index.search(['firmin']), [social]);
});

// -- BotMemory: append, archive, recall ----------------------------------------

test('append tags entries and recall finds them by keyword', (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Margaux', persistence);
  memory.append('social', 'Firmin m\'a dit: je cherche des carottes', ['Firmin', 'Margaux']);
  memory.append('event', 'je suis tombée dans la mine');

  const hits = memory.recall('carottes Firmin');
  t.is(hits.length, 1);
  t.true(hits[0].text.includes('carottes'));
  t.true(hits[0].tags!.includes('firmin'));
  t.is(memory.recall('mine').length, 1);
  t.is(memory.recall('diamant').length, 0);
});

test('window overflow archives a batch and keeps it recallable; cap trims the index', (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Margaux', persistence);
  memory.append('event', 'le zanzibar unique du tout début');
  for (let i = 0; i < 3_000; i++) {
    memory.append('event', `note numero${i} carotte`);
  }

  t.true(memory.windowSize() <= 200);
  t.is(memory.archiveSize(), 2_000, 'archive trimmed to its cap');
  t.true(memory.needsSummarization());
  t.true(memory.recall('carotte').length > 0, 'archived entries stay searchable');
  t.is(memory.recall('zanzibar').length, 0, 'entries trimmed from the archive leave the index');
});

test('takeSummarizationBatch returns the pending tail and leaves it archived', (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Margaux', persistence);
  // Eviction fires once at append #201 (window 201 → 121); #280 refills to exactly 200.
  for (let i = 0; i < 280; i++) memory.append('event', `souvenir numero${i}`);

  t.is(memory.pendingSummarizationCount(), 80, 'one eviction batch pending');
  const batch = memory.takeSummarizationBatch();
  t.is(batch.length, 80);
  t.false(memory.needsSummarization());
  t.is(memory.archiveSize(), 80, 'the batch stays in the archive');
  t.deepEqual(memory.takeSummarizationBatch(), []);
});

test('enrichTags makes archived entries findable by new keywords', (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Margaux', persistence);
  for (let i = 0; i < 280; i++) memory.append('event', `souvenir numero${i}`);
  const batch = memory.takeSummarizationBatch();

  t.is(memory.recall('expedition').length, 0);
  memory.enrichTags(batch, ['expédition', 'Firmin']);
  t.is(memory.recall('expedition').length, 8, 'enriched entries surface (limit applies)');
  t.true(memory.recall('firmin').length > 0);
});

test('state survives a restart, including old-format files without tags', (t) => {
  const dir = tempDir();
  {
    const persistence = new Persistence(dir);
    const memory = new BotMemory('Margaux', persistence);
    for (let i = 0; i < 280; i++) memory.append('event', `souvenir numero${i} carotte`);
    persistence.flushNow();
  }
  {
    const persistence = new Persistence(dir);
    const memory = new BotMemory('Margaux', persistence);
    t.is(memory.pendingSummarizationCount(), 80, 'pending counter persisted');
    t.true(memory.recall('carotte').length > 0, 'archive recallable after reload');
  }

  // Old-format bot file: no tags, no archive fields.
  fs.writeFileSync(
    path.join(dir, 'bots', 'Vieux.json'),
    JSON.stringify({
      skills: [],
      memories: [{ at: 123, kind: 'social', text: 'Firmin m\'a vendu des carottes' }],
      memorySummary: '',
      relations: {},
    }),
    'utf8'
  );
  const persistence = new Persistence(dir);
  const memory = new BotMemory('Vieux', persistence);
  t.is(memory.archiveSize(), 0);
  t.false(memory.needsSummarization());
  const hits = memory.recall('carottes');
  t.is(hits.length, 1, 'untagged old entries are tokenized lazily and indexed');
});

// -- ledger search ---------------------------------------------------------------

test('searchLedger matches by item id and party name', (t) => {
  const persistence = new Persistence(tempDir());
  persistence.appendLedger({
    at: 1_000, a: 'Margaux', b: 'Firmin',
    aGave: [{ item: 'carrot', count: 32 }], bGave: [{ item: 'oak_planks', count: 8 }],
  });
  persistence.appendLedger({
    at: 2_000, a: 'Enclume', b: 'Margaux',
    aGave: [{ item: 'iron_pickaxe', count: 1 }], bGave: [{ item: 'coin', count: 12 }],
  });

  t.is(persistence.searchLedger('Margaux', ['carrot']).length, 1);
  t.is(persistence.searchLedger('Margaux', ['firmin']).length, 1);
  t.is(persistence.searchLedger('Margaux', ['coin']).length, 1);
  t.is(persistence.searchLedger('Firmin', ['coin']).length, 0, 'scoped to the asking bot');
  t.is(persistence.searchLedger('Margaux', ['diamond']).length, 0);
});

// -- summarize reply parsing ------------------------------------------------------

test('parseSummaryReply splits summary and keyword line', (t) => {
  const fr = parseSummaryReply('Il a vendu des carottes à Firmin.\nMOTS-CLÉS: Firmin, carottes, ferme');
  t.is(fr.summary, 'Il a vendu des carottes à Firmin.');
  t.deepEqual(fr.keywords, ['Firmin', 'carottes', 'ferme']);

  const en = parseSummaryReply('Sold tools all week.\nKEYWORDS: tools, Enclume');
  t.is(en.summary, 'Sold tools all week.');
  t.deepEqual(en.keywords, ['tools', 'Enclume']);

  const spaced = parseSummaryReply('Résumé.\nMots-clés : mine, fer');
  t.deepEqual(spaced.keywords, ['mine', 'fer']);
});

test('parseSummaryReply falls back to whole-text summary when malformed', (t) => {
  const parsed = parseSummaryReply('Just a summary, the model forgot the keyword line. MOTS-CLÉS inline does not count.');
  t.deepEqual(parsed.keywords, []);
  t.true(parsed.summary.startsWith('Just a summary'));
});

// -- auto-injection ---------------------------------------------------------------

function recallVillager(memory: BotMemory): Villager {
  return { name: 'Margaux', memory } as unknown as Villager;
}

function thinkReq(reasons: string[]): ThinkRequest {
  return { botName: 'Margaux', kind: 'heartbeat', reasons, enqueuedAt: Date.now() };
}

const QUIET_OBSERVATION = { inConversationWith: null, nearby: { villagers: [], players: [] } };

test('buildRecallBlock surfaces older matching memories but not recent ones', async (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Margaux', persistence);
  memory.append('trade', 'échange conclu avec Firmin: carottes contre planches', ['Firmin']);
  for (let i = 0; i < 12; i++) memory.append('event', `remplissage numero${i}`);

  const block = await buildRecallBlock(
    recallVillager(memory),
    thinkReq(['Firmin is waiting on your reply']),
    [],
    QUIET_OBSERVATION,
    memory.recent(12)
  );
  t.truthy(block);
  t.true(block!.startsWith('RELEVANT OLDER MEMORIES'));
  t.true(block!.includes('carottes'));
});

test('buildRecallBlock is null when matches are already recent or keywords are empty', async (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Margaux', persistence);
  memory.append('trade', 'échange conclu avec Firmin', ['Firmin']);

  const dedupedAway = await buildRecallBlock(
    recallVillager(memory),
    thinkReq(['Firmin is waiting']),
    [],
    QUIET_OBSERVATION,
    memory.recent(12)
  );
  t.is(dedupedAway, null, 'the only match is already in RECENT MEMORIES');

  const noKeywords = await buildRecallBlock(recallVillager(memory), thinkReq([]), [], QUIET_OBSERVATION, []);
  t.is(noKeywords, null);
});

test('buildRecallBlock picks up nearby names and inbox senders', async (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Margaux', persistence);
  memory.append('social', 'Enclume m\'a vendu une pioche', ['Enclume']);
  for (let i = 0; i < 12; i++) memory.append('event', `remplissage numero${i}`);

  const observation = { inConversationWith: null, nearby: { villagers: [{ name: 'Enclume' }], players: [] } };
  const block = await buildRecallBlock(recallVillager(memory), thinkReq(['heartbeat']), [], observation, memory.recent(12));
  t.truthy(block);
  t.true(block!.includes('pioche'));
});
