import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs, usage, validateManifest, matches } from '../src/script/manifest';
import { CommandStore } from '../src/store/commands';
import { Roster } from '../src/roster';
import { guardBot, unwrap, takeChatToken, type GuardControl } from '../src/orders/guard';
import { BotLeftError } from '../src/api/errors';
import { ClaimRegistry } from '../src/orders/claims';
import { abortActiveTasks } from '../src/bots/hardening';
import { FakeBot } from './fakes/fake-bot';

const P = { uuid: 'p', name: 'Paul' };
const A = { uuid: 'a', name: 'Alice' };

test('manifest: defaults, roles, positional and key=value args, enum and bounds', () => {
  const m = validateManifest({
    summary: 'x',
    params: { type: 'object', properties: { block: { type: 'string', enum: ['stone', 'dirt'], default: 'stone' }, n: { type: 'integer', minimum: 1, maximum: 9, default: 3 }, loud: { type: 'boolean', default: false } } },
  });
  assert.deepEqual(m.roles, { all: { select: {}, min: 1, max: Infinity, take: 'free' } });
  assert.deepEqual(parseArgs(m, []), { block: 'stone', n: 3, loud: false });
  assert.deepEqual(parseArgs(m, ['dirt', '5', 'oui']), { block: 'dirt', n: 5, loud: true });
  assert.deepEqual(parseArgs(m, ['n=7']), { block: 'stone', n: 7, loud: false });
  assert.throws(() => parseArgs(m, ['gravel']), /valeurs possibles : stone, dirt/);
  assert.throws(() => parseArgs(m, ['stone', '12']), /maximum 9/);
  assert.throws(() => parseArgs(m, ['x=1']), /paramètre inconnu « x »/);
  assert.equal(usage('mine', m), '/bots order mine [block=stone] [n=3] [loud=false]');
  assert.throws(() => validateManifest({ summary: 'x', colour: 1 }), /unknown key "colour"/);
});

test('selectors: tags, item substrings, names, not', () => {
  const bot = { name: 'Archer1', tags: ['ranged'], items: ['bow', 'iron_pickaxe'] };
  assert.ok(matches({ hasItem: 'bow' }, bot));
  assert.ok(matches({ hasItem: '_pickaxe', tag: 'ranged' }, bot));
  assert.ok(!matches({ not: { hasItem: 'bow' } }, bot));
  assert.ok(matches({ name: ['archer1', 'x'] }, bot));
  assert.ok(!matches({ tag: 'melee' }, bot));
});

test('store: own beats shared beats stock; owner:NAME; versions are append-only; delete removes for everyone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'squad-store-'));
  try {
    const s = new CommandStore(dir, { defend: { source: 'stock', summary: 'Défendre' } });
    assert.equal(s.resolve(P.uuid, 'defend').stock, true);
    s.addVersion(P, 'defend', 'v1', { request: 'r', summary: 'mine' });
    assert.equal(s.resolve(P.uuid, 'defend').source, 'v1');
    assert.equal(s.resolve(A.uuid, 'defend').stock, true);
    assert.throws(() => s.resolve(A.uuid, 'paul:defend'), /ne t'a pas partagé/);
    s.share(P.uuid, 'defend', [A]);
    assert.equal(s.resolve(A.uuid, 'defend').source, 'v1');
    assert.equal(s.resolve(A.uuid, 'squad:defend').stock, true);
    assert.equal(s.addVersion(P, 'defend', 'v2', { request: 'fix', summary: 'mine' }), 2);
    s.revert(P.uuid, 'defend', 1);
    assert.equal(new CommandStore(dir).resolve(A.uuid, 'paul:defend').source, 'v1'); // persisted
    s.delete(P.uuid, 'defend');
    assert.equal(s.resolve(A.uuid, 'defend').stock, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('roster: names, owners, tags, persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'squad-roster-'));
  try {
    const f = join(dir, 'roster.json');
    const r = new Roster(f);
    r.add('Archer1', [P, A], 'admin', 10);
    assert.throws(() => r.add('archer1', [P], 'admin', 10), /existe déjà/);
    assert.throws(() => r.add('ab', [P], 'admin', 10), /invalide/);
    r.tag('ARCHER1', ['+Ranged', 'scout', '-scout']);
    assert.throws(() => r.removeOwners('Archer1', [P, A]), /au moins un propriétaire/);
    const again = new Roster(f);
    assert.deepEqual(again.get('archer1')?.tags, ['ranged']);
    assert.ok(again.isOwner('Archer1', 'a'));
    assert.deepEqual(again.botsOf('p').map((b) => b.name), ['Archer1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function control(live: { v: boolean }, log: string[] = []): GuardControl {
  return {
    check: () => {
      if (!live.v) throw new BotLeftError('Bob', 'reclaimed');
    },
    live: () => live.v,
    leftError: () => new BotLeftError('Bob', 'reclaimed'),
    addListener: (_e, _ev, fn) => fn,
    takeListener: () => undefined,
    log: (l) => log.push(l),
    order: 'the-order',
    tags: () => ['ranged'],
    role: () => 'archers',
  };
}

test('guard: calls check the lease, reads pass, plugins are guarded, a late rejection becomes BotLeftError', async () => {
  const real = new FakeBot('Bob');
  const live = { v: true };
  const g = guardBot(real as never, control(live));
  assert.equal(unwrap(g), real);
  assert.deepEqual((g as unknown as { tags: string[] }).tags, ['ranged']);
  assert.equal((g as unknown as { role: string }).role, 'archers');
  assert.throws(() => (g as unknown as { quit(): void }).quit(), /not allowed in a command/);
  assert.throws(() => (g as unknown as { removeAllListeners(): void }).removeAllListeners(), /runtime's own listeners/);
  real.hang = true;
  const pending = (g as unknown as { pathfinder: { goto(x: unknown): Promise<void> } }).pathfinder.goto({ x: 1, y: 2, z: 3 });
  live.v = false;
  real.pathfinder.setGoal(null); // what the abort sequence does
  await assert.rejects(pending, BotLeftError);
  assert.equal((g as unknown as { username: string }).username, 'Bob'); // reads still pass
  assert.throws(() => (g as unknown as { chat(m: string): void }).chat('x'), BotLeftError);
  assert.throws(() => (g as unknown as { pathfinder: { setGoal(x: null): void } }).pathfinder.setGoal(null), BotLeftError);
});

test('chat tokens: 5 quick, then one per 1.2 s', () => {
  const body = {};
  const t0 = 1_000_000;
  const quick = [0, 1, 2, 3, 4, 5].map(() => takeChatToken(body, t0));
  assert.deepEqual(quick, [true, true, true, true, true, false]);
  assert.equal(takeChatToken(body, t0 + 1_300), true);
});

test('claims are per order, expire, and are released together', () => {
  let now = 0;
  const c = new ClaimRegistry(() => now);
  assert.ok(c.claim('k', '1', 10));
  assert.ok(!c.claim('k', '2', 10));
  assert.ok(c.claim('k', '1', 10));
  now = 11_000;
  assert.ok(c.claim('k', '2', 10));
  c.releaseAll('2');
  assert.ok(c.claim('k', '3'));
});

test('the abort sequence runs in order and restores the default movements', async () => {
  const b = new FakeBot('Bob');
  b.currentWindow = { id: 1 };
  await abortActiveTasks(b as never, 'default-movements');
  assert.deepEqual(b.calls, [
    'collectBlock.cancelTask', 'pvp.stop', 'hawkEye.stop', 'pathfinder.stop', 'pathfinder.setGoal(null)',
    'stopDigging', 'deactivateItem', 'clearControlStates', 'closeWindow', 'pathfinder.setMovements',
  ]);
  assert.equal(b.pathfinder.movements, 'default-movements');
});

test('the pathfinder is bounded in search radius, with upstream planning time (docs/29 §16)', async () => {
  const { boundPathfinder } = await import('../src/bots/hardening');
  const b = new FakeBot('Bob');
  boundPathfinder(b as never);
  assert.equal(b.pathfinder.thinkTimeout, 5_000);
  assert.equal(b.pathfinder.searchRadius, 64);
});
