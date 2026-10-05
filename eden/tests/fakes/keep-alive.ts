import { beforeEach, afterEach } from 'node:test';

/**
 * R73 — hold the event loop open for the duration of each test in the calling file.
 *
 * Production code `unref()`s its timers (skill-engine stall/wall/sleep timers, the scheduler's cooldown
 * re-drain, FakeBot's pulse timers) so they never keep a real host alive. A test that awaits a promise only
 * such a timer can resolve leaves node:test with an EMPTY event loop: the runner then cancels the pending
 * test — and every test after it in the file — with "Promise resolution is still pending but the event loop
 * has already resolved". This registers a ref'd handle per test instead of touching the production `unref()`s.
 *
 * The handle is a bounded `setTimeout`, not an interval: a test that genuinely never settles still empties
 * the loop after `maxMs` and is cancelled (a visible failure), instead of hanging the run forever.
 */
export function holdEventLoopPerTest(maxMs = 30_000): void {
  let handle: NodeJS.Timeout | undefined;
  beforeEach(() => {
    handle = setTimeout(() => undefined, maxMs);
  });
  afterEach(() => {
    if (handle) clearTimeout(handle);
    handle = undefined;
  });
}
