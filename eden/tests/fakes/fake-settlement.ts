// FakeSettlement — a deterministic stand-in for the Java mod's trade-settlement endpoint
// (POST /trade/execute on :8767). The REAL endpoint is the paulsbrawls mod (not available in CI — R29:
// it needs ./gradlew runServer stopped first); this fake lets M6-3 prove proposed→settled + failed
// entirely on the fakes, no Minecraft. Modeled on tests/fakes/scripted-llm.ts (an ephemeral localhost
// server on its own port so suites never collide).
//
// It mirrors the Java listener's SHAPE check (VillageHttpListener.validateShape) — `{botA, botB, aGives,
// bGives}`, ≤ 6 lines per side, count 1..512 — and answers 400 `{ok:false, error}` exactly like the mod,
// so a body that drifts from the Java contract fails every happy-path test instead of passing on a fake
// that accepts anything (the original from/to/give/want bug).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SettlementRequest {
  url: string | undefined;
  body: unknown;
  /** Request headers (lower-cased by node) — lets tests assert the X-Village-Token header. */
  headers: Record<string, string | string[] | undefined>;
}

export class FakeSettlement {
  readonly url: string;
  readonly port: number;
  /** Every settlement request received (assertions read the swapped item lists). */
  readonly requests: SettlementRequest[] = [];
  /** HTTP status to return next (set to a non-2xx to drive the trade.failed path). */
  private status = 200;
  /** When set, the server replies with this JSON body; otherwise a default `{ ok: true }`. */
  private replyBody: unknown = { ok: true };

  private constructor(
    private readonly server: Server,
    port: number,
  ) {
    this.port = port;
    this.url = `http://127.0.0.1:${port}/trade/execute`;
  }

  static start(): Promise<FakeSettlement> {
    return new Promise((resolve) => {
      const server = createServer();
      const holder = { srv: null as FakeSettlement | null };
      server.on('request', (req, res) => holder.srv?.handle(req, res));
      // Never keep the test process alive: a failing assert skips `await server.close()`, and a ref'd
      // listener would hang the whole file instead of reporting the failure.
      server.unref();
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        const srv = new FakeSettlement(server, port);
        holder.srv = srv;
        resolve(srv);
      });
    });
  }

  /** Make the NEXT (and subsequent) responses fail with `status` (e.g. 422 re-validation reject). */
  failWith(status: number, body: unknown = { error: 'rejected' }): this {
    this.status = status;
    this.replyBody = body;
    return this;
  }

  /** Restore the success response. */
  succeed(body: unknown = { ok: true }): this {
    this.status = 200;
    this.replyBody = body;
    return this;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed: unknown = body ? JSON.parse(body) : {};
      this.requests.push({ url: req.url, body: parsed, headers: req.headers });
      const problem = validateShape(parsed);
      if (problem !== null) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: problem }));
        return;
      }
      res.writeHead(this.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.replyBody));
    });
  }
}

/** Java's caps (VillageHttpListener MAX_OFFER_LINES / MAX_STACK_COUNT). */
const MAX_OFFER_LINES = 6;
const MAX_STACK_COUNT = 512;

/** A port of VillageHttpListener.validateShape — same checks, same order, same error strings. */
export function validateShape(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return 'empty request';
  const r = raw as Record<string, unknown>;
  const blank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === '';
  if (blank(r.botA)) return 'missing botA';
  if (blank(r.botB)) return 'missing botB';
  // Java uses equalsIgnoreCase: "Alice"/"alice" are the same player.
  if ((r.botA as string).toLowerCase() === (r.botB as string).toLowerCase()) return 'botA and botB are the same';
  if (!Array.isArray(r.aGives) || !Array.isArray(r.bGives)) return 'missing aGives/bGives';
  if (r.aGives.length === 0 && r.bGives.length === 0) return 'nothing to trade';
  if (r.aGives.length > MAX_OFFER_LINES || r.bGives.length > MAX_OFFER_LINES) {
    return `too many item lines (max ${MAX_OFFER_LINES})`;
  }
  for (const spec of [...r.aGives, ...r.bGives] as unknown[]) {
    const it = (spec ?? {}) as { item?: unknown; count?: unknown };
    if (blank(it.item)) return 'missing item name';
    const count = typeof it.count === 'number' ? Math.trunc(it.count) : 0;
    if (count < 1 || count > MAX_STACK_COUNT) return `bad count for ${String(it.item)}`;
  }
  return null;
}
