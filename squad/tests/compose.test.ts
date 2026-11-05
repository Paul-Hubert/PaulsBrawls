// ctx.run that composes (docs/43 C2/C3): a subroutine runs on a view of its caller's bots, which are LENT to it while
// it runs: they leave the caller's arrays ('left', reason 'lent'), the caller's guard no longer drives them, the view's
// events concern its own bots only, a role's unmet `min` no longer throws, and when the subroutine ends (it returns,
// `until()`, a signal) its bots come back to the caller's role ('joined') and its trigger listeners stop. Then the
// example command tests/fixtures/commands/charge.mjs: a line written with the formation helpers whose melee bots charge
// with the stock `attack` as a subroutine, then re-form.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Vec3 } from 'vec3';

import { checkScript } from '../src/script/check';
import { loadStock } from '../src/stock';
import { EMPTY_SNAPSHOT, type Snapshot } from '../src/types';
import { flatWorld, type FakeBot, type FakeItem } from './fakes/fake-bot';
import { harness, PAUL, tick, until } from './fakes/harness';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

const SWORD: FakeItem[] = [{ name: 'iron_sword', count: 1 }];
const BOW: FakeItem[] = [{ name: 'bow', count: 1 }, { name: 'arrow', count: 64 }];

const ROLES = `roles: { melee: { select: { hasItem: 'iron_sword' } }, archers: { select: { hasItem: 'bow' } } }`;

test('ctx.run on squad.roles.melee: the melee bots are lent to it (they leave the caller, whose guard throws "lent"), its events are its own, and they come back to their role when it ends', async () => {
  const h = harness();
  h.bot('Bob', [PAUL], SWORD);
  h.bot('Max', [PAUL], SWORD);
  h.bot('Eve', [PAUL], BOW);
  h.command(PAUL, 'sub', `export const manifest = { summary: 's', roles: { all: { select: {} } } };
export default async function (squad, args, ctx) {
  ctx.log('sub has ' + squad.bots.map((b) => b.username).sort().join(','));
  squad.on('joined', (b) => ctx.log('sub joined ' + b.username));
  await squad.sleep(150);
  return squad.bots.length;
}`);
  h.command(PAUL, 'parent', `export const manifest = { summary: 'p', ${ROLES} };
export default async function (squad, args, ctx) {
  const bob = squad.roles.melee.find((b) => b.username === 'Bob');
  squad.on('left', (b, why) => ctx.log('left ' + b.username + ' ' + why));
  squad.on('joined', (b, role) => ctx.log('joined ' + b.username + ' ' + role));
  const running = ctx.run('sub', {}, { bots: squad.roles.melee });
  await squad.sleep(50);
  ctx.log('during: ' + squad.bots.map((b) => b.username).join(',') + ' melee ' + squad.roles.melee.length);
  try { bob.setControlState('forward', true); ctx.log('drove a lent bot'); } catch (e) { ctx.log('refused: ' + e.message); }
  const n = await running;
  ctx.log('after: melee ' + squad.roles.melee.map((b) => b.username).sort().join(','));
  bob.setControlState('forward', false);
  return 'sub ' + n;
}`);
  const r = await h.order(PAUL, 'parent');
  assert.ok(r.ok, r.text);
  await until(() => h.notices.length > 0, 3_000, 'the end');
  const o = h.runner.get((r as { orderId: string }).orderId)!;
  const logs = o.report.logs;
  assert.equal(h.notices[0]?.text, '[Bots] « parent » terminé : sub 2', logs.join('\n'));
  assert.ok(logs.includes('sub has Bob,Max'), logs.join('\n'));
  assert.ok(logs.includes('left Bob lent') && logs.includes('left Max lent'), logs.join('\n'));
  assert.ok(logs.includes('during: Eve melee 0'), logs.join('\n'));
  assert.ok(logs.includes('refused: Bob is lent to a subroutine of the order (ctx.run)'), logs.join('\n'));
  assert.ok(logs.includes('joined Bob melee') && logs.includes('joined Max melee'), logs.join('\n'));
  assert.ok(logs.includes('after: melee Bob,Max'), logs.join('\n'));
  assert.ok(!logs.some((l) => l.startsWith('sub joined')), 'the parent getting its bots back is not the sub\'s event');
});

test('ctx.run: a role whose min is not met runs with what it has (it used to throw); `until` ends it from outside: undefined, the bots back, its trigger listener gone', async () => {
  const h = harness();
  h.bot('Bob', [PAUL], SWORD);
  h.bot('Eve', [PAUL], BOW);
  h.command(PAUL, 'needy', `export const manifest = { summary: 'n', roles: { archers: { select: { hasItem: 'bow' }, min: 3 } }, duration: 'until-stopped' };
export default async function (squad, args, ctx) {
  ctx.commander.on('trigger', () => ctx.log('needy heard a click'));
  ctx.log('needy runs with ' + squad.roles.archers.length);
  squad.crew(async (bot) => { bot.setControlState('jump', true); await squad.sleep(50); });
  await squad.untilStopped();
  return 'never';
}`);
  h.command(PAUL, 'parent', `export const manifest = { summary: 'p', ${ROLES}, duration: 'until-stopped' };
export default async function (squad, args, ctx) {
  let stop = false;
  ctx.commander.on('trigger', () => { stop = true; });
  const r = await ctx.run('needy', {}, { until: () => stop });
  ctx.log('needy returned ' + r + '; archers ' + squad.roles.archers.length + ', bots ' + squad.bots.length);
  await squad.untilStopped();
}`);
  const r = await h.runner.trigger({ commander: PAUL, command: 'parent', tokens: [], snap: { ...EMPTY_SNAPSHOT, trigger: { kind: 'use', item: 'stick' } } });
  assert.ok(r.ok, r.text);
  const o = h.runner.get((r as { orderId: string }).orderId)!;
  await until(() => o.report.logs.includes('needy runs with 1'), 2_000, 'needy running');
  await tick(150);
  const d = await h.runner.trigger({ commander: PAUL, command: 'parent', tokens: [], snap: { ...EMPTY_SNAPSHOT, trigger: { kind: 'use', item: 'stick' } } });
  assert.ok('delivered' in d && d.delivered);
  await until(() => o.report.logs.some((l) => l.startsWith('needy returned')), 2_000, 'needy ended');
  assert.ok(o.report.logs.includes('needy returned undefined; archers 1, bots 2'), o.report.logs.join('\n'));
  assert.ok(o.report.logs.some((l) => /role "archers" has 1 bot\(s\) of its min 3/.test(l)), o.report.logs.join('\n'));
  const heard = o.report.logs.filter((l) => l === 'needy heard a click').length;
  await h.runner.trigger({ commander: PAUL, command: 'parent', tokens: [], snap: { ...EMPTY_SNAPSHOT, trigger: { kind: 'use', item: 'stick' } } });
  await tick(50);
  assert.equal(o.report.logs.filter((l) => l === 'needy heard a click').length, heard, 'no click reaches an ended subroutine');
  assert.equal(o.status, 'running');
  const eve = h.pool.bots.get('Eve')!;
  eve.controlState.jump = false;
  await tick(200);
  assert.equal(eve.controlState.jump, false, "the ended subroutine's crew no longer drives Eve");
  await h.runner.stopAll();
});

test('ctx.run live view: a melee bot reclaimed by another order mid-subroutine and given back is lent to the subroutine again', async () => {
  const h = harness();
  h.bot('Bob', [PAUL], SWORD);
  h.bot('Eve', [PAUL], BOW);
  h.command(PAUL, 'hold', `export const manifest = { summary: 'h', duration: 'until-stopped' };
export default async function (squad, args, ctx) {
  squad.on('joined', (b) => ctx.log('hold got back ' + b.username));
  squad.on('left', (b, why) => ctx.log('hold lost ' + b.username + ' ' + why));
  await squad.untilStopped();
}`);
  h.command(PAUL, 'parent', `export const manifest = { summary: 'p', ${ROLES}, duration: 'until-stopped' };
export default async function (squad, args, ctx) {
  await ctx.run('hold', {}, { bots: squad.roles.melee });
}`);
  h.command(PAUL, 'grab', `export const manifest = { summary: 'g', roles: { all: { select: { name: 'Bob' }, take: 'reclaim' } } };
export default async function (squad) { await squad.sleep(100); return 'ok'; }`);
  const r = await h.order(PAUL, 'parent');
  assert.ok(r.ok, r.text);
  const o = h.runner.get((r as { orderId: string }).orderId)!;
  await tick(50);
  const g = await h.order(PAUL, 'grab');
  assert.ok(g.ok, g.text);
  await until(() => o.report.logs.includes('hold got back Bob'), 3_000, 'Bob back in the subroutine');
  assert.ok(o.report.logs.includes('hold lost Bob reclaimed'), o.report.logs.join('\n'));
  await h.runner.stopAll();
});

// -- the example command: a line whose melee charge with `attack`, then re-form -------------------------------------

const stock = await loadStock();
const CHARGE = readFileSync(new URL('./fixtures/commands/charge.mjs', import.meta.url), 'utf8');

test('the example `charge` passes the checks a submitted command does (typecheck against squad.d.ts included)', { timeout: 60_000 }, async () => {
  const r = await checkScript(CHARGE);
  assert.ok(r.ok, r.diagnostics.map((d) => `${d.line}: ${d.message}`).join('\n'));
});

test('the example `charge`: the line forms; a click on a zombie sends the melee at it (attack as a subroutine) while the archer holds its slot; once it is dead the melee walk back onto their exact slots', async () => {
  const h = harness({ stock });
  h.command(PAUL, 'charge', CHARGE);
  const world: Record<string, unknown> = {};
  const players: Record<string, { entity: unknown }> = {};
  let id = 10;
  const add = (name: string, x: number, z: number, items: FakeItem[]): FakeBot => {
    const b = h.bot(name, [PAUL], items);
    b.entity.position = new Vec3(x + 0.5, 64, z + 0.5);
    world[Object.assign(b.entity, { id: id++ }).id] = b.entity;
    players[name] = { entity: b.entity };
    b.entities = world;
    b.players = players;
    b.world = flatWorld(63);
    b.autoWalk = true;
    b.physics({ tickMs: 5 });
    return b;
  };
  const melee = [add('Bob', -2, 0, SWORD), add('Max', 2, 0, SWORD)];
  const archer = add('Eve', 0, -2, BOW);
  const snap = (over: Partial<Snapshot>): Snapshot => ({ ...EMPTY_SNAPSHOT, position: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, ...over });
  const r = await h.runner.trigger({ commander: PAUL, command: 'charge', tokens: [], snap: snap({ lookBlock: { x: 0, y: 63, z: 10, name: 'stone' }, trigger: { kind: 'use', item: 'stick' } }) });
  assert.ok(r.ok, r.text);
  const o = h.runner.get((r as { orderId: string }).orderId)!;
  const flat = (b: FakeBot, p: { x: number; z: number }) => Math.hypot(b.entity.position.x - p.x, b.entity.position.z - p.z);
  try {
    // Facing south (the left is +X), the melee on z 10.5, 1.5 apart, each on its own side; the archer 4 behind: z 6.5.
    const places = new Map([['Bob', { x: -0.25, z: 10.5 }], ['Max', { x: 1.25, z: 10.5 }], ['Eve', { x: 0.5, z: 6.5 }]]);
    const onSlots = () => [...melee, archer].every((b) => flat(b, places.get(b.username)!) <= 0.15);
    await until(onSlots, 4_000, 'the line formed');
    const zombie = { id: 500, type: 'hostile', name: 'zombie', position: new Vec3(0.5, 64, 16.5), isValid: true, height: 1.95 };
    world[zombie.id] = zombie;
    const archerAt = archer.entity.position.clone();
    await h.runner.trigger({ commander: PAUL, command: 'charge', tokens: [], snap: snap({ lookEntity: { id: 500, name: 'zombie', type: 'hostile', position: zombie.position }, trigger: { kind: 'use', item: 'stick' } }) });
    await until(() => melee.every((b) => b.pvp.target === zombie), 3_000, 'both melee bots on the zombie');
    assert.ok(archer.entity.position.distanceTo(archerAt) < 0.2, 'the archer kept its slot');
    zombie.isValid = false;
    delete world[zombie.id];
    await until(() => o.report.logs.some((l) => /^charge 1: Cible abattue \(zombie\)/.test(l)), 4_000, `the charge's end: ${o.report.logs.join(' | ')}`);
    // The melee came back ('joined') and walked onto their exact slots again.
    for (const b of melee) b.entity.position = b.entity.position.offset(0, 0, 3); // where the fight left them
    await until(onSlots, 4_000, 'the melee back on their slots');
    assert.equal(o.status, 'running');
  } finally {
    await h.runner.stopAll();
  }
});
