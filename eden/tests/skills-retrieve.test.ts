import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryJournal } from './fakes/memory-journal';
import { SkillLibrary, AllGranted, type DraftInput } from '../src/skills/library';
import { EmbeddingsService, type EmbeddingBackend } from '../src/llm/embeddings';
import { SkillRetriever } from '../src/skills/retrieve';

function freshLibrary(): SkillLibrary {
  const dir = mkdtempSync(join(tmpdir(), 'eden-retrieve-'));
  return new SkillLibrary({ dataDir: dir, journal: new MemoryJournal(), probationRuns: 3 });
}

const seed = (lib: SkillLibrary, name: string, summary: string, tier: 'mortal' | 'divine' = 'mortal', status: 'active' | 'active-probation' = 'active'): void => {
  const input: DraftInput = {
    name,
    summary,
    params: { type: 'object', properties: {} },
    returns: { type: 'object', properties: {} },
    code: `async function ${name.replace(/-/g, '_')}(bot, a, c) { return 1; }`,
    author: { kind: 'stock' },
    tier,
  };
  lib.seedStock(input, status);
};

const off = (): EmbeddingsService => new EmbeddingsService({}); // keyword floor

test('M2-4: ranks by keyword overlap when embeddings are off (R38 floor)', async () => {
  const lib = freshLibrary();
  seed(lib, 'collect-wood', 'couper du bois de chêne');
  seed(lib, 'go-fishing', 'pêcher au lac avec une canne');
  const r = new SkillRetriever({ library: lib, embeddings: off(), grants: new AllGranted() });
  const ranked = await r.search('couper du bois', { tier: 'mortal' });
  assert.equal(ranked[0]?.name, 'collect-wood', 'the wood skill ranks first');
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test('M2-4: uses embedding cosine when embeddings are enabled', async () => {
  const lib = freshLibrary();
  seed(lib, 'alpha', 'topic about iron');
  seed(lib, 'beta', 'topic about wood');
  // A controlled backend: the query aligns with whatever text mentions "wood", regardless of keywords.
  const backend: EmbeddingBackend = (texts) =>
    Promise.resolve(texts.map((t) => (t.includes('wood') ? [1, 0, 0] : t.includes('iron') ? [0, 1, 0] : [0, 0, 1])));
  const embeddings = new EmbeddingsService({ backend });
  const r = new SkillRetriever({ library: lib, embeddings, grants: new AllGranted() });
  // query text mentions wood → cosine puts 'beta' (wood) first even though both share "topic about".
  const ranked = await r.search('wood', { tier: 'mortal' });
  assert.equal(ranked[0]?.name, 'beta');
});

test('M2-4 (P2/tiers): divine skills are invisible to a mortal search, visible to divine', async () => {
  const lib = freshLibrary();
  seed(lib, 'walk', 'aller quelque part', 'mortal');
  seed(lib, 'fly-to', 'voler vers une cible', 'divine');
  const r = new SkillRetriever({ library: lib, embeddings: off(), grants: new AllGranted() });
  const mortal = (await r.search('se déplacer', { tier: 'mortal' })).map((s) => s.name);
  assert.ok(!mortal.includes('fly-to'), 'divine hidden from villagers (not a forbidden temptation)');
  const divine = (await r.search('se déplacer', { tier: 'divine' })).map((s) => s.name);
  assert.ok(divine.includes('fly-to') && divine.includes('walk'), 'God sees both tiers');
});

test('M2-4 (P2): drafts and quarantined versions are never surfaced for normal work', async () => {
  const lib = freshLibrary();
  // A pure draft (never admitted) must not appear.
  lib.upsertDraft({
    name: 'half-baked',
    summary: 'couper du bois experimental',
    params: { type: 'object', properties: {} },
    returns: { type: 'object', properties: {} },
    code: 'async function half_baked(bot, a, c) { return 1; }',
    author: { kind: 'villager', name: 'Firmin' },
  });
  seed(lib, 'collect-wood', 'couper du bois');
  const r = new SkillRetriever({ library: lib, embeddings: off(), grants: new AllGranted() });
  const names = (await r.search('couper du bois', { tier: 'mortal' })).map((s) => s.name);
  assert.ok(!names.includes('half-baked'), 'a draft is runnable only in its rollout, never retrieved');
  assert.ok(names.includes('collect-wood'));
});

test('M2-4: active-probation IS surfaced (runnable + retrievable; only composition is gated, D-12)', async () => {
  const lib = freshLibrary();
  seed(lib, 'probie', 'récolter du blé', 'mortal', 'active-probation');
  const r = new SkillRetriever({ library: lib, embeddings: off(), grants: new AllGranted() });
  const names = (await r.search('récolter du blé', { tier: 'mortal' })).map((s) => s.name);
  assert.ok(names.includes('probie'));
});

test('M2-4: caps results at top-k (default 8)', async () => {
  const lib = freshLibrary();
  for (let i = 0; i < 12; i++) seed(lib, `skill-${i}`, `tâche numéro ${i} couper bois`);
  const r = new SkillRetriever({ library: lib, embeddings: off(), grants: new AllGranted() });
  assert.equal((await r.search('couper bois', { tier: 'mortal' })).length, 8);
  assert.equal((await r.search('couper bois', { tier: 'mortal', k: 3 })).length, 3);
});

test('R58: per-skill vectors are cached — a second search re-embeds only the query, not the library', async () => {
  const lib = freshLibrary();
  for (let i = 0; i < 10; i++) seed(lib, `skill-${i}`, `tâche ${i} couper bois`);
  const embedded: string[][] = [];
  const backend: EmbeddingBackend = (texts) => {
    embedded.push(texts);
    return Promise.resolve(texts.map(() => [1, 0, 0]));
  };
  const r = new SkillRetriever({ library: lib, embeddings: new EmbeddingsService({ backend }), grants: new AllGranted() });

  await r.search('couper bois', { tier: 'mortal' });
  assert.equal(embedded[0]?.length, 11, 'first search embeds the query + all 10 skills');

  await r.search('autre requête', { tier: 'mortal' });
  assert.equal(embedded[1]?.length, 1, 'second search embeds ONLY the query — skill vectors are reused');

  // A NEW skill (new name@version) is the only thing embedded on the next search, alongside the query.
  seed(lib, 'skill-new', 'planter des graines');
  await r.search('encore', { tier: 'mortal' });
  assert.equal(embedded[2]?.length, 2, 'third search embeds the query + the one new skill');
});

test('R58: a re-described version (text changed at admission) is re-embedded, stale vector dropped', async () => {
  const lib = freshLibrary();
  seed(lib, 'probie', 'résumé initial', 'mortal', 'active-probation');
  const version = lib.activeVersion('probie')!.version;
  const embedded: string[][] = [];
  const backend: EmbeddingBackend = (texts) => {
    embedded.push(texts);
    return Promise.resolve(texts.map(() => [1, 0, 0]));
  };
  const r = new SkillRetriever({ library: lib, embeddings: new EmbeddingsService({ backend }), grants: new AllGranted() });

  await r.search('q', { tier: 'mortal' });
  assert.equal(embedded[0]?.length, 2, 'query + the one skill');

  // The description-from-code pass mutates the manifest text AFTER first retrieval (admit → live → describe).
  lib.applyDescription('probie', version, { description: 'description riche dérivée du code' });
  await r.search('q', { tier: 'mortal' });
  assert.equal(embedded[1]?.length, 2, 'changed text forces a re-embed (query + the skill), not a stale reuse');
});

test('M2-4: returns the prompt-facing one-liner fields (name — signature — summary)', async () => {
  const lib = freshLibrary();
  seed(lib, 'collect-wood', 'couper du bois');
  const r = new SkillRetriever({ library: lib, embeddings: off(), grants: new AllGranted() });
  const top = (await r.search('couper du bois', { tier: 'mortal' }))[0];
  assert.equal(top?.name, 'collect-wood');
  assert.match(top?.signature ?? '', /collect-wood/);
  assert.equal(top?.summary, 'couper du bois');
});
