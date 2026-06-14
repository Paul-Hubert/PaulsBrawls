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
      this.requests.push({ url: req.url, body: body ? JSON.parse(body) : {} });
      res.writeHead(this.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.replyBody));
    });
  }
}
