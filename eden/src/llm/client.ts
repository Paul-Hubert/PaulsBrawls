// The provider-agnostic LLM client (layer 2). One blocking call shape over OpenAI-compatible
// /v1/chat/completions (OpenAI / LM Studio / Ollama all speak it). Two hard-won rules from v1:
//   • R21 — timeouts are NOT retries. A 180 s default timeout (reasoning models exceed 60 s); a
//     timeout throws and is final. Only TCP connection-resets (stale keepalive pools) auto-retry.
//   • 05 — journal `llm.call` with metrics ONLY (caller/model/tier/latency/tokens/finish). NEVER
//     prompt or completion bodies (size + secrets-adjacent); full transcripts go to
//     .eden-data/llm/<callId>.json when debugPrompts is on, referenced by refs.llmCallId.
//
// Imports only journal/ + types/ (downward). The scheduler (M2-L3) wraps this with lanes/budget;
// God desks and villager brains call through the scheduler, never the client directly.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { monotonicFactory } from 'ulid';

import type { Refs } from '../types/index';
import type { JournalAppender } from '../journal/journal';

const ulid = monotonicFactory();

/** A model tier — `strong` for novelty, `fast` for dispatch/reactive/QA (D-13). Distinct from skill Tier. */
export type ModelTier = 'strong' | 'fast';

/** One provider endpoint: where to POST, which model, and its per-call input ceiling (D-11). */
export interface ProviderEntry {
  baseUrl: string;
  model: string;
  inputTokenBudget: number;
}

/** Maps a model tier to its provider config — plain data, wired from EdenConfig in main.ts. */
export class ProviderRegistry {
  constructor(private readonly providers: Record<ModelTier, ProviderEntry>) {}
  get(tier: ModelTier): ProviderEntry {
    return this.providers[tier];
  }
}

/** A tool definition in OpenAI function-calling shape. */
export interface LlmToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

/** A parsed assistant tool call (arguments already JSON-parsed). */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: object;
}

/** One message in the conversation — provider-neutral; the client renders it to wire shape. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Assistant turns that called tools (R20: must be answered by adjacent tool results). */
  toolCalls?: LlmToolCall[];
  /** Tool result turns reference the call they answer. */
  toolCallId?: string;
  /** Optional tool/function name on a tool result. */
  name?: string;
}

/** A single chat request: messages + optional tools, a tier, and who is asking (the journal actor). */
export interface LlmRequest {
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  /**
   * Override the OpenAI `tool_choice` field. When omitted, defaults to `'auto'`.
   * Use `{ type: 'function', function: { name: '...' } }` to force a specific tool call (R52).
   * Only sent when `tools` is non-empty.
   */
  toolChoice?: string | { type: 'function'; function: { name: string } };
  tier: ModelTier;
  /** Who is calling — becomes the journal `actor` and the `llm.call.caller` field (R41). */
  caller: string;
  /** Causality refs folded into the journal event (the call gets its own llmCallId). */
  refs?: Refs;
  /** Per-call timeout override (R21); defaults to the client's timeoutMs. */
  timeoutMs?: number;
}

/** The parsed result of one chat call. */
export interface LlmResult {
  callId: string;
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
  retries: number;
}

/** A call exceeded its wall-clock timeout (R21: NOT retried — fix the blocking work, keep the valve R39). */
export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

/** A non-2xx HTTP response — surfaced, never silently retried (distinct from a retriable reset). */
export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

/** Construction options for {@link LlmClient}. */
export interface LlmClientOptions {
  providers: ProviderRegistry;
  journal: JournalAppender;
  /** HTTP timeout per call (R21). Default 180 s — reasoning models routinely exceed 60 s. */
  timeoutMs?: number;
  /** Retriable-reset attempts before giving up. Default 4 (hardcoded S7). */
  maxRetries?: number;
  /** When true, dump full transcripts to .eden-data/llm/<callId>.json (05). */
  debugPrompts?: boolean;
  dataDir?: string;
  /** Injectable fetch + clock for deterministic tests (R42). */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Bearer token for REMOTE (non-local) providers — sent as `Authorization: Bearer <key>`
   * ONLY when the provider baseUrl is non-local (OpenAI 401s without it; local LM Studio /
   * Ollama need none, so we never leak a key to a local endpoint). Defaults to
   * `process.env.OPENAI_API_KEY`. NEVER sourced from eden.json or the journal — the key lives
   * only in the environment, and the debug transcript dumps the request BODY only (no headers).
   */
  apiKey?: string;
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}
interface WireResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Stale-keepalive TCP resets are retriable noise (R21); a timeout/HTTP error is not. */
const RETRIABLE_CODES = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']);

function codeOf(x: unknown): string | undefined {
  if (x && typeof x === 'object' && 'code' in x) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function isRetriableReset(e: unknown): boolean {
  if (e instanceof LlmTimeoutError || e instanceof LlmHttpError) return false;
  const direct = codeOf(e);
  if (direct && RETRIABLE_CODES.has(direct)) return true;
  if (e && typeof e === 'object' && 'cause' in e) {
    const cause = codeOf((e as { cause?: unknown }).cause);
    if (cause && RETRIABLE_CODES.has(cause)) return true;
  }
  return false;
}

/** A localhost provider (LM Studio/Ollama) needs no auth; a remote one (OpenAI) gets a bearer.
 *  Unparseable URLs are treated as remote — better to send a key than to silently 401. */
function isLocalBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

/** DeepSeek's hybrid models (deepseek-v4-*) default to thinking mode ON (api-docs.deepseek.com/guides/
 *  thinking_mode), and thinking mode rejects a forced `tool_choice` with HTTP 400 "Thinking mode does not
 *  support this tool_choice". Eden's whole desk design FORCES a single tool (R52/R68: critic→verdict,
 *  curriculum→propose_task/decompose), so thinking mode is unusable here — and the reasoning tokens would
 *  only burn the throughput budget (D-13). We turn it off for every DeepSeek call (R71). Host-sniffed for
 *  the same reason auth is (isLocalBaseUrl): the behavior is a property of the endpoint, not a user toggle. */
function isDeepSeekBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return host === 'api.deepseek.com' || host.endsWith('.deepseek.com');
}

/** The OpenAI-compatible chat client. Provider-agnostic; one method, `chat`. */
export class LlmClient {
  private readonly providers: ProviderRegistry;
  private readonly journal: JournalAppender;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly debugPrompts: boolean;
  private readonly dataDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly apiKey: string | undefined;

  constructor(opts: LlmClientOptions) {
    this.providers = opts.providers;
    this.journal = opts.journal;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.debugPrompts = opts.debugPrompts ?? false;
    this.dataDir = opts.dataDir ?? '.eden-data';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  }

  /** One chat completion. Retries ONLY on connection-reset (R21); journals metrics, never bodies. */
  async chat(req: LlmRequest): Promise<LlmResult> {
    const provider = this.providers.get(req.tier);
    const callId = ulid();
    const url = `${provider.baseUrl}/chat/completions`;
    const wireBody: Record<string, unknown> = { model: provider.model, messages: req.messages.map(toWire) };
    if (req.tools && req.tools.length > 0) {
      wireBody['tools'] = req.tools;
      wireBody['tool_choice'] = req.toolChoice ?? 'auto';
    }
    // R71: disable DeepSeek's default-on thinking mode — it 400s on Eden's forced tool_choice and only
    // burns the throughput budget. Top-level field (what the OpenAI SDK's `extra_body` sends over the wire).
    if (isDeepSeekBaseUrl(provider.baseUrl)) {
      wireBody['thinking'] = { type: 'disabled' };
    }
    const started = this.now();
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;

    let retries = 0;
    for (;;) {
      try {
        return await this.attempt(url, wireBody, timeoutMs, callId, started, retries, provider, req);
      } catch (e) {
        if (isRetriableReset(e) && retries < this.maxRetries) {
          retries++;
          continue;
        }
        throw e;
      }
    }
  }

  private async attempt(
    url: string,
    wireBody: Record<string, unknown>,
    timeoutMs: number,
    callId: string,
    started: number,
    retries: number,
    provider: ProviderEntry,
    req: LlmRequest,
  ): Promise<LlmResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Auth header for remote providers only (OpenAI). A local endpoint never receives the key.
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey && !isLocalBaseUrl(provider.baseUrl)) {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(wireBody),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new LlmTimeoutError(
          `llm call ${callId} (${provider.model}) exceeded ${timeoutMs}ms — a timeout is final, not a retry (R21)`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmHttpError(`llm call ${callId} (${provider.model}) HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    const json = (await res.json()) as WireResponse;
    const latencyMs = this.now() - started;
    const choice = json.choices?.[0];
    const toolCalls: LlmToolCall[] = (choice?.message?.tool_calls ?? []).map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? '',
      arguments: parseArgs(tc.function?.arguments),
    }));
    const result: LlmResult = {
      callId,
      content: choice?.message?.content ?? null,
      toolCalls,
      finishReason: choice?.finish_reason ?? 'stop',
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      },
      latencyMs,
      retries,
    };

    this.journal.append(
      req.caller,
      'llm.call',
      {
        caller: req.caller,
        model: provider.model,
        tier: req.tier,
        latencyMs,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        finishReason: result.finishReason,
        retries,
      },
      { ...req.refs, llmCallId: callId },
    );

    if (this.debugPrompts) this.dumpTranscript(callId, wireBody, json);
    return result;
  }

  private dumpTranscript(callId: string, request: object, response: object): void {
    try {
      const dir = join(this.dataDir, 'llm');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${callId}.json`), JSON.stringify({ request, response }, null, 2));
    } catch {
      // Debug dumps are best-effort; never let them break the call path.
    }
  }
}

function toWire(m: LlmMessage): WireMessage {
  const out: WireMessage = { role: m.role, content: m.content };
  if (m.toolCalls && m.toolCalls.length > 0) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  if (m.toolCallId !== undefined) out.tool_call_id = m.toolCallId;
  if (m.name !== undefined) out.name = m.name;
  return out;
}

function parseArgs(raw: string | undefined): object {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as object) : {};
  } catch {
    return {};
  }
}
