// `squad`: the order's bots and the cooperation primitives (docs/29 §5.2). Everything is awaitable; a bot leaving
// is handled inside parallel/tasks/crew so scripts written with them keep going with the bots they still have.
//
// A `ctx.run` subroutine gets a view (docs/43 C2/C3): its own Squad over the bots it was given, which are LENT to it
// for as long as it runs. A lent bot leaves the lender's `bots` and roles (a 'left' event, reason 'lent'), and the
// lender's guarded bot throws BotLeftError('lent') if it still tries to drive it, so two parts of one script never move
// one body. When the subroutine ends, its bots come back (a 'joined' event each, with the role they had). Given one of
// the lender's live arrays (`squad.roles.melee`), the view is live too: a bot joining that role later is lent at once.

import { EventEmitter } from 'node:events';

import type { Bot } from 'mineflayer';

import type { ClaimRegistry } from '../orders/claims';
import type { Order } from '../orders/order';
import { matches, validateRoleSpec, type Manifest } from '../script/manifest';
import type { BotFacts } from '../script/manifest';
import { OrderStoppedError, errorMessage, isBotLeft, isStopped } from './errors';

export interface ParallelResult<T = unknown> {
  bot: Bot;
  ok: boolean;
  value?: T;
  error?: string;
  /** The bot left the order during the call (reclaimed, released, died, disconnected), or was lent. */
  left?: boolean;
}

export interface TaskResult<T = unknown> {
  item: unknown;
  ok: boolean;
  value?: T;
  error?: string;
  /** Name of the bot that did (or last tried) it. */
  bot?: string;
}

export interface SquadDeps {
  claims: ClaimRegistry;
  /** The commander's bots an `acquire` may draw from (online, after the order's @filters). */
  candidates(): string[];
  facts(name: string): BotFacts | undefined;
}

/** `squad.crew`'s options. */
export interface CrewOptions {
  /** Only the bots of these roles (default: every bot of the squad). */
  roles?: string[];
  /** The loops go on while this holds (checked before each pass; default: until the order or the view ends). */
  while?: () => boolean;
  /** Called at each launch of a bot's loop (its first, and again when it comes back): add its listeners here. */
  setup?: (bot: Bot, role: string | undefined) => unknown;
  /** A pass shorter than this is followed by a pause up to it (default 50 ms, one physics tick; at least a macrotask). */
  minPassMs?: number;
}

/** How long `tasks` waits for a bot to join when every bot left with work still queued. */
export const TASKS_WAIT_FOR_BOTS_MS = 30_000;
/** `squad.crew`: the default shortest pass (a physics tick). */
export const CREW_MIN_PASS_MS = 50;
/** `squad.crew`: the pause after a pass that threw (anything but a bot leaving or the order ending). */
export const CREW_ERROR_PAUSE_MS = 500;

export class Squad {
  /** The bots of this squad: the order's own live array, or a subroutine view's (live too). */
  readonly bots: Bot[];
  readonly roles: Record<string, Bot[]>;
  /** null: the order's own squad; a view: itself (the holder its lent bots' guards are made for). */
  private readonly holder: object | null;
  private readonly parent: Squad | null;
  private readonly events: EventEmitter;
  /** The lender's live array a view follows (bots joining it later are lent to the view too), else null. */
  private source: Bot[] | null = null;
  private manifest: Manifest | null = null;
  private disposed = false;
  private disposing?: Promise<void>;
  private readonly controller: AbortController | null;
  private readonly sleepers = new Set<(e: Error) => void>();
  private readonly endWaiters: Array<() => void> = [];
  private readonly cleanups: Array<() => void> = [];
  /** Bots this squad lent to a view, by name: the role they had here (they come back to it). */
  private readonly lentRoles = new Map<string, string | undefined>();

  constructor(
    private readonly order: Order,
    private readonly deps: SquadDeps,
    parent?: Squad,
  ) {
    if (!parent) {
      this.bots = order.bots;
      this.roles = order.roles;
      this.holder = null;
      this.parent = null;
      this.events = order.events;
      this.controller = null;
      return;
    }
    this.bots = [];
    this.roles = {};
    this.holder = this;
    this.parent = parent;
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.controller = new AbortController();
    order.signal.addEventListener('abort', () => void this.dispose(), { once: true });
  }

  /**
   * A subroutine's view (ctx.run): `bots` (the lender's bots it may have) are lent to it, each in the first of the
   * manifest's roles that it matches and that has room. A role whose `min` is not met is logged, not refused: the
   * view is live, more may come. Bots the lender does not drive, or that match no role, stay with the lender.
   */
  static async view(parent: Squad, opts: { bots: Bot[]; manifest: Manifest; name: string }): Promise<Squad> {
    const v = new Squad(parent.order, parent.deps, parent);
    v.manifest = opts.manifest;
    for (const role of Object.keys(opts.manifest.roles)) v.roles[role] = [];
    if (parent.bots === opts.bots || Object.values(parent.roles).includes(opts.bots)) v.source = opts.bots;
    const order = v.order;
    for (const b of [...opts.bots]) await v.borrow(b);
    for (const [role, spec] of Object.entries(opts.manifest.roles)) {
      const n = v.roles[role]?.length ?? 0;
      if (n < spec.min) order.log(`ctx.run("${opts.name}"): role "${role}" has ${n} bot(s) of its min ${spec.min}; it runs with them (more may join)`);
    }
    // A bot leaving the order (dead, reclaimed by another order) leaves the view it was lent to.
    const onOrderLeft = (bot: Bot, reason: string): void => {
      if (reason === 'lent') return;
      const name = order.nameOf(bot);
      if (!name) return;
      const mine = v.bots.find((b) => order.nameOf(b) === name);
      if (!mine) return;
      v.drop(mine);
      v.emit('left', mine, reason);
    };
    order.events.on('left', onOrderLeft);
    v.cleanups.push(() => order.events.removeListener('left', onOrderLeft));
    // A live view takes the bots that join its source later.
    if (v.source) {
      const onParentJoined = (bot: Bot): void => {
        if (v.disposed || !v.source?.includes(bot)) return;
        void v.borrow(bot).then((g) => {
          if (g && !v.disposed) v.emit('joined', g, v.roleIn(g));
        });
      };
      parent.events.on('joined', onParentJoined);
      v.cleanups.push(() => parent.events.removeListener('joined', onParentJoined));
    }
    return v;
  }

  /** Lend one of the lender's bots to this view; its guard here, or undefined when it stayed with the lender. */
  private async borrow(lenderBot: Bot): Promise<Bot | undefined> {
    const parent = this.parent as Squad;
    const order = this.order;
    const name = order.nameOf(lenderBot);
    if (!name || !order.hasMember(name) || order.topHolder(name) !== parent.holder || this.disposed) return undefined;
    const role = this.roleFor(name);
    if (role === null) return undefined;
    const guard = await order.lend(name, parent.holder, this);
    if (!guard) return undefined;
    parent.lentOut(name, lenderBot);
    if (!this.bots.includes(guard)) this.bots.push(guard);
    if (role !== undefined) (this.roles[role] ??= []).push(guard);
    return guard;
  }

  /** The view's role for a bot: the first of its manifest's roles it matches with room; null: none (it is not taken). */
  private roleFor(name: string): string | undefined | null {
    const m = this.manifest;
    if (!m) return undefined;
    const f = this.deps.facts(name);
    for (const [role, spec] of Object.entries(m.roles)) {
      if ((this.roles[role]?.length ?? 0) >= spec.max || !f || !matches(spec.select, f)) continue;
      return role;
    }
    return null;
  }

  private roleIn(bot: Bot): string | undefined {
    for (const [role, arr] of Object.entries(this.roles)) if (arr.includes(bot)) return role;
    return undefined;
  }

  /** This squad lent a bot to a view: it leaves `bots` and its role here ('left', reason 'lent'). */
  private lentOut(name: string, bot: Bot): void {
    this.lentRoles.set(name, this.holder === null ? this.order.roleOf(name) : this.roleIn(bot));
    this.drop(bot);
    this.emit('left', bot, 'lent');
  }

  /** A bot this squad lent comes back: into `bots` and its role, with a 'joined' event. */
  private takeBack(name: string): void {
    const bot = this.order.guardFor(name, this.holder);
    if (!bot) return;
    const role = this.lentRoles.get(name);
    this.lentRoles.delete(name);
    if (this.disposed) {
      // A view that ended meanwhile gives the bot on down.
      void this.order.unlend(name, this as object).then((h) => this.handDown(name, h));
      return;
    }
    if (!this.bots.includes(bot)) this.bots.push(bot);
    if (role !== undefined && !(this.roles[role] ??= []).includes(bot)) this.roles[role].push(bot);
    this.emit('joined', bot, role);
  }

  /** After an unlend: the holder now driving the bot takes it back (the root squad or a view up the chain). */
  private handDown(name: string, holder: object | null | undefined): void {
    if (holder === undefined) return;
    for (let s: Squad | null = this.parent; s; s = s.parent) {
      if (s.holder === holder) {
        s.takeBack(name);
        return;
      }
    }
  }

  private drop(bot: Bot): void {
    remove(this.bots, bot);
    for (const arr of Object.values(this.roles)) remove(arr, bot);
  }

  private emit(event: 'left' | 'joined', bot: Bot, detail: unknown): void {
    if (this.holder === null) this.order.emitEvent(event, bot, detail);
    else {
      for (const l of this.events.listeners(event)) {
        try {
          const r = (l as (...a: unknown[]) => unknown)(bot, detail);
          if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch((e) => this.order.log(`squad.on('${event}'): ${errorMessage(e)}`));
        } catch (e) {
          this.order.log(`squad.on('${event}'): ${errorMessage(e)}`);
        }
      }
    }
  }

  /**
   * The subroutine ended: its bots go back to the lender (to the role they had there), its listeners, timers and
   * sleeps end (a sleep rejects with OrderStoppedError), `stopped` turns true. Idempotent.
   */
  dispose(): Promise<void> {
    if (this.holder === null) return Promise.resolve();
    this.disposing ??= this.disposeNow();
    return this.disposing;
  }

  /** Whether the view ended (dispose was called). */
  get ended(): boolean {
    return this.disposed;
  }

  private async disposeNow(): Promise<void> {
    this.disposed = true;
    this.controller?.abort();
    for (const c of this.cleanups.splice(0)) c();
    for (const done of [...this.sleepers]) done(new OrderStoppedError('subroutine ended'));
    for (const w of this.endWaiters.splice(0)) w();
    const held = this.bots.map((b) => this.order.nameOf(b)).filter((n): n is string => !!n);
    this.bots.length = 0;
    for (const arr of Object.values(this.roles)) arr.length = 0;
    this.events.removeAllListeners();
    for (const name of held) this.handDown(name, await this.order.unlend(name, this));
  }

  /** True once the order is stopped, timed out or finished (for a view: or once its subroutine ended). */
  get stopped(): boolean {
    return !this.order.alive || this.disposed;
  }

  get signal(): AbortSignal {
    return this.controller ? AbortSignal.any([this.order.signal, this.controller.signal]) : this.order.signal;
  }

  /** The order's squad tag (`esc-N`, docs/40) when the order is scoped to one, else null. */
  get tag(): string | null {
    return this.order.squad ?? null;
  }

  /**
   * Run `fn` on each bot at once. Resolves to one result per bot; a bot failing or leaving never rejects the call.
   * Rejects only when the order itself is stopped.
   */
  async parallel<T>(bots: Bot[] | Bot, fn: (bot: Bot) => Promise<T> | T): Promise<Array<ParallelResult<T>>> {
    if (typeof fn !== 'function') throw new TypeError('squad.parallel(bots, fn): fn must be a function');
    const live = Array.isArray(bots) && (bots === this.bots || Object.values(this.roles).includes(bots));
    const list = Array.isArray(bots) ? [...bots] : [bots];
    const settled = live ? await this.parallelLive(bots, fn) : (await Promise.allSettled(list.map(async (bot) => fn(bot)))).map((s, i) => ({ bot: list[i] as Bot, s }));
    if (this.stopped) throw new OrderStoppedError(this.disposed ? 'subroutine ended' : 'order ended');
    return settled.map(({ bot, s }) => {
      if (s.status === 'fulfilled') return { bot, ok: true, value: s.value };
      const e = s.reason;
      if (isStopped(e)) return { bot, ok: false, error: errorMessage(e) };
      const name = this.order.nameOf(bot) ?? String((bot as { username?: string }).username);
      const left = isBotLeft(e) || !this.order.hasMember(name) || !this.bots.includes(bot);
      if (!left) this.order.failure(name, 'parallel', e);
      return { bot, ok: false, error: errorMessage(e), ...(left ? { left: true } : {}) };
    });
  }

  /**
   * `parallel` over the squad's own live array (`squad.bots`, `squad.roles.x`): a bot reclaimed by another order (or
   * lent to a subroutine) and given back (§6.3) runs `fn` again, and the call waits for such a bot while it can still
   * come back. Without this a returning bot rejoined `squad.bots` but no loop drove it: `defend`'s guards stood idle
   * after a shield wall borrowed them (docs/33). One result per run, so a bot that came back has two.
   */
  private parallelLive<T>(arr: Bot[], fn: (bot: Bot) => Promise<T> | T): Promise<Array<{ bot: Bot; s: PromiseSettledResult<T> }>> {
    const order = this.order;
    return new Promise((resolve) => {
      const results: Array<{ bot: Bot; s: PromiseSettledResult<T> }> = [];
      const running = new Set<Bot>();
      let poll: ReturnType<typeof setInterval> | undefined;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.events.removeListener('joined', onJoined);
        if (poll) clearInterval(poll);
        resolve(results);
      };
      // A death or a disconnect clears the bot's whole lease stack without telling the orders below, so the wait
      // looks again every second rather than only on events.
      const check = (): void => {
        if (running.size > 0) return;
        if (this.stopped || (order.suspended().length === 0 && this.lentRoles.size === 0)) return finish();
        if (!poll) {
          poll = setInterval(check, 1_000);
          poll.unref?.();
        }
      };
      const run = (bot: Bot): void => {
        if (done || running.has(bot)) return;
        running.add(bot);
        const slot = results.length;
        results.push({ bot, s: { status: 'rejected', reason: new OrderStoppedError('order ended') } });
        void (async () => fn(bot))()
          .then(
            (value) => (results[slot] = { bot, s: { status: 'fulfilled', value } }),
            (reason: unknown) => (results[slot] = { bot, s: { status: 'rejected', reason } }),
          )
          .finally(() => {
            running.delete(bot);
            check();
          });
      };
      // The squad pushes a returning bot into its arrays before it emits 'joined'.
      const onJoined = (bot: Bot): void => {
        if (!this.stopped && arr.includes(bot)) run(bot);
      };
      this.events.on('joined', onJoined);
      for (const bot of [...arr]) run(bot);
      check();
    });
  }

  /**
   * One loop per bot, `fn(bot, role)` again and again (docs/43 C1): what a formation or a fight needs from each of
   * its bots. A bot that leaves (dead, reclaimed, lent) ends its loop; one that comes back (a 'joined') gets a new
   * one, with `setup` called again first (the listeners a bot had were removed when it left). A pass that throws is
   * logged and followed by a 500 ms pause; every pass is followed by at least a macrotask and, when shorter than
   * `minPassMs`, a pause up to it, so a pass that awaited nothing cannot starve the event loop. Returns `stop()`.
   */
  crew(fn: (bot: Bot, role: string | undefined) => unknown, opts: CrewOptions = {}): { stop: () => void } {
    if (typeof fn !== 'function') throw new TypeError('squad.crew(fn, opts): fn must be a function');
    const tokens = new Map<Bot, object>();
    const minPass = Math.max(0, Number(opts.minPassMs ?? CREW_MIN_PASS_MS));
    let stopped = false;
    const goOn = (): boolean => !stopped && !this.stopped && (opts.while ? !!opts.while() : true);
    const launch = (bot: Bot, role: string | undefined): void => {
      if (opts.roles && (role === undefined || !opts.roles.includes(role))) return;
      if (!goOn() || !this.bots.includes(bot)) return;
      const token = {};
      tokens.set(bot, token);
      try {
        opts.setup?.(bot, role);
      } catch (e) {
        if (isBotLeft(e) || isStopped(e)) return;
        this.order.log(`${(bot as { username?: string }).username}: crew setup: ${errorMessage(e)}`);
      }
      void (async () => {
        while (goOn() && tokens.get(bot) === token && this.bots.includes(bot)) {
          const t0 = Date.now();
          try {
            await fn(bot, role);
          } catch (e) {
            if (isBotLeft(e) || isStopped(e)) break;
            this.order.log(`${(bot as { username?: string }).username}: ${errorMessage(e)}`);
            await this.sleep(CREW_ERROR_PAUSE_MS);
            continue;
          }
          await this.sleep(Math.max(0, minPass - (Date.now() - t0)));
        }
      })().catch(() => undefined);
    };
    const onJoined = (bot: Bot, role: unknown): void => launch(bot, typeof role === 'string' ? role : this.roleIn(bot));
    this.events.on('joined', onJoined);
    for (const bot of [...this.bots]) launch(bot, this.roleIn(bot));
    return {
      stop: () => {
        stopped = true;
        this.events.removeListener('joined', onJoined);
      },
    };
  }

  /**
   * A work queue: each free bot takes the next item. An item whose bot leaves goes back in the queue; a failed item
   * is retried `retries` times (on any bot); bots that join the order (a reclaimed bot coming back, an `acquire`)
   * start pulling too. Resolves to one result per item, in item order.
   */
  tasks<I, T>(
    items: I[],
    fn: (bot: Bot, item: I, index: number) => Promise<T> | T,
    opts: { bots?: Bot[]; retries?: number } = {},
  ): Promise<Array<TaskResult<T>>> {
    if (!Array.isArray(items)) throw new TypeError('squad.tasks(items, fn): items must be an array');
    if (typeof fn !== 'function') throw new TypeError('squad.tasks(items, fn): fn must be a function');
    const order = this.order;
    const pool = opts.bots ?? this.bots;
    const retries = Math.max(0, opts.retries ?? 1);
    const queue = items.map((item, index) => ({ item, index, attempts: 0 }));
    const results: Array<TaskResult<T>> = new Array(items.length);
    const active = new Set<string>();
    let inflight = 0;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;

    return new Promise<Array<TaskResult<T>>>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (waitTimer) clearTimeout(waitTimer);
        this.events.removeListener('joined', kick);
        if (err) reject(err);
        else resolve(results);
      };
      const work = async (bot: Bot, name: string): Promise<void> => {
        while (queue.length > 0 && order.running && !this.stopped && order.hasMember(name) && pool.includes(bot)) {
          const job = queue.shift() as (typeof queue)[number];
          inflight++;
          try {
            const value = await fn(bot, job.item, job.index);
            results[job.index] = { item: job.item, ok: true, value, bot: name };
          } catch (e) {
            if (isStopped(e) || this.stopped) {
              inflight--;
              finish(isStopped(e) ? e : new OrderStoppedError('order ended'));
              return;
            }
            if (isBotLeft(e) || !order.hasMember(name) || !pool.includes(bot)) {
              queue.unshift(job); // someone else does it
              inflight--;
              return;
            }
            job.attempts++;
            order.failure(name, 'tasks', e, job.item);
            if (job.attempts <= retries) queue.push(job);
            else results[job.index] = { item: job.item, ok: false, error: errorMessage(e), bot: name };
          }
          inflight--;
          // A macrotask before the next item. An item that fails before its first real await (mineBlock throwing
          // after a synchronous findBlocks found nothing) would otherwise be retried, and the next one taken, in
          // microtasks only: the whole queue would fail before a timer, a packet or the supervisor's heartbeat got
          // a turn (a 3-minute freeze live, docs/31 §2.6). The loop condition is checked again after it.
          await nextTurn();
        }
      };
      const kick = (): void => {
        if (settled) return;
        if (this.stopped) return finish(new OrderStoppedError('order ended'));
        for (const bot of [...pool]) {
          // Only while work is queued: a worker started on an empty queue would end at once, and its `finally`
          // would kick again, forever (a microtask loop that freezes every bot).
          if (queue.length === 0) break;
          const name = order.nameOf(bot);
          if (!name || !order.hasMember(name) || active.has(name)) continue;
          active.add(name);
          void work(bot, name).finally(() => {
            active.delete(name);
            kick();
          });
        }
        if (queue.length === 0 && inflight === 0 && active.size === 0) return finish();
        if (queue.length > 0 && active.size === 0 && inflight === 0) {
          // Every bot is gone; give a reclaimed one the chance to come back.
          if (!waitTimer) {
            waitTimer = setTimeout(() => {
              waitTimer = undefined;
              if (active.size > 0) return;
              for (const job of queue.splice(0)) {
                results[job.index] = { item: job.item, ok: false, error: 'no bot left in the order to do it' };
              }
              finish();
            }, TASKS_WAIT_FOR_BOTS_MS);
          }
        } else if (waitTimer) {
          clearTimeout(waitTimer);
          waitTimer = undefined;
        }
      };
      this.events.on('joined', kick);
      this.signal.addEventListener('abort', () => finish(new OrderStoppedError('order ended')), { once: true });
      kick();
    });
  }

  /** Reserve a key across ALL orders (true if it is now yours). `blockKey(pos)` makes a key for a block. */
  claim(key: string, opts: { ttlSeconds?: number } = {}): boolean {
    this.order.assertRunning();
    return this.deps.claims.claim(String(key), this.order.id, opts.ttlSeconds ?? 300);
  }

  unclaim(key: string): void {
    this.deps.claims.unclaim(String(key), this.order.id);
  }

  /**
   * Ask for more of the commander's bots mid-run, with the manifest's role rules: `{ select, max, take, as }`.
   * Resolves to the bots granted (maybe none); they also appear in `squad.bots` and `squad.roles[as]`.
   */
  async acquire(spec: { select?: unknown; max?: number; min?: number; take?: 'free' | 'reclaim'; as?: string } = {}): Promise<Bot[]> {
    const role = validateRoleSpec(spec, 'squad.acquire', ['as']);
    const as = typeof spec.as === 'string' && spec.as ? spec.as : 'extra';
    if (this.disposed) throw new OrderStoppedError('subroutine ended');
    const got = await this.order.acquire(role, as, this.deps.candidates());
    if (this.holder === null) return got;
    // A view: the new members (the order's own squad drives them at first) are lent to it.
    const out: Bot[] = [];
    const root = this.rootSquad();
    for (const b of got) {
      const name = this.order.nameOf(b);
      if (!name) continue;
      const g = await this.order.lend(name, null, this);
      if (!g) continue;
      root.lentOut(name, b);
      if (!this.bots.includes(g)) this.bots.push(g);
      (this.roles[as] ??= []).push(g);
      out.push(g);
    }
    return out;
  }

  /** The order's own squad, up the chain of views. */
  private rootSquad(): Squad {
    return this.parent ? this.parent.rootSquad() : this;
  }

  /** Let a bot go: it returns to the order it was reclaimed from (if still running), else it goes idle. */
  release(bot: Bot): Promise<void> {
    return this.order.releaseBot(bot);
  }

  /** `joined` (bot, role) / `left` (bot, reason). Listeners are removed when the order (or the subroutine) ends. */
  on(event: 'joined' | 'left', fn: (bot: Bot, detail: string) => unknown): void {
    if (event !== 'joined' && event !== 'left') throw new Error(`squad.on: unknown event "${String(event)}" (joined, left)`);
    this.events.on(event, fn);
  }

  off(event: 'joined' | 'left', fn: (bot: Bot, detail: string) => unknown): void {
    this.events.removeListener(event, fn);
  }

  /** Resolves after `ms`; rejects with OrderStoppedError when the order stops (or the subroutine ends) first. */
  sleep(ms: number): Promise<void> {
    if (this.disposed) return Promise.reject(new OrderStoppedError('subroutine ended'));
    if (this.holder === null) return this.order.sleep(ms);
    return new Promise<void>((resolve, reject) => {
      const done = (e?: Error): void => {
        this.sleepers.delete(done);
        if (e) reject(e);
        else resolve();
      };
      this.sleepers.add(done);
      this.order.sleep(ms).then(
        () => done(),
        (e: Error) => done(e),
      );
    });
  }

  /** Call `fn` every `ms` until the order (or the subroutine) ends; returns a function that stops it. */
  every(ms: number, fn: () => unknown): () => void {
    const t = this.order.setInterval(() => (this.disposed ? undefined : fn()), ms);
    const stop = (): void => this.order.clearInterval(t);
    if (this.holder !== null) this.cleanups.push(stop);
    return stop;
  }

  /** Resolves when the order is stopped (or the subroutine ended): an `until-stopped` command that only reacts awaits it. */
  untilStopped(): Promise<void> {
    if (this.holder === null) return this.order.untilStopped();
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => this.endWaiters.push(resolve));
  }
}

/** Resolves from a setImmediate, so the event loop's timers and I/O get a turn before the caller goes on. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function remove<T>(arr: T[], v: T): void {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
}
