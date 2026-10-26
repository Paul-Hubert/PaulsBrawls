import { z } from 'zod';
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { ToolFactory } from '../tool-factory.js';

// Surfaces mineflayer-pathfinder's GoalFollow as two MCP tools. `follow-entity`
// is fire-and-forget — pathfinder owns its own internal goal loop and re-paths
// as the target moves (the `dynamic` flag on setGoal). `stop-follow` clears the
// goal. Mirrors the attack-entity / stop-combat shape: one call to start, one
// call to stop, return to the LLM right away.

export function registerFollowTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    'follow-entity',
    'Start continuously following an entity. The bot pathfinds toward the target and re-routes as it moves, until stop-follow is called or another movement tool overrides the goal.',
    {
      target: z.string().describe("Who to follow — a player username (e.g. 'Paul'), 'player' for the nearest player, 'mob' for the nearest mob, or a substring of entity.name (e.g. 'cow')"),
      range: z.coerce.number().finite().positive().optional().describe('How close the bot stays to the target while following, in blocks (default: 2)'),
      maxDistance: z.coerce.number().finite().positive().optional().describe('Maximum distance to search for the target when acquiring it (default: 16)')
    },
    async ({ target, range = 2, maxDistance = 16 }: { target: string; range?: number; maxDistance?: number }) => {
      const bot = getBot();
      const needle = target.toLowerCase();

      // Matching order: exact-username (so "Paul" finds player Paul over a
      // cow-named "Paul"), then the bucket aliases find-entity supports
      // ('player' / 'mob'), then substring on entity.name.
      const entity = bot.nearestEntity((candidate) => {
        if (candidate === bot.entity) return false;
        const username = (candidate as { username?: string }).username;
        if (username && username.toLowerCase() === needle) return true;
        if (target === 'player') return candidate.type === 'player';
        if (target === 'mob') return candidate.type === 'mob';
        return Boolean(candidate.name && candidate.name.toLowerCase().includes(needle));
      });

      if (!entity) {
        return factory.createResponse(`No entity matching "${target}" found nearby`);
      }

      const distance = bot.entity.position.distanceTo(entity.position);
      if (distance > maxDistance) {
        return factory.createResponse(`No "${target}" found within ${maxDistance} blocks (nearest was ${distance.toFixed(1)} blocks away)`);
      }

      // setGoal(goal, true) — the second arg flags the goal as dynamic, so
      // pathfinder re-pathfinds when GoalFollow.hasChanged() returns true (i.e.
      // when the target entity has moved past its tolerance). Fire-and-forget:
      // pathfinder owns the tick loop, no promise to await.
      const goal = new goals.GoalFollow(entity, range);
      bot.pathfinder.setGoal(goal, true);

      const targetName = (entity as { username?: string }).username || entity.name || entity.type;
      return factory.createResponse(`Following ${targetName} at range ${range} (currently ${distance.toFixed(1)} blocks away)`);
    }
  );

  factory.registerTool(
    'stop-follow',
    'Stop following any entity that follow-entity is tracking. Also cancels any other in-progress pathfinder goal (e.g. move-to-position).',
    {},
    async () => {
      const bot = getBot();
      bot.pathfinder.setGoal(null);
      return factory.createResponse('Follow stopped');
    }
  );
}
