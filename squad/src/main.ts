// The composition root (the only one): config → journal → roster → stock + store → leases, claims → pool → runner →
// service → HTTP. A real boot connects every roster bot (staggered), serves 127.0.0.1:<port>, and beats a heartbeat
// to the supervisor (src/supervisor.ts) when there is one. Crash-only: on boot every order still `running` in the
// journal becomes `interrupted` and its commander is told.

import { join } from 'node:path';

import { applyPathfinding, loadConfig, type SquadConfig } from './config';
import { BotPool, skippedPackets, type BotPoolOptions } from './bots/pool';
import { Journal } from './journal/journal';
import { LeaseManager } from './leases';
import { logger } from './logger';
import { ClaimRegistry } from './orders/claims';
import { OrderRunner } from './orders/runner';
import { Roster } from './roster';
import { SquadService } from './service';
import { CommandStore } from './store/commands';
import { loadStock } from './stock';
import { checkScript } from './script/check';
import { SquadHttp } from './http/server';
import { errorMessage, isBotLeft, isStopped } from './api/errors';
import { LoopMonitor } from './vitals/lag-monitor';
import { Vitals } from './vitals/metrics';

export interface Started {
  service: SquadService;
  http: SquadHttp;
  port: number;
  stop(): Promise<void>;
}

export async function start(
  cfg: SquadConfig,
  opts: { connectBots?: boolean; installGuards?: boolean; pool?: Pick<BotPoolOptions, 'createBot' | 'setup'> } = {},
): Promise<Started> {
  // The loop monitor first: armed later, it would miss the synchronous boot work (opening the journal, loading the
  // stock) that it should see.
  const loop = new LoopMonitor();
  applyPathfinding(cfg.pathfinding);
  const journal = new Journal(join(cfg.dataDir, 'squad.db'));
  const interrupted = journal.markInterrupted();
  const roster = new Roster(join(cfg.dataDir, 'roster.json'));
  const store = new CommandStore(join(cfg.dataDir, 'commands'), await loadStock());
  const leases = new LeaseManager(cfg.limits.maxLeaseDepth);
  const claims = new ClaimRegistry();
  const pool = new BotPool({ host: cfg.minecraft.host, port: cfg.minecraft.port, version: cfg.minecraft.version, staggerMs: cfg.loginStaggerMs, ...opts.pool });
  const runner = new OrderRunner({ pool, roster, leases, claims, store, journal, limits: cfg.limits });
  const vitals = new Vitals({ pool, journal, skipped: skippedPackets, loop });
  const service = new SquadService({ roster, pool, leases, claims, store, journal, runner, limits: cfg.limits, vitals });
  const http = new SquadHttp(service, { port: cfg.port, token: cfg.token });

  vitals.start();
  pool.on('gone', (name: string, reason: 'died' | 'disconnected') => void runner.botGone(name, reason));
  const port = await http.listen();
  logger.info('squad', `control API, events and MCP on http://127.0.0.1:${port} (/api, /events, /mcp/squad)`);

  for (const row of interrupted) {
    if (row.trial) continue;
    http.notice({ to: [row.commander], text: `[Bots] Le runtime des bots a redémarré : « ${row.command} » (#${row.id}) a été interrompu.` });
  }
  if (opts.connectBots !== false) for (const b of roster.all()) pool.add(b.name);
  if (opts.installGuards) installGuards(runner);

  // Warm the typecheck (the first one parses every library file, ~5 s) so the agent's first check_script is quick.
  setTimeout(() => {
    void checkScript('export const manifest = { summary: "warm-up" };\nexport default async function () {}').catch(() => undefined);
  }, 2_000).unref();

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      await runner.stopAll('interrupted');
      vitals.stop();
      pool.stop();
      await http.close();
      journal.close();
    })());
  return { service, http, port, stop };
}

/**
 * A script's detached promise or a mineflayer physics-tick throw must not kill the process (and every other order).
 * An error whose stack points at a running command's file fails that order; anything else is logged.
 */
function installGuards(runner: OrderRunner): void {
  const attribute = (e: unknown, kind: string): void => {
    if (isStopped(e) || isBotLeft(e)) return; // a stray await of a finished order or a lost bot
    const stack = e instanceof Error ? e.stack ?? '' : '';
    const owner = runner.running().find((o) => stack.includes(o.filename + ':'));
    if (owner) {
      void owner.fail(e, kind);
      return;
    }
    logger.error('squad', `${kind}: ${e instanceof Error ? e.stack ?? e.message : errorMessage(e)}`);
  };
  process.on('uncaughtException', (e) => attribute(e, 'uncaught exception'));
  process.on('unhandledRejection', (e) => attribute(e, 'unhandled rejection'));
}

async function main(): Promise<void> {
  const cfgPath = process.argv[2] ?? 'squad.json';
  const cfg = loadConfig(cfgPath);
  const s = await start(cfg, { connectBots: true, installGuards: true });

  // The supervisor's watchdog: a heartbeat every second; silence for 10 s means a wedged event loop.
  if (process.send) {
    setInterval(() => process.send?.({ type: 'heartbeat', at: Date.now() }), 1_000);
    process.on('message', (m: unknown) => {
      if ((m as { type?: string })?.type === 'shutdown') void shutdown('supervisor');
    });
    process.on('disconnect', () => void shutdown('supervisor gone'));
  }
  const shutdown = async (why: string): Promise<void> => {
    logger.info('squad', `shutting down (${why})`);
    const t = setTimeout(() => process.exit(1), 10_000);
    t.unref();
    await s.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isMain = process.argv[1] && /[\\/]main\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    logger.error('squad', `boot failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
