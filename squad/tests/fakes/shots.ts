// What each bot shoots at, for the stock commands' tests: the scope's `shoot` (HELPERS.shoot, spread into every
// order's scope when it starts) is wrapped to record the target, and the real one still runs: the archers' FakeBots
// need archer() for their shots to finish (physics ticks, a bow that fires).

import { HELPERS } from '../../src/api/helpers';
import { unwrap } from '../../src/orders/guard';

type Shoot = typeof HELPERS.shoot;

export interface ShotLog {
  /** Targets by the shooter's username, in order. */
  byBot: Map<string, unknown[]>;
  all: unknown[];
  /** Put the real shoot back (orders started afterwards get it). */
  restore(): void;
}

/** Wrap HELPERS.shoot until restore(); install it before the orders start. `onShot` sees every call too. */
export function recordShots(onShot?: (username: string, target: unknown) => void): ShotLog {
  const helpers = HELPERS as { shoot: Shoot };
  const real = helpers.shoot;
  const byBot = new Map<string, unknown[]>();
  const all: unknown[] = [];
  helpers.shoot = ((bot, target, opts) => {
    const name = (unwrap(bot) as { username?: string }).username ?? '?';
    if (!byBot.has(name)) byBot.set(name, []);
    byBot.get(name)!.push(target);
    all.push(target);
    onShot?.(name, target);
    return real(bot, target, opts);
  }) as Shoot;
  return { byBot, all, restore: () => void (helpers.shoot = real) };
}
