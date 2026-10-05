// D-18 — the production conversation turn (villagers/conversation-turn.ts): one fast-tier call on the
// conversation lane per turn; the reply is strict JSON {say} | {leave}, tolerated when fenced or plain text.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTurn, renderTurn, ConversationTurner } from '../src/villagers/conversation-turn';
import { LlmClient, ProviderRegistry } from '../src/llm/client';
import { LlmScheduler } from '../src/llm/scheduler';
import { ScriptedLlm } from './fakes/scripted-llm';
import { MemoryJournal } from './fakes/memory-journal';

test('parseTurn: say, leave (clamped), fenced JSON, plain text, and junk', () => {
  assert.deepEqual(parseTurn('{"say":"Bonjour Pilou !"}'), { say: 'Bonjour Pilou !' });
  assert.deepEqual(parseTurn('```json\n{"leave":{"opinion":42,"note":"ami","headline":"On a parlé blé."}}\n```'), {
    leave: { opinion: 10, note: 'ami', headline: 'On a parlé blé.' },
  });
  assert.deepEqual(parseTurn('Je pense qu’on devrait planter.'), { say: 'Je pense qu’on devrait planter.' }, 'plain text is the line');
  assert.ok('leave' in parseTurn(''), 'an empty reply ends the conversation politely');
  assert.ok('leave' in parseTurn('{"nothing":true}'));
});

test('renderTurn: carries who, the topic, memories and the transcript', () => {
  const msg = renderTurn(
    { self: 'Firmin', partner: 'Pilou', topic: 'les semis', persona: 'Tu es fermier du village.' },
    [{ from: 'Pilou', text: 'Salut' }],
    ['(event) a planté du blé'],
  );
  assert.match(msg, /Tu es Firmin/);
  assert.match(msg, /Sujet : les semis/);
  assert.match(msg, /a planté du blé/);
  assert.match(msg, /Pilou: Salut/);
});

test('ConversationTurner: one fast-tier call per turn, parsed into a SpeakResult', async () => {
  const llm = await ScriptedLlm.start([
    { content: '{"say":"Bonjour !"}', finishReason: 'stop' },
    { content: '{"leave":{"opinion":3,"note":"cordial","headline":"Salutations."}}', finishReason: 'stop' },
  ]);
  const journal = new MemoryJournal();
  const client = new LlmClient({
    providers: new ProviderRegistry({
      strong: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 48000 },
      fast: { baseUrl: llm.url, model: 'scripted', inputTokenBudget: 16000 },
    }),
    journal,
  });
  const turner = new ConversationTurner({ client, scheduler: new LlmScheduler({ maxConcurrent: 2, perVillagerCooldownMs: 0 }) });
  const speak = turner.speakFn({ self: 'Firmin', partner: 'Pilou', topic: 'x', persona: '' }, 'k');
  assert.deepEqual(await speak([]), { say: 'Bonjour !' });
  assert.deepEqual(await speak([{ from: 'Firmin', text: 'Bonjour !' }]), { leave: { opinion: 3, note: 'cordial', headline: 'Salutations.' } });
  const calls = journal.events.filter((e) => e.kind === 'llm.call');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((e) => (e.payload as { tier: string }).tier === 'fast'), 'conversation turns are fast-tier (D-13)');
  await llm.close();
});
