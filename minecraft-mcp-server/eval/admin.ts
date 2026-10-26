import type { LedgerEntryLike } from './util.js';

/**
 * Client for the village process's localhost admin API (admin-server.ts):
 * status / per-bot observation / ledger / pause / resume, plus the
 * --test-hooks-only deterministic deliberation trigger.
 */

export interface AdminSkill {
  name: string;
  kind: string;
  version: number;
  status: 'active' | 'disabled';
  errorCount: number;
  lastError?: string;
  description?: string;
}

export interface BotSnapshot {
  name: string;
  connected: boolean;
  position: { x: number; y: number; z: number } | null;
  health: number | null;
  food: number | null;
  inventory: Array<{ item: string; count: number }>;
  skills: AdminSkill[];
  /** The full self-relative observation (time, dayPlan, needs, mood, activeJob, …). */
  observation: Record<string, unknown>;
  recentMemories: Array<{ at: number; kind: string; text: string }>;
  raw: Record<string, unknown>;
}

interface StatusBody {
  ok: boolean;
  scheduler: { pending: number; inFlight: number; completed: number; dropped: number; paused: boolean };
  bots: Array<{ name: string; state: string }>;
}

const REQUEST_TIMEOUT_MS = 5_000;

export class AdminClient {
  constructor(private readonly baseUrl: string) {}

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        ...(body !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
        signal: controller.signal,
      });
      const json = (await resp.json()) as Record<string, unknown>;
      if (!resp.ok || json.ok === false) {
        throw new Error(`admin ${method} ${path} -> HTTP ${resp.status}: ${String(json.error ?? 'unknown')}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  status(): Promise<StatusBody> {
    return this.request('GET', '/village/status') as Promise<StatusBody>;
  }

  async schedulerCompleted(): Promise<number> {
    return (await this.status()).scheduler.completed;
  }

  async connectedBots(): Promise<string[]> {
    const status = await this.status();
    return status.bots.filter((b) => b.state === 'connected').map((b) => b.name);
  }

  async bot(name: string): Promise<BotSnapshot> {
    const body = (await this.request('GET', `/village/bot/${encodeURIComponent(name)}`)) as Record<string, unknown>;
    const observation = (body.observation ?? {}) as Record<string, unknown>;
    const you = (observation.you ?? null) as Record<string, unknown> | null;
    return {
      name,
      connected: observation.connected !== false && you !== null,
      position: you ? (you.position as { x: number; y: number; z: number }) : null,
      health: you ? Number(you.health) : null,
      food: you ? Number(you.food) : null,
      inventory: Array.isArray(observation.inventory)
        ? (observation.inventory as Array<{ item: string; count: number }>)
        : [],
      skills: Array.isArray(body.skills) ? (body.skills as AdminSkill[]) : [],
      observation,
      recentMemories: Array.isArray(body.recentMemories)
        ? (body.recentMemories as Array<{ at: number; kind: string; text: string }>)
        : [],
      raw: body,
    };
  }

  async ledger(): Promise<LedgerEntryLike[]> {
    const body = (await this.request('GET', '/village/ledger')) as { trades?: LedgerEntryLike[] };
    return body.trades ?? [];
  }

  pause(): Promise<unknown> {
    return this.request('POST', '/village/pause');
  }

  resume(): Promise<unknown> {
    return this.request('POST', '/village/resume');
  }

  /** Requires the village process to run with --test-hooks. */
  testThink(bot: string, reason: string, kind: 'player' | 'combat' | 'conversation' | 'job' | 'plan' | 'heartbeat' = 'job'): Promise<unknown> {
    return this.request('POST', '/village/test/think', { bot, reason, kind });
  }
}
