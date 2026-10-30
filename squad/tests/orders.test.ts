import { test } from 'node:test';
import assert from 'node:assert/strict';

import { holdEventLoopPerTest } from './fakes/keep-alive';
import { ALICE, PAUL, harness, tick, until } from './fakes/harness';

holdEventLoopPerTest();

const GUARD = `
export const manifest = { summary: 'tenir', duration: 'until-stopped' };
export default async function (squad, args, ctx) {
  squad.on('left', (bot, reason) => ctx.log('left ' + bot.username + ' ' + reason));
  squad.on('joined', (bot, role) => ctx.log('joined ' + bot.username + ' ' + role));
  while (!squad.stopped) await squad.sleep(10);
}`;

test('an order runs, returns a French line, and is journaled', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'hello', `
export const manifest = { summary: 'dire bonjour', params: { type: 'object', properties: { n: { type: 'integer', default: 2 } } } };
export default async function (squad, { n }) {
  const r = await squad.parallel(squad.bots, async (bot) => { bot.chat('salut'); return bot.username; });
  return n + ' ' + r.map((x) => x.value).join(',');
}`);
  const r = await h.order(PAUL, 'hello', ['n=3']);
  assert.ok(r.ok, r.text);
  assert.match(r.text, /« hello » lancé \(#1\) : Bob\./);
  await until(() => h.notices.length > 0);
  assert.equal(h.notices[0]?.text, '[Bots] « hello » terminé : 3 Bob');
  assert.deepEqual(h.pool.bots.get('Bob')?.sentChat, ['salut']);
  assert.equal(h.journal.report('1')?.status, 'done');
  assert.ok(h.leases.isIdle('Bob'));
});

test('archers are reclaimed per role while the melee bot stays on the previous order, then return', async () => {
  const h = harness();
  h.bot('Archer1', [PAUL, ALICE], [{ name: 'bow', count: 1 }]);
  h.bot('Brute1', [PAUL, ALICE], [{ name: 'iron_sword', count: 1 }]);
  h.command(PAUL, 'guard', GUARD);
  h.command(ALICE, 'volley', `
export const manifest = {
  summary: 'tirer',
  roles: { archers: { select: { hasItem: 'bow' }, min: 1, take: 'reclaim' }, melee: { select: { hasItem: '_sword' }, take: 'free' } },
};
export default async function (squad) {
  await squad.sleep(30);
  return 'archers ' + squad.roles.archers.map((b) => b.username).join(',') + ' melee ' + squad.roles.melee.length;
}`);
  const g = await h.order(PAUL, 'guard');
  assert.ok(g.ok, g.text);
  const guard = h.runner.get(g.ok ? g.orderId : '')!;
  assert.deepEqual(guard.memberNames().sort(), ['Archer1', 'Brute1']);

  const v = await h.order(ALICE, 'volley');
  assert.ok(v.ok, v.text);
  assert.match(v.text, /Archer1 \(archers\) réquisitionné de #1/);
  assert.deepEqual(guard.memberNames(), ['Brute1']);
  assert.ok(h.notices.some((n) => n.to[0] === PAUL.uuid && /Alice a réquisitionné Archer1 pour « volley »/.test(n.text)));
  // The reclaimed bot ran the abort sequence before the new order used it.
  assert.ok(h.pool.bots.get('Archer1')!.calls.includes('pathfinder.setGoal(null)'));

  await until(() => h.notices.some((n) => /« volley » terminé/.test(n.text)));
  assert.ok(h.notices.some((n) => n.text === '[Bots] « volley » terminé : archers Archer1 melee 0'));
  await until(() => guard.memberNames().length === 2, 1000, 'Archer1 back in guard');
  assert.ok(guard.report.logs.includes('left Archer1 reclaimed'));
  assert.ok(guard.report.logs.includes('joined Archer1 all'));
  await h.runner.stop(PAUL, false, 'guard');
  assert.equal(guard.status, 'stopped');
  assert.ok(h.leases.isIdle('Archer1') && h.leases.isIdle('Brute1'));
});

test('a role below its min refuses the order and reclaims nothing', async () => {
  const h = harness();
  h.bot('Brute1', [PAUL]);
  h.command(PAUL, 'guard', GUARD);
  h.command(PAUL, 'volley', `export const manifest = { summary: 's', roles: { archers: { select: { hasItem: 'bow' }, min: 1, take: 'reclaim' } } };
export default async function () {}`);
  const g = await h.order(PAUL, 'guard');
  const v = await h.order(PAUL, 'volley');
  assert.equal(v.ok, false);
  assert.match(v.text, /Pas assez de bots pour « volley » : archers 0\/1/);
  assert.deepEqual(h.runner.get(g.ok ? g.orderId : '')!.memberNames(), ['Brute1']);
  await h.runner.stopAll();
});

test('tasks: an item whose bot is reclaimed mid-call goes back in the queue and another bot does it', async () => {
  const h = harness();
  const a = h.bot('Ann', [PAUL]);
  h.bot('Ben', [PAUL]);
  h.bot('Cid', [PAUL], [{ name: 'bow', count: 1 }]);
  a.hang = true; // A's goto never finishes on its own
  h.command(PAUL, 'work', `
export const manifest = { summary: 'w', roles: { all: { min: 1 } } };
export default async function (squad) {
  const res = await squad.tasks([1, 2, 3, 4], async (bot, n) => { await bot.pathfinder.goto({ x: n, y: 0, z: 0 }); await squad.sleep(5); return bot.username; });
  return res.map((r) => r.ok ? 'ok' : r.error).join(',');
}`);
  h.command(PAUL, 'grab', `
export const manifest = { summary: 'g', roles: { it: { select: { name: 'Ann' }, min: 1, take: 'reclaim' } } };
export default async function (squad) { await squad.sleep(20); return 'got ' + squad.bots.map((b) => b.username); }`);
  const w = await h.order(PAUL, 'work', [], { filters: ['Ann', 'Ben'] });
  assert.ok(w.ok, w.text);
  await tick(5);
  const grab = await h.order(PAUL, 'grab');
  assert.ok(grab.ok, grab.text);
  a.hang = false;
  await until(() => h.notices.some((n) => /« work » terminé/.test(n.text)), 3000, 'work to end');
  assert.ok(h.notices.some((n) => n.text === '[Bots] « work » terminé : ok,ok,ok,ok'), JSON.stringify(h.notices));
});

test('a script error fails the order with the line and a fix click for the author', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'oops', `export const manifest = { summary: 'x' };
export default async function () {
  await squad.sleep(1);
  undefinedThing.call();
}`.replace('squad.sleep', 'sleep'));
  const r = await h.order(PAUL, 'oops');
  assert.ok(r.ok);
  await until(() => h.notices.length > 0);
  const n = h.notices[0]!;
  assert.match(n.text, /« oops » a échoué : undefinedThing is not defined \(ligne 4\)/);
  assert.deepEqual(n.click, { label: '[Corriger]', command: '/bots fix oops ' });
});

test('a throwing listener fails its own order and nothing else', async () => {
  const h = harness();
  const bob = h.bot('Bob', [PAUL]);
  h.bot('Eve', [PAUL]);
  h.command(PAUL, 'listen', `export const manifest = { summary: 'l', duration: 'until-stopped' };
export default async function (squad) {
  for (const bot of squad.bots) bot.on('ping', () => { throw new Error('boom in ' + bot.username); });
  await squad.untilStopped();
}`);
  h.command(PAUL, 'idle', GUARD);
  const l = await h.order(PAUL, 'listen', [], { filters: ['Bob'] });
  const i = await h.order(PAUL, 'idle', [], { filters: ['Eve'] });
  assert.ok(l.ok && i.ok);
  bob.emit('ping');
  await until(() => h.notices.some((n) => /« listen » a échoué : boom in Bob/.test(n.text)));
  assert.equal(h.runner.get(i.ok ? i.orderId : '')!.status, 'running');
  assert.equal(bob.listenerCount('ping'), 0, 'the listener is removed with the order');
  await h.runner.stopAll();
});

test('a guarded bot kept by a script throws BotLeftError once reclaimed', async () => {
  const h = harness();
  const bob = h.bot('Bob', [PAUL]);
  h.command(PAUL, 'keep', `export const manifest = { summary: 'k', duration: 'until-stopped' };
export default async function (squad, a, ctx) {
  const bot = squad.bots[0];
  while (!squad.stopped) {
    try { bot.chat('tick'); } catch (e) { ctx.log(e.name + ': ' + e.message); return 'lost'; }
    await squad.sleep(15);
  }
}`);
  h.command(PAUL, 'take', `export const manifest = { summary: 't', roles: { all: { min: 1, take: 'reclaim' } } };
export default async function (squad) { await squad.sleep(60); }`);
  const k = await h.order(PAUL, 'keep');
  await tick(20);
  await h.order(PAUL, 'take');
  const keep = h.runner.get(k.ok ? k.orderId : '')!;
  await until(() => keep.status === 'done', 2000, 'keep to end');
  assert.ok(keep.report.logs.some((l) => l === 'BotLeftError: Bob left the order (reclaimed)'), keep.report.logs.join('\n'));
  assert.ok(bob.sentChat.length >= 1);
  await h.runner.stopAll();
});

test('arguments are checked against the manifest and the usage is shown', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'mine', `export const manifest = { summary: 'm', params: { type: 'object', properties: { count: { type: 'integer', minimum: 1 }, block: { type: 'string', default: 'stone' } }, required: ['count'] } };
export default async function (s, a) { return a.count + a.block; }`);
  const bad = await h.order(PAUL, 'mine', ['beaucoup']);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /« count » : nombre attendu, reçu « beaucoup »\. Usage : \/bots order mine <count> \[block=stone\]/);
  const ok = await h.order(PAUL, 'mine', ['5', 'oak_log']);
  assert.ok(ok.ok);
  await until(() => h.notices.length > 0);
  assert.equal(h.notices[0]?.text, '[Bots] « mine » terminé : 5oak_log');
});

test('a time limit ends the order as timeout and frees its bots', async () => {
  const h = harness({ limits: { orderMinutes: 0.001 } });
  h.bot('Bob', [PAUL]);
  h.command(PAUL, 'long', GUARD.replace("duration: 'until-stopped'", "duration: 'bounded'"));
  const r = await h.order(PAUL, 'long');
  assert.ok(r.ok);
  await until(() => h.notices.some((n) => /limite de/.test(n.text)), 2000);
  assert.ok(h.leases.isIdle('Bob'));
});

test('a trial runs a draft on idle bots and returns the report without chat notices', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  const rep = await h.runner.trial({
    author: PAUL,
    name: 'draft',
    source: `export const manifest = { summary: 'd' };
export default async function (squad, a, ctx) { ctx.log('trying'); ctx.say('ignored in chat'); return 'fine'; }`,
    tokens: [],
    snap: { position: { x: 1, y: 2, z: 3 }, yaw: 0, pitch: 0, dimension: 'overworld', heldItem: null, lookBlock: null, lookEntity: null },
    seconds: 5,
  });
  assert.ok(!('error' in rep));
  if (!('error' in rep)) {
    assert.equal(rep.status, 'done');
    assert.equal(rep.result, 'fine');
    assert.ok(rep.logs.includes('trying'));
  }
  assert.equal(h.notices.length, 0);
});

test('ctx.run runs another command on a subset of the bots', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.bot('Eve', [PAUL]);
  h.command(PAUL, 'wave', `export const manifest = { summary: 'w' };
export default async function (squad) { for (const b of squad.bots) b.chat('hi'); return squad.bots.length; }`);
  h.command(PAUL, 'parent', `export const manifest = { summary: 'p' };
export default async function (squad, a, ctx) { const n = await ctx.run('wave', {}, { bots: [squad.bots[0]] }); return 'sub ' + n; }`);
  const r = await h.order(PAUL, 'parent');
  assert.ok(r.ok);
  await until(() => h.notices.length > 0);
  assert.equal(h.notices[0]?.text, '[Bots] « parent » terminé : sub 1');
});

test('acquire mid-run and release back', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.bot('Eve', [PAUL], [], ['scout']);
  h.command(PAUL, 'grow', `export const manifest = { summary: 'g', roles: { main: { select: { name: 'Bob' }, min: 1 } } };
export default async function (squad) {
  const got = await squad.acquire({ select: { tag: 'scout' }, as: 'scouts' });
  const n = squad.bots.length + '/' + squad.roles.scouts.length;
  await squad.release(got[0]);
  return n + ' then ' + squad.bots.length;
}`);
  const r = await h.order(PAUL, 'grow');
  assert.ok(r.ok, r.text);
  await until(() => h.notices.length > 0);
  assert.equal(h.notices[0]?.text, '[Bots] « grow » terminé : 2/1 then 1');
  assert.ok(h.leases.isIdle('Eve'));
});

test('chat is rate-limited per body', async () => {
  const h = harness();
  const bob = h.bot('Bob', [PAUL]);
  h.command(PAUL, 'spam', `export const manifest = { summary: 's' };
export default async function (squad) { for (let i = 0; i < 20; i++) squad.bots[0].chat('m' + i); }`);
  await h.order(PAUL, 'spam');
  await until(() => h.notices.length > 0);
  assert.equal(bob.sentChat.length, 5);
});

test('only the owners may order a bot; @filters must name your bots', async () => {
  const h = harness();
  h.bot('Bob', [PAUL]);
  h.command(ALICE, 'xx', 'export const manifest = { summary: "x" }; export default async () => 1;');
  const r = await h.order(ALICE, 'xx');
  assert.equal(r.ok, false);
  assert.match(r.text, /aucun bot/);
  h.bot('Eve', [ALICE]);
  const f = await h.order(ALICE, 'xx', [], { filters: ['Bob'] });
  assert.match(f.text, /Bob n'est pas un de tes bots/);
});
