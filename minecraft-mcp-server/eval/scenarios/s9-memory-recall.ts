import fs from 'fs';
import path from 'path';
import { ARENA } from '../fixture.js';
import type { EvalContext, Scenario } from '../types.js';
import { pollUntil } from '../util.js';
import { parkAllExcept, settle, sweepScenario } from './helpers.js';

/**
 * S9 memory-recall (M10) — the retrieval triple, end to end. The miner's
 * state file is pre-seeded with ONE high-importance "diamond find" memory
 * buried under 60 noise entries, so it is far outside the RECENT MEMORIES
 * window. A player-question deliberation about diamonds must surface it in
 * the prompt's RELEVANT OLDER MEMORIES block — and surface nothing else
 * (the noise shares no keywords, so MIN_RELEVANCE filters it).
 *
 * Runs with embeddings OFF (village.test.json) so the ranking is the
 * deterministic keyword+importance+recency path; the semantic path is pinned
 * by unit tests with a fake backend instead.
 */

const MINER = 'EvalCaillou';
const TAG = 'eval_s9';
const TREASURE_TEXT = "j'ai trouvé un filon de diamants sous le grand chêne au nord de la mine";
const NOISE_COUNT = 60;

export const s9MemoryRecall: Scenario = {
  id: 'S9',
  name: 'memory-recall',
  suite: 'reflex',
  timeoutMs: 30_000,
  mockOnly: true, // asserts on the exact prompt the (mock) model received

  async preBoot({ dataDir }): Promise<void> {
    const botsDir = path.join(dataDir, 'bots');
    fs.mkdirSync(botsDir, { recursive: true });
    const now = Date.now();
    const memories = [
      {
        at: now - 60 * 60 * 1_000,
        kind: 'event',
        text: TREASURE_TEXT,
        tags: ['diamant', 'filon', 'chene', 'mine'],
        importance: 9,
      },
      ...Array.from({ length: NOISE_COUNT }, (_, i) => ({
        at: now - 50 * 60 * 1_000 + i * 1_000,
        kind: 'event' as const,
        text: `inspection de routine du tunnel secteur${i}`,
        tags: [`secteur${i}`, 'tunnel'],
        importance: 2,
      })),
    ];
    fs.writeFileSync(
      path.join(botsDir, `${MINER}.json`),
      JSON.stringify({ skills: [], memories, memorySummary: '', relations: {} }, null, 1),
      'utf8'
    );
  },

  async setup(ctx: EvalContext): Promise<void> {
    await parkAllExcept(ctx, [MINER]);
    await ctx.rcon.tp(MINER, ARENA.center.x, ARENA.center.y, ARENA.center.z);
    await settle();
    ctx.mock?.reset(); // no handler needed — DONE_REPLY; we assert on what the model SAW
  },

  async trigger(ctx: EvalContext): Promise<void> {
    await ctx.admin.testThink(MINER, 'le joueur Paul demande: où as-tu vu des diamants ?', 'player');
  },

  async assert(ctx: EvalContext): Promise<void> {
    await pollUntil({ label: 'S9 buried memory surfaced', timeoutMs: this.timeoutMs, intervalMs: 500 }, async () => {
      const req = ctx.mock?.seen.find((r) => r.botName === MINER && r.kind === 'player');
      if (!req) return { done: false, detail: 'no player deliberation reached the mock yet' };

      const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
      const recallBlock = user.split('RELEVANT OLDER MEMORIES')[1]?.split('\n\n')[0] ?? '';
      const surfaced = recallBlock.includes('filon de diamants');
      const recentHasIt = (user.split('RECENT MEMORIES')[1] ?? '').includes('filon de diamants');
      const noiseLeaked = recallBlock.includes('inspection de routine');
      return {
        done: surfaced && !recentHasIt && !noiseLeaked,
        detail: `surfacedInRecall=${surfaced} leakedIntoRecent=${recentHasIt} noiseLeaked=${noiseLeaked}`,
      };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    ctx.mock?.reset();
    await sweepScenario(ctx, TAG);
  },
};
