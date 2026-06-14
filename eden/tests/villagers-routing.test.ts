// M5-3 — routing outcomes + R36. A matched subscription routes to either:
//   • kind:'skill'      → a ZERO-TOKEN SkillEngine.run (no LLM); a FAILING handler still files a normal
//                          RunReport (the critic tripwire owns it) — never silently swallowed (04);
//   • kind:'deliberate' → ONE brain wake-up (a context pack → Brain), on the right priority lane.
// R36 (one incident → one wake-up): the router OWNS the escalation — when one event matches N deliberate
// subscriptions, it escalates EXACTLY ONE coalesced wake-up, not N. Skill handlers are zero-token and may
// all fire. A suppressed match (cooldown/disabled/notWhileRunning) journals subscription.suppressed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { SkillLibrary, AllGranted } from '../src/skills/library';
import { SkillEngine } from '../src/skills/engine';
import { SubscriptionStore } from '../src/villagers/subscriptions';
import { SubscriptionRouter, type WakeupRequest } from '../src/villagers/events';
import type { Envelope, EdenEvent, RunnerRef } from '../src/types/index';

const RUNNER: RunnerRef = { name: 'Firmin', role: 'farmer', tier: 'mortal' };
const env = (event: EdenEvent): Envelope => ({ at: 1000, villager: 'Firmin', event });

interface HarnessOpts {
  now?: () => number;
  runningSkills?: string[];
}

function harness(over: HarnessOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eden-route-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  const bot = new FakeBot({ username: 'Firmin' });
  const engine = new SkillEngine({
    library, journal, grants: new AllGranted(), resolveBot: () => bot,
    runDefaultTimeoutMs: 120_000, stallSeconds: 20, maxCallDepth: 8, autoQuarantineAfter: 5,
  });
  const store = new SubscriptionStore({ dataDir: dir, journal, ...(over.now ? { now: over.now } : {}) });
  const wakeups: WakeupRequest[] = [];
  const router = new SubscriptionRouter({
    villager: 'Firmin',
    runner: RUNNER,
    store,
    engine,
    journal,
    wakeup: async (req) => { wakeups.push(req); },
    vitals: () => ({ selfPos: [0, 64, 0], timeOfDay: 6000, health: 20, food: 20, runningSkills: over.runningSkills ?? [] }),
    ...(over.now ? { now: over.now } : {}),
  });
  return { dir, journal, library, bot, engine, store, router, wakeups };
}

test('M5-3 (skill outcome, zero-token): a matched skill handler runs the skill + journals subscription.fired{skill}', async () => {
  const { library, store, router, journal, bot } = harness();
  library.seedStock({ name: 'flee-to-safety', summary: 'fuir', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function f(bot,args,ctx){ bot.give("flag",1); return { fled: true }; }', author: { kind: 'stock' } }, 'active');
  store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'skill', name: 'flee-to-safety', args: {} }, source: 'role-default' });

  await router.route(env({ type: 'hurt', damage: 4 }));

  // The skill ran (zero LLM calls — there's no llm wired at all) and produced a RunReport.
  assert.equal(journal.query({ kinds: ['skill.run'] }).length, 1, 'one zero-token run');
  assert.equal(journal.query({ kinds: ['llm.call'] }).length, 0, 'no LLM call — reflex is free');
  assert.equal(bot.countItem('flag'), 1, 'the reflex skill executed');
  const fired = journal.query({ kinds: ['subscription.fired'] });
  assert.equal(fired.length, 1);
  assert.equal((fired[0]!.payload as { outcome: string; target: string }).outcome, 'skill');
  assert.equal((fired[0]!.payload as { target: string }).target, 'flee-to-safety');
});

test('M5-3 (skill outcome): a FAILING handler still files a RunReport — never silently swallowed (04)', async () => {
  const { library, store, router, journal } = harness();
  library.seedStock({ name: 'boom', summary: 'casse', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function f(bot,args,ctx){ throw new Error("échec réflexe"); }', author: { kind: 'stock' } }, 'active');
  store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'skill', name: 'boom', args: {} }, source: 'self' });

  await router.route(env({ type: 'hurt', damage: 2 }));

  const runs = journal.query({ kinds: ['skill.run'] });
  assert.equal(runs.length, 1, 'the failure is journaled as a RunReport (critic tripwire owns it)');
  assert.equal((runs[0]!.payload as { outcome: { ok: boolean } }).outcome.ok, false);
  // It still counts as a fire (it matched + routed); the OUTCOME of the run is the failure, not the routing.
  assert.equal(journal.query({ kinds: ['subscription.fired'] }).length, 1);
});

test('M5-3 (skill outcome): ArgTemplate $event.* args are substituted into the run', async () => {
  const { library, store, router, journal } = harness();
  // The skill records its received args by tagging an item name with them — assert via the RunReport args.
  library.seedStock({ name: 'face', summary: 'fixe', params: { type: 'object', properties: { target: { type: 'string' } } }, returns: { type: 'object', properties: {} }, code: 'async function f(bot,args,ctx){ return { saw: args.target }; }', author: { kind: 'stock' } }, 'active');
  store.add({ villager: 'Firmin', on: 'entity-spotted', handler: { kind: 'skill', name: 'face', args: { target: '$event.entity' } }, source: 'self' });

  await router.route(env({ type: 'entity-spotted', entity: 'creeper:9', distance: 3 }));

  const run = journal.query({ kinds: ['skill.run'] })[0]!;
  assert.deepEqual((run.payload as { args: object }).args, { target: 'creeper:9' });
});

test('M5-3 (deliberate outcome): a matched deliberate handler escalates ONE wake-up + journals subscription.fired{deliberate}', async () => {
  const { store, router, wakeups, journal } = harness();
  store.add({ villager: 'Firmin', on: 'player-chat', handler: { kind: 'deliberate', hint: 'un joueur te parle', priority: 'normal' }, source: 'role-default' });

  await router.route(env({ type: 'player-chat', player: 'Paul', text: 'salut' }));

  assert.equal(wakeups.length, 1, 'exactly one wake-up');
  assert.match(wakeups[0]!.triggers.join(' '), /player-chat|joueur/i);
  assert.deepEqual(wakeups[0]!.hints, ['un joueur te parle']);
  assert.equal(wakeups[0]!.lane, 'conversation', 'normal priority → the conversation lane (04 lane map)');
  const fired = journal.query({ kinds: ['subscription.fired'] });
  assert.equal(fired.length, 1);
  assert.equal((fired[0]!.payload as { outcome: string }).outcome, 'deliberate');
});

// ── R36 — one incident, one wake-up (the load-bearing test) ──────────────────────────────────────
test('M5-3 (R36): ONE event matching N deliberate subs escalates EXACTLY ONE coalesced wake-up, not N', async () => {
  const { store, router, wakeups, journal } = harness();
  // Three separate deliberate subscriptions all keyed on the same event (highest priority is interrupt).
  store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'deliberate', hint: 'réagis à la douleur', priority: 'interrupt' }, source: 'role-default' });
  store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'deliberate', hint: 'qui m’attaque?', priority: 'normal' }, source: 'self' });
  store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'deliberate', hint: 'dois-je fuir?', priority: 'normal' }, source: 'self' });

  await router.route(env({ type: 'hurt', damage: 7, byEntity: 'zombie:3' }));

  assert.equal(wakeups.length, 1, 'R36: one incident → exactly one wake-up (not three)');
  // The single wake-up carries ALL three hints (coalesced), and takes the HIGHEST priority lane present.
  assert.equal(wakeups[0]!.hints.length, 3, 'all three hints rode the one wake-up');
  assert.equal(wakeups[0]!.lane, 'combat', 'the highest-priority (interrupt) → the combat lane wins');
  // Each matched subscription is still journaled as fired (legibility), but only ONE escalation happened.
  assert.equal(journal.query({ kinds: ['subscription.fired'] }).length, 3, 'each match journals (everyone journals)');
});

test('M5-3 (R36): skill + deliberate from one event — skills all run, deliberate is the single wake-up', async () => {
  const { library, store, router, wakeups, journal } = harness();
  library.seedStock({ name: 'flee', summary: 'fuir', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function f(bot,args,ctx){ return {}; }', author: { kind: 'stock' } }, 'active');
  store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'skill', name: 'flee', args: {} }, source: 'role-default' });
  store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'deliberate', hint: 'que se passe-t-il?' }, source: 'self' });

  await router.route(env({ type: 'hurt', damage: 3 }));

  assert.equal(journal.query({ kinds: ['skill.run'] }).length, 1, 'the reflex ran');
  assert.equal(wakeups.length, 1, 'the deliberate escalated once');
});

// ── suppression (cooldown / disabled / notWhileRunning) ──────────────────────────────────────────
test('M5-3 (cooldown): a second fire inside the window is suppressed + journaled subscription.suppressed', async () => {
  let now = 0;
  const { journal, library, store, router } = harness({ now: () => now });
  library.seedStock({ name: 'flee', summary: 'fuir', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function f(bot,args,ctx){ return {}; }', author: { kind: 'stock' } }, 'active');
  store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'skill', name: 'flee', args: {} }, source: 'self', cooldownMs: 5000 });

  await router.route(env({ type: 'hurt', damage: 1 })); // fires
  await router.route(env({ type: 'hurt', damage: 1 })); // inside cooldown → suppressed
  assert.equal(journal.query({ kinds: ['skill.run'] }).length, 1, 'only the first fired');
  const supp = journal.query({ kinds: ['subscription.suppressed'] });
  assert.equal(supp.length, 1);
  assert.equal((supp[0]!.payload as { reason: string }).reason, 'cooldown');

  now += 6000;
  await router.route(env({ type: 'hurt', damage: 1 })); // past cooldown → fires again
  assert.equal(journal.query({ kinds: ['skill.run'] }).length, 2);
});

test('M5-3 (disabled): a disabled subscription does not fire (journals suppressed{disabled})', async () => {
  const { store, router, journal, library } = harness();
  library.seedStock({ name: 'flee', summary: 'fuir', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function f(bot,args,ctx){ return {}; }', author: { kind: 'stock' } }, 'active');
  const sub = store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'skill', name: 'flee', args: {} }, source: 'self' });
  store.setEnabled(sub.id, false);
  await router.route(env({ type: 'hurt', damage: 1 }));
  assert.equal(journal.query({ kinds: ['skill.run'] }).length, 0);
  assert.equal(journal.query({ kinds: ['subscription.suppressed'] }).length, 1);
});

test('M5-3 (notWhileRunning): a filter that fails on running-skill suppresses + journals the reason', async () => {
  // The router's vitals report `flee` as currently running, so a notWhileRunning:['flee'] filter fails.
  const { store, router, journal, library } = harness({ runningSkills: ['flee'] });
  library.seedStock({ name: 'flee', summary: 'fuir', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function f(bot,args,ctx){ return {}; }', author: { kind: 'stock' } }, 'active');
  store.add({ villager: 'Firmin', on: 'hurt', handler: { kind: 'skill', name: 'flee', args: {} }, source: 'self', filter: { notWhileRunning: ['flee'] } });
  await router.route(env({ type: 'hurt', damage: 1 }));
  assert.equal(journal.query({ kinds: ['skill.run'] }).length, 0, 'notWhileRunning suppressed the reflex');
  const supp = journal.query({ kinds: ['subscription.suppressed'] });
  assert.equal(supp.length, 1);
  assert.equal((supp[0]!.payload as { reason: string }).reason, 'not-while-running');
});

test('M5-3: a non-matching filter is a silent skip (NOT a suppression — the event just does not apply)', async () => {
  const { store, router, journal, library } = harness();
  library.seedStock({ name: 'flee', summary: 'fuir', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code: 'async function f(bot,args,ctx){ return {}; }', author: { kind: 'stock' } }, 'active');
  store.add({ villager: 'Firmin', on: 'entity-spotted', handler: { kind: 'skill', name: 'flee', args: {} }, source: 'self', filter: { within: 3 } });
  await router.route(env({ type: 'entity-spotted', entity: 'zombie:1', distance: 20 })); // too far → filter fails
  assert.equal(journal.query({ kinds: ['skill.run'] }).length, 0);
  assert.equal(journal.query({ kinds: ['subscription.suppressed'] }).length, 0, 'a filter MISS is not a suppression');
  assert.equal(journal.query({ kinds: ['subscription.fired'] }).length, 0);
});
