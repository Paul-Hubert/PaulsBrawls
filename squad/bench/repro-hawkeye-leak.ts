// Repro (no server): does a bot that hawkEye was loaded on stay in memory after the runtime lets it go? The fight
// benchmark's RSS grew ~1.1 GB per round, ~35 MB (one bot's world) per despawned bot. `freshHawkEye`
// (src/bots/plugins.ts) drops minecrafthawkeye from the require cache and loads it again for every bot, but each new
// module was also pushed onto the createRequire parent's `module.children`, which nobody clears; the copy's
// `loadBot.bot` is the bot it was loaded on. So every bot that ever had the plugin, with its world, stayed. A second
// link kept the FIRST bot: a shared module (mineflayer, vec3, uuid, detect-collisions) keeps the module that loaded
// it first. Fixed (docs/36 §5.1): each copy loads through a throwaway parent, and a primed copy with no bot is that
// first parent (it is the one child the live loading modules still hold). Exits 1 while any bot stays reachable.
//
//   cd squad && node --expose-gc --import tsx bench/repro-hawkeye-leak.ts
//
// The repro holds nothing of what it measures: the bots are made in a function and the loading modules are held
// through WeakRefs. Its first version made the bots in a top-level loop, whose frame kept the last one: its "2/20
// with the children cleared" were bot 19 (that frame) and bot 0 (the first-parent link).

import { EventEmitter } from 'node:events';
import { Module } from 'node:module';

import { freshHawkEye } from '../src/bots/plugins';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc --import tsx');
const N = 20;
/** Stands for a bot's world: what a real despawned bot would keep alive. */
const WORLD_BYTES = 16 * 1024 * 1024;

// The modules that load minecrafthawkeye (createRequire's parents in plugins.ts), caught on their way through _load.
type Mod = { children: unknown[] };
const loader = Module as unknown as { _load: (request: string, parent: Mod, isMain: boolean) => unknown };
const load = loader._load;
const parents: Array<WeakRef<Mod>> = [];
loader._load = function (request, parent, isMain) {
  if (request === 'minecrafthawkeye' && !parents.some((p) => p.deref() === parent)) parents.push(new WeakRef(parent));
  return load.call(this, request, parent, isMain);
};

/** One bot with hawkEye loaded on it, which the runtime then lets go. */
function loadOne(i: number): WeakRef<object> {
  const bot = Object.assign(new EventEmitter(), { username: `Leak${i}`, world: new Uint8Array(WORLD_BYTES) });
  freshHawkEye()(bot as never);
  return new WeakRef(bot);
}
const refs: Array<WeakRef<object>> = [];
for (let i = 0; i < N; i++) refs.push(loadOne(i));

async function collect(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 50));
    gc?.();
  }
  return refs.filter((r) => r.deref() !== undefined).length;
}
const heldChildren = (): number => parents.reduce((n, p) => n + (p.deref()?.children.length ?? 0), 0);
const mb = (n: number): number => Math.round(n / 1048576);
const alive = await collect();
process.stdout.write(`${alive}/${N} bots still reachable after GC; the loading modules still alive hold ${heldChildren()} children; arrayBuffers ${mb(process.memoryUsage().arrayBuffers)} MB (${mb(N * WORLD_BYTES)} MB if all are kept)
`);
// The first link: drop those children, and only the first-parent link can still hold a bot (bot 0, before the fix).
for (const p of parents) p.deref()?.children.splice(0);
const after = await collect();
process.stdout.write(`after clearing module.children: ${after}/${N} reachable, arrayBuffers ${mb(process.memoryUsage().arrayBuffers)} MB
`);
process.exit(alive > 0 ? 1 : 0);
