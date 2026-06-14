// M7-1a — the derived views (LAYER 1: fold the journal, never primary state; rebuildable by replay).
// Each view exposes fold(event) + value()/snapshot(); rebuildByReplay(journal) folds the whole history.
// These tests pin the folding math and the rebuild-by-replay contract (P4 / S2 derived-state discipline).

import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryJournal } from './fakes/memory-journal';
import {
  SkillStatsView,
  CompetenceView,
  RelationsView,
  TradeLedgerView,
  ALL_VIEWS,
} from '../src/views/index';
import type { RunReport } from '../src/types/index';

function runReport(over: Partial<RunReport>): RunReport {
  return {
    runId: 'r1',
    skill: 'go-to',
    version: 1,
    villager: 'Firmin',
    args: {},
    outcome: { ok: true },
    startedAt: 1000,
    durationMs: 50,
    pulses: 3,
    deepestDepth: 0,
    callTree: [],
    worldBefore: null,
    worldAfter: null,
    ...over,
  };
}

// ── SkillStatsView ─────────────────────────────────────────────────────────
test('SkillStatsView folds skill.run into per-skill runs/successes/failures/stalls/avgMs', () => {
  const v = new SkillStatsView();
  v.fold(ev('skill.run', runReport({ skill: 'mine', outcome: { ok: true }, durationMs: 100 })));
  v.fold(ev('skill.run', runReport({ skill: 'mine', outcome: { ok: false, error: 'no ore' }, durationMs: 200 })));
  v.fold(ev('skill.run', runReport({ skill: 'mine', outcome: { ok: false, error: 'timed out' }, aborted: 'stalled', durationMs: 300 })));

  const stats = v.value().mine;
  assert.equal(stats.runs, 3);
  assert.equal(stats.successes, 1);
  assert.equal(stats.failures, 2);
  assert.equal(stats.stalls, 1); // the aborted:'stalled' run
  assert.equal(stats.avgMs, 200); // (100+200+300)/3
  assert.equal(stats.lastError, 'timed out');
  assert.equal(typeof stats.lastRunAt, 'number');
});

test('SkillStatsView ignores non-skill.run events', () => {
  const v = new SkillStatsView();
  v.fold(ev('system.error', { message: 'x' }));
  assert.deepEqual(v.value(), {});
});

// ── CompetenceView ───────────────────────────────────────────────────────────
test('CompetenceView folds per-villager per-skill runs/successes from skill.run', () => {
  const v = new CompetenceView();
  v.fold(ev('skill.run', runReport({ villager: 'Firmin', skill: 'craft', outcome: { ok: true } })));
  v.fold(ev('skill.run', runReport({ villager: 'Firmin', skill: 'craft', outcome: { ok: false, error: 'x' } })));
  v.fold(ev('skill.run', runReport({ villager: 'Alban', skill: 'mine', outcome: { ok: true } })));

  const all = v.value();
  assert.deepEqual(all.Firmin.craft, { runs: 2, successes: 1 });
  assert.deepEqual(all.Alban.mine, { runs: 1, successes: 1 });
});

// ── RelationsView ─────────────────────────────────────────────────────────────
test('RelationsView folds conversation.ended opinion into a symmetric relation score', () => {
  const v = new RelationsView();
  v.fold(ev('conversation.started', { id: 'c1', initiator: 'Firmin', partner: 'Alban' }));
  v.fold(ev('conversation.ended', { id: 'c1', by: 'Firmin', reason: 'left', opinion: 3, headline: 'a fair trade' }, { conversationId: 'c1' }));

  const rels = v.value();
  // The leaver moved their relation toward the partner; the headline rides as the note.
  assert.equal(rels.Firmin.Alban.score, 3);
  assert.equal(rels.Firmin.Alban.note, 'a fair trade');
});

test('RelationsView accumulates opinion across multiple conversations', () => {
  const v = new RelationsView();
  v.fold(ev('conversation.started', { id: 'c1', initiator: 'Firmin', partner: 'Alban' }));
  v.fold(ev('conversation.ended', { id: 'c1', by: 'Firmin', reason: 'left', opinion: 2 }, { conversationId: 'c1' }));
  v.fold(ev('conversation.started', { id: 'c2', initiator: 'Firmin', partner: 'Alban' }));
  v.fold(ev('conversation.ended', { id: 'c2', by: 'Firmin', reason: 'left', opinion: -1 }, { conversationId: 'c2' }));
  assert.equal(v.value().Firmin.Alban.score, 1); // 2 + (-1)
});

// ── TradeLedgerView ───────────────────────────────────────────────────────────
test('TradeLedgerView folds trade.proposed/settled/failed into a per-trade ledger', () => {
  const v = new TradeLedgerView();
  v.fold(ev('trade.proposed', { id: 't1', from: 'Firmin', to: 'Alban', give: [{ item: 'coin', count: 2 }], want: [{ item: 'wheat', count: 3 }] }, { tradeId: 't1' }));
  v.fold(ev('trade.settled', { id: 't1', from: 'Firmin', to: 'Alban', give: [{ item: 'coin', count: 2 }], want: [{ item: 'wheat', count: 3 }] }, { tradeId: 't1' }));
  v.fold(ev('trade.proposed', { id: 't2', from: 'Alban', to: 'Firmin', give: [], want: [] }, { tradeId: 't2' }));
  v.fold(ev('trade.failed', { id: 't2', from: 'Alban', to: 'Firmin', reason: 'http 422' }, { tradeId: 't2' }));

  const ledger = v.value();
  assert.equal(ledger.length, 2);
  const t1 = ledger.find((t) => t.id === 't1')!;
  assert.equal(t1.status, 'settled');
  assert.equal(t1.from, 'Firmin');
  const t2 = ledger.find((t) => t.id === 't2')!;
  assert.equal(t2.status, 'failed');
  assert.equal(t2.reason, 'http 422');
});

// ── rebuild-by-replay == live (the deliverable) ───────────────────────────────
test('rebuildByReplay over the journal equals a view folded live', () => {
  const journal = new MemoryJournal();
  // Drive a mixed stream the same way the live system would.
  journal.append('engine', 'skill.run', runReport({ skill: 'mine', outcome: { ok: true } }));
  journal.append('engine', 'skill.run', runReport({ skill: 'mine', outcome: { ok: false, error: 'x' }, aborted: 'stalled' }));
  journal.append('villager:Firmin', 'chat.said', { from: 'Firmin', to: 'Alban', text: 'hi' });
  journal.append('villager:Firmin', 'conversation.ended', { id: 'c1', by: 'Firmin', reason: 'left', opinion: 4, headline: 'friend' }, { conversationId: 'c1' });
  journal.append('engine', 'trade.proposed', { id: 't1', from: 'Firmin', to: 'Alban', give: [], want: [] }, { tradeId: 't1' });
  journal.append('engine', 'trade.settled', { id: 't1', from: 'Firmin', to: 'Alban', give: [], want: [] }, { tradeId: 't1' });

  for (const View of ALL_VIEWS) {
    // Live: fold each event as it would arrive on the subscribe() stream.
    const live = new View();
    for (const e of journal.query()) live.fold(e);
    // Replay: a fresh view rebuilt purely by replaying the journal.
    const replayed = new View();
    replayed.rebuildByReplay(journal);
    assert.deepEqual(
      replayed.value(),
      live.value(),
      `${View.name}: rebuild-by-replay must equal the live fold (P4/S2)`,
    );
  }
});

// helper: build a JournalEvent with the right kind + payload + refs (the views read events generically).
let seq = 0;
function ev(kind: string, payload: object, refs: Record<string, unknown> = {}): import('../src/types/index').JournalEvent {
  return { id: `e${seq++}`, at: 1000 + seq, actor: 'engine', kind, payload, refs };
}
