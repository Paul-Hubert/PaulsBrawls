// The `squad` MCP server (docs/29 §8.3): what the `squad-author` agent can do, and nothing else. Stateless
// Streamable HTTP (a fresh server + transport per request, JSON responses), behind the same bearer token as the
// control API. Every tool but get_api_reference takes the `cmd-…` ticket of the authoring turn; a refusal is
// `isError: true` with an English message the agent can act on.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { Authoring } from '../authoring';
import { errorMessage } from '../api/errors';
import { logger } from '../logger';

const ticket = z.string().describe('The authoring ticket (cmd-…) from the first message of the turn');
const source = z.string().describe('The whole command file: `export const manifest = {…}` + `export default async function (squad, args, ctx) {…}`');

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function guarded(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return text(errorMessage(e), true);
  }
}

export function buildMcpServer(authoring: Authoring): McpServer {
  const server = new McpServer({ name: 'squad', version: '1.0.0' }, { instructions: 'Write squad commands for Minecraft bots. Start with get_api_reference.' });

  server.registerTool(
    'get_api_reference',
    {
      title: 'Squad API reference',
      description: 'The full command API (squad, ctx, helpers, the manifest) as a TypeScript declaration file with docs. Read it before writing.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => guarded(() => text(authoring.apiReference())),
  );

  server.registerTool(
    'get_context',
    {
      title: 'The player and their bots',
      description: "The command being written, the player's request and position, and each of their bots: tags, owners, online, busy (which order), position, health, held item, inventory.",
      inputSchema: { ticket },
      annotations: { readOnlyHint: true },
    },
    async ({ ticket: t }) => guarded(() => text(authoring.context(t))),
  );

  server.registerTool(
    'list_commands',
    {
      title: 'Commands the player can use',
      description: 'Own, shared and stock commands (stock = squad:NAME, worked examples to copy from). Reuse one with ctx.run(name, args, { bots }).',
      inputSchema: { ticket },
      annotations: { readOnlyHint: true },
    },
    async ({ ticket: t }) => guarded(() => text(authoring.listCommands(t))),
  );

  server.registerTool(
    'read_command',
    {
      title: 'Read a command',
      description: 'The full source of a command: NAME, owner:NAME, or squad:NAME for a stock example.',
      inputSchema: { ticket, name: z.string().describe('NAME, owner:NAME or squad:NAME') },
      annotations: { readOnlyHint: true },
    },
    async ({ ticket: t, name }) => guarded(() => text(authoring.readCommand(t, name))),
  );

  server.registerTool(
    'check_script',
    {
      title: 'Check a draft',
      description:
        'Parse, compile, validate the manifest and typecheck the draft against the API and mineflayer types. ERRORs block submission (unknown names or properties, wrong argument counts, syntax); WARNINGs do not. Nothing runs in the world.',
      inputSchema: { ticket, source },
      annotations: { readOnlyHint: true },
    },
    async ({ ticket: t, source: s }) => guarded(async () => {
      const r = await authoring.check(t, s);
      return text(r.text, !r.ok);
    }),
  );

  server.registerTool(
    'trial_run',
    {
      title: 'Try a draft on the real server',
      description:
        "Run the draft as a real order on the player's IDLE bots (never reclaims), for at most 60 s, and get its report: status, returned value, error with line, logs, per-bot failures, inventories before/after. It acts in the world. At most 3 per turn.",
      inputSchema: {
        ticket,
        source,
        args: z.string().optional().describe('The arguments as the player would type them after the command name, e.g. "oak_log 8" or "radius=12"'),
        seconds: z.number().int().min(5).max(60).optional().describe('Cut the trial after this long (default 60)'),
      },
    },
    async ({ ticket: t, source: s, args, seconds }) => guarded(async () => {
      const r = await authoring.trial(t, s, args ?? '', seconds);
      return text(r.text, !r.ok);
    }),
  );

  server.registerTool(
    'submit_command',
    {
      title: 'Submit the command',
      description: "Store the draft as the command's next version (it must pass check_script with no ERROR). Once per turn. Then answer the player in one French sentence.",
      inputSchema: { ticket, source },
    },
    async ({ ticket: t, source: s }) => guarded(async () => {
      const r = await authoring.submit(t, s);
      return text(r.text, !r.ok);
    }),
  );

  return server;
}

/** Serve one MCP request (POST). GET/DELETE are 405: stateless, no SSE stream. */
export async function handleMcp(authoring: Authoring, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null }));
    return;
  }
  const server = buildMcpServer(authoring);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    logger.warn('mcp', `request failed: ${errorMessage(e)}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
    }
  }
}
