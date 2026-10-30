// Experiments against controls: one row per (run, phase), the main measurements side by side. Controls are the
// runs whose label starts with "control" (default settings, same N and stagger as the experiments); their range is
// the noise floor an experiment has to clear.
//
//   cd squad && npm run bench:compare -- bench/.runs            (every run directory with a results.json)

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PhaseResult } from './lib/table';

const root = process.argv[2] ?? 'bench/.runs';
const runs = readdirSync(root)
  .filter((d) => existsSync(join(root, d, 'results.json')))
  .map((d) => ({ dir: d, label: d.replace(/^.*?Z-/, ''), ...(JSON.parse(readFileSync(join(root, d, 'results.json'), 'utf8')) as { env: { variant: Record<string, unknown> }; results: PhaseResult[] }) }))
  .filter((r) => /^(control|exp-)/.test(r.label));

const PHASES = ['idle', 'follow', 'walk', 'gather'] as const;
const f = (v: number | undefined | null): string => (v === undefined || v === null || !Number.isFinite(v) ? '' : String(Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10));

let md = '';
for (const phase of PHASES) {
  const rows = runs.flatMap((r) => r.results.filter((x) => x.phase === phase && x.n === 10).map((x) => ({ label: r.label, x })));
  if (rows.length === 0) continue;
  md += `\n### ${phase} (N = 10)\n\n`;
  md += '| run | ELU | loop p50 / p99 ms | ticks/s min | CPU % | A* % | look-ahead % | physics % | decode+inflate % | paths ok / noPath / timeout | work |\n';
  md += '|---|---|---|---|---|---|---|---|---|---|---|\n';
  rows.sort((a, b) => (a.label.startsWith('control') === b.label.startsWith('control') ? a.label.localeCompare(b.label) : a.label.startsWith('control') ? -1 : 1));
  for (const { label, x } of rows) {
    const p = x.process;
    const b = x.bots;
    const work = x.walk ? `legs ${x.walk.legs.ok ?? 0} ok, ${x.walk.legs.timeout ?? 0} timeout, ${(x.walk.legs.noPath ?? 0) + (x.walk.legs.stall ?? 0) + (x.walk.legs.other ?? 0)} other` : x.gather ? `${x.gather.logsMined} logs` : '';
    md +=
      `| ${label} | ${f(p.elu)} | ${f(p.loop.p50)} / ${f(p.loop.p99)} | ${f(b?.ticksPerSec.min)} | ${f(p.cpuPct)} | ${f(p.share.astar)} | ${f(p.share.lookahead)} | ${f(p.share.physics)} | ` +
      `${f(p.share.decode + p.share.inflate)} | ${b ? `${b.path.success} / ${b.path.noPath} / ${b.path.timeout}` : ''} | ${work} |\n`;
  }
}
process.stdout.write(md);
writeFileSync(join(root, 'compare.md'), md);
