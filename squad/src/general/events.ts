// A General's events (docs/38 §5): a ring of what happened to its army, read with a cursor. `wait` is the long poll
// behind `wait_events`: it returns as soon as an event of a waking kind arrives (then waits COALESCE_MS more, so a
// burst is one wake: R36), or at the timeout with nothing. In memory only: nothing hot is journaled (R44).

export const EVENT_KINDS = [
  'contact',
  'contact-lost',
  'casualty',
  'kill',
  'hp-band',
  'order-end',
  'arrived',
  'spawn-refused',
  'axis-end',
  'idle',
  'allowance',
  'admin',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Woken on by default: everything but the routine `arrived`. */
export const DEFAULT_WAKE: readonly EventKind[] = EVENT_KINDS.filter((k) => k !== 'arrived');

export interface GeneralEvent {
  seq: number;
  at: number;
  kind: EventKind;
  text: string;
}

const MAX_EVENTS = 500;
export const COALESCE_MS = 2_000;

export class EventRing {
  private readonly events: GeneralEvent[] = [];
  private seq = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly coalesceMs = COALESCE_MS) {}

  get cursor(): number {
    return this.seq;
  }

  push(kind: EventKind, text: string, at = Date.now()): GeneralEvent {
    const e: GeneralEvent = { seq: ++this.seq, at, kind, text };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const w of [...this.waiters]) w();
    return e;
  }

  since(cursor: number): GeneralEvent[] {
    return this.events.filter((e) => e.seq > cursor);
  }

  /**
   * The events after `cursor` once one of a `wake` kind is among them (waiting up to `timeoutMs` for it, then
   * COALESCE_MS for the rest of the burst). `signal` ends the wait early (the client went away).
   */
  async wait(cursor: number, timeoutMs: number, wake: ReadonlySet<EventKind>, signal?: AbortSignal): Promise<{ events: GeneralEvent[]; woke: boolean }> {
    const woken = (): boolean => this.since(cursor).some((e) => wake.has(e.kind));
    if (!woken()) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.waiters.delete(check);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const check = (): void => {
          if (woken()) done();
        };
        const timer = setTimeout(done, Math.max(0, timeoutMs));
        this.waiters.add(check);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
    const woke = woken();
    if (woke && this.coalesceMs > 0 && !signal?.aborted) await new Promise((r) => setTimeout(r, this.coalesceMs));
    return { events: this.since(cursor), woke };
  }

  /** Drop every waiter (the General was stopped). */
  wakeAll(): void {
    for (const w of [...this.waiters]) w();
  }
}
