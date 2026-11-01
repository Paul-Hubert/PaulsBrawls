// The dispatcher's tick source in a real boot (docs/37 §2.5): one online bot's physicsTick, so the job ticks are the
// bots' ticks. The first bot to come online leads; when it goes offline, the next online bot takes over (or none, and
// the pool's own self-correcting timer ticks until a bot is back, pool.ts). Each bot runs its own physics timer, so
// the bots' ticks are not in phase with each other: following one keeps the dispatcher at the bots' rate (20 a
// second, no drift), not a common phase. A job submitted between two dispatcher ticks is answered two ticks later at
// most (docs/37 §8.4), so a caller with a deadline submits that far ahead.

import type { JobPool, TickSource } from './pool';

/** The pool's side, narrowed (tests pass a fake). */
export interface TickPool {
  on(event: 'online', fn: (name: string, bot: unknown) => void): unknown;
  on(event: 'status', fn: (name: string, status: string) => void): unknown;
  names(): string[];
  bot(name: string): unknown;
}

/** Make `jobs` follow the physics ticks of one online bot of `pool`. Returns the name of the leader now (tests). */
export class LeaderTicks {
  private leader: string | null = null;

  constructor(
    private readonly pool: TickPool,
    private readonly jobs: Pick<JobPool, 'useTickSource'>,
  ) {
    pool.on('online', (name: string, bot: unknown) => {
      if (this.leader === null || this.leader === name) this.follow(name, bot);
    });
    pool.on('status', (name: string, status: string) => {
      if (name === this.leader && status !== 'online') this.elect();
    });
    this.elect();
  }

  get current(): string | null {
    return this.leader;
  }

  private elect(): void {
    for (const n of this.pool.names()) {
      const b = this.pool.bot(n);
      if (b) return this.follow(n, b);
    }
    this.leader = null;
    this.jobs.useTickSource(null);
  }

  private follow(name: string, bot: unknown): void {
    this.leader = name;
    this.jobs.useTickSource(bot as TickSource);
  }
}
