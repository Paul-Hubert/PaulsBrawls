// Child entry: run ONE scenario in its OWN process. The parent (run.ts) spawns this per scenario so a
// wedge in the code-under-test (e.g. a macrotask-starving skill the engine guard can't see, like sync
// recursion) can be KILLED by the parent's timer — which lives in a separate, healthy event loop — instead
// of hanging the whole suite. The parent passes the evidence dir via EDEN_LIVE_RUNDIR so it can read this
// run's result.json even when it has to SIGKILL us. Exit code: 0 = PASS, 1 = FAIL, 2/3 = harness error.
//
// Also directly runnable for a single scenario:
//   node --import tsx live-tests/run-one.ts farm-wheat
//   node --import tsx live-tests/run-one.ts farm-wheat --provider openai

import { pathToFileURL } from 'node:url';

import { logger } from '../src/logger';
import { runScenario } from './harness';
import { SCENARIOS } from './catalogue';
import { loadApiKeys, setupProviderEnv, DEFAULT_PROVIDER } from './config';

async function main(): Promise<number> {
  // When run as a child, EDEN_LIVE_PROVIDER + OPENAI_API_KEY are already in env (set by the parent).
  // When run directly, we parse --provider ourselves and load api-keys.env.
  const argv = process.argv.slice(2);
  let name: string | undefined;
  let providerArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === '--provider' || a === '-p') && argv[i + 1]) {
      providerArg = argv[++i];
    } else if (!a.startsWith('--')) {
      name = a;
    }
  }

  const providerName = providerArg ?? process.env['EDEN_LIVE_PROVIDER'] ?? DEFAULT_PROVIDER;

  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) {
    logger.error('live-test', `run-one: unknown or missing scenario "${name ?? ''}". Known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    return 2;
  }

  // Load api-keys.env (no-op if keys are already in env from the parent).
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

  const runDir = process.env['EDEN_LIVE_RUNDIR'];
  const report = await runScenario(scenario, { provider: providerName, ...(runDir ? { runDir } : {}) });
  logger.info('live-test', `${report.pass ? 'PASS' : 'FAIL'} ${report.name} (${(report.durationMs / 1000).toFixed(0)}s) — ${report.runDir}`);
  for (const line of report.report.split('\n')) logger.info('live-test', `    ${line}`);
  return report.pass ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      logger.error('live-test', `run-one FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(3);
    });
}
