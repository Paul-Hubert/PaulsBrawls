import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dispatchTool, DeliberationState } from '../src/village/agent-tools.js';
import type { VillageContext } from '../src/village/context.js';
import {
  currentSlotOf,
  DailyRhythm,
  FALLBACK_GRACE_TICKS,
  fallbackPlanFor,
  GREET_BOT_COOLDOWN_MS,
  GREET_PAIR_COOLDOWN_MS,
  planDayFor,
  validateDayPlanSlots,
} from '../src/village/day-planner.js';
import { VillagerEventBus } from '../src/village/event-bus.js';
import { BotMemory } from '../src/village/memory.js';
import { Persistence } from '../src/village/persistence.js';
import { SkillLibrary } from '../src/village/skill-library.js';
import { NeedsSettings, VillageEvent, VillageSettings } from '../src/village/types.js';
import type { Villager } from '../src/village/villager.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'village-rhythm-'));
}

const NEEDS: NeedsSettings = {
  restDecayPerMin: 0.6,
  restRecoverPerMin: 0.3,
  socialDecayPerMin: 0.2,
  socialRecoverPerMin: 0.5,
  lowThreshold: 0.25,
};

function settingsFor(dataDir: string): VillageSettings {
  return {
    llm: { provider: 'openai', baseUrl: '', model: 't', fastModel: '', apiKey: 'k', timeoutMs: 1_000, temperature: 0, maxTokens: 64 },
    embeddings: { mode: 'off', model: '' },
    dayPlanning: true,
    needs: NEEDS,
    spontaneousChat: false, // greet-gate tests opt in explicitly
    concurrency: 1,
    heartbeatSeconds: 9_999,
    botCooldownMs: 0,
    earshotRadius: 32,
    settlementUrl: '',
    dataDir,
    maxConversationTurns: 8,
  };
}

interface Harness {
  villager: Villager;
  ctx: VillageContext;
  rhythm: DailyRhythm;
  memory: BotMemory;
  bus: VillagerEventBus;
  requests: Array<{ kind: string; reason: string }>;
  started: string[];
  stopped: number;
  walks: number;
  /** Mutable fake world state. */
  world: { timeOfDay: number; day: number; pos: { x: number; y: number; z: number }; running: string | null };
  clock: { t: number };
}

function harness(opts: { routines?: string[] } = {}): Harness {
  const dir = tempDir();
  const persistence = new Persistence(dir);
  const memory = new BotMemory('Margaux', persistence);
  const skills = new SkillLibrary('Margaux', persistence);
  for (const name of opts.routines ?? ['farm-loop']) {
    skills.upsert({ name, kind: 'routine', description: 'test routine', code: 'await sleep(10);' });
  }
  const bus = new VillagerEventBus();
  const world = { timeOfDay: 1_000, day: 0, pos: { x: 100, y: 64, z: 100 }, running: null as string | null };
  const clock = { t: 1_000_000 };
  const requests: Array<{ kind: string; reason: string }> = [];
  const started: string[] = [];
  const h: Partial<Harness> = { memory, bus, requests, started, stopped: 0, walks: 0, world, clock };

  const fakeBot = (): unknown => ({
    time: { timeOfDay: world.timeOfDay, day: world.day },
    entity: { position: { ...world.pos } },
  });
  const villager = {
    name: 'Margaux',
    roster: { name: 'Margaux', role: 'farmer', personality: 't', home: { x: 10, y: 64, z: 10 } },
    homeAnchor: () => ({ x: 10, y: 64, z: 10 }),
    memory,
    skills,
    bus,
    bot: fakeBot,
    requireBot: fakeBot,
    routines: {
      status: () => (world.running ? { name: world.running, runningForMs: 1 } : null),
      start: (name: string) => {
        started.push(name);
        world.running = name;
        return null;
      },
      stop: () => {
        (h as Harness).stopped++;
        world.running = null;
        return true;
      },
    },
    runExclusive: () => {
      (h as Harness).walks++;
      return Promise.resolve();
    },
    villagersInEarshot: () => [],
  } as unknown as Villager;

  // A second villager standing 3 blocks away — the greet-gate counterpart.
  const neighbor = {
    name: 'Firmin',
    roster: { name: 'Firmin', role: 'farmer', personality: 't', home: { x: 30, y: 64, z: 30 } },
    bot: () => ({ time: { timeOfDay: world.timeOfDay, day: world.day }, entity: { position: { x: world.pos.x + 3, y: world.pos.y, z: world.pos.z } } }),
    routines: { status: () => null },
  } as unknown as Villager;

  const ctx = {
    settings: settingsFor(dir),
    scheduler: { request: (_bot: string, kind: string, reason: string) => requests.push({ kind, reason }) },
    conversations: { get: () => undefined },
    villagers: new Map([['Margaux', villager], ['Firmin', neighbor]]),
    villagerNames: new Set(['Margaux', 'Firmin']),
  } as unknown as VillageContext;

  const rhythm = new DailyRhythm(ctx, () => clock.t);
  h.villager = villager;
  h.ctx = ctx;
  h.rhythm = rhythm;
  return h as Harness;
}

// -- pure validation -------------------------------------------------------------

const VCTX = { routineNames: new Set(['farm-loop']), villagerNames: new Set(['Margaux', 'Firmin']), self: 'Margaux' };

test('validateDayPlanSlots normalizes, sorts and accepts the four activity forms', (t) => {
  const result = validateDayPlanSlots(
    [
      { from: 11_500.7, to: 23_500, activity: 'home' },
      { from: 0, to: 5_500, activity: 'job:farm-loop' },
      { from: 5_500, to: 7_000, activity: 'visit:Firmin' },
      { from: 7_000, to: 11_500, activity: 'idle' },
    ],
    VCTX
  );
  t.true(result.ok);
  if (result.ok) {
    t.deepEqual(result.slots.map((s) => s.activity), ['job:farm-loop', 'visit:Firmin', 'idle', 'home']);
    t.is(result.slots[3].from, 11_500, 'fractional ticks floored');
  }
});

test('validateDayPlanSlots rejects malformed plans with actionable errors', (t) => {
  const cases: Array<[unknown, RegExp]> = [
    ['nope', /must be an array/],
    [[{ from: 5, to: 4, activity: 'home' }], /bad slot times/],
    [[{ from: 0, to: 25_000, activity: 'home' }], /bad slot times/],
    [[{ from: 0, to: 10, activity: 'party' }], /bad activity/],
    [[{ from: 0, to: 10, activity: 'job:dance-loop' }], /unknown routine 'dance-loop'.*farm-loop/],
    [[{ from: 0, to: 10, activity: 'visit:Inconnu' }], /unknown villager/],
    [[{ from: 0, to: 10, activity: 'visit:Margaux' }], /cannot visit yourself/],
    [[{ from: 0, to: 100, activity: 'home' }, { from: 50, to: 200, activity: 'idle' }], /overlap/],
    [Array.from({ length: 9 }, (_, i) => ({ from: i * 100, to: i * 100 + 50, activity: 'idle' })), /at most 8/],
  ];
  for (const [raw, pattern] of cases) {
    const result = validateDayPlanSlots(raw, VCTX);
    t.false(result.ok);
    if (!result.ok) t.regex(result.error, pattern);
  }
  t.true(validateDayPlanSlots([], VCTX).ok, 'empty array = clear plan');
});

test('fallbackPlanFor works the first active routine, or idles without one', (t) => {
  const h = harness();
  const plan = fallbackPlanFor(h.villager, 3);
  t.is(plan.day, 3);
  t.is(plan.source, 'fallback');
  t.is(plan.slots[0].activity, 'job:farm-loop');
  t.is(plan.slots[plan.slots.length - 1].activity, 'home');

  const idle = harness({ routines: [] });
  t.is(fallbackPlanFor(idle.villager, 0).slots[0].activity, 'idle');
});

test('currentSlotOf is [from,to) and planDayFor rolls pre-dawn to tomorrow', (t) => {
  const plan = { day: 0, source: 'llm' as const, slots: [{ from: 0, to: 100, activity: 'idle' }] };
  t.truthy(currentSlotOf(plan, 0));
  t.truthy(currentSlotOf(plan, 99));
  t.is(currentSlotOf(plan, 100), null);
  t.is(currentSlotOf(null, 0), null);

  t.is(planDayFor(5, 12_000), 5);
  t.is(planDayFor(5, 23_000), 6);
});

// -- the engine -------------------------------------------------------------------

test('ensurePlan requests one plan deliberation, then falls back after the grace window', (t) => {
  const h = harness();
  h.world.timeOfDay = 500;
  h.rhythm.tick(h.villager);
  h.rhythm.tick(h.villager);
  t.is(h.requests.filter((r) => r.kind === 'plan').length, 1, 'request coalesced to one per day');
  t.is(h.memory.dayPlan(), null, 'no fallback inside the grace window');

  h.world.timeOfDay = FALLBACK_GRACE_TICKS + 500;
  h.rhythm.tick(h.villager);
  const plan = h.memory.dayPlan();
  t.truthy(plan);
  t.is(plan!.source, 'fallback');
  t.is(plan!.day, 0);
});

test('slot executor starts the slot job, stops it on transition, and walks home', (t) => {
  const h = harness();
  const set = h.rhythm.setPlanFromModel(h.villager, [
    { from: 0, to: 11_000, activity: 'job:farm-loop' },
    { from: 11_000, to: 23_500, activity: 'home' },
  ]);
  t.regex(set, /^day plan set for day 0/);

  h.world.timeOfDay = 1_000;
  h.rhythm.tick(h.villager);
  t.deepEqual(h.started, ['farm-loop']);

  // Mid-slot, job already running → nothing new even past the reassert window.
  h.clock.t += 31_000;
  h.rhythm.tick(h.villager);
  t.is(h.started.length, 1);

  // Transition into the home slot: job stops, bot (far from home) walks.
  h.world.timeOfDay = 12_000;
  h.rhythm.tick(h.villager);
  t.is(h.stopped, 1);
  t.is(h.walks, 1);

  // Already close to home → no more walking.
  h.world.pos = { x: 11, y: 64, z: 10 };
  h.clock.t += 31_000;
  h.rhythm.tick(h.villager);
  t.is(h.walks, 1);
});

test('a job the model started during a matching slot is left alone; gaps stop nothing', (t) => {
  const h = harness();
  h.rhythm.setPlanFromModel(h.villager, [
    { from: 0, to: 6_000, activity: 'job:farm-loop' },
    { from: 8_000, to: 10_000, activity: 'idle' },
  ]);
  h.world.running = 'farm-loop'; // model already started it
  h.world.timeOfDay = 1_000;
  h.rhythm.tick(h.villager);
  t.is(h.started.length, 0, 'matching job not restarted');
  t.is(h.stopped, 0);

  h.world.timeOfDay = 7_000; // gap between slots
  h.rhythm.tick(h.villager);
  t.is(h.stopped, 0, 'gaps do not stop a running job');
});

test('setPlanFromModel validates, clears on empty, and pre-dawn plans target tomorrow', (t) => {
  const h = harness();
  t.regex(h.rhythm.setPlanFromModel(h.villager, [{ from: 0, to: 10, activity: 'job:nope' }]), /^ERROR/);

  h.world.timeOfDay = 23_500;
  t.regex(h.rhythm.setPlanFromModel(h.villager, [{ from: 0, to: 9_000, activity: 'idle' }]), /day 1/);
  t.is(h.memory.dayPlan()!.day, 1);

  t.is(h.rhythm.setPlanFromModel(h.villager, []), 'day plan cleared');
  t.is(h.memory.dayPlan(), null);
});

test('needs decay while working, fire tired once with hysteresis, and recover off-shift', (t) => {
  const h = harness();
  h.memory.setDayPlan(null);
  h.ctx.settings.dayPlanning = false; // isolate needs from plan machinery
  const events: VillageEvent[] = [];
  h.bus.subscribe('::test', 'tired', (e) => {
    events.push(e);
  });

  h.world.running = 'farm-loop';
  h.rhythm.tick(h.villager); // arms the dt clock
  h.clock.t += 60_000;
  h.rhythm.tick(h.villager); // -0.6 → rest 0.4
  t.is(events.length, 0);
  t.is(h.memory.needs().rest, 0.4);

  h.clock.t += 60_000;
  h.rhythm.tick(h.villager); // → 0 (clamped), crosses 0.25
  t.is(events.length, 1, "'tired' fired once");
  t.is(h.memory.needs().rest, 0);

  h.clock.t += 60_000;
  h.rhythm.tick(h.villager);
  t.is(events.length, 1, 'no refire while below threshold');

  // Stop working: +0.3/min. Two minutes → 0.6 ≥ 2×threshold → re-armed.
  h.world.running = null;
  h.clock.t += 120_000;
  h.rhythm.tick(h.villager);
  t.is(h.memory.needs().rest, 0.6);

  // Work it back down → fires again after re-arm.
  h.world.running = 'farm-loop';
  h.clock.t += 60_000;
  h.rhythm.tick(h.villager); // 0.0
  t.is(events.length, 2, 'refires after hysteresis re-arm');
});

// -- spontaneous greet gate (M12) ----------------------------------------------------

function greetRequests(h: Harness): Array<{ kind: string; reason: string }> {
  return h.requests.filter((r) => r.reason.includes('tu croises Firmin'));
}

test('greet gate fires for a lonely bot, with per-pair and per-bot cooldowns', (t) => {
  const h = harness();
  h.ctx.settings.spontaneousChat = true;
  h.ctx.settings.dayPlanning = false;
  h.memory.setNeeds({ rest: 1, social: 0.3 }); // lonely → gate passes

  h.rhythm.tick(h.villager);
  t.is(greetRequests(h).length, 1, 'lonely bot greets the neighbor');
  t.regex(greetRequests(h)[0].reason, /start_conversation/);

  h.clock.t += GREET_BOT_COOLDOWN_MS + 1_000;
  h.rhythm.tick(h.villager);
  t.is(greetRequests(h).length, 1, 'pair cooldown still blocks after the bot cooldown');

  h.clock.t += GREET_PAIR_COOLDOWN_MS;
  h.rhythm.tick(h.villager);
  t.is(greetRequests(h).length, 2, 'fires again after the pair cooldown');
});

test('greet gate stays closed for sated strangers, opens on friendship or a visit slot', (t) => {
  const sated = harness();
  sated.ctx.settings.spontaneousChat = true;
  sated.ctx.settings.dayPlanning = false;
  sated.memory.setNeeds({ rest: 1, social: 1 });
  sated.rhythm.tick(sated.villager);
  t.is(greetRequests(sated).length, 0, 'no need, no friendship, no visit → silence');

  // Friendship opens it.
  sated.memory.adjustRelation('Firmin', 30);
  sated.clock.t += GREET_BOT_COOLDOWN_MS + 1_000;
  sated.rhythm.tick(sated.villager);
  t.is(greetRequests(sated).length, 1, 'warm relation opens the gate');

  // A visit slot opens it too, even for a neutral relation.
  const visiting = harness();
  visiting.ctx.settings.spontaneousChat = true;
  visiting.ctx.settings.dayPlanning = false;
  visiting.memory.setNeeds({ rest: 1, social: 1 });
  visiting.memory.setDayPlan({ day: 0, source: 'llm', slots: [{ from: 0, to: 24_000, activity: 'visit:Firmin' }] });
  visiting.world.timeOfDay = 6_000;
  visiting.rhythm.tick(visiting.villager);
  t.is(greetRequests(visiting).length, 1, 'visit slot greets its target');
});

test('greet gate never interrupts work and respects the config switch', (t) => {
  const h = harness();
  h.ctx.settings.spontaneousChat = true;
  h.ctx.settings.dayPlanning = false;
  h.memory.setNeeds({ rest: 1, social: 0.1 });
  h.world.running = 'farm-loop';
  h.rhythm.tick(h.villager);
  t.is(greetRequests(h).length, 0, 'working bots do not break off to chat');

  const off = harness();
  off.ctx.settings.dayPlanning = false; // spontaneousChat stays false
  off.memory.setNeeds({ rest: 1, social: 0.1 });
  off.rhythm.tick(off.villager);
  t.is(greetRequests(off).length, 0, 'config off → no greeting');
});

// -- mood + persistence -------------------------------------------------------------

test("done tool's mood side-output updates the bot's mood", async (t) => {
  const h = harness();
  const state: DeliberationState = { conversationMode: false, done: false, doneSummary: '', conversationMoved: false };
  const out = await dispatchTool(h.villager, h.ctx, state, 'done', JSON.stringify({ summary: 'fini', mood: 'de bonne humeur' }));
  t.is(out, 'ok');
  t.true(state.done);
  t.is(h.memory.mood(), 'de bonne humeur');

  await dispatchTool(h.villager, h.ctx, state, 'done', JSON.stringify({ summary: 'fini' }));
  t.is(h.memory.mood(), 'de bonne humeur', 'omitted mood leaves the old one');
});

test('needs, mood and day plan survive a restart', (t) => {
  const dir = tempDir();
  {
    const persistence = new Persistence(dir);
    const memory = new BotMemory('Margaux', persistence);
    memory.setNeeds({ rest: 0.42, social: 0.9 });
    memory.setMood('fatiguée');
    memory.setDayPlan({ day: 7, source: 'llm', slots: [{ from: 0, to: 100, activity: 'idle' }] });
    persistence.flushNow();
  }
  const memory = new BotMemory('Margaux', new Persistence(dir));
  t.deepEqual(memory.needs(), { rest: 0.42, social: 0.9 });
  t.is(memory.mood(), 'fatiguée');
  t.is(memory.dayPlan()!.day, 7);

  // Old-format file → defaults.
  fs.writeFileSync(
    path.join(dir, 'bots', 'Vieux.json'),
    JSON.stringify({ skills: [], memories: [], memorySummary: '', relations: {} }),
    'utf8'
  );
  const old = new BotMemory('Vieux', new Persistence(dir));
  t.deepEqual(old.needs(), { rest: 1, social: 1 });
  t.is(old.mood(), '');
  t.is(old.dayPlan(), null);
});
