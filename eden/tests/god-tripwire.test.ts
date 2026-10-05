// B3.3 — the FailureTripwire (autoQuarantineAfter) files a critic ticket in the live host. main.ts passes
// `onTripwire` to the SkillEngine (late-bound to makeTripwireHandler once the critic exists). These tests drive
// the real engine streak → handler → CriticDesk (scripted LLM) → GodService.routeTripwireVerdict path. The
// engine→handler hop inside main.ts needs a live bot to run a skill, so it is pinned here, not through start().

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptedLlm, type ScriptedTurn } from './fakes/scripted-llm';
import { MemoryJournal } from './fakes/memory-journal';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { LlmClient, ProviderRegistry } from '../src/llm/client';
import { LlmScheduler } from '../src/llm/scheduler';
import { CriticDesk } from '../src/god/critic';
import { GodService } from '../src/god/god';
import { SkillLibrary, AllGranted } from '../src/skills/library';
import { SkillEngine } from '../src/skills/engine';
import { makeTripwireHandler } from '../src/main';
import type { RunReport } from '../src/types/index';

holdEventLoopPerTest();

const verdict = (args: object): ScriptedTurn => ({ toolCalls: [{ name: 'verdict', arguments: args }] });

async function rig(turns: ScriptedTurn[]) {
  const dir = mkdtempSync(join(tmpdir(), 'eden-tripwire-'));
  const journal = new MemoryJournal();
  const llm = await ScriptedLlm.start(turns);
  const client = new LlmClient({
    providers: new ProviderRegistry({
      strong: { baseUrl: llm.url, model: 'strong', inputTokenBudget: 48000 },
      fast: { baseUrl: llm.url, model: 'fast', inputTokenBudget: 16000 },
    }),
    journal,
  });
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  library.seedStock({
    name: 'broken', summary: 'casse', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} },
    code: "async function broken(bot, a, c) { throw new Error('toujours cassé'); }", author: { kind: 'stock' }, tier: 'mortal',
  });
  const god = new GodService({ journal, library, inboxes: new Map() });
  const critic = new CriticDesk({ client, scheduler: new LlmScheduler({ maxConcurrent: 2, perVillagerCooldownMs: 0 }), journal });
  const handler = makeTripwireHandler({ god, critic, library, threshold: 3 });
  const fired: string[] = [];
  const bot = new FakeBot({ username: 'Firmin' });
  const engine = new SkillEngine({
    library, journal, grants: new AllGranted(), resolveBot: () => bot,
    runDefaultTimeoutMs: 2_000, stallSeconds: 20, maxCallDepth: 8, autoQuarantineAfter: 3,
    onTripwire: (s: string, r: RunReport) => { fired.push(s); handler(s, r); },
  });
  return { journal, library, engine, fired, llm };
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(pred(), 'condition met in time');
}

test('B3.3: a failure streak files ONE tripwire ticket and a quarantine verdict pulls the skill', async () => {
  const h = await rig([verdict({ success: false, critique: 'le code lève toujours', libraryAction: 'quarantine', score: 0 })]);
  const runner = { name: 'Firmin', role: 'farmer', tier: 'mortal' as const };
  for (let i = 0; i < 3; i++) await h.engine.run('broken', {}, runner);
  assert.deepEqual(h.fired, ['broken'], 'the tripwire fired once for the streak');
  await until(() => h.journal.query({ kinds: ['skill.quarantine'] }).length === 1);
  const ticket = h.journal.query({ kinds: ['god.ticket'] })[0]!;
  assert.equal((ticket.payload as { source: string }).source, 'tripwire');
  const q = h.journal.query({ kinds: ['skill.quarantine'] })[0]!;
  assert.equal(q.actor, 'god:critic');
  assert.match((q.payload as { reason: string }).reason, /^tripwire: le code lève toujours/);
  assert.equal(h.library.activeVersion('broken'), undefined, 'the quarantined skill is no longer runnable');
  await h.llm.close();
});

test('B3.3: a tripwire verdict can never admit or archive — only quarantine is applied', async () => {
  const h = await rig([verdict({ success: true, critique: 'ça va', libraryAction: 'archive', score: 5 })]);
  const runner = { name: 'Firmin', role: 'farmer', tier: 'mortal' as const };
  for (let i = 0; i < 3; i++) await h.engine.run('broken', {}, runner);
  await until(() => h.journal.query({ kinds: ['god.verdict'] }).length === 1);
  assert.equal(h.journal.query({ kinds: ['skill.quarantine', 'skill.archive'] }).length, 0);
  assert.equal(h.library.activeVersion('broken')?.status, 'active', 'untouched');
  await h.llm.close();
});
