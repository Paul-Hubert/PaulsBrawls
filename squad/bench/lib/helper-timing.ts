// Bench-only timing of the helpers as the commands call them (the scope's `shoot`, `attack`, `follow`,
// `nearestEntity`…). Every entry of HELPERS is wrapped in place before any order starts: buildScope spreads HELPERS
// into each new order's scope, so the orders get the wrappers, while the helpers' calls to each other inside
// helpers.ts stay unwrapped (an `attack` is one `attack`, not also the `goTo` it may call).
//
// Per helper and per group (the bench passes the army of the bot, the helpers' first argument):
//   • calls, and how they ended: ok, or the error's first words (« no clear line of fire », BotLeftError…);
//   • wall time, from the call to its promise settling (p50 / p95 / max / total): how long a shot or a melee fight
//     takes in game time. It is mostly waiting, not work;
//   • sync time, from the call to its first return (the synchronous prologue, before its first await): the part
//     that blocks the event loop. For a synchronous helper (nearestEntity, lineSlots…) this is all of it.

import { performance } from 'node:perf_hooks';

import { HELPERS } from '../../src/api/helpers';
import { dist, r1, type Dist } from './probe';

type Fn = (...args: unknown[]) => unknown;

interface Stat {
  calls: number;
  ends: Map<string, number>;
  wallMs: number[];
  syncMs: number;
  syncMaxMs: number;
}

export interface HelperRow {
  helper: string;
  group: string;
  calls: number;
  ends: Record<string, number>;
  wall: Dist & { totalMs: number };
  sync: { totalMs: number; meanUs: number; maxMs: number };
}

const stats = new Map<string, Stat>();
let groupOf: (bot: string) => string = () => 'all';
let installed = false;
/** Calls started in each second since the last `takeCallsPerHelper`, for the fight's timeline. */
let recent = new Map<string, number>();

function stat(helper: string, group: string): Stat {
  const key = `${helper}\u0000${group}`;
  let s = stats.get(key);
  if (!s) {
    s = { calls: 0, ends: new Map(), wallMs: [], syncMs: 0, syncMaxMs: 0 };
    stats.set(key, s);
  }
  return s;
}

/** How a call ended, short: "ok", or the error's class and its first words without the bot's name and positions. */
function endOf(e: unknown): string {
  if (!(e instanceof Error)) return 'error';
  const name = e.constructor?.name && e.constructor.name !== 'Error' ? e.constructor.name : 'Error';
  if (name === 'BotLeftError' || name === 'OrderStoppedError') return name;
  const msg = e.message.replace(/^\w+\([^)]*\):\s*/, '').replace(/-?\d+(\.\d+)?/g, '#').slice(0, 60);
  return `${name}: ${msg}`;
}

/** Wrap every helper (once per process). `group` maps a bot's username to its army. */
export function instrumentHelpers(group: (bot: string) => string): void {
  groupOf = group;
  if (installed) return;
  installed = true;
  const table = HELPERS as unknown as Record<string, Fn>;
  for (const [name, fn] of Object.entries(table)) {
    table[name] = function timed(this: unknown, ...args: unknown[]): unknown {
      const bot = args[0] as { username?: unknown } | null | undefined;
      let who = '?';
      try {
        who = typeof bot?.username === 'string' ? bot.username : '?';
      } catch {
        // a guarded bot whose lease ended: the helper itself will say so
      }
      const s = stat(name, groupOf(who));
      s.calls++;
      recent.set(name, (recent.get(name) ?? 0) + 1);
      const t0 = performance.now();
      const settle = (t1: number, e: unknown): void => {
        s.wallMs.push(performance.now() - t0);
        const end = e === undefined ? 'ok' : endOf(e);
        s.ends.set(end, (s.ends.get(end) ?? 0) + 1);
        const sync = t1 - t0;
        s.syncMs += sync;
        if (sync > s.syncMaxMs) s.syncMaxMs = sync;
      };
      let r: unknown;
      try {
        r = fn.apply(this, args);
      } catch (e) {
        settle(performance.now(), e);
        throw e;
      }
      const t1 = performance.now();
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        return (r as Promise<unknown>).then(
          (v) => {
            settle(t1, undefined);
            return v;
          },
          (e: unknown) => {
            settle(t1, e);
            throw e;
          },
        );
      }
      settle(t1, undefined);
      return r;
    };
  }
}

/** Zero the counters (the start of a phase). */
export function resetHelperStats(): void {
  stats.clear();
  recent = new Map();
}

/** Calls started per helper since the last call of this function (the timeline's per-second counts). */
export function takeCallsPerHelper(): Record<string, number> {
  const out = Object.fromEntries(recent);
  recent = new Map();
  return out;
}

/** One row per (helper, group), and one per helper for every group together; the largest total wall time first. */
export function readHelperStats(): HelperRow[] {
  const rows: HelperRow[] = [];
  const all = new Map<string, Stat>();
  const row = (helper: string, group: string, s: Stat): HelperRow => {
    const d = dist(s.wallMs);
    return {
      helper,
      group,
      calls: s.calls,
      ends: Object.fromEntries([...s.ends.entries()].sort((a, b) => b[1] - a[1])),
      wall: { ...d, totalMs: Math.round(s.wallMs.reduce((a, b) => a + b, 0)) },
      sync: { totalMs: r1(s.syncMs), meanUs: s.calls ? r1((s.syncMs / s.calls) * 1000) : 0, maxMs: r1(s.syncMaxMs) },
    };
  };
  for (const [key, s] of stats) {
    const [helper, group] = key.split('\u0000') as [string, string];
    rows.push(row(helper, group, s));
    const a: Stat = all.get(helper) ?? { calls: 0, ends: new Map(), wallMs: [], syncMs: 0, syncMaxMs: 0 };
    a.calls += s.calls;
    for (const [k, v] of s.ends) a.ends.set(k, (a.ends.get(k) ?? 0) + v);
    a.wallMs.push(...s.wallMs);
    a.syncMs += s.syncMs;
    a.syncMaxMs = Math.max(a.syncMaxMs, s.syncMaxMs);
    all.set(helper, a);
  }
  for (const [helper, s] of all) rows.push(row(helper, 'all', s));
  return rows.sort((a, b) => b.wall.totalMs - a.wall.totalMs);
}
