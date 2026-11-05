// The General (docs/38): geometry, what the army sees, the event ring, and the service on fakes (spawning through the
// mod's reports, orders with a written commander snapshot, the advance's legs, the events), then the MCP server over
// HTTP with its ticket header.

import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Vec3 } from 'vec3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { parseConfig } from '../src/config';
import { start, type Started } from '../src/main';
import { EventRing } from '../src/general/events';
import { Generals, type GeneralRecord } from '../src/general/general';
import { along, dirName, parseDirection, parsePosition, rel, roundYaw16 } from '../src/general/geometry';
import { ClusterTracker, FORGET_MS, LOST_MS } from '../src/general/perception';
import type { Order } from '../src/orders/order';
import type { Player } from '../src/roster';
import { loadStock } from '../src/stock';
import { FakeBot } from './fakes/fake-bot';
import { harness, PAUL, tick, until } from './fakes/harness';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest(60_000);

const stock = await loadStock();
const ROUGE: Player = { uuid: 'uuid-rouge', name: 'Rouge' };
const SPAWN = { x: 100, y: 64, z: -300, dimension: 'overworld', yaw: 270 }; // facing east

// -- geometry ----------------------------------------------------------------------------------------------------------

test('geometry: compass and yaw, positions relative to the spawn point, the axis', () => {
  assert.equal(dirName(270), 'E');
  assert.equal(dirName(0), 'S');
  assert.equal(dirName(180), 'N');
  assert.equal(dirName(90), 'W');
  assert.equal(parseDirection('E'), 270);
  assert.equal(parseDirection('90'), 270); // a bearing: east
  assert.equal(parseDirection('yaw=90'), 90);
  assert.equal(roundYaw16(265), 270);
  const spawn = { x: 100, y: 64, z: -300 };
  assert.equal(rel(spawn, { x: 112, y: 64, z: -303 }), 'E12 N3');
  assert.equal(rel(spawn, spawn), '0');
  const ctx = { spawn, axis: 270, front: 10 };
  assert.deepEqual(parsePosition('E12 N3', ctx), { x: 112, y: 64, z: -303 });
  assert.deepEqual(parsePosition('n3 e12', ctx), { x: 112, y: 64, z: -303 });
  const ax = parsePosition('axis+48', ctx);
  assert.ok(Math.abs(ax.x - 158) < 1e-9 && Math.abs(ax.z + 300) < 1e-9, JSON.stringify(ax));
  assert.deepEqual(parsePosition('1 2 3', ctx), { x: 1, y: 2, z: 3 });
  assert.throws(() => parsePosition('E1 E2', ctx), /unknown position/);
  assert.equal(Math.round(along(spawn, 270, { x: 130, y: 0, z: -290 })), 30);
});

// -- perception ----------------------------------------------------------------------------------------------------

test('clusters: grouped by distance, ids kept while they move, lost then forgotten', () => {
  const t = new ClusterTracker();
  const s = (id: number, x: number, z: number, held = 'bow') => ({ id, name: `P${id}`, pos: { x, y: 64, z }, held, armor: 'iron_chestplate' });
  let u = t.update(0, [s(1, 0, 0), s(2, 5, 0), s(3, 40, 0, 'iron_sword')]);
  assert.deepEqual(u.appeared.map((c) => c.id), ['X1', 'X2']);
  assert.equal(t.get('X1')!.members.size, 2);
  u = t.update(1000, [s(1, 3, 0), s(2, 8, 0), s(3, 43, 0, 'iron_sword')]);
  assert.equal(u.appeared.length, 0);
  u = t.update(3000, [s(1, 9, 0), s(2, 14, 0)]);
  assert.ok(t.get('X1')!.velocity!.x > 2, 'it moves east');
  u = t.update(1000 + LOST_MS, [s(1, 9, 0), s(2, 14, 0)]);
  assert.deepEqual(u.lost.map((c) => c.id), ['X2']);
  t.update(1000 + FORGET_MS, [s(1, 9, 0)]);
  assert.equal(t.get('X2'), undefined);
  assert.equal(t.remove(1)?.name, 'P1');
});

test('events: wait wakes on a waking kind, not on others, and times out', async () => {
  const r = new EventRing(0);
  const quiet = await r.wait(0, 20, new Set(['contact']));
  assert.equal(quiet.woke, false);
  setTimeout(() => r.push('arrived', 'a'), 5);
  setTimeout(() => r.push('contact', 'b'), 15);
  const w = await r.wait(0, 2000, new Set(['contact']));
  assert.equal(w.woke, true);
  assert.deepEqual(w.events.map((e) => e.kind), ['arrived', 'contact']);
});

// -- the service on fakes ------------------------------------------------------------------------------------------

const rigs: Array<{ runner: { stopAll(): Promise<unknown> }; generals: Generals }> = [];
afterEach(async () => {
  // An arrival's or a rule's order starts a moment later: let every queued start finish, then stop them all.
  for (const r of rigs.splice(0)) {
    await new Promise((res) => setTimeout(res, 20));
    await r.generals.settled();
    await r.runner.stopAll();
    await r.generals.settled();
    await r.runner.stopAll();
  }
});

function rig() {
  const h = harness({ stock, limits: { maxBots: 100 } });
  const events = new EventEmitter();
  const sent: Array<{ event: string; data: Record<string, unknown> }> = [];
  const generals = new Generals({
    roster: h.roster,
    pool: h.pool as never,
    poolEvents: events,
    runner: h.runner,
    limits: h.runner['deps'].limits,
    revive: (n) => h.roster.setDead(n, false),
    file: null,
    sampleMs: 0,
    coalesceMs: 0,
  });
  rigs.push({ runner: h.runner, generals });
  generals.sink = (event, data) => {
    sent.push({ event, data: data as Record<string, unknown> });
    return true;
  };
  const r = generals.create({ by: PAUL, admin: true, name: 'Rouge', owner: ROUGE, spawn: SPAWN, allowance: { archer: 4, guard: 4 }, reinforce: 2, range: 200 });
  assert.ok(r.ok, r.text);
  const g = generals.byTicket(r.ticket) as GeneralRecord;
  /** The mod's side of a spawn: each bot in the roster (and the fake pool), reported spawned then arrived. */
  const fulfil = (i = sent.length - 1, at = new Vec3(100, 64, -300)) => {
    const d = sent[i]!.data;
    const kit = String(d.kit);
    const out: FakeBot[] = [];
    for (let k = 1; k <= Number(d.n); k++) {
      const name = `${String(d.prefix)}${String(k).padStart(2, '0')}`;
      const items = kit === 'archer' ? [{ name: 'bow', count: 1 }, { name: 'arrow', count: 64 }] : [{ name: 'iron_sword', count: 1 }, { name: 'shield', count: 1 }];
      const b = h.bot(name, [ROUGE], items, [kit]);
      b.entity.position = at.offset(k, 0, 0);
      generals.spawned(String(d.request), name);
      generals.arrived(String(d.request), name);
      out.push(b);
    }
    return out;
  };
  return { h, generals, g, sent, fulfil, events, ticket: r.ticket! };
}

test('create: admin only, a valid name and allowance; the axis is the facing rounded to 16 directions', () => {
  const { generals, g } = rig();
  assert.equal(g.axis, 270);
  assert.match(generals.briefing(g), /Axis of attack: E/);
  assert.equal(generals.create({ by: PAUL, admin: false, name: 'Bleu', owner: { uuid: 'b', name: 'Bleu' }, spawn: SPAWN, allowance: { archer: 1 } }).ok, false);
  assert.match(generals.create({ by: PAUL, admin: true, name: 'Bleu', owner: { uuid: 'b', name: 'Bleu' }, spawn: SPAWN, allowance: { knight: 1 } }).text, /kit inconnu/);
  assert.throws(() => generals.byTicket('gen-nope'), /unknown or revoked/);
  assert.equal(generals.isGeneralOwner(ROUGE.uuid), true);
});

test('spawn_squad goes through the mod and counts against the allowance; arrival is one event', async () => {
  const { generals, g, sent, fulfil } = rig();
  assert.match(generals.spawnSquad(g, 'A', 'archer', 3), /requested 3 archer for squad A/);
  assert.equal(sent[0]!.event, 'general-spawn');
  assert.equal(sent[0]!.data.prefix, 'RougeArc');
  assert.throws(() => generals.spawnSquad(g, 'B', 'archer', 2), /only 1 archer left/);
  assert.throws(() => generals.spawnSquad(g, 'B', 'miner', 1), /not in your allowance/);
  fulfil();
  assert.deepEqual(g.squads.A!.bots, ['RougeArc01', 'RougeArc02', 'RougeArc03']);
  await until(() => generals.events(g).since(0).some((e) => e.kind === 'arrived'), 2000, 'arrived');
  const ev = generals.events(g).since(0);
  assert.equal(ev.filter((e) => e.kind === 'arrived').length, 1);
  // With no order to join, the arrivals form a line at the rally point (spread out, not a pile at the spawn).
  assert.match(ev.find((e) => e.kind === 'arrived')!.text, /3 archer arrived at the spawn point .*; squad A: line #\d+ \(3 archers\)/);
  assert.match(generals.sitrep(g), /allow archer 3\/4 guard 0\/4/);
  assert.match(generals.sitrep(g), /^A 3\/3 archer3 hp100 line rules1 @E2/m);
});

test('order: a written snapshot at the point, facing the axis; retarget re-aims a listening order without restarting', async () => {
  const { generals, g, fulfil } = rig();
  generals.spawnSquad(g, 'G', 'guard', 2);
  fulfil();
  const text = await generals.order(g, 'G', 'line', '', { pos: 'E20 N2' });
  assert.match(text, /squad G: line #\d+ \(2 guards\) at E20 N2 facing E/);
  const id = /#(\d+)/.exec(text)![1]!;
  const o = generals['deps'].runner.get(id) as Order;
  assert.deepEqual(o.snap.lookBlock, { x: 120, y: 63, z: -302, name: 'ground' });
  assert.equal(o.snap.yaw, 270);
  await until(() => o.listening, 2000, 'line listens');
  const again = await generals.retarget(g, 'G', { pos: 'E30' });
  assert.match(again, /re-aimed: at E30 facing E/);
  assert.equal(o.running, true);
  assert.equal(o.snap.lookBlock!.x, 130);
  assert.match(await generals.stopSquad(g, 'G'), /line stopped/);
  assert.equal(generals.events(g).since(0).filter((e) => e.kind === 'order-end').length, 0, 'a stop by the General is not an event');
});

test('order refuses commands outside the offered list and squads with nobody online', async () => {
  const { generals, g } = rig();
  generals.spawnSquad(g, 'A', 'archer', 1); // never fulfilled: nobody online
  await assert.rejects(generals.order(g, 'A', 'gather', '', {}), /unknown order/);
  await assert.rejects(generals.order(g, 'A', 'attack', '', {}), /no bot online/);
});

test('enemies: a sighting is a contact, a cluster in the sitrep, and a target for orders', async () => {
  const { generals, g, fulfil } = rig();
  generals.spawnSquad(g, 'A', 'archer', 2);
  const [a1] = fulfil();
  a1!.entities = {
    41: { id: 41, type: 'player', username: 'Paul', position: new Vec3(130, 64, -300), equipment: [{ name: 'iron_sword' }, null, null, null, { name: 'diamond_chestplate' }] },
    42: { id: 42, type: 'player', username: 'RougeArc02', position: new Vec3(101, 64, -300) }, // ours
    43: { id: 43, type: 'hostile', name: 'zombie', position: new Vec3(104, 64, -300) },
  };
  generals.sample(Date.now());
  const contact = generals.events(g).since(0).find((e) => e.kind === 'contact');
  assert.ok(contact, 'a contact event');
  assert.match(contact.text, /X1 1 @E30 .*sword1 diamond \[Paul\]/);
  assert.match(generals.sitrep(g), /^A 2\/2 archer2 hp100 idle rules1 @E2 contact X1 29b mobs1$/m);
  const r = await generals.order(g, 'A', 'attack', '', { target: 'X1' });
  assert.match(r, /on Paul @E30 facing E/);
  const o = generals['deps'].runner.get(/#(\d+)/.exec(r)![1]!) as Order;
  assert.equal(o.snap.lookEntity!.id, 41);
  await generals.stopSquad(g, 'A');
});

test('advance: raid legs along the axis, side by side; a finished leg starts the next; the range ends it', async () => {
  const { generals, g, fulfil } = rig();
  generals.spawnSquad(g, 'A', 'guard', 2);
  fulfil();
  generals.spawnSquad(g, 'B', 'archer', 2);
  fulfil(undefined, new Vec3(100, 64, -290));
  const text = await generals.advance(g, undefined, 40);
  assert.match(text, /squad A: raid #\d+/);
  const legA = generals['deps'].runner.get(/squad A: raid #(\d+)/.exec(text)![1]!) as Order;
  const legB = generals['deps'].runner.get(/squad B: raid #(\d+)/.exec(text)![1]!) as Order;
  assert.deepEqual([legA.args.x, legA.args.z, legA.args.quiet], [142, -300, 3]); // front 2 + 40, lane 0
  assert.deepEqual([legB.args.x, legB.args.z], [136, -288], 'next lane (12 to the right of east = south), 6 back');
  assert.match(generals.sitrep(g), /^A 2\/2 guard2 hp100 advance→E42/m);

  // A's leg ends: it waits for B (within 16 along the axis), then marches on.
  for (const b of ['RougeGar01', 'RougeGar02']) generals['deps'].pool.bot(b)!.entity.position = new Vec3(142, 64, -300) as never;
  await legA.complete('Raid terminé : aucun ennemi trouvé.');
  await tick(5);
  generals.sample();
  assert.equal(generals.events(g).since(0).filter((e) => e.kind === 'order-end').length, 0);
  assert.match(generals.sitrep(g), /waiting for the others/);
  for (const b of ['RougeArc01', 'RougeArc02']) generals['deps'].pool.bot(b)!.entity.position = new Vec3(135, 64, -288) as never;
  generals.sample();
  await until(() => /^A .*advance→E82/m.test(generals.sitrep(g)), 2000, 'the next leg');

  // At the range: the next leg is not started; the advance stops and says so once.
  g.range = 50;
  for (const b of ['RougeGar01', 'RougeGar02']) generals['deps'].pool.bot(b)!.entity.position = new Vec3(150, 64, -300) as never;
  generals['runtime'](g).advancing.get('A')!.waiting = true;
  generals.sample();
  await until(() => generals.events(g).since(0).some((e) => e.kind === 'axis-end'), 2000, 'axis-end');
  assert.equal(generals['runtime'](g).advancing.size, 0);
  await assert.rejects(generals.advance(g, ['A'], undefined), /range limit/);
  await generals['deps'].runner.stopAll();
});

test('casualties, health bands and idle', () => {
  const { generals, g, fulfil, events } = rig();
  generals.spawnSquad(g, 'A', 'guard', 2);
  const [b1, b2] = fulfil();
  b1!.health = 8;
  b2!.health = 8;
  generals.sample(Date.now());
  assert.match(generals.events(g).since(0).find((e) => e.kind === 'hp-band')!.text, /squad A health down to 40% \(below 50%\)/);
  events.emit('gone', 'RougeGar01', 'died');
  assert.match(generals.events(g).since(0).find((e) => e.kind === 'casualty')!.text, /RougeGar01 of squad A died \(1 left online; 2 reinforcement/);
  const now = Date.now();
  generals.sample(now);
  generals.sample(now + 21_000);
  assert.match(generals.events(g).since(0).find((e) => e.kind === 'idle')!.text, /advance along the axis \(E\)/);
});

test('reinforce brings a dead bot back and spends a reinforcement; mission and axis are recorded', () => {
  const { h, generals, g, fulfil, sent } = rig();
  generals.spawnSquad(g, 'A', 'guard', 1);
  fulfil();
  h.roster.setDead('RougeGar01', true);
  assert.match(generals.reinforce(g, 'A', 3), /bringing back RougeGar01 .*1 reinforcement\(s\) left/);
  assert.deepEqual(sent.at(-1)!.data.revive, ['RougeGar01']);
  assert.equal(h.roster.get('RougeGar01')!.dead, undefined);
  assert.match(generals.setMission(g, 'take the hill', 'archers behind a shield wall'), /goal: take the hill \| strategy: archers behind/);
  assert.match(generals.setAxis(g, 'NE'), /axis is now NE/);
  assert.match(generals.sitrep(g), /axis=NE/);
});

test('attribution: who hurt a squad, from where; under-fire, enemy-approach, a lost cluster keeps its heading, what each bot does', () => {
  const { generals, g, fulfil, events } = rig();
  generals.spawnSquad(g, 'A', 'guard', 2);
  const [b1, b2] = fulfil();
  generals.setStanding(g, 'A', []); // standing orders have their own tests (standing.test.ts)
  const t0 = Date.now();
  // An enemy archer 70 blocks north-east, and a melee cluster 40 blocks east coming west at 2 b/s.
  const archer = { id: 50, type: 'player', username: 'Hubert', position: new Vec3(150, 64, -350), equipment: [{ name: 'bow' }] };
  const runner = (x: number) => ({ id: 51, type: 'player', username: 'HubertSwd', position: new Vec3(x, 64, -300), equipment: [{ name: 'iron_sword' }] });
  b1!.entities = { 50: archer, 51: runner(142) };
  generals.sample(t0);
  assert.equal(generals.events(g).since(0).filter((e) => e.kind === 'enemy-approach').length, 0, 'no speed yet');
  b1!.entities = { 50: archer, 51: runner(140) };
  generals.sample(t0 + 1000);
  const near = generals.events(g).since(0).find((e) => e.kind === 'enemy-approach');
  assert.ok(near, 'enemy-approach');
  assert.match(near.text, /X2 \(1, sword1\) 39b from squad A, closing at 2\.0b\/s from E: contact in ~19s/);
  b1!.entities = { 50: archer, 51: runner(136) };
  generals.sample(t0 + 2000);
  generals.sample(t0 + 2500);
  assert.equal(generals.events(g).since(0).filter((e) => e.kind === 'enemy-approach').length, 1, 'once');

  // Three arrows from Hubert within 5 s: under-fire, with the bearing and the cluster.
  for (const [i, b] of [b1, b2, b1].entries()) generals.hurt(g, b!.username, { attacker: archer as never, kind: 'arrow', weapon: 'bow', from: archer.position }, t0 + 2600 + i * 100);
  generals.sample(t0 + 3000);
  const fire = generals.events(g).since(0).find((e) => e.kind === 'under-fire');
  assert.ok(fire, 'under-fire');
  assert.match(fire.text, /squad A: 3 hits in 5s: 3 arrows from NE ~\d+b \(X1\)/);

  // Health falls: the band says what hit it; a death names its killer.
  b1!.health = 6;
  b2!.health = 6;
  generals.sample(t0 + 3500);
  assert.match(generals.events(g).since(0).find((e) => e.kind === 'hp-band')!.text, /below 50%\); 3 hits in 10s: 3 arrows from NE/);
  const detail = generals.squadDetail(g, 'A');
  assert.match(detail, /RougeGar01 guard hp6 .*no order: standing, holds .*; hit 2x in 10s, last by Hubert \(bow, arrow, from NE \d+b, X1\)/);
  events.emit('gone', 'RougeGar02', 'died');
  assert.match(generals.events(g).since(0).find((e) => e.kind === 'casualty')!.text, /RougeGar02 of squad A died, killed by Hubert \(bow, arrow, from NE \d+b, X1\)/);

  // The runner leaves sight: lost, with its last heading.
  b1!.entities = { 50: archer };
  generals.sample(t0 + 3500 + LOST_MS);
  const lost = generals.events(g).since(0).find((e) => e.kind === 'contact-lost');
  assert.ok(lost);
  assert.match(lost.text, /X2 1 LOST \d+s ago, last @E36 y64 →W \d\.\db\/s sword1 \[HubertSwd\]/);
  assert.match(generals.sitrep(g), /X2 1 LOST/);
});

test('cadence: wait_events sends the sitrep whole once, then only what changed; a short default timeout in a fight', async () => {
  const { generals, g, fulfil } = rig();
  generals.spawnSquad(g, 'A', 'guard', 1);
  const [a] = fulfil();
  generals.spawnSquad(g, 'B', 'archer', 1);
  fulfil();
  const first = await generals.waitEvents(g, { timeoutS: 1 });
  assert.match(first, /^mission: /m);
  assert.match(first, /^A 1\/1 /m);
  const second = await generals.waitEvents(g, { timeoutS: 1 });
  assert.doesNotMatch(second, /^A 1\/1 /m, 'nothing changed');
  assert.match(second, /^unchanged: A B$/m);
  a!.health = 10;
  const third = await generals.waitEvents(g, { timeoutS: 1 });
  assert.match(third, /^A 1\/1 guard1 hp50 /m);
  assert.match(third, /^unchanged: B$/m);
  assert.match(await generals.waitEvents(g, { timeoutS: 1, full: true }), /^B 1\/1 /m);

  // An enemy in sight: the default timeout is the fight's (8 s), and a contact wakes it at once.
  generals.setStanding(g, 'A', []);
  generals.setStanding(g, 'B', []);
  a!.entities = { 60: { id: 60, type: 'player', username: 'Hubert', position: new Vec3(140, 64, -300) } };
  generals.sample();
  const t = Date.now();
  const quiet = await generals.waitEvents(g, {});
  assert.ok(Date.now() - t >= 7_500 && Date.now() - t < 12_000, `waited ${Date.now() - t} ms`);
  assert.match(quiet, /nothing new in 8s/);
});

test('orders: a plan in one call, checked whole first; the model and the runtime have their own budgets', async () => {
  const { generals, g, fulfil } = rig();
  generals.spawnSquad(g, 'A', 'guard', 2);
  fulfil();
  generals.spawnSquad(g, 'B', 'archer', 2);
  fulfil();
  await tick(20);
  const before = generals['deps'].runner.running().map((o) => o.id);
  await assert.rejects(generals.orderMany(g, [{ squad: 'A', command: 'line', at: { pos: 'E20' } }, { squad: 'Z', command: 'attack' }]), /unknown squad "Z"/);
  assert.deepEqual(generals['deps'].runner.running().map((o) => o.id), before, 'nothing started');
  const r = await generals.orderMany(g, [
    { squad: 'A', command: 'line', at: { pos: 'E20' } },
    { squad: 'B', command: 'line', args: 'back=6', at: { pos: 'E20' } },
  ]);
  assert.match(r, /^squad A: line #\d+ \(2 guards\) at E20 facing E$/m);
  assert.match(r, /^squad B: line #\d+ \(2 archers\) at E20 facing E$/m);
  assert.equal(generals['deps'].runner.running().length, 2);
  // 18 more model orders fit, the 19th not; the runtime's own budget is apart.
  const rt = generals['runtime'](g);
  rt.orderTimes.push(...Array.from({ length: 18 }, () => Date.now()));
  await assert.rejects(generals.order(g, 'A', 'line', '', { pos: 'E30' }), /20 orders a minute at most/);
  assert.match(await generals.advance(g, ['A'], 40), /squad A: raid #\d+/);
  await generals['deps'].runner.stopAll();
});

test('safe reinforcement: refused with an enemy near the spawn (unless forced); the arrivals get their order', async () => {
  const { h, generals, g, fulfil, sent } = rig();
  generals.spawnSquad(g, 'A', 'guard', 2);
  const [a1] = fulfil();
  generals.setStanding(g, 'A', []);
  await until(() => generals.events(g).since(0).some((e) => e.kind === 'arrived'), 2000, 'arrived');
  h.roster.setDead('RougeGar02', true);
  // An enemy 20 blocks from the spawn point: arrivals would die there.
  a1!.entities = { 80: { id: 80, type: 'player', username: 'Hubert', position: new Vec3(120, 64, -300) } };
  generals.sample();
  assert.throws(() => generals.reinforce(g, 'A', 1), /enemy X1 \(1\) is 20 blocks from the spawn point: arrivals would die there/);
  assert.throws(() => generals.spawnSquad(g, 'B', 'archer', 1), /20 blocks from the spawn point/);
  assert.match(generals.reinforce(g, 'A', 1, { force: true, then: { command: 'attack', at: { target: 'X1' } } }), /bringing back RougeGar02 .*on arrival: attack/);
  const req = String(sent.at(-1)!.data.request);
  generals.arrived(req, 'RougeGar02');
  await until(() => generals.events(g).since(0).filter((e) => e.kind === 'arrived').length === 2, 2000, 'the reinforcement arrived');
  assert.match(generals.events(g).since(0).filter((e) => e.kind === 'arrived')[1]!.text, /1 guard back at the spawn point \(RougeGar02\); squad A: attack #\d+ \(\d melee\) on Hubert/);
});

test('attack: archers close in by default (approach=40); with approach=0 a far target is refused', async () => {
  const { generals, g, fulfil } = rig();
  generals.spawnSquad(g, 'A', 'archer', 2);
  const [a1] = fulfil();
  generals.setStanding(g, 'A', []);
  a1!.entities = { 90: { id: 90, type: 'player', username: 'Far', position: new Vec3(210, 64, -300) } };
  generals.sample();
  await assert.rejects(generals.order(g, 'A', 'attack', 'approach=0', { target: 'X1' }), /target 109 blocks from squad A, out of bow range .*use raid, or attack with approach=N/);
  const r = await generals.order(g, 'A', 'attack', '', { target: 'X1' });
  const o = generals['deps'].runner.get(/#(\d+)/.exec(r)![1]!) as Order;
  assert.equal(o.args.approach, 40);
});

// -- over HTTP -------------------------------------------------------------------------------------------------------

let dir: string;
let rt: Started;
let base: string;
const TOKEN = 'test-token';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'squad-general-'));
  const cfg = parseConfig({ port: 0, dataDir: dir, loginStaggerMs: 1 }, { PAULSBRAWLS_SQUAD_TOKEN: TOKEN });
  rt = await start(cfg, {
    connectBots: true,
    pool: {
      createBot: (req) => {
        const b = new FakeBot(req.username);
        setTimeout(() => b.emit('spawn'), 1);
        return b as never;
      },
      setup: () => undefined,
    },
  });
  base = `http://127.0.0.1:${rt.port}`;
});

after(async () => {
  await rt.stop();
  rmSync(dir, { recursive: true, force: true });
});

const api = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;

const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join('\n');

test('HTTP: create a General, then its instance reaches /mcp/general with the ticket header alone', async () => {
  const c = await api('/api/general/create', { by: PAUL, admin: true, name: 'Bleu', owner: { uuid: 'uuid-bleu', name: 'Bleu' }, spawn: { ...SPAWN, yaw: 85 }, allowance: { archer: 2 }, range: 120 });
  assert.equal(c.ok, true, String(c.text));
  assert.match(String(c.text), /axe d'attaque W/);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp/general'), { requestInit: { headers: { 'X-Squad-General': String(c.ticket) } } }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['get_briefing', 'sitrep', 'wait_events', 'spawn_squad', 'order', 'advance', 'set_mission']) assert.ok(tools.includes(t), t);
  assert.match(textOf(await client.callTool({ name: 'get_briefing', arguments: {} })), /You are General Bleu/);
  const spawn = await client.callTool({ name: 'spawn_squad', arguments: { squad: 'A', kit: 'archer', count: 1 } });
  assert.equal(spawn.isError, true, 'no mod listens: nothing can spawn');
  assert.match(textOf(spawn), /not connected/);
  const t0 = Date.now();
  const w = textOf(await client.callTool({ name: 'wait_events', arguments: { timeout_s: 1 } }));
  assert.ok(Date.now() - t0 >= 900);
  assert.match(w, /nothing new in 1s[\s\S]*--- sitrep/);
  await client.close();

  const wrong = new Client({ name: 'test', version: '1' });
  await wrong.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp/general'), { requestInit: { headers: { 'X-Squad-General': 'gen-wrong' } } }));
  const r = await wrong.callTool({ name: 'sitrep', arguments: {} });
  assert.equal(r.isError, true);
  await wrong.close();

  const list = await api('/api/general/list', { by: PAUL, admin: true });
  assert.match(String(list.text), /Bleu .* archer 0\/2/);
  const stop = await api('/api/general/stop', { by: PAUL, admin: true, name: 'Bleu' });
  assert.equal(stop.ok, true);
  await tick(5);
});
