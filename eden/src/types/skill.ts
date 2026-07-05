import type { Tier, SkillStatus, AbortCause } from './enums';

/** A JSON-schema fragment (params/returns). Rendered into `signature` by the library. */
export type JsonSchema = Record<string, unknown>;

/** Who authored a skill version — God, a villager, or a stock/exemplar seed. */
export interface Author {
  kind: 'god' | 'villager' | 'stock';
  name?: string;
}

/**
 * Set on admit — ties a version back to the rollout + the judgment that blessed it. `source`
 * discriminates the two admission paths (docs/26 P-9): the LLM critic ('critic', pre-D-16) vs the
 * mechanical paired-test flip gate ('self-verdict', D-16). The Milestone-A oracle ("zero
 * critic-driven admissions") and the CI assert both read this field from the `skill.admit` payload.
 */
export interface Provenance {
  rolloutId: string;
  source: 'critic' | 'self-verdict';
  /** The god.verdict journal id (source 'critic'). */
  verdictId?: string;
  /** The skill.self-verdict journal id (source 'self-verdict'). */
  selfVerdictId?: string;
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
  /**
   * D-16 pairing (docs/22 §3): true = this skill IS a paired test (returns {verdict, evidence}).
   * Tests are hidden from retrieval and are never composable. Optional because manifests persisted
   * before D-16 lack the field — absent reads as false everywhere.
   */
  test?: boolean;
  /** On a test skill: the name of the subject skill it validates (the S↔T pairing key). */
  validates?: string;
  /**
   * On a test skill: which oracle class the pair uses (O-4, docs/26). 'state' (default) and 'events'
   * require Sδ ≠ ∅ to admit; 'return' (observer/movement skills — they mutate nothing by contract)
   * is exempt from the delta floor: the test asserts the subject's return value against a world read.
   */
  oracle?: 'state' | 'events' | 'return';
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
  /**
   * O-4 (docs/26): per-name counts behind {@link nearbyBlocks} (same bounded scan). The flip gate's
   * Sδ compares COUNTS, not the deduped name set — a name-set misses the 2nd farmland/wheat of a
   * till/sow into a field already showing one. Optional: snapshots persisted pre-O-4 lack it; the
   * gate falls back to the set comparison when absent.
   */
  nearbyBlockCounts?: Record<string, number>;
  knownChests: Array<[number, number, number]>;
}

/**
 * One entry in a run's bounded event-trace ring (D-16, docs/22 §3.4) — the EPHEMERAL oracle. State
 * effects live in the before/after snapshots; a mob's death, a drop pickup, or a dig completion is
 * not reliably a snapshot delta, so the engine records these during the run. `name`/`id` carry the
 * subject entity/block identity so a paired test can filter to ITS subject; `playerCollect` is
 * recorded only when the collector is the runner's own bot (attribution, docs/26 P-5).
 */
export interface TraceEvent {
  kind: 'entityDead' | 'playerCollect' | 'diggingCompleted';
  name?: string;
  id?: number;
  /** ms since the run started. */
  at: number;
}

/** One node in a run's call tree — a skill invoking another skill (D-12 composition). */
export interface CallFrame {
  skill: string;
  version: number;
  ok: boolean;
  ms: number;
}

/** A log entry from a skill run — levels distinguish task impossibility (warn) from code failures (error). */
export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
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
  logs: LogEntry[];
  worldBefore: Snapshot | null;
  worldAfter: Snapshot | null;
  /** The bounded event-trace ring recorded during the run (D-16 §3.4). Absent on pre-D-16 reports. */
  events?: TraceEvent[];
  /** How many trace events were dropped once the ring filled (64 entries) — bloat stays bounded (R44). */
  eventsDropped?: number;
}

/** Who is running a skill — the tier gate reads this. */
export interface RunnerRef {
  name: string;
  role: string;
  tier: Tier;
}
