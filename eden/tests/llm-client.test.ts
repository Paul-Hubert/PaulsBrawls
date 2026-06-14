import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptedLlm } from './fakes/scripted-llm';
import { MemoryJournal } from './fakes/memory-journal';
import {
  LlmClient,
  ProviderRegistry,
  LlmTimeoutError,
  type LlmRequest,
} from '../src/llm/client';

function providers(strongUrl: string, fastUrl = strongUrl): ProviderRegistry {
  return new ProviderRegistry({
    strong: { baseUrl: strongUrl, model: 'strong-model', inputTokenBudget: 48000 },
    fast: { baseUrl: fastUrl, model: 'fast-model', inputTokenBudget: 16000 },
  });
}

const ask = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  messages: [{ role: 'user', content: 'bonjour' }],
  tier: 'strong',
  caller: 'god:critic',
  ...overrides,
});

test('M2-L1: round-trips a ScriptedLLM completion and parses tool calls', async () => {
  const llm = await ScriptedLlm.start([
    { toolCalls: [{ name: 'judge', arguments: { success: true } }], promptTokens: 120, completionTokens: 8 },
  ]);
  const journal = new MemoryJournal();
  const client = new LlmClient({ providers: providers(llm.url), journal });
  try {
    const result = await client.chat(ask({ tools: [{ type: 'function', function: { name: 'judge', description: 'j', parameters: {} } }] }));
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]?.name, 'judge');
    assert.deepEqual(result.toolCalls[0]?.arguments, { success: true });
    assert.equal(result.usage.promptTokens, 120);
    // The wire request used the resolved model + carried the tool definitions.
    assert.equal(llm.requests[0].body.model, 'strong-model');
    assert.ok(Array.isArray(llm.requests[0].body.messages));
  } finally {
    await llm.close();
  }
});

test('M2-L1: journals llm.call with metrics only — NEVER prompt/completion bodies (05)', async () => {
  const llm = await ScriptedLlm.start([{ content: 'une réponse', promptTokens: 42, completionTokens: 7 }]);
  const journal = new MemoryJournal();
  const client = new LlmClient({ providers: providers(llm.url), journal });
  try {
    const result = await client.chat(ask({ refs: { rolloutId: 'r1' } }));
    const calls = journal.query({ kinds: ['llm.call'] });
    assert.equal(calls.length, 1);
    const ev = calls[0]!;
    assert.equal(ev.actor, 'god:critic');
    assert.equal(ev.refs.llmCallId, result.callId);
    assert.equal(ev.refs.rolloutId, 'r1');
    // The payload carries metrics, and its serialization contains none of the message text.
    const serialized = JSON.stringify(ev.payload);
    assert.doesNotMatch(serialized, /bonjour|une réponse/, 'no prompt/completion bodies in the journal');
    const p = ev.payload as Record<string, unknown>;
    assert.equal(p['model'], 'strong-model');
    assert.equal(p['promptTokens'], 42);
    assert.equal(p['completionTokens'], 7);
    assert.equal(p['finishReason'], 'stop');
    assert.equal(typeof p['latencyMs'], 'number');
  } finally {
    await llm.close();
  }
});

test('M2-L1: debugPrompts dumps full transcript to a side file, referenced by callId', async () => {
  const llm = await ScriptedLlm.start([{ content: 'avec corps' }]);
  const journal = new MemoryJournal();
  const dataDir = mkdtempSync(join(tmpdir(), 'eden-llm-'));
  const client = new LlmClient({ providers: providers(llm.url), journal, debugPrompts: true, dataDir });
  try {
    const result = await client.chat(ask());
    const file = join(dataDir, 'llm', `${result.callId}.json`);
    assert.ok(existsSync(file), 'debug transcript written');
    const dump = JSON.parse(readFileSync(file, 'utf8')) as { request: { messages: unknown[] }; response: unknown };
    assert.ok(Array.isArray(dump.request.messages), 'the side file DOES carry the bodies');
  } finally {
    await llm.close();
  }
});

// ── R21: timeouts are not retries; connection-resets ARE retriable noise ──────
test('R21: a timeout throws LlmTimeoutError and is NOT retried', async () => {
  const journal = new MemoryJournal();
  let calls = 0;
  const hangingFetch: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      calls++;
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  const client = new LlmClient({
    providers: providers('http://127.0.0.1:1/v1'),
    journal,
    timeoutMs: 40,
    fetchImpl: hangingFetch,
  });
  await assert.rejects(client.chat(ask()), (e: unknown) => e instanceof LlmTimeoutError);
  assert.equal(calls, 1, 'a timeout is final — exactly one attempt, no retry (R21)');
});

test('R21: a TCP connection-reset is retried automatically, then succeeds', async () => {
  const journal = new MemoryJournal();
  let calls = 0;
  const flakyFetch: typeof fetch = (_url) => {
    calls++;
    if (calls === 1) {
      // The undici shape of a stale-keepalive reset: a wrapping error with a coded cause.
      return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }));
    }
    const body = {
      id: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  const client = new LlmClient({ providers: providers('http://127.0.0.1:1/v1'), journal, fetchImpl: flakyFetch });
  const result = await client.chat(ask());
  assert.equal(result.content, 'recovered');
  assert.equal(calls, 2, 'reset retried once');
  assert.equal((journal.query({ kinds: ['llm.call'] })[0]!.payload as Record<string, unknown>)['retries'], 1);
});

test('R21: a connection-reset that NEVER recovers gives up after maxRetries and throws (no infinite loop)', async () => {
  // The retry valve is bounded (R21/S7 maxRetries): a persistently-resetting endpoint must stop, not spin.
  const journal = new MemoryJournal();
  let calls = 0;
  const alwaysReset: typeof fetch = () => {
    calls++;
    return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }));
  };
  const client = new LlmClient({ providers: providers('http://127.0.0.1:1/v1'), journal, fetchImpl: alwaysReset, maxRetries: 2 });
  await assert.rejects(client.chat(ask()), /reset|fetch failed/);
  assert.equal(calls, 3, 'the initial attempt + exactly maxRetries (2) retries, then it gives up');
  assert.equal(journal.query({ kinds: ['llm.call'] }).length, 0, 'a failed call never journals a success metric');
});

test('R21 (EPIPE/UND_ERR_SOCKET): other transient socket codes are also retried', async () => {
  const journal = new MemoryJournal();
  let calls = 0;
  const flaky: typeof fetch = () => {
    calls++;
    if (calls === 1) return Promise.reject(Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' }));
    const body = { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  const client = new LlmClient({ providers: providers('http://127.0.0.1:1/v1'), journal, fetchImpl: flaky });
  const result = await client.chat(ask());
  assert.equal(result.content, 'ok');
  assert.equal(calls, 2, 'a direct (non-wrapped) retriable code retries');
});

// ── env-based auth: remote (OpenAI) gets a bearer; a local endpoint never does ──
test('auth: a REMOTE provider carries Authorization: Bearer; a LOCAL one does NOT; no key → no header', async () => {
  const journal = new MemoryJournal();
  const okBody = {
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const seen: Array<string | null> = [];
  const capFetch: typeof fetch = (_url, init) => {
    seen.push(new Headers(init?.headers).get('authorization'));
    return Promise.resolve(new Response(JSON.stringify(okBody), { status: 200, headers: { 'content-type': 'application/json' } }));
  };

  // Remote (https) + key → bearer present.
  await new LlmClient({ providers: providers('https://api.openai.com/v1'), journal, fetchImpl: capFetch, apiKey: 'sk-test-123' }).chat(ask());
  assert.equal(seen[0], 'Bearer sk-test-123', 'a remote provider carries the bearer (OpenAI 401s without it)');

  // Local (127.0.0.1) + key → NO header (never leak the key to a local endpoint).
  await new LlmClient({ providers: providers('http://127.0.0.1:1234/v1'), journal, fetchImpl: capFetch, apiKey: 'sk-test-123' }).chat(ask());
  assert.equal(seen[1], null, 'a localhost provider sends no Authorization header');

  // Remote but no key → NO header (nothing to send).
  await new LlmClient({ providers: providers('https://api.openai.com/v1'), journal, fetchImpl: capFetch, apiKey: '' }).chat(ask());
  assert.equal(seen[2], null, 'no key configured → no Authorization header even for a remote provider');
});

test('R21: HTTP 500 is an error, not a silent retry-forever', async () => {
  const journal = new MemoryJournal();
  let calls = 0;
  const errFetch: typeof fetch = () => {
    calls++;
    return Promise.resolve(new Response('upstream boom', { status: 500 }));
  };
  const client = new LlmClient({ providers: providers('http://127.0.0.1:1/v1'), journal, fetchImpl: errFetch, maxRetries: 4 });
  await assert.rejects(client.chat(ask()));
  assert.equal(calls, 1, 'a 4xx/5xx is surfaced, not retried as if it were a reset');
});
