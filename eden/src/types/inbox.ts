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
  deliver(m: InboxMessage): void;
  drain(): InboxMessage[];
}
