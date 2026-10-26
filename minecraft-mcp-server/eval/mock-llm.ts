import http from 'http';

/**
 * The mock LLM (--llm mock, the default): a tiny local HTTP server speaking
 * POST /v1/chat/completions with scripted, deterministic responses. It tests
 * the village plumbing (scheduler, reflexes, conversations, settlement)
 * repeatably and for free; reflex scenarios must pass even when this server
 * returns only errors (mode 'http-500') — that is the degradation guarantee.
 *
 * Scenarios install a handler that receives a PARSED view of each request
 * (who is thinking, why, conversation state) and returns either tool calls or
 * plain content. Unhandled requests get a clean `done` tool call so stray
 * deliberations never hang the village.
 *
 * The parsing + response-shaping functions are pure and unit-tested.
 */

export interface ChatMessageLike {
  role: string;
  content: string | null;
}

export interface ParsedChatRequest {
  /** From the system prompt's "You are <name>, the <role> …". */
  botName: string | null;
  /** From "WHY YOU ARE AWAKE (<kind>):". */
  kind: string | null;
  reasons: string[];
  /** From "=== ACTIVE CONVERSATION with <name> …". */
  inConversationWith: string | null;
  /** The other party has an offer on the table. */
  offerFromOther: boolean;
  /** My own offer is on the table. */
  offerMine: boolean;
  /** True for the first round of a deliberation (no assistant/tool turns yet). */
  isFirstRound: boolean;
  toolResults: string[];
  lastToolResult: string | null;
  messages: ChatMessageLike[];
}

export function parseChatRequest(body: unknown): ParsedChatRequest {
  const messages: ChatMessageLike[] = Array.isArray((body as { messages?: unknown })?.messages)
    ? ((body as { messages: unknown[] }).messages as Array<Record<string, unknown>>).map((m) => ({
        role: String(m.role ?? ''),
        content: typeof m.content === 'string' ? m.content : null,
      }))
    : [];

  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.find((m) => m.role === 'user')?.content ?? '';

  const nameMatch = /^You are (\w+), the/.exec(system);
  const kindMatch = /WHY YOU ARE AWAKE \((\w+)\):/.exec(user);
  const convMatch = /=== ACTIVE CONVERSATION with (\w+)/.exec(user);

  const reasons: string[] = [];
  if (kindMatch) {
    const after = user.slice(user.indexOf(kindMatch[0]) + kindMatch[0].length);
    for (const line of after.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) reasons.push(trimmed.slice(2));
      else if (trimmed === '') {
        if (reasons.length > 0) break;
      } else break;
    }
  }

  const toolResults = messages.filter((m) => m.role === 'tool').map((m) => m.content ?? '');

  return {
    botName: nameMatch ? nameMatch[1] : null,
    kind: kindMatch ? kindMatch[1] : null,
    reasons,
    inConversationWith: convMatch ? convMatch[1] : null,
    offerFromOther: user.includes('OFFER ON THE TABLE from'),
    offerMine: user.includes('YOUR OFFER IS ON THE TABLE'),
    isFirstRound: messages.every((m) => m.role === 'system' || m.role === 'user'),
    toolResults,
    lastToolResult: toolResults.length > 0 ? toolResults[toolResults.length - 1] : null,
    messages,
  };
}

export interface MockToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type MockReply = { toolCalls: MockToolCall[] } | { content: string };

export const DONE_REPLY: MockReply = { toolCalls: [{ name: 'done', args: { summary: '(eval idle)' } }] };

export function toolCalls(...calls: MockToolCall[]): MockReply {
  return { toolCalls: calls };
}

/** Shapes a MockReply as an OpenAI chat-completions response body. */
export function completionResponse(reply: MockReply, model = 'eval-mock'): Record<string, unknown> {
  const message: Record<string, unknown> =
    'content' in reply
      ? { role: 'assistant', content: reply.content }
      : {
          role: 'assistant',
          content: null,
          tool_calls: reply.toolCalls.map((call, i) => ({
            id: `call_eval_${Date.now()}_${i}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        };
  return {
    id: `chatcmpl-eval-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: 'content' in reply ? 'stop' : 'tool_calls' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export type MockHandler = (req: ParsedChatRequest) => MockReply | null;

export type MockMode = 'scripted' | 'http-500';

export class MockLLM {
  private server: http.Server | null = null;
  private handler: MockHandler | null = null;
  mode: MockMode = 'scripted';
  /** Every parsed request, in order — scenarios assert on what the model saw. */
  readonly seen: ParsedChatRequest[] = [];
  requestCount = 0;

  constructor(private readonly logLine: (line: string) => void = () => {}) {}

  setHandler(handler: MockHandler | null): void {
    this.handler = handler;
  }

  /** Back to the idle default: scripted mode, no handler, fresh request log. */
  reset(): void {
    this.handler = null;
    this.mode = 'scripted';
    this.seen.length = 0;
  }

  /** Actual bound port (useful when started with port 0 in tests). */
  port(): number {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : 0;
  }

  start(port: number, host = '127.0.0.1'): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.requestCount++;
        if (this.mode === 'http-500') {
          this.logLine(`[mock-llm] ${req.method} ${req.url} -> 500 (failure mode)`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'eval mock failure mode: everything is broken' } }));
          return;
        }
        if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${req.url}` } }));
          return;
        }
        let reply = DONE_REPLY;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          const parsed = parseChatRequest(body);
          this.seen.push(parsed);
          reply = this.handler?.(parsed) ?? DONE_REPLY;
          const what = 'content' in reply ? `"${reply.content}"` : reply.toolCalls.map((c) => c.name).join('+');
          this.logLine(`[mock-llm] ${parsed.botName ?? '?'} (${parsed.kind ?? '?'}) -> ${what}`);
        } catch (err) {
          this.logLine(`[mock-llm] bad request: ${err instanceof Error ? err.message : String(err)}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(completionResponse(reply)));
      });
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      this.server = null;
    });
  }
}
