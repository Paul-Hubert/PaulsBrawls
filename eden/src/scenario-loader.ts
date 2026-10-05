// Loads a JSON scenario file and converts it into EdenConfig overrides + RCON setup commands.
// A scenario is a declarative preset — villagers as a named dict, a persona + initial items per
// villager, and optional God config overrides. It does NOT replace eden.json; call applyScenario
// to shallow-merge the result onto a base EdenConfig produced by parseConfig.
//
// Dependency: imports only config.ts (layer 1) and stdlib — safe at any layer.

import { readFileSync } from 'node:fs';
import stripJsonComments from 'strip-json-comments';
import type { EdenConfig, VillagerConfig, ItemStack } from './config';

// ── JSON scenario shape ──────────────────────────────────────────────────────

/** One villager entry inside a scenario file. */
export interface ScenarioVillager {
  role: string;
  /** §1 Identity sentence(s). If absent the runtime defaults to "Tu es <name>." */
  persona?: string;
  /** Items to /give the bot via RCON immediately after it connects. */
  items?: ItemStack[];
}

/** God section overrides — merged on top of the base EdenConfig.god. */
export interface ScenarioGod {
  /** Avatar username. Defaults to "Dieu". Must differ from every villager name. */
  name?: string;
  /** true = avatar appears in-world to deliver critiques. */
  embodiedVerdicts?: boolean;
  /** "villager" (default) | "god" — who writes skill drafts. */
  authoring?: 'villager' | 'god';
  /**
   * Scenario-level mission statement injected into every desk's system prompt.
   * Use this to tell God what the overall goal is, what to teach the villagers,
   * what to avoid, or any other standing instructions for this run.
   */
  godPrompt?: string;
}

/** The shape of an `eden/scenarios/*.json` file. */
export interface ScenarioFile {
  /** kebab-case identifier, e.g. "farming-hamlet". */
  name: string;
  /** One-line French description shown in logs. */
  description: string;
  /** Optional God overrides (shallow-merged onto base EdenConfig.god). */
  god?: ScenarioGod;
  /** Villagers keyed by their Minecraft username. */
  villagers: Record<string, ScenarioVillager>;
}

// ── Loader result ────────────────────────────────────────────────────────────

export interface ScenarioLoadResult {
  name: string;
  description: string;
  /** Villagers converted to VillagerConfig[] (name injected from the dict key). */
  villagers: VillagerConfig[];
  /** God overrides ready to shallow-merge into EdenConfig.god. */
  god: ScenarioGod;
  /**
   * RCON `/give` commands to run after bots connect, one per item stack.
   * Format: `give <username> <id> <count>`  (no leading slash — send via RCON directly).
   * For live-test scenarios pass these as `prepare` commands; for production runs use RCON.
   */
  setupCommands: string[];
}

// ── Parsing helpers (mirror config.ts style — no shared util to keep layers clean) ─

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const asStr = (v: unknown, dflt: string): string => (typeof v === 'string' ? v : dflt);
const asNum = (v: unknown, dflt: number): number => (typeof v === 'number' ? v : dflt);
const asArr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
const asBool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);

function parseVillager(name: string, raw: Raw): VillagerConfig {
  const entry: VillagerConfig = {
    name,
    role: asStr(raw['role'], 'villager'),
  };
  if (typeof raw['persona'] === 'string') entry.persona = raw['persona'];
  const rawItems = asArr(raw['items']);
  if (rawItems) {
    entry.items = rawItems
      .filter(isObj)
      .map((it) => ({ id: asStr(it['id'], ''), count: asNum(it['count'], 1) }))
      .filter((it) => it.id !== '');
  }
  return entry;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a JSON scenario file from disk and return the structured result.
 * Throws on file-not-found or JSON parse errors; otherwise best-effort (unknown keys ignored).
 */
export function loadScenario(scenarioPath: string): ScenarioLoadResult {
  const text = readFileSync(scenarioPath, 'utf8');
  const raw: Raw = JSON.parse(stripJsonComments(text)) as Raw;

  const name = asStr(raw['name'], 'unnamed');
  const description = asStr(raw['description'], '');

  // villagers
  const rawVillagers = isObj(raw['villagers']) ? raw['villagers'] : {};
  const villagers: VillagerConfig[] = Object.entries(rawVillagers).map(([vname, vraw]) =>
    parseVillager(vname, isObj(vraw) ? vraw : {}),
  );

  // god overrides
  const rawGod = isObj(raw['god']) ? raw['god'] : {};
  const god: ScenarioGod = {};
  if (typeof rawGod['name'] === 'string') god.name = rawGod['name'];
  // B3.8: a scenario's `combineDesks` is ignored (the key was removed — it was never read).
  if (typeof rawGod['embodiedVerdicts'] === 'boolean') god.embodiedVerdicts = asBool(rawGod['embodiedVerdicts'], true);
  if (rawGod['authoring'] === 'god' || rawGod['authoring'] === 'villager') god.authoring = rawGod['authoring'];
  if (typeof rawGod['godPrompt'] === 'string') god.godPrompt = rawGod['godPrompt'];

  // RCON /give commands for initial items
  const setupCommands: string[] = [];
  for (const v of villagers) {
    for (const item of v.items ?? []) {
      setupCommands.push(`give ${v.name} ${item.id} ${item.count}`);
    }
  }

  return { name, description, villagers, god, setupCommands };
}

/**
 * Merge a loaded scenario onto a base EdenConfig.
 * - Replaces `villagers` entirely with the scenario's roster.
 * - Shallow-merges god overrides (only defined keys overwrite).
 * - All other sections (llm, skills, settlement, …) come from `base`.
 */
export function applyScenario(base: EdenConfig, scenario: ScenarioLoadResult): EdenConfig {
  return {
    ...base,
    scenario: scenario.name,
    villagers: scenario.villagers,
    god: { ...base.god, ...scenario.god },
  };
}
