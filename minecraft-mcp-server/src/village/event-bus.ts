import { log, logDebug } from '../logger.js';
import { VillageEvent, VillageEventType } from './types.js';

/**
 * Per-villager event bus. Reflexes (bot-authored code) and host systems
 * subscribe; bot-host wiring + routines emit. Dispatch is fire-and-forget per
 * handler — a slow reflex never blocks its siblings; ordering across handlers
 * is not guaranteed (action serialization happens in the villager's exclusive
 * action chain, not here).
 */

export type VillageEventHandler = (event: VillageEvent) => void | Promise<void>;

interface Subscription {
  owner: string;
  handler: VillageEventHandler;
}

/** Terse payload summary for the debug log. */
function eventSummary(e: VillageEvent): string {
  const bits: string[] = [];
  if (e.from) bits.push(`from=${e.from}`);
  if (e.text) bits.push(`text="${e.text.slice(0, 60)}"`);
  if (e.item) bits.push(`item=${e.item}x${e.count ?? 1}`);
  if (e.job) bits.push(`job=${e.job}`);
  if (e.entity) bits.push(`entity=${e.entity.name}@${e.entity.distance ?? '?'}`);
  if (e.attacker) bits.push(`attacker=${e.attacker.name}`);
  if (e.error) bits.push(`error=${e.error.slice(0, 80)}`);
  if (e.outcome) bits.push(`outcome=${e.outcome.slice(0, 60)}`);
  if (e.value !== undefined) bits.push(`value=${e.value}`);
  return bits.length > 0 ? ` {${bits.join(' ')}}` : '';
}

export class VillagerEventBus {
  private readonly ownerName: string;
  private readonly subs = new Map<VillageEventType, Subscription[]>();
  /** Per-type minimum interval; re-emits inside the window are coalesced away. */
  private readonly lastEmit = new Map<string, number>();

  constructor(ownerName = '?') {
    this.ownerName = ownerName;
  }

  subscribe(owner: string, type: VillageEventType, handler: VillageEventHandler): void {
    const list = this.subs.get(type) ?? [];
    list.push({ owner, handler });
    this.subs.set(type, list);
  }

  /** Remove every subscription a reflex (or skill version) registered. */
  unsubscribeOwner(owner: string): void {
    for (const [type, list] of this.subs) {
      this.subs.set(type, list.filter((s) => s.owner !== owner));
    }
  }

  /**
   * Emit with an optional rate-limit key: events sharing a key within
   * `minIntervalMs` are dropped (the storm-coalescing layer — an entityHurt
   * burst becomes one 'hurt'). The tri-state result lets the caller fall back
   * to an LLM wake-up when NOBODY handled a real event, without double-firing
   * on rate-limited repeats.
   */
  emit(event: VillageEvent, rateKey?: string, minIntervalMs = 0): 'delivered' | 'rate-limited' | 'no-subscribers' {
    if (rateKey && minIntervalMs > 0) {
      const now = Date.now();
      const last = this.lastEmit.get(rateKey) ?? 0;
      if (now - last < minIntervalMs) {
        logDebug(`bus:${this.ownerName}`, `event ${event.type} rate-limited (key ${rateKey})`);
        return 'rate-limited';
      }
      this.lastEmit.set(rateKey, now);
      if (this.lastEmit.size > 500) {
        // Bound the rate-key map (per-entity keys can accumulate).
        const cutoff = now - 300_000;
        for (const [k, t] of this.lastEmit) {
          if (t < cutoff) this.lastEmit.delete(k);
        }
      }
    }
    const list = this.subs.get(event.type);
    if (!list || list.length === 0) {
      logDebug(`bus:${this.ownerName}`, `event ${event.type}${eventSummary(event)} → no subscribers`);
      return 'no-subscribers';
    }
    logDebug(`bus:${this.ownerName}`, `event ${event.type}${eventSummary(event)} → ${list.length} handler(s): ${list.map((s) => s.owner).join(', ')}`);
    for (const sub of [...list]) {
      try {
        const result = sub.handler(event);
        if (result instanceof Promise) {
          result.catch((err) => log('warn', `event handler (${sub.owner}) for ${event.type} rejected: ${String(err)}`));
        }
      } catch (err) {
        log('warn', `event handler (${sub.owner}) for ${event.type} threw: ${String(err)}`);
      }
    }
    return 'delivered';
  }

  subscriberCount(type: VillageEventType): number {
    return this.subs.get(type)?.length ?? 0;
  }
}
