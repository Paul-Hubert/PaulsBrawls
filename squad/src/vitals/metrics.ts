// The runtime's vitals (docs/31 §5.5, docs/32 C): what the load bench measures, made visible in production.
//
// Every 10 s the sampler closes a window: the event loop and the process (lag-monitor.ts) plus every bot's counters
// from the pool (physics ticks, path searches by outcome, path resets, deaf trips) and the process-wide count of
// skipped packets. That window is what POST /api/metrics and /bots status show, so two requests within the same
// 10 s give the same numbers. Before the first window closes (the first 10 s after boot) a request sees the window
// so far, marked incomplete.
//
// It warns once a minute at most when the loop is overloaded (p99 > 250 ms or ELU > 0.9: Eden's 1 s threshold is
// too late, bots are in slow motion well before), and writes one row per minute to the journal (never the hot
// stream, R44).

import type { BotMeterReading } from '../bots/pool';
import type { VitalsRow } from '../journal/journal';
import { logger } from '../logger';
import { LoopMonitor, r1, type LoopWindow } from './lag-monitor';

export const SAMPLE_MS = 10_000;
export const MINUTE_MS = 60_000;
/** Above either, bots move in slow motion (docs/31 §2: at ELU 1.0 the slowest bot falls to 15 ticks/s and below). */
export const WARN_P99_MS = 250;
export const WARN_ELU = 0.9;
export const WARN_EVERY_MS = 60_000;

/** The pool's side, narrowed (tests pass a fake). */
export interface MeteredPool {
  readMeters(reset: boolean): BotMeterReading[];
}

/** The journal's side, narrowed. */
export interface VitalsSink {
  saveVitals(row: VitalsRow): void;
}

/** The loop's side, narrowed (tests pass scripted windows). */
export interface LoopSource {
  read(reset: boolean): LoopWindow;
  stop(): void;
}

export interface BotMetrics {
  name: string;
  status: BotMeterReading['status'];
  /** Physics ticks per second over the part of the window the bot was online (null: online for less than 1 s). */
  ticksPerSec: number | null;
  path: { success: number; noPath: number; timeout: number; other: number };
  /** "Stuck" and other path resets, by reason. */
  resets: Record<string, number>;
  deafTrips: number;
}

export interface Metrics {
  ok: true;
  /** The French line for a player. */
  text: string;
  /** The window every number covers: `seconds` long, ending at `endedAt` (ms); `complete` is false before the first 10 s. */
  window: { seconds: number; endedAt: number; complete: boolean };
  loop: { p50: number; p99: number; max: number };
  elu: number;
  cpuPct: number;
  rssMb: number;
  heapMb: number;
  /** Undecodable server packets skipped in the window, all bots together. */
  skippedPackets: number;
  bots: BotMetrics[];
}

export interface VitalsOptions {
  pool: MeteredPool;
  journal?: VitalsSink;
  /** The process-wide skipped-packet count since boot (pool.ts `skippedPackets`). */
  skipped?: () => number;
  loop?: LoopSource;
  now?: () => number;
}

/** The minute being summed for the journal. */
interface Minute {
  start: number;
  seconds: number;
  eluSec: number;
  cpuSec: number;
  p50Sec: number;
  p99: number;
  max: number;
  minTps: number | null;
  slowest: string | null;
  path: BotMetrics['path'];
  resets: Record<string, number>;
  deafTrips: number;
  skippedPackets: number;
  windows: number;
}

export class Vitals {
  private readonly loop: LoopSource;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private last?: Metrics;
  private lastWarn = -Infinity;
  private skipped0: number;
  private minute: Minute;

  constructor(private readonly opts: VitalsOptions) {
    // Armed first: the histogram must be running before any synchronous work it should see.
    this.loop = opts.loop ?? new LoopMonitor();
    this.now = opts.now ?? Date.now;
    this.skipped0 = opts.skipped?.() ?? 0;
    this.minute = emptyMinute(this.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.loop.stop();
  }

  /** The last complete window, or the window so far before the first one closes. */
  metrics(): Metrics {
    return this.last ?? this.build(false);
  }

  /** Close the current window (the 10 s timer; tests call it directly). */
  sample(): Metrics {
    const m = this.build(true);
    this.last = m;
    this.warn(m);
    this.addToMinute(m);
    return m;
  }

  private build(reset: boolean): Metrics {
    const now = this.now();
    const w = this.loop.read(reset);
    const readings = this.opts.pool.readMeters(reset);
    const skippedNow = this.opts.skipped?.() ?? 0;
    const skipped = skippedNow - this.skipped0;
    if (reset) this.skipped0 = skippedNow;
    const bots = readings.map((b) => botMetrics(b, w.seconds, now));
    const m: Metrics = {
      ok: true,
      text: '',
      window: { seconds: w.seconds, endedAt: now, complete: reset },
      loop: { p50: w.p50, p99: w.p99, max: w.max },
      elu: w.elu,
      cpuPct: w.cpuPct,
      rssMb: w.rssMb,
      heapMb: w.heapMb,
      skippedPackets: skipped,
      bots,
    };
    m.text = statusText(m);
    return m;
  }

  private warn(m: Metrics): void {
    if (!overloaded(m)) return;
    const now = this.now();
    if (now - this.lastWarn < WARN_EVERY_MS) return;
    this.lastWarn = now;
    const s = slowest(m.bots);
    logger.warn(
      'vitals',
      `event loop overloaded over the last ${Math.round(m.window.seconds)} s: ELU ${m.elu}, loop p99 ${m.loop.p99} ms (max ${m.loop.max} ms), CPU ${m.cpuPct} %` +
        (s ? `, slowest bot ${s.name} at ${s.ticksPerSec} ticks/s` : '') +
        ` (${online(m.bots)} bots online; bots move in slow motion)`,
    );
  }

  private addToMinute(m: Metrics): void {
    const a = this.minute;
    const sec = m.window.seconds;
    a.seconds += sec;
    a.eluSec += m.elu * sec;
    a.cpuSec += m.cpuPct * sec;
    a.p50Sec += m.loop.p50 * sec;
    a.p99 = Math.max(a.p99, m.loop.p99);
    a.max = Math.max(a.max, m.loop.max);
    const s = slowest(m.bots);
    if (s && s.ticksPerSec !== null && (a.minTps === null || s.ticksPerSec < a.minTps)) {
      a.minTps = s.ticksPerSec;
      a.slowest = s.name;
    }
    for (const b of m.bots) {
      a.path.success += b.path.success;
      a.path.noPath += b.path.noPath;
      a.path.timeout += b.path.timeout;
      a.path.other += b.path.other;
      for (const [k, v] of Object.entries(b.resets)) if (v) a.resets[k] = (a.resets[k] ?? 0) + v;
      a.deafTrips += b.deafTrips;
    }
    a.skippedPackets += m.skippedPackets;
    a.windows++;
    const now = this.now();
    if (now - a.start < MINUTE_MS) return;
    const secs = Math.max(a.seconds, 0.001);
    try {
      this.opts.journal?.saveVitals({
        at: now,
        seconds: r1(a.seconds),
        elu: Math.round((a.eluSec / secs) * 1000) / 1000,
        loopP50: r1(a.p50Sec / secs),
        loopP99: a.p99,
        loopMax: a.max,
        cpuPct: r1(a.cpuSec / secs),
        rssMb: m.rssMb,
        heapMb: m.heapMb,
        bots: online(m.bots),
        minTicksPerSec: a.minTps,
        data: { windows: a.windows, slowest: a.slowest, path: a.path, resets: a.resets, deafTrips: a.deafTrips, skippedPackets: a.skippedPackets },
      });
    } catch (e) {
      logger.warn('vitals', `could not journal the minute's vitals: ${(e as Error).message}`);
    }
    this.minute = emptyMinute(now);
  }
}

function emptyMinute(start: number): Minute {
  return {
    start,
    seconds: 0,
    eluSec: 0,
    cpuSec: 0,
    p50Sec: 0,
    p99: 0,
    max: 0,
    minTps: null,
    slowest: null,
    path: { success: 0, noPath: 0, timeout: 0, other: 0 },
    resets: {},
    deafTrips: 0,
    skippedPackets: 0,
    windows: 0,
  };
}

function botMetrics(b: BotMeterReading, windowSec: number, now: number): BotMetrics {
  // A bot that came online during the window is measured over its online part only, or it would look slow.
  const onlineSec = b.onlineAt > 0 ? Math.min(windowSec, Math.max(0, (now - b.onlineAt) / 1000)) : 0;
  return {
    name: b.name,
    status: b.status,
    ticksPerSec: onlineSec >= 1 ? r1(b.ticks / onlineSec) : null,
    path: { success: b.pathSuccess, noPath: b.pathNoPath, timeout: b.pathTimeout, other: b.pathOther },
    resets: Object.fromEntries(Object.entries(b.resets).filter(([, v]) => v > 0)),
    deafTrips: b.deafTrips,
  };
}

function slowest(bots: BotMetrics[]): (BotMetrics & { ticksPerSec: number }) | undefined {
  let s: (BotMetrics & { ticksPerSec: number }) | undefined;
  for (const b of bots) if (b.ticksPerSec !== null && (!s || b.ticksPerSec < s.ticksPerSec)) s = b as BotMetrics & { ticksPerSec: number };
  return s;
}

function online(bots: BotMetrics[]): number {
  return bots.filter((b) => b.status === 'online').length;
}

export function overloaded(m: Pick<Metrics, 'elu' | 'loop'>): boolean {
  return m.loop.p99 > WARN_P99_MS || m.elu > WARN_ELU;
}

/** French decimals: 0.65 → "0,65". */
function fr(v: number, digits: number): string {
  return v.toFixed(digits).replace('.', ',');
}

/** The line /bots status shows (the mod formats its own from the numbers; this is the same summary, longer). */
export function statusText(m: Omit<Metrics, 'text'>): string {
  const s = slowest(m.bots);
  const n = online(m.bots);
  const bots = s
    ? `bot le plus lent : ${s.name} à ${fr(s.ticksPerSec, 1)} ticks/s (${n} en ligne)`
    : n > 0
      ? `${n} bot${n > 1 ? 's' : ''} en ligne, pas encore mesuré${n > 1 ? 's' : ''}`
      : 'aucun bot en ligne';
  const span = m.window.complete ? `${Math.round(m.window.seconds)} s` : `${Math.round(m.window.seconds)} s, mesure en cours`;
  return (
    `[Bots] Charge du runtime (${span}) : ELU ${fr(m.elu, 2)} · boucle p99 ${Math.round(m.loop.p99)} ms (max ${Math.round(m.loop.max)}) · ` +
    `CPU ${Math.round(m.cpuPct)} % · RAM ${m.rssMb} Mo · ${bots}` +
    (overloaded(m) ? ' — surchargé : les bots ralentissent.' : '.')
  );
}
