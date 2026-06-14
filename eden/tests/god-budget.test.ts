// M4-4 — D-13: throughput-limited budget; caps are a safety valve. Per-desk daily caps default null
// (R49: throughput is the limiter, not the wallet); a `null` cap NEVER degrades. A breach degrades the
// RIGHT desk: critic → `check` + a templated critique (no LLM call); curriculum → repeat the last task
// type (no LLM call); orchestrator → urgent-only dispatch. The strong/fast tier split: strong for
// novelty (critic, curriculum proposal/decompose), fast for dispatch/QA. Verdict batching caps at 3.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ScriptedLlm, type ScriptedTurn } from './fakes/scripted-llm';
import { MemoryJournal } from './fakes/memory-journal';
import { LlmClient, ProviderRegistry } from '../src/llm/client';
import { LlmScheduler, BudgetTracker } from '../src/llm/scheduler';
import { EmbeddingsService } from '../src/llm/embeddings';
import { CriticDesk, type CriticContext } from '../src/god/critic';
import { Curriculum } from '../src/god/curriculum';
import { Orchestrator } from '../src/god/orchestrator';
import { VillagerInbox } from '../src/villagers/inbox';
import type { GodState } from '../src/god/god';
import type { CriticTicket, Dossier, RunReport, Snapshot, Task, TaskLedger, Inbox } from '../src/types/index';

const SNAP = (inv: Array<{ name: string; count: number }> = []): Snapshot => ({
  biome: 'plains', time: 0, position: [0, 64, 0], health: 20, hunger: 20,
  equipment: [], inventory: inv, nearbyEntities: [], nearbyBlocks: [], knownChests: [],
});
function report(over: Partial<RunReport> = {}): RunReport {
  return { runId: 'run-1', rolloutId: 'roll-1', skill: 'collect-oak-logs', version: 1, villager: 'Firmin', args: {}, outcome: { ok: true }, startedAt: 0, durationMs: 100, pulses: 3, deepestDepth: 0, callTree: [], worldBefore: SNAP(), worldAfter: SNAP([{ name: 'oak_log', count: 3 }]), ...over };
}
const task = (over: Partial<Task> = {}): Task => ({ id: 'task-1', goal: 'collect 3 oak logs', assignee: 'Firmin', successCriteria: 's', context: '', maxRetries: 4, check: { item: 'oak_log', count: 3 }, ...over });
const ticket = (id = 'ticket-1'): CriticTicket => ({ id, source: 'rollout', runReportRef: 'run-1', taskRef: 'task-1', filedAt: 0 });

function emptyState(): GodState {
  return { ledger: { completed: [], failed: [], open: [] } as TaskLedger, dossiers: new Map<string, Dossier>(), criticQueue: [], rollouts: new Map(), tasks: new Map(), directivesOpen: [] };
}

async function wireLlm(turns: ScriptedTurn[]): Promise<{ client: LlmClient; scheduler: LlmScheduler; journal: MemoryJournal; llm: ScriptedLlm }> {
  const journal = new MemoryJournal();
  const llm = await ScriptedLlm.start(turns);
  const providers = new ProviderRegistry({ strong: { baseUrl: llm.url, model: 'strong', inputTokenBudget: 48000 }, fast: { baseUrl: llm.url, model: 'fast', inputTokenBudget: 16000 } });
  const client = new LlmClient({ providers, journal });
  const scheduler = new LlmScheduler({ maxConcurrent: 3, perVillagerCooldownMs: 0 });
  return { client, scheduler, journal, llm };
}
const chatCalls = (llm: ScriptedLlm): number => llm.requests.filter((r) => String(r.url).includes('/chat/completions')).length;

// ── BudgetTracker semantics (D-13 / R49) ──────────────────────────────────────

test('M4-4 (R49): a null daily cap NEVER degrades, no matter the spend', () => {
  const b = new BudgetTracker({ critic: { dailyTokens: null }, curriculum: { dailyTokens: null }, orchestrator: { dailyTokens: null } });
  b.spend('critic', 10_000_000);
  assert.equal(b.degraded('critic'), false, 'uncapped desks never degrade (throughput is the limiter)');
  assert.equal(b.remaining('critic'), null, 'uncapped → no remaining ceiling');
});

test('M4-4 (D-13): a desk degrades only once spend EXCEEDS its cap; resetDay clears it', () => {
  const b = new BudgetTracker({ critic: { dailyTokens: 1000 }, curriculum: { dailyTokens: null }, orchestrator: { dailyTokens: null } });
  b.spend('critic', 1000);
  assert.equal(b.degraded('critic'), false, 'at exactly the cap, not yet degraded');
  b.spend('critic', 1);
  assert.equal(b.degraded('critic'), true, 'over the cap → degraded');
  assert.equal(b.degraded('curriculum'), false, 'a different (uncapped) desk is unaffected');
  b.resetDay();
  assert.equal(b.degraded('critic'), false, 'the dawn reset clears the accumulator');
});

test('M4-4 (R49 throughput sanity): the throughput ceiling, not the wallet, bounds the worst case', () => {
  // maxConcurrent × seconds/day ÷ avgLatency — the wallet-independent limiter (D-13).
  const ceiling = (maxConcurrent: number, avgLatencySeconds: number): number => Math.floor((maxConcurrent * 86_400) / avgLatencySeconds);
  assert.ok(ceiling(3, 75) >= 3000 && ceiling(3, 75) <= 3600, '~3000–3500 calls/day at maxConcurrent 3 (D-13)');
  // A null budget does not lower the ceiling — degraded() is false regardless of spend at any volume.
  const b = new BudgetTracker({ critic: { dailyTokens: null }, curriculum: { dailyTokens: null }, orchestrator: { dailyTokens: null } });
  for (let i = 0; i < ceiling(3, 75); i++) b.spend('critic', 25_000);
  assert.equal(b.degraded('critic'), false, 'a full day at the throughput ceiling never trips an uncapped desk');
});

// ── Tier split (strong = novelty; fast = dispatch/QA) ──────────────────────────

test('M4-4 (tier split): the critic runs on STRONG (novelty), the orchestrator on FAST (dispatch)', async () => {
  const w = await wireLlm([{ toolCalls: [{ name: 'verdict', arguments: { success: true, critique: 'ok', libraryAction: 'admit' } }] }]);
  try {
    const critic = new CriticDesk({ client: w.client, scheduler: w.scheduler, journal: w.journal });
    const ctx: CriticContext = { ticket: ticket(), task: task(), report: report(), code: 'async function f(){}' };
    await critic.judge(ctx);
    const criticReq = w.llm.requests.find((r) => String(r.url).includes('/chat/completions'));
    assert.equal(criticReq!.body.model, 'strong', 'critic judgment is novelty → strong tier (D-13)');
  } finally {
    await w.llm.close();
  }

  const w2 = await wireLlm([{ toolCalls: [{ name: 'directive', arguments: { to: 'Firmin', goal: 'g', reason: 'r', priority: 'normal' } }] }]);
  try {
    const inboxes = new Map<string, Inbox>([['Firmin', new VillagerInbox('Firmin', w2.journal)]]);
    const orch = new Orchestrator({ state: emptyState(), journal: w2.journal, client: w2.client, scheduler: w2.scheduler, inboxes });
    await orch.dispatch({ task: task(), trigger: 'new-task' });
    const orchReq = w2.llm.requests.find((r) => String(r.url).includes('/chat/completions'));
    assert.equal(orchReq!.body.model, 'fast', 'dispatch is shallow + frequent → fast tier (D-13)');
  } finally {
    await w2.llm.close();
  }
});

test('M4-4 (tier split): curriculum proposal runs STRONG, the QA-cache answer runs FAST', async () => {
  const w = await wireLlm([
    { toolCalls: [{ name: 'propose_task', arguments: { goal: 'g', successCriteria: 's', howTo: 'how to mine?' } }] },
    { content: 'a réponse' },
  ]);
  try {
    const cur = new Curriculum({ state: emptyState(), journal: w.journal, client: w.client, scheduler: w.scheduler, embeddings: new EmbeddingsService({}) });
    await cur.proposeTask({ trigger: 'idle' });
    const models = w.llm.requests.filter((r) => String(r.url).includes('/chat/completions')).map((r) => r.body.model);
    assert.deepEqual(models, ['strong', 'fast'], 'proposal=strong (novelty), QA=fast (D-13)');
  } finally {
    await w.llm.close();
  }
});

// ── degradeOnBreach: each desk falls back correctly ───────────────────────────

test('M4-4 (D-13 degrade — critic): over budget → no LLM call; the verdict comes from the check + a template', async () => {
  // The check IS satisfied (worldAfter has 3 oak_log), so the templated verdict succeeds — but admission
  // is deferred to keep-draft (a degraded critic never auto-admits without a real judgment).
  const w = await wireLlm([]); // no turns — degraded must NOT call the LLM
  try {
    const budget = new BudgetTracker({ critic: { dailyTokens: 100 }, curriculum: { dailyTokens: null }, orchestrator: { dailyTokens: null } });
    budget.spend('critic', 101); // over cap
    const critic = new CriticDesk({ client: w.client, scheduler: w.scheduler, journal: w.journal, budget, degradeOnBreach: true });
    const ctx: CriticContext = { ticket: ticket(), task: task(), report: report(), code: 'async function f(){}' };
    const verdict = await critic.judge(ctx);
    assert.equal(chatCalls(w.llm), 0, 'a degraded critic spends ZERO LLM calls (the budget valve)');
    assert.equal(verdict.success, true, 'the check is satisfied → templated success');
    assert.equal(verdict.libraryAction, 'keep-draft', 'a degraded critic never auto-admits (no real judgment)');
    assert.match(verdict.critique, /budget|templat|check/i, 'a templated critique names the degraded path');
  } finally {
    await w.llm.close();
  }
});

test('M4-4 (D-13 degrade — critic): over budget + check FAILS → templated success:false', async () => {
  const w = await wireLlm([]);
  try {
    const budget = new BudgetTracker({ critic: { dailyTokens: 100 }, curriculum: { dailyTokens: null }, orchestrator: { dailyTokens: null } });
    budget.spend('critic', 101);
    const critic = new CriticDesk({ client: w.client, scheduler: w.scheduler, journal: w.journal, budget, degradeOnBreach: true });
    const ctx: CriticContext = { ticket: ticket(), task: task(), report: report({ worldAfter: SNAP() }), code: 'async function f(){}' };
    const verdict = await critic.judge(ctx);
    assert.equal(chatCalls(w.llm), 0);
    assert.equal(verdict.success, false, 'check unmet → degraded verdict fails');
    assert.equal(verdict.libraryAction, 'keep-draft');
  } finally {
    await w.llm.close();
  }
});

test('M4-4 (D-13 degrade — critic): a null cap means the critic ALWAYS calls the LLM (never degrades)', async () => {
  const w = await wireLlm([{ toolCalls: [{ name: 'verdict', arguments: { success: true, critique: 'real judgment', libraryAction: 'admit' } }] }]);
  try {
    const budget = new BudgetTracker({ critic: { dailyTokens: null }, curriculum: { dailyTokens: null }, orchestrator: { dailyTokens: null } });
    budget.spend('critic', 10_000_000);
    const critic = new CriticDesk({ client: w.client, scheduler: w.scheduler, journal: w.journal, budget, degradeOnBreach: true });
    const verdict = await critic.judge({ ticket: ticket(), task: task(), report: report(), code: 'async function f(){}' });
    assert.equal(chatCalls(w.llm), 1, 'uncapped → a real LLM judgment (R49: throughput, not wallet)');
    assert.equal(verdict.libraryAction, 'admit');
  } finally {
    await w.llm.close();
  }
});

test('M4-4 (D-13 degrade — curriculum): over budget → repeat the last task type, NO LLM call', async () => {
  const w = await wireLlm([]); // degraded curriculum must not call the LLM
  try {
    const state = emptyState();
    const template = task({ id: 'prev', goal: 'gather wood' });
    state.ledger.open.push(template);
    state.tasks.set(template.id, template);
    const budget = new BudgetTracker({ critic: { dailyTokens: null }, curriculum: { dailyTokens: 100 }, orchestrator: { dailyTokens: null } });
    budget.spend('curriculum', 101);
    const cur = new Curriculum({ state, journal: w.journal, client: w.client, scheduler: w.scheduler, embeddings: new EmbeddingsService({}), budget, degradeOnBreach: true });
    const proposed = await cur.proposeTask({ trigger: 'idle', villager: 'Firmin' });
    assert.equal(chatCalls(w.llm), 0, 'a degraded curriculum spends ZERO LLM calls');
    assert.ok(proposed, 'it still feeds the loop — repeating the last task type');
    assert.equal(proposed!.goal, 'gather wood', 'the last task TYPE is repeated (D-13)');
  } finally {
    await w.llm.close();
  }
});

test('M4-4 (D-13 degrade — orchestrator): over budget → only interrupt dispatch survives', async () => {
  const w = await wireLlm([{ toolCalls: [
    { name: 'directive', arguments: { to: 'Firmin', goal: 'normal job', reason: 'r', priority: 'normal' } },
    { name: 'directive', arguments: { to: 'Colette', goal: 'EMERGENCY', reason: 'creeper', priority: 'interrupt' } },
  ] }]);
  try {
    const inboxes = new Map<string, Inbox>([['Firmin', new VillagerInbox('Firmin', w.journal)], ['Colette', new VillagerInbox('Colette', w.journal)]]);
    const budget = new BudgetTracker({ critic: { dailyTokens: null }, curriculum: { dailyTokens: null }, orchestrator: { dailyTokens: 100 } });
    budget.spend('orchestrator', 101);
    const orch = new Orchestrator({ state: emptyState(), journal: w.journal, client: w.client, scheduler: w.scheduler, inboxes, budget, degradeOnBreach: true });
    const dirs = await orch.dispatch({ trigger: 'event' });
    assert.equal(dirs.length, 1, 'only the urgent directive survives a degraded orchestrator');
    assert.equal(dirs[0]!.priority, 'interrupt');
    assert.equal(dirs[0]!.to, 'Colette');
  } finally {
    await w.llm.close();
  }
});

// ── Verdict batching (≤3 tickets per critic call) ─────────────────────────────

test('M4-4 (verdict batching): judgeBatch fans up to 3 tickets into ONE critic call', async () => {
  // One call returns 3 verdict tool calls (one per ticket); the batch must cap at 3 and map each back.
  const w = await wireLlm([{ toolCalls: [
    { name: 'verdict', arguments: { ticketId: 'ticket-1', success: true, critique: 'a', libraryAction: 'admit' } },
    { name: 'verdict', arguments: { ticketId: 'ticket-2', success: false, critique: 'b', libraryAction: 'keep-draft' } },
    { name: 'verdict', arguments: { ticketId: 'ticket-3', success: false, critique: 'c', libraryAction: 'keep-draft' } },
  ] }]);
  try {
    const critic = new CriticDesk({ client: w.client, scheduler: w.scheduler, journal: w.journal, batchMax: 3 });
    const ctxs: CriticContext[] = ['ticket-1', 'ticket-2', 'ticket-3', 'ticket-4'].map((id) => ({
      ticket: ticket(id), task: task(), report: report({ rolloutId: `roll-${id}`, runId: `run-${id}` }), code: 'async function f(){}',
    }));
    const verdicts = await critic.judgeBatch(ctxs);
    assert.equal(verdicts.length, 3, 'the batch caps at 3 tickets per call (D-13)');
    assert.equal(chatCalls(w.llm), 1, 'three tickets, ONE critic call (the 3-per-call fan-in)');
    assert.equal(verdicts[0]!.ticketId, 'ticket-1');
    assert.equal(verdicts[1]!.success, false);
  } finally {
    await w.llm.close();
  }
});
