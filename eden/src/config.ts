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
/** A villager's roster entry; `home`/`chest` coords are hints (self-healing at boot in M1). */
export interface VillagerConfig {
  name: string;
  role: string;
  home: [number, number, number];
  chest: [number, number, number];
}
/** The fully-validated Eden configuration — every section defaulted by {@link parseConfig}. */
export interface EdenConfig {
  minecraft: { host: string; port: number; version: string };
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
    combineDesks: boolean;
    embodiedVerdicts: boolean;
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
  settlement: { url: string };
  admin: { port: number };
  journal: { vitalsIntervalSeconds: number; debugPrompts: boolean; retentionDays: number };
}

/** The defaulted skeleton (villagers come from the user). */
export const DEFAULT_CONFIG: Omit<EdenConfig, 'villagers'> = {
  minecraft: { host: '127.0.0.1', port: 25599, version: SUPPORTED_MINECRAFT_VERSION },
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
    combineDesks: false,
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
  settlement: { url: 'http://127.0.0.1:8767/trade/execute' },
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
    ['minecraft', 'villagers', 'god', 'behavior', 'llm', 'skills', 'settlement', 'admin', 'journal'],
    warnings,
  );

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

  // villagers
  const rawVillagers = Array.isArray(raw['villagers']) ? raw['villagers'] : [];
  if (!Array.isArray(raw['villagers'])) {
    warnings.push('config: no villagers array — defaulting to empty (R22)');
  }
  const villagers: VillagerConfig[] = rawVillagers.map((v, i) => {
    const vo = isObj(v) ? v : {};
    warnUnknown(`villagers[${i}]`, vo, ['name', 'role', 'home', 'chest'], warnings);
    return {
      name: str(vo, 'name', `villager${i}`),
      role: str(vo, 'role', 'villager'),
      home: (Array.isArray(vo['home']) ? vo['home'] : [0, 64, 0]) as [number, number, number],
      chest: (Array.isArray(vo['chest']) ? vo['chest'] : [0, 64, 0]) as [number, number, number],
    };
  });

  // god
  const g = isObj(raw['god']) ? raw['god'] : {};
  warnUnknown(
    'god',
    g,
    ['name', 'gamemode', 'authoring', 'desks', 'budget', 'combineDesks', 'embodiedVerdicts'],
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
  const god = {
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
    combineDesks: bool(g, 'combineDesks', d.god.combineDesks),
    embodiedVerdicts: bool(g, 'embodiedVerdicts', d.god.embodiedVerdicts),
  };

  // behavior
  const beh = isObj(raw['behavior']) ? raw['behavior'] : {};
  warnUnknown('behavior', beh, ['drives'], warnings);
  const behavior = { drives: bool(beh, 'drives', d.behavior.drives) };

  // llm (alias-aware)
  const llmRaw = applyAliases('llm', isObj(raw['llm']) ? raw['llm'] : {}, warnings);
  warnUnknown('llm', llmRaw, ['providers', 'maxConcurrent', 'perVillagerCooldownSeconds'], warnings);
  const providers = isObj(llmRaw['providers']) ? llmRaw['providers'] : {};
  const provider = (key: 'strong' | 'fast'): ProviderConfig => {
    const p = isObj(providers[key]) ? providers[key] : {};
    return {
      baseUrl: str(p, 'baseUrl', d.llm.providers[key].baseUrl),
      model: str(p, 'model', d.llm.providers[key].model),
      inputTokenBudget: num(p, 'inputTokenBudget', d.llm.providers[key].inputTokenBudget),
    };
  };
  const llm = {
    providers: { strong: provider('strong'), fast: provider('fast') },
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
  warnUnknown('settlement', set, ['url'], warnings);
  const settlement = { url: str(set, 'url', d.settlement.url) };

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

  const config: EdenConfig = { minecraft, villagers, god, behavior, llm, skills, settlement, admin, journal };

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
  const names = villagers.map((v) => v.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) {
    throw new Error(`config: duplicate villager name "${dup}" — usernames must be unique (R12)`);
  }
  if (names.includes(god.name)) {
    throw new Error(`config: god.name "${god.name}" collides with a villager username (R12)`);
  }
  if (god.name === V1_RESERVED_AVATAR) {
    warnings.push(`config: god.name "${V1_RESERVED_AVATAR}" is v1's reserved avatar — pick another to coexist`);
  }

  return { config, warnings };
}

/** Read a config file (JSONC tolerated), validate, forward warnings to onWarn, return the config. */
export function loadConfig(path: string, onWarn?: (warning: string) => void): EdenConfig {
  const text = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(stripJsonComments(text, { trailingCommas: true }));
  const { config, warnings } = parseConfig(parsed);
  if (onWarn) for (const w of warnings) onWarn(w);
  return config;
}
