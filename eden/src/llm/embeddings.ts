// Embeddings (layer 2). Multilingual on purpose: the bots think partly in French and English-only
// MiniLM cannot separate French topics (R38), so the default in-process model is
// Xenova/paraphrase-multilingual-MiniLM-L12-v2, loaded lazily off the hot path. Two non-negotiables:
//   • R38 — three CONSECUTIVE backend failures degrade retrieval to the keyword floor for the run
//     (a success resets the counter); never error the caller, just return null and let it fall back.
//   • The backend is pluggable: a /v1/embeddings provider, an in-process transformers.js model, or
//     `off` (no backend) — all expose the same embed/cosine surface. SkillRetriever (M2-4) and
//     VillagerMemory (M6) compute relevance as max(cosine, keywordScore), so the floor is always live.

/** A batch embedder: text[] → vector[]. Throws on failure (the service counts toward R38 degrade). */
export type EmbeddingBackend = (texts: string[]) => Promise<number[][]>;

/** Construction options for {@link EmbeddingsService}. */
export interface EmbeddingsOptions {
  /** Omit (or pass undefined) for `off` — the service stays on the keyword floor forever. */
  backend?: EmbeddingBackend;
  /** Consecutive failures before degrading for the run. Default 3 (R38). */
  maxFailures?: number;
  onWarn?: (message: string) => void;
}

/**
 * The embeddings service. `embed` returns vectors or **null** — null means "use the keyword floor"
 * (off, or degraded after R38). It never throws for a backend failure; that is the whole point.
 */
export class EmbeddingsService {
  private readonly backend?: EmbeddingBackend;
  private readonly maxFailures: number;
  private readonly onWarn?: (message: string) => void;
  private consecutiveFailures = 0;
  private degraded = false;

  constructor(opts: EmbeddingsOptions) {
    this.backend = opts.backend;
    this.maxFailures = opts.maxFailures ?? 3;
    this.onWarn = opts.onWarn;
  }

  /** True while semantic embeddings are usable; false when off or degraded (keyword floor). */
  enabled(): boolean {
    return this.backend !== undefined && !this.degraded;
  }

  /** Embed a batch; returns null when off/degraded so the caller drops to {@link keywordScore}. */
  async embed(texts: string[]): Promise<number[][] | null> {
    if (!this.enabled()) return null;
    try {
      const vectors = await this.backend!(texts);
      this.consecutiveFailures = 0; // a success resets the run's failure streak (R38)
      return vectors;
    } catch (e) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.maxFailures) {
        this.degraded = true;
        this.onWarn?.(
          `embeddings: ${this.consecutiveFailures} consecutive failures — degrading to the keyword floor for this run (R38): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      return null;
    }
  }
}

/** Cosine similarity in [-1, 1]; 0 when either vector is zero-length. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Tokenize for the keyword floor — lowercase, unicode letters/digits, ≥2 chars (keeps French accents). */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (tok.length >= 2) out.add(tok);
  }
  return out;
}

/** The embeddings-off relevance floor (R38): set-cosine token overlap in [0, 1]. */
export function keywordScore(query: string, text: string): number {
  const q = tokenize(query);
  const d = tokenize(text);
  if (q.size === 0 || d.size === 0) return 0;
  let overlap = 0;
  for (const t of q) if (d.has(t)) overlap++;
  return overlap / Math.sqrt(q.size * d.size);
}

/** A backend that POSTs to an OpenAI-compatible /v1/embeddings endpoint (LM Studio / Ollama / OpenAI). */
export function providerBackend(baseUrl: string, model: string, fetchImpl: typeof fetch = fetch): EmbeddingBackend {
  return async (texts: string[]): Promise<number[][]> => {
    const res = await fetchImpl(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) throw new Error(`embeddings: HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const data = json.data ?? [];
    if (data.length !== texts.length) throw new Error(`embeddings: expected ${texts.length} vectors, got ${data.length}`);
    return data.map((d) => d.embedding ?? []);
  };
}

/**
 * The in-process transformers.js backend (the production default — multilingual MiniLM, R38). Lazily
 * dynamic-imports the model the first time it runs, so it costs nothing until a real embed is needed
 * and a missing/broken install simply counts as a failure toward the R38 degrade. Not used in CI
 * (the fakes drive the provider/injected backends); kept thin and dependency-light on purpose.
 */
export function localBackend(
  modelId = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
): EmbeddingBackend {
  let extractorPromise: Promise<(text: string, opts: object) => Promise<{ data: ArrayLike<number> }>> | undefined;
  const load = async (): Promise<(text: string, opts: object) => Promise<{ data: ArrayLike<number> }>> => {
    // Dynamic import via a NON-LITERAL specifier so tsc treats the heavy dep as runtime-only
    // (optional). An absent/broken install throws here → counts as an R38 failure, never a build break.
    const spec = '@xenova/transformers';
    const mod = (await import(spec)) as {
      pipeline: (task: string, model: string) => Promise<(text: string, opts: object) => Promise<{ data: ArrayLike<number> }>>;
    };
    return mod.pipeline('feature-extraction', modelId);
  };
  return async (texts: string[]): Promise<number[][]> => {
    extractorPromise ??= load();
    const extractor = await extractorPromise;
    const out: number[][] = [];
    for (const text of texts) {
      const result = await extractor(text, { pooling: 'mean', normalize: true });
      out.push(Array.from(result.data));
    }
    return out;
  };
}
