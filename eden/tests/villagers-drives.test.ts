// M6-4 — drives (OPTIONAL, gated on behavior.drives). Proofs (plan §4):
//   • with drives:true, rest/social decay → a tired/lonely wake-up (hysteresis);
//   • with drives:false, decay has NO effect (architecture unchanged).
// Self-contained: a DriveTracker decays per `tick()` and fires a wake-up via an INJECTED callback (the
// same decoupling M5's SubscriptionRouter uses — no extension of the frozen EdenEvent union, no change to
// M5's events.ts emitter registry). See PROGRESS.md for the deliberate "minimal, doesn't touch M5"
// decision (the plan sanctions minimal/defer if M6-4 risks destabilizing events.ts).

import test from 'node:test';
import assert from 'node:assert/strict';

import { DriveTracker } from '../src/villagers/drives';

test('M6-4 (off): with drives disabled, decay produces NO wake-up (architecture unchanged)', () => {
  const fired: string[] = [];
  const d = new DriveTracker({
    villager: 'Firmin',
    enabled: false,
    wakeup: (kind) => fired.push(kind),
    restDecayPerTick: 5,
    socialDecayPerTick: 5,
  });
  for (let i = 0; i < 100; i++) d.tick();
  assert.equal(fired.length, 0, 'no drives → no wake-ups, ever');
});

test('M6-4 (tired): with drives enabled, rest decaying below the threshold fires ONE tired wake-up', () => {
  const fired: string[] = [];
  const d = new DriveTracker({
    villager: 'Firmin', enabled: true, wakeup: (kind) => fired.push(kind),
    restDecayPerTick: 10, socialDecayPerTick: 0, tiredBelow: 30, lonelyBelow: 30,
  });
  // rest starts at 100; -10/tick → crosses 30 after 8 ticks.
  for (let i = 0; i < 12; i++) d.tick();
  assert.deepEqual(fired.filter((k) => k === 'tired'), ['tired'], 'exactly one tired wake-up on the crossing (hysteresis)');
});

test('M6-4 (lonely): social decaying below the threshold fires ONE lonely wake-up', () => {
  const fired: string[] = [];
  const d = new DriveTracker({
    villager: 'Firmin', enabled: true, wakeup: (kind) => fired.push(kind),
    restDecayPerTick: 0, socialDecayPerTick: 10, tiredBelow: 30, lonelyBelow: 30,
  });
  for (let i = 0; i < 12; i++) d.tick();
  assert.deepEqual(fired.filter((k) => k === 'lonely'), ['lonely']);
});

test('M6-4 (hysteresis): staying below the threshold does NOT re-fire; recovery re-arms the edge', () => {
  const fired: string[] = [];
  const d = new DriveTracker({
    villager: 'Firmin', enabled: true, wakeup: (kind) => fired.push(kind),
    restDecayPerTick: 10, socialDecayPerTick: 0, tiredBelow: 30, lonelyBelow: 30,
  });
  for (let i = 0; i < 12; i++) d.tick(); // crosses + fires once
  for (let i = 0; i < 5; i++) d.tick();  // still low → NO re-fire
  assert.equal(fired.filter((k) => k === 'tired').length, 1, 'one fire while held below the threshold');

  d.rest(100); // recovered (e.g. slept) → re-arm
  for (let i = 0; i < 12; i++) d.tick(); // decay below again → fires once more
  assert.equal(fired.filter((k) => k === 'tired').length, 2, 'recovery re-arms the edge (a future fire is possible)');
});

test('M6-4 (restore): rest()/socialize() lift the drive back up (the wake-up handler closes the loop)', () => {
  const d = new DriveTracker({ villager: 'Firmin', enabled: true, wakeup: () => {}, restDecayPerTick: 50 });
  d.tick(); // rest 100 → 50
  assert.ok(d.snapshot().rest <= 50);
  d.rest(100);
  assert.equal(d.snapshot().rest, 100, 'rest() restores the drive');
  d.socialize(100);
  assert.equal(d.snapshot().social, 100);
});
