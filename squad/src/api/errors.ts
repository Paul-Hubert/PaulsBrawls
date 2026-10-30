// The errors a command sees (docs/29 §5.1 rule 6: a bot leaving is an exception, not a state to poll). They are
// scope globals, so a script can `catch (e) { if (e instanceof BotLeftError) … }`. Messages are English and carry
// evidence (they go to the author agent); what players read is French and built elsewhere.

import type { LeftReason } from '../leases';

export class SquadError extends Error {
  override name = 'SquadError';
}

/** The bot is no longer this order's: reclaimed by another order, released, dead, disconnected, despawned. */
export class BotLeftError extends SquadError {
  override name = 'BotLeftError';
  constructor(
    readonly bot: string,
    readonly reason: LeftReason | 'order-ended',
  ) {
    super(`${bot} left the order (${reason})`);
  }
}

/** The order was stopped (by a player, its time limit, or the end of a trial). Thrown at the next await. */
export class OrderStoppedError extends SquadError {
  override name = 'OrderStoppedError';
  constructor(readonly why: string) {
    super(`order stopped (${why})`);
  }
}

/** A helper could not do its job; the message says what and where. */
export class HelperError extends SquadError {
  override name = 'HelperError';
}

export function isBotLeft(e: unknown): e is BotLeftError {
  return e instanceof BotLeftError;
}

export function isStopped(e: unknown): e is OrderStoppedError {
  return e instanceof OrderStoppedError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return typeof e === 'string' ? e : JSON.stringify(e);
  } catch {
    return String(e);
  }
}
