// The B1 ready-gate probes (docs/26 B1 step 7 / P-13/P-14). The existing RconClient.connect() is
// ONE-SHOT (rejects on the first ECONNREFUSED, no retry) — right for commands against an up server,
// unusable as a readiness poll. This module wraps it in connect-with-backoff, plus the raw TCP-accept
// probe the mod's :8767 settlement listener answers (it starts unconditionally at SERVER_STARTED — the
// mod's liveness signal; there is no RCON-reachable `/village on`).

import net from 'node:net';

import { RconClient } from '../rcon';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RconTarget {
  host: string;
  port: number;
  password: string;
}

/**
 * Poll until RCON connects + auths AND `list` returns a parseable player-count reply. Returns the
 * LIVE client (the caller owns closing it). Throws with the elapsed time on deadline (S10 — the
 * lifecycle folds this into its phase-named failure).
 */
export async function connectRconWithBackoff(target: RconTarget, timeoutMs: number, onAttempt?: (msg: string) => void): Promise<RconClient> {
  const t0 = Date.now();
  let lastErr = 'no attempt made';
  let backoffMs = 1000;
  while (Date.now() - t0 < timeoutMs) {
    const client = new RconClient(target);
    try {
      await client.connect();
      const reply = await client.send('list');
      if (/there are \d+ of a max of \d+ players online/i.test(reply)) return client;
      lastErr = `list replied unparseably: "${reply}"`;
      client.close();
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      client.close();
    }
    onAttempt?.(`rcon not ready (${lastErr}) — retrying in ${backoffMs}ms`);
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 5000);
  }
  throw new Error(`readiness: RCON at ${target.host}:${target.port} not ready after ${Math.round((Date.now() - t0) / 1000)}s — last: ${lastErr}`);
}

/** One TCP connect attempt — resolves true if `host:port` ACCEPTS within `connectTimeoutMs`. */
export function tcpAccepts(host: string, port: number, connectTimeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(connectTimeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Poll until `host:port` accepts a TCP connection (the :8767 mod-liveness probe). Throws on deadline. */
export async function waitForTcpAccept(host: string, port: number, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await tcpAccepts(host, port)) return;
    await sleep(1000);
  }
  throw new Error(`readiness: nothing accepting TCP on ${host}:${port} after ${Math.round((Date.now() - t0) / 1000)}s`);
}
