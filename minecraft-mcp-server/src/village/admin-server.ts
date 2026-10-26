import http from 'http';
import { log } from '../logger.js';
import { benchmark } from './benchmark.js';
import { VillageContext } from './context.js';
import { Villager } from './villager.js';
import { tokenize } from './memory-index.js';
import { buildObservation } from './observation.js';
import { surveyTerrain } from './terrain.js';
import { MemoryEntry } from './types.js';

/**
 * Localhost admin surface (no auth — mirror of the bridge's posture):
 *   GET  /village/status      — roster, connection states, scheduler stats
 *   GET  /village/metrics     — food-production benchmark counters (benchmark.ts)
 *   GET  /village/skills      — every bot's full skill list INCLUDING code
 *   GET  /village/bot/<name>  — one villager: observation, skills, memory tail
 *   GET  /village/bot/<name>/terrain?radius= — ASCII relief snapshot around the bot
 *   GET  /village/ledger      — recent trades
 *   POST /village/pause       — stop scheduling LLM work (reflexes/routines keep running)
 *   POST /village/resume
 *   POST /village/bot/<name>/tell — { message, from?, wake? } — a "divine voice"
 *     lands in the bot's inbox + memory and (default) wakes a deliberation.
 *     Naming a skill in the message pulls that skill's code into the prompt
 *     (Voyager relevance gating), so a supervisor can steer skill use.
 *   POST /village/broadcast   — { message, from?, wake? } — same, all bots
 * Consumed by the Java mod's /village command, the long-run supervisor, and
 * curious humans.
 *
 * With `testHooks` enabled (the eval harness's `--test-hooks` flag — never on
 * in a normal `npm run village`):
 *   POST /village/test/think  — { bot, reason, kind? } → scheduler.request(...)
 *     so the eval can trigger a deliberation deterministically.
 */

export interface AdminServerOptions {
  testHooks?: boolean;
}

const MAX_BODY_BYTES = 16 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const THINK_KINDS: ReadonlySet<string> = new Set(['player', 'combat', 'conversation', 'job', 'plan', 'heartbeat']);
const MEMORY_KINDS: ReadonlySet<string> = new Set(['event', 'social', 'trade', 'thought', 'system']);

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 1);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

/**
 * The "divine voice": same recipe as bot-host's player-chat path (memory
 * entry + 'player'-priority wake), plus the inbox so the message shows under
 * UNREAD MESSAGES even if another wake-up wins the race.
 */
function tellVillager(ctx: VillageContext, villager: Villager, from: string, message: string, wake: boolean): void {
  villager.pushInbox(from, message);
  villager.memory.append('social', `${from} (voix divine) m'a dit: ${message.slice(0, 200)}`, [from], 7);
  if (wake) {
    ctx.scheduler.request(villager.name, 'player', `${from} (voix divine) me parle: "${message.slice(0, 200)}"`);
  }
  log('info', `[village] ${from} → ${villager.name}: ${message.slice(0, 200)}${wake ? '' : ' (no wake)'}`);
}

export function createAdminServer(
  ctx: VillageContext,
  host: string,
  port: number,
  options: AdminServerOptions = {}
): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const path = url.split('?')[0];

    try {
      if (method === 'GET' && path === '/village/status') {
        writeJson(res, 200, {
          ok: true,
          uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
          scheduler: ctx.scheduler.stats(),
          conversations: ctx.conversations.activeCount(),
          bots: Array.from(ctx.villagers.values()).map((v) => ({
            name: v.name,
            role: v.roster.role,
            state: v.connection.getState(),
            job: v.routines.status()?.name ?? null,
            inConversation: ctx.conversations.get(v.name) !== undefined,
            skills: v.skills.list().length,
          })),
        });
        return;
      }

      if (method === 'GET' && path === '/village/metrics') {
        writeJson(res, 200, { ok: true, ...benchmark.metrics() });
        return;
      }

      if (method === 'GET' && path === '/village/skills') {
        writeJson(res, 200, {
          ok: true,
          bots: Array.from(ctx.villagers.values()).map((v) => ({
            name: v.name,
            role: v.roster.role,
            skills: v.skills.list(),
          })),
        });
        return;
      }

      // More specific than the bare /village/bot/<name> route — check first.
      if (method === 'POST' && path.startsWith('/village/bot/') && path.endsWith('/tell')) {
        const name = decodeURIComponent(path.slice('/village/bot/'.length, -'/tell'.length));
        const villager = ctx.villagers.get(name);
        if (!villager) {
          writeJson(res, 404, { ok: false, error: `no villager named '${name}'` });
          return;
        }
        void readBody(req)
          .then((raw) => {
            const body = JSON.parse(raw || '{}') as { message?: unknown; from?: unknown; wake?: unknown };
            const message = String(body.message ?? '').trim().slice(0, 300);
            if (!message) {
              writeJson(res, 400, { ok: false, error: 'missing message' });
              return;
            }
            const from = String(body.from ?? 'Dieu').trim().slice(0, 24) || 'Dieu';
            const wake = body.wake !== false;
            tellVillager(ctx, villager, from, message, wake);
            writeJson(res, 200, { ok: true, bot: villager.name, woke: wake });
          })
          .catch((err) => {
            writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
          });
        return;
      }

      if (method === 'POST' && path === '/village/broadcast') {
        void readBody(req)
          .then((raw) => {
            const body = JSON.parse(raw || '{}') as { message?: unknown; from?: unknown; wake?: unknown };
            const message = String(body.message ?? '').trim().slice(0, 300);
            if (!message) {
              writeJson(res, 400, { ok: false, error: 'missing message' });
              return;
            }
            const from = String(body.from ?? 'Dieu').trim().slice(0, 24) || 'Dieu';
            const wake = body.wake !== false;
            for (const villager of ctx.villagers.values()) {
              tellVillager(ctx, villager, from, message, wake);
            }
            writeJson(res, 200, { ok: true, bots: Array.from(ctx.villagers.keys()), woke: wake });
          })
          .catch((err) => {
            writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
          });
        return;
      }

      // More specific than the bare /village/bot/<name> route — check first.
      if (method === 'GET' && path.startsWith('/village/bot/') && path.endsWith('/memory')) {
        const name = decodeURIComponent(path.slice('/village/bot/'.length, -'/memory'.length));
        const villager = ctx.villagers.get(name);
        if (!villager) {
          writeJson(res, 404, { ok: false, error: `no villager named '${name}'` });
          return;
        }
        const params = new URL(url, 'http://localhost').searchParams;
        const q = (params.get('q') ?? '').slice(0, 200);
        if (!q.trim()) {
          writeJson(res, 200, {
            ok: true,
            name: villager.name,
            windowSize: villager.memory.windowSize(),
            archiveSize: villager.memory.archiveSize(),
            pendingSummarization: villager.memory.pendingSummarizationCount(),
            archiveTail: villager.memory.archiveTail(10),
          });
          return;
        }
        const kindParam = params.get('kind') ?? undefined;
        const kind = kindParam && MEMORY_KINDS.has(kindParam) ? (kindParam as MemoryEntry['kind']) : undefined;
        const limit = Math.min(50, Math.max(1, Number(params.get('limit')) || 10));
        const now = Date.now();
        writeJson(res, 200, {
          ok: true,
          name: villager.name,
          query: q,
          matches: villager.memory.recall(q, { kind, limit }).map((m) => ({
            at: m.at,
            ageSeconds: Math.floor((now - m.at) / 1000),
            kind: m.kind,
            text: m.text,
            tags: m.tags ?? [],
          })),
          ledger: ctx.persistence.searchLedger(villager.name, tokenize(q), 5),
        });
        return;
      }

      // More specific than the bare /village/bot/<name> route — check first.
      if (method === 'GET' && path.startsWith('/village/bot/') && path.endsWith('/terrain')) {
        const name = decodeURIComponent(path.slice('/village/bot/'.length, -'/terrain'.length));
        const villager = ctx.villagers.get(name);
        if (!villager) {
          writeJson(res, 404, { ok: false, error: `no villager named '${name}'` });
          return;
        }
        const bot = villager.bot();
        if (!bot) {
          writeJson(res, 200, { ok: true, name: villager.name, terrain: 'not in the world right now' });
          return;
        }
        const params = new URL(url, 'http://localhost').searchParams;
        const radiusParam = Number(params.get('radius'));
        const radius = Number.isFinite(radiusParam) && radiusParam > 0 ? radiusParam : undefined;
        writeJson(res, 200, {
          ok: true,
          name: villager.name,
          terrain: surveyTerrain(bot, radius !== undefined ? { radius } : {}),
        });
        return;
      }

      if (method === 'GET' && path.startsWith('/village/bot/')) {
        const name = decodeURIComponent(path.slice('/village/bot/'.length));
        const villager = ctx.villagers.get(name);
        if (!villager) {
          writeJson(res, 404, { ok: false, error: `no villager named '${name}'` });
          return;
        }
        writeJson(res, 200, {
          ok: true,
          name: villager.name,
          roster: villager.roster,
          observation: buildObservation(villager, ctx),
          skills: villager.skills.list().map((s) => ({
            name: s.name, kind: s.kind, version: s.version, status: s.status,
            errorCount: s.errorCount, lastError: s.lastError, description: s.description,
          })),
          memorySummary: villager.memory.summary(),
          recentMemories: villager.memory.recent(20),
          archiveSize: villager.memory.archiveSize(),
          relations: villager.memory.topRelations(10),
        });
        return;
      }

      if (method === 'GET' && path === '/village/ledger') {
        writeJson(res, 200, { ok: true, trades: ctx.persistence.recentLedger(50) });
        return;
      }

      if (method === 'POST' && path === '/village/pause') {
        ctx.scheduler.pause();
        log('info', '[village] LLM scheduling PAUSED via admin API');
        writeJson(res, 200, { ok: true, paused: true });
        return;
      }

      if (method === 'POST' && path === '/village/resume') {
        ctx.scheduler.resume();
        log('info', '[village] LLM scheduling resumed via admin API');
        writeJson(res, 200, { ok: true, paused: false });
        return;
      }

      if (options.testHooks && method === 'POST' && path === '/village/test/think') {
        void readBody(req)
          .then((raw) => {
            const body = JSON.parse(raw || '{}') as { bot?: unknown; reason?: unknown; kind?: unknown };
            const botName = String(body.bot ?? '');
            const reason = String(body.reason ?? '').slice(0, 300);
            const kind = body.kind === undefined ? 'job' : String(body.kind);
            if (!ctx.villagers.has(botName)) {
              writeJson(res, 404, { ok: false, error: `no villager named '${botName}'` });
              return;
            }
            if (!reason) {
              writeJson(res, 400, { ok: false, error: 'missing reason' });
              return;
            }
            if (!THINK_KINDS.has(kind)) {
              writeJson(res, 400, { ok: false, error: `bad kind '${kind}'` });
              return;
            }
            ctx.scheduler.request(botName, kind as Parameters<typeof ctx.scheduler.request>[1], reason);
            log('info', `[village] TEST HOOK think: ${botName} (${kind}) — ${reason}`);
            writeJson(res, 200, { ok: true });
          })
          .catch((err) => {
            writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
          });
        return;
      }

      writeJson(res, 404, { ok: false, error: `no route for ${method} ${path}` });
    } catch (err) {
      writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log('info', `[village] admin API on http://${host}:${port}/village/status`);
      resolve(server);
    });
  });
}
