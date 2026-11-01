// docs/36 §5.1: `freshHawkEye` loads a copy of minecrafthawkeye for every bot, and the copy keeps the bot it was loaded
// on (`loadBot.bot`). Node kept every copy (the loading module's `module.children`, and a shared module's first
// parent), so every bot that ever had the plugin stayed in memory with its world: +1.1 GB RSS per fight round. A bot
// the runtime lets go must be collected with its copy; a bot still in use keeps a working one. Needs `gc()`: exposed
// at run time (`--expose-gc` set through v8, then read from a new context), so `npm test` runs it as is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { Vec3 } from 'vec3';

import { freshHawkEye } from '../src/bots/plugins';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest();

/** `gc()` from the command line's `--expose-gc`, or else from the flag set now (a new context gets the function). */
function exposeGc(): (() => void) | undefined {
  const own = (globalThis as { gc?: () => void }).gc;
  if (own) return own;
  try {
    setFlagsFromString('--expose-gc');
    const gc: unknown = runInNewContext('gc');
    return typeof gc === 'function' ? (gc as () => void) : undefined;
  } catch {
    return undefined;
  }
}
const gc = exposeGc();
const NO_GC = 'gc() is not available (run with node --expose-gc): the leak cannot be measured';

type ShooterBot = EventEmitter & { username: string; hawkEye?: { oneShot: (t: unknown) => void; stop: () => void } };

function mkBot(name: string): ShooterBot {
  return Object.assign(new EventEmitter(), { username: name, deactivateItem: () => undefined, activateItem: () => undefined });
}

/** One bot with hawkEye loaded on it, which the runtime then lets go. A function, so no frame here keeps the bot. */
function loadAndDrop(i: number): WeakRef<ShooterBot> {
  const bot = mkBot(`Gone${i}`);
  freshHawkEye()(bot as never);
  return new WeakRef(bot);
}

/** Collect a few times, with a turn of the event loop between (WeakRefs read in a job hold their target till it ends). */
async function collect(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await sleep(20);
    gc!();
  }
}

test('hawkEye: a bot the runtime lets go is collected with its copy of the module (docs/36 §5.1)', { skip: gc ? false : NO_GC }, async () => {
  // The first bot of the process too: the first copy loaded is the first parent of the shared modules it pulls in.
  const refs = Array.from({ length: 10 }, (_, i) => loadAndDrop(i));
  await collect();
  const kept = refs.flatMap((r) => r.deref()?.username ?? []);
  assert.deepEqual(kept, [], `${kept.length}/10 bots still reachable after GC: ${kept.join(', ')}`);
});

test('hawkEye: a bot still in use keeps a working copy after GC', { skip: gc ? false : NO_GC }, async () => {
  const bot = mkBot('Kept');
  freshHawkEye()(bot as never);
  loadAndDrop(99);
  await collect();
  bot.hawkEye!.oneShot({ position: new Vec3(5, 64, 0), isValid: true });
  assert.ok(bot.listenerCount('physicsTick') > 0, 'its copy still aims it');
  bot.hawkEye!.stop();
  assert.equal(bot.listenerCount('physicsTick'), 0);
});
