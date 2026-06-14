// MemorySummarizer (layer 3, villagers/) — the rolling life-summary pass (04 §Memory). When a batch of
// memories is EVICTED from the window, ONE fast-tier LLM call (D-13: cheap, not novelty) folds them into
// the rolling life summary and ALSO returns keyword-tag enrichment, importance bumps, and up to two
// `lesson` insights. Modeled on skills/describe.ts: it must NEVER throw into the memory flow — a bad
// reply yields null and the caller degrades (the batch is still archived).
//
// Imports only llm/ + types/ (downward). villagers/ may import llm/; this stays out of the hot path.

import type { LlmClient } from '../llm/client';
import type { MemoryEntry } from '../types/index';

/** The structured enrichment the summarizer returns (all fields optional — a partial reply is fine). */
export interface SummaryResult {
  /** The new rolling life summary (replaces the prior one). */
  summary: string;
  /** Per-evicted-entry keyword tags, keyed `entry-<index>` (index into the evicted batch). */
  tags?: Record<string, string[]>;
  /** Per-evicted-entry importance bumps (0–10), keyed `entry-<index>`. */
  importanceBumps?: Record<string, number>;
  /** Up to two distilled insights — seeded as `lesson` memories that survive eviction. */
  lessons?: string[];
}

const SYSTEM_PROMPT = [
  'Tu es la mémoire à long terme d’un villageois (un bot Minecraft) qui pense en français.',
  'On te donne le résumé de vie actuel et un lot de souvenirs qui sortent de la fenêtre récente.',
  'Mets à jour le résumé de vie (court, factuel, à la 3e personne), enrichis les souvenirs avec des',
  'mots-clés et des notes d’importance (0–10), et distille AU PLUS DEUX leçons générales.',
  'Réponds en JSON STRICT uniquement: {"summary": string, "tags": {"entry-0": string[], …},',
  '"importanceBumps": {"entry-0": number, …}, "lessons": string[]}. Aucune prose hors du JSON.',
].join(' ');

/** Runs the eviction summarization against a fast-tier LLM client (D-13). */
export class MemorySummarizer {
  constructor(
    private readonly client: LlmClient,
    private readonly opts: { caller?: string } = {},
  ) {}

  /**
   * Fold `evicted` into `prevSummary`. Returns the enrichment, or null on any failure (best-effort).
   * The caller (VillagerMemory) applies the result off the hot path and degrades silently on null.
   */
  async summarize(villager: string, prevSummary: string, evicted: MemoryEntry[]): Promise<SummaryResult | null> {
    if (evicted.length === 0) return null;
    const batch = evicted.map((e, i) => `entry-${i} (${e.kind}, imp ${e.importance}): ${e.text}`).join('\n');
    try {
      const result = await this.client.chat({
        tier: 'fast',
        caller: this.opts.caller ?? `villager:${villager}`,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Villageois: ${villager}\n\nRésumé de vie actuel:\n${prevSummary || '(aucun)'}\n\nSouvenirs évincés:\n${batch}\n\nRenvoie uniquement l’objet JSON.`,
          },
        ],
      });
      return parseResult(result.content);
    } catch {
      return null; // a model/network error never breaks eviction (best-effort, like describe.ts)
    }
  }
}

function parseResult(content: string | null): SummaryResult | null {
  if (!content) return null;
  const json = extractJson(content);
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const summary = typeof obj['summary'] === 'string' ? (obj['summary'] as string) : '';
    if (!summary) return null;
    const out: SummaryResult = { summary };
    if (isStringArrayMap(obj['tags'])) out.tags = obj['tags'] as Record<string, string[]>;
    if (isNumberMap(obj['importanceBumps'])) out.importanceBumps = obj['importanceBumps'] as Record<string, number>;
    if (Array.isArray(obj['lessons'])) out.lessons = (obj['lessons'] as unknown[]).filter((l): l is string => typeof l === 'string');
    return out;
  } catch {
    return null;
  }
}

/** Pull a JSON object out of a possibly-fenced reply (```json … ``` or bare). */
function extractJson(content: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const body = fenced ? fenced[1]! : content;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  return body.slice(start, end + 1);
}

function isStringArrayMap(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => Array.isArray(x));
}
function isNumberMap(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'number');
}
