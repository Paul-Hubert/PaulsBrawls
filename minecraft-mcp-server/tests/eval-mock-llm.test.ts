import test from 'ava';
import {
  completionResponse,
  DONE_REPLY,
  MockLLM,
  parseChatRequest,
  toolCalls,
} from '../eval/mock-llm.js';

/**
 * Pins the mock LLM's request parsing + response shaping — the pure logic the
 * scenario scripts stand on. The prompt fragments here mirror what
 * agent-runtime.ts actually assembles (systemPrompt / userPrompt /
 * conversation contextFor).
 */

const SYSTEM = [
  'You are EvalMargaux, the farmer of a small Minecraft village.',
  'Personality: Fermière calme.',
  'RULES: ...',
].join('\n');

function userPrompt(parts: { kind?: string; reasons?: string[]; conversation?: string }): string {
  const lines: string[] = [];
  if (parts.kind) {
    lines.push(`WHY YOU ARE AWAKE (${parts.kind}):`);
    for (const r of parts.reasons ?? []) lines.push(`- ${r}`);
    lines.push('');
  }
  lines.push('OBSERVATION: {"you":{"name":"EvalMargaux"}}');
  if (parts.conversation) {
    lines.push('', parts.conversation);
  }
  return lines.join('\n');
}

test('parseChatRequest extracts bot name, kind and coalesced reasons', (t) => {
  const parsed = parseChatRequest({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt({ kind: 'job', reasons: ['EVAL_TRADE: sell carrots', 'second reason'] }) },
    ],
  });
  t.is(parsed.botName, 'EvalMargaux');
  t.is(parsed.kind, 'job');
  t.deepEqual(parsed.reasons, ['EVAL_TRADE: sell carrots', 'second reason']);
  t.is(parsed.inConversationWith, null);
  t.true(parsed.isFirstRound);
  t.is(parsed.lastToolResult, null);
});

test('parseChatRequest sees conversation state and standing offers', (t) => {
  const conversation = [
    "=== ACTIVE CONVERSATION with EvalEnclume (it's YOUR turn; ~3 exchanges left) ===",
    'EvalMargaux: Salut !',
    'OFFER ON THE TABLE from EvalEnclume: they give [8x oak_planks], they want [32x carrot] from you. accept_trade / reject_trade / counter with propose_trade.',
  ].join('\n');
  const parsed = parseChatRequest({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt({ kind: 'conversation', reasons: ['EvalEnclume is waiting'], conversation }) },
    ],
  });
  t.is(parsed.inConversationWith, 'EvalEnclume');
  t.true(parsed.offerFromOther);
  t.false(parsed.offerMine);
});

test('parseChatRequest tracks tool results across rounds', (t) => {
  const parsed = parseChatRequest({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt({ kind: 'job', reasons: ['r'] }) },
      { role: 'assistant', content: null },
      { role: 'tool', content: 'conversation started with EvalEnclume — they will reply soon' },
    ],
  });
  t.false(parsed.isFirstRound);
  t.is(parsed.lastToolResult, 'conversation started with EvalEnclume — they will reply soon');
});

test('completionResponse shapes tool calls the OpenAI-compatible way', (t) => {
  const body = completionResponse(toolCalls({ name: 'accept_trade', args: {} }, { name: 'done', args: { summary: 'ok' } })) as {
    choices: Array<{ message: { tool_calls: Array<{ type: string; function: { name: string; arguments: string } }> }; finish_reason: string }>;
  };
  const message = body.choices[0].message;
  t.is(body.choices[0].finish_reason, 'tool_calls');
  t.is(message.tool_calls.length, 2);
  t.is(message.tool_calls[0].function.name, 'accept_trade');
  t.deepEqual(JSON.parse(message.tool_calls[1].function.arguments), { summary: 'ok' });
});

test('completionResponse shapes plain content', (t) => {
  const body = completionResponse({ content: 'Bonjour !' }) as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
  };
  t.is(body.choices[0].message.content, 'Bonjour !');
  t.is(body.choices[0].finish_reason, 'stop');
});

test('MockLLM serves scripted replies, falls back to done, and can fail hard', async (t) => {
  const mock = new MockLLM();
  await mock.start(0);
  const url = `http://127.0.0.1:${mock.port()}/v1/chat/completions`;
  const ask = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userPrompt({ kind: 'job', reasons: ['hello'] }) },
        ],
      }),
    });
    return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
  };

  try {
    // Scripted.
    mock.setHandler((req) => (req.botName === 'EvalMargaux' ? toolCalls({ name: 'say', args: { message: 'coucou' } }) : null));
    const scripted = await ask();
    t.is(scripted.status, 200);
    const call = (scripted.body as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }> })
      .choices[0].message.tool_calls[0];
    t.is(call.function.name, 'say');

    // Default → done.
    mock.setHandler(() => null);
    const fallback = await ask();
    const doneCall = (fallback.body as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }> })
      .choices[0].message.tool_calls[0];
    t.is(doneCall.function.name, (DONE_REPLY as { toolCalls: Array<{ name: string }> }).toolCalls[0].name);

    // Failure mode: HTTP 500 on everything (S8's degradation guarantee).
    mock.mode = 'http-500';
    const failed = await ask();
    t.is(failed.status, 500);

    t.is(mock.requestCount, 3);
    t.is(mock.seen.length, 2, 'failure-mode requests are not parsed/recorded');
  } finally {
    await mock.stop();
  }
});
