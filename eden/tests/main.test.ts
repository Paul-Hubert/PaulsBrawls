import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start, guardHostKillers } from '../src/main';
import { MemoryJournal } from './fakes/memory-journal';
import { SkillForbiddenError } from '../src/skills/instrument';

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

test('CRIT-2/R77: guardHostKillers neutralizes the four process host-killers and journals; restore reinstates them', () => {
  const journal = new MemoryJournal();
  let realCalled = false;
  const mark = (): void => { realCalled = true; };
  const target: Record<string, unknown> = { exit: mark, reallyExit: mark, abort: mark, kill: mark };

  const restore = guardHostKillers(journal, target);
  for (const m of ['exit', 'reallyExit', 'abort', 'kill'] as const) {
    assert.throws(
      () => (target[m] as (...a: unknown[]) => unknown)(1),
      (e: unknown) => e instanceof SkillForbiddenError,
      `process.${m} must throw SkillForbiddenError, not kill the host`,
    );
  }
  assert.equal(realCalled, false, 'the real host-killer must never run while guarded');
  assert.equal(journal.events.filter((e) => e.kind === 'system.error').length, 4, 'each blocked call journals system.error');

  restore();
  (target['exit'] as () => void)();
  assert.equal(realCalled, true, 'restore() must reinstate the original method');
});
