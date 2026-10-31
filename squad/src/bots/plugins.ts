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
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

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

// minecrafthawkeye keeps its state in module variables: the bot it drives (`loadBot.bot`, the LAST bot that loaded
// the plugin), the target, the drawn bow. One process runs every squad bot, so with one shared copy
// `archer.hawkEye.oneShot(t)` aimed and drew the bow of whichever bot logged in last (found after a 20-bot fight:
// archers mostly fell back to the slow manual shot, and one bot turned toward everyone's targets). Each bot gets its
// own copy of the module instead: its files are dropped from the require cache and loaded again for every bot.
const requireHere = createRequire(import.meta.url);

/** A fresh minecrafthawkeye (its own module state) for one bot. */
export function freshHawkEye(): (bot: Bot, options?: unknown) => void {
  const dir = dirname(requireHere.resolve('minecrafthawkeye'));
  for (const k of Object.keys(requireHere.cache)) if (k.startsWith(dir)) delete requireHere.cache[k];
  const m = requireHere('minecrafthawkeye') as { default?: unknown };
  // CJS with `exports.default = inject`.
  const inject = (typeof m === 'function' ? m : m.default) as (bot: Bot, options?: unknown) => void;
  for (const k of Object.keys(requireHere.cache)) if (k.startsWith(dir)) delete requireHere.cache[k];
  return inject;
}

/** The plugin: a new copy of hawkEye per bot it is loaded on. */
function hawkEye(bot: Bot, options?: unknown): void {
  freshHawkEye()(bot, options);
}

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
