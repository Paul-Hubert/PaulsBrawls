import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start } from '../src/main';

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
  assert.equal(status.bots, 0);
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
