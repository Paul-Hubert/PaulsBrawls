import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BotMemory } from '../src/village/memory.js';
import { Persistence } from '../src/village/persistence.js';
import { normalizeFailureReason, VillageScheduler } from '../src/village/scheduler.js';
import { ThinkRequest } from '../src/village/types.js';

/**
 * June 2026 anti-loop guards:
 *  - identical error wake-ups are memoized (suppressed with backoff, escalated
 *    to a 'plan' revision once they keep recurring) so a blocked precondition
 *    can't burn one deliberation per failure forever;
 *  - an observed success retires stored "X is impossible" beliefs so one bogus
 *    tool error can't become permanent false memory.
 */

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'village-memo-'));
}

test('normalizeFailureReason strips volatile details but keeps the blocker identity', (t) => {
  t.is(
    normalizeFailureReason("my routine 'farm-setup' failed: goTo (-34,76,24) timed out after 45000ms"),
    normalizeFailureReason("my routine 'farm-setup' failed: goTo (-28,76,30) timed out after 45018ms"),
    'coords and durations do not make a failure "different"'
  );
  t.not(
    normalizeFailureReason("my routine 'farm-setup' failed: no hoe"),
    normalizeFailureReason("my routine 'wood-loop' failed: no hoe"),
    'different routines are different failures'
  );
});

test('identical error wake-ups suppress with backoff, then escalate to plan', async (t) => {
  let now = 0;
  const seen: ThinkRequest[] = [];
  const scheduler = new VillageScheduler({
    concurrency: 1,
    botCooldownMs: 0,
    now: () => now,
    runner: async (req) => { seen.push(req); },
  });

  scheduler.request('alice', 'error', "my routine 'farm-setup' failed: goTo (1,2,3) timed out after 45000ms");
  await delay(20);
  t.is(seen.length, 1, 'first failure deliberates normally');
  t.is(seen[0].kind, 'error');

  now += 1_000; // still inside the 60s backoff window
  scheduler.request('alice', 'error', "my routine 'farm-setup' failed: goTo (4,5,6) timed out after 45002ms");
  await delay(20);
  t.is(seen.length, 1, 'identical failure inside the window is suppressed entirely');
  t.is(scheduler.stats().suppressedFailures, 1);

  now += 120_000; // past the backoff — third occurrence of the same blocker
  scheduler.request('alice', 'error', "my routine 'farm-setup' failed: goTo (7,8,9) timed out after 45001ms");
  await delay(20);
  t.is(seen.length, 2, 'post-backoff occurrence runs');
  t.is(seen[1].kind, 'plan', 'third identical failure escalates from diagnose to replan');
  t.regex(seen[1].reasons[0], /Do NOT retry the same action/);

  // Release valve: demonstrated progress clears the memo.
  scheduler.clearFailures('alice');
  now += 1_000;
  scheduler.request('alice', 'error', "my routine 'farm-setup' failed: goTo (1,1,1) timed out after 45000ms");
  await delay(20);
  t.is(seen.length, 3, 'cleared memo lets the failure deliberate again');
  t.is(seen[2].kind, 'error', 'and it starts back at a plain error, not an escalation');
});

test('a DIFFERENT failure is not suppressed by an unrelated memo entry', async (t) => {
  let now = 0;
  const seen: ThinkRequest[] = [];
  const scheduler = new VillageScheduler({
    concurrency: 2,
    botCooldownMs: 0,
    now: () => now,
    runner: async (req) => { seen.push(req); },
  });

  scheduler.request('alice', 'error', 'craft wooden_hoe failed: missing ingredients');
  await delay(20);
  now += 1_000;
  scheduler.request('alice', 'error', 'deposit failed: no chest within 16 blocks of me');
  await delay(20);
  t.is(seen.length, 2, 'distinct blockers each get their own deliberation');
});

test('refuteBlockedBeliefs demotes impossible-beliefs and writes a refutation', (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Froment', persistence);
  memory.append('thought', 'une crafting table ne peut pas être fabriquée sans crafting table à proximité', ['crafting_table'], 6);
  memory.append('system', "job 'farm-setup' failed: cannot craft crafting_table", ['farm-setup'], 4);
  memory.append('thought', "le blé pousse mieux près de l'eau", ['ble'], 5);

  const demoted = memory.refuteBlockedBeliefs(
    'craft crafting_table',
    'vérifié: j’ai fabriqué 1x crafting_table — mes anciennes conclusions étaient fausses'
  );
  t.true(demoted >= 1, 'at least the false belief is demoted');

  const all = memory.recent(10);
  const falseBelief = all.find((m) => m.text.includes('ne peut pas'));
  t.is(falseBelief?.importance, 1, 'refuted belief drops to importance 1');
  const unrelated = all.find((m) => m.text.includes('pousse'));
  t.is(unrelated?.importance, 5, 'unrelated memories are untouched');
  t.true(all.some((m) => m.text.startsWith('vérifié')), 'a high-importance refutation note is written');
});

test('refuteBlockedBeliefs is a no-op when nothing matches', (t) => {
  const persistence = new Persistence(tempDir());
  const memory = new BotMemory('Glane', persistence);
  memory.append('thought', 'le village est calme ce matin', undefined, 4);
  t.is(memory.refuteBlockedBeliefs('craft iron_pickaxe', 'vérifié: fabriqué'), 0);
  t.is(memory.recent(10).length, 1, 'no refutation note without a demotion');
});
