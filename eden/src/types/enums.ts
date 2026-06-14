// Layer 0 — enumerations. Modeled as `as const` arrays so the members are available
// at runtime (admin can describe them) and the union type derives from one source.

/** Permission tiers a skill runner holds; `divine` is the God avatar (fly/spawn/server cmds). */
export const TIERS = ['mortal', 'divine'] as const;
export type Tier = (typeof TIERS)[number];

/**
 * The D-12 skill lifecycle states.
 * D-12: active-probation = runnable + retrievable, but NOT yet composable by other skills.
 */
export const SKILL_STATUSES = [
  'draft',
  'active-probation',
  'active',
  'quarantined',
  'archived',
] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/** Why a run was aborted: scheduler preemption, a no-pulse stall, or a wall-clock timeout. */
export const ABORT_CAUSES = ['preempted', 'stalled', 'timeout'] as const;
export type AbortCause = (typeof ABORT_CAUSES)[number];

/** Directive / event-handler priority, low to high. */
export const PRIORITIES = ['background', 'normal', 'interrupt'] as const;
export type Priority = (typeof PRIORITIES)[number];
