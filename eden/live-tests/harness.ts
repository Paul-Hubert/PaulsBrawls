// The live-scenario RUNNER. Given a Scenario it: applies the RCON arena, boots a REAL Eden host against
// the dev server (spawnBots + enableGod + installProcessGuards — the invariants the smoke paid for),
// waits for the assignees to connect, runs the post-connect prepare (tp/clear/give/summon), injects each
// task and drives it through the real refinement loop (god.addTask -> coordinator.assignAndRun), then runs
// the scenario's journal+world assertions and preserves the evidence (journal DB, LLM transcripts, a
// post-mortem report). One scenario = one fresh host + its own gitignored run dir; the dev server stays up.
//
// This is the tracked, parameterized successor to `.smoke/smoke-run.ts`. It is EXCLUDED from `npm run
// check` (no Minecraft, no API key in CI) — see live-tests/README.md.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { start, type EdenHost, type RolloutResult } from '../src/main';
import { logger } from '../src/logger';
import type { EdenConfig, VillagerConfig } from '../src/config';
import type { JournalEvent, Task } from '../src/types/index';
import { RconClient, type RconSend } from './rcon';
import { baseConfig, readServerProps, writeConfig, type ServerProps } from './config';
import { kindHistogram } from './checks';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A live scenario: roster + deterministic arena + tasks + a journal/world assertion. */
export interface Scenario {
  /** kebab id, also the run-dir + npm arg (e.g. `farm-wheat`). */
  name: string;
  /** one line shown in the summary. */
  description: string;
  /** the villagers for this scenario (and the avatar Dieu is added by the base config). */
  roster: VillagerConfig[];
  /** optional deep override on the assembled config (providers, budgets, …). */
  configure?: (base: EdenConfig) => EdenConfig;
  /** RCON commands building the deterministic arena — applied BEFORE Eden boots. */
  arena: string[];
  /** RCON commands run AFTER the assignees connect (tp / clear / give / summon). */
  prepare?: (connectedBots: string[]) => string[];
  /** tasks injected via god.addTask + coordinator.assignAndRun (run concurrently). */
  tasks: Task[];
  /** bots that must connect before prepare/run. Defaults to the distinct task assignees. */
  requiredBots?: string[];
  /** journal + world (RCON) pass/fail. */
  assert: (ctx: AssertContext) => Promise<AssertResult>;
  /** wall-clock ceiling for the whole run (the deadline each task races against). */
  timeoutMs: number;
}

/** The outcome of one injected task (the coordinator result, a timeout, or an error). */
export interface TaskOutcome {
  taskId: string;
  assignee?: string;
  result?: RolloutResult;
  timedOut: boolean;
  error?: string;
}

/** What a scenario's `assert` receives. */
export interface AssertContext {
  host: EdenHost;
  rcon: RconSend;
  outcomes: TaskOutcome[];
  /** the distinct assignee names. */
  villagers: string[];
  log: (msg: string) => void;
}

export interface AssertResult {
  pass: boolean;
  report: string;
}

/** The runner's verdict for one scenario. */
export interface ScenarioReport {
  name: string;
  pass: boolean;
  report: string;
  runDir: string;
  durationMs: number;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function runsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '.runs');
}

/** The gitignored evidence dir for a scenario run. Exported so the parent supervisor (run.ts) can
 *  pre-generate it and read `result.json` even when it has to KILL a wedged child (which never wrote one). */
export function makeRunDir(name: string): string {
  return join(runsRoot(), `${name}-${stamp()}`);
}

function assignees(tasks: Task[]): string[] {
  return [...new Set(tasks.map((t) => t.assignee).filter((a): a is string => a !== undefined))];
}

async function waitForBots(host: EdenHost, names: string[], timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const want = new Set(names);
  while (Date.now() < deadline) {
    const connected = new Set(
      host.journal.query({ kinds: ['system.bot-connected'] }).map((e) => (e.payload as { name?: string }).name),
    );
    if ([...want].every((n) => connected.has(n))) return [...connected].filter((n): n is string => n !== undefined);
    await sleep(2000);
  }
  const connected = host.journal.query({ kinds: ['system.bot-connected'] }).map((e) => (e.payload as { name?: string }).name);
  return connected.filter((n): n is string => n !== undefined);
}

async function runTask(host: EdenHost, task: Task, timeoutMs: number, log: (m: string) => void): Promise<TaskOutcome> {
  host.god!.addTask(task);
  log(`task injected: id=${task.id} assignee=${task.assignee ?? '(none)'} check=${JSON.stringify(task.check ?? null)} goal="${task.goal.slice(0, 80)}…"`);
  try {
    const raced = await Promise.race([
      host.coordinator!.assignAndRun(task, { trigger: 'admin' }).then((r) => ({ kind: 'result' as const, r })),
      sleep(timeoutMs).then(() => ({ kind: 'deadline' as const })),
    ]);
    if (raced.kind === 'deadline') {
      log(`task ${task.id}: deadline (${timeoutMs / 1000}s) reached before assignAndRun returned`);
      return { taskId: task.id, assignee: task.assignee, timedOut: true };
    }
    log(`task ${task.id}: assignAndRun -> ${JSON.stringify(raced.r)}`);
    return { taskId: task.id, assignee: task.assignee, result: raced.r, timedOut: false };
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`task ${task.id}: assignAndRun THREW — ${message}`);
    return { taskId: task.id, assignee: task.assignee, timedOut: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Render a compact post-mortem (kind histogram + a key-event timeline) for the evidence file. */
function journalReport(host: EdenHost): string {
  const all = host.journal.query({ limit: 1_000_000 });
  const t0 = all.length ? all[0]!.at : 0;
  const dt = (at: number): string => '+' + ((at - t0) / 1000).toFixed(1) + 's';
  const clip = (v: unknown, n = 140): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  const lines: string[] = [];
  const hist = kindHistogram(host);
  lines.push(`=== ${all.length} events ===`, '=== KIND HISTOGRAM ===');
  for (const [k, n] of Object.entries(hist).sort((a, b) => b[1] - a[1])) lines.push(`${String(n).padStart(4)} ${k}`);
  lines.push('', '=== KEY TIMELINE ===');
  const keep = new Set([
    'system.boot', 'system.bot-connected', 'system.error', 'world.death',
    'god.task-proposed', 'god.directive', 'inbox.delivered',
    'skill.draft', 'skill.run', 'god.ticket', 'god.verdict', 'skill.admit', 'brain.done',
  ]);
  for (const e of all.filter((x) => keep.has(x.kind))) {
    lines.push(`${dt(e.at).padStart(8)} | ${e.actor.padEnd(16)} | ${e.kind.padEnd(20)} | ${clip(summarize(e))}`);
  }
  return lines.join('\n') + '\n';
}

function summarize(e: JournalEvent): unknown {
  const p = e.payload as Record<string, unknown>;
  switch (e.kind) {
    case 'skill.run': return { skill: p['skill'], ok: (p['outcome'] as { ok?: boolean } | undefined)?.ok, villager: p['villager'] };
    case 'skill.draft': return { name: p['name'], v: p['version'], author: p['author'], lines: p['lines'] };
    case 'god.verdict': return { success: p['success'], action: p['libraryAction'], critique: p['critique'] };
    case 'world.death': return { name: p['name'], cause: p['cause'] };
    case 'brain.done': return { villager: p['villager'], toolCalls: p['toolCalls'], summary: p['summary'] };
    default: return p;
  }
}

function writeEvidence(runDir: string, host: EdenHost, report: ScenarioReport): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'journal-report.txt'), journalReport(host), 'utf8');
  writeFileSync(
    join(runDir, 'result.json'),
    JSON.stringify({ name: report.name, pass: report.pass, durationMs: report.durationMs, report: report.report }, null, 2),
    'utf8',
  );
}

/**
 * Run ONE scenario end to end. Returns its PASS/FAIL report; never throws on a scenario-level failure
 * (a thrown error is itself reported as FAIL). The dev server is assumed already running; only the Eden
 * host is created and torn down here.
 */
export async function runScenario(scenario: Scenario, opts: { runDir?: string } = {}): Promise<ScenarioReport> {
  const t0 = Date.now();
  const runDir = opts.runDir ?? makeRunDir(scenario.name);
  const log = (m: string): void => logger.info('live-test', `[${scenario.name}] ${m}`);

  const props: ServerProps = readServerProps();
  const config = (scenario.configure ?? ((c) => c))(baseConfig(props, scenario.roster));
  const configPath = writeConfig(runDir, config);
  const dataDir = join(runDir, '.eden-data');
  log(`run dir ${runDir} — mc 127.0.0.1:${props.mcPort}, rcon :${props.rconPort}, admin :${config.admin.port}`);

  const rconClient = new RconClient({ host: props.rconHost, port: props.rconPort, password: props.rconPassword });
  const rcon: RconSend = (cmd) => rconClient.send(cmd);

  let host: EdenHost | undefined;
  let progress: ReturnType<typeof setInterval> | undefined;
  try {
    await rconClient.connect();
    log(`applying arena (${scenario.arena.length} RCON commands) …`);
    await rconClient.sendAll(scenario.arena);

    log('booting Eden host (spawnBots + enableGod + installProcessGuards) …');
    host = await start(configPath, { dataDir, spawnBots: true, enableGod: true, installProcessGuards: true });
    if (!host.god || !host.coordinator) throw new Error('host booted without god/coordinator — enableGod failed');

    const required = scenario.requiredBots ?? assignees(scenario.tasks);
    log(`waiting for required bots to connect: [${required.join(', ')}] …`);
    const connected = await waitForBots(host, required, 120_000);
    const missingBots = required.filter((n) => !connected.includes(n));
    log(`connected: [${connected.join(', ')}] — missing: [${missingBots.join(', ')}]`);
    if (missingBots.length > 0) {
      const report: ScenarioReport = {
        name: scenario.name,
        pass: false,
        report: `required bot(s) never connected within 120s: [${missingBots.join(', ')}]. Is the dev server up on :${props.mcPort}?`,
        runDir,
        durationMs: Date.now() - t0,
      };
      writeEvidence(runDir, host, report);
      return report;
    }

    if (scenario.prepare) {
      const cmds = scenario.prepare(connected);
      log(`prepare (${cmds.length} RCON commands: tp/clear/give/summon) …`);
      await rconClient.sendAll(cmds);
    }
    log('settling 3s for chunk load + inventory sync …');
    await sleep(3000);

    progress = setInterval(() => log(`journal: ${JSON.stringify(kindHistogram(host!))}`), 20_000);

    log(`running ${scenario.tasks.length} task(s) through the refinement loop …`);
    const outcomes = await Promise.all(scenario.tasks.map((task) => runTask(host!, task, scenario.timeoutMs, log)));

    const ctx: AssertContext = { host, rcon, outcomes, villagers: assignees(scenario.tasks), log };
    const verdict = await scenario.assert(ctx);
    const report: ScenarioReport = { name: scenario.name, pass: verdict.pass, report: verdict.report, runDir, durationMs: Date.now() - t0 };
    writeEvidence(runDir, host, report);
    return report;
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`scenario ERROR — ${message}`);
    const report: ScenarioReport = { name: scenario.name, pass: false, report: `scenario threw: ${message}`, runDir, durationMs: Date.now() - t0 };
    if (host) {
      try {
        writeEvidence(runDir, host, report);
      } catch {
        /* best effort */
      }
    }
    return report;
  } finally {
    if (progress) clearInterval(progress);
    rconClient.close();
    if (host) {
      try {
        await host.stop();
      } catch {
        /* best effort */
      }
    }
  }
}
