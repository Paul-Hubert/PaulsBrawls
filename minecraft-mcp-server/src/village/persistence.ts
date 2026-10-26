import fs from 'fs';
import path from 'path';
import { log } from '../logger.js';
import { normalizeKeyword } from './memory-index.js';
import { AnchorOverrides, BotNeeds, BotStats, DayPlan, LedgerEntry, MemoryEntry, RelationEntry, Skill, emptyBotStats } from './types.js';

/**
 * JSON-file persistence. One file per bot (`<dataDir>/bots/<name>.json`) plus a
 * shared trade ledger (`<dataDir>/ledger.json`).
 *
 * Deliberate deviation from VILLAGE_PLAN §D9: plain JSON instead of
 * better-sqlite3, to keep `npm install` free of native modules on Windows.
 * Data volumes here are tiny (10 bots × a few hundred entries); the interface
 * is narrow enough that a SQLite backend can be swapped in later without
 * touching callers.
 *
 * Writes are atomic (tmp file + rename) and debounced per file so a chatty
 * night of trading doesn't thrash the disk.
 */

export interface BotState {
  skills: Skill[];
  memories: MemoryEntry[];
  /** Rolling summary of evicted memories — the bot's "life story so far". */
  memorySummary: string;
  relations: Record<string, RelationEntry>;
  /** Entries evicted from the window, oldest-first, keyword-searchable. */
  archive: MemoryEntry[];
  /** How many archive-tail entries have not yet been folded into memorySummary. */
  archivePendingSummarization: number;
  /** Daily rhythm (M11): drive levels, current mood, today's schedule. */
  needs: BotNeeds;
  mood: string;
  dayPlan: DayPlan | null;
  /** Discovered corrections to the roster's home/chest coordinates. */
  anchors: AnchorOverrides;
  /** Food-production benchmark counters (benchmark.ts). */
  stats: BotStats;
}

const EMPTY_BOT_STATE: BotState = {
  skills: [],
  memories: [],
  memorySummary: '',
  relations: {},
  archive: [],
  archivePendingSummarization: 0,
  needs: { rest: 1, social: 1 },
  mood: '',
  dayPlan: null,
  anchors: {},
  stats: emptyBotStats(),
};

const FLUSH_DELAY_MS = 2_000;

export class Persistence {
  private readonly dir: string;
  private readonly botStates = new Map<string, BotState>();
  private ledger: LedgerEntry[] = [];
  private readonly dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    this.dir = dataDir;
    fs.mkdirSync(path.join(this.dir, 'bots'), { recursive: true });
    this.ledger = this.readJson<LedgerEntry[]>(this.ledgerPath()) ?? [];
  }

  // -- bot state ------------------------------------------------------------

  botState(name: string): BotState {
    let state = this.botStates.get(name);
    if (!state) {
      state = this.readJson<BotState>(this.botPath(name)) ?? structuredClone(EMPTY_BOT_STATE);
      // Defensive defaults for files written by older versions.
      state.skills ??= [];
      state.memories ??= [];
      state.memorySummary ??= '';
      state.relations ??= {};
      state.archive ??= [];
      state.archivePendingSummarization ??= 0;
      state.archivePendingSummarization = Math.min(state.archivePendingSummarization, state.archive.length);
      state.needs ??= { rest: 1, social: 1 };
      state.mood ??= '';
      state.dayPlan ??= null;
      state.anchors ??= {};
      state.stats ??= emptyBotStats();
      this.botStates.set(name, state);
    }
    return state;
  }

  markDirty(botName: string): void {
    this.dirty.add(botName);
    this.scheduleFlush();
  }

  // -- ledger ---------------------------------------------------------------

  appendLedger(entry: LedgerEntry): void {
    this.ledger.push(entry);
    if (this.ledger.length > 2_000) this.ledger.splice(0, this.ledger.length - 2_000);
    this.dirty.add('::ledger');
    this.scheduleFlush();
  }

  recentLedger(limit: number): LedgerEntry[] {
    return this.ledger.slice(-limit);
  }

  ledgerFor(botName: string, limit: number): LedgerEntry[] {
    return this.ledger.filter((e) => e.a === botName || e.b === botName).slice(-limit);
  }

  /**
   * Keyword search over this bot's trades: party names + item ids, normalized
   * the same way as memory tags. Linear scan — the ledger is capped at 2k.
   */
  searchLedger(botName: string, keywords: string[], limit = 5): LedgerEntry[] {
    const wanted = new Set(keywords.map(normalizeKeyword));
    const scored: Array<[LedgerEntry, number]> = [];
    for (const entry of this.ledger) {
      if (entry.a !== botName && entry.b !== botName) continue;
      const tags = new Set<string>([
        normalizeKeyword(entry.a),
        normalizeKeyword(entry.b),
        ...entry.aGave.map((s) => normalizeKeyword(s.item)),
        ...entry.bGave.map((s) => normalizeKeyword(s.item)),
      ]);
      let score = 0;
      for (const kw of wanted) if (tags.has(kw)) score++;
      if (score > 0) scored.push([entry, score]);
    }
    return scored
      .sort((a, b) => b[1] - a[1] || b[0].at - a[0].at)
      .slice(0, limit)
      .map(([entry]) => entry);
  }

  // -- flushing -------------------------------------------------------------

  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const key of this.dirty) {
      try {
        if (key === '::ledger') {
          this.writeJsonAtomic(this.ledgerPath(), this.ledger);
        } else {
          const state = this.botStates.get(key);
          if (state) this.writeJsonAtomic(this.botPath(key), state);
        }
      } catch (err) {
        log('warn', `village persistence flush failed for ${key}: ${String(err)}`);
      }
    }
    this.dirty.clear();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, FLUSH_DELAY_MS);
    // Don't keep the process alive just to flush — shutdown calls flushNow().
    this.flushTimer.unref?.();
  }

  // -- io helpers -----------------------------------------------------------

  private botPath(name: string): string {
    // Roster names are Minecraft usernames ([A-Za-z0-9_]) so they're filesystem-safe,
    // but sanitize anyway.
    const safe = name.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.dir, 'bots', `${safe}.json`);
  }

  private ledgerPath(): string {
    return path.join(this.dir, 'ledger.json');
  }

  private readJson<T>(file: string): T | null {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch (err) {
      log('warn', `village persistence read failed for ${file}: ${String(err)}`);
      return null;
    }
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  }
}
