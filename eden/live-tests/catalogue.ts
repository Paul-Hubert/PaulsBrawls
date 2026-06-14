// The live-scenario catalogue — the single source of truth for which scenarios exist and their order.
// Exported separately from run.ts so a CI test can validate the catalogue STRUCTURE (names, rosters,
// assignees, idempotent arenas) with NO Minecraft and NO LLM — mirroring how tests/eval-harness.test.ts
// validates the eval scaffold. Importing this module has no side effects beyond building the scenario
// data objects (no host boots, no sockets open).

import type { Scenario } from './harness';
import { farmWheat } from './scenarios/farm-wheat';
import { craftWoodenTools } from './scenarios/craft-wooden-tools';
import { cooperativeMobDefense } from './scenarios/cooperative-mob-defense';

/**
 * The catalogue, in the SUGGESTED run order: lowest real-mineflayer risk first (farm-wheat proves the
 * harness end-to-end), the crafting-window risk next, the pvp + multi-villager risk last.
 */
export const SCENARIOS: Scenario[] = [farmWheat, craftWoodenTools, cooperativeMobDefense];

/** Distinct assignee names referenced by a scenario's tasks (used by the runner + the catalogue test). */
export function scenarioAssignees(scenario: Scenario): string[] {
  return [...new Set(scenario.tasks.map((t) => t.assignee).filter((a): a is string => a !== undefined))];
}
