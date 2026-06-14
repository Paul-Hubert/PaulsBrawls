import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptedLlm } from './fakes/scripted-llm';
import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { SkillLibrary, AllGranted } from '../src/skills/library';
import { SkillEngine } from '../src/skills/engine';
import { SkillRetriever } from '../src/skills/retrieve';
import { EmbeddingsService } from '../src/llm/embeddings';
import { LlmClient, ProviderRegistry } from '../src/llm/client';
import { LlmScheduler } from '../src/llm/scheduler';
import { ToolRegistry } from '../src/villagers/tools';
import { ContextPackBuilder, type ContextPackInput } from '../src/villagers/context-pack';
import { Brain } from '../src/villagers/brain';
import type { RunnerRef, Snapshot } from '../src/types/index';

const RUNNER: RunnerRef = { name: 'Firmin', role: 'farmer', tier: 'mortal' };
const SNAP: Snapshot = {
  biome: 'plains', time: 1200, position: [0, 64, 0], health: 20, hunger: 20,
  equipment: [], inventory: [], nearbyEntities: [], nearbyBlocks: ['oak_log'], knownChests: [],
};

async function harness(turns: Parameters<typeof ScriptedLlm.start>[0]) {
  const dir = mkdtempSync(join(tmpdir(), 'eden-brain-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  const bot = new FakeBot({ username: 'Firmin' });
  const engine = new SkillEngine({
    library, journal, grants: new AllGranted(), resolveBot: () => bot,
    runDefaultTimeoutMs: 120_000, stallSeconds: 20, maxCallDepth: 8, autoQuarantineAfter: 5,
  });
  const retriever = new SkillRetriever({ library, embeddings: new EmbeddingsService({}), grants: new AllGranted() });
  const tools = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400 });
  const builder = new ContextPackBuilder({ journal });
  const llm = await ScriptedLlm.start(turns);
  const providers = new ProviderRegistry({
    strong: { baseUrl: llm.url, model: 'strong', inputTokenBudget: 48000 },
    fast: { baseUrl: llm.url, model: 'fast', inputTokenBudget: 16000 },
  });
  const client = new LlmClient({ providers, journal });
  const scheduler = new LlmScheduler({ maxConcurrent: 3, perVillagerCooldownMs: 0 });
  const brain = new Brain({ builder, tools, scheduler, client, journal });
  return { brain, library, journal, bot, llm, dir };
}

function input(over: Partial<ContextPackInput> = {}): ContextPackInput {
  return {
    villager: 'Firmin', runner: RUNNER,
    persona: 'Tu es Firmin.', role: 'farmer',
    triggers: ['directive: récolte 3 bûches'], hint: 'authoring',
    snapshot: SNAP, runningSkill: null, directive: { goal: 'récolte 3 bûches', reason: 'grenier vide' }, openTask: { goal: 'collect 3 oak logs' },
    recentEvents: [], memories: [], retrievedSkills: [], exemplars: [], includeExemplarCode: true,
    toolNames: ['write_skill', 'run_skill', 'done'], inbox: [],
    tier: 'strong', inputTokenBudget: 48000,
    ...over,
  };
}

const GOOD_CODE = 'async function collect(bot, args, ctx) { return { collected: 3 }; }';

test('M3-3: one deliberation drives scripted author → run → done', async () => {
  const h = await harness([
    { toolCalls: [{ name: 'write_skill', arguments: { name: 'collect-oak-logs', summary: 's', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: GOOD_CODE } }] },
    { toolCalls: [{ name: 'run_skill', arguments: { name: 'collect-oak-logs', args: {} } }] },
    { toolCalls: [{ name: 'done', arguments: { summary: 'récolté', mood: 'fier' } }] },
  ]);
  try {
    const result = await h.brain.deliberate(input(), { rolloutId: 'roll-1' });
    assert.deepEqual(result.authoredDraft, { name: 'collect-oak-logs', version: 1 });
    assert.ok(result.lastRunReport, 'a RunReport was captured');
    assert.equal(result.lastRunReport!.outcome.ok, true);
    assert.equal(result.lastRunReport!.version, 1, 'the draft version was trialed (P2)');
    assert.deepEqual(result.done, { summary: 'récolté', mood: 'fier' });
    assert.equal(result.toolCalls, 3);
  } finally {
    await h.llm.close();
  }
});

test('M3-3: journals brain.wakeup → brain.tool-call(s) → brain.done, all under refs.rolloutId', async () => {
  const h = await harness([
    { toolCalls: [{ name: 'write_skill', arguments: { name: 'x', summary: 's', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: GOOD_CODE } }] },
    { toolCalls: [{ name: 'done', arguments: { summary: 'fini' } }] },
  ]);
  try {
    await h.brain.deliberate(input(), { rolloutId: 'roll-1' });
    const wake = h.journal.query({ kinds: ['brain.wakeup'] });
    const calls = h.journal.query({ kinds: ['brain.tool-call'] });
    const done = h.journal.query({ kinds: ['brain.done'] });
    assert.equal(wake.length, 1);
    assert.equal(calls.length, 2, 'write_skill + done both journaled');
    assert.equal(done.length, 1);
    assert.equal((done[0]!.payload as { toolCalls: number }).toolCalls, 2);
    for (const e of [...wake, ...calls, ...done]) {
      assert.equal(e.refs.rolloutId, 'roll-1', `${e.kind} tied to the rollout`);
      assert.equal(e.actor, 'villager:Firmin', `${e.kind} actor is the villager (R41)`);
    }
  } finally {
    await h.llm.close();
  }
});

test('M3-3 (R20): every assistant tool-call turn is followed by adjacent tool results — no dangling', async () => {
  // The model emits TWO tool calls in ONE turn, one of which is `done`. Both MUST be answered before
  // the loop ends — leaving `run_skill` unanswered while breaking on `done` would 400 the next provider call.
  const h = await harness([
    {
      toolCalls: [
        { name: 'run_skill', arguments: { name: 'go-to', args: { x: 0, y: 64, z: 0 } } },
        { name: 'done', arguments: { summary: 'arrivé' } },
      ],
    },
  ]);
  // Seed go-to so run_skill has a live skill.
  h.library.seedStock({ name: 'go-to', summary: 'aller', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function g(bot,args,ctx){ return { arrived: true }; }', author: { kind: 'stock' } }, 'active');
  try {
    const result = await h.brain.deliberate(input());
    // Walk the assembled conversation: each assistant(tool_calls) is immediately followed by one tool result per call.
    for (let i = 0; i < result.messages.length; i++) {
      const m = result.messages[i]!;
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        for (let k = 0; k < m.toolCalls.length; k++) {
          const r = result.messages[i + 1 + k];
          assert.equal(r?.role, 'tool', 'tool call answered by an adjacent tool result (R20)');
          assert.equal(r?.toolCallId, m.toolCalls[k]!.id, 'result answers the matching call');
        }
      }
    }
    assert.ok(result.done, 'deliberation ended on done');
  } finally {
    await h.llm.close();
  }
});

test('M3-3: a deliberation that stops issuing tool calls ends cleanly (implicit done)', async () => {
  const h = await harness([{ content: 'Je ne sais pas quoi faire.', finishReason: 'stop' }]);
  try {
    const result = await h.brain.deliberate(input());
    assert.equal(result.toolCalls, 0);
    assert.ok(result.done, 'an implicit done closes the deliberation');
    assert.equal(h.journal.query({ kinds: ['brain.done'] }).length, 1);
  } finally {
    await h.llm.close();
  }
});

test('M3-3: revision context (activeRollout draft + density + history) persists into the pack', async () => {
  const h = await harness([{ toolCalls: [{ name: 'done', arguments: { summary: 'révisé' } }] }]);
  try {
    const result = await h.brain.deliberate(
      input({
        density: { draft: { name: 'collect-oak-logs', version: 2, code: GOOD_CODE }, critique: 'manque la re-vérification' },
        history: [
          {
            assistant: { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'write_skill', arguments: { name: 'collect-oak-logs' } }] },
            results: [{ role: 'tool', content: 'v1 créé', toolCallId: 'call_1', name: 'write_skill' }],
          },
        ],
      }),
      { rolloutId: 'roll-1' },
    );
    // The density payload + prior revision pair both reached the model (first request body).
    const sent = h.llm.requests[0].body.messages as Array<{ role: string; content: string | null }>;
    assert.ok(sent.some((m) => m.role === 'user' && (m.content ?? '').includes('manque la re-vérification')), 'critique rode in the density payload');
    assert.ok(sent.some((m) => m.role === 'assistant'), 'the prior revision turn rode along');
    assert.ok(result.done);
  } finally {
    await h.llm.close();
  }
});
