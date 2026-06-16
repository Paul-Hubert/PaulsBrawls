// SkillRetriever (layer 2) — what fills the "retrieved relevant skills" section of a prompt
// (02 §Retrieval). Three invariants:
//   • P2 — only `active` + `active-probation` versions are ever surfaced (the library's liveSkills);
//     drafts are runnable solely inside their own rollout, quarantined/archived are invisible.
//   • Tiers — tier-filtered: a mortal villager never sees divine skills (invisible, not forbidden);
//     God's desks (tier 'divine') see both, since divine composes mortal (02 §Tiers).
//   • Relevance = max(embedding cosine, keyword overlap) over summary+description+tags, with the
//     keyword floor always live so an embeddings outage (R38) degrades gracefully, never errors.
// Both retrieval and execution pass through the GrantPolicy (the economy seam, owner #3).

import type { SkillManifest, Tier } from '../types/index';
import { cosine, keywordScore, type EmbeddingsService } from '../llm/embeddings';
import type { GrantPolicy, SkillLibrary } from './library';

/** One ranked retrieval result — the prompt renders `name — signature — summary` (+ stats elsewhere). */
export interface RankedSkill {
  name: string;
  signature: string;
  summary: string;
  tags: string[];
  tier: Tier;
  score: number;
}

/** Search parameters: the runner tier (gates divine), the asking villager (grants), and top-k. */
export interface SearchOptions {
  tier: Tier;
  villager?: string;
  k?: number;
}

/** Construction dependencies. */
export interface SkillRetrieverOptions {
  library: SkillLibrary;
  embeddings: EmbeddingsService;
  grants: GrantPolicy;
}

const DEFAULT_K = 8;

function skillText(m: SkillManifest): string {
  return `${m.summary} ${m.description} ${m.tags.join(' ')}`.trim();
}

/** Largest number of (name@version) skill vectors kept; FIFO-evicted past this (bounds long-run memory). */
const VECTOR_CACHE_CAP = 4096;

/** Ranks the live library against a query, tier- and grant-filtered (02 §Retrieval). */
export class SkillRetriever {
  // Per-(name@version) embedding cache (R58). Library versions are append-only so a skill's vector is
  // reusable; we ALSO key on the embedded text because the description-from-code pass can land AFTER a
  // version's first retrieval (admit → live → describe), which mutates the text. Before this cache,
  // search() embedded [query, ...EVERY live skill] through the in-process ONNX model on every call —
  // O(library) synchronous inferences per deliberation, the multi-second event-loop stall (system.loop-lag)
  // that worsened as the library grew. Now a search embeds only the query + skills whose text changed.
  private readonly vectorCache = new Map<string, { text: string; vector: number[] }>();

  constructor(private readonly opts: SkillRetrieverOptions) {}

  /** Top-k relevant live skills for a query, filtered by tier (R25) and grants (owner #3). */
  async search(query: string, search: SearchOptions): Promise<RankedSkill[]> {
    const k = search.k ?? DEFAULT_K;
    const villager = search.villager ?? '*';
    const candidates = this.opts.library
      .liveSkills()
      // Tier filter: mortal sees only mortal; divine (God) sees both (divine composes mortal).
      .filter((s) => s.manifest.tier === 'mortal' || search.tier === 'divine')
      .filter((s) => this.opts.grants.canRetrieve(villager, s.manifest.name));
    if (candidates.length === 0) return [];

    const texts = candidates.map((c) => skillText(c.manifest));
    const keys = candidates.map((c) => `${c.version.name}@${c.version.version}`);

    // Only the query + skills with a missing/stale cached vector need a fresh embed (R58).
    const misses: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const cached = this.vectorCache.get(keys[i]!);
      if (!cached || cached.text !== texts[i]) misses.push(i);
    }
    const fresh = await this.opts.embeddings.embed([query, ...misses.map((i) => texts[i]!)]);
    const queryVec = fresh ? fresh[0] : undefined;
    if (fresh) {
      for (let j = 0; j < misses.length; j++) {
        const i = misses[j]!;
        const v = fresh[j + 1];
        if (v) this.vectorCache.set(keys[i]!, { text: texts[i]!, vector: v });
      }
      this.evictOldest();
    }

    const scored: RankedSkill[] = candidates.map((c, i) => {
      const keyword = keywordScore(query, texts[i]!);
      let relevance = keyword;
      const sv = this.vectorCache.get(keys[i]!)?.vector;
      if (queryVec && sv) relevance = Math.max(cosine(queryVec, sv), keyword); // max(semantic, keyword) — R38 floor
      return {
        name: c.manifest.name,
        signature: c.manifest.signature,
        summary: c.manifest.summary,
        tags: c.manifest.tags,
        tier: c.manifest.tier,
        score: relevance,
      };
    });
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored.slice(0, k);
  }

  /** FIFO-evict cached vectors past the cap (Map keeps insertion order); superseded versions drift out. */
  private evictOldest(): void {
    while (this.vectorCache.size > VECTOR_CACHE_CAP) {
      const oldest = this.vectorCache.keys().next().value;
      if (oldest === undefined) break;
      this.vectorCache.delete(oldest);
    }
  }
}
