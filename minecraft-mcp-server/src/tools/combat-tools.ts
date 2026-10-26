import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

// Surfaces mineflayer-pvp as two MCP tools. `attack-entity` is fire-and-forget
// — pvp owns its own internal tick loop (range maintenance, swing timing,
// optional pathfinding to follow), so awaiting bot.pvp.attack(target) would
// block until the target dies. We let it run and return to the LLM right away.
// `stop-combat` mirrors that: one call to terminate the loop.

export function registerCombatTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    'attack-entity',
    'Start attacking the nearest entity matching the given target. Combat continues until the entity dies or stop-combat is called.',
    {
      target: z.string().describe("Who to attack — a player username (e.g. 'Paul'), 'player' for the nearest player, 'mob' for the nearest mob, entity type (e.g. 'zombie'), or a substring of entity.name"),
      maxDistance: z.coerce.number().finite().positive().optional().describe('Maximum distance to search for the target (default: 16)')
    },
    async ({ target, maxDistance = 16 }: { target: string; maxDistance?: number }) => {
      const bot = getBot();
      const needle = target.toLowerCase();

      // Matching order: exact-username (so "Paul" targets player Paul specifically),
      // then bucket aliases ('player' / 'mob'), then entity type, then substring on entity.name.
      // Mirrors follow-entity's matching shape.
      const entity = bot.nearestEntity((candidate) => {
        if (candidate === bot.entity) return false;
        const username = (candidate as { username?: string }).username;
        if (username && username.toLowerCase() === needle) return true;
        if (target === 'player') return candidate.type === 'player';
        if (target === 'mob') return candidate.type === 'mob';
        if (candidate.type === target) return true;
        return Boolean(candidate.name && candidate.name.toLowerCase().includes(needle));
      });

      if (!entity) {
        return factory.createResponse(`No entity matching "${target}" found nearby`);
      }

      const distance = bot.entity.position.distanceTo(entity.position);
      if (distance > maxDistance) {
        return factory.createResponse(`No "${target}" found within ${maxDistance} blocks (nearest was ${distance.toFixed(1)} blocks away)`);
      }

      // Fire-and-forget. pvp.attack() returns a Promise that resolves only when
      // the engagement ends — we deliberately don't await it so the LLM gets
      // control back. Stash a .catch so an unhandled-rejection event isn't
      // raised if combat ends with an error after the response is returned.
      void bot.pvp.attack(entity).catch(() => { /* combat-loop errors surface via subsequent tools */ });

      const targetName = (entity as { username?: string }).username || entity.name || entity.type;
      return factory.createResponse(`Engaging ${targetName} at distance ${distance.toFixed(1)} blocks`);
    }
  );

  factory.registerTool(
    'stop-combat',
    'Stop any in-progress attack started by attack-entity.',
    {},
    async () => {
      const bot = getBot();
      await bot.pvp.stop();
      return factory.createResponse('Combat stopped');
    }
  );
}
