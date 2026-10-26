import test from 'ava';
import { VillageScheduler } from '../src/village/scheduler.js';
import { ThinkRequest } from '../src/village/types.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('respects the concurrency cap and runs higher priority first', async (t) => {
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const scheduler = new VillageScheduler({
    concurrency: 1,
    botCooldownMs: 0,
    runner: async (req: ThinkRequest) => {
      ran.push(`${req.botName}/${req.kind}`);
      if (ran.length === 1) await gate; // hold the slot while we queue more
    },
  });

  scheduler.request('alice', 'heartbeat', 'tick');
  t.is(ran.length, 1, 'first request starts immediately');

  scheduler.request('bob', 'heartbeat', 'tick');
  scheduler.request('carol', 'player', 'a player spoke');
  t.is(ran.length, 1, 'cap of 1 holds');

  release();
  await delay(50);
  t.deepEqual(ran, ['alice/heartbeat', 'carol/player', 'bob/heartbeat'], 'player priority preempts the earlier heartbeat');
});

test('coalesces repeat requests per bot+kind, merging reasons', async (t) => {
  const seen: ThinkRequest[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const scheduler = new VillageScheduler({
    concurrency: 1,
    botCooldownMs: 0,
    runner: async (req) => {
      seen.push(req);
      if (seen.length === 1) await gate;
    },
  });

  scheduler.request('alice', 'heartbeat', 'occupy the slot');
  scheduler.request('bob', 'combat', 'hurt by zombie');
  scheduler.request('bob', 'combat', 'hurt again');
  scheduler.request('bob', 'combat', 'and again');

  release();
  await delay(50);
  t.is(seen.length, 2, 'three combat requests coalesced into one');
  t.deepEqual(seen[1].reasons, ['hurt by zombie', 'hurt again', 'and again']);
});

test('one deliberation in flight per bot', async (t) => {
  const running = new Set<string>();
  let overlap = false;
  const scheduler = new VillageScheduler({
    concurrency: 4,
    botCooldownMs: 0,
    runner: async (req) => {
      if (running.has(req.botName)) overlap = true;
      running.add(req.botName);
      await delay(30);
      running.delete(req.botName);
    },
  });

  scheduler.request('alice', 'combat', 'r1');
  await delay(5);
  scheduler.request('alice', 'player', 'r2'); // different kind — must still wait
  await delay(120);
  t.false(overlap, 'the same bot never deliberates twice at once');
});

test('cooldown delays the next run; pause/resume works', async (t) => {
  const ran: number[] = [];
  const scheduler = new VillageScheduler({
    concurrency: 1,
    botCooldownMs: 80,
    runner: async () => { ran.push(Date.now()); },
  });

  scheduler.request('alice', 'heartbeat', 'one');
  await delay(20);
  scheduler.request('alice', 'heartbeat', 'two');
  await delay(20);
  t.is(ran.length, 1, 'cooldown holds the second run');
  await delay(150);
  t.is(ran.length, 2, 'wake timer releases it after the cooldown');

  scheduler.pause();
  scheduler.request('alice', 'heartbeat', 'three');
  await delay(150);
  t.is(ran.length, 2, 'paused scheduler runs nothing');
  scheduler.resume();
  await delay(150);
  t.is(ran.length, 3, 'resume drains the queue');
});

test('a sooner-eligible urgent request re-arms the wake timer', async (t) => {
  // Regression: the wake timer used to stay armed for the FIRST deadline it
  // computed (often a slow non-urgent one), so an urgent request landing later
  // waited out the FULL cooldown — conversation turns crawled at cooldown
  // speed whenever any background request was pending.
  const ran: string[] = [];
  const scheduler = new VillageScheduler({
    concurrency: 1,
    botCooldownMs: 500,
    runner: async (req) => { ran.push(req.kind); },
  });

  scheduler.request('alice', 'heartbeat', 'seed the cooldown');
  await delay(20);
  t.deepEqual(ran, ['heartbeat']);

  // Non-urgent request: eligible at cooldown end (~500ms) — arms the timer.
  scheduler.request('alice', 'job', 'background work');
  await delay(20);
  // Urgent request: eligible at ~20% of the cooldown (~100ms).
  scheduler.request('alice', 'conversation', 'your turn');
  await delay(250); // well before the 500ms non-urgent deadline
  t.true(ran.includes('conversation'), 'urgent request dispatched at ITS deadline, not the stale one');
});

test('isHeld keeps matching requests queued until pump() releases them', async (t) => {
  const ran: string[] = [];
  let inConversation = true;
  const scheduler = new VillageScheduler({
    concurrency: 2,
    botCooldownMs: 0,
    isHeld: (_bot, kind) => kind === 'error' && inConversation,
    runner: async (req) => { ran.push(`${req.botName}/${req.kind}`); },
  });

  scheduler.request('alice', 'error', 'routine failed');
  await delay(30);
  t.deepEqual(ran, [], 'held request does not dispatch');

  scheduler.request('alice', 'conversation', 'your turn');
  await delay(30);
  t.deepEqual(ran, ['alice/conversation'], 'non-held kinds flow normally');

  inConversation = false;
  scheduler.pump(); // what the conversation manager calls on conversation end
  await delay(30);
  t.deepEqual(ran, ['alice/conversation', 'alice/error'], 'released request dispatches');
});

test('cancel drops a pending request', async (t) => {
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new VillageScheduler({
    concurrency: 1,
    botCooldownMs: 0,
    runner: async (req) => {
      ran.push(req.botName);
      if (ran.length === 1) await gate;
    },
  });
  scheduler.request('alice', 'heartbeat', 'hold');
  scheduler.request('bob', 'conversation', 'your turn');
  scheduler.cancel('bob', 'conversation');
  release();
  await delay(50);
  t.deepEqual(ran, ['alice'], 'cancelled request never ran');
});
