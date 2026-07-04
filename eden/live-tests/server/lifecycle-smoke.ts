// The B1 lifecycle-smoke drill (docs/26 B1 DoD). No LLM, no key, no God (D-19: one mortal bot, never
// op'd). Modes:
//   npm run lifecycle-smoke               # open → ready → one bot via BotPool → RCON `list` shows it
//                                         # → teardown → IMMEDIATELY repeat (proves reset + wait-free
//                                         # + reaping); exit 0 only if both runs pass
//   npm run lifecycle-smoke -- poison     # deliberately poison the state (an ORPHAN server left
//                                         # running + its leftover stamped .ci-backup — exactly what a
//                                         # crashed run leaves), then run ONE smoke pass — it must
//                                         # heal + reap + come up clean
//   npm run lifecycle-smoke -- abandon    # open the server and EXIT without teardown (builds the
//                                         # orphan state by hand for manual poking)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Journal } from '../../src/journal/journal';
import { logger } from '../../src/logger';
import { BotPool } from '../../src/bots/pool';
import { makeRunDir } from '../harness';
import { openCiServer, type CiServer } from './lifecycle';

/** Namespaced per R12 — never a villager/avatar/eval name; MC kicks duplicate logins. */
const SMOKE_BOT = 'CiSmokeRunner';
const BOT_CONNECT_WALL_MS = 120_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One full pass: open → spawn ONE mortal bot → `list` must show it → teardown. Throws on any miss. */
async function smokePass(label: string, evidenceDir: string): Promise<void> {
  logger.info('ci-smoke', `── ${label}: opening the CI server …`);
  const server: CiServer = await openCiServer(evidenceDir);
  try {
    const dataDir = join(evidenceDir, '.eden-data');
    mkdirSync(dataDir, { recursive: true });
    const journal = new Journal(join(dataDir, 'eden.db'));
    const pool = new BotPool({
      journal,
      host: '127.0.0.1',
      port: server.props.mcPort,
      villagers: [{ name: SMOKE_BOT, role: 'ci-smoke' }],
      // No avatarName: D-19 — the CI pool is all-mortal, nothing is ever op'd.
      dataDir,
      worldId: `127.0.0.1:${server.props.mcPort}`,
      vitalsIntervalMs: 10_000,
    });
    try {
      await pool.start();
      const t0 = Date.now();
      while (pool.connectedCount() < 1) {
        if (Date.now() - t0 > BOT_CONNECT_WALL_MS) {
          throw new Error(`ci-smoke: ${SMOKE_BOT} not connected after ${BOT_CONNECT_WALL_MS / 1000}s`);
        }
        await sleep(1000);
      }
      const list = await server.rcon.send('list');
      if (!list.includes(SMOKE_BOT)) {
        throw new Error(`ci-smoke: RCON list does not show ${SMOKE_BOT} — got "${list}"`);
      }
      logger.info('ci-smoke', `${label}: PASS — server ready, ${SMOKE_BOT} connected + visible to RCON ("${list}")`);
    } finally {
      pool.stop();
      await sleep(1500); // let the quit's TCP FIN land before the server stops (R66-adjacent tidiness)
    }
  } finally {
    await server.teardown();
  }
}

async function main(): Promise<number> {
  const mode = process.argv[2] ?? 'double';
  const evidenceRoot = makeRunDir(`lifecycle-smoke-${mode}`);
  mkdirSync(evidenceRoot, { recursive: true });
  logger.info('ci-smoke', `mode:${mode} — evidence under ${evidenceRoot}`);

  if (mode === 'abandon') {
    await openCiServer(join(evidenceRoot, 'abandoned'));
    logger.warn('ci-smoke', 'server opened and ABANDONED (no teardown) — the overlay + a live orphan now poison the state');
    process.exit(0); // exit without teardown — the gradle daemon keeps the server JVM alive
  }

  if (mode === 'poison') {
    // A crashed run = an orphan server owning the ports + the overlay still applied + its stamped
    // .ci-backup left behind. Abandoning a fresh open produces EXACTLY that state.
    logger.warn('ci-smoke', 'POISONING: opening a server and abandoning it (no teardown) …');
    await openCiServer(join(evidenceRoot, 'orphan'));
    logger.warn('ci-smoke', 'state poisoned (orphan server + leftover .ci-backup). Running the recovery pass …');
    await smokePass('poisoned-state run', join(evidenceRoot, 'recovery'));
    logger.info('ci-smoke', 'POISON DRILL PASS — healed the stale backup, reaped the orphan, came up clean');
    return 0;
  }

  // Default: the double-run drill.
  await smokePass('run 1', join(evidenceRoot, 'run1'));
  await smokePass('run 2 (immediate repeat)', join(evidenceRoot, 'run2'));
  logger.info('ci-smoke', 'DOUBLE-RUN DRILL PASS — the second run came up clean (reset + wait-free + reaping proven)');
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      logger.error('ci-smoke', `FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(1);
    });
}
