#!/usr/bin/env node

import http from 'http';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { log } from '../logger.js';
import { BotConnection } from '../bot-connection.js';
import { ToolFactory } from '../tool-factory.js';
import { MessageStore } from '../message-store.js';
import { registerPositionTools } from '../tools/position-tools.js';
import { registerInventoryTools } from '../tools/inventory-tools.js';
import { registerBlockTools } from '../tools/block-tools.js';
import { registerEntityTools } from '../tools/entity-tools.js';
import { registerChatTools } from '../tools/chat-tools.js';
import { registerFlightTools } from '../tools/flight-tools.js';
import { registerGameStateTools } from '../tools/gamestate-tools.js';
import { registerCraftingTools } from '../tools/crafting-tools.js';
import { registerFurnaceTools } from '../tools/furnace-tools.js';
import { registerCombatTools } from '../tools/combat-tools.js';
import { registerCollectionTools } from '../tools/collection-tools.js';
import { registerFollowTools } from '../tools/follow-tools.js';
import { handleBridgeRequest, isBridgePath } from '../bridge/server.js';

/**
 * Unified entrypoint — runs ONE Mineflayer bot that serves BOTH the bridge HTTP
 * surface (used by pauls-brawls' BotBridgeClient) AND the MCP SSE surface (used
 * by pauls-brawls' MCPGateway via langchain4j-mcp's HttpMcpTransport).
 *
 * The standalone entrypoints ({@code src/main.ts}, {@code src/bridge/main.ts})
 * remain in tree as a rollback option. Pick exactly one entrypoint per run —
 * running this AND `npm run bridge` simultaneously kicks one login.
 *
 * MCP routes (compatible with langchain4j-mcp 1.0.0-beta5's HttpMcpTransport,
 * which speaks the older two-endpoint SSE protocol — GET for the SSE stream,
 * POST for client→server messages):
 *
 *   GET  /mcp/sse           — establishes the SSE stream. The server emits an
 *                              `event: endpoint` line whose data tells the client
 *                              to POST messages to /mcp/messages?sessionId=<id>.
 *   POST /mcp/messages?sessionId=<id>
 *                            — client-to-server JSON-RPC request, routed to the
 *                              SSEServerTransport stored under that sessionId.
 *
 * The bridge endpoints (/health /appear /chat /look /gesture /vanish) are served
 * by {@link handleBridgeRequest} on the same listener — path-prefix switches
 * between the two surfaces.
 */

process.on('unhandledRejection', (reason) => {
  log('error', `unified unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `unified uncaught exception: ${error}`);
});

interface UnifiedConfig {
  host: string;
  port: number;
  username: string;
  bridgeHost: string;
  bridgePort: number;
  mcpSsePath: string;
  mcpMessagesPath: string;
}

function parseUnifiedConfig(): UnifiedConfig {
  return yargs(hideBin(process.argv))
    .option('host',              { type: 'string', default: 'localhost',     description: 'Minecraft server host' })
    .option('port',              { type: 'number', default: 25565,           description: 'Minecraft server port' })
    .option('username',          { type: 'string', default: 'LLMBot',        description: 'Bot username' })
    .option('bridge-host',       { type: 'string', default: '127.0.0.1',     description: 'HTTP listener bind address (bridge + MCP share this)' })
    .option('bridge-port',       { type: 'number', default: 8765,            description: 'HTTP listener port (bridge + MCP share this)' })
    .option('mcp-sse-path',      { type: 'string', default: '/mcp/sse',      description: 'GET path for the MCP SSE stream' })
    .option('mcp-messages-path', { type: 'string', default: '/mcp/messages', description: 'POST path for MCP client→server messages' })
    .help()
    .alias('help', 'h')
    .parseSync() as unknown as UnifiedConfig;
}

async function main(): Promise<void> {
  const cfg = parseUnifiedConfig();

  // ---- One BotConnection, one MessageStore, one login ----
  const messageStore = new MessageStore();
  const connection = new BotConnection(
    { host: cfg.host, port: cfg.port, username: cfg.username },
    {
      onLog: log,
      // MCP's read-chat tool reads from MessageStore. The bridge has no
      // dependent reader, so we always push — sharing one bot means there's no
      // reason to drop chat for the bridge case.
      onChatMessage: (username, message) => messageStore.addMessage(username, message),
    }
  );
  connection.connect();

  // ---- MCP server with all 12 tool modules ----
  const mcpServer = new McpServer({
    name: 'minecraft-mcp-server',
    version: '2.0.5',
  });
  const factory = new ToolFactory(mcpServer, connection);
  const getBot = () => connection.getBot()!;
  registerPositionTools(factory, getBot);
  registerInventoryTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, messageStore);
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  registerCombatTools(factory, getBot);
  registerCollectionTools(factory, getBot);
  registerFollowTools(factory, getBot);

  // ---- MCP SSE transport map (keyed by sessionId) ----
  // SSEServerTransport is per-connection in the SDK: each GET /mcp/sse spawns a
  // fresh transport, and the matching POST /mcp/messages?sessionId=<id> looks it
  // up here. On `close` we drop it so a reconnecting Java client gets a clean
  // session rather than racing against a stale one.
  const transports = new Map<string, SSEServerTransport>();

  // ---- Shared HTTP listener (bridge + MCP) ----
  const bridgeCtx = { getBot: () => connection.getBot() };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const path = url.split('?')[0];

    // MCP SSE stream
    if (method === 'GET' && path === cfg.mcpSsePath) {
      try {
        const transport = new SSEServerTransport(cfg.mcpMessagesPath, res);
        transports.set(transport.sessionId, transport);
        transport.onclose = () => {
          transports.delete(transport.sessionId);
          log('info', `mcp sse session closed: ${transport.sessionId}`);
        };
        transport.onerror = (err) => {
          log('warn', `mcp sse session ${transport.sessionId} error: ${err.message}`);
        };
        await mcpServer.connect(transport);
        log('info', `mcp sse session opened: ${transport.sessionId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('error', `mcp sse handshake failed: ${msg}`);
        // The SDK may have already written headers; only attempt a fallback
        // response if we still own the response stream.
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: msg }));
        } else {
          try { res.end(); } catch { /* nothing left to do */ }
        }
      }
      return;
    }

    // MCP client→server messages
    if (method === 'POST' && path === cfg.mcpMessagesPath) {
      const sessionId = new URL(url, 'http://localhost').searchParams.get('sessionId');
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing sessionId query param' }));
        return;
      }
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `no mcp session for ${sessionId}` }));
        return;
      }
      try {
        // Pass undefined for parsedBody so the SDK reads + parses the stream
        // itself — its body parser handles large JSON-RPC frames better than
        // the bridge's 64 KiB cap.
        await transport.handlePostMessage(req, res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('error', `mcp post for session ${sessionId} threw: ${msg}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
      }
      return;
    }

    // Bridge surface
    if (isBridgePath(url)) {
      await handleBridgeRequest(req, res, bridgeCtx);
      return;
    }

    // Anything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `no route for ${method} ${path}` }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.bridgePort, cfg.bridgeHost, () => {
      log('info', `unified listening on http://${cfg.bridgeHost}:${cfg.bridgePort}`);
      log('info', `  bridge:    POST /appear /chat /look /gesture /vanish, GET /health`);
      log('info', `  mcp sse:   GET  ${cfg.mcpSsePath}`);
      log('info', `  mcp post:  POST ${cfg.mcpMessagesPath}?sessionId=<id>`);
      resolve();
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    log('info', `unified received ${signal}, shutting down`);
    // Drop every SSE session first so langchain4j-mcp sees `onclose` and exits
    // its read loop cleanly rather than hanging on a half-closed socket.
    for (const transport of transports.values()) {
      try { await transport.close(); } catch { /* ignore */ }
    }
    transports.clear();
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch (err) {
      log('warn', `unified http close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    connection.cleanup();
    process.exit(0);
  };
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((error) => {
  log('error', `unified fatal error: ${error}`);
  process.exit(1);
});
