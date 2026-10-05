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
import { wireDrives } from '../src/main';
import { MemoryJournal as DrivesJournal } from './fakes/memory-journal';

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

// B3.7 — main.ts wiring of the optional drives (wireDrives): one tracker per villager, restored from journal
// facts. Only built with behavior.drives:true AND a live pool (the wake-up is the reactive deliberation).

test('B3.7: wireDrives fires one wake-up per depleted drive; journal facts restore the drives', () => {
  const journal = new DrivesJournal();
  const woke: string[] = [];
  const drives = wireDrives({ villagers: ['Firmin', 'Alban'], journal, wakeup: (kind, v) => woke.push(`${v}:${kind}`) });
  for (let i = 0; i < 80; i++) drives.tick(); // 100 → 20, below the 25 threshold once
  assert.deepEqual(woke.sort(), ['Alban:lonely', 'Alban:tired', 'Firmin:lonely', 'Firmin:tired']);
  journal.append('villager:Firmin', 'chat.heard', { hearer: 'Firmin', from: 'Alban', text: 'salut', eavesdrop: false });
  journal.append('villager:Firmin', 'skill.run', { skill: 'go-home', villager: 'Firmin', outcome: { ok: true, value: { home: true } } } as never);
  assert.deepEqual(drives.snapshot('Firmin'), { rest: 100, social: 100 });
  assert.deepEqual(drives.snapshot('Alban'), { rest: 20, social: 20 });
  journal.append('villager:Alban', 'skill.run', { skill: 'go-home', villager: 'Alban', outcome: { ok: true, value: { home: false } } } as never);
  assert.equal(drives.snapshot('Alban')!.rest, 20, 'a go-home that had no home to go to restores nothing');
  assert.equal(drives.snapshot('Nobody'), undefined);
});

// Review fix: drives decayed and woke villagers that were not connected (Eden boots, nobody runs /villagers start
// for ~38 min → 20 deliberations against a default snapshot, and the latches stay spent once they connect).
test('drives neither decay nor wake while the villager is offline', () => {
  const journal = new DrivesJournal();
  const woke: string[] = [];
  const online = new Set<string>(['Firmin']);
  const drives = wireDrives({ villagers: ['Firmin', 'Alban'], journal, isConnected: (v) => online.has(v), wakeup: (kind, v) => woke.push(`${v}:${kind}`) });
  for (let i = 0; i < 80; i++) drives.tick();
  assert.deepEqual(woke.sort(), ['Firmin:lonely', 'Firmin:tired']);
  assert.deepEqual(drives.snapshot('Alban'), { rest: 100, social: 100 }, 'an offline villager does not tire');
});
