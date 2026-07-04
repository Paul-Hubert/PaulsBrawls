// The CI port reaper (B1 total-order step 2 / P-15). A previous crashed run can leave an orphan server
// JVM (loom forks it via the SHARED, PERSISTENT gradle daemon) or an orphan Eden host. Reaping is by
// PORT OWNERSHIP only:
//   • resolve the PIDs listening on the CI ports via `netstat -ano` (25599+8767 are the same server
//     JVM — dedupe; an absent listener is success, not error);
//   • `taskkill /T /F` the owners, loudly logging what dies;
//   • NEVER kill by process name, NEVER the gradle daemon (RK11's warm-start mitigation), and REFUSE
//     to touch a listener on 25565 — the production server guard.
// The parse + dedupe + guard logic is pure (unit-tested per-push, tests/server-reaper.test.ts); only
// the two thin exec wrappers touch the OS.

import { execFile } from 'node:child_process';

import { logger } from '../../src/logger';

/** The ports a CI run owns: dev MC, its RCON, the mod's settlement listener, Eden admin. */
export const CI_PORTS = [25599, 25575, 8767, 8770] as const;
/** The production server (PaulsBrawlsVanilla). The reaper REFUSES to resolve or kill its owner. */
export const PRODUCTION_PORT = 25565;

export interface Listener {
  port: number;
  pid: number;
}

/**
 * Parse `netstat -ano` output into LISTENING (port, pid) pairs. Handles IPv4 (`0.0.0.0:25599`) and
 * IPv6 (`[::]:25599`) local addresses; ignores non-listening rows (UDP rows carry no state and are
 * ignored too — every port we reap is TCP).
 */
export function parseListeners(netstatOutput: string): Listener[] {
  const out: Listener[] = [];
  for (const line of netstatOutput.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // TCP rows: Proto Local Foreign State PID
    if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
    const local = cols[1]!;
    const portStr = local.slice(local.lastIndexOf(':') + 1);
    const port = Number(portStr);
    const pid = Number(cols[4]);
    if (!Number.isInteger(port) || !Number.isInteger(pid)) continue;
    out.push({ port, pid });
  }
  return out;
}

/**
 * The deduped set of PIDs owning any of `ports`, from parsed netstat output. Throws if `ports`
 * includes the production port — the guard is structural, not a call-site convention.
 */
export function ownersOf(ports: readonly number[], listeners: Listener[]): Map<number, number[]> {
  if (ports.includes(PRODUCTION_PORT)) {
    throw new Error(`reaper: refusing to resolve owners of production port ${PRODUCTION_PORT} — CI never touches the production server`);
  }
  const byPid = new Map<number, number[]>();
  for (const l of listeners) {
    if (!ports.includes(l.port)) continue;
    const entry = byPid.get(l.pid);
    if (entry) {
      if (!entry.includes(l.port)) entry.push(l.port);
    } else {
      byPid.set(l.pid, [l.port]);
    }
  }
  return byPid;
}

/** Run `netstat -ano` and return the parsed LISTENING pairs. */
export function snapshotListeners(): Promise<Listener[]> {
  return new Promise((resolve, reject) => {
    execFile('netstat', ['-ano'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(`reaper: netstat -ano failed — ${err.message}`));
      else resolve(parseListeners(stdout));
    });
  });
}

/** `taskkill /T /F` one PID (kills its process tree — the server JVM's children too). Best-effort. */
function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, (err) => {
      if (err) logger.warn('ci-reaper', `taskkill /T /F /PID ${pid} reported: ${err.message} (already gone?)`);
      resolve();
    });
  });
}

/**
 * Reap the owners of the CI ports (B1 step 2). Loudly logs every kill — on the dedicated runner box a
 * manual `npm run live-test` or dev `runServer` left running is exactly what dies here (docs/26 B1
 * environment pins). An empty result (nothing listening) is the happy path.
 */
export async function reapCiPorts(): Promise<void> {
  const owners = ownersOf(CI_PORTS, await snapshotListeners());
  if (owners.size === 0) {
    logger.info('ci-reaper', `CI ports ${CI_PORTS.join('/')} are all free — nothing to reap`);
    return;
  }
  for (const [pid, ports] of owners) {
    logger.warn('ci-reaper', `killing PID ${pid} (owns port${ports.length > 1 ? 's' : ''} ${ports.join(', ')}) — taskkill /T /F`);
    await taskkill(pid);
  }
}

/** Is `port` currently in LISTENING state? (netstat-based — bind-probing is unreliable vs 0.0.0.0 binds). */
export async function portListening(port: number): Promise<boolean> {
  return (await snapshotListeners()).some((l) => l.port === port);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `port` is UNBOUND (B1 step 3 — the old JVM has exited and released its file handles;
 * Windows EBUSY on the world delete otherwise). Throws with the elapsed time on timeout (S10).
 */
export async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await portListening(port))) return;
    await sleep(1000);
  }
  throw new Error(`reaper: port ${port} still LISTENING after ${Math.round((Date.now() - t0) / 1000)}s — old server JVM did not exit`);
}
