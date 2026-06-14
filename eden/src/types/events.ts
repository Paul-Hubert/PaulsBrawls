import type { Priority } from './enums';

/**
 * Closed discriminated union — adding a variant is a registry-row change
 * (08 §recipes), so this is data, not a class hierarchy with virtual dispatch.
 * Concrete emitters land in M5 (villagers/events.ts); the shapes are fixed here.
 */
export type EdenEvent =
  | { type: 'hurt'; damage: number; byEntity?: string }
  | { type: 'entity-spotted'; entity: string; distance: number }
  | { type: 'entity-lost'; entity: string }
  | { type: 'player-chat'; player: string; text: string }
  | { type: 'villager-chat'; villager: string; text: string }
  | { type: 'inbox' }
  | { type: 'item-received'; item: string; count: number }
  | { type: 'health-low'; health: number }
  | { type: 'night-falls' }
  | { type: 'new-day'; day: number }
  | { type: 'died'; byEntity?: string }
  | { type: 'run-finished'; skill: string; ok: boolean }
  | { type: 'block-broken-nearby'; block: string }
  | { type: 'tick-30s' };

/** The discriminant tag of an {@link EdenEvent} — used as a subscription's `on`. */
export type EventType = EdenEvent['type'];

/** A timestamped event addressed to one villager — what the event bus carries. */
export interface Envelope {
  at: number;
  villager: string;
  event: EdenEvent;
}

/** Declarative only (P5) — no predicate code. AND-composed by the FilterEvaluator. */
export interface Filter {
  within?: number;
  entityKind?: string;
  nameMatches?: string;
  timeOfDay?: 'day' | 'night' | 'dawn' | 'dusk';
  healthBelow?: number;
  foodBelow?: number;
  notWhileRunning?: string[];
}

/** Args may be a literal object or an $event.* template resolved at fire time. */
export type ArgTemplate = Record<string, unknown>;

/** A subscription that auto-runs a named skill when its event+filter match. */
export interface SkillHandler {
  kind: 'skill';
  name: string;
  args: object | ArgTemplate;
}

/** A subscription that escalates a matched event into an LLM deliberation. */
export interface DeliberateHandler {
  kind: 'deliberate';
  hint: string;
  priority?: Priority;
}

/** What a matched subscription does: run a skill or deliberate. */
export type SubscriptionHandler = SkillHandler | DeliberateHandler;

/** A villager's standing "when X (filtered), do Y" rule — policy as data (P5). */
export interface Subscription {
  id: string;
  villager: string;
  on: EventType;
  filter?: Filter;
  handler: SubscriptionHandler;
  cooldownMs?: number;
  source: 'role-default' | 'self' | 'god' | 'admin';
  enabled: boolean;
}
