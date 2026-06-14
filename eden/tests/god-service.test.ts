import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryJournal } from './fakes/memory-journal';
import { SkillLibrary } from '../src/skills/library';
import { VillagerInbox } from '../src/villagers/inbox';
import { GodService } from '../src/god/god';
import type { Inbox, RunReport, Snapshot, Task, Verdict } from '../src/types/index';

const SNAP: Snapshot = { biome: 'plains', time: 0, position: [0, 64, 0], health: 20, hunger: 20, equipment: [], inventory: [], nearbyEntities: [], nearbyBlocks: [], knownChests: [] };

function report(over: Partial<RunReport> = {}): RunReport {
  return { runId: 'run-1', rolloutId: 'roll-x', skill: 'collect-oak-logs', version: 1, villager: 'Firmin', args: {}, outcome: { ok: true }, startedAt: 0, durationMs: 50, pulses: 1, deepestDepth: 0, callTree: [], worldBefore: SNAP, worldAfter: SNAP, ...over };
}

function task(over: Partial<Task> = {}): Task {
  return { id: 'task-1', goal: 'collect 3 oak logs', assignee: 'Firmin', successCriteria: 'avoir 3 oak_log', context: '', maxRetries: 4, ...over };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'eden-god-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  const inbox = new VillagerInbox('Firmin', journal);
  const inboxes = new Map<string, Inbox>([['Firmin', inbox]]);
  const god = new GodService({ journal, library, inboxes });
  return { god, library, journal, inbox, dir };
}

const verdict = (over: Partial<Verdict> = {}): Verdict => ({ ticketId: 'ticket-1', success: true, critique: 'bon', libraryAction: 'admit', ...over });

test('M3-4: openRollout creates a rollout and sets task.currentRolloutId (D-09 one live rollout)', () => {
  const { god } = harness();
  const t = task();
  god.addTask(t);
  const rollout = god.openRollout(t.id);
  assert.equal(rollout.open, true);
  assert.equal(rollout.taskId, t.id);
  assert.equal(rollout.villager, 'Firmin');
  assert.equal(t.currentRolloutId, rollout.id, 'the task points at its live rollout');
  assert.equal(god.state.rollouts.get(rollout.id)?.id, rollout.id);
});

test('M3-4: fileTicket enqueues a ticket and journals god.ticket under refs.rolloutId', () => {
  const { god, journal } = harness();
  const t = task();
  god.addTask(t);
  const rollout = god.openRollout(t.id);
  const ticket = god.fileTicket({ rolloutId: rollout.id, report: report({ rolloutId: rollout.id }), source: 'rollout' });
  assert.equal(god.state.criticQueue.length, 1);
  assert.equal(ticket.runReportRef, 'run-1');
  const ev = journal.query({ kinds: ['god.ticket'] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.refs.rolloutId, rollout.id);
  assert.equal(ev[0]!.refs.skill, 'collect-oak-logs');
});

test('M3-4 (routeVerdict admit): a draft → active-probation, critique to inbox, task completed, rollout closed', async () => {
  const { god, library, journal, inbox } = harness();
  const t = task();
  god.addTask(t);
  const rollout = god.openRollout(t.id);
  // The villager authored a draft.
  library.upsertDraft({ name: 'collect-oak-logs', summary: 's', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function f(b,a,c){ return {ok:true}; }', author: { kind: 'villager', name: 'Firmin' }, tags: ['wood'] });

  const out = await god.routeVerdict(verdict({ libraryAction: 'admit', success: true }), { rolloutId: rollout.id, draft: { name: 'collect-oak-logs', version: 1 }, task: t });

  assert.equal(out.admitted, true);
  assert.equal(out.rolloutClosed, true);
  assert.equal(library.getVersion('collect-oak-logs', 1)?.status, 'active-probation', 'admit lands in active-probation (D-12), not active');
  // god.verdict journaled with refs.
  const v = journal.query({ kinds: ['god.verdict'] });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.refs.rolloutId, rollout.id);
  // critique delivered to the assignee inbox (inbox.delivered journaled).
  assert.equal(journal.query({ kinds: ['inbox.delivered'] }).length, 1);
  assert.equal(inbox.depth(), 1);
  // task moved open → completed; rollout closed.
  assert.equal(god.state.ledger.completed.length, 1);
  assert.equal(god.state.ledger.open.find((x) => x.id === t.id), undefined);
  assert.equal(god.state.rollouts.get(rollout.id)?.open, false);
  // dossier updated by tag.
  const dossier = god.dossierFor('Firmin');
  assert.equal(dossier.competence['wood']?.successes, 1);
});

test('M3-4 (routeVerdict keep-draft): critique to inbox, rollout stays open, task stays open', async () => {
  const { god, library, inbox } = harness();
  const t = task();
  god.addTask(t);
  const rollout = god.openRollout(t.id);
  library.upsertDraft({ name: 'collect-oak-logs', summary: 's', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function f(b,a,c){}', author: { kind: 'villager', name: 'Firmin' } });

  const out = await god.routeVerdict(verdict({ libraryAction: 'keep-draft', success: false, critique: 'révise la boucle' }), { rolloutId: rollout.id, draft: { name: 'collect-oak-logs', version: 1 }, task: t });

  assert.equal(out.admitted, false);
  assert.equal(out.rolloutClosed, false);
  assert.equal(library.getVersion('collect-oak-logs', 1)?.status, 'draft', 'still a draft');
  assert.equal(god.state.rollouts.get(rollout.id)?.open, true, 'rollout stays open for revision');
  assert.equal(god.state.ledger.completed.length, 0);
  assert.equal(inbox.depth(), 1, 'the critique drives the next revision');
  assert.equal(god.state.rollouts.get(rollout.id)?.critiqueChain.length, 1);
});

test('M3-4 (D-12(ii)/R37): a wrongly-quarantined skill that succeeds re-enters active-probation, not active', async () => {
  const { god, library } = harness();
  const t = task();
  god.addTask(t);
  const rollout = god.openRollout(t.id);
  // Seed an ACTIVE skill, then quarantine it (a wrong quarantine).
  library.seedStock({ name: 'collect-oak-logs', summary: 's', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function f(b,a,c){ return {ok:true}; }', author: { kind: 'stock' }, tags: ['wood'] }, 'active');
  library.quarantine('collect-oak-logs', 'wrongly flagged', 1);
  assert.equal(library.getVersion('collect-oak-logs', 1)?.status, 'quarantined');

  // A forced re-trial succeeds; the critic admits it.
  const out = await god.routeVerdict(verdict({ libraryAction: 'admit', success: true }), { rolloutId: rollout.id, draft: { name: 'collect-oak-logs', version: 1 }, task: t });

  assert.equal(out.admitted, true);
  assert.equal(library.getVersion('collect-oak-logs', 1)?.status, 'active-probation', 'self-healing un-quarantine lands in active-probation (R37/R48), never straight to active');
});
