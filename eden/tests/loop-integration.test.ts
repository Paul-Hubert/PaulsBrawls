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
import { ContextPackBuilder, type ContextPackInput } from '../src/villagers/context-pack';
import { Brain } from '../src/villagers/brain';
import { VillagerInbox } from '../src/villagers/inbox';
import { GodService } from '../src/god/god';
import { CriticDesk } from '../src/god/critic';
import { Curriculum } from '../src/god/curriculum';
import { Orchestrator } from '../src/god/orchestrator';
import { RolloutCoordinator } from '../src/main';
import type { Bot, Snapshot, Task } from '../src/types/index';

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
  retriever: SkillRetriever;
  journal: MemoryJournal;
  llm: ScriptedLlm;
  close: () => Promise<void>;
}

/** R61: opt the coordinator into the skill retriever + exemplar set. Off by default so the M4-3 tests
 *  above keep their `retrievedSkills: []` baseline (the backward-compat path). */
interface WireOpts {
  withRetriever?: boolean;
  exemplars?: Array<{ name: string; code: string }>;
}

async function wire(villagers: string[], turns: ScriptedTurn[], wopts: WireOpts = {}): Promise<Wiring> {
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
  const coordinator = new RolloutCoordinator({
    god, curriculum, orchestrator, critic, brain, library, inboxes, roster,
    ...(wopts.withRetriever ? { retriever } : {}),
    ...(wopts.exemplars ? { exemplars: wopts.exemplars } : {}),
  });
  return { coordinator, curriculum, orchestrator, god, library, retriever, journal, llm, close: () => llm.close() };
}

/** All system-message contents the brain sent — the villager context-pack frame carries `## CAPACITÉS`. */
function capabilitiesPrompts(llm: ScriptedLlm): string[] {
  return llm.requests
    .flatMap((r) => ((r.body?.messages ?? []) as Array<{ role: string; content?: string }>))
    .filter((m) => m.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .filter((c) => c.includes('## CAPACITÉS'));
}

/** Seed a relevant `active` skill the retriever can surface (keyword floor in tests — overlap the query). */
function seedActiveSkill(library: SkillLibrary, name: string, summary: string, tags: string[]): void {
  library.seedStock(
    {
      name, summary, tags,
      params: { type: 'object', properties: {} },
      returns: { type: 'object', properties: {} },
      code: `async function ${name.replace(/-/g, '_')}(bot, args, ctx) { return {}; }`,
      author: { kind: 'stock' },
    },
    'active',
  );
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

test('★ R70: a non-converging task is RESUMED across runOnce (not re-proposed) and the R65 breaker fires', async () => {
  // The brain gives up every revision (a bare `done` — no draft, so each rollout exhausts maxRetries
  // without converging). Before R70 the autonomous loop proposed a NEW task id every idle turn, so the
  // breaker (keyed per id) never reached its 2nd exhausted rollout and the open list filled with
  // duplicates (the live "bake bread ×9" grind). Now: the 1st runOnce proposes; the 2nd RESUMES the same
  // id (no second proposal), the breaker fires, and the task closes `failed` so the village moves on.
  // Turn budget: propose(1) + [dispatch(1) + maxRetries×bare-done(4)] per rollout × 2 = 11 turns.
  const w = await wire(['Firmin'], [
    { toolCalls: [{ name: 'propose_task', arguments: { goal: 'bake bread', successCriteria: 'have 1 bread', assignee: 'Firmin' } }] },
    { toolCalls: [{ name: 'directive', arguments: { to: 'Firmin', goal: 'bake bread', reason: 'work', priority: 'normal', taskRef: '$task' } }] },
    doneTurn('je ne sais pas'), doneTurn('je ne sais pas'), doneTurn('je ne sais pas'), doneTurn('je ne sais pas'),
    { toolCalls: [{ name: 'directive', arguments: { to: 'Firmin', goal: 'bake bread', reason: 'retry', priority: 'normal', taskRef: '$task' } }] },
    doneTurn('je ne sais pas'), doneTurn('je ne sais pas'), doneTurn('je ne sais pas'), doneTurn('je ne sais pas'),
  ]);
  try {
    const r1 = await w.coordinator.runOnce({ trigger: 'idle', villager: 'Firmin' });
    assert.equal(r1?.converged, false, 'first rollout exhausted without converging');
    assert.equal(w.god.state.ledger.open.length, 1, 'the task stays open after one exhausted rollout');
    assert.equal(w.god.state.ledger.open[0]!.currentRolloutId, undefined, 'its rollout pointer is cleared → resumable next turn');

    const r2 = await w.coordinator.runOnce({ trigger: 'idle', villager: 'Firmin' });
    assert.equal(r2?.converged, false, 'second rollout also exhausted');
    assert.equal(r2!.taskId, r1!.taskId, 'the SAME task id was resumed, not a fresh proposal');

    assert.equal(w.journal.query({ kinds: ['god.task-proposed'] }).length, 1, 'exactly one proposal — the 2nd turn RESUMED, no duplicate');
    assert.equal(w.god.state.ledger.failed.length, 1, 'the R65 breaker closed the task failed through the autonomous loop');
    assert.equal(w.god.state.ledger.open.length, 0, 'the village moves on (no grind on an unconvergeable wall)');
    const closed = w.journal.query({ kinds: ['god.task-closed'] });
    assert.equal(closed.length, 1);
    assert.equal((closed[0]!.payload as { outcome: string }).outcome, 'failed');
  } finally {
    await w.close();
  }
});

test('★ R70 (claim): runOnce RESUMES a pre-existing unassigned open task (claiming it) instead of proposing', async () => {
  // An open task with NO assignee (e.g. an admin-injected or decomposed sub-task) must be picked up and
  // claimed by the driving villager — not shadowed by a fresh proposal. Proves the resume-before-propose
  // branch AND the unassigned-claim line in runOnce, through to convergence on the real path.
  const w = await wire(['Firmin'], [
    { toolCalls: [{ name: 'directive', arguments: { to: 'Firmin', goal: 'collect 3 oak logs', reason: 'le grenier est vide', priority: 'normal', taskRef: '$task' } }] },
    ...convergeTurns('collect-oak-logs'),
  ]);
  try {
    const t: Task = { id: 'seed-open', goal: 'collect 3 oak logs', successCriteria: 'have 3 oak_log', context: '', maxRetries: 4 };
    w.curriculum.addTask(t); // unassigned, open, no live rollout

    const out = await w.coordinator.runOnce({ trigger: 'idle', villager: 'Firmin' });
    assert.equal(out?.converged, true, 'the resumed task converged through the real assignment path');
    assert.equal(out!.taskId, 'seed-open', 'the SEEDED task id was run — not a freshly proposed one');
    assert.equal(t.assignee, 'Firmin', 'the unassigned open task was claimed by the driving villager');
    // The only god.task-proposed is the seed's own addTask (trigger 'admin') — runOnce added no idle proposal.
    const proposed = w.journal.query({ kinds: ['god.task-proposed'] });
    assert.equal(proposed.length, 1, 'no NEW proposal — runOnce resumed the open task');
    assert.equal((proposed[0]!.payload as { trigger: string }).trigger, 'admin', 'the one proposal is the seed (addTask), not a curriculum idle proposal');
    assert.equal(w.god.state.ledger.completed.length, 1, 'the resumed task closed completed');
  } finally {
    await w.close();
  }
});

test('★ R72: a BLOCKED verdict stops the rollout fast, closes the task, and enqueues the acquire follow-up', async () => {
  // Harry has no seeds: till-and-sow is correct but a permanent no-op. The critic returns blocked + a
  // follow-up ("harvest mature wheat to obtain wheat_seeds"). The rollout must NOT grind its 4 retries
  // revising correct code — it stops after the first verdict, closes the task blocked, and the curriculum
  // pivots to the acquire-task. Turns: propose(1) + dispatch(1) + write/run/done(3) + blocked verdict(1).
  const w = await wire(['Harry'], [
    { toolCalls: [{ name: 'propose_task', arguments: { goal: 'till-and-sow', successCriteria: 'sow wheat', assignee: 'Harry' } }] },
    { toolCalls: [{ name: 'directive', arguments: { to: 'Harry', goal: 'till-and-sow', reason: 'farm', priority: 'normal', taskRef: '$task' } }] },
    writeTurn('till-and-sow', GOOD), runTurn('till-and-sow'), doneTurn('rien à semer — 0 graines'),
    { toolCalls: [{ name: 'verdict', arguments: { success: false, critique: 'no wheat_seeds in inventory — cannot sow', libraryAction: 'none', blocked: true, followUp: { goal: 'Harvest mature wheat to obtain wheat_seeds', successCriteria: 'have ≥3 wheat_seeds', check: { item: 'wheat_seeds', count: 3 } } } }] },
  ]);
  try {
    const out = await w.coordinator.runOnce({ trigger: 'idle', villager: 'Harry' });
    assert.equal(out?.converged, false, 'a blocked task does not converge');
    assert.equal(out?.blocked, true, 'the rollout reports blocked');
    assert.equal(out?.revisions, 1, 'FAIL FAST — stopped after the first verdict, did NOT grind all 4 retries');

    // The blocked task closed failed with a blocked-on-resource reason (the village moves on).
    const closed = w.journal.query({ kinds: ['god.task-closed'] });
    assert.equal(closed.length, 1);
    const cp = closed[0]!.payload as { outcome: string; reason?: string };
    assert.equal(cp.outcome, 'failed');
    assert.match(cp.reason ?? '', /blocked-on-resource/, 'the reason marks it blocked on a resource');
    assert.equal(w.god.state.ledger.open.some((t) => t.goal === 'till-and-sow'), false, 'the blocked task is no longer open');

    // The curriculum pivoted: the acquire follow-up is now an open task (trigger critic-follow-up).
    const acquire = w.god.state.ledger.open.find((t) => t.goal === 'Harvest mature wheat to obtain wheat_seeds');
    assert.ok(acquire, 'the acquire follow-up was enqueued');
    assert.deepEqual(acquire!.check, { item: 'wheat_seeds', count: 3 }, 'with the critic-supplied objective check');
    const proposed = w.journal.query({ kinds: ['god.task-proposed'] });
    assert.equal((proposed.at(-1)!.payload as { trigger: string; goal: string }).trigger, 'critic-follow-up', 'the follow-up is journaled as a critic follow-up');
  } finally {
    await w.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ★ R61 — the retriever is wired into both deliberation paths, so a villager acts on relevant EXISTING
// skills (Voyager, owner #8/#10) instead of discovering the library by spamming `search_skills` (R60).
// ─────────────────────────────────────────────────────────────────────────────

test('★ R61 (rollout path): retrieved skills are pre-loaded into the deliberation; exemplars are not duplicated', async () => {
  const w = await wire(
    ['Firmin'],
    [
      { toolCalls: [{ name: 'propose_task', arguments: { goal: 'collect 3 oak logs', successCriteria: 'have 3 oak_log', check: { item: 'oak_log', count: 3 }, assignee: 'Firmin' } }] },
      { toolCalls: [{ name: 'directive', arguments: { to: 'Firmin', goal: 'collect 3 oak logs', reason: 'le grenier est vide', priority: 'normal', taskRef: '$task' } }] },
      ...convergeTurns('collect-oak-logs'),
    ],
    { withRetriever: true, exemplars: [{ name: 'collect-blocks', code: 'async function collect_blocks(bot, args, ctx) { return {}; }' }] },
  );
  // A relevant non-exemplar skill (must surface as a one-liner) + an exemplar-NAMED relevant skill (injected
  // as full code already → must NOT be duplicated into the retrieved one-liner list).
  seedActiveSkill(w.library, 'gather-oak', 'collect oak logs from nearby trees', ['collect', 'oak', 'logs']);
  seedActiveSkill(w.library, 'collect-blocks', 'collect oak logs in bulk', ['collect', 'oak', 'logs']);
  try {
    const outcome = await w.coordinator.runOnce({ trigger: 'idle', villager: 'Firmin' });
    assert.equal(outcome?.converged, true, 'the rollout converged through the real assignment path');

    const cap = capabilitiesPrompts(w.llm)[0];
    assert.ok(cap, 'a villager deliberation prompt was assembled');
    assert.match(cap, /exécute-les avec run_skill/, 'the capabilities section lists retrieved skills (reusable-skills header)');
    assert.match(cap, /- gather-oak —/, 'the relevant skill is pre-loaded as a one-liner');
    assert.doesNotMatch(cap, /- collect-blocks —/, 'an exemplar-named skill is NOT duplicated as a one-liner');
    assert.match(cap, /\/\/ collect-blocks/, 'the exemplar is still injected as full code');
  } finally {
    await w.close();
  }
});

test('★ R61 (backward-compat): a coordinator built WITHOUT a retriever pre-loads nothing', async () => {
  const w = await wire(['Firmin'], [
    { toolCalls: [{ name: 'propose_task', arguments: { goal: 'collect 3 oak logs', successCriteria: 'have 3 oak_log', check: { item: 'oak_log', count: 3 }, assignee: 'Firmin' } }] },
    { toolCalls: [{ name: 'directive', arguments: { to: 'Firmin', goal: 'collect 3 oak logs', reason: 'work', priority: 'normal', taskRef: '$task' } }] },
    ...convergeTurns('collect-oak-logs'),
  ]); // no WireOpts → the optional retriever is absent (the M3/M4 baseline)
  // Even a perfectly relevant live skill is NOT surfaced when the retriever is absent.
  seedActiveSkill(w.library, 'gather-oak', 'collect oak logs from nearby trees', ['collect', 'oak', 'logs']);
  try {
    const outcome = await w.coordinator.runOnce({ trigger: 'idle', villager: 'Firmin' });
    assert.equal(outcome?.converged, true);
    const cap = capabilitiesPrompts(w.llm)[0];
    assert.ok(cap, 'a villager deliberation prompt was assembled');
    assert.doesNotMatch(cap, /exécute-les avec run_skill/, 'no retriever → retrievedSkills stays empty (no reusable-skills header)');
  } finally {
    await w.close();
  }
});

test('★ R61 (reactive path): a reactive wake-up pre-loads retrieved skills for the trigger', async () => {
  // Mirrors main.ts's reactive WakeupFn (fast tier, includeExemplarCode:false): the retrieved one-liners
  // are the wake-up's MAIN skill signal. Query = the trigger(s) + hint(s) that woke the villager.
  const dir = mkdtempSync(join(tmpdir(), 'eden-react-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  seedActiveSkill(library, 'defend-self', 'fight back against a hostile attacker', ['hurt', 'zombie', 'defend']);
  const bot = new FakeBot({ username: 'Garde' }) as unknown as Bot;
  const engine = new SkillEngine({
    library, journal, grants: new AllGranted(), resolveBot: () => bot,
    runDefaultTimeoutMs: 120_000, stallSeconds: 20, maxCallDepth: 8, autoQuarantineAfter: 5,
  });
  const retriever = new SkillRetriever({ library, embeddings: new EmbeddingsService({}), grants: new AllGranted() });
  const tools = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400 });
  const builder = new ContextPackBuilder({ journal });
  const llm = await ScriptedLlm.start([doneTurn('rien à faire')]);
  const providers = new ProviderRegistry({ strong: { baseUrl: llm.url, model: 'strong', inputTokenBudget: 48000 }, fast: { baseUrl: llm.url, model: 'fast', inputTokenBudget: 16000 } });
  const client = new LlmClient({ providers, journal });
  const scheduler = new LlmScheduler({ maxConcurrent: 3, perVillagerCooldownMs: 0 });
  const brain = new Brain({ builder, tools, scheduler, client, journal });
  const SNAP: Snapshot = { biome: 'plains', time: 1200, position: [0, 64, 0], health: 20, hunger: 20, equipment: [], inventory: [], nearbyEntities: [], nearbyBlocks: [], knownChests: [] };
  try {
    const triggers = ['hurt'];
    const hints = ['un zombie attaque'];
    const retrievedSkills = await retriever.search(`${triggers.join(' ')} ${hints.join(' ')}`.trim(), { tier: 'mortal', villager: 'Garde', k: 8 });
    assert.ok(retrievedSkills.some((s) => s.name === 'defend-self'), 'the retriever surfaced the relevant skill for the trigger');

    const input: ContextPackInput = {
      villager: 'Garde', runner: { name: 'Garde', role: 'guard', tier: 'mortal' },
      persona: 'Tu es Garde.', role: 'guard',
      triggers, hint: hints.join(' / '),
      snapshot: SNAP, runningSkill: null, directive: null, openTask: null,
      recentEvents: [], memories: [], retrievedSkills, exemplars: [], includeExemplarCode: false,
      toolNames: brain.toolNames(), inbox: [],
      tier: 'fast', inputTokenBudget: 16000,
    };
    await brain.deliberate(input, { lane: 'combat', kind: 'reactive' });

    const cap = capabilitiesPrompts(llm)[0];
    assert.ok(cap, 'a reactive deliberation prompt was assembled');
    assert.match(cap, /exécute-les avec run_skill/, 'the reactive pack lists retrieved skills (reusable-skills header)');
    assert.match(cap, /- defend-self —/, 'the relevant skill for the trigger is pre-loaded');
  } finally {
    await llm.close();
  }
});
