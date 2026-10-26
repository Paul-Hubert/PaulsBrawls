#!/usr/bin/env node

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { AdminClient } from './admin.js';
import { DEFAULT_ADMIN_PORT, DEFAULT_MOCK_PORT, EVAL_BOTS, SETTLEMENT_URL, TAG_ALL } from './fixture.js';
import { MockLLM } from './mock-llm.js';
import { RconClient } from './rcon.js';
import { scenariosForSuite } from './scenarios/index.js';
import type { EvalContext, EvalReport, LLMMode, Scenario, ScenarioResult, SuiteName } from './types.js';
import { parseProperties, sleep } from './util.js';
import { runWorldSetup } from './world-setup.js';

/**
 * The eval orchestrator (`npm run eval`):
 *
 *   npm run eval                                  # everything, mock LLM
 *   npm run eval -- --suite reflex --llm mock     # S1–S4 + S8
 *   npm run eval -- --suite trade  --llm mock     # S5–S7
 *   npm run eval -- --suite tasks  --llm mock     # T1 — higher-level tasks
 *   npm run eval -- --llm real                    # outcome-tolerant, real provider
 *   npm run eval -- --keep-up                     # leave village+mock running after
 *
 * It owns the full lifecycle: RCON pre-flight against the (already running)
 * Minecraft test server, world fixture build, a FRESH village process per run
 * (clean dataDir, --test-hooks), scenario execution with one retry each, and
 * eval/report.json + a console table + a meaningful exit code.
 *
 * The Minecraft server itself is NOT managed here — see eval/README.md for
 * the one-time setup (Fabric 1.21.1 + the paulsbrawls jar + RCON enabled).
 */

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(EVAL_DIR, '..');
const DATA_DIR = path.join(EVAL_DIR, '.village-data-eval');
const LOGS_DIR = path.join(EVAL_DIR, '.logs');
const REPORT_PATH = path.join(EVAL_DIR, 'report.json');

interface EvalArgs {
  suite: SuiteName;
  llm: LLMMode;
  serverDir: string;
  mcHost: string;
  mcPort: number;
  adminPort: number;
  mockPort: number;
  keepUp: boolean;
  bootTimeout: number;
}

function parseArgs(): EvalArgs {
  return yargs(hideBin(process.argv))
    .option('suite',        { type: 'string', default: 'all', choices: ['reflex', 'trade', 'tasks', 'all'], description: 'Which scenario suite to run' })
    .option('llm',          { type: 'string', default: 'mock', choices: ['mock', 'real'], description: 'mock = scripted local LLM (deterministic, free); real = roster provider' })
    .option('server-dir',   { type: 'string', default: 'C:/Users/Paul/Desktop/pauls-brawls/run', description: 'Minecraft test server directory (reads server.properties for RCON)' })
    .option('mc-host',      { type: 'string', default: '127.0.0.1', description: 'Minecraft server host' })
    .option('mc-port',      { type: 'number', default: 25599, description: 'Minecraft server port' })
    .option('admin-port',   { type: 'number', default: DEFAULT_ADMIN_PORT, description: 'Village admin API port' })
    .option('mock-port',    { type: 'number', default: DEFAULT_MOCK_PORT, description: 'Mock LLM port' })
    .option('keep-up',      { type: 'boolean', default: false, description: 'Leave the village process + mock LLM running after the run (debugging)' })
    .option('boot-timeout', { type: 'number', default: 180, description: 'Seconds to wait for all village bots to connect' })
    .help()
    .alias('help', 'h')
    .parseSync() as unknown as EvalArgs;
}

// -- logging ------------------------------------------------------------------

let logStream: fs.WriteStream | null = null;

function logLine(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  logStream?.write(`${stamped}\n`);
}

function fileOnly(line: string): void {
  logStream?.write(`[${new Date().toISOString()}] ${line}\n`);
}

// -- pre-flight ----------------------------------------------------------------

interface RconSettings {
  port: number;
  password: string;
}

function readRconSettings(serverDir: string): RconSettings {
  const propsPath = path.join(serverDir, 'server.properties');
  if (!fs.existsSync(propsPath)) {
    throw new Error(`no server.properties in '${serverDir}' — point --server-dir at the Minecraft test server (see eval/README.md)`);
  }
  const props = parseProperties(fs.readFileSync(propsPath, 'utf8'));
  if (props['enable-rcon'] !== 'true') {
    throw new Error(`enable-rcon=false in ${propsPath} — set enable-rcon=true and rcon.password, then restart the server (see eval/README.md)`);
  }
  const password = props['rcon.password'] ?? '';
  if (!password) {
    throw new Error(`rcon.password is empty in ${propsPath} — set one, then restart the server`);
  }
  return { port: Number(props['rcon.port'] ?? 25575), password };
}

async function checkSettlementListener(): Promise<void> {
  try {
    const resp = await fetch(`${SETTLEMENT_URL}/trade/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    // Any HTTP answer (400 expected for an empty body) proves the mod listener is up.
    fileOnly(`settlement listener probe -> HTTP ${resp.status}`);
  } catch {
    throw new Error(
      `the mod's trade-settlement listener (${SETTLEMENT_URL}) is unreachable — is the Minecraft server running with the paulsbrawls jar and '/village on'?`
    );
  }
}

// -- village process ------------------------------------------------------------

function buildRoster(llmMode: LLMMode): string {
  const testRoster = path.join(EVAL_DIR, 'village.test.json');
  if (llmMode === 'mock') return testRoster;
  // Real mode: same bots/world knobs, but the LLM settings come from the
  // operator's own village.json (provider, model, key).
  const realConfigPath = path.join(MCP_ROOT, 'village.json');
  if (!fs.existsSync(realConfigPath)) {
    throw new Error(`--llm real needs ${realConfigPath} (copy village.example.json and set your provider)`);
  }
  const base = JSON.parse(fs.readFileSync(testRoster, 'utf8')) as { settings: Record<string, unknown> };
  const real = JSON.parse(fs.readFileSync(realConfigPath, 'utf8')) as { settings?: { llm?: unknown } };
  if (!real.settings?.llm) throw new Error(`${realConfigPath} has no settings.llm block`);
  base.settings.llm = real.settings.llm;
  const generated = path.join(EVAL_DIR, 'village.real.generated.json');
  fs.writeFileSync(generated, JSON.stringify(base, null, 1), 'utf8');
  return generated;
}

function startVillage(args: EvalArgs, rosterPath: string, onExit: (code: number | null) => void): ChildProcess {
  const villageLog = fs.createWriteStream(path.join(LOGS_DIR, 'village.log'), { flags: 'w' });
  const child = spawn(
    process.execPath,
    [
      '--import', 'tsx',
      'src/village/main.ts',
      '--host', args.mcHost,
      '--port', String(args.mcPort),
      '--roster', rosterPath,
      '--admin-port', String(args.adminPort),
      '--test-hooks',
    ],
    { cwd: MCP_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.pipe(villageLog);
  child.stderr?.pipe(villageLog);
  child.on('exit', (code) => onExit(code));
  return child;
}

async function waitForVillage(admin: AdminClient, timeoutSeconds: number): Promise<void> {
  const expected = EVAL_BOTS.map((b) => b.name);
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let lastDetail = '(no status yet)';
  while (Date.now() < deadline) {
    try {
      const connected = await admin.connectedBots();
      lastDetail = `${connected.length}/${expected.length} connected`;
      if (expected.every((name) => connected.includes(name))) {
        logLine(`village up: ${lastDetail}`);
        return;
      }
    } catch (err) {
      lastDetail = `admin API not answering (${err instanceof Error ? err.message : String(err)})`;
    }
    await sleep(3_000);
  }
  throw new Error(`village did not come up within ${timeoutSeconds}s — last state: ${lastDetail} (see eval/.logs/village.log)`);
}

// -- scenario runner --------------------------------------------------------------

async function runScenario(scenario: Scenario, ctx: EvalContext, childAlive: () => boolean): Promise<ScenarioResult> {
  if (scenario.mockOnly && ctx.llmMode === 'real') {
    logLine(`-- ${scenario.id} ${scenario.name}: SKIPPED (mock-only scenario under --llm real)`);
    return { id: scenario.id, name: scenario.name, pass: true, skipped: true, attempts: 0, elapsedMs: 0, llmCalls: 0 };
  }

  const maxAttempts = 2; // one retry per scenario
  let failure = '';
  let llmCalls = 0;
  let elapsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!childAlive()) {
      return { id: scenario.id, name: scenario.name, pass: false, attempts: attempt, elapsedMs: elapsed, llmCalls, failure: 'village process exited' };
    }
    logLine(`-- ${scenario.id} ${scenario.name} (attempt ${attempt}/${maxAttempts})`);
    const before = await ctx.admin.schedulerCompleted().catch(() => 0);
    const t0 = Date.now();
    let pass = false;
    try {
      await scenario.setup(ctx);
      await scenario.trigger(ctx);
      await scenario.assert(ctx);
      pass = true;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      logLine(`   ${scenario.id} attempt ${attempt} FAILED: ${failure}`);
    } finally {
      try {
        await scenario.teardown(ctx);
      } catch (err) {
        logLine(`   ${scenario.id} teardown error (continuing): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    elapsed = Date.now() - t0;
    llmCalls = (await ctx.admin.schedulerCompleted().catch(() => before)) - before;
    if (pass) {
      logLine(`   ${scenario.id} PASS in ${(elapsed / 1_000).toFixed(1)}s (${llmCalls} LLM call(s))`);
      return { id: scenario.id, name: scenario.name, pass: true, attempts: attempt, elapsedMs: elapsed, llmCalls };
    }
  }
  return { id: scenario.id, name: scenario.name, pass: false, attempts: maxAttempts, elapsedMs: elapsed, llmCalls, failure };
}

// -- report -------------------------------------------------------------------------

function printTable(report: EvalReport): void {
  const rows = report.scenarios.map((s) => [
    s.id,
    s.name,
    s.skipped ? 'SKIP' : s.pass ? 'PASS' : 'FAIL',
    s.skipped ? '-' : `${(s.elapsedMs / 1_000).toFixed(1)}s`,
    s.skipped ? '-' : String(s.llmCalls),
    s.failure ? s.failure.slice(0, 80) : '',
  ]);
  const header = ['ID', 'scenario', 'result', 'time', 'LLM', 'detail'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const formatRow = (r: string[]): string => r.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  console.log('');
  console.log(formatRow(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(formatRow(row));
  console.log('');
  console.log(`SUITE ${report.suite} (${report.llmMode}): ${report.pass ? 'PASS' : 'FAIL'}`);
}

// -- main ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  logStream = fs.createWriteStream(path.join(LOGS_DIR, 'eval.log'), { flags: 'w' });

  const scenarios = scenariosForSuite(args.suite);
  logLine(`eval: suite=${args.suite} llm=${args.llm} → ${scenarios.map((s) => s.id).join(', ')}`);

  // 1. Pre-flight: RCON + (for trade scenarios) the mod's settlement listener.
  const rconSettings = readRconSettings(args.serverDir);
  let rcon: RconClient;
  try {
    rcon = await RconClient.connect(args.mcHost, rconSettings.port, rconSettings.password, fileOnly);
  } catch (err) {
    throw new Error(
      `cannot reach RCON at ${args.mcHost}:${rconSettings.port} (${err instanceof Error ? err.message : String(err)}) — is the Minecraft server running?`
    );
  }
  await rcon.send('list');
  if (scenarios.some((s) => s.suite === 'trade')) {
    await checkSettlementListener();
  }

  // 2. World fixture.
  logLine('building world fixture via RCON…');
  await runWorldSetup(rcon, logLine);

  // 3. Mock LLM.
  let mock: MockLLM | null = null;
  if (args.llm === 'mock') {
    mock = new MockLLM(fileOnly);
    await mock.start(args.mockPort);
    logLine(`mock LLM on http://127.0.0.1:${args.mockPort}/v1/chat/completions`);
  }

  // 4. Fresh village state + pre-boot seeds (e.g. S7's broken skill).
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const scenario of scenarios) {
    await scenario.preBoot?.({ dataDir: DATA_DIR });
  }

  // 5. Boot the village process.
  const rosterPath = buildRoster(args.llm);
  let childExitCode: number | null | undefined;
  const child = startVillage(args, rosterPath, (code) => {
    childExitCode = code;
    logLine(`village process exited (code ${code})`);
  });
  const childAlive = (): boolean => childExitCode === undefined;
  const admin = new AdminClient(`http://127.0.0.1:${args.adminPort}`);

  const ctx: EvalContext = { rcon, admin, mock, llmMode: args.llm, log: logLine };
  const results: ScenarioResult[] = [];
  const startedAt = new Date().toISOString();

  try {
    await waitForVillage(admin, args.bootTimeout);

    // Anchor everyone: respawn at home, start at home.
    for (const bot of EVAL_BOTS) {
      await rcon.send(`spawnpoint ${bot.name} ${bot.home.x} ${bot.home.y} ${bot.home.z}`);
      await rcon.tp(bot.name, bot.home.x, bot.home.y, bot.home.z);
    }
    await sleep(3_000);

    for (const scenario of scenarios) {
      results.push(await runScenario(scenario, ctx, childAlive));
    }
  } finally {
    if (args.keepUp) {
      logLine(`--keep-up: village (pid ${child.pid}) and mock LLM left running; world fixture left in place`);
    } else {
      child.kill();
      await mock?.stop();
      try {
        await rcon.killTagged(TAG_ALL);
        await rcon.killDroppedItems();
        await rcon.timeSet(1_000);
      } catch {
        // Server went away — nothing left to sweep.
      }
    }
    await rcon.end().catch(() => {});
  }

  const report: EvalReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    llmMode: args.llm,
    suite: args.suite,
    pass: results.every((r) => r.pass),
    scenarios: results,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  printTable(report);
  logLine(`report written to ${REPORT_PATH}`);
  return report.pass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logLine(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
