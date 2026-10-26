#!/usr/bin/env node

import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { initFileLog, log, logDebug } from '../logger.js';
import { AgentRuntime } from './agent-runtime.js';
import { createAdminServer } from './admin-server.js';
import { benchmark } from './benchmark.js';
import { BotHost } from './bot-host.js';
import { loadVillageConfig } from './config.js';
import { ConversationManager } from './conversation.js';
import { VillageContext } from './context.js';
import { DailyRhythm } from './day-planner.js';
import { EmbeddingService } from './embeddings.js';
import { LLMClient } from './llm-client.js';
import { Persistence } from './persistence.js';
import { VillageScheduler } from './scheduler.js';
import { initSkillAudit } from './skill-audit.js';
import { TradeManager } from './trade.js';
import { Villager } from './villager.js';

/**
 * Village entrypoint (`npm run village`) — a SEPARATE process from the God's
 * unified entrypoint, on purpose: a village crash must never take down the
 * God's avatar, and the rosters must not share usernames (Minecraft kicks
 * duplicate logins).
 *
 *   npm run village -- --host localhost --port 25565 --roster village.json --admin-port 8766
 */

process.on('unhandledRejection', (reason) => {
  log('error', `village unhandled rejection: ${reason}`);
});
process.on('uncaughtException', (error) => {
  log('error', `village uncaught exception: ${error}`);
});

interface VillageArgs {
  host: string;
  port: number;
  roster: string;
  adminHost: string;
  adminPort: number;
  testHooks: boolean;
  logFile: string;
}

function parseArgs(): VillageArgs {
  return yargs(hideBin(process.argv))
    .option('host',       { type: 'string', default: 'localhost',    description: 'Minecraft server host' })
    .option('port',       { type: 'number', default: 25565,          description: 'Minecraft server port' })
    .option('roster',     { type: 'string', default: 'village.json', description: 'Roster + settings JSON (see village.example.json)' })
    .option('admin-host', { type: 'string', default: '127.0.0.1',    description: 'Admin API bind address' })
    .option('admin-port', { type: 'number', default: 8766,           description: 'Admin API port' })
    .option('test-hooks', { type: 'boolean', default: false,         description: 'Enable the eval harness test endpoints (POST /village/test/*) — never use in normal play' })
    .option('log-file',   { type: 'string', default: '',             description: "Debug log file (captures everything incl. debug level). Default: logs/village-<timestamp>.log; pass 'none' to disable" })
    .help()
    .alias('help', 'h')
    .parseSync() as unknown as VillageArgs;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (args.logFile !== 'none') {
    const resolved = initFileLog(args.logFile || path.join('logs', `village-${stamp}.log`));
    log('info', `[village] debug log → ${resolved}`);
  }
  const skillAuditPath = initSkillAudit(path.join('logs', `skills-${stamp}.jsonl`));
  log('info', `[village] skill audit → ${skillAuditPath}`);
  const config = loadVillageConfig(args.roster);
  log('info', `[village] roster: ${config.bots.length} bots — ${config.bots.map((b) => `${b.name}(${b.role})`).join(', ')}`);
  log('info', `[village] llm: ${config.settings.llm.provider}/${config.settings.llm.model}, concurrency ${config.settings.concurrency}, heartbeat ${config.settings.heartbeatSeconds}s`);
  logDebug('config', `args: host=${args.host}:${args.port} roster=${args.roster} admin=${args.adminHost}:${args.adminPort} testHooks=${args.testHooks}`);
  logDebug('config', `settings: ${JSON.stringify({ ...config.settings, llm: { ...config.settings.llm, apiKey: config.settings.llm.apiKey ? '<set>' : '(env)' } })}`);
  logDebug('config', `roster: ${JSON.stringify(config.bots)}`);

  const persistence = new Persistence(config.settings.dataDir);
  const benchmarkPath = benchmark.configure(persistence, path.join('logs', `benchmark-${stamp}.jsonl`));
  log('info', `[village] food benchmark → ${benchmarkPath}`);
  const embeddings = new EmbeddingService(config.settings);
  const llm = new LLMClient(config.settings.llm);
  const conversations = new ConversationManager();
  const trades = new TradeManager();

  const ctx: VillageContext = {
    settings: config.settings,
    llm,
    persistence,
    embeddings,
    conversations,
    trades,
    villagers: new Map<string, Villager>(),
    villagerNames: new Set(config.bots.map((b) => b.name)),
    startedAt: Date.now(),
    // Assigned just below (runtime needs ctx; scheduler needs runtime).
    scheduler: undefined as unknown as VillageScheduler,
    rhythm: undefined as unknown as DailyRhythm,
  };

  const runtime = new AgentRuntime(ctx);
  ctx.scheduler = new VillageScheduler({
    concurrency: config.settings.concurrency,
    botCooldownMs: config.settings.botCooldownMs,
    runner: runtime.runner,
    // While a bot is mid-conversation, hold its background wake-ups: an
    // error/job deliberation dispatched between turns sees the conversation
    // context, speaks out of turn or leaves, and kills the exchange after one
    // turn. combat/player/conversation stay immediate; the conversation
    // manager pumps the queue on every conversation end.
    isHeld: (botName, kind) =>
      (kind === 'error' || kind === 'job' || kind === 'plan' || kind === 'heartbeat') &&
      Boolean(conversations.get(botName)),
  });
  ctx.rhythm = new DailyRhythm(ctx);
  conversations.init(ctx);
  trades.init(ctx);

  const host = new BotHost(ctx, args.host, args.port);
  host.createVillagers(config.bots);

  if (args.testHooks) {
    log('warn', '[village] TEST HOOKS ENABLED — /village/test/* endpoints are live (eval harness mode)');
  }
  const adminServer = await createAdminServer(ctx, args.adminHost, args.adminPort, { testHooks: args.testHooks });

  const shutdown = (signal: string): void => {
    log('info', `[village] received ${signal}, shutting down`);
    host.shutdown();
    adminServer.close();
    benchmark.stop();
    persistence.flushNow();
    embeddings.flushNow();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Event-loop health: with N bots in one process, heavy synchronous work
  // (pathfinder A*, GC) shows up here LONG before it costs a keepalive. A
  // logged stall ≥1s is the smoking gun to check when a bot drops with
  // "client timed out after N milliseconds" — and a clean log here means the
  // SERVER stopped sending keep_alives (check its log for "Can't keep up!").
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const loopTimer = setInterval(() => {
    const p99Ms = Math.round(loopDelay.percentile(99) / 1e6);
    const maxMs = Math.round(loopDelay.max / 1e6);
    if (maxMs >= 1_000) {
      log('warn', `[village] event loop stalled in the last minute: p99=${p99Ms}ms max=${maxMs}ms — suspect heavy sync work (pathfinder/GC)`);
    } else if (p99Ms >= 100) {
      logDebug('village', `event loop busy: p99=${p99Ms}ms max=${maxMs}ms over the last minute`);
    }
    loopDelay.reset();
  }, 60_000);
  loopTimer.unref?.();

  await host.start();
  log('info', `[village] all ${config.bots.length} villagers launched. The village lives.`);
}

main().catch((error) => {
  log('error', `village fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
