import { ARENA } from '../../fixture.js';
import { toolCalls, type MockHandler } from '../../mock-llm.js';
import type { EvalContext, Scenario } from '../../types.js';
import { pollUntil } from '../../util.js';
import { parkAllExcept, settle, sweepScenario } from '../helpers.js';

/**
 * T1 get-crafting-table — first scenario of the `tasks` suite (higher-level
 * tasks): a full gather→craft pipeline driven by deliberation tools, graded
 * purely on the outcome (authoritative `data get` inventory), never on
 * wording.
 *
 * Distilled from a live June 2026 run where a lone roster crafter felled
 * wood, made planks and produced a crafting table in ~3 minutes. Here the
 * same pipeline must hold in the isolation arena (the village platform
 * already has a crafting table at the crafter's workstation, so the arena
 * keeps the goal honest): two oak trunks are planted near the bot, a
 * test-hook think hands it the goal, and the bot must end up HOLDING a
 * crafting_table.
 *
 * Mock mode scripts the canonical four-round tool chain
 * (collect_blocks → craft planks → craft table → done) and so proves the
 * action plumbing; --llm real lets the provider plan the same task with the
 * identical outcome assert.
 */

const CRAFTER = 'EvalEnclume';
const TAG = 'eval_t1';

export const T1_GOAL_MARKER = 'EVAL_TASK: table de craft';

/** Two 2-high oak trunks a short walk from the arena center — four logs, so
 *  the planks still work out even if the bot only fells one trunk. */
const TRUNKS = [
  { x: ARENA.center.x + 6, z: ARENA.center.z },
  { x: ARENA.center.x + 8, z: ARENA.center.z + 2 },
];
const TRUNK_HEIGHT = 2;

/** The pure state machine the mock walks: each round keys off the
 *  accumulated tool results (strings produced by agent-tools.ts). Exported so
 *  tests/eval-tasks.test.ts can pin it. */
export function buildCraftingTableHandler(): MockHandler {
  return (req) => {
    if (req.botName !== CRAFTER || req.kind !== 'job') return null;
    if (!req.reasons.some((r) => r.includes(T1_GOAL_MARKER))) return null;
    const results = req.toolResults;
    if (results.some((r) => r.includes('crafted crafting_table'))) {
      return toolCalls({ name: 'done', args: { summary: 'Table de craft en poche.', mood: 'Fier' } });
    }
    if (results.some((r) => r.includes('crafted oak_planks'))) {
      return toolCalls({ name: 'craft', args: { item: 'crafting_table', count: 1 } });
    }
    if (results.some((r) => r.includes('collected') && r.includes('oak_log'))) {
      // craft's count = OUTPUT items (June 2026 semantics fix); asking for 1
      // plank still runs the recipe once, which yields the 4 the table needs.
      return toolCalls({ name: 'craft', args: { item: 'oak_planks', count: 1 } });
    }
    // First round, or a failed collect (ERROR result) — (re)try the gather.
    return toolCalls({ name: 'collect_blocks', args: { blockType: 'oak_log', count: 2 } });
  };
}

export const t1GetCraftingTable: Scenario = {
  id: 'T1',
  name: 'get-crafting-table',
  suite: 'tasks',
  timeoutMs: 90_000,

  async setup(ctx: EvalContext): Promise<void> {
    await parkAllExcept(ctx, [CRAFTER]);
    await ctx.rcon.tp(CRAFTER, ARENA.center.x, ARENA.center.y, ARENA.center.z);
    await ctx.rcon.clearInventory(CRAFTER);
    for (const trunk of TRUNKS) {
      for (let dy = 0; dy < TRUNK_HEIGHT; dy++) {
        await ctx.rcon.send(`setblock ${trunk.x} ${ARENA.center.y + dy} ${trunk.z} minecraft:oak_log`);
      }
    }
    await settle();
    ctx.mock?.reset();
    ctx.mock?.setHandler(buildCraftingTableHandler());
  },

  async trigger(ctx: EvalContext): Promise<void> {
    await ctx.admin.testThink(
      CRAFTER,
      `${T1_GOAL_MARKER} — récolte le bois proche, fabrique des planches puis une table de craft, et garde-la dans ton inventaire`,
      'job'
    );
  },

  async assert(ctx: EvalContext): Promise<void> {
    await pollUntil({ label: 'T1 crafting_table in inventory', timeoutMs: this.timeoutMs, intervalMs: 2_000 }, async () => {
      const inventory = await ctx.rcon.inventory(CRAFTER);
      const count = inventory['crafting_table'] ?? 0;
      return { done: count >= 1, detail: `inventory=${JSON.stringify(inventory)}` };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    ctx.mock?.reset();
    for (const trunk of TRUNKS) {
      for (let dy = 0; dy < TRUNK_HEIGHT; dy++) {
        await ctx.rcon.send(`setblock ${trunk.x} ${ARENA.center.y + dy} ${trunk.z} minecraft:air`);
      }
    }
    await ctx.rcon.clearInventory(CRAFTER);
    await sweepScenario(ctx, TAG);
  },
};
