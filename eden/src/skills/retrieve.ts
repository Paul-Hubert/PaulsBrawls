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

/** Ranks the live library against a query, tier- and grant-filtered (02 §Retrieval). */
export class SkillRetriever {
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
    const vectors = await this.opts.embeddings.embed([query, ...texts]);

    const scored: RankedSkill[] = candidates.map((c, i) => {
      const keyword = keywordScore(query, texts[i]!);
      let relevance = keyword;
      if (vectors) {
        const qv = vectors[0];
        const sv = vectors[i + 1];
        if (qv && sv) relevance = Math.max(cosine(qv, sv), keyword); // max(semantic, keyword) — R38 floor
      }
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
}
