// ★ M3-GATE — the milestone's reason to exist. One villager converges on a trivial task through the
// FULL cycle: task → draft → run → verdict → revise → admit. ScriptedLLM scripts a fail-once-then-fix
// villager + a critic that keep-drafts the failure then admits the fix. The whole cycle shares ONE
// refs.rolloutId (the website's rollout view), and the skill ends in active-probation (D-12).
//
// This file IS the M3 injection-path loop driver (tasks seeded by the harness, not curriculum). The
// loop touches BOTH god/ and villagers/, so it lives here (or in main.ts) — never inside a layer-3
// actor (the dependency law). M4-3 replaces this driver with the real curriculum→orchestrator→inbox path.

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
import { ContextPackBuilder, type ContextPackInput, type RevisionTurn } from '../src/villagers/context-pack';
import { Brain } from '../src/villagers/brain';
import { VillagerInbox } from '../src/villagers/inbox';
import { GodService } from '../src/god/god';
import { CriticDesk } from '../src/god/critic';
import type { Inbox, RunReport, Snapshot, Task, RunnerRef } from '../src/types/index';

const MORTAL: RunnerRef = { name: 'Firmin', role: 'farmer', tier: 'mortal' };
const SNAP: Snapshot = { biome: 'plains', time: 1200, position: [0, 64, 0], health: 20, hunger: 20, equipment: [], inventory: [], nearbyEntities: [], nearbyBlocks: ['oak_log'], knownChests: [] };

const BAD = 'async function collect(bot, args, ctx) { throw new Error("pas encore implémenté"); }';
// FakeBot test affordance: bot.give simulates ending up with the logs (no Minecraft in CI). The
// engine's worldAfter snapshot then satisfies the check {oak_log:3}.
const GOOD = 'async function collect(bot, args, ctx) { bot.give("oak_log", 3); return { collected: 3 }; }';

const writeTurn = (code: string): ScriptedTurn => ({
  toolCalls: [{ name: 'write_skill', arguments: { name: 'collect-oak-logs', summary: 'récolte 3 bûches de chêne', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: { collected: { type: 'number' } } }, code } }],
});
const runTurn = (): ScriptedTurn => ({ toolCalls: [{ name: 'run_skill', arguments: { name: 'collect-oak-logs', args: {} } }] });
const doneTurn = (s: string): ScriptedTurn => ({ toolCalls: [{ name: 'done', arguments: { summary: s } }] });
const verdictTurn = (args: object): ScriptedTurn => ({ toolCalls: [{ name: 'verdict', arguments: args }] });

interface Wiring {
  god: GodService;
  brain: Brain;
  critic: CriticDesk;
  library: SkillLibrary;
  journal: MemoryJournal;
  tools: ToolRegistry;
  llm: ScriptedLlm;
}

async function wire(turns: ScriptedTurn[]): Promise<Wiring> {
  const dir = mkdtempSync(join(tmpdir(), 'eden-gate-'));
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
  const inboxes = new Map<string, Inbox>([['Firmin', new VillagerInbox('Firmin', journal)]]);
  const god = new GodService({ journal, library, inboxes });
  const critic = new CriticDesk({ client, scheduler, journal });
  return { god, brain, critic, library, journal, tools, llm };
}

/**
 * The M3 rollout loop: ONE rollout, revised draft→run→verdict→revise until admit or maxRetries.
 * Returns whether it converged + the rolloutId every event shares.
 */
async function runRollout(w: Wiring, task: Task): Promise<{ converged: boolean; rolloutId: string; revisions: number }> {
  w.god.addTask(task);
  const rollout = w.god.openRollout(task.id);
  const toolNames = w.tools.definitions().map((d) => d.function.name);

  let lastCritique: string | undefined;
  let lastRunReport: RunReport | undefined;
  let draftCode: string | undefined;
  let draftVersion: number | undefined;
  const history: RevisionTurn[] = [];
  let revisions = 0;

  for (let i = 0; i < task.maxRetries; i++) {
    revisions++;
    const input: ContextPackInput = {
      villager: 'Firmin', runner: MORTAL,
      persona: 'Tu es Firmin, fermier du village. Tu parles français.', role: 'farmer',
      triggers: [`directive de Dieu: ${task.goal}`], hint: 'authoring',
      snapshot: SNAP, runningSkill: null, directive: { goal: task.goal, reason: 'le grenier est vide' }, openTask: { goal: task.goal },
      recentEvents: [], memories: [], retrievedSkills: [], exemplars: [], includeExemplarCode: true,
      toolNames, inbox: [],
      density: draftVersion !== undefined ? { draft: { name: 'collect-oak-logs', version: draftVersion, code: draftCode! }, runReport: lastRunReport, critique: lastCritique } : undefined,
      history: [...history],
      tier: 'strong', inputTokenBudget: 48000,
    };

    const delib = await w.brain.deliberate(input, { rolloutId: rollout.id });
    assert.ok(delib.draft && delib.lastRunReport, 'the villager authored + trialed a draft');

    const ticket = w.god.fileTicket({ rolloutId: rollout.id, report: delib.lastRunReport!, source: 'rollout' });
    const verdict = await w.critic.judge({
      ticket,
      task,
      report: delib.lastRunReport!,
      code: w.library.read(delib.draft!.name, delib.draft!.version)?.code ?? '',
      dossier: w.god.dossierFor('Firmin'),
      lastCritique,
    });
    const route = await w.god.routeVerdict(verdict, { rolloutId: rollout.id, draft: delib.draft!, task });
    if (route.rolloutClosed) return { converged: true, rolloutId: rollout.id, revisions };

    // Set up the next revision's density payload from this revision's artifacts.
    lastCritique = verdict.critique;
    lastRunReport = delib.lastRunReport;
    draftVersion = delib.draft!.version;
    draftCode = w.library.read(delib.draft!.name, delib.draft!.version)?.code;
  }
  return { converged: false, rolloutId: rollout.id, revisions };
}

const task = (): Task => ({ id: 'task-1', goal: 'collect 3 oak logs', assignee: 'Firmin', successCriteria: 'avoir 3 oak_log dans l’inventaire', check: { item: 'oak_log', count: 3 }, context: '', maxRetries: 4 });

test('★ M3-GATE: one villager converges (fail-once → fix) to active-probation through the full cycle', async () => {
  const w = await wire([
    // ── revision 1: villager writes a broken draft, runs it (fails), done ──
    writeTurn(BAD), runTurn(), doneTurn('échec, je dois réessayer'),
    verdictTurn({ success: false, critique: 'le code lève une exception; implémente vraiment la récolte', libraryAction: 'keep-draft' }),
    // ── revision 2: villager fixes it, runs it (succeeds, ends with 3 logs), done ──
    writeTurn(GOOD), runTurn(), doneTurn('récolté 3 bûches'),
    verdictTurn({ success: true, critique: 'bien — code générique et propre', libraryAction: 'admit', praise: 'beau travail' }),
  ]);
  try {
    const t = task();
    const result = await runRollout(w, t);

    // Converged on the second revision.
    assert.equal(result.converged, true, 'the rollout converged');
    assert.equal(result.revisions, 2, 'it took one failure then a fix');

    // The skill landed in active-probation (D-12), at v2; v1 is a harmless orphan draft.
    const live = w.library.activeVersion('collect-oak-logs');
    assert.equal(live?.status, 'active-probation', 'admitted skill is active-probation, not active');
    assert.equal(live?.version, 2, 'the FIXED draft (v2) was admitted');
    assert.equal(w.library.getVersion('collect-oak-logs', 1)?.status, 'draft', 'the broken v1 stays a draft');

    // The task closed as completed; its rollout pointer is cleared (D-09 invariant).
    assert.equal(w.god.state.ledger.completed.length, 1);
    assert.equal(t.currentRolloutId, undefined);

    // ── The rollout view: refs.rolloutId shows the COMPLETE cycle (the website's rollout page). ──
    const view = w.journal.query({ ref: result.rolloutId });
    const count = (kind: string) => view.filter((e) => e.kind === kind).length;
    assert.equal(count('brain.wakeup'), 2, 'two deliberations');
    assert.equal(count('skill.run'), 2, 'two draft trials');
    assert.equal(count('god.ticket'), 2, 'two tickets filed');
    assert.equal(count('god.verdict'), 2, 'two verdicts');
    assert.equal(count('skill.admit'), 1, 'one admission (the fix)');
    // The whole cycle is causally ordered under one rolloutId — no event escaped the view.
    assert.ok(view.length >= 9, `the rollout view is complete (${view.length} events)`);

    // The critique reached the villager's inbox both times (it drove the revision).
    assert.equal(w.journal.query({ kinds: ['inbox.delivered'] }).length, 2);
  } finally {
    await w.llm.close();
  }
});

test('★ M3-GATE: the check-veto blocks admission of a draft that never produced the logs (R34)', async () => {
  // The villager "succeeds" cleanly but the skill never actually yields oak_log; the critic tries to
  // admit, but the failed check (oak_log≥3 not met in worldAfter) vetoes it — it stays a draft.
  const NOOP = 'async function collect(bot, args, ctx) { return { collected: 3 }; }'; // claims 3, gives none
  const w = await wire([
    writeTurn(NOOP), runTurn(), doneTurn('je pense avoir fini'),
    verdictTurn({ success: true, critique: 'on dirait bon', libraryAction: 'admit' }),
  ]);
  try {
    const t = { ...task(), maxRetries: 1 };
    const result = await runRollout(w, t);
    assert.equal(result.converged, false, 'a no-op that fails the check never converges');
    assert.equal(w.library.activeVersion('collect-oak-logs'), undefined, 'nothing admitted — check-veto held');
    assert.equal(w.library.getVersion('collect-oak-logs', 1)?.status, 'draft', 'stays a draft (R34: completion ≠ progress)');
  } finally {
    await w.llm.close();
  }
});
