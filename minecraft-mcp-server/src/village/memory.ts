import { logDebug } from '../logger.js';
import { dot, MemoryVectors } from './embeddings.js';
import { MAX_TAGS_PER_ENTRY, MemoryIndex, normalizeKeyword, tagsFor, tokenize } from './memory-index.js';
import { BotState, Persistence } from './persistence.js';
import { BotNeeds, DayPlan, MemoryEntry } from './types.js';

/**
 * Per-bot episodic memory + relationships, backed by {@link Persistence}.
 *
 * The window keeps the last {@link MAX_ENTRIES}; older entries are evicted
 * into the persisted archive (capped at {@link ARCHIVE_MAX}), where they stay
 * keyword-searchable via {@link recall}. The archive tail that hasn't been
 * folded into `memorySummary` yet is tracked by a persisted counter, so a
 * restart before the AgentRuntime's summarization pass loses nothing.
 *
 * {@link retrieve} is the ranked path (M10): relevance (semantic cosine when
 * vectors exist, keyword overlap otherwise) blended with recency decay and
 * importance — the Generative-Agents triple. Without a {@link MemoryVectors}
 * it degrades to keyword relevance and stays fully deterministic.
 */

const MAX_ENTRIES = 200;
/** When the window overflows, this many oldest entries move to the archive. */
const EVICT_BATCH = 80;
const ARCHIVE_MAX = 2_000;

/** Marks a stored conclusion as "X is blocked/impossible" — bilingual because
 *  the bots think in French over English tool output. */
const BLOCKED_BELIEF_RE = /impossible|cannot|can't|ne\s+(?:peux|puis|peut)\s+pas|pas\s+possible|bloqu|fail|échou|need\s+.*\s+first|besoin\s+d/i;

/** Write-time salience heuristic by kind (0–10), overridable per append. */
export const DEFAULT_IMPORTANCE: Record<MemoryEntry['kind'], number> = {
  trade: 6,
  social: 5,
  event: 4,
  thought: 4,
  system: 2,
};

/** Retrieval scoring knobs — exported so tests pin the math. */
export const RETRIEVAL = {
  /** score = REL*relevance + REC*recency + IMP*importance/10 */
  RELEVANCE_WEIGHT: 0.5,
  RECENCY_WEIGHT: 0.25,
  IMPORTANCE_WEIGHT: 0.25,
  /** Entries below this relevance never surface, however recent/important. */
  MIN_RELEVANCE: 0.3,
  /** Recency halves every 2 h of wall clock (≈ 6 Minecraft days). */
  HALF_LIFE_MS: 2 * 60 * 60 * 1_000,
  /** One matched keyword = 0.5 relevance, two or more = 1. */
  KEYWORD_MATCH_VALUE: 0.5,
} as const;

export interface RecallOptions {
  kind?: MemoryEntry['kind'];
  limit?: number;
}

export interface RetrieveOptions {
  kind?: MemoryEntry['kind'];
  limit?: number;
  /** Already-shown entries (e.g. the RECENT MEMORIES block) to skip. */
  exclude?: ReadonlySet<MemoryEntry>;
  /** Pre-tokenized keywords; defaults to tokenize(queryText). */
  keywords?: string[];
  /** Injected clock for tests. */
  now?: number;
}

export class BotMemory {
  private readonly botName: string;
  private readonly persistence: Persistence;
  private readonly vectors: MemoryVectors | null;
  /** Inverted index over window + archive; built lazily, never persisted. */
  private index: MemoryIndex | null = null;

  constructor(botName: string, persistence: Persistence, vectors?: MemoryVectors) {
    this.botName = botName;
    this.persistence = persistence;
    this.vectors = vectors ?? null;
    if (this.vectors?.enabled()) {
      const state = this.state();
      // One-time per boot: embed entries written before embeddings existed
      // (or while they were down) and prune sidecar rows for trimmed entries.
      this.vectors.backfill([...state.archive, ...state.memories]);
    }
  }

  private state(): BotState {
    return this.persistence.botState(this.botName);
  }

  /** Build the index from persisted state, tagging old untagged entries in-memory. */
  private ensureIndex(): MemoryIndex {
    if (!this.index) {
      this.index = new MemoryIndex();
      const state = this.state();
      for (const entry of state.archive) this.index.add(entry);
      for (const entry of state.memories) this.index.add(entry);
    }
    return this.index;
  }

  append(kind: MemoryEntry['kind'], text: string, tags?: string[], importance?: number): void {
    const state = this.state();
    const entry: MemoryEntry = {
      at: Date.now(),
      kind,
      text: text.slice(0, 500),
      tags: tagsFor(text, tags),
      importance: clampImportance(importance ?? DEFAULT_IMPORTANCE[kind]),
    };
    state.memories.push(entry);
    this.ensureIndex().add(entry);
    this.vectors?.enqueue(entry);
    logDebug(this.botName, `memory+ [${kind}/${entry.importance}] ${entry.text.slice(0, 140)}`);
    if (state.memories.length > MAX_ENTRIES) {
      const batch = state.memories.splice(0, EVICT_BATCH);
      state.archive.push(...batch);
      state.archivePendingSummarization += batch.length;
      logDebug(this.botName, `memory window full — evicted ${batch.length} entries to the archive (${state.archivePendingSummarization} awaiting summarization)`);
      // Trim the archive head (oldest, already-summarized entries first —
      // the pending tail is far smaller than ARCHIVE_MAX).
      if (state.archive.length > ARCHIVE_MAX) {
        for (const dropped of state.archive.splice(0, state.archive.length - ARCHIVE_MAX)) {
          this.ensureIndex().remove(dropped);
          this.vectors?.remove(dropped);
        }
        state.archivePendingSummarization = Math.min(state.archivePendingSummarization, state.archive.length);
      }
    }
    this.persistence.markDirty(this.botName);
  }

  /**
   * Contradiction retirement (June 2026): an observed SUCCESS refutes stored
   * conclusions that the same subject was impossible. Without this, one bogus
   * tool error becomes a permanent false belief the bot re-recalls forever
   * (seen live: "a crafting table can't be crafted without a crafting table
   * nearby" — written after a craft desync, never revisited). Demotes matching
   * thought/system entries to importance 1 so ranked retrieval stops surfacing
   * them, and writes ONE high-importance refutation so the correction outranks
   * the stale belief if keywords still match it.
   */
  refuteBlockedBeliefs(subject: string, refutation: string): number {
    // Same tokenizer as write-time tagging, so 'crafting_table' matches
    // however tagsFor split it when the belief was stored.
    const keywords = tokenize(subject).map(normalizeKeyword).filter((k) => k.length >= 2);
    if (keywords.length === 0) return 0;
    const kwSet = new Set(keywords);
    const state = this.state();
    let demoted = 0;
    for (const entry of [...state.archive, ...state.memories]) {
      if (entry.kind !== 'thought' && entry.kind !== 'system') continue;
      if ((entry.importance ?? DEFAULT_IMPORTANCE[entry.kind]) <= 1) continue;
      if (!(entry.tags ?? []).some((tag) => kwSet.has(tag))) continue;
      if (!BLOCKED_BELIEF_RE.test(entry.text)) continue;
      entry.importance = 1;
      demoted++;
    }
    if (demoted > 0) {
      this.append('thought', refutation, keywords, 7);
      logDebug(this.botName, `memory: demoted ${demoted} refuted belief(s) about '${subject}'`);
      this.persistence.markDirty(this.botName);
    }
    return demoted;
  }

  /** Raise an entry's salience (summarization pass); never lowers it. */
  bumpImportance(entry: MemoryEntry, atLeast: number): void {
    const target = clampImportance(atLeast);
    if ((entry.importance ?? DEFAULT_IMPORTANCE[entry.kind]) >= target) return;
    entry.importance = target;
    this.persistence.markDirty(this.botName);
  }

  recent(limit: number): MemoryEntry[] {
    return this.state().memories.slice(-limit);
  }

  /** Keyword search over the live window + archive. */
  recall(query: string, opts: RecallOptions = {}): MemoryEntry[] {
    const keywords = tokenize(query);
    if (keywords.length === 0) return [];
    return this.ensureIndex().search(keywords, opts);
  }

  /**
   * Ranked retrieval over window + archive:
   * `score = 0.5·relevance + 0.25·recency + 0.25·importance` where relevance
   * is max(semantic cosine, keyword overlap). Linear scan — the corpus is
   * capped at ~2.2k entries, so brute-force cosine is microseconds.
   */
  async retrieve(queryText: string, opts: RetrieveOptions = {}): Promise<MemoryEntry[]> {
    const limit = opts.limit ?? 6;
    const keywords = (opts.keywords ?? tokenize(queryText)).map(normalizeKeyword);
    const kwSet = new Set(keywords);
    const queryVec = queryText.trim() && this.vectors ? await this.vectors.embedQuery(queryText) : null;
    if (kwSet.size === 0 && !queryVec) return [];

    this.ensureIndex(); // guarantees every entry is tagged (old-format files)
    const state = this.state();
    const now = opts.now ?? Date.now();
    const scored: Array<[MemoryEntry, number]> = [];
    for (const entry of [...state.archive, ...state.memories]) {
      if (opts.exclude?.has(entry)) continue;
      if (opts.kind && entry.kind !== opts.kind) continue;

      let matched = 0;
      for (const tag of entry.tags ?? []) if (kwSet.has(tag)) matched++;
      const keywordRelevance = Math.min(1, matched * RETRIEVAL.KEYWORD_MATCH_VALUE);
      let semanticRelevance = 0;
      if (queryVec) {
        const vec = this.vectors!.vectorFor(entry);
        if (vec) semanticRelevance = Math.max(0, Math.min(1, dot(queryVec, vec)));
      }
      const relevance = Math.max(keywordRelevance, semanticRelevance);
      if (relevance < RETRIEVAL.MIN_RELEVANCE) continue;

      const recency = Math.pow(0.5, Math.max(0, now - entry.at) / RETRIEVAL.HALF_LIFE_MS);
      const importance = clampImportance(entry.importance ?? DEFAULT_IMPORTANCE[entry.kind]) / 10;
      const score =
        RETRIEVAL.RELEVANCE_WEIGHT * relevance +
        RETRIEVAL.RECENCY_WEIGHT * recency +
        RETRIEVAL.IMPORTANCE_WEIGHT * importance;
      scored.push([entry, score]);
    }
    return scored
      .sort((a, b) => b[1] - a[1] || b[0].at - a[0].at)
      .slice(0, limit)
      .map(([entry]) => entry);
  }

  windowSize(): number {
    return this.state().memories.length;
  }

  archiveSize(): number {
    return this.state().archive.length;
  }

  archiveTail(limit: number): MemoryEntry[] {
    return this.state().archive.slice(-limit);
  }

  summary(): string {
    return this.state().memorySummary;
  }

  /** Archived entries not yet folded into the summary. */
  needsSummarization(): boolean {
    return this.state().archivePendingSummarization > 0;
  }

  pendingSummarizationCount(): number {
    return this.state().archivePendingSummarization;
  }

  /**
   * The unsummarized archive tail, as live refs (so tag enrichment lands on
   * the persisted objects). Zeroes the pending counter — the entries stay in
   * the archive whether or not the summarization LLM call succeeds.
   */
  takeSummarizationBatch(): MemoryEntry[] {
    const state = this.state();
    const pending = state.archivePendingSummarization;
    if (pending === 0) return [];
    state.archivePendingSummarization = 0;
    this.persistence.markDirty(this.botName);
    return state.archive.slice(-pending);
  }

  /** Merge extra keywords into entries (LLM enrichment) and reindex them. */
  enrichTags(entries: MemoryEntry[], keywords: string[]): void {
    const normalized = keywords.map(normalizeKeyword).filter((k) => k.length >= 2);
    if (normalized.length === 0 || entries.length === 0) return;
    const index = this.ensureIndex();
    for (const entry of entries) {
      entry.tags = Array.from(new Set([...(entry.tags ?? []), ...normalized])).slice(0, MAX_TAGS_PER_ENTRY);
      index.reindex(entry);
    }
    this.persistence.markDirty(this.botName);
  }

  setSummary(text: string): void {
    this.state().memorySummary = text.slice(0, 2_000);
    this.persistence.markDirty(this.botName);
  }

  // -- daily-rhythm state (M11) ----------------------------------------------
  // BotMemory is the BotState facade, so the non-episodic per-bot state
  // (needs, mood, day plan) lives behind it too.

  needs(): BotNeeds {
    return this.state().needs;
  }

  setNeeds(needs: BotNeeds): void {
    this.state().needs = {
      rest: Math.max(0, Math.min(1, needs.rest)),
      social: Math.max(0, Math.min(1, needs.social)),
    };
    this.persistence.markDirty(this.botName);
  }

  mood(): string {
    return this.state().mood;
  }

  setMood(mood: string): void {
    this.state().mood = mood.slice(0, 60);
    this.persistence.markDirty(this.botName);
  }

  dayPlan(): DayPlan | null {
    return this.state().dayPlan;
  }

  setDayPlan(plan: DayPlan | null): void {
    this.state().dayPlan = plan;
    this.persistence.markDirty(this.botName);
  }

  // -- relationships --------------------------------------------------------

  relationWith(other: string): { score: number; notes: string } {
    return this.state().relations[other] ?? { score: 0, notes: '' };
  }

  adjustRelation(other: string, delta: number, note?: string): void {
    const state = this.state();
    const rel = state.relations[other] ?? { score: 0, notes: '' };
    rel.score = Math.max(-100, Math.min(100, rel.score + delta));
    if (note) {
      rel.notes = `${rel.notes} ${note}`.trim().slice(-300);
    }
    state.relations[other] = rel;
    this.persistence.markDirty(this.botName);
  }

  topRelations(limit: number): Array<{ name: string; score: number; notes: string }> {
    return Object.entries(this.state().relations)
      .map(([name, r]) => ({ name, score: r.score, notes: r.notes }))
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, limit);
  }
}

function clampImportance(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10, Math.round(value)));
}
