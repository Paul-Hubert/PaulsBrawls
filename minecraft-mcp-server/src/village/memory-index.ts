import { MemoryEntry } from './types.js';

/**
 * Keyword machinery for the memory registries: a French/English-aware
 * tokenizer and an in-RAM inverted index over MemoryEntry tags. The index is
 * never persisted — tags live on the entries; the index is rebuilt from them.
 *
 * Normalization is deliberately crude (accent-strip + plural-s). Explicit
 * writer-supplied tags carry the load for names/items; don't grow the stemmer
 * until a real recall miss shows up in play.
 */

export const MAX_TAGS_PER_ENTRY = 16;
const MIN_TOKEN_LENGTH = 3;

/**
 * Common FR + EN words that carry no recall value. Stored in NORMALIZED form,
 * because membership is tested after normalizeKeyword: 'mais'→'mai',
 * 'suis'→'sui', 'this'→'thi', but 'les'/'was' (3 chars) keep their 's'.
 * Words shorter than MIN_TOKEN_LENGTH never reach this set.
 */
const STOPWORDS = new Set([
  // French
  'les', 'des', 'une', 'mai', 'donc', 'car', 'pas', 'plu', 'moi', 'moin',
  'tre', 'tout', 'toute', 'tou', 'rien', 'que', 'qui', 'quoi', 'dont',
  'quand', 'comme', 'sur', 'sou', 'dan', 'par', 'pour', 'avec', 'san',
  'chez', 'entre', 'ver', 'est', 'sont', 'etait', 'ete', 'etre', 'sui',
  'avoir', 'ont', 'avait', 'fait', 'faire', 'dit', 'dire', 'aller', 'peut',
  'veux', 'veut', 'cette', 'cela', 'elle', 'nou', 'vou', 'leur', 'mon',
  'ton', 'son', 'aux', 'lui', 'bien', 'oui', 'non', 'merci', 'salut',
  'bonjour', 'alor', 'aussi', 'encore', 'ici', 'voila', 'comment',
  'pourquoi', 'quel', 'quelle', 'deja', 'juste',
  // English
  'the', 'and', 'but', 'not', 'with', 'for', 'from', 'are', 'was', 'were',
  'been', 'have', 'has', 'had', 'doe', 'did', 'will', 'would', 'said', 'say',
  'your', 'their', 'thi', 'that', 'these', 'those', 'you', 'they', 'them',
  'what', 'when', 'where', 'who', 'how', 'can', 'could', 'should', 'just',
  'now', 'then', 'here', 'there',
]);

/** lowercase → strip accents (NFD) → strip one trailing plural 's'. */
export function normalizeKeyword(raw: string): string {
  let word = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (word.length > MIN_TOKEN_LENGTH && word.endsWith('s')) word = word.slice(0, -1);
  return word;
}

/** Normalized, deduped, stopword-free keywords from free text. */
export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  // Apostrophes split French elisions (j'ai → j ai) before the word split.
  for (const raw of text.replace(/['’]/g, ' ').split(/[^\p{L}\p{N}_]+/u)) {
    if (!raw) continue;
    const word = normalizeKeyword(raw);
    if (word.length < MIN_TOKEN_LENGTH || STOPWORDS.has(word)) continue;
    seen.add(word);
  }
  return Array.from(seen);
}

/** Explicit writer-supplied tags first (they survive the cap), then text tokens. */
export function tagsFor(text: string, explicit?: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of explicit ?? []) {
    const word = normalizeKeyword(tag);
    if (word.length >= 2) seen.add(word);
  }
  for (const word of tokenize(text)) seen.add(word);
  return Array.from(seen).slice(0, MAX_TAGS_PER_ENTRY);
}

export interface SearchOptions {
  kind?: MemoryEntry['kind'];
  limit?: number;
}

/**
 * Inverted index over live MemoryEntry objects (window + archive). Score is
 * the count of distinct query keywords present in an entry's tags — exact
 * match after normalization, no fuzzy/prefix matching, so results stay
 * predictable.
 */
export class MemoryIndex {
  private readonly byTag = new Map<string, Set<MemoryEntry>>();

  add(entry: MemoryEntry): void {
    entry.tags ??= tagsFor(entry.text);
    for (const tag of entry.tags) {
      let bucket = this.byTag.get(tag);
      if (!bucket) {
        bucket = new Set();
        this.byTag.set(tag, bucket);
      }
      bucket.add(entry);
    }
  }

  remove(entry: MemoryEntry): void {
    for (const tag of entry.tags ?? []) {
      const bucket = this.byTag.get(tag);
      if (!bucket) continue;
      bucket.delete(entry);
      if (bucket.size === 0) this.byTag.delete(tag);
    }
  }

  /** Re-post an entry whose tags changed (LLM enrichment). Call AFTER mutating tags. */
  reindex(entry: MemoryEntry): void {
    // remove() walks the current tags, which already include the additions —
    // deleting a member from a bucket it isn't in is a no-op, so this is safe.
    this.remove(entry);
    this.add(entry);
  }

  search(keywords: string[], opts: SearchOptions = {}): MemoryEntry[] {
    const limit = opts.limit ?? 8;
    const scores = new Map<MemoryEntry, number>();
    for (const raw of keywords) {
      const bucket = this.byTag.get(normalizeKeyword(raw));
      if (!bucket) continue;
      for (const entry of bucket) {
        if (opts.kind && entry.kind !== opts.kind) continue;
        scores.set(entry, (scores.get(entry) ?? 0) + 1);
      }
    }
    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1] || b[0].at - a[0].at)
      .slice(0, limit)
      .map(([entry]) => entry);
  }
}
