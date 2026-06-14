// ★ M4-3 — the FULL loop via the real assignment path. Replaces the M3 GATE's synchronous injection
// driver: curriculum.proposeTask → orchestrator.dispatch → Directive to the villager's inbox → the
// villager's brain deliberates (the directive is in its context) → rollout → critic.judge →
// routeVerdict → revise/close. The coordination touches BOTH god/ and villagers/, so it lives in the
// composition root (main.ts RolloutCoordinator) — never inside a layer-3 actor (the dependency law).
//
// PROOF: 3+ villagers run unattended and converge; D-09 re-enqueue lands in the REAL assignment path
// (extends the M3-6 recovery test — an abandoned task gets re-assigned + re-converged).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptedLlm, type ScriptedTurn } from './fakes/scripted-llm';
import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { SkillLibrary, AllGranted } from '../src/skills/library';
import { SkillEngine } from '../src/skills/engine';
import { SkillRetriever } from '../src/skills/retrieve';
import { EmbeddingsService } from '../src/llm/embeddings';
import { LlmClient, ProviderRegistry } from '../src/llm/client';
import { LlmScheduler } from '../src/llm/scheduler';
import { ToolRegistry } from '../src/villagers/tools';
import { ContextPackBuilder } from '../src/villagers/context-pack';
import { Brain } from '../src/villagers/brain';
import { VillagerInbox } from '../src/villagers/inbox';
import { GodService } from '../src/god/god';
import { CriticDesk } from '../src/god/critic';
import { Curriculum } from '../src/god/curriculum';
import { Orchestrator } from '../src/god/orchestrator';
import { RolloutCoordinator } from '../src/main';
import type { Bot } from '../src/types/index';

// A villager that fixes the skill on the FIRST try (one deliberation, one run, done).
const GOOD = 'async function collect(bot, args, ctx) { bot.give("oak_log", 3); return { collected: 3 }; }';
const writeTurn = (name: string, code: string): ScriptedTurn => ({ toolCalls: [{ name: 'write_skill', arguments: { name, summary: 'récolte', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code } }] });
const runTurn = (name: string): ScriptedTurn => ({ toolCalls: [{ name: 'run_skill', arguments: { name, args: {} } }] });
const doneTurn = (s: string): ScriptedTurn => ({ toolCalls: [{ name: 'done', arguments: { summary: s } }] });

// One villager's full converge-on-first-try turn quartet (3 brain turns + 1 critic verdict turn).
const convergeTurns = (name: string): ScriptedTurn[] => [
  writeTurn(name, GOOD), runTurn(name), doneTurn('fait'),
  { toolCalls: [{ name: 'verdict', arguments: { success: true, critique: 'générique et propre', libraryAction: 'admit' } }] },
];

interface Wiring {
  coordinator: RolloutCoordinator;
  curriculum: Curriculum;
  orchestrator: Orchestrator;
  god: GodService;
  library: SkillLibrary;
  journal: MemoryJournal;
  llm: ScriptedLlm;
  close: () => Promise<void>;
}

async function wire(villagers: string[], turns: ScriptedTurn[]): Promise<Wiring> {
  const dir = mkdtempSync(join(tmpdir(), 'eden-loop-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  const bots = new Map<string, Bot>(villagers.map((v) => [v, new FakeBot({ username: v }) as unknown as Bot]));
  const engine = new SkillEngine({
    library, journal, grants: new AllGranted(),
    resolveBot: (name) => bots.get(name) ?? (bots.values().next().value as Bot),
    runDefaultTimeoutMs: 120_000, stallSeconds: 20, maxCallDepth: 8, autoQuarantineAfter: 5,
  });
  const retriever = new SkillRetriever({ library, embeddings: new EmbeddingsService({}), grants: new AllGranted() });
  const tools = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400 });
  const builder = new ContextPackBuilder({ journal });
  const llm = await ScriptedLlm.start(turns);
  const providers = new ProviderRegistry({ strong: { baseUrl: llm.url, model: 'strong', inputTokenBudget: 48000 }, fast: { baseUrl: llm.url, model: 'fast', inputTokenBudget: 16000 } });
  const client = new LlmClient({ providers, journal });
  const scheduler = new LlmScheduler({ maxConcurrent: 3, perVillagerCooldownMs: 0 });
  const brain = new Brain({ builder, tools, scheduler, client, journal });
  const inboxes = new Map(villagers.map((v) => [v, new VillagerInbox(v, journal)]));
  const embeddings = new EmbeddingsService({});

  const god = new GodService({ journal, library, inboxes });
  const curriculum = new Curriculum({ state: god.state, journal, client, scheduler, embeddings });
  // Wire the ledger writer (Curriculum is the sole writer of the ledger, S2) — replaces god's direct writes.
  (god as unknown as { ledger: Curriculum }).ledger = curriculum;
  const orchestrator = new Orchestrator({ state: god.state, journal, client, scheduler, inboxes });
  const critic = new CriticDesk({ client, scheduler, journal });

  const roster = new Map(villagers.map((v) => [v, { name: v, role: 'farmer', persona: `Tu es ${v}.` }]));
  const coordinator = new RolloutCoordinator({ god, curriculum, orchestrator, critic, brain, library, inboxes, roster });
  return { coordinator, curriculum, orchestrator, god, library, journal, llm, close: () => llm.close() };
}

test('★ M4-3: a proposed task flows curriculum → orchestrator → inbox → brain → rollout → critic → admit', async () => {
  const w = await wire(['Firmin'], [
    // 1) curriculum proposes (propose_task), 2) orchestrator dispatches (directive),
    // 3) brain converges (write/run/done), 4) critic admits.
    { toolCalls: [{ name: 'propose_task', arguments: { goal: 'collect 3 oak logs', successCriteria: 'have 3 oak_log', check: { item: 'oak_log', count: 3 }, assignee: 'Firmin' } }] },
    { toolCalls: [{ name: 'directive', arguments: { to: 'Firmin', goal: 'collect 3 oak logs', reason: 'le grenier est vide', priority: 'normal', taskRef: '$task' } }] },
    ...convergeTurns('collect-oak-logs'),
  ]);
  try {
    const outcome = await w.coordinator.runOnce({ trigger: 'idle', villager: 'Firmin' });
    assert.ok(outcome, 'a task was proposed and run');
    assert.equal(outcome!.converged, true, 'the loop converged through the real assignment path');

    // The directive reached the villager's inbox (the orchestrator delivered it) before the brain woke.
    const dir = w.journal.query({ kinds: ['god.directive'] });
    assert.equal(dir.length, 1, 'one directive opened');
    assert.equal((dir[0]!.payload as { to: string }).to, 'Firmin');
    assert.ok(w.journal.query({ kinds: ['inbox.delivered'] }).length >= 1, 'the directive was delivered to the inbox');

    // The task was proposed (curriculum) and closed completed (curriculum, sole writer of the ledger).
    assert.equal(w.journal.query({ kinds: ['god.task-proposed'] }).length, 1);
    assert.equal((w.journal.query({ kinds: ['god.task-closed'] })[0]!.payload as { outcome: string }).outcome, 'completed');
    assert.equal(w.god.state.ledger.completed.length, 1);

    // The skill landed in active-probation (D-12), and the directive was closed.
    assert.equal(w.library.activeVersion('collect-oak-logs')?.status, 'active-probation');
    assert.equal(w.god.state.directivesOpen!.length, 0, 'the directive closed when the task completed');
    assert.equal((w.journal.query({ kinds: ['god.directive-closed'] })[0]!.payload as { reason: string }).reason, 'completed');
  } finally {
    await w.close();
  }
});

test('★ M4-3 (multi-villager): 3 villagers run unattended and all converge', async () => {
  const villagers = ['Firmin', 'Colette', 'Hugo'];
  const turns: ScriptedTurn[] = [];
  for (const v of villagers) {
    const skill = `collect-${v.toLowerCase()}`;
    turns.push({ toolCalls: [{ name: 'propose_task', arguments: { goal: `task for ${v}`, successCriteria: 'have 3 oak_log', check: { item: 'oak_log', count: 3 }, assignee: v } }] });
    turns.push({ toolCalls: [{ name: 'directive', arguments: { to: v, goal: `task for ${v}`, reason: 'work', priority: 'normal', taskRef: '$task' } }] });
    turns.push(...convergeTurns(skill));
  }
  const w = await wire(villagers, turns);
  try {
    let converged = 0;
    for (const v of villagers) {
      const out = await w.coordinator.runOnce({ trigger: 'idle', villager: v });
      if (out?.converged) converged++;
    }
    assert.equal(converged, 3, 'all three villagers converged unattended');
    assert.equal(w.god.state.ledger.completed.length, 3, 'three tasks completed in the ledger');
    assert.equal(w.journal.query({ kinds: ['god.task-proposed'] }).length, 3);
    assert.equal(w.journal.query({ kinds: ['god.directive'] }).length, 3);
  } finally {
    await w.close();
  }
});

test('★ M4-3 (D-09 re-enqueue in the REAL path): an abandoned task is re-assigned + re-converges', async () => {
  // Pre-crash: a task is proposed + a rollout opened (it points at currentRolloutId), then the host
  // "crashes". recoverRollouts() abandons it and re-enqueues through the ledger writer (Curriculum).
  // The coordinator then RE-ASSIGNS it via the real orchestrator→inbox path and it converges.
  const w = await wire(['Firmin'], [
    // crash setup: a propose (creates the open task) — no directive/brain turns consumed yet.
    { toolCalls: [{ name: 'propose_task', arguments: { goal: 'collect 3 oak logs', successCriteria: 'have 3 oak_log', check: { item: 'oak_log', count: 3 }, assignee: 'Firmin' } }] },
    // after recovery: dispatch + converge through the real path.
    { toolCalls: [{ name: 'directive', arguments: { to: 'Firmin', goal: 'collect 3 oak logs', reason: 'retry', priority: 'normal', taskRef: '$task' } }] },
    ...convergeTurns('collect-oak-logs'),
  ]);
  try {
    // 1) propose a task and open a rollout (simulating an in-flight attempt at crash time).
    const task = await w.curriculum.proposeTask({ trigger: 'idle', villager: 'Firmin' });
    assert.ok(task);
    const rollout = w.god.openRollout(task!.id);
    assert.equal(task!.currentRolloutId, rollout.id);

    // 2) boot recovery (startup step 7): abandon + re-enqueue through the REAL ledger writer.
    const abandoned = w.god.recoverRollouts();
    assert.equal(abandoned, 1, 'the in-flight rollout was abandoned');
    assert.equal(task!.currentRolloutId, undefined, 'pointer cleared (D-09)');
    assert.ok(w.god.state.ledger.open.some((t) => t.id === task!.id), 're-enqueued in the open ledger');
    assert.equal(w.journal.query({ kinds: ['god.rollout-abandoned'] }).length, 1);

    // 3) the coordinator re-assigns the re-enqueued task via the real orchestrator→inbox path.
    const outcome = await w.coordinator.assignAndRun(task!, { trigger: 'critic-follow-up' });
    assert.equal(outcome.converged, true, 'the re-enqueued task re-converged through the real assignment path');
    assert.equal((w.journal.query({ kinds: ['god.directive'] })[0]!.payload as { to: string }).to, 'Firmin');
    assert.equal(w.god.state.ledger.completed.length, 1, 'the recovered task completed');
  } finally {
    await w.close();
  }
});
