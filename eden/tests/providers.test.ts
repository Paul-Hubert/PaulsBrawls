// providers.ts — unit tests. Covers loadProviders (parse + tier defaults + apiKeyEnv handling +
// error modes) and resolveProvider (lookup + the available-names error message). Pure file IO via a
// temp dir; no network, no LLM. providers.ts stores only the NAME of the key env var, never a key.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnvFile, loadProviders, resolveProvider } from '../src/providers';

let tmpDir: string;
function writeTmp(name: string, content: unknown): string {
  const p = join(tmpDir, name);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

test.before(() => {
  tmpDir = join(tmpdir(), `eden-providers-test-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
});
test.after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

// ── loadProviders ──────────────────────────────────────────────────────────────

test('parses strong/fast tiers + apiKeyEnv (the key env-var NAME, never a key)', () => {
  const path = writeTmp('p.json', {
    openai: {
      strong: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', inputTokenBudget: 48000 },
      fast: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', inputTokenBudget: 16000 },
      apiKeyEnv: 'OPENAI_API_KEY',
    },
  });
  assert.deepEqual(loadProviders(path)['openai'], {
    strong: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', inputTokenBudget: 48000 },
    fast: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', inputTokenBudget: 16000 },
    apiKeyEnv: 'OPENAI_API_KEY',
  });
});

test('tolerates JSONC comments + trailing commas (the shipped providers.json style)', () => {
  const path = writeTmp('jsonc.json', `{
  // a local LM-Studio provider needs no key
  "local": {
    "strong": { "baseUrl": "http://127.0.0.1:1234/v1", "model": "m", "inputTokenBudget": 32000 },
    "fast":   { "baseUrl": "http://127.0.0.1:1234/v1", "model": "m", "inputTokenBudget": 16000 },
    "apiKeyEnv": null,
  },
}`);
  const { local } = loadProviders(path);
  assert.equal(local.apiKeyEnv, null);
  assert.equal(local.strong.inputTokenBudget, 32000);
});

test('missing tier fields fall back to tier defaults (strong 48k / fast 16k, empty url+model)', () => {
  const { bare } = loadProviders(writeTmp('defaults.json', { bare: { apiKeyEnv: 'X' } }));
  assert.deepEqual(bare.strong, { baseUrl: '', model: '', inputTokenBudget: 48000 });
  assert.deepEqual(bare.fast, { baseUrl: '', model: '', inputTokenBudget: 16000 });
  assert.equal(bare.apiKeyEnv, 'X');
});

test('apiKeyEnv is null when absent or non-string (a local provider = no auth header)', () => {
  const presets = loadProviders(writeTmp('noauth.json', {
    local: { strong: {}, fast: {} },                 // no apiKeyEnv at all
    weird: { strong: {}, fast: {}, apiKeyEnv: 123 },  // non-string → coerced to null
  }));
  assert.equal(presets['local'].apiKeyEnv, null);
  assert.equal(presets['weird'].apiKeyEnv, null);
});

test('throws on a non-object root, naming the file', () => {
  assert.throws(() => loadProviders(writeTmp('arr.json', [1, 2, 3])), /must be a JSON object/);
});

test('throws on a non-object entry, naming the entry', () => {
  assert.throws(() => loadProviders(writeTmp('badentry.json', { openai: 'nope' })), /entry "openai".*must be an object/);
});

test('throws on file-not-found', () => {
  assert.throws(() => loadProviders(join(tmpDir, 'does-not-exist.json')));
});

// ── resolveProvider ──────────────────────────────────────────────────────────────

test('resolveProvider returns the named preset', () => {
  const presets = loadProviders(writeTmp('r.json', { openai: { strong: {}, fast: {}, apiKeyEnv: 'K' } }));
  assert.equal(resolveProvider(presets, 'openai').apiKeyEnv, 'K');
});

test('resolveProvider throws listing the available names on an unknown name', () => {
  const presets = loadProviders(writeTmp('r2.json', { openai: { strong: {}, fast: {} }, deepseek: { strong: {}, fast: {} } }));
  assert.throws(() => resolveProvider(presets, 'anthropic'), /unknown provider "anthropic".*openai, deepseek/);
});

test('resolveProvider reports "(none)" when no presets are loaded', () => {
  assert.throws(() => resolveProvider({}, 'whatever'), /\(none\)/);
});

// ── loadEnvFile (R56) ──────────────────────────────────────────────────────────────

test('loadEnvFile loads KEY=value pairs, skips comments + blanks, splits on first =', () => {
  const key1 = `EDEN_TEST_KEY_A_${process.pid}`;
  const key2 = `EDEN_TEST_KEY_B_${process.pid}`;
  delete process.env[key1];
  delete process.env[key2];
  const path = writeTmp('keys.env', `# a comment\n\n${key1}=sk-abc=def\n  ${key2} = plain \n`);
  loadEnvFile(path);
  assert.equal(process.env[key1], 'sk-abc=def'); // only the FIRST = splits; the rest is value
  assert.equal(process.env[key2], 'plain');      // key + value are trimmed
  delete process.env[key1];
  delete process.env[key2];
});

test('loadEnvFile does NOT override an existing env var (real env / pm2 / CI wins)', () => {
  const key = `EDEN_TEST_KEY_C_${process.pid}`;
  process.env[key] = 'from-env';
  loadEnvFile(writeTmp('override.env', `${key}=from-file`));
  assert.equal(process.env[key], 'from-env');
  delete process.env[key];
});

test('loadEnvFile is a silent no-op when the file is absent', () => {
  assert.doesNotThrow(() => loadEnvFile(join(tmpDir, 'no-such-file.env')));
});
