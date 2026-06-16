// Loads and validates providers.json — named LLM provider presets (strong/fast tiers + API key
// env var). Kept separate from config.ts to avoid a cycle: config.ts would need scenario-loader.ts
// would need config.ts. Resolution happens in main.ts (the composition root) after loadConfig.
//
// Dependency: imports only config.ts types (layer 1 sibling) and stdlib.

import { existsSync, readFileSync } from 'node:fs';
import stripJsonComments from 'strip-json-comments';
import type { ProviderConfig } from './config';

/** One entry in providers.json: strong + fast tiers + which env var holds the API key. */
export interface ProviderPreset {
  strong: ProviderConfig;
  fast: ProviderConfig;
  /** Name of the env var that holds the bearer token, e.g. "OPENAI_API_KEY". null = no auth (local). */
  apiKeyEnv: string | null;
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, dflt: string): string => (typeof v === 'string' ? v : dflt);
const num = (v: unknown, dflt: number): number => (typeof v === 'number' ? v : dflt);

function parseProviderConfig(raw: Raw, tier: 'strong' | 'fast'): ProviderConfig {
  const dflt = tier === 'strong'
    ? { baseUrl: '', model: '', inputTokenBudget: 48000 }
    : { baseUrl: '', model: '', inputTokenBudget: 16000 };
  return {
    baseUrl: str(raw['baseUrl'], dflt.baseUrl),
    model: str(raw['model'], dflt.model),
    inputTokenBudget: num(raw['inputTokenBudget'], dflt.inputTokenBudget),
  };
}

/**
 * Parse and validate a providers.json file (Record<name, ProviderPreset>).
 * Throws on file-not-found, JSON parse errors, or a non-object root.
 */
export function loadProviders(path: string): Record<string, ProviderPreset> {
  const text = readFileSync(path, 'utf8');
  const raw: unknown = JSON.parse(stripJsonComments(text, { trailingCommas: true }));
  if (!isObj(raw)) throw new Error(`providers: ${path} must be a JSON object`);
  const result: Record<string, ProviderPreset> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!isObj(entry)) throw new Error(`providers: entry "${name}" in ${path} must be an object`);
    const apiKeyEnvRaw = entry['apiKeyEnv'];
    const apiKeyEnv = typeof apiKeyEnvRaw === 'string' ? apiKeyEnvRaw : null;
    result[name] = {
      strong: parseProviderConfig(isObj(entry['strong']) ? entry['strong'] : {}, 'strong'),
      fast: parseProviderConfig(isObj(entry['fast']) ? entry['fast'] : {}, 'fast'),
      apiKeyEnv,
    };
  }
  return result;
}

/**
 * Load a `KEY=value` env file (eden/api-keys.env) into process.env. Existing env vars WIN — a real
 * environment / pm2 / CI export always overrides the file. No-op when the file is absent. Mirrors
 * live-tests/config.ts `loadApiKeys` so a direct `tsx src/main.ts` boot reads the SAME key file the
 * live-test harness does; without it the production host never read the file, had no DEEPSEEK_API_KEY,
 * and silently sent OPENAI_API_KEY to DeepSeek → a misleading 401 on a key the user never configured
 * (R56). Comments (`#`) and blank lines are skipped; only the first `=` splits key from value.
 */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

/**
 * Look up a named provider from a providers.json record.
 * Throws with a clear message (listing available names) if not found.
 */
export function resolveProvider(presets: Record<string, ProviderPreset>, name: string): ProviderPreset {
  const preset = presets[name];
  if (!preset) {
    const available = Object.keys(presets).join(', ') || '(none)';
    throw new Error(`providers: unknown provider "${name}" — available: ${available}`);
  }
  return preset;
}
