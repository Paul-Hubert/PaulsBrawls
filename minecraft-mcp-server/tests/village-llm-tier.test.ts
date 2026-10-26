import test from 'ava';
import { LLMClient, modelForTier } from '../src/village/llm-client.js';
import { LLMSettings } from '../src/village/types.js';

/** M14 — latency tiering: 'fast' calls ride fastModel when configured. */

const SETTINGS: LLMSettings = {
  provider: 'custom',
  baseUrl: 'http://127.0.0.1:9',
  model: 'big-model',
  fastModel: 'small-model',
  apiKey: 'k',
  timeoutMs: 2_000,
  temperature: 0,
  maxTokens: 64,
};

test('modelForTier routes fast to fastModel and falls back without one', (t) => {
  t.is(modelForTier(SETTINGS, 'main'), 'big-model');
  t.is(modelForTier(SETTINGS, 'fast'), 'small-model');
  t.is(modelForTier(SETTINGS), 'big-model', 'default tier is main');
  t.is(modelForTier({ ...SETTINGS, fastModel: '' }, 'fast'), 'big-model', 'no fastModel → main model');
});

test.serial('chat() puts the tier-resolved model into the request body', async (t) => {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    sent.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;
  try {
    const client = new LLMClient(SETTINGS);
    await client.chat([{ role: 'user', content: 'salut' }]);
    await client.chat([{ role: 'user', content: 'salut' }], undefined, { tier: 'fast' });
    await client.complete('sys', 'user', { tier: 'fast' });
    t.deepEqual(sent, ['big-model', 'small-model', 'small-model']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
