import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { until } from './fakes/harness';

const here = fileURLToPath(new URL('.', import.meta.url));

test('the supervisor kills a runtime whose event loop is wedged and starts it again', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'squad-sup-'));
  const counter = join(dir, 'starts.txt');
  const sup = spawn(process.execPath, ['--import', 'tsx', join(here, '..', 'src', 'supervisor.ts'), 'unused.json'], {
    env: {
      ...process.env,
      SQUAD_MAIN: join(here, 'fixtures', 'wedging-child.mjs'),
      SQUAD_HEARTBEAT_TIMEOUT_MS: '1500',
      SQUAD_TEST_COUNTER: counter,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  sup.stdout.on('data', (d) => (out += d));
  sup.stderr.on('data', (d) => (out += d));
  try {
    const starts = () => {
      try {
        return readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    await until(() => starts() >= 2, 20_000, 'a second launch');
    assert.match(out, /killing the runtime: no heartbeat/);
    assert.match(out, /restarting in 1 s/);
  } finally {
    sup.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
