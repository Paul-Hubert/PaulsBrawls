// The event-loop monitor, copied from Eden's journal/lag-monitor.ts (D-07's backpressure canary) and owned here from
// now on (O7). What changed from Eden, and why (docs/31 §5.5):
//   - it reads ELU, CPU and memory too, not only the delay histogram: ELU says how busy the one thread is, which is
//     what slows every bot at once;
//   - the resolution is 10 ms and a value is reported as its lateness beyond that, exactly like the load bench
//     (bench/lib/probe.ts), so a number here means what the docs/31 tables mean;
//   - it does not journal or warn: it only measures windows. The vitals sampler (metrics.ts) decides what to do.
//
// The histogram is armed in the constructor, before any synchronous work it should see: armed later, a long sync
// block that already started records ~0 (an Eden lesson).

import { monitorEventLoopDelay, performance, type EventLoopUtilization, type IntervalHistogram } from 'node:perf_hooks';

/** The histogram's sampling interval; a delay is reported as its lateness beyond this. */
export const LOOP_RESOLUTION_MS = 10;

/** One window of the event loop and the process. */
export interface LoopWindow {
  /** The window's length, seconds. */
  seconds: number;
  /** Loop delay beyond the 10 ms interval, ms. */
  p50: number;
  p99: number;
  max: number;
  /** Event-loop utilization: the share of the window the main thread was busy (0–1). */
  elu: number;
  /** CPU of the whole process (every thread), % of one core. */
  cpuPct: number;
  rssMb: number;
  heapMb: number;
}

export class LoopMonitor {
  private readonly hist: IntervalHistogram;
  private elu0: EventLoopUtilization;
  private cpu0: NodeJS.CpuUsage;
  private t0: number;

  constructor() {
    this.hist = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.hist.enable();
    this.elu0 = performance.eventLoopUtilization();
    this.cpu0 = process.cpuUsage();
    this.t0 = performance.now();
  }

  /**
   * The window since the last reset. With `reset`, the next window starts now (the 10 s sampler); without, it is a
   * peek that leaves the window running (a metrics request before the first sample).
   */
  read(reset: boolean): LoopWindow {
    const wallMs = Math.max(1, performance.now() - this.t0);
    const elu = performance.eventLoopUtilization(this.elu0);
    const cpu = process.cpuUsage(this.cpu0);
    const mem = process.memoryUsage();
    // An empty histogram (no timer fired yet) reads NaN or a huge max: report 0 rather than nonsense.
    const late = (ns: number): number => (Number.isFinite(ns) && this.hist.count > 0 ? r1(Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS)) : 0);
    const w: LoopWindow = {
      seconds: r1(wallMs / 1000),
      p50: late(this.hist.percentile(50)),
      p99: late(this.hist.percentile(99)),
      max: late(this.hist.max),
      elu: Math.round(elu.utilization * 1000) / 1000,
      cpuPct: r1(((cpu.user + cpu.system) / 1000 / wallMs) * 100),
      rssMb: Math.round(mem.rss / 1048576),
      heapMb: Math.round(mem.heapUsed / 1048576),
    };
    if (reset) {
      this.hist.reset();
      this.elu0 = performance.eventLoopUtilization();
      this.cpu0 = process.cpuUsage();
      this.t0 = performance.now();
    }
    return w;
  }

  stop(): void {
    this.hist.disable();
  }
}

export const r1 = (v: number): number => Math.round(v * 10) / 10;
