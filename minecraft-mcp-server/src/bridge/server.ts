import http from 'http';
import mineflayer from 'mineflayer';
import { log } from '../logger.js';
import { appear, chat, gesture, health, look, vanish, ActionResult } from './actions.js';

/**
 * Minimal HTTP control server. Bound to 127.0.0.1 only so prayers from outside
 * the host can't pilot the avatar.
 *
 * Endpoints (see GOD_BOT_INTEGRATION_PLAN.md §4b):
 *   GET  /health   → { connected, username, position }
 *   POST /appear   { x, y, z, facing? }
 *   POST /chat     { message }
 *   POST /look     { x, y, z }
 *   POST /gesture  { type }       — swing | jump | sneak | nod | summon
 *   POST /vanish   { x?, y?, z? } — defaults to a fixed parking spot
 *
 * The route logic is split into {@link handleBridgeRequest} + {@link isBridgePath}
 * so the unified entrypoint (`src/unified/main.ts`) can mount the bridge surface
 * on the same HTTP listener as the MCP SSE endpoints without duplicating code.
 * {@link createBridgeServer} stays for the standalone `npm run bridge` mode.
 */

export interface BridgeServer {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface RouteContext {
  getBot: () => mineflayer.Bot | null;
}

type Handler = (body: unknown, ctx: RouteContext) => ActionResult;

const handlers: Record<string, Handler> = {
  'POST /appear':  (body, ctx) => appear(ctx.getBot(),  body as { x: number; y: number; z: number; facing?: string }),
  'POST /chat':    (body, ctx) => chat(ctx.getBot(),    body as { message: string }),
  'POST /look':    (body, ctx) => look(ctx.getBot(),    body as { x: number; y: number; z: number }),
  'POST /gesture': (body, ctx) => gesture(ctx.getBot(), body as { type: string }),
  'POST /vanish':  (body, ctx) => vanish(ctx.getBot(),  body as { x?: number; y?: number; z?: number }),
};

/** Bridge paths the unified entrypoint should hand to {@link handleBridgeRequest}.
 *  Anything outside this set is foreign to the bridge — the unified server tries
 *  MCP next, or 404s on its own. */
const BRIDGE_PATHS = new Set(['/health', '/appear', '/chat', '/look', '/gesture', '/vanish']);

/** Returns true iff the URL's path (query stripped) is a known bridge endpoint. */
export function isBridgePath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0];
  return BRIDGE_PATHS.has(path);
}

function readBody(req: http.IncomingMessage, max = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

/**
 * Single-request dispatch for the bridge surface. Exported so the unified
 * entrypoint can share one HTTP listener with the MCP SSE routes without
 * round-tripping through {@link createBridgeServer}'s own listener.
 *
 * The caller is responsible for deciding whether to dispatch — use
 * {@link isBridgePath} to gate it, otherwise this method will 404 on any URL
 * outside the bridge set.
 */
export async function handleBridgeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext
): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
    const result = health(ctx.getBot());
    writeJson(res, result.ok ? 200 : 503, result);
    return;
  }

  const key = `${method} ${url.split('?')[0]}`;
  const handler = handlers[key];
  if (!handler) {
    writeJson(res, 404, { ok: false, error: `no route for ${key}` });
    return;
  }

  let body: unknown = {};
  if (method === 'POST') {
    try {
      const raw = await readBody(req);
      body = raw.length === 0 ? {} : JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeJson(res, 400, { ok: false, error: `bad body: ${msg}` });
      return;
    }
  }

  try {
    const result = handler(body, ctx);
    writeJson(res, result.ok ? 200 : 400, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `handler ${key} threw: ${msg}`);
    writeJson(res, 500, { ok: false, error: msg });
  }
}

export function createBridgeServer(opts: {
  host: string;
  port: number;
  getBot: () => mineflayer.Bot | null;
}): BridgeServer {
  const ctx: RouteContext = { getBot: opts.getBot };

  const server = http.createServer(async (req, res) => {
    await handleBridgeRequest(req, res, ctx);
  });

  return {
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, opts.host, () => {
        log('info', `bridge listening on http://${opts.host}:${opts.port}`);
        resolve();
      });
    }),
    stop: () => new Promise((resolve) => {
      server.close(() => resolve());
    }),
  };
}
