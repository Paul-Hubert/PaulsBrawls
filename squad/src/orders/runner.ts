// The order runner (docs/29 §7): resolve a command, compile it (once per version), run its module with a fresh
// order scope, parse the args against its manifest, grant bots (§6.2, reclaiming as the roles demand), run it
// under supervision, and journal + announce the end. Trials (§8.3) are orders too, on the author's idle bots.
// A bound item's click (§5.4) is a trigger: it reaches the player's running order of that command, or starts it.

import { EventEmitter } from 'node:events';

import type { Bot } from 'mineflayer';

import type { Limits } from '../config';
import type { Journal } from '../journal/journal';
import type { LeaseManager, RoleRequest, Take } from '../leases';
import type { Roster } from '../roster';
import { errorMessage, isBotLeft, isStopped } from '../api/errors';
import { buildCtx, buildScope, subCommander, type RunOptions } from '../api/scope';
import { Squad } from '../api/squad';
import { compile, CompileError, type CommandFactory } from '../script/compile';
import { ManifestError, matches, parseArgs, usage, validateManifest, type BotFacts, type Manifest } from '../script/manifest';
import { STOCK_AUTHOR, StoreError, type CommandStore, type Resolved } from '../store/commands';
import type { CommandRef, Notice, OrderReport, Player, Snapshot } from '../types';
import type { ClaimRegistry } from './claims';
import { Order, type OrderDeps } from './order';

/** The pool as the runner needs it (BotPool implements it; tests use a fake). */
export interface PoolView {
  bot(name: string): Bot | undefined;
  movements(name: string): unknown;
}

export interface RunnerDeps {
  pool: PoolView;
  roster: Roster;
  leases: LeaseManager;
  claims: ClaimRegistry;
  store: CommandStore;
  journal: Journal;
  limits: Limits;
}

export interface OrderRequest {
  commander: Player;
  /** NAME or owner:NAME. */
  command: string;
  tokens: string[];
  /** @bot filters (only these bots may be granted). */
  filters?: string[];
  take?: Take;
  /**
   * The selected squad (a roster tag: one `/bots squad spawn`, docs/40): only its bots may be granted, and the binding
   * is per squad, so two squads of one player each run their own `line`.
   */
  squad?: string;
  snap: Snapshot;
}

export type StartResult =
  | { ok: true; orderId: string; text: string; bots: Array<{ name: string; role: string; from?: string }> }
  | { ok: false; text: string; click?: Notice['click'] };

/** A click of a bound item (§5.4): the binding's order line, and the snapshot taken at the click (with `trigger`). */
export interface TriggerRequest extends OrderRequest {
  /** Sneak + right-click: stop the binding's order. */
  stop?: boolean;
}

export type TriggerResult =
  | (StartResult & { started?: true; restarted?: true })
  | { ok: true; text: ''; orderId: string; delivered: true }
  | { ok: true; text: string; orderId?: string; stopped: boolean };

export interface TrialRequest {
  author: Player;
  name: string;
  source: string;
  tokens: string[];
  snap: Snapshot;
  seconds: number;
}

/**
 * Events: `notice` (Notice) for the mod to show; `state` () when bots, leases or orders changed (the mod
 * refreshes its cache).
 */
export class OrderRunner extends EventEmitter {
  private readonly orders = new Map<string, Order>();
  private readonly compiled = new Map<string, CommandFactory>();
  /** Starts in flight per binding key (commander, author, command): a trigger arriving meanwhile waits for them. */
  private readonly starting = new Map<string, Promise<StartResult>>();
  /** A delivered click's take-back in flight per order (takeBack). */
  private readonly takingBack = new Map<string, Promise<void>>();
  private nextId: number;

  constructor(private readonly deps: RunnerDeps) {
    super();
    this.nextId = deps.journal.nextId();
    // Friends follow the roster: a bot spawned, despawned or re-owned mid-order (every such change emits 'state')
    // must not keep the side it had when the order started.
    this.on('state', () => {
      for (const o of this.running()) this.refreshFriends(o);
    });
  }

  // -- queries ---------------------------------------------------------------------------------------------------

  running(): Order[] {
    return [...this.orders.values()].filter((o) => !o.ended);
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  describe(orderId: string): { commander: string; command: string } | undefined {
    const o = this.orders.get(orderId);
    return o ? { commander: o.commander.name, command: o.command.name } : undefined;
  }

  /** Tags + items of a bot, for selectors. Items: inventory, held, armor (substring-matched by hasItem). */
  facts(name: string): BotFacts | undefined {
    const rb = this.deps.roster.get(name);
    if (!rb) return undefined;
    const items = new Set<string>();
    const bot = this.deps.pool.bot(rb.name);
    if (bot) {
      try {
        for (const s of bot.inventory?.slots ?? []) if (s) items.add(s.name);
        for (const it of bot.inventory?.items?.() ?? []) items.add(it.name);
        if (bot.heldItem) items.add(bot.heldItem.name);
      } catch {
        /* a half-spawned bot */
      }
    }
    return { name: rb.name, tags: rb.tags, items: [...items] };
  }

  /** The commander's online bots, restricted to `filters` and to the bots tagged `squad` when given. */
  candidates(uuid: string, filters: string[] = [], squad?: string): string[] {
    const want = new Set(filters.map((f) => f.toLowerCase()));
    return this.deps.roster
      .botsOf(uuid)
      .filter((b) => !squad || b.tags.includes(squad))
      .map((b) => b.name)
      .filter((n) => (want.size === 0 || want.has(n.toLowerCase())) && !!this.deps.pool.bot(n));
  }

  // -- orders ----------------------------------------------------------------------------------------------------

  /** `/bots order` (and a trigger's start): tracked, so a click arriving while it starts waits for it. */
  start(req: OrderRequest): Promise<StartResult> {
    const b = this.bindingOf(req.commander, req.command, req.squad);
    const p = this.launch(req);
    return 'error' in b ? p : this.track(b.key, p);
  }

  private async launch(req: OrderRequest): Promise<StartResult> {
    const owned = this.deps.roster.botsOf(req.commander.uuid);
    if (owned.length === 0) return { ok: false, text: "[Bots] Tu ne possèdes aucun bot (un admin en crée avec /bots spawn)." };
    for (const f of req.filters ?? []) {
      if (!owned.some((b) => b.name.toLowerCase() === f.toLowerCase())) return { ok: false, text: `[Bots] ${f} n'est pas un de tes bots.` };
    }
    const squad = req.squad;
    if (squad && !owned.some((b) => b.tags.includes(squad))) {
      return { ok: false, text: `[Bots] Aucun de tes bots dans l'escouade sélectionnée (${squad}).` };
    }
    let resolved: Resolved;
    try {
      resolved = this.deps.store.resolve(req.commander.uuid, req.command);
    } catch (e) {
      return { ok: false, text: `[Bots] ${errorMessage(e)}` };
    }
    const ref: CommandRef = { author: resolved.meta.author, name: resolved.meta.name, version: resolved.version };
    const order = this.newOrder(ref, req.commander, req.snap, false);
    order.filters = [...(req.filters ?? [])];
    if (req.take) order.take = req.take;
    if (squad) order.squad = squad;
    try {
      const factory = this.factory(ref, resolved.source);
      const { fn, manifest } = await this.load(order, factory);
      let args: Record<string, unknown>;
      try {
        args = parseArgs(manifest, req.tokens);
      } catch (e) {
        await this.abandon(order);
        return { ok: false, text: `[Bots] ${errorMessage(e)}. Usage : ${usage(ref.name, manifest)}` };
      }
      order.args = args;
      order.report.args = args;
      order.limitMs = this.limitMs(manifest);
      const roles = this.roleRequests(manifest, req.take);
      const plan = this.deps.leases.plan(order.id, roles, this.candidates(req.commander.uuid, req.filters, squad));
      if (!plan.ok) {
        await this.abandon(order);
        const detail = plan.shortfall.map((s) => `${s.role} ${s.got}/${s.min}`).join(', ');
        const where = squad ? ` dans l'escouade (${squad})` : '';
        return { ok: false, text: `[Bots] Pas assez de bots${where} pour « ${ref.name} » : ${detail}.${this.offlineHint(req.commander.uuid, squad)}` };
      }
      this.deps.leases.register(order);
      await this.deps.leases.apply(order.id, plan.grants);
      order.begin(plan.grants, manifest);
      this.refreshFriends(order);
      this.deps.journal.save(order.report);
      this.emit('state');
      this.execute(order, fn, args);
      const bots = plan.grants.map((g) => ({ name: g.bot, role: g.role, ...(g.from ? { from: g.from } : {}) }));
      return { ok: true, orderId: order.id, bots, text: `[Bots] « ${ref.name} » lancé (#${order.id}) : ${describeBots(bots, manifest)}.` };
    } catch (e) {
      await this.abandon(order);
      const click = this.fixClick(req.commander, ref);
      return { ok: false, text: `[Bots] « ${ref.name} » v${ref.version} ne démarre pas : ${firstLine(e)}`, ...(click ? { click } : {}) };
    }
  }

  /**
   * A bound item's trigger (§5.4 item 6). The binding's order is the player's running order of that command (author
   * + name), whoever started it (a click or `/bots order`); trials never count.
   * - `stop`: stop it.
   * - Running and listening (it called `ctx.commander.on('trigger')` or `next()`), with the same args, @bot filters
   *   and take: deliver, then take back the order's bots (docs/35 F5, Paul's D5): its roles are planned again as a
   *   start would, over the commander's bots not in it, and granted mid-run; a bot lent from it to another order
   *   (an `epee` reclaimed the wall's guards) comes back from there. The answer has no text (no chat line per click).
   * - Running, not listening, or a click whose args, filters or take differ: restart it with the new snapshot, args,
   *   filters and take.
   * - Not running: start it like `/bots order`.
   * A trigger arriving while a start of the binding is in flight (the arrow-hit after the arrow-release that starts
   * the order) waits for it, then goes to the order it started even before that order listens.
   */
  async trigger(req: TriggerRequest): Promise<TriggerResult> {
    const b = this.bindingOf(req.commander, req.command, req.squad);
    const ofSquad = (o: Order): boolean => (o.squad ?? '') === (req.squad ?? '');
    if ('error' in b) {
      // The command no longer resolves for the player (unshared, deleted): the stop gesture still stops what runs.
      const stale = req.stop ? this.mineRunning(req.commander, (o) => ofSquad(o) && refMatches(o, req.command)) : [];
      return stale.length ? this.stopByTrigger(stale, req) : { ok: false, text: b.error };
    }
    let fresh: string | undefined;
    for (let p = this.starting.get(b.key); p; p = this.starting.get(b.key)) {
      const r = await p;
      fresh = r.ok ? r.orderId : undefined;
    }
    // From here to the tracked restart below nothing awaits, so two triggers can never both start the binding.
    // A squad's binding is that squad's order of the command: another squad's `line` is another binding.
    const mine = this.mineRunning(req.commander, (o) => ofSquad(o) && o.command.author.uuid === b.author && o.command.name === b.name);
    if (req.stop) {
      const none = `[Bots] Aucun ordre « ${b.name} » en cours${req.squad ? ' pour cette escouade' : ''}.`;
      return mine.length ? this.stopByTrigger(mine, req) : { ok: true, text: none, stopped: false };
    }
    const current = mine[mine.length - 1];
    if (current && (current.listening || current.id === fresh) && sameLine(current, req) && current.deliverTrigger(req.snap)) {
      await this.takeBack(current, req.commander);
      return { ok: true, text: '', orderId: current.id, delivered: true };
    }
    const restarted = mine.map((o) => o.id);
    const r = await this.track(
      b.key,
      (async () => {
        for (const o of mine) o.silentEnd = true; // the start's answer is the player's line
        await Promise.all(mine.map((o) => o.stop('stopped', `restarted by ${req.commander.name}'s bound item`)));
        return this.launch(req);
      })(),
    );
    if (!r.ok) {
      // The old order is gone and the new one refused: say both, since the old one ended without a line.
      return restarted.length ? { ...r, text: `[Bots] « ${b.name} » (${restarted.map((id) => '#' + id).join(', ')}) arrêté.\n${r.text}` } : r;
    }
    this.orders.get(r.orderId)?.noteTrigger(req.snap, restarted.length ? 'restarted' : 'started');
    return restarted.length ? { ...r, restarted: true } : { ...r, started: true };
  }

  /**
   * A delivered click takes back the order's bots (docs/35 F5): each role of its manifest, in order, gets the
   * commander's bots that match it and are not in the order, as at its start (idle ones first, then for a `reclaim`
   * role busy ones, a bot lent from this order to another coming back from there), up to the role's max. They join
   * the running order (a 'joined' event each: the item commands re-form). One take-back at a time per order: two
   * quick clicks would otherwise plan the same bot twice.
   */
  private takeBack(order: Order, commander: Player): Promise<void> {
    const prev = this.takingBack.get(order.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const m = order.manifest;
      if (!m || !order.running) return;
      const candidates = this.candidates(commander.uuid, order.filters, order.squad);
      let got = 0;
      for (const [role, spec] of Object.entries(m.roles)) {
        if (!order.running) break;
        const room = spec.max - (order.roles[role]?.length ?? 0);
        if (room <= 0) continue;
        got += (await order.acquire({ select: spec.select, max: room, take: order.take ?? spec.take }, role, candidates, { announce: true })).length;
      }
      if (got > 0) this.emit('state');
    }).catch(() => undefined); // the order stopped meanwhile: nothing to take back
    this.takingBack.set(order.id, next);
    void next.then(() => {
      if (this.takingBack.get(order.id) === next) this.takingBack.delete(order.id);
    });
    return next;
  }

  private async stopByTrigger(victims: Order[], req: TriggerRequest): Promise<TriggerResult> {
    for (const o of victims) {
      o.noteTrigger(req.snap, 'stopped');
      o.silentEnd = true; // the answer below is the player's line
    }
    await Promise.all(victims.map((o) => o.stop('stopped', `stopped by ${req.commander.name}'s bound item`)));
    const last = victims[victims.length - 1] as Order;
    return { ok: true, text: `[Bots] « ${last.command.name} » arrêté.`, orderId: last.id, stopped: true };
  }

  /** The player's running (not starting, not ended) non-trial orders passing `pick`, oldest first. */
  private mineRunning(commander: Player, pick: (o: Order) => boolean): Order[] {
    return this.running().filter((o) => o.running && !o.trial && o.commander.uuid === commander.uuid && pick(o));
  }

  /**
   * The binding key of a command line for a player: who orders, which command (author + name, not the version) and
   * for which squad (docs/40: each selected squad has its own order of a command).
   */
  private bindingOf(commander: Player, command: string, squad?: string): { key: string; author: string; name: string } | { error: string } {
    try {
      const r = this.deps.store.resolve(commander.uuid, command);
      return { key: `${commander.uuid}|${r.meta.author.uuid}/${r.meta.name}|${squad ?? ''}`, author: r.meta.author.uuid, name: r.meta.name };
    } catch (e) {
      return { error: `[Bots] ${errorMessage(e)}` };
    }
  }

  private track(key: string, p: Promise<StartResult>): Promise<StartResult> {
    this.starting.set(key, p);
    const clear = (): void => {
      if (this.starting.get(key) === p) this.starting.delete(key);
    };
    p.then(clear, clear);
    return p;
  }

  /** §8.3: run a draft on the author's idle bots for at most `seconds`; resolves to its report. */
  async trial(req: TrialRequest): Promise<OrderReport | { error: string }> {
    const ref: CommandRef = { author: req.author, name: req.name, version: 0 };
    const order = this.newOrder(ref, req.author, req.snap, true);
    try {
      const factory = compile(req.source, order.filename);
      const { fn, manifest } = await this.load(order, factory);
      const args = parseArgs(manifest, req.tokens);
      order.args = args;
      order.report.args = args;
      order.limitMs = req.seconds * 1000;
      const roles = this.roleRequests(manifest, 'free');
      const plan = this.deps.leases.plan(order.id, roles, this.candidates(req.author.uuid));
      if (!plan.ok) {
        await this.abandon(order);
        const detail = plan.shortfall.map((s) => `${s.role} ${s.got}/${s.min}`).join(', ');
        return { error: `not enough IDLE bots for a trial (a trial never reclaims): ${detail}. Idle bots of the player: ${this.idleOf(req.author.uuid).join(', ') || 'none'}` };
      }
      this.deps.leases.register(order);
      await this.deps.leases.apply(order.id, plan.grants);
      order.begin(plan.grants, manifest);
      this.refreshFriends(order);
      this.emit('state');
      this.execute(order, fn, args);
      await order.waitEnded();
      return order.report;
    } catch (e) {
      await this.abandon(order);
      return { error: errorMessage(e) };
    }
  }

  /**
   * `ctx.run(name, args, { bots, until, signal })`: another command the commander may use, as a subroutine of this
   * order, on a view of `parent` (docs/43 C2/C3). Its bots (`bots`, default all of the parent's) are lent to it while
   * it runs and come back when it ends: when it returns or throws, when `until()` turns true (checked every 100 ms)
   * or `signal` aborts. Ended that way it resolves to undefined. Its `ctx.commander` listeners end with it.
   */
  private async runSub(order: Order, parent: Squad, stack: string[], name: string, rawArgs: Record<string, unknown> | undefined, opts: RunOptions | undefined): Promise<unknown> {
    if (stack.length >= this.deps.limits.maxCallDepth) throw new Error(`ctx.run: depth ${stack.length} reached (max ${this.deps.limits.maxCallDepth})`);
    let resolved: Resolved;
    try {
      resolved = this.deps.store.resolve(order.commander.uuid, name);
    } catch (e) {
      throw new Error(`ctx.run("${name}"): ${errorMessage(e)}`);
    }
    const key = `${resolved.meta.author.uuid}/${resolved.meta.name}`;
    if (stack.includes(key)) throw new Error(`ctx.run("${name}"): cycle ${[...stack, key].join(' → ')}`);
    const ref: CommandRef = { author: resolved.meta.author, name: resolved.meta.name, version: resolved.version };
    const factory = this.factory(ref, resolved.source);
    const exports = await factory(buildScope(order));
    if (typeof exports.default !== 'function') throw new Error(`ctx.run("${name}"): it has no default function`);
    const manifest = validateManifest(exports.manifest);
    const tokens = Object.entries(rawArgs ?? {}).map(([k, v]) => `${k}=${String(v)}`);
    const args = parseArgs(manifest, tokens);
    if (opts?.bots !== undefined && !Array.isArray(opts.bots)) throw new TypeError(`ctx.run("${name}"): opts.bots must be an array of bots`);
    if (opts?.until !== undefined && typeof opts.until !== 'function') throw new TypeError(`ctx.run("${name}"): opts.until must be a function`);
    const squad = await Squad.view(parent, { bots: opts?.bots ?? parent.bots, manifest, name: resolved.meta.name });
    const commander = subCommander(order, squad.signal);
    const ctx = { ...buildCtx(order, args, (n, a, o) => this.runSub(order, squad, [...stack, key], n, a, o), commander), signal: squad.signal };
    let poll: ReturnType<typeof setInterval> | undefined;
    let endedOutside = false;
    const end = (): void => {
      endedOutside = true;
      void squad.dispose();
    };
    if (opts?.until) {
      const until = opts.until;
      poll = setInterval(() => {
        try {
          if (until()) end();
        } catch (e) {
          order.log(`ctx.run("${name}") until: ${errorMessage(e)}`);
          end();
        }
      }, 100);
    }
    opts?.signal?.addEventListener?.('abort', end, { once: true });
    try {
      const value = await (exports.default as (s: Squad, a: unknown, c: unknown) => unknown)(squad, args, ctx);
      return endedOutside ? undefined : value;
    } catch (e) {
      // Ended from outside (until, signal): what its loops threw on the way out is not a failure.
      if (squad.stopped && order.alive && (isStopped(e) || isBotLeft(e))) return undefined;
      throw e;
    } finally {
      if (poll) clearInterval(poll);
      opts?.signal?.removeEventListener?.('abort', end);
      await squad.dispose();
    }
  }

  private execute(order: Order, fn: (...a: unknown[]) => unknown, args: Record<string, unknown>): void {
    const squad = new Squad(order, this.squadDeps(order));
    const rootKey = `${order.command.author.uuid}/${order.command.name}`;
    const ctx = buildCtx(order, args, (n, a, o) => this.runSub(order, squad, [rootKey], n, a, o));
    void (async () => {
      try {
        const result = await fn(squad, args, ctx);
        await order.complete(result);
      } catch (e) {
        if (order.ended || isStopped(e)) return;
        await order.fail(e);
      }
    })();
  }

  /** Stop orders. `target`: 'all' (admin: every order; else the player's own), '#id', a command name, or '@bot'. */
  async stop(by: Player, admin: boolean, target: string): Promise<string> {
    const t = target.trim();
    if (t.startsWith('@')) {
      const name = this.deps.roster.canonical(t.slice(1));
      if (!name) return `[Bots] Bot inconnu : ${t.slice(1)}`;
      if (!admin && !this.deps.roster.isOwner(name, by.uuid)) return `[Bots] ${name} n'est pas à toi.`;
      const top = this.deps.leases.top(name);
      if (!top) return `[Bots] ${name} ne fait rien.`;
      const back = await this.deps.leases.drop(name, 'released', by.name);
      this.emit('state');
      return back ? `[Bots] ${name} libéré ; il retourne à l'ordre #${back}.` : `[Bots] ${name} libéré.`;
    }
    let victims: Order[];
    if (t === 'all') victims = admin ? this.running() : this.running().filter((o) => o.commander.uuid === by.uuid);
    else if (t.startsWith('#')) {
      const o = this.orders.get(t.slice(1));
      if (!o || o.ended) return `[Bots] Pas d'ordre en cours ${t}.`;
      const mine = o.commander.uuid === by.uuid || o.memberNames().some((n) => this.deps.roster.isOwner(n, by.uuid));
      if (!admin && !mine) return `[Bots] L'ordre ${t} ne concerne pas tes bots.`;
      victims = [o];
    } else if (t === '') victims = this.running().filter((o) => o.commander.uuid === by.uuid);
    else victims = this.running().filter((o) => o.command.name === t.toLowerCase() && (admin || o.commander.uuid === by.uuid));
    victims = victims.filter((o) => !o.trial || admin);
    if (victims.length === 0) return '[Bots] Aucun ordre à arrêter.';
    await Promise.all(victims.map((o) => o.stop('stopped', `stopped by ${by.name}`)));
    return `[Bots] Arrêté : ${victims.map((o) => `#${o.id} « ${o.command.name} »`).join(', ')}.`;
  }

  /** A bot died, disconnected or was despawned: its order loses it. */
  async botGone(name: string, reason: 'died' | 'disconnected' | 'despawned'): Promise<void> {
    await this.deps.leases.drop(name, reason);
    this.emit('state');
  }

  async stopAll(why: 'interrupted' | 'stopped' = 'stopped'): Promise<void> {
    await Promise.all(this.running().map((o) => o.stop(why, why === 'interrupted' ? 'runtime shutting down' : 'stopped')));
  }

  // -- internals -------------------------------------------------------------------------------------------------

  /**
   * Who an order's scripts must never target (`isFriend`): its commander, the co-owners of its bots, and every
   * roster bot sharing an owner with them. The same team as the server's friendly-fire rule (SquadFriends: a bot
   * never hurts a bot sharing an owner with it, nor its own owners). It used to be every roster bot, and then two
   * players' armies could never fight. Rebuilt in place, because the scope's isFriend and ctx.friends hold this Set.
   */
  refreshFriends(order: Order): void {
    const team = new Set<string>([order.commander.uuid]);
    const names = new Set<string>([order.commander.name]);
    for (const n of order.memberNames()) {
      for (const o of this.deps.roster.get(n)?.owners ?? []) {
        team.add(o.uuid);
        names.add(o.name);
      }
    }
    for (const b of this.deps.roster.all()) if (b.owners.some((o) => team.has(o.uuid))) names.add(b.name);
    order.friends.clear();
    for (const n of names) order.friends.add(n);
  }

  private newOrder(ref: CommandRef, commander: Player, snap: Snapshot, trial: boolean): Order {
    const id = String(this.nextId++);
    const filename = trial
      ? `squad:${ref.author.name}/${ref.name}@trial-${id}.mjs`
      : `squad:${ref.author.name}/${ref.name}@v${ref.version}.mjs`;
    const deps: OrderDeps = {
      leases: this.deps.leases,
      claims: this.deps.claims,
      bot: (n) => this.deps.pool.bot(n),
      movements: (n) => this.deps.pool.movements(n),
      facts: (n) => this.facts(n),
      describe: (id2) => this.describe(id2),
      notify: (n) => this.emit('notice', n),
      ended: (o) => this.onEnded(o),
    };
    const order = new Order({ id, command: ref, commander, snap, args: {}, trial, limitMs: 60_000, friends: new Set<string>(), filename }, deps);
    this.orders.set(id, order);
    return order;
  }

  private factory(ref: CommandRef, source: string): CommandFactory {
    const key = `${ref.author.uuid}/${ref.name}@v${ref.version}`;
    let f = this.compiled.get(key);
    if (!f) {
      f = compile(source, `squad:${ref.author.name}/${ref.name}@v${ref.version}.mjs`);
      this.compiled.set(key, f);
    }
    return f;
  }

  private async load(order: Order, factory: CommandFactory): Promise<{ fn: (...a: unknown[]) => unknown; manifest: Manifest }> {
    const exports = await factory(buildScope(order));
    const manifest = validateManifest(exports.manifest);
    if (typeof exports.default !== 'function') throw new ManifestError('the command has no `export default async function (squad, args, ctx)`');
    return { fn: exports.default as (...a: unknown[]) => unknown, manifest };
  }

  /** An order that never started: forget it (it is not journaled). */
  private async abandon(order: Order): Promise<void> {
    this.orders.delete(order.id);
    if (order.status === 'starting') {
      order.status = 'stopped';
      order.controller.abort();
    }
  }

  private roleRequests(m: Manifest, take?: Take): RoleRequest[] {
    return Object.entries(m.roles).map(([name, r]) => ({
      name,
      min: r.min,
      max: r.max,
      take: take ?? r.take,
      matches: (bot: string) => {
        const f = this.facts(bot);
        return !!f && matches(r.select, f);
      },
    }));
  }

  private limitMs(m: Manifest): number {
    const l = this.deps.limits;
    const minutes = m.duration === 'until-stopped' ? l.maxStandingMinutes : Math.min(m.maxMinutes ?? l.orderMinutes, l.maxOrderMinutes);
    return Math.max(1_000, minutes * 60_000);
  }

  private squadDeps(order: Order): ConstructorParameters<typeof Squad>[1] {
    return {
      claims: this.deps.claims,
      candidates: () => this.candidates(order.commander.uuid, [], order.squad),
      facts: (n) => this.facts(n),
    };
  }

  private idleOf(uuid: string): string[] {
    return this.candidates(uuid).filter((n) => this.deps.leases.isIdle(n));
  }

  private offlineHint(uuid: string, squad?: string): string {
    const offline = this.deps.roster
      .botsOf(uuid)
      .filter((b) => !squad || b.tags.includes(squad))
      .map((b) => b.name)
      .filter((n) => !this.deps.pool.bot(n));
    return offline.length ? ` Hors ligne : ${offline.join(', ')}.` : '';
  }

  private fixClick(commander: Player, ref: CommandRef): Notice['click'] | undefined {
    if (ref.author.uuid !== commander.uuid || ref.author.uuid === STOCK_AUTHOR.uuid) return undefined;
    return { label: '[Corriger]', command: `/bots fix ${ref.name} ` };
  }

  private onEnded(order: Order): void {
    if (!order.trial) this.deps.journal.save(order.report);
    setTimeout(() => this.orders.delete(order.id), 60_000).unref(); // keep it a minute for /bots orders and reclaim notices
    this.emit('state');
    if (order.trial || order.silentEnd) return;
    const r = order.report;
    const name = order.command.name;
    let text: string;
    let click: Notice['click'] | undefined;
    switch (r.status) {
      case 'done':
        text = r.result ? `« ${name} » terminé : ${r.result}` : `« ${name} » terminé.`;
        break;
      case 'failed':
        text = `« ${name} » a échoué : ${firstLine(r.error?.message ?? 'erreur inconnue')}${r.error?.line ? ` (ligne ${r.error.line})` : ''}`;
        click = this.fixClick(order.commander, order.command);
        break;
      case 'timeout':
        text = `« ${name} » arrêté : limite de ${Math.round(order.limitMs / 60000)} min atteinte.`;
        break;
      case 'interrupted':
        text = `« ${name} » interrompu (le runtime s'arrête).`;
        break;
      default:
        text = `« ${name} » arrêté.`;
    }
    this.emit('notice', { to: [order.commander.uuid], text: `[Bots] ${text}`, ...(click ? { click } : {}) } satisfies Notice);
  }
}

function describeBots(bots: Array<{ name: string; role: string; from?: string }>, m: Manifest): string {
  const showRole = Object.keys(m.roles).length > 1 || !m.roles.all;
  return bots
    .map((b) => `${b.name}${showRole ? ` (${b.role})` : ''}${b.from ? ` réquisitionné de #${b.from}` : ''}`)
    .join(', ');
}

/**
 * Whether a click carries the running order's own line: the same args (parsed against its manifest, so `spacing=2`
 * equals the default 2), @bot filters and take. A rebind with other args (`spacing=1`) used to be delivered with the
 * old ones (#221 → #223); it restarts the order now (docs/35 F5).
 */
function sameLine(o: Order, req: TriggerRequest): boolean {
  if (!o.manifest) return true;
  let args: Record<string, unknown>;
  try {
    args = parseArgs(o.manifest, req.tokens);
  } catch {
    return false; // the restart answers with the usage line
  }
  const sorted = (a: Record<string, unknown>): string => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]]));
  const names = (f: string[] | undefined): string => (f ?? []).map((n) => n.toLowerCase()).sort().join(',');
  return sorted(args) === sorted(o.args) && names(req.filters) === names(o.filters) && (req.take ?? null) === (o.take ?? null);
}

/** A canonical binding (`name`, `author:name`, `squad:name`) names this order's command, whatever the share rights. */
function refMatches(o: Order, ref: string): boolean {
  const r = ref.trim().toLowerCase();
  const colon = r.indexOf(':');
  const name = colon > 0 ? r.slice(colon + 1) : r;
  if (o.command.name !== name) return false;
  if (colon <= 0) return true;
  const owner = r.slice(0, colon);
  return owner === STOCK_AUTHOR.name ? o.command.author.uuid === STOCK_AUTHOR.uuid : o.command.author.name.toLowerCase() === owner;
}

function firstLine(e: unknown): string {
  const msg = e instanceof CompileError && e.line ? `${e.message} (ligne ${e.line})` : e instanceof StoreError ? e.message : errorMessage(e);
  return msg.split('\n')[0]?.slice(0, 300) ?? '';
}
