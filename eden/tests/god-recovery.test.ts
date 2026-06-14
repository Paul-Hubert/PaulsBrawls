import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryJournal } from './fakes/memory-journal';
import { SkillLibrary } from '../src/skills/library';
import { VillagerInbox } from '../src/villagers/inbox';
import { GodService } from '../src/god/god';
import type { Inbox, Task } from '../src/types/index';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'eden-recover-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  const inboxes = new Map<string, Inbox>([['Firmin', new VillagerInbox('Firmin', journal)]]);
  const god = new GodService({ journal, library, inboxes });
  return { god, library, journal };
}

const task = (over: Partial<Task> = {}): Task => ({ id: 'task-1', goal: 'collect 3 oak logs', assignee: 'Firmin', successCriteria: 'avoir 3 oak_log', context: '', maxRetries: 4, ...over });

test('M3-6 (D-09): boot recovery abandons an open task’s live rollout, clears the pointer, re-enqueues; orphan draft stays draft', () => {
  const { god, library, journal } = harness();

  // Pre-crash state: an open task with a LIVE rollout + an authored draft + rollout journal events.
  const t = task();
  god.addTask(t);
  const rollout = god.openRollout(t.id); // sets t.currentRolloutId
  assert.equal(t.currentRolloutId, rollout.id);
  library.upsertDraft({ name: 'collect-oak-logs', summary: 's', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function f(b,a,c){}', author: { kind: 'villager', name: 'Firmin' } });
  god.fileTicket({ rolloutId: rollout.id, report: { runId: 'run-1', rolloutId: rollout.id, skill: 'collect-oak-logs', version: 1, villager: 'Firmin', args: {}, outcome: { ok: false, error: 'crashed mid-trial' }, startedAt: 0, durationMs: 1, pulses: 0, deepestDepth: 0, callTree: [], worldBefore: null, worldAfter: null }, source: 'rollout' });

  // --- boot recovery (startup step 7) ---
  const n = god.recoverRollouts();

  assert.equal(n, 1, 'one open rollout abandoned');
  // god.rollout-abandoned journaled with reason + refs.
  const ab = journal.query({ kinds: ['god.rollout-abandoned'] });
  assert.equal(ab.length, 1);
  assert.equal((ab[0]!.payload as { reason: string }).reason, 'crash-recovery');
  assert.equal(ab[0]!.refs.rolloutId, rollout.id);
  assert.equal(ab[0]!.refs.taskId, t.id);
  // pointer cleared.
  assert.equal(t.currentRolloutId, undefined, 'currentRolloutId cleared');
  // task re-enqueued (still open, ready for a fresh rollout).
  assert.ok(god.state.ledger.open.some((x) => x.id === t.id), 'task re-enqueued in ledger.open');
  assert.equal(god.state.tasks.get(t.id)?.id, t.id);
  // the abandoned rollout is closed.
  assert.equal(god.state.rollouts.get(rollout.id)?.open, false);
  // orphan draft stays a harmless draft — NOT active, NOT retrievable for normal work (P2).
  assert.equal(library.getVersion('collect-oak-logs', 1)?.status, 'draft');
  assert.equal(library.activeVersion('collect-oak-logs'), undefined, 'the orphan draft is not retrievable');
  // the re-enqueued task keeps its full retry budget (the lost attempt never counts).
  assert.equal(god.state.tasks.get(t.id)?.maxRetries, 4);
});

test('M3-6 (D-09): a task with no live rollout is untouched by recovery', () => {
  const { god } = harness();
  const t = task({ id: 'task-2' });
  god.addTask(t); // no openRollout — currentRolloutId stays undefined
  const n = god.recoverRollouts();
  assert.equal(n, 0);
  assert.equal(t.currentRolloutId, undefined);
});
