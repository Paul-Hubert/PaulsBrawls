// Merge repeated load runs (bench/.runs/*/results.json) into one table: for each (N, phase), the mean of the runs
// and their spread (min–max) for the main measurements.
//
//   cd squad && npm run bench:report -- bench/.runs/<run1> bench/.runs/<run2> …

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PhaseResult } from './lib/table';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  process.stderr.write('usage: npm run bench:report -- <run dir> <run dir> …\n');
  process.exit(1);
}

const runs = dirs.map((d) => (JSON.parse(readFileSync(join(d, 'results.json'), 'utf8')) as { results: PhaseResult[] }).results);
const keys: string[] = [];
const groups = new Map<string, PhaseResult[]>();
for (const rs of runs) {
  for (const r of rs) {
    const k = `${r.n}|${r.phase}`;
    if (!groups.has(k)) {
      groups.set(k, []);
      keys.push(k);
    }
    groups.get(k)!.push(r);
  }
}

const cell = (vals: Array<number | null | undefined>): string => {
  const v = vals.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (v.length === 0) return '';
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const f = (x: number): string => String(Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10);
  if (v.length === 1) return f(mean);
  return `${f(mean)} (${f(Math.min(...v))}–${f(Math.max(...v))})`;
};

const head =
  '| N | phase | runs | loop p99 ms | loop max ms | ELU | CPU % | RSS MB | A* % | physics % | decode+inflate % | ticks/s min | path timeouts | server tick ms | server p95 ms | keep-up lines | JVM CPU % |\n' +
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
const rows = keys.map((k) => {
  const g = groups.get(k)!;
  const [n, phase] = k.split('|');
  return (
    `| ${n} | ${phase} | ${g.length} | ${cell(g.map((r) => r.process.loop.p99))} | ${cell(g.map((r) => r.process.loop.max))} | ${cell(g.map((r) => r.process.elu))} | ` +
    `${cell(g.map((r) => r.process.cpuPct))} | ${cell(g.map((r) => r.process.rssMb))} | ${cell(g.map((r) => r.process.share.astar))} | ${cell(g.map((r) => r.process.share.physics))} | ` +
    `${cell(g.map((r) => r.process.share.decode + r.process.share.inflate))} | ${cell(g.map((r) => r.bots?.ticksPerSec.min))} | ${cell(g.map((r) => r.bots?.path.timeout))} | ` +
    `${cell(g.map((r) => r.server.tick?.mean))} | ${cell(g.map((r) => r.server.tick?.p95))} | ${cell(g.map((r) => r.server.keepUp.count))} | ${cell(g.map((r) => r.server.cpuPct))} |`
  );
});
const md = head + rows.join('\n') + '\n';
process.stdout.write(md);
writeFileSync(join(dirs[0]!, 'report.md'), md);
