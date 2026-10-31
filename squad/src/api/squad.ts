// `squad`: the order's bots and the cooperation primitives (docs/29 §5.2). Everything is awaitable; a bot leaving
// is handled inside parallel/tasks so scripts written with them keep going with the bots they still have.

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
  /** The bot left the order during the call (reclaimed, released, died, disconnected). */
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

/** How long `tasks` waits for a bot to join when every bot left with work still queued. */
export const TASKS_WAIT_FOR_BOTS_MS = 30_000;

export class Squad {
  /** The bots of this squad: the order's own live array, or a subset view for a `ctx.run` subroutine. */
  readonly bots: Bot[];
  readonly roles: Record<string, Bot[]>;
  private readonly subset: Set<string> | null;

  constructor(
    private readonly order: Order,
    private readonly deps: SquadDeps,
    view?: { bots: Bot[]; manifest: Manifest },
  ) {
    if (!view) {
      this.bots = order.bots;
      this.roles = order.roles;
      this.subset = null;
      return;
    }
    // A subroutine's view: the given bots, its own roles matched by its manifest's selectors, kept live.
    this.subset = new Set(view.bots.map((b) => order.nameOf(b)).filter((n): n is string => !!n && order.hasMember(n)));
    this.bots = order.bots.filter((b) => this.subset!.has(order.nameOf(b) as string));
    this.roles = {};
    const taken = new Set<string>();
    for (const [role, spec] of Object.entries(view.manifest.roles)) {
      const arr: Bot[] = [];
      for (const b of this.bots) {
        const name = order.nameOf(b) as string;
        const f = deps.facts(name);
        if (taken.has(name) || arr.length >= spec.max || !f || !matches(spec.select, f)) continue;
        arr.push(b);
        taken.add(name);
      }
      if (arr.length < spec.min) throw new Error(`ctx.run: role "${role}" needs ${spec.min} bot(s), the given bots match ${arr.length}`);
      this.roles[role] = arr;
    }
    order.events.on('left', (bot: Bot) => {
      remove(this.bots, bot);
      for (const arr of Object.values(this.roles)) remove(arr, bot);
    });
    order.events.on('joined', (bot: Bot) => {
      const name = order.nameOf(bot);
      if (name && this.subset!.has(name) && !this.bots.includes(bot)) this.bots.push(bot);
    });
  }

  /** True once the order is stopped, timed out or finished. */
  get stopped(): boolean {
    return !this.order.alive;
  }

  get signal(): AbortSignal {
    return this.order.signal;
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
    if (this.stopped) throw new OrderStoppedError('order ended');
    return settled.map(({ bot, s }) => {
      if (s.status === 'fulfilled') return { bot, ok: true, value: s.value };
      const e = s.reason;
      if (isStopped(e)) return { bot, ok: false, error: errorMessage(e) };
      const name = this.order.nameOf(bot) ?? String((bot as { username?: string }).username);
      const left = isBotLeft(e) || !this.order.hasMember(name);
      if (!left) this.order.failure(name, 'parallel', e);
      return { bot, ok: false, error: errorMessage(e), ...(left ? { left: true } : {}) };
    });
  }

  /**
   * `parallel` over the order's own live array (`squad.bots`, `squad.roles.x`): a bot reclaimed by another order and
   * given back (§6.3) runs `fn` again, and the call waits for such a bot while it can still come back. Without this a
   * returning bot rejoined `squad.bots` but no loop drove it: `defend`'s guards stood idle after a shield wall
   * borrowed them (docs/33). One result per run, so a bot that came back has two.
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
        order.events.removeListener('joined', onJoined);
        if (poll) clearInterval(poll);
        resolve(results);
      };
      // A death or a disconnect clears the bot's whole lease stack without telling the orders below, so the wait
      // looks again every second rather than only on events.
      const check = (): void => {
        if (running.size > 0) return;
        if (!order.alive || order.suspended().length === 0) return finish();
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
      // The order pushes a returning bot into its arrays before it emits 'joined'.
      const onJoined = (bot: Bot): void => {
        if (order.alive && arr.includes(bot)) run(bot);
      };
      order.events.on('joined', onJoined);
      for (const bot of [...arr]) run(bot);
      check();
    });
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
        order.events.removeListener('joined', kick);
        if (err) reject(err);
        else resolve(results);
      };
      const work = async (bot: Bot, name: string): Promise<void> => {
        while (queue.length > 0 && order.running && order.hasMember(name) && pool.includes(bot)) {
          const job = queue.shift() as (typeof queue)[number];
          inflight++;
          try {
            const value = await fn(bot, job.item, job.index);
            results[job.index] = { item: job.item, ok: true, value, bot: name };
          } catch (e) {
            if (isStopped(e) || !order.alive) {
              inflight--;
              finish(isStopped(e) ? e : new OrderStoppedError('order ended'));
              return;
            }
            if (isBotLeft(e) || !order.hasMember(name)) {
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
      function kick(): void {
        if (settled) return;
        if (!order.alive) return finish(new OrderStoppedError('order ended'));
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
      }
      order.events.on('joined', kick);
      order.signal.addEventListener('abort', () => finish(new OrderStoppedError('order ended')), { once: true });
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
    const got = await this.order.acquire(role, as, this.deps.candidates());
    if (this.subset) {
      for (const b of got) {
        const n = this.order.nameOf(b);
        if (n) this.subset.add(n);
        if (!this.bots.includes(b)) this.bots.push(b);
        (this.roles[as] ??= []).push(b);
      }
    }
    return got;
  }

  /** Let a bot go: it returns to the order it was reclaimed from (if still running), else it goes idle. */
  release(bot: Bot): Promise<void> {
    return this.order.releaseBot(bot);
  }

  /** `joined` (bot, role) / `left` (bot, reason). Listeners are removed when the order ends. */
  on(event: 'joined' | 'left', fn: (bot: Bot, detail: string) => unknown): void {
    if (event !== 'joined' && event !== 'left') throw new Error(`squad.on: unknown event "${String(event)}" (joined, left)`);
    this.order.events.on(event, fn);
  }

  off(event: 'joined' | 'left', fn: (bot: Bot, detail: string) => unknown): void {
    this.order.events.removeListener(event, fn);
  }

  sleep(ms: number): Promise<void> {
    return this.order.sleep(ms);
  }

  /** Call `fn` every `ms` until the order ends; returns a function that stops it. */
  every(ms: number, fn: () => unknown): () => void {
    const t = this.order.setInterval(fn, ms);
    return () => this.order.clearInterval(t);
  }

  /** Resolves when the order is stopped (an `until-stopped` command that only reacts to events awaits this). */
  untilStopped(): Promise<void> {
    return this.order.untilStopped();
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
