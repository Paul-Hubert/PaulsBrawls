import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { SkillLibrary, AllGranted } from '../src/skills/library';
import { SkillEngine } from '../src/skills/engine';
import { seedStockSkills } from '../src/skills/exemplars/index';
import { GodBody } from '../src/god/body';
import type { Verdict } from '../src/types/index';

function harness(opts: { avatar?: FakeBot | undefined; embodied?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eden-body-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  seedStockSkills(library); // includes the divine stock (appear-near, vanish, gesture, …)
  const avatar = 'avatar' in opts ? opts.avatar : new FakeBot({ username: 'Dieu' });
  const engine = new SkillEngine({
    library, journal, grants: new AllGranted(),
    resolveBot: (name) => (name === 'Dieu' ? avatar : undefined),
    runDefaultTimeoutMs: 120_000, stallSeconds: 20, maxCallDepth: 8, autoQuarantineAfter: 5,
  });
  const body = new GodBody({ engine, journal, avatarName: 'Dieu', embodiedVerdicts: opts.embodied ?? true });
  return { body, journal, avatar };
}

const verdict: Verdict = { ticketId: 't1', success: true, critique: 'bien', libraryAction: 'admit', praise: 'beau travail' };

test('M3-5: deliverVerdict runs a divine skill and journals god.appearance (theatrics)', async () => {
  const h = harness({ embodied: true });
  const ok = await h.body.deliverVerdict({ villager: 'Firmin', verdict });
  assert.equal(ok, true);
  // The underlying divine skill ran (skill.run by god:body) AND a god.appearance was journaled.
  const runs = h.journal.query({ kinds: ['skill.run'] });
  assert.ok(runs.length >= 1, 'a divine skill executed through the engine');
  assert.equal(runs[0]!.actor, 'god:body');
  const app = h.journal.query({ kinds: ['god.appearance'] });
  assert.equal(app.length, 1);
  assert.equal((app[0]!.payload as { villager: string; ok: boolean }).villager, 'Firmin');
  assert.equal((app[0]!.payload as { ok: boolean }).ok, true);
});

test('M3-5 (gated): embodiedVerdicts:false → deliverVerdict is a no-op, no theatrics', async () => {
  const h = harness({ embodied: false });
  const ok = await h.body.deliverVerdict({ villager: 'Firmin', verdict });
  assert.equal(ok, false, 'verdict delivery via the inbox already happened; theatrics are skipped');
  assert.equal(h.journal.query({ kinds: ['god.appearance'] }).length, 0);
  assert.equal(h.journal.query({ kinds: ['skill.run'] }).length, 0);
});

test('M3-5 (theatrics-never-a-dependency): avatar disconnected → deliverVerdict fails softly, never throws', async () => {
  const h = harness({ avatar: undefined, embodied: true }); // no avatar bot
  let threw = false;
  let ok = true;
  try {
    ok = await h.body.deliverVerdict({ villager: 'Firmin', verdict });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'a down avatar must not throw into the loop');
  assert.equal(ok, false, 'the divine run failed — but the caller (the loop) carries on');
  // A god.appearance with ok:false is journaled so the miss is observable.
  const app = h.journal.query({ kinds: ['god.appearance'] });
  assert.equal(app.length, 1);
  assert.equal((app[0]!.payload as { ok: boolean }).ok, false);
});

test('M3-5: appearNear / gesture / vanish are best-effort booleans (avatar up)', async () => {
  const h = harness({ embodied: true });
  assert.equal(await h.body.appearNear('Firmin'), true);
  assert.equal(await h.body.gesture('nod'), true);
  assert.equal(await h.body.vanish(), true);
  // appear-near drove a /tp through the avatar's chat.
  assert.ok(h.avatar!.sentChat.some((m) => m.startsWith('/tp')));
});

// B3.5 — GodBody.runAction (the orchestrator's DivineActor): stage-setting divine skills only.
test('B3.5: runAction runs a stage-setting divine skill and refuses anything else', async () => {
  const h = harness();
  assert.equal(await h.body.runAction('gesture', { type: 'nod' }), true); // FakeBot has no swingArm; nod degrades without bot.look
  assert.equal(await h.body.runAction('smite', { target: 'Firmin' }), false, 'smite acts ON a villager — not stage-setting');
  assert.equal(await h.body.runAction('vanish', {}), false);
  const ran = h.journal.query({ kinds: ['skill.run'] }).map((e) => (e.payload as { skill: string }).skill);
  assert.deepEqual(ran, ['gesture'], 'a refused action never reaches the engine');
});

test('B3.5: gesture nod and sneak are real moves (they were silent no-ops)', async () => {
  const avatar = new FakeBot({ username: 'Dieu' });
  const moves: string[] = [];
  Object.assign(avatar, {
    look: async (yaw: number, pitch: number) => { moves.push(`look ${pitch}`); void yaw; },
    setControlState: (c: string, on: boolean) => { moves.push(`${c} ${on}`); },
  });
  (avatar.entity as unknown as { yaw: number; pitch: number }).yaw = 1;
  (avatar.entity as unknown as { yaw: number; pitch: number }).pitch = 0;
  const h = harness({ avatar });
  assert.equal(await h.body.gesture('nod'), true);
  assert.equal(await h.body.gesture('sneak'), true);
  assert.equal(await h.body.gesture('cartwheel'), false, 'an unknown gesture is reported, not a silent ok');
  assert.deepEqual(moves, ['look -0.6', 'look 0', 'sneak true', 'sneak false']);
});
