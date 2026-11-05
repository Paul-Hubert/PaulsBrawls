// The `general` MCP server (docs/38 §3): what a General's Claude Code instance can do. Stateless Streamable HTTP, like
// /mcp/squad. The `gen-…` ticket rides in the X-Squad-General header (the instance's .mcp.json reads it from
// SQUAD_GENERAL_TICKET) and is the only credential: it names one General, so the tools take no ticket argument.
// A refusal is `isError: true` with an English message the agent can act on.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { errorMessage } from '../api/errors';
import { EVENT_KINDS } from '../general/events';
import { RULE_ACTIONS, TRIGGER_KINDS } from '../general/standing';
import { FIGHT_WAIT_S, KITS, OFFERED, QUIET_WAIT_S, type GeneralRecord, type Generals } from '../general/general';
import { logger } from '../logger';

export const TICKET_HEADER = 'x-squad-general';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

const at = z
  .object({
    pos: z.string().optional().describe('Where: "E12 N3" (relative to the spawn point; E = +x, N = -z), "axis+48" (past the front along the axis), "spawn", or "x y z"'),
    target: z.string().optional().describe('Whom: a cluster id from the sitrep (X1), an enemy name, or #entityId'),
    facing: z.string().optional().describe('A compass point (E, NNW…) or a bearing in degrees; default: toward the target, else the axis'),
  })
  .optional()
  .describe('The point, target and facing of the order (the commander snapshot)');

/** What a spawn's or reinforcement's bots do once there (docs/45 §2). */
const arrival = {
  then: z
    .object({ command: z.enum(OFFERED), args: z.string().optional(), at })
    .optional()
    .describe('The order the squad gets once they all arrived'),
  rally: z.string().optional().describe('Where they gather when they have no order to join (default: the rally point)'),
  force: z.boolean().optional().describe('Spawn even with an enemy near the spawn point'),
};

const rule = z.object({
  when: z.enum(TRIGGER_KINDS as [string, ...string[]]).describe('contact (a cluster within value), approach (one within value closing on the squad), hp (mean health below value %), losses (value deaths since it last fired), idle (no order for value s), ended (its order ended by itself)'),
  value: z.number().optional().describe('The trigger number (defaults: contact 48, approach 64, hp 40, losses 1, idle 8)'),
  do: z.enum(RULE_ACTIONS).describe('An order (raid, attack, line), advance, or reinforce'),
  args: z.string().optional().describe('The order key=value args'),
  at: z
    .object({
      pos: z.string().optional().describe('"here", "rally", "back N" (N blocks from the enemy, away from it), or any position'),
      target: z.string().optional().describe('"trigger" (the cluster that fired it), "nearest", or a cluster/enemy'),
      facing: z.string().optional(),
    })
    .optional(),
  n: z.number().int().min(1).max(50).optional().describe('reinforce: how many'),
  cooldown_s: z.number().int().min(2).max(600).optional().describe('Seconds before it may fire again (default 10)'),
});

export function buildGeneralServer(generals: Generals, ticket: string | undefined, signal?: AbortSignal): McpServer {
  const server = new McpServer(
    { name: 'general', version: '1.0.0' },
    { instructions: 'Command an army of Minecraft bot squads. Start with get_briefing, then act and wait_events.' },
  );
  const run = async (fn: (g: GeneralRecord) => Promise<string> | string): Promise<ToolResult> => {
    try {
      return text(await fn(generals.byTicket(ticket)));
    } catch (e) {
      return text(errorMessage(e), true);
    }
  };
  const read = { readOnlyHint: true } as const;

  server.registerTool(
    'get_briefing',
    { title: 'Briefing', description: 'Who you are, your spawn point, axis, allowance, mission, the orders you can give and the sitrep legend. Read it first.', inputSchema: {}, annotations: read },
    async () => run((g) => generals.briefing(g)),
  );
  server.registerTool(
    'sitrep',
    { title: 'Situation report', description: 'The whole battle in a few lines: one per squad, one per enemy cluster. wait_events already carries one.', inputSchema: {}, annotations: read },
    async () => run((g) => generals.sitrep(g)),
  );
  server.registerTool(
    'squad_detail',
    { title: 'Squad detail', description: "One line per bot of a squad (kit, health, position, held item, role), and its order's last log lines.", inputSchema: { squad: z.string() }, annotations: read },
    async ({ squad }) => run((g) => generals.squadDetail(g, squad)),
  );
  server.registerTool(
    'map',
    {
      title: 'Terrain map',
      description: 'A coarse ASCII map of the terrain as your bots know it, with your squads, the enemies seen and the spawn point.',
      inputSchema: {
        center: z.string().optional().describe('A position (default: your army)'),
        radius: z.number().int().min(8).max(64).optional().describe('Blocks (default 48)'),
        cell: z.number().int().min(1).max(8).optional().describe('Blocks per character (default 4)'),
      },
      annotations: read,
    },
    async ({ center, radius, cell }) => run((g) => generals.map(g, center, radius, cell)),
  );
  server.registerTool(
    'wait_events',
    {
      title: 'Wait for events',
      description:
        'Long poll: returns as soon as something you wake on happens (0.5 s later for contact/casualty/under-fire/enemy-approach, 2 s for the rest, to gather the burst), or after timeout_s with nothing. The sitrep it carries lists only what changed since the last wait_events (full=true: whole). Your heartbeat between moves: call it again right after acting.',
      inputSchema: {
        cursor: z.number().int().optional().describe('The cursor of the previous answer (default: only new events)'),
        timeout_s: z.number().int().min(1).max(50).optional().describe(`Seconds (default ${FIGHT_WAIT_S} while an enemy is in sight, else ${QUIET_WAIT_S})`),
        min_gap_s: z.number().int().min(0).max(30).optional().describe('Never return sooner than this after the call: the events of that time come together (default 0)'),
        wake_on: z.array(z.enum(EVENT_KINDS)).optional().describe('Kinds that wake you (default: all)'),
        full: z.boolean().optional().describe('The whole sitrep instead of the changes (default false)'),
      },
      annotations: read,
    },
    async ({ cursor, timeout_s, min_gap_s, wake_on, full }) =>
      run((g) => generals.waitEvents(g, { cursor, timeoutS: timeout_s, wakeOn: wake_on, minGapS: min_gap_s, full }, signal)),
  );
  server.registerTool(
    'set_mission',
    {
      title: 'Record the mission',
      description: "Record the goal and/or strategy you took from the admin's message (shown in every sitrep). An empty string clears one.",
      inputSchema: { goal: z.string().optional(), strategy: z.string().optional() },
    },
    async ({ goal, strategy }) => run((g) => generals.setMission(g, goal, strategy)),
  );
  server.registerTool(
    'set_axis',
    { title: 'Change the axis', description: 'Change the axis of attack (the advance follows it). Say so in your mission line.', inputSchema: { direction: z.string().describe('A compass point (E, NNW…) or a bearing in degrees') } },
    async ({ direction }) => run((g) => generals.setAxis(g, direction)),
  );
  server.registerTool(
    'spawn_squad',
    {
      title: 'Spawn a squad',
      description:
        'Spawn bots of one kit at the spawn point into a squad (new or existing), within your allowance. A new squad gets its kit\'s standing orders. Once all are there ("arrived" event) they get then, else join the squad\'s running order, else form a line at rally (default: the rally point, 12 blocks behind your army). Refused while an enemy is within 32 blocks of the spawn point unless force=true.',
      inputSchema: { squad: z.string().describe('Squad name, e.g. A or archers'), kit: z.enum(KITS), count: z.number().int().min(1).max(50), ...arrival },
    },
    async ({ squad, kit, count, then, rally, force }) => run((g) => generals.spawnSquad(g, squad, kit, count, { then, rally, force })),
  );
  server.registerTool(
    'reinforce',
    {
      title: 'Bring back the dead',
      description:
        "Bring a squad's dead bots back at the spawn point with their kit; each one spends a reinforcement. On arrival they get then, else join the squad's running order, else form a line at rally. Refused while an enemy is within 32 blocks of the spawn point unless force=true.",
      inputSchema: { squad: z.string(), count: z.number().int().min(1).max(50), ...arrival },
    },
    async ({ squad, count, then, rally, force }) => run((g) => generals.reinforce(g, squad, count, { then, rally, force })),
  );
  server.registerTool(
    'assign',
    { title: 'Move bots between squads', description: 'Move bots into a squad (created if new): to split or merge squads.', inputSchema: { bots: z.array(z.string()).min(1), squad: z.string() } },
    async ({ bots, squad }) => run((g) => generals.assign(g, bots, squad)),
  );
  server.registerTool(
    'order',
    {
      title: 'Give a squad an order',
      description: `Start an order for a squad's bots (it replaces the squad's current one). Commands: ${OFFERED.join(', ')} (see get_briefing).`,
      inputSchema: {
        squad: z.string(),
        command: z.enum(OFFERED),
        args: z.string().optional().describe('key=value pairs, e.g. "radius=16 seconds=90"'),
        at,
      },
    },
    async ({ squad, command, args, at: a }) => run((g) => generals.order(g, squad, command, args ?? '', a ?? {})),
  );
  server.registerTool(
    'orders',
    {
      title: 'Give several squads their orders at once',
      description: 'A whole plan in one call: one order per squad (each replaces that squad\'s current one). All are checked first; nothing starts if one is wrong.',
      inputSchema: {
        orders: z
          .array(z.object({ squad: z.string(), command: z.enum(OFFERED), args: z.string().optional().describe('key=value pairs'), at, standing: z.array(rule).max(8).optional().describe("Replaces the squad's standing orders") }))
          .min(1)
          .max(12),
      },
    },
    async ({ orders }) => run((g) => generals.orderMany(g, orders)),
  );
  server.registerTool(
    'standing',
    {
      title: "Set a squad's standing orders",
      description:
        "Rules the runtime fires by itself, within a quarter second, without waiting for you: when TRIGGER → do ACTION. They replace the squad's rules (an empty list clears them; defaults=true restores its kit's). The first rule due fires (list order); each waits its cooldown; contact, approach and idle rules fire only while the squad holds a line, advances or has no order; none fires within 5 s of your own order to the squad. Every firing is a 'standing' event.",
      inputSchema: { squad: z.string(), rules: z.array(rule).max(8).optional(), defaults: z.boolean().optional() },
    },
    async ({ squad, rules, defaults }) => run((g) => generals.setStanding(g, squad, defaults ? 'defaults' : (rules ?? []))),
  );
  server.registerTool(
    'retarget',
    {
      title: 'Re-aim an order',
      description: "Re-aim a squad's running order at a new point, target or facing (attack and line re-aim without restarting; raid restarts).",
      inputSchema: { squad: z.string(), at: at.unwrap() },
    },
    async ({ squad, at: a }) => run((g) => generals.retarget(g, squad, a)),
  );
  server.registerTool(
    'advance',
    {
      title: 'Advance along the axis',
      description: 'The default move with no enemy in sight: the squads march along the axis in legs (raid orders), side by side, fighting what they meet, until the range limit.',
      inputSchema: {
        squads: z.array(z.string()).optional().describe('Default: every squad with a bot online'),
        distance: z.number().int().min(8).max(128).optional().describe('Blocks per leg (default 48)'),
      },
    },
    async ({ squads, distance }) => run((g) => generals.advance(g, squads, distance)),
  );
  server.registerTool(
    'stop',
    { title: 'Stop a squad', description: "Stop a squad's order (and its advance); the bots stay where they are.", inputSchema: { squad: z.string() } },
    async ({ squad }) => run((g) => generals.stopSquad(g, squad)),
  );
  server.registerTool(
    'disband',
    { title: 'Disband a squad', description: 'Despawn a squad: its bots leave and their allowance slots are free again.', inputSchema: { squad: z.string() }, annotations: { destructiveHint: true } },
    async ({ squad }) => run((g) => generals.disband(g, squad)),
  );
  return server;
}

/** Serve one MCP request (POST); the ticket is read from its header. */
export async function handleGeneralMcp(generals: Generals, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null }));
    return;
  }
  const raw = req.headers[TICKET_HEADER];
  const ticket = Array.isArray(raw) ? raw[0] : raw;
  // A long wait_events ends when the client goes away.
  const gone = new AbortController();
  res.on('close', () => gone.abort());
  const server = buildGeneralServer(generals, ticket, gone.signal);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    logger.warn('general', `mcp request failed: ${errorMessage(e)}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
    }
  }
}
