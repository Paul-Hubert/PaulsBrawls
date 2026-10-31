// Orders bound to items, the runtime side (docs/29 §5.4 items 5 and 6): the trigger route's rules (deliver to a
// listening order, restart one that does not listen, start one that does not run, stop, wait for a start in
// flight), the script API (`ctx.commander.on('trigger')`, `off`, `next`), the report's trigger events, the check
// route, and the snapshot sanitizer. Fakes only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LIMITS } from '../src/config';
import { MAX_TRIGGER_EVENTS } from '../src/orders/order';
import type { TriggerRequest, TriggerResult } from '../src/orders/runner';
import { SquadService } from '../src/service';
import { snapshot } from '../src/http/server';
import { checkScript } from '../src/script/check';
import { EMPTY_SNAPSHOT, type Snapshot, type TriggerKind } from '../src/types';
import type { Player } from '../src/roster';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { ALICE, PAUL, harness, tick, until } from './fakes/harness';

holdEventLoopPerTest();

type H = ReturnType<typeof harness>;

function snap(x: number, kind: TriggerKind = 'use', extra: Partial<Snapshot> = {}): Snapshot {
  return {
    ...EMPTY_SNAPSHOT,
    position: { x, y: 64, z: 0 },
    trigger: { kind, item: kind === 'use' ? 'shield' : 'bow' },
    ...extra,
  };
}

function trigger(h: H, by: Player, command: string, s: Snapshot, extra: Partial<TriggerRequest> = {}): Promise<TriggerResult> {
  return h.runner.trigger({ commander: by, command, tokens: [], snap: s, ...extra });
}

const idOf = (r: TriggerResult): string => ('orderId' in r && r.orderId ? r.orderId : assert.fail(`no order: ${r.text}`));
const triggerEvents = (h: H, id: string) => h.runner.get(id)!.report.events.filter((e) => e.kind === 'trigger');

// Listens with both on() and next(), and logs what it sees.
const LISTEN = `
export const manifest = { summary: 'écouter', duration: 'until-stopped' };
export default async function (squad, args, ctx) {
  const first = ctx.commander.at;
  ctx.log('start ' + (first.trigger ? first.trigger.kind : 'none') + ' x=' + first.position.x);
  ctx.commander.on('trigger', (at) => ctx.log('on ' + at.trigger.kind + ' x=' + at.position.x + ' current=' + (at === ctx.commander.at) + ' first=' + first.position.x));
  while (!squad.stopped) {
    const at = await ctx.commander.next();
    ctx.log('next ' + at.trigger.kind + ' x=' + at.position.x + ' vec=' + (typeof at.position.offset) + ' id=' + (at.trigger.hit?.entity?.id ?? '-'));
  }
}`;

// Never listens.
const DEAF = `
export const manifest = { summary: 'sourd', duration: 'until-stopped' };
export default async function (squad, args, ctx) {
  ctx.log('start x=' + ctx.commander.at.position.x);
  while (!squad.stopped) await squad.sleep(10);
}`;

test('a trigger starts the order when none runs; the script sees at.trigger', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'mur', LISTEN);
  const r = await trigger(h, PAUL, 'mur', snap(5));
  assert.equal(r.ok, true, r.text);
  assert.ok('started' in r && r.started);
  assert.match(r.text, /« mur » lancé \(#1\) : Bob\./);
  const o = h.runner.get(idOf(r))!;
  assert.ok(o.report.logs.includes('start use x=5'), o.report.logs.join('\n'));
  assert.deepEqual(triggerEvents(h, o.id).map((e) => e.outcome), ['started']);
  await h.runner.stopAll();
});

test('a listening order gets the trigger: no restart, at replaced, listener called, next() resolves', async () => {
  const h = harness();
  const bob = h.bot('Bob', [PAUL]);
  h.command(PAUL, 'mur', LISTEN);
  const first = await trigger(h, PAUL, 'mur', snap(5));
  const o = h.runner.get(idOf(first))!;
  assert.equal(o.listening, true);
  const setGoals = bob.calls.filter((c) => c === 'pathfinder.setGoal(null)').length;

  const hit = { position: { x: 9, y: 64, z: 3 }, entity: { id: 42, name: 'zombie', type: 'mob', position: { x: 9, y: 64, z: 3 } } };
  const r = await trigger(h, PAUL, 'mur', snap(7, 'arrow-hit', { trigger: { kind: 'arrow-hit', item: 'bow', hit } }));
  assert.deepEqual(r, { ok: true, text: '', orderId: o.id, delivered: true });
  await until(() => o.report.logs.some((l) => l.startsWith('next ')), 1000, 'next() to resolve');
  assert.ok(o.report.logs.includes('on arrow-hit x=7 current=true first=5'), o.report.logs.join('\n'));
  assert.ok(o.report.logs.includes('next arrow-hit x=7 vec=function id=42'), o.report.logs.join('\n'));
  // Nothing was stopped, granted or reclaimed: same order, same bot, no abort sequence.
  assert.equal(o.status, 'running');
  assert.deepEqual(o.memberNames(), ['Bob']);
  assert.equal(o.report.events.filter((e) => e.kind === 'granted').length, 1);
  assert.equal(bob.calls.filter((c) => c === 'pathfinder.setGoal(null)').length, setGoals);
  assert.equal(o.snap.position.x, 7);
  assert.equal(o.report.snap.position.x, 5, 'the report keeps the start snapshot');
  assert.equal(h.runner.running().length, 1);
  assert.deepEqual(triggerEvents(h, o.id).at(-1), { at: triggerEvents(h, o.id).at(-1)!.at, kind: 'trigger', outcome: 'delivered', trigger: 'arrow-hit', item: 'bow', pos: [9, 64, 3], entity: 'zombie' });
  await h.runner.stopAll();
});

test('with no next() waiting the latest trigger is kept (one slot); next(ms) gives null on timeout; off() unhooks', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'slot', `
export const manifest = { summary: 'slot', duration: 'until-stopped' };
export default async function (squad, args, ctx) {
  const seen = [];
  const fn = (at) => seen.push(at.position.x);
  ctx.commander.on('trigger', fn);
  ctx.log('ready');
  await squad.sleep(150);
  ctx.commander.off('trigger', fn);
  const a = await ctx.commander.next(0);
  const b = await ctx.commander.next(20);
  ctx.log('seen ' + seen.join(',') + ' a=' + (a ? a.position.x : 'null') + ' b=' + (b ? b.position.x : 'null') + ' at=' + ctx.commander.at.position.x);
  while (!squad.stopped) {
    const c = await ctx.commander.next(1000);
    if (c) ctx.log('later ' + c.position.x + ' seen ' + seen.join(','));
  }
}`);
  const r = await trigger(h, PAUL, 'slot', snap(1));
  const o = h.runner.get(idOf(r))!;
  assert.equal((await trigger(h, PAUL, 'slot', snap(2))).text, '');
  assert.equal((await trigger(h, PAUL, 'slot', snap(3))).text, '');
  await until(() => o.report.logs.some((l) => l.startsWith('seen ')), 2000, 'the script to read its slot');
  assert.ok(o.report.logs.includes('seen 2,3 a=3 b=null at=3'), o.report.logs.join('\n'));
  await trigger(h, PAUL, 'slot', snap(4));
  await until(() => o.report.logs.some((l) => l.startsWith('later ')), 1000, 'a later trigger');
  assert.ok(o.report.logs.includes('later 4 seen 2,3'), 'off() removed the listener');
  await h.runner.stopAll();
});

test('a running order that does not listen is restarted with the new snapshot, without an end line', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'sourd', DEAF);
  const a = await trigger(h, PAUL, 'sourd', snap(1));
  assert.ok('started' in a && a.started);
  const old = h.runner.get(idOf(a))!;
  assert.equal(old.listening, false);
  const b = await trigger(h, PAUL, 'sourd', snap(2), { tokens: [] });
  assert.equal(b.ok, true, b.text);
  assert.ok('restarted' in b && b.restarted);
  assert.match(b.text, /« sourd » lancé \(#2\) : Bob\./);
  assert.equal(old.status, 'stopped');
  const fresh = h.runner.get(idOf(b))!;
  assert.equal(fresh.status, 'running');
  assert.deepEqual(fresh.memberNames(), ['Bob']);
  assert.ok(fresh.report.logs.includes('start x=2'));
  assert.deepEqual(triggerEvents(h, fresh.id).map((e) => e.outcome), ['restarted']);
  assert.equal(h.notices.length, 0, `no "« sourd » arrêté." for the restart: ${JSON.stringify(h.notices)}`);
  assert.equal(h.runner.running().length, 1);
  await h.runner.stopAll();
});

test('an order started with /bots order is the binding order too; a trigger of another player never touches it', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.bot('Eve', [ALICE]);
  h.command(PAUL, 'mur', LISTEN);
  h.store.share(PAUL.uuid, 'mur', [ALICE]);
  const o = await h.order(PAUL, 'mur');
  assert.ok(o.ok, o.text);
  const d = await trigger(h, PAUL, 'mur', snap(3));
  assert.ok('delivered' in d && d.delivered && d.orderId === o.orderId);
  const alice = await trigger(h, ALICE, 'Paul:mur', snap(4));
  assert.ok('started' in alice && alice.started, alice.text);
  assert.notEqual(idOf(alice), o.orderId);
  assert.equal(h.runner.get(o.orderId)!.snap.position.x, 3, "Alice's click left Paul's order alone");
  assert.deepEqual(h.runner.get(idOf(alice))!.memberNames(), ['Eve']);
  await h.runner.stopAll();
});

test('stop: true stops the binding order (one line, no end notice); with nothing running it says so', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'mur', LISTEN);
  const none = await trigger(h, PAUL, 'mur', snap(1), { stop: true });
  assert.deepEqual(none, { ok: true, text: '[Bots] Aucun ordre « mur » en cours.', stopped: false });
  const r = await trigger(h, PAUL, 'mur', snap(1));
  const id = idOf(r);
  await trigger(h, PAUL, 'mur', snap(2));
  const s = await trigger(h, PAUL, 'mur', snap(3), { stop: true });
  assert.deepEqual(s, { ok: true, text: '[Bots] « mur » arrêté.', orderId: id, stopped: true });
  const o = h.runner.get(id)!;
  assert.equal(o.status, 'stopped');
  assert.ok(h.leases.isIdle('Bob'));
  assert.equal(h.notices.length, 0, JSON.stringify(h.notices));
  // Journaled with the report at its end: the start, the delivered click, the stop.
  const journaled = h.journal.report(id)!;
  assert.deepEqual(journaled.events.filter((e) => e.kind === 'trigger').map((e) => e.outcome), ['started', 'delivered', 'stopped']);
});

test('the stop gesture still stops an order whose command no longer resolves for the player', async () => {
  const h = harness();
  h.bot('Eve', [ALICE]);
  h.command(PAUL, 'mur', LISTEN);
  h.store.share(PAUL.uuid, 'mur', [ALICE]);
  const r = await trigger(h, ALICE, 'Paul:mur', snap(1));
  const id = idOf(r);
  h.store.unshare(PAUL.uuid, 'mur', [ALICE]);
  const refused = await trigger(h, ALICE, 'Paul:mur', snap(2));
  assert.equal(refused.ok, false);
  assert.match(refused.text, /Paul ne t'a pas partagé « mur »/);
  const s = await trigger(h, ALICE, 'Paul:mur', snap(3), { stop: true });
  assert.deepEqual(s, { ok: true, text: '[Bots] « mur » arrêté.', orderId: id, stopped: true });
});

test('a trigger arriving while a start is in flight waits for it and is delivered, listening or not', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'sourd', DEAF);
  const p1 = trigger(h, PAUL, 'sourd', snap(1, 'arrow-release'));
  const p2 = trigger(h, PAUL, 'sourd', snap(2, 'arrow-hit'));
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok('started' in r1 && r1.started, r1.text);
  assert.deepEqual(r2, { ok: true, text: '', orderId: idOf(r1), delivered: true });
  const o = h.runner.get(idOf(r1))!;
  assert.equal(o.listening, false);
  assert.equal(o.snap.trigger?.kind, 'arrow-hit');
  assert.equal(h.runner.running().length, 1);
  assert.deepEqual(triggerEvents(h, o.id).map((e) => `${e.outcome} ${e.trigger}`), ['started arrow-release', 'delivered arrow-hit']);
  await h.runner.stopAll();
});

test('when the start in flight fails, one waiting trigger starts the order and the others are delivered to it', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.roster.add('Off', [PAUL], 'test', 100); // owned but offline: a role filtered to it cannot be filled
  h.command(PAUL, 'sourd', DEAF.replace("duration: 'until-stopped'", "duration: 'until-stopped', roles: { all: { min: 1 } }"));
  const p1 = trigger(h, PAUL, 'sourd', snap(1), { filters: ['Off'] });
  const p2 = trigger(h, PAUL, 'sourd', snap(2));
  const p3 = trigger(h, PAUL, 'sourd', snap(3));
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.ok, false);
  assert.match(r1.text, /Pas assez de bots pour « sourd »/);
  assert.ok('started' in r2 && r2.started, r2.text);
  assert.deepEqual(r3, { ok: true, text: '', orderId: idOf(r2), delivered: true });
  assert.equal(h.runner.running().length, 1);
  await h.runner.stopAll();
});

test('a /bots order start in flight is waited for as well', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'sourd', DEAF);
  const p1 = h.order(PAUL, 'sourd');
  const p2 = trigger(h, PAUL, 'sourd', snap(2));
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(r1.ok, r1.text);
  assert.deepEqual(r2, { ok: true, text: '', orderId: r1.orderId, delivered: true });
  await h.runner.stopAll();
});

test('trigger events in the report stop at the cap', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'mur', LISTEN);
  const id = idOf(await trigger(h, PAUL, 'mur', snap(0)));
  for (let i = 1; i <= MAX_TRIGGER_EVENTS + 10; i++) {
    const r = await trigger(h, PAUL, 'mur', snap(i));
    assert.ok('delivered' in r && r.delivered);
  }
  const o = h.runner.get(id)!;
  assert.equal(triggerEvents(h, id).length, MAX_TRIGGER_EVENTS);
  assert.equal(o.snap.position.x, MAX_TRIGGER_EVENTS + 10, 'delivery goes on past the cap');
  await h.runner.stopAll();
  assert.equal(h.journal.report(id)!.events.filter((e) => e.kind === 'trigger').length, MAX_TRIGGER_EVENTS);
});

test('a throwing trigger listener fails its own order and nothing else', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.bot('Eve', [PAUL]);
  h.command(PAUL, 'fragile', `
export const manifest = { summary: 'f', duration: 'until-stopped' };
export default async function (squad, args, ctx) {
  ctx.commander.on('trigger', (at) => { throw new Error('boom at ' + at.position.x); });
  await squad.untilStopped();
}`);
  h.command(PAUL, 'mur', LISTEN);
  const f = await trigger(h, PAUL, 'fragile', snap(1), { filters: ['Bob'] });
  const m = await trigger(h, PAUL, 'mur', snap(1), { filters: ['Eve'] });
  await trigger(h, PAUL, 'fragile', snap(6));
  await until(() => h.notices.some((n) => /« fragile » a échoué : boom at 6/.test(n.text)), 1000, 'fragile to fail');
  assert.equal(h.runner.get(idOf(f))!.status, 'failed');
  assert.equal(h.runner.get(idOf(m))!.status, 'running');
  await h.runner.stopAll();
});

test('next() rejects with OrderStoppedError when the order stops', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'wait', `
export const manifest = { summary: 'w', duration: 'until-stopped' };
export default async function (squad, args, ctx) {
  try { await ctx.commander.next(); } catch (e) { ctx.log('caught ' + e.name + ' ' + (e instanceof OrderStoppedError)); throw e; }
}`);
  const id = idOf(await trigger(h, PAUL, 'wait', snap(1)));
  await tick(5);
  await h.runner.stop(PAUL, false, 'wait');
  const o = h.runner.get(id)!;
  await until(() => o.report.logs.some((l) => l.startsWith('caught')), 1000, 'the rejection');
  assert.ok(o.report.logs.includes('caught OrderStoppedError true'), o.report.logs.join('\n'));
  assert.equal(o.status, 'stopped');
});

test('a ctx.run subroutine shares the commander: its next() makes the order listen and gets the trigger', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'viser', `
export const manifest = { summary: 'v' };
export default async function (squad, args, ctx) {
  const at = await ctx.commander.next(2000);
  return at ? at.trigger.kind + ' ' + at.position.x + ' ' + ctx.commander.at.position.x : 'rien';
}`);
  h.command(PAUL, 'parent', `
export const manifest = { summary: 'p' };
export default async function (squad, args, ctx) {
  const sub = await ctx.run('viser', {});
  return 'sub ' + sub + ' / parent ' + ctx.commander.at.position.x;
}`);
  const id = idOf(await trigger(h, PAUL, 'parent', snap(1)));
  await until(() => h.runner.get(id)!.listening, 1000, 'the sub to listen');
  const d = await trigger(h, PAUL, 'parent', snap(8, 'arrow-hit'));
  assert.ok('delivered' in d && d.delivered);
  await until(() => h.notices.length > 0, 1000, 'the end');
  assert.equal(h.notices[0]?.text, '[Bots] « parent » terminé : sub arrow-hit 8 8 / parent 8');
});

test('the reference types the trigger API: a command using it typechecks clean', { timeout: 60_000 }, async () => {
  const r = await checkScript(`export const manifest = { summary: 'x', duration: 'until-stopped' };
export default async function (squad, args, ctx) {
  const onClick = (at) => ctx.log(at.trigger ? at.trigger.kind + ' ' + at.trigger.item : 'none', at.yaw, at.position.offset(0, 1, 0));
  ctx.commander.on('trigger', onClick);
  ctx.commander.off('trigger', onClick);
  while (!squad.stopped) {
    const at = await ctx.commander.next(5000);
    if (!at) continue;
    const id = at.trigger?.hit?.entity?.id ?? at.lookEntity?.id;
    const target = id !== undefined ? squad.bots[0]?.entities[id] : null;
    ctx.log(at.trigger?.hit?.position.distanceTo(ctx.commander.at.position), target?.name);
  }
}`);
  assert.deepEqual(r.diagnostics, [], JSON.stringify(r.diagnostics, null, 1));
  const bad = await checkScript(`export const manifest = { summary: 'x' };
export default async function (squad, args, ctx) { ctx.commander.on('click', () => 1); await ctx.commander.wait(); }`);
  assert.equal(bad.ok, false);
  // An unknown method blocks the submission; an unknown event is a warning the agent reads (TS2345 is advisory).
  assert.deepEqual(bad.diagnostics.map((d) => `${d.severity} ${d.code}`), ['warning 2345', 'error 2339']);
});

// -- the check route -------------------------------------------------------------------------------------------

function service(h: H): SquadService {
  return new SquadService({ roster: h.roster, pool: h.pool as never, leases: h.leases, claims: h.claims, store: h.store, journal: h.journal, runner: h.runner, limits: DEFAULT_LIMITS });
}

test('check: the canonical name, bad args with the usage, foreign filters, unknown commands', async () => {
  const h = harness({ stock: { garde: { source: `export const manifest = { summary: 'Garder', params: { type: 'object', properties: { radius: { type: 'integer', default: 16 } } } };\nexport default async () => 1;`, summary: 'Garder' } } });
  h.bot('Bob', [PAUL]);
  h.bot('Eve', [ALICE]);
  h.command(ALICE, 'volee', `export const manifest = { summary: 'Une volée', params: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } };\nexport default async () => 1;`);
  h.store.share(ALICE.uuid, 'volee', [PAUL]);
  h.command(PAUL, 'mur', LISTEN);
  const s = service(h);

  assert.deepEqual(await s.checkOrder(PAUL, 'garde', ['8'], ['bob']), { ok: true, text: '[Bots] Ordre « garde » : Garder', command: 'garde', summary: 'Garder' });
  assert.deepEqual(await s.checkOrder(PAUL, 'mur', [], []), { ok: true, text: '[Bots] Ordre « Paul:mur » : écouter', command: 'Paul:mur', summary: 'écouter' });
  const shared = await s.checkOrder(PAUL, 'volee', ['3'], []);
  assert.equal(shared.command, 'Alice:volee');

  const bad = await s.checkOrder(PAUL, 'volee', ['beaucoup'], []);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /^\[Bots\] « count » : nombre attendu, reçu « beaucoup »\. Usage : \/bots order volee <count>$/);
  const missing = await s.checkOrder(PAUL, 'volee', [], []);
  assert.match(missing.text, /il manque « count »/);

  assert.deepEqual(await s.checkOrder(PAUL, 'garde', [], ['Eve']), { ok: false, text: "[Bots] Eve n'est pas un de tes bots." });
  const unknown = await s.checkOrder(PAUL, 'nope', [], []);
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /^\[Bots\] commande inconnue : nope/);
  const notShared = await s.checkOrder(ALICE, 'Paul:mur', [], []);
  assert.match(notShared.text, /Paul ne t'a pas partagé « mur »/);
});

// -- the snapshot sanitizer --------------------------------------------------------------------------------------

test('snapshot(): kinds whitelisted, numbers coerced, strings checked, unknown keys dropped', () => {
  const s = snapshot({
    position: { x: '1.5', y: 64, z: 'nope', w: 9 },
    yaw: '90',
    pitch: null,
    dimension: 'overworld',
    heldItem: 7,
    lookBlock: { x: 1, y: '2', z: 3, name: 'stone', extra: true },
    lookEntity: { id: '17', name: 'zombie', type: 'mob', username: 3, position: { x: 1, y: 2, z: 3 }, evil: 'x' },
    trigger: {
      kind: 'arrow-hit',
      item: 'bow',
      junk: 1,
      hit: { position: { x: '4', y: 5, z: 6 }, entity: { id: 3.5, name: 'Alex', type: 'player', username: 'Alex', position: { x: 4, y: 5, z: 6 } }, more: 2 },
    },
    hacked: true,
  });
  assert.deepEqual(s, {
    position: { x: 1.5, y: 64, z: 0 },
    yaw: 90,
    pitch: 0,
    dimension: 'overworld',
    heldItem: null,
    lookBlock: { x: 1, y: 2, z: 3, name: 'stone' },
    lookEntity: { id: 17, name: 'zombie', type: 'mob', position: { x: 1, y: 2, z: 3 } },
    trigger: { kind: 'arrow-hit', item: 'bow', hit: { position: { x: 4, y: 5, z: 6 }, entity: { name: 'Alex', type: 'player', username: 'Alex', position: { x: 4, y: 5, z: 6 } } } },
  });
  assert.equal(snapshot({ trigger: { kind: 'swing', item: 'sword' } }).trigger, undefined, 'an unknown kind is no trigger');
  assert.deepEqual(snapshot({ trigger: { kind: 'use', item: 5 } }).trigger, { kind: 'use', item: '' });
  assert.equal(snapshot({ lookEntity: 'zombie', lookBlock: [1, 2, 3] }).lookEntity, null);
  assert.equal(snapshot(null), EMPTY_SNAPSHOT);
});
