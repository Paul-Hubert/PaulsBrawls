/** The ONLY God→villager channel — keeps layer-3 actors decoupled (11 §7 note). */
export interface InboxMessage {
  from: 'god' | 'villager';
  kind: 'directive' | 'critique' | 'tell';
  payload: object;
  at: number;
}

/**
 * The concrete instance is wired in main.ts; God holds only this interface, never a
 * Villager — that is what keeps god/ from importing villagers/ (the dependency law).
 */
export interface Inbox {
  /** Deliver + journal `inbox.delivered` once, as `actor` (default the engine) — e.g. `player:<name>` for an
   *  admin/website tell, so the audit row names who spoke without a second row (bug #17). */
  deliver(m: InboxMessage, actor?: string): void;
  drain(): InboxMessage[];
}
