// eval/mock-llm.ts — the deterministic scripted mock LLM on its OWN ephemeral port (R42). It serves the
// OpenAI-compatible `/v1/chat/completions` (canned turns in order) + `/v1/embeddings` (stable hash
// vector), so an eval scenario drives the brain/desks with a fixed tool-call script — no real provider,
// no flakiness. This is the runtime twin of tests/fakes/scripted-llm.ts (kept separate so the harness has
// no test-only imports). Reserved-prefix usernames + ambient suppression (roster.ts) + this scripted LLM
// together make eval scenarios fully deterministic.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One scripted tool call the mock returns. */
export interface MockToolCall {
  name: string;
  arguments: object;
}
/** One scripted assistant turn (content and/or tool calls, in order). */
export interface MockTurn {
  content?: string;
  toolCalls?: MockToolCall[];
  finishReason?: 'stop' | 'tool_calls';
}

/** A running mock LLM: its base url (`http://127.0.0.1:<port>/v1`) and a `close`. */
export interface MockLlm {
  readonly url: string;
  readonly port: number;
  /** Every request the mock received (url + parsed body) — scenarios assert on these. */
  readonly requests: Array<{ url: string | undefined; body: unknown }>;
  /** Append more scripted turns mid-scenario. */
  enqueue(...turns: MockTurn[]): void;
  close(): Promise<void>;
}

/** Start the scripted mock LLM on an ephemeral port with an initial turn script. */
export function startMockLlm(turns: MockTurn[] = []): Promise<MockLlm> {
  return new Promise((resolve) => {
    const queue: MockTurn[] = [...turns];
    const requests: Array<{ url: string | undefined; body: unknown }> = [];
    const server: Server = createServer((req, res) => handle(req, res, queue, requests));
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        port,
        requests,
        enqueue: (...t: MockTurn[]) => void queue.push(...t),
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

function handle(req: IncomingMessage, res: ServerResponse, queue: MockTurn[], requests: Array<{ url: string | undefined; body: unknown }>): void {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed: unknown = body ? JSON.parse(body) : {};
    requests.push({ url: req.url, body: parsed });
    if (req.url?.includes('/embeddings')) return respondEmbeddings(parsed, res);
    return respondChat(res, queue);
  });
}

function respondChat(res: ServerResponse, queue: MockTurn[]): void {
  const turn = queue.shift() ?? { content: '(no scripted turn)', finishReason: 'stop' as const };
  const message: Record<string, unknown> = { role: 'assistant', content: turn.content ?? null };
  let finish = turn.finishReason ?? 'stop';
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    message['tool_calls'] = turn.toolCalls.map((tc, i) => ({
      id: `call_${i}`,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
    finish = 'tool_calls';
  }
  send(res, 200, {
    id: 'chatcmpl-eval', object: 'chat.completion', created: 0, model: 'scripted',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function respondEmbeddings(parsed: unknown, res: ServerResponse): void {
  const p = parsed as { input?: unknown };
  const inputs: string[] = Array.isArray(p.input) ? (p.input as string[]) : [String(p.input ?? '')];
  const data = inputs.map((text, index) => ({ object: 'embedding', index, embedding: hashVector(String(text), 16) }));
  send(res, 200, { object: 'list', data, model: 'scripted-embed', usage: { prompt_tokens: 0, total_tokens: 0 } });
}

function send(res: ServerResponse, status: number, json: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(json));
}

function hashVector(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) v[i % dims] += text.charCodeAt(i);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
