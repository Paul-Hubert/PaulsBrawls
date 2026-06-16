import test from 'node:test';
import assert from 'node:assert/strict';

import { ScriptedLlm, type ScriptedTurn } from './fakes/scripted-llm';
import { MemoryJournal } from './fakes/memory-journal';
import { LlmClient, ProviderRegistry } from '../src/llm/client';
import { LlmScheduler } from '../src/llm/scheduler';
import { CriticDesk, loadCriticPrompt, type CriticContext } from '../src/god/critic';
import type { CriticTicket, RunReport, Snapshot, Task } from '../src/types/index';

const SNAP = (inv: Array<{ name: string; count: number }> = []): Snapshot => ({
  biome: 'plains', time: 0, position: [0, 64, 0], health: 20, hunger: 20,
  equipment: [], inventory: inv, nearbyEntities: [], nearbyBlocks: [], knownChests: [],
});

function report(over: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'run-1', rolloutId: 'roll-1', skill: 'collect-oak-logs', version: 1, villager: 'Firmin',
    args: {}, outcome: { ok: true, value: { collected: 3 } }, startedAt: 0, durationMs: 100, pulses: 3,
    deepestDepth: 0, callTree: [], worldBefore: SNAP(), worldAfter: SNAP([{ name: 'oak_log', count: 3 }]),
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return { id: 'task-1', goal: 'collect 3 oak logs', assignee: 'Firmin', successCriteria: 'avoir 3 oak_log', context: '', maxRetries: 4, ...over };
}

const ticket: CriticTicket = { id: 'ticket-1', source: 'rollout', runReportRef: 'run-1', taskRef: 'task-1', filedAt: 0 };

async function judgeWith(turn: ScriptedTurn, ctx: Partial<CriticContext>): Promise<{ verdict: import('../src/types/index').Verdict; journal: MemoryJournal; llm: ScriptedLlm }> {
  const journal = new MemoryJournal();
  const llm = await ScriptedLlm.start([turn]);
  const providers = new ProviderRegistry({
    strong: { baseUrl: llm.url, model: 'strong', inputTokenBudget: 48000 },
    fast: { baseUrl: llm.url, model: 'fast', inputTokenBudget: 16000 },
  });
  const client = new LlmClient({ providers, journal });
  const scheduler = new LlmScheduler({ maxConcurrent: 3, perVillagerCooldownMs: 0 });
  const critic = new CriticDesk({ client, scheduler, journal });
  const full: CriticContext = { ticket, task: task(), report: report(), code: 'async function f(b,a,c){}', ...ctx };
  const verdict = await critic.judge(full);
  return { verdict, journal, llm };
}

const verdictCall = (args: object): ScriptedTurn => ({ toolCalls: [{ name: 'verdict', arguments: args }] });

test('M3-4: the critic prompt (golden) encodes the rails — world delta, the verdict tool, the actions', () => {
  const prompt = loadCriticPrompt();
  assert.match(prompt, /world delta/i);
  assert.match(prompt, /R34/);
  assert.match(prompt, /R35/);
  assert.match(prompt, /verdict/);
  // P3: the composition doctrine — the critic teaches reuse/decomposition over monolithic skills.
  assert.match(prompt, /compos/i, 'critic prefers composition over re-implementation');
  assert.match(prompt, /ctx\.skills\.run/, 'critic names the composition call in its instructive critique');
  for (const action of ['admit', 'keep-draft', 'quarantine', 'archive', 'none']) {
    assert.ok(prompt.includes(action), `prompt documents libraryAction "${action}"`);
  }
  // R72: the blocked-on-resource doctrine — a missing input is not a code defect; pivot via followUp.
  assert.match(prompt, /blocked/i, 'critic documents the blocked-on-resource verdict');
  assert.match(prompt, /followUp/i, 'critic documents the follow-up acquire-task');
});

test('R72 (blocked verdict): the critic parses blocked + followUp; the rail forces success:false', async () => {
  const { verdict, llm } = await judgeWith(
    verdictCall({
      success: false, critique: 'no wheat_seeds in inventory — cannot sow', libraryAction: 'none', blocked: true,
      followUp: { goal: 'Harvest mature wheat to obtain wheat_seeds', successCriteria: 'have ≥3 wheat_seeds', check: { item: 'wheat_seeds', count: 3 } },
    }),
    { task: task({ goal: 'till-and-sow' }), report: report({ skill: 'till-and-sow', outcome: { ok: true, value: { tilled: 0, sown: 0 } }, worldAfter: SNAP([{ name: 'iron_hoe', count: 1 }]) }) },
  );
  try {
    assert.equal(verdict.blocked, true, 'blocked is parsed');
    assert.equal(verdict.success, false, 'a blocked run is never a success (rail)');
    assert.ok(verdict.followUp && 'goal' in verdict.followUp, 'the follow-up acquire-task is parsed');
    assert.equal((verdict.followUp as { goal: string }).goal, 'Harvest mature wheat to obtain wheat_seeds');
    assert.deepEqual((verdict.followUp as { check?: unknown }).check, { item: 'wheat_seeds', count: 3 }, 'the follow-up carries an objective check');
  } finally {
    await llm.close();
  }
});

test('R72 (blocked never penalises the skill): a blocked verdict downgrades quarantine/admit to none', async () => {
  const { verdict, llm } = await judgeWith(
    verdictCall({ success: false, critique: 'no seeds', libraryAction: 'quarantine', blocked: true, followUp: { goal: 'get seeds' } }),
    { task: task({ goal: 'till-and-sow' }) },
  );
  try {
    assert.equal(verdict.libraryAction, 'none', 'a correct-but-blocked skill is not quarantined for a missing input');
  } finally {
    await llm.close();
  }
});

test('M3-4: judge parses the verdict tool call into a Verdict (caller god:critic)', async () => {
  const { verdict, llm, journal } = await judgeWith(
    verdictCall({ success: true, score: 8, critique: 'générique et propre', libraryAction: 'admit', praise: 'beau travail' }),
    {},
  );
  try {
    assert.equal(verdict.ticketId, 'ticket-1');
    assert.equal(verdict.success, true);
    assert.equal(verdict.score, 8);
    assert.equal(verdict.libraryAction, 'admit');
    assert.equal(verdict.praise, 'beau travail');
    // It journaled an llm.call as god:critic.
    assert.equal(journal.query({ kinds: ['llm.call'] })[0]!.actor, 'god:critic');
  } finally {
    await llm.close();
  }
});

test('M3-4 (D-12(i) check-veto): an unmet check forces success:false / no admit, regardless of the verdict', async () => {
  // The model wrongly admits a no-op on a check task — the check (oak_log≥3) is NOT met in worldAfter.
  const { verdict, llm } = await judgeWith(verdictCall({ success: true, critique: 'on dirait bon', libraryAction: 'admit' }), {
    task: task({ check: { item: 'oak_log', count: 3 } }),
    report: report({ worldAfter: SNAP([]) }), // ZERO oak_log — the check fails
  });
  try {
    assert.equal(verdict.success, false, 'a failed check forces success:false (one-directional)');
    assert.notEqual(verdict.libraryAction, 'admit', 'a failed check forbids admission');
    assert.match(verdict.critique, /check|oak_log/i, 'the critique names the objective miss');
  } finally {
    await llm.close();
  }
});

test('M3-4 (R34): a clean exit with an unmet check is NOT progress — vetoed', async () => {
  const { verdict, llm } = await judgeWith(verdictCall({ success: true, critique: 'exit propre', libraryAction: 'admit' }), {
    task: task({ check: { item: 'oak_log', count: 3 } }),
    report: report({ outcome: { ok: true, value: {} }, worldBefore: SNAP(), worldAfter: SNAP() }), // returned cleanly, world unchanged
  });
  try {
    assert.equal(verdict.success, false, 'completion ≠ progress (R34): a clean return with no world delta fails the check');
  } finally {
    await llm.close();
  }
});

test('M3-4 (D-12, passing check is NOT an auto-admit): a satisfied check still leaves the verdict to the critic', async () => {
  const { verdict, llm } = await judgeWith(verdictCall({ success: false, critique: 'fragile, à revoir', libraryAction: 'keep-draft' }), {
    task: task({ check: { item: 'oak_log', count: 3 } }),
    report: report({ worldAfter: SNAP([{ name: 'oak_log', count: 3 }]) }), // check IS met
  });
  try {
    assert.equal(verdict.success, false, 'a passing check does not override a negative verdict (evidence FOR, not a bypass)');
    assert.equal(verdict.libraryAction, 'keep-draft');
  } finally {
    await llm.close();
  }
});

test('M3-4 (R35): a quiet run (no failures, no delta) with no check is a legitimate pass — not auto-failed', async () => {
  const { verdict, llm } = await judgeWith(verdictCall({ success: true, critique: 'patrouille effectuée', libraryAction: 'none' }), {
    task: task({ check: undefined }),
    report: report({ outcome: { ok: true, value: {} }, worldBefore: SNAP(), worldAfter: SNAP() }),
  });
  try {
    assert.equal(verdict.success, true, 'quiet ≠ futile (R35): the critic does not auto-fail a no-delta run');
  } finally {
    await llm.close();
  }
});

test('M3-4 (voidDivineOverreach): a success achieved by divine intervention is voided', async () => {
  const { verdict, llm } = await judgeWith(verdictCall({ success: true, critique: 'fait', libraryAction: 'admit' }), {
    divineAssisted: true,
  });
  try {
    assert.equal(verdict.success, false, 'divine action can never inflate the ledger');
    assert.notEqual(verdict.libraryAction, 'admit');
    assert.match(verdict.critique, /divin|intervention|overreach/i);
  } finally {
    await llm.close();
  }
});

test('R52: critic forces tool_choice to { type:function, function:{name:verdict} } — never "auto"', async () => {
  const llm = await ScriptedLlm.start([verdictCall({ success: true, critique: 'ok', libraryAction: 'admit' })]);
  const journal = new MemoryJournal();
  const providers = new ProviderRegistry({
    strong: { baseUrl: llm.url, model: 'strong', inputTokenBudget: 48000 },
    fast: { baseUrl: llm.url, model: 'fast', inputTokenBudget: 16000 },
  });
  const client = new LlmClient({ providers, journal });
  const scheduler = new LlmScheduler({ maxConcurrent: 3, perVillagerCooldownMs: 0 });
  const critic = new CriticDesk({ client, scheduler, journal });
  await critic.judge({ ticket, task: task(), report: report(), code: 'async function f(b,a,c){}' });
  try {
    const wired = llm.requests[0]?.body as Record<string, unknown>;
    assert.deepEqual(wired['tool_choice'], { type: 'function', function: { name: 'verdict' } },
      'critic must force the verdict tool (R52: "auto" lets gpt-4o return markdown bullets)');
  } finally {
    await llm.close();
  }
});

test('M3-4: a non-tool reply degrades to a safe keep-draft verdict (never throws)', async () => {
  const { verdict, llm } = await judgeWith({ content: 'je ne suis pas sûr', finishReason: 'stop' }, {});
  try {
    assert.equal(verdict.success, false);
    assert.equal(verdict.libraryAction, 'keep-draft');
  } finally {
    await llm.close();
  }
});
