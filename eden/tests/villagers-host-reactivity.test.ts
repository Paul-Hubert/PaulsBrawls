// M5 host wiring — the piece the milestone adds: the reactivity system, BUILT + unit-tested in M5-1/2/3,
// is now ASSEMBLED per villager (signal adapter → EventRouter → SubscriptionRouter) and seeded at boot,
// so a seeded reflex actually fires in the running host. These FakeBot tests pin that assembly the same
// way main.ts does it (VillagerReactivity + bots/signals + seedRoleDefaults), with NO Minecraft:
//   • the signal adapter derives a `hurt` from the bot's health delta + nearest-hostile attacker;
//   • a seeded everyone `hurt → flee-to-safety` reflex fires as a ZERO-TOKEN skill run (no LLM);
//   • a guard's `hurt → defend-self` reflex OVERRIDES the everyone flee (D-15), also zero-token;
//   • the `health-low` deliberate reflex escalates exactly ONE wake-up;
//   • role defaults seed each villager exactly ONCE (idempotent first boot);
//   • the engine reports a skill as "running" while its tree executes (backs notWhileRunning + vitals).

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
import { attachReactivitySignals } from '../src/bots/signals';
import { EventRouter } from '../src/villagers/events';
import { SubscriptionStore } from '../src/villagers/subscriptions';
import { loadRoles, seedRoleDefaults, DEFAULT_ROLES_PATH } from '../src/villagers/role-defaults';
import { VillagerReactivity } from '../src/villagers/reactivity';
import type { WakeupRequest } from '../src/villagers/events';
import type { Envelope, RunnerRef } from '../src/types/index';

const MORTAL: RunnerRef = { name: 'Firmin', role: 'farmer', tier: 'mortal' };

/** Poll until `pred()` (a fired reflex's skill.run is async + fire-and-forget at the emit site). */
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: condition not met in time');
}

// ── 1. The signal adapter (bots/signals.ts) — native mineflayer events → the router's synthetic shape ──

test('M5 host (adapter): a health DECREASE synthesizes one entityHurt with the delta as damage', () => {
  const bot = new FakeBot({ username: 'Firmin' }); // spawns at health 20
  const { signals, detach } = attachReactivitySignals(bot);
  const hurts: Array<{ damage: number; byEntity?: string }> = [];
  signals.on('entityHurt', (_self, info) => hurts.push(info as { damage: number; byEntity?: string }));

  bot.setVitals({ health: 14 });
  bot.emit('health'); // 20 → 14: a hit
  bot.setVitals({ health: 14 });
  bot.emit('health'); // no change: NOT a hit (food-only tick shape)
  bot.setVitals({ health: 20 });
  bot.emit('health'); // recovery: NOT a hit

  assert.equal(hurts.length, 1, 'only the decrease synthesizes a hurt');
  assert.equal(hurts[0]!.damage, 6, 'damage = lastHealth - health');
  detach();
  bot.setVitals({ health: 2 });
  bot.emit('health');
  assert.equal(hurts.length, 1, 'detach removes the native listener (no leak)');
});

test('M5 host (adapter): byEntity is the nearest hostile in bot.entities', () => {
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  bot.setEntities({
    1: { name: 'cow', position: { x: 1, y: 64, z: 0 } }, // friendly + nearer — must NOT win
    2: { name: 'zombie', position: { x: 3, y: 64, z: 0 } }, // the nearest HOSTILE
    3: { name: 'skeleton', position: { x: 9, y: 64, z: 0 } }, // hostile but farther
  });
  const { signals } = attachReactivitySignals(bot);
  let seen: { byEntity?: string } | undefined;
  signals.on('entityHurt', (_self, info) => { seen = info as { byEntity?: string }; });

  bot.setVitals({ health: 17 });
  bot.emit('health');
  assert.equal(seen?.byEntity, 'zombie', 'nearest hostile by name (cow ignored, skeleton farther)');
});

test('M5 host (adapter+router): a health drop routes through the bus to a normalized hurt Envelope', () => {
  const bot = new FakeBot({ username: 'Firmin' });
  const { signals } = attachReactivitySignals(bot);
  const seen: Envelope[] = [];
  const router = new EventRouter({ villager: 'Firmin', bot, signals, sink: (e) => seen.push(e) });
  router.attach();

  bot.setVitals({ health: 11 });
  bot.emit('health');

  const hurt = seen.find((e) => e.event.type === 'hurt');
  assert.ok(hurt, 'the native health drop became a normalized hurt via the adapter bus');
  assert.equal((hurt!.event as { damage: number }).damage, 9);
  router.detach();
});

// ── 2. The full per-villager assembly (VillagerReactivity), wired like main.ts ──

interface HostHarness {
  dir: string;
  journal: MemoryJournal;
  engine: SkillEngine;
  store: SubscriptionStore;
  reactivity: VillagerReactivity;
  wakeups: WakeupRequest[];
  bots: Map<string, FakeBot>;
}

/** Assemble the reactivity host exactly as main.ts does: shared store, seeded defaults, one router/bot. */
function hostHarness(roster: Array<{ name: string; role: string }>): HostHarness {
  const dir = mkdtempSync(join(tmpdir(), 'eden-host-react-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  seedStockSkills(library); // flee-to-safety / defend-self / go-to / kill-mob all enter the library
  const bots = new Map<string, FakeBot>();
  const engine = new SkillEngine({
    library, journal, grants: new AllGranted(),
    resolveBot: (name) => bots.get(name),
    runDefaultTimeoutMs: 120_000, stallSeconds: 20, maxCallDepth: 8, autoQuarantineAfter: 5,
  });
  const store = new SubscriptionStore({ dataDir: dir, journal });
  const roles = loadRoles(DEFAULT_ROLES_PATH); // the SHIPPED roles.json (the real policy under test)
  for (const v of roster) seedRoleDefaults(store, v.name, v.role, roles);
  const wakeups: WakeupRequest[] = [];
  const reactivity = new VillagerReactivity({
    villagers: roster, store, engine, journal,
    wakeup: async (req) => { wakeups.push(req); },
    vitalsFor: (name) => ({
      selfPos: [0, 64, 0], timeOfDay: 6000,
      health: bots.get(name)?.health ?? 20, food: 20,
      runningSkills: engine.runningSkills(name),
    }),
  });
  return { dir, journal, engine, store, reactivity, wakeups, bots };
}

test('M5 host (seeding): boot seeds each villager exactly once (idempotent first boot)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eden-host-seed-'));
  const journal = new MemoryJournal();
  const store = new SubscriptionStore({ dataDir: dir, journal });
  const roles = loadRoles(DEFAULT_ROLES_PATH);
  const first = seedRoleDefaults(store, 'Firmin', 'farmer', roles);
  assert.ok(first > 0, 'first boot seeds the role defaults');
  const created1 = journal.query({ kinds: ['subscription.created'] }).length;
  // A second boot over the SAME store seeds nothing — restarts never pile up duplicate reflexes.
  const second = seedRoleDefaults(store, 'Firmin', 'farmer', roles);
  assert.equal(second, 0, 'first-boot only — a re-boot adds no subscriptions');
  assert.equal(journal.query({ kinds: ['subscription.created'] }).length, created1, 'no new subscription.created');
});

test('M5 host (zero-token reflex): a hurt fires the everyone flee reflex as a skill run — NO LLM', async () => {
  const h = hostHarness([{ name: 'Firmin', role: 'farmer' }]);
  const bot = new FakeBot({ username: 'Firmin', position: { x: 0, y: 64, z: 0 } });
  h.bots.set('Firmin', bot);
  h.reactivity.attach('Firmin', bot);

  bot.setVitals({ health: 12 }); // a hit
  bot.emit('health');

  await waitFor(() => h.journal.query({ kinds: ['skill.run'] }).length >= 1);
  const runs = h.journal.query({ kinds: ['skill.run'] });
  assert.equal(runs.length, 1, 'exactly one zero-token reflex run');
  assert.equal((runs[0]!.payload as { skill: string }).skill, 'flee-to-safety');
  assert.equal((runs[0]!.payload as { outcome: { ok: boolean } }).outcome.ok, true, 'flee ran cleanly on the fake bot');
  // The reflex story: subscription.fired{skill}, and NOT a single token spent (no LLM, no wake-up pack).
  const fired = h.journal.query({ kinds: ['subscription.fired'] });
  assert.ok(fired.some((e) => (e.payload as { outcome: string; target: string }).outcome === 'skill' && (e.payload as { target: string }).target === 'flee-to-safety'));
  assert.equal(h.journal.query({ kinds: ['llm.call'] }).length, 0, 'zero-token: no LLM call');
  assert.equal(h.journal.query({ kinds: ['brain.wakeup'] }).length, 0, 'no context pack built for a skill reflex');
  assert.equal(h.wakeups.length, 0, 'a skill reflex escalates no deliberation');
});

test('M5 host (D-15 guard override): a guard FIGHTS on hurt (defend-self), not flee — zero-token, BEFORE any wake-up', async () => {
  const h = hostHarness([{ name: 'Garde', role: 'guard' }]);
  const bot = new FakeBot({ username: 'Garde', position: { x: 0, y: 64, z: 0 } });
  h.bots.set('Garde', bot);
  h.reactivity.attach('Garde', bot);

  // Sanity: the guard's hurt reflex resolved to defend-self, NOT the everyone flee-to-safety (D-15).
  const hurtSubs = h.store.list('Garde').filter((s) => s.on === 'hurt');
  assert.equal(hurtSubs.length, 1, 'exactly one hurt reflex (role override, not stacked on everyone)');
  assert.equal((hurtSubs[0]!.handler as { name?: string }).name, 'defend-self');

  bot.setVitals({ health: 16 }); // a hit (no entities seeded → defend-self finds no target, returns cleanly)
  bot.emit('health');

  await waitFor(() => h.journal.query({ kinds: ['skill.run'] }).length >= 1);
  const runs = h.journal.query({ kinds: ['skill.run'] });
  assert.equal((runs[0]!.payload as { skill: string }).skill, 'defend-self', 'guard fights, not flees');
  const fired = h.journal.query({ kinds: ['subscription.fired'] });
  assert.ok(fired.some((e) => (e.payload as { target: string }).target === 'defend-self' && (e.payload as { outcome: string }).outcome === 'skill'));
  assert.equal(h.journal.query({ kinds: ['llm.call'] }).length, 0, 'the defensive action cost ZERO tokens');
  assert.equal(h.journal.query({ kinds: ['brain.wakeup'] }).length, 0, 'the reflex fired BEFORE (without) any brain wake-up');
});

test('M5 host (deliberate reflex): health crossing low escalates exactly ONE coalesced wake-up', async () => {
  const h = hostHarness([{ name: 'Firmin', role: 'farmer' }]);
  const bot = new FakeBot({ username: 'Firmin' });
  h.bots.set('Firmin', bot);
  h.reactivity.attach('Firmin', bot);

  bot.setVitals({ health: 4 }); // crosses below the health-low threshold (6) → the deliberate reflex
  bot.emit('health');

  await waitFor(() => h.wakeups.length >= 1);
  assert.equal(h.wakeups.length, 1, 'one incident → one wake-up (R36)');
  assert.equal(h.wakeups[0]!.lane, 'combat', 'health-low is interrupt priority → the combat lane');
  assert.match(h.wakeups[0]!.triggers.join(' '), /health-low/);
});

test('M5 host (reconnect-safe): re-attach drops the stale router (no double-fire after a reconnect)', async () => {
  const h = hostHarness([{ name: 'Firmin', role: 'farmer' }]);
  const bot1 = new FakeBot({ username: 'Firmin' });
  h.bots.set('Firmin', bot1);
  h.reactivity.attach('Firmin', bot1);
  // A reconnect: the pool re-spawns and fires onBotSpawn again with a FRESH bot instance.
  const bot2 = new FakeBot({ username: 'Firmin' });
  h.bots.set('Firmin', bot2);
  h.reactivity.attach('Firmin', bot2);

  // The stale bot must no longer route — only the live one does.
  bot1.setVitals({ health: 10 });
  bot1.emit('health');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.journal.query({ kinds: ['skill.run'] }).length, 0, 'the detached (stale) bot routes nothing');

  bot2.setVitals({ health: 10 });
  bot2.emit('health');
  await waitFor(() => h.journal.query({ kinds: ['skill.run'] }).length >= 1);
  assert.equal(h.journal.query({ kinds: ['skill.run'] }).length, 1, 'the live bot routes exactly once');

  h.reactivity.detach();
});

// ── 3. The engine's running-skill tracking (backs notWhileRunning + vitals) ──

test('M5 host (runningSkills): the engine reports a skill running mid-tree, empty when done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eden-running-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  const bot = new FakeBot({ username: 'Firmin' });
  const engine = new SkillEngine({
    library, journal, grants: new AllGranted(), resolveBot: () => bot,
    runDefaultTimeoutMs: 120_000, stallSeconds: 60, maxCallDepth: 8, autoQuarantineAfter: 5,
  });
  // A skill that stays in-flight ~250 ms (a real setTimeout — well under stallSeconds), so the mid-tree
  // window is wide enough to observe deterministically. This is the live source notWhileRunning reads.
  library.seedStock({
    name: 'park', summary: 'attend', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} },
    code: 'async function park(bot, args, ctx) { await new Promise((r) => setTimeout(r, 250)); return {}; }', author: { kind: 'stock' },
  }, 'active');

  assert.deepEqual(engine.runningSkills('Firmin'), [], 'nothing running before the call');
  const runP = engine.run('park', {}, MORTAL);
  await waitFor(() => engine.runningSkills('Firmin').includes('park'));
  assert.deepEqual(engine.runningSkills('Firmin'), ['park'], 'park is reported running mid-tree');
  await runP;
  assert.deepEqual(engine.runningSkills('Firmin'), [], 'cleared when the tree finishes');
});
