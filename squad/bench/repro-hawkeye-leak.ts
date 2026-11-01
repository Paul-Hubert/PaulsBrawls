// Repro (no server): does a bot that hawkEye was loaded on stay in memory after the runtime lets it go? The fight
// benchmark's RSS grew ~1.1 GB per round, ~35 MB (one bot's world) per despawned bot. `freshHawkEye`
// (src/bots/plugins.ts) drops minecrafthawkeye from the require cache and loads it again for every bot, but each new
// module is also pushed onto the createRequire parent's `module.children`, which nobody clears; the copy's
// `loadBot.bot` is the bot it was loaded on. So every bot that ever had the plugin, with its world, would stay.
//
//   cd squad && node --expose-gc --import tsx bench/repro-hawkeye-leak.ts

import { EventEmitter } from 'node:events';
import { Module } from 'node:module';

import { freshHawkEye } from '../src/bots/plugins';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc --import tsx');
const N = 20;
/** Stands for a bot's world: what a real despawned bot would keep alive. */
const WORLD_BYTES = 16 * 1024 * 1024;

// The module that loads minecrafthawkeye (createRequire's parent in plugins.ts), caught on its way through _load.
type Mod = { children: unknown[] };
const loader = Module as unknown as { _load: (request: string, parent: Mod, isMain: boolean) => unknown };
const load = loader._load;
let parentModule: Mod | undefined;
loader._load = function (request, parent, isMain) {
  if (request === 'minecrafthawkeye') parentModule = parent;
  return load.call(this, request, parent, isMain);
};

const refs: Array<WeakRef<object>> = [];
for (let i = 0; i < N; i++) {
  const bot = Object.assign(new EventEmitter(), { username: `Leak${i}`, world: new Uint8Array(WORLD_BYTES) });
  freshHawkEye()(bot as never);
  refs.push(new WeakRef(bot));
}
async function collect(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 50));
    gc?.();
  }
  return refs.filter((r) => r.deref() !== undefined).length;
}
const mb = (n: number): number => Math.round(n / 1048576);
const alive = await collect();
const children = parentModule?.children.length ?? 0;
process.stdout.write(`${alive}/${N} bots still reachable after GC; the loading module holds ${children} children; arrayBuffers ${mb(process.memoryUsage().arrayBuffers)} MB (${mb(N * WORLD_BYTES)} MB if all are kept)
`);
// The suspected retainer: drop those children, and the bots should go.
parentModule?.children.splice(0);
const after = await collect();
process.stdout.write(`after clearing module.children: ${after}/${N} reachable, arrayBuffers ${mb(process.memoryUsage().arrayBuffers)} MB
`);
process.exit(alive > 0 ? 1 : 0);
