import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JOURNAL_KINDS,
  KIND_REGISTRY,
  isKnownKind,
  describeKinds,
} from '../src/journal/kinds';

test('M0..M6 register their kinds (one row per kind; each milestone adds only its own)', () => {
  assert.deepEqual(
    [...JOURNAL_KINDS],
    [
      // System domain (M0).
      'system.boot',
      'system.config-warning',
      'system.bot-connected',
      'system.bot-disconnected',
      'system.error',
      'system.loop-lag',
      // World domain (M1).
      'vitals',
      'world.death',
      // Skills domain (M2).
      'skill.draft',
      'skill.admit',
      'skill.quarantine',
      'skill.archive',
      'skill.run',
      'skill.log',
      // LLM domain (M2).
      'llm.call',
      // Brain domain (M3).
      'brain.wakeup',
      'brain.tool-call',
      'brain.done',
      // God domain (M3).
      'god.ticket',
      'god.verdict',
      'god.appearance',
      'god.rollout-abandoned',
      // God domain (M4).
      'god.task-proposed',
      'god.task-closed',
      'god.directive',
      'god.directive-closed',
      // Social domain (M3).
      'inbox.delivered',
      // Social domain (M6).
      'chat.said',
      'chat.heard',
      'conversation.started',
      'conversation.turn',
      'conversation.ended',
      'trade.proposed',
      'trade.settled',
      'trade.failed',
      // Reactivity domain (M5).
      'subscription.created',
      'subscription.removed',
      'subscription.fired',
      'subscription.suppressed',
    ],
  );
});

test('every kind has a registry doc row (S1 exhaustiveness)', () => {
  for (const k of JOURNAL_KINDS) {
    assert.ok(KIND_REGISTRY[k]?.doc, `kind ${k} is missing a doc`);
  }
  assert.equal(describeKinds().length, JOURNAL_KINDS.length);
});

test('isKnownKind is a precise type guard', () => {
  assert.equal(isKnownKind('system.loop-lag'), true);
  assert.equal(isKnownKind('vitals'), true); // registered in M1 (World domain)
  assert.equal(isKnownKind('world.death'), true); // registered in M1 (R27/G2)
  assert.equal(isKnownKind('subscription.fired'), true); // registered in M5 (Reactivity)
  assert.equal(isKnownKind('subscription.suppressed'), true); // registered in M5 (Reactivity)
  assert.equal(isKnownKind('chat.said'), true); // registered in M6 (Social)
  assert.equal(isKnownKind('conversation.ended'), true); // registered in M6 (Social)
  assert.equal(isKnownKind('trade.settled'), true); // registered in M6 (Social)
  assert.equal(isKnownKind('totally-made-up'), false);
});

test('R44: no per-tick / pulse stream is ever a JournalKind', () => {
  // Word boundaries: catch a genuine per-tick kind (`tick`, `tick-30s`) without false-matching a
  // substring like `god.ticket` (a ticket is not a stream).
  for (const k of JOURNAL_KINDS) {
    assert.doesNotMatch(
      k,
      /\b(pulse|tick|position|pathfinder|physic)\b/i,
      `${k} looks like a per-tick stream — pulses are in-memory only (R44/D-07)`,
    );
  }
});
