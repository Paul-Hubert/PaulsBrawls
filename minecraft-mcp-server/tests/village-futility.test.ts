import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Bot } from 'mineflayer';
import type { VillageContext } from '../src/village/context.js';
import { BotMemory } from '../src/village/memory.js';
import { VillagerEventBus } from '../src/village/event-bus.js';
import { Persistence } from '../src/village/persistence.js';
import { RoutineRunner } from '../src/village/routines.js';
import { SkillLibrary } from '../src/village/skill-library.js';
import type { Villager } from '../src/village/villager.js';
import type { VillageEvent } from '../src/village/types.js';

/**
 * Futility pipeline (June 2026): a routine that swallows every action error in
 * try/catch and completes "successfully" must NOT look productive. After
 * FUTILE_ESCALATE_AFTER (2) consecutive zero-progress completions the job-done
 * event carries `futile: true`; any productive action resets the counter; a
 * cancelled run never counts.
 *
 * Deliberately fixture-light: we drive RoutineRunner with a stub Villager whose
 * `give` action is wired to succeed or fail on demand — `give(...)` is a
 * PROGRESS_PREFIX label that never touches mineflayer internals (it goes through
 * ctx.trades.give), so we exercise the real act()/onAction/tally path without a
 * world or minecraft-data.
 */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'village-futility-'));
}

interface FutilityWorld {
  runner: RoutineRunner;
  villager: Villager;
  events: VillageEvent[];
  errorRequests: Array<{ kind: string; reason: string }>;
  clearFailuresCalls: number;
  /** Flip this to make every give() succeed (returns the count) or fail (throws). */
  giveOk: { value: boolean };
}

function makeWorld(): FutilityWorld {
  const persistence = new Persistence(tempDir());
  const bus = new VillagerEventBus('Bûcheron');
  const memory = new BotMemory('Bûcheron', persistence);
  const skills = new SkillLibrary('Bûcheron', persistence);
  const events: VillageEvent[] = [];
  bus.subscribe('::test', 'job-done', (e) => { events.push(e); });

  const giveOk = { value: false };
  const errorRequests: Array<{ kind: string; reason: string }> = [];
  let clearFailuresCalls = 0;

  // A non-null bot so requireBot() succeeds inside act(); inventorySummary()
  // (success-check verdict path) reads .inventory.items().
  const bot = { inventory: { items: () => [] } } as unknown as Bot;

  const villager = {
    name: 'Bûcheron',
    roster: { name: 'Bûcheron', role: 'lumberjack' },
    memory,
    skills,
    bus,
    bot: () => bot,
    requireBot: () => bot,
    runExclusive: <T>(fn: () => Promise<T>) => fn(),
    chestAnchor: () => null,
    homeAnchor: () => null,
    villagersInEarshot: () => [],
    mirrorChat: () => { /* noop */ },
  } as unknown as Villager;

  const ctx = {
    villagers: new Map(),
    villagerNames: new Set<string>(),
    scheduler: {
      request: (_bot: string, kind: string, reason: string) => { errorRequests.push({ kind, reason }); },
      clearFailures: () => { clearFailuresCalls += 1; },
    },
    trades: {
      give: async (): Promise<number> => {
        if (giveOk.value) return 1;
        throw new Error('aucun villageois nommé X — rien livré');
      },
    },
  } as unknown as VillageContext;

  const runner = new RoutineRunner(villager, ctx);
  return {
    runner,
    villager,
    events,
    errorRequests,
    get clearFailuresCalls() { return clearFailuresCalls; },
    giveOk,
  } as FutilityWorld;
}

/** Wait for the routine to fully settle (it runs async off start()). */
async function settle(runner: RoutineRunner): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!runner.status()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('routine never finished');
}

// A routine whose ONLY action is a give() it swallows: success → progress,
// failure → a futile pass. No sleep, so it completes in one tick.
const TRY_GIVE = "try { await bot.give('X', 'oak_log', 1); } catch (e) { /* swallowed */ }";

test('two consecutive zero-progress completions emit job-done futile=true', async (t) => {
  const w = makeWorld();
  w.giveOk.value = false; // every give fails
  w.villager.skills.upsert({ name: 'futile-loop', kind: 'routine', description: 'always-fails', code: TRY_GIVE });

  // Pass 1: failures>0, progress==0 → counter 1 (< escalate threshold), not futile yet.
  t.is(w.runner.start('futile-loop'), null);
  await settle(w.runner);
  t.is(w.events.length, 1);
  t.falsy(w.events[0].futile, 'first futile pass does not yet escalate');

  // Pass 2: counter 2 ≥ FUTILE_ESCALATE_AFTER → futile.
  t.is(w.runner.start('futile-loop'), null);
  await settle(w.runner);
  t.is(w.events.length, 2);
  t.true(w.events[1].futile === true, 'second consecutive futile pass escalates');
  t.regex(w.events[1].outcome ?? '', /PASSAGE À VIDE/);
});

test('a productive completion resets the futile counter and clears the failure memo', async (t) => {
  const w = makeWorld();
  w.villager.skills.upsert({ name: 'maybe-loop', kind: 'routine', description: 'mixed', code: TRY_GIVE });

  // Two futile passes — second is futile.
  w.giveOk.value = false;
  t.is(w.runner.start('maybe-loop'), null);
  await settle(w.runner);
  t.is(w.runner.start('maybe-loop'), null);
  await settle(w.runner);
  t.true(w.events[1].futile === true);

  const clearsBefore = w.clearFailuresCalls;
  // A productive pass: give succeeds (returns 1 > 0 → progress).
  w.giveOk.value = true;
  t.is(w.runner.start('maybe-loop'), null);
  await settle(w.runner);
  t.falsy(w.events[2].futile, 'productive pass is not futile');
  t.true(w.clearFailuresCalls > clearsBefore, 'progress releases the scheduler failure memo');

  // Counter reset: the NEXT futile pass is back to count 1, NOT escalated.
  w.giveOk.value = false;
  t.is(w.runner.start('maybe-loop'), null);
  await settle(w.runner);
  t.falsy(w.events[3].futile, 'counter reset — single futile pass after progress does not escalate');
});

test('a cancelled run never counts as futile', async (t) => {
  const w = makeWorld();
  w.giveOk.value = false;
  // A routine that loops with a sleep so we can cancel it mid-flight before it
  // completes. The give fails each iteration (would be futile if it completed).
  w.villager.skills.upsert({
    name: 'long-loop',
    kind: 'routine',
    description: 'cancellable',
    code: "for (let i = 0; i < 100; i++) { try { await bot.give('X', 'oak_log', 1); } catch (e) {} await sleep(20); }",
  });

  t.is(w.runner.start('long-loop'), null);
  // Let at least one failing give register, then stop.
  await new Promise((r) => setTimeout(r, 40));
  t.true(w.runner.stop());
  await settle(w.runner);

  t.is(w.events.length, 0, 'a cancelled routine emits no job-done at all');

  // And a fresh futile completion afterwards is count 1, not escalated — the
  // cancelled run did not poison the per-skill futile counter.
  w.villager.skills.upsert({ name: 'short', kind: 'routine', description: 'x', code: TRY_GIVE });
  t.is(w.runner.start('short'), null);
  await settle(w.runner);
  t.falsy(w.events[0]?.futile, 'first completion of a different skill is not futile');
});

test('benign productive then quiet pass: zero failures stays a plain completion', async (t) => {
  const w = makeWorld();
  // A routine with NO actions at all — a pure patrol/wait. progress==0 AND
  // failures==0 → legitimately quiet, never futile.
  w.villager.skills.upsert({ name: 'patrol', kind: 'routine', description: 'quiet', code: 'await sleep(10);' });

  t.is(w.runner.start('patrol'), null);
  await settle(w.runner);
  t.is(w.events.length, 1);
  t.falsy(w.events[0].futile, 'zero progress + zero failures is a quiet pass, not futility');
  t.is(w.events[0].outcome, undefined, 'no PASSAGE À VIDE line on a quiet pass');
});
