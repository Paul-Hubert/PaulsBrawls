// Live-scenario CLI + parent SUPERVISOR: `npm run live-test [name]`. Each scenario runs in its OWN child
// process ([run-one.ts]); the parent enforces a hard wall-clock kill from THIS (healthy) event loop, so a
// wedge in the code-under-test can never hang the suite — the parent SIGKILLs the child and records a
// timeout FAIL, then moves on. With no name it runs the full suite in the suggested order (farm-wheat ->
// craft-wooden-tools -> cooperative-mob-defense). Exit code = number of FAILED scenarios (0 = all pass).
//
// REQUIRES a running dev server (port + RCON from run/server.properties) and process.env.OPENAI_API_KEY.
// EXCLUDED from `npm run check`. See README.md.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { logger } from '../src/logger';
import { makeRunDir, type Scenario } from './harness';
import { SCENARIOS } from './catalogue';

/** Extra wall-clock the parent grants beyond a scenario's per-task timeout — covers boot, the ≤120 s bot
 *  connect wait, prepare, assert, and shutdown — before it force-kills the child as wedged. */
const KILL_GRACE_MS = 200_000;

interface SupervisedResult {
  name: string;
  pass: boolean;
  report: string;
  runDir: string;
  durationMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Force-kill a child process tree (Windows needs taskkill /T to reap the node child reliably). */
function hardKill(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Run one scenario in a killable child; the parent's timer (healthy event loop) bounds it absolutely. */
async function superviseScenario(scenario: Scenario): Promise<SupervisedResult> {
  const runDir = makeRunDir(scenario.name);
  const t0 = Date.now();
  const killAfter = scenario.timeoutMs + KILL_GRACE_MS;
  logger.info('live-test', `── ${scenario.name} ── ${scenario.description}`);
  logger.info('live-test', `  spawning isolated child (hard-kill after ${(killAfter / 1000).toFixed(0)}s) → ${runDir}`);

  const child = spawn(process.execPath, ['--import', 'tsx', 'live-tests/run-one.ts', scenario.name], {
    cwd: process.cwd(),
    env: { ...process.env, EDEN_LIVE_RUNDIR: runDir },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let killed = false;
  const killTimer = setTimeout(() => {
    killed = true;
    logger.error('live-test', `  ${scenario.name}: HARD-KILL — child exceeded ${(killAfter / 1000).toFixed(0)}s (wedged?). SIGKILL.`);
    if (child.pid !== undefined) hardKill(child.pid);
  }, killAfter);

  const exitCode: number = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      logger.error('live-test', `  ${scenario.name}: spawn error — ${err.message}`);
      resolve(99);
    });
  });
  clearTimeout(killTimer);

  // The child wrote result.json at scenario end; if we killed it (or it crashed) before that, synthesize FAIL.
  const resultPath = join(runDir, 'result.json');
  if (!killed && existsSync(resultPath)) {
    try {
      const parsed = JSON.parse(readFileSync(resultPath, 'utf8')) as { pass: boolean; report: string; durationMs: number };
      return { name: scenario.name, pass: parsed.pass, report: parsed.report, runDir, durationMs: parsed.durationMs };
    } catch {
      /* fall through to synthesized failure */
    }
  }
  const why = killed
    ? `hard-killed after ${(killAfter / 1000).toFixed(0)}s — child wedged (see ${runDir})`
    : `child exited ${exitCode} without writing result.json (crash before assert)`;
  return { name: scenario.name, pass: false, report: why, runDir, durationMs: Date.now() - t0 };
}

function usage(): void {
  logger.info('live-test', `usage: npm run live-test [name]`);
  logger.info('live-test', `  names: ${SCENARIOS.map((s) => s.name).join(', ')}  (omit to run all, in order)`);
}

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    usage();
    return 0;
  }
  if (!process.env['OPENAI_API_KEY']) {
    logger.error('live-test', 'OPENAI_API_KEY is not set — live scenarios drive a real LLM. Export it and retry.');
    return 2;
  }
  const selected = arg ? SCENARIOS.filter((s) => s.name === arg) : SCENARIOS;
  if (arg && selected.length === 0) {
    logger.error('live-test', `unknown scenario "${arg}".`);
    usage();
    return 2;
  }

  logger.info('live-test', `running ${selected.length} scenario(s), process-isolated: ${selected.map((s) => s.name).join(', ')}`);
  const reports: SupervisedResult[] = [];
  for (let i = 0; i < selected.length; i++) {
    const report = await superviseScenario(selected[i]!);
    reports.push(report);
    logger.info('live-test', `${report.pass ? 'PASS' : 'FAIL'} ${report.name} (${(report.durationMs / 1000).toFixed(0)}s)`);
    for (const line of report.report.split('\n')) logger.info('live-test', `    ${line}`);
    logger.info('live-test', `    evidence: ${report.runDir}`);
    if (i < selected.length - 1) {
      logger.info('live-test', '    settling 10s before the next scenario …');
      await sleep(10_000);
    }
  }

  logger.info('live-test', '═══ SUMMARY ═══');
  for (const r of reports) logger.info('live-test', `  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  const failed = reports.filter((r) => !r.pass).length;
  logger.info('live-test', `${reports.length - failed}/${reports.length} passed`);
  return failed;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((failed) => process.exit(failed))
    .catch((err: unknown) => {
      logger.error('live-test', `FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(1);
    });
}
