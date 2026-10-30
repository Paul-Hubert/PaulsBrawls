// One order = one program controlling N bots (docs/29 §5, §6, §7). The Order owns everything the program touches:
// its members (guarded bots, live arrays per role), its tracked timers and listeners, its claims and its report.
// It is the LeaseHolder the lease manager calls when a bot is reclaimed, returns, dies or disconnects, and it runs
// the cleanup (the R4/R5 abort sequence) whenever a bot leaves it or it ends.

import { EventEmitter } from 'node:events';

import type { Bot } from 'mineflayer';

import { abortActiveTasks } from '../bots/hardening';
import { BotLeftError, OrderStoppedError, errorMessage, isBotLeft, isStopped } from '../api/errors';
import type { LeaseHolder, LeaseManager, LeftReason, RoleRequest } from '../leases';
import type { BotFacts, Manifest, RoleSpec } from '../script/manifest';
import { matches } from '../script/manifest';
import type { CommandRef, Notice, OrderReport, OrderStatus, Player, Snapshot, Vitals } from '../types';
import type { ClaimRegistry } from './claims';
import { guardBot, unwrap, type GuardControl } from './guard';

export interface OrderDeps {
  leases: LeaseManager;
  claims: ClaimRegistry;
  /** The live bot for a roster name (undefined when offline). */
  bot(name: string): Bot | undefined;
  /** The runtime's default movements of a bot (restored after each order). */
  movements(name: string): unknown;
  /** Tags and items of a bot, for role selectors. */
  facts(name: string): BotFacts | undefined;
  /** Who runs an order and which command (for "Alice a réquisitionné Archer1 pour « defend »"). */
  describe(orderId: string): { commander: string; command: string } | undefined;
  notify(n: Notice): void;
  /** The order ended (journal it, tell the commander). */
  ended(order: Order): void;
}

export interface OrderInit {
  id: string;
  command: CommandRef;
  commander: Player;
  snap: Snapshot;
  args: Record<string, unknown>;
  trial: boolean;
  /** Wall clock, ms. */
  limitMs: number;
  /** Names that `isFriend` accepts: the commander, every co-owner, every roster bot. */
  friends: Set<string>;
  /** The script file name in stack traces (unhandled rejections are attributed by it). */
  filename: string;
}

interface Member {
  name: string;
  role: string;
  real: Bot;
  guard: Bot;
}

interface TrackedListener {
  bot: string;
  emitter: object;
  event: string | symbol;
  fn: (...a: unknown[]) => unknown;
  wrapped: (...a: unknown[]) => unknown;
}

const MAX_LOG_LINES = 300;
const MAX_FAILURES = 60;

export class Order implements LeaseHolder {
  readonly id: string;
  readonly command: CommandRef;
  readonly commander: Player;
  readonly snap: Snapshot;
  readonly trial: boolean;
  readonly friends: Set<string>;
  readonly filename: string;
  limitMs: number;
  args: Record<string, unknown>;
  status: OrderStatus | 'starting' = 'starting';
  manifest?: Manifest;

  /** Live arrays handed to the script (mutated in place so references stay valid). */
  readonly bots: Bot[] = [];
  readonly roles: Record<string, Bot[]> = {};
  readonly events = new EventEmitter();
  readonly controller = new AbortController();

  private readonly members = new Map<string, Member>();
  private readonly guards = new Map<string, { real: Bot; guard: Bot }>();
  private readonly leftReasons = new Map<string, LeftReason | 'order-ended'>();
  private readonly listeners: TrackedListener[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly intervals = new Set<ReturnType<typeof setInterval>>();
  private readonly sleepers = new Set<(e: Error) => void>();
  private readonly endWaiters: Array<() => void> = [];
  private wallClock?: ReturnType<typeof setTimeout>;
  private stopWhy = 'stopped';
  private ending?: Promise<void>;
  private sayTokens = 5;
  private sayAt = Date.now();
  readonly report: OrderReport;

  constructor(
    init: OrderInit,
    private readonly deps: OrderDeps,
  ) {
    this.id = init.id;
    this.command = init.command;
    this.commander = init.commander;
    this.snap = init.snap;
    this.args = init.args;
    this.trial = init.trial;
    this.friends = init.friends;
    this.filename = init.filename;
    this.limitMs = init.limitMs;
    this.report = {
      id: init.id,
      command: init.command,
      commander: init.commander,
      trial: init.trial,
      args: init.args,
      snap: init.snap,
      status: 'running',
      startedAt: Date.now(),
      bots: [],
      events: [],
      failures: [],
      logs: [],
      vitals: { before: {}, after: {} },
    };
    this.events.setMaxListeners(100);
  }

  get running(): boolean {
    return this.status === 'running';
  }

  get ended(): boolean {
    return this.ending !== undefined;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  // -- members ---------------------------------------------------------------------------------------------------

  memberNames(): string[] {
    return [...this.members.keys()];
  }

  roleOf(name: string): string | undefined {
    return this.members.get(name)?.role;
  }

  hasMember(name: string): boolean {
    return this.members.has(name);
  }

  /** The member behind a guarded (or raw) bot. */
  nameOf(bot: unknown): string | undefined {
    const real = unwrap(bot) as Bot | undefined;
    for (const m of this.members.values()) if (m.real === real || m.guard === bot) return m.name;
    for (const [name, g] of this.guards) if (g.real === real || g.guard === bot) return name;
    return undefined;
  }

  /** Start: grants are applied by the runner (leases), the order takes its bots and its clock starts. */
  begin(grants: Array<{ bot: string; role: string; from?: string }>, manifest: Manifest): void {
    this.manifest = manifest;
    for (const role of Object.keys(manifest.roles)) this.roles[role] = [];
    this.status = 'running';
    for (const g of grants) {
      this.addMember(g.bot, g.role, 'granted', g.from);
      this.report.bots.push(g.from ? { name: g.bot, role: g.role, from: g.from } : { name: g.bot, role: g.role });
      const v = this.vitalsOf(g.bot);
      if (v) this.report.vitals.before[g.bot] = v;
    }
    this.wallClock = setTimeout(() => void this.stop('timeout'), this.limitMs);
    this.wallClock.unref();
  }

  private addMember(name: string, role: string, kind: 'granted' | 'joined' | 'acquired', by?: string): Bot | undefined {
    const real = this.deps.bot(name);
    if (!real) return undefined;
    let g = this.guards.get(name);
    if (!g || g.real !== real) {
      g = { real, guard: guardBot(real, this.control(name, real)) };
      this.guards.set(name, g);
    }
    this.members.set(name, { name, role, real, guard: g.guard });
    this.leftReasons.delete(name);
    if (!this.bots.includes(g.guard)) this.bots.push(g.guard);
    const arr = (this.roles[role] ??= []);
    if (!arr.includes(g.guard)) arr.push(g.guard);
    this.report.events.push({ at: Date.now(), kind, bot: name, role, ...(by ? { by } : {}) });
    return g.guard;
  }

  private dropMember(name: string, reason: LeftReason | 'order-ended'): Member | undefined {
    const m = this.members.get(name);
    if (!m) return undefined;
    this.members.delete(name);
    this.leftReasons.set(name, reason);
    removeFrom(this.bots, m.guard);
    for (const arr of Object.values(this.roles)) removeFrom(arr, m.guard);
    this.removeListenersOf(name);
    return m;
  }

  private control(name: string, real: Bot): GuardControl {
    return {
      check: () => {
        if (this.status !== 'running') throw new OrderStoppedError(this.stopWhy);
        if (!this.holds(name, real)) throw new BotLeftError(name, this.leftReasons.get(name) ?? 'released');
      },
      live: () => this.status === 'running' && this.holds(name, real),
      leftError: () =>
        this.status !== 'running' ? new OrderStoppedError(this.stopWhy) : new BotLeftError(name, this.leftReasons.get(name) ?? 'released'),
      addListener: (emitter, event, fn) => {
        const wrapped = this.wrapCallback(fn, `listener ${String(event)} on ${name}`);
        this.listeners.push({ bot: name, emitter, event, fn, wrapped });
        return wrapped;
      },
      takeListener: (emitter, event, fn) => {
        const i = this.listeners.findIndex((l) => l.emitter === emitter && l.event === event && l.fn === fn);
        if (i < 0) return undefined;
        const [l] = this.listeners.splice(i, 1);
        return l?.wrapped;
      },
      log: (line) => this.log(line),
      order: this,
      tags: () => [...(this.deps.facts(name)?.tags ?? [])],
      role: () => this.members.get(name)?.role,
    };
  }

  private holds(name: string, real: Bot): boolean {
    return this.members.has(name) && this.deps.leases.holds(this.id, name) && this.deps.bot(name) === real;
  }

  private removeListenersOf(name: string | null): void {
    for (let i = this.listeners.length - 1; i >= 0; i--) {
      const l = this.listeners[i] as TrackedListener;
      if (name !== null && l.bot !== name) continue;
      try {
        (l.emitter as EventEmitter).removeListener(l.event, l.wrapped);
      } catch {
        /* the emitter may be gone with its bot */
      }
      this.listeners.splice(i, 1);
    }
  }

  // -- LeaseHolder -----------------------------------------------------------------------------------------------

  async onLeft(name: string, reason: LeftReason, by?: string): Promise<void> {
    const m = this.dropMember(name, reason);
    if (!m) return;
    this.report.events.push({ at: Date.now(), kind: 'left', bot: name, reason, ...(by ? { by } : {}) });
    this.emitSafe('left', m.guard, reason);
    if (reason === 'reclaimed' && by) {
      const who = this.deps.describe(by);
      if (who) this.notify(`${who.commander} a réquisitionné ${name} pour « ${who.command} ».`);
    } else if (reason === 'died' || reason === 'disconnected') {
      this.notify(`${name} quitte « ${this.command.name} » (${reason === 'died' ? 'mort' : 'déconnecté'}).`);
    }
    await abortActiveTasks(m.real as never, this.deps.movements(name));
  }

  onJoined(name: string, role: string): void {
    if (this.status !== 'running') {
      // Never keep a bot we cannot drive: pass it on.
      queueMicrotask(() => this.deps.leases.release(this.id, name));
      return;
    }
    const guard = this.addMember(name, role, 'joined');
    if (!guard) {
      queueMicrotask(() => this.deps.leases.release(this.id, name));
      return;
    }
    this.emitSafe('joined', guard, role);
  }

  // -- script-facing operations (squad.acquire / squad.release) ------------------------------------------------

  async acquire(spec: RoleSpec, as: string, candidates: string[]): Promise<Bot[]> {
    this.assertRunning();
    const sel = spec.select ?? {};
    const req: RoleRequest = {
      name: as,
      min: 0,
      max: spec.max ?? Infinity,
      take: spec.take ?? 'free',
      matches: (b) => {
        const f = this.deps.facts(b);
        return !!f && matches(sel, f);
      },
    };
    const plan = this.deps.leases.plan(this.id, [req], candidates, this.members.keys());
    if (!plan.ok) return [];
    await this.deps.leases.apply(this.id, plan.grants);
    const out: Bot[] = [];
    for (const g of plan.grants) {
      if (this.status !== 'running') {
        this.deps.leases.release(this.id, g.bot);
        continue;
      }
      const guard = this.addMember(g.bot, as, 'acquired', g.from);
      if (guard) {
        out.push(guard);
        if (!this.report.vitals.before[g.bot]) {
          const v = this.vitalsOf(g.bot);
          if (v) this.report.vitals.before[g.bot] = v;
        }
      } else this.deps.leases.release(this.id, g.bot);
    }
    return out;
  }

  async releaseBot(bot: unknown): Promise<void> {
    const name = this.nameOf(bot);
    if (!name || !this.members.has(name)) return;
    const m = this.dropMember(name, 'released') as Member;
    this.report.events.push({ at: Date.now(), kind: 'released', bot: name });
    this.emitSafe('left', m.guard, 'released');
    await abortActiveTasks(m.real as never, this.deps.movements(name));
    this.deps.leases.release(this.id, name);
  }

  // -- claims (helpers claim their block targets through the bot's order) --------------------------------------

  claimKey(key: string, ttlSeconds = 300): boolean {
    return this.alive && this.deps.claims.claim(key, this.id, ttlSeconds);
  }

  heldByOther(key: string): boolean {
    return this.deps.claims.heldByOther(key, this.id);
  }

  unclaimKey(key: string): void {
    this.deps.claims.unclaim(key, this.id);
  }

  // -- timers, sleeps, callbacks -------------------------------------------------------------------------------

  /** Wrap a script callback: a throw or a rejection fails this order and nothing else. */
  wrapCallback(fn: (...a: unknown[]) => unknown, what: string): (...a: unknown[]) => unknown {
    return (...args: unknown[]) => {
      if (!this.alive) return undefined;
      try {
        const r = fn(...args);
        if (r && typeof (r as Promise<unknown>).then === 'function') {
          (r as Promise<unknown>).catch((e) => this.callbackFailed(e, what));
        }
        return r;
      } catch (e) {
        this.callbackFailed(e, what);
        return undefined;
      }
    };
  }

  private callbackFailed(e: unknown, what: string): void {
    if (isStopped(e) || this.status !== 'running') return;
    if (isBotLeft(e)) {
      this.log(`${what}: ${errorMessage(e)}`);
      return;
    }
    void this.fail(e, what);
  }

  setTimeout(fn: (...a: unknown[]) => unknown, ms?: number, ...args: unknown[]): ReturnType<typeof setTimeout> {
    this.assertRunning();
    const wrapped = this.wrapCallback(fn, 'setTimeout callback');
    const t = setTimeout(() => {
      this.timers.delete(t);
      wrapped(...args);
    }, ms);
    this.timers.add(t);
    return t;
  }

  clearTimeout(t: ReturnType<typeof setTimeout> | undefined): void {
    if (t === undefined) return;
    clearTimeout(t);
    this.timers.delete(t);
  }

  setInterval(fn: (...a: unknown[]) => unknown, ms?: number, ...args: unknown[]): ReturnType<typeof setInterval> {
    this.assertRunning();
    const wrapped = this.wrapCallback(fn, 'setInterval callback');
    const t = setInterval(() => wrapped(...args), Math.max(50, ms ?? 0));
    this.intervals.add(t);
    return t;
  }

  clearInterval(t: ReturnType<typeof setInterval> | undefined): void {
    if (t === undefined) return;
    clearInterval(t);
    this.intervals.delete(t);
  }

  /** Resolves after `ms`; rejects with OrderStoppedError if the order stops first. */
  sleep(ms: number): Promise<void> {
    this.assertRunning();
    return new Promise<void>((resolve, reject) => {
      const done = (e?: Error): void => {
        clearTimeout(t);
        this.timers.delete(t);
        this.sleepers.delete(done);
        if (e) reject(e);
        else resolve();
      };
      const t = setTimeout(() => done(), Math.max(0, ms));
      this.timers.add(t);
      this.sleepers.add(done);
    });
  }

  /** Resolves when the order ends (for `until-stopped` commands that only react to events). */
  untilStopped(): Promise<void> {
    if (!this.alive) return Promise.resolve();
    return new Promise<void>((resolve) => this.endWaiters.push(resolve));
  }

  // -- logs, notices ------------------------------------------------------------------------------------------

  log(line: string): void {
    const logs = this.report.logs;
    const text = line.length > 500 ? line.slice(0, 500) + '…' : line;
    if (logs.length < MAX_LOG_LINES) logs.push(text);
    else if (logs.length === MAX_LOG_LINES) logs.push(`… (log truncated at ${MAX_LOG_LINES} lines)`);
  }

  failure(bot: string, op: string, error: unknown, item?: unknown): void {
    if (this.report.failures.length >= MAX_FAILURES) return;
    this.report.failures.push({ bot, op, error: errorMessage(error), ...(item !== undefined ? { item: shortValue(item) } : {}) });
  }

  /** `ctx.say`: a French line to the commander, 5 quick then 1 per second. */
  say(text: string): void {
    const now = Date.now();
    this.sayTokens = Math.min(5, this.sayTokens + (now - this.sayAt) / 1000);
    this.sayAt = now;
    this.log(`say: ${text}`);
    if (this.sayTokens < 1) return;
    this.sayTokens -= 1;
    this.notify(String(text).slice(0, 240));
  }

  notify(text: string, click?: Notice['click']): void {
    if (this.trial) return; // a trial reports to the author agent, not to chat
    this.deps.notify({ to: [this.commander.uuid], text: `[Bots] ${text}`, ...(click ? { click } : {}) });
  }

  // -- ending --------------------------------------------------------------------------------------------------

  /** Starting (module top level) or running: the script may await, sleep and set timers. */
  get alive(): boolean {
    return this.status === 'running' || this.status === 'starting';
  }

  assertRunning(): void {
    if (!this.alive) throw new OrderStoppedError(this.stopWhy);
  }

  stop(status: 'stopped' | 'timeout' | 'interrupted' = 'stopped', why?: string): Promise<void> {
    this.stopWhy = why ?? (status === 'timeout' ? `time limit of ${Math.round(this.limitMs / 60000)} min` : status);
    return this.end(status);
  }

  fail(e: unknown, where?: string): Promise<void> {
    if (where) this.log(`failed in ${where}: ${errorMessage(e)}`);
    return this.end('failed', undefined, e);
  }

  /** The script returned. */
  complete(result: unknown): Promise<void> {
    return this.end('done', result);
  }

  /** Idempotent: the first caller decides the status. Resolves once every bot is cleaned up and released. */
  end(status: OrderStatus, result?: unknown, error?: unknown): Promise<void> {
    if (this.ending) return this.ending;
    this.ending = this.finish(status, result, error);
    return this.ending;
  }

  waitEnded(): Promise<void> {
    return this.ending ?? new Promise<void>((resolve) => this.endWaiters.push(() => void this.ending?.then(resolve)));
  }

  private async finish(status: OrderStatus, result?: unknown, error?: unknown): Promise<void> {
    if (status !== 'stopped' && status !== 'timeout' && status !== 'interrupted') this.stopWhy = 'order-ended';
    this.status = status;
    this.controller.abort();
    if (this.wallClock) clearTimeout(this.wallClock);
    for (const t of this.timers) clearTimeout(t);
    for (const t of this.intervals) clearInterval(t);
    this.timers.clear();
    this.intervals.clear();
    for (const done of [...this.sleepers]) done(new OrderStoppedError(this.stopWhy));
    this.removeListenersOf(null);

    const held = this.deps.leases.endOrder(this.id);
    const names = new Set([...held, ...this.members.keys()]);
    for (const name of names) {
      const v = this.vitalsOf(name);
      if (v) this.report.vitals.after[name] = v;
    }
    const members = [...names].map((n) => ({ name: n, real: this.members.get(n)?.real ?? this.deps.bot(n) }));
    for (const n of names) this.dropMember(n, 'order-ended');
    await Promise.all(
      members.map(async (m) => {
        if (m.real) await abortActiveTasks(m.real as never, this.deps.movements(m.name));
        this.deps.leases.release(this.id, m.name);
      }),
    );
    this.deps.claims.releaseAll(this.id);

    this.report.status = status;
    this.report.endedAt = Date.now();
    if (result !== undefined) this.report.result = shortResult(result);
    if (error !== undefined) {
      const err = error instanceof Error ? error : new Error(errorMessage(error));
      this.report.error = { name: err.name, message: err.message, ...(err.stack ? { stack: trimStack(err.stack) } : {}) };
      const line = lineIn(err, this.filename);
      if (line !== undefined) this.report.error.line = line;
    }
    for (const w of this.endWaiters.splice(0)) w();
    this.events.removeAllListeners();
    try {
      this.deps.ended(this);
    } catch {
      /* journaling must not break the end of an order */
    }
  }

  private emitSafe(event: 'left' | 'joined', ...args: unknown[]): void {
    for (const l of this.events.listeners(event)) {
      try {
        const r = (l as (...a: unknown[]) => unknown)(...args);
        if (r && typeof (r as Promise<unknown>).then === 'function') {
          (r as Promise<unknown>).catch((e) => this.callbackFailed(e, `squad.on('${event}')`));
        }
      } catch (e) {
        this.callbackFailed(e, `squad.on('${event}')`);
      }
    }
  }

  vitalsOf(name: string): Vitals | undefined {
    const bot = this.deps.bot(name);
    if (!bot) return undefined;
    try {
      const p = bot.entity?.position;
      const inventory: Record<string, number> = {};
      for (const it of bot.inventory?.items?.() ?? []) inventory[it.name] = (inventory[it.name] ?? 0) + it.count;
      return {
        health: bot.health ?? 0,
        food: bot.food ?? 0,
        position: p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null,
        held: bot.heldItem?.name ?? null,
        inventory,
      };
    } catch {
      return undefined;
    }
  }
}

function removeFrom<T>(arr: T[], v: T): void {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
}

function shortValue(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 200 ? s.slice(0, 200) + '…' : v;
  } catch {
    return String(v);
  }
}

/** What the player reads at the end: a string as is, anything else as short JSON. */
export function shortResult(r: unknown): string {
  if (typeof r === 'string') return r.slice(0, 400);
  try {
    const s = JSON.stringify(r);
    return (s ?? String(r)).slice(0, 400);
  } catch {
    return String(r).slice(0, 400);
  }
}

function trimStack(stack: string): string {
  return stack.split('\n').filter((l) => !l.includes('node:internal')).slice(0, 12).join('\n');
}

function lineIn(err: Error, filename: string): number | undefined {
  const stack = err.stack ?? '';
  const i = stack.indexOf(filename + ':');
  if (i < 0) return undefined;
  const m = /^:(\d+)/.exec(stack.slice(i + filename.length));
  return m ? Number(m[1]) : undefined;
}
