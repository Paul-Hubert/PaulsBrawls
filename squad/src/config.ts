// squad.json → a validated, fully defaulted config (docs/29 §2). The token never has to be in the file: the
// environment variable wins, so the same secret can be exported once for the mod and the runtime.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

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

/** Process-wide pathfinding settings, applied once at start (applyPathfinding). */
export interface PathfindingConfig {
  /**
   * The A* time all bots together may spend per 50 ms window (mineflayer-pathfinder's AStar.setBudget, added by
   * patches/). A search that finds the window spent waits for the next one with its best partial path. 0 = no budget.
   * Default 20 ms (DEFAULT_ASTAR_BUDGET_MS): measured better than no budget in every moving phase at 10-30 bots
   * (docs/31 §11): uncapped searches fill the loop, slow every bot down, and time out more.
   */
  astarBudgetMs: number;
}

/** The A* budget when squad.json sets none (docs/31 §11). */
export const DEFAULT_ASTAR_BUDGET_MS = 20;
/** A budget above the 50 ms window would never bind. */
export const MAX_ASTAR_BUDGET_MS = 50;

/**
 * The reader workers (docs/37 §2.5, src/jobs/): the read-only calculations (aim, raycasts, line of sight, A*, block
 * searches, as docs/37's phases add them) run there in batches, each worker with a CPU budget per 50 ms tick.
 */
export interface WorkersConfig {
  /**
   * Reader worker threads (each one a thread with its own copy of the registry, ~25 MB, and nothing per chunk: they
   * read the shared world). 0 = off (the default): every search on the main thread. The bots' A* runs there since
   * docs/37 P4. `pathfinding.workers` (docs/32 D's pathfinding worker pool, which P4 replaced) is an alias, read only
   * when `workers.count` is not set: when both are set, `workers.count` wins.
   */
  count: number;
  /** Each worker's CPU budget per 50 ms tick, ms (Paul, 2026-11-01: 40). */
  tickBudgetMs: number;
}

export const DEFAULT_WORKER_TICK_BUDGET_MS = 40;
/** A budget above the 50 ms tick could never be spent. */
export const MAX_WORKER_TICK_BUDGET_MS = 50;
export const MAX_JOB_WORKERS = 16;

/**
 * The shared world (docs/37 P1, src/world/): one copy of the chunks the bots receive, in shared memory, written by
 * one writer thread and readable by every thread.
 */
export interface WorldConfig {
  /**
   * Default: on exactly when the reader workers are (workers.count > 0), since they read it (A*, docs/37 P4). An
   * explicit false with workers on keeps A* on the main thread (main.ts warns); true without workers builds the store
   * for `verify` alone.
   */
  enabled: boolean;
  /** A column no bot holds any more is kept this long (readers see it as unknown) in case a bot receives it again. */
  cacheSeconds: number;
  /** At most this many such columns, oldest dropped first. */
  cacheColumns: number;
  /** Once a second, compare a random sample of the store with the bots' own worlds and log mismatches (debug). */
  verify: boolean;
}

/** `enabled` here is the default without reader workers; with them it defaults to true (parseConfig). */
export const DEFAULT_WORLD: WorldConfig = { enabled: false, cacheSeconds: 60, cacheColumns: 2_000, verify: false };

/**
 * The archers' aim (docs/37 §3, D5; src/aim/): when, in a bow's draw, the aim solver is asked again. The look turns
 * smoothly between two answers and arrives at each on the next update's tick.
 */
export interface AimConfig {
  /**
   * The draw ticks whose aim is solved anew (Paul, 2026-11-01): the start, 500 ms in, the middle four, the four
   * before the release. Integers from 0, increasing, below drawTicks; the first must be 0.
   */
  schedule: number[];
  /** The bow's release tick, from the start of the draw (24: 1.2 s; a bow reaches full power after 20 server ticks). */
  drawTicks: number;
  /**
   * A friend in the low arc's line: try the high arc over it (true), or count the line blocked (false, docs/37 §3:
   * the draw waits for the friend to step out, then « no clear line of fire »). Measured in docs/37 §10.6.
   */
  overFriends: boolean;
}

/** overFriends on: archers lob over a friend in the line (docs/37 D6, Paul 2026-11-01). */
export const DEFAULT_AIM: AimConfig = { schedule: [0, 10, 11, 12, 13, 14, 20, 21, 22, 23], drawTicks: 24, overFriends: true };
/** Below this the arrow leaves before full power (20 server ticks), with a tick of margin. */
export const MIN_DRAW_TICKS = 21;

export interface SquadConfig {
  minecraft: { host: string; port: number; version: string };
  /** Loopback port of the control API, the SSE stream and the MCP server. */
  port: number;
  token: string;
  dataDir: string;
  limits: Limits;
  /**
   * Milliseconds between two bot logins (I1), default 100. Every bot receives its 313 chunk columns at login, so
   * logins all at once stall the event loop (40 at once: up to 1.1 s, docs/36 §6). The Fabric server has no login
   * throttle of its own: 40 logins in 6 s were all accepted.
   */
  loginStaggerMs: number;
  pathfinding: PathfindingConfig;
  workers: WorkersConfig;
  world: WorldConfig;
  aim: AimConfig;
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
  const pathRaw = (o.pathfinding ?? {}) as Record<string, unknown>;
  const astarBudgetMs = num(pathRaw.astarBudgetMs, DEFAULT_ASTAR_BUDGET_MS, 'pathfinding.astarBudgetMs');
  if (astarBudgetMs > MAX_ASTAR_BUDGET_MS) {
    throw new ConfigError(`squad.json: pathfinding.astarBudgetMs is per 50 ms window, so at most ${MAX_ASTAR_BUDGET_MS}, got ${astarBudgetMs}`);
  }
  // pathfinding.workers: the alias of workers.count (docs/37 P4), used when workers.count is not set.
  const alias = num(pathRaw.workers, 0, 'pathfinding.workers');
  if (!Number.isInteger(alias) || alias > MAX_JOB_WORKERS) {
    throw new ConfigError(`squad.json: pathfinding.workers (an alias of workers.count) must be an integer from 0 to ${MAX_JOB_WORKERS}, got ${alias}`);
  }
  const workersRaw = (o.workers ?? {}) as Record<string, unknown>;
  const count = workersRaw.count === undefined || workersRaw.count === null ? alias : num(workersRaw.count, 0, 'workers.count');
  if (!Number.isInteger(count) || count > MAX_JOB_WORKERS) {
    throw new ConfigError(`squad.json: workers.count must be an integer from 0 to ${MAX_JOB_WORKERS}, got ${count}`);
  }
  const tickBudgetMs = num(workersRaw.tickBudgetMs, DEFAULT_WORKER_TICK_BUDGET_MS, 'workers.tickBudgetMs');
  if (tickBudgetMs <= 0 || tickBudgetMs > MAX_WORKER_TICK_BUDGET_MS) {
    throw new ConfigError(`squad.json: workers.tickBudgetMs is per 50 ms tick, so above 0 and at most 50, got ${tickBudgetMs}`);
  }
  const worldRaw = (o.world ?? {}) as Record<string, unknown>;
  const world: WorldConfig = {
    enabled: bool(worldRaw.enabled, count > 0, 'world.enabled'),
    cacheSeconds: num(worldRaw.cacheSeconds, DEFAULT_WORLD.cacheSeconds, 'world.cacheSeconds'),
    cacheColumns: num(worldRaw.cacheColumns, DEFAULT_WORLD.cacheColumns, 'world.cacheColumns'),
    verify: bool(worldRaw.verify, DEFAULT_WORLD.verify, 'world.verify'),
  };
  if (!Number.isInteger(world.cacheColumns)) throw new ConfigError(`squad.json: world.cacheColumns must be an integer, got ${world.cacheColumns}`);
  const aim = parseAim((o.aim ?? {}) as Record<string, unknown>);
  return {
    minecraft: { host, port, version: typeof mc.version === 'string' ? mc.version : '1.21.1' },
    port: num(o.port, 8772, 'port'),
    token,
    dataDir: resolve(baseDir, typeof o.dataDir === 'string' && o.dataDir ? o.dataDir : '.squad-data'),
    limits,
    loginStaggerMs: num(o.loginStaggerMs, 100, 'loginStaggerMs'),
    pathfinding: { astarBudgetMs },
    workers: { count, tickBudgetMs },
    world,
    aim,
  };
}

function parseAim(raw: Record<string, unknown>): AimConfig {
  const drawTicks = num(raw.drawTicks, DEFAULT_AIM.drawTicks, 'aim.drawTicks');
  if (!Number.isInteger(drawTicks) || drawTicks < MIN_DRAW_TICKS || drawTicks > 100) {
    throw new ConfigError(`squad.json: aim.drawTicks must be an integer from ${MIN_DRAW_TICKS} (a full draw) to 100, got ${drawTicks}`);
  }
  const overFriends = bool(raw.overFriends, DEFAULT_AIM.overFriends, 'aim.overFriends');
  if (raw.schedule === undefined || raw.schedule === null) return { schedule: [...DEFAULT_AIM.schedule], drawTicks, overFriends };
  const s = raw.schedule;
  const ok =
    Array.isArray(s) &&
    s.length > 0 &&
    s[0] === 0 &&
    s.every((k, i) => Number.isInteger(k) && (k as number) >= 0 && (k as number) < drawTicks && (i === 0 || (k as number) > (s[i - 1] as number)));
  if (!ok) {
    throw new ConfigError(`squad.json: aim.schedule must be increasing integer ticks from 0, each below aim.drawTicks (${drawTicks}), got ${JSON.stringify(s)}`);
  }
  return { schedule: [...(s as number[])], drawTicks, overFriends };
}

/**
 * Apply the pathfinding settings. They are process-wide (one mineflayer-pathfinder module serves every bot), so this
 * runs once, at start. AStar.setBudget comes from patches/: without it the install skipped patch-package, and the
 * other library fixes are missing too, so it fails loudly instead of running unpatched.
 */
export function applyPathfinding(p: PathfindingConfig): void {
  const astar = require('mineflayer-pathfinder/lib/astar') as { setBudget?: (ms: number) => void };
  if (typeof astar.setBudget !== 'function') {
    throw new ConfigError('mineflayer-pathfinder is not patched (no AStar.setBudget): run npm install in squad/, whose postinstall applies patches/');
  }
  astar.setBudget(p.astarBudgetMs);
}

/**
 * The reader workers this machine gets: the configured count, at most one per core other than the main thread's (a
 * worker that shares the main thread's core takes time from the bots' physics). Logged by the caller when it caps.
 */
export function jobWorkerCount(w: WorkersConfig, cores = availableParallelism()): number {
  return Math.max(0, Math.min(w.count, cores - 1));
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

function bool(v: unknown, fallback: boolean, what: string): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new ConfigError(`squad.json: ${what} must be true or false, got ${JSON.stringify(v)}`);
  return v;
}

function num(v: unknown, fallback: number, what: string): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ConfigError(`squad.json: ${what} must be a number ≥ 0, got ${JSON.stringify(v)}`);
  return v;
}
