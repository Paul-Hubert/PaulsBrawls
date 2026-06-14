// M4-1 — the curriculum desk. TaskLedger SOLE WRITER (S2): proposeTask routes into the ledger; the
// QaCache dedups + persists the "how to X" answer as Task.context; ledger transitions (open →
// completed/failed/retired) all flow through here; the golden prompt is loaded at runtime.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryJournal } from './fakes/memory-journal';
import { ScriptedLlm, type ScriptedTurn } from './fakes/scripted-llm';
import { LlmClient, ProviderRegistry } from '../src/llm/client';
import { LlmScheduler } from '../src/llm/scheduler';
import { EmbeddingsService, providerBackend } from '../src/llm/embeddings';
import { Curriculum, loadCurriculumPrompt } from '../src/god/curriculum';
import type { GodState } from '../src/god/god';
import type { Dossier, Task, TaskLedger, TaskRecord } from '../src/types/index';

function emptyState(): GodState {
  return {
    ledger: { completed: [], failed: [], open: [] } as TaskLedger,
    dossiers: new Map<string, Dossier>(),
    criticQueue: [],
    rollouts: new Map(),
    tasks: new Map(),
  };
}

async function harness(turns: ScriptedTurn[], opts: { embed?: boolean } = {}): Promise<{
  curriculum: Curriculum;
  state: GodState;
  journal: MemoryJournal;
  llm: ScriptedLlm;
  close: () => Promise<void>;
}> {
  const journal = new MemoryJournal();
  const llm = await ScriptedLlm.start(turns);
  const providers = new ProviderRegistry({
    strong: { baseUrl: llm.url, model: 'strong', inputTokenBudget: 48000 },
    fast: { baseUrl: llm.url, model: 'fast', inputTokenBudget: 16000 },
  });
  const client = new LlmClient({ providers, journal });
  const scheduler = new LlmScheduler({ maxConcurrent: 3, perVillagerCooldownMs: 0 });
  const embeddings = new EmbeddingsService(opts.embed ? { backend: providerBackend(llm.url, 'scripted-embed') } : {});
  const state = emptyState();
  const curriculum = new Curriculum({ state, journal, client, scheduler, embeddings });
  return { curriculum, state, journal, llm, close: () => llm.close() };
}

const proposeTurn = (args: object): ScriptedTurn => ({ toolCalls: [{ name: 'propose_task', arguments: args }] });

test('M4-1 (loadCurriculumPrompt): the golden prompt loads at runtime and names the curriculum doctrine', () => {
  const prompt = loadCurriculumPrompt();
  assert.match(prompt, /curriculum/i);
  assert.match(prompt, /propose_task/);
  assert.match(prompt, /edge of/i, 'one task at the edge of current ability (Voyager)');
});

test('M4-1 (proposeTask routing): a propose_task call enters ledger.open + state.tasks and journals god.task-proposed', async () => {
  const h = await harness([
    proposeTurn({ goal: 'Acquire an iron pickaxe', successCriteria: 'have 1 iron_pickaxe', check: { item: 'iron_pickaxe', count: 1 }, assignee: 'Firmin' }),
  ]);
  try {
    const task = await h.curriculum.proposeTask({ trigger: 'idle', villager: 'Firmin' });
    assert.ok(task, 'a task was proposed');
    assert.equal(task!.goal, 'Acquire an iron pickaxe');
    assert.equal(task!.assignee, 'Firmin');
    assert.deepEqual(task!.check, { item: 'iron_pickaxe', count: 1 });
    assert.equal(task!.maxRetries, 4, 'Voyager default retry budget');

    // Sole writer of the ledger: the open list + the task map both carry it.
    assert.ok(h.state.ledger.open.some((t) => t.id === task!.id), 'in ledger.open');
    assert.equal(h.state.tasks.get(task!.id)?.id, task!.id, 'in the task map (assignable)');

    // Journaled god.task-proposed with the trigger.
    const ev = h.journal.query({ kinds: ['god.task-proposed'] });
    assert.equal(ev.length, 1);
    assert.equal((ev[0]!.payload as { trigger: string }).trigger, 'idle');
    assert.equal(ev[0]!.refs.taskId, task!.id);
  } finally {
    await h.close();
  }
});

test('M4-1 (proposeTask): no structured reply → no task, no ledger write (never throws into the loop)', async () => {
  const h = await harness([{ content: 'je réfléchis…' }]); // no tool call
  try {
    const task = await h.curriculum.proposeTask({ trigger: 'dawn' });
    assert.equal(task, undefined, 'no task proposed');
    assert.equal(h.state.ledger.open.length, 0, 'no ledger write');
    assert.equal(h.journal.query({ kinds: ['god.task-proposed'] }).length, 0);
  } finally {
    await h.close();
  }
});

test('M4-1 (QaCache dedup + persist): howTo answers once via the fast tier and folds into Task.context', async () => {
  // Turn 1: propose_task (carrying a howTo). Turn 2: the QA "how to" answer it then fetches.
  const h = await harness([
    proposeTurn({ goal: 'Acquire an iron pickaxe', successCriteria: 'have 1 iron_pickaxe', howTo: 'How to craft an iron pickaxe in Minecraft?' }),
    { content: 'Pour fabriquer une pioche en fer: fonds du minerai, puis assemble 3 lingots + 2 bâtons.' },
  ], { embed: true });
  try {
    const task = await h.curriculum.proposeTask({ trigger: 'idle' });
    assert.ok(task);
    assert.match(task!.context, /lingots/, 'the QA answer is folded into Task.context (Voyager)');

    // The QA cache deduped: a second howTo for the SAME question does NOT spend another LLM call.
    const before = h.llm.requests.filter((r) => String(r.url).includes('/chat/completions')).length;
    const again = await h.curriculum.howTo('How to craft an iron pickaxe in Minecraft?');
    const after = h.llm.requests.filter((r) => String(r.url).includes('/chat/completions')).length;
    assert.match(again, /lingots/, 'cache hit returns the same answer');
    assert.equal(after, before, 'a cache hit spends ZERO chat calls (zero-token, D-13)');
  } finally {
    await h.close();
  }
});

test('M4-1 (decompose): a big goal becomes sub-tasks with parent set, each entering the ledger', async () => {
  const h = await harness([
    { toolCalls: [{ name: 'decompose', arguments: { subtasks: [
      { goal: 'Mine 3 iron ore', successCriteria: 'have 3 raw_iron', check: { item: 'raw_iron', count: 3 } },
      { goal: 'Smelt 3 iron', successCriteria: 'have 3 iron_ingot' },
      { goal: 'Craft the pickaxe', successCriteria: 'have 1 iron_pickaxe' },
    ] } }] },
  ]);
  try {
    const subs = await h.curriculum.decompose('Acquire an iron pickaxe');
    assert.equal(subs.length, 3);
    for (const s of subs) assert.equal(s.parent, 'Acquire an iron pickaxe', 'each sub-task points at the parent goal');
    assert.equal(h.state.ledger.open.length, 3, 'all sub-tasks entered the ledger (sole writer)');
    // Each journaled god.task-proposed with its parent.
    const ev = h.journal.query({ kinds: ['god.task-proposed'] });
    assert.equal(ev.length, 3);
    assert.equal((ev[0]!.payload as { parent?: string }).parent, 'Acquire an iron pickaxe');
  } finally {
    await h.close();
  }
});

test('M4-1 (ledger transition completed): closeTask moves open → completed and journals god.task-closed', async () => {
  const h = await harness([]);
  try {
    const t: Task = { id: 'task-1', goal: 'collect 3 oak logs', successCriteria: 'have 3 oak_log', context: '', maxRetries: 4 };
    h.curriculum.addTask(t);
    assert.equal(h.state.ledger.open.length, 1);

    h.curriculum.closeTask(t, 'verdict-1', true);
    assert.equal(h.state.ledger.open.length, 0, 'left the open list');
    assert.equal(h.state.ledger.completed.length, 1, 'landed in completed');
    assert.equal(h.state.tasks.has('task-1'), false, 'no longer assignable');

    const ev = h.journal.query({ kinds: ['god.task-closed'] });
    assert.equal(ev.length, 1);
    assert.equal((ev[0]!.payload as { outcome: string }).outcome, 'completed');
    assert.equal(ev[0]!.refs.verdictId, 'verdict-1');
  } finally {
    await h.close();
  }
});

test('M4-1 (ledger transition failed): a retries-exhausted task lands in failed', async () => {
  const h = await harness([]);
  try {
    const t: Task = { id: 'task-2', goal: 'tame a polar bear', successCriteria: 'impossible', context: '', maxRetries: 4 };
    h.curriculum.addTask(t);
    h.curriculum.closeTask(t, 'verdict-9', false);
    assert.equal(h.state.ledger.failed.length, 1);
    assert.equal((h.journal.query({ kinds: ['god.task-closed'] })[0]!.payload as { outcome: string }).outcome, 'failed');
  } finally {
    await h.close();
  }
});

test('M4-1 (clean_up_tasks): a stale failed task is retired when a later task completes the same goal', async () => {
  const h = await harness([]);
  try {
    const failed: TaskRecord = { task: { id: 'old', goal: 'collect 3 oak logs', successCriteria: 's', context: '', maxRetries: 4 }, closedAt: 1, verdictId: 'v-old' };
    h.state.ledger.failed.push(failed);
    // A later attempt at the SAME goal completed.
    const won: TaskRecord = { task: { id: 'new', goal: 'collect 3 oak logs', successCriteria: 's', context: '', maxRetries: 4 }, closedAt: 2, verdictId: 'v-new' };
    h.state.ledger.completed.push(won);

    const retired = h.curriculum.cleanUpTasks();
    assert.equal(retired, 1, 'one stale failure retired (Voyager clean_up_tasks)');
    assert.equal(h.state.ledger.failed.length, 0, 'the stale failed record is gone');
    const ev = h.journal.query({ kinds: ['god.task-closed'] });
    assert.equal(ev.length, 1);
    assert.equal((ev[0]!.payload as { outcome: string }).outcome, 'retired');
  } finally {
    await h.close();
  }
});

test('M4-1 (warmup gate): in early game the proposer is told to stay survival-basic (config table)', async () => {
  const h = await harness([proposeTurn({ goal: 'Gather wood', successCriteria: 'have 4 oak_log' })]);
  try {
    // With an empty ledger we are in warmup — the rendered context must say so.
    await h.curriculum.proposeTask({ trigger: 'idle' });
    const sent = h.llm.requests.find((r) => String(r.url).includes('/chat/completions'));
    const userMsg = (sent!.body.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'user');
    assert.match(userMsg!.content, /survie|warm|basique|early/i, 'the warmup phase is signalled to the proposer');
  } finally {
    await h.close();
  }
});
