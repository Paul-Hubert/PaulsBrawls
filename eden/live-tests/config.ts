// Config assembly for the live-scenario harness. The base Eden config is derived from the SAME proven
// settings the smoke used, with the Minecraft host/port and RCON creds read from `run/server.properties`
// (R28 — never hardcode the port/password). The LLM provider is selected by name from
// `live-tests/providers.json` (gitignored; copy from providers.example.json). The API key is loaded from
// `api-keys.env` (gitignored; copy from api-keys.example.env) and normalised into OPENAI_API_KEY — the
// only env var LlmClient reads. Keys never appear in the config file or the journal.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EdenConfig, VillagerConfig, ProviderConfig } from '../src/config';

export const DEFAULT_PROVIDER = 'deepseek';

/** RCON + Minecraft connection facts read from run/server.properties. */
export interface ServerProps {
  /** server-port — where the bots connect (R28). */
  mcPort: number;
  rconHost: string;
  rconPort: number;
  rconPassword: string;
}

/** One entry in providers.json — the strong/fast model configs for a named LLM provider. */
export interface LiveProviderEntry {
  strong: ProviderConfig;
  fast: ProviderConfig;
  /** The env var that holds the API key for this provider (null = local, no auth). */
  apiKeyEnv: string | null;
}

export type LiveProviders = Record<string, LiveProviderEntry>;

function liveTestsDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Load live-tests/providers.json (gitignored). If it doesn't exist, error with a clear hint pointing
 * to providers.example.json.
 */
export function loadProviders(): LiveProviders {
  const path = join(liveTestsDir(), '..', 'providers.json');
  if (!existsSync(path)) {
    throw new Error(
      `eden/providers.json not found — copy eden/providers.example.json to providers.json and fill in your model settings`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as LiveProviders;
}

/**
 * Load eden/api-keys.env and merge into process.env. Existing env vars win (so CI can export keys
 * directly and override the file). Safe to call multiple times — once a key is set it stays set.
 */
export function loadApiKeys(): void {
  const path = join(liveTestsDir(), '..', 'api-keys.env');
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
 * Look up a provider entry and normalise its key into process.env.OPENAI_API_KEY (the only variable
 * LlmClient reads as default bearer). Call AFTER loadApiKeys(). Returns the entry so the caller can
 * validate the key was actually found. Throws if the provider name is unknown.
 */
export function setupProviderEnv(providerName: string): LiveProviderEntry {
  const all = loadProviders();
  const entry = all[providerName];
  if (!entry) {
    throw new Error(
      `unknown provider "${providerName}" — known: ${Object.keys(all).join(', ')}. Edit live-tests/providers.json to add it`,
    );
  }
  if (entry.apiKeyEnv && entry.apiKeyEnv !== 'OPENAI_API_KEY') {
    const key = process.env[entry.apiKeyEnv];
    if (key && !process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = key;
  }
  return entry;
}

/** Repo root = two levels up from this file (eden/live-tests/ -> eden/ -> repo root). */
function repoRoot(): string {
  return join(liveTestsDir(), '..', '..');
}

/** Parse the handful of keys we need out of run/server.properties (a flat `key=value` file). */
export function readServerProps(): ServerProps {
  const path = join(repoRoot(), 'run', 'server.properties');
  const text = readFileSync(path, 'utf8');
  const props: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    props[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  const rconEnabled = props['enable-rcon'] === 'true';
  if (!rconEnabled) {
    throw new Error(`live-tests: enable-rcon is not true in ${path} — the harness needs RCON to build the arena`);
  }
  return {
    mcPort: Number(props['server-port'] ?? 25599),
    rconHost: '127.0.0.1',
    rconPort: Number(props['rcon.port'] ?? 25575),
    rconPassword: props['rcon.password'] ?? '',
  };
}

/**
 * The base config parameterised by the live server's port and a named LLM provider. The provider
 * defaults to `deepseek`; each scenario may further mutate via its `configure` callback.
 */
export function baseConfig(props: ServerProps, roster: VillagerConfig[], providerName: string = DEFAULT_PROVIDER): EdenConfig {
  const all = loadProviders();
  const entry = all[providerName];
  if (!entry) {
    throw new Error(
      `unknown provider "${providerName}" — known: ${Object.keys(all).join(', ')}`,
    );
  }
  return {
    minecraft: { host: '127.0.0.1', port: props.mcPort, version: '1.21.1' },
    scenario: undefined,
    provider: undefined,
    apiKeyEnv: entry.apiKeyEnv ?? undefined,
    villagers: roster,
    god: {
      name: 'Dieu',
      gamemode: 'creative',
      authoring: 'villager',
      desks: { critic: { model: 'strong' }, curriculum: { model: 'strong' }, orchestrator: { model: 'fast' } },
      budget: {
        perDesk: { critic: { dailyTokens: null }, curriculum: { dailyTokens: null }, orchestrator: { dailyTokens: null } },
        degradeOnBreach: true,
      },
      combineDesks: false,
      embodiedVerdicts: true,
    },
    behavior: { drives: false },
    llm: {
      providers: { strong: entry.strong, fast: entry.fast },
      maxConcurrent: 3,
      perVillagerCooldownSeconds: 15,
    },
    skills: { runDefaultTimeoutMs: 120000, stallSeconds: 20, maxCallDepth: 8, maxSkillLines: 400, probationRuns: 3, autoQuarantineAfter: 5 },
    settlement: { url: 'http://127.0.0.1:8767/trade/execute' },
    admin: { port: 8770 },
    journal: { vitalsIntervalSeconds: 10, debugPrompts: true, retentionDays: 7 },
  };
}

/**
 * Write the assembled config to `<runDir>/eden.json` and return the path. The file holds NO secret (the
 * API key is env-only); `start()` reads this path. The run dir is under live-tests/.runs/ (gitignored).
 */
export function writeConfig(runDir: string, config: EdenConfig): string {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, 'eden.json');
  // `journal.retentionDays` is parser-DEFAULTED (G1: no input key yet), so writing it back trips a
  // spurious "unknown key" warning at load. Drop it from the file — the parser re-applies the default.
  const { retentionDays: _retentionDays, ...journalForFile } = config.journal;
  const forFile = { ...config, journal: journalForFile };
  writeFileSync(path, JSON.stringify(forFile, null, 2), 'utf8');
  return path;
}
