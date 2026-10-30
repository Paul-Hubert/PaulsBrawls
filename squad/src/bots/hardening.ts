// The v1 hardening corpus, copied from Eden (R1–R10) and widened for Squad: the abort sequence now also stops
// digging, lowers a drawn bow, stops hawkEye, releases every control state and puts the runtime's default
// movements back (a script's own Movements object may hold a guarded bot that has since lost its lease).
// Written over a narrowed seam so the FakeBot drives it in tests.

import pathfinderPkg from 'mineflayer-pathfinder';
import type { Bot } from 'mineflayer';

const { Movements } = pathfinderPkg;

/** The parts of a bot the abort sequence touches. Everything is optional: a plugin may have failed to load (R16). */
export interface AbortableBot {
  collectBlock?: { cancelTask?: (cb?: () => void) => unknown; targets?: unknown[] };
  pvp?: { stop?: () => unknown };
  pathfinder?: {
    stop?: () => void;
    setGoal?: (g: null) => void;
    setMovements?: (m: unknown) => void;
    thinkTimeout?: number;
    tickTimeout?: number;
    searchRadius?: number;
  };
  hawkEye?: { stop?: () => void };
  stopDigging?: () => void;
  deactivateItem?: () => void;
  clearControlStates?: () => void;
  currentWindow?: unknown;
  closeWindow?: (w: never) => void;
}

/**
 * R6: upstream defaults are thinkTimeout 5000 / tickTimeout 40 / searchRadius -1 (UNBOUNDED). The search radius is
 * what must be bounded. Eden's 2 s think limit failed live on hilly production terrain with a busy server ("Took to
 * long to decide path to goal" at 14 blocks, docs/29 §16), so the planning time is upstream's 5 s.
 */
export function boundPathfinder(bot: AbortableBot): void {
  const pf = bot.pathfinder;
  if (!pf) return;
  pf.thinkTimeout = 5_000;
  pf.tickTimeout = 10;
  pf.searchRadius = 64;
}

/** The runtime's movements for a bot: digging and placing allowed (grief is on, O5), no parkour. */
export function defaultMovements(bot: Bot): unknown {
  const m = new Movements(bot);
  m.canDig = true;
  m.allowParkour = false;
  m.allowSprinting = true;
  return m;
}

/**
 * R4/R5: aborting is a SEQUENCE, not a call. A timed-out action's promise is abandoned, but its plugin keeps
 * driving the bot, so every stop/reclaim/timeout path runs this exact order. Each step is guarded on its own so a
 * missing or throwing plugin never breaks the chain.
 *   1. collectblock: clear targets, cancel its task;
 *   2. pvp.stop(), hawkEye.stop();
 *   3. pathfinder stop() THEN setGoal(null) (a lone stop() silently cancels the NEXT goal, R4);
 *   4. stop digging, lower a drawn bow / raised shield, release all controls;
 *   5. close any stray window (R1);
 *   6. `movements` (when given): the runtime's default movements replace a script's;
 *   7. one macrotask so the plugins' own handlers see the stops.
 */
export async function abortActiveTasks(bot: AbortableBot, movements?: unknown): Promise<void> {
  const step = async (fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch {
      /* a missing/throwing plugin must not block the rest of the abort (R5) */
    }
  };
  await step(() => {
    bot.collectBlock?.cancelTask?.();
    if (Array.isArray(bot.collectBlock?.targets)) bot.collectBlock.targets.length = 0;
  });
  await step(() => bot.pvp?.stop?.());
  await step(() => bot.hawkEye?.stop?.());
  await step(() => {
    bot.pathfinder?.stop?.();
    bot.pathfinder?.setGoal?.(null); // ORDER: stop() then setGoal(null), R4
  });
  await step(() => bot.stopDigging?.());
  await step(() => bot.deactivateItem?.());
  await step(() => bot.clearControlStates?.());
  await step(() => {
    if (bot.currentWindow) bot.closeWindow?.(bot.currentWindow as never);
  });
  if (movements !== undefined) await step(() => bot.pathfinder?.setMovements?.(movements));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The pieces of a bot a window operation touches (R1–R3). */
export interface WindowBot {
  currentWindow?: unknown;
  closeWindow?: (w: never) => void;
  autoEat?: { disableAuto?: () => void; enableAuto?: () => void };
  armorManager?: { pause?: () => void; resume?: () => void };
  _client: { on(ev: string, fn: () => void): unknown; removeListener(ev: string, fn: () => void): unknown };
}

/**
 * R2: a craft/chest op is confirmed by server packets (`set_slot` / `window_items`), not by the resolved promise.
 * Resolve once those go quiet for `quietMs`, or after `timeoutMs` (the safety valve).
 */
export function waitForInventoryQuiescence(bot: WindowBot, quietMs = 120, timeoutMs = 2_000): Promise<void> {
  return new Promise<void>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      bot._client.removeListener('set_slot', onPacket);
      bot._client.removeListener('window_items', onPacket);
    };
    const arm = (): void => {
      quietTimer = setTimeout(() => {
        cleanup();
        resolve();
      }, quietMs);
    };
    const onPacket = (): void => {
      clearTimeout(quietTimer);
      arm();
    };
    const hardTimer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    bot._client.on('set_slot', onPacket);
    bot._client.on('window_items', onPacket);
    arm();
  });
}

/**
 * R1–R3: run a window operation (craft, chest, furnace) safely. Close a stray window first (mineflayer routes
 * EVERY click to bot.currentWindow, R1), pause auto-eat and armor-manager (both click mid-sequence, R3), run, then
 * wait for packet quiescence (R2). The mutators are always restored and the window always closed.
 */
export async function windowOperation<T>(bot: WindowBot, fn: () => Promise<T>): Promise<T> {
  await closeStrayWindow(bot);
  bot.autoEat?.disableAuto?.();
  bot.armorManager?.pause?.();
  try {
    const result = await fn();
    await waitForInventoryQuiescence(bot);
    return result;
  } finally {
    try {
      await closeStrayWindow(bot);
    } finally {
      bot.armorManager?.resume?.();
      bot.autoEat?.enableAuto?.();
    }
  }
}

export async function closeStrayWindow(bot: WindowBot): Promise<void> {
  if (bot.currentWindow && bot.closeWindow) {
    bot.closeWindow(bot.currentWindow as never);
    await new Promise<void>((r) => setTimeout(r, 0)); // let the close land before the next open (R1)
  }
}
