// Config assembly for the live-scenario harness. The base Eden config is derived from the SAME proven
// settings the smoke used (OpenAI strong gpt-4o / fast gpt-4o-mini, debugPrompts on), with the Minecraft
// host/port and RCON creds read from `run/server.properties` (R28 — never hardcode the port/password) so
// the harness follows whatever the dev server is actually bound to. The NO-API-KEY rule (the smoke paid
// for it): the key lives ONLY in process.env.OPENAI_API_KEY; it is never written into the config file.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EdenConfig, VillagerConfig } from '../src/config';

/** RCON + Minecraft connection facts read from run/server.properties. */
export interface ServerProps {
  /** server-port — where the bots connect (R28). */
  mcPort: number;
  rconHost: string;
  rconPort: number;
  rconPassword: string;
}

/** Repo root = two levels up from this file (eden/live-tests/ -> eden/ -> repo root). */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
 * The base config — the proven smoke settings, parameterized by the live server's port. Providers point
 * at OpenAI (the models that worked: strong gpt-4o, fast gpt-4o-mini); auth is env-only. Each scenario
 * supplies its roster and may further mutate via `configure`.
 */
export function baseConfig(props: ServerProps, roster: VillagerConfig[]): EdenConfig {
  return {
    minecraft: { host: '127.0.0.1', port: props.mcPort, version: '1.21.1' },
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
      providers: {
        strong: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', inputTokenBudget: 48000 },
        fast: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', inputTokenBudget: 16000 },
      },
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
