// Riding a horse (src/bots/mount.ts, docs/41): a mounted bot's body walks as on foot, and every physics tick its
// position goes to the server as the horse's move; sneaking (which would dismount it) stays local; the server's
// correction moves the body; off the horse, the eyes and the speed are the player's again.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';

import { freeLook, freeRein, HORSE_SEAT, installRiding, isSneakStart, notchianYaw, PLAYER_EYES, steer } from '../src/bots/mount';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

const SPEED = 'minecraft:movement_speed';

function rider() {
  const b = new FakeBot('Cavalier01', { position: new Vec3(10.5, 70, 0.5) });
  const sent: Array<[string, Record<string, unknown>]> = [];
  Object.assign(b._client, { write: (name: string, params: Record<string, unknown>) => sent.push([name, params]) });
  Object.assign(b.entity, { id: 10, velocity: new Vec3(0, -0.5, 0), onGround: true, eyeHeight: PLAYER_EYES, attributes: { [SPEED]: { value: 0.1, modifiers: [] } } });
  Object.assign(b.registry, { attributesByName: { movementSpeed: { resource: SPEED } } });
  const horse = { id: 30, name: 'horse', type: 'animal', position: new Vec3(10.5, 64, 0.5), isValid: true, attributes: { [SPEED]: { value: 0.3, modifiers: [] } } };
  installRiding(b as never);
  const mount = () => {
    Object.assign(b, { vehicle: horse });
    b.emit('mount');
  };
  const dismount = () => {
    Object.assign(b, { vehicle: null });
    b.emit('dismount', horse);
  };
  const moves = () => sent.filter(([n]) => n === 'vehicle_move').map(([, p]) => p);
  return { b, sent, horse, mount, dismount, moves };
}

test('riding: the body starts where the horse stands, and each physics tick sends it as the horse\'s move, with the rider\'s eyes and the horse\'s speed', () => {
  const { b, horse, mount, moves } = rider();
  b.emit('physicsTick');
  assert.deepEqual(moves(), [], 'on foot: no horse to move');
  mount();
  assert.deepEqual(b.entity.position, horse.position);
  assert.notEqual(b.entity.position, horse.position, 'a copy: the body moves, the horse entity is the server\'s');
  b.entity.position = new Vec3(11, 64, 0.5);
  (b.entity as unknown as { yaw: number }).yaw = Math.PI / 2; // facing west
  b.emit('physicsTick');
  assert.deepEqual(moves(), [{ x: 11, y: 64, z: 0.5, yaw: 90, pitch: 0, onGround: true }]);
  const e = b.entity as unknown as { eyeHeight: number; attributes: Record<string, { value: number }> };
  assert.equal(e.eyeHeight, PLAYER_EYES + HORSE_SEAT);
  assert.ok(Math.abs(e.attributes[SPEED]!.value * 1.3 - 0.3) < 1e-9, 'sprinting, the body goes at the horse\'s speed');
});

test('riding: a sneak packet is not sent (it would dismount the rider); other packets and sneaking on foot are', () => {
  const { b, sent, mount, dismount } = rider();
  const client = b._client as unknown as { write: (n: string, p: Record<string, unknown>) => void };
  mount();
  client.write('player_input', { inputs: { shift: true } });
  client.write('entity_action', { entityId: 10, actionId: 0, jumpBoost: 0 });
  client.write('player_input', { inputs: { shift: false } });
  client.write('arm_animation', { hand: 0 });
  assert.deepEqual(sent.map(([n]) => n), ['player_input', 'arm_animation']);
  dismount();
  client.write('player_input', { inputs: { shift: true } });
  assert.equal(sent.at(-1)![0], 'player_input');
  assert.ok(isSneakStart('entity_action', { actionId: 'start_sneaking' }));
  assert.ok(!isSneakStart('entity_action', { actionId: 1 }));
});

test('riding: the server\'s correction moves the body; off the horse the eyes and speed are the player\'s, and nothing more is sent', () => {
  const { b, mount, dismount, moves } = rider();
  mount();
  b._client.emit('vehicle_move', { x: 3.5, y: 65, z: -2.5, yaw: 0, pitch: 0 });
  assert.deepEqual(b.entity.position, new Vec3(3.5, 65, -2.5));
  dismount();
  const e = b.entity as unknown as { eyeHeight: number; attributes: Record<string, { value: number }> };
  assert.equal(e.eyeHeight, PLAYER_EYES);
  assert.equal(e.attributes[SPEED]!.value, 0.1);
  b.emit('physicsTick');
  assert.deepEqual(moves(), []);
  // A boat (or any mount this does not drive) is not ridden.
  Object.assign(b, { vehicle: { id: 31, name: 'oak_boat', position: new Vec3(0, 63, 0) } });
  b.emit('mount');
  b.emit('physicsTick');
  assert.deepEqual(moves(), []);
});

test('notchianYaw matches mineflayer\'s conversion', () => {
  assert.equal(notchianYaw(0), 180);
  assert.equal(notchianYaw(Math.PI), 0);
  assert.equal(notchianYaw(Math.PI / 2), 90);
  assert.equal(notchianYaw(-Math.PI / 2), 270);
});

test('a free rein: while it is held a rider steers only its heading (the body\'s walk and the horse\'s move), its look is the aim\'s; the release turns the look back; on foot it does nothing', () => {
  const { b, mount, dismount, moves } = rider();
  const e = b.entity as unknown as { yaw: number; moveYaw?: number };
  const looks: Array<[number, number]> = [];
  b.look = (yaw: number, pitch: number) => {
    looks.push([yaw, pitch]);
    e.yaw = yaw;
    return Promise.resolve();
  };
  // On foot: no rein, steering turns the look.
  const none = freeRein(b as never);
  assert.equal(e.moveYaw, undefined);
  steer(b as never, 1);
  assert.deepEqual(looks, [[1, 0]]);
  none();
  mount();
  const pf = (b as unknown as { pathfinder: { steer?: (yaw: number) => void } }).pathfinder;
  assert.equal(typeof pf.steer, 'function', 'installRiding hands the pathfinder its steering');
  e.yaw = Math.PI / 2; // heading west
  const release = freeRein(b as never);
  assert.equal(e.moveYaw, Math.PI / 2, 'the rein keeps the heading it had');
  assert.equal(freeRein(b as never)(), undefined, 'a second rein is a no-op');
  assert.equal(e.moveYaw, Math.PI / 2);
  // The aim looks east, the walk steers north: only the heading turns.
  e.yaw = -Math.PI / 2;
  looks.length = 0;
  pf.steer!(0);
  steer(b as never, 0, true);
  assert.deepEqual(looks, [], 'the look stays the aim\'s');
  assert.equal(e.moveYaw, 0);
  b.emit('physicsTick');
  assert.equal(moves().at(-1)!.yaw, 180, 'the horse faces where it goes (north), not where its rider aims');
  release();
  assert.equal(e.moveYaw, undefined);
  assert.deepEqual(looks, [[0, 0]], 'the look back to the heading');
  // A rein left held when the bot gets off is dropped with the horse.
  freeRein(b as never);
  dismount();
  assert.equal(e.moveYaw, undefined);
});

test('a free look on foot (docs/49): steer turns only the walk (moveYaw), the look stays; the release ends it and leaves the look; an earlier release leaves a later hold alone', () => {
  const b = new FakeBot('Garde01', { position: new Vec3(0.5, 64, 0.5) });
  const e = b.entity as unknown as { yaw: number; moveYaw?: number };
  e.yaw = Math.PI; // facing south
  const first = freeLook(b as never);
  assert.equal(e.moveYaw, Math.PI, 'the walk starts along the look');
  steer(b as never, 0); // the pathfinder turns the walk north
  assert.deepEqual([e.yaw, e.moveYaw], [Math.PI, 0], 'the look stays south, the walk goes north');
  assert.equal(freeLook(b as never)(), undefined, 'a second hold is a no-op');
  assert.equal(e.moveYaw, 0, '…whose release leaves the first alone');
  first();
  assert.equal(e.moveYaw, undefined);
  assert.equal(e.yaw, Math.PI, 'the release leaves the look where it is');
  const later = freeLook(b as never);
  first(); // released again, after a later hold began
  assert.equal(e.moveYaw, Math.PI, 'the later hold is still on');
  later();
  steer(b as never, 1);
  assert.equal(e.yaw, 1, 'no hold: steering turns the look');
});
