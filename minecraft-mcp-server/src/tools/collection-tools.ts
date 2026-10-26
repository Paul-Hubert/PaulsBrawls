import { z } from 'zod';
import type { Bot } from 'mineflayer';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';

// Wraps mineflayer-collectblock's collect() in one MCP tool. The plugin already
// handles the find→path→equip-tool→dig→pick-up-drop loop internally, so all we
// do is locate the targets and hand them off.

export function registerCollectionTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    'collect-block',
    'Collect a number of blocks of a specific type — the bot will pathfind to each, mine it with the best available tool, and pick up the drops.',
    {
      blockType: z.string().describe("Block type name to collect (e.g. 'oak_log', 'stone', 'iron_ore')"),
      count: z.coerce.number().int().positive().optional().describe('How many blocks to collect (default: 1)')
    },
    async ({ blockType, count = 1 }: { blockType: string; count?: number }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const blockInfo = mcData.blocksByName[blockType];

      if (!blockInfo) {
        return factory.createResponse(`Unknown block type: ${blockType}`);
      }

      // Search a wider radius than find-blocks' default (16) — collect-block is
      // a "go do this for me" call, the model shouldn't have to chunk targets
      // when the obvious nearest cluster is 20-30 blocks away.
      const positions = bot.findBlocks({
        matching: blockInfo.id,
        maxDistance: 32,
        count
      });

      if (positions.length === 0) {
        return factory.createResponse(`No ${blockType} found within 32 blocks`);
      }

      // collect() accepts Block | Block[] (lib/CollectBlock.d.ts). Map the
      // positions to Block objects up front — blockAt may return null near the
      // edge of loaded chunks, so filter those out before handing the list off.
      const targets = positions
        .map((pos) => bot.blockAt(pos))
        .filter((b): b is NonNullable<ReturnType<typeof bot.blockAt>> => b !== null);

      if (targets.length === 0) {
        return factory.createResponse(`Found ${positions.length} ${blockType} position(s) but couldn't load the blocks — try again once nearer`);
      }

      // Snapshot the count of this item in inventory before/after so we report
      // what actually landed, not what we asked for. collect() can succeed-then-
      // partial-fail if pathfinding gives up part-way through a queue.
      const itemNameForCount = blockInfo.name;
      const countItem = (): number =>
        bot.inventory.items()
          .filter((it) => it.name === itemNameForCount)
          .reduce((sum, it) => sum + it.count, 0);
      const before = countItem();

      await bot.collectBlock.collect(targets);

      const collected = countItem() - before;
      return factory.createResponse(`Collected ${collected} ${blockType} (requested ${count})`);
    }
  );
}
