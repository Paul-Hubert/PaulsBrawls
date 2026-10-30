// The Minecraft server's side of a measurement: its properties, RCON, `tick query` (mean and percentiles of the last
// 100 ticks), the "Can't keep up!" lines of its log, and the CPU time of its JVM (Windows: Get-Process; elsewhere
// `ps`). Never starts or stops a server.

import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { Rcon } from '../../live-tests/rcon';

const run = promisify(execFile);

export function readProps(file: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  ) as Record<string, string>;
}

export interface TickSample {
  at: number;
  meanMs: number;
  p50: number;
  p95: number;
  p99: number;
}

/** `tick query` → mean and percentiles of the server's last 100 ticks (1.20.3+). */
export async function tickQuery(rcon: Rcon): Promise<TickSample | undefined> {
  const text = await rcon.command('tick query');
  const mean = /Average time per tick: ([\d.,]+)\s*ms/i.exec(text);
  const pct = /P50: ([\d.,]+)\s*ms P95: ([\d.,]+)\s*ms P99: ([\d.,]+)\s*ms/i.exec(text);
  if (!mean || !pct) return undefined;
  const n = (s: string | undefined): number => Number(String(s).replace(',', '.'));
  return { at: Date.now(), meanMs: n(mean[1]), p50: n(pct[1]), p95: n(pct[2]), p99: n(pct[3]) };
}

/** New lines of the server's latest.log since the last call. */
export class LogTail {
  private offset: number;

  constructor(private readonly file: string) {
    this.offset = existsSync(file) ? statSync(file).size : 0;
  }

  static forServer(propsFile: string): LogTail {
    return new LogTail(join(dirname(propsFile), 'logs', 'latest.log'));
  }

  read(): string[] {
    if (!existsSync(this.file)) return [];
    const size = statSync(this.file).size;
    if (size < this.offset) this.offset = 0; // rotated
    if (size === this.offset) return [];
    const fd = openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      return buf.toString('utf8').split(/\r?\n/).filter(Boolean);
    } finally {
      closeSync(fd);
    }
  }
}

export interface KeepUp {
  count: number;
  /** The worst "Running Nms or M ticks behind". */
  worstMs: number;
}

export function keepUpLines(lines: string[]): KeepUp {
  let count = 0;
  let worstMs = 0;
  for (const l of lines) {
    if (!/Can't keep up/i.test(l)) continue;
    count++;
    const m = /Running (\d+)ms/.exec(l);
    if (m) worstMs = Math.max(worstMs, Number(m[1]));
  }
  return { count, worstMs };
}

/** The pid listening on a TCP port (the server), or undefined. */
export async function pidOnPort(port: number): Promise<number | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of stdout.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 5 && cols[1]?.endsWith(`:${port}`) && /LISTEN/i.test(cols[3] ?? '')) return Number(cols[4]);
      }
      return undefined;
    }
    const { stdout } = await run('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
    const pid = Number(stdout.trim().split('\n')[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Total CPU time (ms, all threads) and working set (MB) of a process. */
export async function processCpu(pid: number): Promise<{ cpuMs: number; rssMb: number } | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell', [
        '-NoProfile',
        '-Command',
        `$p = Get-Process -Id ${pid}; "$($p.TotalProcessorTime.TotalMilliseconds) $($p.WorkingSet64)"`,
      ]);
      const [cpu, ws] = stdout.trim().split(/\s+/).map((s) => Number(s.replace(',', '.')));
      return { cpuMs: cpu ?? 0, rssMb: (ws ?? 0) / 1048576 };
    }
    const { stdout } = await run('ps', ['-o', 'cputimes=,rss=', '-p', String(pid)]);
    const [cpu, rss] = stdout.trim().split(/\s+/).map(Number);
    return { cpuMs: (cpu ?? 0) * 1000, rssMb: (rss ?? 0) / 1024 };
  } catch {
    return undefined;
  }
}
