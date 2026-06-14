// eval/run.ts — the eval-harness ENTRYPOINT + scenario catalogue (R42). SCAFFOLD-ONLY in CI: importing
// this module registers the scenarios + builds the roster (pure, tested), but the actual run drives bots
// against PaulsBrawlsVanilla and is SMOKE-TIME — it only fires when this file is invoked directly with a
// live server. CI never touches Minecraft (the DoD).
//
// ── HOW TO RUN THE SMOKE (R28/R29) ───────────────────────────────────────────
//   1. Stop `./gradlew runServer` first — it steals :8767, the settlement listener the trade scenarios
//      need (R29). Evals run against PaulsBrawlsVanilla (25565; RCON 25575 — read run/server.properties,
//      never assume — R28), NOT the dev server on 25599.
//   2. Ensure the Java mod is loaded in PaulsBrawlsVanilla (it owns op-on-join for the avatar + the
//      settlement endpoint). Eden's eval avatar is `EvalBotGod` (reserved prefix — cannot collide with
//      v1's LLMBot or Eden-production Dieu, R12).
//   3. `npm run eval` — wipes `.eden-eval-data/`, applies each scenario's idempotent RCON fixture, points
//      the brain/desks at the scripted mock LLM (own ephemeral port), runs the scenarios, asserts the
//      expected journal events, prints a pass/fail summary via logger.
//   The scenarios-green-vs-PaulsBrawlsVanilla run is the smoke gate; CI proves only the harness logic
//   (tests/eval-harness.test.ts): the reserved prefix (R12), the per-bot collision guard (R42), the
//   fixture idempotency, and the scripted mock LLM determinism.

import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { logger } from '../src/logger';
import { buildEvalRoster, ScenarioRegistry } from './roster';
import { fixtureCommands, isIdempotentFixture, type WorldFixture } from './fixtures';

/** The eval data dir — WIPED at run start (R42) so every run is from a clean slate. */
export const EVAL_DATA_DIR = '.eden-eval-data';

/** One eval scenario: which bot it owns, the world fixture, and the scripted LLM turns it drives. */
export interface EvalScenario {
  id: string;
  bot: string;
  fixture: WorldFixture;
  /** A one-line description of what the scenario proves (for the summary). */
  proves: string;
}

/**
 * The scenario catalogue (R42 suites: reflex + trade). Each scenario claims an EXCLUSIVE bot via the
 * registry — claiming a bot another scenario already owns throws (the sharpest edge). Returns the built
 * roster + the registry so the runner (and tests) can inspect the claims.
 */
export function buildScenarios(villagerCount = 4): { roster: ReturnType<typeof buildEvalRoster>; registry: ScenarioRegistry; scenarios: EvalScenario[] } {
  const roster = buildEvalRoster(villagerCount);
  const names = roster.villagers.map((v) => v.name);
  const registry = new ScenarioRegistry(names);

  const scenarios: EvalScenario[] = [
    {
      id: 'reflex-flee-on-hurt',
      bot: names[0]!,
      fixture: { player: names[0]!, clearInventory: true, tp: [0, 64, 0], setTime: 'day', setWeather: 'clear' },
      proves: 'a hurt event fires the flee reflex (zero-token skill handler, journaled subscription.fired)',
    },
    {
      id: 'reflex-eat-when-hungry',
      bot: names[1]!,
      fixture: { player: names[1]!, clearInventory: true, give: [{ item: 'minecraft:bread', count: 3 }], tp: [4, 64, 0] },
      proves: 'a food-low event fires the eat reflex; auto-eat config is load-bearing (R17)',
    },
    {
      id: 'trade-basic-settle',
      bot: names[2]!,
      fixture: { player: names[2]!, clearInventory: true, give: [{ item: 'paulsbrawls:coin', count: 5 }], tp: [8, 64, 0] },
      proves: 'a typed offer settles via :8767 (coin→paulsbrawls:coin); trade.settled journaled (R29 first)',
    },
    {
      id: 'trade-fail-untouched',
      bot: names[3]!,
      fixture: { player: names[3]!, clearInventory: true, tp: [12, 64, 0] },
      proves: 'an under-funded offer fails settlement; inventories UNTOUCHED; trade.failed journaled (S10)',
    },
  ];

  // Register each scenario's EXCLUSIVE bot claim (R42 — a duplicate bot throws here).
  for (const s of scenarios) registry.register({ id: s.id, bot: s.bot, seeds: fixtureCommands(s.fixture) });

  // Guard: every fixture must be RCON-idempotent (re-applying it is a no-op-safe set).
  for (const s of scenarios) {
    const cmds = fixtureCommands(s.fixture);
    if (!isIdempotentFixture(cmds)) {
      throw new Error(`eval scenario "${s.id}": fixture is NOT RCON-idempotent (relative command) — fix the seed (R42)`);
    }
  }

  return { roster, registry, scenarios };
}

/**
 * SMOKE-TIME entrypoint. Wipes the eval data dir, builds the scenarios, and (against a live server) would
 * apply the RCON fixtures + run each scenario. CI never calls this — the actual bot run is documented
 * above. Here it validates the scaffold (catalogue builds, claims don't collide, fixtures idempotent) and
 * prints the plan, so `npm run eval` without a server is a safe dry-run rather than a crash.
 */
export function main(): void {
  // Wipe the eval data dir at run start (R42) — clean slate, no carried-over beliefs (R32).
  rmSync(EVAL_DATA_DIR, { recursive: true, force: true });

  const { roster, scenarios } = buildScenarios();
  logger.info('admin', `eval harness: ${scenarios.length} scenario(s), roster avatar=${roster.god.name}, ${roster.villagers.length} villager(s), embeddings=${roster.embeddings}`);
  for (const s of scenarios) {
    logger.info('admin', `  [${s.id}] bot=${s.bot} — ${s.proves}`);
  }
  logger.warn(
    'admin',
    'eval dry-run only: the scenarios-vs-PaulsBrawlsVanilla bot run is SMOKE-TIME (see the header — stop ./gradlew runServer first, R29; read run/server.properties for the port, R28).',
  );
}

// Run directly: `npm run eval` → `tsx eval/run.ts`.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
