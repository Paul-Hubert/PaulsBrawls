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
import type { SkillLibrary, ResolvedSkill } from '../src/skills/library';
import type { Dossier, Snapshot, Task, TaskLedger, TaskRecord } from '../src/types/index';

/** A bare Snapshot carrying just the inventory the curriculum reads (the rest is render-irrelevant). */
function snapshotWith(inventory: Array<{ name: string; count: number }>): Snapshot {
  return {
    biome: 'plains', time: 0, position: [0, 64, 0], health: 20, hunger: 20,
    equipment: [], inventory, nearbyEntities: [], nearbyBlocks: [], knownChests: [],
  };
}

/** A minimal library stub exposing only liveSkills() — all the curriculum's coverage render touches. */
function fakeLibrary(skills: Array<{ name: string; summary: string; tier: 'mortal' | 'divine' }>): SkillLibrary {
  const live = skills.map((s) => ({ manifest: { name: s.name, summary: s.summary, tier: s.tier } })) as unknown as ResolvedSkill[];
  return { liveSkills: () => live } as unknown as SkillLibrary;
}

function emptyState(): GodState {
  return {
    ledger: { completed: [], failed: [], open: [] } as TaskLedger,
    dossiers: new Map<string, Dossier>(),
    criticQueue: [],
    rollouts: new Map(),
    tasks: new Map(),
  };
}

async function harness(
  turns: ScriptedTurn[],
  opts: { embed?: boolean; library?: SkillLibrary; hasMissionDirective?: boolean } = {},
): Promise<{
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
  const curriculum = new Curriculum({
    state, journal, client, scheduler, embeddings,
    ...(opts.library ? { library: opts.library } : {}),
    ...(opts.hasMissionDirective !== undefined ? { hasMissionDirective: opts.hasMissionDirective } : {}),
  });
  return { curriculum, state, journal, llm, close: () => llm.close() };
}

/** The user message sent to the proposer on the last /chat/completions request. */
function lastProposalUserMessage(llm: ScriptedLlm): string {
  const sent = llm.requests.filter((r) => String(r.url).includes('/chat/completions')).at(-1);
  return (sent!.body.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!.content;
}

/** The `tool_choice` field of the last /chat/completions request body (R68 pin). */
function lastToolChoice(llm: ScriptedLlm): unknown {
  const sent = llm.requests.filter((r) => String(r.url).includes('/chat/completions')).at(-1);
  return sent!.body.tool_choice;
}

const proposeTurn = (args: object): ScriptedTurn => ({ toolCalls: [{ name: 'propose_task', arguments: args }] });

test('M4-1 (loadCurriculumPrompt): the golden prompt loads at runtime and names the curriculum doctrine', () => {
  const prompt = loadCurriculumPrompt();
  assert.match(prompt, /curriculum/i);
  assert.match(prompt, /propose_task/);
  assert.match(prompt, /edge of/i, 'one task at the edge of current ability (Voyager)');
  // P5: decompose-into-composable-steps doctrine — big goals become small composable skills, not one giant skill.
  assert.match(prompt, /decompose/, 'curriculum documents the decompose tool');
  assert.match(prompt, /compos/i, 'curriculum steers big goals toward composable sub-skills');
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

test('R68 (proposeTask forces the tool): the request pins tool_choice to propose_task, never auto', async () => {
  const h = await harness([proposeTurn({ goal: 'collect 3 oak logs', successCriteria: 'have 3 oak_log' })]);
  try {
    await h.curriculum.proposeTask({ trigger: 'idle' });
    // Without the force, gpt-4o intermittently narrates the JSON as text (finish=stop, no tool call) and the
    // VillageLoop spins on the identical context. The desk has one tool and always wants it called.
    assert.deepEqual(lastToolChoice(h.llm), { type: 'function', function: { name: 'propose_task' } });
  } finally {
    await h.close();
  }
});

test('R68 (howTo QA stays free-text): the knowledge-cache call sends NO tools and NO tool_choice', async () => {
  // The QA "how to X in Minecraft?" answer is prose folded into Task.context — forcing a tool here would be
  // wrong. Guards against a future blanket tool_choice leaking onto the toolless fast-tier path.
  const h = await harness([{ content: 'Pour faire du pain: 3 blé sur une table de craft.' }]);
  try {
    const ans = await h.curriculum.howTo('how to bake bread in Minecraft?');
    assert.match(ans, /pain/i, 'the QA answer comes back as free text');
    const sent = h.llm.requests.filter((r) => String(r.url).includes('/chat/completions')).at(-1);
    assert.equal(sent!.body.tools, undefined, 'the QA call exposes no tools');
    assert.equal(sent!.body.tool_choice, undefined, 'so no tool_choice is sent (free-text answer)');
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
    assert.deepEqual(lastToolChoice(h.llm), { type: 'function', function: { name: 'decompose' } }, 'R68: decompose forces its tool');
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

test('R65 (convergence breaker): K exhausted rollouts close the task `failed` with a blocked reason, then it stays closed', async () => {
  const h = await harness([]);
  try {
    const t: Task = { id: 'task-stuck', goal: 'Place a chest by the 3×3 wheat plot and store the first loaf of bread', successCriteria: 'chest + 1 bread inside', context: '', maxRetries: 4 };
    h.curriculum.addTask(t);

    // First exhausted rollout (converged:false): below the breaker — the task stays OPEN to retry.
    const gaveUp1 = h.curriculum.noteExhausted(t);
    assert.equal(gaveUp1, false, 'first exhaustion is within budget — no give-up');
    assert.ok(h.state.ledger.open.some((x) => x.id === t.id), 'still open after one exhausted rollout');
    assert.equal(h.state.tasks.has(t.id), true, 'still assignable after one exhausted rollout');
    assert.equal(h.journal.query({ kinds: ['god.task-closed'] }).length, 0, 'no close yet');

    // Second exhausted rollout reaches MAX_ROLLOUT_ATTEMPTS — the breaker fires and gives up.
    const gaveUp2 = h.curriculum.noteExhausted(t);
    assert.equal(gaveUp2, true, 'breaker fired after K exhausted rollouts');
    assert.equal(h.state.ledger.open.length, 0, 'no longer open');
    assert.equal(h.state.tasks.has(t.id), false, 'no longer re-proposed/assignable (the village moves on)');
    assert.equal(h.state.ledger.failed.length, 1, 'landed in failed (a frontier signal that steers proposals away)');

    // Observable give-up: god.task-closed{failed} whose reason NAMES the task + the attempt count (S10).
    const ev = h.journal.query({ kinds: ['god.task-closed'] });
    assert.equal(ev.length, 1, 'exactly one give-up close journaled');
    const p = ev[0]!.payload as { taskId: string; goal: string; outcome: string; reason?: string };
    assert.equal(p.outcome, 'failed');
    assert.equal(ev[0]!.refs.taskId, t.id);
    assert.ok(p.reason, 'a reason is attached');
    assert.match(p.reason!, /blocked/i, 'the reason marks the task blocked');
    assert.match(p.reason!, new RegExp(t.goal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the reason NAMES the task goal (S10)');
    assert.match(p.reason!, /2 exhausted rollout/, 'the reason names the attempt count (S10)');

    // A further note on a now-closed task is a no-op (no double-close, no spurious re-give-up).
    const gaveUp3 = h.curriculum.noteExhausted(t);
    assert.equal(gaveUp3, false, 'noteExhausted on a closed task is a no-op');
    assert.equal(h.journal.query({ kinds: ['god.task-closed'] }).length, 1, 'no second close');
  } finally {
    await h.close();
  }
});

test('R65 (negative — within budget retries unchanged): one exhausted rollout leaves the task open with no give-up signal', async () => {
  const h = await harness([]);
  try {
    const t: Task = { id: 'task-retry', goal: 'collect 3 oak logs', successCriteria: 'have 3 oak_log', context: '', maxRetries: 4 };
    h.curriculum.addTask(t);
    const gaveUp = h.curriculum.noteExhausted(t);
    assert.equal(gaveUp, false);
    assert.ok(h.state.ledger.open.some((x) => x.id === t.id), 'task remains open for another rollout');
    assert.equal(h.state.ledger.failed.length, 0, 'not failed yet');
    assert.equal(h.journal.query({ kinds: ['god.task-closed'] }).length, 0, 'no give-up signal within budget');
  } finally {
    await h.close();
  }
});

test('R65 (legitimate path intact): a task that CONVERGES still closes `completed` normally, breaker untouched', async () => {
  const h = await harness([]);
  try {
    const t: Task = { id: 'task-win', goal: 'collect 3 oak logs', successCriteria: 'have 3 oak_log', context: '', maxRetries: 4 };
    h.curriculum.addTask(t);
    // One exhausted rollout, THEN a converging verdict closes it `completed` — the success path is unchanged.
    h.curriculum.noteExhausted(t);
    h.curriculum.closeTask(t, 'verdict-ok', true);
    assert.equal(h.state.ledger.completed.length, 1, 'completed normally');
    assert.equal(h.state.ledger.failed.length, 0, 'never marked blocked/failed');
    const ev = h.journal.query({ kinds: ['god.task-closed'] });
    assert.equal(ev.length, 1);
    const p = ev[0]!.payload as { outcome: string; reason?: string };
    assert.equal(p.outcome, 'completed');
    assert.equal(p.reason, undefined, 'a verdict-close carries no breaker reason');
  } finally {
    await h.close();
  }
});

test('R70 (nextOpenTaskFor): resumes the oldest open task for the villager; skips running + other-villager tasks', async () => {
  const h = await harness([]);
  try {
    const mk = (id: string, assignee?: string, rollout?: string): Task => {
      const t: Task = { id, goal: id, successCriteria: 's', context: '', maxRetries: 4 };
      if (assignee !== undefined) t.assignee = assignee;
      if (rollout !== undefined) t.currentRolloutId = rollout;
      h.curriculum.addTask(t);
      return t;
    };
    mk('running', 'Harry', 'ro-1');   // live rollout → not resumable
    mk('other', 'Colette');           // another villager → skip
    mk('first', 'Harry');             // oldest resumable for Harry
    mk('second', 'Harry');            // newer resumable for Harry
    mk('floating');                   // unassigned → eligible for anyone

    assert.equal(h.curriculum.nextOpenTaskFor('Harry')?.id, 'first', 'oldest open Harry task with no live rollout (FIFO drain)');
    assert.equal(h.curriculum.nextOpenTaskFor('Zoe')?.id, 'floating', 'an unassigned open task is eligible for any villager');
  } finally {
    await h.close();
  }
});

test('R70 (noteExhausted folds the last critique into the failed record reason — the memory)', async () => {
  const h = await harness([]);
  try {
    const t: Task = { id: 'stuck', goal: 'Bake bread at a crafting table', successCriteria: 'have 1 bread', context: '', maxRetries: 4 };
    h.curriculum.addTask(t);
    assert.equal(h.curriculum.noteExhausted(t, 'aucune table de craft à portée'), false, 'attempt 1 within budget');
    assert.equal(h.curriculum.noteExhausted(t, 'aucune table de craft à portée'), true, 'attempt 2 fires the breaker');
    const rec = h.state.ledger.failed[0]!;
    assert.ok(rec.reason?.includes('aucune table de craft à portée'), 'the obstacle (last critique) is carried into the record');
    assert.ok(rec.reason?.includes('Bake bread'), 'the reason still names the goal (S10)');
    // The persisted reason is also what the journal close event carries.
    const closed = h.journal.query({ kinds: ['god.task-closed'] })[0]!;
    assert.match((closed.payload as { reason?: string }).reason ?? '', /dernier obstacle/);
  } finally {
    await h.close();
  }
});

test('R72 (addFollowUp): enqueues the acquire-task (trigger critic-follow-up); dedups open + recently-failed goals', async () => {
  const h = await harness([]);
  try {
    const fu = h.curriculum.addFollowUp({ goal: 'Harvest mature wheat to obtain wheat_seeds', successCriteria: 'have ≥3 wheat_seeds', check: { item: 'wheat_seeds', count: 3 } }, 'Harry');
    assert.ok(fu, 'the follow-up task was created');
    assert.equal(fu!.assignee, 'Harry', 'assigned to the blocked villager');
    assert.deepEqual(fu!.check, { item: 'wheat_seeds', count: 3 }, 'carries the objective check');
    assert.ok(h.state.ledger.open.some((t) => t.id === fu!.id), 'in the open ledger (sole writer)');
    const ev = h.journal.query({ kinds: ['god.task-proposed'] }).at(-1)!;
    assert.equal((ev.payload as { trigger: string }).trigger, 'critic-follow-up', 'journaled with the follow-up trigger');

    // Anti-loop: the SAME goal is now open → a second follow-up is dropped (no duplicate, no pivot chain).
    assert.equal(h.curriculum.addFollowUp({ goal: 'harvest mature wheat to obtain wheat_seeds' }, 'Harry'), undefined, 'deduped against an open goal (case-insensitive)');

    // And a goal that was recently FAILED is also refused (the blocked→acquire chain can circle back).
    h.state.ledger.failed.push({ task: { id: 'f1', goal: 'Get more dirt', successCriteria: 's', context: '', maxRetries: 4 }, closedAt: 1, reason: 'blocked' });
    assert.equal(h.curriculum.addFollowUp({ goal: 'get more dirt' }, 'Harry'), undefined, 'deduped against a recently-failed goal');
    // A genuinely new goal still goes through.
    assert.ok(h.curriculum.addFollowUp({ goal: 'Craft a wooden hoe' }, 'Harry'), 'a fresh goal is enqueued');
  } finally {
    await h.close();
  }
});

test('R70 (failed-frontier memory): a failed task with a reason is rendered into the proposal context', async () => {
  const h = await harness([proposeTurn({ goal: 'next thing', successCriteria: 's' })]);
  try {
    h.state.ledger.failed.push({
      task: { id: 'old', goal: 'Bake bread at a crafting table', successCriteria: 's', context: '', maxRetries: 4 },
      closedAt: 1,
      reason: 'blocked: « Bake bread » not converged after 2 exhausted rollout(s) — dernier obstacle: aucune table de craft à portée',
    });
    await h.curriculum.proposeTask({ trigger: 'idle', villager: 'Harry' });
    const msg = lastProposalUserMessage(h.llm);
    assert.match(msg, /FRONTIÈRE — ÉCHOUÉES/, 'the failed frontier is rendered');
    assert.match(msg, /Bake bread at a crafting table/, 'the failed goal is listed');
    assert.match(msg, /aucune table de craft à portée/, 'the obstacle is surfaced as cross-deliberation memory');
    assert.match(msg, /NE re-propose PAS un but déjà échoué/i, 'with an explicit do-not-repeat guard');
  } finally {
    await h.close();
  }
});

test('M4-1 (warmup gate): in early game the proposer is told to stay survival-basic (config table)', async () => {
  const h = await harness([proposeTurn({ goal: 'Gather wood', successCriteria: 'have 4 oak_log' })]);
  try {
    // With an empty ledger we are in warmup — the rendered context must say so.
    await h.curriculum.proposeTask({ trigger: 'idle' });
    assert.match(lastProposalUserMessage(h.llm), /survie|warm|basique|early/i, 'the warmup phase is signalled to the proposer');
  } finally {
    await h.close();
  }
});

test('inventory awareness: the requesting villager’s current items are rendered, with the no-re-acquire guard', async () => {
  // The farm.json failure: a hoe + seeds are already in hand, yet God proposed gathering wood for a hoe.
  const h = await harness([proposeTurn({ goal: 'Bake bread', successCriteria: 'have 1 bread' })]);
  try {
    await h.curriculum.proposeTask({
      trigger: 'idle',
      villager: 'Firmin',
      snapshot: snapshotWith([{ name: 'iron_hoe', count: 1 }, { name: 'wheat_seeds', count: 32 }]),
    });
    const userMsg = lastProposalUserMessage(h.llm);
    assert.match(userMsg, /INVENTAIRE ACTUEL \(Firmin\)/, 'the villager inventory is a labelled section');
    assert.match(userMsg, /iron_hoe ×1/, 'the held hoe is visible');
    assert.match(userMsg, /wheat_seeds ×32/, 'the held seeds are visible');
    assert.match(userMsg, /NE propose PAS d’acquérir/i, 'the no-re-acquire guard is present');
  } finally {
    await h.close();
  }
});

test('mission-aware warmup: with a scenario mission the warmup nudge serves the mission, not generic survival', async () => {
  const h = await harness([proposeTurn({ goal: 'Sow the first row', successCriteria: 'rows sown' })], { hasMissionDirective: true });
  try {
    await h.curriculum.proposeTask({
      trigger: 'idle',
      villager: 'Firmin',
      snapshot: snapshotWith([{ name: 'iron_hoe', count: 1 }]),
    });
    const userMsg = lastProposalUserMessage(h.llm);
    assert.match(userMsg, /au service de la mission/i, 'warmup defers to the mission');
    assert.match(userMsg, /INVENTAIRE ET LES COMPÉTENCES ACTUELS/i, 'warmup points at what the villager already has');
    assert.doesNotMatch(userMsg, /SURVIE basique \(bois/i, 'the generic wood/food/tools survival default is suppressed under a mission');
  } finally {
    await h.close();
  }
});

test('library coverage: existing reusable MORTAL skills are listed for composition; divine skills are hidden', async () => {
  const library = fakeLibrary([
    { name: 'till-block', summary: 'hoe one dirt/grass block into farmland', tier: 'mortal' },
    { name: 'sow-seed', summary: 'plant a seed on adjacent farmland', tier: 'mortal' },
    { name: 'smite', summary: 'divine lightning strike', tier: 'divine' },
  ]);
  const h = await harness([proposeTurn({ goal: 'Compose the bread loop', successCriteria: 'loop runs' })], { library });
  try {
    await h.curriculum.proposeTask({ trigger: 'idle', villager: 'Firmin' });
    const userMsg = lastProposalUserMessage(h.llm);
    assert.match(userMsg, /COMPÉTENCES EXISTANTES/, 'the existing-skills section is rendered');
    assert.match(userMsg, /till-block — hoe one dirt/, 'a mortal skill is listed with its summary');
    assert.match(userMsg, /sow-seed —/, 'a second mortal skill is listed');
    assert.doesNotMatch(userMsg, /smite/, 'divine skills are not villager work — hidden from the curriculum coverage');
    assert.match(userMsg, /COMPOSE/i, 'God is told a good task composes these');
  } finally {
    await h.close();
  }
});
