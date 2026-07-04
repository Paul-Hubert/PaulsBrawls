// The B1 CI server lifecycle (docs/26 B1 / D-17): opens the `run/` dev server itself, knows when it is
// GENUINELY ready, starts from a clean deterministic state, and cannot be poisoned by a previous crash.
// Under D-19 it never ops any bot — CI runs entirely unprivileged.
//
// The one total order (P-12/P-15 — reaping precedes the world delete, which waits on the old JVM's
// file locks): heal → reap → wait-free → delete world → overlay → spawn gradle → ready-gate; teardown
// is RCON `stop` → wait port-free → hard-kill the port OWNER if still alive → restore properties.
// Loom forks the server JVM via the shared gradle daemon: teardown kills by port ownership, never the
// gradle tree, never the daemon (RK11's warm-start mitigation).

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../../src/logger';
import { readServerProps, type ServerProps } from '../config';
import type { RconClient } from '../rcon';
import { backupAndOverlay, healLeftoverBackup, restoreFromBackup } from './properties-overlay';
import { connectRconWithBackoff, waitForTcpAccept } from './readiness';
import { ownersOf, reapCiPorts, snapshotListeners, waitForPortFree } from './reaper';

/** The whole ready-gate wall — the FIRST gradle run compiles/remaps the mod (docs/26 B1 step 7). */
const READY_WALL_MS = 10 * 60_000;
/** How long teardown waits for a graceful RCON `stop` before hard-killing the port owner. */
const STOP_GRACE_MS = 60_000;
/** Bounded retry on the world delete — Windows releases file locks a beat after the JVM exits. */
const WORLD_DELETE_RETRIES = 5;
/** `run/mods/` is an input to reproducibility — pinned, asserted every open (docs/26 B1 / P-27). */
const PINNED_MODS = ['worldedit-mod-7.3.8.jar'];
/** The CI world dir name — must match the overlay's `level-name` (properties-overlay.ts). */
const CI_WORLD = 'eden-ci';
/** The mod's settlement listener — its unconditional-start is the mod-liveness probe (P-13). */
const SETTLEMENT_PORT = 8767;

/** The determinism baseline, applied ON TOP of the overlay's `difficulty=peaceful` (B1 step 7.3). */
export const CI_GAMERULES: ReadonlyArray<string> = [
  'gamerule randomTickSpeed 0',
  'gamerule doDaylightCycle false',
  'gamerule doWeatherCycle false',
  'gamerule doMobSpawning false',
  'gamerule doFireTick false',
  'gamerule mobGriefing false',
  'gamerule doInsomnia false',
  'gamerule doTraderSpawning false',
];

function repoRoot(): string {
  // eden/live-tests/server/ → eden/live-tests/ → eden/ → repo root
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** A running CI server: the live RCON client plus the teardown that must always run. */
export interface CiServer {
  rcon: RconClient;
  props: ServerProps;
  evidenceDir: string;
  /** Graceful stop + properties restore. Idempotent; ALWAYS call it (finally). */
  teardown: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Assert run/mods/ matches the pinned manifest — a drifted mods dir is a reproducibility break. */
function assertModsPinned(runDir: string): void {
  const modsDir = join(runDir, 'mods');
  const actual = existsSync(modsDir) ? readdirSync(modsDir).filter((f) => f.endsWith('.jar')).sort() : [];
  const expected = [...PINNED_MODS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `lifecycle: run/mods/ drifted from the pinned manifest — expected [${expected.join(', ')}], found [${actual.join(', ')}]. Update PINNED_MODS deliberately or restore the dir (docs/26 B1).`,
    );
  }
}

/** Delete the disposable CI world with a bounded retry on Windows file-lock errors (B1 step 4). */
async function deleteCiWorld(runDir: string): Promise<void> {
  const worldDir = join(runDir, CI_WORLD);
  if (!existsSync(worldDir)) return;
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(worldDir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= WORLD_DELETE_RETRIES) {
        throw new Error(`lifecycle: could not delete ${worldDir} after ${attempt} attempts — ${err instanceof Error ? err.message : String(err)}`);
      }
      logger.warn('ci-lifecycle', `world delete attempt ${attempt} failed (file locks?) — retrying in 2s`);
      await sleep(2000);
    }
  }
}

/**
 * Open the CI server (B1 total order, steps 1–7). On ANY failure after the overlay is applied, the
 * properties file is restored before the error propagates — a failed open never leaves the dev
 * profile overlaid. The returned teardown is idempotent.
 */
export async function openCiServer(evidenceDir: string): Promise<CiServer> {
  const root = repoRoot();
  const runDir = join(root, 'run');
  const propsPath = join(runDir, 'server.properties');
  mkdirSync(evidenceDir, { recursive: true });

  // 1. Heal a crashed prior run's leftover backup FIRST (stamped-only; foreign files throw).
  const healed = healLeftoverBackup(propsPath);
  if (healed === 'healed') logger.warn('ci-lifecycle', 'healed a leftover .ci-backup from a crashed prior run — dev profile restored before overlaying');

  // 2. Reap the CI port owners (orphans from a crashed run; loud; production 25565 is refused).
  await reapCiPorts();

  // 3. Wait for the MC port to actually unbind (the old JVM must release run/eden-ci file handles).
  await waitForPortFree(25599, 30_000);

  // 4. Delete the disposable CI world (regenerates in seconds, deterministically by seed).
  await deleteCiWorld(runDir);

  // Environment pin: run/mods is an input to what `runServer` boots.
  assertModsPinned(runDir);

  // 5. Overlay: stamped backup of the WORKING-TREE file, then the full-file CI rewrite.
  backupAndOverlay(propsPath);
  const props = readServerProps(); // re-read: port + rcon facts now come from the overlaid file

  // 6. Spawn `gradlew runServer` as a supervised child, stdout tee'd into the evidence dir.
  //    R82: the wrapper is invoked by ABSOLUTE path — `cmd /c gradlew.bat` silently fails to resolve
  //    from the cwd when Windows' NoDefaultCurrentDirectoryInExePath hardening is set (it is here).
  const serverLog = createWriteStream(join(evidenceDir, 'server.log'));
  const gradle: ChildProcess =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', join(root, 'gradlew.bat'), 'runServer', '--console=plain'], { cwd: root, windowsHide: true })
      : spawn(join(root, 'gradlew'), ['runServer', '--console=plain'], { cwd: root });
  gradle.stdout?.pipe(serverLog);
  gradle.stderr?.pipe(serverLog);
  let gradleExited: { code: number | null } | undefined;
  gradle.on('exit', (code) => {
    gradleExited = { code };
  });

  // 7. Ready-gate — all mandatory, in order; the failure names the PHASE it died in (S10).
  const t0 = Date.now();
  let phase = 'rcon-connect';
  let rcon: RconClient | undefined;
  try {
    // 7.1 RCON answers `list` parseably.
    rcon = await connectRconWithBackoff(
      { host: props.rconHost, port: props.rconPort, password: props.rconPassword },
      READY_WALL_MS,
      (m) => {
        if (gradleExited) throw new Error(`gradle runServer exited (code ${gradleExited.code}) before readiness — see ${join(evidenceDir, 'server.log')}`);
        logger.info('ci-lifecycle', `[ready:${phase} +${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
      },
    );

    // 7.2 The MOD answers: the :8767 settlement listener accepts (starts unconditionally at SERVER_STARTED).
    phase = 'mod-settlement-8767';
    await waitForTcpAccept('127.0.0.1', SETTLEMENT_PORT, Math.max(30_000, READY_WALL_MS - (Date.now() - t0)));

    // 7.3 The world is actually flat + the baseline sticks: apply the gamerules, read one back, probe
    //     one flat-profile block — a malformed level-type silently regenerated a NORMAL world (P-20);
    //     fail loudly here, not as downstream flake.
    phase = 'gamerules-and-flat-probe';
    await rcon.sendAll([...CI_GAMERULES]);
    const readback = await rcon.send('gamerule randomTickSpeed');
    if (!/randomtickspeed.*\b0\b/i.test(readback)) {
      throw new Error(`gamerule readback failed — "gamerule randomTickSpeed" replied "${readback}" (expected 0)`);
    }
    // Default flat profile: bedrock@-64, dirt@-63/-62, grass_block@-61. Spawn chunks are loaded.
    const probe = await rcon.send('execute if block 0 -61 0 minecraft:grass_block');
    if (!/passed/i.test(probe)) {
      throw new Error(`flat-block probe failed — expected grass_block at (0,-61,0), server said "${probe}". The level-type overlay likely regenerated a NORMAL world (colon-escaping, P-20).`);
    }
  } catch (err) {
    // A failed open must not leave the overlay in place OR the half-booted server running.
    rcon?.close();
    try {
      await hardStopByPort(props.mcPort);
    } catch {
      /* best-effort — the next open's reap step is the backstop */
    }
    restoreFromBackup(propsPath);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`lifecycle: ready-gate failed in phase "${phase}" after ${Math.round((Date.now() - t0) / 1000)}s — ${msg}`);
  }

  logger.info('ci-lifecycle', `server READY in ${Math.round((Date.now() - t0) / 1000)}s — flat eden-ci world, gamerule baseline applied, :${SETTLEMENT_PORT} up`);

  let torndown = false;
  const teardown = async (): Promise<void> => {
    if (torndown) return;
    torndown = true;
    // 8. RCON stop → wait for the port to free → hard-kill the port-owning PID if still alive →
    //    restore server.properties from the stamped backup.
    try {
      await rcon.send('stop');
    } catch {
      /* server may already be down — the port wait below is the real check */
    }
    rcon.close();
    try {
      await waitForPortFree(props.mcPort, STOP_GRACE_MS);
    } catch {
      logger.warn('ci-lifecycle', `server did not release :${props.mcPort} after graceful stop — hard-killing the port owner`);
      await hardStopByPort(props.mcPort);
      await waitForPortFree(props.mcPort, 30_000);
    }
    restoreFromBackup(propsPath);
    logger.info('ci-lifecycle', 'teardown complete — server down, dev server.properties restored');
  };

  return { rcon, props, evidenceDir, teardown };
}

/** Kill whoever owns `port` (the forked server JVM), by port ownership only — never the daemon. */
async function hardStopByPort(port: number): Promise<void> {
  const owners = ownersOf([port], await snapshotListeners());
  for (const [pid] of owners) {
    logger.warn('ci-lifecycle', `taskkill /T /F PID ${pid} (owner of :${port})`);
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve());
    });
  }
}
