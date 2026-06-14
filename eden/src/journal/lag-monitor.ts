// The event-loop lag monitor — D-07's backpressure CANARY (R40), ported from v1's
// monitorEventLoopDelay({ resolution: 20 }). On a spike it appends one system.loop-lag
// event (at most once per reset window). The threshold (1000 ms) is HARDCODED, not a
// config key (D-07/S7) — nothing else reads it. Lives here so it is testable against the
// in-memory journal fake; main.ts owns the instance and starts the interval.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { JournalAppender } from './journal';

/** Tuning for {@link createLagMonitor}; all default (resolution 20ms, threshold 1000ms, reset 60s). */
export interface LagMonitorOptions {
  resolutionMs?: number;
  thresholdMs?: number;
  resetMs?: number;
}

/** One read of the loop-delay histogram (ms): whether it breached, plus p99 and max. */
export interface LagSample {
  lagged: boolean;
  p99: number;
  max: number;
}

export interface LagMonitor {
  /** Read the histogram, append system.loop-lag if over threshold, then reset. */
  sample(): LagSample;
  start(): void;
  stop(): void;
  readonly thresholdMs: number;
}

const NS_PER_MS = 1e6;

/**
 * Build the D-07 backpressure canary. Enables the histogram immediately, but it only records
 * after the loop ticks once post-arming — arrange a tick before relying on a sample in tests.
 */
export function createLagMonitor(appender: JournalAppender, opts: LagMonitorOptions = {}): LagMonitor {
  const resolution = opts.resolutionMs ?? 20;
  const thresholdMs = opts.thresholdMs ?? 1000;
  const resetMs = opts.resetMs ?? 60_000;
  const histogram = monitorEventLoopDelay({ resolution });
  histogram.enable();
  let timer: ReturnType<typeof setInterval> | undefined;

  function sample(): LagSample {
    const max = histogram.max / NS_PER_MS;
    const p99 = histogram.percentile(99) / NS_PER_MS;
    const lagged = Number.isFinite(max) && max >= thresholdMs;
    if (lagged) {
      appender.append('engine', 'system.loop-lag', { p99: Math.round(p99), max: Math.round(max) });
    }
    histogram.reset();
    return { lagged, p99, max };
  }

  function start(): void {
    if (!timer) {
      timer = setInterval(sample, resetMs);
      timer.unref();
    }
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    histogram.disable();
  }

  return { sample, start, stop, thresholdMs };
}
