import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIERS,
  SKILL_STATUSES,
  ABORT_CAUSES,
  PRIORITIES,
} from '../src/types/index';
import type {
  Task,
  RunReport,
  Verdict,
  JournalEvent,
  Subscription,
  Inbox,
  InboxMessage,
} from '../src/types/index';

// types/ is interface-heavy (compile-time only); the dependency-cruiser law test
// proves "types/ imports nothing". Here we pin the runtime enum-like registries so a
// typo in a member is caught, and we exercise the interfaces at the type level.

test('Tier registry has exactly mortal + divine', () => {
  assert.deepEqual([...TIERS], ['mortal', 'divine']);
});

test('SkillStatus registry matches the D-12 status machine', () => {
  assert.deepEqual(
    [...SKILL_STATUSES],
    ['draft', 'active-probation', 'active', 'quarantined', 'archived'],
  );
});

test('AbortCause registry is preempted/stalled/timeout', () => {
  assert.deepEqual([...ABORT_CAUSES], ['preempted', 'stalled', 'timeout']);
});

test('Priority registry is background/normal/interrupt', () => {
  assert.deepEqual([...PRIORITIES], ['background', 'normal', 'interrupt']);
});

test('domain interfaces are constructible as plain data', () => {
  const task: Task = {
    id: 't1',
    goal: 'collect 3 oak logs',
    successCriteria: 'three oak_log in inventory',
    context: '',
    maxRetries: 4,
  };
  assert.equal(task.maxRetries, 4);
  assert.equal(task.currentRolloutId, undefined);

  const verdict: Verdict = {
    ticketId: 'k1',
    success: true,
    critique: 'good',
    libraryAction: 'admit',
  };
  assert.equal(verdict.libraryAction, 'admit');

  const ev: JournalEvent = {
    id: '01J',
    at: 0,
    actor: 'engine',
    kind: 'system.boot',
    payload: {},
    refs: {},
  };
  assert.equal(ev.kind, 'system.boot');
});

test('Inbox is a behavior-free channel interface', () => {
  const delivered: InboxMessage[] = [];
  const inbox: Inbox = {
    deliver: (m) => void delivered.push(m),
    drain: () => delivered.splice(0, delivered.length),
  };
  inbox.deliver({ from: 'god', kind: 'tell', payload: { text: 'hi' }, at: 1 });
  assert.equal(inbox.drain().length, 1);
  assert.equal(inbox.drain().length, 0);
});

test('Subscription and RunReport shapes compile', () => {
  const sub: Subscription = {
    id: 's1',
    villager: 'Firmin',
    on: 'hurt',
    handler: { kind: 'deliberate', hint: 'react to damage' },
    source: 'role-default',
    enabled: true,
  };
  assert.equal(sub.on, 'hurt');

  const report: RunReport = {
    runId: 'r1',
    skill: 'collect-blocks',
    version: 1,
    villager: 'Firmin',
    args: {},
    outcome: { ok: true },
    startedAt: 0,
    durationMs: 5,
    pulses: 3,
    deepestDepth: 0,
    callTree: [],
    worldBefore: null,
    worldAfter: null,
  };
  assert.equal(report.outcome.ok, true);
});
