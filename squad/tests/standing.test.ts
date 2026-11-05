// Standing orders (docs/45 §1): the pure rules (src/general/standing.ts: checks, edges, cooldowns, the model's
// precedence) and their firing by the General's sampler on fakes (tests/general.test.ts has the rest of the General).

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Vec3 } from 'vec3';

import { Generals, type GeneralRecord } from '../src/general/general';
import { checkRule, defaultRules, due, freshState, RESPECT_MS, ruleText, type SquadView } from '../src/general/standing';
import type { Order } from '../src/orders/order';
import type { Player } from '../src/roster';
import { loadStock } from '../src/stock';
import { harness, PAUL, until } from './fakes/harness';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest(60_000);

const stock = await loadStock();
const ROUGE: Player = { uuid: 'uuid-rouge', name: 'Rouge' };
const SPAWN = { x: 100, y: 64, z: -300, dimension: 'overworld', yaw: 270 }; // facing east

test('rules: checked, written in one line, defaults per kit', () => {
  assert.throws(() => checkRule({ when: 'sunrise', do: 'line' }), /unknown trigger/);
  assert.throws(() => checkRule({ when: 'hp', value: 120, do: 'line' }), /out of 5\.\.95/);
  assert.throws(() => checkRule({ when: 'contact', do: 'attack' }), /attack needs at\.target/);
  const r = checkRule({ when: 'hp', do: 'line', at: { pos: 'back 24' } });
  assert.equal(r.value, 40);
  assert.equal(ruleText(r), 'health below 40% → line @back 24');
  assert.deepEqual(defaultRules('horseman').map((x) => x.when), ['hp', 'contact', 'approach', 'ended']);
  assert.ok(defaultRules('horseman').every((x) => x.do !== 'line' || x.when === 'hp'), 'cavalry only lines up to fall back');
  assert.deepEqual(defaultRules('horsearcher').map((x) => x.do), ['line', 'raid', 'raid']);
  assert.deepEqual(defaultRules('miner'), []);
});

test('due: edges, cooldowns, a free squad for contact, the model first', () => {
  const rules = [checkRule({ when: 'hp', value: 40, do: 'line', at: { pos: 'back 24' } }), checkRule({ when: 'contact', value: 48, do: 'attack', at: { target: 'trigger' } })];
  const states = rules.map(() => freshState(0, 0));
  const v = (o: Partial<SquadView>): SquadView => ({ now: 100_000, clusters: [], hp: 100, deaths: 0, free: true, ...o });
  assert.equal(due(rules, states, v({})), null);
  assert.deepEqual(due(rules, states, v({ clusters: [{ id: 'X1', d: 40, closing: 0 }] })), { i: 1, cluster: 'X1' });
  states[1]!.firedAt = 100_000;
  assert.equal(due(rules, states, v({ now: 100_500, clusters: [{ id: 'X2', d: 30, closing: 0 }] })), null, 'cooldown');
  assert.deepEqual(due(rules, states, v({ now: 111_000, clusters: [{ id: 'X1', d: 10, closing: 0 }, { id: 'X2', d: 30, closing: 0 }] })), { i: 1, cluster: 'X2' }, 'X1 already fired it');
  assert.equal(due(rules, states, v({ now: 130_000, clusters: [{ id: 'X3', d: 30, closing: 0 }], free: false })), null, 'busy: no contact rule');
  // hp: once per crossing, armed again 10 points above.
  assert.deepEqual(due(rules, states, v({ now: 130_000, hp: 35, free: false })), { i: 0 });
  states[0]!.firedAt = 130_000;
  assert.equal(due(rules, states, v({ now: 150_000, hp: 30, free: false })), null);
  due(rules, states, v({ now: 150_000, hp: 55, free: false }));
  assert.deepEqual(due(rules, states, v({ now: 160_000, hp: 35, free: false })), { i: 0 });
  // The model's own order: nothing fires for RESPECT_MS.
  assert.equal(due(rules, states, v({ now: 200_000, clusters: [{ id: 'X9', d: 5, closing: 0 }], modelAt: 200_000 - RESPECT_MS + 100 })), null);
  // losses, idle, ended
  const more = [checkRule({ when: 'losses', value: 2, do: 'reinforce', n: 2 }), checkRule({ when: 'idle', value: 8, do: 'advance' }), checkRule({ when: 'ended', do: 'advance' })];
  const st = more.map(() => freshState(3, 0));
  assert.equal(due(more, st, v({ deaths: 4 })), null);
  assert.deepEqual(due(more, st, v({ deaths: 5 })), { i: 0 });
  assert.deepEqual(due(more, st, v({ idleSince: 100_000 - 8_000 })), { i: 1 });
  assert.equal(due(more.slice(2), st.slice(2), v({ endedAt: 99_000 })) !== null, true);
  st[2]!.firedAt = 99_500;
  assert.equal(due(more.slice(2), st.slice(2), v({ endedAt: 99_000 })), null, 'that end already fired it');
});

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
  const generals = new Generals({ roster: h.roster, pool: h.pool as never, poolEvents: new EventEmitter(), runner: h.runner, limits: h.runner['deps'].limits, revive: (n) => h.roster.setDead(n, false), file: null, sampleMs: 0, coalesceMs: 0 });
  rigs.push({ runner: h.runner, generals });
  const sent: Array<Record<string, unknown>> = [];
  generals.sink = (_e, data) => {
    sent.push(data as Record<string, unknown>);
    return true;
  };
  const r = generals.create({ by: PAUL, admin: true, name: 'Rouge', owner: ROUGE, spawn: SPAWN, allowance: { horseman: 4, guard: 4 }, reinforce: 2, range: 300 });
  const g = generals.byTicket(r.ticket) as GeneralRecord;
  const spawn = (squad: string, kit: 'horseman' | 'guard', n: number, x = 101) => {
    generals.spawnSquad(g, squad, kit, n);
    const d = sent.at(-1)!;
    return Array.from({ length: n }, (_, i) => {
      const name = `${String(d.prefix)}${String(i + 1).padStart(2, '0')}`;
      const b = h.bot(name, [ROUGE], [{ name: 'iron_sword', count: 1 }, ...(kit === 'guard' ? [{ name: 'shield', count: 1 }] : [])], [kit]);
      b.entity.position = new Vec3(x + i, 64, -300);
      generals.spawned(String(d.request), name);
      generals.arrived(String(d.request), name);
      return b;
    });
  };
  const events = (kind: string) => generals.events(g).since(0).filter((e) => e.kind === kind);
  const orderOf = (squad: string) => {
    const e = generals['runtime'](g).orders.get(squad);
    return e ? (generals['deps'].runner.get(e.orderId) as Order) : undefined;
  };
  return { h, generals, g, spawn, events, orderOf };
}

test('standing: cavalry gets its kit rules and charges a contact by itself; the model wins for 5 s; a fallback goes away from the enemy', async () => {
  const { generals, g, spawn, events, orderOf } = rig();
  const [c1] = spawn('C', 'horseman', 2);
  await until(() => events('arrived').length > 0, 2000, 'arrived');
  const rt = generals['runtime'](g);
  const runtimeBefore = rt.runtimeOrderTimes.length;
  assert.equal(g.squads.C!.standing!.length, 4);
  assert.match(generals.sitrep(g), /^C 2\/2 horseman2 hp100 line rules4 /m);
  assert.match(generals.squadDetail(g, 'C'), /standing orders: 1\. health below 40% → line @back 24; 2\. contact within 48 → attack on trigger/);

  // An enemy 40 blocks east: the contact rule fires an attack on it, with no model turn.
  const foe = { id: 70, type: 'player', username: 'Hubert', position: new Vec3(141, 64, -300) };
  c1!.entities = { 70: foe };
  generals.sample();
  await until(() => events('standing').length > 0, 2000, 'a standing event');
  assert.match(events('standing')[0]!.text, /^squad C: contact within 48 \(X1\) → squad C: attack #\d+ \(2 melee\) on Hubert @E41/);
  const o = orderOf('C')!;
  assert.equal(o.command.name, 'attack');
  assert.equal(rt.orders.get('C')!.by, 'runtime');
  assert.equal(rt.runtimeOrderTimes.length, runtimeBefore + 1, 'counted on the runtime budget');
  assert.equal(rt.orderTimes.length, 0);

  // The model orders a line: a new enemy within 48 does not override it for RESPECT_MS.
  await generals.order(g, 'C', 'line', '', { pos: 'E10' });
  c1!.entities = { 70: foe, 71: { id: 71, type: 'player', username: 'Other', position: new Vec3(110, 64, -340) } };
  generals.sample();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(orderOf('C')!.command.name, 'line', 'the model first');

  // Health falls under 40%: the fallback line forms 24 blocks beyond where it stands, away from the enemy (west).
  for (const n of g.squads.C!.bots) generals['deps'].pool.bot(n)!.health = 6;
  rt.standing.get('C')!.modelAt = Date.now() - 10_000;
  generals.sample();
  await until(() => events('standing').length > 1, 2000, 'the fallback');
  const fb = events('standing')[1]!.text;
  assert.match(fb, /health below 40% → squad C: line #\d+/, fb);
  const line = orderOf('C')!;
  assert.ok(line.snap.lookBlock!.x < 101 - 20, `the line is west of the squad: ${JSON.stringify(line.snap.lookBlock)}`);
  await generals['deps'].runner.stopAll();
});

test('standing: a foot squad idle with an enemy in sight lines up facing it; an empty list clears the rules', async () => {
  const { generals, g, spawn, events, orderOf } = rig();
  const [a] = spawn('G', 'guard', 2);
  a!.entities = { 70: { id: 70, type: 'player', username: 'Hubert', position: new Vec3(101, 64, -380) } }; // 80 north
  const t = Date.now();
  generals.sample(t);
  generals.sample(t + 5_000);
  assert.equal(events('standing').length, 0, 'not idle long enough');
  generals.sample(t + 9_000);
  await until(() => events('standing').length > 0, 2000, 'the idle rule');
  assert.match(events('standing')[0]!.text, /idle 8s → squad G: line #\d+ \(2 guards\) at E\d+ facing N/);
  assert.ok(Math.abs(orderOf('G')!.snap.yaw - 180) <= 2, `facing north, at the enemy: ${orderOf('G')!.snap.yaw}`);
  assert.match(generals.setStanding(g, 'G', []), /no standing orders/);
  assert.match(generals.setStanding(g, 'G', 'defaults'), /1\. idle 8s → line/);
  await generals['deps'].runner.stopAll();
});
