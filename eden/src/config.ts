// Load + validate eden.json. Imports ONLY types/ (the dependency law forbids config
// importing logger), so it never prints — it returns warnings; the caller (main.ts) logs
// and journals them. Unknown keys warn loudly, common aliases are adopted (R22, S7).

import { readFileSync } from 'node:fs';
import stripJsonComments from 'strip-json-comments';

const SUPPORTED_MINECRAFT_VERSION = '1.21.1'; // R11 — server, mod, and bot must agree
const V1_RESERVED_AVATAR = 'LLMBot'; // 07 §Identity — Eden's avatar must differ

/** Which provider tier a God desk uses. */
export interface DeskConfig {
  model: 'strong' | 'fast';
}
/** An LLM provider tier: endpoint, model id, and per-call input ceiling (D-11). */
export interface ProviderConfig {
  baseUrl: string;
  model: string;
  inputTokenBudget: number;
}
/** One item stack to give a villager via RCON on connect. */
export interface ItemStack {
  /** Namespaced item id, e.g. "minecraft:iron_hoe". */
  id: string;
  count: number;
}
/** A villager's roster entry. */
export interface VillagerConfig {
  name: string;
  role: string;
  /** §1 Identity sentence(s) injected into every deliberation. Defaults to "Tu es <name>." */
  persona?: string;
  /** Initial inventory applied via /give RCON commands after the bot connects. */
  items?: ItemStack[];
}
/** The fully-validated Eden configuration — every section defaulted by {@link parseConfig}. */
export interface EdenConfig {
  minecraft: { host: string; port: number; version: string };
  /** Bare scenario name, e.g. "farming-hamlet". Resolved to villagers + god overrides by the
   *  caller (main.ts) via loadScenario/applyScenario after loadConfig. Always present (undefined
   *  when the user did not set the key). */
  scenario: string | undefined;
  /** Bare provider name, e.g. "openai". Resolved to llm.providers by the caller (main.ts) via
   *  loadProviders/resolveProvider after loadConfig. Always present (undefined when not set). */
  provider: string | undefined;
  /** The env-var name from which to read the API key (e.g. "OPENAI_API_KEY"). Populated by
   *  main.ts after resolving the provider preset; undefined until then or when apiKeyEnv is null
   *  (local providers). */
  apiKeyEnv: string | undefined;
  villagers: VillagerConfig[];
  god: {
    name: string;
    gamemode: string;
    authoring: 'villager' | 'god';
    desks: { critic: DeskConfig; curriculum: DeskConfig; orchestrator: DeskConfig };
    budget: {
      perDesk: Record<'critic' | 'curriculum' | 'orchestrator', { dailyTokens: number | null }>;
      degradeOnBreach: boolean;
    };
    // B3.8: `combineDesks` (a one-prompt "cheap mode") was parsed but never read; it is removed. A config that
    // still sets it gets the usual unknown-key warning (R22).
    embodiedVerdicts: boolean;
    /** Optional scenario-level mission statement injected into every desk's system prompt. */
    godPrompt?: string;
  };
  behavior: { drives: boolean };
  llm: {
    providers: { strong: ProviderConfig; fast: ProviderConfig };
    maxConcurrent: number;
    perVillagerCooldownSeconds: number;
  };
  skills: {
    runDefaultTimeoutMs: number;
    stallSeconds: number;
    maxCallDepth: number;
    maxSkillLines: number;
    probationRuns: number;
    autoQuarantineAfter: number;
  };
  /** `reach` (R33): the accepting partner walks until the two bots are this close. It must stay strictly below
   *  `maxTradeDistance`, which mirrors the mod's `maxTradeDistance` in village_config.properties (default 16) —
   *  Eden cannot read the mod's file, so keep the two equal by hand. */
  settlement: { url: string; reach: number; maxTradeDistance: number };
  admin: { port: number };
  journal: { vitalsIntervalSeconds: number; debugPrompts: boolean; retentionDays: number };
}

/** The defaulted skeleton (villagers come from the user). */
export const DEFAULT_CONFIG: Omit<EdenConfig, 'villagers'> = {
  minecraft: { host: '127.0.0.1', port: 25599, version: SUPPORTED_MINECRAFT_VERSION },
  scenario: undefined,
  provider: undefined,
  apiKeyEnv: undefined,
  god: {
    name: 'Dieu',
    gamemode: 'creative',
    authoring: 'villager',
    desks: {
      critic: { model: 'strong' },
      curriculum: { model: 'strong' },
      orchestrator: { model: 'fast' },
    },
    budget: {
      perDesk: {
        critic: { dailyTokens: null },
        curriculum: { dailyTokens: null },
        orchestrator: { dailyTokens: null },
      },
      degradeOnBreach: true,
    },
    embodiedVerdicts: true,
  },
  behavior: { drives: false },
  llm: {
    providers: {
      strong: { baseUrl: '', model: '', inputTokenBudget: 48000 },
      fast: { baseUrl: '', model: '', inputTokenBudget: 16000 },
    },
    maxConcurrent: 3,
    perVillagerCooldownSeconds: 15,
  },
  skills: {
    runDefaultTimeoutMs: 120000,
    stallSeconds: 20,
    maxCallDepth: 8,
    maxSkillLines: 400,
    probationRuns: 3,
    autoQuarantineAfter: 5,
  },
  settlement: { url: 'http://127.0.0.1:8767/trade/execute', reach: 8, maxTradeDistance: 16 },
  admin: { port: 8770 },
  journal: {
    vitalsIntervalSeconds: 10,
    debugPrompts: false,
    // G1: "configurable 7-day retention" has no key yet — hardcoded default, owner call pending.
    retentionDays: 7,
  },
};

// Per-section deprecated key → canonical key (R22).
const ALIASES: Record<string, Record<string, string>> = {
  llm: { maxConcurrency: 'maxConcurrent', perVillagerCooldownSec: 'perVillagerCooldownSeconds' },
  journal: { vitalsIntervalSec: 'vitalsIntervalSeconds' },
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function applyAliases(section: string, raw: Obj, warnings: string[]): Obj {
  const map = ALIASES[section];
  const out: Obj = { ...raw };
  if (!map) return out;
  for (const [from, to] of Object.entries(map)) {
    if (from in out) {
      warnings.push(`config: ${section}.${from} is deprecated; adopting as ${section}.${to} (R22)`);
      if (!(to in out)) out[to] = out[from];
      delete out[from];
    }
  }
  return out;
}

function warnUnknown(section: string, raw: Obj, known: readonly string[], warnings: string[]): void {
  for (const k of Object.keys(raw)) {
    if (!known.includes(k)) {
      warnings.push(`config: unknown key ${section}.${k} ignored (R22)`);
    }
  }
}

function num(raw: Obj, key: string, dflt: number): number {
  const v = raw[key];
  return typeof v === 'number' ? v : dflt;
}
function bool(raw: Obj, key: string, dflt: boolean): boolean {
  const v = raw[key];
  return typeof v === 'boolean' ? v : dflt;
}
function str(raw: Obj, key: string, dflt: string): string {
  const v = raw[key];
  return typeof v === 'string' ? v : dflt;
}

/** Validate + normalize a raw (already JSON-parsed) config. Pure: returns warnings, never prints. */
export function parseConfig(input: unknown): { config: EdenConfig; warnings: string[] } {
  const warnings: string[] = [];
  const raw: Obj = isObj(input) ? input : {};
  warnUnknown(
    '',
    raw,
    ['minecraft', 'scenario', 'provider', 'villagers', 'god', 'behavior', 'llm', 'skills', 'settlement', 'admin', 'journal'],
    warnings,
  );

  // Top-level resolution keys (resolved by main.ts after loadConfig — pure strings here).
  const scenario = typeof raw['scenario'] === 'string' ? raw['scenario'] : undefined;
  const provider = typeof raw['provider'] === 'string' ? raw['provider'] : undefined;

  const d = DEFAULT_CONFIG;

  // minecraft
  const mc = isObj(raw['minecraft']) ? raw['minecraft'] : {};
  warnUnknown('minecraft', mc, ['host', 'port', 'version'], warnings);
  const minecraft = {
    host: str(mc, 'host', d.minecraft.host),
    port: num(mc, 'port', d.minecraft.port),
    version: str(mc, 'version', d.minecraft.version),
  };
  if (minecraft.version !== SUPPORTED_MINECRAFT_VERSION) {
    warnings.push(
      `config: minecraft.version "${minecraft.version}" != pinned ${SUPPORTED_MINECRAFT_VERSION} (R11) — server, mod, and bot must agree`,
    );
  }

  // villagers — may come from raw JSON directly (legacy) or be populated later via scenario
  const hasVillagers = Array.isArray(raw['villagers']);
  const rawVillagers = hasVillagers ? (raw['villagers'] as unknown[]) : [];
  if (!hasVillagers && !scenario) {
    warnings.push('config: no villagers array — defaulting to empty (R22)');
  }
  if (hasVillagers && scenario) {
    warnings.push('config: both "scenario" and "villagers" set; "scenario" takes precedence (R22)');
  }
  const villagers: VillagerConfig[] = rawVillagers.map((v, i) => {
    const vo = isObj(v) ? v : {};
    warnUnknown(`villagers[${i}]`, vo, ['name', 'role', 'persona', 'items'], warnings);
    const rawItems = Array.isArray(vo['items']) ? (vo['items'] as unknown[]) : undefined;
    const entry: VillagerConfig = {
      name: str(vo, 'name', `villager${i}`),
      role: str(vo, 'role', 'villager'),
    };
    if (typeof vo['persona'] === 'string') entry.persona = vo['persona'];
    if (rawItems) {
      entry.items = rawItems
        .filter(isObj)
        .map((it) => ({ id: str(it, 'id', ''), count: num(it, 'count', 1) }))
        .filter((it) => it.id !== '');
    }
    return entry;
  });

  // god
  const g = isObj(raw['god']) ? raw['god'] : {};
  warnUnknown(
    'god',
    g,
    ['name', 'gamemode', 'authoring', 'desks', 'budget', 'embodiedVerdicts', 'godPrompt'],
    warnings,
  );
  const desks = isObj(g['desks']) ? g['desks'] : {};
  const deskCfg = (key: 'critic' | 'curriculum' | 'orchestrator'): DeskConfig => {
    const dk = isObj(desks[key]) ? desks[key] : {};
    const model = str(dk, 'model', d.god.desks[key].model);
    return { model: model === 'fast' ? 'fast' : 'strong' };
  };
  const budget = isObj(g['budget']) ? g['budget'] : {};
  const perDeskRaw = isObj(budget['perDesk']) ? budget['perDesk'] : {};
  const deskBudget = (key: 'critic' | 'curriculum' | 'orchestrator'): { dailyTokens: number | null } => {
    const b = isObj(perDeskRaw[key]) ? perDeskRaw[key] : {};
    const v = b['dailyTokens'];
    return { dailyTokens: typeof v === 'number' ? v : null };
  };
  const authoring = str(g, 'authoring', d.god.authoring) === 'god' ? 'god' : 'villager';
  const god: EdenConfig['god'] = {
    name: str(g, 'name', d.god.name),
    gamemode: str(g, 'gamemode', d.god.gamemode),
    authoring: authoring as 'villager' | 'god',
    desks: { critic: deskCfg('critic'), curriculum: deskCfg('curriculum'), orchestrator: deskCfg('orchestrator') },
    budget: {
      perDesk: {
        critic: deskBudget('critic'),
        curriculum: deskBudget('curriculum'),
        orchestrator: deskBudget('orchestrator'),
      },
      degradeOnBreach: bool(budget, 'degradeOnBreach', d.god.budget.degradeOnBreach),
    },
    embodiedVerdicts: bool(g, 'embodiedVerdicts', d.god.embodiedVerdicts),
  };
  if (typeof g['godPrompt'] === 'string') god.godPrompt = g['godPrompt'];

  // behavior
  const beh = isObj(raw['behavior']) ? raw['behavior'] : {};
  warnUnknown('behavior', beh, ['drives'], warnings);
  const behavior = { drives: bool(beh, 'drives', d.behavior.drives) };

  // llm (alias-aware)
  const llmRaw = applyAliases('llm', isObj(raw['llm']) ? raw['llm'] : {}, warnings);
  warnUnknown('llm', llmRaw, ['providers', 'maxConcurrent', 'perVillagerCooldownSeconds'], warnings);
  if ('providers' in llmRaw && provider) {
    warnings.push('config: llm.providers is ignored when "provider" key is set; remove llm.providers (R22)');
  }
  const llmProviders = isObj(llmRaw['providers']) ? llmRaw['providers'] : {};
  const parseProviderTier = (key: 'strong' | 'fast'): ProviderConfig => {
    const p = isObj(llmProviders[key]) ? llmProviders[key] : {};
    return {
      baseUrl: str(p, 'baseUrl', d.llm.providers[key].baseUrl),
      model: str(p, 'model', d.llm.providers[key].model),
      inputTokenBudget: num(p, 'inputTokenBudget', d.llm.providers[key].inputTokenBudget),
    };
  };
  const llm = {
    providers: { strong: parseProviderTier('strong'), fast: parseProviderTier('fast') },
    maxConcurrent: num(llmRaw, 'maxConcurrent', d.llm.maxConcurrent),
    perVillagerCooldownSeconds: num(llmRaw, 'perVillagerCooldownSeconds', d.llm.perVillagerCooldownSeconds),
  };

  // skills
  const sk = isObj(raw['skills']) ? raw['skills'] : {};
  warnUnknown(
    'skills',
    sk,
    ['runDefaultTimeoutMs', 'stallSeconds', 'maxCallDepth', 'maxSkillLines', 'probationRuns', 'autoQuarantineAfter'],
    warnings,
  );
  const skills = {
    runDefaultTimeoutMs: num(sk, 'runDefaultTimeoutMs', d.skills.runDefaultTimeoutMs),
    stallSeconds: num(sk, 'stallSeconds', d.skills.stallSeconds),
    maxCallDepth: num(sk, 'maxCallDepth', d.skills.maxCallDepth),
    maxSkillLines: num(sk, 'maxSkillLines', d.skills.maxSkillLines),
    probationRuns: num(sk, 'probationRuns', d.skills.probationRuns),
    autoQuarantineAfter: num(sk, 'autoQuarantineAfter', d.skills.autoQuarantineAfter),
  };

  // settlement / admin
  const set = isObj(raw['settlement']) ? raw['settlement'] : {};
  warnUnknown('settlement', set, ['url', 'reach', 'maxTradeDistance'], warnings);
  const settlement = {
    url: str(set, 'url', d.settlement.url),
    reach: num(set, 'reach', d.settlement.reach),
    maxTradeDistance: num(set, 'maxTradeDistance', d.settlement.maxTradeDistance),
  };
  // B4: an "in range" pair the mod still refuses would fail every trade after the walk.
  if (!(settlement.reach > 0 && settlement.reach < settlement.maxTradeDistance)) {
    throw new Error(
      `config: settlement.reach=${settlement.reach} must be > 0 and < settlement.maxTradeDistance=${settlement.maxTradeDistance} ` +
        "(the mod's maxTradeDistance; it refuses parties farther apart)",
    );
  }

  const adm = isObj(raw['admin']) ? raw['admin'] : {};
  warnUnknown('admin', adm, ['port'], warnings);
  const admin = { port: num(adm, 'port', d.admin.port) };

  // journal (alias-aware)
  const jrnRaw = applyAliases('journal', isObj(raw['journal']) ? raw['journal'] : {}, warnings);
  warnUnknown('journal', jrnRaw, ['vitalsIntervalSeconds', 'debugPrompts'], warnings);
  if (num(jrnRaw, 'vitalsIntervalSeconds', d.journal.vitalsIntervalSeconds) < 5) {
    warnings.push('config: journal.vitalsIntervalSeconds < 5 floods the journal — consider raising it');
  }
  const journal = {
    vitalsIntervalSeconds: num(jrnRaw, 'vitalsIntervalSeconds', d.journal.vitalsIntervalSeconds),
    debugPrompts: bool(jrnRaw, 'debugPrompts', d.journal.debugPrompts),
    retentionDays: d.journal.retentionDays,
  };

  const config: EdenConfig = { minecraft, scenario, provider, apiKeyEnv: undefined, villagers, god, behavior, llm, skills, settlement, admin, journal };

  // ── D-11 reserve invariant (R47) — declared in M0-3, ACTIVATES now that the context-pack (M3)
  // consumes inputTokenBudget. A tier that runs a rollout role (the STRONG tier: authoring/revision)
  // must hold frame + max-draft + RunReport + critique + headroom for ≥1 prior revision. The exact
  // sizes are runtime concerns (the context-pack's fitBudget); here we apply a conservative arithmetic
  // floor from skills.maxSkillLines so a misconfigured budget warns at boot rather than truncating
  // code mid-rollout. (config.ts imports only types/ — no token estimator; this is a coarse guard.) ──
  const APPROX_TOKENS_PER_LINE = 12; // a code line ≈ 12 tokens (≈45 chars / 4)
  const RESERVE_OVERHEAD = 8000; // frame (exemplars/snapshot/inbox) + RunReport + critique + headroom
  const maxDraftTokens = skills.maxSkillLines * APPROX_TOKENS_PER_LINE;
  const reserveFloor = 2 * maxDraftTokens + RESERVE_OVERHEAD; // current draft + ≥1 prior revision
  if (llm.providers.strong.inputTokenBudget < reserveFloor) {
    warnings.push(
      `config: llm.providers.strong.inputTokenBudget (${llm.providers.strong.inputTokenBudget}) is below the ` +
        `D-11 reserve floor (~${reserveFloor}) for maxSkillLines=${skills.maxSkillLines} — a rollout revision may ` +
        `not fit current draft + RunReport + critique + headroom (R47). Raise the budget or lower maxSkillLines.`,
    );
  }

  // ── Fatal validations (R11/R12 identity law) ─────────────────────────────
  assertIdentity(villagers, god.name);
  if (god.name === V1_RESERVED_AVATAR) {
    warnings.push(`config: god.name "${V1_RESERVED_AVATAR}" is v1's reserved avatar — pick another to coexist`);
  }

  return { config, warnings };
}

/**
 * Fatal R12 identity check: villager usernames must be unique and none may equal the avatar's name.
 * Throws (never warns) — Minecraft kicks the second login of a shared username. Called by
 * {@link parseConfig} AND again after a scenario roster REPLACES the villagers post-parse (the
 * composition root, which applies the booted scenario): parseConfig only ever saw the empty pre-scenario
 * array, so the scenario path would otherwise admit a "Dieu" villager or a duplicate name uncaught.
 */
export function assertIdentity(villagers: readonly { name: string }[], godName: string): void {
  const names = villagers.map((v) => v.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) {
    throw new Error(`config: duplicate villager name "${dup}" — usernames must be unique (R12)`);
  }
  if (names.includes(godName)) {
    throw new Error(`config: god.name "${godName}" collides with a villager username (R12)`);
  }
}

/** Read a config file (JSONC tolerated), validate, forward warnings to onWarn, return the config. */
export function loadConfig(path: string, onWarn?: (warning: string) => void): EdenConfig {
  const text = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(stripJsonComments(text, { trailingCommas: true }));
  const { config, warnings } = parseConfig(parsed);
  if (onWarn) for (const w of warnings) onWarn(w);
  return config;
}
