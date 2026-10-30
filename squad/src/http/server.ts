// The runtime's one HTTP server (docs/29 §10), on loopback only:
//   /api/*      the mod's control API (JSON in, `{ ok, text, … }` out)
//   /events     SSE to the mod: `notice` (a French line for some players) and `state` (refresh your cache)
//   /mcp/squad  the author agent's tools (src/http/mcp.ts)
// Every route needs `Authorization: Bearer <token>`. Notices emitted while no mod is listening are kept (200 max)
// and sent when it connects, so an order that ends during a mod restart is still announced.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import type { SquadService } from '../service';
import type { Notice, Snapshot } from '../types';
import { EMPTY_SNAPSHOT } from '../types';
import type { Player } from '../roster';
import { errorMessage } from '../api/errors';
import { logger } from '../logger';
import { handleMcp } from './mcp';

const MAX_BODY = 1 << 20;
const MAX_PENDING = 200;

export interface HttpOptions {
  port: number;
  token: string;
  host?: string;
}

export class SquadHttp {
  private server?: Server;
  private readonly clients = new Set<ServerResponse>();
  private readonly pending: Notice[] = [];
  private stateTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(
    private readonly service: SquadService,
    private readonly opts: HttpOptions,
  ) {
    service.deps.runner.on('notice', (n: Notice) => this.notice(n));
    service.deps.runner.on('state', () => this.stateChanged());
    service.deps.pool.on('status', () => this.stateChanged());
  }

  listen(): Promise<number> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n');
    }, 15_000);
    this.heartbeat.unref();
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port, this.opts.host ?? '127.0.0.1', () => {
        const addr = this.server!.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.opts.port);
      });
    });
  }

  close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.end();
    this.clients.clear();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** A notice for the mod; kept while no mod is connected. */
  notice(n: Notice): void {
    if (this.clients.size === 0) {
      this.pending.push(n);
      if (this.pending.length > MAX_PENDING) this.pending.shift();
      return;
    }
    this.broadcast('notice', n);
  }

  private stateChanged(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.broadcast('state', {});
    }, 200);
    this.stateTimer.unref();
  }

  private broadcast(event: string, data: unknown): void {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(line);
  }

  private authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const a = Buffer.from(m[1]!.trim());
    const b = Buffer.from(this.opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!this.authorized(req)) return send(res, 401, { ok: false, text: 'unauthorized (bearer token)' });
      if (url.pathname === '/events') return this.events(req, res);
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      if (url.pathname === '/mcp/squad') return await handleMcp(this.service.authoring, req, res, body);
      if (url.pathname.startsWith('/api/')) return send(res, 200, await this.api(url, (body ?? {}) as Record<string, unknown>));
      send(res, 404, { ok: false, text: `no route ${url.pathname}` });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) logger.error('http', `${req.method} ${url.pathname}: ${errorMessage(e)}`);
      if (!res.headersSent) send(res, status, { ok: false, text: `[Bots] Erreur du runtime : ${errorMessage(e)}` });
    }
  }

  private events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: {}\n\n`);
    this.clients.add(res);
    for (const n of this.pending.splice(0)) res.write(`event: notice\ndata: ${JSON.stringify(n)}\n\n`);
    req.on('close', () => this.clients.delete(res));
  }

  private async api(url: URL, b: Record<string, unknown>): Promise<unknown> {
    const s = this.service;
    const who = (): Player => player(b.by); // only the routes that act for a player need it
    const admin = b.admin === true;
    switch (url.pathname) {
      case '/api/health':
        return { ok: true, text: 'squad up', bots: s.deps.roster.all().length, orders: s.deps.runner.running().length };
      case '/api/state':
        return { ok: true, text: '', ...s.state() };
      case '/api/bots/spawn':
        return s.spawn(who(), admin, str(b.name), players(b.owners));
      case '/api/bots/despawn':
        return s.despawn(who(), admin, str(b.name));
      case '/api/bots/owners':
        return s.owners(who(), admin, str(b.name), players(b.add ?? []), players(b.remove ?? []));
      case '/api/bots/tag':
        return s.tag(who(), admin, str(b.name), strings(b.changes));
      case '/api/bots/list':
        return s.list(who(), admin && b.all === true);
      case '/api/orders/start':
        return s.order({
          commander: who(),
          command: str(b.command),
          tokens: strings(b.tokens ?? []),
          filters: strings(b.filters ?? []),
          ...(b.take === 'free' || b.take === 'reclaim' ? { take: b.take } : {}),
          snap: snapshot(b.snap),
        });
      case '/api/orders/stop':
        return s.stop(who(), admin, typeof b.target === 'string' ? b.target : '');
      case '/api/orders/list':
        return s.orders(who(), admin);
      case '/api/authoring/open': {
        const mode = b.mode === 'fix' || b.mode === 'manual' ? b.mode : 'create';
        return s.openAuthoring(mode, who(), str(b.name), typeof b.request === 'string' ? b.request : '', snapshot(b.snap));
      }
      case '/api/authoring/close':
        return s.closeAuthoring(str(b.ticket));
      case '/api/authoring/revoke':
        return s.revokeTickets(who());
      case '/api/commands/list':
        return s.commands(who());
      case '/api/commands/show':
        return s.show(who(), str(b.name));
      case '/api/commands/share':
        return s.share(who(), str(b.name), players(b.players), b.remove === true);
      case '/api/commands/delete':
        return s.delete(who(), str(b.name));
      case '/api/commands/revert':
        return s.revert(who(), str(b.name), Number(b.version));
      default:
        throw new HttpError(404, `no route ${url.pathname}`);
    }
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large (1 MiB)');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'malformed JSON');
  }
}

function str(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'a required string field is missing');
  return v.trim();
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'expected an array of strings');
  return v.map(String);
}

function player(v: unknown): Player {
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o.uuid !== 'string' || typeof o.name !== 'string') throw new HttpError(400, '"by" must be { uuid, name }');
  return { uuid: o.uuid, name: o.name };
}

function players(v: unknown): Player[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'expected an array of { uuid, name }');
  return v.map(player);
}

function snapshot(v: unknown): Snapshot {
  if (!v || typeof v !== 'object') return EMPTY_SNAPSHOT;
  const o = v as Partial<Snapshot>;
  const p = o.position ?? EMPTY_SNAPSHOT.position;
  return {
    position: { x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 },
    yaw: Number(o.yaw) || 0,
    pitch: Number(o.pitch) || 0,
    dimension: typeof o.dimension === 'string' ? o.dimension : 'overworld',
    heldItem: typeof o.heldItem === 'string' ? o.heldItem : null,
    lookBlock: o.lookBlock && typeof o.lookBlock === 'object' ? o.lookBlock : null,
    lookEntity: o.lookEntity && typeof o.lookEntity === 'object' ? o.lookEntity : null,
  };
}
