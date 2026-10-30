// What one phase of the load benchmark measures inside the runtime's process:
//   • the event loop: delay histogram (monitorEventLoopDelay, armed at the phase start) and utilization (ELU);
//   • the process: CPU (all threads, % of one core), RSS and heap, sampled every second;
//   • the shared-module counters of instrument.ts (decode, inflate, physics, A*), as a share of wall time;
//   • per bot: physics ticks per second (20 when smooth; mineflayer drops ticks after 4 catch-up ticks), packets
//     and bytes received, path searches by outcome and planning time, path resets by reason, deaths.

import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';

import type { Bot } from 'mineflayer';

import { takeCounters } from './instrument';

/** The delay histogram's sampling interval; a value is reported as its lateness beyond this. */
export const LOOP_RESOLUTION_MS = 10;

export interface Dist {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export function dist(values: number[]): Dist {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
  return { n: s.length, p50: r1(at(0.5)), p95: r1(at(0.95)), max: r1(s[s.length - 1] as number) };
}

export const r1 = (v: number): number => Math.round(v * 10) / 10;

interface BotTrack {
  bot: Bot;
  ticks: number;
  packets: number;
  bytes0: number;
  deaths: number;
}

export interface PathStats {
  /** Final outcomes of searches (a 'partial' result is a search still going). */
  success: number;
  noPath: number;
  timeout: number;
  /** Planning time (ms, wall) of finished searches. */
  planMs: Dist;
  /** Path resets by reason (stuck, block_updated, chunk_loaded, goal_moved…): each one means a new search. */
  resets: Record<string, number>;
}

/** Per-bot listeners, attached once per bot instance (a reconnect brings a new instance). */
export class BotMeters {
  private readonly tracks = new Map<string, BotTrack>();
  private plans: number[] = [];
  private outcomes = { success: 0, noPath: 0, timeout: 0 };
  private resets: Record<string, number> = {};

  attach(name: string, bot: Bot): void {
    const t: BotTrack = { bot, ticks: 0, packets: 0, bytes0: bytesRead(bot), deaths: 0 };
    this.tracks.set(name, t);
    bot.on('physicsTick', () => {
      if (this.tracks.get(name) === t) t.ticks++;
    });
    bot._client.on('packet', () => {
      if (this.tracks.get(name) === t) t.packets++;
    });
    bot.on('death', () => {
      t.deaths++;
    });
    bot.on('path_update' as never, ((r: { status: string; time: number }) => {
      if (this.tracks.get(name) !== t || r.status === 'partial') return;
      if (r.status === 'success') this.outcomes.success++;
      else if (r.status === 'noPath') this.outcomes.noPath++;
      else if (r.status === 'timeout') this.outcomes.timeout++;
      this.plans.push(r.time);
    }) as never);
    bot.on('path_reset' as never, ((reason: string) => {
      if (this.tracks.get(name) === t) this.resets[reason] = (this.resets[reason] ?? 0) + 1;
    }) as never);
  }

  /** Zero every counter (the start of a phase). */
  reset(): void {
    for (const t of this.tracks.values()) {
      t.ticks = 0;
      t.packets = 0;
      t.bytes0 = bytesRead(t.bot);
      t.deaths = 0;
    }
    this.plans = [];
    this.outcomes = { success: 0, noPath: 0, timeout: 0 };
    this.resets = {};
  }

  read(names: string[], seconds: number): BotPhase {
    const ticks: number[] = [];
    let packets = 0;
    let bytes = 0;
    let deaths = 0;
    let columns = 0;
    for (const n of names) {
      const t = this.tracks.get(n);
      if (!t) continue;
      columns += loadedColumns(t.bot);
      ticks.push(t.ticks / seconds);
      packets += t.packets;
      bytes += bytesRead(t.bot) - t.bytes0;
      deaths += t.deaths;
    }
    const nb = Math.max(1, ticks.length);
    return {
      bots: ticks.length,
      ticksPerSec: { min: r1(Math.min(...ticks, 20)), mean: r1(ticks.reduce((a, b) => a + b, 0) / nb) },
      packetsPerSecPerBot: r1(packets / seconds / nb),
      kbPerSecPerBot: r1(bytes / 1024 / seconds / nb),
      deaths,
      columnsPerBot: Math.round(columns / nb),
      path: { ...this.outcomes, planMs: dist(this.plans), resets: { ...this.resets } },
    };
  }
}

export interface BotPhase {
  bots: number;
  ticksPerSec: { min: number; mean: number };
  packetsPerSecPerBot: number;
  kbPerSecPerBot: number;
  deaths: number;
  /** Chunk columns each bot holds (its own copy of the world): (2 × view distance + 1)² when settled. */
  columnsPerBot: number;
  path: PathStats;
}

function loadedColumns(bot: Bot): number {
  const cols = (bot.world as unknown as { async?: { columns?: Record<string, unknown> } }).async?.columns;
  return cols ? Object.keys(cols).length : 0;
}

function bytesRead(bot: Bot): number {
  return (bot._client as unknown as { socket?: { bytesRead?: number } }).socket?.bytesRead ?? 0;
}

export interface ProcessPhase {
  seconds: number;
  /** Loop delay beyond the histogram's 10 ms interval, ms. */
  loop: { p50: number; p99: number; max: number; mean: number };
  /** Event-loop utilization: the share of wall time the main thread was busy. */
  elu: number;
  /** CPU of the whole process (every thread), % of one core. */
  cpuPct: number;
  rssMb: number;
  rssMaxMb: number;
  heapMb: number;
  heapMaxMb: number;
  /** Share of wall time (%) in each instrumented module, all bots together. */
  share: { decode: number; inflate: number; physics: number; lookahead: number; astar: number };
  /** Look-ahead: simulated ticks per second (all bots), and how many decisions the memo experiment reused. */
  lookaheadTicksPerSec: number;
  lookaheadMemoHits: number;
  astarMaxSliceMs: number;
  astarMaxWindowMs: number;
  /** A* slices refused by the --astar-budget cap. */
  astarStarved: number;
  /** --astar-blockcache: the share of A*'s neighbour lookups served from the cache. */
  astarCacheHitRate: number | null;
  packetsDecoded: number;
}

export class ProcessProbe {
  private hist = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  private elu0?: EventLoopUtilization;
  private cpu0?: NodeJS.CpuUsage;
  private t0 = 0;
  private sampler?: ReturnType<typeof setInterval>;
  private rssMax = 0;
  private heapMax = 0;

  start(): void {
    takeCounters();
    this.hist.reset();
    this.hist.enable();
    this.elu0 = performance.eventLoopUtilization();
    this.cpu0 = process.cpuUsage();
    this.t0 = performance.now();
    this.rssMax = 0;
    this.heapMax = 0;
    this.sample();
    this.sampler = setInterval(() => this.sample(), 1_000);
  }

  private sample(): void {
    const m = process.memoryUsage();
    this.rssMax = Math.max(this.rssMax, m.rss);
    this.heapMax = Math.max(this.heapMax, m.heapUsed);
  }

  stop(): ProcessPhase {
    this.hist.disable();
    if (this.sampler) clearInterval(this.sampler);
    this.sample();
    const wallMs = performance.now() - this.t0;
    const elu = performance.eventLoopUtilization(this.elu0);
    const cpu = process.cpuUsage(this.cpu0);
    const c = takeCounters();
    const m = process.memoryUsage();
    const late = (ns: number): number => r1(Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS));
    const pct = (ms: number): number => r1((ms / wallMs) * 100);
    return {
      seconds: r1(wallMs / 1000),
      loop: { p50: late(this.hist.percentile(50)), p99: late(this.hist.percentile(99)), max: late(this.hist.max), mean: late(this.hist.mean) },
      elu: Math.round(elu.utilization * 1000) / 1000,
      cpuPct: r1(((cpu.user + cpu.system) / 1000 / wallMs) * 100),
      rssMb: Math.round(m.rss / 1048576),
      rssMaxMb: Math.round(this.rssMax / 1048576),
      heapMb: Math.round(m.heapUsed / 1048576),
      heapMaxMb: Math.round(this.heapMax / 1048576),
      share: { decode: pct(c.decodeMs), inflate: pct(c.inflateMs), physics: pct(c.physicsMs), lookahead: pct(c.lookaheadMs), astar: pct(c.astarMs) },
      lookaheadTicksPerSec: Math.round(c.lookaheadTicks / (wallMs / 1000)),
      lookaheadMemoHits: c.lookaheadMemoHits,
      astarMaxSliceMs: r1(c.astarMaxSlice),
      astarMaxWindowMs: r1(c.astarMaxWindow),
      astarStarved: c.astarStarved,
      astarCacheHitRate: c.astarCacheHits + c.astarCacheMisses > 0 ? Math.round((c.astarCacheHits / (c.astarCacheHits + c.astarCacheMisses)) * 1000) / 1000 : null,
      packetsDecoded: c.decodePackets,
    };
  }
}
