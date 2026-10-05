import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventEmitter } from 'node:events';
import { start, installShutdownHandlers, redactSecrets } from '../src/main';

test('the assembled M0 spine boots, serves /status + /journal, and journals system.boot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eden-host-'));
  const configPath = join(dir, 'eden.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      minecraft: { version: '1.21.1' },
      villagers: [{ name: 'Firmin', role: 'farmer', home: [0, 64, 0], chest: [1, 64, 0] }],
      god: { name: 'Dieu' },
      admin: { port: 0 },
      // an unknown key to prove the config-warning path journals on boot
      skills: { wat: true },
    }),
  );

  const host = await start(configPath, { dataDir: join(dir, '.eden-data') });
  t.after(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const status = (await (await fetch(`http://127.0.0.1:${host.adminPort}/status`)).json()) as any;
  assert.equal(status.botsConnected, 0); // dashboard mission-control shape
  assert.equal(typeof status.uptimeMs, 'number');

  const boot = (await (
    await fetch(`http://127.0.0.1:${host.adminPort}/journal?kinds=system.boot`)
  ).json()) as any;
  assert.equal(boot.events.length, 1);

  const warns = (await (
    await fetch(`http://127.0.0.1:${host.adminPort}/journal?kinds=system.config-warning`)
  ).json()) as any;
  assert.ok(
    warns.events.some((e: { payload: { message: string } }) => e.payload.message.includes('wat')),
    'the unknown config key was journaled as a config-warning',
  );
});

// Bug #17: a real boot had no SIGINT/SIGTERM handler (Ctrl-C left bots logged in and the journal unclosed).
test('installShutdownHandlers: the first signal stops the host once then exits 0; a second forces exit 1', async () => {
  const target = new EventEmitter();
  const exits: number[] = [];
  let stops = 0;
  let release!: () => void;
  const stopped = new Promise<void>((r) => (release = r));
  const detach = installShutdownHandlers(
    () => { stops++; return stopped; },
    target as never,
    (code) => exits.push(code),
  );
  target.emit('SIGTERM');
  target.emit('SIGINT'); // a second signal while stop() is still running
  assert.equal(stops, 1, 'stop runs once');
  assert.deepEqual(exits, [1], 'the second signal forces exit(1)');
  release();
  await stopped;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(exits, [1, 0], 'the graceful stop then exits 0');
  detach();
  assert.equal(target.listenerCount('SIGINT') + target.listenerCount('SIGTERM'), 0, 'detached');
});

// Bug #17: the substring test /key|secret|token|password/ masked token BUDGETS and env-var names in system.boot.
test('redactSecrets masks secret values but keeps budgets and env-var names readable', () => {
  const out = redactSecrets({
    apiKey: 'sk-1', settlementToken: 't', password: 'p', clientSecret: 's', key: 'k',
    apiKeyEnv: 'DEEPSEEK_API_KEY', inputTokenBudget: 48000,
    budget: { perDesk: { critic: { dailyTokens: 100 } } },
    list: [{ token: 'x', maxTokens: 5 }],
  }) as Record<string, any>;
  for (const k of ['apiKey', 'settlementToken', 'password', 'clientSecret', 'key']) assert.equal(out[k], '***', k);
  assert.equal(out.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(out.inputTokenBudget, 48000);
  assert.equal(out.budget.perDesk.critic.dailyTokens, 100);
  assert.deepEqual(out.list, [{ token: '***', maxTokens: 5 }]);
});
