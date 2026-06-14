import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptedLlm } from './fakes/scripted-llm';
import { MemoryJournal } from './fakes/memory-journal';
import { LlmClient, ProviderRegistry } from '../src/llm/client';
import { SkillLibrary } from '../src/skills/library';
import { DescriptionPass } from '../src/skills/describe';

function clientFor(url: string): LlmClient {
  const providers = new ProviderRegistry({
    strong: { baseUrl: url, model: 'strong', inputTokenBudget: 48000 },
    fast: { baseUrl: url, model: 'fast', inputTokenBudget: 16000 },
  });
  return new LlmClient({ providers, journal: new MemoryJournal() });
}

const CODE = 'async function harvestField(bot, { center, radius = 8 }, ctx) { return { harvested: 12 }; }';

test('M2-5: derives description/summary/tags from the code via the fast tier (ScriptedLLM)', async () => {
  const llm = await ScriptedLlm.start([
    { content: JSON.stringify({ description: 'Harvests a wheat field around a center point.', summary: 'harvest a field', tags: ['farming', 'harvest'] }) },
  ]);
  try {
    const pass = new DescriptionPass(clientFor(llm.url));
    const patch = await pass.derive('harvest-field', CODE);
    assert.match(patch.description, /Harvests a wheat field/);
    assert.equal(patch.summary, 'harvest a field');
    assert.deepEqual(patch.tags, ['farming', 'harvest']);
    // It used the FAST tier (D-13: descriptions are cheap, not novelty).
    assert.equal(llm.requests[0].body.model, 'fast');
  } finally {
    await llm.close();
  }
});

test('M2-5: tolerates a fenced ```json block in the model reply', async () => {
  const llm = await ScriptedLlm.start([
    { content: '```json\n{"description":"Does a thing.","summary":"do thing","tags":["misc"]}\n```' },
  ]);
  try {
    const pass = new DescriptionPass(clientFor(llm.url));
    const patch = await pass.derive('do-thing', CODE);
    assert.equal(patch.summary, 'do thing');
  } finally {
    await llm.close();
  }
});

test('M2-5: falls back gracefully when the reply is not JSON (never throws into admission)', async () => {
  const llm = await ScriptedLlm.start([{ content: 'I cannot do that.' }]);
  try {
    const pass = new DescriptionPass(clientFor(llm.url));
    const patch = await pass.derive('mystery', CODE);
    assert.ok(patch.description.length > 0, 'a non-empty fallback description');
    assert.equal(patch.summary, undefined, 'no summary proposed when parsing fails — keep the author’s');
  } finally {
    await llm.close();
  }
});

test('M2-5: admission triggers the pass — the derived description replaces the draft’s (02 §Description-from-code)', async () => {
  const llm = await ScriptedLlm.start([
    { content: JSON.stringify({ description: 'A precise generated description.', summary: 'cut wood', tags: ['wood'] }) },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'eden-describe-'));
  const library = new SkillLibrary({ dataDir: dir, journal: new MemoryJournal(), probationRuns: 3 });
  try {
    const v = library.upsertDraft({
      name: 'collect-wood',
      summary: 'collecte du bois (auteur)',
      params: { type: 'object', properties: {} },
      returns: { type: 'object', properties: {} },
      code: CODE,
      author: { kind: 'villager', name: 'Firmin' },
    });
    library.admit('collect-wood', v.version, { rolloutId: 'r1', verdictId: 'v1' });
    // The admission flow (M3 wires this at the critic) runs the pass + patches the manifest.
    const pass = new DescriptionPass(clientFor(llm.url));
    const patch = await pass.derive('collect-wood', CODE);
    library.applyDescription('collect-wood', v.version, patch);
    const manifest = library.read('collect-wood')?.manifest;
    assert.equal(manifest?.description, 'A precise generated description.');
    assert.equal(manifest?.summary, 'cut wood', 'the derived summary replaces the author’s at admission');
  } finally {
    await llm.close();
  }
});
