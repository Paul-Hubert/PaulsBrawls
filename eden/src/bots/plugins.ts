// Post-spawn plugin loading (R15/R16/R17). This is the ONE module that holds the real
// mineflayer plugin imports, so the import-shape rules live in one place:
//   • Named imports for the CJS-with-__esModule trio + native-ESM auto-eat (R15) — a default
//     import lands `undefined` under strict ESM loaders.
//   • mineflayer-armor-manager / mineflayer-pathfinder are flagless CJS — default import works.
// Each plugin loads independently (R16): one failed load logs a warning, never the bot. The
// auto-eat config is load-bearing and ported VERBATIM from v1 (R17).

import { plugin as pvp } from 'mineflayer-pvp';
import armorManager from 'mineflayer-armor-manager';
import { plugin as tool } from 'mineflayer-tool';
import { plugin as collectBlock } from 'mineflayer-collectblock';
import { loader as autoEat } from 'mineflayer-auto-eat';
import pathfinderPkg from 'mineflayer-pathfinder';

import type { Bot } from '../types/index';
import { logger } from '../logger';

/** The pre-spawn pathfinder plugin — passed in createBot's `plugins` (the only construction-time slot). */
export const pathfinder = pathfinderPkg.pathfinder;

/**
 * auto-eat options, ported VERBATIM from v1 (R17). The two load-bearing fields:
 *   • returnToLastItem — swap the previously-held item back after eating (combat-after-eat).
 *   • bannedFood — never poison the bot while trying to keep it alive.
 * The rest are the README defaults restated so a silent upstream default shift is visible.
 */
export const AUTO_EAT_OPTS = {
  priority: 'foodPoints',
  minHunger: 15,
  minHealth: 14,
  bannedFood: ['rotten_flesh', 'pufferfish', 'chorus_fruit', 'poisonous_potato', 'spider_eye'],
  returnToLastItem: true,
  offhand: false,
  eatingTimeout: 3000,
} as const;

/** The five post-spawn plugins, loaded in v1's order (pvp first, auto-eat last). */
export interface PluginSet {
  pvp: unknown;
  armorManager: unknown;
  tool: unknown;
  collectBlock: unknown;
  autoEat: unknown;
}

/** The real plugins. Tests inject fakes to exercise the fallible-load path without real wiring. */
const REAL_PLUGINS: PluginSet = { pvp, armorManager, tool, collectBlock, autoEat };

export interface LoadPluginsOptions {
  /** Override the plugin set (tests). Missing keys fall back to the real plugin. */
  plugins?: Partial<PluginSet>;
  /** Warning sink — defaults to the logger (R16/R41). */
  onWarn?: (message: string) => void;
}

/**
 * Load the post-spawn plugins, each independently fallible (R16), then configure + enable
 * auto-eat (R17). Loading order matches v1; a failed plugin logs and is skipped so the bot
 * stays online with whatever loaded.
 */
export function loadPlugins(bot: Bot, opts: LoadPluginsOptions = {}): void {
  const set: PluginSet = { ...REAL_PLUGINS, ...opts.plugins };
  const warn = opts.onWarn ?? ((m: string) => logger.warn(`bot:${bot.username}`, m));

  // Order is v1's: pvp, armor-manager, tool, collectblock, auto-eat.
  const order: Array<keyof PluginSet> = ['pvp', 'armorManager', 'tool', 'collectBlock', 'autoEat'];
  for (const key of order) {
    try {
      bot.loadPlugin(set[key]);
    } catch (err) {
      // R16: one failed load is a warning, not a crashed bot.
      warn(`plugin "${key}" failed to load: ${err instanceof Error ? err.message : String(err)} (R16)`);
    }
  }

  // auto-eat needs explicit activation; the loader only wires the class (R17).
  bot.autoEat?.setOpts?.(AUTO_EAT_OPTS);
  bot.autoEat?.enableAuto();
}
