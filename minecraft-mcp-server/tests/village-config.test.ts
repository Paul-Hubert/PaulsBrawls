import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadVillageConfig } from '../src/village/config.js';

/**
 * Config loading must be LOUD about mistakes: a silently-ignored typo
 * (`max_completion_tokens` for `maxTokens`) once ran a whole village on the
 * 1024-token default while the file said 4096.
 */

function writeRoster(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-config-'));
  const file = path.join(dir, 'village.json');
  fs.writeFileSync(file, JSON.stringify(content), 'utf8');
  return file;
}

const BOT = { name: 'A', role: 'farmer', personality: 'p', home: { x: 0, y: 64, z: 0 } };

test('adopts max_completion_tokens as maxTokens with a warning', (t) => {
  const file = writeRoster({ settings: { llm: { max_completion_tokens: 4096 } }, bots: [BOT] });
  const config = loadVillageConfig(file);
  t.is(config.settings.llm.maxTokens, 4096);
  t.true(config.warnings.some((w) => w.includes('max_completion_tokens')));
});

test('explicit maxTokens wins over the alias', (t) => {
  const file = writeRoster({ settings: { llm: { maxTokens: 2048, max_tokens: 4096 } }, bots: [BOT] });
  const config = loadVillageConfig(file);
  t.is(config.settings.llm.maxTokens, 2048);
  t.true(config.warnings.some((w) => w.includes('max_tokens')));
});

test('warns on and drops unknown settings keys', (t) => {
  const file = writeRoster({ settings: { hartbeatSeconds: 60, llm: { modle: 'gpt-4o-mini' } }, bots: [BOT] });
  const config = loadVillageConfig(file);
  t.is(config.settings.heartbeatSeconds, 180); // default — the typo did not land anywhere
  t.true(config.warnings.some((w) => w.includes("'hartbeatSeconds'")));
  t.true(config.warnings.some((w) => w.includes("'modle'")));
});

test('warns on a very low heartbeat', (t) => {
  const file = writeRoster({ settings: { heartbeatSeconds: 10 }, bots: [BOT] });
  const config = loadVillageConfig(file);
  t.is(config.settings.heartbeatSeconds, 10); // respected, but flagged
  t.true(config.warnings.some((w) => w.includes('heartbeatSeconds=10')));
});

test('drops a malformed home with a warning (anchors self-heal at boot)', (t) => {
  const file = writeRoster({ bots: [{ ...BOT, home: { x: 0, y: 'sixty-four', z: 0 } }] });
  const config = loadVillageConfig(file);
  t.is(config.bots[0].home, undefined);
  t.true(config.warnings.some((w) => w.includes('malformed home')));
});

test('drops a malformed chest with a warning instead of crashing later', (t) => {
  const file = writeRoster({ bots: [{ ...BOT, chest: { x: 1, y: null, z: 2 } }] });
  const config = loadVillageConfig(file);
  t.is(config.bots[0].chest, undefined);
  t.true(config.warnings.some((w) => w.includes('malformed chest')));
});

test('a clean roster produces no warnings', (t) => {
  const file = writeRoster({
    settings: { llm: { model: 'gpt-4o-mini', maxTokens: 4096 }, heartbeatSeconds: 180 },
    bots: [{ ...BOT, workstation: { x: 1, y: 64, z: 1 }, chest: { x: 2, y: 64, z: 2 } }],
  });
  const config = loadVillageConfig(file);
  t.deepEqual(config.warnings, []);
});
