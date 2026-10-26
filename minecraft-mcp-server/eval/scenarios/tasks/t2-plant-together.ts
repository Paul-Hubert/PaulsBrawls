import { ARENA } from '../../fixture.js';
import { toolCalls, type MockHandler } from '../../mock-llm.js';
import type { EvalContext, Scenario } from '../../types.js';
import { pollUntil } from '../../util.js';
import { parkAllExcept, settle, sweepScenario } from '../helpers.js';

/**
 * T2 plant-together — a two-villager cooperative task: ten wheat seeds must
 * end up planted on a shared farmland row. Cooperation is enforced by
 * CONSTRUCTION, not by wording: each farmer is given exactly five seeds, so
 * ten planted crops are only reachable if both do their half.
 *
 * Planting uses the regular `place` tool with wheat_seeds against farmland —
 * the same mechanism the stock farm-loop/farm-setup routines use
 * (actions.placeBlock equips the item and places against the block below).
 * The farmers stand within placement reach (≤4.5 blocks) of all their spots
 * so nobody pathfinds across the row and tramples it.
 *
 * Mock mode scripts one batch of five `place` calls per farmer, then `done`;
 * --llm real hands each farmer its seed count and exact positions in the
 * wake-up reason and lets the provider plan. Either way the assert is the
 * world, polled by RCON: all ten positions must hold a wheat crop.
 */

const FARMER_A = 'EvalMargaux';
const FARMER_B = 'EvalFirmin';
const TAG = 'eval_t2';

export const T2_GOAL_MARKER = 'EVAL_TASK: plantation à deux';

/** One 10-block farmland row south of the arena center, water trench behind
 *  it for hydration; each farmer owns five adjacent positions. */
const ROW_Y = ARENA.center.y; // crops sit at stand level, farmland one below
const ROW_Z = ARENA.center.z + 6;
const ROW_MIN_X = ARENA.center.x - 6;
const ROW_MAX_X = ROW_MIN_X + 9;

export const T2_SPOTS: Record<string, Array<{ x: number; z: number }>> = {
  [FARMER_A]: Array.from({ length: 5 }, (_, i) => ({ x: ROW_MIN_X + i, z: ROW_Z })),
  [FARMER_B]: Array.from({ length: 5 }, (_, i) => ({ x: ROW_MIN_X + 5 + i, z: ROW_Z })),
};

/** Standing spots two blocks north of the row, centered on each half — every
 *  assigned position stays within the 4.5-block placement reach. */
const STANDS: Record<string, { x: number; z: number }> = {
  [FARMER_A]: { x: ROW_MIN_X + 2, z: ROW_Z - 2 },
  [FARMER_B]: { x: ROW_MIN_X + 7, z: ROW_Z - 2 },
};

/** Pure per-farmer state machine (pinned by tests/eval-tasks.test.ts): one
 *  batch of five seed placements, then done — the world assert is the
 *  authority on success, not the tool results. */
export function buildPlantTogetherHandler(): MockHandler {
  return (req) => {
    if (req.kind !== 'job') return null;
    if (!req.reasons.some((r) => r.includes(T2_GOAL_MARKER))) return null;
    const spots = req.botName ? T2_SPOTS[req.botName] : undefined;
    if (!spots) return null;
    if (req.toolResults.length >= spots.length) {
      return toolCalls({ name: 'done', args: { summary: 'Mes cinq graines sont en terre.', mood: 'Satisfait' } });
    }
    return toolCalls(
      ...spots.map((s) => ({ name: 'place', args: { item: 'wheat_seeds', x: s.x, y: ROW_Y, z: s.z } }))
    );
  };
}

export const t2PlantTogether: Scenario = {
  id: 'T2',
  name: 'plant-together',
  suite: 'tasks',
  timeoutMs: 90_000,

  async setup(ctx: EvalContext): Promise<void> {
    await parkAllExcept(ctx, [FARMER_A, FARMER_B]);
    // Fresh plot: clear the airspace, lay farmland, hydrate from behind.
    await ctx.rcon.send(`fill ${ROW_MIN_X} ${ROW_Y} ${ROW_Z} ${ROW_MAX_X} ${ROW_Y} ${ROW_Z + 1} minecraft:air`);
    await ctx.rcon.send(`fill ${ROW_MIN_X} ${ROW_Y - 1} ${ROW_Z} ${ROW_MAX_X} ${ROW_Y - 1} ${ROW_Z} minecraft:farmland`);
    await ctx.rcon.send(`fill ${ROW_MIN_X} ${ROW_Y - 1} ${ROW_Z + 1} ${ROW_MAX_X} ${ROW_Y - 1} ${ROW_Z + 1} minecraft:water`);
    for (const name of [FARMER_A, FARMER_B]) {
      await ctx.rcon.tp(name, STANDS[name].x, ARENA.center.y, STANDS[name].z);
      await ctx.rcon.clearInventory(name);
      await ctx.rcon.give(name, 'minecraft:wheat_seeds', 5);
    }
    await settle();
    ctx.mock?.reset();
    ctx.mock?.setHandler(buildPlantTogetherHandler());
  },

  async trigger(ctx: EvalContext): Promise<void> {
    for (const name of [FARMER_A, FARMER_B]) {
      const spots = T2_SPOTS[name];
      const positions = spots.map((s) => `(${s.x},${ROW_Y},${s.z})`).join(' ');
      await ctx.admin.testThink(
        name,
        `${T2_GOAL_MARKER} — tu as 5 graines de blé (wheat_seeds); plante-les avec place sur la terre labourée devant toi, une par position: ${positions}. Ton partenaire plante les 5 autres — à vous deux il faut 10 plants.`,
        'job'
      );
    }
  },

  async assert(ctx: EvalContext): Promise<void> {
    const all = [...T2_SPOTS[FARMER_A], ...T2_SPOTS[FARMER_B]];
    await pollUntil({ label: 'T2 ten wheat crops on the shared row', timeoutMs: this.timeoutMs, intervalMs: 2_000 }, async () => {
      let planted = 0;
      for (const s of all) {
        const resp = await ctx.rcon.send(`execute if block ${s.x} ${ROW_Y} ${s.z} minecraft:wheat`);
        if (!/Test failed/i.test(resp)) planted++;
      }
      return { done: planted >= all.length, detail: `planted ${planted}/${all.length}` };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    ctx.mock?.reset();
    // Remove crops, then restore the ground (also swallows the water trench).
    await ctx.rcon.send(`fill ${ROW_MIN_X} ${ROW_Y} ${ROW_Z} ${ROW_MAX_X} ${ROW_Y} ${ROW_Z + 1} minecraft:air`);
    await ctx.rcon.send(`fill ${ROW_MIN_X} ${ROW_Y - 1} ${ROW_Z} ${ROW_MAX_X} ${ROW_Y - 1} ${ROW_Z + 1} minecraft:grass_block`);
    for (const name of [FARMER_A, FARMER_B]) {
      await ctx.rcon.clearInventory(name);
    }
    await sweepScenario(ctx, TAG);
  },
};
