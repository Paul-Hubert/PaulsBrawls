// Role-default subscriptions (layer 3, villagers/) — load roles.json and SEED each villager's default
// reflexes at FIRST boot (04 §Subscriptions: "Role defaults seed each villager at first boot. Defaults
// are config data (roles.json), not code."). This is the on-ramp that makes a fresh villager reactive
// before it has authored a single subscription itself.
//
// Two invariants:
//   • Policy as DATA (P5): roles.json is declarative "when X (filtered), do Y" entries; this module only
//     parses + seeds them through the SubscriptionStore (the sole writer, S2). No reflex logic lives here.
//   • FIRST boot only / idempotent: seeding a villager that already holds ANY subscription seeds nothing,
//     so a restart never piles up duplicate reflexes. (A villager re-adopts defaults by deleting its
//     persisted subscriptions file — the store reloads empty, the next seed runs.)
//
// villagers/ imports config-ish JSON via node:fs (downward); it never imports god/ or social/.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import stripJsonComments from 'strip-json-comments';

import type { EventType, Filter, SubscriptionHandler } from '../types/index';
import type { SubscriptionStore } from './subscriptions';

/** One declarative role-default entry — a subscription spec without `villager`/`source` (seed-filled). */
export interface RoleDefaultSpec {
  on: EventType;
  handler: SubscriptionHandler;
  filter?: Filter;
  cooldownMs?: number;
}

/** The parsed roles.json — an `everyone` block applied to all, plus optional per-role blocks. */
export interface RolesConfig {
  everyone: RoleDefaultSpec[];
  [role: string]: RoleDefaultSpec[];
}

/** The shipped roles.json, resolved relative to this module (eden/roles.json). */
export const DEFAULT_ROLES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles.json');

/**
 * Load + lightly validate roles.json (JSONC tolerated, like eden.json). A missing/corrupt file degrades
 * to `{ everyone: [] }` (a villager with no defaults still boots — reflexes are an on-ramp, not a gate),
 * never throws into boot.
 */
export function loadRoles(path: string = DEFAULT_ROLES_PATH): RolesConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(readFileSync(path, 'utf8'), { trailingCommas: true }));
  } catch {
    return { everyone: [] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { everyone: [] };
  const out: RolesConfig = { everyone: [] };
  for (const [role, list] of Object.entries(raw as Record<string, unknown>)) {
    out[role] = Array.isArray(list) ? list.filter(isValidSpec) : [];
  }
  if (!Array.isArray(out.everyone)) out.everyone = [];
  return out;
}

/**
 * Seed a villager's role defaults (everyone + its role block) — FIRST boot only. Returns how many it
 * created. Idempotent: a villager that already holds any subscription is left untouched (no duplicates).
 *
 * Per-event role OVERRIDE (D-15): a role block is the MORE SPECIFIC policy, so a role spec on event E
 * REPLACES every `everyone` spec on E rather than piling on top of it. This is what lets a guard's
 * `hurt → defend-self` (fight) win over everyone's `hurt → flee-to-safety` (flee) — the two would
 * otherwise both seed and the guard would flee + fight at once. (Was: a same-event+same-kind role spec
 * was SKIPPED in favour of everyone — the opposite of what a role override needs.)
 */
export function seedRoleDefaults(
  store: SubscriptionStore,
  villager: string,
  role: string,
  roles: RolesConfig,
): number {
  if (store.list(villager).length > 0) return 0; // already seeded (or self-authored) — first boot only
  const roleBlock = roles[role] ?? [];
  const overriddenEvents = new Set(roleBlock.map((r) => r.on));
  // Drop any everyone reflex whose event the role redefines — the role's reflex for that event wins.
  const everyone = (roles.everyone ?? []).filter((e) => !overriddenEvents.has(e.on));
  let seeded = 0;
  for (const spec of [...everyone, ...roleBlock]) {
    store.add({
      villager,
      on: spec.on,
      handler: spec.handler,
      ...(spec.filter !== undefined ? { filter: spec.filter } : {}),
      ...(spec.cooldownMs !== undefined ? { cooldownMs: spec.cooldownMs } : {}),
      source: 'role-default',
    });
    seeded++;
  }
  return seeded;
}

/** A roles.json entry is valid iff it names an event + a handler with a known kind (data, not code — P5). */
function isValidSpec(v: unknown): v is RoleDefaultSpec {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o['on'] !== 'string' || o['on'].length === 0) return false;
  const h = o['handler'];
  if (!h || typeof h !== 'object') return false;
  const kind = (h as Record<string, unknown>)['kind'];
  return kind === 'skill' || kind === 'deliberate';
}
