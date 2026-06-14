import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryJournal } from './fakes/memory-journal';
import {
  SkillLibrary,
  AllGranted,
  renderSignature,
  type DraftInput,
} from '../src/skills/library';
import type { SkillManifest } from '../src/types/index';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'eden-lib-'));
}

const draft = (over: Partial<DraftInput> = {}): DraftInput => ({
  name: 'collect-wood',
  summary: 'collect oak logs',
  params: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
  returns: { type: 'object', properties: { collected: { type: 'number' } } },
  code: 'async function collectWood(bot, a, c) { return { collected: a.count }; }',
  author: { kind: 'villager', name: 'Firmin' },
  tier: 'mortal',
  ...over,
});

function lib(dir = tmp(), journal = new MemoryJournal()): { library: SkillLibrary; journal: MemoryJournal; dir: string } {
  return { library: new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 }), journal, dir };
}

test('renderSignature derives a TS-style line from the schemas (can not lie — D-04)', () => {
  const sig = renderSignature(
    'harvest-field',
    { type: 'object', properties: { center: { type: 'object' }, radius: { type: 'number' } }, required: ['center'] },
    { type: 'object', properties: { harvested: { type: 'number' } } },
  );
  assert.match(sig, /center: object/);
  assert.match(sig, /radius\?: number/);
  assert.match(sig, /harvested: number/);
});

test('M2-2: upsertDraft is append-only and version-monotonic; code lands on disk; journals skill.draft', () => {
  const { library, journal, dir } = lib();
  const v1 = library.upsertDraft(draft());
  assert.equal(v1.version, 1);
  assert.equal(v1.status, 'draft');
  const v2 = library.upsertDraft(draft({ code: 'async function collectWood(bot, a, c) { return { collected: 0 }; }' }));
  assert.equal(v2.version, 2, 'versions never reused');
  // Both code files persist (append-only retention — v1's file stays forever).
  const files = readdirSync(join(dir, 'library', 'collect-wood'));
  assert.ok(files.includes('v1.js') && files.includes('v2.js'));
  const drafts = journal.query({ kinds: ['skill.draft'] });
  assert.equal(drafts.length, 2);
  assert.equal((drafts[0]!.payload as Record<string, unknown>)['lines'], 1);
});

test('M2-2 (D-12): admit lands in active-probation, not active; journals provenance', () => {
  const { library, journal } = lib();
  library.upsertDraft(draft());
  const admitted = library.admit('collect-wood', 1, { rolloutId: 'r1', verdictId: 'v1' });
  assert.equal(admitted.status, 'active-probation');
  assert.equal(admitted.probationRunsLeft, 3);
  const ev = journal.query({ kinds: ['skill.admit'] })[0]!;
  assert.deepEqual((ev.payload as Record<string, unknown>)['provenance'], { rolloutId: 'r1', verdictId: 'v1' });
});

test('M2-2 (D-12): probation graduates after N clean re-judged runs; a failure does not count', () => {
  const { library } = lib();
  library.upsertDraft(draft());
  library.admit('collect-wood', 1, { rolloutId: 'r1', verdictId: 'v1' });
  library.recordProbationRun('collect-wood', false); // a failure must not advance graduation
  assert.equal(library.activeVersion('collect-wood')?.status, 'active-probation');
  assert.equal(library.activeVersion('collect-wood')?.probationRunsLeft, 3);
  library.recordProbationRun('collect-wood', true);
  library.recordProbationRun('collect-wood', true);
  assert.equal(library.activeVersion('collect-wood')?.status, 'active-probation');
  library.recordProbationRun('collect-wood', true); // third clean run → graduate
  assert.equal(library.activeVersion('collect-wood')?.status, 'active');
  assert.equal(library.activeVersion('collect-wood')?.probationRunsLeft, undefined);
});

test('M2-2 (D-12/R37): quarantine then self-healing un-quarantine lands in active-probation', () => {
  const { library, journal } = lib();
  library.upsertDraft(draft());
  library.admit('collect-wood', 1, { rolloutId: 'r1', verdictId: 'v1' });
  library.quarantine('collect-wood', 'stats decayed');
  assert.equal(library.getVersion('collect-wood', 1)?.status, 'quarantined');
  assert.equal(library.activeVersion('collect-wood'), undefined, 'a quarantined skill is not live');
  assert.equal(journal.query({ kinds: ['skill.quarantine'] }).length, 1);
  // A forced re-trial succeeds → re-enter active-probation, NEVER straight to active (R37/R48).
  const healed = library.unquarantine('collect-wood');
  assert.equal(healed?.status, 'active-probation');
  assert.equal(healed?.probationRunsLeft, 3);
});

test('M2-2: archive removes a version from retrieval/default-read but keeps it on disk', () => {
  const { library } = lib();
  library.upsertDraft(draft());
  library.admit('collect-wood', 1, { rolloutId: 'r', verdictId: 'v' });
  library.archive('collect-wood', 1);
  assert.equal(library.activeVersion('collect-wood'), undefined);
  assert.equal(library.read('collect-wood'), undefined, 'default read skips archived');
  assert.equal(library.getVersion('collect-wood', 1)?.status, 'archived', 'still addressable by explicit version');
});

test('M2-2: read default = newest non-archived; explicit version still resolves', () => {
  const { library } = lib();
  library.upsertDraft(draft());
  library.upsertDraft(draft({ code: 'async function collectWood(bot, a, c) { return { collected: 99 }; }' }));
  library.admit('collect-wood', 2, { rolloutId: 'r', verdictId: 'v' });
  const def = library.read('collect-wood');
  assert.equal(def?.version.version, 2);
  assert.match(def!.code, /99/);
  const explicit = library.read('collect-wood', 1);
  assert.equal(explicit?.version.version, 1);
});

test('M2-2: exemplars are tier-filtered and active-only', () => {
  const { library } = lib();
  library.seedStock(draft({ name: 'go-to', exemplar: true }), 'active');
  library.seedStock(draft({ name: 'fly-to', tier: 'divine', exemplar: true }), 'active');
  library.seedStock(draft({ name: 'mine-block', exemplar: false }), 'active');
  const mortal = library.exemplars('mortal').map((v) => v.name);
  assert.deepEqual(mortal, ['go-to']);
  const divine = library.exemplars('divine').map((v) => v.name);
  assert.deepEqual(divine, ['fly-to']);
});

test('M2-2: verifyHashes quarantines a tampered code file at boot', () => {
  const dir = tmp();
  const first = lib(dir);
  first.library.upsertDraft(draft());
  first.library.admit('collect-wood', 1, { rolloutId: 'r', verdictId: 'v' });
  // Tamper the on-disk code out from under the recorded hash.
  writeFileSync(join(dir, 'library', 'collect-wood', 'v1.js'), 'async function x(){ return { hacked: true }; }');
  // A fresh library boots from the same dir and re-verifies.
  const journal = new MemoryJournal();
  const reborn = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  reborn.verifyHashes();
  assert.equal(reborn.getVersion('collect-wood', 1)?.status, 'quarantined');
  const q = journal.query({ kinds: ['skill.quarantine'] })[0]!;
  assert.match((q.payload as Record<string, unknown>)['reason'] as string, /hash/i);
});

test('M2-2: AllGranted is the v0 economy seam — constant true at both call sites', () => {
  const grants = new AllGranted();
  assert.equal(grants.canRetrieve('Firmin', 'collect-wood'), true);
  assert.equal(grants.canRun('Colette', 'fly-to'), true);
});

test('M2-2: a divine draft keeps its tier through the manifest (set by God/admin, not the library)', () => {
  const { library } = lib();
  const v = library.upsertDraft(draft({ name: 'summon-creature', tier: 'divine' }));
  const m: SkillManifest | undefined = library.read('summon-creature', v.version)?.manifest;
  assert.equal(m?.tier, 'divine');
});
