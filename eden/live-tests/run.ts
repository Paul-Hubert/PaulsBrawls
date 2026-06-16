// Live-scenario CLI + parent SUPERVISOR: `npm run live-test [name] [-- --provider <name>]`.
// Each scenario runs in its OWN child process ([run-one.ts]); the parent enforces a hard wall-clock
// kill from THIS (healthy) event loop, so a wedge in the code-under-test can never hang the suite —
// the parent SIGKILLs the child and records a timeout FAIL, then moves on. With no name it runs the
// full suite in the suggested order (farm-wheat -> craft-wooden-tools -> cooperative-mob-defense).
// Exit code = number of FAILED scenarios (0 = all pass).
//
// REQUIRES a running dev server (port + RCON from run/server.properties), live-tests/providers.json,
// and the API key for the chosen provider in api-keys.env or the environment.
// EXCLUDED from `npm run check`. See README.md.
//
// Usage:
//   npm run live-test                             # all scenarios, default provider (deepseek)
//   npm run live-test -- farm-wheat               # one scenario, default provider
//   npm run live-test -- --provider openai        # all scenarios, openai
//   npm run live-test -- farm-wheat --provider openai

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { logger } from '../src/logger';
import { makeRunDir, type Scenario } from './harness';
import { SCENARIOS } from './catalogue';
import { loadApiKeys, setupProviderEnv, DEFAULT_PROVIDER } from './config';

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

/** Parse CLI args: optional positional scenario name + optional --provider flag. */
function parseArgs(): { scenarioName: string | undefined; providerName: string } {
  const argv = process.argv.slice(2);
  let scenarioName: string | undefined;
  let providerName: string = DEFAULT_PROVIDER;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--provider' || a === '-p') {
      if (argv[i + 1]) providerName = argv[++i]!;
    } else if (!a.startsWith('--')) {
      scenarioName = a;
    }
  }
  return { scenarioName, providerName };
}

/** Run one scenario in a killable child; the parent's timer (healthy event loop) bounds it absolutely. */
async function superviseScenario(scenario: Scenario, providerName: string): Promise<SupervisedResult> {
  const runDir = makeRunDir(scenario.name);
  const t0 = Date.now();
  const killAfter = scenario.timeoutMs + KILL_GRACE_MS;
  logger.info('live-test', `── ${scenario.name} ── ${scenario.description}`);
  logger.info('live-test', `  provider:${providerName} — spawning isolated child (hard-kill after ${(killAfter / 1000).toFixed(0)}s) → ${runDir}`);

  const child = spawn(process.execPath, ['--import', 'tsx', 'live-tests/run-one.ts', scenario.name], {
    cwd: process.cwd(),
    // OPENAI_API_KEY is already normalised in process.env by main(); the child inherits it.
    env: { ...process.env, EDEN_LIVE_RUNDIR: runDir, EDEN_LIVE_PROVIDER: providerName },
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
  logger.info('live-test', `usage: npm run live-test [-- [name] [--provider <name>]]`);
  logger.info('live-test', `  names:     ${SCENARIOS.map((s) => s.name).join(', ')}  (omit to run all, in order)`);
  logger.info('live-test', `  providers: defined in live-tests/providers.json  (default: ${DEFAULT_PROVIDER})`);
}

async function main(): Promise<number> {
  const { scenarioName, providerName } = parseArgs();
  if (scenarioName === '--help' || scenarioName === '-h') {
    usage();
    return 0;
  }

  // Load api-keys.env into env BEFORE setupProviderEnv so the file's keys are available.
  loadApiKeys();

  let entry;
  try {
    entry = setupProviderEnv(providerName);
  } catch (err) {
    logger.error('live-test', String(err instanceof Error ? err.message : err));
    return 2;
  }

  const keyEnv = entry.apiKeyEnv;
  if (keyEnv && !process.env['OPENAI_API_KEY']) {
    logger.error('live-test', `no API key for provider "${providerName}" — set ${keyEnv} in api-keys.env or the environment`);
    return 2;
  }
  if (!keyEnv) {
    logger.info('live-test', `provider "${providerName}" uses a local endpoint — no API key required`);
  }

  const selected = scenarioName ? SCENARIOS.filter((s) => s.name === scenarioName) : SCENARIOS;
  if (scenarioName && selected.length === 0) {
    logger.error('live-test', `unknown scenario "${scenarioName}".`);
    usage();
    return 2;
  }

  logger.info('live-test', `provider:${providerName} — running ${selected.length} scenario(s), process-isolated: ${selected.map((s) => s.name).join(', ')}`);
  const reports: SupervisedResult[] = [];
  for (let i = 0; i < selected.length; i++) {
    const report = await superviseScenario(selected[i]!, providerName);
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
