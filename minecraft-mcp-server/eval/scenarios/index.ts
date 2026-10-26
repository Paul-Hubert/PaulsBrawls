import type { Scenario, SuiteName } from '../types.js';
import { s1ReflexSurvive } from './s1-reflex-survive.js';
import { s2GuardAlertChain } from './s2-guard-alert-chain.js';
import { s3NightShelter } from './s3-night-shelter.js';
import { s4AutoEat } from './s4-auto-eat.js';
import { s5BarterGoods } from './s5-barter-goods.js';
import { s6BuyFoodWithCoins } from './s6-buy-food-with-coins.js';
import { s7SkillSelfHealing } from './s7-skill-self-healing.js';
import { s8LlmDown } from './s8-llm-down.js';
import { s9MemoryRecall } from './s9-memory-recall.js';
import { s10DayPlan } from './s10-day-plan.js';
import { s11NeedsReflex } from './s11-needs-reflex.js';
import { s12SocialGossip } from './s12-social-gossip.js';
import { s13SkillReuse } from './s13-skill-reuse.js';
import { s14GoalCurriculum } from './s14-goal-curriculum.js';
import { t1GetCraftingTable } from './tasks/t1-get-crafting-table.js';
import { t2PlantTogether } from './tasks/t2-plant-together.js';

/** Execution order — every scenario cleans up after itself, so any subset in
 *  any order must hold. */
export const ALL_SCENARIOS: Scenario[] = [
  s1ReflexSurvive,
  s2GuardAlertChain,
  s3NightShelter,
  s4AutoEat,
  s5BarterGoods,
  s6BuyFoodWithCoins,
  s7SkillSelfHealing,
  s8LlmDown,
  s9MemoryRecall,
  s10DayPlan,
  s11NeedsReflex,
  s12SocialGossip,
  s13SkillReuse,
  s14GoalCurriculum,
  // Higher-level tasks (suite 'tasks') live under scenarios/tasks/.
  t1GetCraftingTable,
  t2PlantTogether,
];

export function scenariosForSuite(suite: SuiteName): Scenario[] {
  if (suite === 'all') return ALL_SCENARIOS;
  return ALL_SCENARIOS.filter((s) => s.suite === suite);
}
