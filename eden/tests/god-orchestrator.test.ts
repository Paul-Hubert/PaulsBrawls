// M4-2 — the orchestrator desk. dispatch turns a task/event into a Directive (the SOLE WRITER of
// directivesOpen, S2) delivered to a villager's inbox. The anti-thrash rules are ENGINE-ENFORCED, not
// prompt-hoped: max 1 open non-standing directive per villager; no repeat `interrupt` to the same
// villager within 5 min; conflicting directives auto-supersede oldest-first (journaled). `intervene`
// is divine stage-setting (never does the villager's task — the critic voids overreach via the
// divineAssisted flag). report_to_god objections journal + note the dossier. Golden prompt at runtime.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryJournal } from './fakes/memory-journal';
import { ScriptedLlm, type ScriptedTurn } from './fakes/scripted-llm';
import { LlmClient, ProviderRegistry } from '../src/llm/client';
import { LlmScheduler } from '../src/llm/scheduler';
import { Orchestrator, loadOrchestratorPrompt } from '../src/god/orchestrator';
import { VillagerInbox } from '../src/villagers/inbox';
import type { GodState } from '../src/god/god';
import type { Dossier, Inbox, Task, TaskLedger } from '../src/types/index';

function emptyState(): GodState {
  return { ledger: { completed: [], failed: [], open: [] } as TaskLedger, dossiers: new Map<string, Dossier>(), criticQueue: [], rollouts: new Map(), tasks: new Map(), directivesOpen: [] };
}

async function harness(turns: ScriptedTurn[], opts: { now?: () => number; interruptCooldownMs?: number; body?: import('../src/god/orchestrator').DivineActor } = {}): Promise<{
  orch: Orchestrator;
  state: GodState;
  journal: MemoryJournal;
  inboxes: Map<string, Inbox>;
  llm: ScriptedLlm;
  close: () => Promise<void>;
}> {
  const journal = new MemoryJournal();
  const llm = await ScriptedLlm.start(turns);
  const providers = new ProviderRegistry({ strong: { baseUrl: llm.url, model: 'strong', inputTokenBudget: 48000 }, fast: { baseUrl: llm.url, model: 'fast', inputTokenBudget: 16000 } });
  const client = new LlmClient({ providers, journal });
  const scheduler = new LlmScheduler({ maxConcurrent: 3, perVillagerCooldownMs: 0 });
  const state = emptyState();
  const inboxes = new Map<string, Inbox>([
    ['Firmin', new VillagerInbox('Firmin', journal)],
    ['Colette', new VillagerInbox('Colette', journal)],
  ]);
  const ctorOpts: ConstructorParameters<typeof Orchestrator>[0] = { state, journal, client, scheduler, inboxes };
  if (opts.now) ctorOpts.now = opts.now;
  if (opts.interruptCooldownMs !== undefined) ctorOpts.interruptCooldownMs = opts.interruptCooldownMs;
  if (opts.body) ctorOpts.body = opts.body;
  const orch = new Orchestrator(ctorOpts);
  return { orch, state, journal, inboxes, llm, close: () => llm.close() };
}

const task = (over: Partial<Task> = {}): Task => ({ id: 'task-1', goal: 'collect 3 oak logs', assignee: 'Firmin', successCriteria: 's', context: '', maxRetries: 4, ...over });
const directiveTurn = (args: object): ScriptedTurn => ({ toolCalls: [{ name: 'directive', arguments: args }] });

test('M4-2 (loadOrchestratorPrompt): the golden prompt loads and names the doctrine + anti-thrash', () => {
  const p = loadOrchestratorPrompt();
  assert.match(p, /orchestrat/i);
  assert.match(p, /directive/i);
  assert.match(p, /never do .*villager|jamais.*tâche|stage|intervention/i, 'interventions set stages, never do the task');
});

test('M4-2 (dispatch routing): a directive call opens directivesOpen + delivers to the inbox + journals god.directive', async () => {
  const h = await harness([directiveTurn({ to: 'Firmin', goal: 'Collect 3 oak logs', reason: 'le grenier est vide', priority: 'normal' })]);
  try {
    const dirs = await h.orch.dispatch({ task: task(), trigger: 'new-task' });
    assert.equal(dirs.length, 1);
    const d = dirs[0]!;
    assert.equal(d.to, 'Firmin');
    assert.equal(d.priority, 'normal');

    // SOLE WRITER of directivesOpen.
    assert.equal(h.state.directivesOpen!.length, 1);
    assert.equal(h.state.directivesOpen![0]!.id, d.id);

    // delivered to the inbox (inbox.delivered journaled) + the directive journaled.
    assert.equal((h.inboxes.get('Firmin') as VillagerInbox).depth(), 1);
    assert.equal(h.journal.query({ kinds: ['inbox.delivered'] }).length, 1);
    const ev = h.journal.query({ kinds: ['god.directive'] });
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.refs.directiveId, d.id);
    assert.equal((ev[0]!.payload as { to: string }).to, 'Firmin');
  } finally {
    await h.close();
  }
});

test('M4-2 (anti-thrash: max 1 open non-standing/villager): a second directive supersedes the oldest (journaled)', async () => {
  const h = await harness([
    directiveTurn({ to: 'Firmin', goal: 'first job', reason: 'r1', priority: 'normal' }),
    directiveTurn({ to: 'Firmin', goal: 'second job', reason: 'r2', priority: 'normal' }),
  ]);
  try {
    const first = (await h.orch.dispatch({ task: task(), trigger: 'new-task' }))[0]!;
    const second = (await h.orch.dispatch({ task: task({ id: 'task-2', goal: 'second job' }), trigger: 'new-task' }))[0]!;

    // Only ONE open non-standing directive remains — the newer one; the older was superseded.
    const open = h.state.directivesOpen!.filter((d) => d.to === 'Firmin' && !d.standing);
    assert.equal(open.length, 1, 'max 1 open non-standing directive per villager');
    assert.equal(open[0]!.id, second.id, 'the newer directive wins');

    // The supersede is journaled (both the closed-event and on the new directive's payload).
    const closed = h.journal.query({ kinds: ['god.directive-closed'] });
    assert.equal(closed.length, 1);
    assert.equal((closed[0]!.payload as { reason: string }).reason, 'superseded');
    assert.equal(closed[0]!.refs.directiveId, first.id);
    const newDir = h.journal.query({ kinds: ['god.directive'] }).find((e) => e.refs.directiveId === second.id);
    assert.deepEqual((newDir!.payload as { superseded?: string[] }).superseded, [first.id]);
  } finally {
    await h.close();
  }
});

test('M4-2 (anti-thrash: a standing directive is NOT superseded by a new non-standing one)', async () => {
  const h = await harness([
    directiveTurn({ to: 'Firmin', goal: 'stop mining at night', reason: 'safety', priority: 'background', standing: true }),
    directiveTurn({ to: 'Firmin', goal: 'collect logs', reason: 'r', priority: 'normal' }),
  ]);
  try {
    await h.orch.dispatch({ trigger: 'admin' });
    await h.orch.dispatch({ task: task(), trigger: 'new-task' });
    // Both stay open: the standing order coexists with one non-standing directive.
    assert.equal(h.state.directivesOpen!.filter((d) => d.to === 'Firmin').length, 2);
    assert.equal(h.state.directivesOpen!.filter((d) => d.to === 'Firmin' && d.standing).length, 1);
    assert.equal(h.journal.query({ kinds: ['god.directive-closed'] }).length, 0, 'nothing superseded');
  } finally {
    await h.close();
  }
});

test('M4-2 (anti-thrash: no repeat interrupt within 5 min): the second interrupt is downgraded to normal', async () => {
  let clock = 1_000_000;
  const h = await harness([
    directiveTurn({ to: 'Firmin', goal: 'flee the creeper', reason: 'danger', priority: 'interrupt' }),
    directiveTurn({ to: 'Firmin', goal: 'flee again', reason: 'danger again', priority: 'interrupt' }),
  ], { now: () => clock, interruptCooldownMs: 5 * 60_000 });
  try {
    const first = (await h.orch.dispatch({ trigger: 'event' }))[0]!;
    assert.equal(first.priority, 'interrupt', 'the first interrupt fires');
    clock += 60_000; // only 1 minute later — inside the 5-min interrupt cooldown
    const second = (await h.orch.dispatch({ trigger: 'event' }))[0]!;
    assert.equal(second.priority, 'normal', 'a second interrupt within 5 min is downgraded (anti-thrash)');
  } finally {
    await h.close();
  }
});

test('M4-2 (anti-thrash: an interrupt AFTER the cooldown fires as interrupt again)', async () => {
  let clock = 1_000_000;
  const h = await harness([
    directiveTurn({ to: 'Firmin', goal: 'a', reason: 'r', priority: 'interrupt' }),
    directiveTurn({ to: 'Firmin', goal: 'b', reason: 'r', priority: 'interrupt' }),
  ], { now: () => clock, interruptCooldownMs: 5 * 60_000 });
  try {
    await h.orch.dispatch({ trigger: 'event' }); // fires the first interrupt
    clock += 6 * 60_000; // 6 minutes — past the cooldown
    const second = (await h.orch.dispatch({ trigger: 'event' }))[0]!;
    assert.equal(second.priority, 'interrupt', 'past the cooldown, an interrupt fires again');
  } finally {
    await h.close();
  }
});

test('M4-2 (intervene): divine stage-setting journals god.appearance and flags divineAssisted for the critic', async () => {
  const h = await harness([]);
  try {
    // A fake body that records the divine action and reports success.
    const calls: Array<{ action: string; args: object }> = [];
    const fakeBody = {
      runAction: async (action: string, args: object) => {
        calls.push({ action, args });
        return true;
      },
    };
    const ok = await h.orch.intervene({ villager: 'Firmin', taskId: 'task-1', action: 'summon-creature', args: { entity: 'zombie', count: 3 } }, fakeBody);
    assert.equal(ok, true);
    assert.deepEqual(calls, [{ action: 'summon-creature', args: { entity: 'zombie', count: 3 } }]);

    // The divineAssisted flag is set for the task — the critic reads it to void overreach (D-12).
    assert.equal(h.orch.wasDivinelyAssisted('task-1'), true);
    assert.equal(h.orch.wasDivinelyAssisted('other-task'), false);

    // journaled (god.appearance is the body theatrics row).
    const ev = h.journal.query({ kinds: ['god.appearance'] });
    assert.equal(ev.length, 1);
    assert.equal((ev[0]!.payload as { action: string }).action, 'summon-creature');
  } finally {
    await h.close();
  }
});

test('M4-2 (report_to_god): an objection journals + is noted in the dossier', async () => {
  const h = await harness([]);
  try {
    h.orch.reportToGod({ villager: 'Firmin', text: 'Je refuse de miner la nuit, c’est trop dangereux.' });
    // dossier-noted.
    const d = h.state.dossiers.get('Firmin');
    assert.ok(d, 'a dossier was created');
    assert.ok(d!.notes.some((n) => n.includes('dangereux')), 'the objection is noted in the dossier');
  } finally {
    await h.close();
  }
});

test('M4-2 (intervene soft-fail): a divine action that THROWS is caught — ok:false, the loop never depends on the body', async () => {
  // Theatrics are never a dependency (03): if the avatar is down, body.runAction throws; intervene must
  // swallow it, journal ok:false, and STILL flag divineAssisted (the stage-set was attempted for this task).
  const h = await harness([]);
  try {
    const downBody = {
      runAction: async (): Promise<boolean> => {
        throw new Error('avatar disconnected');
      },
    };
    const ok = await h.orch.intervene({ villager: 'Firmin', taskId: 'task-9', action: 'set-weather', args: { clear: true } }, downBody);
    assert.equal(ok, false, 'a thrown body action fails soft (never propagates)');
    assert.equal(h.orch.wasDivinelyAssisted('task-9'), true, 'the task is still flagged divineAssisted');
    const ev = h.journal.query({ kinds: ['god.appearance'] });
    assert.equal(ev.length, 1);
    assert.equal((ev[0]!.payload as { ok: boolean }).ok, false, 'journaled as a failed appearance');
  } finally {
    await h.close();
  }
});

test('M4-2 (intervene without a taskId): journals the appearance, sets no task flag', async () => {
  const h = await harness([]);
  try {
    const ok = await h.orch.intervene({ villager: 'Firmin', action: 'gesture', args: {} }, { runAction: async () => true });
    assert.equal(ok, true);
    assert.equal(h.journal.query({ kinds: ['god.appearance'] }).length, 1);
    // No taskId → nothing to flag (the wasDivinelyAssisted set stays empty).
    assert.equal(h.orch.wasDivinelyAssisted('task-1'), false);
  } finally {
    await h.close();
  }
});

test('M4-2 (clearDivineAssist): consuming a verdict clears the flag so a later run isn’t falsely voided', async () => {
  const h = await harness([]);
  try {
    await h.orch.intervene({ villager: 'Firmin', taskId: 'task-1', action: 'summon-creature', args: {} }, { runAction: async () => true });
    assert.equal(h.orch.wasDivinelyAssisted('task-1'), true);
    h.orch.clearDivineAssist('task-1');
    assert.equal(h.orch.wasDivinelyAssisted('task-1'), false, 'the flag is one-shot per verdict');
  } finally {
    await h.close();
  }
});

test('M4-2 (expireStale): directives past their expiresAt are closed (god.directive-closed expired); fresh ones survive', async () => {
  let clock = 1_000_000;
  const h = await harness([], { now: () => clock });
  try {
    // Open one expiring directive and one without an expiry, deterministically (no LLM).
    const stale = h.orch.openDirective({ to: 'Firmin', goal: 'old job', reason: 'r', priority: 'normal', expiresAt: clock + 1000, standing: true });
    h.orch.openDirective({ to: 'Colette', goal: 'durable', reason: 'r', priority: 'background', standing: true });
    clock += 5000; // both well past the first's expiry
    const n = h.orch.expireStale();
    assert.equal(n, 1, 'exactly the expired directive was closed');
    assert.ok(!h.state.directivesOpen!.some((d) => d.id === stale.id), 'the stale directive is gone');
    assert.ok(h.state.directivesOpen!.some((d) => d.to === 'Colette'), 'the no-expiry directive survives');
    const closed = h.journal.query({ kinds: ['god.directive-closed'] }).filter((e) => (e.payload as { reason: string }).reason === 'expired');
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.refs.directiveId, stale.id);
  } finally {
    await h.close();
  }
});

test('M4-2 (closeDirectivesForTask): a completed task closes its open directive(s) (god.directive-closed completed)', async () => {
  const h = await harness([directiveTurn({ to: 'Firmin', goal: 'collect logs', reason: 'r', priority: 'normal' })]);
  try {
    const d = (await h.orch.dispatch({ task: task(), trigger: 'new-task' }))[0]!;
    assert.equal(h.state.directivesOpen!.length, 1);
    h.orch.closeDirectivesForTask('task-1', 'completed');
    assert.equal(h.state.directivesOpen!.length, 0, 'the directive is closed when its task completes');
    const closed = h.journal.query({ kinds: ['god.directive-closed'] });
    assert.equal(closed.length, 1);
    assert.equal((closed[0]!.payload as { reason: string }).reason, 'completed');
    assert.equal(closed[0]!.refs.directiveId, d.id);
  } finally {
    await h.close();
  }
});

// B3.5 — with a body, dispatch also offers `intervene`; an intervene call stages through the avatar and flags
// the dispatched task divinely assisted (the critic's D-12 voidDivineOverreach rail then applies).
test('B3.5: dispatch offers intervene only with a body; an intervene call runs the action and flags the task', async () => {
  const actions: Array<{ action: string; args: object }> = [];
  const body = { runAction: async (action: string, args: object) => { actions.push({ action, args }); return true; } };
  const h = await harness([{ toolCalls: [
    { name: 'intervene', arguments: { villager: 'Firmin', action: 'give-items', args: { villager: 'Firmin', items: [{ name: 'wooden_axe', count: 1 }] }, reason: 'il n’a pas de hache' } },
    { name: 'directive', arguments: { to: 'Firmin', goal: 'couper 3 bûches', reason: 'bois', priority: 'normal' } },
  ] }], { body });
  try {
    const out = await h.orch.dispatch({ task: task(), trigger: 'new-task' });
    assert.equal(out.length, 1, 'the directive still lands');
    assert.deepEqual(actions.map((a) => a.action), ['give-items']);
    assert.equal(h.orch.wasDivinelyAssisted('task-1'), true);
    const sent = h.llm.requests[0]!.body.tools.map((t: { function: { name: string } }) => t.function.name);
    assert.deepEqual(sent, ['directive', 'intervene']);
  } finally {
    await h.close();
  }
  const bare = await harness([{ toolCalls: [{ name: 'directive', arguments: { to: 'Firmin', goal: 'g', reason: 'r', priority: 'normal' } }] }]);
  try {
    await bare.orch.dispatch({ task: task(), trigger: 'new-task' });
    assert.deepEqual(bare.llm.requests[0]!.body.tools.map((t: { function: { name: string } }) => t.function.name), ['directive'], 'no body → no intervene tool');
  } finally {
    await bare.close();
  }
});
