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
// A copy must not outlive its bot: the copy's `loadBot.bot` is the bot it was loaded on, with its ~35 MB world. Node
// keeps two links to a loaded module that nothing clears (docs/36 §5.1: +1.1 GB RSS per fight round):
//   • its parent's `module.children`. Each copy loads through a throwaway `createRequire`, which goes with its
//     require function (one long-lived require kept every copy, so every bot that ever had the plugin).
//   • a shared module's first parent (mineflayer, vec3, uuid, detect-collisions stay cached; each keeps the module
//     that loaded it first). One copy is loaded before the first bot's and never given a bot, to be that parent.
// So a copy lives as long as its bot (tests/plugins.test.ts, bench/repro-hawkeye-leak.ts).
let primed = false;

/** minecrafthawkeye's `inject`, from files loaded again through a throwaway parent and dropped from the cache. */
function loadHawkEye(): (bot: Bot, options?: unknown) => void {
  const req = createRequire(import.meta.url);
  const dir = dirname(req.resolve('minecrafthawkeye'));
  for (const k of Object.keys(req.cache)) if (k.startsWith(dir)) delete req.cache[k];
  const m = req('minecrafthawkeye') as { default?: unknown };
  // CJS with `exports.default = inject`.
  const inject = (typeof m === 'function' ? m : m.default) as (bot: Bot, options?: unknown) => void;
  for (const k of Object.keys(req.cache)) if (k.startsWith(dir)) delete req.cache[k];
  return inject;
}

/** A fresh minecrafthawkeye (its own module state) for one bot. */
export function freshHawkEye(): (bot: Bot, options?: unknown) => void {
  if (!primed) {
    primed = true;
    loadHawkEye(); // the first parent of the shared modules, kept for good, with no bot
  }
  return loadHawkEye();
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
