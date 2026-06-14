import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeBot } from './fakes/fake-bot';
import {
  boundPathfinder,
  abortActiveTasks,
  craftQuiescence,
  waitForInventoryQuiescence,
  installChatInterceptor,
} from '../src/bots/hardening';
import { loadPlugins, AUTO_EAT_OPTS } from '../src/bots/plugins';

test('boundPathfinder bounds thinkTimeout/tickTimeout/searchRadius (R6)', () => {
  const bot = new FakeBot();
  // Upstream defaults are unbounded/high — the canary that we actually changed them.
  assert.equal(bot.pathfinder.searchRadius, -1);
  boundPathfinder(bot);
  assert.equal(bot.pathfinder.thinkTimeout, 2_000);
  assert.equal(bot.pathfinder.tickTimeout, 10);
  assert.equal(bot.pathfinder.searchRadius, 64);
});

test('abortActiveTasks runs the ordered sequence (R4): collect → pvp → pathfinder.stop → setGoal(null) → close window', async () => {
  const bot = new FakeBot();
  bot.openWindow({ id: 7, type: 'minecraft:crafting' }); // a stray window to close last
  await abortActiveTasks(bot);
  // The order is load-bearing: a lone pathfinder.stop() arms a latent flag, so setGoal(null)
  // MUST follow it; pvp/collectblock keep driving the bot until told to stop (R4/R5).
  const seq = bot.calls.filter((c) =>
    /^(collectBlock\.cancelTask|pvp\.stop|pathfinder\.stop|pathfinder\.setGoal\(null\)|closeWindow)$/.test(c),
  );
  assert.deepEqual(seq, [
    'collectBlock.cancelTask',
    'pvp.stop',
    'pathfinder.stop',
    'pathfinder.setGoal(null)',
    'closeWindow',
  ]);
  assert.equal(bot.currentWindow, null, 'stray window closed');
});

test('abortActiveTasks survives missing plugins (R5/R16) — never throws', async () => {
  const bot = new FakeBot() as unknown as Record<string, unknown>;
  // Simulate a bot that never loaded pvp/collectblock/pathfinder.
  bot['pvp'] = undefined;
  bot['collectBlock'] = undefined;
  bot['pathfinder'] = undefined;
  await assert.doesNotReject(abortActiveTasks(bot as never));
});

test('installChatInterceptor drops /-prefixed chat on an op-able mortal run (R25)', () => {
  const bot = new FakeBot();
  const remove = installChatInterceptor(bot);
  bot.chat('hello villagers');
  bot.chat('/op @s'); // a slash command phrased as speech — must be dropped
  bot.chat('  /gamemode creative'); // leading whitespace then slash — still a command
  assert.deepEqual(bot.sentChat, ['hello villagers'], 'only non-command speech lands');
  remove();
  bot.chat('/now-allowed'); // interceptor removed → passes through again
  assert.deepEqual(bot.sentChat, ['hello villagers', '/now-allowed']);
});

test('waitForInventoryQuiescence resolves only after packets settle (R2)', async () => {
  const bot = new FakeBot();
  const quietMs = 60;
  const started = Date.now();
  const done = waitForInventoryQuiescence(bot, { quietMs, timeoutMs: 2_000 });
  // Keep emitting set_slot/window_items packets — each resets the quiet timer.
  bot.packetSetSlot(0, 1, { name: 'oak_planks', count: 4 });
  await new Promise((r) => setTimeout(r, 30));
  bot.packetWindowItems(0, []); // late packet — pushes the settle point out
  await done;
  assert.ok(Date.now() - started >= quietMs, 'did not resolve before the quiet window elapsed');
});

test('craftQuiescence closes the stray window, pauses mutators, then restores (R1–R3)', async () => {
  const bot = new FakeBot();
  bot.openWindow({ id: 9, type: 'minecraft:chest' }); // R1: a stray chest hijacks clicks
  let pausedDuringCraft = false;
  const result = await craftQuiescence(
    bot,
    async () => {
      // Inside the craft: auto-eat disabled + armor-manager paused (R3).
      pausedDuringCraft = bot.autoEat.enabled === false && bot.armorManager.paused === true;
      bot.packetSetSlot(0, 0, { name: 'stick', count: 4 });
      return 'crafted';
    },
    { quietMs: 30, timeoutMs: 1_000 },
  );
  assert.equal(result, 'crafted', 'returns the inner result');
  assert.equal(pausedDuringCraft, true, 'mutators paused during the click sequence (R3)');
  assert.equal(bot.currentWindow, null, 'stray window closed before crafting (R1)');
  assert.equal(bot.autoEat.enabled, true, 'auto-eat restored after (R3)');
  assert.equal(bot.armorManager.paused, false, 'armor-manager resumed after (R3)');
});

test('loadPlugins is individually fallible (R16) and applies auto-eat config verbatim (R17)', () => {
  const bot = new FakeBot();
  const bad = { name: 'bad-plugin' };
  const good = [{ name: 'pvp' }, { name: 'armor' }, { name: 'tool' }, { name: 'collect' }];
  // One plugin throws on load; the rest must still load and a warning is recorded.
  const original = bot.loadPlugin.bind(bot);
  bot.loadPlugin = (p: unknown): void => {
    if (p === bad) throw new Error('boom loading bad-plugin');
    original(p);
  };
  const warnings: string[] = [];
  loadPlugins(bot, {
    plugins: { pvp: good[0], armorManager: bad, tool: good[1], collectBlock: good[2], autoEat: good[3] },
    onWarn: (m) => warnings.push(m),
  });
  // The four good plugins loaded; the bad one did not crash the bot.
  assert.deepEqual(bot.loadedPlugins, [good[0], good[1], good[2], good[3]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /bad-plugin|armorManager/i);
  // R17: auto-eat configured with the verbatim opts, then enabled.
  assert.deepEqual(bot.autoEat.lastOpts, AUTO_EAT_OPTS);
  assert.equal(bot.autoEat.enabled, true);
  // The load-bearing fields, restated (so a silent upstream default shift is caught — R17).
  assert.equal(AUTO_EAT_OPTS.returnToLastItem, true);
  assert.ok(AUTO_EAT_OPTS.bannedFood.includes('poisonous_potato'));
});
