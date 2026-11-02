// A bot that dies leaves its orders, quits once mineflayer has respawned it, and stays offline (docs/35 F7, Paul's
// D2): not reconnected by the backoff, nor at boot, until `/bots squad respawn` (POST /api/bots/respawn) brings it
// back. The runtime on fakes, over HTTP; a second runtime on the same data dir is the restart.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BotPool, DEAD_QUIT_MS } from '../src/bots/pool';
import { parseConfig } from '../src/config';
import { start, type Started } from '../src/main';
import { Roster } from '../src/roster';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { until } from './fakes/harness';

holdEventLoopPerTest(60_000);

const TOKEN = 'test-token';
const PAUL = { uuid: 'uuid-paul', name: 'Paul' };
const ALICE = { uuid: 'uuid-alice', name: 'Alice' };
const dir = mkdtempSync(join(tmpdir(), 'squad-death-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A runtime on `dir` whose bots are FakeBots that spawn on the next tick; `connects` lists every login. */
async function runtime(connects: string[], live: Map<string, FakeBot>): Promise<{ rt: Started; api: (path: string, body?: unknown) => Promise<Record<string, unknown>> }> {
  const cfg = parseConfig({ port: 0, dataDir: dir, loginStaggerMs: 1 }, { PAULSBRAWLS_SQUAD_TOKEN: TOKEN });
  const rt = await start(cfg, {
    connectBots: true,
    pool: {
      createBot: (req) => {
        connects.push(req.username);
        const b = new FakeBot(req.username);
        live.set(req.username, b);
        setTimeout(() => b.emit('spawn'), 1);
        return b as never;
      },
      setup: () => undefined,
    },
  });
  const api = async (path: string, body: unknown = {}): Promise<Record<string, unknown>> => {
    const res = await fetch(`http://127.0.0.1:${rt.port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (await res.json()) as Record<string, unknown>;
  };
  return { rt, api };
}

/** mineflayer's death, then its automatic respawn (the next spawn). */
function die(b: FakeBot): void {
  b.emit('death');
  setTimeout(() => b.emit('spawn'), 5);
}

test('a death: the bot leaves its order, quits once respawned, is marked dead, and nothing reconnects it — not the backoff, not a restart; respawn brings back up to n of a kit', async () => {
  const connects: string[] = [];
  const live = new Map<string, FakeBot>();
  let { rt, api } = await runtime(connects, live);
  try {
    for (const [name, kit, owner] of [['Garde01', 'guard', PAUL], ['Garde02', 'guard', PAUL], ['Garde03', 'guard', PAUL], ['Archer01', 'archer', PAUL], ['Garde04', 'guard', ALICE]] as const) {
      const r = await api('/api/bots/spawn', { by: PAUL, admin: true, name, owners: [owner] });
      assert.equal(r.ok, true, String(r.text));
      await api('/api/bots/tag', { by: PAUL, admin: true, name, changes: [`+${kit}`] });
    }
    const pool = rt.service.deps.pool;
    await until(() => ['Garde01', 'Garde02', 'Garde03', 'Archer01', 'Garde04'].every((n) => pool.status(n) === 'online'), 3_000, 'all online');
    const order = await api('/api/orders/start', { by: PAUL, command: 'follow', tokens: [], filters: ['Garde01'] });
    assert.equal(order.ok, true, String(order.text));
    const o = rt.service.deps.runner.get(String(order.orderId))!;

    for (const n of ['Garde01', 'Garde02', 'Archer01', 'Garde04']) die(live.get(n)!);
    await until(() => ['Garde01', 'Garde02', 'Archer01', 'Garde04'].every((n) => pool.status(n) === 'offline'), 2_000, 'the dead quit once respawned');
    assert.ok(live.get('Garde01')!.calls.includes('quit'));
    assert.equal(o.hasMember('Garde01'), false, 'it left its order');
    assert.ok(rt.service.deps.roster.get('Garde01')!.dead);
    const state = (await api('/api/state')).bots as Array<{ name: string; status: string }>;
    assert.equal(state.find((b) => b.name === 'Garde01')!.status, 'dead');
    assert.equal(state.find((b) => b.name === 'Garde03')!.status, 'online');
    assert.match(String((await api('/api/bots/list', { by: PAUL })).text), /Garde01 — mort/);
    assert.deepEqual((await api('/api/metrics')).dead, ['Garde01', 'Garde02', 'Archer01', 'Garde04']);
    // Past the first reconnect backoff (1 s): nobody logged in again.
    const before = connects.length;
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(connects.length, before, `no reconnect: ${connects.slice(before).join(', ')}`);
    // Dead bots still count toward limits.maxBots: they are in the roster.
    assert.equal(rt.service.deps.roster.all().length, 5);

    // A restart: the mark is in roster.json, and the boot connects only the living.
    await rt.stop();
    assert.ok(new Roster(join(dir, 'roster.json')).get('Garde02')!.dead, 'the mark is on disk');
    connects.length = 0;
    ({ rt, api } = await runtime(connects, live));
    await until(() => rt.service.deps.pool.status('Garde03') === 'online', 2_000, 'the living bot back');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(connects, ['Garde03'], 'only the living bot logs in at boot');

    // /bots squad respawn guards 1 (as Paul, for Paul): the first dead guard by name, not the archer, not Alice's.
    const no = await api('/api/bots/respawn', { by: PAUL, admin: false, kit: 'guard', n: 1 });
    assert.equal(no.ok, false);
    const one = await api('/api/bots/respawn', { by: PAUL, admin: true, kit: 'guard', n: 1 });
    assert.deepEqual(one.bots, ['Garde01'], String(one.text));
    assert.match(String(one.text), /1 bot ramené : Garde01\./);
    await until(() => rt.service.deps.pool.status('Garde01') === 'online', 2_000, 'Garde01 back online');
    assert.equal(rt.service.deps.roster.get('Garde01')!.dead, undefined);
    assert.equal(rt.service.deps.roster.get('Garde02')!.dead, true, 'n = 1: the other guard stays dead');
    // No kit: every dead bot of the owner. Alice's guard needs her as the owner.
    const all = await api('/api/bots/respawn', { by: PAUL, admin: true });
    assert.deepEqual(all.bots, ['Archer01', 'Garde02']);
    const none = await api('/api/bots/respawn', { by: PAUL, admin: true, kit: 'guard' });
    assert.deepEqual(none.bots, []);
    assert.match(String(none.text), /Aucun bot mort \(guard\) pour Paul/);
    const alice = await api('/api/bots/respawn', { by: PAUL, admin: true, owner: ALICE, kit: 'guard' });
    assert.deepEqual(alice.bots, ['Garde04']);
    await until(() => ['Archer01', 'Garde02', 'Garde04'].every((n) => rt.service.deps.pool.status(n) === 'online'), 2_000, 'all back');

    // A despawn removes a dead bot too.
    die(live.get('Garde03')!);
    await until(() => rt.service.deps.roster.get('Garde03')?.dead === true, 2_000, 'Garde03 dead');
    assert.equal((await api('/api/bots/despawn', { by: PAUL, admin: true, name: 'Garde03' })).ok, true);
    assert.equal(rt.service.deps.roster.get('Garde03'), undefined);
  } finally {
    await rt.stop();
  }
});

test('a dead bot whose respawn never comes quits anyway (DEAD_QUIT_MS)', async () => {
  assert.equal(DEAD_QUIT_MS, 10_000);
  const p = new BotPool({
    host: 'x',
    port: 1,
    staggerMs: 1,
    deadQuitMs: 200,
    setup: () => undefined,
    createBot: (req) => {
      const b = new FakeBot(req.username);
      setTimeout(() => b.emit('spawn'), 1);
      return b as never;
    },
  });
  try {
    p.add('Lonely');
    await until(() => p.status('Lonely') === 'online', 1_000, 'online');
    const b = p.bot('Lonely') as unknown as FakeBot;
    b.emit('death'); // no respawn follows
    assert.equal(p.status('Lonely'), 'online', 'still there while it waits for the respawn');
    await until(() => p.status('Lonely') === 'offline', 2_000, 'quit after deadQuitMs');
    assert.ok(p.isDead('Lonely'));
  } finally {
    p.stop();
  }
});
