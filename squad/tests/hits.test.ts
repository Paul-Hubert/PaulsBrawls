// The runtime's `meleeHit` event (src/bots/hits.ts) from the packets a 1.21.1 server sends: an unblocked hit is a
// damage_event naming its cause and direct source, a hit the raised shield stopped is entity status 29 naming nobody,
// with the attacker's arm swing (animation 0) just before (a mob) or just after (a player).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';

import { installMeleeHits, STATUS_SHIELD_BLOCK, SWING_LATE_MS } from '../src/bots/hits';
import { FakeBot } from './fakes/fake-bot';
import { tick } from './fakes/harness';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

function guard() {
  const b = new FakeBot('Guard0', { position: new Vec3(0.5, 64, 0.5) });
  Object.assign(b.entity, { id: 10 });
  const zombie = { id: 20, type: 'hostile', name: 'zombie', position: new Vec3(2, 64, 0.5), isValid: true };
  const player = { id: 21, type: 'player', name: 'player', username: 'Enemy', position: new Vec3(0.5, 64, 3), isValid: true };
  const skeleton = { id: 22, type: 'hostile', name: 'skeleton', position: new Vec3(15, 64, 0.5), isValid: true };
  const arrow = { id: 23, type: 'projectile', name: 'arrow', position: new Vec3(1, 65, 0.5), isValid: true };
  b.entities = { 10: b.entity, 20: zombie, 21: player, 22: skeleton, 23: arrow };
  installMeleeHits(b as never);
  const hits: Array<[unknown, { blocked: boolean }]> = [];
  b.on('meleeHit', (attacker: unknown, hit: { blocked: boolean }) => hits.push([attacker, hit]));
  const swing = (entityId: number) => b._client.emit('animation', { entityId, animation: 0 });
  const block = () => b._client.emit('entity_status', { entityId: 10, entityStatus: STATUS_SHIELD_BLOCK });
  // The ids in a damage_event are the entity's id + 1 (0: none).
  const damage = (cause: number, direct: number) => b._client.emit('damage_event', { entityId: 10, sourceTypeId: 0, sourceCauseId: cause + 1, sourceDirectId: direct + 1 });
  return { b, zombie, player, skeleton, arrow, hits, swing, block, damage };
}

test('meleeHit: an unblocked hit by a creature within reach, not by its arrow or from afar', () => {
  const g = guard();
  g.damage(20, 20); // the zombie's arm
  assert.deepEqual(g.hits, [[g.zombie, { blocked: false }]]);
  g.damage(22, 23); // the skeleton's arrow: the direct source is the arrow
  g.damage(22, 22); // a direct hit from 15 blocks is no melee hit
  g.b._client.emit('damage_event', { entityId: 10, sourceTypeId: 0, sourceCauseId: 0, sourceDirectId: 0 }); // a fall
  g.b._client.emit('damage_event', { entityId: 99, sourceTypeId: 0, sourceCauseId: 21, sourceDirectId: 21 }); // someone else hurt
  assert.equal(g.hits.length, 1);
});

test('meleeHit: a hit the shield stopped is the swing nearest the block, a mob before it or a player just after; no swing, no hit', async () => {
  const g = guard();
  g.swing(20);
  g.block();
  await tick(SWING_LATE_MS + 50);
  assert.deepEqual(g.hits, [[g.zombie, { blocked: true }]], "the zombie's swing came with its hit");

  // A player: attack then swing, so the swing comes after the block.
  await tick(500);
  g.block();
  await tick(20);
  g.swing(21);
  await tick(SWING_LATE_MS + 50);
  assert.deepEqual(g.hits[1], [g.player, { blocked: true }]);

  // An arrow on the shield: nobody near swung.
  await tick(500);
  g.swing(22); // the skeleton is 15 blocks off
  g.block();
  await tick(SWING_LATE_MS + 50);
  assert.equal(g.hits.length, 2);
});

test('hurtBy: who hurt the bot, how and from where: melee, an arrow with its shooter, an arrow from an unseen shooter', () => {
  const g = guard();
  const hurt: Array<{ attacker: unknown; kind: string; weapon: string | null; from: { x: number; z: number } | null }> = [];
  g.b.on('hurtBy', (h: (typeof hurt)[number]) => hurt.push(h));
  Object.assign(g.player, { equipment: [{ name: 'iron_sword' }] });
  Object.assign(g.skeleton, { equipment: [{ name: 'bow' }] });
  g.damage(21, 21);
  assert.equal(hurt[0]!.attacker, g.player);
  assert.equal(hurt[0]!.kind, 'melee');
  assert.equal(hurt[0]!.weapon, 'iron_sword');
  g.damage(22, 23); // the skeleton's arrow
  assert.equal(hurt[1]!.attacker, g.skeleton);
  assert.equal(hurt[1]!.kind, 'arrow');
  assert.equal(hurt[1]!.weapon, 'bow');
  assert.equal(hurt[1]!.from!.x, 15);
  // A shooter the bot does not see: back along the arrow's flight (it flies west, so it came from the east).
  Object.assign(g.arrow, { velocity: new Vec3(-2, -0.1, 0) });
  g.damage(77, 23);
  assert.equal(hurt[2]!.attacker, null);
  assert.equal(hurt[2]!.kind, 'arrow');
  assert.equal(hurt[2]!.weapon, 'arrow');
  assert.ok(hurt[2]!.from!.x > 10, JSON.stringify(hurt[2]!.from));
  g.b._client.emit('damage_event', { entityId: 10, sourceTypeId: 0, sourceCauseId: 0, sourceDirectId: 0 }); // a fall: no event
  assert.equal(hurt.length, 3);
});
