// Regression guard for live-tests/checks.ts `chainStatus()`. The bug it pins: `skill.draft` events are
// NOT rollout-scoped — library.upsertDraft refs only {skill, skillVersion} because the library is a low
// layer that doesn't know the rolloutId (run/ticket/verdict/admit all carry rolloutId because God/the
// coordinator emit them). Scoping drafts by a rolloutId ref-query therefore made `draftByVillager`
// STRUCTURALLY always-false, even when a villager authored the very skill the rollout ran + admitted (seen
// live on farm-wheat: admit=true but draft=false). The fix ties a draft to the rollout by the (skill,
// version) the rollout actually RAN. The MemoryJournal fake reproduces the real query semantics ("any refs
// value === ref"), so this test would have caught the original mis-scoping.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryJournal } from './fakes/memory-journal';
import { chainStatus } from '../live-tests/checks';
import type { EdenHost } from '../src/main';
import type { RunReport } from '../src/types/index';

const ROLLOUT = '01ROLLOUTAAAAAAAAAAAAAAAAA';

/** A complete-enough RunReport — chainStatus reads only `.outcome.ok`; the (skill, version) join is in refs. */
function runReport(skill: string, version: number, rolloutId: string, ok: boolean): RunReport {
  return {
    runId: `run-${skill}-${version}`,
    rolloutId,
    skill,
    version,
    villager: 'Firmin',
    args: {},
    outcome: ok ? { ok: true } : { ok: false, error: 'boom' },
    startedAt: 0,
    durationMs: 1,
    pulses: 0,
    deepestDepth: 0,
    callTree: [],
    worldBefore: null,
    worldAfter: null,
  };
}

/** chainStatus only touches host.journal — a thin stand-in is all it needs. */
function hostWith(journal: MemoryJournal): EdenHost {
  return { journal } as unknown as EdenHost;
}

test('chainStatus: draftByVillager ties an un-rollout-scoped draft to the version the rollout ran', () => {
  const j = new MemoryJournal();
  // Drafts carry only {skill, skillVersion} — NO rolloutId — exactly like the real library write.
  j.append('engine', 'skill.draft', { name: 'mine-block', version: 1, author: { kind: 'stock' }, tier: 'mortal', lines: 6 }, { skill: 'mine-block', skillVersion: 1 });
  j.append('villager:Firmin', 'skill.draft', { name: 'harvest_wheat', version: 1, author: { kind: 'villager', name: 'Firmin' }, tier: 'mortal', lines: 20 }, { skill: 'harvest_wheat', skillVersion: 1 });
  j.append('villager:Firmin', 'skill.draft', { name: 'harvest_wheat', version: 2, author: { kind: 'villager', name: 'Firmin' }, tier: 'mortal', lines: 27 }, { skill: 'harvest_wheat', skillVersion: 2 });
  // The rollout RAN harvest_wheat v2 — rollout-scoped, refs carry rolloutId + skill + skillVersion.
  j.append('villager:Firmin', 'skill.run', runReport('harvest_wheat', 2, ROLLOUT, true), { runId: 'run-harvest_wheat-2', rolloutId: ROLLOUT, skill: 'harvest_wheat', skillVersion: 2 });
  j.append('god:critic', 'god.ticket', { source: 'rollout', skill: 'harvest_wheat', version: 2 }, { rolloutId: ROLLOUT, runId: 'run-harvest_wheat-2', skill: 'harvest_wheat', skillVersion: 2 });
  j.append('god:critic', 'god.verdict', { ticketId: 't1', success: true, libraryAction: 'admit', critique: 'ok' }, { rolloutId: ROLLOUT, verdictId: 'v1', skill: 'harvest_wheat', skillVersion: 2 });
  j.append('god:critic', 'skill.admit', { name: 'harvest_wheat', version: 2, provenance: { rolloutId: ROLLOUT, verdictId: 'v1' } }, { skill: 'harvest_wheat', skillVersion: 2, rolloutId: ROLLOUT, verdictId: 'v1' });

  const chain = chainStatus(hostWith(j), ROLLOUT);
  assert.equal(chain.draftByVillager, true, 'the version the rollout ran + admitted was villager-authored');
  assert.equal(chain.runOk, true);
  assert.equal(chain.ticket, true);
  assert.equal(chain.verdict, true);
  assert.equal(chain.verdictSuccess, true);
  assert.equal(chain.admit, true);
});

test('chainStatus: draftByVillager scopes to the RAN version, not "any villager draft exists in the journal"', () => {
  const j = new MemoryJournal();
  // A villager draft exists — but for a skill this rollout never ran.
  j.append('villager:Firmin', 'skill.draft', { name: 'harvest_wheat', version: 1, author: { kind: 'villager', name: 'Firmin' }, tier: 'mortal', lines: 20 }, { skill: 'harvest_wheat', skillVersion: 1 });
  j.append('engine', 'skill.draft', { name: 'mine-block', version: 1, author: { kind: 'stock' }, tier: 'mortal', lines: 6 }, { skill: 'mine-block', skillVersion: 1 });
  // This rollout COMPOSED only the stock mine-block skill.
  j.append('villager:Firmin', 'skill.run', runReport('mine-block', 1, ROLLOUT, true), { runId: 'run-mine-block-1', rolloutId: ROLLOUT, skill: 'mine-block', skillVersion: 1 });

  const chain = chainStatus(hostWith(j), ROLLOUT);
  assert.equal(chain.draftByVillager, false, 'the ran version was stock-authored — an unrelated villager draft must not count');
  assert.equal(chain.runOk, true);
});
