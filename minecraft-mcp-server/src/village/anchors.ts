import { Vec3 } from 'vec3';
import { log, logDebug } from '../logger.js';
import * as actions from './actions.js';
import type { Villager } from './villager.js';

/**
 * Boot-time validation of a bot's world anchors (home + chest).
 *
 * The roster file asserts coordinates for a world that may have been
 * regenerated, edited, or built differently since the file was written —
 * historically the village would then loop forever on "no chest at (x,y,z)"
 * and unreachable home walks, burning pathfinder timeouts and LLM wake-ups.
 * This pass runs ONCE per bot per process, right after the first spawn:
 *
 *  1. Walk near home (loads the chunks), then snap home's y onto real
 *     standable ground (roster files love y=64; the world rarely agrees).
 *  2. Verify the configured chest block exists; if not, adopt the nearest
 *     chest around the configured point (or around the bot) and persist it.
 *  3. When an anchor is beyond saving, say so LOUDLY exactly once — an
 *     admin log line plus one high-importance memory the next deliberation
 *     will see — instead of erroring forever.
 */

const ANCHOR_WALK_TIMEOUT_MS = 45_000;
const HOME_SNAP_RANGE = 8;
const CHEST_SEARCH_RADIUS = 16;

export async function validateAnchors(villager: Villager): Promise<void> {
  try {
    await validateHome(villager);
  } catch (err) {
    logDebug(villager.name, `anchor check: home validation crashed: ${String(err)}`);
  }
  try {
    await validateChest(villager);
  } catch (err) {
    logDebug(villager.name, `anchor check: chest validation crashed: ${String(err)}`);
  }
}

async function validateHome(villager: Villager): Promise<void> {
  if (!villager.homeAnchor()) {
    // No home in roster or persisted overrides — capture spawn position so
    // night-shelter and day-planner have a safe location to return to.
    // The LLM can override later via set_home.
    const bot = villager.bot();
    if (bot) {
      const pos = bot.entity.position;
      villager.setHomeAnchor(
        { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
        'aucune maison configurée — position de spawn utilisée par défaut'
      );
    }
    return;
  }
  const home = villager.homeAnchor()!;
  let walked = false;
  try {
    await villager.runExclusive(() =>
      actions.goTo(villager.requireBot(), home.x, home.y, home.z, 3, ANCHOR_WALK_TIMEOUT_MS)
    );
    walked = true;
    logDebug(villager.name, `anchor check: home (${home.x},${home.y},${home.z}) reachable`);
  } catch (err) {
    logDebug(
      villager.name,
      `anchor check: walk to home (${home.x},${home.y},${home.z}) failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const bot = villager.bot();
  if (!bot) return;
  const standY = actions.standableYNear(bot, home, HOME_SNAP_RANGE);
  if (standY !== null && standY !== home.y) {
    villager.setHomeAnchor(
      { x: home.x, y: standY, z: home.z },
      `le sol réel est à y=${standY}, pas y=${home.y}`
    );
  } else if (standY === null && !walked) {
    log(
      'warn',
      `[village] ${villager.name} home (${home.x},${home.y},${home.z}) is unreachable and has no standable ground within ±${HOME_SNAP_RANGE} — fix the roster or have the bot set_home`
    );
    villager.memory.append(
      'system',
      `ma maison configurée (${home.x},${home.y},${home.z}) est inaccessible — il m'en faut une autre (set_home quelque part de sûr)`,
      ['maison'],
      7
    );
  }
}

async function validateChest(villager: Villager): Promise<void> {
  const chest = villager.chestAnchor();
  if (!chest) return; // no chest configured — deposit/withdraw already search near the bot

  // Load the area before concluding anything: blockAt() returns null for
  // unloaded chunks, which is "I can't see" — not "it doesn't exist".
  try {
    await villager.runExclusive(async () => {
      const bot = villager.requireBot();
      if (bot.entity.position.distanceTo(new Vec3(chest.x, chest.y, chest.z)) > 6) {
        await actions.goTo(bot, chest.x, chest.y, chest.z, 3, ANCHOR_WALK_TIMEOUT_MS);
      }
    });
  } catch (err) {
    logDebug(
      villager.name,
      `anchor check: walk to chest (${chest.x},${chest.y},${chest.z}) failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const bot = villager.bot();
  if (!bot) return;
  if (actions.isChestBlock(bot.blockAt(new Vec3(chest.x, chest.y, chest.z)))) {
    logDebug(villager.name, `anchor check: chest (${chest.x},${chest.y},${chest.z}) confirmed`);
    return;
  }

  const found =
    actions.findChestNear(bot, chest, CHEST_SEARCH_RADIUS) ??
    actions.findChestNear(bot, bot.entity.position, CHEST_SEARCH_RADIUS);
  if (found) {
    villager.setChestAnchor(
      { x: found.position.x, y: found.position.y, z: found.position.z },
      `le coffre configuré (${chest.x},${chest.y},${chest.z}) n'existe pas — j'ai trouvé celui-ci à la place`
    );
    return;
  }

  log(
    'warn',
    `[village] ${villager.name} chest (${chest.x},${chest.y},${chest.z}) does not exist and no chest stands within ${CHEST_SEARCH_RADIUS} blocks — place one (or run setup-wood-village.mjs), or have the bot set_chest`
  );
  villager.memory.append(
    'system',
    `mon coffre configuré (${chest.x},${chest.y},${chest.z}) N'EXISTE PAS et aucun coffre n'est visible à moins de ${CHEST_SEARCH_RADIUS} blocs — je dois en fabriquer/placer un (8 planches) puis set_chest, ou demander de l'aide`,
    ['coffre'],
    8
  );
}
