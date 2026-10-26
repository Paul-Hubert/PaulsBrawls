import { log, logDebug } from '../logger.js';
import { resolveApiKey, resolveBaseUrl } from './config.js';
import { LLMSettings, LLMTier } from './types.js';

/**
 * Minimal OpenAI-compatible chat-completions client. All three providers the
 * Java side already supports (OpenAI, LM Studio, Ollama) speak this protocol,
 * so one fetch wrapper covers the lot — no SDK dependency.
 */

export interface ChatToolCall {
  id: string;
  name: string;
  /** Raw JSON string as returned by the model. */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  content: string;
  toolCalls: ChatToolCall[];
}

export interface ChatOptions {
  /** 'fast' routes to settings.fastModel when configured (M14 latency tiering). */
  tier?: LLMTier;
  /** Debug-log attribution, e.g. 'Margaux/heartbeat'. Logging only — never sent to the provider. */
  tag?: string;
}

/** Pure tier→model resolution, exported for tests. */
export function modelForTier(settings: LLMSettings, tier: LLMTier = 'main'): string {
  return tier === 'fast' && settings.fastModel ? settings.fastModel : settings.model;
}

interface CompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class LLMClient {
  private readonly settings: LLMSettings;

  constructor(settings: LLMSettings) {
    this.settings = settings;
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], opts: ChatOptions = {}): Promise<ChatResult> {
    const url = `${resolveBaseUrl(this.settings)}/chat/completions`;
    const model = modelForTier(this.settings, opts.tier);
    const tag = opts.tag ?? 'llm';
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: this.settings.temperature,
      max_completion_tokens: this.settings.maxTokens,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const approxChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    logDebug(tag, `LLM → ${model} (${opts.tier ?? 'main'}): ${messages.length} messages ~${approxChars} chars, ${tools?.length ?? 0} tools`);
    const startedAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolveApiKey(this.settings)}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await resp.text();
      if (!resp.ok) {
        throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`);
      }
      const parsed = JSON.parse(text) as CompletionsResponse;
      if (parsed.error?.message) throw new Error(`LLM error: ${parsed.error.message}`);
      const message = parsed.choices?.[0]?.message;
      if (!message) throw new Error('LLM returned no choices');

      const toolCalls: ChatToolCall[] = (message.tool_calls ?? [])
        .filter((tc) => tc.function?.name)
        .map((tc, i) => ({
          id: tc.id ?? `call_${i}`,
          name: tc.function?.name ?? '',
          arguments: tc.function?.arguments ?? '{}',
        }));

      const usage = parsed.usage;
      logDebug(
        tag,
        `LLM ← ${model} in ${Date.now() - startedAt}ms: content ${message.content?.length ?? 0} chars, ` +
          `${toolCalls.length} tool call(s)${toolCalls.length > 0 ? ` [${toolCalls.map((tc) => tc.name).join(', ')}]` : ''}` +
          `${usage ? `, tokens ${usage.prompt_tokens ?? '?'}+${usage.completion_tokens ?? '?'}` : ''}` +
          `${parsed.choices?.[0]?.finish_reason ? `, finish=${parsed.choices[0].finish_reason}` : ''}`
      );
      return { content: message.content ?? '', toolCalls };
    } catch (err) {
      const failure = controller.signal.aborted
        ? new Error(`LLM request timed out after ${this.settings.timeoutMs}ms`)
        : err;
      logDebug(tag, `LLM ✗ ${model} after ${Date.now() - startedAt}ms: ${failure instanceof Error ? failure.message : String(failure)}`);
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One-shot helper for summarization-style calls (no tools). */
  async complete(system: string, user: string, opts: ChatOptions = {}): Promise<string> {
    try {
      const result = await this.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        undefined,
        opts
      );
      return result.content;
    } catch (err) {
      log('warn', `LLM complete() failed: ${String(err)}`);
      return '';
    }
  }
}
