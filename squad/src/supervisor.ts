// The supervisor (docs/29 §7.3): the parent process of the runtime. No sandbox (O1) means a script can wedge the
// one event loop every bot lives on; the loop budget and the starvation canary prevent most of it, this is the
// backstop. The child beats a heartbeat over IPC every second; 10 s of silence → kill it and start it again, with
// backoff. On boot the runtime marks the orders that were running `interrupted` and tells their commanders.
//
//   npx tsx src/supervisor.ts squad.json        (npm start)

import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from './logger';

// Overridable for the supervisor's own test (a fixture child, a short timeout).
const HEARTBEAT_TIMEOUT_MS = Number(process.env.SQUAD_HEARTBEAT_TIMEOUT_MS) || 10_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const HEALTHY_AFTER_MS = 60_000;

const here = dirname(fileURLToPath(import.meta.url));
const mainFile = process.env.SQUAD_MAIN || join(here, 'main.ts');
const cfgPath = process.argv[2] ?? 'squad.json';
const tsx = import.meta.resolve('tsx');

let child: ChildProcess | undefined;
let lastBeat = 0;
let startedAt = 0;
let attempts = 0;
let stopping = false;

function launch(): void {
  startedAt = Date.now();
  lastBeat = Date.now() + Math.min(30_000, HEARTBEAT_TIMEOUT_MS * 3); // grace for the boot (stock, journal)
  const c = fork(mainFile, [cfgPath], { execArgv: ['--import', tsx], stdio: 'inherit' });
  child = c;
  c.on('message', (m: unknown) => {
    if ((m as { type?: string })?.type === 'heartbeat') lastBeat = Date.now();
  });
  c.on('exit', (code, signal) => {
    if (child !== c) return;
    child = undefined;
    if (stopping) return void process.exit(0);
    if (Date.now() - startedAt > HEALTHY_AFTER_MS) attempts = 0;
    const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] as number;
    attempts++;
    logger.warn('supervisor', `runtime exited (code ${code ?? '-'}, signal ${signal ?? '-'}); restarting in ${wait / 1000} s`);
    setTimeout(launch, wait);
  });
}

function kill(why: string): void {
  if (!child) return;
  logger.error('supervisor', `killing the runtime: ${why}`);
  child.kill('SIGKILL');
}

const watchdog = setInterval(() => {
  if (child && Date.now() - lastBeat > HEARTBEAT_TIMEOUT_MS) {
    kill(`no heartbeat for ${Math.round((Date.now() - lastBeat) / 1000)} s (a script wedged the event loop?)`);
  }
}, 1_000);

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  clearInterval(watchdog);
  if (!child) return void process.exit(0);
  child.send?.({ type: 'shutdown' });
  setTimeout(() => {
    kill('did not stop within 12 s');
    process.exit(0);
  }, 12_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
logger.info('supervisor', `starting the squad runtime (${cfgPath})`);
launch();
