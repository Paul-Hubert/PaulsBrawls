// squad.json → a validated, fully defaulted config (docs/29 §2). The token never has to be in the file: the
// environment variable wins, so the same secret can be exported once for the mod and the runtime.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const TOKEN_ENV = 'PAULSBRAWLS_SQUAD_TOKEN';

export interface Limits {
  /** Bots in the roster, all owners together. */
  maxBots: number;
  /** Default wall clock of a `bounded` order, and the ceiling a manifest's maxMinutes may ask for. */
  orderMinutes: number;
  maxOrderMinutes: number;
  /** Wall clock of an `until-stopped` order. */
  maxStandingMinutes: number;
  /** One authoring trial run, and how many a turn may start. */
  trialSeconds: number;
  maxTrialsPerTurn: number;
  /** An authoring ticket dies after this long even if its turn is still running. */
  ticketMinutes: number;
  /** A manual ticket (`/bots ticket`). */
  manualTicketMinutes: number;
  /** Lease-stack depth per bot (§6.1). */
  maxLeaseDepth: number;
  /** `ctx.run` nesting. */
  maxCallDepth: number;
  /** Lines of a submitted command. */
  maxScriptLines: number;
}

export interface SquadConfig {
  minecraft: { host: string; port: number; version: string };
  /** Loopback port of the control API, the SSE stream and the MCP server. */
  port: number;
  token: string;
  dataDir: string;
  limits: Limits;
  /** Milliseconds between two bot logins (I1: a burst trips the server's login throttle). */
  loginStaggerMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBots: 30,
  orderMinutes: 10,
  maxOrderMinutes: 60,
  maxStandingMinutes: 120,
  trialSeconds: 60,
  maxTrialsPerTurn: 3,
  ticketMinutes: 30,
  manualTicketMinutes: 120,
  maxLeaseDepth: 4,
  maxCallDepth: 8,
  maxScriptLines: 400,
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Validate a parsed squad.json (tests pass objects directly). */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env, baseDir = process.cwd()): SquadConfig {
  if (!raw || typeof raw !== 'object') throw new ConfigError('squad.json: expected an object');
  const o = raw as Record<string, unknown>;
  const mc = (o.minecraft ?? {}) as Record<string, unknown>;
  const host = typeof mc.host === 'string' && mc.host ? mc.host : '127.0.0.1';
  const port = num(mc.port, 25565, 'minecraft.port');
  const token = (env[TOKEN_ENV] ?? '').trim() || (typeof o.token === 'string' ? o.token.trim() : '');
  if (!token) {
    throw new ConfigError(
      `no token: set ${TOKEN_ENV} (the mod's squad.properties "token") or "token" in squad.json`,
    );
  }
  const limitsRaw = (o.limits ?? {}) as Record<string, unknown>;
  const limits = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(DEFAULT_LIMITS) as Array<keyof Limits>) {
    if (limitsRaw[k] !== undefined) limits[k] = num(limitsRaw[k], DEFAULT_LIMITS[k], `limits.${k}`);
  }
  return {
    minecraft: { host, port, version: typeof mc.version === 'string' ? mc.version : '1.21.1' },
    port: num(o.port, 8772, 'port'),
    token,
    dataDir: resolve(baseDir, typeof o.dataDir === 'string' && o.dataDir ? o.dataDir : '.squad-data'),
    limits,
    loginStaggerMs: num(o.loginStaggerMs, 4_000, 'loginStaggerMs'),
  };
}

export function loadConfig(path: string): SquadConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read ${path}: ${(e as Error).message} (copy squad.example.json to squad.json)`);
  }
  return parseConfig(JSON.parse(text), process.env, resolve(path, '..'));
}

function num(v: unknown, fallback: number, what: string): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ConfigError(`squad.json: ${what} must be a number ≥ 0, got ${JSON.stringify(v)}`);
  return v;
}
