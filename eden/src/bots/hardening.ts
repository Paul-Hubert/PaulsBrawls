// The v1 hardening corpus (R1–R10, R25), ported as small functions over the narrowed Bot seam
// (types/bot.ts) so they are testable on FakeBot with no Minecraft. These are the load-bearing
// behaviors months of v1 debugging produced — treat docs/07 R-numbers as the acceptance criteria.
//
//   • boundPathfinder        R6  — upstream pathfinder is unbounded; bound it at spawn.
//   • abortActiveTasks       R4/R5 — the ONLY safe abort order; every timeout/stall/preempt path.
//   • craftQuiescence        R1–R3 — close stray window, pause mutators, trust packets not promises.
//   • waitForInventoryQuiescence R2 — a craft is confirmed by packet quiescence, never the promise.
//   • installChatInterceptor R25 — drop `/`-commands while an op-able bot runs mortal code.

import type { Bot } from '../types/index';

/** R6: upstream defaults are thinkTimeout 5000 / tickTimeout 40 / searchRadius -1 (UNBOUNDED). */
export function boundPathfinder(bot: Bot): void {
  const pf = bot.pathfinder;
  if (!pf) return; // plugin may have failed to load (R16) — nothing to bound
  pf.thinkTimeout = 2_000;
  pf.tickTimeout = 10;
  pf.searchRadius = 64;
}

/**
 * R4/R5: aborting is a SEQUENCE, not a call. A timed-out action's promise is abandoned, but its
 * plugin keeps driving the bot — so every timeout/stall/preempt path runs this exact order:
 *   1. clear collectblock targets + cancel its task;
 *   2. pvp.stop();
 *   3. pathfinder.stop() THEN setGoal(null) — a lone stop() arms a latent flag that silently
 *      self-cancels the NEXT goal;
 *   4. close any stray window;
 *   5. yield one macrotask so event handlers settle.
 * Each step is independently guarded so a missing/throwing plugin (R16) never breaks the chain.
 */
export async function abortActiveTasks(bot: Bot): Promise<void> {
  try {
    bot.collectBlock?.cancelTask?.();
    if (Array.isArray(bot.collectBlock?.targets)) bot.collectBlock.targets.length = 0;
  } catch {
    /* a missing/throwing collectblock must not block the rest of the abort (R5) */
  }
  try {
    await bot.pvp?.stop();
  } catch {
    /* pvp may not be loaded */
  }
  try {
    bot.pathfinder?.stop();
    bot.pathfinder?.setGoal(null); // ORDER: stop() then setGoal(null) — R4
  } catch {
    /* pathfinder may not be loaded */
  }
  try {
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  } catch {
    /* no stray window, or close raced a server close */
  }
  // Yield one macrotask so the plugins' own handlers observe the stops before the next action.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Tuning for {@link waitForInventoryQuiescence} / {@link craftQuiescence}. */
export interface QuiescenceOptions {
  /** Resolve after this long with no set_slot/window_items packet. Default 120 ms. */
  quietMs?: number;
  /** Hard ceiling so a never-quiet server can't hang the caller (R39). Default 2000 ms. */
  timeoutMs?: number;
}

/**
 * R2: a craft/chest op's outcome is confirmed by server packets (`set_slot` / `window_items` on
 * `bot._client`), NOT the resolved promise (1.17+ has no per-click ack; a full window_items
 * re-emits updateSlot:0, spuriously satisfying naive sync). Resolve only once those packets go
 * quiet for `quietMs`, or `timeoutMs` elapses (the safety valve, never the bug — R39).
 */
export function waitForInventoryQuiescence(bot: Bot, opts: QuiescenceOptions = {}): Promise<void> {
  const quietMs = opts.quietMs ?? 120;
  const timeoutMs = opts.timeoutMs ?? 2_000;
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
      arm(); // each packet pushes the settle point out
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
 * R1–R3: run a window operation (craft / chest work) safely. Close any stray window first
 * (mineflayer routes EVERY clickWindow to bot.currentWindow regardless of intent — R1), pause
 * the autonomous inventory mutators (auto-eat AND armor-manager both corrupt a click sequence —
 * R3), run the operation, then wait for packet quiescence (R2). Mutators are always restored.
 */
export async function craftQuiescence<T>(
  bot: Bot,
  fn: () => Promise<T>,
  opts: QuiescenceOptions = {},
): Promise<T> {
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow); // R1
  bot.autoEat?.disableAuto(); // R3
  bot.armorManager?.pause?.(); // R3
  try {
    const result = await fn();
    await waitForInventoryQuiescence(bot, opts); // R2
    return result;
  } finally {
    bot.armorManager?.resume?.();
    bot.autoEat?.enableAuto();
  }
}

/**
 * R25: while an op-able bot runs MORTAL code (demonstrations, trials of villager-authored skills),
 * intercept its chat and drop any `/`-prefixed message — otherwise the LLM could run arbitrary
 * server commands by phrasing them as "speech" on the op'd avatar. Returns a remover that restores
 * the original chat. (Villagers are never op'd — this is the second layer; the tier gate is the first.)
 */
export function installChatInterceptor(bot: Bot): () => void {
  const original = bot.chat.bind(bot);
  bot.chat = (message: string): void => {
    if (/^\s*\//.test(message)) return; // drop the slash-command, silently (v1 bridge behavior)
    original(message);
  };
  return () => {
    bot.chat = original;
  };
}
