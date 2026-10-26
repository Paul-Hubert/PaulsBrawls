import fs from 'fs';
import path from 'path';
import { log } from '../logger.js';
import { resolveApiKey, resolveBaseUrl, resolveEmbeddingModel } from './config.js';
import { MemoryEntry, VillageSettings } from './types.js';

/**
 * Semantic-memory embeddings (VILLAGE_PLAN M10). Entries are embedded lazily
 * off the hot path: BotMemory.append() only enqueues; a debounced drain
 * embeds in batches and stores vectors in a per-bot sidecar file
 * (`<dataDir>/bots/<name>.vectors.json`, base64 Float32) so bot state JSON
 * stays small and diffable.
 *
 * Failure policy: embedding is an enhancement, never a dependency. Backend
 * init failure or three consecutive embed failures disable the service for
 * the rest of the process (one warning); retrieval silently degrades to the
 * keyword index. Tests inject a fake backend — the real ones never run in CI.
 */

export interface EmbeddingBackend {
  /** Returns one unit-normalized(ish) vector per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

const DRAIN_DELAY_MS = 1_000;
const DRAIN_BATCH = 16;
const SAVE_DELAY_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 3;
/** Embedding input cap — memory texts are ≤500 chars anyway. */
const MAX_EMBED_CHARS = 600;

/** Stable identity of an entry across restarts (at + text hash). */
export function entryKey(entry: Pick<MemoryEntry, 'at' | 'text'>): string {
  return `${entry.at}_${fnv1a(entry.text)}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Dot product — vectors are unit-normalized, so this IS the cosine. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

function normalize(vec: number[]): Float32Array {
  const out = new Float32Array(vec.length);
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 0;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] * inv;
  return out;
}

function toBase64(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64');
}

function fromBase64(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/** Minimal slice of the transformers.js pipeline we rely on — kept loose so
 *  minor upstream type churn can't break the build. */
type FeatureExtractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ tolist(): number[][] }>;

class LocalBackend implements EmbeddingBackend {
  private extractor: FeatureExtractor | null = null;
  private readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async init(): Promise<void> {
    const transformers = (await import('@huggingface/transformers')) as unknown as {
      pipeline(task: string, model: string): Promise<unknown>;
    };
    this.extractor = (await transformers.pipeline('feature-extraction', this.model)) as FeatureExtractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.extractor) throw new Error('local embedding backend not initialized');
    const output = await this.extractor(texts, { pooling: 'mean', normalize: true });
    return output.tolist();
  }
}

class ProviderBackend implements EmbeddingBackend {
  private readonly settings: VillageSettings;
  private readonly model: string;

  constructor(settings: VillageSettings, model: string) {
    this.settings = settings;
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const url = `${resolveBaseUrl(this.settings.llm)}/embeddings`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.llm.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolveApiKey(this.settings.llm)}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`embeddings HTTP ${resp.status}: ${text.slice(0, 200)}`);
      const parsed = JSON.parse(text) as { data?: Array<{ embedding?: number[]; index?: number }> };
      if (!Array.isArray(parsed.data) || parsed.data.length !== texts.length) {
        throw new Error('embeddings: unexpected response shape');
      }
      const out = new Array<number[]>(texts.length);
      parsed.data.forEach((d, i) => {
        out[d.index ?? i] = d.embedding ?? [];
      });
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-bot vector sidecar
// ---------------------------------------------------------------------------

class Sidecar {
  readonly vectors = new Map<string, Float32Array>();
  dirty = false;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
        for (const [key, b64] of Object.entries(raw)) this.vectors.set(key, fromBase64(b64));
      }
    } catch (err) {
      log('warn', `vector sidecar read failed for ${file}: ${String(err)}`);
    }
  }

  save(): void {
    if (!this.dirty) return;
    try {
      const out: Record<string, string> = {};
      for (const [key, vec] of this.vectors) out[key] = toBase64(vec);
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      log('warn', `vector sidecar write failed for ${this.file}: ${String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface QueueItem {
  bot: string;
  key: string;
  text: string;
}

export class EmbeddingService {
  private readonly settings: VillageSettings;
  private readonly botsDir: string;
  private backend: EmbeddingBackend | null = null;
  private backendInit: Promise<boolean> | null = null;
  private disabled: boolean;
  private consecutiveFailures = 0;
  private embedded = 0;

  private readonly queue: QueueItem[] = [];
  private readonly queuedKeys = new Set<string>();
  private readonly sidecars = new Map<string, Sidecar>();
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** `backendOverride` is the test seam — skips real model/network init. */
  constructor(settings: VillageSettings, backendOverride?: EmbeddingBackend) {
    this.settings = settings;
    this.botsDir = path.join(settings.dataDir, 'bots');
    fs.mkdirSync(this.botsDir, { recursive: true });
    this.disabled = settings.embeddings.mode === 'off' && !backendOverride;
    if (backendOverride) {
      this.backend = backendOverride;
      this.backendInit = Promise.resolve(true);
    }
  }

  forBot(name: string): MemoryVectors {
    return new MemoryVectors(this, name);
  }

  isEnabled(): boolean {
    return !this.disabled;
  }

  stats(): { enabled: boolean; queued: number; embedded: number } {
    return { enabled: !this.disabled, queued: this.queue.length, embedded: this.embedded };
  }

  vectorFor(bot: string, entry: MemoryEntry): Float32Array | null {
    if (this.disabled) return null;
    return this.sidecar(bot).vectors.get(entryKey(entry)) ?? null;
  }

  enqueue(bot: string, entry: MemoryEntry): void {
    if (this.disabled) return;
    const key = entryKey(entry);
    const sidecar = this.sidecar(bot);
    if (sidecar.vectors.has(key)) return;
    const qk = `${bot}/${key}`;
    if (this.queuedKeys.has(qk)) return;
    this.queuedKeys.add(qk);
    this.queue.push({ bot, key, text: entry.text.slice(0, MAX_EMBED_CHARS) });
    this.scheduleDrain();
  }

  remove(bot: string, entry: MemoryEntry): void {
    if (this.disabled) return;
    const sidecar = this.sidecar(bot);
    if (sidecar.vectors.delete(entryKey(entry))) {
      sidecar.dirty = true;
      this.scheduleSave();
    }
  }

  /**
   * Enqueue entries that have no stored vector yet and drop sidecar rows whose
   * entry no longer exists (one-time migration + steady-state pruning). Call
   * with a bot's FULL live entry list (window + archive).
   */
  backfill(bot: string, entries: MemoryEntry[]): void {
    if (this.disabled) return;
    const sidecar = this.sidecar(bot);
    const live = new Set(entries.map((e) => entryKey(e)));
    for (const key of sidecar.vectors.keys()) {
      if (!live.has(key)) {
        sidecar.vectors.delete(key);
        sidecar.dirty = true;
      }
    }
    for (const entry of entries) this.enqueue(bot, entry);
    if (sidecar.dirty) this.scheduleSave();
  }

  /** Embed a retrieval query. Null when disabled/unavailable — caller falls back to keywords. */
  async embedQuery(text: string): Promise<Float32Array | null> {
    if (this.disabled) return null;
    if (!(await this.ensureBackend())) return null;
    try {
      const [vec] = await this.backend!.embed([text.slice(0, MAX_EMBED_CHARS)]);
      this.noteSuccess();
      return normalize(vec);
    } catch (err) {
      this.noteFailure(`query embed failed: ${String(err)}`);
      return null;
    }
  }

  /** Embed everything queued right now (tests + shutdown), skipping the debounce. */
  async drainNow(): Promise<void> {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    await this.drain();
  }

  /** Synchronous best-effort flush of dirty sidecars (shutdown path). */
  flushNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    for (const sidecar of this.sidecars.values()) sidecar.save();
  }

  // -- internals --------------------------------------------------------------

  private sidecar(bot: string): Sidecar {
    let sidecar = this.sidecars.get(bot);
    if (!sidecar) {
      const safe = bot.replace(/[^A-Za-z0-9_-]/g, '_');
      sidecar = new Sidecar(path.join(this.botsDir, `${safe}.vectors.json`));
      this.sidecars.set(bot, sidecar);
    }
    return sidecar;
  }

  private async ensureBackend(): Promise<boolean> {
    if (this.disabled) return false;
    if (!this.backendInit) {
      this.backendInit = (async () => {
        const model = resolveEmbeddingModel(this.settings.embeddings);
        try {
          if (this.settings.embeddings.mode === 'local') {
            const local = new LocalBackend(model);
            await local.init();
            this.backend = local;
          } else {
            this.backend = new ProviderBackend(this.settings, model);
          }
          log('info', `[village] embeddings up (${this.settings.embeddings.mode}/${model})`);
          return true;
        } catch (err) {
          this.disable(`backend init failed (${model}): ${String(err)}`);
          return false;
        }
      })();
    }
    return this.backendInit;
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.draining || this.disabled) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drain();
    }, DRAIN_DELAY_MS);
    this.drainTimer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disabled) return;
    this.draining = true;
    try {
      if (!(await this.ensureBackend())) return;
      while (this.queue.length > 0 && !this.disabled) {
        const batch = this.queue.slice(0, DRAIN_BATCH);
        try {
          const vectors = await this.backend!.embed(batch.map((item) => item.text));
          this.noteSuccess();
          batch.forEach((item, i) => {
            const sidecar = this.sidecar(item.bot);
            sidecar.vectors.set(item.key, normalize(vectors[i] ?? []));
            sidecar.dirty = true;
          });
          this.queue.splice(0, batch.length);
          for (const item of batch) this.queuedKeys.delete(`${item.bot}/${item.key}`);
          this.embedded += batch.length;
          this.scheduleSave();
        } catch (err) {
          this.noteFailure(`batch embed failed: ${String(err)}`);
          break; // keep the queue; retry on the next enqueue/drain
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) this.scheduleDrain();
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      for (const sidecar of this.sidecars.values()) sidecar.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private noteSuccess(): void {
    this.consecutiveFailures = 0;
  }

  private noteFailure(message: string): void {
    this.consecutiveFailures++;
    log('warn', `[village] embeddings: ${message} (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.disable('too many consecutive failures');
    }
  }

  private disable(reason: string): void {
    if (this.disabled) return;
    this.disabled = true;
    this.queue.length = 0;
    this.queuedKeys.clear();
    log('warn', `[village] embeddings DISABLED for this run — ${reason}. Memory retrieval falls back to keywords.`);
  }
}

/** Per-bot facade handed to BotMemory — keeps memory.ts free of service plumbing. */
export class MemoryVectors {
  private readonly service: EmbeddingService;
  private readonly bot: string;

  constructor(service: EmbeddingService, bot: string) {
    this.service = service;
    this.bot = bot;
  }

  enabled(): boolean {
    return this.service.isEnabled();
  }

  enqueue(entry: MemoryEntry): void {
    this.service.enqueue(this.bot, entry);
  }

  remove(entry: MemoryEntry): void {
    this.service.remove(this.bot, entry);
  }

  vectorFor(entry: MemoryEntry): Float32Array | null {
    return this.service.vectorFor(this.bot, entry);
  }

  backfill(entries: MemoryEntry[]): void {
    this.service.backfill(this.bot, entries);
  }

  embedQuery(text: string): Promise<Float32Array | null> {
    return this.service.embedQuery(text);
  }
}
