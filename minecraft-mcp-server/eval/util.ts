/**
 * Small pure helpers shared across the eval harness. Everything here is
 * mineflayer-free and unit-testable.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollProbe {
  done: boolean;
  /** Human-readable snapshot of what was observed — becomes the failure detail. */
  detail: string;
}

export interface PollOptions {
  timeoutMs: number;
  intervalMs?: number;
  label: string;
}

/**
 * Polls `probe` until it reports done or the timeout elapses (assertions poll,
 * with generous timeouts — never fixed sleeps). Throws with the last observed
 * state on timeout so the report shows what the world looked like.
 */
export async function pollUntil(options: PollOptions, probe: () => Promise<PollProbe>): Promise<void> {
  const interval = options.intervalMs ?? 1_000;
  const deadline = Date.now() + options.timeoutMs;
  let last: PollProbe = { done: false, detail: '(no poll completed)' };
  for (;;) {
    try {
      last = await probe();
    } catch (err) {
      last = { done: false, detail: `probe error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (last.done) return;
    if (Date.now() >= deadline) {
      throw new Error(`${options.label}: timed out after ${options.timeoutMs}ms — last state: ${last.detail}`);
    }
    await sleep(interval);
  }
}

export function dist3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function distXZ(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Minimal .properties parser (enough for server.properties). */
export function parseProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return result;
}

export interface LedgerEntryLike {
  at: number;
  a: string;
  b: string;
  aGave: Array<{ item: string; count: number }>;
  bGave: Array<{ item: string; count: number }>;
}

/**
 * True if the ledger contains a trade settled after `since`, between exactly
 * the two named bots, whose combined stacks include every stack in `items`
 * (direction-agnostic: it only matters that the items changed hands).
 */
export function ledgerHasTrade(
  entries: LedgerEntryLike[],
  since: number,
  names: [string, string],
  items: Array<{ item: string; count: number }>
): boolean {
  const pair = new Set(names);
  return entries.some((entry) => {
    if (entry.at < since) return false;
    if (!pair.has(entry.a) || !pair.has(entry.b) || entry.a === entry.b) return false;
    const stacks = [...entry.aGave, ...entry.bGave];
    return items.every((want) =>
      stacks.some((s) => s.item === want.item && s.count >= want.count)
    );
  });
}
