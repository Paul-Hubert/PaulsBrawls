// VillageLauncher — unit tests. Drives a FAKE injected pool (no real BotPool, no Minecraft) and a
// recorder bot for the setup commands. The roster is supplied directly (option C: the scenario is loaded
// at boot, so the launcher never touches scenario files).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { VillageLauncher, type PoolLike, type VillageLauncherDeps } from '../src/village-launch';
import type { VillagerConfig } from '../src/config';
import { MemoryJournal } from './fakes/memory-journal';

// ── helpers ──────────────────────────────────────────────────────────────────

class FakeBot {
  readonly chats: string[] = [];
  chat(msg: string): void {
    this.chats.push(msg);
  }
}

class FakePool implements PoolLike {
  starts = 0;
  stops = 0;
  async start(): Promise<void> {
    this.starts++;
  }
  stop(): void {
    this.stops++;
  }
}

const ROSTER: VillagerConfig[] = [
  { name: 'Firmin', role: 'farmer', items: [{ id: 'minecraft:iron_hoe', count: 1 }] },
  { name: 'Bertrand', role: 'guard' },
];

let tmpDir: string;
let dataDir: string;

function makeLauncher(overrides: Partial<VillageLauncherDeps> = {}): {
  launcher: VillageLauncher;
  pool: FakePool;
} {
  const pool = new FakePool();
  const launcher = new VillageLauncher({
    pool,
    villagers: ROSTER,
    avatarName: 'Dieu',
    scenarioName: 'farming-hamlet',
    dataDir,
    journal: new MemoryJournal(),
    spawnDelayMs: 0,
    ...overrides,
  });
  return { launcher, pool };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

test.before(() => {
  tmpDir = join(tmpdir(), `eden-vl-test-${process.pid}`);
  dataDir = join(tmpDir, 'data');
  mkdirSync(join(dataDir, 'bots'), { recursive: true });
});

test.after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── start ─────────────────────────────────────────────────────────────────────

test('start: starts the boot pool and returns the roster', async () => {
  const { launcher, pool } = makeLauncher();
  const result = await launcher.start('farming-hamlet', 0, 0);
  assert.ok(result.ok, result.message);
  assert.equal(pool.starts, 1);
  assert.deepEqual(result.botNames, ['Firmin', 'Bertrand']);
  assert.ok(launcher.isRunning());
});

test('start: a second start while running is a no-op (no double-spawn)', async () => {
  const { launcher, pool } = makeLauncher();
  await launcher.start('farming-hamlet', 0, 0);
  const again = await launcher.start('farming-hamlet', 0, 0);
  assert.ok(again.ok);
  assert.match(again.message, /already running/);
  assert.equal(pool.starts, 1); // NOT 2 — the pool is started once
});

test('start: name mismatching the booted scenario is rejected (reboot to switch)', async () => {
  const { launcher, pool } = makeLauncher();
  const result = await launcher.start('mining-crew', 0, 0);
  assert.equal(result.ok, false);
  assert.match(result.message, /booted scenario is "farming-hamlet"/);
  assert.equal(pool.starts, 0);
});

test('start: a bare boot (no pool) reports no village configured', async () => {
  const { launcher } = makeLauncher({ pool: undefined });
  const result = await launcher.start('farming-hamlet', 0, 0);
  assert.equal(result.ok, false);
  assert.match(result.message, /no village configured/);
});

test('start: any name accepted when no scenario was booted (direct villagers config)', async () => {
  const { launcher, pool } = makeLauncher({ scenarioName: undefined });
  const result = await launcher.start('whatever', 0, 0);
  assert.ok(result.ok, result.message);
  assert.equal(pool.starts, 1);
});

// ── stop ──────────────────────────────────────────────────────────────────────

test('stop: stops the pool when running', async () => {
  const { launcher, pool } = makeLauncher();
  await launcher.start('farming-hamlet', 0, 0);
  const result = await launcher.stop();
  assert.ok(result.ok);
  assert.equal(pool.stops, 1);
  assert.ok(!launcher.isRunning());
});

test('stop: when nothing is running returns ok with no village message', async () => {
  const { launcher, pool } = makeLauncher();
  const result = await launcher.stop();
  assert.ok(result.ok);
  assert.match(result.message, /no village running/);
  assert.equal(pool.stops, 0);
});

// ── restart ───────────────────────────────────────────────────────────────────

test('restart: stops then starts the same pool', async () => {
  const { launcher, pool } = makeLauncher();
  await launcher.start('farming-hamlet', 0, 0);
  const result = await launcher.restart('farming-hamlet', 0, 0);
  assert.ok(result.ok, result.message);
  assert.equal(pool.stops, 1);
  assert.equal(pool.starts, 2); // started for the original start + the restart
});

test('restart: wipes bots/<name>.json for each villager', async () => {
  const { launcher } = makeLauncher();
  writeFileSync(join(dataDir, 'bots', 'Firmin.json'), '{}');
  writeFileSync(join(dataDir, 'bots', 'Bertrand.json'), '{}');

  await launcher.restart('farming-hamlet', 0, 0);

  assert.ok(!existsSync(join(dataDir, 'bots', 'Firmin.json')));
  assert.ok(!existsSync(join(dataDir, 'bots', 'Bertrand.json')));
});

// ── onSpawn — setup commands ──────────────────────────────────────────────────

test('onSpawn: fires spreadplayers + /give for a villager once armed', async () => {
  const { launcher } = makeLauncher();
  await launcher.start('farming-hamlet', 100, 200);
  const bot = new FakeBot();
  launcher.onSpawn('Firmin', bot);
  await tick();
  assert.ok(bot.chats.some((c) => c.includes('/spreadplayers 100 200')), `got: ${bot.chats}`);
  assert.ok(bot.chats.some((c) => c.includes('/give Firmin minecraft:iron_hoe 1')), `got: ${bot.chats}`);
});

test('onSpawn: no /give when the villager has no items', async () => {
  const { launcher } = makeLauncher();
  await launcher.start('farming-hamlet', 0, 0);
  const bot = new FakeBot();
  launcher.onSpawn('Bertrand', bot);
  await tick();
  assert.equal(bot.chats.filter((c) => c.startsWith('/give Bertrand')).length, 0);
});

test('onSpawn: skips the avatar (no setup commands for Dieu)', async () => {
  const { launcher } = makeLauncher();
  await launcher.start('farming-hamlet', 0, 0);
  const bot = new FakeBot();
  launcher.onSpawn('Dieu', bot);
  await tick();
  assert.equal(bot.chats.length, 0);
});

test('onSpawn: does nothing before a start (not armed)', async () => {
  const { launcher } = makeLauncher();
  const bot = new FakeBot();
  launcher.onSpawn('Firmin', bot);
  await tick();
  assert.equal(bot.chats.length, 0);
});

test('onSpawn restart: fires /clear before /give', async () => {
  const { launcher } = makeLauncher();
  await launcher.restart('farming-hamlet', 0, 0);
  const bot = new FakeBot();
  launcher.onSpawn('Firmin', bot);
  await tick();
  const clearIdx = bot.chats.findIndex((c) => c.includes('/clear Firmin'));
  const giveIdx = bot.chats.findIndex((c) => c.includes('/give Firmin'));
  assert.ok(clearIdx !== -1 && giveIdx !== -1, `got: ${bot.chats}`);
  assert.ok(clearIdx < giveIdx, '/clear must precede /give');
});

test('onSpawn start (non-restart): no /clear', async () => {
  const { launcher } = makeLauncher();
  await launcher.start('farming-hamlet', 0, 0);
  const bot = new FakeBot();
  launcher.onSpawn('Firmin', bot);
  await tick();
  assert.ok(!bot.chats.some((c) => c.includes('/clear')), `got: ${bot.chats}`);
});

test('onSpawn: a reconnect does NOT re-issue setup commands (no item duplication)', async () => {
  const { launcher } = makeLauncher();
  await launcher.start('farming-hamlet', 0, 0);
  const bot = new FakeBot();
  launcher.onSpawn('Firmin', bot); // first spawn
  await tick();
  const afterFirst = bot.chats.length;
  launcher.onSpawn('Firmin', bot); // reconnect
  await tick();
  assert.equal(bot.chats.length, afterFirst, 'setup must fire once per start, not per reconnect');
});

test('onSpawn: a fresh start re-arms setup for a reconnecting villager', async () => {
  const { launcher } = makeLauncher();
  await launcher.start('farming-hamlet', 0, 0);
  const bot = new FakeBot();
  launcher.onSpawn('Firmin', bot);
  await tick();
  await launcher.stop();
  await launcher.start('farming-hamlet', 5, 5);
  launcher.onSpawn('Firmin', bot);
  await tick();
  assert.ok(bot.chats.some((c) => c.includes('/spreadplayers 5 5')), `got: ${bot.chats}`);
});
