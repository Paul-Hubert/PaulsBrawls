// M7-1c — `eden rebuild-stats`: replay the journal into the derived views. The deliverable invariant is
// rebuild-by-replay == live (P4/S2 derived-state). This pins the CLI's pure core against a live fold over
// a real on-disk Journal (the CLI opens the real DB; the rebuild path must equal folding the same stream).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Journal } from '../src/journal/journal';
import { ALL_VIEWS } from '../src/views/index';
import { rebuildStats } from '../src/cli/rebuild-stats';
import type { RunReport } from '../src/types/index';

function runReport(over: Partial<RunReport>): RunReport {
  return {
    runId: 'r', skill: 'go-to', version: 1, villager: 'Firmin', args: {}, outcome: { ok: true },
    startedAt: 1, durationMs: 10, pulses: 1, deepestDepth: 0, callTree: [],
    worldBefore: null, worldAfter: null, ...over,
  };
}

test('rebuild-stats replays a real on-disk journal; rebuild == live fold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eden-rebuild-'));
  const journal = new Journal(join(dir, 'eden.db'));
  try {
    // Drive a representative mixed stream through the REAL (SQLite) journal.
    journal.append('engine', 'skill.run', runReport({ skill: 'mine', villager: 'Firmin', outcome: { ok: true }, durationMs: 100 }));
    journal.append('engine', 'skill.run', runReport({ skill: 'mine', villager: 'Firmin', outcome: { ok: false, error: 'no ore' }, aborted: 'stalled', durationMs: 200 }));
    journal.append('engine', 'skill.run', runReport({ skill: 'craft', villager: 'Alban', outcome: { ok: true }, durationMs: 30 }));
    journal.append('villager:Firmin', 'conversation.started', { id: 'c1', initiator: 'Firmin', partner: 'Alban' });
    journal.append('villager:Firmin', 'conversation.ended', { id: 'c1', by: 'Firmin', reason: 'left', opinion: 5, headline: 'fast friend' }, { conversationId: 'c1' });
    journal.append('engine', 'trade.proposed', { id: 't1', from: 'Firmin', to: 'Alban', give: [{ item: 'coin', count: 1 }], want: [{ item: 'wheat', count: 2 }] }, { tradeId: 't1' });
    journal.append('engine', 'trade.settled', { id: 't1', from: 'Firmin', to: 'Alban', give: [{ item: 'coin', count: 1 }], want: [{ item: 'wheat', count: 2 }] }, { tradeId: 't1' });

    // Live fold: fold each event as it arrives (what the running host does on the subscribe stream).
    const live: Record<string, unknown> = {};
    for (const View of ALL_VIEWS) {
      const v = new View();
      for (const e of journal.query()) v.fold(e);
      live[View.name] = v.value();
    }

    // Rebuild via the CLI core (replay the same journal).
    const rebuilt = rebuildStats(journal);

    assert.deepEqual(rebuilt.skillStats, live['SkillStatsView']);
    assert.deepEqual(rebuilt.competence, live['CompetenceView']);
    assert.deepEqual(rebuilt.relations, live['RelationsView']);
    assert.deepEqual(rebuilt.tradeLedger, live['TradeLedgerView']);

    // Spot-check a couple of folded facts so a silently-empty pass can't hide.
    assert.equal((rebuilt.skillStats as any).mine.stalls, 1);
    assert.equal((rebuilt.relations as any).Firmin.Alban.score, 5);
    assert.equal((rebuilt.tradeLedger as any[])[0].status, 'settled');
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuild-stats on an empty journal yields empty views (no crash)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eden-rebuild-empty-'));
  const journal = new Journal(join(dir, 'eden.db'));
  try {
    const out = rebuildStats(journal);
    assert.deepEqual(out.skillStats, {});
    assert.deepEqual(out.competence, {});
    assert.deepEqual(out.relations, {});
    assert.deepEqual(out.tradeLedger, []);
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
