// Post-spawn plugin loading, copied from Eden (R15/R16/R17) plus hawkEye for bows.
//   • Named imports for the CJS-with-__esModule trio + native-ESM auto-eat (R15): a default import lands
//     `undefined` under strict ESM loaders.
//   • armor-manager / pathfinder are flagless CJS: default import works. hawkEye ships `exports.default`.
// Each plugin loads independently (R16): one failed load logs a warning, never kills the bot.

import { plugin as pvp } from 'mineflayer-pvp';
import armorManager from 'mineflayer-armor-manager';
import { plugin as tool } from 'mineflayer-tool';
import { plugin as collectBlock } from 'mineflayer-collectblock';
import { loader as autoEat } from 'mineflayer-auto-eat';
import pathfinderPkg from 'mineflayer-pathfinder';
import hawkEyeModule from 'minecrafthawkeye';
import type { Bot } from 'mineflayer';

import { logger } from '../logger';

/** The pre-spawn pathfinder plugin, passed in createBot's `plugins`. */
export const pathfinder = pathfinderPkg.pathfinder;

/** auto-eat options, ported verbatim from v1 through Eden (R17). */
export const AUTO_EAT_OPTS = {
  priority: 'foodPoints',
  minHunger: 15,
  minHealth: 14,
  bannedFood: ['rotten_flesh', 'pufferfish', 'chorus_fruit', 'poisonous_potato', 'spider_eye'],
  returnToLastItem: true,
  offhand: false,
  eatingTimeout: 3000,
} as const;

// minecrafthawkeye is CJS with `exports.default = inject`; under tsx/Node ESM the default import is either the
// function or the namespace holding it.
const hawkEye = (typeof hawkEyeModule === 'function'
  ? hawkEyeModule
  : (hawkEyeModule as unknown as { default: unknown }).default) as unknown;

export interface PluginSet {
  pvp: unknown;
  armorManager: unknown;
  tool: unknown;
  collectBlock: unknown;
  hawkEye: unknown;
  autoEat: unknown;
}

const REAL_PLUGINS: PluginSet = { pvp, armorManager, tool, collectBlock, hawkEye, autoEat };

/** Load the post-spawn plugins (each independently fallible, R16), then configure + enable auto-eat (R17). */
export function loadPlugins(bot: Bot, opts: { plugins?: Partial<PluginSet>; onWarn?: (m: string) => void } = {}): void {
  const set: PluginSet = { ...REAL_PLUGINS, ...opts.plugins };
  const warn = opts.onWarn ?? ((m: string) => logger.warn(`bot:${bot.username}`, m));
  const order: Array<keyof PluginSet> = ['pvp', 'armorManager', 'tool', 'collectBlock', 'hawkEye', 'autoEat'];
  for (const key of order) {
    try {
      bot.loadPlugin(set[key] as Parameters<Bot['loadPlugin']>[0]);
    } catch (err) {
      warn(`plugin "${key}" failed to load: ${err instanceof Error ? err.message : String(err)} (R16)`);
    }
  }
  const ae = (bot as unknown as { autoEat?: { setOpts?: (o: unknown) => void; enableAuto?: () => void } }).autoEat;
  ae?.setOpts?.(AUTO_EAT_OPTS);
  ae?.enableAuto?.();
}
