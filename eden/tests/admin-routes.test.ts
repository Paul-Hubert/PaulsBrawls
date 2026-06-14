// M7-1b — the complete admin API (05 §Admin API). Every GET route returns derived/journal data; every
// mutating POST journals what it did (actor:'admin' | player:<name>) BEFORE acting. These tests drive
// the in-memory journal + plain accessor fakes — no Minecraft, no real subsystems (admin is a consumer).

import test from 'node:test';
import assert from 'node:assert/strict';

import { AdminServer } from '../src/admin/server';
import { MemoryJournal } from './fakes/memory-journal';

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}
async function post(url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function baseDeps(journal: MemoryJournal) {
  return {
    port: 0,
    journal,
    villagers: () => [
      { name: 'Firmin', role: 'farmer', vitals: { health: 20, food: 18 }, subscriptions: 2, inboxDepth: 1, currentRun: null, dossier: { notes: ['diligent'] } },
      { name: 'Alban', role: 'miner', vitals: null, subscriptions: 0, inboxDepth: 0, currentRun: 'mine v1', dossier: { notes: [] } },
    ],
    villager: (name: string) => (name === 'Firmin' ? { name: 'Firmin', role: 'farmer', vitals: { health: 20, food: 18 }, subscriptions: 2, inboxDepth: 1, currentRun: null, dossier: { notes: ['diligent'] } } : undefined),
    skills: () => [
      { name: 'mine', version: 3, status: 'active', tier: 'mortal', stats: { runs: 5, successes: 4 } },
      { name: 'craft', version: 1, status: 'active-probation', tier: 'mortal', stats: { runs: 1, successes: 1 } },
    ],
    skill: (name: string, opts: { version?: number; code?: boolean }) =>
      name === 'mine'
        ? { name: 'mine', version: opts.version ?? 3, status: 'active', stats: { runs: 5, successes: 4 }, ...(opts.code ? { code: 'module.exports = async () => {}' } : {}), ...(opts.version !== undefined ? { requestedVersion: opts.version } : {}) }
        : undefined,
    tasks: () => ({ open: [{ id: 'T1', goal: 'collect 3 oak logs' }], completed: [], failed: [] }),
    verdicts: () => [{ ticketId: 'k1', success: true, libraryAction: 'admit' }],
    directives: () => [{ id: 'D1', to: 'Firmin', goal: 'farm', priority: 'normal' }],
  };
}

test('GET /villagers and /villagers/:name return identity + vitals + subscriptions + inbox + dossier', async (t) => {
  const journal = new MemoryJournal();
  const admin = new AdminServer(baseDeps(journal));
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const list = await getJson(`http://127.0.0.1:${port}/villagers`);
  assert.equal(list.status, 200);
  assert.equal(list.body.villagers.length, 2);
  assert.equal(list.body.villagers[0].name, 'Firmin');
  assert.equal(list.body.villagers[1].currentRun, 'mine v1');

  const one = await getJson(`http://127.0.0.1:${port}/villagers/Firmin`);
  assert.equal(one.status, 200);
  assert.equal(one.body.role, 'farmer');
  assert.equal(one.body.inboxDepth, 1);

  const missing = await getJson(`http://127.0.0.1:${port}/villagers/Nobody`);
  assert.equal(missing.status, 404);
});

test('GET /skills, /skills/:name, ?version=, ?code=1', async (t) => {
  const journal = new MemoryJournal();
  const admin = new AdminServer(baseDeps(journal));
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const list = await getJson(`http://127.0.0.1:${port}/skills`);
  assert.equal(list.body.skills.length, 2);

  const one = await getJson(`http://127.0.0.1:${port}/skills/mine`);
  assert.equal(one.body.name, 'mine');
  assert.equal(one.body.code, undefined, 'no source unless ?code=1');

  const withCode = await getJson(`http://127.0.0.1:${port}/skills/mine?code=1`);
  assert.ok(typeof withCode.body.code === 'string');

  const byVersion = await getJson(`http://127.0.0.1:${port}/skills/mine?version=2`);
  assert.equal(byVersion.body.requestedVersion, 2);

  const missing = await getJson(`http://127.0.0.1:${port}/skills/ghost`);
  assert.equal(missing.status, 404);
});

test('GET /tasks, /verdicts, /directives return ledger views with refs', async (t) => {
  const journal = new MemoryJournal();
  const admin = new AdminServer(baseDeps(journal));
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const tasks = await getJson(`http://127.0.0.1:${port}/tasks`);
  assert.equal(tasks.body.open[0].id, 'T1');
  const verdicts = await getJson(`http://127.0.0.1:${port}/verdicts`);
  assert.equal(verdicts.body.verdicts[0].ticketId, 'k1');
  const directives = await getJson(`http://127.0.0.1:${port}/directives`);
  assert.equal(directives.body.directives[0].id, 'D1');
});

test('POST /pause and /resume gate LLM scheduling and journal actor:admin BEFORE acting', async (t) => {
  const journal = new MemoryJournal();
  const acts: string[] = [];
  const admin = new AdminServer({
    ...baseDeps(journal),
    onPause: () => acts.push('paused'),
    onResume: () => acts.push('resumed'),
  });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const r = await post(`http://127.0.0.1:${port}/pause`);
  assert.equal(r.status, 200);
  assert.equal(r.body.paused, true);
  assert.equal(acts[0], 'paused');
  // The journal entry must precede the action — admin is actor:'admin'.
  const pauseEv = journal.events.find((e) => e.actor === 'admin' && /pause/.test((e.payload as any).message ?? ''));
  assert.ok(pauseEv, 'pause journaled with actor:admin');

  const rr = await post(`http://127.0.0.1:${port}/resume`);
  assert.equal(rr.body.paused, false);
  assert.equal(acts[1], 'resumed');
});

test('POST /skills/:name/quarantine journals actor:admin BEFORE quarantining', async (t) => {
  const journal = new MemoryJournal();
  const quarantined: string[] = [];
  const admin = new AdminServer({
    ...baseDeps(journal),
    onQuarantine: (name: string) => {
      // Assert the admin journal entry already exists when the action fires (journaled BEFORE).
      const pre = journal.events.find((e) => e.actor === 'admin' && e.kind === 'skill.quarantine' && (e.payload as any).name === name);
      assert.ok(pre, 'admin journaled skill.quarantine BEFORE the action ran');
      quarantined.push(name);
      return true;
    },
  });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const r = await post(`http://127.0.0.1:${port}/skills/mine/quarantine`, { reason: 'kill switch' });
  assert.equal(r.status, 200);
  assert.deepEqual(quarantined, ['mine']);
});

test('POST /villagers/:name/prompt journals inbox.delivered BEFORE delivery, zero engine machinery', async (t) => {
  const journal = new MemoryJournal();
  const delivered: Array<{ name: string; text: string; from?: string }> = [];
  const admin = new AdminServer({
    ...baseDeps(journal),
    onPrompt: (name: string, msg: { text: string; from?: string }) => {
      // The inbox.delivered event must already be in the journal when delivery happens (05).
      const pre = journal.events.find((e) => e.kind === 'inbox.delivered' && (e.payload as any).to === name && (e.payload as any).kind === 'tell');
      assert.ok(pre, 'inbox.delivered journaled BEFORE the message is delivered');
      delivered.push({ name, ...msg });
      return true;
    },
  });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const r = await post(`http://127.0.0.1:${port}/villagers/Firmin/prompt`, { text: 'go farm', from: 'paul' });
  assert.equal(r.status, 200);
  assert.deepEqual(delivered, [{ name: 'Firmin', text: 'go farm', from: 'paul' }]);
  // actor is player:<from> when a from is supplied (05 audit trail).
  const ev = journal.events.find((e) => e.kind === 'inbox.delivered' && (e.payload as any).to === 'Firmin');
  assert.equal(ev!.actor, 'player:paul');
});

test('POST /villagers/:name/prompt 404s an unknown villager and never journals', async (t) => {
  const journal = new MemoryJournal();
  const admin = new AdminServer({ ...baseDeps(journal), onPrompt: () => false });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const r = await post(`http://127.0.0.1:${port}/villagers/Nobody/prompt`, { text: 'hi' });
  assert.equal(r.status, 404);
  assert.equal(journal.events.length, 0, 'an unknown villager 404s without a stray journal entry');
});

test('mutating verbs degrade gracefully when their handler is unwired', async (t) => {
  const journal = new MemoryJournal();
  const admin = new AdminServer(baseDeps(journal)); // no onPause/onQuarantine/onPrompt
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const r = await post(`http://127.0.0.1:${port}/pause`);
  assert.equal(r.status, 503, 'an unwired control reports unavailable, not crash');
});
