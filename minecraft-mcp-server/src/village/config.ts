import fs from 'fs';
import path from 'path';
import { log } from '../logger.js';
import { EmbeddingSettings, LLMSettings, NeedsSettings, RosterBot, Vec3Like, VillageRosterFile, VillageSettings } from './types.js';

/**
 * Roster + settings loading. One JSON file (`village.json` by default) holds
 * the LLM config, the village-wide knobs, and the ten-bot roster — see
 * `village.example.json` at the sub-project root for the shape.
 */

const DEFAULT_LLM: LLMSettings = {
  provider: 'openai',
  baseUrl: '',
  model: 'gpt-4o-mini',
  fastModel: '',
  apiKey: '',
  timeoutMs: 120_000,
  temperature: 0.9,
  maxTokens: 1024,
};

const DEFAULT_EMBEDDINGS: EmbeddingSettings = {
  mode: 'local',
  model: '',
};

const DEFAULT_NEEDS: NeedsSettings = {
  restDecayPerMin: 0.02,    // ~50 min of nonstop work to bottom out
  restRecoverPerMin: 0.05,  // ~20 min off to refill
  socialDecayPerMin: 0.01,  // ~100 min alone to bottom out
  socialRecoverPerMin: 0.1, // ~10 min of company to refill
  lowThreshold: 0.25,
};

const DEFAULT_SETTINGS: VillageSettings = {
  llm: DEFAULT_LLM,
  embeddings: DEFAULT_EMBEDDINGS,
  dayPlanning: true,
  needs: DEFAULT_NEEDS,
  spontaneousChat: true,
  concurrency: 3,
  heartbeatSeconds: 180,
  botCooldownMs: 15_000,
  earshotRadius: 32,
  settlementUrl: 'http://127.0.0.1:8767',
  dataDir: '.village-data',
  maxConversationTurns: 8,
};

/** Default OpenAI-compatible base URL per provider. */
export function resolveBaseUrl(llm: LLMSettings): string {
  if (llm.baseUrl) return llm.baseUrl.replace(/\/+$/, '');
  switch (llm.provider) {
    case 'lmstudio': return 'http://127.0.0.1:1234/v1';
    case 'ollama':   return 'http://127.0.0.1:11434/v1';
    default:         return 'https://api.openai.com/v1';
  }
}

export function resolveApiKey(llm: LLMSettings): string {
  if (llm.apiKey) return llm.apiKey;
  return process.env.OPENAI_API_KEY ?? 'not-needed';
}

/** Per-mode default embedding model. */
export function resolveEmbeddingModel(embeddings: EmbeddingSettings): string {
  if (embeddings.model) return embeddings.model;
  // MULTILINGUAL MiniLM, not the paper's all-MiniLM-L6-v2: the villagers
  // speak French, and the English-only model barely separates French topics
  // (measured: related 0.42 vs unrelated 0.39 cosine — useless), while this
  // one gives 0.77 vs 0.01. The Xenova repo ships the ONNX weights
  // transformers.js needs; one-time ~45 s download, cached afterwards.
  return embeddings.mode === 'provider'
    ? 'text-embedding-3-small'
    : 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
}

export interface VillageConfig {
  settings: VillageSettings;
  bots: RosterBot[];
  /** Human-readable problems found while loading (already logged as warnings). */
  warnings: string[];
}

/** Keep only known keys; everything else becomes a warning. A silently-ignored
 *  typo (`max_completion_tokens` for `maxTokens`) once ran a whole village on
 *  the wrong token budget — config mistakes must be LOUD. */
function pickKnown<T>(obj: Record<string, unknown>, known: ReadonlySet<string>, label: string, warnings: string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (known.has(key)) out[key] = value;
    else warnings.push(`unknown ${label} key '${key}' — ignored (valid: ${Array.from(known).join(', ')})`);
  }
  return out as Partial<T>;
}

const KNOWN_SETTINGS = new Set(Object.keys(DEFAULT_SETTINGS));
const KNOWN_LLM = new Set(Object.keys(DEFAULT_LLM));
const KNOWN_EMBEDDINGS = new Set(Object.keys(DEFAULT_EMBEDDINGS));
const KNOWN_NEEDS = new Set(Object.keys(DEFAULT_NEEDS));
/** Below this, heartbeats alone make every bot hammer the LLM. */
const HEARTBEAT_SANE_MIN_S = 30;

function isVec3Like(value: unknown): value is Vec3Like {
  const v = value as Vec3Like | null | undefined;
  return Boolean(v) && Number.isFinite(v!.x) && Number.isFinite(v!.y) && Number.isFinite(v!.z);
}

export function loadVillageConfig(rosterPath: string): VillageConfig {
  const raw = fs.readFileSync(rosterPath, 'utf8');
  const parsed = JSON.parse(raw) as VillageRosterFile;
  const warnings: string[] = [];

  if (!Array.isArray(parsed.bots) || parsed.bots.length === 0) {
    throw new Error(`roster ${rosterPath} has no bots`);
  }
  const seen = new Set<string>();
  for (const bot of parsed.bots) {
    if (!bot.name || !bot.role) {
      throw new Error(`roster entry missing name/role: ${JSON.stringify(bot)}`);
    }
    if (seen.has(bot.name)) throw new Error(`duplicate bot name in roster: ${bot.name}`);
    seen.add(bot.name);
    for (const field of ['home', 'workstation', 'chest'] as const) {
      if (bot[field] !== undefined && !isVec3Like(bot[field])) {
        warnings.push(`bot '${bot.name}' has a malformed ${field} (need numeric x/y/z) — dropped`);
        delete bot[field];
      }
    }
  }

  const fileSettings = { ...(parsed.settings ?? {}) } as Record<string, unknown>;
  const fileLlm = { ...((parsed.settings?.llm ?? {}) as Record<string, unknown>) };

  // Forgiving aliases for the most common mistake: OpenAI's wire-format token
  // keys instead of our `maxTokens`. Adopt the value rather than silently
  // running on the 1024 default.
  for (const alias of ['max_completion_tokens', 'max_tokens', 'maxCompletionTokens']) {
    if (alias in fileLlm) {
      const value = fileLlm[alias];
      if (fileLlm.maxTokens === undefined && typeof value === 'number') {
        fileLlm.maxTokens = value;
        warnings.push(`llm.${alias} is not a setting — adopted as maxTokens=${value} (rename it in ${path.basename(rosterPath)})`);
      } else {
        warnings.push(`llm.${alias} is not a setting (the key is maxTokens) — ignored`);
      }
      delete fileLlm[alias];
    }
  }

  const settings: VillageSettings = {
    ...DEFAULT_SETTINGS,
    ...pickKnown<VillageSettings>(fileSettings, KNOWN_SETTINGS, 'settings', warnings),
    llm: { ...DEFAULT_LLM, ...pickKnown<LLMSettings>(fileLlm, KNOWN_LLM, 'llm', warnings) },
    embeddings: { ...DEFAULT_EMBEDDINGS, ...pickKnown<EmbeddingSettings>((parsed.settings?.embeddings ?? {}) as Record<string, unknown>, KNOWN_EMBEDDINGS, 'embeddings', warnings) },
    needs: { ...DEFAULT_NEEDS, ...pickKnown<NeedsSettings>((parsed.settings?.needs ?? {}) as Record<string, unknown>, KNOWN_NEEDS, 'needs', warnings) },
  };
  settings.dataDir = path.resolve(path.dirname(rosterPath), settings.dataDir);

  if (settings.heartbeatSeconds < HEARTBEAT_SANE_MIN_S) {
    warnings.push(
      `heartbeatSeconds=${settings.heartbeatSeconds} is very aggressive — every bot wakes the LLM that often when idle; ${HEARTBEAT_SANE_MIN_S}+ recommended (default 180)`
    );
  }

  for (const warning of warnings) log('warn', `[village] config: ${warning}`);
  return { settings, bots: parsed.bots, warnings };
}
