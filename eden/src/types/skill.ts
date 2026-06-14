import type { Tier, SkillStatus, AbortCause } from './enums';

/** A JSON-schema fragment (params/returns). Rendered into `signature` by the library. */
export type JsonSchema = Record<string, unknown>;

/** Who authored a skill version — God, a villager, or a stock/exemplar seed. */
export interface Author {
  kind: 'god' | 'villager' | 'stock';
  name?: string;
}

/** Set on admit — ties a version back to the rollout + verdict that blessed it. */
export interface Provenance {
  rolloutId: string;
  verdictId: string;
}

/** The English-facing description of a skill — what retrieval and prompts render. */
export interface SkillManifest {
  name: string;
  summary: string;
  description: string;
  params: JsonSchema;
  returns: JsonSchema;
  /** Rendered from params/returns — the one-line signature shown in prompts. */
  signature: string;
  tags: string[];
  tier: Tier;
  exemplar: boolean;
}

/** Append-only: each authored revision is a new version row. */
export interface SkillVersion {
  name: string;
  version: number;
  codePath: string;
  codeHash: string;
  status: SkillStatus;
  /** D-12: clean re-judged runs left before active-probation graduates to active. */
  probationRunsLeft?: number;
  author: Author;
  provenance?: Provenance;
  createdAt: number;
}

/** Derived (folded from skill.run journal events), never primary state. */
export interface SkillStats {
  runs: number;
  successes: number;
  failures: number;
  stalls: number;
  avgMs: number;
  lastError?: string;
  lastRunAt?: number;
}

/** Voyager-rendered world view — small by construction (D-07): no raw world dumps. */
export interface Snapshot {
  biome: string;
  time: number;
  position: [number, number, number];
  health: number;
  hunger: number;
  equipment: string[];
  inventory: Array<{ name: string; count: number }>;
  nearbyEntities: Array<{ name: string; distance: number }>;
  nearbyBlocks: string[];
  knownChests: Array<[number, number, number]>;
}

/** One node in a run's call tree — a skill invoking another skill (D-12 composition). */
export interface CallFrame {
  skill: string;
  version: number;
  ok: boolean;
  ms: number;
}

/** The terminal result of a run: success (optional value) or failure (error + optional kind). */
export type RunOutcome =
  | { ok: true; value?: unknown }
  | { ok: false; error: string; errorKind?: string };

/** The full evidence record of a single skill run — what God's critic reads to judge it. */
export interface RunReport {
  runId: string;
  rolloutId?: string;
  skill: string;
  version: number;
  villager: string;
  args: object;
  outcome: RunOutcome;
  aborted?: AbortCause;
  startedAt: number;
  durationMs: number;
  pulses: number;
  deepestDepth: number;
  callTree: CallFrame[];
  worldBefore: Snapshot | null;
  worldAfter: Snapshot | null;
}

/** Who is running a skill — the tier gate reads this. */
export interface RunnerRef {
  name: string;
  role: string;
  tier: Tier;
}
