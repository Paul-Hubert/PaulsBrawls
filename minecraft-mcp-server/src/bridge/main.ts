#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { log } from '../logger.js';
import { BotConnection } from '../bot-connection.js';
import { createBridgeServer } from './server.js';

/**
 * Bridge entrypoint — second Node binary alongside the MCP server.
 *
 * Does NOT touch the MCP stdio transport: this server uses plain HTTP. Logging
 * still goes to stderr via {@link log} so we never accidentally write JSON-like
 * lines to stdout (a holdover guard from the MCP entrypoint; harmless here but
 * keeps the two binaries cargo-cult identical).
 */

process.on('unhandledRejection', (reason) => {
  log('error', `bridge unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `bridge uncaught exception: ${error}`);
});

interface BridgeConfig {
  host: string;
  port: number;
  username: string;
  bridgeHost: string;
  bridgePort: number;
}

function parseBridgeConfig(): BridgeConfig {
  return yargs(hideBin(process.argv))
    .option('host',         { type: 'string', default: 'localhost', description: 'Minecraft server host' })
    .option('port',         { type: 'number', default: 25565,       description: 'Minecraft server port' })
    .option('username',     { type: 'string', default: 'LLMBot',    description: 'Bot username' })
    .option('bridge-host',  { type: 'string', default: '127.0.0.1', description: 'HTTP control server bind address' })
    .option('bridge-port',  { type: 'number', default: 8765,        description: 'HTTP control server port' })
    .help()
    .alias('help', 'h')
    .parseSync() as unknown as BridgeConfig;
}

async function main(): Promise<void> {
  const cfg = parseBridgeConfig();

  const connection = new BotConnection(
    { host: cfg.host, port: cfg.port, username: cfg.username },
    {
      onLog: log,
      onChatMessage: () => { /* bridge ignores incoming chat — pauls-brawls is the brain */ },
    }
  );

  connection.connect();

  const server = createBridgeServer({
    host: cfg.bridgeHost,
    port: cfg.bridgePort,
    getBot: () => connection.getBot(),
  });

  await server.start();

  const shutdown = async (signal: string): Promise<void> => {
    log('info', `bridge received ${signal}, shutting down`);
    try {
      await server.stop();
    } catch (err) {
      log('warn', `bridge stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    connection.cleanup();
    process.exit(0);
  };

  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((error) => {
  log('error', `bridge fatal error: ${error}`);
  process.exit(1);
});
