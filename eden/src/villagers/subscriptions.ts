// SubscriptionStore + FilterEvaluator (layer 3, villagers/) — the reactivity policy store + matcher
// (04 §Subscriptions). A subscription is a villager's standing "when X (filtered), do Y" rule, stored
// as DATA (P5): it journals legibly, renders on the website, and can be written safely by LLM tool
// calls (subscribe/unsubscribe/list_subscriptions) and by God (source:'god' — wiring a reflex IS an
// orchestration move). There is NO predicate code in a subscription.
//
// Two components, two invariants:
//   • SubscriptionStore is the SOLE WRITER of subscription state (S2). Every add/remove/enable flows
//     through it and journals (subscription.created/-removed). It owns persistence (JSON under the data
//     dir, like the library/anchors) and the per-subscription cooldown bookkeeping (last-fired clock).
//   • FilterEvaluator is a CLAUSE REGISTRY (S1/P5): each Filter clause is one ROW (a pure predicate),
//     AND-composed. Adding a clause is a row, not an if/else fork. ArgTemplate `$event.*` substitution
//     resolves a skill handler's args from the event at fire time — also data, no code.
//
// villagers/ imports skills/llm/render/journal/config/types (downward); never god/ or social/.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { monotonicFactory } from 'ulid';

import type { IJournal } from '../journal/journal';
import type {
  ArgTemplate,
  EdenEvent,
  Envelope,
  EventType,
  Filter,
  Subscription,
  SubscriptionHandler,
} from '../types/index';

const ulid = monotonicFactory();

/** What `add` carries — everything but the id + the enabled flag (the store fills those). */
export interface SubscriptionSpec {
  villager: string;
  on: EventType;
  handler: SubscriptionHandler;
  filter?: Filter;
  cooldownMs?: number;
  source: Subscription['source'];
  /** Defaults true; a seed can land disabled if a role-default is gated off. */
  enabled?: boolean;
}

/** Construction deps. The store is the sole writer of subscription state (S2). */
export interface SubscriptionStoreOptions {
  dataDir: string;
  journal: IJournal;
  now?: () => number;
}

/** Per-villager subscriptions, persisted to JSON, journaled on every mutation. Sole writer (S2). */
export class SubscriptionStore {
  private readonly dataDir: string;
  private readonly journal: IJournal;
  private readonly now: () => number;
  /** id → subscription (the single source of truth for live state). */
  private readonly byId = new Map<string, Subscription>();
  /** id → last-fired epoch ms (cooldown bookkeeping; not persisted — a restart clears cooldowns). */
  private readonly lastFired = new Map<string, number>();

  constructor(opts: SubscriptionStoreOptions) {
    this.dataDir = opts.dataDir;
    this.journal = opts.journal;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** Create a subscription (journals subscription.created). The ONLY way new state enters the store. */
  add(spec: SubscriptionSpec): Subscription {
    const sub: Subscription = {
      id: ulid(),
      villager: spec.villager,
      on: spec.on,
      handler: spec.handler,
      ...(spec.filter !== undefined ? { filter: spec.filter } : {}),
      ...(spec.cooldownMs !== undefined ? { cooldownMs: spec.cooldownMs } : {}),
      source: spec.source,
      enabled: spec.enabled ?? true,
    };
    this.byId.set(sub.id, sub);
    this.persist(sub.villager);
    this.journal.append(`villager:${sub.villager}`, 'subscription.created', {
      id: sub.id,
      villager: sub.villager,
      on: sub.on,
      handler: sub.handler.kind,
      source: sub.source,
    });
    return sub;
  }

  /** Remove a subscription (journals subscription.removed). Returns false if it didn't exist. */
  remove(id: string): boolean {
    const sub = this.byId.get(id);
    if (!sub) return false;
    this.byId.delete(id);
    this.lastFired.delete(id);
    this.persist(sub.villager);
    this.journal.append(`villager:${sub.villager}`, 'subscription.removed', { id, villager: sub.villager });
    return true;
  }

  /** Bug #16 — the restart wipe: remove every subscription the villager authored itself (`source:'self'`),
   *  keeping the role defaults (config data, not the villager's history). Journals each removal. */
  removeSelfAuthored(villager: string): number {
    const mine = this.list(villager).filter((s) => s.source === 'self');
    for (const s of mine) this.remove(s.id);
    return mine.length;
  }

  /** Enable/disable without removing — the quarantine auto-disable path (04) + admin toggles. */
  setEnabled(id: string, enabled: boolean): void {
    const sub = this.byId.get(id);
    if (!sub || sub.enabled === enabled) return;
    sub.enabled = enabled;
    this.persist(sub.villager);
  }

  /** One subscription by id. */
  get(id: string): Subscription | undefined {
    return this.byId.get(id);
  }

  /** Every subscription a villager holds (the brain's list_subscriptions + the router's match set). */
  list(villager: string): Subscription[] {
    return [...this.byId.values()].filter((s) => s.villager === villager);
  }

  /** Stamp a subscription as just-fired (starts its cooldown window). */
  markFired(id: string): void {
    this.lastFired.set(id, this.now());
  }

  /** True while a subscription is inside its per-subscription cooldown window (no cooldownMs → never). */
  inCooldown(id: string): boolean {
    const sub = this.byId.get(id);
    if (!sub || sub.cooldownMs === undefined) return false;
    const last = this.lastFired.get(id);
    if (last === undefined) return false;
    return this.now() - last < sub.cooldownMs;
  }

  // ── persistence (per-villager JSON, like the library/anchors) ──────────────────────────────────
  private fileFor(villager: string): string {
    return join(this.dataDir, 'subscriptions', `${villager}.json`);
  }

  private persist(villager: string): void {
    const dir = join(this.dataDir, 'subscriptions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.fileFor(villager), JSON.stringify(this.list(villager), null, 2));
  }

  /** Load persisted subscriptions for every villager file present (a reload, NOT a re-journal). */
  private load(): void {
    const dir = join(this.dataDir, 'subscriptions');
    if (!existsSync(dir)) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const file of names) {
      if (!file.endsWith('.json')) continue;
      try {
        const subs = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Subscription[];
        for (const s of subs) if (s && s.id) this.byId.set(s.id, s);
      } catch {
        // A corrupt file for one villager must not stop the rest from loading.
      }
    }
  }
}

// ── FilterEvaluator: the clause registry (P5) ──────────────────────────────────────────────────────

/** The live world facts a filter clause reads — supplied by the router at match time (P5: data in). */
export interface FilterContext {
  selfPos: [number, number, number];
  /** World time 0..24000 (mineflayer timeOfDay) — the timeOfDay clause classifies the phase. */
  timeOfDay: number;
  health: number;
  food: number;
  /** Skills currently running on this villager's bot — the notWhileRunning clause reads it. */
  runningSkills: string[];
}

/** One filter clause: read its value off the Filter, test it against the event + context. Pure (P5). */
type ClauseFn = (value: unknown, event: EdenEvent, ctx: FilterContext) => boolean;

/**
 * The CLAUSE REGISTRY — one row per Filter key. AND-composition iterates only the keys PRESENT on the
 * filter; an absent clause never constrains. Adding a clause is adding a row here (S1), never a branch.
 */
const CLAUSES: Record<keyof Filter, ClauseFn> = {
  within: (value, event, ctx) => {
    if (typeof value !== 'number') return true;
    const d = eventDistance(event, ctx);
    return d === undefined ? true : d <= value; // events with no distance are not gated by `within`
  },
  entityKind: (value, event) => {
    if (typeof value !== 'string') return true;
    const name = eventEntityName(event);
    return name === undefined ? false : classifyEntity(name) === value;
  },
  nameMatches: (value, event) => {
    if (typeof value !== 'string') return true;
    const hay = eventNameHaystack(event).toLowerCase();
    return hay.includes(value.toLowerCase());
  },
  timeOfDay: (value, _event, ctx) => {
    if (typeof value !== 'string') return true;
    return timePhase(ctx.timeOfDay) === value;
  },
  healthBelow: (value, _event, ctx) => (typeof value === 'number' ? ctx.health < value : true),
  foodBelow: (value, _event, ctx) => (typeof value === 'number' ? ctx.food < value : true),
  notWhileRunning: (value, _event, ctx) =>
    Array.isArray(value) ? !value.some((s) => ctx.runningSkills.includes(String(s))) : true,
};

/** AND-composes declarative Filter clauses (P5). The router asks `matches` before routing a subscription. */
export class FilterEvaluator {
  /** True iff EVERY present clause passes. An undefined/empty filter always matches (no constraints). */
  matches(filter: Filter | undefined, env: Envelope, ctx: FilterContext): boolean {
    if (!filter) return true;
    for (const key of Object.keys(filter) as Array<keyof Filter>) {
      const clause = CLAUSES[key];
      if (!clause) continue; // an unknown key is ignored (forward-compatible with role-default files)
      if (!clause(filter[key], env.event, ctx)) return false;
    }
    return true;
  }
}

// ── ArgTemplate $event.* substitution ──────────────────────────────────────────────────────────────

/**
 * Resolve a skill handler's args from the event at fire time (04). A string value of the form
 * `$event.path.to.field` is replaced by the event field; anything else passes through unchanged. An
 * unresolved path becomes `undefined` (never throws — a bad template degrades, it doesn't crash routing).
 */
export function substituteArgs(template: object | ArgTemplate, env: Envelope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
    out[k] = typeof v === 'string' && v.startsWith('$event.') ? resolvePath(env.event, v.slice('$event.'.length)) : v;
  }
  return out;
}

function resolvePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// ── clause helpers (the small data tables behind the declarative clauses — P5) ─────────────────────

/** Hostile/animal name tables — the entityKind clause classifies by name (the event carries `name:id`). */
const HOSTILE = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'husk',
  'drowned', 'pillager', 'vindicator', 'phantom', 'blaze', 'ghast', 'piglin', 'hoglin', 'zoglin', 'ravager',
]);
const ANIMAL = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'horse', 'rabbit', 'wolf', 'cat', 'fox', 'goat', 'llama', 'donkey',
  'mooshroom', 'ocelot', 'parrot', 'turtle', 'bee', 'axolotl',
]);

/** Map an entity name to one of the four declarative kinds (player/villager/animal/hostile). */
function classifyEntity(name: string): string {
  const n = name.toLowerCase();
  if (n === 'villager' || n === 'wandering_trader') return 'villager';
  if (HOSTILE.has(n)) return 'hostile';
  if (ANIMAL.has(n)) return 'animal';
  return 'player'; // an unrecognized named entity is treated as a player (the broadest social default)
}

/** The bare entity name an entity event carries (`zombie:7` → `zombie`), or undefined for non-entity events. */
function eventEntityName(event: EdenEvent): string | undefined {
  if (event.type === 'entity-spotted' || event.type === 'entity-lost') {
    return event.entity.split(':')[0];
  }
  return undefined;
}

/** The string a nameMatches clause searches — the salient name/text of the event. */
function eventNameHaystack(event: EdenEvent): string {
  switch (event.type) {
    case 'entity-spotted':
    case 'entity-lost':
      return event.entity;
    case 'item-received':
      return event.item;
    case 'block-broken-nearby':
      return event.block;
    case 'player-chat':
      return `${event.player} ${event.text}`;
    case 'villager-chat':
      return `${event.villager} ${event.text}`;
    case 'run-finished':
      return event.skill;
    default:
      return '';
  }
}

/** The self-relative distance an event carries (entity-spotted, and a chat whose speaker is known), else undefined. */
function eventDistance(event: EdenEvent, _ctx: FilterContext): number | undefined {
  if (event.type === 'entity-spotted') return event.distance;
  if (event.type === 'player-chat' || event.type === 'villager-chat') return event.distance;
  return undefined;
}

/** Classify a 0..24000 day clock into a coarse phase the timeOfDay clause matches against. */
function timePhase(timeOfDay: number): 'day' | 'night' | 'dawn' | 'dusk' {
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  if (t >= 23000 || t < 1000) return 'dawn';
  if (t >= 11500 && t < 13000) return 'dusk';
  if (t >= 13000 && t < 23000) return 'night';
  return 'day';
}
