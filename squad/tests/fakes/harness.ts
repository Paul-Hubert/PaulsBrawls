// A runner wired on fakes: in-memory roster, store and journal, FakeBots for the pool.

import { DEFAULT_LIMITS, type Limits } from '../../src/config';
import { Journal } from '../../src/journal/journal';
import { LeaseManager } from '../../src/leases';
import { ClaimRegistry } from '../../src/orders/claims';
import { OrderRunner } from '../../src/orders/runner';
import { Roster, type Player } from '../../src/roster';
import { CommandStore } from '../../src/store/commands';
import { EMPTY_SNAPSHOT, type Notice } from '../../src/types';
import { FakePool, type FakeItem } from './fake-bot';

export const PAUL: Player = { uuid: 'uuid-paul', name: 'Paul' };
export const ALICE: Player = { uuid: 'uuid-alice', name: 'Alice' };

export function harness(opts: { limits?: Partial<Limits>; stock?: Record<string, { source: string; summary: string }> } = {}) {
  const pool = new FakePool();
  const roster = new Roster(null);
  const leases = new LeaseManager(4);
  const claims = new ClaimRegistry();
  const store = new CommandStore(null, opts.stock ?? {});
  const journal = new Journal(':memory:');
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const runner = new OrderRunner({ pool, roster, leases, claims, store, journal, limits });
  const notices: Notice[] = [];
  runner.on('notice', (n: Notice) => notices.push(n));
  return {
    pool,
    roster,
    leases,
    claims,
    store,
    journal,
    runner,
    notices,
    bot(name: string, owners: Player[], items: FakeItem[] = [], tags: string[] = []) {
      roster.add(name, owners, 'test', 100);
      if (tags.length) roster.tag(name, tags);
      return pool.add(name, { items });
    },
    command(author: Player, name: string, source: string) {
      return store.addVersion(author, name, source, { request: 'test', summary: name });
    },
    order(commander: Player, command: string, tokens: string[] = [], extra: { filters?: string[]; take?: 'free' | 'reclaim' } = {}) {
      return runner.start({ commander, command, tokens, snap: EMPTY_SNAPSHOT, ...extra });
    },
  };
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until `cond()` holds (polling), or fail after `ms`. */
export async function until(cond: () => boolean, ms = 3_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}
