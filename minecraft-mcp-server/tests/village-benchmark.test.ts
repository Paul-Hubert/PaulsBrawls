import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Bot } from 'mineflayer';
import { BenchmarkTracker } from '../src/village/benchmark.js';
import { Persistence } from '../src/village/persistence.js';
import { SkillLibrary } from '../src/village/skill-library.js';
import { auditSkill, initSkillAudit, resetSkillAudit } from '../src/village/skill-audit.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'village-bench-'));
}

/** Minimal stand-in for the parts of a mineflayer Bot the tracker touches. */
function fakeBot(items: Array<{ name: string; count: number }>): Bot {
  return {
    version: '1.21.1',
    username: 'TestBot',
    inventory: { items: () => items },
  } as unknown as Bot;
}

// -- benchmark tracker --------------------------------------------------------

test('first tick is a baseline — existing food is not credited', (t) => {
  const tracker = new BenchmarkTracker();
  tracker.tick('Jean', fakeBot([{ name: 'bread', count: 10 }]));
  t.is(tracker.metrics().village.foodAcquired, 0);
});

test('positive food deltas are credited, non-food and negative deltas are not', (t) => {
  const tracker = new BenchmarkTracker();
  tracker.tick('Jean', fakeBot([{ name: 'bread', count: 2 }, { name: 'oak_log', count: 5 }]));
  tracker.tick('Jean', fakeBot([{ name: 'bread', count: 6 }, { name: 'oak_log', count: 60 }, { name: 'carrot', count: 3 }]));
  const m = tracker.metrics();
  t.is(m.village.foodAcquired, 7); // +4 bread, +3 carrot, oak_log ignored
  t.deepEqual(m.bots.Jean.perItem, { bread: 4, carrot: 3 });

  // Eating / depositing shows as a negative delta — monotonic counter unmoved.
  tracker.tick('Jean', fakeBot([{ name: 'bread', count: 1 }]));
  t.is(tracker.metrics().village.foodAcquired, 7);
});

test('mcData "foods" with no nutritional honor (rotten_flesh & co) are excluded', (t) => {
  const tracker = new BenchmarkTracker();
  tracker.tick('Jean', fakeBot([]));
  tracker.tick('Jean', fakeBot([{ name: 'rotten_flesh', count: 8 }, { name: 'spider_eye', count: 2 }]));
  t.is(tracker.metrics().village.foodAcquired, 0);
});

test('chest withdrawals are absorbed instead of counted as production', (t) => {
  const tracker = new BenchmarkTracker();
  const bot = fakeBot([]);
  tracker.tick('Jean', bot);
  tracker.onWithdraw('Jean', 'bread', 5, bot);
  tracker.tick('Jean', fakeBot([{ name: 'bread', count: 5 }]));
  const m = tracker.metrics();
  t.is(m.village.foodAcquired, 0, 'withdrawn bread is not production');
  t.is(m.village.foodWithdrawn, 5);

  // Genuinely new bread above the withdrawn amount IS production.
  tracker.tick('Jean', fakeBot([{ name: 'bread', count: 8 }]));
  t.is(tracker.metrics().village.foodAcquired, 3);
});

test('deposits count toward the chest gauge, withdrawals drain it', (t) => {
  const tracker = new BenchmarkTracker();
  const bot = fakeBot([]);
  tracker.onDeposit('Jean', 'bread', 10, bot);
  tracker.onDeposit('Jean', 'oak_log', 20, bot); // non-food — ignored
  tracker.onWithdraw('Pierre', 'bread', 4, bot);
  const m = tracker.metrics();
  t.is(m.village.foodDeposited, 10);
  t.is(m.village.foodWithdrawn, 4);
  t.is(m.village.chestFoodEstimate, 6);
});

test('death drops re-collected after respawn are not double-counted', (t) => {
  const tracker = new BenchmarkTracker();
  tracker.tick('Jean', fakeBot([]));
  tracker.tick('Jean', fakeBot([{ name: 'bread', count: 6 }]));
  t.is(tracker.metrics().village.foodAcquired, 6);

  tracker.onDeath('Jean');
  t.is(tracker.metrics().bots.Jean.deaths, 1);

  // Respawn empty (baseline), then re-collect the dropped bread.
  tracker.tick('Jean', fakeBot([]));
  tracker.tick('Jean', fakeBot([{ name: 'bread', count: 6 }]));
  t.is(tracker.metrics().village.foodAcquired, 6, 're-collected drops absorbed');

  // Anything beyond the dropped amount is genuinely new.
  tracker.tick('Jean', fakeBot([{ name: 'bread', count: 9 }]));
  t.is(tracker.metrics().village.foodAcquired, 9);
});

test('counters persist through Persistence and survive a tracker restart', (t) => {
  const dir = tempDir();
  const persistence = new Persistence(dir);
  const tracker = new BenchmarkTracker();
  const samplePath = path.join(dir, 'benchmark.jsonl');
  tracker.configure(persistence, samplePath);

  tracker.tick('Jean', fakeBot([]));
  tracker.tick('Jean', fakeBot([{ name: 'carrot', count: 12 }]));
  tracker.stop();
  persistence.flushNow();

  t.is(persistence.botState('Jean').stats.foodAcquired, 12);
  t.true(fs.existsSync(samplePath), 'stop() writes a final sample');
  const lastSample = JSON.parse(fs.readFileSync(samplePath, 'utf8').trim().split('\n').pop()!) as {
    village: { foodAcquired: number };
  };
  t.is(lastSample.village.foodAcquired, 12);

  // A fresh tracker (process restart) resumes from the persisted counters.
  const tracker2 = new BenchmarkTracker();
  tracker2.configure(new Persistence(dir), path.join(dir, 'benchmark2.jsonl'));
  tracker2.tick('Jean', fakeBot([{ name: 'carrot', count: 12 }])); // baseline, no credit
  tracker2.tick('Jean', fakeBot([{ name: 'carrot', count: 15 }]));
  t.is(tracker2.metrics().village.foodAcquired, 15);
  tracker2.stop();
});

// -- skill audit --------------------------------------------------------------

// Serial: the audit sink is module-global state shared by both tests below.
test.serial('skill lifecycle events land in the audit JSONL with the right types', (t) => {
  const dir = tempDir();
  const auditPath = initSkillAudit(path.join(dir, 'skills.jsonl'));
  try {
    const persistence = new Persistence(dir);
    const skills = new SkillLibrary('Pierre', persistence);

    skills.upsert({ name: 'chop', kind: 'routine', description: 'chop wood', code: 'await sleep(1);' });
    skills.upsert({ name: 'chop', kind: 'routine', description: 'chop wood v2', code: 'await sleep(2);' });
    skills.recordError('chop', 'boom 1');
    skills.recordError('chop', 'boom 2');
    skills.recordError('chop', 'boom 3'); // third strike — disables
    skills.upsert({ name: 'chop', kind: 'routine', description: 'fixed', code: 'await sleep(3);' });
    skills.upsert({ name: 'guard', kind: 'reflex', description: 'stock seed', code: 'bot;', stock: true });
    skills.remove('guard');
    auditSkill({ bot: 'Pierre', event: 'rejected-validation', name: 'bad', kind: 'reflex', error: 'nope', code: 'zzz' });

    const events = fs.readFileSync(auditPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { bot: string; event: string; name: string; code?: string; version?: number });
    t.deepEqual(events.map((e) => e.event), [
      'created', 'updated', 'strike', 'strike', 'disabled', 're-enabled', 'seeded-stock', 'removed', 'rejected-validation',
    ]);
    t.is(events[0].code, 'await sleep(1);', 'created events carry the full code');
    t.is(events[5].version, 3, 're-enable bumps the version');
    t.true(events.every((e) => e.bot === 'Pierre'));
  } finally {
    resetSkillAudit();
  }
});

test.serial('audit is a no-op when uninitialized', (t) => {
  resetSkillAudit();
  t.notThrows(() => auditSkill({ bot: 'X', event: 'created', name: 'y' }));
});
