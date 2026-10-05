// VillagerMemory (layer 3, villagers/) — the full memory port (04 §Memory). One per villager:
//   • an episodic WINDOW (~200 entries) → evicted batches fold into a persisted per-bot ARCHIVE
//     (cap ~2000) AND into a rolling LIFE SUMMARY via ONE fast-LLM call (the MemorySummarizer) that
//     also returns keyword-tag enrichment, importance bumps, and up to two `lesson` insight memories;
//   • a MemoryRetriever ranking 0.5·relevance + 0.25·recency(2 h half-life) + 0.25·importance, where
//     relevance = max(embedding cosine, keyword overlap); embeddings are lazy + degrade to keywords (R38);
//   • RELATIONS (per-other score + note) — leave_conversation moves them;
//   • R32 — a persisted store whose world-id differs from the current world is QUARANTINED behind an
//     admin decision (wipe | migrate): not silently used, not silently dropped.
//
// Two deliberate DROPS vs v1:
//   • refuteBlockedBeliefs is GONE — the critic owns belief retirement at verdict delivery (R37). This
//     module must NOT re-implement it (a grep for the method finds nothing — see the R37 test).
//   • drives (rest/social) are NOT here — they are optional config (behavior.drives, M6-4), wake-ups not
//     architecture.
//
// S2: VillagerMemory is the SOLE WRITER of one villager's memory state (window/archive/relations/summary),
// persisted to .eden-data/bots/<name>.json (alongside anchors). villagers/ imports llm/render/journal/
// config/types (downward) — never god/ or social/. social/ reaches it through the types/ MemoryWriter
// interface injected at main.ts (the cross-layer-3 seam).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MemoryEntry, MemorySeed, MemoryWriter, Relation } from '../types/index';
import type { IJournal, JournalAppender } from '../journal/journal';
import { cosine, keywordScore, type EmbeddingsService } from '../llm/embeddings';
import type { MemorySummarizer } from './memory-summarizer';

export { MemorySummarizer } from './memory-summarizer';

/** Default heuristic importance by kind (0–10) — bumped during summarization (04). Lessons rank top. */
const IMPORTANCE_BY_KIND: Record<MemoryEntry['kind'], number> = {
  lesson: 9,
  trade: 6,
  social: 5,
  event: 4,
  thought: 3,
  system: 2,
};

/** Recency half-life for the retrieval blend (04: 2 h). At one half-life recency = 0.5. */
const RECENCY_HALF_LIFE_MS = 2 * 60 * 60 * 1000;

/** The retrieval blend weights (04 §Memory) — sum to 1. */
const W_RELEVANCE = 0.5;
const W_RECENCY = 0.25;
const W_IMPORTANCE = 0.25;

const DEFAULT_WINDOW_MAX = 200;
const DEFAULT_EVICT_BATCH = 20;
const DEFAULT_ARCHIVE_MAX = 2000;
const RELATION_SCORE_BAND = 100; // clamp |score| so a runaway streak can't dominate

/** A ranked retrieval hit — the entry plus its blended score (the context-pack §6 source). */
export interface RankedMemory extends MemoryEntry {
  /** The 0.5·rel + 0.25·rec + 0.25·imp blended score in [0, ~1]. */
  score: number;
}

/** The persisted shape under the bot file's `memory` key (S2). */
interface PersistedMemory {
  worldId: string;
  window: MemoryEntry[];
  archive: MemoryEntry[];
  relations: Relation[];
  lifeSummary: string;
}

/** Construction deps (wired in main.ts; no singletons). */
export interface VillagerMemoryOptions {
  villager: string;
  dataDir: string;
  journal: IJournal | JournalAppender;
  /** Stable identifier of the current world (R32) — main.ts passes `${host}:${port}` (matches the pool). */
  worldId: string;
  /** Semantic backend for the relevance half of max(cosine, keyword). Omit → keyword floor (R38). */
  embeddings?: EmbeddingsService;
  /** The fast-LLM summarizer run on eviction. Omit → eviction still archives, just no rolling summary. */
  summarizer?: MemorySummarizer;
  windowMax?: number;
  evictBatch?: number;
  archiveMax?: number;
  now?: () => number;
}

/**
 * One villager's memory. Implements the types/ {@link MemoryWriter} seam so social/ can write to it
 * without importing villagers/ (the dependency law).
 */
export class VillagerMemory implements MemoryWriter {
  readonly villager: string;
  private readonly dataDir: string;
  private readonly journal: JournalAppender;
  private readonly worldId: string;
  private readonly embeddings?: EmbeddingsService;
  private readonly summarizer?: MemorySummarizer;
  private readonly windowMax: number;
  private readonly evictBatch: number;
  private readonly archiveMax: number;
  private readonly now: () => number;

  private window: MemoryEntry[] = [];
  private archiveStore: MemoryEntry[] = [];
  private relationMap = new Map<string, Relation>();
  private summary = '';

  // R32 quarantine: persisted state from a DIFFERENT world is held aside until the admin decides.
  private quarantine: PersistedMemory | null = null;
  // Pending summarization work — flushSummary() awaits it (off the hot path).
  private pendingSummary: Promise<void> = Promise.resolve();
  // Bumped by reset(): a summarization that started before a reset must not write the old life back.
  private generation = 0;

  constructor(opts: VillagerMemoryOptions) {
    this.villager = opts.villager;
    this.dataDir = opts.dataDir;
    this.journal = opts.journal;
    this.worldId = opts.worldId;
    if (opts.embeddings) this.embeddings = opts.embeddings;
    if (opts.summarizer) this.summarizer = opts.summarizer;
    this.windowMax = opts.windowMax ?? DEFAULT_WINDOW_MAX;
    this.evictBatch = opts.evictBatch ?? DEFAULT_EVICT_BATCH;
    this.archiveMax = opts.archiveMax ?? DEFAULT_ARCHIVE_MAX;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  // ── writes (MemoryWriter) ─────────────────────────────────────────────────────────────────────
  /** Seed an episodic entry into the window (heuristic importance + tags if omitted). May evict. */
  remember(seed: MemorySeed): MemoryEntry {
    const entry: MemoryEntry = {
      kind: seed.kind,
      text: seed.text,
      tags: seed.tags && seed.tags.length > 0 ? seed.tags : deriveTags(seed.text),
      importance: clamp(seed.importance ?? IMPORTANCE_BY_KIND[seed.kind], 0, 10),
      at: this.now(),
    };
    this.window.push(entry);
    this.maybeEvict();
    this.persist();
    return entry;
  }

  /** Adjust the relation toward `other` by `delta`, replacing the note (leave_conversation, 04). */
  moveRelation(other: string, delta: number, note: string): Relation {
    const prev = this.relationMap.get(other);
    const relation: Relation = {
      other,
      score: clamp((prev?.score ?? 0) + delta, -RELATION_SCORE_BAND, RELATION_SCORE_BAND),
      note,
      at: this.now(),
    };
    this.relationMap.set(other, relation);
    this.persist();
    return relation;
  }

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────
  /** The newest `n` window entries, newest-first (context-pack §5 "recent past" as strings). */
  recent(n: number): string[] {
    return this.window
      .slice(-n)
      .reverse()
      .map((e) => renderEntry(e));
  }

  /** Every live window entry (oldest-first) — tests + the summarizer batch. */
  all(): MemoryEntry[] {
    return [...this.window];
  }

  /** The persisted archive (oldest-first). */
  archive(): MemoryEntry[] {
    return [...this.archiveStore];
  }

  /** Every relation this villager holds. */
  relations(): Relation[] {
    return [...this.relationMap.values()];
  }

  /** The rolling life summary (the side product of eviction summarization). */
  lifeSummary(): string {
    return this.summary;
  }

  /**
   * Ranked retrieval over the live window (and archive) for a query (context-pack §6). The blend is
   * 0.5·relevance + 0.25·recency(2 h half-life) + 0.25·importance, relevance = max(cosine, keyword).
   * Embeddings are computed lazily here and degrade to the keyword floor (R38: embed → null).
   */
  async retrieve(query: string, k: number): Promise<RankedMemory[]> {
    const pool = [...this.window, ...this.archiveStore];
    if (pool.length === 0) return [];

    // Lazy, batched embeddings off the hot path; null (off/degraded) → keyword floor everywhere (R38).
    let vectors: number[][] | null = null;
    if (this.embeddings?.enabled()) {
      vectors = await this.embeddings.embed([query, ...pool.map((e) => e.text)]);
    }
    const queryVec = vectors?.[0];

    const tNow = this.now();
    const ranked: RankedMemory[] = pool.map((entry, i) => {
      const kw = keywordScore(query, entry.text);
      const cos = queryVec && vectors ? Math.max(0, cosine(queryVec, vectors[i + 1] ?? [])) : 0;
      const relevance = Math.max(cos, kw); // relevance = max(embedding cosine, keyword overlap) (04)
      const recency = Math.pow(0.5, (tNow - entry.at) / RECENCY_HALF_LIFE_MS);
      const importance = clamp(entry.importance, 0, 10) / 10;
      const score = W_RELEVANCE * relevance + W_RECENCY * recency + W_IMPORTANCE * importance;
      return { ...entry, score };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, k);
  }

  // ── R32 quarantine + admin decision ─────────────────────────────────────────────────────────────
  /** True while a different-world persisted store is held aside awaiting an admin decision (R32). */
  isQuarantined(): boolean {
    return this.quarantine !== null;
  }

  /** How many memories (window + archive) are quarantined (held for the admin decision). */
  quarantinedCount(): number {
    if (!this.quarantine) return 0;
    return this.quarantine.window.length + this.quarantine.archive.length;
  }

  /**
   * The admin's R32 decision. `wipe` drops the dead-world memories; `migrate` adopts them into the new
   * world. Either way the new world id is adopted as the stamp and the quarantine clears.
   */
  resolveQuarantine(decision: 'wipe' | 'migrate'): void {
    if (!this.quarantine) return;
    if (decision === 'migrate') {
      this.window = this.quarantine.window;
      this.archiveStore = this.quarantine.archive;
      this.relationMap = new Map(this.quarantine.relations.map((r) => [r.other, r]));
      this.summary = this.quarantine.lifeSummary;
      this.trimArchive();
    }
    // 'wipe' keeps the already-empty live state.
    this.quarantine = null;
    this.persist(); // re-stamp with the current world id + the resolved state
  }

  /**
   * Bug #16 — forget everything (the in-game `/villagers restart`). The launcher deletes `bots/<name>.json`, but
   * this live instance held the old window/archive/relations in RAM and re-wrote them on the next memory write.
   * Clears the RAM state and any R32 quarantine; does not write (the next remember() persists a fresh file).
   */
  reset(): void {
    this.generation++;
    this.window = [];
    this.archiveStore = [];
    this.relationMap = new Map();
    this.summary = '';
    this.quarantine = null;
  }

  // ── summarization (off the hot path; flushSummary awaits the pending work) ───────────────────────
  /** Await any in-flight eviction summarization (tests + graceful shutdown). */
  async flushSummary(): Promise<void> {
    await this.pendingSummary;
  }

  private maybeEvict(): void {
    if (this.window.length <= this.windowMax) return;
    const overflow = this.window.length - this.windowMax;
    const take = Math.max(overflow, this.evictBatch);
    const evicted = this.window.splice(0, Math.min(take, this.window.length));
    this.archiveStore.push(...evicted);
    this.trimArchive();
    // Fold the evicted batch into the rolling summary — off the hot path, best-effort (never throws here).
    this.scheduleSummary(evicted);
  }

  private trimArchive(): void {
    if (this.archiveStore.length > this.archiveMax) {
      this.archiveStore.splice(0, this.archiveStore.length - this.archiveMax);
    }
  }

  private scheduleSummary(evicted: MemoryEntry[]): void {
    if (!this.summarizer) return;
    const prev = this.summary;
    const gen = this.generation;
    this.pendingSummary = this.pendingSummary
      .then(async () => {
        const result = await this.summarizer!.summarize(this.villager, prev, evicted);
        if (!result) return; // a bad reply degrades silently (best-effort, like describe.ts)
        if (gen !== this.generation) return; // reset() ran meanwhile — this summary belongs to the old life
        this.summary = result.summary || prev;
        // Apply importance bumps + tag enrichment to the just-evicted (archived) entries by index.
        for (const [key, bump] of Object.entries(result.importanceBumps ?? {})) {
          const idx = parseEntryIndex(key);
          if (idx !== undefined && evicted[idx]) evicted[idx]!.importance = clamp(bump, 0, 10);
        }
        for (const [key, tags] of Object.entries(result.tags ?? {})) {
          const idx = parseEntryIndex(key);
          if (idx !== undefined && evicted[idx]) {
            evicted[idx]!.tags = Array.from(new Set([...evicted[idx]!.tags, ...tags]));
          }
        }
        // Seed up to two LESSON memories into the live window (insights survive eviction — 04).
        for (const lesson of (result.lessons ?? []).slice(0, 2)) {
          this.window.push({
            kind: 'lesson',
            text: lesson,
            tags: deriveTags(lesson),
            importance: IMPORTANCE_BY_KIND.lesson,
            at: this.now(),
          });
        }
        this.persist();
      })
      .catch(() => {
        // Summarization is best-effort: a model/network error never breaks the memory flow (R39 spirit).
      });
  }

  // ── persistence (.eden-data/bots/<name>.json under the `memory` key) ─────────────────────────────
  private file(): string {
    return join(this.dataDir, 'bots', `${this.villager}.json`);
  }

  /** Load the persisted memory; on a WORLD-ID MISMATCH, quarantine it instead of adopting it (R32). */
  private load(): void {
    const f = this.file();
    if (!existsSync(f)) return;
    let raw: { memory?: PersistedMemory };
    try {
      raw = JSON.parse(readFileSync(f, 'utf8')) as { memory?: PersistedMemory };
    } catch {
      return; // a corrupt file must not crash boot — start fresh (it re-persists on the next write)
    }
    const persisted = raw.memory;
    if (!persisted) return;
    if (persisted.worldId && persisted.worldId !== this.worldId) {
      // R32: the data dir belongs to a different world. Hold it aside; start with an EMPTY live store so
      // bots never reason from a dead world, but the admin can still wipe or migrate.
      this.quarantine = persisted;
      this.journal.append(`villager:${this.villager}`, 'system.config-warning', {
        message:
          `memory: "${this.villager}" persisted world "${persisted.worldId}" != current "${this.worldId}" — ` +
          `${persisted.window.length + persisted.archive.length} memories QUARANTINED behind an admin decision (wipe|migrate) (R32)`,
      });
      return;
    }
    this.window = persisted.window ?? [];
    this.archiveStore = persisted.archive ?? [];
    this.relationMap = new Map((persisted.relations ?? []).map((r) => [r.other, r]));
    this.summary = persisted.lifeSummary ?? '';
  }

  /** Write the memory state under the bot file's `memory` key (preserving anchors/etc). */
  private persist(): void {
    if (this.quarantine) return; // never overwrite quarantined state until the admin resolves it (R32)
    const f = this.file();
    mkdirSync(join(this.dataDir, 'bots'), { recursive: true });
    let data: Record<string, unknown> = {};
    if (existsSync(f)) {
      try {
        data = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    const memory: PersistedMemory = {
      worldId: this.worldId,
      window: this.window,
      archive: this.archiveStore,
      relations: [...this.relationMap.values()],
      lifeSummary: this.summary,
    };
    data['memory'] = memory;
    writeFileSync(f, JSON.stringify(data, null, 2));
  }
}

/** Render one memory entry as a context-pack line (kind-tagged, French-facing). */
function renderEntry(e: MemoryEntry): string {
  const tags = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
  return `(${e.kind}) ${e.text}${tags}`;
}

/** Cheap keyword tags from text when the caller gives none — the heuristic enrichment (04). */
function deriveTags(text: string): string[] {
  const stop = new Set(['les', 'des', 'une', 'avec', 'pour', 'dans', 'sur', 'and', 'the', 'for', 'with']);
  const out: string[] = [];
  for (const tok of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (tok.length >= 4 && !stop.has(tok) && !out.includes(tok)) out.push(tok);
    if (out.length >= 4) break;
  }
  return out;
}

/** Parse the summarizer's `entry-<n>` key into an index (the enrichment addresses evicted entries). */
function parseEntryIndex(key: string): number | undefined {
  const m = /^entry-(\d+)$/.exec(key);
  return m ? Number(m[1]) : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
