// Lease stacks (docs/29 §6). Each bot has a stack of the orders holding it; the TOP one drives the body, the ones
// below are orders it was reclaimed from that are still running (it returns to them when the top lets go). Stacks
// only ever hold live orders. Pure bookkeeping: what happens to a body (the abort sequence, a guarded proxy going
// dead) is the order's business, through the LeaseHolder callbacks.

export type LeftReason = 'reclaimed' | 'released' | 'died' | 'disconnected' | 'despawned';
export type Take = 'free' | 'reclaim';

/** An order as the lease manager sees it. */
export interface LeaseHolder {
  readonly id: string;
  /** The bot is no longer this order's (it is the top lease that left). Awaited before the bot is reused. */
  onLeft(bot: string, reason: LeftReason, by?: string): Promise<void> | void;
  /** A bot this order lost to a reclaim came back, in its old role. */
  onJoined(bot: string, role: string): void;
}

export interface RoleRequest {
  name: string;
  min: number;
  max: number;
  take: Take;
  matches: (bot: string) => boolean;
}

export interface Grant {
  bot: string;
  role: string;
  /** The order it is reclaimed from, when busy. */
  from?: string;
}

export type Plan = { ok: true; grants: Grant[] } | { ok: false; shortfall: Array<{ role: string; got: number; min: number }> };

interface Entry {
  orderId: string;
  role: string;
}

export class LeaseManager {
  private readonly stacks = new Map<string, Entry[]>();
  private readonly holders = new Map<string, LeaseHolder>();
  private readonly lastGranted = new Map<string, number>();
  private clock = 0;

  constructor(private readonly maxDepth = 4) {}

  register(holder: LeaseHolder): void {
    this.holders.set(holder.id, holder);
  }

  /** The order driving the bot, or undefined when idle. */
  top(bot: string): { orderId: string; role: string } | undefined {
    const s = this.stacks.get(bot);
    const e = s?.[s.length - 1];
    return e ? { ...e } : undefined;
  }

  holds(orderId: string, bot: string): boolean {
    return this.top(bot)?.orderId === orderId;
  }

  isIdle(bot: string): boolean {
    return (this.stacks.get(bot)?.length ?? 0) === 0;
  }

  /** Bots whose top lease is this order. */
  botsOf(orderId: string): string[] {
    const out: string[] = [];
    for (const [bot, s] of this.stacks) if (s[s.length - 1]?.orderId === orderId) out.push(bot);
    return out;
  }

  /** The whole stack (bottom first), for /bots list and reports. */
  stack(bot: string): Array<{ orderId: string; role: string }> {
    return (this.stacks.get(bot) ?? []).map((e) => ({ ...e }));
  }

  /**
   * §6.2: for each role in order, the candidates that match, idle ones first, then (when the role's take is
   * `reclaim`) busy ones, least recently granted first. A bot goes to the first role that takes it. Nothing is
   * changed: the plan is all or nothing, applied with {@link apply}.
   */
  plan(orderId: string, roles: RoleRequest[], candidates: string[], exclude: Iterable<string> = []): Plan {
    const taken = new Set(exclude);
    const grants: Grant[] = [];
    const shortfall: Array<{ role: string; got: number; min: number }> = [];
    for (const role of roles) {
      const pool = candidates.filter((b) => !taken.has(b) && !this.holds(orderId, b) && role.matches(b));
      const idle = pool.filter((b) => this.isIdle(b));
      const busy = role.take === 'reclaim'
        ? pool.filter((b) => !this.isIdle(b)).sort((a, b) => (this.lastGranted.get(a) ?? 0) - (this.lastGranted.get(b) ?? 0))
        : [];
      const chosen = [...idle, ...busy].slice(0, Math.max(0, role.max));
      for (const bot of chosen) {
        taken.add(bot);
        const from = this.top(bot)?.orderId;
        grants.push(from ? { bot, role: role.name, from } : { bot, role: role.name });
      }
      if (chosen.length < role.min) shortfall.push({ role: role.name, got: chosen.length, min: role.min });
    }
    return shortfall.length > 0 ? { ok: false, shortfall } : { ok: true, grants };
  }

  /** Apply a plan: busy bots leave their order first (awaited: their abort sequence runs), then are pushed. */
  async apply(orderId: string, grants: Grant[]): Promise<void> {
    const leaving: Array<Promise<void> | void> = [];
    for (const g of grants) {
      const top = this.top(g.bot);
      if (top && top.orderId !== orderId) {
        const holder = this.holders.get(top.orderId);
        if (holder) leaving.push(safe(() => holder.onLeft(g.bot, 'reclaimed', orderId)));
      }
    }
    await Promise.all(leaving);
    for (const g of grants) {
      const s = this.stacks.get(g.bot) ?? [];
      s.push({ orderId, role: g.role });
      while (s.length > this.maxDepth) s.shift(); // the bottom order will not get it back
      this.stacks.set(g.bot, s);
      this.lastGranted.set(g.bot, ++this.clock);
    }
  }

  /**
   * The order lets go of a bot (squad.release, end of order, the order's own cleanup is done). When it was the
   * top lease, the bot returns to the next live order below; otherwise its buried entry just disappears.
   * Returns the order the bot returned to, if any.
   */
  release(orderId: string, bot: string): string | undefined {
    const s = this.stacks.get(bot);
    if (!s) return undefined;
    const wasTop = s[s.length - 1]?.orderId === orderId;
    const rest = s.filter((e) => e.orderId !== orderId);
    if (!wasTop) {
      this.setStack(bot, rest);
      return undefined;
    }
    // Drop entries of orders that are gone until a live one (or none) is on top.
    let stack = rest;
    for (;;) {
      this.setStack(bot, stack);
      const below = stack[stack.length - 1];
      if (!below) return undefined;
      const holder = this.holders.get(below.orderId);
      if (holder) {
        holder.onJoined(bot, below.role);
        return below.orderId;
      }
      stack = stack.slice(0, -1);
    }
  }

  /** An order ended: forget it everywhere. Returns the bots it still drove (the caller cleans them up). */
  endOrder(orderId: string): string[] {
    this.holders.delete(orderId);
    for (const [bot, s] of [...this.stacks]) {
      const top = s[s.length - 1];
      const kept = s.filter((e) => e === top || e.orderId !== orderId); // buried entries go now
      if (kept.length !== s.length) this.setStack(bot, kept);
    }
    return this.botsOf(orderId);
  }

  /**
   * The bot is gone (died, disconnected, despawned) or an owner freed it (`released`): the top order loses it.
   * For a death or a disconnect the whole stack is cleared (the bot comes back idle, §4); a `released` bot
   * returns to the order below it.
   */
  async drop(bot: string, reason: LeftReason, by?: string): Promise<string | undefined> {
    const top = this.top(bot);
    if (!top) return undefined;
    const holder = this.holders.get(top.orderId);
    if (holder) await safe(() => holder.onLeft(bot, reason, by));
    if (reason === 'released') return this.release(top.orderId, bot);
    this.stacks.delete(bot);
    return undefined;
  }

  private setStack(bot: string, s: Entry[]): void {
    if (s.length === 0) this.stacks.delete(bot);
    else this.stacks.set(bot, s);
  }
}

async function safe(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch {
    /* a holder's cleanup failing must not block the reclaim */
  }
}
