// FakeSettlement — a deterministic stand-in for the Java mod's trade-settlement endpoint
// (POST /trade/execute on :8767). The REAL endpoint is the paulsbrawls mod (not available in CI — R29:
// it needs ./gradlew runServer stopped first); this fake lets M6-3 prove proposed→settled + failed
// entirely on the fakes, no Minecraft. Modeled on tests/fakes/scripted-llm.ts (an ephemeral localhost
// server on its own port so suites never collide).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SettlementRequest {
  url: string | undefined;
  body: unknown;
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
      this.requests.push({ url: req.url, body: parsed });
      // Mirror the mod's contract check (VillageHttpListener.validateShape) so a wrong-shape POST 400s
      // here exactly as it would against the real :8767 — this is what catches REG-1 (a body sent as
      // {from,to,give,want} instead of {botA,botB,aGives,bGives}) in CI instead of only on a live server.
      const problem = validateShape(parsed);
      if (problem) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: problem }));
        return;
      }
      res.writeHead(this.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.replyBody));
    });
  }
}

/** The mod's MAX_OFFER_LINES / MAX_STACK_COUNT (VillageHttpListener). */
const MAX_OFFER_LINES = 6;
const MAX_STACK_COUNT = 512;

/** Port of VillageHttpListener.validateShape — returns the mod's error string, or null when valid. */
function validateShape(req: unknown): string | null {
  if (typeof req !== 'object' || req === null) return 'empty request';
  const r = req as { botA?: unknown; botB?: unknown; aGives?: unknown; bGives?: unknown };
  if (typeof r.botA !== 'string' || r.botA.trim() === '') return 'missing botA';
  if (typeof r.botB !== 'string' || r.botB.trim() === '') return 'missing botB';
  if (r.botA === r.botB) return 'botA and botB are the same';
  if (!Array.isArray(r.aGives) || !Array.isArray(r.bGives)) return 'missing aGives/bGives';
  if (r.aGives.length === 0 && r.bGives.length === 0) return 'nothing to trade';
  if (r.aGives.length > MAX_OFFER_LINES || r.bGives.length > MAX_OFFER_LINES) {
    return `too many item lines (max ${MAX_OFFER_LINES})`;
  }
  for (const spec of [...r.aGives, ...r.bGives]) {
    const s = spec as { item?: unknown; count?: unknown };
    if (typeof s.item !== 'string' || s.item.trim() === '') return 'missing item name';
    if (typeof s.count !== 'number' || s.count < 1 || s.count > MAX_STACK_COUNT) return `bad count for ${String(s.item)}`;
  }
  return null;
}
