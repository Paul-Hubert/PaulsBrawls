import fs from 'fs';
import path from 'path';
import type { Bot } from 'mineflayer';
import minecraftData from 'minecraft-data';
import { log } from '../logger.js';
import type { Persistence } from './persistence.js';
import { BotStats, emptyBotStats } from './types.js';

/**
 * Food-production benchmark (the village simulator's score).
 *
 * "How much food can the village get": on every scan tick each bot's inventory
 * is diffed against the previous tick, and POSITIVE deltas of edible items
 * (harvests, craft outputs, pickups) are credited to a monotonic per-bot
 * counter. Negative deltas (eating, depositing, dropping, dying) are ignored.
 * Two corrections keep the counter honest:
 *
 *  - chest withdrawals re-enter the inventory without being production — the
 *    withdrawn count becomes an "absorb debt" that eats the next positive
 *    delta for that item instead of crediting it;
 *  - on death the last-known food snapshot becomes the same kind of debt, so
 *    re-collecting your own dropped items after respawn doesn't double-count.
 *
 * Known double-count (accepted, documented): cooking/crafting chains where
 * both input and output are edible (potato → baked_potato). Raw wheat is not
 * edible, so the main farm chain (wheat → bread) counts bread only.
 *
 * Module-level singleton, like the logger: actions.ts / bot-host.ts /
 * admin-server.ts reach it without threading it through VillageContext.
 * Unconfigured (tests, unified entrypoint) it still counts in memory but
 * persists nothing and writes no sample file.
 */

/** Items mcData calls "food" but that no sane villager counts as a meal. */
const EXCLUDED_FOODS: ReadonlySet<string> = new Set([
  'rotten_flesh', 'pufferfish', 'chorus_fruit', 'poisonous_potato', 'spider_eye',
]);

/** Re-collected death drops / chest withdrawals stop being absorbed after this. */
const DEBT_TTL_MS = 10 * 60_000;
const SAMPLE_INTERVAL_MS = 60_000;
/** Every Nth sample also goes to the human-readable log. */
const SAMPLES_PER_LOG_LINE = 5;

interface AbsorbDebt {
  items: Map<string, number>;
  at: number;
}

export class BenchmarkTracker {
  private persistence: Persistence | null = null;
  private samplePath: string | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private sampleCount = 0;
  private startedAt = Date.now();

  private readonly stats = new Map<string, BotStats>();
  private readonly prevFood = new Map<string, Map<string, number>>();
  private readonly lastStock = new Map<string, Map<string, number>>();
  private readonly debts = new Map<string, AbsorbDebt>();
  private readonly foodCache = new Map<string, Set<string> | null>();

  configure(persistence: Persistence, samplePath: string): string {
    this.persistence = persistence;
    this.startedAt = Date.now();
    fs.mkdirSync(path.dirname(samplePath), { recursive: true });
    this.samplePath = path.resolve(samplePath);
    this.sampleTimer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    this.sampleTimer.unref?.();
    return this.samplePath;
  }

  stop(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this.sample();
  }

  /** Inventory diff on the shared scan tick. Pure reads — never throws. */
  tick(name: string, bot: Bot): void {
    const foods = this.foodNames(bot);
    if (!foods) return;
    let current: Map<string, number>;
    try {
      current = this.snapshot(bot, foods);
    } catch {
      return;
    }
    const prev = this.prevFood.get(name);
    this.prevFood.set(name, current);
    this.lastStock.set(name, current);
    if (!prev) return; // first sight of this bot (boot or post-death) = baseline only

    const debt = this.liveDebt(name);
    for (const [item, count] of current) {
      let delta = count - (prev.get(item) ?? 0);
      if (delta <= 0) continue;
      if (debt) {
        const owed = debt.items.get(item) ?? 0;
        if (owed > 0) {
          const absorbed = Math.min(owed, delta);
          debt.items.set(item, owed - absorbed);
          delta -= absorbed;
        }
      }
      if (delta > 0) this.credit(name, item, delta);
    }
  }

  /** Death drops re-collected after respawn must not count twice. */
  onDeath(name: string): void {
    const prev = this.prevFood.get(name);
    if (prev && prev.size > 0) {
      const debt = this.debtFor(name);
      for (const [item, count] of prev) {
        debt.items.set(item, (debt.items.get(item) ?? 0) + count);
      }
      debt.at = Date.now();
    }
    this.prevFood.delete(name);
    const stats = this.statsFor(name);
    stats.deaths += 1;
    this.persist(name, stats);
  }

  /** Called from actions.depositToChest — covers tool AND sandbox call sites. */
  onDeposit(name: string, item: string, count: number, bot: Bot): void {
    if (!this.isFood(bot, item)) return;
    const stats = this.statsFor(name);
    stats.foodDeposited += count;
    this.persist(name, stats);
  }

  /** Withdrawn food re-enters the inventory but is not production. */
  onWithdraw(name: string, item: string, count: number, bot: Bot): void {
    if (!this.isFood(bot, item)) return;
    const stats = this.statsFor(name);
    stats.foodWithdrawn += count;
    const debt = this.debtFor(name);
    debt.items.set(item, (debt.items.get(item) ?? 0) + count);
    debt.at = Date.now();
    this.persist(name, stats);
  }

  metrics(): {
    sampleFile: string | null;
    uptimeSeconds: number;
    village: {
      foodAcquired: number;
      foodDeposited: number;
      foodWithdrawn: number;
      chestFoodEstimate: number;
      foodHeld: number;
      deaths: number;
    };
    bots: Record<string, BotStats & { foodHeld: number }>;
  } {
    const bots: Record<string, BotStats & { foodHeld: number }> = {};
    const village = { foodAcquired: 0, foodDeposited: 0, foodWithdrawn: 0, chestFoodEstimate: 0, foodHeld: 0, deaths: 0 };
    for (const [name, stats] of this.stats) {
      const held = Array.from(this.lastStock.get(name)?.values() ?? []).reduce((s, c) => s + c, 0);
      bots[name] = { ...stats, perItem: { ...stats.perItem }, foodHeld: held };
      village.foodAcquired += stats.foodAcquired;
      village.foodDeposited += stats.foodDeposited;
      village.foodWithdrawn += stats.foodWithdrawn;
      village.deaths += stats.deaths;
      village.foodHeld += held;
    }
    village.chestFoodEstimate = Math.max(0, village.foodDeposited - village.foodWithdrawn);
    return {
      sampleFile: this.samplePath,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      village,
      bots,
    };
  }

  /** One JSONL line per minute — the benchmark's time series. */
  private sample(): void {
    if (!this.samplePath) return;
    const m = this.metrics();
    try {
      fs.appendFileSync(this.samplePath, `${JSON.stringify({ t: new Date().toISOString(), ...m })}\n`);
    } catch {
      /* best-effort — never take the village down over a metrics write */
    }
    this.sampleCount += 1;
    if (this.sampleCount % SAMPLES_PER_LOG_LINE === 1) {
      const v = m.village;
      log('info', `[village] benchmark: ${v.foodAcquired} food acquired (held ${v.foodHeld}, chest ~${v.chestFoodEstimate}, deaths ${v.deaths})`);
    }
  }

  // -- internals --------------------------------------------------------------

  private statsFor(name: string): BotStats {
    let stats = this.stats.get(name);
    if (!stats) {
      const persisted = this.persistence?.botState(name).stats;
      stats = persisted ?? emptyBotStats();
      this.stats.set(name, stats);
    }
    return stats;
  }

  private credit(name: string, item: string, count: number): void {
    const stats = this.statsFor(name);
    stats.foodAcquired += count;
    stats.perItem[item] = (stats.perItem[item] ?? 0) + count;
    this.persist(name, stats);
  }

  private persist(name: string, stats: BotStats): void {
    if (!this.persistence) return;
    this.persistence.botState(name).stats = stats;
    this.persistence.markDirty(name);
  }

  private debtFor(name: string): AbsorbDebt {
    let debt = this.debts.get(name);
    if (!debt) {
      debt = { items: new Map(), at: Date.now() };
      this.debts.set(name, debt);
    }
    return debt;
  }

  private liveDebt(name: string): AbsorbDebt | null {
    const debt = this.debts.get(name);
    if (!debt) return null;
    if (Date.now() - debt.at > DEBT_TTL_MS) {
      this.debts.delete(name);
      return null;
    }
    return debt;
  }

  private snapshot(bot: Bot, foods: ReadonlySet<string>): Map<string, number> {
    const current = new Map<string, number>();
    for (const it of bot.inventory.items()) {
      if (foods.has(it.name)) current.set(it.name, (current.get(it.name) ?? 0) + it.count);
    }
    return current;
  }

  private isFood(bot: Bot, item: string): boolean {
    return this.foodNames(bot)?.has(item) ?? false;
  }

  private foodNames(bot: Bot): Set<string> | null {
    const version = bot.version;
    if (!this.foodCache.has(version)) {
      try {
        const names = Object.keys(minecraftData(version).foodsByName ?? {})
          .filter((n) => !EXCLUDED_FOODS.has(n));
        this.foodCache.set(version, new Set(names));
      } catch {
        // Registry hiccup (modded version string?) — disable for this version
        // rather than risk throwing inside the scan tick.
        this.foodCache.set(version, null);
      }
    }
    return this.foodCache.get(version) ?? null;
  }
}

export const benchmark = new BenchmarkTracker();
