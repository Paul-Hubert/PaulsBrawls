// The load benchmark's result shape and its Markdown rendering (shared by load.ts and report.ts).

import type { BotPhase, Dist, ProcessPhase } from './probe';
import type { KeepUp } from './server';

export type Phase = 'idle' | 'follow' | 'walk' | 'gather';

export interface ServerPhase {
  tick: { mean: number; p50: number; p95: number; p99Max: number; samples: number } | null;
  keepUp: KeepUp;
  cpuPct: number | null;
  rssMb: number | null;
}

export interface PhaseResult {
  n: number;
  phase: Phase | 'login';
  process: ProcessPhase;
  bots: BotPhase | null;
  server: ServerPhase;
  walk?: { legs: Record<string, number>; legMs: Dist; blocksPerLeg: Dist; examples: string[] };
  gather?: { logsMined: number; status: string; failures: number; failureExamples: string[] };
  deafTrips: number;
  skippedPackets: number;
  profile?: string;
}

export function work(r: PhaseResult): string {
  if (r.walk) return `legs ${Object.entries(r.walk.legs).map(([k, v]) => `${k} ${v}`).join(', ')}`;
  if (r.gather) return `${r.gather.logsMined} logs`;
  return '';
}

export function summaryLine(r: PhaseResult): string {
  const p = r.process;
  const s = r.server;
  const b = r.bots;
  return (
    `N=${r.n} ${r.phase}: loop p50/p99/max ${p.loop.p50}/${p.loop.p99}/${p.loop.max} ms, ELU ${p.elu}, CPU ${p.cpuPct}%, RSS ${p.rssMb} MB, ` +
    `A* ${p.share.astar}% look-ahead ${p.share.lookahead ?? '-'}% physics ${p.share.physics}% decode ${p.share.decode}% inflate ${p.share.inflate}%` +
    (b ? `, ticks/s min ${b.ticksPerSec.min} mean ${b.ticksPerSec.mean}, ${b.kbPerSecPerBot} KB/s/bot, paths ok ${b.path.success} noPath ${b.path.noPath} timeout ${b.path.timeout}` : '') +
    (s.tick ? `; server tick ${s.tick.mean} ms (p95 ${s.tick.p95}), keep-up ${s.keepUp.count}, JVM CPU ${s.cpuPct}%` : '') +
    (r.walk || r.gather ? `; ${work(r)}` : '') +
    (r.deafTrips ? `; deaf ${r.deafTrips}` : '') +
    (r.skippedPackets ? `; skipped packets ${r.skippedPackets}` : '')
  );
}

export function table(rs: PhaseResult[]): string {
  const head =
    '| N | phase | loop p50 / p99 / max (ms) | ELU | CPU % | RSS MB | A* % | look-ahead % | physics % | decode % | inflate % | ticks/s min / mean | KB/s/bot | paths ok / noPath / timeout | plan p95 ms | server tick ms (p95) | keep-up | JVM CPU % | work |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  const rows = rs.map((r) => {
    const p = r.process;
    const b = r.bots;
    const s = r.server;
    return (
      `| ${r.n} | ${r.phase} | ${p.loop.p50} / ${p.loop.p99} / ${p.loop.max} | ${p.elu} | ${p.cpuPct} | ${p.rssMb} | ${p.share.astar} | ${p.share.lookahead ?? ''} | ${p.share.physics} | ` +
      `${p.share.decode} | ${p.share.inflate} | ${b ? `${b.ticksPerSec.min} / ${b.ticksPerSec.mean}` : ''} | ${b?.kbPerSecPerBot ?? ''} | ` +
      `${b ? `${b.path.success} / ${b.path.noPath} / ${b.path.timeout}` : ''} | ${b?.path.planMs.p95 ?? ''} | ${s.tick ? `${s.tick.mean} (${s.tick.p95})` : ''} | ` +
      `${s.keepUp.count ? `${s.keepUp.count} (${s.keepUp.worstMs} ms)` : '0'} | ${s.cpuPct ?? ''} | ${work(r)} |`
    );
  });
  return head + rows.join('\n') + '\n';
}
