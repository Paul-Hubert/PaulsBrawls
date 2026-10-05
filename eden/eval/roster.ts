// eval/roster.ts — the ambient-suppression eval roster + the per-bot-EXCLUSIVE seed collision guard
// (R42). The eval roster suppresses ambient machinery so scenarios drive EVERYTHING explicitly: huge
// heartbeats (ambient deliberation effectively never fires), embeddings off (deterministic keyword
// retrieval), drives off, no real provider (each scenario injects the scripted mock LLM). Eval usernames
// share a RESERVED PREFIX that cannot collide with any production name (R12).
//
// The harness lives under eden/ as a consumer of config types only; it touches no Minecraft in CI. The
// actual scenario run vs PaulsBrawlsVanilla is smoke-time (see eval/run.ts).

import type { EdenConfig, VillagerConfig } from '../src/config';

/** The reserved eval username prefix (R12). No production username starts with this, and the eval avatar
 *  is prefixed too — so an eval run can never kick a v1 / Eden-production login by name collision. */
export const EVAL_USERNAME_PREFIX = 'EvalBot';

/**
 * Reserved production usernames the eval roster must never equal (R12): v1's unified avatar + village
 * bots, and Eden's production avatar `Dieu`. Kept as a flat list so the collision assertion is one
 * `includes`. (v1 village rosters use ordinary French names like Firmin/Alban — those are production too,
 * but the EvalBot prefix already separates the eval namespace; this list pins the well-known fixed names.)
 */
export const V1_RESERVED_NAMES: readonly string[] = ['LLMBot', 'GodBot', 'Dieu'];

/** The eval roster bundle main/run.ts hands the harness. */
export interface EvalRoster {
  villagers: VillagerConfig[];
  god: { name: string };
  config: EdenConfig;
  /** Ambient suppression knobs surfaced for assertions (R42). */
  embeddings: 'off';
  heartbeatSeconds: number;
}

/** A huge heartbeat so ambient deliberation effectively never fires — scenarios drive wake-ups (R42). */
const EVAL_HEARTBEAT_SECONDS = 3600;

/**
 * Build an N-villager eval roster with ambient machinery suppressed. Villager names are `EvalBot0..N-1`;
 * the avatar is `EvalBotGod` — all under the reserved prefix (R12). Coordinates are placeholders (the
 * fixtures TP each bot at scenario start), embeddings off, drives off, no real provider baseUrl.
 */
export function buildEvalRoster(count: number): EvalRoster {
  const villagers: VillagerConfig[] = Array.from({ length: count }, (_, i) => ({
    name: `${EVAL_USERNAME_PREFIX}${i}`,
    role: 'villager',
    home: [0, 64, 0],
    chest: [2, 64, 0],
  }));
  const godName = `${EVAL_USERNAME_PREFIX}God`;

  // A fully-defaulted config with ambient machinery off. baseUrl '' means "no real provider" — each
  // scenario points the client at the scripted mock LLM's ephemeral port instead.
  const config: EdenConfig = {
    minecraft: { host: '127.0.0.1', port: 25565, version: '1.21.1' }, // PaulsBrawlsVanilla (R28) — smoke only
    scenario: undefined,
    provider: undefined,
    apiKeyEnv: undefined,
    villagers,
    god: {
      name: godName,
      gamemode: 'creative',
      authoring: 'villager',
      desks: { critic: { model: 'strong' }, curriculum: { model: 'strong' }, orchestrator: { model: 'fast' } },
      budget: {
        perDesk: { critic: { dailyTokens: null }, curriculum: { dailyTokens: null }, orchestrator: { dailyTokens: null } },
        degradeOnBreach: true,
      },
      embodiedVerdicts: false, // no theatrics in eval — scenarios assert behavior, not appearances
    },
    behavior: { drives: false }, // ambient suppression: no tired/lonely wake-ups
    llm: {
      providers: {
        strong: { baseUrl: '', model: 'scripted', inputTokenBudget: 48000 },
        fast: { baseUrl: '', model: 'scripted', inputTokenBudget: 16000 },
      },
      maxConcurrent: 3,
      perVillagerCooldownSeconds: 0, // scenarios drive turns deterministically — no cooldown smearing
    },
    skills: { runDefaultTimeoutMs: 120000, stallSeconds: 20, maxCallDepth: 8, maxSkillLines: 400, probationRuns: 3, autoQuarantineAfter: 5 },
    settlement: { url: 'http://127.0.0.1:8767/trade/execute', reach: 8, maxTradeDistance: 16 },
    admin: { port: 8770 },
    journal: { vitalsIntervalSeconds: 10, debugPrompts: false, retentionDays: 7 },
  };

  return { villagers, god: { name: godName }, config, embeddings: 'off', heartbeatSeconds: EVAL_HEARTBEAT_SECONDS };
}

/** A scenario's pre-boot state claim: it OWNS one bot and seeds its world before the run (R42). */
export interface ScenarioClaim {
  id: string;
  /** The single bot this scenario owns (per-bot EXCLUSIVE — R42's sharpest edge). */
  bot: string;
  /** RCON seed commands applied before the scenario runs (idempotent — eval/fixtures.ts). */
  seeds: string[];
}

/**
 * The collision guard (R42's sharpest edge): per-scenario pre-boot state seeds are per-bot EXCLUSIVE — a
 * new scenario must claim an UNCLAIMED bot or it silently clobbers another scenario's seed. The registry
 * makes that clobber LOUD: a second claim of the same bot throws, naming the prior owner (S10).
 */
export class ScenarioRegistry {
  private readonly rosterNames: ReadonlySet<string>;
  private readonly claims = new Map<string, ScenarioClaim>(); // bot -> claim

  constructor(rosterNames: string[]) {
    this.rosterNames = new Set(rosterNames);
  }

  /** Claim a bot for a scenario. Throws if the bot is outside the roster or already claimed. */
  register(claim: ScenarioClaim): void {
    if (!this.rosterNames.has(claim.bot)) {
      throw new Error(`eval scenario "${claim.id}": bot "${claim.bot}" is not in the eval roster (R42)`);
    }
    const prior = this.claims.get(claim.bot);
    if (prior) {
      throw new Error(
        `eval scenario "${claim.id}": bot "${claim.bot}" is already claimed by ${prior.id} — per-bot seeds are EXCLUSIVE (R42)`,
      );
    }
    this.claims.set(claim.bot, claim);
  }

  /** The bots currently claimed by some scenario. */
  claimedBots(): string[] {
    return [...this.claims.keys()];
  }

  /** The bots in `all` not yet claimed — what a new scenario may take. */
  freeBots(all: string[]): string[] {
    return all.filter((b) => !this.claims.has(b));
  }

  /** All registered scenarios (for the runner to drive). */
  scenarios(): ScenarioClaim[] {
    return [...this.claims.values()];
  }
}
