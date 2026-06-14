// ScriptedLLM — a deterministic OpenAI-compatible endpoint (R42). Serves
// `/v1/chat/completions` (canned tool-call / content turns, in order) and `/v1/embeddings`
// (a stable hash vector). Listens on its own ephemeral port so suites never collide.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedToolCall {
  name: string;
  arguments: object;
}
export interface ScriptedTurn {
  content?: string;
  toolCalls?: ScriptedToolCall[];
  finishReason?: 'stop' | 'tool_calls';
  promptTokens?: number;
  completionTokens?: number;
}

export class ScriptedLlm {
  readonly url: string;
  readonly port: number;
  readonly requests: any[] = [];
  private readonly queue: ScriptedTurn[] = [];

  private constructor(
    private readonly server: Server,
    port: number,
  ) {
    this.port = port;
    this.url = `http://127.0.0.1:${port}/v1`;
  }

  static start(turns: ScriptedTurn[] = []): Promise<ScriptedLlm> {
    return new Promise((resolve) => {
      const server = createServer();
      const holder = { llm: null as ScriptedLlm | null };
      server.on('request', (req, res) => holder.llm?.handle(req, res));
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        const llm = new ScriptedLlm(server, port);
        for (const t of turns) llm.queue.push(t);
        holder.llm = llm;
        resolve(llm);
      });
    });
  }

  enqueue(...turns: ScriptedTurn[]): this {
    this.queue.push(...turns);
    return this;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      this.requests.push({ url: req.url, body: parsed });
      if (req.url?.includes('/embeddings')) return this.respondEmbeddings(parsed, res);
      return this.respondChat(res);
    });
  }

  private respondChat(res: ServerResponse): void {
    const turn = this.queue.shift() ?? { content: '(no scripted turn)', finishReason: 'stop' as const };
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
    const out = {
      id: 'chatcmpl-scripted',
      object: 'chat.completion',
      created: 0,
      model: 'scripted',
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: {
        prompt_tokens: turn.promptTokens ?? 10,
        completion_tokens: turn.completionTokens ?? 5,
        total_tokens: (turn.promptTokens ?? 10) + (turn.completionTokens ?? 5),
      },
    };
    send(res, 200, out);
  }

  private respondEmbeddings(parsed: any, res: ServerResponse): void {
    const inputs: string[] = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? ''];
    const data = inputs.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: hashVector(String(text), 16),
    }));
    send(res, 200, { object: 'list', data, model: 'scripted-embed', usage: { prompt_tokens: 0, total_tokens: 0 } });
  }
}

function send(res: ServerResponse, status: number, json: unknown): void {
  const text = JSON.stringify(json);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

/** Deterministic pseudo-embedding so cosine is stable across runs. */
function hashVector(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[i % dims] += text.charCodeAt(i);
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
