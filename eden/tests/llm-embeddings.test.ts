import test from 'node:test';
import assert from 'node:assert/strict';

import { ScriptedLlm } from './fakes/scripted-llm';
import {
  EmbeddingsService,
  cosine,
  keywordScore,
  providerBackend,
  type EmbeddingBackend,
} from '../src/llm/embeddings';

test('cosine is 1 for identical vectors, 0 for orthogonal, handles zero', () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test('keywordScore is the embeddings-off floor — overlap, multilingual (accents kept)', () => {
  assert.ok(keywordScore('couper du bois', 'aller couper du bois de chêne') > 0);
  assert.equal(keywordScore('mine iron ore', 'go fishing at the lake'), 0);
  // Accented French tokens are not stripped to nothing.
  assert.ok(keywordScore('récolter blé', 'récolter le blé mûr') > 0);
});

test('M2-L2: embeds via a /v1/embeddings provider backend and ranks by cosine', async () => {
  const llm = await ScriptedLlm.start();
  try {
    const svc = new EmbeddingsService({ backend: providerBackend(llm.url, 'embed-model') });
    const vecs = await svc.embed(['couper du bois', 'couper du bois']);
    assert.ok(vecs);
    assert.equal(vecs!.length, 2);
    // ScriptedLlm hashes input deterministically, so identical text → identical vectors → cosine 1.
    assert.ok(Math.abs(cosine(vecs![0]!, vecs![1]!) - 1) < 1e-9);
  } finally {
    await llm.close();
  }
});

// ── R38: three consecutive failures degrade to keyword-only for the run ──────
test('R38: 3 consecutive embedding failures disable embeddings for the run', async () => {
  let calls = 0;
  const failing: EmbeddingBackend = () => {
    calls++;
    return Promise.reject(new Error('model load failed'));
  };
  const warnings: string[] = [];
  const svc = new EmbeddingsService({ backend: failing, maxFailures: 3, onWarn: (m) => warnings.push(m) });
  assert.equal(svc.enabled(), true);
  assert.equal(await svc.embed(['a']), null); // failure 1
  assert.equal(await svc.embed(['b']), null); // failure 2
  assert.equal(svc.enabled(), true, 'still trying before the threshold');
  assert.equal(await svc.embed(['c']), null); // failure 3 → degrade
  assert.equal(svc.enabled(), false, 'degraded to keyword floor for the rest of the run (R38)');
  // Once degraded, the backend is not called again — retrieval is on the keyword floor.
  assert.equal(await svc.embed(['d']), null);
  assert.equal(calls, 3, 'no further backend calls after degrade');
  assert.ok(warnings.some((w) => /embedding/i.test(w)));
});

test('R38: a success resets the consecutive-failure counter', async () => {
  let n = 0;
  const flaky: EmbeddingBackend = (texts) => {
    n++;
    if (n === 1 || n === 2) return Promise.reject(new Error('blip'));
    return Promise.resolve(texts.map(() => [1, 0, 0]));
  };
  const svc = new EmbeddingsService({ backend: flaky, maxFailures: 3 });
  await svc.embed(['x']); // fail 1
  await svc.embed(['y']); // fail 2
  const ok = await svc.embed(['z']); // success → counter resets
  assert.deepEqual(ok, [[1, 0, 0]]);
  await svc.embed(['a']); // fail (n=4) → only 1 consecutive, still enabled
  assert.equal(svc.enabled(), true);
});

test('an off (no backend) service is permanently on the keyword floor', async () => {
  const svc = new EmbeddingsService({});
  assert.equal(svc.enabled(), false);
  assert.equal(await svc.embed(['anything']), null);
});
