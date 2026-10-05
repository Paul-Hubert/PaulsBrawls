// Admin server — a PURE CONSUMER (08): imports anything, nothing imports it, deletable. The full v0
// surface (05 §Admin API): GET /status /villagers[/:name] /skills[/:name]?version=&code= /tasks
// /verdicts /directives /rollouts /journal[?id=…] /kinds + a WS /journal/stream live fan-out; POST
// /pause /resume /skills/:name/quarantine /villagers/:name/prompt. Every mutating verb journals what it did
// (actor:'admin' | player:<name>) BEFORE acting, so the dashboard's own pokes show in the history it
// renders. The future website is a pure consumer of exactly these routes — snapshot via REST, live via
// the WS, interaction via the POST verbs.
//
// The admin holds only narrow accessor functions + a journal (S5: no concrete subsystem classes), so it
// stays deletable and decoupled — main.ts wires the live readers (views, library, god state, scheduler).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer } from 'ws';

import type { JournalQuery } from '../types/index';
import type { IJournal, Unsubscribe } from '../journal/journal';
import { describeKinds } from '../journal/kinds';

/** What `GET /skills/:name` accepts as query options. */
export interface SkillReadOptions {
  /** `?version=` — a specific version (history); omitted = newest non-archived. */
  version?: number;
  /** `?code=1` — include the source. */
  code?: boolean;
}

/**
 * Construction input for {@link AdminServer}. `journal` is the read+subscribe side PLUS `append` (the
 * mutating verbs journal BEFORE acting). All data accessors are optional so the M0 spine boots with the
 * read-only core; later milestones wire the live readers. Mutating handlers return `true` when they
 * acted, `false`/absent → the route reports 404 (unknown subject) or 503 (unwired control).
 */
export interface AdminServerOptions {
  port: number;
  journal: Pick<IJournal, 'query' | 'subscribe' | 'append'>;
  /** Live status snapshot from main.ts (bots, runs, queue depths, budget). */
  getStatus?: () => Record<string, unknown>;
  startedAt?: number;
  /**
   * Optional static web root (the dashboard). When set, any GET that matches no API route is served from
   * this directory (`/` → `index.html`), same-origin with the API so the website needs no CORS (owner #9:
   * the host serves the dashboard). A path-traversal guard keeps reads inside the root. API routes win.
   */
  webRoot?: string;

  // ── GET data accessors (derived views / live state — admin only reads) ──
  villagers?: () => unknown[];
  villager?: (name: string) => unknown | undefined;
  skills?: () => unknown[];
  skill?: (name: string, opts: SkillReadOptions) => unknown | undefined;
  tasks?: () => unknown;
  verdicts?: () => unknown[];
  directives?: () => unknown[];
  /** The rollout index (RolloutsView) — the navigation entry point for the rollout-replay view. */
  rollouts?: () => unknown[];
  /**
   * The full prompt/response transcript of one `llm.call`, keyed by its `refs.llmCallId`. These live on
   * disk (`.eden-data/llm/<callId>.json`) and are written ONLY when `journal.debugPrompts` is on — the
   * journal event itself carries metrics only (05). `undefined` → 404 (debug off, unknown id, or read
   * error). main.ts wires the file read + a traversal guard; the admin stays filesystem-agnostic (S5).
   */
  llmTranscript?: (callId: string) => unknown | undefined;

  // ── Mutating verbs (each journals actor:'admin'|player:<name> BEFORE acting) ──
  /** Gate LLM scheduling (skills/subscriptions keep running). */
  onPause?: () => void;
  /** Lift the gate. */
  onResume?: () => void;
  /** Quarantine a skill (admin kill switch); return false if no such skill. */
  onQuarantine?: (name: string, reason: string, actor: string) => boolean;
  /** Inject a `tell` into a villager's inbox; return false if no such villager. */
  onPrompt?: (name: string, msg: { text: string; from?: string }, actor: string) => boolean;

  // ── Scenario control (the /villagers in-game command) ──────────────────────
  /** Load a scenario and connect its bots. cx/cz = player position for spreadplayers. */
  onScenarioStart?: (name: string, cx: number, cz: number) => Promise<{ ok: boolean; message: string; botNames?: string[] }>;
  /** Disconnect scenario bots (keeps state on disk). */
  onScenarioStop?: () => Promise<{ ok: boolean; message: string }>;
  /** Wipe bot state then reconnect scenario bots with a fresh loadout. */
  onScenarioRestart?: (name: string, cx: number, cz: number) => Promise<{ ok: boolean; message: string; botNames?: string[] }>;
}

/** The complete admin surface (05). Pure consumer — deleting it must break nothing. */
export class AdminServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly o: AdminServerOptions;
  private readonly journal: Pick<IJournal, 'query' | 'subscribe' | 'append'>;
  private readonly getStatus: () => Record<string, unknown>;
  private readonly startedAt: number;
  private boundPort = 0;

  constructor(opts: AdminServerOptions) {
    this.o = opts;
    this.journal = opts.journal;
    this.getStatus = opts.getStatus ?? (() => ({}));
    this.startedAt = opts.startedAt ?? Date.now();
    this.boundPort = opts.port;
    this.http = createServer((req, res) => void this.route(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/journal/stream') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
    this.wss.on('connection', (ws, req: IncomingMessage) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const kinds = parseList(url.searchParams.get('kinds'));
      const unsub: Unsubscribe = this.journal.subscribe((event) => {
        if (kinds && !kinds.includes(event.kind)) return;
        try {
          ws.send(JSON.stringify(event));
        } catch {
          /* a dropped client must not break the writer */
        }
      });
      ws.on('close', unsub);
      ws.on('error', () => ws.close());
    });
  }

  /** Listen on 127.0.0.1 (pass port 0 for ephemeral); resolves with the actually-bound port. */
  start(): Promise<{ port: number }> {
    return new Promise((resolve) => {
      this.http.listen(this.boundPort, '127.0.0.1', () => {
        this.boundPort = (this.http.address() as AddressInfo).port;
        resolve({ port: this.boundPort });
      });
    });
  }

  /** Terminate all WS clients and close both servers. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.wss.clients) client.terminate();
      this.wss.close(() => this.http.close(() => resolve()));
    });
  }

  /** The bound port (0 until {@link start} resolves). */
  get port(): number {
    return this.boundPort;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (req.method === 'POST') return await this.routePost(req, res, path);
      return this.routeGet(res, url, path);
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private routeGet(res: ServerResponse, url: URL, path: string): void {
    // Static routes first.
    switch (path) {
      case '/status':
        return send(res, 200, { uptimeMs: Date.now() - this.startedAt, ...this.getStatus() });
      case '/kinds':
        return send(res, 200, { kinds: describeKinds() });
      case '/journal':
        return send(res, 200, { events: this.journal.query(parseJournalQuery(url)) });
      case '/villagers':
        return send(res, 200, { villagers: this.o.villagers?.() ?? [] });
      case '/skills':
        return send(res, 200, { skills: this.o.skills?.() ?? [] });
      case '/tasks':
        return send(res, 200, this.o.tasks?.() ?? { open: [], completed: [], failed: [] });
      case '/verdicts':
        return send(res, 200, { verdicts: this.o.verdicts?.() ?? [] });
      case '/directives':
        return send(res, 200, { directives: this.o.directives?.() ?? [] });
      case '/rollouts':
        return send(res, 200, { rollouts: this.o.rollouts?.() ?? [] });
    }
    // Parameterized GETs.
    const villager = matchParam(path, '/villagers/');
    if (villager !== undefined) {
      const found = this.o.villager?.(villager);
      return found ? send(res, 200, found) : send(res, 404, { error: `no villager ${villager}` });
    }
    const skill = matchParam(path, '/skills/');
    if (skill !== undefined) {
      const versionRaw = url.searchParams.get('version');
      const opts: SkillReadOptions = {
        code: url.searchParams.get('code') === '1' || url.searchParams.get('code') === 'true',
      };
      if (versionRaw !== null) opts.version = Number(versionRaw);
      const found = this.o.skill?.(skill, opts);
      return found ? send(res, 200, found) : send(res, 404, { error: `no skill ${skill}` });
    }
    // The transcript of one llm.call (refs.llmCallId) — only present when debugPrompts dumped it (05).
    const llmCall = matchParam(path, '/llm/');
    if (llmCall !== undefined) {
      const transcript = this.o.llmTranscript?.(llmCall);
      return transcript !== undefined
        ? send(res, 200, transcript)
        : send(res, 404, { error: `no transcript ${llmCall}` });
    }
    // No API route matched — serve the dashboard from the static web root, if one is wired (same-origin).
    if (this.o.webRoot !== undefined) return this.serveStatic(res, this.o.webRoot, path);
    return send(res, 404, { error: `no route ${path}` });
  }

  /** Serve a file from the static web root (the dashboard). `/` → index.html; reads are guarded against
   *  path traversal (the resolved path must stay inside the root). Unknown files 404 (consistent JSON). */
  private serveStatic(res: ServerResponse, webRoot: string, pathname: string): void {
    const root = resolve(webRoot);
    let rel: string;
    try {
      rel = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
    } catch {
      return send(res, 400, { error: 'bad path' });
    }
    const full = resolve(root, rel);
    if (full !== root && !full.startsWith(root + sep)) return send(res, 403, { error: 'forbidden' });
    if (!existsSync(full) || !statSync(full).isFile()) return send(res, 404, { error: `no file ${pathname}` });
    res.writeHead(200, { 'content-type': contentType(full), 'cache-control': 'no-cache' });
    res.end(readFileSync(full));
  }

  private async routePost(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === '/pause') return this.doToggle(res, 'pause', this.o.onPause);
    if (path === '/resume') return this.doToggle(res, 'resume', this.o.onResume);
    if (path === '/scenario/stop') return this.doScenarioStop(res);
    if (path === '/scenario/start') return this.doScenarioOp(req, res, 'start');
    if (path === '/scenario/restart') return this.doScenarioOp(req, res, 'restart');

    const quarantine = matchParam(path, '/skills/', '/quarantine');
    if (quarantine !== undefined) {
      if (!this.o.onQuarantine) return send(res, 503, { error: 'quarantine control not wired' });
      const body = await readBody(req);
      const reason = typeof body.reason === 'string' ? body.reason : 'admin kill switch';
      // The library journals ONE skill.quarantine (actor admin, the real version) BEFORE it mutates (05); the
      // admin used to journal its own version:-1 row too, so every quarantine showed twice (bug #17).
      const ok = this.o.onQuarantine(quarantine, reason, 'admin');
      return ok ? send(res, 200, { quarantined: quarantine }) : send(res, 404, { error: `no skill ${quarantine}` });
    }

    const prompt = matchParam(path, '/villagers/', '/prompt');
    if (prompt !== undefined) {
      if (!this.o.onPrompt) return send(res, 503, { error: 'prompt control not wired' });
      const body = await readBody(req);
      const text = typeof body.text === 'string' ? body.text : '';
      const from = typeof body.from === 'string' ? body.from : undefined;
      // Existence check FIRST, so an unknown villager 404s WITHOUT a stray journal entry. When the
      // villager accessor is unwired we trust onPrompt's boolean (it 404s after the fact).
      if (this.o.villager && this.o.villager(prompt) === undefined) {
        return send(res, 404, { error: `no villager ${prompt}` });
      }
      // The inbox journals inbox.delivered ONCE, BEFORE delivery (05), as this actor: player:<from> when named,
      // else admin (the dashboard sends from:'admin', which is the admin, not a player). The admin used to
      // journal its own row too, so every prompt showed twice (bug #17).
      const actor = from && from !== 'admin' ? `player:${from}` : 'admin';
      const ok = this.o.onPrompt(prompt, { text, from }, actor);
      return ok ? send(res, 200, { delivered: prompt }) : send(res, 404, { error: `no villager ${prompt}` });
    }

    return send(res, 404, { error: `no route ${path}` });
  }

  private async doScenarioOp(req: IncomingMessage, res: ServerResponse, action: 'start' | 'restart'): Promise<void> {
    const cb = action === 'start' ? this.o.onScenarioStart : this.o.onScenarioRestart;
    if (!cb) return send(res, 503, { error: `scenario ${action} not wired` });
    const body = await readBody(req);
    const name = typeof body['name'] === 'string' ? body['name'] : '';
    const cx = typeof body['x'] === 'number' ? body['x'] : 0;
    const cz = typeof body['z'] === 'number' ? body['z'] : 0;
    if (!name) return send(res, 400, { error: 'name is required' });
    // Journal BEFORE acting (05/S2) — the admin poke shows in the history it renders.
    if (action === 'start') {
      this.journal.append('admin', 'scenario.start', { name, cx, cz }, {});
    } else {
      this.journal.append('admin', 'scenario.restart', { name, cx, cz }, {});
    }
    const result = await cb(name, cx, cz);
    send(res, result.ok ? 200 : 404, result);
  }

  private async doScenarioStop(res: ServerResponse): Promise<void> {
    if (!this.o.onScenarioStop) return send(res, 503, { error: 'scenario stop not wired' });
    this.journal.append('admin', 'scenario.stop', {} as Record<string, never>, {});
    const result = await this.o.onScenarioStop();
    send(res, result.ok ? 200 : 500, result);
  }

  private doToggle(res: ServerResponse, action: 'pause' | 'resume', handler: (() => void) | undefined): void {
    if (!handler) return send(res, 503, { error: `${action} control not wired` });
    // Journal BEFORE acting (05) — the admin poke shows in the history it renders. No new kind (S1):
    // system.config-warning is the existing "an operator changed runtime state" row; the message carries
    // the verb so the website can colour it.
    this.journal.append('admin', 'system.config-warning', { message: `admin: ${action} LLM scheduling` }, {});
    handler();
    send(res, 200, { paused: action === 'pause' });
  }
}

function send(res: ServerResponse, status: number, json: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(json));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(',').filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** Extract `:name` from `/<prefix>:name` (no trailing) or `/<prefix>:name<suffix>`; undefined if no match. */
function matchParam(path: string, prefix: string, suffix?: string): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  if (suffix !== undefined) {
    if (!rest.endsWith(suffix)) return undefined;
    const name = rest.slice(0, rest.length - suffix.length);
    return name.length > 0 && !name.includes('/') ? decodeURIComponent(name) : undefined;
  }
  // Plain `/prefix/:name` — reject nested paths (those are handled by a suffix matcher above).
  return rest.length > 0 && !rest.includes('/') ? decodeURIComponent(rest) : undefined;
}

function parseJournalQuery(url: URL): JournalQuery {
  const q: JournalQuery = {};
  const kinds = parseList(url.searchParams.get('kinds'));
  if (kinds) q.kinds = kinds;
  const actor = url.searchParams.get('actor');
  if (actor) q.actor = actor;
  const id = url.searchParams.get('id');
  if (id) q.id = id;
  const ref = url.searchParams.get('ref');
  if (ref) q.ref = ref;
  const since = url.searchParams.get('since');
  if (since) q.since = Number(since);
  const until = url.searchParams.get('until');
  if (until) q.until = Number(until);
  const limit = url.searchParams.get('limit');
  if (limit) q.limit = Number(limit);
  const order = url.searchParams.get('order');
  if (order === 'desc' || order === 'asc') q.order = order;
  return q;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
function contentType(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}
